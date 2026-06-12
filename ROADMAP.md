# HamPi Dashboard — Roadmap

Local multi-mode RF monitoring dashboard running on a Raspberry Pi, served via a locally-hosted web server. All decoding, storage, and serving happens on-device — no cloud dependencies.

> **Current version:** 0.3.0_p4ck3t5 (2026-06-12)  
> **Status:** Pre-beta. DMR (metadata), ADS-B, Airband AM, Meshtastic, SSTV, APRS, and Satellite telemetry (via TinyGS hardware → local MQTT) are all live. config.yaml + systemd + udev rules in place. Mobile-responsive. Single RTL-SDR dongle covers all SDR modes via the mode switcher; second dongle runs Airband dedicated. DMR audio decode was removed — AMBE via dsd-fme had persistent sample-rate issues on Pi 4; DMR page is now metadata-only (talkgroup, caller, call history, map).

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

### ✅ APRS Station Monitoring

Decode APRS traffic on 144.390 MHz via `direwolf` TNC.

**Implemented (2026-06-12):**
- `aprs.py` — `APRSDecoder`: `direwolf` subprocess (`-q hd -n 1 -r 48000 -b 16 -`, audio on stdin from `fm_demodulate()`); stdout frame lines parsed with `aprslib` (position, weather, messages, objects, telemetry); station registry + 200-packet rolling log
- `main.py` — `"aprs"` added to SDR mode switcher (device 0 retuned to 144.390 MHz FM); `aprs_loop()`; `/ws/aprs`; `GET /api/aprs/status`, `/api/aprs/stations`, `/api/aprs/packets`
- `APRSPage.tsx` — Leaflet map (emoji symbol markers), station detail panel (position, course/speed, path, weather, comment), station list + live packet log

**Configuration (config.yaml):**
```yaml
aprs:
  freq: 144390000
  gain: 49.6
```

**Requires:** `direwolf` in PATH (`sudo apt install direwolf`); time-share device 0 via mode switcher or dedicated dongle later

**Known limitations / future:**
- RX only. **TX path planned via BTech APRS-K1 audio cable** — HT speaker/mic jack to a USB soundcard on the Pi; direwolf keys the radio via VOX, enabling beacon / digipeat / igate transmit with no TNC hardware. Would also serve as an alternative RX audio source (HT discriminator audio instead of RTL-SDR).
- Emoji symbol markers, not the standard two-table APRS symbol sprite set
- No igate/digipeater function (intentional until TX path exists)

---

## Roadmap — Further Out

### ✅ AX.25 Packet Terminal (RX monitor — phases 1–3)

Raw AX.25 frame monitoring via `direwolf` KISS TNC, in-browser.

**Implemented (2026-06-12):**
- `ax25.py` — `AX25Decoder`: asyncio KISS TCP client on the **shared APRS-mode direwolf** (`KISSPORT 8001` in `direwolf.conf`); KISS deframe/unescape; full AX.25 decode (dest/src/up-to-8 digis with repeated `*` flag, I/S/U control byte incl. SABM/UA/DISC/RR/REJ, PID, info); 500-frame rolling log + heard-stations registry
- `main.py` — AX25Decoder starts/stops with `"aprs"` SDR mode; `/ws/ax25`; `GET /api/ax25/status`, `/api/ax25/frames`, `/api/ax25/heard`. `aprs_loop()` now broadcasts waterfall FFT and demodulates at `sdr.freq` (not fixed APRS_FREQ) so `/api/tune` retunes the decode chain live
- `AX25Page.tsx` — waterfall (click-to-tune) + frequency/gain text controls + green-on-black terminal console with autoscroll; mode banner with one-click switch to APRS mode
- `direwolf.conf` — `ADEVICE stdin null` (no ALSA output grab), `ARATE 48000`, `AGWPORT 0`, `KISSPORT 8001`

**Resolved open questions:** shares the APRS direwolf instance (one process, stdout→aprslib + KISS→ax25.py); RX-only first; RTL-SDR direct.

**Remaining phases — blocked on TX hardware (BTech APRS-K1 cable + radio):**
4. **Connected terminal** — relay SABM/I-frame exchange over a second WebSocket; in-browser packet BBS connects
5. **Beacon inject** — KISS write; direwolf VOX PTT through the APRS-K1

**RX only until then** — the dashboard transmits nothing.

---

### ✅ Satellite Telemetry (TinyGS hardware + local MQTT)

Receive satellite LoRa telemetry via a TinyGS-firmware ESP32 board, brokered through a local Mosquitto instance — **no data leaves the LAN**.

**Implemented (0.2.2_rustylives):**
- **Hardware:** LilyGO T3 V1.6.1 LoRa32 (SX1276, 433/868/915 MHz). Heltec WiFi LoRa 32 V3 is also a known-working TinyGS target.
- **Firmware (modified TinyGS):** `MQTT_Client.cpp` uses `WiFiClientSecure::setInsecure()` instead of `setCACert(newRoot_CA)` so the board accepts the Pi's self-signed cert on Mosquitto port 8883. Keeping `SECURE_MQTT` enabled is required — switching to plain `WiFiClient` changes the binary layout enough to break SPI radio init (RADIOLIB_ERR_CHIP_NOT_FOUND / -18). Version check bypassed; WiFi + MQTT config injected on boot.
- **Pi-side broker:** Mosquitto on ports 1883 (plain) + 8883 (TLS, self-signed). `allow_anonymous true`. Certs in `/etc/mosquitto/`.
- **Backend:** `satellite.py` (`SatelliteMonitor`) — `paho-mqtt` subscribes `tinygs/#`, decodes `tele/ping` (board telemetry), `tele/rx` (received satellite packet — RSSI/SNR/freq/CRC/raw), `stat/status` (station identity).
- **API:** `/ws/satellite`, `GET /api/satellite/status`, `GET /api/satellite/packets`.
- **Frontend:** `SatellitePage.tsx` — WS + MQTT status dots, station info row (board IP, free mem, WiFi RSSI, instantaneous radio RSSI), packet feed with expandable hex/ASCII dump, RSSI bar, CRC/noisy badges.

**Known limitations / future:**
- One sat target per session — multi-band requires re-config or second board
- No pass-prediction overlay yet (`skyfield` + Celestrak TLE — moved to backlog)
- No upload to public TinyGS network (intentional — privacy-first / local-only)

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

- [x] config.yaml — env vars still override; editable airband channel list (talkgroup aliases still pending, see item 6)
- [x] Systemd service — `hampi-dashboard.service` in repo root; auto-start and restart on boot
- [x] udev rules — `99-hampi.rules` (meshtastic/tinygs tty symlinks); rtl_device config keys accept EEPROM serial strings for stable dongle selection
- [ ] ADS-B flight lookup — local `aircraft.csv` for airline/registration data
- [ ] Talkgroup alias CSV import
- [ ] Offline RadioID database (local SQLite snapshot)
- [ ] Trunked DMR (control channel parsing)
- [ ] P25 Phase 1 & 2, NXDN, D-STAR
- [ ] ADS-B range rings, squawk alerts, ICAO watchlist

---

## Priority Order (updated 2026-06-06)

1. ~~**config.yaml + systemd**~~ — ✅ done (2026-06-12): `config.yaml.example` + `hampi-dashboard.service`
2. ~~**udev rules**~~ — ✅ done (2026-06-12): `99-hampi.rules` + serial-string `rtl_device` config
3. ~~**APRS**~~ — ✅ done (2026-06-12); TX via BTech APRS-K1 cable is the follow-on
4. ~~**AX.25 packet terminal**~~ — ✅ RX monitor done (2026-06-12); connected-mode + beacon TX blocked on APRS-K1 + radio
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
  APRS    → rtl_tcp :1234 → SDREngine → APRSDecoder (direwolf, 144.390 MHz FM)

Device 1+ (dedicated, independent):
  Airband → rtl_tcp :1235 → AirbandScanner
  ADS-B   → rtl_adsb -d 2 → ADSBDecoder
```

### Stable Device Names (multi-dongle / multi-serial)
`99-hampi.rules` in repo root — install with:
```bash
sudo cp 99-hampi.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger
```
Gives `/dev/meshtastic` (Heltec V3) and `/dev/tinygs` (LilyGO T3) regardless of plug order.

**RTL dongles:** symlinks don't help — `rtl_tcp`/`rtl_adsb` select via `-d`, not /dev paths. Instead, every `rtl_device` config key accepts an EEPROM serial string, which `verbose_device_search` resolves to the right dongle at startup.

Get serial: `rtl_eeprom -d 0` · Set serial: `rtl_eeprom -d 0 -s HAMPI0` (replug after).
Serials must be **non-numeric** — numeric `-d` values parse as a device index first.

### Config File
Live since 2026-06-12 — see `config.yaml.example` for the full key list. Env vars override yaml; missing file falls back to defaults.
```yaml
# config.yaml
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

# talkgroups: section planned — lands with priority item 6 (alias import)
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
✅ Satellite telemetry (TinyGS hardware → local MQTT) — 0.2.2_rustylives  
✅ config.yaml + systemd service + udev rules — 0.3.0_p4ck3t5  
✅ APRS station monitoring (direwolf + aprslib) — 0.3.0_p4ck3t5  
