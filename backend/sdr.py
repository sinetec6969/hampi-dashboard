"""
sdr.py - SDR engine wrapping rtl_tcp for IQ acquisition, FFT, and FM demodulation.
"""

import logging
import socket
import struct
import subprocess
import time
from typing import Optional

import numpy as np
from scipy.signal import firwin, lfilter, lfilter_zi

logger = logging.getLogger(__name__)

# rtl_tcp command opcodes
CMD_FREQ        = 0x01
CMD_SAMPLE_RATE = 0x02
CMD_GAIN_MODE   = 0x03
CMD_GAIN        = 0x04

MAGIC = b"RTL0"
HEADER_LEN = 12  # 4-byte magic + 4-byte tuner type + 4-byte tuner gain count


class SDREngine:
    """
    Manages rtl_tcp subprocess, TCP socket connection, IQ reads,
    FFT computation, and FM demodulation.
    """

    def __init__(
        self,
        freq: int = 438_800_000,
        sample_rate: int = 2_400_000,
        gain: float = 49.6,
        rtl_tcp_host: str = "127.0.0.1",
        rtl_tcp_port: int = 1234,
    ):
        self.freq = freq
        self.sample_rate = sample_rate
        self.gain = gain
        self.host = rtl_tcp_host
        self.port = rtl_tcp_port

        self._proc: Optional[subprocess.Popen] = None
        self._sock: Optional[socket.socket] = None

        # FM demodulation state
        self._prev_sample: complex = 0 + 0j
        self._decim_ratio = self.sample_rate // 48_000  # 50

        # Audio LPF applied AFTER decimation at 48 kHz.
        # At 48 kHz a 64-tap Hamming FIR gives -72 dB at 12.5 kHz (adjacent DMR
        # channel), which is the correct place to filter.  The same filter applied
        # at 2.4 MHz only gives -0.7 dB at 12.5 kHz — completely ineffective.
        self._audio_lpf    = firwin(numtaps=64, cutoff=6_000, fs=48_000,
                                    window="hamming").astype(np.float32)
        self._audio_lpf_zi = np.zeros(len(self._audio_lpf) - 1, dtype=np.float32)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Launch rtl_tcp and connect the control socket."""
        gain_tenths = int(self.gain * 10)
        cmd = [
            "rtl_tcp",
            "-a", self.host,
            "-p", str(self.port),
            "-f", str(self.freq),
            "-s", str(self.sample_rate),
            "-g", str(self.gain),
        ]
        logger.info("Starting rtl_tcp: %s", " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Give rtl_tcp a moment to bind its port
        time.sleep(1.5)

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.settimeout(5.0)
        retries = 5
        for attempt in range(retries):
            try:
                self._sock.connect((self.host, self.port))
                break
            except ConnectionRefusedError:
                if attempt < retries - 1:
                    logger.warning("rtl_tcp not ready, retry %d/%d", attempt + 1, retries)
                    time.sleep(1.0)
                else:
                    raise RuntimeError("Could not connect to rtl_tcp after retries")

        # Read and validate the 12-byte magic header
        header = self._recv_exactly(HEADER_LEN)
        if not header.startswith(MAGIC):
            raise RuntimeError(f"Unexpected rtl_tcp magic: {header[:4]!r}")
        tuner_type = struct.unpack(">I", header[4:8])[0]
        gain_count = struct.unpack(">I", header[8:12])[0]
        logger.info(
            "Connected to rtl_tcp — tuner type=%d, gain steps=%d", tuner_type, gain_count
        )

        self._sock.settimeout(None)  # blocking from here on

        # Send initial configuration
        self._send_command(CMD_GAIN_MODE, 1)          # manual gain
        self._send_command(CMD_GAIN, int(self.gain * 10))
        self._send_command(CMD_SAMPLE_RATE, self.sample_rate)
        self._send_command(CMD_FREQ, self.freq)

    def stop(self) -> None:
        """Close socket and terminate rtl_tcp."""
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None
        logger.info("SDREngine stopped")

    # ------------------------------------------------------------------
    # rtl_tcp socket helpers
    # ------------------------------------------------------------------

    def _send_command(self, cmd: int, value: int) -> None:
        """Send a 5-byte rtl_tcp command: [cmd:1B][value:4B big-endian]."""
        if self._sock is None:
            raise RuntimeError("Not connected to rtl_tcp")
        data = struct.pack(">BI", cmd, value)
        self._sock.sendall(data)

    def _recv_exactly(self, n: int) -> bytes:
        """Read exactly n bytes from the socket."""
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("rtl_tcp socket closed unexpectedly")
            buf += chunk
        return buf

    # ------------------------------------------------------------------
    # IQ acquisition
    # ------------------------------------------------------------------

    def read_iq(self, n_samples: int) -> np.ndarray:
        """
        Read n_samples IQ samples from rtl_tcp.

        rtl_tcp streams interleaved uint8 [I, Q, I, Q, …].
        Converts to complex64: (raw - 127.5) / 127.5.

        Returns:
            np.ndarray of shape (n_samples,), dtype=complex64
        """
        raw = self._recv_exactly(n_samples * 2)
        u8 = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        u8 = (u8 - 127.5) / 127.5
        return (u8[0::2] + 1j * u8[1::2]).astype(np.complex64)

    # ------------------------------------------------------------------
    # FFT / waterfall
    # ------------------------------------------------------------------

    def compute_fft(self, iq: np.ndarray, n_fft: int = 1024) -> np.ndarray:
        """
        Compute power spectrum suitable for waterfall display.

        Uses a Blackman window, fftshift to centre DC, then converts
        to dBFS (20·log10 of magnitude).

        Args:
            iq:    Complex64 IQ samples. Uses the first n_fft samples.
            n_fft: FFT size (default 1024).

        Returns:
            np.ndarray of shape (n_fft,), dtype=float32, in dBFS.
        """
        frame = iq[:n_fft]
        window = np.blackman(n_fft).astype(np.float32)
        windowed = frame * window
        spectrum = np.fft.fftshift(np.fft.fft(windowed, n=n_fft))
        power = np.abs(spectrum) / n_fft
        # Avoid log10(0)
        power = np.maximum(power, 1e-10)
        return (20.0 * np.log10(power)).astype(np.float32)

    # ------------------------------------------------------------------
    # FM demodulation
    # ------------------------------------------------------------------

    def fm_demodulate(self, iq: np.ndarray, target_freq: int) -> bytes:
        """
        Demodulate FM from IQ samples centred at self.freq.

        Steps:
          1. Frequency-shift to move target_freq to baseband.
          1. Frequency shift so target_freq lands at DC (skipped if already there).
          2. Decimate IQ from 2.4 MHz to 48 kHz (factor 50, no pre-filter needed —
             adjacent channels land at ≥12.5 kHz in the 48 kHz domain where the
             audio LPF rejects them at −72 dB).
          3. FM discriminator: instantaneous phase via conjugate product.
          4. Low-pass filter at 48 kHz — 64-tap Hamming FIR, 6 kHz cutoff.
             Stateful (lfilter + zi) so there is no transient at chunk boundaries.
          5. Scale and clip to int16.

        Args:
            iq:          Complex64 IQ array at self.sample_rate.
            target_freq: Centre frequency of the FM carrier (Hz).

        Returns:
            Raw PCM bytes, int16 little-endian, mono, 48 kHz.
        """
        n = len(iq)

        # 1. Frequency shift so target_freq lands at DC
        freq_offset = target_freq - self.freq
        if freq_offset != 0:
            t = np.arange(n, dtype=np.float32) / self.sample_rate
            shift = np.exp(-2j * np.pi * freq_offset * t).astype(np.complex64)
            iq = iq * shift

        # 2. Decimate IQ to 48 kHz — simple stride, no pre-filter.
        # Adjacent DMR channels (±12.5 kHz) survive decimation at 12.5 kHz in the
        # 48 kHz domain and are removed by the audio LPF in step 4.
        decimated = iq[:: self._decim_ratio]

        # 3. FM discriminator: angle(x[n] · conj(x[n-1])) = instantaneous freq
        prev = np.empty_like(decimated)
        prev[0]  = self._prev_sample
        prev[1:] = decimated[:-1]
        self._prev_sample = decimated[-1]
        demod = np.angle(decimated * np.conj(prev)).astype(np.float32)

        # 4. Low-pass filter at 48 kHz: channel selection and noise rejection.
        # lfilter with zi maintains state across chunks (no per-chunk transient).
        demod, self._audio_lpf_zi = lfilter(
            self._audio_lpf, [1.0], demod, zi=self._audio_lpf_zi
        )

        # 5. Scale to int16
        demod = demod.astype(np.float32)
        demod *= 32767.0 / np.pi
        pcm = np.clip(demod, -32768, 32767).astype(np.int16)
        return pcm.tobytes()

    # ------------------------------------------------------------------
    # Runtime tuning
    # ------------------------------------------------------------------

    def set_freq(self, freq: int) -> None:
        """Retune the SDR to freq (Hz) and update internal state."""
        self.freq = freq
        self._send_command(CMD_FREQ, freq)
        logger.info("Tuned to %d Hz", freq)

    def set_gain(self, gain: float) -> None:
        """Set tuner gain (dB, expressed as tenths-of-dB to rtl_tcp)."""
        self.gain = gain
        self._send_command(CMD_GAIN_MODE, 1)
        self._send_command(CMD_GAIN, int(gain * 10))
        logger.info("Gain set to %.1f dB", gain)
