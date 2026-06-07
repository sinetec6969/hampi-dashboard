"""
meshtastic_handler.py — Async-friendly Meshtastic device interface.

Connects to a Meshtastic device via USB serial, maintains a node registry
and message log, and bridges pubsub callbacks to the asyncio event loop.

Connection strategy:
  - devPath=None  → auto-detect (scans all serial ports)
  - devPath given → use that port; retry if unavailable
  - Retries every RETRY_S seconds until a device is found
  - On disconnect, closes the interface and retries

Pubsub note: pypubsub uses a process-global registry. Subscriptions are
registered once at class level and guarded by _subscribed to survive
reconnects without duplicating callbacks.
"""

import asyncio
import logging
import time
from typing import Optional, Callable, Awaitable

logger = logging.getLogger(__name__)

try:
    import meshtastic.serial_interface
    from pubsub import pub
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False
    logger.warning("meshtastic package not installed — run: pip install meshtastic")

MAX_MESSAGES   = 200
ONLINE_TIMEOUT = 900   # 15 min in seconds
RETRY_S        = 10

PacketCb = Callable[[dict], Awaitable[None]]
StatusCb = Callable[[dict], Awaitable[None]]


def _pos_float(pos: dict, float_key: str, int_key: str) -> Optional[float]:
    """
    Extract a lat or lon from a position dict.
    Prefers the float field (_fixupPosition already ran), falls back to the
    raw integer field. Returns None only when neither is present.
    """
    v = pos.get(float_key)
    if v is not None:
        return float(v)
    raw = pos.get(int_key)
    if raw is not None:
        return raw / 1e7
    return None


def _node_from_iface(raw: dict, local_id: Optional[int] = None) -> dict:
    """Normalise an iface.nodes entry to our wire format."""
    num  = raw.get("num", 0)
    user = raw.get("user", {})
    pos  = raw.get("position", {})
    dm   = raw.get("deviceMetrics", {})
    env  = raw.get("environmentMetrics", {})
    return {
        "node_id":      user.get("id", f"!{num:08x}"),
        "num":          num,
        "long_name":    user.get("longName", ""),
        "short_name":   user.get("shortName", f"!{num:04x}"),
        "hw_model":     user.get("hwModel", ""),
        "lat":          _pos_float(pos, "latitude",  "latitudeI"),
        "lon":          _pos_float(pos, "longitude", "longitudeI"),
        "altitude":     pos.get("altitude"),
        "battery_level":dm.get("batteryLevel"),
        "voltage":      dm.get("voltage"),
        "temperature":  env.get("temperature"),
        "humidity":     env.get("relativeHumidity"),
        "snr":          raw.get("snr"),
        "rssi":         None,
        "last_heard":   raw.get("lastHeard"),
        "hops_away":    raw.get("hopsAway", 0),
        "is_local":     num == local_id,
    }


class MeshtasticHandler:
    """
    Manages one Meshtastic USB serial connection.
    Safe to call start()/stop() from an asyncio context.
    """

    _subscribed = False   # class-level guard — pubsub is a global singleton

    def __init__(
        self,
        dev_path: Optional[str] = None,
        packet_callback: Optional[PacketCb] = None,
        status_callback: Optional[StatusCb] = None,
    ):
        self._dev_path  = dev_path
        self._packet_cb = packet_callback
        self._status_cb = status_callback

        self._iface  = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._task:  Optional[asyncio.Task] = None
        self._active = False

        # Public state (read by REST endpoints)
        self.connected   = False
        self.device_path: Optional[str] = None
        self.local_id:    Optional[int]  = None
        self.nodes:    dict[str, dict] = {}
        self.messages: list[dict]      = []

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if not _AVAILABLE:
            logger.warning("MeshtasticHandler inactive — package not installed")
            return
        self._loop   = asyncio.get_running_loop()
        self._active = True
        self._task   = asyncio.create_task(
            self._connection_loop(), name="meshtastic-conn"
        )
        logger.info("MeshtasticHandler started (dev=%s)", self._dev_path or "auto")

    async def stop(self) -> None:
        self._active = False
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        await self._loop.run_in_executor(None, self._close_iface) if self._loop else self._close_iface()
        logger.info("MeshtasticHandler stopped")

    # ------------------------------------------------------------------
    # Connection loop
    # ------------------------------------------------------------------

    async def _connection_loop(self) -> None:
        while self._active:
            if not self.connected:
                try:
                    await self._loop.run_in_executor(None, self._connect_sync)
                    # Connected — idle until disconnected or stopped
                    while self._active and self.connected:
                        await asyncio.sleep(1)
                except Exception:
                    logger.warning("Meshtastic connect failed — retry in %d s",
                                   RETRY_S, exc_info=True)
                    self._close_iface()
            await asyncio.sleep(RETRY_S)

    def _connect_sync(self) -> None:
        """Blocking — runs in thread executor."""
        self._subscribe_pubsub()
        try:
            self._iface = meshtastic.serial_interface.SerialInterface(
                devPath=self._dev_path,
                connectNow=True,
                debugOut=None,
            )
        except SystemExit as exc:
            # meshtastic calls sys.exit() on ambiguous/missing port — convert so
            # the retry loop handles it instead of crashing the process.
            raise RuntimeError(f"meshtastic serial_interface exited: {exc}") from exc

    def _close_iface(self) -> None:
        if self._iface is not None:
            try:
                self._iface.close()
            except Exception:
                pass
            self._iface   = None
        self.connected    = False
        self.device_path  = None

    # ------------------------------------------------------------------
    # Pubsub subscriptions (called from background thread)
    # ------------------------------------------------------------------

    def _subscribe_pubsub(self) -> None:
        if MeshtasticHandler._subscribed:
            return
        pub.subscribe(self._cb_receive, "meshtastic.receive")
        pub.subscribe(self._cb_connect, "meshtastic.connection.established")
        pub.subscribe(self._cb_lost,    "meshtastic.connection.lost")
        MeshtasticHandler._subscribed = True

    def _schedule(self, coro) -> None:
        """Thread-safe: post an awaitable onto the event loop."""
        if self._loop:
            asyncio.run_coroutine_threadsafe(coro, self._loop)

    # Topic arg is required by pubsub but unused here
    def _cb_connect(self, interface, topic=None) -> None:
        self.connected   = True
        self.device_path = getattr(interface, "devPath", None)
        # localNode.nodeNum is the most reliable path in 2.7.x
        try:
            self.local_id = interface.localNode.nodeNum
        except Exception:
            try:
                self.local_id = interface.myInfo.my_node_num
            except Exception:
                self.local_id = None
        self._schedule(self._handle_connect(interface))

    def _cb_lost(self, interface, topic=None) -> None:
        logger.warning("Meshtastic device disconnected")
        self.connected   = False
        self.device_path = None
        self._schedule(self._handle_lost())

    def _cb_receive(self, packet, interface) -> None:
        self._schedule(self._handle_packet(packet))

    # ------------------------------------------------------------------
    # Async event handlers
    # ------------------------------------------------------------------

    async def _handle_connect(self, interface) -> None:
        logger.info("Meshtastic connected — device=%s  local_id=%s",
                    self.device_path, f"!{self.local_id:08x}" if self.local_id else None)

        # Seed registry from the device's node DB
        raw_nodes = getattr(interface, "nodes", {}) or {}
        for raw in raw_nodes.values():
            node = _node_from_iface(raw, self.local_id)
            self.nodes[node["node_id"]] = node

        await self._emit_status()
        if self._packet_cb:
            await self._packet_cb({"type": "node_list", "nodes": list(self.nodes.values())})

    async def _handle_lost(self) -> None:
        await self._emit_status()
        if self._packet_cb:
            await self._packet_cb({"type": "status", **self.status_dict()})

    async def _handle_packet(self, packet: dict) -> None:
        decoded  = packet.get("decoded", {})
        portnum  = decoded.get("portnum", "")
        from_num = packet.get("from", 0)
        node_id  = f"!{from_num:08x}"
        snr      = packet.get("rxSnr")
        rssi     = packet.get("rxRssi")
        now      = time.time()

        # Upsert node entry
        node = self.nodes.get(node_id) or {
            "node_id":      node_id,
            "num":          from_num,
            "long_name":    "",
            "short_name":   node_id[-4:],
            "hw_model":     "",
            "lat":          None,
            "lon":          None,
            "altitude":     None,
            "battery_level":None,
            "voltage":      None,
            "temperature":  None,
            "humidity":     None,
            "snr":          None,
            "rssi":         None,
            "last_heard":   None,
            "hops_away":    packet.get("hopLimit", 0),
            "is_local":     from_num == self.local_id,
        }
        node["last_heard"] = now
        if snr  is not None: node["snr"]  = snr
        if rssi is not None: node["rssi"] = rssi

        if portnum == "NODEINFO_APP":
            user = decoded.get("user", {})
            if user.get("longName"):  node["long_name"]  = user["longName"]
            if user.get("shortName"): node["short_name"] = user["shortName"]
            if user.get("hwModel"):   node["hw_model"]   = user["hwModel"]
            if user.get("id"):        node["node_id"]    = user["id"]

        elif portnum == "POSITION_APP":
            pos = decoded.get("position", {})
            lat = _pos_float(pos, "latitude",  "latitudeI")
            lon = _pos_float(pos, "longitude", "longitudeI")
            if lat is not None: node["lat"] = lat
            if lon is not None: node["lon"] = lon
            if pos.get("altitude") is not None:
                node["altitude"] = pos["altitude"]

        elif portnum == "TELEMETRY_APP":
            tel = decoded.get("telemetry", {})
            dm  = tel.get("deviceMetrics", {})
            env = tel.get("environmentMetrics", {})
            if "batteryLevel" in dm:      node["battery_level"] = dm["batteryLevel"]
            if "voltage"      in dm:      node["voltage"]       = dm["voltage"]
            if "temperature"  in env:     node["temperature"]   = env["temperature"]
            if "relativeHumidity" in env: node["humidity"]      = env["relativeHumidity"]

        elif portnum == "TEXT_MESSAGE_APP":
            text = decoded.get("text", "")
            msg  = {
                "id":         str(packet.get("id", now)),
                "timestamp":  now,
                "from_id":    node["node_id"],
                "from_short": node["short_name"],
                "from_long":  node["long_name"],
                "text":       text,
                "channel":    packet.get("channel", 0),
                "hop_limit":  packet.get("hopLimit", 0),
                "snr":        snr,
            }
            self.messages.insert(0, msg)
            if len(self.messages) > MAX_MESSAGES:
                del self.messages[MAX_MESSAGES:]
            if self._packet_cb:
                await self._packet_cb({"type": "message", "message": msg})

        self.nodes[node["node_id"]] = node
        if self._packet_cb:
            await self._packet_cb({"type": "node_update", "node": node})

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _emit_status(self) -> None:
        if self._status_cb:
            await self._status_cb(self.status_dict())

    def status_dict(self) -> dict:
        return {
            "type":       "status",
            "available":  _AVAILABLE,
            "connected":  self.connected,
            "device":     self.device_path,
            "node_count": len(self.nodes),
            "local_id":   f"!{self.local_id:08x}" if self.local_id else None,
        }

    def get_channels(self) -> list[dict]:
        """Return active channels from localNode.channels (protobuf list)."""
        if self._iface is None:
            return []
        try:
            out = []
            for ch in getattr(self._iface.localNode, "channels", []) or []:
                role = ch.role  # 0=DISABLED 1=PRIMARY 2=SECONDARY
                if role == 0:
                    continue
                name = (ch.settings.name or "").strip()
                if not name:
                    name = "Primary" if role == 1 else f"Ch {ch.index}"
                out.append({
                    "index": ch.index,
                    "name":  name,
                    "role":  "PRIMARY" if role == 1 else "SECONDARY",
                })
            return out
        except Exception:
            logger.debug("get_channels failed", exc_info=True)
            return []

    async def send_text(
        self,
        text: str,
        destination: str = "^all",
        channel: int = 0,
    ) -> None:
        """Send a text message. Runs sendText in the thread executor (blocking)."""
        if not self.connected or self._iface is None:
            raise RuntimeError("Not connected to Meshtastic device")
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            lambda: self._iface.sendText(
                text,
                destinationId=destination,
                channelIndex=channel,
            ),
        )
        logger.info("Sent text to=%s ch=%d: %r", destination, channel, text[:60])
