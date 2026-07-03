"""
radio.py - Digirig Mobile TX interface: RTS PTT + ALSA audio out.

Phase A foundation for the transmit era. The Digirig is a USB sound card
(C-Media codec) plus a CP2102N serial port whose RTS line keys the radio's
PTT. We hold the serial port open with RTS deasserted for the life of the
process, so opening the device never keys the rig; TX asserts RTS only for
the duration of a transmission.

TX is HARD-GATED: every transmit call refuses unless config sets
radio.tx_enable: true AND station.callsign is non-empty. Unmodulated-carrier
and tone helpers exist for bring-up / deviation calibration; real modes
(APRS, AX.25) key through direwolf, which gets the same Digirig device.
"""

import logging
import subprocess
import threading
import time
from typing import Optional

import numpy as np
import serial

logger = logging.getLogger(__name__)


def _sine(freq: int, seconds: float, rate: int = 48_000, amp: float = 0.5) -> bytes:
    t = np.arange(int(rate * seconds)) / rate
    return (np.sin(2 * np.pi * freq * t) * amp * 32767).astype("<i2").tobytes()


class RadioInterface:
    def __init__(self, serial_port: str, audio_device: str,
                 tx_enable: bool, callsign: str):
        self.serial_port  = serial_port
        self.audio_device = audio_device
        self.tx_enable    = tx_enable
        self.callsign     = (callsign or "").strip().upper()
        self._ser: Optional[serial.Serial] = None
        # TX methods run in thread-pool executors — serialize PTT access
        self._tx_lock = threading.Lock()

    def start(self) -> None:
        # Open then immediately deassert RTS — a sub-ms blip at most, never a key.
        ser = serial.Serial(self.serial_port)
        ser.rts = False
        ser.dtr = False
        self._ser = ser
        logger.info("RadioInterface open on %s (tx_enable=%s, callsign=%s)",
                    self.serial_port, self.tx_enable, self.callsign or "—")

    def stop(self) -> None:
        if self._ser is not None:
            try:
                self._ser.rts = False
                self._ser.close()
            except Exception:
                pass
            self._ser = None

    @property
    def ready(self) -> bool:
        return bool(self.tx_enable and self.callsign and self._ser is not None)

    def _guard(self) -> None:
        if not self.tx_enable:
            raise PermissionError("TX disabled — set radio.tx_enable: true in config.yaml")
        if not self.callsign:
            raise PermissionError("TX refused — set station.callsign in config.yaml")
        if self._ser is None:
            raise RuntimeError("radio serial port not open")

    def key(self, on: bool) -> None:
        self._guard()
        self._ser.rts = bool(on)

    def ptt_test(self, seconds: float = 1.0) -> None:
        """Key an unmodulated carrier briefly — confirms PTT wiring only."""
        self._guard()
        with self._tx_lock:
            self._ser.rts = True
            try:
                time.sleep(seconds)
            finally:
                self._ser.rts = False

    def transmit_tone(self, freq: int = 1000, seconds: float = 2.0) -> None:
        """Key + emit a sine tone out the Digirig — deviation calibration."""
        self._guard()
        pcm = _sine(freq, seconds)
        with self._tx_lock:
            self._ser.rts = True
            try:
                # timeout: a hung aplay must never leave the radio keyed
                subprocess.run(
                    ["aplay", "-D", self.audio_device, "-f", "S16_LE",
                     "-r", "48000", "-c", "1", "-q", "-"],
                    input=pcm, check=True, timeout=seconds + 2.0,
                )
            finally:
                self._ser.rts = False

    def status(self) -> dict:
        return {
            "serial":    self.serial_port,
            "audio":     self.audio_device,
            "tx_enable": self.tx_enable,
            "callsign":  self.callsign,
            "ready":     self.ready,
            "open":      self._ser is not None,
            "keyed":     bool(self._ser is not None and self._ser.rts),
        }


if __name__ == "__main__":
    # Offline checks — no serial, no audio, no keying.
    assert len(_sine(1000, 1.0)) == 48000 * 2, "48 kHz mono S16 byte count"
    r = RadioInterface("/dev/null", "hw:CARD=Device", tx_enable=False, callsign="")
    for fn in (lambda: r.key(True), r.ptt_test, r.transmit_tone):
        try:
            fn(); assert False, "guard should have blocked TX"
        except PermissionError:
            pass
    r.tx_enable = True
    try:
        r.ptt_test(); assert False
    except PermissionError:
        pass  # still blocked: no callsign
    r.callsign = "N0CALL"
    try:
        r.key(True); assert False
    except RuntimeError:
        pass  # callsign+enable ok, but serial not open
    print("PASS: tone gen + TX guards (tx_enable, callsign, open)")
