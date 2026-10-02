"""
camera.py - on-demand USB-webcam MJPEG relay (shack cam).

The EMEET C960 (and most USB webcams) output Motion-JPEG natively, so we run
ffmpeg with `-c copy` — no decode/re-encode, cheap on the Pi — and split its
MJPEG byte stream back into individual JPEG frames on the SOI/EOI markers.

On demand ("click to view"): ffmpeg starts when the first viewer connects and
stops a few seconds after the last one leaves, so the camera and its USB
bandwidth are free the rest of the time (the RTL-SDR shares the USB bus). One
ffmpeg process fans out to all viewers; a webcam can't be opened twice.
"""

import asyncio
import logging
import os
import time

logger = logging.getLogger(__name__)

_SOI = b"\xff\xd8"   # JPEG start-of-image
_EOI = b"\xff\xd9"   # JPEG end-of-image
_STOP_GRACE_S = 4.0
_MAX_FRAME = 4 * 1024 * 1024


class Camera:
    def __init__(self, device: str, width: int = 1280, height: int = 720, fps: int = 15):
        self.device = device
        self.width = width
        self.height = height
        self.fps = fps
        self._proc: "asyncio.subprocess.Process | None" = None
        self._reader: "asyncio.Task | None" = None
        self._subscribers: "set[asyncio.Queue]" = set()
        self._latest: "bytes | None" = None
        self._latest_ts = 0.0
        self._frames = 0
        self._error = ""
        self._stop_task: "asyncio.Task | None" = None
        self._lock = asyncio.Lock()

    def present(self) -> bool:
        dev = self.device
        if dev.startswith("/dev/v4l/by-id/"):
            try:
                dev = os.path.realpath(dev)
            except OSError:
                pass
        return os.path.exists(dev)

    # ---------------------------------------------------------------- lifecycle

    async def _start_ffmpeg(self) -> None:
        if self._proc is not None:
            return
        if not self.present():
            self._error = f"camera device {self.device} not present"
            raise RuntimeError(self._error)
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-f", "v4l2", "-input_format", "mjpeg",
            "-video_size", f"{self.width}x{self.height}", "-framerate", str(self.fps),
            "-i", self.device,
            "-c", "copy", "-f", "mjpeg", "pipe:1",
        ]
        logger.info("Camera: starting ffmpeg (%dx%d @%dfps) on %s",
                    self.width, self.height, self.fps, self.device)
        self._proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self._error = ""
        self._reader = asyncio.create_task(self._read_loop(), name="camera-read")

    async def stop(self) -> None:
        if self._stop_task:
            self._stop_task.cancel()
            self._stop_task = None
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
            self._reader = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
            self._proc = None
        logger.info("Camera: stopped")

    async def _schedule_stop(self) -> None:
        # stop a few seconds after the last viewer leaves (debounce quick reloads)
        if self._stop_task:
            self._stop_task.cancel()
        async def _later():
            await asyncio.sleep(_STOP_GRACE_S)
            if not self._subscribers:
                await self.stop()
        self._stop_task = asyncio.create_task(_later(), name="camera-stop")

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        buf = bytearray()
        try:
            while True:
                chunk = await self._proc.stdout.read(65536)
                if not chunk:
                    err = b""
                    if self._proc.stderr:
                        try:
                            err = await asyncio.wait_for(self._proc.stderr.read(400), timeout=0.5)
                        except asyncio.TimeoutError:
                            pass
                    self._error = err.decode("utf-8", "replace").strip()[-200:] or "ffmpeg ended"
                    logger.warning("Camera: ffmpeg output closed — %s", self._error)
                    break
                buf += chunk
                # emit every complete JPEG sitting in the buffer
                while True:
                    start = buf.find(_SOI)
                    if start < 0:
                        if len(buf) > _MAX_FRAME:
                            del buf[:-2]
                        break
                    end = buf.find(_EOI, start + 2)
                    if end < 0:
                        if start > 0:
                            del buf[:start]
                        break
                    frame = bytes(buf[start:end + 2])
                    del buf[:end + 2]
                    self._latest = frame
                    self._latest_ts = time.time()
                    self._frames += 1
                    for q in list(self._subscribers):
                        if q.full():
                            try: q.get_nowait()
                            except asyncio.QueueEmpty: pass
                        q.put_nowait(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Camera: read loop error")

    # ---------------------------------------------------------------- consumers

    async def frames(self):
        """Async generator of JPEG frames for one viewer. Starts the camera if needed."""
        q: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=2)
        async with self._lock:
            self._subscribers.add(q)
            if self._stop_task:
                self._stop_task.cancel(); self._stop_task = None
            try:
                await self._start_ffmpeg()
            except Exception:
                self._subscribers.discard(q)
                raise
        try:
            if self._latest is not None:
                yield self._latest
            while True:
                yield await q.get()
        finally:
            self._subscribers.discard(q)
            if not self._subscribers:
                await self._schedule_stop()

    async def snapshot(self) -> bytes:
        """One JPEG. Reuses the live frame if streaming, else a one-shot grab."""
        if self._latest is not None and time.time() - self._latest_ts < 2.0:
            return self._latest
        if self._proc is not None and self._latest is not None:
            return self._latest
        if not self.present():
            raise RuntimeError(f"camera device {self.device} not present")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-f", "v4l2", "-input_format", "mjpeg",
            "-video_size", f"{self.width}x{self.height}", "-i", self.device,
            "-frames:v", "1", "-c", "copy", "-f", "mjpeg", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        if not out:
            raise RuntimeError("camera snapshot failed")
        return out

    def status(self) -> dict:
        return {
            "present": self.present(),
            "streaming": self._proc is not None,
            "viewers": len(self._subscribers),
            "width": self.width, "height": self.height, "fps": self.fps,
            "frames": self._frames,
            "last_frame_age": round(time.time() - self._latest_ts, 1) if self._latest_ts else None,
            "device": self.device,
            "error": self._error,
        }


if __name__ == "__main__":
    # Offline: JPEG framing logic (no camera, no ffmpeg)
    c = Camera("/dev/null")
    two = _SOI + b"AAAA" + _EOI + _SOI + b"BBBBBB" + _EOI
    # drive the split logic directly
    buf = bytearray(b"\x00\x01" + two + _SOI + b"CC")  # trailing partial frame
    frames = []
    while True:
        s = buf.find(_SOI)
        if s < 0: break
        e = buf.find(_EOI, s + 2)
        if e < 0:
            if s > 0: del buf[:s]
            break
        frames.append(bytes(buf[s:e+2])); del buf[:e+2]
    assert frames == [_SOI + b"AAAA" + _EOI, _SOI + b"BBBBBB" + _EOI], frames
    assert bytes(buf) == _SOI + b"CC"   # partial frame retained for next read
    assert c.status()["present"] is True  # /dev/null exists
    print("PASS: JPEG SOI/EOI framing + partial-frame retention")
