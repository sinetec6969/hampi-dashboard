"""
sstv.py — SSTV image decoder for the HamPi dashboard.

Audio input: int16 PCM, 48 kHz mono, from SDREngine.fm_demodulate().
Supported modes: Scottie S1 (60), Scottie S2 (56), Martin M1 (44), Martin M2 (40), Robot 36 (8).
Saves completed images as PNG via Pillow; fires progressive line callbacks.
"""

import asyncio
import logging
import os
import time
from enum import Enum, auto
from typing import Callable, Awaitable, Optional

import numpy as np
from scipy.signal import hilbert

logger = logging.getLogger(__name__)

try:
    from PIL import Image as PILImage
    _PIL = True
except ImportError:
    _PIL = False
    logger.warning("Pillow not installed — SSTV images will not be saved (pip install Pillow)")

SAMPLE_RATE = 48_000

DECODE_STALL_S = 10.0   # no line progress for this long → abort the decode
MIN_SAVE_LINES = 16     # keep a partial image if at least this many lines landed

FREQ_SYNC   = 1200
FREQ_BLACK  = 1500
FREQ_WHITE  = 2300
FREQ_LEADER = 1900
FREQ_VIS_0  = 1100
FREQ_VIS_1  = 1300

# VIS code → mode parameters
# format "GBR" = Scottie (G then B then R per line)
# format "RGB" = Martin  (R then G then B per line)
# format "YC"  = Robot 36 (Y+chroma, alternating Cr/Cb)
SSTV_MODES: dict[int, dict] = {
    60: {"name": "Scottie S1", "lines": 240, "width": 320,
         "pixel_ms": 0.4321, "format": "GBR",
         "sync_ms": 9.0,   "porch_ms": 1.5,   "sep_ms": 1.5},
    56: {"name": "Scottie S2", "lines": 240, "width": 320,
         "pixel_ms": 0.2758, "format": "GBR",
         "sync_ms": 9.0,   "porch_ms": 1.5,   "sep_ms": 1.5},
    44: {"name": "Martin M1",  "lines": 256, "width": 320,
         "pixel_ms": 0.4576, "format": "RGB",
         "sync_ms": 4.862, "porch_ms": 0.572, "sep_ms": 0.572},
    40: {"name": "Martin M2",  "lines": 256, "width": 320,
         "pixel_ms": 0.2288, "format": "RGB",
         "sync_ms": 4.862, "porch_ms": 0.572, "sep_ms": 0.572},
     8: {"name": "Robot 36",   "lines": 240, "width": 320,
         "pixel_ms": 0.1400, "format": "YC",
         "sync_ms": 9.0,   "porch_ms": 3.0,   "sep_ms": 6.0},
}


class State(Enum):
    IDLE        = auto()
    VIS_DECODE  = auto()
    SYNC_HUNT   = auto()
    LINE_DECODE = auto()


def _ms(ms: float) -> int:
    return max(1, int(ms * SAMPLE_RATE / 1000 + 0.5))


def _freq_of(buf: np.ndarray, offset: int, n: int) -> float:
    """Dominant frequency in SSTV band [1050, 2450] Hz for buf[offset:offset+n]."""
    block = buf[offset : offset + n]
    if len(block) < 4:
        return float(FREQ_BLACK)
    sz  = max(len(block), 256)
    pad = np.zeros(sz, dtype=np.float32)
    pad[:len(block)] = block * np.hanning(len(block)).astype(np.float32)
    mag   = np.abs(np.fft.rfft(pad))
    freqs = np.fft.rfftfreq(sz, 1.0 / SAMPLE_RATE)
    mask  = (freqs >= 1050) & (freqs <= 2450)
    if not mask.any():
        return float(FREQ_BLACK)
    return float(freqs[mask][np.argmax(mag[mask])])


def _scan_channel(buf: np.ndarray, offset: int, n_pixels: int, pixel_samples: int) -> np.ndarray:
    """
    Decode one color channel scan line via Hilbert instantaneous frequency.
    Returns uint8 pixel values [0, 255].
    """
    n     = n_pixels * pixel_samples
    block = buf[offset : offset + n].astype(np.float64)
    if len(block) < n:
        block = np.pad(block, (0, n - len(block)))

    analytic  = hilbert(block)
    phase     = np.unwrap(np.angle(analytic))
    inst_freq = np.diff(phase) * SAMPLE_RATE / (2.0 * np.pi)   # length n-1

    n_full = (len(inst_freq) // pixel_samples) * pixel_samples
    grid   = inst_freq[:n_full].reshape(-1, pixel_samples)
    avg    = np.mean(grid, axis=1)[:n_pixels]

    vals = (avg - FREQ_BLACK) / (FREQ_WHITE - FREQ_BLACK) * 255.0
    return np.clip(vals, 0, 255).astype(np.uint8)


LineCb   = Callable[[int, list, list, list], Awaitable[None]]   # (y, r, g, b)
ImageCb  = Callable[[str, str], Awaitable[None]]                # (filename, mode_name)
StatusCb = Callable[[dict], Awaitable[None]]


class SSTVDecoder:
    def __init__(
        self,
        image_dir: str,
        line_callback:   Optional[LineCb]   = None,
        image_callback:  Optional[ImageCb]  = None,
        status_callback: Optional[StatusCb] = None,
    ):
        self.image_dir  = image_dir
        self._line_cb   = line_callback
        self._image_cb  = image_callback
        self._status_cb = status_callback

        self._queue:  asyncio.Queue[np.ndarray] = asyncio.Queue()
        self._task:   Optional[asyncio.Task]     = None
        self._active: bool                       = False

        self.state:       State          = State.IDLE
        self.mode:        Optional[dict] = None
        self.mode_name:   str            = ""
        self.line_num:    int            = 0
        self.total_lines: int            = 0
        self._signal_rms: float          = 0.0
        self._last_status_t: float       = 0.0
        self._last_progress_t: float     = 0.0

        self._r: Optional[np.ndarray] = None
        self._g: Optional[np.ndarray] = None
        self._b: Optional[np.ndarray] = None
        # Robot 36 intermediates
        self._y_plane: Optional[np.ndarray] = None
        self._cr_row:  Optional[np.ndarray] = None
        self._cb_row:  Optional[np.ndarray] = None

    async def start(self) -> None:
        os.makedirs(self.image_dir, exist_ok=True)
        self._active = True
        self._task   = asyncio.create_task(self._process_loop(), name="sstv-decode")
        logger.info("SSTVDecoder started — images → %s", self.image_dir)

    async def stop(self) -> None:
        self._active = False
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        logger.info("SSTVDecoder stopped")

    async def write_audio(self, pcm: bytes) -> None:
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32767.0
        await self._queue.put(samples)

    def status_dict(self) -> dict:
        m = self.mode
        return {
            "type":        "status",
            "state":       self.state.name.lower(),
            "mode":        self.mode_name,
            "line":        self.line_num,
            "total_lines": self.total_lines,
            "signal_rms":  round(self._signal_rms, 4),
            "width":       m["width"]  if m else 320,
            "height":      m["lines"]  if m else 240,
        }

    # ── Main processing loop ───────────────────────────────────────────

    async def _process_loop(self) -> None:
        buf: np.ndarray = np.array([], dtype=np.float32)
        MAX_BUF = SAMPLE_RATE * 30   # 30 s

        while self._active:
            try:
                chunk = await asyncio.wait_for(self._queue.get(), timeout=0.05)
                buf   = np.concatenate([buf, chunk])
                while not self._queue.empty():
                    buf = np.concatenate([buf, self._queue.get_nowait()])
            except asyncio.TimeoutError:
                pass

            if len(buf) == 0:
                continue

            tail = buf[-_ms(100):]
            self._signal_rms = float(np.sqrt(np.mean(tail ** 2)))

            prev_state = self.state

            if   self.state == State.IDLE:
                consumed = self._wait_leader(buf)
            elif self.state == State.VIS_DECODE:
                consumed = self._decode_vis(buf)
            elif self.state == State.SYNC_HUNT:
                consumed = self._hunt_sync(buf)
            elif self.state == State.LINE_DECODE:
                consumed = await self._decode_line(buf)
            else:
                consumed = len(buf)

            buf = buf[consumed:]
            if len(buf) > MAX_BUF:
                buf = buf[-MAX_BUF:]

            now = time.monotonic()

            # Signal lost mid-image: SYNC_HUNT would otherwise scan forever and
            # the partial image would be silently discarded.
            if (self.state in (State.SYNC_HUNT, State.LINE_DECODE)
                    and now - self._last_progress_t > DECODE_STALL_S):
                logger.warning("SSTV decode stalled at line %d/%d — aborting",
                               self.line_num, self.total_lines)
                if self.line_num >= MIN_SAVE_LINES:
                    await self._finish_image()
                self.state     = State.IDLE
                self.mode      = None
                self.mode_name = ""
            if self._status_cb and (self.state != prev_state or now - self._last_status_t > 0.5):
                self._last_status_t = now
                asyncio.create_task(self._status_cb(self.status_dict()))

    # ── IDLE: find 1900 Hz leader then 1200 Hz break ──────────────────

    def _wait_leader(self, buf: np.ndarray) -> int:
        win   = _ms(10)
        count = 0
        i     = 0
        while i + win <= len(buf):
            f = _freq_of(buf, i, win)
            if abs(f - FREQ_LEADER) < 150:
                count += 1
            elif abs(f - FREQ_SYNC) < 150 and count >= 15:
                logger.info("SSTV leader found (~%d ms); entering VIS decode", count * 10)
                self.state = State.VIS_DECODE
                return i   # hand break position to _decode_vis
            else:
                count = 0
            i += win
        return max(0, i - win)

    # ── VIS_DECODE ────────────────────────────────────────────────────

    def _decode_vis(self, buf: np.ndarray) -> int:
        # buf[0] = start of 10 ms break (1200 Hz)
        # sequence: break(10) + leader2(300) + start(10) + bits×8(30 each) + stop(10)
        needed = _ms(10 + 300 + 10 + 8 * 30 + 10)
        if len(buf) < needed:
            return 0

        pos  = _ms(10)    # skip break
        pos += _ms(300)   # skip second leader
        pos += _ms(10)    # skip start bit

        bits = []
        for _ in range(8):
            f = _freq_of(buf, pos, _ms(30))
            bits.append(0 if abs(f - FREQ_VIS_0) <= abs(f - FREQ_VIS_1) else 1)
            pos += _ms(30)
        pos += _ms(10)    # stop bit

        vis_code = sum(bits[i] << i for i in range(7))
        logger.info("VIS code=%d bits=%s", vis_code, bits[:7])

        if vis_code in SSTV_MODES:
            self.mode        = SSTV_MODES[vis_code]
            self.mode_name   = self.mode["name"]
            self.total_lines = self.mode["lines"]
            self.line_num    = 0
            h, w = self.mode["lines"], self.mode["width"]
            self._r = np.zeros((h, w), dtype=np.uint8)
            self._g = np.zeros((h, w), dtype=np.uint8)
            self._b = np.zeros((h, w), dtype=np.uint8)
            if self.mode["format"] == "YC":
                self._y_plane = np.zeros((h, w), dtype=np.float32)
                self._cr_row  = None
                self._cb_row  = None
            logger.info("SSTV mode: %s (%d × %d)", self.mode_name, w, h)
            self._last_progress_t = time.monotonic()
            self.state = State.SYNC_HUNT
        else:
            logger.warning("Unknown VIS code %d — returning to IDLE", vis_code)
            self.state = State.IDLE

        return pos

    # ── SYNC_HUNT ─────────────────────────────────────────────────────

    def _hunt_sync(self, buf: np.ndarray) -> int:
        probe = _ms(5)
        step  = max(1, probe // 2)
        i     = 0
        while i + probe <= len(buf):
            if abs(_freq_of(buf, i, probe) - FREQ_SYNC) < 150:
                self.state = State.LINE_DECODE
                return i
            i += step
        return max(0, i - probe)

    # ── LINE_DECODE ───────────────────────────────────────────────────

    async def _decode_line(self, buf: np.ndarray) -> int:
        if self.mode is None:
            self.state = State.IDLE
            return 0

        m       = self.mode
        fmt     = m["format"]
        width   = m["width"]
        pix_n   = _ms(m["pixel_ms"])
        sync_n  = _ms(m["sync_ms"])
        porch_n = _ms(m["porch_ms"])
        sep_n   = _ms(m["sep_ms"])
        chan_n  = pix_n * width

        if fmt in ("GBR", "RGB"):
            line_n = sync_n + porch_n + chan_n + sep_n + chan_n + sep_n + chan_n
        else:  # YC
            chr_pix_n = _ms(m["pixel_ms"] * 2)
            chr_n     = chr_pix_n * (width // 2)
            line_n    = sync_n + porch_n + chan_n + sep_n + chr_n

        if len(buf) < line_n:
            return 0

        loop = asyncio.get_running_loop()
        pos  = sync_n + porch_n   # skip sync + porch
        y    = self.line_num

        if fmt in ("GBR", "RGB"):
            ch1 = await loop.run_in_executor(None, _scan_channel, buf, pos, width, pix_n)
            pos += chan_n + sep_n
            ch2 = await loop.run_in_executor(None, _scan_channel, buf, pos, width, pix_n)
            pos += chan_n + sep_n
            ch3 = await loop.run_in_executor(None, _scan_channel, buf, pos, width, pix_n)

            if fmt == "GBR":                            # Scottie: G B R
                self._g[y], self._b[y], self._r[y] = ch1, ch2, ch3
            else:                                       # Martin:  R G B
                self._r[y], self._g[y], self._b[y] = ch1, ch2, ch3

        else:  # YC — Robot 36
            Y_ch = await loop.run_in_executor(None, _scan_channel, buf, pos, width, pix_n)
            pos += chan_n + sep_n
            C_ch = await loop.run_in_executor(None, _scan_channel, buf, pos, width // 2, chr_pix_n)

            Y_f = Y_ch.astype(np.float32)
            C_f = np.repeat(C_ch.astype(np.float32), 2)[:width] - 128.0

            self._y_plane[y] = Y_f

            if y % 2 == 0:
                self._cr_row = C_f
                # Emit grey placeholder until Cb arrives on the next line
                grey = np.clip(Y_f, 0, 255).astype(np.uint8)
                self._r[y] = self._g[y] = self._b[y] = grey
            else:
                self._cb_row = C_f
                Cr = self._cr_row if self._cr_row is not None else np.zeros(width, dtype=np.float32)
                Cb = self._cb_row
                for row in (y - 1, y):
                    if row < 0:
                        continue
                    Yv  = self._y_plane[row]
                    r_f = Yv + 1.402 * Cr
                    g_f = Yv - 0.344136 * Cb - 0.714136 * Cr
                    b_f = Yv + 1.772 * Cb
                    self._r[row] = np.clip(r_f, 0, 255).astype(np.uint8)
                    self._g[row] = np.clip(g_f, 0, 255).astype(np.uint8)
                    self._b[row] = np.clip(b_f, 0, 255).astype(np.uint8)
                    if row == y - 1 and self._line_cb:
                        asyncio.create_task(self._line_cb(
                            row,
                            self._r[row].tolist(),
                            self._g[row].tolist(),
                            self._b[row].tolist(),
                        ))

        if self._line_cb:
            asyncio.create_task(self._line_cb(
                y,
                self._r[y].tolist(),
                self._g[y].tolist(),
                self._b[y].tolist(),
            ))

        self.line_num += 1
        self._last_progress_t = time.monotonic()
        if self.line_num >= self.total_lines:
            await self._finish_image()
            self.state     = State.IDLE
            self.mode      = None
            self.mode_name = ""
        else:
            self.state = State.SYNC_HUNT

        return line_n

    # ── Save image ────────────────────────────────────────────────────

    async def _finish_image(self) -> None:
        ts    = time.strftime("%Y%m%d_%H%M%S")
        fname = f"sstv_{ts}.png"
        path  = os.path.join(self.image_dir, fname)

        if _PIL and self._r is not None:
            rgb = np.stack([self._r, self._g, self._b], axis=2)
            loop = asyncio.get_running_loop()
            def _save():
                PILImage.fromarray(rgb, mode="RGB").save(path)
            await loop.run_in_executor(None, _save)
            logger.info("SSTV image saved: %s", path)
        else:
            logger.info("SSTV decode complete (Pillow unavailable): %s", fname)

        if self._image_cb:
            await self._image_cb(fname, self.mode_name)
