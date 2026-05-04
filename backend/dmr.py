"""
dmr.py - Async DMR decoder wrapping the DSD (Digital Speech Decoder) binary.

DSD command line used:
    dsd -i - -o - -fr -v 10

  -i -   read raw int16 PCM from stdin
  -o -   write decoded audio to stdout
  -fr    force DMR/MOTOTRBO framing
  -v 10  verbose level 10 (produces SLOT/frame metadata on stderr)
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field, asdict
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

# Regex helpers for stderr parsing
_RE_SLOT0 = re.compile(r"\[SLOT0\]", re.IGNORECASE)
_RE_SLOT1 = re.compile(r"\[SLOT1\]", re.IGNORECASE)
_RE_FRAME = re.compile(r"\b(VOICE|TLC|MBC|DATA)\b", re.IGNORECASE)
_RE_ERRORS = re.compile(r"e:\s*([EO.]+)", re.IGNORECASE)

AudioCallback = Callable[[bytes], Awaitable[None]]
MetaCallback  = Callable[[dict], Awaitable[None]]


@dataclass
class DMRFrame:
    sync:       bool = False
    timeslot:   int  = 0          # 0 or 1
    frame_type: str  = "UNKNOWN"  # VOICE / TLC / MBC / DATA / UNKNOWN
    errors:     int  = 0          # count of 'E' chars in error field
    raw_line:   str  = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_dmr_line(line: str) -> Optional[DMRFrame]:
    """
    Parse a single DSD stderr line into a DMRFrame.

    Returns None if the line carries no useful DMR information.
    """
    line = line.strip()
    if not line:
        return None

    frame = DMRFrame(raw_line=line)

    # Timeslot detection
    if _RE_SLOT1.search(line):
        frame.timeslot = 1
        frame.sync = True
    elif _RE_SLOT0.search(line):
        frame.timeslot = 0
        frame.sync = True
    else:
        # Lines without explicit SLOT tags are not DMR frame lines
        return None

    # Frame type
    m = _RE_FRAME.search(line)
    if m:
        frame.frame_type = m.group(1).upper()

    # Error count: count capital 'E' in the error field after 'e:'
    m = _RE_ERRORS.search(line)
    if m:
        frame.errors = m.group(1).count("E")

    return frame


class DMRDecoder:
    """
    Async wrapper around the DSD binary.

    Usage:
        decoder = DMRDecoder(audio_callback=..., meta_callback=...)
        await decoder.start()
        await decoder.write_audio(pcm_bytes)
        ...
        await decoder.stop()
    """

    DSD_ARGS = ["dsd", "-i", "-", "-o", "-", "-fr", "-v", "10"]

    def __init__(
        self,
        audio_callback: AudioCallback,
        meta_callback:  MetaCallback,
    ):
        self._audio_cb = audio_callback
        self._meta_cb  = meta_callback

        self._proc:  Optional[asyncio.subprocess.Process] = None
        self._tasks: list[asyncio.Task] = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Launch DSD and start background reader tasks."""
        logger.info("Starting DSD: %s", " ".join(self.DSD_ARGS))
        self._proc = await asyncio.create_subprocess_exec(
            *self.DSD_ARGS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        self._tasks = [
            asyncio.create_task(self._read_audio(),  name="dsd-audio"),
            asyncio.create_task(self._read_meta(),   name="dsd-meta"),
        ]
        logger.info("DSD started (pid=%d)", self._proc.pid)

    async def stop(self) -> None:
        """Gracefully shut down DSD and cancel reader tasks."""
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        if self._proc:
            try:
                if self._proc.stdin and not self._proc.stdin.is_closing():
                    self._proc.stdin.close()
                    await self._proc.stdin.wait_closed()
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except (ProcessLookupError, asyncio.TimeoutError):
                self._proc.kill()
            self._proc = None

        logger.info("DMRDecoder stopped")

    # ------------------------------------------------------------------
    # Audio input
    # ------------------------------------------------------------------

    async def write_audio(self, pcm_bytes: bytes) -> None:
        """
        Feed raw int16 PCM bytes into DSD stdin.

        This is called from the SDR loop with FM-demodulated audio.
        """
        if self._proc is None or self._proc.stdin is None:
            return
        if self._proc.stdin.is_closing():
            return
        try:
            self._proc.stdin.write(pcm_bytes)
            await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.warning("DSD stdin pipe broken")

    # ------------------------------------------------------------------
    # Background readers
    # ------------------------------------------------------------------

    async def _read_audio(self) -> None:
        """Read decoded audio chunks from DSD stdout and forward to callback."""
        if self._proc is None or self._proc.stdout is None:
            return
        CHUNK = 4096
        try:
            while True:
                data = await self._proc.stdout.read(CHUNK)
                if not data:
                    logger.info("DSD stdout closed")
                    break
                try:
                    await self._audio_cb(data)
                except Exception:
                    logger.exception("audio_callback raised an exception")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in DSD audio reader")

    async def _read_meta(self) -> None:
        """Read DSD stderr line-by-line, parse DMR metadata, call meta_callback."""
        if self._proc is None or self._proc.stderr is None:
            return
        try:
            async for raw_line in self._proc.stderr:
                line = raw_line.decode(errors="replace")
                frame = _parse_dmr_line(line)
                if frame is not None:
                    try:
                        await self._meta_cb(frame.to_dict())
                    except Exception:
                        logger.exception("meta_callback raised an exception")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in DSD meta reader")
