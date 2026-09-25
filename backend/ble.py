"""
ble.py - Bluetooth LE advertisement scanner on the Pi 4's built-in radio.

Runs alongside every SDR mode — it never touches device 0. Keeps a rolling
table of advertisers keyed by address, with vendor names from the Bluetooth
SIG company-ID list (bluetooth-numbers) and member service UUIDs (bleak's
table), and flags well-known item trackers.

Scan is BlueZ's default active scan (scan requests go out) — that's what
resolves most local names. Pi 4 radio has no sniffer mode: adverts only.

Tracker signatures adapted from smittix/intercept (Apache 2.0).
Requires: bleak, bluetooth-numbers; hci0 unblocked (rfkill) and powered.
"""

import asyncio
import logging
import time
from typing import Awaitable, Callable, Optional

from bleak import BleakScanner
from bleak.uuids import uuid16_dict
from bluetooth_numbers import company

logger = logging.getLogger(__name__)

MsgCb = Callable[[dict], Awaitable[None]]

APPLE = 0x004C
# 16-bit member service UUIDs that identify trackers outright
TRACKER_SERVICES = {0xFEED: "Tile", 0xFEEC: "Tile", 0xFE33: "Chipolo", 0xFD5A: "SmartTag"}
EDDYSTONE = 0xFEAA


def _uuid16(u: str) -> Optional[int]:
    # 0000xxxx-0000-1000-8000-00805f9b34fb → 0xxxxx
    if u.endswith("-0000-1000-8000-00805f9b34fb") and u.startswith("0000"):
        return int(u[4:8], 16)
    return None


def tracker_kind(mfr: dict[int, bytes], uuids: list[int], sdata: dict[int, bytes]) -> Optional[str]:
    apple = mfr.get(APPLE)
    if apple and apple[0] == 0x12:
        # Find My offline-finding: length 0x19 carries the full public key and
        # is only sent once the tag has been away from its owner
        return "Find My · separated" if len(apple) > 1 and apple[1] == 0x19 else "Find My · near owner"
    for u in uuids:
        if u in TRACKER_SERVICES:
            return TRACKER_SERVICES[u]
    ed = sdata.get(EDDYSTONE)
    if ed and ed[0] in (0x40, 0x41):   # FMDN frame types
        return "Google Find My"
    return None


class BLEScanner:
    def __init__(self, ttl_s: int = 600, update_callback: Optional[MsgCb] = None, surveil=None):
        self.ttl_s = ttl_s
        self._cb = update_callback
        self.surveil = surveil   # SurveillanceDetector — sees every advert
        self.devices: dict[str, dict] = {}
        self._dirty = False
        self._scanner: Optional[BleakScanner] = None
        self._task: Optional[asyncio.Task] = None
        self._active = False
        self.error = ""

    async def start(self) -> None:
        self._scanner = BleakScanner(detection_callback=self._on_adv)
        await self._scanner.start()
        self._active = True
        self._task = asyncio.create_task(self._tick_loop(), name="ble-tick")
        logger.info("BLEScanner started — ttl %ds", self.ttl_s)

    async def stop(self) -> None:
        self._active = False
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        if self._scanner is not None:
            try:
                await self._scanner.stop()
            except Exception:
                logger.warning("BLE scanner stop failed", exc_info=True)
            self._scanner = None
        logger.info("BLEScanner stopped")

    def status_dict(self) -> dict:
        return {
            "type":     "status",
            "running":  self._active,
            "devices":  len(self.devices),
            "trackers": sum(1 for d in self.devices.values() if d["tracker"]),
            "ttl_s":    self.ttl_s,
            "error":    self.error,
        }

    def device_list(self) -> list[dict]:
        return sorted(self.devices.values(), key=lambda d: d["rssi"] or -999, reverse=True)

    # ------------------------------------------------------------------

    def _on_adv(self, dev, adv) -> None:
        mfr, sdata = dict(adv.manufacturer_data), dict(adv.service_data)
        self._ingest(dev.address, adv.local_name, adv.rssi, adv.tx_power, mfr, adv.service_uuids, sdata)
        if self.surveil is not None:
            props = dev.details.get("props", {}) if isinstance(dev.details, dict) else {}
            self.surveil.check_ble(dev.address, props.get("AddressType"), adv.local_name, adv.rssi,
                                   mfr, list(adv.service_uuids) + list(sdata))

    def _ingest(self, addr: str, name: Optional[str], rssi: int, tx_power: Optional[int],
                mfr: dict[int, bytes], service_uuids: list[str], service_data: dict[str, bytes]) -> None:
        uuids = [u for u in (_uuid16(s) for s in service_uuids) if u is not None]
        sdata = {u: v for u, v in ((_uuid16(k), v) for k, v in service_data.items()) if u is not None}
        uuids += [u for u in sdata if u not in uuids]

        vendor = next((company.get(k) for k in mfr if company.get(k)), None) \
            or next((uuid16_dict.get(u) for u in uuids if uuid16_dict.get(u)), None)
        prev = self.devices.get(addr)
        now = time.time()
        self.devices[addr] = {
            "addr":     addr,
            "name":     name or (prev["name"] if prev else None),
            "rssi":     rssi,
            "tx_power": tx_power,
            "vendor":   vendor,
            "mfr_ids":  sorted(mfr),
            "services": [uuid16_dict.get(u) or f"0x{u:04X}" for u in uuids],
            "tracker":  tracker_kind(mfr, uuids, sdata),
            "first":    prev["first"] if prev else now,
            "last":     now,
            "count":    (prev["count"] if prev else 0) + 1,
        }
        self._dirty = True

    async def _tick_loop(self) -> None:
        # Adverts arrive at tens per second — push a table snapshot at most every 2 s
        try:
            while self._active:
                await asyncio.sleep(2.0)
                cutoff = time.time() - self.ttl_s
                stale = [a for a, d in self.devices.items() if d["last"] < cutoff]
                for a in stale:
                    del self.devices[a]
                if (self._dirty or stale) and self._cb:
                    self._dirty = False
                    await self._cb({"type": "devices", "devices": self.device_list(),
                                    "status": self.status_dict()})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("BLE tick loop error")


if __name__ == "__main__":
    # Offline self-test: canned adverts through the ingest + tracker path
    s = BLEScanner()
    s._ingest("AA:01", None, -60, None, {APPLE: bytes([0x12, 0x19, 0x10]) + bytes(24)}, [], {})
    s._ingest("AA:02", None, -70, None, {APPLE: bytes([0x12, 0x02, 0x00, 0x01])}, [], {})
    s._ingest("AA:03", "Tile", -80, None, {}, ["0000feed-0000-1000-8000-00805f9b34fb"], {})
    s._ingest("AA:04", "[TV] Samsung", -50, None, {0x0075: b"\x42\x04\x01"}, [], {})
    s._ingest("AA:04", None, -52, None, {0x0075: b"\x42\x04\x01"}, [], {})
    s._ingest("AA:05", None, -90, None, {},
              [], {"0000feaa-0000-1000-8000-00805f9b34fb": bytes([0x41]) + bytes(20)})
    d = s.devices
    assert d["AA:01"]["tracker"] == "Find My · separated", d["AA:01"]
    assert d["AA:02"]["tracker"] == "Find My · near owner"
    assert d["AA:03"]["tracker"] == "Tile" and d["AA:03"]["vendor"] == "Tile: Inc."
    assert d["AA:04"]["tracker"] is None and d["AA:04"]["count"] == 2
    assert d["AA:04"]["name"] == "[TV] Samsung" and d["AA:04"]["vendor"].startswith("Samsung")
    assert d["AA:05"]["tracker"] == "Google Find My"
    assert s.status_dict()["trackers"] == 4
    print("PASS:", [(x["addr"], x["vendor"], x["tracker"]) for x in s.device_list()])
