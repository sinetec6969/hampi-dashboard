"""
main.py - FastAPI application for the HamPi SDR dashboard.

WebSocket endpoints:
  /ws/waterfall  — binary float32 FFT frames
  /ws/dmr        — JSON DMR metadata

REST endpoints:
  GET  /api/status
  POST /api/tune?freq=<hz>&gain=<db>

Static frontend served at "/" from ../frontend/dist/
"""

import asyncio
import json
import logging
import os
import socket
import sqlite3
import subprocess
import time
from contextlib import asynccontextmanager
from typing import Optional, Set

import httpx
import numpy as np
import yaml
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.websockets import WebSocketState

from adsb import ADSBDecoder
from airband import AirbandScanner, DEFAULT_CHANNELS
from aprs import APRSDecoder
from ax25 import AX25Decoder
from radio import RadioInterface
from satpredict import SatTracker
from meteor import MeteorDecoder
from sdrtrunk import TrunkMonitor
from dmr import DMRDecoder
from meshtastic_handler import MeshtasticHandler
from sdr import SDREngine
from sstv import SSTVDecoder
from satellite import SatelliteMonitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# RadioID.net lookup cache: dmr_id → (expire_ts, result_dict)
_lookup_cache: dict[int, tuple[float, dict]] = {}
LOOKUP_TTL = 3600.0   # cache entries for 1 hour

# Geocoding cache: "city|state" → (lat, lon) | None — permanent, cities don't move
_geo_cache: dict[str, tuple[float, float] | None] = {}

# config.yaml (repo root) is the primary config; env vars override it.
_CONFIG_PATH = os.getenv("CONFIG", os.path.join(os.path.dirname(__file__), "..", "config.yaml"))
try:
    with open(_CONFIG_PATH) as _f:
        _CFG: dict = yaml.safe_load(_f) or {}
    logger.info("Loaded config from %s", _CONFIG_PATH)
except FileNotFoundError:
    _CFG = {}


def cfg(path: str, default):
    cur = _CFG
    for key in path.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def cfg_bool(env: str, path: str, default: int) -> bool:
    return str(os.getenv(env, cfg(path, default))).lower() in ("1", "true")


INITIAL_FREQ:   int   = int(os.getenv("SDR_FREQ",        cfg("sdr.freq", 438800000)))
INITIAL_GAIN:   float = float(os.getenv("SDR_GAIN",      cfg("sdr.gain", 49.6)))
SAMPLE_RATE:    int   = int(os.getenv("SDR_SAMPLE_RATE", cfg("sdr.sample_rate", 2400000)))
CHUNK_SIZE:     int   = int(os.getenv("SDR_CHUNK_SIZE",  cfg("sdr.chunk_size", 131072)))
FFT_PER_CHUNK:  int   = 4   # waterfall lines emitted per IQ read
N_FFT:          int   = 1024
# rtl_device values may be an index (0) or an EEPROM serial string ("HAMPI0") —
# rtl_tcp/rtl_adsb resolve both via verbose_device_search. Serials must be
# non-numeric: a numeric string parses as an index first.
SDR_RTL_DEV: int | str = os.getenv("SDR_RTL_DEV", cfg("sdr.rtl_device", 0))
SERVER_PORT:    int   = int(os.getenv("PORT", cfg("server.port", 8000)))
FRONTEND_DIST:  str   = os.getenv("FRONTEND_DIST", cfg("server.frontend_dist", "../frontend/dist"))
HISTORY_FILE:   str   = os.getenv("HISTORY_FILE", cfg("server.history_file",
                                   os.path.join(os.path.dirname(__file__), "..", "call_history.json")))
MAX_HISTORY:    int   = 200

# Meshtastic configuration
MESH_ENABLE: bool          = cfg_bool("MESH_ENABLE", "meshtastic.enable", 1)
MESH_PORT:   Optional[str] = os.getenv("MESH_PORT", cfg("meshtastic.port", None))  # None = auto-detect

# Airband configuration
AIRBAND_ENABLE:  bool  = cfg_bool("AIRBAND_ENABLE", "airband.enable", 1)
AIRBAND_RTL_DEV: int | str = os.getenv("AIRBAND_RTL_DEV", cfg("airband.rtl_device", 1))
AIRBAND_RTL_PORT:int   = int(os.getenv("AIRBAND_RTL_PORT", cfg("airband.rtl_port", 1235)))
AIRBAND_GAIN:    float = float(os.getenv("AIRBAND_GAIN",   cfg("airband.gain", 40.0)))
AIRBAND_SQUELCH: float = float(os.getenv("AIRBAND_SQUELCH",cfg("airband.squelch", 0.01)))
AIRBAND_DWELL:   int   = int(os.getenv("AIRBAND_DWELL_MS", cfg("airband.dwell_ms", 2000)))
AIRBAND_CHANNELS: list[dict] = cfg("airband.frequencies", DEFAULT_CHANNELS)

# ADS-B configuration
ADSB_ENABLE:  bool  = cfg_bool("ADSB_ENABLE", "adsb.enable", 0)
ADSB_RTL_DEV: int | str = os.getenv("ADSB_RTL_DEV", cfg("adsb.rtl_device", 2))
ADSB_GAIN:    float = float(os.getenv("ADSB_GAIN",   cfg("adsb.gain", -1)))    # negative = auto
ADSB_LAT:     float = float(os.getenv("ADSB_LAT",    cfg("adsb.lat_ref", 0.0)))  # reference for CPR fallback
ADSB_LON:     float = float(os.getenv("ADSB_LON",    cfg("adsb.lon_ref", 0.0)))

# SSTV configuration
SSTV_FREQ:      int   = int(os.getenv("SSTV_FREQ",   cfg("sstv.freq", 145800000)))
SSTV_GAIN:      float = float(os.getenv("SSTV_GAIN", cfg("sstv.gain", 40.0)))
SSTV_IMAGE_DIR: str   = os.getenv("SSTV_IMAGE_DIR", cfg("sstv.image_dir",
    os.path.join(os.path.dirname(__file__), "..", "sstv_images"),
))

# APRS configuration
APRS_FREQ: int   = int(os.getenv("APRS_FREQ",   cfg("aprs.freq", 144390000)))
APRS_GAIN: float = float(os.getenv("APRS_GAIN", cfg("aprs.gain", 49.6)))

# QTH + SSTV satellite tracking (Maidenhead grid; sat list optional override)
QTH_GRID:  str = os.getenv("QTH_GRID", cfg("qth.grid", "EM95of"))
SSTV_SATS: Optional[list] = cfg("sstv_satellites", None)

# METEOR LRPT (SatDump subprocess on device 0)
METEOR_FREQ:     int   = int(os.getenv("METEOR_FREQ", cfg("meteor.freq", 137900000)))
METEOR_GAIN:     float = float(os.getenv("METEOR_GAIN", cfg("meteor.gain", 42.0)))
METEOR_SR:       int   = int(os.getenv("METEOR_SAMPLERATE", cfg("meteor.samplerate", 1000000)))
METEOR_PIPELINE: str   = os.getenv("METEOR_PIPELINE", cfg("meteor.pipeline", "meteor_m2_lrpt"))
METEOR_IMAGE_DIR: str  = os.getenv("METEOR_IMAGE_DIR", cfg("meteor.image_dir",
    os.path.join(os.path.dirname(__file__), "..", "meteor_images")))

# SDRTrunk trunked-DMR (Connect Plus) monitor — runs as the `sdrtrunk` systemd
# user service; this mode just starts/stops it so the dashboard owns the dongle.
TRUNK_APP_DIR:  str = os.getenv("TRUNK_APP_DIR", cfg("trunk.app_dir",
    os.path.join(os.path.expanduser("~"), "SDRTrunk")))
TRUNK_SERVICE:  str = os.getenv("TRUNK_SERVICE", cfg("trunk.service", "sdrtrunk"))
TRUNK_PLAYLIST: str = os.getenv("TRUNK_PLAYLIST", cfg("trunk.playlist", "~/SDRTrunk/playlist/default.xml"))
TRUNK_SYSTEMS:  list = cfg("trunk.systems", [])   # each: name, site, protocol, color_code, control[], voice[]
TRUNK_ACTIVE:   str = os.getenv("TRUNK_SYSTEM", cfg("trunk.active",
    TRUNK_SYSTEMS[0]["name"] if TRUNK_SYSTEMS else ""))
TRUNK_VNC_URL:  str = os.getenv("TRUNK_VNC_URL",  cfg("trunk.vnc_url", ""))


def _trunk_sys(name: str) -> dict:
    return next((s for s in TRUNK_SYSTEMS if s["name"] == name),
                TRUNK_SYSTEMS[0] if TRUNK_SYSTEMS else {})

# City→coords geocoding for the DMR caller map hits nominatim.openstreetmap.org —
# who you're hearing leaves the LAN. Off unless explicitly enabled.
GEOCODE_ENABLE: bool = cfg_bool("GEOCODE_ENABLE", "geocode.enable", 0)

# DMR talkgroup names: Brandmeister list (talkgroups_bm.json — refresh from
# api.brandmeister.network/v2/talkgroup/) as the base, config.yaml `talkgroups:`
# overrides on top.
_BM_TG_PATH = os.path.join(os.path.dirname(__file__), "..", "talkgroups_bm.json")
try:
    with open(_BM_TG_PATH) as _f:
        TALKGROUPS: dict[int, str] = {int(k): v for k, v in json.load(_f).items() if v}
    logger.info("Loaded %d Brandmeister talkgroups", len(TALKGROUPS))
except FileNotFoundError:
    TALKGROUPS = {}
TALKGROUPS.update({int(k): str(v) for k, v in (cfg("talkgroups", None) or {}).items()})

_RADIOID_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "radioid.db")
_radioid_db: Optional[sqlite3.Connection] = None
if os.path.isfile(_RADIOID_DB_PATH):
    _radioid_db = sqlite3.connect(_RADIOID_DB_PATH, check_same_thread=False)

# Satellite / TinyGS configuration
SAT_ENABLE:  bool = cfg_bool("SAT_ENABLE", "satellite.enable", 1)
MQTT_HOST:   str  = os.getenv("MQTT_HOST",  cfg("satellite.mqtt_host", "localhost"))
MQTT_PORT:   int  = int(os.getenv("MQTT_PORT", cfg("satellite.mqtt_port", 1883)))

# Station identity + radio TX (Phase A — Digirig). TX is hard-gated off by default.
STATION:     dict = cfg("station", None) or {}
TX_ENABLE:   bool = cfg_bool("TX_ENABLE", "radio.tx_enable", 0)
RADIO_SERIAL: str = os.getenv("RADIO_SERIAL", cfg("radio.serial", "/dev/digirig"))
RADIO_AUDIO:  str = os.getenv("RADIO_AUDIO",  cfg("radio.audio", "hw:CARD=Device"))

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
sdr:     SDREngine
decoder: DMRDecoder
airband:       Optional[AirbandScanner]   = None
meshtastic:    Optional[MeshtasticHandler] = None
adsb_decoder:  Optional[ADSBDecoder]      = None  # dedicated-dongle ADS-B
_mode_airband: Optional[AirbandScanner]   = None  # mode-switched airband on device 0
_mode_adsb:    Optional[ADSBDecoder]      = None  # mode-switched ADS-B on device 0
active_sdr_mode: str                      = "dmr"
active_trunk_system: str                  = TRUNK_ACTIVE
sdr_task: Optional[asyncio.Task]          = None
_mode_lock = asyncio.Lock()  # serializes /api/sdr/mode — device 0 has one owner

waterfall_clients:  Set[WebSocket] = set()
dmr_clients:        Set[WebSocket] = set()
dmr_audio_clients:  Set[WebSocket] = set()
airband_clients:    Set[WebSocket] = set()
meshtastic_clients: Set[WebSocket] = set()
adsb_clients:       Set[WebSocket] = set()
sstv_clients:       Set[WebSocket] = set()
satellite_clients:  Set[WebSocket] = set()
aprs_clients:       Set[WebSocket] = set()
ax25_clients:       Set[WebSocket] = set()
meteor_clients:     Set[WebSocket] = set()
trunk_clients:      Set[WebSocket] = set()

_mode_sstv: Optional[SSTVDecoder] = None
_mode_aprs: Optional[APRSDecoder] = None
_mode_ax25: Optional[AX25Decoder] = None  # rides along with aprs mode (shared direwolf)
_mode_meteor: Optional[MeteorDecoder] = None  # SatDump owns device 0 directly
_mode_trunk:  Optional[TrunkMonitor]  = None  # SDRTrunk service owns device 0
satellite_monitor: Optional[SatelliteMonitor] = None
radio: Optional[RadioInterface] = None
sat_tracker: Optional[SatTracker] = None

# Last-known airband status — returned by /api/airband/status
airband_status: dict = {
    "enabled":      False,
    "active_idx":   0,
    "channel":      None,
    "squelch_open": False,
    "scanner_on":   True,
    "squelch":      AIRBAND_SQUELCH,
    "dwell_ms":     AIRBAND_DWELL,
    "channels":     AIRBAND_CHANNELS,
}

call_history: list[dict] = []


def _load_history() -> list[dict]:
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_history() -> None:
    try:
        with open(HISTORY_FILE, "w") as f:
            json.dump(call_history, f)
    except Exception:
        logger.exception("Failed to save call history")

# ---------------------------------------------------------------------------
# Broadcast helpers
# ---------------------------------------------------------------------------

# A client that can't take a frame in 500 ms is dead for a realtime stream —
# evict it rather than let its TCP backpressure stall the SDR loop (pages
# auto-reconnect).
SEND_TIMEOUT = 0.5


async def broadcast_bytes(clients: Set[WebSocket], data: bytes) -> None:
    """Send binary data to all connected clients; evict dead/stalled connections."""
    dead: Set[WebSocket] = set()
    for ws in list(clients):
        try:
            if ws.client_state == WebSocketState.CONNECTED:
                await asyncio.wait_for(ws.send_bytes(data), SEND_TIMEOUT)
            else:
                dead.add(ws)
        except Exception:
            dead.add(ws)
    clients -= dead


async def broadcast_json(clients: Set[WebSocket], payload: dict) -> None:
    """Send a JSON message to all connected clients; evict dead/stalled connections."""
    text = json.dumps(payload)
    dead: Set[WebSocket] = set()
    for ws in list(clients):
        try:
            if ws.client_state == WebSocketState.CONNECTED:
                await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT)
            else:
                dead.add(ws)
        except Exception:
            dead.add(ws)
    clients -= dead


# ---------------------------------------------------------------------------
# Airband callbacks
# ---------------------------------------------------------------------------

async def on_airband_audio(pcm: bytes) -> None:
    await broadcast_bytes(airband_clients, pcm)


# TEMP instrumentation (Part 1A diagnosis) — remove after audio fix
_dmr_ws_stat = {"n": 0, "tot": 0.0, "max": 0.0, "t0": 0.0}

async def on_dmr_audio(pcm: bytes) -> None:
    t0 = time.monotonic()
    await broadcast_bytes(dmr_audio_clients, pcm)
    dt = time.monotonic() - t0
    s = _dmr_ws_stat
    s["n"] += 1
    s["tot"] += dt
    s["max"] = max(s["max"], dt)
    if t0 - s["t0"] >= 10:
        if s["t0"] and dmr_audio_clients:
            logger.info("DMR WS send: %d msgs, avg=%.2fms max=%.2fms, clients=%d",
                        s["n"], s["tot"] / s["n"] * 1e3, s["max"] * 1e3,
                        len(dmr_audio_clients))
        s["n"], s["tot"], s["max"], s["t0"] = 0, 0.0, 0.0, t0


async def on_airband_status(status: dict) -> None:
    airband_status.update(status)
    await broadcast_json(airband_clients, status)


# ---------------------------------------------------------------------------
# Meshtastic callbacks
# ---------------------------------------------------------------------------

async def on_mesh_packet(packet: dict) -> None:
    await broadcast_json(meshtastic_clients, packet)


async def on_mesh_status(status: dict) -> None:
    await broadcast_json(meshtastic_clients, status)


# ---------------------------------------------------------------------------
# ADS-B callback
# ---------------------------------------------------------------------------

async def on_adsb_aircraft(payload: dict) -> None:
    await broadcast_json(adsb_clients, payload)


# ---------------------------------------------------------------------------
# SSTV callbacks
# ---------------------------------------------------------------------------

async def on_sstv_line(y: int, r: list, g: list, b: list) -> None:
    await broadcast_json(sstv_clients, {"type": "line", "y": y, "r": r, "g": g, "b": b})


async def on_sstv_image(filename: str, mode_name: str) -> None:
    await broadcast_json(sstv_clients, {"type": "image_complete", "filename": filename, "mode": mode_name})


async def on_sstv_status(status: dict) -> None:
    await broadcast_json(sstv_clients, status)


# ---------------------------------------------------------------------------
# Satellite callbacks
# ---------------------------------------------------------------------------

async def on_satellite_packet(packet: dict) -> None:
    await broadcast_json(satellite_clients, packet)


async def on_satellite_status(status: dict) -> None:
    await broadcast_json(satellite_clients, status)


async def on_meteor_status(msg: dict) -> None:
    await broadcast_json(meteor_clients, msg)


async def on_meteor_image(msg: dict) -> None:
    await broadcast_json(meteor_clients, msg)


async def on_trunk_status(msg: dict) -> None:
    await broadcast_json(trunk_clients, msg)


async def on_trunk_event(msg: dict) -> None:
    await broadcast_json(trunk_clients, msg)


async def on_aprs_packet(msg: dict) -> None:
    await broadcast_json(aprs_clients, msg)


async def on_ax25_frame(msg: dict) -> None:
    await broadcast_json(ax25_clients, msg)


async def aprs_loop() -> None:
    loop = asyncio.get_running_loop()
    logger.info("APRS loop started — freq=%d Hz", sdr.freq)
    step = CHUNK_SIZE // FFT_PER_CHUNK
    try:
        while True:
            try:
                iq = await loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)
                for k in range(FFT_PER_CHUNK):
                    fft_bins = sdr.compute_fft(iq[k * step:], n_fft=N_FFT)
                    await broadcast_bytes(waterfall_clients, fft_bins.tobytes())
                # demod at sdr.freq so /api/tune retunes the decoder too
                pcm = await loop.run_in_executor(None, sdr.fm_demodulate, iq, sdr.freq)
                if _mode_aprs:
                    await _mode_aprs.write_audio(pcm)
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("APRS loop error — retrying in 3 s")
                await asyncio.sleep(3)
                try:
                    sdr.stop()
                    await loop.run_in_executor(None, sdr.start)
                except Exception:
                    logger.exception("APRS SDR reconnect failed")
    except asyncio.CancelledError:
        logger.info("APRS loop cancelled")


async def sstv_loop() -> None:
    loop = asyncio.get_running_loop()
    logger.info("SSTV loop started — freq=%d Hz", SSTV_FREQ)
    target = SSTV_FREQ
    last_dop = 0.0
    try:
        while True:
            try:
                iq  = await loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)
                # If a satellite is tracked, follow its Doppler-shifted downlink
                # (SDR centre is retuned to the downlink on selection). Recompute
                # once a second — the shift drifts slowly relative to the chunk rate.
                now = time.time()
                if sat_tracker is not None and sat_tracker.tracked is not None:
                    if now - last_dop > 1.0:
                        rx = await loop.run_in_executor(None, sat_tracker.tracked_rx_freq)
                        if rx:
                            target = rx
                        last_dop = now
                else:
                    target = SSTV_FREQ
                pcm = await loop.run_in_executor(None, sdr.fm_demodulate, iq, target)
                if _mode_sstv:
                    await _mode_sstv.write_audio(pcm)
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("SSTV loop error — retrying in 3 s")
                await asyncio.sleep(3)
                try:
                    sdr.stop()
                    await loop.run_in_executor(None, sdr.start)
                except Exception:
                    logger.exception("SSTV SDR reconnect failed")
    except asyncio.CancelledError:
        logger.info("SSTV loop cancelled")


# ---------------------------------------------------------------------------
# DMR callbacks (called from DMRDecoder background tasks)
# ---------------------------------------------------------------------------

async def on_meta(frame_dict: dict) -> None:
    frame_dict["tg_name"] = TALKGROUPS.get(frame_dict.get("dst_id", 0), "")
    await broadcast_json(dmr_clients, frame_dict)


async def on_call_end(record: dict) -> None:
    record["tg_name"] = TALKGROUPS.get(record.get("dst_id", 0), "")
    src_id = record.get("src_id", 0)
    if src_id:
        try:
            info = await _lookup_dmr_id(src_id)
            record["callsign"] = info.get("callsign", "")
            record["name"]     = info.get("name", "")
            record["city"]     = info.get("city", "")
            record["state"]    = info.get("state", "")
        except Exception:
            record["callsign"] = record["name"] = record["city"] = record["state"] = ""
    else:
        record["callsign"] = record["name"] = record["city"] = record["state"] = ""
    call_history.insert(0, record)
    if len(call_history) > MAX_HISTORY:
        del call_history[MAX_HISTORY:]
    _save_history()
    await broadcast_json(dmr_clients, {"type": "call_record", **record})
    logger.info("Call logged: src=%s tg=%s dur=%.1fs", record["src_id"], record["dst_id"], record["duration_s"])


# ---------------------------------------------------------------------------
# SDR acquisition loop
# ---------------------------------------------------------------------------

async def sdr_loop() -> None:
    """
    Pipelined SDR loop: read_iq and fm_demodulate run concurrently in the
    thread-pool executor so audio is written to dsd-fme at real-time rate.

    Timeline per iteration (read ≈ 54 ms, demod ≈ 46 ms):
      [read N+1 ──────────────────54ms──]
      [        demod N ──46ms──] [write]
      total wall time ≈ 54 ms  (not 54+46=100 ms as in the sequential version)
    """
    loop = asyncio.get_running_loop()
    logger.info("SDR loop started — freq=%d Hz, gain=%.1f dB", sdr.freq, sdr.gain)
    step        = CHUNK_SIZE // FFT_PER_CHUNK
    read_future = None
    # TEMP instrumentation (Part 1A): per-stage wall time, expect iter ≈ 54.6 ms
    st = {"read": 0.0, "fft": 0.0, "demod": 0.0, "write": 0.0,
          "iter_max": 0.0, "n": 0, "t0": time.monotonic()}
    try:
        while True:
            try:
                t_iter = time.monotonic()
                # First pass or after reconnect: no read in flight yet — block once.
                if read_future is None:
                    iq = await loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)
                else:
                    iq = await read_future
                t1 = time.monotonic()

                # Kick off the next read immediately so it runs while we demodulate.
                read_future = loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)

                # Waterfall: spread FFT_PER_CHUNK slices across the chunk.
                for k in range(FFT_PER_CHUNK):
                    fft_bins = sdr.compute_fft(iq[k * step:], n_fft=N_FFT)
                    await broadcast_bytes(waterfall_clients, fft_bins.tobytes())
                t2 = time.monotonic()

                # Demodulate current chunk (runs concurrently with read_future).
                pcm = await loop.run_in_executor(None, sdr.fm_demodulate, iq, sdr.freq)
                t3 = time.monotonic()
                await decoder.write_audio(pcm)
                t4 = time.monotonic()
                await asyncio.sleep(0)

                st["read"]  += t1 - t_iter
                st["fft"]   += t2 - t1
                st["demod"] += t3 - t2
                st["write"] += t4 - t3
                st["iter_max"] = max(st["iter_max"], t4 - t_iter)
                st["n"] += 1
                if t4 - st["t0"] >= 10:
                    n = st["n"]
                    logger.info(
                        "SDR loop: %d iters, avg ms read=%.1f fft+wf=%.1f demod=%.1f "
                        "write=%.1f | iter avg=%.1f max=%.1f (real-time=54.6)",
                        n, st["read"]/n*1e3, st["fft"]/n*1e3, st["demod"]/n*1e3,
                        st["write"]/n*1e3, (st["read"]+st["fft"]+st["demod"]+st["write"])/n*1e3,
                        st["iter_max"]*1e3)
                    st.update(read=0.0, fft=0.0, demod=0.0, write=0.0,
                              iter_max=0.0, n=0, t0=t4)

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("SDR loop error — reconnecting in 3 s")
                if read_future is not None:
                    read_future.cancel()
                    read_future = None
                await asyncio.sleep(3)
                try:
                    sdr.stop()
                    await loop.run_in_executor(None, sdr.start)
                    logger.info("SDR reconnected")
                except Exception:
                    logger.exception("SDR reconnect failed — will retry")
    except asyncio.CancelledError:
        logger.info("SDR loop cancelled")


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global sdr, decoder, airband, meshtastic, adsb_decoder, sdr_task, satellite_monitor, radio, sat_tracker

    # Load persisted call history
    call_history.extend(_load_history())
    logger.info("Call history loaded: %d entries", len(call_history))

    # Initialise SDR engine
    sdr = SDREngine(
        freq=INITIAL_FREQ,
        sample_rate=SAMPLE_RATE,
        gain=INITIAL_GAIN,
        device_index=SDR_RTL_DEV,
    )

    # Initialise DMR decoder
    decoder = DMRDecoder(
        meta_callback=on_meta,
        call_end_callback=on_call_end,
        audio_callback=on_dmr_audio,
    )

    # Start hardware (blocking calls wrapped)
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sdr.start)
    await decoder.start()

    # Launch SDR acquisition loop
    sdr_task = asyncio.create_task(sdr_loop(), name="sdr-loop")

    # Start airband scanner (optional — graceful on failure)
    if AIRBAND_ENABLE:
        try:
            airband = AirbandScanner(
                channels=AIRBAND_CHANNELS,
                squelch=AIRBAND_SQUELCH,
                dwell_ms=AIRBAND_DWELL,
                gain=AIRBAND_GAIN,
                rtl_device=AIRBAND_RTL_DEV,
                rtl_port=AIRBAND_RTL_PORT,
                audio_callback=on_airband_audio,
                status_callback=on_airband_status,
            )
            await airband.start()
            airband_status["enabled"]  = True
            airband_status["channels"] = AIRBAND_CHANNELS
            logger.info("AirbandScanner started on device=%s port=%d",
                        AIRBAND_RTL_DEV, AIRBAND_RTL_PORT)
        except Exception:
            logger.warning("AirbandScanner failed to start — airband disabled",
                           exc_info=True)
            airband = None

    # Start dedicated ADS-B decoder (optional — needs its own dongle)
    if ADSB_ENABLE:
        try:
            adsb_decoder = ADSBDecoder(
                device_index=ADSB_RTL_DEV,
                gain=ADSB_GAIN,
                lat_ref=ADSB_LAT,
                lon_ref=ADSB_LON,
                aircraft_callback=on_adsb_aircraft,
            )
            await adsb_decoder.start()
            logger.info("ADSBDecoder started on device=%s", ADSB_RTL_DEV)
        except Exception:
            logger.warning("ADSBDecoder failed to start — ADS-B disabled", exc_info=True)
            adsb_decoder = None

    # Start satellite monitor (TinyGS via local MQTT)
    if SAT_ENABLE:
        try:
            satellite_monitor = SatelliteMonitor(
                mqtt_host=MQTT_HOST,
                mqtt_port=MQTT_PORT,
                packet_callback=on_satellite_packet,
                status_callback=on_satellite_status,
            )
            await satellite_monitor.start()
            logger.info("SatelliteMonitor started — mqtt=%s:%d", MQTT_HOST, MQTT_PORT)
        except Exception:
            logger.warning("SatelliteMonitor failed to start", exc_info=True)
            satellite_monitor = None

    # Start Meshtastic handler
    if MESH_ENABLE:
        try:
            meshtastic = MeshtasticHandler(
                dev_path=MESH_PORT,
                packet_callback=on_mesh_packet,
                status_callback=on_mesh_status,
            )
            await meshtastic.start()
            logger.info("MeshtasticHandler started (port=%s)", MESH_PORT or "auto")
        except Exception:
            logger.warning("MeshtasticHandler failed to start", exc_info=True)
            meshtastic = None

    # Open the radio TX interface (Digirig) only when TX is enabled — opening the
    # serial port asserts RTS briefly (a momentary key), so we don't touch it
    # until the operator has opted in with tx_enable + callsign. RX is unaffected.
    if TX_ENABLE and STATION.get("callsign", "").strip():
        try:
            radio = RadioInterface(RADIO_SERIAL, RADIO_AUDIO, TX_ENABLE,
                                   STATION.get("callsign", ""))
            radio.start()
        except Exception:
            logger.warning("RadioInterface failed to open %s — TX unavailable", RADIO_SERIAL)
            radio = None
    else:
        logger.info("Radio TX disabled (tx_enable=%s, callsign=%s) — Digirig not opened",
                    TX_ENABLE, STATION.get("callsign", "") or "—")

    # SSTV satellite tracker — load AMSAT TLEs (network, graceful on failure)
    try:
        sat_tracker = SatTracker(QTH_GRID, SSTV_SATS)
        ok = await loop.run_in_executor(None, sat_tracker.refresh_tles)
        logger.info("SatTracker ready: QTH %s (%.4f,%.4f), %d SSTV sats",
                    QTH_GRID, sat_tracker.lat, sat_tracker.lon, sat_tracker._sats and len(sat_tracker._sats) or 0)
        if not ok:
            logger.warning("SatTracker: no TLEs loaded (AMSAT unreachable?)")
    except Exception:
        logger.warning("SatTracker init failed", exc_info=True)
        sat_tracker = None

    yield  # application is running

    # Shutdown
    if sdr_task is not None and not sdr_task.done():
        sdr_task.cancel()
        await asyncio.gather(sdr_task, return_exceptions=True)
    await decoder.stop()
    sdr.stop()
    if _mode_airband is not None:
        await _mode_airband.stop()
    if _mode_adsb is not None:
        await _mode_adsb.stop()
    if _mode_sstv is not None:
        await _mode_sstv.stop()
    if _mode_aprs is not None:
        await _mode_aprs.stop()
    if _mode_ax25 is not None:
        await _mode_ax25.stop()
    if _mode_meteor is not None:
        await _mode_meteor.stop()
    if airband is not None:
        await airband.stop()
    if adsb_decoder is not None:
        await adsb_decoder.stop()
    if meshtastic is not None:
        await meshtastic.stop()
    if satellite_monitor is not None:
        await satellite_monitor.stop()
    if radio is not None:
        radio.stop()
    logger.info("Shutdown complete")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="HamPi SDR Dashboard", lifespan=lifespan)


# ---------------------------------------------------------------------------
# WebSocket endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/waterfall")
async def ws_waterfall(websocket: WebSocket):
    await websocket.accept()
    waterfall_clients.add(websocket)
    logger.info("Waterfall client connected — total=%d", len(waterfall_clients))
    try:
        # Keep the connection alive; client sends nothing meaningful
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in waterfall WebSocket handler")
    finally:
        waterfall_clients.discard(websocket)
        logger.info("Waterfall client disconnected — total=%d", len(waterfall_clients))


@app.websocket("/ws/dmr")
async def ws_dmr(websocket: WebSocket):
    await websocket.accept()
    dmr_clients.add(websocket)
    logger.info("DMR metadata client connected — total=%d", len(dmr_clients))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in DMR WebSocket handler")
    finally:
        dmr_clients.discard(websocket)
        logger.info("DMR metadata client disconnected — total=%d", len(dmr_clients))


@app.websocket("/ws/dmr-audio")
async def ws_dmr_audio(websocket: WebSocket):
    await websocket.accept()
    dmr_audio_clients.add(websocket)
    logger.info("DMR audio client connected — total=%d", len(dmr_audio_clients))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in DMR audio WebSocket handler")
    finally:
        dmr_audio_clients.discard(websocket)
        logger.info("DMR audio client disconnected — total=%d", len(dmr_audio_clients))


@app.websocket("/ws/airband")
async def ws_airband(websocket: WebSocket):
    await websocket.accept()
    airband_clients.add(websocket)
    logger.info("Airband client connected — total=%d", len(airband_clients))
    # Send current status immediately on connect
    try:
        import json as _json
        await websocket.send_text(_json.dumps({"type": "status", **airband_status}))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in airband WebSocket handler")
    finally:
        airband_clients.discard(websocket)
        logger.info("Airband client disconnected — total=%d", len(airband_clients))


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/sysinfo")
async def api_sysinfo():
    info: dict = {
        "hostname":     socket.gethostname(),
        "local_ip":     None,
        "tailscale_ip": None,
        "version":      "0.9-b3t5",
        "geocode":      GEOCODE_ENABLE,
    }
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        info["local_ip"] = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    try:
        result = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            info["tailscale_ip"] = result.stdout.strip()
    except Exception:
        pass
    return info


@app.get("/api/status")
async def api_status():
    return {
        "freq":        sdr.freq,
        "gain":        sdr.gain,
        "sample_rate": sdr.sample_rate,
        "clients": {
            "waterfall": len(waterfall_clients),
            "dmr":       len(dmr_clients),
        },
    }


@app.post("/api/tune")
async def api_tune(freq: Optional[int] = None, gain: Optional[float] = None):
    changed = {}
    try:
        if freq is not None:
            sdr.set_freq(freq)
            changed["freq"] = freq
        if gain is not None:
            sdr.set_gain(gain)
            changed["gain"] = gain
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"SDR unavailable: {exc}")
    return {"status": "ok", "changed": changed}


def _cur_airband() -> Optional[AirbandScanner]:
    """Return the airband scanner that is currently active for REST control."""
    return _mode_airband if active_sdr_mode == "airband" else airband


def _cur_adsb() -> Optional[ADSBDecoder]:
    """Return the ADS-B decoder that is currently active."""
    return _mode_adsb if active_sdr_mode == "adsb" else adsb_decoder


def _cur_sstv() -> Optional[SSTVDecoder]:
    return _mode_sstv if active_sdr_mode == "sstv" else None


def _cur_aprs() -> Optional[APRSDecoder]:
    return _mode_aprs if active_sdr_mode == "aprs" else None


def _cur_meteor() -> Optional[MeteorDecoder]:
    return _mode_meteor if active_sdr_mode == "meteor" else None


def _cur_trunk() -> Optional[TrunkMonitor]:
    return _mode_trunk if active_sdr_mode == "trunk" else None


def _cur_ax25() -> Optional[AX25Decoder]:
    return _mode_ax25 if active_sdr_mode == "aprs" else None


@app.get("/api/sdr/mode")
async def api_get_sdr_mode():
    return {"mode": active_sdr_mode}


@app.post("/api/sdr/mode")
async def api_set_sdr_mode(mode: str):
    VALID = ("dmr", "airband", "adsb", "sstv", "aprs", "meteor", "trunk")
    if mode not in VALID:
        raise HTTPException(status_code=400, detail=f"mode must be one of {VALID}")
    async with _mode_lock:
        return await _switch_sdr_mode(mode)


async def _switch_sdr_mode(mode: str):
    global active_sdr_mode, sdr_task, _mode_airband, _mode_adsb, _mode_sstv, _mode_aprs, _mode_ax25, _mode_meteor, _mode_trunk

    if mode == active_sdr_mode:
        return {"mode": active_sdr_mode}

    loop = asyncio.get_running_loop()

    # ── Stop currently active mode ───────────────────────────────
    if active_sdr_mode == "dmr":
        if sdr_task is not None and not sdr_task.done():
            sdr_task.cancel()
            await asyncio.gather(sdr_task, return_exceptions=True)
            sdr_task = None
        await decoder.stop()
        await loop.run_in_executor(None, sdr.stop)

    elif active_sdr_mode == "airband":
        if _mode_airband is not None:
            await _mode_airband.stop()
            _mode_airband = None
        airband_status["enabled"] = airband is not None

    elif active_sdr_mode == "adsb":
        if _mode_adsb is not None:
            await _mode_adsb.stop()
            _mode_adsb = None

    elif active_sdr_mode == "meteor":
        if _mode_meteor is not None:
            await _mode_meteor.stop()
            _mode_meteor = None

    elif active_sdr_mode == "trunk":
        if _mode_trunk is not None:
            await _mode_trunk.stop()
            _mode_trunk = None

    elif active_sdr_mode == "sstv":
        if sdr_task is not None and not sdr_task.done():
            sdr_task.cancel()
            await asyncio.gather(sdr_task, return_exceptions=True)
            sdr_task = None
        if _mode_sstv is not None:
            await _mode_sstv.stop()
            _mode_sstv = None
        await loop.run_in_executor(None, sdr.stop)

    elif active_sdr_mode == "aprs":
        if sdr_task is not None and not sdr_task.done():
            sdr_task.cancel()
            await asyncio.gather(sdr_task, return_exceptions=True)
            sdr_task = None
        if _mode_aprs is not None:
            await _mode_aprs.stop()
            _mode_aprs = None
        if _mode_ax25 is not None:
            await _mode_ax25.stop()
            _mode_ax25 = None
        await loop.run_in_executor(None, sdr.stop)

    # ── Start requested mode ─────────────────────────────────────
    try:
        if mode == "dmr":
            sdr.freq = INITIAL_FREQ
            sdr.gain = INITIAL_GAIN
            await loop.run_in_executor(None, sdr.start)
            await decoder.start()
            sdr_task = asyncio.create_task(sdr_loop(), name="sdr-loop")

        elif mode == "airband":
            _mode_airband = AirbandScanner(
                channels=AIRBAND_CHANNELS,
                squelch=AIRBAND_SQUELCH,
                dwell_ms=AIRBAND_DWELL,
                gain=AIRBAND_GAIN,
                rtl_device=sdr.device_index,
                rtl_port=sdr.port,
                audio_callback=on_airband_audio,
                status_callback=on_airband_status,
            )
            await _mode_airband.start()
            airband_status["enabled"] = True

        elif mode == "adsb":
            _mode_adsb = ADSBDecoder(
                device_index=sdr.device_index,
                gain=ADSB_GAIN,
                lat_ref=ADSB_LAT,
                lon_ref=ADSB_LON,
                aircraft_callback=on_adsb_aircraft,
            )
            await _mode_adsb.start()

        elif mode == "meteor":
            # SatDump owns device 0 directly (rtl_tcp already stopped above).
            _mode_meteor = MeteorDecoder(
                image_dir=METEOR_IMAGE_DIR,
                freq=METEOR_FREQ,
                samplerate=METEOR_SR,
                gain=METEOR_GAIN,
                pipeline=METEOR_PIPELINE,
                rtl_dev=sdr.device_index if isinstance(sdr.device_index, int) else 0,
                status_callback=on_meteor_status,
                image_callback=on_meteor_image,
            )
            await _mode_meteor.start()

        elif mode == "trunk":
            # SDRTrunk service claims device 0 over libusb (rtl_tcp stopped above).
            _mode_trunk = TrunkMonitor(
                app_dir=TRUNK_APP_DIR,
                service=TRUNK_SERVICE,
                systems=TRUNK_SYSTEMS,
                active=active_trunk_system,
                playlist_path=TRUNK_PLAYLIST,
                vnc_url=TRUNK_VNC_URL,
                status_callback=on_trunk_status,
                event_callback=on_trunk_event,
            )
            await _mode_trunk.start()

        elif mode == "sstv":
            # If a satellite is already tracked, centre on its downlink so the
            # Doppler follower in sstv_loop has the signal in the passband.
            tracked_dl = sat_tracker.tracked_downlink() if sat_tracker else None
            sdr.freq = tracked_dl or SSTV_FREQ
            sdr.gain = SSTV_GAIN
            await loop.run_in_executor(None, sdr.start)
            _mode_sstv = SSTVDecoder(
                image_dir=SSTV_IMAGE_DIR,
                line_callback=on_sstv_line,
                image_callback=on_sstv_image,
                status_callback=on_sstv_status,
            )
            await _mode_sstv.start()
            sdr_task = asyncio.create_task(sstv_loop(), name="sstv-loop")

        elif mode == "aprs":
            sdr.freq = APRS_FREQ
            sdr.gain = APRS_GAIN
            await loop.run_in_executor(None, sdr.start)
            _mode_aprs = APRSDecoder(packet_callback=on_aprs_packet)
            await _mode_aprs.start()
            _mode_ax25 = AX25Decoder(frame_callback=on_ax25_frame)
            await _mode_ax25.start()
            sdr_task = asyncio.create_task(aprs_loop(), name="aprs-loop")

    except Exception as exc:
        logger.error("Mode switch to %r failed: %s — restoring DMR", mode, exc)
        # Stop anything partially started — a leaked subprocess keeps device 0
        # busy and the DMR fallback below would fail too.
        for obj in (_mode_airband, _mode_adsb, _mode_sstv, _mode_aprs,
                    _mode_ax25, _mode_meteor, _mode_trunk):
            if obj is not None:
                try:
                    await obj.stop()
                except Exception:
                    logger.exception("cleanup stop failed during mode-switch recovery")
        _mode_airband = None
        _mode_adsb    = None
        _mode_sstv    = None
        _mode_aprs    = None
        _mode_ax25    = None
        _mode_meteor  = None
        _mode_trunk   = None
        try:
            await loop.run_in_executor(None, sdr.stop)  # in case the failed mode left it running
            sdr.freq = INITIAL_FREQ
            sdr.gain = INITIAL_GAIN
            await loop.run_in_executor(None, sdr.start)
            await decoder.start()
            sdr_task = asyncio.create_task(sdr_loop(), name="sdr-loop")
            active_sdr_mode = "dmr"
        except Exception:
            logger.exception("DMR fallback also failed")
        raise HTTPException(status_code=503, detail=f"Mode switch to {mode!r} failed: {exc}")

    active_sdr_mode = mode
    return {"mode": active_sdr_mode}


async def _geocode(city: str, state: str, country: str) -> tuple[float, float] | None:
    """Resolve city+state to lat/lon via Nominatim OSM. Cached permanently."""
    if not GEOCODE_ENABLE or not city:
        return None
    key = f"{city}|{state}|{country}".lower()
    if key in _geo_cache:
        return _geo_cache[key]
    q = ", ".join(part for part in [city, state, country] if part)
    try:
        async with httpx.AsyncClient(
            timeout=5.0,
            headers={"User-Agent": "HamPiSDR/0.0.4 (github.com/sinetec6969/hampi-dashboard)"},
        ) as client:
            r    = await client.get("https://nominatim.openstreetmap.org/search",
                                    params={"q": q, "format": "json", "limit": 1})
            data = r.json()
        if data:
            coords: tuple[float, float] = (float(data[0]["lat"]), float(data[0]["lon"]))
            _geo_cache[key] = coords
            return coords
    except Exception as exc:
        logger.debug("Geocode failed for %r: %s", q, exc)
    _geo_cache[key] = None
    return None


@app.get("/api/calls")
async def api_calls():
    return call_history


async def _lookup_dmr_id(dmr_id: int) -> dict:
    now = time.monotonic()
    if dmr_id in _lookup_cache:
        expires, cached = _lookup_cache[dmr_id]
        if now < expires:
            return cached

    if _radioid_db is not None:
        # Offline path: radioid.db is authoritative — a miss stays a miss,
        # no HTTP fallback (build with build_radioid_db.py; rerun to refresh)
        row = _radioid_db.execute(
            "SELECT callsign, name, city, state, country FROM users WHERE id=?",
            (dmr_id,),
        ).fetchone()
        if row:
            result = {"dmr_id": dmr_id, "callsign": row[0], "name": row[1],
                      "city": row[2], "state": row[3], "country": row[4]}
        else:
            result = {"dmr_id": dmr_id, "callsign": "", "name": "", "city": "",
                      "state": "", "country": "", "lat": None, "lon": None}
    else:
        url = f"https://www.radioid.net/api/dmr/user/?id={dmr_id}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                r.raise_for_status()
                data = r.json()
        except Exception as exc:
            logger.warning("RadioID lookup failed for %d: %s", dmr_id, exc)
            return {"dmr_id": dmr_id, "callsign": "", "name": "", "city": "", "state": "",
                    "lat": None, "lon": None}

        results = data.get("results", [])
        if results:
            u = results[0]
            result = {
                "dmr_id":   dmr_id,
                "callsign": u.get("callsign", ""),
                "name":     f"{u.get('fname', '')} {u.get('surname', '')}".strip(),
                "city":     u.get("city", ""),
                "state":    u.get("state", ""),
                "country":  u.get("country", ""),
            }
        else:
            result = {"dmr_id": dmr_id, "callsign": "", "name": "", "city": "", "state": "",
                      "country": "", "lat": None, "lon": None}

    coords = await _geocode(result["city"], result["state"], result.get("country", ""))
    result["lat"] = coords[0] if coords else None
    result["lon"] = coords[1] if coords else None

    _lookup_cache[dmr_id] = (now + LOOKUP_TTL, result)
    return result


@app.get("/api/lookup/{dmr_id}")
async def api_lookup(dmr_id: int):
    """Look up a DMR ID on RadioID.net; includes lat/lon from Nominatim geocoding."""
    return await _lookup_dmr_id(dmr_id)


@app.get("/api/hamclock")
async def api_hamclock():
    """Same-origin proxy for the local OpenHamClock solar/band data (its CORS
    allowlist can't cover every LAN/tailscale origin this dashboard serves)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get("http://127.0.0.1:3001/api/n0nbh")
            data = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="OpenHamClock not reachable")
    data["station"] = {"callsign": cfg("station.callsign", ""), "grid": cfg("qth.grid", "")}
    return data


# ---------------------------------------------------------------------------
# Airband REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/airband/status")
async def api_airband_status():
    return airband_status


@app.post("/api/airband/squelch")
async def api_airband_squelch(level: float):
    ab = _cur_airband()
    if ab is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    ab.set_squelch(level)
    airband_status["squelch"] = ab.squelch
    return {"squelch": ab.squelch}


@app.post("/api/airband/scan")
async def api_airband_scan(enabled: bool):
    ab = _cur_airband()
    if ab is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    ab.set_scanner(enabled)
    airband_status["scanner_on"] = ab.scanner_on
    return {"scanner_on": ab.scanner_on}


@app.post("/api/airband/channel/{idx}")
async def api_airband_channel(idx: int):
    """Manually lock to a channel index (turns scanner off)."""
    ab = _cur_airband()
    if ab is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    if not ab.channels or idx < 0 or idx >= len(ab.channels):
        raise HTTPException(status_code=400, detail="Invalid channel index")
    ab.set_scanner(False)
    airband_status["scanner_on"] = False
    await ab._tune_to(idx)
    return {"active_idx": idx, "channel": ab.channels[idx]}


# ---------------------------------------------------------------------------
# Meshtastic WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/meshtastic")
async def ws_meshtastic(websocket: WebSocket):
    await websocket.accept()
    meshtastic_clients.add(websocket)
    logger.info("Meshtastic client connected — total=%d", len(meshtastic_clients))
    # Send current state immediately on connect
    try:
        status = meshtastic.status_dict() if meshtastic else {
            "type": "status", "available": False, "connected": False,
            "device": None, "node_count": 0, "local_id": None,
        }
        await websocket.send_text(json.dumps(status))
        if meshtastic and meshtastic.nodes:
            await websocket.send_text(json.dumps({
                "type": "node_list",
                "nodes": meshtastic.node_list(),
            }))
        if meshtastic and meshtastic.messages:
            for msg in reversed(meshtastic.messages[:50]):
                await websocket.send_text(json.dumps({"type": "message", "message": msg}))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in meshtastic WebSocket handler")
    finally:
        meshtastic_clients.discard(websocket)
        logger.info("Meshtastic client disconnected — total=%d", len(meshtastic_clients))


@app.get("/api/meshtastic/status")
async def api_mesh_status():
    if meshtastic is None:
        return {"available": False, "connected": False, "device": None, "node_count": 0}
    return meshtastic.status_dict()


@app.get("/api/meshtastic/nodes")
async def api_mesh_nodes():
    if meshtastic is None:
        return []
    return meshtastic.node_list()


@app.get("/api/meshtastic/messages")
async def api_mesh_messages():
    if meshtastic is None:
        return []
    return meshtastic.messages


@app.get("/api/meshtastic/channels")
async def api_mesh_channels():
    if meshtastic is None:
        return []
    return meshtastic.get_channels()


class MeshSendBody(BaseModel):
    text: str
    destination: str = "^all"
    channel: int = 0


@app.post("/api/meshtastic/send")
async def api_mesh_send(body: MeshSendBody):
    if meshtastic is None or not meshtastic.connected:
        raise HTTPException(status_code=503, detail="Meshtastic not connected")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")
    if len(text.encode("utf-8")) > 228:
        raise HTTPException(status_code=400, detail="Message too long (max 228 bytes)")
    try:
        await meshtastic.send_text(text, destination=body.destination, channel=body.channel)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"ok": True}


class MeshTracerouteBody(BaseModel):
    destination: str
    hop_limit: int = 7
    channel: int = 0


@app.post("/api/meshtastic/traceroute")
async def api_mesh_traceroute(body: MeshTracerouteBody):
    if meshtastic is None or not meshtastic.connected:
        raise HTTPException(status_code=503, detail="Meshtastic not connected")
    try:
        await meshtastic.traceroute(body.destination, body.hop_limit, body.channel)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"ok": True}


@app.get("/api/meshtastic/rangetest")
async def api_mesh_rangetest_get():
    if meshtastic is None:
        return {"available": False, "enabled": False, "sender": 0, "save": False}
    return meshtastic.get_range_test_config()


class MeshRangeTestBody(BaseModel):
    enabled: bool
    sender: int = 0   # broadcast interval in seconds; 0 = receiver-only
    save: bool = True


@app.post("/api/meshtastic/rangetest")
async def api_mesh_rangetest_set(body: MeshRangeTestBody):
    if meshtastic is None or not meshtastic.connected:
        raise HTTPException(status_code=503, detail="Meshtastic not connected")
    if body.sender < 0:
        raise HTTPException(status_code=400, detail="sender interval must be >= 0")
    try:
        await meshtastic.set_range_test_config(body.enabled, body.sender, body.save)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"ok": True}


# ---------------------------------------------------------------------------
# ADS-B WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/adsb")
async def ws_adsb(websocket: WebSocket):
    await websocket.accept()
    adsb_clients.add(websocket)
    logger.info("ADS-B client connected — total=%d", len(adsb_clients))
    # Send current aircraft snapshot immediately
    try:
        cur = _cur_adsb()
        if cur:
            for ac in cur.aircraft_list():
                await websocket.send_text(json.dumps({"type": "aircraft", "aircraft": ac}))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in ADS-B WebSocket handler")
    finally:
        adsb_clients.discard(websocket)
        logger.info("ADS-B client disconnected — total=%d", len(adsb_clients))


@app.get("/api/adsb/aircraft")
async def api_adsb_aircraft():
    cur = _cur_adsb()
    return cur.aircraft_list() if cur else []


@app.get("/api/adsb/status")
async def api_adsb_status():
    cur = _cur_adsb()
    return {
        "enabled":       cur is not None,
        "mode_active":   active_sdr_mode == "adsb",
        "aircraft_count": len(cur.aircraft) if cur else 0,
        "lat_ref":       ADSB_LAT,
        "lon_ref":       ADSB_LON,
    }


# ---------------------------------------------------------------------------
# SSTV WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/sstv")
async def ws_sstv(websocket: WebSocket):
    await websocket.accept()
    sstv_clients.add(websocket)
    logger.info("SSTV client connected — total=%d", len(sstv_clients))
    try:
        cur = _cur_sstv()
        if cur:
            await websocket.send_text(json.dumps(cur.status_dict()))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in SSTV WebSocket handler")
    finally:
        sstv_clients.discard(websocket)
        logger.info("SSTV client disconnected — total=%d", len(sstv_clients))


@app.get("/api/sstv/status")
async def api_sstv_status():
    cur = _cur_sstv()
    if cur:
        return cur.status_dict()
    return {"state": "disabled", "mode": "", "line": 0, "total_lines": 0, "signal_rms": 0.0}


@app.get("/api/sstv/images")
async def api_sstv_images():
    try:
        files = sorted(
            [f for f in os.listdir(SSTV_IMAGE_DIR) if f.endswith(".png")],
            reverse=True,
        )
        return [{"filename": f, "url": f"/api/sstv/images/{f}"} for f in files]
    except FileNotFoundError:
        return []


@app.get("/api/sstv/images/{filename}")
async def api_sstv_image(filename: str):
    from fastapi.responses import FileResponse
    if not filename.endswith(".png") or "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = os.path.join(SSTV_IMAGE_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png")


# ---------------------------------------------------------------------------
# SSTV satellite tracking — AMSAT TLEs, pass prediction, Doppler
# ---------------------------------------------------------------------------

@app.get("/api/sat/sstv")
async def api_sat_sstv():
    if sat_tracker is None:
        return {"qth": {"grid": QTH_GRID}, "tracked": None, "satellites": []}
    info = await asyncio.get_running_loop().run_in_executor(None, sat_tracker.info)
    return {"qth": sat_tracker.status(), "tracked": sat_tracker.tracked,
            "sstv_active": active_sdr_mode == "sstv", "satellites": info}


@app.post("/api/sat/track")
async def api_sat_track(norad: int = 0):
    """Select a satellite to track (norad=0 to stop). Retunes the SDR centre to
    the downlink when SSTV mode is active so Doppler stays within the passband."""
    if sat_tracker is None:
        raise HTTPException(status_code=503, detail="satellite tracker unavailable")
    if norad == 0:
        sat_tracker.tracked = None
        if active_sdr_mode == "sstv":
            sdr.set_freq(SSTV_FREQ)
        return {"tracked": None, "rx_freq": SSTV_FREQ}
    if norad not in sat_tracker._sats:
        raise HTTPException(status_code=404, detail=f"no TLE for NORAD {norad}")
    sat_tracker.tracked = norad
    downlink = sat_tracker.tracked_downlink()
    if active_sdr_mode == "sstv" and downlink:
        sdr.set_freq(downlink)   # Doppler offset applied per-chunk in sstv_loop
    return {"tracked": norad, "downlink": downlink,
            "rx_freq": sat_tracker.tracked_rx_freq()}


@app.post("/api/sat/tle/refresh")
async def api_sat_tle_refresh():
    if sat_tracker is None:
        raise HTTPException(status_code=503, detail="satellite tracker unavailable")
    ok = await asyncio.get_running_loop().run_in_executor(None, sat_tracker.refresh_tles, True)
    return {"ok": ok, "sats_loaded": len(sat_tracker._sats)}


@app.get("/api/sat/meteor")
async def api_sat_meteor():
    if sat_tracker is None:
        return {"qth": {"grid": QTH_GRID}, "satellites": []}
    info = await asyncio.get_running_loop().run_in_executor(
        None, sat_tracker.info, sat_tracker.meteor_sats)
    return {"qth": sat_tracker.status(), "satellites": info}


# ---------------------------------------------------------------------------
# METEOR LRPT (SatDump) WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/meteor")
async def ws_meteor(websocket: WebSocket):
    await websocket.accept()
    meteor_clients.add(websocket)
    logger.info("METEOR client connected — total=%d", len(meteor_clients))
    try:
        cur = _cur_meteor()
        if cur:
            await websocket.send_text(json.dumps(cur.status_dict()))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in METEOR WebSocket handler")
    finally:
        meteor_clients.discard(websocket)
        logger.info("METEOR client disconnected — total=%d", len(meteor_clients))


@app.get("/api/meteor/status")
async def api_meteor_status():
    cur = _cur_meteor()
    if cur:
        return cur.status_dict()
    return {"type": "status", "running": False, "freq": METEOR_FREQ,
            "pipeline": METEOR_PIPELINE, "snr": 0.0, "images": 0, "last_log": ""}


@app.get("/api/meteor/images")
async def api_meteor_images():
    try:
        rels = []
        for root, _, files in os.walk(METEOR_IMAGE_DIR):
            for f in files:
                if f.lower().endswith(".png"):
                    rels.append(os.path.relpath(os.path.join(root, f), METEOR_IMAGE_DIR))
        rels.sort(reverse=True)
        return [{"path": r, "url": f"/api/meteor/images/{r}"} for r in rels]
    except FileNotFoundError:
        return []


@app.get("/api/meteor/images/{path:path}")
async def api_meteor_image(path: str):
    from fastapi.responses import FileResponse
    base = os.path.realpath(METEOR_IMAGE_DIR)
    full = os.path.realpath(os.path.join(base, path))
    if not full.startswith(base + os.sep) or not full.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404)
    return FileResponse(full, media_type="image/png")


# ---------------------------------------------------------------------------
# SDRTrunk trunked-DMR WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/trunk")
async def ws_trunk(websocket: WebSocket):
    await websocket.accept()
    trunk_clients.add(websocket)
    try:
        cur = _cur_trunk()
        if cur:
            await websocket.send_text(json.dumps(cur.status_dict()))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in trunk WebSocket handler")
    finally:
        trunk_clients.discard(websocket)


@app.get("/api/trunk/status")
async def api_trunk_status():
    cur = _cur_trunk()
    if cur:
        return cur.status_dict()
    s = _trunk_sys(active_trunk_system)
    control = s.get("control", [])
    return {"type": "status", "running": False, "tuner_locked": False,
            "system": active_trunk_system, "systems": [x["name"] for x in TRUNK_SYSTEMS],
            "site": s.get("site", ""), "protocol": s.get("protocol", ""),
            "control_freq": int(control[0]) if control else 0, "color_code": s.get("color_code"),
            "encrypted_seen": False, "vnc_url": TRUNK_VNC_URL, "recent": []}


@app.post("/api/trunk/system")
async def api_set_trunk_system(name: str):
    global active_trunk_system
    if not any(s["name"] == name for s in TRUNK_SYSTEMS):
        raise HTTPException(status_code=404, detail=f"unknown trunked system: {name}")
    active_trunk_system = name
    cur = _cur_trunk()
    if cur:
        await cur.set_system(name)   # stops SDRTrunk, rewrites playlist, restarts
    return {"system": name}


# ---------------------------------------------------------------------------
# APRS WebSocket + REST endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/aprs")
async def ws_aprs(websocket: WebSocket):
    await websocket.accept()
    aprs_clients.add(websocket)
    logger.info("APRS client connected — total=%d", len(aprs_clients))
    try:
        cur = _cur_aprs()
        if cur:
            await websocket.send_text(json.dumps(cur.status_dict()))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in APRS WebSocket handler")
    finally:
        aprs_clients.discard(websocket)
        logger.info("APRS client disconnected — total=%d", len(aprs_clients))


@app.get("/api/aprs/status")
async def api_aprs_status():
    cur = _cur_aprs()
    if cur:
        return cur.status_dict()
    return {"type": "status", "running": False, "frames": 0, "parse_errors": 0, "stations": 0}


@app.get("/api/aprs/stations")
async def api_aprs_stations():
    cur = _cur_aprs()
    return list(cur.stations.values()) if cur else []


@app.get("/api/aprs/packets")
async def api_aprs_packets():
    cur = _cur_aprs()
    return list(cur.packets) if cur else []


# ---------------------------------------------------------------------------
# AX.25 WebSocket + REST endpoints (active in aprs mode — shared direwolf)
# ---------------------------------------------------------------------------

@app.websocket("/ws/ax25")
async def ws_ax25(websocket: WebSocket):
    await websocket.accept()
    ax25_clients.add(websocket)
    logger.info("AX25 client connected — total=%d", len(ax25_clients))
    try:
        cur = _cur_ax25()
        if cur:
            await websocket.send_text(json.dumps(cur.status_dict()))
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in AX25 WebSocket handler")
    finally:
        ax25_clients.discard(websocket)
        logger.info("AX25 client disconnected — total=%d", len(ax25_clients))


@app.get("/api/ax25/status")
async def api_ax25_status():
    cur = _cur_ax25()
    if cur:
        return cur.status_dict()
    return {"type": "status", "connected": False, "frames": 0, "heard": 0}


@app.get("/api/ax25/frames")
async def api_ax25_frames():
    cur = _cur_ax25()
    return list(cur.frames) if cur else []


@app.get("/api/ax25/heard")
async def api_ax25_heard():
    cur = _cur_ax25()
    return list(cur.heard.values()) if cur else []


# ---------------------------------------------------------------------------
# Radio TX (Phase A — Digirig). Hard-gated on radio.tx_enable + station.callsign.
# ---------------------------------------------------------------------------

@app.get("/api/radio/status")
async def api_radio_status():
    if radio is None:
        return {"open": False, "ready": False, "tx_enable": TX_ENABLE,
                "callsign": STATION.get("callsign", ""), "serial": RADIO_SERIAL}
    return {**radio.status(), "station": STATION}


@app.post("/api/radio/ptt_test")
async def api_radio_ptt_test(seconds: float = 1.0):
    if radio is None:
        raise HTTPException(status_code=503, detail="radio not available")
    seconds = min(max(seconds, 0.1), 5.0)
    try:
        await asyncio.get_running_loop().run_in_executor(None, radio.ptt_test, seconds)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    return {"status": "ok", "keyed_s": seconds}


@app.post("/api/radio/tone")
async def api_radio_tone(freq: int = 1000, seconds: float = 2.0):
    if radio is None:
        raise HTTPException(status_code=503, detail="radio not available")
    seconds = min(max(seconds, 0.1), 10.0)
    try:
        await asyncio.get_running_loop().run_in_executor(
            None, radio.transmit_tone, freq, seconds)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    return {"status": "ok", "freq": freq, "seconds": seconds}


# ---------------------------------------------------------------------------
# Satellite endpoints
# ---------------------------------------------------------------------------

@app.websocket("/ws/satellite")
async def ws_satellite(websocket: WebSocket):
    await websocket.accept()
    satellite_clients.add(websocket)
    try:
        # Send current state immediately on connect
        if satellite_monitor:
            await websocket.send_json({"type": "status", **satellite_monitor.get_status()})
            for pkt in satellite_monitor.get_packets():
                await websocket.send_json({"type": "packet", **pkt})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in satellite WebSocket handler")
    finally:
        satellite_clients.discard(websocket)


@app.get("/api/satellite/status")
async def api_satellite_status():
    if satellite_monitor is None:
        return {"mqtt_connected": False, "station": {}, "packet_count": 0}
    return satellite_monitor.get_status()


@app.get("/api/satellite/packets")
async def api_satellite_packets():
    if satellite_monitor is None:
        return []
    return satellite_monitor.get_packets()


# ---------------------------------------------------------------------------
# Static frontend (must come last so API routes take precedence)
# ---------------------------------------------------------------------------

class SPAStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code == 404 and not path.startswith("api/"):
                return await super().get_response("index.html", scope)
            raise


_dist = os.path.join(os.path.dirname(__file__), FRONTEND_DIST)
if os.path.isdir(_dist):
    app.mount("/", SPAStaticFiles(directory=_dist, html=True), name="frontend")
else:
    logger.warning("Frontend dist directory not found at %s — skipping static mount", _dist)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=SERVER_PORT, reload=False)
