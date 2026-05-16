"""
main.py - FastAPI application for the HamPi SDR dashboard.

WebSocket endpoints:
  /ws/waterfall  — binary float32 FFT frames
  /ws/dmr        — JSON DMR metadata
  /ws/audio      — binary PCM audio from DSD

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
import subprocess
import time
from contextlib import asynccontextmanager
from typing import Optional, Set

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState

from airband import AirbandScanner, DEFAULT_CHANNELS
from dmr import DMRDecoder
from sdr import SDREngine

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

INITIAL_FREQ:   int   = int(os.getenv("SDR_FREQ",        "438800000"))
INITIAL_GAIN:   float = float(os.getenv("SDR_GAIN",      "49.6"))
SAMPLE_RATE:    int   = int(os.getenv("SDR_SAMPLE_RATE", "2400000"))
CHUNK_SIZE:     int   = int(os.getenv("SDR_CHUNK_SIZE",  "131072"))
FFT_PER_CHUNK:  int   = 4   # waterfall lines emitted per IQ read
N_FFT:          int   = 1024
FRONTEND_DIST:  str   = os.getenv("FRONTEND_DIST", "../frontend/dist")
HISTORY_FILE:   str   = os.getenv("HISTORY_FILE",
                                   os.path.join(os.path.dirname(__file__), "..", "call_history.json"))
MAX_HISTORY:    int   = 200

# Airband configuration
AIRBAND_ENABLE:  bool  = os.getenv("AIRBAND_ENABLE", "1") == "1"
AIRBAND_RTL_DEV: int   = int(os.getenv("AIRBAND_RTL_DEV",  "1"))
AIRBAND_RTL_PORT:int   = int(os.getenv("AIRBAND_RTL_PORT", "1235"))
AIRBAND_GAIN:    float = float(os.getenv("AIRBAND_GAIN",   "40.0"))
AIRBAND_SQUELCH: float = float(os.getenv("AIRBAND_SQUELCH","0.01"))
AIRBAND_DWELL:   int   = int(os.getenv("AIRBAND_DWELL_MS", "2000"))

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
sdr:     SDREngine
decoder: DMRDecoder
airband: Optional[AirbandScanner] = None

waterfall_clients: Set[WebSocket] = set()
dmr_clients:       Set[WebSocket] = set()
audio_clients:     Set[WebSocket] = set()
airband_clients:   Set[WebSocket] = set()

# Last-known airband status — returned by /api/airband/status
airband_status: dict = {
    "enabled":      False,
    "active_idx":   0,
    "channel":      None,
    "squelch_open": False,
    "scanner_on":   True,
    "squelch":      AIRBAND_SQUELCH,
    "dwell_ms":     AIRBAND_DWELL,
    "channels":     DEFAULT_CHANNELS,
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

async def broadcast_bytes(clients: Set[WebSocket], data: bytes) -> None:
    """Send binary data to all connected clients; evict dead connections."""
    dead: Set[WebSocket] = set()
    for ws in list(clients):
        try:
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_bytes(data)
            else:
                dead.add(ws)
        except Exception:
            dead.add(ws)
    clients -= dead


async def broadcast_json(clients: Set[WebSocket], payload: dict) -> None:
    """Send a JSON message to all connected clients; evict dead connections."""
    text = json.dumps(payload)
    dead: Set[WebSocket] = set()
    for ws in list(clients):
        try:
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_text(text)
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


async def on_airband_status(status: dict) -> None:
    airband_status.update(status)
    await broadcast_json(airband_clients, status)


# ---------------------------------------------------------------------------
# DMR callbacks (called from DMRDecoder background tasks)
# ---------------------------------------------------------------------------

async def on_audio(pcm: bytes) -> None:
    await broadcast_bytes(audio_clients, pcm)


async def on_meta(frame_dict: dict) -> None:
    await broadcast_json(dmr_clients, frame_dict)


async def on_call_end(record: dict) -> None:
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
    try:
        while True:
            try:
                # First pass or after reconnect: no read in flight yet — block once.
                if read_future is None:
                    iq = await loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)
                else:
                    iq = await read_future

                # Kick off the next read immediately so it runs while we demodulate.
                read_future = loop.run_in_executor(None, sdr.read_iq, CHUNK_SIZE)

                # Waterfall: spread FFT_PER_CHUNK slices across the chunk.
                for k in range(FFT_PER_CHUNK):
                    fft_bins = sdr.compute_fft(iq[k * step:], n_fft=N_FFT)
                    await broadcast_bytes(waterfall_clients, fft_bins.tobytes())

                # Demodulate current chunk (runs concurrently with read_future).
                pcm = await loop.run_in_executor(None, sdr.fm_demodulate, iq, sdr.freq)
                await decoder.write_audio(pcm)
                await asyncio.sleep(0)

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
    global sdr, decoder, airband

    # Load persisted call history
    call_history.extend(_load_history())
    logger.info("Call history loaded: %d entries", len(call_history))

    # Initialise SDR engine
    sdr = SDREngine(
        freq=INITIAL_FREQ,
        sample_rate=SAMPLE_RATE,
        gain=INITIAL_GAIN,
    )

    # Initialise DMR decoder
    decoder = DMRDecoder(
        audio_callback=on_audio,
        meta_callback=on_meta,
        call_end_callback=on_call_end,
    )

    # Start hardware (blocking calls wrapped)
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sdr.start)
    await decoder.start()

    # Launch SDR acquisition loop
    task = asyncio.create_task(sdr_loop(), name="sdr-loop")

    # Start airband scanner (optional — graceful on failure)
    if AIRBAND_ENABLE:
        try:
            airband = AirbandScanner(
                channels=DEFAULT_CHANNELS,
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
            airband_status["channels"] = DEFAULT_CHANNELS
            logger.info("AirbandScanner started on device=%d port=%d",
                        AIRBAND_RTL_DEV, AIRBAND_RTL_PORT)
        except Exception:
            logger.warning("AirbandScanner failed to start — airband disabled",
                           exc_info=True)
            airband = None

    yield  # application is running

    # Shutdown
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await decoder.stop()
    sdr.stop()
    if airband is not None:
        await airband.stop()
    logger.info("Shutdown complete")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="HamPi SDR Dashboard", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    await websocket.accept()
    audio_clients.add(websocket)
    logger.info("Audio client connected — total=%d", len(audio_clients))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected error in audio WebSocket handler")
    finally:
        audio_clients.discard(websocket)
        logger.info("Audio client disconnected — total=%d", len(audio_clients))


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
        "version":      "0.0.8-1",
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
            "audio":     len(audio_clients),
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


async def _geocode(city: str, state: str, country: str) -> tuple[float, float] | None:
    """Resolve city+state to lat/lon via Nominatim OSM. Cached permanently."""
    if not city:
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


# ---------------------------------------------------------------------------
# Airband REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/airband/status")
async def api_airband_status():
    return airband_status


@app.post("/api/airband/squelch")
async def api_airband_squelch(level: float):
    if airband is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    airband.set_squelch(level)
    airband_status["squelch"] = airband.squelch
    return {"squelch": airband.squelch}


@app.post("/api/airband/scan")
async def api_airband_scan(enabled: bool):
    if airband is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    airband.set_scanner(enabled)
    airband_status["scanner_on"] = airband.scanner_on
    return {"scanner_on": airband.scanner_on}


@app.post("/api/airband/channel/{idx}")
async def api_airband_channel(idx: int):
    """Manually lock to a channel index (turns scanner off)."""
    if airband is None:
        raise HTTPException(status_code=503, detail="Airband not running")
    if not airband.channels or idx < 0 or idx >= len(airband.channels):
        raise HTTPException(status_code=400, detail="Invalid channel index")
    airband.set_scanner(False)
    airband_status["scanner_on"] = False
    # _tune_to is async — run from this endpoint via create_task
    asyncio.create_task(airband._tune_to(idx))
    return {"active_idx": idx, "channel": airband.channels[idx]}


# ---------------------------------------------------------------------------
# Static frontend (must come last so API routes take precedence)
# ---------------------------------------------------------------------------

_dist = os.path.join(os.path.dirname(__file__), FRONTEND_DIST)
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
else:
    logger.warning("Frontend dist directory not found at %s — skipping static mount", _dist)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
