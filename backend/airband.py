"""
airband.py - AM airband scanner backed by an independent rtl_tcp instance.

Scanner behaviour:
  - Cycles through a channel list at dwell_ms intervals.
  - When audio_rms > squelch the channel is held; scanning resumes
    HANG_S seconds after the signal drops below the threshold.
  - One chunk after retuning is discarded to let the SDR settle.
  - PCM (int16, mono, 48 kHz) is sent to the audio_callback only
    while squelch is open (gated audio — no noise between transmissions).
"""

import asyncio
import logging
from typing import Callable, Awaitable, Optional

from sdr import SDREngine

logger = logging.getLogger(__name__)

HANG_S  = 1.0    # seconds to hold after signal drops below squelch
CHUNK   = 131_072  # IQ samples per read (~54 ms at 2.4 MHz)

DEFAULT_CHANNELS = [
    {"freq": 121_500_000, "label": "Guard"},
    {"freq": 123_450_000, "label": "CTAF"},
    {"freq": 126_200_000, "label": "Center"},
    {"freq": 132_850_000, "label": "Departure"},
]

AudioCb  = Callable[[bytes], Awaitable[None]]
StatusCb = Callable[[dict], Awaitable[None]]


class AirbandScanner:
    """
    AM airband scanner backed by its own rtl_tcp/SDREngine instance.
    Designed to run alongside the DMR stack on a second SDR dongle.
    """

    def __init__(
        self,
        channels: list[dict] = DEFAULT_CHANNELS,
        squelch: float = 0.01,
        dwell_ms: int = 2000,
        gain: float = 40.0,
        sample_rate: int = 2_400_000,
        rtl_device: int | str = 1,
        rtl_port: int = 1235,
        audio_callback: Optional[AudioCb] = None,
        status_callback: Optional[StatusCb] = None,
    ):
        self.channels   = list(channels)
        self.squelch    = squelch
        self.dwell_ms   = dwell_ms
        self.scanner_on = True

        self._audio_cb  = audio_callback
        self._status_cb = status_callback
        self._active    = False
        self._task: Optional[asyncio.Task] = None

        self._active_idx   = 0
        self._squelch_open = False

        first_freq = self.channels[0]["freq"] if self.channels else 121_500_000
        self._sdr = SDREngine(
            freq=first_freq,
            sample_rate=sample_rate,
            gain=gain,
            rtl_tcp_host="127.0.0.1",
            rtl_tcp_port=rtl_port,
            device_index=rtl_device,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def active_idx(self) -> int:
        return self._active_idx

    @property
    def squelch_open(self) -> bool:
        return self._squelch_open

    def set_squelch(self, level: float) -> None:
        self.squelch = max(0.0, level)

    def set_scanner(self, enabled: bool) -> None:
        self.scanner_on = enabled

    def set_channels(self, channels: list[dict]) -> None:
        self.channels = list(channels)
        self._active_idx = 0

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sdr.start)
        self._active = True
        self._task   = asyncio.create_task(self._scan_loop(), name="airband-scan")
        logger.info("AirbandScanner started — device=%s port=%d",
                    self._sdr.device_index, self._sdr.port)

    async def stop(self) -> None:
        self._active = False
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        self._sdr.stop()
        logger.info("AirbandScanner stopped")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _tune_to(self, idx: int) -> None:
        self._active_idx = idx % len(self.channels)
        freq = self.channels[self._active_idx]["freq"]
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sdr.set_freq, freq)
        self._squelch_open = False
        await self._emit_status()
        logger.debug("Airband tuned to ch %d: %s (%d Hz)",
                     self._active_idx, self.channels[self._active_idx]["label"], freq)

    async def _emit_status(self) -> None:
        if not self._status_cb or not self.channels:
            return
        try:
            await self._status_cb({
                "type":         "status",
                "active_idx":   self._active_idx,
                "channel":      self.channels[self._active_idx],
                "squelch_open": self._squelch_open,
                "scanner_on":   self.scanner_on,
                "squelch":      self.squelch,
                "dwell_ms":     self.dwell_ms,
            })
        except Exception:
            logger.exception("airband status_callback raised")

    # ------------------------------------------------------------------
    # Scan loop
    # ------------------------------------------------------------------

    async def _scan_loop(self) -> None:
        loop = asyncio.get_running_loop()
        hold_until  = loop.time()
        skip_chunks = 0

        if self.channels:
            await self._tune_to(0)
            hold_until  = loop.time() + self.dwell_ms / 1000.0
            skip_chunks = 2  # discard first two chunks after initial tune

        while self._active:
            try:
                iq = await loop.run_in_executor(None, self._sdr.read_iq, CHUNK)

                if skip_chunks > 0:
                    skip_chunks -= 1
                    continue

                if not self.channels:
                    await asyncio.sleep(0.1)
                    continue

                freq = self.channels[self._active_idx]["freq"]
                pcm, audio_rms = await loop.run_in_executor(
                    None, self._sdr.am_demodulate, iq, freq
                )

                now          = loop.time()
                was_open     = self._squelch_open
                squelch_open = audio_rms > self.squelch
                self._squelch_open = squelch_open

                if squelch_open:
                    hold_until = now + HANG_S
                    if self._audio_cb:
                        await self._audio_cb(pcm)
                elif was_open and not squelch_open:
                    # Squelch just closed — emit status update
                    await self._emit_status()

                if squelch_open != was_open:
                    await self._emit_status()

                # Advance scanner when dwell expires and scanner is on
                if (self.scanner_on
                        and len(self.channels) > 1
                        and now >= hold_until):
                    next_idx   = (self._active_idx + 1) % len(self.channels)
                    await self._tune_to(next_idx)
                    hold_until  = loop.time() + self.dwell_ms / 1000.0
                    skip_chunks = 1

                await asyncio.sleep(0)

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Airband scan loop error — retrying in 2 s")
                await asyncio.sleep(2)
