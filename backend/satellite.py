"""
satellite.py - TinyGS satellite packet receiver via local MQTT broker.

The TinyGS board connects to Mosquitto on the Pi and publishes received
satellite packets to tinygs/{user}/{station}/tele/rx as JSON. This module
subscribes to tinygs/# and forwards events to the FastAPI WebSocket layer.
"""
import asyncio
import json
import logging
import threading
import time
from collections import deque
from typing import Awaitable, Callable, Optional

import paho.mqtt.client as mqtt

logger = logging.getLogger(__name__)

MAX_PACKETS = 100
RECONNECT_DELAY = 5


class SatelliteMonitor:
    def __init__(
        self,
        mqtt_host: str = "localhost",
        mqtt_port: int = 1883,
        packet_callback: Optional[Callable[..., Awaitable]] = None,
        status_callback: Optional[Callable[..., Awaitable]] = None,
    ):
        self._host = mqtt_host
        self._port = mqtt_port
        self._packet_cb = packet_callback
        self._status_cb = status_callback

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client: Optional[mqtt.Client] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self._packets: deque = deque(maxlen=MAX_PACKETS)
        self._station: dict = {}
        self.mqtt_connected: bool = False

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._running = True
        self._thread = threading.Thread(
            target=self._mqtt_thread, daemon=True, name="satellite-mqtt"
        )
        self._thread.start()
        logger.info("SatelliteMonitor starting — broker %s:%d", self._host, self._port)

    async def stop(self) -> None:
        self._running = False
        if self._client:
            try:
                self._client.disconnect()
                self._client.loop_stop()
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        logger.info("SatelliteMonitor stopped")

    def get_status(self) -> dict:
        return {
            "mqtt_connected": self.mqtt_connected,
            "station": self._station,
            "packet_count": len(self._packets),
        }

    def get_packets(self) -> list:
        return list(reversed(self._packets))

    # ── MQTT thread ────────────────────────────────────────────────────────────

    def _mqtt_thread(self) -> None:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        client.on_connect    = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message    = self._on_message
        self._client = client

        while self._running:
            try:
                client.connect(self._host, self._port, keepalive=60)
                client.loop_forever(retry_first_connection=True)
            except Exception as exc:
                logger.warning("MQTT connect failed (%s), retry in %ds", exc, RECONNECT_DELAY)
                if self._running:
                    time.sleep(RECONNECT_DELAY)

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if not reason_code.is_failure:
            self.mqtt_connected = True
            client.subscribe("tinygs/#")
            logger.info("MQTT connected, subscribed tinygs/#")
            self._fire(self._status_cb({"type": "mqtt_connected"}))
        else:
            logger.warning("MQTT connect refused rc=%s", reason_code)

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties) -> None:
        self.mqtt_connected = False
        logger.info("MQTT disconnected rc=%s", reason_code)
        self._fire(self._status_cb({"type": "mqtt_disconnected"}))

    def _on_message(self, client, userdata, msg) -> None:
        parts = msg.topic.split("/")
        # tinygs / {user} / {station} / {tele|stat} / {cmnd}
        if len(parts) < 5:
            return
        kind, command = parts[3], parts[4]

        try:
            payload = json.loads(msg.payload.decode())
        except Exception:
            return

        if kind == "tele" and command == "rx":
            self._handle_rx(payload)
        elif kind == "tele" and command in ("ping", "welcome"):
            self._handle_ping(payload)
        elif kind == "stat" and command == "status":
            self._handle_station_status(payload)

    # ── Handlers ───────────────────────────────────────────────────────────────

    def _handle_rx(self, p: dict) -> None:
        packet = {
            "time":            p.get("unix_GS_time", 0),
            "satellite":       p.get("satellite", "unknown"),
            "norad":           p.get("NORAD", 0),
            "mode":            p.get("mode", "LoRa"),
            "frequency":       p.get("frequency", 0),
            "frequency_error": p.get("frequency_error", 0),
            "f_doppler":       p.get("f_doppler", 0),
            "rssi":            p.get("rssi", 0),
            "snr":             p.get("snr", 0),
            "crc_error":       p.get("crc_error", False),
            "noisy":           p.get("noisy", False),
            "data":            p.get("data", ""),
            "data_raw":        p.get("data_raw", ""),
            "sf":              p.get("sf"),
            "cr":              p.get("cr"),
            "bw":              p.get("bw"),
            "bitrate":         p.get("bitrate"),
            "freqdev":         p.get("freqdev"),
        }
        self._packets.append(packet)
        logger.info("Sat packet: %s  rssi=%.1f snr=%.1f crc_err=%s",
                    packet["satellite"], packet["rssi"], packet["snr"], packet["crc_error"])
        self._fire(self._packet_cb({"type": "packet", **packet}))

    def _handle_ping(self, p: dict) -> None:
        self._station.update({
            "vbat":      p.get("Vbat"),
            "mem":       p.get("Mem"),
            "wifi_rssi": p.get("RSSI"),
            "radio_err": p.get("radio", 0),
            "inst_rssi": p.get("InstRSSI"),
        })
        self._fire(self._status_cb({"type": "ping", **self._station}))

    def _handle_station_status(self, p: dict) -> None:
        self._station.update({
            "satellite":  p.get("sat"),
            "modem_conf": p.get("modem_conf"),
            "board":      p.get("board"),
            "version":    p.get("version"),
            "ip":         p.get("ip"),
            "seconds":    p.get("seconds"),
        })
        self._fire(self._status_cb({"type": "station_status", **self._station}))

    def _fire(self, coro) -> None:
        if self._loop and coro is not None:
            self._loop.call_soon_threadsafe(self._loop.create_task, coro)
