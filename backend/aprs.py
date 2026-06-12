"""
aprs.py - APRS decoder backed by a direwolf subprocess.

Audio path: SDREngine.fm_demodulate() (int16 mono 48 kHz) piped to direwolf
stdin; direwolf decodes AX.25/AFSK and prints one frame per line on stdout;
payloads are parsed with aprslib.

TX path (future): BTech APRS-K1 audio cable — HT speaker/mic jack wired to a
USB soundcard on the Pi; direwolf keys the radio via VOX, enabling beacon /
digipeat / igate transmit with no TNC hardware.
"""

import asyncio
import logging
import os
import re
import time
from collections import deque
from typing import Awaitable, Callable, Optional

import aprslib

logger = logging.getLogger(__name__)

PacketCb = Callable[[dict], Awaitable[None]]

# direwolf frame line: "[0] SRC>DST,PATH:payload" (channel may carry a
# slicer suffix like "[0.3]" when multiple decoders run)
_FRAME_RE = re.compile(r"^\[\d+(?:\.\d+)?\] (\S+>.+)$")

_KEEP_KEYS = (
    "format", "to", "path", "via", "latitude", "longitude", "altitude",
    "course", "speed", "symbol", "symbol_table", "comment", "status",
    "message_text", "addresse", "weather", "object_name", "alive",
)


class APRSDecoder:
    """direwolf subprocess + aprslib parsing + station registry."""

    def __init__(
        self,
        sample_rate: int = 48_000,
        max_packets: int = 200,
        packet_callback: Optional[PacketCb] = None,
    ):
        self.sample_rate = sample_rate
        self._cb         = packet_callback

        self.packets:  deque[dict]     = deque(maxlen=max_packets)
        self.stations: dict[str, dict] = {}
        self.frames_total = 0
        self.parse_errors = 0

        self._proc:      Optional[asyncio.subprocess.Process] = None
        self._read_task: Optional[asyncio.Task] = None
        self._active = False

    async def start(self) -> None:
        # -t 0 no colors, -q hd quiet (audio levels + descriptions),
        # -n 1 mono, -b 16 bit, "-" audio from stdin
        conf = os.path.join(os.path.dirname(__file__), "direwolf.conf")
        cmd = ["direwolf", "-c", conf, "-t", "0", "-q", "hd", "-n", "1",
               "-r", str(self.sample_rate), "-b", "16", "-"]
        logger.info("Starting direwolf: %s", " ".join(cmd))
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._active    = True
        self._read_task = asyncio.create_task(self._read_loop(), name="aprs-read")
        logger.info("APRSDecoder started")

    async def stop(self) -> None:
        self._active = False
        if self._read_task is not None:
            self._read_task.cancel()
            await asyncio.gather(self._read_task, return_exceptions=True)
            self._read_task = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
            self._proc = None
        logger.info("APRSDecoder stopped")

    async def write_audio(self, pcm: bytes) -> None:
        if self._proc is None or self._proc.stdin is None or self._proc.returncode is not None:
            return
        try:
            self._proc.stdin.write(pcm)
            await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            # RuntimeError: uvloop raises it on write to a closed transport
            logger.warning("direwolf stdin closed")

    def status_dict(self) -> dict:
        return {
            "type":         "status",
            "running":      self._active,
            "frames":       self.frames_total,
            "parse_errors": self.parse_errors,
            "stations":     len(self.stations),
        }

    # ------------------------------------------------------------------

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while self._active:
                line = await self._proc.stdout.readline()
                if not line:
                    logger.warning("direwolf stdout closed")
                    break
                m = _FRAME_RE.match(line.decode("utf-8", errors="replace").strip())
                if not m:
                    continue
                pkt = self._handle_frame(m.group(1))
                if pkt and self._cb:
                    await self._cb({"type": "packet", "packet": pkt})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("APRS read loop error")

    def _handle_frame(self, frame: str) -> Optional[dict]:
        self.frames_total += 1
        try:
            parsed = aprslib.parse(frame)
        except Exception as exc:
            self.parse_errors += 1
            logger.debug("aprslib parse failed (%s): %s", exc, frame)
            return None

        pkt = {"ts": time.time(), "raw": frame, "from": parsed.get("from", "")}
        for k in _KEEP_KEYS:
            if parsed.get(k) not in (None, ""):
                pkt[k] = parsed[k]
        self.packets.appendleft(pkt)

        # Objects/items plot under their own name, not the sender's
        name = pkt.get("object_name") or pkt["from"]
        if name:
            st = self.stations.setdefault(name, {"callsign": name, "count": 0})
            st["count"]      += 1
            st["last_heard"]  = pkt["ts"]
            for k in ("latitude", "longitude", "altitude", "course", "speed",
                      "symbol", "symbol_table", "comment", "status",
                      "weather", "path", "format"):
                if k in pkt:
                    st[k] = pkt[k]
        return pkt


if __name__ == "__main__":
    async def demo():
        got = []
        async def cb(msg): got.append(msg)
        d = APRSDecoder(packet_callback=cb)
        pkt = d._handle_frame("N0CALL-9>APDR16,WIDE1-1:=3012.34N/09745.67W>rolling test")
        assert pkt and abs(pkt["latitude"] - 30.2057) < 0.01, pkt
        assert d.stations["N0CALL-9"]["symbol"] == ">"
        bad = d._handle_frame("N0CALL>GARBAGE:\x01\x02nonsense")
        assert bad is None and d.parse_errors == 1
        print("PASS:", d.status_dict())
    asyncio.run(demo())
