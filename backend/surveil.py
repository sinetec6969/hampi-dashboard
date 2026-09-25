"""
surveil.py - Ring and Flock Safety device detection from public signatures.

Sources:
  - Flock-You (github.com/colonelpanichacks/flock-you, MIT): BLE names, the
    XUNTONG battery-pack advert, Flock accessory / Raven GATT services and the
    SoftAP SSID, from datasets/firmware_derived_signatures.md + api/flockyou_ble.py
  - IEEE MA-L registry: every vendor OUI below was checked against it
    (2026-09-24) — 13 blocks registered to Ring LLC, 1 to Flock Safety
  - @NitekryDPaul's community Flock OUI list (via Flock-You): all 32 resolve to
    generic module vendors (Liteon, Silicon Labs, Espressif, …), so they only
    ever produce LOW-tier hints

What this Pi can hear: BLE adverts (built-in radio) and WiFi *access points*
via NetworkManager's scan list. The built-in WiFi has no monitor mode and is
the uplink, so client probe requests — Flock-You's strongest WiFi tell — are
out of reach without a second, monitor-capable adapter.

Tiers: high = vendor-registered OUI or a firmware literal; medium = a pattern
other devices can also produce; low = generic module OUI (corroboration only).
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

MsgCb = Callable[[dict], Awaitable[None]]

RING_OUIS = {
    "00:B4:63", "18:7F:88", "24:2B:D6", "34:3E:A4", "50:E4:67", "54:E0:19", "5C:47:5E",
    "64:9A:63", "90:48:6C", "9C:76:13", "AC:9F:C3", "C4:DB:AD", "CC:3B:FB",
}
FLOCK_OUIS = {"B4:1E:52"}
FLOCK_COMMUNITY_OUIS = {
    "70:C9:4E", "3C:91:80", "D8:F3:BC", "80:30:49", "B8:35:32", "14:5A:FC", "74:4C:A1", "08:3A:88",
    "9C:2F:9D", "C0:35:32", "94:08:53", "E4:AA:EA", "F4:6A:DD", "E0:0A:F6", "24:B2:B9", "00:F4:8D",
    "D0:39:57", "E8:D0:FC", "E0:4F:43", "B8:1E:A4", "70:08:94", "58:8E:81", "EC:1B:BD", "3C:71:BF",
    "58:00:E3", "90:35:EA", "5C:93:A2", "64:6E:69", "48:27:EA", "A4:CF:12", "14:B5:CD", "82:6B:F2",
    "00:03:7F",   # Qualcomm Atheros default MAC baked into the camera's QCA9377 blobs
}

XUNTONG = 0x09C8
FLOCK_ACCESSORY_SVC = "e8ccbb38-9532-46a8-9fe5-1814df172e6f"
RAVEN_SVC_RANGE = (0x3100, 0x3500)

_PENGUIN = re.compile(r"^Penguin-\d{10}$")
_BARE10 = re.compile(r"^\d{10}$")
_FLOCK_AP = re.compile(r"^Flock-[0-9A-Fa-f]{6}$")
_TN_SERIAL = re.compile(rb"TN\d{14}")

TIER_RANK = {"low": 0, "medium": 1, "high": 2}


def _m(kind: str, tier: str, label: str, evidence: str) -> dict:
    return {"kind": kind, "tier": tier, "label": label, "evidence": evidence}


def _oui_matches(mac: str) -> list[dict]:
    oui = mac.upper()[:8]
    if oui in RING_OUIS:
        return [_m("ring", "high", "Ring device", f"OUI {oui} (IEEE: Ring LLC)")]
    if oui in FLOCK_OUIS:
        return [_m("flock", "high", "Flock Safety device", f"OUI {oui} (IEEE: Flock Safety)")]
    if oui in FLOCK_COMMUNITY_OUIS:
        return [_m("flock", "low", "Possible Flock (generic module OUI)", f"OUI {oui} on community Flock list")]
    return []


def classify_ble(addr: str, addr_type: Optional[str], name: Optional[str],
                 mfr: dict[int, bytes], service_uuids: list[str]) -> list[dict]:
    out: list[dict] = []
    # A random address's top bits are arbitrary — C4:DB:AD would "be" Ring by chance
    if addr_type == "public":
        out += _oui_matches(addr)
    if name:
        if _PENGUIN.match(name) or name == "FS Ext Battery":
            out.append(_m("flock", "high", "Flock Penguin battery pack", f"name “{name}”"))
        elif _BARE10.match(name):
            out.append(_m("flock", "medium", "Possible Flock battery pack", f"bare 10-digit name “{name}”"))
    payload = mfr.get(XUNTONG)
    if payload is not None:
        if _TN_SERIAL.search(payload):
            out.append(_m("flock", "high", "Flock Penguin battery pack", "XUNTONG advert with TN serial"))
        else:
            out.append(_m("flock", "medium", "Possible Flock battery pack", "XUNTONG (0x09C8) manufacturer data"))
    for u in (s.lower() for s in service_uuids):
        if u == FLOCK_ACCESSORY_SVC:
            out.append(_m("flock", "high", "Flock accessory", "Flock accessory GATT service"))
        elif u.endswith("-0000-1000-8000-00805f9b34fb") and u.startswith("0000"):
            u16 = int(u[4:8], 16)
            if RAVEN_SVC_RANGE[0] <= u16 <= RAVEN_SVC_RANGE[1]:
                out.append(_m("flock", "medium", "Possible Flock Raven", f"service 0x{u16:04X} in Raven range"))
    return out


def classify_ap(bssid: str, ssid: str) -> list[dict]:
    out = _oui_matches(bssid)
    if _FLOCK_AP.match(ssid):
        out.append(_m("flock", "high", "Flock camera SoftAP", f"SSID “{ssid}”"))
    elif ssid == "Flock":
        out.append(_m("flock", "medium", "Possible Flock camera", "bare “Flock” SSID"))
    return out


def _nmcli_split(line: str) -> list[str]:
    # nmcli -t escapes ':' inside values as '\:'
    return [f.replace("\\:", ":") for f in re.split(r"(?<!\\):", line)]


class SurveillanceDetector:
    def __init__(self, wifi_scan_s: int = 30, log_path: Optional[str] = None,
                 update_callback: Optional[MsgCb] = None):
        self.wifi_scan_s = wifi_scan_s
        self.log_path = log_path
        self._cb = update_callback
        self.detections: dict[str, dict] = {}
        self.wifi_error = ""
        self.last_wifi_scan = 0.0
        self.aps_seen = 0
        self._dirty = False
        self._tasks: list[asyncio.Task] = []
        self._active = False

    async def start(self) -> None:
        self._active = True
        self._tasks = [asyncio.create_task(self._wifi_loop(), name="surveil-wifi"),
                       asyncio.create_task(self._tick_loop(), name="surveil-tick")]
        logger.info("SurveillanceDetector started — WiFi AP scan every %ds", self.wifi_scan_s)

    async def stop(self) -> None:
        self._active = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

    # ------------------------------------------------------------------ inputs

    def check_ble(self, addr: str, addr_type: Optional[str], name: Optional[str], rssi: int,
                  mfr: dict[int, bytes], service_uuids: list[str]) -> None:
        matches = classify_ble(addr, addr_type, name, mfr, service_uuids)
        if matches:
            self._observe("ble", addr, name, rssi, matches, {"addr_type": addr_type})

    def check_ap(self, bssid: str, ssid: str, signal_pct: int, chan: str) -> None:
        matches = classify_ap(bssid, ssid)
        if matches:
            self._observe("wifi", bssid, ssid, signal_pct, matches, {"channel": chan})

    def _observe(self, source: str, ident: str, name: Optional[str], strength: int,
                 matches: list[dict], extra: dict) -> None:
        best = max(matches, key=lambda m: TIER_RANK[m["tier"]])
        key = f"{source}:{ident}"
        now = time.time()
        prev = self.detections.get(key)
        rec = {
            "key": key, "source": source, "id": ident, "name": name or (prev["name"] if prev else None),
            "kind": best["kind"], "tier": best["tier"], "label": best["label"],
            "evidence": sorted({m["evidence"] for m in matches}),
            "strength": strength, "strength_unit": "dBm" if source == "ble" else "%",
            "first": prev["first"] if prev else now, "last": now,
            "count": (prev["count"] if prev else 0) + 1, **extra,
        }
        self.detections[key] = rec
        self._dirty = True
        if prev is None:
            logger.info("Surveillance detection: %s %s (%s) — %s", rec["label"], ident, rec["tier"], "; ".join(rec["evidence"]))
            if self.log_path:
                try:
                    with open(self.log_path, "a") as f:
                        f.write(json.dumps({k: rec[k] for k in ("first", "source", "id", "name", "kind", "tier", "label", "evidence", "strength")}) + "\n")
                except OSError:
                    logger.warning("surveillance log write failed", exc_info=True)

    # ------------------------------------------------------------------ loops

    async def _wifi_loop(self) -> None:
        try:
            while self._active:
                await self._scan_wifi()
                await asyncio.sleep(self.wifi_scan_s)
        except asyncio.CancelledError:
            raise

    async def _run(self, *args: str) -> tuple[int, str, str]:
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(p.communicate(), timeout=20)
        return p.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    async def _scan_wifi(self) -> None:
        try:
            # rescan needs a polkit grant for a service user; without it NM's own
            # background scans keep the list reasonably fresh
            await self._run("nmcli", "dev", "wifi", "rescan")
            rc, out, err = await self._run("nmcli", "-t", "-e", "yes", "-f", "BSSID,SSID,CHAN,SIGNAL", "dev", "wifi", "list")
        except (OSError, asyncio.TimeoutError) as exc:
            self.wifi_error = f"nmcli unavailable: {exc}"
            return
        if rc != 0:
            self.wifi_error = err.strip()[-160:] or f"nmcli exit {rc}"
            return
        self.wifi_error = ""
        n = 0
        for line in out.splitlines():
            f = _nmcli_split(line)
            if len(f) < 4 or not f[0]:
                continue
            n += 1
            try:
                sig = int(f[3])
            except ValueError:
                sig = 0
            self.check_ap(f[0], f[1], sig, f[2])
        self.aps_seen = n
        self.last_wifi_scan = time.time()
        self._dirty = True

    async def _tick_loop(self) -> None:
        try:
            while self._active:
                await asyncio.sleep(2.0)
                if self._dirty and self._cb:
                    self._dirty = False
                    await self._cb({"type": "detections", "detections": self.detection_list(),
                                    "status": self.status_dict()})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("surveillance tick loop error")

    # ------------------------------------------------------------------ views

    def status_dict(self) -> dict:
        by = {"high": 0, "medium": 0, "low": 0}
        for d in self.detections.values():
            by[d["tier"]] += 1
        return {"type": "status", "running": self._active, "counts": by,
                "ring": sum(1 for d in self.detections.values() if d["kind"] == "ring"),
                "flock": sum(1 for d in self.detections.values() if d["kind"] == "flock" and d["tier"] != "low"),
                "wifi_error": self.wifi_error, "last_wifi_scan": self.last_wifi_scan,
                "aps_seen": self.aps_seen, "wifi_scan_s": self.wifi_scan_s}

    def detection_list(self) -> list[dict]:
        return sorted(self.detections.values(), key=lambda d: (-TIER_RANK[d["tier"]], -d["last"]))


if __name__ == "__main__":
    pub, rnd = "public", "random"
    cases = [
        (classify_ble("C4:DB:AD:11:22:33", pub, None, {}, []), "ring", "high"),
        (classify_ble("C4:DB:AD:11:22:33", rnd, None, {}, []), None, None),   # random-address collision
        (classify_ble("B4:1E:52:00:00:01", pub, None, {}, []), "flock", "high"),
        (classify_ble("F1:00:00:00:00:01", rnd, "Penguin-1234567890", {}, []), "flock", "high"),
        (classify_ble("F1:00:00:00:00:02", rnd, "FS Ext Battery", {}, []), "flock", "high"),
        (classify_ble("F1:00:00:00:00:03", rnd, "1234567890", {}, []), "flock", "medium"),
        (classify_ble("F1:00:00:00:00:04", rnd, None, {XUNTONG: b"\x01TN72023022000771"}, []), "flock", "high"),
        (classify_ble("F1:00:00:00:00:05", rnd, None, {XUNTONG: b"\x01\x02"}, []), "flock", "medium"),
        (classify_ble("F1:00:00:00:00:06", rnd, None, {}, [FLOCK_ACCESSORY_SVC.upper()]), "flock", "high"),
        (classify_ble("F1:00:00:00:00:07", rnd, None, {}, ["00003101-0000-1000-8000-00805f9b34fb"]), "flock", "medium"),
        (classify_ble("A4:CF:12:00:00:01", pub, "plug", {}, []), "flock", "low"),
        (classify_ble("88:A2:9E:00:00:01", pub, "Pi", {}, ["0000180f-0000-1000-8000-00805f9b34fb"]), None, None),
        (classify_ap("B4:1E:52:AA:BB:CC", "Flock-AABBCC"), "flock", "high"),
        (classify_ap("00:11:22:33:44:55", "Flock-A1B2C3"), "flock", "high"),
        (classify_ap("00:11:22:33:44:55", "Flock"), "flock", "medium"),
        (classify_ap("50:E4:67:00:00:01", "Ring Setup"), "ring", "high"),
        (classify_ap("00:11:22:33:44:55", "Flock-Party"), None, None),
    ]
    for i, (res, kind, tier) in enumerate(cases):
        best = max(res, key=lambda m: TIER_RANK[m["tier"]]) if res else None
        got = (best["kind"], best["tier"]) if best else (None, None)
        assert got == (kind, tier), (i, got, res)
    assert _nmcli_split(r"B4\:1E\:52\:AA\:BB\:CC:Flock-AABBCC:6:72") == ["B4:1E:52:AA:BB:CC", "Flock-AABBCC", "6", "72"]
    d = SurveillanceDetector()
    d.check_ap("B4:1E:52:AA:BB:CC", "Flock-AABBCC", 70, "6")
    d.check_ap("B4:1E:52:AA:BB:CC", "Flock-AABBCC", 72, "6")
    d.check_ble("A4:CF:12:00:00:01", "public", None, -80, {}, [])
    st = d.status_dict()
    assert st["counts"] == {"high": 1, "medium": 0, "low": 1} and st["flock"] == 1, st
    assert d.detection_list()[0]["count"] == 2
    print(f"PASS: {len(cases)} signature cases, nmcli parsing, detector bookkeeping")
