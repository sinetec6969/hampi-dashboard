"""
subghz.py - sub-GHz ISM device decoder via rtl_433 (subprocess on device 0).

rtl_433 -F json emits one JSON object per decode across ~250 protocols
(weather stations, TPMS, doorbells, remotes) — no parsing to write. We keep a
rolling device table keyed model/id/channel plus a short event ring.

US TPMS sits on 315 MHz, most sensors/doorbells on 433.92 — with more than
one frequency configured rtl_433 hops between them itself (-H).

Argv adapted from smittix/intercept (Apache 2.0).

Requires: rtl_433 built against the rtl-sdr-blog librtlsdr (V4 support).
RTL-SDR device 0 must be free — the mode switcher stops rtl_tcp first.
"""

import asyncio
import json
import logging
import re
import time
from collections import deque
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

EventCb  = Callable[[dict], Awaitable[None]]
StatusCb = Callable[[dict], Awaitable[None]]

_TUNED_RE = re.compile(r"Tuned to (\d+\.\d+)MHz")   # logged on every hop


class SubGHzDecoder:
    def __init__(
        self,
        freqs: list[int],
        hop_s: int = 60,
        gain: Optional[float] = None,
        rtl_device: int = 0,
        event_callback: Optional[EventCb] = None,
        status_callback: Optional[StatusCb] = None,
    ):
        self.freqs      = freqs
        self.hop_s      = hop_s
        self.gain       = gain
        self.rtl_device = rtl_device
        self._event_cb  = event_callback
        self._status_cb = status_callback

        self.devices: dict[str, dict] = {}
        self.events: deque[dict] = deque(maxlen=200)
        self.cur_freq: Optional[int] = None
        self.last_log = ""
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._tasks: list[asyncio.Task] = []
        self._active = False

    async def start(self) -> None:
        # Once running, rtl_433 logs through its outputs. The "Tuned to" hop
        # lines are NOTICE: -v lifts global verbosity to it, v=5 lets json emit it.
        cmd = ["rtl_433", "-v", "-d", str(self.rtl_device), "-F", "json,v=5",
               "-M", "time:unix", "-M", "level", "-M", "protocol"]
        for f in self.freqs:
            cmd += ["-f", str(f)]
        if len(self.freqs) > 1:
            cmd += ["-H", str(self.hop_s)]
        if self.gain is not None:
            cmd += ["-g", str(self.gain)]
        logger.info("Starting rtl_433: %s", " ".join(cmd))
        self._proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        # rtl_433 exits within a second when device 0 is still held — surface
        # that as a failed switch (so the switcher rolls back) instead of a dead mode.
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
        else:
            err = (await self._proc.stderr.read()).decode("utf-8", "replace").strip()
            self._proc = None
            raise RuntimeError(f"rtl_433 exited: {err[-200:]}")

        self._active = True
        self._tasks = [
            asyncio.create_task(self._read_stdout(), name="subghz-read"),
            asyncio.create_task(self._read_stderr(), name="subghz-log"),
        ]
        logger.info("SubGHzDecoder started — %s MHz",
                    " / ".join(f"{f / 1e6:.3f}" for f in self.freqs))

    async def stop(self) -> None:
        self._active = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self._proc is not None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self._proc.kill()
                    await self._proc.wait()
                except ProcessLookupError:
                    pass
            self._proc = None
        logger.info("SubGHzDecoder stopped")

    def status_dict(self) -> dict:
        return {
            "type":     "status",
            "running":  self._active,
            "freqs":    self.freqs,
            "cur_freq": self.cur_freq,
            "hop_s":    self.hop_s if len(self.freqs) > 1 else None,
            "devices":  len(self.devices),
            "events":   len(self.events),
            "last_log": self.last_log,
        }

    def device_list(self) -> list[dict]:
        return sorted(self.devices.values(), key=lambda d: d["last"], reverse=True)

    # ------------------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            async for line in self._proc.stdout:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "model" not in ev:
                    if "msg" in ev:
                        await self._log(str(ev["msg"]))
                    continue
                self._ingest(ev)
                if self._event_cb:
                    await self._event_cb({"type": "event", "event": ev,
                                          "device": self.devices[self._key(ev)]})
            logger.warning("rtl_433 stdout closed")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("SubGHz read loop error")

    async def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        try:
            async for line in self._proc.stderr:
                txt = line.decode("utf-8", "replace").strip()
                if txt:
                    await self._log(txt)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("SubGHz log loop error")

    async def _log(self, txt: str) -> None:
        self.last_log = txt[-160:]
        m = _TUNED_RE.search(txt)
        if m:
            self.cur_freq = round(float(m.group(1)) * 1e6)
            if self._status_cb:
                await self._status_cb(self.status_dict())

    @staticmethod
    def _key(ev: dict) -> str:
        return f'{ev.get("model")}/{ev.get("id", "-")}/{ev.get("channel", "-")}'

    def _ingest(self, ev: dict) -> None:
        now = time.time()
        key = self._key(ev)
        prev = self.devices.get(key)
        self.devices[key] = {
            "key":   key,
            "model": ev.get("model"),
            "id":    ev.get("id"),
            "channel": ev.get("channel"),
            "first": prev["first"] if prev else now,
            "last":  now,
            "count": (prev["count"] if prev else 0) + 1,
            "freq":  ev.get("freq"),
            "rssi":  ev.get("rssi"),
            "last_event": ev,
        }
        self.events.append(ev)


if __name__ == "__main__":
    # Offline self-test: feed canned rtl_433 JSON through the ingest path
    d = SubGHzDecoder(freqs=[433_920_000, 315_000_000])
    for raw in (
        '{"time":"1727200000","model":"Acurite-Tower","id":1234,"channel":"A","temperature_C":21.5,"rssi":-8.1}',
        '{"time":"1727200030","model":"Acurite-Tower","id":1234,"channel":"A","temperature_C":21.6,"rssi":-8.0}',
        '{"time":"1727200040","model":"Schrader","type":"TPMS","id":"8A1B2C3","pressure_kPa":230.0,"rssi":-15.2}',
    ):
        d._ingest(json.loads(raw))
    assert len(d.devices) == 2, d.devices.keys()
    assert d.devices["Acurite-Tower/1234/A"]["count"] == 2
    assert d.device_list()[0]["model"] == "Schrader"
    assert len(d.events) == 3
    print("PASS:", [f'{x["key"]} ×{x["count"]}' for x in d.device_list()])
