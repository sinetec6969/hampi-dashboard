"""
scanner.py - AM/FM scanner across the VHF/UHF range, backed by an independent
rtl_tcp instance.

Scanner behaviour:
  - Cycles through a channel list at dwell_ms intervals.
  - Each channel carries its own modulation (AM or FM); the demodulator is
    picked per channel, so an airband AM channel and a 2 m FM repeater can sit
    in the same list.
  - When the channel's squelch metric exceeds the threshold for its mode the
    channel is held; scanning resumes hold_s seconds after the signal drops.
  - One chunk after retuning is discarded to let the SDR settle.
  - PCM (int16, mono, 48 kHz) is sent to the audio_callback only while squelch
    is open (gated audio — no noise between transmissions).

Squelch is per-mode because the two metrics are not the same quantity: AM
squelches on envelope modulation depth, FM on carrier magnitude.

Favourites live in an .ini file — see parse_ini/dump_ini.
"""

import asyncio
import configparser
import logging
from typing import Callable, Awaitable, Optional

from sdr import SDREngine

logger = logging.getLogger(__name__)

CHUNK = 131_072  # IQ samples per read (~54 ms at 2.4 MHz)

DEFAULT_CHANNELS = [
    {"freq": 121_500_000, "label": "Guard",     "mode": "AM"},
    {"freq": 123_450_000, "label": "CTAF",      "mode": "AM"},
    {"freq": 126_200_000, "label": "Center",    "mode": "AM"},
    {"freq": 132_850_000, "label": "Departure", "mode": "AM"},
]

AudioCb  = Callable[[bytes], Awaitable[None]]
StatusCb = Callable[[dict], Awaitable[None]]


def default_mode(freq: int) -> str:
    """Civil airband is the only AM allocation in the tuner's VHF/UHF range."""
    return "AM" if 108_000_000 <= freq <= 137_000_000 else "FM"


def parse_ini(text: str) -> list[dict]:
    """
    Parse a favourites .ini into a channel list.

        [NOAA WX1]
        freq = 162.550      ; MHz, or Hz if the number is large
        mode = FM           ; optional — inferred from the band if absent

    Section name is the channel label. Raises ValueError on a bad file so the
    caller can reject an upload without clobbering a working list.
    """
    cp = configparser.ConfigParser()
    try:
        cp.read_string(text)
    except configparser.Error as exc:
        raise ValueError(f"not a valid .ini file: {exc}") from exc

    channels: list[dict] = []
    for label in cp.sections():
        sec = cp[label]
        raw = sec.get("freq")
        if raw is None:
            raise ValueError(f"[{label}] has no freq")
        try:
            val = float(raw)
        except ValueError:
            raise ValueError(f"[{label}] freq {raw!r} is not a number") from None
        # Bare numbers under 10 000 are MHz; anything larger is already Hz.
        freq = int(val if val > 10_000 else val * 1e6)
        if not 24_000_000 <= freq <= 1_766_000_000:
            raise ValueError(f"[{label}] {freq/1e6:.4f} MHz is outside the tuner range")
        mode = sec.get("mode", "").strip().upper() or default_mode(freq)
        if mode not in ("AM", "FM"):
            raise ValueError(f"[{label}] mode {mode!r} must be AM or FM")
        channels.append({"freq": freq, "label": label, "mode": mode})

    if not channels:
        raise ValueError("no channels found — each channel needs its own [section]")
    return channels


def dump_ini(channels: list[dict]) -> str:
    """Render a channel list back to .ini text (round-trips through parse_ini)."""
    lines = ["; HamPi scanner favourites — one [section] per channel",
             "; freq in MHz (or Hz), mode = AM | FM (optional)", ""]
    for ch in channels:
        lines.append(f"[{ch['label']}]")
        lines.append(f"freq = {ch['freq'] / 1e6:.4f}")
        lines.append(f"mode = {ch.get('mode') or default_mode(ch['freq'])}")
        lines.append("")
    return "\n".join(lines)


class Scanner:
    """
    AM/FM scanner backed by its own rtl_tcp/SDREngine instance.
    Designed to run alongside the DMR stack on a second SDR dongle.
    """

    def __init__(
        self,
        channels: list[dict] = DEFAULT_CHANNELS,
        squelch_am: float = 0.01,
        squelch_fm: float = 0.05,
        dwell_ms: int = 2000,
        hold_s: float = 1.0,
        gain: float = 40.0,
        sample_rate: int = 2_400_000,
        rtl_device: int | str = 1,
        rtl_port: int = 1235,
        audio_callback: Optional[AudioCb] = None,
        status_callback: Optional[StatusCb] = None,
    ):
        self.channels   = self._normalize(channels)
        self.squelch_am = squelch_am
        self.squelch_fm = squelch_fm
        self.dwell_ms   = dwell_ms
        self.hold_s     = hold_s
        self.scanner_on = True

        self._audio_cb  = audio_callback
        self._status_cb = status_callback
        self._active    = False
        self._task: Optional[asyncio.Task] = None

        self._active_idx   = 0
        self._squelch_open = False
        self._level        = 0.0

        first_freq = self.channels[0]["freq"] if self.channels else 121_500_000
        self._sdr = SDREngine(
            freq=first_freq,
            sample_rate=sample_rate,
            gain=gain,
            rtl_tcp_host="127.0.0.1",
            rtl_tcp_port=rtl_port,
            device_index=rtl_device,
        )

    @staticmethod
    def _normalize(channels: list[dict]) -> list[dict]:
        """Fill in a mode for channels that came from config without one."""
        out = []
        for ch in channels:
            mode = str(ch.get("mode", "")).upper()
            out.append({
                "freq":  int(ch["freq"]),
                "label": ch.get("label", f"{int(ch['freq'])/1e6:.4f}"),
                "mode":  mode if mode in ("AM", "FM") else default_mode(int(ch["freq"])),
            })
        return out

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def active_idx(self) -> int:
        return self._active_idx

    @property
    def squelch_open(self) -> bool:
        return self._squelch_open

    def set_squelch(self, level: float, mode: str = "AM") -> None:
        if mode.upper() == "FM":
            self.squelch_fm = max(0.0, level)
        else:
            self.squelch_am = max(0.0, level)

    def set_dwell(self, dwell_ms: int) -> None:
        self.dwell_ms = max(200, int(dwell_ms))

    def set_hold(self, hold_s: float) -> None:
        self.hold_s = max(0.0, float(hold_s))

    def set_scanner(self, enabled: bool) -> None:
        self.scanner_on = enabled

    def set_channels(self, channels: list[dict]) -> None:
        self.channels = self._normalize(channels)
        self._active_idx = 0

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sdr.start)
        self._active = True
        self._task   = asyncio.create_task(self._scan_loop(), name="scanner-scan")
        logger.info("Scanner started — device=%s port=%d",
                    self._sdr.device_index, self._sdr.port)

    async def stop(self) -> None:
        self._active = False
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        self._sdr.stop()
        logger.info("Scanner stopped")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _tune_to(self, idx: int) -> None:
        self._active_idx = idx % len(self.channels)
        ch = self.channels[self._active_idx]
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sdr.set_freq, ch["freq"])
        self._squelch_open = False
        await self._emit_status()
        logger.debug("Scanner tuned to ch %d: %s (%d Hz %s)",
                     self._active_idx, ch["label"], ch["freq"], ch["mode"])

    def _threshold(self, mode: str) -> float:
        return self.squelch_fm if mode == "FM" else self.squelch_am

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
                "squelch_am":   self.squelch_am,
                "squelch_fm":   self.squelch_fm,
                "dwell_ms":     self.dwell_ms,
                "hold_s":       self.hold_s,
                "level":        round(self._level, 5),
            })
        except Exception:
            logger.exception("scanner status_callback raised")

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

                ch = self.channels[self._active_idx]
                demod = (self._sdr.nbfm_demodulate if ch["mode"] == "FM"
                         else self._sdr.am_demodulate)
                pcm, level = await loop.run_in_executor(None, demod, iq, ch["freq"])
                self._level = level

                now          = loop.time()
                was_open     = self._squelch_open
                squelch_open = level > self._threshold(ch["mode"])
                self._squelch_open = squelch_open

                if squelch_open:
                    hold_until = now + self.hold_s
                    if self._audio_cb:
                        await self._audio_cb(pcm)

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
                logger.exception("Scanner loop error — retrying in 2 s")
                await asyncio.sleep(2)


if __name__ == "__main__":
    ini = """
[Guard]
freq = 121.5

[NOAA WX1]
freq = 162.550
mode = FM

[UHF Repeater]
freq = 442125000
"""
    chans = parse_ini(ini)
    assert chans == [
        {"freq": 121_500_000, "label": "Guard",        "mode": "AM"},
        {"freq": 162_550_000, "label": "NOAA WX1",     "mode": "FM"},
        {"freq": 442_125_000, "label": "UHF Repeater", "mode": "FM"},
    ], chans
    assert parse_ini(dump_ini(chans)) == chans, "ini round-trip"

    for bad in ("[X]\nfreq = 5000.0\n",        # 5 GHz — out of tuner range
                "[X]\nmode = FM\n",            # no freq
                "[X]\nfreq = abc\n",           # not a number
                "[X]\nfreq = 146.52\nmode = SSB\n",
                "; comments only\n"):
        try:
            parse_ini(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"should have rejected: {bad!r}")

    assert Scanner._normalize([{"freq": 146_520_000, "label": "Simplex"}])[0]["mode"] == "FM"
    print("ok")
