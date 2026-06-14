"""
meteor.py - METEOR-M LRPT decoder via SatDump (subprocess on device 0).

LRPT is QPSK → Viterbi → Reed-Solomon → CCSDS VCDU → JPEG: far too much to
hand-roll, so we drive SatDump's `live` decoder as a subprocess. SatDump's
Debian 1.2.2 build ships the native `rtlsdr` source plugin but it fails to
register a handler, so we feed it through the working `rtltcp` source: we run
our own dedicated `rtl_tcp` (satdump's sole client) and satdump connects to it,
setting frequency/gain/samplerate. SatDump writes MSU-MR image products into an
output directory; we watch it and surface new PNGs.

Requires: satdump + rtl_tcp. RTL-SDR device 0 must be free — the mode switcher
stops the DMR stack's rtl_tcp before starting this.
"""

import asyncio
import logging
import os
import re
import socket
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

StatusCb = Callable[[dict], Awaitable[None]]
ImageCb  = Callable[[dict], Awaitable[None]]

_SNR_RE = re.compile(r"SNR\s*[:=]?\s*(-?\d+\.?\d*)\s*dB", re.IGNORECASE)


class MeteorDecoder:
    def __init__(
        self,
        image_dir: str,
        freq: int = 137_900_000,
        samplerate: int = 1_000_000,
        gain: float = 42.0,
        pipeline: str = "meteor_m2_lrpt",
        rtl_dev: int = 0,
        rtl_port: int = 1236,
        status_callback: Optional[StatusCb] = None,
        image_callback: Optional[ImageCb] = None,
    ):
        self.image_dir  = image_dir
        self.freq       = freq
        self.samplerate = samplerate
        self.gain       = gain
        self.pipeline   = pipeline
        self.rtl_dev    = rtl_dev
        self.rtl_port   = rtl_port
        self._status_cb = status_callback
        self._image_cb  = image_callback

        self.snr        = 0.0
        self.last_log   = ""
        self._seen: set[str] = set()
        self._proc:  Optional[asyncio.subprocess.Process] = None
        self._rtl:   Optional[asyncio.subprocess.Process] = None
        self._read_task:  Optional[asyncio.Task] = None
        self._watch_task: Optional[asyncio.Task] = None
        self._active = False

    async def _wait_port(self, timeout: float = 6.0) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.rtl_port), timeout=1):
                    return True
            except OSError:
                await asyncio.sleep(0.3)
        return False

    async def start(self) -> None:
        os.makedirs(self.image_dir, exist_ok=True)
        self._seen = set(self._scan())  # don't re-announce existing images

        # Dedicated rtl_tcp — satdump's rtltcp source will be its only client and
        # will command frequency / gain / samplerate. The previous owner's USB
        # interface can take a moment to release after its process exits, so retry.
        last_err = ""
        for attempt in range(4):
            self._rtl = await asyncio.create_subprocess_exec(
                "rtl_tcp", "-a", "127.0.0.1", "-p", str(self.rtl_port), "-d", str(self.rtl_dev),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            if await self._wait_port():
                break
            try:
                err = await asyncio.wait_for(self._rtl.stderr.read(800), timeout=1)
                last_err = err.decode("utf-8", "replace").strip()[-200:]
            except Exception:
                pass
            await self._kill(self._rtl)
            self._rtl = None
            logger.warning("rtl_tcp launch attempt %d failed (%s) — retrying", attempt + 1, last_err)
            await asyncio.sleep(1.5)
        else:
            raise RuntimeError(f"rtl_tcp did not come up on port {self.rtl_port}: {last_err}")

        cmd = [
            "satdump", "live", self.pipeline, self.image_dir,
            "--source", "rtltcp", "--ip_address", "127.0.0.1", "--port", str(self.rtl_port),
            "--samplerate", str(self.samplerate),
            "--frequency", str(self.freq),
            "--gain", str(self.gain),
        ]
        logger.info("Starting SatDump: %s", " ".join(cmd))
        self._proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        self._active     = True
        self._read_task  = asyncio.create_task(self._read_loop(),  name="meteor-read")
        self._watch_task = asyncio.create_task(self._watch_loop(), name="meteor-watch")
        logger.info("MeteorDecoder started — %.3f MHz, pipeline=%s",
                    self.freq / 1e6, self.pipeline)

    async def _kill(self, proc: Optional[asyncio.subprocess.Process]) -> None:
        if proc is None:
            return
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    async def stop(self) -> None:
        self._active = False
        for t in (self._read_task, self._watch_task):
            if t is not None:
                t.cancel()
        await asyncio.gather(*(t for t in (self._read_task, self._watch_task) if t),
                             return_exceptions=True)
        self._read_task = self._watch_task = None
        await self._kill(self._proc)   # satdump first (it's the rtl_tcp client)
        await self._kill(self._rtl)
        self._proc = self._rtl = None
        logger.info("MeteorDecoder stopped")

    def _scan(self) -> list[str]:
        out = []
        for root, _, files in os.walk(self.image_dir):
            for f in files:
                if f.lower().endswith(".png"):
                    out.append(os.path.relpath(os.path.join(root, f), self.image_dir))
        return sorted(out)

    def status_dict(self) -> dict:
        return {
            "type":     "status",
            "running":  self._active,
            "freq":     self.freq,
            "pipeline": self.pipeline,
            "snr":      round(self.snr, 1),
            "images":   len(self._scan()),
            "last_log": self.last_log,
        }

    # ------------------------------------------------------------------

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while self._active:
                line = await self._proc.stdout.readline()
                if not line:
                    logger.warning("SatDump output closed")
                    break
                txt = line.decode("utf-8", errors="replace").strip()
                if not txt:
                    continue
                self.last_log = txt[-160:]
                m = _SNR_RE.search(txt)
                if m:
                    try:
                        self.snr = float(m.group(1))
                    except ValueError:
                        pass
                if self._status_cb:
                    await self._status_cb(self.status_dict())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("METEOR read loop error")

    async def _watch_loop(self) -> None:
        try:
            while self._active:
                await asyncio.sleep(2.0)
                for rel in self._scan():
                    if rel not in self._seen:
                        self._seen.add(rel)
                        logger.info("METEOR image: %s", rel)
                        if self._image_cb:
                            await self._image_cb({"type": "image", "path": rel})
        except asyncio.CancelledError:
            raise


if __name__ == "__main__":
    # Offline checks — no SDR, no satdump process.
    import tempfile
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "MSU-MR"))
    open(os.path.join(d, "MSU-MR", "rgb.png"), "wb").close()
    md = MeteorDecoder(d, freq=137_900_000)
    assert md._scan() == ["MSU-MR/rgb.png"], md._scan()
    s = md.status_dict()
    assert s["images"] == 1 and s["freq"] == 137_900_000 and s["pipeline"] == "meteor_m2_lrpt"
    assert _SNR_RE.search("(I) Demod SNR : 12.4 dB Peak").group(1) == "12.4"
    print("PASS: scan + status + SNR parse")
