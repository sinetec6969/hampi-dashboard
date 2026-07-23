"""
dmr.py - Async DMR decoder wrapping dsd-fme.

dsd-fme command:
    dsd-fme -i - -fs -o null

  -i -    read raw 48kHz int16 PCM from stdin
  -fs     force DMR BS/MS Simplex (Tier II repeater)
  -o null discard decoded audio (audio output removed)

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
import re
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

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

MetaCallback     = Callable[[dict], Awaitable[None]]
CallEndCallback  = Callable[[dict], Awaitable[None]]
AudioCallback    = Callable[[bytes], Awaitable[None]]

AUDIO_UDP_PORT = 23456


class _AudioProtocol(asyncio.DatagramProtocol):
    """Receives dsd-fme UDP blaster PCM; queues it for ordered delivery."""

    def __init__(self, queue: asyncio.Queue, stats: dict):
        self._queue  = queue
        self._stats  = stats
        self._last_t = 0.0

    def datagram_received(self, data: bytes, addr) -> None:
        # TEMP instrumentation (Part 1A diagnosis) — remove after audio fix
        now = time.monotonic()
        if self._last_t and now - self._last_t < 0.5:
            self._stats["gaps"].append(now - self._last_t)
        self._last_t = now
        self._stats["sizes"].append(len(data))
        try:
            self._queue.put_nowait(data)
        except asyncio.QueueFull:
            self._stats["drops"] += 1


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

    DSD_ARGS = ["dsd-fme", "-i", "-", "-fs", "-o", f"udp:127.0.0.1:{AUDIO_UDP_PORT}"]

    def __init__(self, meta_callback: MetaCallback,
                 call_end_callback: Optional[CallEndCallback] = None,
                 audio_callback: Optional[AudioCallback] = None):
        self._meta_cb     = meta_callback
        self._call_end_cb = call_end_callback
        self._audio_cb    = audio_callback
        self._proc:       Optional[asyncio.subprocess.Process] = None
        self._tasks:      list[asyncio.Task] = []
        self._udp_transport = None
        self._audio_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._audio_stats: dict = {"gaps": [], "sizes": [], "drops": 0}

        # Per-slot persistent call context (1-indexed: slot 1 and 2)
        self._slot_ctx: dict[int, dict] = {
            1: {"src_id": 0, "dst_id": 0, "group": True, "alias": ""},
            2: {"src_id": 0, "dst_id": 0, "group": True, "alias": ""},
        }
        # dsd-fme stderr parser state
        self._active_slot   = 1   # 1-indexed
        self._active_cc     = 0
        self._pending_ftype = "UNKNOWN"

        # Call tracking state (for history log) — per-slot: TS1 and TS2 calls
        # interleave on a BS-mode repeater and must not clobber each other
        self._recording:     dict[int, bool]           = {1: False, 2: False}
        self._active_call:   dict[int, Optional[dict]] = {1: None, 2: None}
        self._last_voice_ts: dict[int, float]          = {1: 0.0, 2: 0.0}
        # Appended by _clear_call (sync); drained by _read_stderr (async)
        self._pending_finalize: list[dict] = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._audio_cb and self._udp_transport is None:
            loop = asyncio.get_running_loop()
            self._udp_transport, _ = await loop.create_datagram_endpoint(
                lambda: _AudioProtocol(self._audio_queue, self._audio_stats),
                local_addr=("127.0.0.1", AUDIO_UDP_PORT),
            )
            logger.info("DMR audio UDP listener on 127.0.0.1:%d", AUDIO_UDP_PORT)

        logger.info("Starting dsd-fme: %s", " ".join(self.DSD_ARGS))
        self._proc = await asyncio.create_subprocess_exec(
            *self.DSD_ARGS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("dsd-fme started (pid=%d)", self._proc.pid)

        self._tasks = [
            asyncio.create_task(self._read_stderr(), name="dfme-stderr"),
        ]
        if self._audio_cb:
            self._tasks.append(
                asyncio.create_task(self._drain_audio(), name="dfme-audio"))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        if self._udp_transport is not None:
            self._udp_transport.close()
            self._udp_transport = None

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
            # TEMP instrumentation (Part 1A): tee discriminator PCM for offline
            # dsd-fme flag experiments; capped at 60 MB (~10 min)
            if not hasattr(self, "_tee"):
                self._tee = open("/tmp/dmr_input.pcm", "wb")
                self._tee_n = 0
            if self._tee and self._tee_n < 60_000_000:
                self._tee.write(pcm_bytes)
                self._tee_n += len(pcm_bytes)
            # TEMP instrumentation (Part 1A): input rate — expect 96000 B/s (48k s16)
            self._in_bytes = getattr(self, "_in_bytes", 0) + len(pcm_bytes)
            now = time.monotonic()
            t0 = getattr(self, "_in_t0", 0.0)
            if now - t0 >= 10:
                if t0:
                    logger.info("DMR input: %d B/s to dsd-fme stdin",
                                int(self._in_bytes / (now - t0)))
                self._in_bytes, self._in_t0 = 0, now
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.warning("dsd-fme stdin pipe broken")

    # ------------------------------------------------------------------
    # Background tasks
    # ------------------------------------------------------------------

    async def _drain_audio(self) -> None:
        """Relay dsd-fme UDP blaster PCM to the audio callback, in order."""
        rate_bytes = 0
        rate_t0    = time.monotonic()
        try:
            while True:
                data = await self._audio_queue.get()
                rate_bytes += len(data)
                now = time.monotonic()
                if now - rate_t0 >= 10:
                    # TEMP instrumentation (Part 1A diagnosis)
                    st = self._audio_stats
                    gaps, sizes = sorted(st["gaps"]), st["sizes"]
                    if gaps:
                        p = lambda q: gaps[min(len(gaps) - 1, int(q * len(gaps)))]
                        logger.info(
                            "DMR audio: %d B/s | %d dgrams sz min/med/max=%d/%d/%d | "
                            "gap ms p50/p90/p99/max=%.1f/%.1f/%.1f/%.1f | qdrops=%d",
                            int(rate_bytes / (now - rate_t0)), len(sizes),
                            min(sizes), sorted(sizes)[len(sizes)//2], max(sizes),
                            p(.5)*1e3, p(.9)*1e3, p(.99)*1e3, gaps[-1]*1e3,
                            st["drops"])
                    else:
                        logger.info("DMR audio: %d B/s from dsd-fme UDP",
                                    int(rate_bytes / (now - rate_t0)))
                    st["gaps"], st["sizes"], st["drops"] = [], [], 0
                    rate_bytes, rate_t0 = 0, now
                try:
                    await self._audio_cb(data)
                except Exception:
                    logger.exception("audio_callback raised an exception")
        except asyncio.CancelledError:
            pass

    async def _read_stderr(self) -> None:
        """Parse dsd-fme stderr for DMR call metadata."""
        if self._proc is None or self._proc.stderr is None:
            return

        # TEMP instrumentation (Part 1A): raw stderr tee for MBE-error analysis
        raw_log = open("/tmp/dsdfme_stderr.log", "ab", buffering=0)
        try:
            while True:
                line_bytes = await self._proc.stderr.readline()
                if not line_bytes:
                    logger.info("dsd-fme stderr closed")
                    break
                raw_log.write(line_bytes)
                line = line_bytes.decode("ascii", errors="replace")

                frame = self._parse_line(line)
                while self._pending_finalize:
                    await self._do_finalize(self._pending_finalize.pop(0))
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
            logger.info("dsd-fme stderr reader done")

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
            if raw_ftype.startswith(("VLC", "TLC")):
                self._clear_call(self._active_slot)
            frame = self._make_frame(line)
            self._maybe_start_recording(frame)
            return frame

        # --- Sync line (MS/DM mode): no slot bracket, check it's a Sync line ---
        if "Sync:" in line:
            m = _RE_SYNC_DM.search(line)
            if m:
                self._active_cc     = int(m.group(1))
                raw_ftype           = m.group(2).upper()
                self._pending_ftype = _map_ftype(raw_ftype)
                if raw_ftype.startswith(("VLC", "TLC")):
                    self._clear_call(self._active_slot)
                frame = self._make_frame(line)
                self._maybe_start_recording(frame)
                return frame

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
                        call = self._active_call.get(slot)
                        if call and len(alias) >= len(call.get("alias", "")):
                            call["alias"] = alias
            return None

        return None

    def _clear_call(self, slot: int) -> None:
        """Reset per-call fields on VLC (new call) or TLC (call terminator)."""
        if self._recording.get(slot) and self._active_call.get(slot):
            call = self._active_call[slot]
            call["end_time"] = self._last_voice_ts.get(slot) or time.time()
            self._pending_finalize.append(dict(call))
        self._recording[slot]   = False
        self._active_call[slot] = None
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

    def _maybe_start_recording(self, frame: "DMRFrame") -> None:
        if frame.frame_type != "VOICE" or frame.src_id == 0:
            return
        slot = self._active_slot
        self._last_voice_ts[slot] = time.time()
        if not self._recording.get(slot):
            self._recording[slot] = True
            self._active_call[slot] = {
                "src_id":     frame.src_id,
                "dst_id":     frame.dst_id,
                "group":      frame.group,
                "alias":      frame.alias,
                "slot":       slot,
                "start_time": time.time(),
            }

    async def _do_finalize(self, call_info: dict) -> None:
        if not self._call_end_cb:
            return
        end_time   = call_info.get("end_time") or time.time()
        start_time = call_info.get("start_time", end_time)
        src_id     = call_info.get("src_id", 0)
        record = {
            "id":         f"{datetime.fromtimestamp(start_time).strftime('%Y%m%d_%H%M%S')}_{src_id}",
            "started_at": datetime.fromtimestamp(start_time).isoformat(),
            "ended_at":   datetime.fromtimestamp(end_time).isoformat(),
            "duration_s": max(0.0, round(end_time - start_time, 1)),
            "src_id":     src_id,
            "dst_id":     call_info.get("dst_id", 0),
            "group":      call_info.get("group", True),
            "alias":      call_info.get("alias", ""),
        }
        try:
            await self._call_end_cb(record)
        except Exception:
            logger.exception("call_end_callback raised an exception")

