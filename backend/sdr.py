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
from scipy.signal import firwin, oaconvolve

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

        # Build decimation filter once (2.4 MHz -> 48 kHz, ratio=50)
        # Cutoff 6 kHz: DMR uses 12.5 kHz channel spacing with ±1944 Hz deviation;
        # 6 kHz passes the full DMR signal while rejecting adjacent channel noise.
        self._decim_ratio = self.sample_rate // 48_000  # 50
        self._fm_lpf = firwin(
            numtaps=64,
            cutoff=6_000,
            fs=self.sample_rate,
            window="hamming",
        )

        # Overlap-save state: last (numtaps-1) samples from the previous chunk.
        # Prepended to each new chunk so the FIR filter has correct past history
        # at every chunk boundary (no startup transient between chunks).
        self._lpf_tail = np.zeros(len(self._fm_lpf) - 1, dtype=np.complex64)

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
          2. Low-pass filter (15 kHz cutoff, 64-tap FIR).
          3. Decimate from sample_rate (2.4 MHz) to 48 kHz.
          4. FM discriminator via conjugate product.
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

        # 2. Low-pass filter via overlap-add (oaconvolve).
        # Prepend the saved tail from the previous chunk so the filter has correct
        # history at the boundary — no startup transient between chunks.
        M = len(self._fm_lpf)
        padded   = np.concatenate([self._lpf_tail, iq])
        full_out = oaconvolve(padded, self._fm_lpf, mode="full")
        filtered = full_out[M - 1 : M - 1 + len(iq)].astype(np.complex64)
        self._lpf_tail = iq[-(M - 1):]

        # 3. Decimate
        decimated = filtered[:: self._decim_ratio]

        # 4. FM discriminator: angle of x[n] * conj(x[n-1])
        prev = np.empty_like(decimated)
        prev[0] = self._prev_sample
        prev[1:] = decimated[:-1]
        self._prev_sample = decimated[-1]

        product = decimated * np.conj(prev)
        demod = np.angle(product).astype(np.float32)

        # 5. Scale to int16
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
