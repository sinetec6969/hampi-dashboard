"""
pager.py - POCSAG / FLEX pager decoder: rtl_fm | multimon-ng (device 0).

rtl_fm demodulates NBFM at 22050 Hz (multimon-ng's native raw rate) straight
into multimon-ng over an OS pipe. multimon-ng --json emits one object per
page for both POCSAG and FLEX, and flushes stdout per message by default in
current builds — no pty needed.

Pipeline argv adapted from smittix/intercept (Apache 2.0).

Requires: rtl_fm (rtl-sdr-blog build) + multimon-ng (source build — --json).
RTL-SDR device 0 must be free — the mode switcher stops rtl_tcp first.
"""

import asyncio
import json
import logging
import os
import time
from collections import deque
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

MsgCb = Callable[[dict], Awaitable[None]]

DEMODS = ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"]


def normalize(raw: dict) -> dict:
    """POCSAG and FLEX JSON use different keys — fold into one page shape."""
    text = raw.get("alpha") or raw.get("message") or raw.get("numeric") or raw.get("tone") or ""
    return {
        "type":  "page",
        "ts":    time.time(),
        "proto": raw.get("demod_name", "?"),
        "addr":  raw.get("address", raw.get("capcode")),
        "func":  raw.get("function"),
        "text":  text.strip(),
    }


class PagerDecoder:
    def __init__(
        self,
        freq: int,
        gain: float = 40.0,
        rtl_device: int = 0,
        message_callback: Optional[MsgCb] = None,
        status_callback: Optional[MsgCb] = None,
    ):
        self.freq       = freq
        self.gain       = gain
        self.rtl_device = rtl_device
        self._msg_cb    = message_callback
        self._status_cb = status_callback

        self.messages: deque[dict] = deque(maxlen=300)
        self.count = 0
        self.last_log = ""
        self._rtl: Optional[asyncio.subprocess.Process] = None
        self._mm:  Optional[asyncio.subprocess.Process] = None
        self._tasks: list[asyncio.Task] = []
        self._active = False

    async def start(self) -> None:
        r, w = os.pipe()
        try:
            self._rtl = await asyncio.create_subprocess_exec(
                "rtl_fm", "-d", str(self.rtl_device), "-f", str(self.freq),
                "-M", "fm", "-s", "22050", "-g", str(self.gain), "-",
                stdout=w, stderr=asyncio.subprocess.PIPE,
            )
            self._mm = await asyncio.create_subprocess_exec(
                "multimon-ng", "-t", "raw", "--json", "-e",
                *[a for d in DEMODS for a in ("-a", d)], "-f", "alpha", "-",
                stdin=r, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        finally:
            os.close(r)
            os.close(w)

        # rtl_fm exits within a second when device 0 is still held
        try:
            await asyncio.wait_for(self._rtl.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass
        else:
            err = (await self._rtl.stderr.read()).decode("utf-8", "replace").strip()
            await self._kill_all()
            raise RuntimeError(f"rtl_fm exited: {err[-200:]}")

        self._active = True
        self._tasks = [
            asyncio.create_task(self._read_pages(), name="pager-read"),
            asyncio.create_task(self._read_rtl_log(), name="pager-log"),
        ]
        logger.info("PagerDecoder started — %.4f MHz gain %.1f", self.freq / 1e6, self.gain)
        if self._status_cb:
            await self._status_cb(self.status_dict())

    async def stop(self) -> None:
        self._active = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        await self._kill_all()
        logger.info("PagerDecoder stopped")

    async def retune(self, freq: int, gain: Optional[float] = None) -> None:
        # rtl_fm has no control channel — restart the pipeline on the new freq
        await self.stop()
        self.freq = freq
        if gain is not None:
            self.gain = gain
        await self.start()

    def status_dict(self) -> dict:
        return {
            "type":     "status",
            "running":  self._active,
            "freq":     self.freq,
            "gain":     self.gain,
            "count":    self.count,
            "last_log": self.last_log,
        }

    # ------------------------------------------------------------------

    async def _kill_all(self) -> None:
        # rtl_fm first — multimon-ng then sees EOF and exits on its own
        for proc in (self._rtl, self._mm):
            if proc is None:
                continue
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    proc.kill()
                    await proc.wait()
                except ProcessLookupError:
                    pass
        self._rtl = self._mm = None

    async def _read_pages(self) -> None:
        assert self._mm is not None and self._mm.stdout is not None
        try:
            async for line in self._mm.stdout:
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                page = normalize(raw)
                self.messages.append(page)
                self.count += 1
                if self._msg_cb:
                    await self._msg_cb(page)
            logger.warning("multimon-ng stdout closed")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Pager read loop error")

    async def _read_rtl_log(self) -> None:
        assert self._rtl is not None and self._rtl.stderr is not None
        try:
            async for line in self._rtl.stderr:
                txt = line.decode("utf-8", "replace").strip()
                if txt:
                    self.last_log = txt[-160:]
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Pager log loop error")


if __name__ == "__main__":
    # Offline self-test: canned multimon-ng --json lines through normalize()
    pocsag = normalize({"demod_name": "POCSAG1200", "address": 1234567, "function": 3,
                        "alpha": "CODE BLUE RM 412 "})
    flex = normalize({"demod_name": "flex_alphanumeric", "capcode": 2029568,
                      "message": "TEST PAGE", "timestamp": "2026-09-24 20:00:00"})
    tone = normalize({"demod_name": "POCSAG512", "address": 77, "function": 0})
    assert pocsag["addr"] == 1234567 and pocsag["text"] == "CODE BLUE RM 412", pocsag
    assert flex["addr"] == 2029568 and flex["text"] == "TEST PAGE", flex
    assert tone["text"] == "" and tone["func"] == 0
    print("PASS:", [(p["proto"], p["addr"], p["text"]) for p in (pocsag, flex, tone)])
