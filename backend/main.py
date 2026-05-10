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
import time
from contextlib import asynccontextmanager
from typing import Optional, Set

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState

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

INITIAL_FREQ:   int   = int(os.getenv("SDR_FREQ",        "438800000"))
INITIAL_GAIN:   float = float(os.getenv("SDR_GAIN",      "49.6"))
SAMPLE_RATE:    int   = int(os.getenv("SDR_SAMPLE_RATE", "2400000"))
CHUNK_SIZE:     int   = int(os.getenv("SDR_CHUNK_SIZE",  "131072"))
FFT_PER_CHUNK:  int   = 4   # waterfall lines emitted per IQ read
N_FFT:          int   = 1024
FRONTEND_DIST:  str   = os.getenv("FRONTEND_DIST", "../frontend/dist")

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------
sdr:     SDREngine
decoder: DMRDecoder

waterfall_clients: Set[WebSocket] = set()
dmr_clients:       Set[WebSocket] = set()
audio_clients:     Set[WebSocket] = set()

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
# DMR callbacks (called from DMRDecoder background tasks)
# ---------------------------------------------------------------------------

async def on_audio(pcm: bytes) -> None:
    await broadcast_bytes(audio_clients, pcm)


async def on_meta(frame_dict: dict) -> None:
    await broadcast_json(dmr_clients, frame_dict)


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
    global sdr, decoder

    # Initialise SDR engine
    sdr = SDREngine(
        freq=INITIAL_FREQ,
        sample_rate=SAMPLE_RATE,
        gain=INITIAL_GAIN,
    )

    # Initialise DMR decoder
    decoder = DMRDecoder(audio_callback=on_audio, meta_callback=on_meta)

    # Start hardware (blocking calls wrapped)
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sdr.start)
    await decoder.start()

    # Launch SDR acquisition loop
    task = asyncio.create_task(sdr_loop(), name="sdr-loop")

    yield  # application is running

    # Shutdown
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await decoder.stop()
    sdr.stop()
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



# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

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


@app.get("/api/lookup/{dmr_id}")
async def api_lookup(dmr_id: int):
    """Look up a DMR ID on RadioID.net and return callsign + name (cached 1 h)."""
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
        return {"dmr_id": dmr_id, "callsign": "", "name": "", "city": "", "state": ""}

    results = data.get("results", [])
    if results:
        u = results[0]
        result = {
            "dmr_id":   dmr_id,
            "callsign": u.get("callsign", ""),
            "name":     f"{u.get('fname', '')} {u.get('surname', '')}".strip(),
            "city":     u.get("city", ""),
            "state":    u.get("state", ""),
        }
    else:
        result = {"dmr_id": dmr_id, "callsign": "", "name": "", "city": "", "state": ""}

    _lookup_cache[dmr_id] = (now + LOOKUP_TTL, result)
    return result


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
