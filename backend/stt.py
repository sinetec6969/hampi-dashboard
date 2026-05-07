"""
stt.py - Speech-to-text via faster-whisper.

Uses two independent voice-activity triggers:
  1. DMR VOICE frame metadata — precise, but depends on DSD parsing being correct.
  2. Audio energy (RMS) — always works regardless of metadata; catches the case
     where DSD stderr format doesn't match our parser.

Audio is always buffered in a rolling window so we never miss leading audio
due to the race between DSD stdout and stderr asyncio tasks.
"""

import asyncio
import logging
import os
import time
from typing import Callable, Awaitable, Optional

import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

TranscriptCallback = Callable[[dict], Awaitable[None]]

DSD_SAMPLE_RATE = int(os.getenv("SDR_DSD_RATE", "8000"))
WHISPER_RATE    = 16_000

VOICE_TIMEOUT_S   = 1.2    # seconds of silence/low-energy before flushing
MIN_DURATION_S    = 0.5    # ignore bursts shorter than this
MAX_BUFFER_S      = 30     # rolling window cap
PRE_ROLL_S        = 0.4    # audio kept before voice-start

# Energy VAD thresholds (int16 RMS scale, 0–32768)
# DSD decoded AMBE vocoder output is low-energy; 300/100 works better than 600/200.
ENERGY_START  = int(os.getenv("STT_ENERGY_START",  "300"))   # RMS to begin a burst
ENERGY_HOLD   = int(os.getenv("STT_ENERGY_HOLD",   "100"))   # RMS to keep a burst going

_PRE_ROLL_BYTES = int(PRE_ROLL_S    * DSD_SAMPLE_RATE * 2)
_MAX_BYTES      = int(MAX_BUFFER_S  * DSD_SAMPLE_RATE * 2)
_MIN_BYTES      = int(MIN_DURATION_S * DSD_SAMPLE_RATE * 2)


class STTDecoder:
    def __init__(
        self,
        transcript_callback: TranscriptCallback,
        model_size: str = "tiny",
        language: str = "en",
    ):
        self._cb         = transcript_callback
        self._model_size = model_size
        self._language   = language

        self._model: Optional[WhisperModel] = None
        self._loop:  Optional[asyncio.AbstractEventLoop] = None

        self._pcm_buffer: bytearray = bytearray()

        self._voice_active  = False
        self._last_voice_ts = 0.0
        self._timeslot      = 0
        self._src_id        = 0
        self._audio_chunks  = 0
        self._max_rms       = 0.0

        self._watchdog_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        logger.info("Loading Whisper '%s' model…", self._model_size)
        self._model = await self._loop.run_in_executor(None, self._load_model)
        logger.info(
            "Whisper model ready (DSD rate=%d Hz, energy_start=%d, energy_hold=%d)",
            DSD_SAMPLE_RATE, ENERGY_START, ENERGY_HOLD,
        )
        self._watchdog_task = asyncio.create_task(
            self._watchdog(), name="stt-watchdog"
        )

    def _load_model(self) -> WhisperModel:
        return WhisperModel(self._model_size, device="cpu", compute_type="int8", local_files_only=True)

    async def stop(self) -> None:
        if self._watchdog_task:
            self._watchdog_task.cancel()
            await asyncio.gather(self._watchdog_task, return_exceptions=True)
        logger.info("STTDecoder stopped")

    # ------------------------------------------------------------------
    # Feed interfaces
    # ------------------------------------------------------------------

    def feed_audio(self, pcm_bytes: bytes) -> None:
        """
        Always buffer PCM in a rolling window.
        Also acts as an energy-based VAD fallback: if RMS exceeds ENERGY_START
        we begin a burst even if no VOICE frame arrived.
        """
        # Always buffer
        self._pcm_buffer.extend(pcm_bytes)
        if len(self._pcm_buffer) > _MAX_BYTES:
            self._pcm_buffer = self._pcm_buffer[-_MAX_BYTES:]

        # Energy VAD
        samples = np.frombuffer(pcm_bytes, dtype=np.int16)
        if len(samples) == 0:
            return
        rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
        self._audio_chunks += 1
        if rms > self._max_rms:
            self._max_rms = rms
        if self._audio_chunks % 500 == 0:
            logger.info("Audio stats: chunks=%d max_rms=%.0f voice_active=%s buf=%d bytes",
                        self._audio_chunks, self._max_rms, self._voice_active, len(self._pcm_buffer))
            self._max_rms = 0.0

        if rms >= ENERGY_START:
            if not self._voice_active:
                logger.debug("Energy VAD: voice start (RMS=%.0f)", rms)
                self._voice_active = True
                # Trim to pre-roll so we don't transcribe minutes of noise
                keep = len(pcm_bytes) + _PRE_ROLL_BYTES
                if len(self._pcm_buffer) > keep:
                    self._pcm_buffer = self._pcm_buffer[-keep:]
            self._last_voice_ts = time.monotonic()
        elif rms >= ENERGY_HOLD and self._voice_active:
            # Low but non-zero energy: keep the burst alive
            self._last_voice_ts = time.monotonic()

    def feed_dmr_frame(self, frame: dict) -> None:
        """Extend voice window from DMR VOICE frame metadata."""
        if frame.get("frame_type") != "VOICE":
            return
        if not self._voice_active:
            logger.debug("Frame VAD: voice start (TS%s src=%s)", frame.get("timeslot"), frame.get("src_id"))
            self._voice_active = True
            if len(self._pcm_buffer) > _PRE_ROLL_BYTES:
                self._pcm_buffer = self._pcm_buffer[-_PRE_ROLL_BYTES:]
        self._timeslot      = frame.get("timeslot", 0)
        self._src_id        = frame.get("src_id", 0)
        self._last_voice_ts = time.monotonic()

    # ------------------------------------------------------------------
    # Watchdog
    # ------------------------------------------------------------------

    async def _watchdog(self) -> None:
        try:
            while True:
                await asyncio.sleep(0.1)
                if (
                    self._voice_active
                    and (time.monotonic() - self._last_voice_ts) >= VOICE_TIMEOUT_S
                ):
                    await self._flush()
        except asyncio.CancelledError:
            pass

    async def _flush(self) -> None:
        self._voice_active = False
        buf      = bytes(self._pcm_buffer)
        timeslot = self._timeslot
        src_id   = self._src_id
        self._pcm_buffer.clear()

        if len(buf) < _MIN_BYTES:
            return

        duration = len(buf) / (DSD_SAMPLE_RATE * 2)
        logger.info("Transcribing %.1f s of audio (TS%d src=%d)…", duration, timeslot, src_id)

        if self._loop and self._model:
            text = await self._loop.run_in_executor(None, self._transcribe, buf)
            if text:
                payload = {"timeslot": timeslot, "src_id": src_id, "text": text, "ts": time.time()}
                logger.info("Transcript TS%d: %r", timeslot, text)
                await self._cb(payload)

    # ------------------------------------------------------------------
    # Transcription (thread pool)
    # ------------------------------------------------------------------

    def _transcribe(self, pcm_bytes: bytes) -> str:
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        if DSD_SAMPLE_RATE != WHISPER_RATE:
            new_len = int(len(samples) * WHISPER_RATE / DSD_SAMPLE_RATE)
            samples = np.interp(
                np.linspace(0, len(samples), new_len, endpoint=False),
                np.arange(len(samples)),
                samples,
            ).astype(np.float32)

        # vad_filter=False: let our own VAD handle gating; Whisper's VAD can
        # reject synthesised AMBE vocoder speech as "not speech"
        segments, _ = self._model.transcribe(
            samples,
            language=self._language,
            beam_size=1,
            vad_filter=False,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
