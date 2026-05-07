"""
dmr.py - Async DMR decoder wrapping the DSD (Digital Speech Decoder) binary.

DSD command line used:
    dsd -i - -o - -fr -v 10

  -i -   read raw int16 PCM from stdin
  -o -   write decoded audio to stdout
  -fr    force DMR/MOTOTRBO framing
  -v 10  verbose level 10

NOTE: This DSD build writes ALL output (frame metadata text AND decoded PCM audio)
to stdout. Stderr is unused. The _read_stdout task splits the mixed stream:
printable ASCII lines → DMR metadata parser; binary chunks → audio callback.
"""

import asyncio
import logging
import re
from dataclasses import dataclass, asdict, field
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

# --- Regex patterns -------------------------------------------------------
# Active slot has brackets: [SLOT0] or [slot0]. Inactive is lowercase no-brackets: slot1.
# Brackets are required to avoid matching the inactive-slot label on the same line.
_RE_SLOT0  = re.compile(r'\[(?:SLOT|TS|TIMESLOT)\s*0\]', re.IGNORECASE)
_RE_SLOT1  = re.compile(r'\[(?:SLOT|TS|TIMESLOT)\s*1\]', re.IGNORECASE)
# Frame type
_RE_FRAME  = re.compile(r'\b(VOICE|TLC|MBC|DATA|HDR|HEADER)\b', re.IGNORECASE)
# Error field
_RE_ERRORS = re.compile(r'e:\s*([EO.]+)', re.IGNORECASE)
# Source/destination — handle =, :, : space, or just space
_RE_SRC    = re.compile(r'\bsrc(?:_id)?\s*[=:]\s*(\d+)', re.IGNORECASE)
_RE_DST    = re.compile(r'\bdst(?:_id|_tg)?\s*[=:]\s*(\d+)', re.IGNORECASE)
# Also catch "Source: 123456" and "Destination Talkgroup: 123"
_RE_SRC2   = re.compile(r'\bSource\s*:\s*(\d+)', re.IGNORECASE)
_RE_DST2   = re.compile(r'\bDestination\s+(?:Talkgroup\s*)?:\s*(\d+)', re.IGNORECASE)
# Group call indicator
_RE_GRP    = re.compile(r'\b(?:GRP|GROUP|TGID|Group:\s*Yes)\b', re.IGNORECASE)
# -------------------------------------------------------------------------

AudioCallback = Callable[[bytes], Awaitable[None]]
MetaCallback  = Callable[[dict], Awaitable[None]]


@dataclass
class DMRFrame:
    sync:       bool = False
    timeslot:   int  = 0
    frame_type: str  = "UNKNOWN"
    errors:     int  = 0
    src_id:     int  = 0       # source radio ID (DMR ID)
    dst_id:     int  = 0       # destination: talk group or radio ID
    group:      bool = True    # True = group call, False = private call
    raw_line:   str  = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_dmr_line(line: str) -> Optional[tuple[Optional[DMRFrame], dict]]:
    """
    Parse a single DSD stderr line.

    Returns (frame, lc_update) where:
      frame      — DMRFrame if this line is a SLOT frame line, else None
      lc_update  — dict of {timeslot, src_id, dst_id, group} if LC fields
                   were found (may apply to a previously seen slot), else {}
    """
    line = line.strip()
    if not line:
        return None, {}

    # Extract LC fields — try multiple formats DSD may use
    lc: dict = {}
    m = _RE_SRC.search(line) or _RE_SRC2.search(line)
    if m:
        lc["src_id"] = int(m.group(1))
    m = _RE_DST.search(line) or _RE_DST2.search(line)
    if m:
        lc["dst_id"] = int(m.group(1))
    if lc:
        lc["group"] = bool(_RE_GRP.search(line))

    # Determine timeslot
    if _RE_SLOT1.search(line):
        timeslot, synced = 1, True
    elif _RE_SLOT0.search(line):
        timeslot, synced = 0, True
    else:
        # Line has no SLOT tag — LC fields (if any) belong to the last slot
        return None, lc

    # Associate LC with this slot
    if lc:
        lc["timeslot"] = timeslot

    frame = DMRFrame(sync=synced, timeslot=timeslot, raw_line=line)

    m = _RE_FRAME.search(line)
    if m:
        frame.frame_type = m.group(1).upper()

    m = _RE_ERRORS.search(line)
    if m:
        frame.errors = m.group(1).count("E")

    return frame, lc


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

    # stdbuf -oL forces line-buffered stdout so frame metadata arrives immediately
    # instead of batching in the default 8KB pipe buffer.
    DSD_ARGS = ["stdbuf", "-oL", "dsd", "-i", "-", "-o", "-", "-fr", "-v", "10"]

    def __init__(self, audio_callback: AudioCallback, meta_callback: MetaCallback):
        self._audio_cb = audio_callback
        self._meta_cb  = meta_callback
        self._proc:  Optional[asyncio.subprocess.Process] = None
        self._tasks: list[asyncio.Task] = []
        # Per-slot LC context: carries src_id, dst_id, group across frames
        self._slot_ctx: dict[int, dict] = {
            0: {"src_id": 0, "dst_id": 0, "group": True},
            1: {"src_id": 0, "dst_id": 0, "group": True},
        }
        self._last_slot = 0   # used to associate tagless LC lines

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        logger.info("Starting DSD: %s", " ".join(self.DSD_ARGS))
        self._proc = await asyncio.create_subprocess_exec(
            *self.DSD_ARGS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._tasks = [
            asyncio.create_task(self._read_stdout(), name="dsd-stdout"),
        ]
        logger.info("DSD started (pid=%d)", self._proc.pid)

    async def stop(self) -> None:
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
    # Background reader — splits DSD stdout into text metadata + PCM audio
    # ------------------------------------------------------------------

    async def _read_stdout(self) -> None:
        """
        DSD writes both frame-info text lines and decoded PCM audio to stdout.
        This task reads the mixed stream and routes each piece appropriately:
          - Printable ASCII line (ends with \\n, no control bytes) → metadata parser
          - Everything else → audio callback
        """
        if self._proc is None or self._proc.stdout is None:
            return

        _dbg = open("/tmp/dsd_stdout.log", "w", buffering=1)
        buf = bytearray()

        def _is_text_line(data: bytes) -> bool:
            """Return True if data looks like a printable ASCII text line."""
            return all(b >= 0x20 or b in (0x09, 0x0a, 0x0d) for b in data)

        async def _dispatch_meta(line: str) -> None:
            _dbg.write(line)
            result = _parse_dmr_line(line)
            if result is None:
                return
            frame, lc = result
            if lc:
                slot = lc.get("timeslot", self._last_slot)
                ctx  = self._slot_ctx[slot]
                if lc.get("src_id"):
                    ctx["src_id"] = lc["src_id"]
                if lc.get("dst_id"):
                    ctx["dst_id"] = lc["dst_id"]
                ctx["group"] = lc.get("group", ctx["group"])
            if frame is not None:
                self._last_slot = frame.timeslot
                ctx = self._slot_ctx[frame.timeslot]
                frame.src_id = ctx["src_id"]
                frame.dst_id = ctx["dst_id"]
                frame.group  = ctx["group"]
                try:
                    await self._meta_cb(frame.to_dict())
                except Exception:
                    logger.exception("meta_callback raised an exception")

        try:
            while True:
                chunk = await self._proc.stdout.read(4096)
                if not chunk:
                    logger.info("DSD stdout closed")
                    break
                buf.extend(chunk)

                # Drain complete lines and audio frames from the buffer
                while buf:
                    nl = buf.find(0x0a)  # look for newline

                    if nl == -1:
                        # No newline yet — flush complete audio frames (320 bytes each)
                        if len(buf) >= 320:
                            n = (len(buf) // 320) * 320
                            audio = bytes(buf[:n])
                            del buf[:n]
                            try:
                                await self._audio_cb(audio)
                            except Exception:
                                logger.exception("audio_callback raised an exception")
                        break

                    candidate = buf[:nl + 1]

                    if _is_text_line(candidate):
                        # Metadata text line
                        del buf[:nl + 1]
                        await _dispatch_meta(candidate.decode("ascii", errors="replace"))
                    else:
                        # Binary PCM that happens to contain 0x0a — send as audio
                        # Flush up to and including the newline byte
                        audio = bytes(candidate)
                        del buf[:nl + 1]
                        try:
                            await self._audio_cb(audio)
                        except Exception:
                            logger.exception("audio_callback raised an exception")

        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in DSD stdout reader")
        finally:
            _dbg.close()
