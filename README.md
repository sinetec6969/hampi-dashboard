# HamPi SDR Dashboard

**Locally-hosted multi-mode RF monitoring dashboard for Raspberry Pi.**  
No cloud. No API keys. Everything runs on-device and serves to any browser on your LAN or Tailscale network.

**Stack:** FastAPI (Python) · React/Vite · RTL-SDR · dsd-fme · meshtastic · pyModeS  
**Version:** 0.1.5_py3ModeS  
**Last updated:** 2026-06-05

---

## ⚠️ Warnings

### DMR Audio is Choppy
DMR voice is decoded and streamed correctly, but playback is intermittently choppy on the Pi 4. Root cause is not fully resolved — `dsd-fme` writes AMBE audio in irregular bursts and Pi CPU scheduling jitter compounds the problem. **Do not rely on DMR audio for monitoring-critical use** until this is fixed. Audio tends to be cleaner in the first few minutes of a session; restart the server if it degrades.

### SDR Mode Switching — One Dongle at a Time
The home page SDR toggle lets you switch device 0 between DMR, Airband AM, and ADS-B without restarting the server. Only one mode is active at a time on a given dongle. For simultaneous operation you need multiple dongles — see the table below.

| Mode | Default device | Status |
|---|---|---|
| DMR | device 0 | ✅ Always active on startup |
| Airband AM | device 1 (or mode-switch to device 0) | ✅ Live |
| ADS-B | device 0 (mode-switch) or dedicated dongle | ✅ Live |
| APRS | planned | ○ Planned |

**udev rules are essential** on multi-dongle setups to keep device indices stable across reboots. Without them, a reboot may swap which dongle is device 0 and device 1. See Setup below.

---

## What's Built

| Module | Status | Notes |
|---|---|---|
| Live waterfall | ✅ Working | 1024-pt FFT, 2.4 MHz span, click-to-tune |
| DMR decode | ✅ Working | dsd-fme, timeslot / TG / ID / alias |
| RadioID lookup | ✅ Working | Callsign, name, city/state — 1 hr cache |
| Live caller map | ✅ Working | Leaflet, Nominatim geocoding, pins |
| Call history log | ✅ Working | Persisted JSON, name/location enriched |
| Memory channels | ✅ Working | localStorage, save/recall/delete |
| Dashboard home | ✅ Working | Multi-page shell, nav, mode cards |
| Tailscale access | ✅ Working | Pi Tailscale IP shown on home page |
| SDR mode switcher | ✅ Working | Switch device 0 between DMR / Airband / ADS-B from home page |
| **Airband AM** | ✅ Working | Scanner, squelch, AudioWorklet playback |
| **Meshtastic** | ✅ Working | Node map, message log, send/DM — Heltec V3 via USB |
| **ADS-B** | ✅ Working | Live aircraft map, click-to-detail, track history, altitude colouring |
| DMR audio | ⚠️ Partial | Decoded and streamed — choppy on Pi (see warning above) |

---

## Where We're Going

- **APRS** (144.390 MHz) — `direwolf` TNC, station map with standard APRS symbols, packet log, weather data. Dedicated dongle or time-share with DMR via mode switcher.
- **Config file** (`config.yaml`) — replace hard-coded env vars and hardcoded channel lists; talkgroup aliases, gain, squelch levels per mode.
- **Systemd service** — auto-start on boot, restart on failure.
- **udev rules** — stable dongle indices across reboots (critical for multi-dongle setups).

See [ROADMAP.md](ROADMAP.md) for full per-mode design notes, known issues, and priority order.

---

## Features

### Live Waterfall
- Continuous 1024-point FFT spectrum display at 2.4 MHz bandwidth
- Colour-mapped dBFS scale (blue → cyan → green → yellow → red)
- Frequency axis auto-labelled from centre frequency
- WebSocket-driven, updates as fast as the SDR loop runs
- **Click or tap to tune** — crosshair cursor with live frequency label on hover; touch tunes immediately

### Tune Control
- Frequency input (Hz) and gain slider (0–50 dB)
- POST to `/api/tune` — tunes the RTL-SDR in real time without restarting
- Status bar shows connected client counts per stream
- **Memory channels** — persistent channel bank (localStorage); save any frequency/gain with a name, recall with one tap

### SDR Mode Switcher
- Home page toggle: **DMR | Airband | ADS-B** — switches device 0 between modes without a server restart
- Switching stops the current mode cleanly (cancels tasks, kills `rtl_tcp` / `rtl_adsb`), then starts the new one
- Automatic rollback to DMR if the new mode fails to start
- For simultaneous operation, pair with a dedicated second/third dongle (see env var config below)

### DMR Decode
- `dsd-fme` decodes DMR/MOTOTRBO frames from FM-demodulated PCM
- Sync indicator goes green on active voice traffic
- Per-frame display: timeslot, frame type (VOICE/TLC/MBC/DATA), error count
- Active call info: timeslot, talkgroup, source ID, talker alias
- RadioID.net lookup for DMR IDs (callsign, name, city, state) — cached 1 hour
- Call history: persisted log of all completed calls with duration and enriched metadata

### Airband AM Reception
- AM demodulation pipeline: IQ → frequency shift → decimate 2.4 MHz→48 kHz → envelope detection → 3.5 kHz LPF → AGC → int16 PCM
- Channel scanner: cycles a named frequency list (Guard, CTAF, Center, Departure) with configurable dwell time
- Squelch: holds on active channel while audio RMS exceeds threshold; 1 s hang after signal drops; only streams audio when squelch is open (no noise between transmissions)
- AudioWorklet playback — same pipeline as DMR, 48 kHz input rate
- Frequency list panel with active channel highlight and RX indicator; click any channel to lock to it
- Squelch slider and scanner on/off toggle in the UI

### ADS-B Aircraft Tracking
- Decodes 1090 MHz ADS-B transponder broadcasts via `rtl_adsb` subprocess + `pyModeS`
- **Live Leaflet map** — aircraft plotted as `✈` icons rotated to heading, colour-coded by altitude
  - Green: < 2,000 ft · Cyan: 2,000–10,000 ft · Blue: 10,000–25,000 ft · White: > 25,000 ft
- **Click any aircraft** — detail panel shows callsign, ICAO hex, altitude, speed, heading, vertical rate (green = climbing, red = descending)
- **Track history** — gold polyline of last 60 position fixes for the selected aircraft
- **Aircraft list** — right sidebar sorted by altitude; fades stale contacts (>45 s)
- CPR position decoding: two-message odd/even pair (no reference needed); falls back to single-message with `ADSB_LAT`/`ADSB_LON` reference
- Aircraft pruned automatically after 60 s without a signal
- Map auto-fits to aircraft on first fix; works with a single dongle via mode switch or dedicated dongle via `ADSB_ENABLE=1`

### Meshtastic Mesh Monitor
- Connects to a Meshtastic LoRa device via USB serial — no SDR required
- Auto-detects the device on any serial port; retries every 10 s until found (set `MESH_PORT=/dev/ttyUSB0` to pin it)
- Decodes `NODEINFO`, `POSITION`, `TELEMETRY`, and `TEXT_MESSAGE` packets
- **Node list** — sorted by last-heard; online/offline indicator (< 15 min = online); battery level with colour coding (green/yellow/red); SNR, hop count, temperature/humidity when reported
- **Node map** — Leaflet with cyan pins for remote nodes, purple for the local node; map auto-flies to the first node with GPS on connect
- **Message log** — incoming channel text messages with sender, timestamp, SNR; auto-scrolls to latest
- **Send messages** — compose bar with Enter-to-send, real channel names from device (e.g. Primary, NCMesh), 228-byte counter
- **DM mode** — click any node to address it directly; compose bar shows `→ Node` pill; Escape cancels back to broadcast
- Tested with Heltec WiFi LoRa 32 V3 (CP2102N, `/dev/ttyUSB0`), 200-node NCMesh network

### Audio Playback
- Decoded voice streamed via WebSocket to Web Audio API
- AudioWorklet path (secure context) for gapless real-time playback; scheduled `AudioBufferSourceNode` fallback for plain HTTP
- DMR audio: 8 kHz mono PCM from dsd-fme; Airband audio: 48 kHz mono PCM from AM demodulator

### Live Caller Map
- Mercator world map (CartoDB Dark Matter tiles — no API key required)
- Each heard DMR ID geocoded via Nominatim OSM and pinned with a glowing green dot
- Click any pin for callsign, name, city/state, DMR ID, timeslot, talkgroup, and QRZ link
- Geocoding cached permanently; RadioID lookups cached 1 hour

---

## Hardware Requirements

- Raspberry Pi 4 (4 GB recommended) or Pi 5
- RTL-SDR dongle(s) — RTL-SDR Blog V4 or compatible RTL2832U device
  - 1 dongle: all modes via home-page SDR switcher (one mode active at a time)
  - 2 dongles: DMR + airband simultaneously
  - 3 dongles: DMR + airband + ADS-B simultaneously
- **Meshtastic device** (optional, no SDR) — any Meshtastic-compatible LoRa node connected via USB
  - Tested: Heltec WiFi LoRa 32 V3 → appears as `/dev/ttyUSB0` (CP2102N chip)

## Software Dependencies

- Python 3.11+, `uvicorn`, `fastapi`, `numpy`, `scipy`, `httpx`, `meshtastic`, `pyModeS`
- Node 18+, Vite, React 19, `leaflet`, `react-leaflet`
- `dsd-fme` — must be in `$PATH`
- `rtl_tcp` and `rtl_adsb` from `rtl-sdr` package

## Setup

```bash
# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install
npm run build          # builds dist/ served by FastAPI at :8000
```

### Free the RTL-SDR from the kernel DVB driver

On first boot the kernel DVB driver may claim the device. Free it once:

```bash
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null; true
```

### udev rules for stable device indices (multi-dongle)

Without udev rules, dongles can swap device indices on reboot. Pin them by serial number:

```bash
# Get serial numbers (run for each dongle index 0, 1, 2…)
rtl_eeprom -d 0
rtl_eeprom -d 1

# Set serial numbers if they're blank or colliding
rtl_eeprom -d 0 -s 00000001
rtl_eeprom -d 1 -s 00000002

# Create the rules file
sudo tee /etc/udev/rules.d/99-rtlsdr.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000001", SYMLINK+="rtlsdr0"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000002", SYMLINK+="rtlsdr1"
EOF

sudo udevadm control --reload-rules && sudo udevadm trigger
```

### Serial port access for Meshtastic (Heltec V3)

The Pi user needs to be in the `dialout` group to open USB serial ports:

```bash
sudo usermod -aG dialout $USER
# Log out and back in (or: newgrp dialout)
```

### Start the server

The backend manages `rtl_tcp` / `rtl_adsb` subprocesses and the Meshtastic connection internally:

```bash
cd backend && source venv/bin/activate

# Full stack: DMR (device 0) + airband (device 1) + Meshtastic (auto-detect)
uvicorn main:app --host 0.0.0.0 --port 8000

# Single dongle — use home-page SDR mode switcher to toggle between DMR / Airband / ADS-B
AIRBAND_ENABLE=0 uvicorn main:app --host 0.0.0.0 --port 8000

# Dedicated ADS-B dongle on device 2 (runs alongside DMR + airband)
ADSB_ENABLE=1 ADSB_RTL_DEV=2 ADSB_LAT=30.2 ADSB_LON=-97.7 uvicorn main:app --host 0.0.0.0 --port 8000

# No Meshtastic device attached yet
MESH_ENABLE=0 uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://<pi-ip>:8000/` in a browser.

### Airband configuration

| Env var | Default | Notes |
|---|---|---|
| `AIRBAND_ENABLE` | `1` | Set to `0` to disable the scanner entirely |
| `AIRBAND_RTL_DEV` | `1` | RTL-SDR device index for airband |
| `AIRBAND_RTL_PORT` | `1235` | `rtl_tcp` port for airband |
| `AIRBAND_GAIN` | `40.0` | Tuner gain in dB |
| `AIRBAND_SQUELCH` | `0.01` | Audio RMS threshold — increase if noise triggers squelch |
| `AIRBAND_DWELL_MS` | `2000` | Ms per channel when scanning |

### ADS-B configuration

| Env var | Default | Notes |
|---|---|---|
| `ADSB_ENABLE` | `0` | Set to `1` to start a dedicated decoder on boot (needs its own dongle) |
| `ADSB_RTL_DEV` | `2` | RTL-SDR device index for dedicated ADS-B dongle |
| `ADSB_GAIN` | `-1` | Tuner gain (negative = auto gain) |
| `ADSB_LAT` | `0.0` | Your latitude — enables single-message CPR fallback for faster first fix |
| `ADSB_LON` | `0.0` | Your longitude |

Without `ADSB_ENABLE=1`, ADS-B is available via the SDR mode switcher on the home page (uses device 0, stops DMR while active).

### Meshtastic configuration

| Env var | Default | Notes |
|---|---|---|
| `MESH_ENABLE` | `1` | Set to `0` to disable entirely (suppresses retry loop) |
| `MESH_PORT` | *(auto)* | Serial port path — leave blank to auto-detect; e.g. `/dev/ttyUSB0` to pin the Heltec V3 |

---

## Troubleshooting

### `usb_claim_interface error -6` / `Failed to open rtlsdr device`
Kernel DVB driver is holding the device. Run the blacklist command in Setup above.

### Airband scanner starts but no audio
1. Check `AIRBAND_RTL_DEV` — default is device 1. If you only have one dongle, use the home-page SDR mode switcher to switch to Airband mode.
2. Try increasing `AIRBAND_SQUELCH=0.05` — if noise floor is high it may be blocking the squelch from opening.
3. Check the server log for `AirbandScanner started` — if it says `AirbandScanner failed to start` the dongle at that device index wasn't found.

### ADS-B page shows no aircraft
1. Make sure the SDR is switched to ADS-B mode on the home page (or `ADSB_ENABLE=1` with a dedicated dongle).
2. Set `ADSB_LAT` / `ADSB_LON` to your location — this enables faster position decoding via single-message CPR. Without it, two messages (odd + even) are required per aircraft.
3. Aircraft near the ground or far away may not have position data yet — they'll appear in the sidebar list even without map markers.
4. Check server logs for `ADSBDecoder started` and that `rtl_adsb` is in `$PATH`.

### Two dongles but airband and DMR interfere / crash
Both are trying to open the same device index. Verify with `rtl_test -d 0` and `rtl_test -d 1`. Set udev rules (see Setup) to pin serial numbers.

### Waterfall / WebSocket errors in browser console
Stale frontend build. Hard-refresh (`Ctrl+Shift+R`) or rebuild:
```bash
cd frontend && npm run build
```

### DMR sync dot stays grey on an active channel
Two root causes fixed in v0.0.3: DSD output buffering (fixed with `stdbuf -oL`) and DSD writing metadata to stdout instead of stderr (fixed by rewriting the stream reader).

### SDR loop crashes and waterfall goes blank
`rtl_tcp` dropped the connection. The SDR loop auto-reconnects after 3 seconds. If it persists, restart the server.

### Meshtastic page shows "Searching for device…" after plugging in
1. Check `dialout` group membership: `groups $USER` — must include `dialout`. If not: `sudo usermod -aG dialout $USER` and re-login.
2. Check the port exists: `ls /dev/ttyUSB*` — Heltec V3 should appear as `/dev/ttyUSB0`.
3. Check for port conflicts: `lsof /dev/ttyUSB0` — another process (e.g. ModemManager) may have grabbed it. Disable ModemManager: `sudo systemctl disable --now ModemManager`.
4. Set `MESH_PORT=/dev/ttyUSB0` explicitly if auto-detect is missing the device.
5. Watch the server log — you should see `Meshtastic connected — device=/dev/ttyUSB0` within a few seconds of plugging in.

---

## Architecture

```
Device 0 — mode-switchable (home page toggle)
  ├─ [DMR mode — default]
  │    └── rtl_tcp :1234
  │            └── SDREngine (device_index=0)
  │                    ├── FFT ×4 → /ws/waterfall → browser canvas
  │                    └── fm_demodulate → PCM 48 kHz
  │                            └── DMRDecoder (dsd-fme)
  │                                    ├── stderr → DMRFrame → /ws/dmr → browser
  │                                    │       └── src_id → RadioID.net + Nominatim → MapPanel
  │                                    └── WAV (stereo 8 kHz) → mix mono → pace → /ws/audio → AudioWorklet
  │
  ├─ [Airband mode]
  │    └── rtl_tcp :1234
  │            └── SDREngine (device_index=0)
  │                    └── am_demodulate → PCM 48 kHz (gated by squelch)
  │                            └── AirbandScanner
  │                                    ├── channel scanner (dwell / hold / hang)
  │                                    └── PCM + status → /ws/airband → AudioWorklet + freq list UI
  │
  └─ [ADS-B mode]
       └── rtl_adsb -d 0
               └── ADSBDecoder (pyModeS)
                       ├── DF-17 decode → ICAO, callsign, alt, position (CPR), velocity
                       ├── aircraft registry (60-pt track, 60s expiry)
                       └── aircraft updates → /ws/adsb → Leaflet map + detail panel

Device 1 (Airband, 118–137 MHz) — optional dedicated dongle
  └── rtl_tcp :1235
          └── AirbandScanner (device_index=1, independent of mode switcher)

Device 2 (ADS-B, 1090 MHz) — optional dedicated dongle (ADSB_ENABLE=1)
  └── rtl_adsb -d 2
          └── ADSBDecoder (independent of mode switcher)

Heltec V3 (Meshtastic, LoRa) — no SDR
  └── USB serial /dev/ttyUSB0
          └── meshtastic.SerialInterface
                  └── MeshtasticHandler (pubsub → asyncio bridge)
                          ├── node registry (NODEINFO / POSITION / TELEMETRY)
                          ├── message log (TEXT_MESSAGE)
                          └── node_update / message / status → /ws/meshtastic → node map + message log
```

---

## Version History

### 0.1.5_py3ModeS — 2026-06-05
- **ADS-B fix: pyModeS v3 API migration** — `adsb.py` rewrote from scratch for pyModeS 3.3.0 which dropped the entire v2 function API (`pms.df()`, `pms.icao()`, `pms.adsb.*`). The v2 calls were silently crashing inside the decode loop (swallowed by broad `except`), so the decoder accepted messages but produced nothing.
  - Now uses `pms.Message(hex)` → `.df`, `.icao`, `.typecode`, `.decode()` for per-message parsing.
  - Position: `pyModeS.position.airborne_position_pair(even_lat, even_lon, odd_lat, odd_lon, even_is_newer=bool)` and `airborne_position_with_ref(fmt, cpr_lat, cpr_lon, lat_ref, lon_ref)` — both take raw CPR integer fields from `decode()`, not message objects.
  - Velocity: extracted from `decode()` dict as `groundspeed` / `track` / `vertical_rate`.
  - CPR state per aircraft now stores `(cpr_lat_raw, cpr_lon_raw, timestamp)` instead of `(msg_hex, timestamp)`.

### 0.1.4_THEPLANES — 2026-06-04
- **ADS-B aircraft tracking** — live map of 1090 MHz transponder broadcasts.
  - `backend/adsb.py` (new): `ADSBDecoder` — subprocess wraps `rtl_adsb`; parses `*HEXMSG;` output; decodes DF-17 Extended Squitter via `pyModeS`; callsign (TC 1-4), CPR airborne position (TC 9-18, two-message odd/even pair + single-message reference fallback), velocity/heading/vrate (TC 19); aircraft registry with 60-point track history; prunes stale contacts after 60 s.
  - `backend/main.py`: `ADSB_ENABLE`, `ADSB_RTL_DEV`, `ADSB_GAIN`, `ADSB_LAT`, `ADSB_LON` env vars; `adsb_decoder` global (dedicated dongle) + `_mode_adsb` (mode-switched); `on_adsb_aircraft` callback; `/ws/adsb` WebSocket (snapshot on connect, then live updates); `GET /api/adsb/aircraft`, `GET /api/adsb/status`.
  - `backend/requirements.txt`: `pyModeS` added.
  - `frontend/src/pages/ADSBPage.tsx`: CartoDB Dark Matter Leaflet map; `✈` markers rotated to heading, colour-coded by altitude (green/cyan/blue/white); click → gold highlight + track polyline; detail panel (callsign, ICAO, altitude, speed, heading, vertical rate); aircraft list sorted by altitude; `MapFitter` auto-fits bounds on first data; stale aircraft fade at 45 s.
- **SDR mode switcher** — home page toggle switches device 0 between DMR, Airband, and ADS-B without a server restart.
  - `POST /api/sdr/mode?mode=dmr|airband|adsb` — clean stop-then-start with automatic DMR rollback on failure.
  - `GET /api/sdr/mode` — returns active mode.
  - `frontend/src/pages/Home.tsx`: three-button toggle (DMR / Airband / ADS-B); loading state during switch; active mode highlighted green.

### 0.1.3_s3ndIt — 2026-05-17
- **Meshtastic send messages** — two-way messaging from the dashboard.
  - `backend/meshtastic_handler.py`: `send_text(text, destination, channel)` — runs `sendText()` in thread executor; `get_channels()` — parses `localNode.channels` protobuf list into `[{index, name, role}]`, surfacing named channels (e.g. "NCMesh") correctly.
  - `backend/main.py`: `POST /api/meshtastic/send` (validates UTF-8 byte length ≤ 228, 503 when disconnected); `GET /api/meshtastic/channels`.
  - `frontend`: compose bar with text input (Enter to send), channel picker (real names from device), 228-byte character counter, send button. DM mode — select a node in the list to address a direct message; compose shows `→ ShortName` pill, Escape/× cancels to broadcast. Sent messages echoed optimistically to the log in green as "You". Send error banner auto-dismisses after 4 s. Message panel height 140 → 220 px.

### 0.1.2_m3shPAPI — 2026-05-17
- **Meshtastic handler field corrections** — verified against meshtastic 2.7.8 package source before first live connection; fixed three bugs that would have silently misbehaved on real hardware.
- **`test_meshtastic.py`** — smoke test script.
- **Home page** — Airband and Meshtastic cards updated from `coming-soon` to `live`.
- **Confirmed live on hardware** — Heltec WiFi LoRa 32 V3 connected on `/dev/ttyUSB0`; 200-node mesh DB loaded on connect.

### 0.1.1_m3shd4ddY — 2026-05-16
- **Meshtastic mesh monitor** — full implementation replacing the placeholder page.

### 0.1-1_itbegins — 2026-05-16
- **Airband AM scanner** — full implementation replacing the placeholder page.

### 0.0.911 — 2026-05-15
- README rewrite and GitHub repo description update.

### 0.0.9_DASHBOARDASSEMBLE — 2026-05-15
- Home page, multi-page routing, per-mode pages, `/api/sysinfo`.

### Earlier versions
See full changelog in [git history](https://github.com/sinetec6969/hampi-dashboard/commits/master) for 0.0.8 and earlier.

---

## Version 1.0 Roadmap

### Signal & Decoding
- [x] ADS-B live aircraft map (`rtl_adsb` + `pyModeS`) ← done in 0.1.4_THEPLANES
- [ ] APRS decode (`direwolf`, dedicated dongle or mode-switch)
- [x] Meshtastic node monitor (USB serial, no SDR) ← done in 0.1.1_m3shd4ddY
- [ ] Trunked DMR system support (control channel parsing)
- [ ] P25 Phase 1 & 2, NXDN, D-STAR

### Audio
- [ ] Fix DMR audio choppiness (highest priority)
- [ ] Audio recording — save decoded voice to timestamped WAV per call
- [ ] Per-talkgroup squelch and mute
- [ ] Volume control slider

### Configuration & Infrastructure
- [ ] `config.yaml` — frequencies, channel lists, talkgroup aliases, squelch levels
- [ ] Systemd service file for auto-start on boot
- [ ] udev rules generator in setup script

### DMR Intelligence
- [ ] Talkgroup alias CSV import (map TG numbers to friendly names)
- [ ] Full RadioID.net database import for offline ID lookups
