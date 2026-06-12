"""
ax25.py - AX.25 frame monitor fed by direwolf's KISS TCP port.

Shares the APRS-mode direwolf instance (KISSPORT 8001 in direwolf.conf):
direwolf demodulates AFSK off the SDR audio and hands raw AX.25 frames
over KISS; this module deframes and decodes them for the terminal page.

RX only — connected-mode sessions and beacon TX wait on the BTech APRS-K1
audio cable + radio (direwolf VOX PTT).
"""

import asyncio
import logging
import time
from collections import deque
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

FrameCb = Callable[[dict], Awaitable[None]]

FEND, FESC, TFEND, TFESC = 0xC0, 0xDB, 0xDC, 0xDD

_U_FRAMES = {0x03: "UI", 0x2F: "SABM", 0x6F: "SABME", 0x43: "DISC",
             0x0F: "DM", 0x63: "UA", 0x87: "FRMR", 0xAF: "XID", 0xE3: "TEST"}
_S_FRAMES = {0x01: "RR", 0x05: "RNR", 0x09: "REJ", 0x0D: "SREJ"}


def _decode_addr(b: bytes) -> tuple[str, bool, bool]:
    """7 address bytes → (CALL-SSID, repeated/H bit, last-address bit)."""
    call = bytes(x >> 1 for x in b[:6]).decode("ascii", errors="replace").strip()
    ssid = (b[6] >> 1) & 0x0F
    return (f"{call}-{ssid}" if ssid else call), bool(b[6] & 0x80), bool(b[6] & 0x01)


def decode_ax25(raw: bytes) -> Optional[dict]:
    """Decode one raw AX.25 frame (no KISS framing, no FCS) to a dict."""
    if len(raw) < 15:
        return None
    dst, _, _ = _decode_addr(raw[0:7])
    src, _, last = _decode_addr(raw[7:14])
    via, pos = [], 14
    while not last and pos + 7 <= len(raw) and len(via) < 8:
        call, rpt, last = _decode_addr(raw[pos:pos + 7])
        via.append(call + ("*" if rpt else ""))
        pos += 7
    if pos >= len(raw):
        return None

    ctrl = raw[pos]
    pos += 1
    pid: Optional[int] = None
    if ctrl & 0x01 == 0:
        ftype = f"I ns={(ctrl >> 1) & 7} nr={(ctrl >> 5) & 7}"
        has_pid = True
    elif ctrl & 0x03 == 0x01:
        ftype = f"{_S_FRAMES.get(ctrl & 0x0F, 'S?')} nr={(ctrl >> 5) & 7}"
        has_pid = False
    else:
        ftype = _U_FRAMES.get(ctrl & ~0x10, f"U?{ctrl:02X}")
        has_pid = ftype == "UI"
    if has_pid and pos < len(raw):
        pid = raw[pos]
        pos += 1

    info = raw[pos:]
    return {
        "ts":   time.time(),
        "src":  src,
        "dst":  dst,
        "via":  via,
        "type": ftype,
        "pid":  f"{pid:02X}" if pid is not None else None,
        "info": info.decode("ascii", errors="replace"),
        "hex":  info.hex(),
        "len":  len(raw),
    }


class AX25Decoder:
    """KISS TCP client on the shared direwolf instance."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8001,
        max_frames: int = 500,
        frame_callback: Optional[FrameCb] = None,
    ):
        self.host, self.port = host, port
        self._cb = frame_callback
        self.frames: deque[dict]     = deque(maxlen=max_frames)
        self.heard:  dict[str, dict] = {}
        self.frames_total = 0
        self.connected    = False
        self._task: Optional[asyncio.Task] = None
        self._active = False

    async def start(self) -> None:
        self._active = True
        self._task = asyncio.create_task(self._client_loop(), name="ax25-kiss")
        logger.info("AX25Decoder started — KISS %s:%d", self.host, self.port)

    async def stop(self) -> None:
        self._active = False
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        self.connected = False
        logger.info("AX25Decoder stopped")

    def status_dict(self) -> dict:
        return {
            "type":      "status",
            "connected": self.connected,
            "frames":    self.frames_total,
            "heard":     len(self.heard),
        }

    # ------------------------------------------------------------------

    async def _client_loop(self) -> None:
        # direwolf opens KISSPORT shortly after launch — retry until it's up
        try:
            while self._active:
                try:
                    reader, _ = await asyncio.open_connection(self.host, self.port)
                    self.connected = True
                    logger.info("KISS connected to %s:%d", self.host, self.port)
                    await self._read_kiss(reader)
                except asyncio.CancelledError:
                    raise
                except OSError:
                    pass
                self.connected = False
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            raise

    async def _read_kiss(self, reader: asyncio.StreamReader) -> None:
        buf = bytearray()
        while self._active:
            chunk = await reader.read(4096)
            if not chunk:
                logger.warning("KISS connection closed")
                return
            buf.extend(chunk)
            while True:
                try:
                    start = buf.index(FEND)
                    end   = buf.index(FEND, start + 1)
                except ValueError:
                    break
                frame = bytes(buf[start + 1:end])
                del buf[:end]   # keep trailing FEND as next frame's start
                if len(frame) > 1 and frame[0] & 0x0F == 0x00:  # data, port 0
                    await self._handle(self._unescape(frame[1:]))

    @staticmethod
    def _unescape(data: bytes) -> bytes:
        out, i = bytearray(), 0
        while i < len(data):
            if data[i] == FESC and i + 1 < len(data):
                out.append(FEND if data[i + 1] == TFEND else FESC)
                i += 2
            else:
                out.append(data[i])
                i += 1
        return bytes(out)

    async def _handle(self, raw: bytes) -> None:
        frame = decode_ax25(raw)
        if frame is None:
            return
        self.frames_total += 1
        self.frames.appendleft(frame)
        st = self.heard.setdefault(frame["src"], {"callsign": frame["src"], "count": 0})
        st["count"]     += 1
        st["last_heard"] = frame["ts"]
        st["last_type"]  = frame["type"]
        if self._cb:
            await self._cb({"type": "frame", "frame": frame})


if __name__ == "__main__":
    def _enc(call: str, ssid: int, last: bool = False, rpt: bool = False) -> bytes:
        b = bytearray((ord(c) << 1) for c in f"{call:<6}")
        b.append((ssid << 1) | 0x60 | (0x01 if last else 0) | (0x80 if rpt else 0))
        return bytes(b)

    raw = _enc("APRS", 0) + _enc("W5TEST", 9) + _enc("WIDE1", 1, last=True, rpt=True) \
        + bytes([0x03, 0xF0]) + b"!3012.40N/09745.60W>hello"
    f = decode_ax25(raw)
    assert f and f["src"] == "W5TEST-9" and f["dst"] == "APRS", f
    assert f["via"] == ["WIDE1-1*"] and f["type"] == "UI" and f["pid"] == "F0", f
    assert f["info"].startswith("!3012.40N"), f
    rr = decode_ax25(_enc("W5A", 0) + _enc("W5B", 0, last=True) + bytes([0x21]))
    assert rr and rr["type"].startswith("RR nr=1"), rr
    print("PASS:", f["src"], ">", f["dst"], f["via"], f["type"], f["info"][:20])
