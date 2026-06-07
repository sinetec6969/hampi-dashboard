# HamPi Dashboard — Roadmap

Local multi-mode RF monitoring dashboard running on a Raspberry Pi, served via a locally-hosted web server. All decoding, storage, and serving happens on-device — no cloud dependencies.

> **Current version:** 0.2.1_piperrrrr (2026-06-05)  
> **Status:** Pre-beta. DMR (metadata), ADS-B, Airband AM, and Meshtastic are all live. Mobile-responsive. Single RTL-SDR dongle covers all SDR modes via the mode switcher; second dongle runs Airband dedicated. DMR audio decode was removed — AMBE via dsd-fme had persistent sample-rate issues on Pi 4; DMR page is now metadata-only (talkgroup, caller, call history, map).

---

## ⚠️ Known Issues

### SDR Mode Switching — One Mode Per Dongle
The home-page SDR toggle switches device 0 between DMR, Airband AM, and ADS-B. Only one mode can be active per dongle at a time.

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
| Current | Raspberry Pi 4 (4 GB) | DMR + Airband (2 dongles) + Meshtastic (USB) |
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

### ✅ DMR Digital Voice

Decode DMR digital voice traffic — talkgroup, RadioID, caller ID, call history, map.

**Implemented (0.1.0_b4s3c4mp):**
- `dmr.py` — `DMRDecoder`: `dsd-fme` subprocess, stdout parser, talkgroup/RadioID extraction, RadioID.net HTTP lookup, caller registry
- `main.py` — `/ws/dmr` WebSocket, `GET /api/dmr/status`, `GET /api/dmr/history`
- `DMRPage.tsx` — call history table, active caller panel, Leaflet map (IP geolocation of RadioID), talkgroup decode

**Audio note:** AMBE decode via `dsd-fme` UDP was removed in 0.2.1 — persistent sample-rate mismatch caused slow-motion playback on Pi 4. DMR page is **metadata-only**. Audio re-introduction would require a hardware AMBE dongle (e.g. ThumbDV) or an off-chip decoder.

**Known limitations:**
- No talkgroup alias CSV import yet
- No local RadioID database — lookups are HTTP (requires internet)
- Trunked DMR (control channel) not supported

---

### ✅ ADS-B Aircraft Tracking

Decode 1090 MHz ADS-B transponder broadcasts and display live aircraft traffic on a map.

**Implemented (0.1.4_THEPLANES, updated 0.2.0_n3wb361nn1n6):**
- `adsb.py` — `ADSBDecoder`: `rtl_adsb` subprocess; parses `*HEXMSG;` hex output; DF-17 Extended Squitter via pyModeS 3.3.0; callsign (TC 1–4), CPR airborne position (odd/even pair + single-message ref fallback), velocity/heading/vrate (TC 19); 60-point track history; 60 s prune loop
- `main.py` — `ADSB_ENABLE/RTL_DEV/GAIN/LAT/LON` env vars; `/ws/adsb`; `GET /api/adsb/aircraft`, `GET /api/adsb/status`
- `ADSBPage.tsx` — CartoDB Dark Matter Leaflet map; `✈` icons rotated to heading, altitude colour-coded; click → highlight + track polyline + detail panel; 1 s refresh; 10 s stale rolloff

**Configuration (env vars):**
```
ADSB_ENABLE=0       # 1 = start dedicated decoder on boot (needs own dongle)
ADSB_RTL_DEV=2      # device index for dedicated dongle (default: 2)
ADSB_GAIN=-1        # tuner gain, negative = auto
ADSB_LAT=0.0        # reference latitude — enables faster CPR decode
ADSB_LON=0.0        # reference longitude
```

**Known limitations:**
- No ICAO → airline/registration database (local `aircraft.csv` planned)
- No squawk/emergency flag display
- Surface position frames (TC 5–8) not decoded

---

### ✅ SDR Mode Switcher

Switch device 0 between DMR, Airband AM, and ADS-B from the home page without a server restart.

**Implemented (0.1.4_THEPLANES):**
- `POST /api/sdr/mode?mode=dmr|airband|adsb` — stops active mode cleanly, starts new one; automatic DMR rollback on failure
- `GET /api/sdr/mode` — current mode
- Home page three-button toggle with loading state and active-mode highlight

---

### ✅ Airband AM Reception

Receive VHF airband voice (118–137 MHz) with AM demodulation and channel scanner.

**Implemented (0.1-1_itbegins):**
- `sdr.py` — `am_demodulate()`: IQ → freq shift → decimate 2.4 MHz→48 kHz → envelope detection → 3.5 kHz LPF → DC remove → AGC → int16 PCM at 48 kHz
- `airband.py` — `AirbandScanner`: owns its own `rtl_tcp` instance; cycles channel list with configurable dwell; holds on squelch break + 1 s hang; gated audio output
- `main.py` — `/ws/airband`; `GET /api/airband/status`, `POST /api/airband/squelch`, `POST /api/airband/scan`, `POST /api/airband/channel/{idx}`
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
- Channel list is hardcoded — `config.yaml` support planned
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

### ✅ Mobile-Responsive Layout

**Implemented (0.2.1_piperrrrr):**
- `useIsMobile()` hook + CSS media query block (≤768 px)
- All pages adapt: ADS-B map stacks above list, Meshtastic node list/map/messages go vertical, Airband freq list above controls, DMR columns stack
- Nav links scroll horizontally on narrow screens
- iOS input-zoom fix (`font-size: 16px` on inputs)

---

## Roadmap — Coming Next

### APRS Station Monitoring

Decode APRS traffic on 144.390 MHz via `direwolf` TNC.

**Backend:**
- `direwolf` subprocess with AGWPE or stdout frame output
- `aprs.py` (APRSDecoder): parse position, weather, messages, objects, telemetry
- `/ws/aprs` WebSocket — live decoded packets
- `GET /api/aprs/stations` REST

**Frontend:**
- `APRSPage.tsx` — Leaflet map with standard APRS symbol icons
- Click station: callsign, last heard, comment, path, packet type
- Packet log: timestamp, callsign, type, decoded summary
- Weather packet display (temp, wind, rain)

**Requires:** dedicated dongle (device 3) or time-share via mode switcher

---

## Roadmap — Further Out

### AX.25 Packet Terminal

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
4. **Connected terminal** *(stretch)* — relay SABM/I-frame exchange over a second WebSocket; in-browser terminal for packet BBS connects
5. **Beacon inject** *(stretch)* — `ax25.write()` via KISS; transmit beacon through a TX-capable rig

**Dependencies:** `direwolf` (already needed for APRS); no additional pip packages

**Open questions:**
- Share `direwolf` instance with APRS or run a second instance on a different port?
- RX-only monitor first, or target connected-mode terminal from the start?
- RTL-SDR direct or VHF radio audio-in via discriminator tap?

---

### Satellite Telemetry (433 MHz / TinyGS)

Receive and decode satellite LoRa telemetry and upload frames to the TinyGS ground station network.

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
1. **Research** — clone `tinygs/tinyGS` for satellite DB; confirm MQTT payload format; pick target sats visible from this location
2. **LoRa decoder** — try `rtl-lora` (C, no GNU Radio) first; fall back to Python/numpy chirp dechirp → FFT → grey decode → Hamming FEC; target SF7–SF12, BW 125/250/500 kHz
3. **TinyGS MQTT upload** — `paho-mqtt`; payload `{ "packet": "<base64>", "rssi", "snr", "frequency", "satelliteName" }`
4. **Dashboard page** — `SatellitePage.tsx`: live packet log, hex/ASCII frame dump, RSSI/SNR, satellite name + pass time, upload status badge
5. **Pass prediction** *(stretch)* — `skyfield` + Celestrak TLE fetch; auto-tune RTL-SDR on approach

**Fallback:** Heltec WiFi LoRa 32 V3 is a TinyGS-compatible device — if pure-SDR LoRa decode proves unreliable, a second Heltec (~$12) gives a rock-solid hardware receiver.

---

### ✅ SSTV Image Reception

Decode Slow Scan Television images off the air with the RTL-SDR — ISS SSTV events (145.800 MHz FM), 2 m SSTV activity, and HF SSTV (14.230 MHz, requires direct-sampling mode on the V4).

**Implemented (2026-06-06):**
- `sstv.py` — `SSTVDecoder`: VIS header detect (1900 Hz leader → 1200 Hz break → 7-bit code + parity); per-line sync hunt; Scottie S1/S2 (GBR), Martin M1/M2 (RGB), Robot 36 (YCbCr→RGB); Hilbert instantaneous-frequency channel decode at 48 kHz; PNG save via Pillow; progressive line callbacks
- `main.py` — `"sstv"` added to SDR mode switcher (device 0 retuned to 145.800 MHz FM); `sstv_loop()` feeds FM-demodulated audio to decoder; `/ws/sstv` WebSocket; `GET /api/sstv/status`, `GET /api/sstv/images`, `GET /api/sstv/images/{filename}`
- `SSTVPage.tsx` — live canvas fills row-by-row as lines arrive; decode progress bar; image gallery with lightbox; signal RMS meter; mode badge

**Configuration (env vars):**
```
SSTV_FREQ=145800000    # receive frequency Hz (default: 145.800 MHz ISS/2m)
SSTV_GAIN=40.0         # tuner gain dB
SSTV_IMAGE_DIR=        # path for saved PNGs (default: sstv_images/ in repo root)
```

**Architecture:**
```
RTL-SDR device 0 (mode-switch)
  └─ rtl_tcp :1234 → SDREngine → fm_demodulate() @ 48 kHz
       └─ sstv.py (SSTVDecoder)
            ├─ State: IDLE → VIS_DECODE → SYNC_HUNT → LINE_DECODE
            ├─ Hilbert inst-freq → pixel values per scan line
            ├─ PNG → sstv_images/sstv_YYYYMMDD_HHMMSS.png  (Pillow)
            ├─ /ws/sstv      WebSocket ({"type":"line"/"image_complete"/"status"})
            └─ /api/sstv/*   REST (gallery list, image serve)
```

**Known limitations / stretch:**
- No slant correction (sample-rate drift over 240 lines)
- HF SSTV (14.230 MHz) needs direct-sampling mode on V4 dongle — not yet wired up
- ISS pass auto-tune — stretch goal shared with satellite telemetry (`skyfield`)

---

### Miscellaneous Backlog

- [ ] config.yaml — replace env vars; editable channel/talkgroup lists
- [ ] Systemd service — auto-start and restart on boot
- [ ] udev rules — stable USB device aliases across reboots (required for reliable multi-dongle)
- [ ] ADS-B flight lookup — local `aircraft.csv` for airline/registration data
- [ ] Talkgroup alias CSV import
- [ ] Offline RadioID database (local SQLite snapshot)
- [ ] Trunked DMR (control channel parsing)
- [ ] P25 Phase 1 & 2, NXDN, D-STAR
- [ ] ADS-B range rings, squawk alerts, ICAO watchlist

---

## Priority Order (updated 2026-06-06)

1. **config.yaml + systemd** — quality of life; stops manual env-var sessions, makes channel lists editable, enables auto-start
2. **udev rules** — required for stable multi-dongle operation
3. **APRS** — `direwolf` handles decoding; can time-share device 0 via mode switcher
4. **AX.25 packet terminal** — shares `direwolf` with APRS; low marginal effort after APRS lands
5. **ADS-B flight lookup** — local `aircraft.csv`; no new hardware required
6. **Talkgroup aliases + RadioID local DB** — DMR polish
7. ~~**SSTV image reception**~~ — ✅ done
8. **Satellite telemetry** — research phase first; hardware path TBD
9. **Full beta tag**

---

## Infrastructure

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
  ADS-B   → rtl_adsb -d 0 → ADSBDecoder (pyModeS 3.3.0)
  SSTV    → rtl_tcp :1234 → SDREngine → SSTVDecoder (145.800 MHz FM)

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

## Completed

✅ DMR digital voice decode (metadata) — 0.1.0_b4s3c4mp  
✅ Airband AM scanner — 0.1-1_itbegins  
✅ Meshtastic mesh monitor — 0.1.1_m3shd4ddY / 0.1.3_s3ndIt  
✅ ADS-B aircraft tracking — 0.1.4_THEPLANES  
✅ SDR mode switcher — 0.1.4_THEPLANES  
✅ DMR audio (UDP) — 0.2.0_n3wb361nn1n6 *(subsequently removed — see note above)*  
✅ ADS-B pyModeS 3.3.0 rewrite — 0.2.0_n3wb361nn1n6  
✅ Mobile-responsive layout — 0.2.1_piperrrrr  
✅ SSTV image decoder (Scottie S1/S2, Martin M1/M2, Robot 36) — 2026-06-06  
