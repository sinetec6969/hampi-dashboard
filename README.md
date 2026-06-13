# HamPi SDR Dashboard

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-asyncio-009688?style=flat-square&logo=fastapi&logoColor=white)
![RTL-SDR](https://img.shields.io/badge/RTL--SDR-Blog_V4-ff6600?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Raspberry_Pi-c51a4a?style=flat-square&logo=raspberry-pi&logoColor=white)
![Version](https://img.shields.io/badge/version-0.9--b3t4-blueviolet?style=flat-square)
![Status](https://img.shields.io/badge/status-beta-orange?style=flat-square)

---

> **A $50 Raspberry Pi that sees everything in the air around you — and shows it in a browser.**

One Pi. A couple of RTL-SDR dongles. A dark browser tab on your phone or laptop.  
Digital voice decoded. Aircraft tracked. Mesh nodes mapped. SSTV images received. Packets logged.  
**No cloud. No subscription. No data leaving your network. Ever.**

---

## What's Live

| Mode | Status | What it does |
|---|---|---|
| 📡 DMR Digital Voice | ✅ Live | Decode · talkgroup aliases · caller map · **offline RadioID DB (307k users)** · call history |
| ✈️ ADS-B 1090 MHz | ✅ Live | Live aircraft map · CPR position · **local flight lookup (516k aircraft)** · track history |
| 🛩️ Airband AM | ✅ Live | 118–137 MHz scanner · squelch · real-time AudioWorklet playback |
| 📻 APRS | ✅ Live | `direwolf` TNC · station map · packet log · weather decode |
| 📟 AX.25 | ✅ Live | KISS terminal · raw frame log · waterfall click-to-tune · RX-only (TX pending APRS-K1) |
| 🌐 Meshtastic LoRa | ✅ Live | Mesh monitor · node map · live messages · send / DM |
| 📺 SSTV | ✅ Live | Scottie S1/S2 · Martin M1/M2 · Robot 36 · live canvas · image gallery |
| 🛰️ Satellite | ✅ Live | TinyGS hardware receiver (LilyGO T3 LoRa32) · local MQTT broker · live telemetry + RX packet feed |
| 📊 Waterfall | ✅ Live | 2.4 MHz FFT · click-to-tune · memory channels |
| 📱 Mobile UI | ✅ Live | Responsive layout · auto-detects phone vs desktop |

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

# System packages (direwolf = APRS/AX.25 TNC)
sudo apt install rtl-sdr dsd-fme direwolf

# Serial access (Meshtastic)
sudo usermod -aG dialout $USER

# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install && npm run build

# Configure
cd ..
cp config.yaml.example config.yaml   # edit frequencies, channels, talkgroups

# Run once to test
cd backend && python main.py
```

Open `http://<pi-ip>:8000` in any browser on your LAN. Works over [Tailscale](https://tailscale.com) too.

### Run on boot (systemd)

```bash
sudo cp hampi-dashboard.service /etc/systemd/system/   # edit paths/user if needed
sudo systemctl daemon-reload
sudo systemctl enable --now hampi-dashboard
```

Stop/start cleans up the whole subprocess tree (rtl_tcp, dsd-fme, direwolf) via cgroup kill.

### Stable device names (udev)

```bash
sudo cp 99-hampi.rules /etc/udev/rules.d/    # edit serials to match your hardware
sudo udevadm control --reload && sudo udevadm trigger
```

Gives `/dev/meshtastic` and `/dev/tinygs` regardless of plug order. For RTL dongles, write **non-numeric** EEPROM serials (`rtl_eeprom -d 0 -s HAMPI0`, replug) and use them in `config.yaml` `rtl_device:` keys — `rtl_tcp`/`rtl_adsb` resolve serials directly, which survives index reshuffles where udev symlinks can't help.

### Local databases (optional, recommended)

```bash
cd backend
venv/bin/python build_radioid_db.py    # DMR users   → radioid.db   (17 MB, 307k users)
venv/bin/python build_aircraft_db.py   # ADS-B fleet → aircraft.db  (34 MB, 516k aircraft)
```

One-time downloads. With the DBs present, every DMR caller and aircraft lookup is a local sqlite read — re-run whenever you want fresh snapshots.

---

## Configuration

### SDR mode switcher (device 0)

Home-page toggle: **DMR · Airband · ADS-B · SSTV · APRS** (APRS mode also powers the AX.25 terminal). No server restart, automatic DMR rollback on failure.

### config.yaml

All settings live in `config.yaml` at the repo root — see [`config.yaml.example`](config.yaml.example) for every key with defaults. The old env var names (`SDR_FREQ`, `AIRBAND_SQUELCH`, `ADSB_LAT`, …) still work and **override** the yaml, so systemd drop-ins and one-off shell overrides behave as expected.

```yaml
sdr:      { freq: 438800000, gain: 49.6 }     # device 0 — mode switcher
airband:
  rtl_device: 1                               # index or EEPROM serial ("HAMPI1")
  squelch: 0.01
  frequencies:
    - { freq: 121500000, label: "Guard" }
adsb:     { lat_ref: 30.2, lon_ref: -97.7 }
aprs:     { freq: 144390000, gain: 49.6 }
meshtastic: { port: /dev/meshtastic }
talkgroups:                                   # DMR aliases shown next to TG numbers
  91: "Worldwide"
  3116: "Texas"
```

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
- **Local flight lookup** — registration, type, model, operator joined from `aircraft.db` (OpenSky snapshot, 516k airframes) at first sighting; no runtime API calls
- Aircraft icons (`✈`) rotate to heading, colour-coded by altitude
- **Click any aircraft** for reg, type, operator, altitude, speed, heading, vertical rate
- **Gold track polyline** — last 60 position fixes for the selected contact
- CPR position: odd/even pair primary; single-message reference fallback
- Sidebar refreshes every second; contacts roll off after 10 s silence

### 📡 DMR — Caller Intelligence

- `dsd-fme` decodes DMR/MOTOTRBO Tier II metadata: timeslot, CC, talkgroup, source ID, talker alias
- **Offline RadioID DB** — `radioid.db` snapshot (307k users) makes every caller lookup a local sqlite read; falls back to the RadioID.net API only when the DB is absent
- **Talkgroup aliases** — `talkgroups:` map in config.yaml shown next to TG numbers in the live panel and call history
- **Caller map** — Nominatim geocodes city/state (cached); click pin for full ID card
- **Call history** — persisted JSON log; survives server restarts

### 📻 APRS — Station Monitoring

- `direwolf` TNC fed 48 kHz FM audio straight from the SDR engine over stdin — no soundcard loopback
- `aprslib` parses positions, weather, messages, objects, telemetry
- **Station map** (symbol markers), detail panel (course/speed, path, WX, comment), live packet log
- RX today; **TX path planned** via BTech APRS-K1 audio cable + radio (direwolf VOX PTT — beacon, digipeat, igate)

### 📟 AX.25 — Packet Terminal

- Rides the same direwolf instance over **KISS TCP (port 8001)** — one process, two decoders
- Full frame decode: source/dest, up to 8 digipeaters with repeated-flag, I/S/U control (SABM, UA, RR, REJ…), PID, info
- **Terminal console** — green-on-black scrollback, 500-frame history
- **Waterfall on-page** with click-to-tune + frequency text entry — the whole chain (rtl_tcp, demod, direwolf) follows the retune live
- RX only until TX hardware lands

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
  ├─ [SSTV]
  │    └─ rtl_tcp :1234 → SDREngine → fm_demodulate → 48 kHz PCM
  │                             └─ SSTVDecoder (Hilbert inst-freq)
  │                                  └─ /ws/sstv → live canvas · gallery
  └─ [APRS + AX.25]
       └─ rtl_tcp :1234 → SDREngine → fm_demodulate → 48 kHz PCM
                               └─ direwolf (stdin audio, one instance)
                                    ├─ stdout → aprslib → /ws/aprs → station map · packet log
                                    └─ KISS :8001 → AX25Decoder → /ws/ax25 → terminal

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
Check `groups $USER` includes `dialout`. Run `ls /dev/ttyUSB*`. If ModemManager grabbed the port: `sudo systemctl disable --now ModemManager`. With multiple serial devices attached, pin `meshtastic: port:` in config.yaml (or install the udev rules and use `/dev/meshtastic`).

**APRS/AX.25: pipeline up but zero frames**  
direwolf at steady ~15% CPU means audio is flowing — the silence is RF. 144.39 needs a 2m-capable antenna; a 70cm whip is deaf there. direwolf 1.7 requires a config file (`backend/direwolf.conf` is passed automatically) and its default AGW port 8000 collides with the dashboard — the shipped conf disables it.

---

## Version History

### 0.9-b3t4 — 2026-06-12 · **BETA**
Every numbered roadmap item shipped. Eight live modes, one Pi, zero cloud.
- **AX.25 packet terminal** — `ax25.py`: KISS TCP client on the shared APRS-mode direwolf (KISSPORT 8001); full AX.25 decode (digi path with repeated-flag, I/S/U control, PID). `AX25Page.tsx`: green-on-black terminal, on-page waterfall, frequency text entry + click-to-tune retuning the entire chain live. RX only until BTech APRS-K1 + radio arrive.
- **ADS-B flight lookup** — `build_aircraft_db.py` distills the OpenSky snapshot into `aircraft.db` (sqlite, 516k airframes); registration/type/operator joined locally at first sighting.
- **Offline RadioID DB** — `build_radioid_db.py` → `radioid.db` (307k users); DMR caller lookups are local reads, no API calls. Live-verified off-air.
- **Talkgroup aliases** — `talkgroups:` config.yaml map → names in live frames and call history.
- **direwolf hardening** — `ADEVICE stdin null` (no ALSA grab), AGW port collision with FastAPI resolved.

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

Roadmap I ([ROADMAP.md](ROADMAP.md)) is complete as of 0.9-b3t4. The TX era is underway in **[ROADMAP-NEXT.md](ROADMAP-NEXT.md)**:

- **TX foundation (Phase A — 🚧 in progress)** — Digirig Mobile (USB audio + hardware RTS PTT). Software path built and a valid APRS beacon transmitted on 144.390; **RF not yet confirmed** (radio keying / deviation pending an operator at the rig). The `Radio TX` page drives PTT + tone bring-up, gated behind `radio.tx_enable` + `station.callsign`.
- **APRS TX** — beacon/messaging/digipeat; **AX.25 connected-mode** BBS terminal; **SSTV transmit**; **Winlink** (`pat`)
- **HamPi as LAN TNC** — KISS over network for APRSdroid/RadioMail
- **Satellite pass prediction** — `skyfield` + Celestrak TLE, alert UI on TinyGS pass window
- **Trunked DMR · ADS-B extras · HF modes** — the long tail

---

*Built on a Pi. Runs on your LAN. Sees everything.*
