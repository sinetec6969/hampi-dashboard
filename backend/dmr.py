"""
dmr.py - Async DMR decoder wrapping the DSD (Digital Speech Decoder) binary.

DSD command line used:
    dsd -i - -n -w /tmp/dsd_audio.fifo -fr -v 10

  -i -   read raw int16 PCM from stdin
  -n     suppress portaudio audio output (audio goes to -w only)
  -w     write decoded audio as WAV to a named FIFO pipe
  -fr    force DMR/MOTOTRBO framing
  -v 10  verbose level 10

DSD's portaudio backend cannot write to a socket fd (what subprocess PIPE
creates), so -o - silently produces no audio. Using -w with a named FIFO
routes decoded PCM through normal file I/O which works reliably.

stdout → pure text metadata lines → DMR metadata parser
FIFO   → WAV header (44 bytes) + raw int16 PCM at 8000 Hz → audio callback
stderr → LC header lines (CC/mfid) with src/dst → slot context
"""

import asyncio
import logging
import os
import re
from dataclasses import dataclass, asdict
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

AUDIO_WAV     = "/tmp/dsd_audio.wav"
WAV_HDR_BYTES = 44    # standard RIFF WAV header size to skip
AUDIO_CHUNK   = 3200  # bytes per read (200 ms at 8000 Hz 16-bit)
AUDIO_POLL_S  = 0.02  # seconds to wait when no new PCM data yet

# --- Regex patterns -------------------------------------------------------
# Active slot has brackets: [SLOT0] or [slot0]. Inactive is lowercase no-brackets: slot1.
_RE_SLOT0  = re.compile(r'\[(?:SLOT|TS|TIMESLOT)\s*0\]', re.IGNORECASE)
_RE_SLOT1  = re.compile(r'\[(?:SLOT|TS|TIMESLOT)\s*1\]', re.IGNORECASE)
# Frame type
_RE_FRAME  = re.compile(r'\b(VOICE|TLC|MBC|DATA|HDR|HEADER)\b', re.IGNORECASE)
# Error field
_RE_ERRORS = re.compile(r'e:\s*([EO.]+)', re.IGNORECASE)
# Source/destination — multiple DSD output formats
_RE_SRC    = re.compile(r'\bsrc(?:_id)?\s*[=:]\s*(\d+)', re.IGNORECASE)
_RE_DST    = re.compile(r'\bdst(?:_id|_tg)?\s*[=:]\s*(\d+)', re.IGNORECASE)
_RE_SRC2   = re.compile(r'\bSource\s*:\s*(\d+)', re.IGNORECASE)
_RE_DST2   = re.compile(r'\bDestination\s+(?:Talkgroup\s*)?:\s*(\d+)', re.IGNORECASE)
_RE_CC_SRC = re.compile(r'\bSRC\s*[=:]\s*(\d+)', re.IGNORECASE)
_RE_CC_DST = re.compile(r'\bDST\s*[=:]\s*(\d+)', re.IGNORECASE)
_RE_CC_SLOT= re.compile(r'\b(?:SLOT|TS)\s*[=:]\s*([01])\b', re.IGNORECASE)
# Group call indicator
_RE_GRP    = re.compile(r'\b(?:GRP|GROUP|TGID|Group:\s*Yes)\b', re.IGNORECASE)
_RE_GRP2   = re.compile(r'\bGRP\s*[=:]\s*([01])\b', re.IGNORECASE)
# Strip ANSI escape codes before parsing
_RE_ANSI   = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
# -------------------------------------------------------------------------

AudioCallback = Callable[[bytes], Awaitable[None]]
MetaCallback  = Callable[[dict], Awaitable[None]]


@dataclass
class DMRFrame:
    sync:       bool = False
    timeslot:   int  = 0
    frame_type: str  = "UNKNOWN"
    errors:     int  = 0
    src_id:     int  = 0
    dst_id:     int  = 0
    group:      bool = True
    raw_line:   str  = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_dmr_line(line: str) -> Optional[tuple[Optional[DMRFrame], dict]]:
    """
    Parse a single DSD stdout/stderr text line.

    Returns (frame, lc_update) where:
      frame      — DMRFrame if this line is a SLOT frame line, else None
      lc_update  — dict of LC fields found (src_id, dst_id, group, timeslot)
    """
    line = _RE_ANSI.sub("", line).strip()
    if not line:
        return None, {}

    lc: dict = {}
    m = (_RE_CC_SRC.search(line) or _RE_SRC.search(line) or _RE_SRC2.search(line))
    if m:
        lc["src_id"] = int(m.group(1))
    m = (_RE_CC_DST.search(line) or _RE_DST.search(line) or _RE_DST2.search(line))
    if m:
        lc["dst_id"] = int(m.group(1))
    if lc:
        grp_m = _RE_GRP2.search(line)
        lc["group"] = (int(grp_m.group(1)) == 1) if grp_m else bool(_RE_GRP.search(line))

    # Determine timeslot
    if _RE_SLOT1.search(line):
        timeslot, synced = 1, True
    elif _RE_SLOT0.search(line):
        timeslot, synced = 0, True
    else:
        m = _RE_CC_SLOT.search(line)
        if m and lc:
            lc["timeslot"] = int(m.group(1))
            return None, lc
        return None, lc

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


def _apply_lc(lc: dict, slot_ctx: dict, last_slot: int) -> int:
    """Merge LC fields into per-slot context. Returns updated last_slot."""
    slot = lc.get("timeslot", last_slot)
    ctx  = slot_ctx[slot]
    if lc.get("src_id"):
        ctx["src_id"] = lc["src_id"]
    if lc.get("dst_id"):
        ctx["dst_id"] = lc["dst_id"]
    ctx["group"] = lc.get("group", ctx["group"])
    return last_slot


class DMRDecoder:
    """Async wrapper around the DSD binary."""

    DSD_ARGS = [
        "stdbuf", "-o0",
        "dsd", "-i", "-", "-n", "-w", AUDIO_WAV, "-fr", "-v", "10",
    ]

    def __init__(self, audio_callback: AudioCallback, meta_callback: MetaCallback):
        self._audio_cb = audio_callback
        self._meta_cb  = meta_callback
        self._proc:       Optional[asyncio.subprocess.Process] = None
        self._tasks:      list[asyncio.Task] = []
        self._audio_fh:   Optional[object]   = None  # file handle for WAV reader
        self._slot_ctx:   dict[int, dict]    = {
            0: {"src_id": 0, "dst_id": 0, "group": True},
            1: {"src_id": 0, "dst_id": 0, "group": True},
        }
        self._last_slot = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        # Remove stale WAV file from a previous run
        try:
            os.unlink(AUDIO_WAV)
        except FileNotFoundError:
            pass

        logger.info("Starting DSD: %s", " ".join(self.DSD_ARGS))
        self._proc = await asyncio.create_subprocess_exec(
            *self.DSD_ARGS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("DSD started (pid=%d)", self._proc.pid)

        # Wait briefly for DSD to create the WAV file, then open for reading
        loop = asyncio.get_running_loop()
        for _ in range(50):
            if os.path.exists(AUDIO_WAV):
                break
            await asyncio.sleep(0.1)

        if os.path.exists(AUDIO_WAV):
            self._audio_fh = open(AUDIO_WAV, "rb")
            logger.info("Audio WAV file open — decoded PCM will flow to STT")
        else:
            logger.warning("DSD did not create audio WAV file — STT disabled")
            self._audio_fh = None

        self._tasks = [
            asyncio.create_task(self._read_stdout(),    name="dsd-stdout"),
            asyncio.create_task(self._read_stderr(),    name="dsd-stderr"),
            asyncio.create_task(self._read_audio_wav(), name="dsd-audio"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        if self._audio_fh:
            try:
                self._audio_fh.close()
            except Exception:
                pass
            self._audio_fh = None

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
    # Audio input (FM PCM → DSD stdin)
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
    # Background tasks
    # ------------------------------------------------------------------

    async def _read_stdout(self) -> None:
        """Read DSD text metadata from stdout (pure text — no PCM mixed in)."""
        if self._proc is None or self._proc.stdout is None:
            return

        _dbg = open("/tmp/dsd_stdout.log", "w", buffering=1)
        _lines = 0
        try:
            while True:
                line_bytes = await self._proc.stdout.readline()
                if not line_bytes:
                    logger.info("DSD stdout closed")
                    break
                line = line_bytes.decode("ascii", errors="replace")
                _dbg.write(line)
                _lines += 1

                result = _parse_dmr_line(line)
                if result is None:
                    continue
                frame, lc = result
                if lc:
                    self._last_slot = _apply_lc(lc, self._slot_ctx, self._last_slot)
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
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in DSD stdout reader")
        finally:
            logger.info("DSD stdout reader done — lines=%d", _lines)
            _dbg.close()

    async def _read_stderr(self) -> None:
        """Read DSD stderr for LC header lines (CC/mfid) with src/dst IDs."""
        if self._proc is None or self._proc.stderr is None:
            return
        _err = open("/tmp/dsd_stderr.log", "w", buffering=1)
        try:
            while True:
                line_bytes = await self._proc.stderr.readline()
                if not line_bytes:
                    logger.info("DSD stderr closed")
                    break
                line = line_bytes.decode("ascii", errors="replace")
                _err.write(line)
                result = _parse_dmr_line(line)
                if result is None:
                    continue
                _, lc = result
                if lc:
                    if lc.get("src_id"):
                        slot = lc.get("timeslot", self._last_slot)
                        logger.info("LC from stderr TS%d src=%d dst=%d",
                                    slot, lc.get("src_id", 0), lc.get("dst_id", 0))
                    self._last_slot = _apply_lc(lc, self._slot_ctx, self._last_slot)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in DSD stderr reader")
        finally:
            _err.close()

    async def _read_audio_wav(self) -> None:
        """Read decoded PCM from DSD's WAV output file, polling for new data."""
        if self._audio_fh is None:
            return

        fh = self._audio_fh

        # Wait for and skip the 44-byte WAV header
        header = b""
        while len(header) < WAV_HDR_BYTES:
            chunk = fh.read(WAV_HDR_BYTES - len(header))
            if chunk:
                header += chunk
            else:
                await asyncio.sleep(AUDIO_POLL_S)

        sample_rate = int.from_bytes(header[24:28], "little")
        logger.info("Audio WAV ready — sample_rate=%d Hz, PCM flowing to STT", sample_rate)

        _audio_bytes = 0
        try:
            while True:
                chunk = fh.read(AUDIO_CHUNK)
                if chunk:
                    _audio_bytes += len(chunk)
                    try:
                        await self._audio_cb(chunk)
                    except Exception:
                        logger.exception("audio_callback raised an exception")
                else:
                    # No new data yet — yield to event loop and retry
                    await asyncio.sleep(AUDIO_POLL_S)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in audio WAV reader")
        finally:
            logger.info("Audio WAV reader done — total=%d bytes", _audio_bytes)
