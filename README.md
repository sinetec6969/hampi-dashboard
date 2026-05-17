# HamPi SDR Dashboard

**Locally-hosted multi-mode RF monitoring dashboard for Raspberry Pi.**  
No cloud. No API keys. Everything runs on-device and serves to any browser on your LAN or Tailscale network.

**Stack:** FastAPI (Python) · React/Vite · RTL-SDR · dsd-fme · meshtastic  
**Version:** 0.1.1_m3shd4ddY  
**Last updated:** 2026-05-16  

---

## ⚠️ Warnings

### DMR Audio is Choppy
DMR voice is decoded and streamed correctly, but playback is intermittently choppy on the Pi 4. Root cause is not fully resolved — `dsd-fme` writes AMBE audio in irregular bursts and Pi CPU scheduling jitter compounds the problem. **Do not rely on DMR audio for monitoring-critical use** until this is fixed. Audio tends to be cleaner in the first few minutes of a session; restart the server if it degrades.

### Multiple RTL-SDR Dongles Required for Simultaneous Modes
Each active receive mode needs its own dongle. You cannot run DMR and airband at the same time on a single dongle.

| Mode | Device | Port |
|---|---|---|
| DMR | 0 | 1234 |
| Airband AM | 1 | 1235 |
| ADS-B | dedicated (`dump1090`) | — |
| APRS | 2 (planned) | 1236 |

**Single-dongle workaround:** Set `AIRBAND_RTL_DEV=0` — but you must stop and restart the server to switch between DMR and airband. They conflict at the hardware level.

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
| **Airband AM** | ✅ Working | Scanner, squelch, AudioWorklet playback — needs 2nd dongle |
| **Meshtastic** | ✅ Working | Node map, message log, telemetry — Heltec V3 via USB |
| DMR audio | ⚠️ Partial | Decoded and streamed — choppy on Pi (see warning above) |

---

## Where We're Going

- **ADS-B** (1090 MHz) — `dump1090-fa` backend, live aircraft map with altitude colouring and track history. Needs a dedicated third RTL-SDR dongle.
- **APRS** (144.390 MHz) — `direwolf` TNC, station map with standard APRS symbols, packet log, weather data. Fourth dongle or time-share with DMR.
- **Config file** (`config.yaml`) — replace hard-coded env vars and hardcoded channel lists; talkgroup aliases, gain, squelch levels per mode.
- **Systemd service** — auto-start on boot, restart on failure.
- **Pi 5 migration** — better compute headroom for simultaneous modes.

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

### Meshtastic Mesh Monitor
- Connects to a Meshtastic LoRa device via USB serial — no SDR required
- Auto-detects the device on any serial port; retries every 10 s until found (set `MESH_PORT=/dev/ttyUSB0` to pin it)
- Decodes `NODEINFO`, `POSITION`, `TELEMETRY`, and `TEXT_MESSAGE` packets
- **Node list** — sorted by last-heard; online/offline indicator (< 15 min = online); battery level with colour coding (green/yellow/red); SNR, hop count, temperature/humidity when reported
- **Node map** — Leaflet with cyan pins for remote nodes, purple for the local node; map auto-flies to the first node with GPS on connect
- **Message log** — channel text messages with sender, timestamp, SNR; auto-scrolls to latest
- Tested with Heltec WiFi LoRa 32 V3 (CP2102N, `/dev/ttyUSB0`)

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
  - 1 dongle: DMR only (or airband only — not simultaneous)
  - 2 dongles: DMR + airband simultaneously ← current recommended setup
  - 3+ dongles: adds ADS-B and/or APRS (planned)
- **Meshtastic device** (optional, no SDR) — any Meshtastic-compatible LoRa node connected via USB
  - Tested: Heltec WiFi LoRa 32 V3 → appears as `/dev/ttyUSB0` (CP2102N chip)

## Software Dependencies

- Python 3.11+, `uvicorn`, `fastapi`, `numpy`, `scipy`, `httpx`, `meshtastic`
- Node 18+, Vite, React 19, `leaflet`, `react-leaflet`
- `dsd-fme` — must be in `$PATH`
- `rtl_tcp` from `rtl-sdr` package

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

Or for a one-time unbind without blacklisting:
```bash
echo "1-1.4" | sudo tee /sys/bus/usb/drivers/usb/unbind
```
Find your USB path with `ls /sys/bus/usb/devices/` — look for `idVendor=0bda`.

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

The Heltec V3 appears as `/dev/ttyUSB0`. Auto-detect finds it — no config needed. If you want to pin it:
```bash
MESH_PORT=/dev/ttyUSB0 uvicorn main:app --host 0.0.0.0 --port 8000
```

### Start the server

The backend manages `rtl_tcp` subprocesses and the Meshtastic connection internally:

```bash
cd backend && source venv/bin/activate

# Full stack: DMR (device 0) + airband (device 1) + Meshtastic (auto-detect)
uvicorn main:app --host 0.0.0.0 --port 8000

# Single dongle, no airband
AIRBAND_ENABLE=0 uvicorn main:app --host 0.0.0.0 --port 8000

# No Meshtastic device attached yet — disable to suppress retry log spam
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

### Meshtastic configuration

| Env var | Default | Notes |
|---|---|---|
| `MESH_ENABLE` | `1` | Set to `0` to disable entirely (suppresses retry loop) |
| `MESH_PORT` | *(auto)* | Serial port path — leave blank to auto-detect; e.g. `/dev/ttyUSB0` |

---

## Troubleshooting

### `usb_claim_interface error -6` / `Failed to open rtlsdr device`
Kernel DVB driver is holding the device. Run the blacklist command in Setup above.

### Airband scanner starts but no audio
1. Check `AIRBAND_RTL_DEV` — default is device 1. If you only have one dongle, set `AIRBAND_RTL_DEV=0` (but stop DMR first or it will conflict).
2. Try increasing `AIRBAND_SQUELCH=0.05` — if noise floor is high it may be blocking the squelch from opening.
3. Check the server log for `AirbandScanner started` — if it says `AirbandScanner failed to start` the dongle at that device index wasn't found.

### Two dongles but airband and DMR interfere / crash
Both are trying to open the same device index. Verify the device indices with `rtl_test -d 0` and `rtl_test -d 1`. Set udev rules (see Setup) to pin serial numbers.

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

### Meshtastic nodes appear but map is empty
Nodes without a GPS fix have no position and won't appear on the map. The node list will still show them. The map auto-centres when the first node with a GPS lock is heard — this can take a minute after the device boots.

---

## Architecture

```
Dongle 0 (DMR, ~440 MHz)
    └── rtl_tcp :1234
            └── SDREngine (device_index=0)
                    ├── FFT ×4 → /ws/waterfall → browser canvas
                    └── fm_demodulate → PCM 48 kHz
                            └── DMRDecoder (dsd-fme)
                                    ├── stderr → DMRFrame → /ws/dmr → browser
                                    │       └── src_id → RadioID.net + Nominatim → MapPanel
                                    └── WAV (stereo 8 kHz) → mix mono → pace → /ws/audio → AudioWorklet

Dongle 1 (Airband, 118–137 MHz)
    └── rtl_tcp :1235
            └── SDREngine (device_index=1)
                    └── am_demodulate → PCM 48 kHz (gated by squelch)
                            └── AirbandScanner
                                    ├── channel scanner (dwell / hold / hang)
                                    ├── squelch gate (audio RMS threshold)
                                    └── PCM + status → /ws/airband → AudioWorklet + freq list UI

Heltec V3 (Meshtastic, LoRa)
    └── USB serial /dev/ttyUSB0
            └── meshtastic.SerialInterface
                    └── MeshtasticHandler (pubsub → asyncio bridge)
                            ├── node registry (NODEINFO / POSITION / TELEMETRY)
                            ├── message log (TEXT_MESSAGE)
                            └── node_update / message / status → /ws/meshtastic → node map + message log
```

---

## Version History

### 0.1.1_m3shd4ddY — 2026-05-16
- **Meshtastic mesh monitor** — full implementation replacing the placeholder page.
  - `backend/meshtastic_handler.py` (new): `MeshtasticHandler` — connects via USB serial using the `meshtastic` Python package; auto-detects port or uses `MESH_PORT` env var; retries every 10 s when no device found; pypubsub callbacks bridged to asyncio via `run_coroutine_threadsafe`; decodes `NODEINFO`, `POSITION`, `TELEMETRY`, `TEXT_MESSAGE`; seeds node registry from `iface.nodes` on connect; graceful no-op if package absent.
  - `backend/main.py`: `/ws/meshtastic` WS (full node list + recent messages on connect, then live frames); `GET /api/meshtastic/status`, `/nodes`, `/messages`; handler in lifespan with graceful fallback.
  - `frontend/src/pages/MeshtasticPage.tsx`: node list (sorted by last-heard, online/offline dot, battery colour coding, SNR, hops, temp/humidity), Leaflet map (cyan remote pins, purple local pin, `MapAutoCenter` flies to first GPS fix), message log with auto-scroll, WS reconnect on close.
  - `backend/requirements.txt`: `meshtastic` added.
  - `frontend/src/App.css`: Meshtastic styles.
- **ROADMAP.md**: Meshtastic marked ✅, moved from roadmap to feature status; priority list updated.
- **README**: Meshtastic added to feature table, features section, hardware, dependencies, setup (serial/dialout), config table, troubleshooting, architecture diagram.

### 0.1-1_itbegins — 2026-05-16
- **Airband AM scanner** — full implementation replacing the placeholder page.
  - `backend/airband.py` (new): `AirbandScanner` class — owns an independent `rtl_tcp` instance on device 1/port 1235; cycles a channel list with configurable dwell time; squelch based on audio RMS with 1 s hang after signal drops; gated audio output (PCM only streamed when squelch open).
  - `backend/sdr.py`: `am_demodulate()` method (IQ → freq shift → decimate 2.4 MHz→48 kHz → `abs()` envelope → 3.5 kHz LPF → DC remove → AGC → int16 PCM); `device_index` param wired to `rtl_tcp -d` flag.
  - `backend/main.py`: `/ws/airband` WebSocket (mixed binary PCM + JSON status frames); REST endpoints `GET /api/airband/status`, `POST /api/airband/squelch`, `POST /api/airband/scan`, `POST /api/airband/channel/{idx}`; scanner integrated into lifespan with graceful fallback if device not found.
  - `frontend/src/pages/AirbandPage.tsx`: frequency list with active-channel highlight and RX blink animation, AudioWorklet audio player at 48 kHz, squelch slider, scanner toggle, setup hint when dongle not available.
  - `frontend/src/components/AudioPlayer.tsx`: parametrized with `wsPath`, `inputRate`, `label` props (defaults preserve DMR behaviour); binary-only guard on `onmessage` to ignore JSON status frames.
- **ROADMAP.md**: airband marked ✅; DMR audio choppiness warning added; multi-dongle warning with device/port table, udev rules documentation, and single-dongle workaround; priority list updated.
- **README**: warnings section added (DMR audio, multi-dongle); airband added to feature table; architecture diagram updated; setup section expanded with udev rules and airband env var reference.

### 0.0.911 — 2026-05-15
- README rewrite — new "What's Built" status table and "Where We're Going" roadmap summary; reflects current working state and pre-beta target feature set.
- GitHub repo description updated to reflect multi-mode scope.
- No code changes from 0.0.9_DASHBOARDASSEMBLE.

### 0.0.9_DASHBOARDASSEMBLE — 2026-05-15
- **Home page** — landing page at `/` with mode cards for all five dashboard modes.
- **Multi-page routing** — `react-router-dom` v6; `NavLink`-based top nav bar persists across all pages.
- **Per-mode pages** — `/dmr`, `/adsb`, `/aprs`, `/meshtastic`, `/airband`. DMR page is the full existing dashboard; coming-soon pages list planned features.
- **System info** — `GET /api/sysinfo` returns hostname, local LAN IP, Tailscale IP, and version string. Displayed on the home page hero.

### 0.0.8-1_THEYMISSEDTHEBARN — 2026-05-14
- **ROADMAP.md added** — full pre-beta roadmap covering ADS-B, APRS, Meshtastic, and airband AM reception.
- **`.gitignore` updated** — `call_history.json` and `recordings/` excluded.

### 0.0.8_stormtrooper — 2026-05-14
- **Call history panel** — persistent log of all completed DMR calls with time, duration, TG, callsign, name, city/state. Persisted to `call_history.json`, 200-call rolling window.
- **Call detection** — start on first VC* frame with non-zero `src_id`; end on next VLC header.
- **RadioID enrichment at call-end** — name/location always present in stored record.
- **Two-column layout** — signal panels in left flex column; call history in fixed 340 px right column.
- **Audio: PACE_AHEAD raised** 100 ms → 500 ms; worklet re-prime removed; initial buffer raised 150 ms → 500 ms.

### 0.0.6_th3d3vi1 — 2026-05-13
- **Waterfall click/touch-to-tune** — click or tap tunes to that frequency instantly.
- **Memory channels** — persistent channel bank (localStorage); save/recall/delete frequency+gain presets.
- **State lifted to App** — `freq`/`gain` in `App.tsx`; single `tuneTo(f, g)` path keeps all controls in sync.

### 0.0.6_thedarkphoenixrises — 2026-05-13
- **Fix: Audio silent on non-localhost HTTP** — `AudioWorklet.addModule()` blocked on plain HTTP. Two-path player: AudioWorklet on secure contexts, scheduled `AudioBufferSourceNode` fallback on plain HTTP.

### 0.0.5-2FIXEDPHOENIX — 2026-05-12
- **Fix: DMR panel active call freezes** — `lastSrcRef` never reset between transmissions; same caller on re-key failed the `!== lastSrcRef` guard. Fixed by resetting to 0 on VLC frame.

### 0.0.5-1WORKINGPHOENIX — 2026-05-12
- **Fix: FM demodulation channel filter ineffective** — 64-tap FIR at 2.4 MHz gave −0.7 dB at 12.5 kHz. Moved LPF to 48 kHz (post-decimation) where same taps give −72 dB. 53 ms headroom per chunk.
- **Fix: Irregular WAV chunk sizes** — `dsd-fme` writes 640-byte bursts; reader now accumulates into a bytearray and emits fixed-size chunks only.
- **Fix: Audio playback replaced with AudioWorklet** — dedicated real-time audio thread; gapless; linear-interp resample from 8 kHz.

### 0.0.5_WORLDWIDEBBY — 2026-05-11
- **Live caller map** — CartoDB Dark Matter tiles, Nominatim geocoding, glowing pins, callsign popups.

### Earlier versions
See full changelog in [previous README entries](https://github.com/sinetec6969/hampi-dashboard/commits/master) for 0.0.4-x, 0.0.3, and 0.0.2.

---

## Version 1.0 Roadmap

### Signal & Decoding
- [ ] ADS-B live aircraft map (`dump1090-fa`, third dongle)
- [ ] APRS decode (`direwolf`, fourth dongle or DMR time-share)
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
