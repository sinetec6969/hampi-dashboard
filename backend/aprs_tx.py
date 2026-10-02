"""
aprs_tx.py - APRS transmit (beacon + messaging) via a one-shot direwolf. [Phase B]

SCAFFOLD — not RF-tested. Keys the Digirig (ADEVICE null → TX audio only,
PTT on the RTS line), same half-duplex TX-only setup proven in Phase A. Each
transmission writes a throwaway direwolf conf with a single delayed PBEACON
(position) or CBEACON (raw APRS message info field), runs direwolf just long
enough for that one frame, then kills it.

HARD-GATED exactly like radio.py: refuses unless radio.tx_enable: true AND
station.callsign is set. With TX disabled (default) the guard raises before any
conf is written or any device is touched, so this is inert until you opt in.

Gotcha banked in ROADMAP-NEXT Phase A: direwolf `every=0:00` means beacon
*continuously* (queued ~59k frames in 7 s). One-shot = a short delay + a long
`every`, killed after the first frame.
"""

import asyncio
import logging
import os
import tempfile
import time
from typing import Optional

logger = logging.getLogger(__name__)

# fire the single frame after this delay, huge repeat so it never repeats, kill after
_BEACON_DELAY_S = 3
_KILL_AFTER_S = 7


def _ssid_call(callsign: str, ssid) -> str:
    callsign = (callsign or "").strip().upper()
    try:
        n = int(ssid)
    except (TypeError, ValueError):
        n = 0
    return f"{callsign}-{n}" if n else callsign


def build_tx_conf(station: dict, serial_port: str, audio_device: str,
                  kind: str, *, addressee: str = "", text: str = "") -> str:
    """Pure conf generator — unit-testable without direwolf or hardware."""
    mycall = _ssid_call(station.get("callsign", ""), station.get("ssid", 0))
    lines = [
        "# HamPi one-shot APRS TX (generated). RX null, TX to the Digirig codec.",
        f"ADEVICE null {audio_device}",
        "ARATE 48000",
        "ACHANNELS 1",
        "CHANNEL 0",
        f"MYCALL {mycall}",
        f"PTT {serial_port} RTS",
        "MODEM 1200",
    ]
    when = f"delay=0:{_BEACON_DELAY_S:02d} every=30:00"
    if kind == "beacon":
        lat = float(station.get("lat", 0.0) or 0.0)
        lon = float(station.get("lon", 0.0) or 0.0)
        comment = str(station.get("comment", "") or "").replace('"', "'")
        lines.append(
            f'PBEACON {when} lat={lat:.4f} long={lon:.4f} symbol="/-" comment="{comment}"')
    elif kind == "message":
        # APRS message info field: ':ADDRESSEE :text' — addressee padded to 9 chars
        to = (addressee or "").strip().upper()[:9].ljust(9)
        info = f":{to}:{text.strip()}"
        lines.append(f'CBEACON {when} INFO="{info}"')
    else:
        raise ValueError(f"unknown TX kind {kind!r}")
    return "\n".join(lines) + "\n"


class APRSTx:
    def __init__(self, station: dict, serial_port: str, audio_device: str, tx_enable: bool):
        self.station = station or {}
        self.serial_port = serial_port
        self.audio_device = audio_device
        self.tx_enable = tx_enable
        self._lock = asyncio.Lock()
        self.last_tx = 0.0
        self.last_desc = ""

    @property
    def callsign(self) -> str:
        return (self.station.get("callsign", "") or "").strip().upper()

    @property
    def ready(self) -> bool:
        return bool(self.tx_enable and self.callsign)

    def _guard(self) -> None:
        if not self.tx_enable:
            raise PermissionError("TX disabled — set radio.tx_enable: true in config.yaml")
        if not self.callsign:
            raise PermissionError("TX refused — set station.callsign in config.yaml")
        if not os.path.exists(self.serial_port):
            raise RuntimeError(f"PTT device {self.serial_port} not present (Digirig unplugged?)")

    async def _run_once(self, conf_text: str, desc: str) -> dict:
        self._guard()
        async with self._lock:   # never two direwolf TX procs on one Digirig
            fd, path = tempfile.mkstemp(prefix="hampi-aprstx-", suffix=".conf")
            os.write(fd, conf_text.encode())
            os.close(fd)
            proc = None
            try:
                logger.info("APRS TX (%s) — direwolf one-shot", desc)
                proc = await asyncio.create_subprocess_exec(
                    "direwolf", "-c", path, "-t", "0", "-q", "d",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                # let the delayed beacon fire, then stop before it can repeat
                try:
                    await asyncio.wait_for(proc.wait(), timeout=_KILL_AFTER_S)
                except asyncio.TimeoutError:
                    pass
            finally:
                if proc is not None and proc.returncode is None:
                    try:
                        proc.terminate()
                        await asyncio.wait_for(proc.wait(), timeout=3)
                    except (ProcessLookupError, asyncio.TimeoutError):
                        try:
                            proc.kill()
                        except ProcessLookupError:
                            pass
                try:
                    os.unlink(path)
                except OSError:
                    pass
            self.last_tx = time.time()
            self.last_desc = desc
            return {"sent": True, "desc": desc, "mycall": _ssid_call(self.callsign, self.station.get("ssid", 0))}

    async def beacon(self) -> dict:
        conf = build_tx_conf(self.station, self.serial_port, self.audio_device, "beacon")
        return await self._run_once(conf, "position beacon")

    async def send_message(self, addressee: str, text: str) -> dict:
        if not addressee.strip():
            raise ValueError("addressee required")
        if not text.strip():
            raise ValueError("message text required")
        conf = build_tx_conf(self.station, self.serial_port, self.audio_device,
                             "message", addressee=addressee, text=text)
        return await self._run_once(conf, f"message to {addressee.strip().upper()}")

    def status(self) -> dict:
        return {
            "tx_enable": self.tx_enable,
            "callsign": self.callsign,
            "mycall": _ssid_call(self.callsign, self.station.get("ssid", 0)) if self.callsign else "",
            "ready": self.ready,
            "ptt_present": os.path.exists(self.serial_port),
            "serial": self.serial_port,
            "last_tx": self.last_tx,
            "last_desc": self.last_desc,
        }


if __name__ == "__main__":
    # Offline: conf generation + guard behaviour. No direwolf, no keying.
    st = {"callsign": "kr4bpw", "ssid": 7, "lat": 35.23, "lon": -80.79, "comment": 'test "rig"'}
    b = build_tx_conf(st, "/dev/digirig", "plughw:CARD=Device", "beacon")
    assert "MYCALL KR4BPW-7" in b and "PTT /dev/digirig RTS" in b
    assert "lat=35.2300 long=-80.7900" in b and "ADEVICE null plughw:CARD=Device" in b
    assert "comment=\"test 'rig'\"" in b   # quotes sanitised
    assert "every=30:00" in b and "delay=0:03" in b   # one-shot, never repeats
    m = build_tx_conf(st, "/dev/digirig", "plughw:CARD=Device", "message", addressee="w1aw", text="hello")
    assert ':W1AW     :hello' in m, m

    import asyncio as _a
    tx = APRSTx({"callsign": ""}, "/dev/digirig", "x", tx_enable=False)
    for coro in (tx.beacon(), tx.send_message("W1AW", "hi")):
        try:
            _a.run(coro); raise SystemExit("guard did not fire")
        except PermissionError:
            pass
    tx2 = APRSTx({"callsign": "KR4BPW"}, "/dev/digirig", "x", tx_enable=False)
    try:
        _a.run(tx2.beacon()); raise SystemExit("tx_enable guard did not fire")
    except PermissionError:
        pass
    assert tx.status()["ready"] is False
    print("PASS: conf generation + TX guards (tx_enable, callsign)")
