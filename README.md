# HamPi SDR Dashboard

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-asyncio-009688?style=flat-square&logo=fastapi&logoColor=white)
![RTL-SDR](https://img.shields.io/badge/RTL--SDR-Blog_V4-ff6600?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Raspberry_Pi-c51a4a?style=flat-square&logo=raspberry-pi&logoColor=white)

---

> **A $50 Raspberry Pi that sees everything in the air around you — and shows it in a browser.**

One Pi. A couple of RTL-SDR dongles. A dark browser tab on your phone or laptop.  
Digital voice decoded. Aircraft tracked. Mesh nodes mapped. SSTV images received. Packets logged.  
**No cloud. No subscription. No data leaving your network. Ever.**

---

## What's Live

| Mode | Status | What it does |
|---|---|---|
| 📡 DMR Digital Voice | ✅ Live | Decode · talkgroup/ID · caller map · RadioID lookup · call history |
| ✈️ ADS-B 1090 MHz | ✅ Live | Live aircraft map · CPR position · altitude/speed/heading · track history |
| 🛩️ Airband AM | ✅ Live | 118–137 MHz scanner · squelch · real-time AudioWorklet playback |
| 🌐 Meshtastic LoRa | ✅ Live | Mesh monitor · node map · live messages · send / DM |
| 📺 SSTV | ✅ Live | Scottie S1/S2 · Martin M1/M2 · Robot 36 · live canvas · image gallery |
| 📊 Waterfall | ✅ Live | 2.4 MHz FFT · click-to-tune · memory channels |
| 📱 Mobile UI | ✅ Live | Responsive layout · auto-detects phone vs desktop |
| 📻 APRS | 🔨 Next | `direwolf` TNC · station map · packet log |
| 🛰️ Satellite | ✅ Live | TinyGS hardware receiver (LilyGO T3 LoRa32) · local MQTT broker · live telemetry + RX packet feed |

One dongle covers all SDR modes via the home-page mode-switcher. Add more dongles to run them simultaneously.

---

## Hardware

| | |
|---|---|
| **Pi** | Raspberry Pi 4 (4 GB+) or Pi 5 |
| **SDR** | RTL-SDR Blog V4 or any RTL2832U dongle |
| **Dongles** | 1 → mode-switch all SDR modes · 2 → DMR + Airband · 3 → all simultaneous |
| **Mesh** | Any Meshtastic USB device (optional) — tested: Heltec WiFi LoRa 32 V3 |

---

## Setup

```bash
# One-time: free the dongle from the kernel DVB driver
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null; true

# System packages
sudo apt install rtl-sdr dsd-fme

# Serial access (Meshtastic)
sudo usermod -aG dialout $USER

# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install && npm run build

# Run
cd ../backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://<pi-ip>:8000` in any browser on your LAN. Works over [Tailscale](https://tailscale.com) too.

### Single-dongle quickstart

```bash
AIRBAND_ENABLE=0 uvicorn main:app --host 0.0.0.0 --port 8000
```

### Multi-dongle (all modes simultaneously)

```bash
ADSB_ENABLE=1 ADSB_RTL_DEV=2 ADSB_LAT=30.2 ADSB_LON=-97.7 \
  uvicorn main:app --host 0.0.0.0 --port 8000
```

### Stable dongle indices across reboots

```bash
# Write serial numbers to EEPROM (one-time)
rtl_eeprom -d 0 -s 00000001
rtl_eeprom -d 1 -s 00000002

# Pin by serial with udev
sudo tee /etc/udev/rules.d/99-rtlsdr.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000001", SYMLINK+="rtlsdr0"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000002", SYMLINK+="rtlsdr1"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

---

## Configuration

### SDR mode switcher (device 0)

| Mode | Command |
|---|---|
| DMR (default) | home page → DMR |
| Airband AM | home page → Airband |
| ADS-B | home page → ADS-B |
| SSTV | home page → SSTV |

### Environment variables

**ADS-B**

| Var | Default | Notes |
|---|---|---|
| `ADSB_ENABLE` | `0` | `1` = dedicated decoder on boot (needs own dongle) |
| `ADSB_RTL_DEV` | `2` | Device index for dedicated dongle |
| `ADSB_GAIN` | `-1` | Negative = auto gain |
| `ADSB_LAT` / `ADSB_LON` | `0.0` | Your location — enables single-message CPR fallback |

**Airband**

| Var | Default | Notes |
|---|---|---|
| `AIRBAND_ENABLE` | `1` | `0` = disable dedicated scanner |
| `AIRBAND_RTL_DEV` | `1` | Device index |
| `AIRBAND_RTL_PORT` | `1235` | `rtl_tcp` port |
| `AIRBAND_GAIN` | `40.0` | dB |
| `AIRBAND_SQUELCH` | `0.01` | RMS threshold — raise if noise trips squelch |
| `AIRBAND_DWELL_MS` | `2000` | ms per channel when scanning |

**SSTV**

| Var | Default | Notes |
|---|---|---|
| `SSTV_FREQ` | `145800000` | Receive frequency Hz — ISS/2m default |
| `SSTV_GAIN` | `40.0` | dB |
| `SSTV_IMAGE_DIR` | `sstv_images/` | Where completed PNGs are saved |

**Meshtastic**

| Var | Default | Notes |
|---|---|---|
| `MESH_ENABLE` | `1` | `0` = disable |
| `MESH_PORT` | *(auto)* | e.g. `/dev/ttyUSB0` to pin the port |

---

## Features

### 📺 SSTV — Image Decoder

Switch device 0 to SSTV mode and receive Slow Scan Television images in your browser.

- **Modes:** Scottie S1 (VIS 60), Scottie S2 (56), Martin M1 (44), Martin M2 (40), Robot 36 (8)
- **Decode pipeline:** VIS header detection (1900 Hz leader → 1200 Hz break → 7-bit VIS code + parity) → per-line sync hunt → Hilbert instantaneous-frequency channel decode at 48 kHz → RGB assembly
- **Robot 36:** full YCbCr→RGB conversion with alternating Cr/Cb scan lines
- **Live canvas** fills top-to-bottom as scan lines arrive; decode progress bar shows line count
- **Gallery** of all received PNGs; click any image for a full-screen lightbox
- Images saved to `sstv_images/sstv_YYYYMMDD_HHMMSS.png` via Pillow
- Default frequency: 145.800 MHz (ISS SSTV events, 2m SSTV activity)

### ✈️ ADS-B — Live Aircraft Map

- `rtl_adsb` + pyModeS 3.3.0 decode DF-17 Extended Squitter at 1090 MHz
- Aircraft icons (`✈`) rotate to heading, colour-coded by altitude
- **Click any aircraft** for ICAO hex, callsign, altitude, speed, heading, vertical rate
- **Gold track polyline** — last 60 position fixes for the selected contact
- CPR position: odd/even pair primary; single-message reference fallback
- Sidebar refreshes every second; contacts roll off after 10 s silence

### 📡 DMR — Caller Intelligence

- `dsd-fme` decodes DMR/MOTOTRBO Tier II metadata: timeslot, CC, talkgroup, source ID, talker alias
- **RadioID.net lookup** — callsign + name for every heard ID (1-hour cache)
- **Caller map** — Nominatim geocodes city/state; click pin for full ID card
- **Call history** — persisted JSON log; survives server restarts

### 🛩️ Airband AM — Channel Scanner

- Full AM demod: IQ → freq shift → decimate 2.4 MHz→48 kHz → envelope → 3.5 kHz LPF → AGC → int16 PCM
- Scans Guard, CTAF, Center, Departure with configurable dwell and squelch hang
- AudioWorklet playback at 48 kHz; click any channel to lock; squelch slider

### 🌐 Meshtastic — Mesh Monitor

- Auto-detects any USB Meshtastic device; reconnects every 10 s
- **Node map** — Leaflet, online/offline indicator, battery, SNR, hop count
- **Message log** — live-scrolling, channel + DM mode, 228-byte counter
- Tested: Heltec WiFi LoRa 32 V3 on a 200-node NCMesh network

### 📊 Waterfall & Tuning

- 1024-point FFT, 2.4 MHz bandwidth, Blackman window, dBFS
- **Click to tune** — crosshair + live frequency label; touch-friendly
- Memory channels (localStorage) — save freq/gain combos, recall in one tap

### 🔀 SDR Mode Switcher

- Home-page toggle switches device 0 between **DMR · Airband · ADS-B · SSTV** — no server restart
- Clean handoff: subprocess killed, new mode starts, SDR retuned
- Automatic rollback to DMR on failure

---

## Architecture

```
Device 0 — mode-switchable (home page toggle)
  ├─ [DMR]
  │    └─ rtl_tcp :1234 → SDREngine → fm_demodulate → 48 kHz PCM
  │                             └─ dsd-fme stdin → DMRDecoder
  │                                  └─ /ws/dmr → caller map · call history
  ├─ [Airband]
  │    └─ rtl_tcp :1234 → SDREngine → am_demodulate → 48 kHz PCM (squelch-gated)
  │                             └─ AirbandScanner → /ws/airband → AudioWorklet
  ├─ [ADS-B]
  │    └─ rtl_adsb -d 0 → ADSBDecoder (pyModeS 3.3.0)
  │                  └─ DF-17 → position · velocity → /ws/adsb → Leaflet map
  └─ [SSTV]
       └─ rtl_tcp :1234 → SDREngine → fm_demodulate → 48 kHz PCM
                               └─ SSTVDecoder (Hilbert inst-freq)
                                    └─ /ws/sstv → live canvas · gallery

Device 1 — optional dedicated Airband (AIRBAND_RTL_DEV=1)
Device 2 — optional dedicated ADS-B  (ADSB_ENABLE=1, ADSB_RTL_DEV=2)

Heltec V3 (LoRa, USB serial) → MeshtasticHandler
  └─ pubsub → asyncio bridge → /ws/meshtastic → node map · messages · send/DM

All SDR modes → /ws/waterfall → browser canvas (click-to-tune)

FastAPI on :8000 — single process, all modes, static frontend from frontend/dist
```

---

## Troubleshooting

**`usb_claim_interface error -6` / device won't open**  
Kernel DVB driver has the device. Run the blacklist step in Setup.

**Airband: no audio**  
Default is device 1. With one dongle, use the home-page mode switcher and `AIRBAND_ENABLE=0`. Raise `AIRBAND_SQUELCH` if noise trips the gate.

**ADS-B: no aircraft**  
Switch to ADS-B on the home page (or `ADSB_ENABLE=1`). Set `ADSB_LAT`/`ADSB_LON` — without them, two CPR frames per aircraft are required before position appears.

**SSTV: canvas stays black**  
Confirm device 0 is in SSTV mode on the home page. Signal RMS bar should move when a signal is present. Default frequency is 145.800 MHz FM — ISS events are announced at [amsat.org](https://www.amsat.org).

**Two dongles fighting**  
Both on the same device index. Set udev rules to pin by serial (see Setup).

**Meshtastic: "Searching for device…"**  
Check `groups $USER` includes `dialout`. Run `ls /dev/ttyUSB*`. If ModemManager grabbed the port: `sudo systemctl disable --now ModemManager`.

---

## Version History

### 0.3.0_p4ck3t5 — 2026-06-12
- **APRS live** — `aprs.py`: direwolf subprocess fed 48 kHz FM audio over stdin, frames parsed with aprslib (position, weather, messages, objects). APRS added to SDR mode switcher (144.390 MHz). `APRSPage.tsx`: station map, detail panel, live packet log. TX path planned via BTech APRS-K1 audio cable (direwolf VOX). Requires `direwolf` ≥1.7 (`sudo apt install direwolf`).
- **config.yaml** — primary configuration at repo root (see `config.yaml.example`); env vars still override. Editable airband channel list.
- **systemd service** — `hampi-dashboard.service`: auto-start on boot, cgroup kill cleans up rtl_tcp/dsd-fme/direwolf children.
- **udev rules** — `99-hampi.rules`: stable `/dev/meshtastic` + `/dev/tinygs` names. `rtl_device` config keys accept EEPROM serial strings (non-numeric) for stable multi-dongle selection.
- **DMR fix** — call end-time now uses last voice frame timestamp; TLC terminator closes calls promptly.
- **Frontend fix** — WebSocket reconnect timers cleaned up on unmount (no more zombie reconnects across page navigation).

### 0.2.2_rustylives — 2026-06-08
- **Satellite telemetry live** — TinyGS-firmware LilyGO T3 V1.6.1 LoRa32 board connects to local Mosquitto over TLS (port 8883, `setInsecure()` cert bypass against self-signed cert) instead of mqtt.tinygs.com. `backend/satellite.py` subscribes `tinygs/#`, parses `tele/ping`, `tele/rx`, and `stat/status` payloads. `SatellitePage.tsx` shows live station telemetry (WiFi RSSI, free mem, radio init status, instantaneous LoRa RSSI) and a packet feed with hex/ASCII dump. Vbat row hidden when USB-powered.
- **Meshtastic crash fix** — `meshtastic_handler.py` catches `SystemExit` from the library's port auto-detect when multiple serial devices are present.

### 0.2.1_piperrrrr + SSTV — 2026-06-07
- **SSTV decoder** — `sstv.py`: full VIS header detect, per-line sync hunt, Hilbert instantaneous-frequency decode, Scottie S1/S2 (GBR), Martin M1/M2 (RGB), Robot 36 (YCbCr). `SSTVPage.tsx`: live canvas, image gallery, lightbox, signal RMS meter. SSTV added to SDR mode switcher (device 0, 145.800 MHz FM).

### 0.2.1_piperrrrr — 2026-06-05
- **Mobile-responsive layout** — `useIsMobile()` hook + CSS media query (≤768 px). All pages adapt. Nav scrolls horizontally. iOS input-zoom fix.
- **DMR audio removed** — AMBE decode via `dsd-fme` UDP had persistent sample-rate issues on Pi 4. Page is now metadata-only.

### 0.2.0_n3wb361nn1n6 — 2026-06-05
- **DMR audio fix** — replaced WAV file polling with dsd-fme UDP output. Per-frame delivery verified live (331 WS frames / 8 s on TG313136).
- **ADS-B UI** — per-second refresh, 10 s stale rolloff, ID·HDG·SPD column layout.
- **ADS-B decoder** — full rewrite for pyModeS 3.3.0.

### 0.1.4_THEPLANES — 2026-06-04
- ADS-B live aircraft map, CPR decode, SDR mode switcher.

### 0.1.3_s3ndIt — 2026-05-17
- Meshtastic send / DM, real channel names from device.

### 0.1.1–0.1.2 — 2026-05-16–17
- Meshtastic live on hardware (200-node mesh). Airband AM scanner.

[Full commit history →](https://github.com/sinetec6969/hampi-dashboard/commits/master)

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for full specs, architecture plans, and implementation phases for upcoming features:

- **APRS** — `direwolf` TNC, 144.390 MHz, station map, packet log, weather decode
- **AX.25 packet terminal** — KISS TNC, heard-stations log, connected-mode BBS terminal
- **Satellite pass prediction** — `skyfield` + Celestrak TLE, alert UI on TinyGS board pass window
- **config.yaml** — replace env vars, editable channel/talkgroup lists
- **Systemd service** — auto-start on boot

---

*Built on a Pi. Runs on your LAN. Sees everything.*
