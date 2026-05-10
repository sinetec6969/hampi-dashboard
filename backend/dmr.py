"""
dmr.py - Async DMR decoder wrapping dsd-fme.

dsd-fme command:
    dsd-fme -i - -fs -w /tmp/dsd_audio.wav

  -i -   read raw 48kHz int16 PCM from stdin (same as old dsd)
  -fs    force DMR BS/MS Simplex (Tier II repeater)
  -w     write decoded AMBE audio to WAV file (bypasses portaudio)

dsd-fme outputs ALL metadata to stderr (not stdout).
stdout is ignored.  stderr contains lines like:

  14:43:58 Sync: +DMR   slot1  [slot2] | Color Code=01 | IDLE
  14:43:58 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC
   SLOT 1 TGT=91 SRC=3168750 Group Call
  14:43:59 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC*
   Slot 0 - Talker Alias Block Num: 1; Valid Block; Talker Alias: KF5DIB

Timeslots: dsd-fme uses 1-indexed slot numbers (slot1=TS1, slot2=TS2).
We store 0-indexed internally (subtract 1) to match frontend timeslot+1 display.
"""

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, asdict
from typing import Callable, Awaitable, Optional

import numpy as np

logger = logging.getLogger(__name__)

AUDIO_WAV     = "/tmp/dsd_audio.wav"
WAV_HDR_BYTES = 44
AUDIO_CHUNK   = 3200   # 200 ms at 8000 Hz 16-bit
AUDIO_POLL_S  = 0.02

# --- Regex patterns for dsd-fme stderr output ----------------------------

# Sync line with bracket slot:  "HH:MM:SS Sync: +DMR  slot1  [slot2] | CC=N | FTYPE"
_RE_SYNC_BS   = re.compile(
    r'\d+:\d+:\d+\s+Sync:.*?\[slot(\d+)\].*?\|\s*Color Code=(\d+)\s*\|\s*(\S+)',
    re.IGNORECASE,
)
# Sync line without bracket slot (MS/DM simplex mode):
# "HH:MM:SS Sync: +DMR MS/DM ... | Color Code=N | FTYPE"
_RE_SYNC_DM   = re.compile(
    r'\d+:\d+:\d+\s+Sync:.*?\|\s*Color Code=(\d+)\s*\|\s*(\S+)',
    re.IGNORECASE,
)
# LC data line:  " SLOT N TGT=X SRC=Y Group/Private Call"
_RE_LC        = re.compile(
    r'\bSLOT\s+(\d+)\s+TGT=(\d+)\s+SRC=(\d+)\s+(Group|Private)\s+Call',
    re.IGNORECASE,
)
# Talker alias:  " Slot N - Talker Alias Block Num: N; Valid Block; Talker Alias: KF5DIB"
_RE_ALIAS     = re.compile(r'Talker Alias:\s*(.+)', re.IGNORECASE)
# Strip ANSI escape codes
_RE_ANSI      = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')

_FTYPE_MAP = {
    'VLC':  'VOICE',   # Voice LC header
    'VC':   'VOICE',   # Voice continuation (dsd-fme outputs VC*; rstrip removes the *)
    'VCALL':'VOICE',
    'IDLE': 'IDLE',
    'PI':   'DATA',
    'CACH': 'DATA',
    'DATA': 'DATA',
    'TLC':  'TLC',
    'MBC':  'MBC',
}

def _map_ftype(raw: str) -> str:
    raw = raw.upper().rstrip('*').strip()
    for key, val in _FTYPE_MAP.items():
        if raw.startswith(key):
            return val
    return 'UNKNOWN'

# -------------------------------------------------------------------------

AudioCallback = Callable[[bytes], Awaitable[None]]
MetaCallback  = Callable[[dict], Awaitable[None]]


@dataclass
class DMRFrame:
    sync:        bool = False
    timeslot:    int  = 0        # 0-indexed (0=TS1, 1=TS2); display as timeslot+1
    frame_type:  str  = "UNKNOWN"
    errors:      int  = 0
    src_id:      int  = 0
    dst_id:      int  = 0
    group:       bool = True
    alias:       str  = ""       # talker alias / callsign from LRRP
    color_code:  int  = 0
    raw_line:    str  = ""

    def to_dict(self) -> dict:
        return asdict(self)


class DMRDecoder:
    """Async wrapper around dsd-fme."""

    DSD_ARGS = ["dsd-fme", "-i", "-", "-fs", "-w", AUDIO_WAV]

    def __init__(self, audio_callback: AudioCallback, meta_callback: MetaCallback):
        self._audio_cb = audio_callback
        self._meta_cb  = meta_callback
        self._proc:     Optional[asyncio.subprocess.Process] = None
        self._tasks:    list[asyncio.Task] = []
        self._audio_fh: Optional[object]  = None

        # Per-slot persistent call context (1-indexed: slot 1 and 2)
        self._slot_ctx: dict[int, dict] = {
            1: {"src_id": 0, "dst_id": 0, "group": True, "alias": ""},
            2: {"src_id": 0, "dst_id": 0, "group": True, "alias": ""},
        }
        # dsd-fme stderr parser state
        self._active_slot  = 1   # 1-indexed
        self._active_cc    = 0
        self._pending_ftype = "UNKNOWN"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        try:
            os.unlink(AUDIO_WAV)
        except FileNotFoundError:
            pass

        logger.info("Starting dsd-fme: %s", " ".join(self.DSD_ARGS))
        self._proc = await asyncio.create_subprocess_exec(
            *self.DSD_ARGS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("dsd-fme started (pid=%d)", self._proc.pid)

        for _ in range(50):
            if os.path.exists(AUDIO_WAV):
                break
            await asyncio.sleep(0.1)

        if os.path.exists(AUDIO_WAV):
            self._audio_fh = open(AUDIO_WAV, "rb")
            logger.info("Audio WAV file open")
        else:
            logger.warning("dsd-fme did not create audio WAV — STT disabled")
            self._audio_fh = None

        self._tasks = [
            asyncio.create_task(self._read_stderr(),    name="dfme-stderr"),
            asyncio.create_task(self._read_audio_wav(), name="dfme-audio"),
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
            logger.warning("dsd-fme stdin pipe broken")

    # ------------------------------------------------------------------
    # Background tasks
    # ------------------------------------------------------------------

    async def _read_stderr(self) -> None:
        """Parse dsd-fme stderr for DMR call metadata."""
        if self._proc is None or self._proc.stderr is None:
            return

        _dbg = open("/tmp/dsd_stderr.log", "w", buffering=1)
        _lines = 0
        try:
            while True:
                line_bytes = await self._proc.stderr.readline()
                if not line_bytes:
                    logger.info("dsd-fme stderr closed")
                    break
                line = line_bytes.decode("ascii", errors="replace")
                _dbg.write(line)
                _lines += 1

                frame = self._parse_line(line)
                if frame is not None:
                    try:
                        await self._meta_cb(frame.to_dict())
                    except Exception:
                        logger.exception("meta_callback raised an exception")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in dsd-fme stderr reader")
        finally:
            logger.info("dsd-fme stderr reader done — lines=%d", _lines)
            _dbg.close()

    def _parse_line(self, raw: str) -> Optional[DMRFrame]:
        """
        Parse one line of dsd-fme stderr output.

        Returns a DMRFrame when a Sync line is processed (the frame carries
        whatever call state is current).  Returns None for LC/alias update
        lines, which update internal state for the next frame.
        """
        line = _RE_ANSI.sub("", raw).strip()
        if not line:
            return None

        # --- Sync line (BS mode): has [slotN] bracket notation ---
        m = _RE_SYNC_BS.search(line)
        if m:
            self._active_slot   = int(m.group(1))   # 1-indexed
            self._active_cc     = int(m.group(2))
            raw_ftype           = m.group(3).upper()
            self._pending_ftype = _map_ftype(raw_ftype)
            if raw_ftype.startswith("VLC"):
                self._clear_call(self._active_slot)
            return self._make_frame(line)

        # --- Sync line (MS/DM mode): no slot bracket, check it's a Sync line ---
        if "Sync:" in line:
            m = _RE_SYNC_DM.search(line)
            if m:
                self._active_cc     = int(m.group(1))
                raw_ftype           = m.group(2).upper()
                self._pending_ftype = _map_ftype(raw_ftype)
                if raw_ftype.startswith("VLC"):
                    self._clear_call(self._active_slot)
                return self._make_frame(line)

        # --- LC data line: update slot context ---
        # Do NOT update _active_slot here — dsd-fme reports "SLOT 1" in
        # MS/DM MONO mode regardless of the actual timeslot, which would
        # override the correct slot detected from BS-mode [slotN] brackets.
        m = _RE_LC.search(line)
        if m:
            tgt   = int(m.group(2))
            src   = int(m.group(3))
            group = m.group(4).lower() == "group"
            slot  = self._active_slot   # trust the last Sync-line slot
            ctx   = self._slot_ctx.get(slot, self._slot_ctx[1])
            if tgt:
                ctx["dst_id"] = tgt
            if src:
                ctx["src_id"] = src
            ctx["group"] = group
            if src:
                logger.info("LC TS%d src=%d tg=%d", slot, src, tgt)
            return None

        # --- Talker alias line ---
        m = _RE_ALIAS.search(line)
        if m:
            alias = m.group(1).strip()
            # Some radios append " DMR ID" or a bare DMR ID number after the
            # callsign (e.g. "KF5DIB DMR ID" or "KF5DIB 3168750").
            # Strip those so the alias is a clean callsign usable in URLs.
            alias = re.sub(r'\s+DMR\s*ID\b.*', '', alias, flags=re.IGNORECASE).strip()
            alias = re.sub(r'\s+\d{6,}.*', '', alias).strip()
            if alias and len(alias) > 1:
                slot = self._active_slot
                if slot in self._slot_ctx:
                    current = self._slot_ctx[slot].get("alias", "")
                    # Only update if this block is longer — alias is assembled
                    # incrementally across blocks; never overwrite a longer value.
                    if len(alias) >= len(current):
                        self._slot_ctx[slot]["alias"] = alias
                        logger.info("Alias TS%d: %s", slot, alias)
            return None

        return None

    def _clear_call(self, slot: int) -> None:
        """Reset per-call fields when a new Voice LC Header is detected."""
        if slot in self._slot_ctx:
            ctx = self._slot_ctx[slot]
            ctx["src_id"] = 0
            ctx["dst_id"] = 0
            ctx["alias"]  = ""

    def _make_frame(self, raw_line: str) -> DMRFrame:
        """Build a DMRFrame from current parser state."""
        slot = self._active_slot
        ctx  = self._slot_ctx.get(slot, {"src_id": 0, "dst_id": 0, "group": True, "alias": ""})
        return DMRFrame(
            sync        = True,
            timeslot    = slot - 1,   # convert to 0-indexed for frontend timeslot+1
            frame_type  = self._pending_ftype,
            errors      = 0,
            src_id      = ctx["src_id"],
            dst_id      = ctx["dst_id"],
            group       = ctx["group"],
            alias       = ctx.get("alias", ""),
            color_code  = self._active_cc,
            raw_line    = raw_line.strip(),
        )

    async def _read_audio_wav(self) -> None:
        """Stream decoded PCM from dsd-fme's WAV output file."""
        if self._audio_fh is None:
            return

        fh = self._audio_fh

        header = b""
        while len(header) < WAV_HDR_BYTES:
            chunk = fh.read(WAV_HDR_BYTES - len(header))
            if chunk:
                header += chunk
            else:
                await asyncio.sleep(AUDIO_POLL_S)

        channels = int.from_bytes(header[22:24], "little")
        sr       = int.from_bytes(header[24:28], "little")
        bits     = int.from_bytes(header[34:36], "little")
        logger.info("Audio WAV ready — sample_rate=%d Hz, channels=%d, bits=%d", sr, channels, bits)

        # Pacing state: track audio-time sent vs wall-clock so we never burst
        # more than PACE_AHEAD seconds of audio to the browser at once.
        # Reset on every gap (empty read) so long silences don't corrupt the ref.
        PACE_AHEAD = 0.10   # target: stay at most 100 ms ahead of real-time
        _pace_t0:    float = 0.0
        _pace_bytes: int   = 0
        mono_rate = sr * 2  # bytes per second of mono int16 at sample rate sr

        _total = 0
        try:
            while True:
                chunk = fh.read(AUDIO_CHUNK)
                if not chunk:
                    # Gap — reset pacing so next burst starts with a clean reference
                    _pace_t0    = 0.0
                    _pace_bytes = 0
                    await asyncio.sleep(AUDIO_POLL_S)
                    continue

                # dsd-fme outputs stereo: TS1 on left, TS2 on right.
                # Mix down to mono so playback and STT see the correct sample rate.
                if channels == 2 and bits == 16:
                    stereo = np.frombuffer(chunk, dtype=np.int16).reshape(-1, 2)
                    mixed  = stereo.astype(np.int32).sum(axis=1) // 2
                    chunk  = mixed.astype(np.int16).tobytes()

                # Pace delivery: if we're ahead of wall-clock by more than PACE_AHEAD,
                # sleep until we're back within a 20 ms margin.
                if _pace_t0 == 0.0:
                    _pace_t0 = time.monotonic()
                _pace_bytes += len(chunk)
                audio_s = _pace_bytes / mono_rate
                wall_s  = time.monotonic() - _pace_t0
                ahead_s = audio_s - wall_s
                if ahead_s > PACE_AHEAD:
                    await asyncio.sleep(ahead_s - 0.02)

                _total += len(chunk)
                try:
                    await self._audio_cb(chunk)
                except Exception:
                    logger.exception("audio_callback raised an exception")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Unexpected error in audio WAV reader")
        finally:
            logger.info("Audio WAV reader done — total=%d bytes", _total)
