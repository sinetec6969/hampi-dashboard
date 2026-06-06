# HamPi SDR Dashboard `v0.2.1_piperrrrr`

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-asyncio-009688?style=flat-square&logo=fastapi&logoColor=white)
![RTL-SDR](https://img.shields.io/badge/RTL--SDR-Blog_V4-ff6600?style=flat-square)
![Version](https://img.shields.io/badge/version-0.2.1__piperrrrr-brightgreen?style=flat-square)

---

## The Vision

> **A $50 Raspberry Pi that sees everything in the air around you — and shows it in a browser.**

One Pi. A couple of RTL-SDR dongles. A dark browser tab on your phone or laptop.  
Every signal decoded. Every aircraft tracked. Every mesh node mapped. Every packet logged.  
**No cloud. No subscription. No data leaving your network. Ever.**

This is a full RF situational awareness stack built from commodity hardware and open-source tools. The goal is a single self-hosted device that gives you total visibility into the radio environment around you — digital voice, aviation transponders, airband comms, LoRa mesh, satellite telemetry, APRS packet radio — all decoded on-device, all accessible from a browser on your LAN or over Tailscale.

**Where we're at right now:**

| Layer | Status | What's working |
|---|---|---|
| 📡 DMR digital voice | ✅ Live | Decode · talkgroup/ID · caller map · RadioID lookup · call history |
| ✈️ ADS-B 1090 MHz | ✅ Live | Live aircraft map · CPR position · altitude/speed/heading · track history |
| 🛩️ Airband AM | ✅ Live | 118–137 MHz scanner · squelch · real-time audio |
| 🌐 Meshtastic LoRa | ✅ Live | 200-node mesh · node map · live messages · send/DM |
| 📊 Waterfall | ✅ Live | 2.4 MHz FFT · click-to-tune · memory channels |
| 📱 Mobile UI | ✅ Live | Responsive layout · auto-detects phone vs desktop |
| 📻 APRS | 🔨 Next | `direwolf` TNC · station map · packet log |
| 🛰️ Satellite telemetry | 🗺️ Planned | RTL-SDR LoRa decode · TinyGS upload · pass prediction |
| 🔒 config.yaml | 🗺️ Planned | Replace env vars · editable channel/talkgroup lists |
| 🚀 Systemd service | 🗺️ Planned | Auto-start on boot |

One dongle runs all SDR modes via a mode-switcher. Add more dongles to run them simultaneously.

---

## What It Does

---

## Live on Hardware

Everything below is **verified running** on a Raspberry Pi 4 with one RTL-SDR Blog V4 and a Heltec WiFi LoRa 32 V3.

```
✅ DMR voice decode      ✅ Airband AM scanner
✅ ADS-B aircraft map    ✅ Meshtastic mesh monitor
✅ Live waterfall        ✅ SDR mode switcher
✅ RadioID lookups       ✅ Caller geocode map
✅ Call history          ✅ Memory channels
✅ Meshtastic send/DM    ✅ Tailscale remote access
```

---

## Features

### 📱 Mobile-Responsive Layout

The dashboard detects desktop vs. mobile via a `useIsMobile()` hook (`window.matchMedia ≤768px`) and applies a full responsive CSS override:

- **Nav** — links scroll horizontally on narrow screens
- **ADS-B** — map fills top half of screen; aircraft list below
- **Meshtastic** — node list, map, and message panel stack vertically
- **Airband** — frequency list above controls
- **DMR** — columns stack; waterfall shrinks to 120 px
- **Home** — single-column card grid
- iOS input-zoom fix (`font-size: 16px` on compose input)

Desktop layout is completely unchanged — the media query only fires below 768 px.

---

### ✈️ ADS-B — Live Aircraft Map

Switch to ADS-B mode and watch aircraft populate a dark Leaflet map in real time.

- `rtl_adsb` + `pyModeS` decode DF-17 Extended Squitter at 1090 MHz
- Aircraft icons (`✈`) rotate to heading, colour-coded by altitude — green at low altitude fading to white at cruise
- **Click any aircraft** for ICAO hex, callsign, altitude, speed, heading, vertical rate (colour-coded climb/descent)
- **Gold track polyline** shows the last 60 position fixes for the selected contact
- Sidebar grid: ID · HDG · SPD columns, refreshes every second, contacts roll off after 10 s silence
- CPR position decoding — two-message odd/even pair first; falls back to single-message with a reference coordinate
- Works with one dongle (mode-switch) or a dedicated `ADSB_ENABLE=1` dongle

### 📡 DMR — Voice Decode & Caller Intelligence

- `dsd-fme` decodes DMR/MOTOTRBO Tier II from FM-demodulated IQ (`-o null` — metadata only, no audio output)
- Per-frame metadata: timeslot, frame type, color code, talkgroup, source ID, talker alias
- **RadioID.net lookup** — callsign, name, city/state for every heard DMR ID (1-hour cache)
- **Caller map** — Nominatim geocoding pins every heard station on a world map; click for full ID card + QRZ link
- **Call history** — persisted JSON log of every completed call with duration, enriched metadata, and timestamps

### 🛩️ Airband AM — Channel Scanner

- Full AM demodulation pipeline: IQ → freq shift → decimate 2.4 MHz→48 kHz → envelope detect → 3.5 kHz LPF → AGC → PCM
- Scans Guard, CTAF, Center, Departure — configurable channel list and dwell time
- Squelch with 1-second hang: streams audio only when a signal is present, silent otherwise
- Active channel highlighted in the UI; click any channel to lock to it
- AudioWorklet playback at 48 kHz

### 🌐 Meshtastic — Mesh Network Monitor

- Connects to any Meshtastic device via USB serial — no SDR needed
- Auto-detects the device; retries every 10 s until found
- **Node map** — Leaflet, cyan pins for remote nodes, purple for local; auto-flies to first GPS node on connect
- **Node list** — online/offline indicator, battery level (colour-coded), SNR, hop count, temperature/humidity
- **Message log** — channel text messages with sender, timestamp, SNR; live-scrolls
- **Send & DM** — compose bar with real channel names from device (e.g. NCMesh), 228-byte counter, Enter-to-send
- Click any node to enter DM mode; pill shows `→ ShortName`; Escape cancels to broadcast
- Tested live: Heltec WiFi LoRa 32 V3, 200-node NCMesh network

### 📊 Waterfall & Tuning

- 1024-point FFT, 2.4 MHz bandwidth, Blackman window, dBFS scale
- WebSocket-driven — updates as fast as the SDR read loop (~18 fps)
- **Click to tune** — crosshair cursor with live frequency label; touch-friendly
- Frequency input + gain slider; real-time retune without restart
- **Memory channels** — save frequency/gain combos with a name; recall with one tap (localStorage)

### 🔀 SDR Mode Switcher

- Home page toggle switches device 0 between **DMR | Airband | ADS-B** without a server restart
- Clean handoff: current mode stops (task cancel + subprocess kill), new mode starts
- Automatic rollback to DMR if the new mode fails
- Scale to multiple dongles: each mode can get a dedicated device

---

## Hardware

| | Requirement |
|---|---|
| **Pi** | Raspberry Pi 4 (4 GB+ recommended) or Pi 5 |
| **SDR** | RTL-SDR Blog V4 or any RTL2832U dongle |
| **Dongles** | 1 → mode-switch all SDR modes · 2 → DMR + Airband · 3 → all simultaneous |
| **Mesh** | Any Meshtastic USB device (optional) — tested with Heltec WiFi LoRa 32 V3 |

---

## Setup

### Dependencies

```bash
# System packages
sudo apt install rtl-sdr dsd-fme

# Free the dongle from the kernel DVB driver (one-time)
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null; true

# Serial access for Meshtastic
sudo usermod -aG dialout $USER
```

### Build & Run

```bash
# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install && npm run build   # output served by FastAPI at :8000

# Start
cd ../backend && source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://<pi-ip>:8000` in any browser on your LAN.

### Single-dongle quickstart

```bash
# One dongle: disable dedicated airband (use mode-switcher instead)
AIRBAND_ENABLE=0 uvicorn main:app --host 0.0.0.0 --port 8000
```

### Multi-dongle

```bash
# DMR (device 0) + Airband (device 1) + ADS-B (device 2)
ADSB_ENABLE=1 ADSB_RTL_DEV=2 ADSB_LAT=30.2 ADSB_LON=-97.7 \
  uvicorn main:app --host 0.0.0.0 --port 8000
```

### Stable dongle indices (udev)

Without udev rules, dongles swap device indices on reboot. Pin by serial number:

```bash
rtl_eeprom -d 0 -s 00000001
rtl_eeprom -d 1 -s 00000002

sudo tee /etc/udev/rules.d/99-rtlsdr.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000001", SYMLINK+="rtlsdr0"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000002", SYMLINK+="rtlsdr1"
EOF

sudo udevadm control --reload-rules && sudo udevadm trigger
```

### Configuration reference

**ADS-B**

| Env var | Default | Notes |
|---|---|---|
| `ADSB_ENABLE` | `0` | `1` = dedicated decoder on boot |
| `ADSB_RTL_DEV` | `2` | Device index for dedicated dongle |
| `ADSB_GAIN` | `-1` | Negative = auto gain |
| `ADSB_LAT` / `ADSB_LON` | `0.0` | Your location — enables single-message CPR fallback |

**Airband**

| Env var | Default | Notes |
|---|---|---|
| `AIRBAND_ENABLE` | `1` | `0` = disable |
| `AIRBAND_RTL_DEV` | `1` | Device index |
| `AIRBAND_RTL_PORT` | `1235` | `rtl_tcp` port |
| `AIRBAND_GAIN` | `40.0` | dB |
| `AIRBAND_SQUELCH` | `0.01` | RMS threshold — raise if noise opens squelch |
| `AIRBAND_DWELL_MS` | `2000` | Ms per channel when scanning |

**Meshtastic**

| Env var | Default | Notes |
|---|---|---|
| `MESH_ENABLE` | `1` | `0` = disable |
| `MESH_PORT` | *(auto)* | e.g. `/dev/ttyUSB0` to pin the port |

---

## Architecture

```
Device 0 — mode-switchable (home page toggle)
  ├─ [DMR]
  │    └── rtl_tcp :1234 → SDREngine
  │                └── fm_demodulate → 48 kHz PCM → dsd-fme stdin (-o null)
  │                        └── stderr → DMRFrame → /ws/dmr → caller map + call history
  │
  ├─ [Airband]
  │    └── rtl_tcp :1234 → SDREngine
  │                └── am_demodulate → 48 kHz PCM (squelch-gated)
  │                        └── AirbandScanner → /ws/airband → AudioWorklet + freq list
  │
  └─ [ADS-B]
       └── rtl_adsb -d 0 → ADSBDecoder (pyModeS v3)
                   └── DF-17 → ICAO · callsign · CPR position · velocity
                           └── /ws/adsb → Leaflet map · sidebar · track polyline

Device 1 — optional dedicated Airband dongle (AIRBAND_RTL_DEV=1)
Device 2 — optional dedicated ADS-B dongle (ADSB_ENABLE=1, ADSB_RTL_DEV=2)

Heltec V3 (LoRa) — USB serial → MeshtasticHandler
  └── pubsub → asyncio bridge → /ws/meshtastic → node map · messages · send/DM

FFT (all SDR modes) → /ws/waterfall → browser canvas (click-to-tune)
```

---

## Troubleshooting

**`usb_claim_interface error -6` / device won't open**
Kernel DVB driver has the device. Run the blacklist step in Setup.

**Airband: no audio**
Default is device 1. With one dongle, use the home-page mode switcher instead of `AIRBAND_ENABLE=1`. Raise `AIRBAND_SQUELCH` if noise opens the gate.

**ADS-B: no aircraft**
Switch to ADS-B mode on the home page (or `ADSB_ENABLE=1`). Set `ADSB_LAT`/`ADSB_LON` for faster first position fix — without them, two CPR frames per aircraft are required before a position appears. Aircraft without position still show in the sidebar.

**Two dongles interfering**
Both trying the same device index. Set udev rules to pin by serial number (see Setup).

**Waterfall goes blank**
`rtl_tcp` dropped. The SDR loop reconnects automatically after 3 s. If it loops, restart the server.

**Meshtastic: "Searching for device…"**
Check `groups $USER` includes `dialout`. Check `ls /dev/ttyUSB*` exists. Kill ModemManager if it grabbed the port: `sudo systemctl disable --now ModemManager`.

---

## Roadmap

### Coming next
- [ ] **APRS** — `direwolf` TNC, station map, packet log, weather beacon decode
- [ ] **config.yaml** — replace env vars; editable channel/talkgroup lists
- [ ] **Systemd service** — auto-start and restart on boot
- [ ] **ADS-B flight lookup** — local `aircraft.csv` for airline/registration data

### Further out

#### Satellite Telemetry (433 MHz / TinyGS)

Receive and decode satellite LoRa telemetry with the RTL-SDR and upload frames to the [TinyGS](https://tinygs.com) ground station network.

**Architecture:**
```
RTL-SDR (mode-switch or dedicated dongle)
  └─ rtl_sdr subprocess → raw IQ at 250 kHz, tuned to sat freq
       └─ rtl-lora (C) OR Python numpy chirp demodulator
            └─ decoded packet bytes + RSSI/SNR
                 └─ satellite.py (SatelliteDecoder)
                      ├─ MQTT → mqtt.tinygs.com  (paho-mqtt)
                      ├─ /ws/satellite  WebSocket
                      └─ /api/satellite/* REST
```

**Phases:**
1. **Research** — clone `tinygs/tinyGS` for satellite DB (freq/SF/BW/CR per sat); confirm MQTT payload format; pick target sats visible from this location
2. **LoRa decoder** — try `rtl-lora` (lightweight C, no GNU Radio) first; fall back to Python/numpy chirp dechirp → FFT → grey decode → Hamming FEC if needed; target SF7–SF12, BW 125/250/500 kHz
3. **TinyGS MQTT upload** — `paho-mqtt`; payload `{ "packet": "<base64>", "rssi", "snr", "frequency", "satelliteName" }`; register Pi as TinyGS station
4. **Dashboard page** — `SatellitePage.tsx`: live packet log, hex/ASCII frame dump, RSSI/SNR, satellite name + pass time, upload status badge
5. **Pass prediction** *(stretch)* — `skyfield` + Celestrak TLE fetch; auto-tune RTL-SDR on approach; show next pass time and elevation arc

**Dependencies:** `paho-mqtt` (pip), `skyfield` (pip, stretch), `rtl-lora` (build from source)

**Open questions before starting:**
- One RTL-SDR dongle (mode-switch) or dedicated second dongle for satellite?
- Use `rtl-lora` C tool or build Python numpy demodulator from scratch?
- TinyGS account for MQTT credentials, or local-only display first?

**Fallback:** Heltec WiFi LoRa 32 V3 is a TinyGS-compatible device — if pure-SDR LoRa decode proves unreliable, a second Heltec (~$12) gives a rock-solid hardware receiver; Pi handles MQTT upload and dashboard only.

---

#### AX.25 Packet Terminal

Raw AX.25 frame monitoring and a connected-mode terminal via `direwolf` KISS TNC — packet BBS access, digipeater trace, and heard-station log, all in-browser.

**Architecture:**
```
RTL-SDR (or VHF radio + audio in)
  └─ direwolf (TNC) — KISS over TCP port 8001
       └─ ax25.py (AX25Decoder)
            ├─ UI frames → heard-stations table + raw frame log
            ├─ Connected sessions (SABM/UA/I-frames) → terminal relay
            ├─ /ws/ax25        WebSocket (live frame stream)
            └─ /api/ax25/*     REST (heard list, frame history)
```

**Phases:**
1. **KISS framing** — `direwolf` launched with `KISSPORT 8001`; Python asyncio KISS TCP client; strip framing, emit raw AX.25 bytes
2. **Frame decode** — parse address field (source, dest, up to 8 digipeaters), control byte (UI / SABM / UA / I / S), PID, info field; log to rolling deque
3. **Dashboard page** — `AX25Page.tsx`: live frame log (timestamp · source · dest · via path · info), heard-stations table sorted by last-seen, hex/ASCII frame dump panel
4. **Connected terminal** *(stretch)* — relay SABM/I-frame exchange over a second WebSocket; in-browser terminal for packet BBS or node connects (W2XSC BBS, etc.)
5. **Beacon inject** *(stretch)* — `ax25.write()` via KISS; transmit beacon or position frame through a connected radio (requires TX-capable rig)

**Dependencies:** `direwolf` (already needed for APRS), no additional pip packages — pure asyncio KISS client

**Open questions before starting:**
- Share `direwolf` instance with APRS (multiple KISS clients on same port) or run a second instance on a different port?
- RX-only packet monitor first, or target connected-mode terminal from the start?
- VHF audio in from radio discriminator, or stick with RTL-SDR direct?

---

- [ ] Trunked DMR (control channel parsing)
- [ ] P25 Phase 1 & 2, NXDN, D-STAR
- [ ] ADS-B range rings, squawk alerts, ICAO watchlist
- [ ] Talkgroup alias CSV import
- [ ] Offline RadioID database

---

## Version History

### 0.2.1_piperrrrr — 2026-06-05
- **Mobile-responsive layout** — `useIsMobile()` hook + CSS media query block (≤768 px). All pages adapt: ADS-B map stacks above list, Meshtastic node list/map/messages go vertical, Airband freq list above controls, DMR columns stack. Nav links scroll horizontally. iOS input-zoom fix.
- **DMR audio removed** — AMBE decode via `dsd-fme` UDP was consistently unreliable (sample-rate mismatch, slomo playback). Removed cleanly: `-o null` flag, `/ws/audio` WebSocket, `audio_clients`, `AudioCallback`, UDP socket listener. DMR page now metadata-only (map, call history, talkgroup decode).
- **Satellite telemetry roadmap** — full architecture plan for RTL-SDR + LoRa decode + TinyGS MQTT upload added to roadmap.
- **AX.25 packet terminal roadmap** — architecture plan for KISS TNC client, raw frame log, heard-stations table, and connected-mode terminal added to roadmap.

### 0.2.0_n3wb361nn1n6 — 2026-06-05
- **DMR audio fix** — replaced WAV file polling with dsd-fme UDP output (`-o udp:127.0.0.1:23456`). Root cause: libc stdio buffered ~4 KB before flush, causing audio to arrive in ~120 ms irregular bursts. Now event-driven at AMBE frame cadence (20 ms/packet). Verified live: 331 WebSocket frames in 8 seconds during an active call.
- **ADS-B UI** — per-second map/list refresh; 10 s frontend stale rolloff (backend retains 60 s for CPR); ID · HDG · SPD column layout in sidebar; panel widened to 272 px.
- **ADS-B decoder** — full rewrite for pyModeS 3.3.0 (v2 API dropped upstream; calls were silently failing).

### 0.1.4_THEPLANES — 2026-06-04
- ADS-B aircraft tracking — live 1090 MHz map, CPR position decode, velocity, track history, mode switcher integration.

### 0.1.3_s3ndIt — 2026-05-17
- Meshtastic two-way messaging — send/DM, real channel names, 228-byte counter.

### 0.1.2_m3shPAPI — 2026-05-17
- Meshtastic live on hardware — first verified connection, 200-node mesh.

### 0.1.1_m3shd4ddY — 0.1-1_itbegins — 2026-05-16
- Meshtastic monitor and Airband AM scanner — full implementations.

### 0.0.9_DASHBOARDASSEMBLE — 2026-05-15
- Multi-page dashboard shell, home page, per-mode routing, sysinfo API.

[Full commit history →](https://github.com/sinetec6969/hampi-dashboard/commits/master)
