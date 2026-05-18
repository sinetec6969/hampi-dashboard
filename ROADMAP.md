# HamPi Dashboard — Roadmap

Local multi-mode RF monitoring dashboard running on a Raspberry Pi, served via a locally-hosted web server. All decoding, storage, and serving happens on-device — no cloud dependencies.

> **Current version:** 0.1.2_m3shPAPI (2026-05-17)  
> **Status:** Pre-beta. DMR voice decode, call history, caller map, multi-page dashboard shell, AM airband scanner, and Meshtastic mesh monitor are all live. DMR audio playback is work-in-progress (see warnings below).

---

## ⚠️ Known Issues & Warnings

### DMR Audio Choppiness
DMR audio decoded via `dsd-fme` is currently choppy / intermittent. The root cause is not fully resolved. PACE_AHEAD tuning helped but the issue persists under load on the Pi 4. **Do not rely on DMR audio for monitoring-critical use** until this is fixed.

Suspected causes under investigation:
- `dsd-fme` WAV file write bursts cause irregular chunk sizes at the reader
- Pi 4 CPU contention between the SDR acquisition loop and dsd-fme's AMBE decoder
- Audio pacing reference drift over long sessions

Workaround: restart the server to reset the audio pipeline; audio tends to be cleaner in the first few minutes of a session.

### Multiple SDR Dongles Required for Simultaneous Modes
Each active receive mode (DMR, airband, ADS-B, APRS) needs its own RTL-SDR dongle running a dedicated `rtl_tcp` instance. **You cannot run two modes on the same dongle simultaneously.**

| Mode | Default device | Default port |
|---|---|---|
| DMR | device 0 | 1234 |
| Airband | device 1 | 1235 |
| ADS-B | dedicated (dump1090) | — |
| APRS | device 2 (planned) | 1236 |

**Single-dongle workaround:** Set `AIRBAND_RTL_DEV=0` to share the DMR dongle — but you must stop/restart the server to switch modes. They cannot be active at the same time.

**udev rules are essential** on multi-dongle setups to prevent dongles from swapping device indices across reboots. Without them, a reboot may assign DMR's dongle to airband and vice versa. See Infrastructure section below.

---

## Hardware Target

| Phase | Board | Notes |
|---|---|---|
| Current | Raspberry Pi 4 (4 GB) | DMR + airband (2 dongles) + Meshtastic (USB) |
| Pre-beta | Raspberry Pi 5 (8 GB) | Better compute for parallel decoders + ADS-B + APRS |

**SDR dongles — current and planned:**
| Dongle | Band | Mode | Status |
|---|---|---|---|
| 0 | ~430–440 MHz | DMR | ✅ Working |
| 1 | 118–137 MHz | Airband AM | ✅ Implemented |
| 2 | 1090 MHz | ADS-B (`dump1090`) | Planned |
| 3 | 144.390 MHz | APRS (`direwolf`) | Planned |

---

## Feature Status

### ✅ Airband AM Reception

Receive VHF airband voice (118–137 MHz) with AM demodulation and channel scanner.

**Implemented:**
- `sdr.py` — `am_demodulate()`: IQ → freq shift → decimate 2.4 MHz→48 kHz → envelope detection (`abs`) → 3.5 kHz LPF → DC remove → AGC → int16 PCM at 48 kHz
- `airband.py` — `AirbandScanner`: owns its own `rtl_tcp` instance; cycles channel list with configurable dwell; holds on squelch break + 1 s hang; gated audio (only streams PCM when squelch is open)
- `backend/main.py` — `/ws/airband` WebSocket (mixed binary PCM + JSON status frames); REST endpoints: `GET /api/airband/status`, `POST /api/airband/squelch`, `POST /api/airband/scan`, `POST /api/airband/channel/{idx}`
- `frontend/src/pages/AirbandPage.tsx` — frequency list with active-channel highlight + RX blink, audio player (AudioWorklet), squelch slider, scanner toggle
- `AudioPlayer.tsx` — parametrized (`wsPath`, `inputRate`, `label`) for reuse across modes

**Configuration (env vars):**
```
AIRBAND_ENABLE=1          # 1 = start scanner on boot (default: 1)
AIRBAND_RTL_DEV=1         # RTL-SDR device index (default: 1)
AIRBAND_RTL_PORT=1235     # rtl_tcp port (default: 1235)
AIRBAND_GAIN=40.0         # tuner gain dB (default: 40.0)
AIRBAND_SQUELCH=0.01      # squelch threshold — tune for your noise floor
AIRBAND_DWELL_MS=2000     # ms per channel when scanning
```

**Known limitations:**
- Channel list is hardcoded (Guard, CTAF, Center, Departure) — `config.yaml` support planned
- No ATIS text decode
- Squelch is audio-RMS based — works well for AM voice; may need adjustment near strong carriers

---

### ✅ Meshtastic Mesh Monitor

Monitor a Meshtastic LoRa mesh network — node positions, messages, and telemetry — via USB serial.

**Implemented:**
- `backend/meshtastic_handler.py` (new): `MeshtasticHandler` — connects to a Meshtastic device via USB serial using the `meshtastic` Python package; auto-detects port or uses `MESH_PORT` env var; retries every 10 s if no device found; pypubsub callbacks (`NODEINFO`, `POSITION`, `TELEMETRY`, `TEXT_MESSAGE`) bridged to asyncio via `run_coroutine_threadsafe`; maintains node registry seeded from `iface.nodes` on connect; graceful no-op if package is absent
- `backend/main.py` — `/ws/meshtastic` WebSocket (sends full node list + recent messages on connect, then live `node_update` / `message` / `status` JSON frames); REST: `GET /api/meshtastic/status`, `/nodes`, `/messages`
- `frontend/src/pages/MeshtasticPage.tsx` — node list sorted by last-heard with online/offline dot, battery level (colour-coded), SNR, hop count, temperature/humidity; Leaflet map with cyan pins (remote) and purple pin (local node), auto-flies to first GPS fix on connect; scrollable message log with auto-scroll; all state degrades cleanly to "Searching…" when no device is present

**Configuration (env vars):**
```
MESH_ENABLE=1          # 1 = start handler on boot (default: 1)
MESH_PORT=             # serial port path — leave blank for auto-detect
                       # e.g. MESH_PORT=/dev/ttyUSB0 to pin the Heltec V3
```

**Hardware note — Heltec WiFi LoRa 32 V3:**  
The Heltec V3 uses a CP2102N USB-Serial chip and appears as `/dev/ttyUSB0` on the Pi. Auto-detect finds it without setting `MESH_PORT`. The Pi user must be in the `dialout` group to open the port:
```bash
sudo usermod -aG dialout $USER   # then log out and back in
```

**Known limitations:**
- TRACEROUTE packets are received but not displayed in the UI (logged only)
- No TX / send-message capability — receive/monitor only
- Node telemetry is displayed as current values; no sparkline history yet

---

## Pre-Beta Feature Roadmap

### 1. ADS-B Dashboard

Decode aircraft transponder broadcasts on 1090 MHz and display live traffic on a map.

**Requires: dedicated RTL-SDR dongle (device 2)**

**Backend:**
- Run `dump1090-fa` or `readsb` as a managed subprocess (same pattern as `rtl_tcp`)
- Poll `dump1090` JSON output (`/run/dump1090-fa/aircraft.json`) at 1 Hz
- WebSocket endpoint `/ws/adsb` — broadcast aircraft state vectors
- REST endpoint `GET /api/aircraft` — current snapshot

**Frontend:**
- Dedicated ADS-B page/tab (or panel within the main dashboard)
- Leaflet map — aircraft plotted as directional icons (heading-aware)
- Click aircraft for callsign, squawk, altitude (ft/m), speed (kts), vertical rate, ICAO hex
- Aircraft track history (last N positions drawn as a polyline)
- Altitude colour-coded icons (ground / low / mid / high)
- Table view alongside map: sortable by distance, altitude, callsign

**Data:**
- `dump1090` handles all ADS-B decoding natively — no additional decoder needed
- Optional: feed to `tar1090` for a standalone ADS-B sub-page if desired
- ICAO → airline/registration lookup via local `aircraft.json` database

---

### 2. APRS Decoding

Decode Automatic Packet Reporting System traffic on 144.390 MHz (North America) or regional equivalent.

**Requires: dedicated RTL-SDR dongle (device 3 recommended, or time-share with DMR)**

**Backend:**
- `direwolf` as the TNC — receives FM-demodulated audio from the SDR, outputs APRS frames to stdout
- Parse APRS frames: position, weather, messages, objects, telemetry
- Store last-heard positions per callsign (in-memory + JSON on disk)
- WebSocket endpoint `/ws/aprs` — broadcast decoded packets
- REST endpoint `GET /api/aprs/stations` — current station snapshot

**Frontend:**
- Dedicated APRS panel / tab
- Leaflet map — stations plotted with standard APRS symbol icons
- Click station: callsign, last heard, comment, path, packet type
- Packet log (scrollable, newest first): timestamp, callsign, type, raw or decoded summary
- Weather packet display when WX data is present (temp, wind, rain)
- Symbol icon set: use the standard APRS symbol tables (two-table system)

**Notes:**
- `direwolf` can also act as a digipeater / igate if ever desired — architecture supports it

---

## Current DMR Dashboard — Remaining Pre-Beta Items

### Audio (highest priority — see warning above)
- [ ] Fix audio choppiness — root cause still under investigation
- [ ] Volume control slider in the UI
- [ ] Per-talkgroup squelch / mute
- [ ] Audio recording — save decoded voice to timestamped WAV files per call

### DMR Intelligence
- [ ] Talkgroup alias file — CSV import mapping TG numbers to friendly names (e.g., "91 → Worldwide", "3116 → Texas")
- [ ] Full RadioID.net database import — local SQLite snapshot for offline ID lookups (removes API rate limits and latency)

### Infrastructure
- [ ] Systemd service file — `hampi-dashboard.service` for auto-start on boot, restart on failure
- [ ] Config file (`config.yaml` / `config.toml`) — frequencies, gain, talkgroup aliases, scan lists, squelch levels; replaces hard-coded env vars and airband channel list
- [ ] udev rules — stable USB device aliases so dongle roles don't swap on reboot (critical for multi-dongle setups)

---

## Infrastructure (Applies to All Modes)

### Web Server
- FastAPI serves all modes from a single process on port 8000
- Each mode adds its own WebSocket endpoint(s) and REST routes
- Static frontend served from `frontend/dist` — single React app with tab/page routing per mode

### Frontend Routing
- React Router: `/` (Home), `/dmr`, `/adsb`, `/aprs`, `/meshtastic`, `/airband`
- Persistent nav bar across all pages
- Each mode is an independently mounted React subtree; disconnects its WebSocket on unmount

### Multi-Dongle Architecture
Each receive mode owns its own `SDREngine` → `rtl_tcp` subprocess pair. The `SDREngine` `device_index` parameter selects the hardware dongle; `rtl_tcp_port` must be unique per instance.

**udev rules (example — add to `/etc/udev/rules.d/99-rtlsdr.rules`):**
```
# Pin dongles by serial number so device indices are stable across reboots
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000001", SYMLINK+="rtlsdr0"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", ATTRS{serial}=="00000002", SYMLINK+="rtlsdr1"
```

Get dongle serial numbers with: `rtl_eeprom -d 0` and `rtl_eeprom -d 1`  
Set serial numbers with: `rtl_eeprom -d 0 -s 00000001`

### Config File (planned)
```yaml
# config.yaml (planned)
sdr:
  primary_freq: 438800000
  gain: 49.6
  sample_rate: 2400000

airband:
  rtl_device: 1
  rtl_port: 1235
  gain: 40.0
  squelch: 0.01
  dwell_ms: 2000
  frequencies:
    - { freq: 121500000, label: "Guard" }
    - { freq: 123450000, label: "CTAF" }
    - { freq: 126200000, label: "Center" }
    - { freq: 132850000, label: "Departure" }

aprs:
  freq: 144390000
  rtl_device: 2

talkgroups:
  91: "Worldwide"
  93: "North America"
  3116: "Texas"
```

### Hardware / OS
- Migrate to Pi 5 (8 GB) before adding ADS-B + APRS simultaneously
- Blacklist `dvb_usb_rtl28xxu` permanently (`/etc/modprobe.d/rtlsdr.conf`) to prevent USB re-grab on connect
- Assign each SDR dongle a stable USB alias via udev rules (see above)
- `systemd` service per long-running subprocess (`rtl_tcp`, `dump1090`, `direwolf`) with `Restart=on-failure`

---

## Priority Order (updated)

1. **Fix DMR audio choppiness** — blocking for usable voice monitoring
2. **Systemd + config.yaml** — quality of life; stops manual env-var sessions, makes channel list editable
3. **udev rules** — required for stable multi-dongle operation
4. **ADS-B** — third dongle; `dump1090` does all the heavy lifting; high visual impact
5. **APRS** — fourth dongle or time-share; `direwolf` handles decoding
6. **Talkgroup aliases + RadioID local DB** — DMR polish
7. **Full beta tag**

✅ ~~Meshtastic~~ — implemented in 0.1.1_m3shd4ddY
