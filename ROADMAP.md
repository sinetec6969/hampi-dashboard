# HamPi Dashboard — Roadmap

Local multi-mode RF monitoring dashboard running on a Raspberry Pi, served via a locally-hosted web server. All decoding, storage, and serving happens on-device — no cloud dependencies.

> **Current version:** 0.1.4_THEPLANES (2026-06-04)  
> **Status:** Pre-beta. DMR voice decode, airband AM scanner, ADS-B aircraft tracking, and Meshtastic mesh monitor are all live. DMR audio playback is work-in-progress (see warnings below). SDR mode switcher lets a single dongle serve any of the three SDR modes.

---

## ⚠️ Known Issues & Warnings

### DMR Audio Choppiness
DMR audio decoded via `dsd-fme` is currently choppy / intermittent. The root cause is not fully resolved. PACE_AHEAD tuning helped but the issue persists under load on the Pi 4. **Do not rely on DMR audio for monitoring-critical use** until this is fixed.

Suspected causes under investigation:
- `dsd-fme` WAV file write bursts cause irregular chunk sizes at the reader
- Pi 4 CPU contention between the SDR acquisition loop and dsd-fme's AMBE decoder
- Audio pacing reference drift over long sessions

Workaround: restart the server to reset the audio pipeline; audio tends to be cleaner in the first few minutes of a session.

### SDR Mode Switching — One Mode Per Dongle
The home-page SDR toggle switches device 0 between DMR, Airband AM, and ADS-B. Only one mode can be active per dongle at a time. For simultaneous operation:

| Dongles | What runs simultaneously |
|---|---|
| 1 | Any one mode (switch on home page) |
| 2 | DMR (device 0) + Airband (device 1) |
| 3 | DMR + Airband + ADS-B (`ADSB_ENABLE=1 ADSB_RTL_DEV=2`) |

**udev rules are essential** on multi-dongle setups to prevent dongles from swapping device indices across reboots.

---

## Hardware Target

| Phase | Board | Notes |
|---|---|---|
| Current | Raspberry Pi 4 (4 GB) | DMR + airband (2 dongles) + Meshtastic (USB) |
| Pre-beta | Raspberry Pi 5 (8 GB) | Better compute for parallel decoders + ADS-B + APRS |

**SDR dongles — current and planned:**
| Dongle | Band | Mode | Status |
|---|---|---|---|
| 0 | ~430–440 MHz | DMR (default) | ✅ Working |
| 0 | 118–137 MHz | Airband AM (mode-switch) | ✅ Working |
| 0 | 1090 MHz | ADS-B (mode-switch) | ✅ Working |
| 1 | 118–137 MHz | Airband AM (dedicated) | ✅ Working |
| 2 | 1090 MHz | ADS-B (dedicated, `ADSB_ENABLE=1`) | ✅ Working |
| 3 | 144.390 MHz | APRS (`direwolf`) | Planned |

---

## Feature Status

### ✅ ADS-B Aircraft Tracking

Decode 1090 MHz ADS-B transponder broadcasts and display live aircraft traffic on a map.

**Implemented (0.1.4_THEPLANES):**
- `adsb.py` — `ADSBDecoder`: subprocess wraps `rtl_adsb`; parses `*HEXMSG;` hex output; filters DF-17 Extended Squitter; decodes via `pyModeS` — callsign (TC 1-4), CPR airborne position with two-message odd/even pair decoding + single-message reference fallback, velocity/heading/vrate (TC 19); aircraft registry with 60-point track history per aircraft; prune loop expires contacts after 60 s
- `main.py` — `ADSB_ENABLE/RTL_DEV/GAIN/LAT/LON` env vars; dedicated-dongle and mode-switched instances; `/ws/adsb` (snapshot on connect + live updates); `GET /api/adsb/aircraft`, `GET /api/adsb/status`
- `ADSBPage.tsx` — CartoDB Dark Matter Leaflet map; `✈` icons rotated to heading, altitude colour-coded; click → gold highlight + track polyline + detail panel; aircraft list sorted by altitude; `MapFitter` auto-fits on first data; stale fade at 45 s

**Configuration (env vars):**
```
ADSB_ENABLE=0       # 1 = start dedicated decoder on boot (needs own dongle)
ADSB_RTL_DEV=2      # device index for dedicated dongle (default: 2)
ADSB_GAIN=-1        # tuner gain, negative = auto (default: auto)
ADSB_LAT=0.0        # reference latitude — enables faster CPR position decode
ADSB_LON=0.0        # reference longitude
```

Without `ADSB_ENABLE=1`, ADS-B is available via the SDR mode switcher (device 0, stops DMR while active).

**Known limitations:**
- No squawk/emergency flag display yet
- No ICAO → airline/registration database lookup
- Surface position frames (TC 5-8) not decoded

---

### ✅ SDR Mode Switcher

Switch device 0 between DMR, Airband AM, and ADS-B from the home page without a server restart.

**Implemented (0.1.4_THEPLANES):**
- `POST /api/sdr/mode?mode=dmr|airband|adsb` — stops active mode cleanly, starts new one; automatic DMR rollback on failure
- `GET /api/sdr/mode` — returns current mode
- Home page three-button toggle with loading state and active-mode highlight

---

### ✅ Airband AM Reception

Receive VHF airband voice (118–137 MHz) with AM demodulation and channel scanner.

**Implemented (0.1-1_itbegins):**
- `sdr.py` — `am_demodulate()`: IQ → freq shift → decimate 2.4 MHz→48 kHz → envelope detection → 3.5 kHz LPF → DC remove → AGC → int16 PCM at 48 kHz
- `airband.py` — `AirbandScanner`: owns its own `rtl_tcp` instance; cycles channel list with configurable dwell; holds on squelch break + 1 s hang; gated audio output
- `main.py` — `/ws/airband` WebSocket; `GET /api/airband/status`, `POST /api/airband/squelch`, `POST /api/airband/scan`, `POST /api/airband/channel/{idx}`
- `AirbandPage.tsx` — frequency list, AudioWorklet player, squelch slider, scanner toggle

**Configuration (env vars):**
```
AIRBAND_ENABLE=1          # 1 = start scanner on boot (default: 1)
AIRBAND_RTL_DEV=1         # RTL-SDR device index (default: 1)
AIRBAND_RTL_PORT=1235     # rtl_tcp port (default: 1235)
AIRBAND_GAIN=40.0         # tuner gain dB
AIRBAND_SQUELCH=0.01      # squelch threshold — tune for your noise floor
AIRBAND_DWELL_MS=2000     # ms per channel when scanning
```

**Known limitations:**
- Channel list is hardcoded (Guard, CTAF, Center, Departure) — `config.yaml` support planned
- No ATIS text decode

---

### ✅ Meshtastic Mesh Monitor

Monitor a Meshtastic LoRa mesh network via USB serial.

**Implemented (0.1.1_m3shd4ddY / 0.1.3_s3ndIt):**
- `meshtastic_handler.py` — `MeshtasticHandler`: USB serial auto-detect, pubsub→asyncio bridge, node registry, message log, `send_text()`, `get_channels()`
- `main.py` — `/ws/meshtastic`, REST CRUD, send endpoint
- `MeshtasticPage.tsx` — node list, Leaflet map, message log, compose bar with channel picker and DM mode

**Configuration (env vars):**
```
MESH_ENABLE=1          # 1 = start handler on boot (default: 1)
MESH_PORT=             # serial port — leave blank for auto-detect
```

**Known limitations:**
- TRACEROUTE packets received but not displayed
- No telemetry sparkline history

---

## Pre-Beta Feature Roadmap

### 1. APRS Decoding

Decode Automatic Packet Reporting System traffic on 144.390 MHz.

**Requires: dedicated RTL-SDR dongle (device 3) or time-share via SDR mode switcher**

**Backend:**
- `direwolf` as the TNC — FM-demodulated audio from SDR → decoded APRS frames on stdout
- Parse APRS frames: position, weather, messages, objects, telemetry
- WebSocket endpoint `/ws/aprs` — broadcast decoded packets
- REST endpoint `GET /api/aprs/stations`

**Frontend:**
- Leaflet map — stations with standard APRS symbol icons
- Click station: callsign, last heard, comment, path, packet type
- Packet log: timestamp, callsign, type, decoded summary
- Weather packet display (temp, wind, rain)

---

## Current DMR Dashboard — Remaining Pre-Beta Items

### Audio (highest priority — see warning above)
- [ ] Fix audio choppiness — root cause still under investigation
- [ ] Volume control slider in the UI
- [ ] Per-talkgroup squelch / mute
- [ ] Audio recording — save decoded voice to timestamped WAV files per call

### DMR Intelligence
- [ ] Talkgroup alias file — CSV import mapping TG numbers to friendly names
- [ ] Full RadioID.net database import — local SQLite snapshot for offline ID lookups

### Infrastructure
- [ ] Systemd service file — `hampi-dashboard.service` for auto-start on boot
- [ ] Config file (`config.yaml`) — frequencies, gain, talkgroup aliases, scan lists; replaces hard-coded env vars
- [ ] udev rules — stable USB device aliases across reboots

---

## Infrastructure (Applies to All Modes)

### Web Server
- FastAPI serves all modes from a single process on port 8000
- Each mode adds its own WebSocket endpoint(s) and REST routes
- Static frontend served from `frontend/dist` — single React app with tab/page routing per mode

### SDR Mode Architecture
Device 0 is managed by the mode switcher. Independent dedicated dongles are unaffected by it.

```
Device 0 (mode-switchable):
  DMR     → rtl_tcp :1234 → SDREngine → DMRDecoder (dsd-fme)
  Airband → rtl_tcp :1234 → SDREngine → AirbandScanner
  ADS-B   → rtl_adsb -d 0 → ADSBDecoder (pyModeS)

Device 1+ (dedicated, independent):
  Airband → rtl_tcp :1235 → AirbandScanner
  ADS-B   → rtl_adsb -d 2 → ADSBDecoder
```

### udev Rules (multi-dongle)
```bash
# /etc/udev/rules.d/99-rtlsdr.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000001", SYMLINK+="rtlsdr0"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000002", SYMLINK+="rtlsdr1"
```

Get serial: `rtl_eeprom -d 0` · Set serial: `rtl_eeprom -d 0 -s 00000001`

### Config File (planned)
```yaml
# config.yaml (planned)
sdr:
  primary_freq: 438800000
  gain: 49.6

airband:
  rtl_device: 1
  squelch: 0.01
  frequencies:
    - { freq: 121500000, label: "Guard" }
    - { freq: 123450000, label: "CTAF" }

adsb:
  lat_ref: 30.2
  lon_ref: -97.7

talkgroups:
  91: "Worldwide"
  93: "North America"
  3116: "Texas"
```

---

## Priority Order (updated 2026-06-04)

1. **Fix DMR audio choppiness** — blocking for usable voice monitoring
2. **Systemd + config.yaml** — quality of life; stops manual env-var sessions, makes channel list editable
3. **udev rules** — required for stable multi-dongle operation
4. **APRS** — `direwolf` handles decoding; can time-share device 0 via mode switcher
5. **Talkgroup aliases + RadioID local DB** — DMR polish
6. **Full beta tag**

✅ ~~ADS-B~~ — implemented in 0.1.4_THEPLANES  
✅ ~~Meshtastic~~ — implemented in 0.1.1_m3shd4ddY
