"""
websdr.py - WebSDR-style receiver DSP for the device-0 "websdr" mode.

Each 2.4 MS/s IQ chunk from SDREngine yields:
  - one spectrum line (1024 bins) of the current *view* — a zoomed sub-span
    of the capture, cut from a larger FFT (down to ~19 kHz wide at N=131072)
  - 48 kHz int16 audio of the *receiver* — a tuned offset inside the capture,
    demodulated as NFM / AM / WFM / USB / LSB / CW with an adjustable passband

Frame wire format (binary WS): float64 view_center_hz, float64 view_span_hz,
then 1024 × float32 dBFS. The header lets the browser drop/rescale lines
that raced a zoom change.

Settings are plain attributes written from the event loop and read by
process() in the executor; filter redesigns are deferred into process().
"""

import numpy as np
import scipy.fft as sfft
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import firwin, lfilter, lfilter_zi

AUDIO_RATE = 48_000
N_BINS     = 1024
MAX_FFT    = 131_072          # = CHUNK_SIZE; bounds the finest zoom
MODES      = ("NFM", "AM", "WFM", "USB", "LSB", "CW")
DEFAULT_BW = {"NFM": 12_500, "AM": 8_000, "WFM": 180_000, "USB": 2_700, "LSB": 2_700, "CW": 500}
CW_PITCH   = 700              # Hz — CW rides USB with the passband centred here


class WebSDRReceiver:
    def __init__(self, sample_rate: int = 2_400_000):
        self.sr = sample_rate
        self.min_span = self.sr * N_BINS / MAX_FFT

        # view (offsets relative to the capture centre)
        self.view_offset = 0.0
        self.span = float(self.sr)
        # receiver
        self.rx_offset = 0.0
        self.mode = "NFM"
        self.bw = DEFAULT_BW["NFM"]

        self._phase = 0.0
        self._windows: dict[int, np.ndarray] = {}
        # 2.4 MHz → 240 kHz → 48 kHz, same split as SDREngine._decimate
        # Stage 1 is polyphase (only every 10th output computed) — a full-rate
        # lfilter here alone ate 20 ms of the 54.6 ms chunk budget on the Pi 4
        self._lpf1_rev = firwin(33, 100_000, fs=self.sr)[::-1].astype(np.complex64)
        self._tail1 = np.zeros(len(self._lpf1_rev) - 1, np.complex64)
        self._lpf2 = firwin(63, 20_000, fs=self.sr / 10).astype(np.float32)
        self._zi2 = lfilter_zi(self._lpf2, 1.0).astype(np.complex64) * 0
        self._rot_key = None
        self._rot = np.ones(1, np.complex64)
        # WFM stays at 240 kHz for demod, then audio LPF + 5:1
        self._wfm_lpf = firwin(64, 15_000, fs=self.sr / 10).astype(np.float32)
        self._wfm_zi = np.zeros(len(self._wfm_lpf) - 1, np.float32)
        self._deemph_a = np.exp(-1 / (self.sr / 10 * 75e-6))   # 75 µs (US)
        self._deemph_z = np.zeros(1, np.float32)

        self._prev = np.complex64(0)
        self._dc = 0.0
        self._agc = 1.0
        self._taps_key = None
        self._chan: np.ndarray = np.ones(1, np.complex64)
        self._chan_zi = np.zeros(0, np.complex64)

    # ------------------------------------------------------------------ settings

    def set_view(self, offset: float, span: float) -> None:
        span = float(min(max(span, self.min_span), self.sr))
        half = self.sr / 2 - span / 2
        self.view_offset = float(min(max(offset, -half), half))
        self.span = span

    def set_rx(self, offset: float, mode: str, bw: float) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.rx_offset = float(min(max(offset, -self.sr / 2), self.sr / 2))
        self.mode = mode
        self.bw = float(bw)

    def state(self) -> dict:
        return {"view_offset": self.view_offset, "span": self.span,
                "rx_offset": self.rx_offset, "mode": self.mode, "bw": self.bw,
                "min_span": self.min_span}

    # ------------------------------------------------------------------ DSP

    def process(self, iq: np.ndarray) -> tuple[bytes, bytes]:
        return self._spectrum(iq), self._audio(iq)

    def _spectrum(self, iq: np.ndarray) -> bytes:
        span, voff = self.span, self.view_offset
        n = 1 << int(np.ceil(np.log2(N_BINS * self.sr / span)))
        n = min(max(n, N_BINS), MAX_FFT, len(iq))
        w = self._windows.get(n)
        if w is None:
            w = self._windows[n] = np.blackman(n).astype(np.float32)
        spec = np.fft.fftshift(sfft.fft(iq[:n] * w, workers=4))
        # bin k sits at -sr/2 + k·sr/n; cut [voff - span/2, voff + span/2)
        lo = (voff - span / 2 + self.sr / 2) * n / self.sr
        edges = np.clip(np.round(lo + np.arange(N_BINS + 1) * span * n / self.sr / N_BINS).astype(int), 0, n - 1)
        a, b = edges[0], edges[-1] + 1
        p = 20 * np.log10(np.abs(spec[a:b]) / n + 1e-12)   # only the bins in view
        if b - a > N_BINS:                         # several FFT bins per pixel → peak-hold
            out = np.maximum.reduceat(p, edges[:-1] - a)
        else:                                      # zoomed past FFT resolution → sample
            out = p[edges[:-1] - a]
        hdr = np.array([voff, span], np.float64).tobytes()
        return hdr + out.astype(np.float32).tobytes()

    def _design(self) -> None:
        key = (self.mode, self.bw)
        if key == self._taps_key:
            return
        bw = self.bw
        if self.mode == "WFM":
            self._taps_key = key
            return
        if self.mode in ("USB", "LSB", "CW"):
            lo, hi = {"USB": (150, bw), "LSB": (-bw, -150),
                      "CW": (CW_PITCH - bw / 2, CW_PITCH + bw / 2)}[self.mode]
            proto = firwin(255, (hi - lo) / 2, fs=AUDIO_RATE)
            fc = (lo + hi) / 2
        else:
            proto = firwin(127, min(bw / 2, 23_000), fs=AUDIO_RATE)
            fc = 0.0
        n = np.arange(len(proto))
        self._chan = (proto * np.exp(2j * np.pi * fc * n / AUDIO_RATE)).astype(np.complex64)
        self._chan_zi = np.zeros(len(self._chan) - 1, np.complex64)
        self._taps_key = key

    def _audio(self, iq: np.ndarray) -> bytes:
        self._design()
        # tune: shift rx_offset to DC. Rotator cached per (offset, length);
        # the running phase is applied as one scalar so chunks stay continuous
        n, off = len(iq), self.rx_offset
        if self._rot_key != (off, n):
            self._rot = np.exp(-2j * np.pi * off * np.arange(n) / self.sr).astype(np.complex64)
            self._rot_key = (off, n)
        x = iq * (self._rot * np.complex64(np.exp(1j * self._phase)))
        self._phase = float((self._phase - 2 * np.pi * off * n / self.sr) % (2 * np.pi))

        xe = np.concatenate((self._tail1, x))
        win = sliding_window_view(xe, len(self._lpf1_rev))[::10]
        self._tail1 = xe[len(win) * 10:]                        # keeps stride phase across chunks
        x = win @ self._lpf1_rev                                # 240 kHz

        if self.mode == "WFM":
            prev = np.concatenate(([self._prev], x[:-1]))
            self._prev = x[-1]
            d = np.angle(x * np.conj(prev)).astype(np.float32)
            d, self._deemph_z = lfilter([1 - self._deemph_a], [1, -self._deemph_a], d, zi=self._deemph_z)
            d, self._wfm_zi = lfilter(self._wfm_lpf, 1.0, d, zi=self._wfm_zi)
            audio = d[::5] * 0.6
            return self._pcm(audio)

        x, self._zi2 = lfilter(self._lpf2, 1.0, x, zi=self._zi2)
        x = x[::5]                                              # 48 kHz
        y, self._chan_zi = lfilter(self._chan, 1.0, x, zi=self._chan_zi)

        if self.mode == "NFM":
            prev = np.concatenate(([self._prev], y[:-1]))
            self._prev = y[-1]
            audio = np.angle(y * np.conj(prev)).astype(np.float32) * 0.8
            return self._pcm(audio)
        if self.mode == "AM":
            env = np.abs(y).astype(np.float32)
            self._dc = 0.99 * self._dc + 0.01 * float(env.mean())
            audio = env - self._dc
        else:                                                   # USB / LSB / CW
            audio = y.real.astype(np.float32)
        return self._pcm(self._apply_agc(audio))

    def _apply_agc(self, a: np.ndarray) -> np.ndarray:
        # Block AGC: fast attack, slow release, gain ramped across the block
        peak = float(np.max(np.abs(a))) + 1e-9
        target = min(0.4 / peak, 2e4)
        new = target if target < self._agc else self._agc + (target - self._agc) * 0.05
        g = np.linspace(self._agc, new, len(a), dtype=np.float32)
        self._agc = new
        return a * g

    @staticmethod
    def _pcm(a: np.ndarray) -> bytes:
        return (np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes()


if __name__ == "__main__":
    # Offline self-test: synthetic tones through every mode + zoom geometry
    sr, n = 2_400_000, 131_072
    t = np.arange(n) / sr
    rx = WebSDRReceiver(sr)

    def tone_at(pcm: bytes) -> float:
        a = np.frombuffer(pcm, np.int16).astype(np.float32)
        a = a[len(a) // 4:]
        f = np.abs(np.fft.rfft(a * np.hanning(len(a))))
        return np.argmax(f[5:]) * AUDIO_RATE / len(a) + 5 * AUDIO_RATE / len(a)

    # USB: carrier at +100 kHz, tone 1 kHz above it → 1 kHz audio
    sig = np.exp(2j * np.pi * (100_000 + 1_000) * t).astype(np.complex64)
    rx.set_rx(100_000, "USB", 2_700)
    for _ in range(3): _, pcm = rx.process(sig)
    f_usb = tone_at(pcm)
    # LSB: tone 1 kHz below the dial → 1 kHz audio; USB must reject it
    sig_l = np.exp(2j * np.pi * (100_000 - 1_000) * t).astype(np.complex64)
    rx.set_rx(100_000, "LSB", 2_700)
    for _ in range(3): _, pcm = rx.process(sig_l)
    f_lsb = tone_at(pcm)
    # CW: carrier 700 Hz above dial → 700 Hz tone
    sig_c = np.exp(2j * np.pi * (100_000 + 700) * t).astype(np.complex64)
    rx.set_rx(100_000, "CW", 500)
    for _ in range(3): _, pcm = rx.process(sig_c)
    f_cw = tone_at(pcm)
    # NFM: 1 kHz tone, 3 kHz deviation at -200 kHz
    ph = 2 * np.pi * -200_000 * t + (3_000 / 1_000) * np.sin(2 * np.pi * 1_000 * t)
    rx.set_rx(-200_000, "NFM", 12_500)
    for _ in range(3): _, pcm = rx.process(np.exp(1j * ph).astype(np.complex64))
    f_nfm = tone_at(pcm)
    # AM: 1 kHz, 50% at +50 kHz
    am = ((1 + 0.5 * np.sin(2 * np.pi * 1_000 * t)) * np.exp(2j * np.pi * 50_000 * t)).astype(np.complex64)
    rx.set_rx(50_000, "AM", 8_000)
    for _ in range(3): _, pcm = rx.process(am)
    f_am = tone_at(pcm)
    # WFM: 1 kHz tone, 50 kHz deviation at +300 kHz
    ph = 2 * np.pi * 300_000 * t + 50 * np.sin(2 * np.pi * 1_000 * t)
    rx.set_rx(300_000, "WFM", 180_000)
    for _ in range(3): _, pcm = rx.process(np.exp(1j * ph).astype(np.complex64))
    f_wfm = tone_at(pcm)

    # Zoom: a carrier at +100 kHz must land at the centre pixel of a 50 kHz view there
    rx.set_view(100_000, 50_000)
    frame, _ = rx.process(sig)
    voff, span = np.frombuffer(frame[:16], np.float64)
    bins = np.frombuffer(frame[16:], np.float32)
    peak_px = int(np.argmax(bins))
    peak_hz = voff - span / 2 + (peak_px + 0.5) * span / N_BINS

    res = {"USB": f_usb, "LSB": f_lsb, "CW": f_cw, "NFM": f_nfm, "AM": f_am, "WFM": f_wfm}
    print({k: round(v) for k, v in res.items()}, f"zoom peak {peak_hz:.0f} Hz span {span:.0f}")
    for k, want in (("USB", 1000), ("LSB", 1000), ("CW", 700), ("NFM", 1000), ("AM", 1000), ("WFM", 1000)):
        assert abs(res[k] - want) < 40, (k, res[k])
    assert abs(peak_hz - 101_000) < span / N_BINS * 2, peak_hz
    assert len(bins) == N_BINS
    rx.set_view(0, 1)          # clamps to min span
    assert rx.span == rx.min_span
    print("PASS")
