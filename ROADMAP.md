# HamPi Dashboard — Roadmap

Local multi-mode RF monitoring dashboard running on a Raspberry Pi, served via a locally-hosted web server. All decoding, storage, and serving happens on-device — no cloud dependencies.

> **Current version:** 0.0.8-1_THEYMISSEDTHEBARN  
> **Status:** Pre-beta. DMR voice decode, call history log, and live caller map are functional. Audio playback is work-in-progress. The features below are planned additions before a stable beta release.

---

## Hardware Target

| Phase | Board | Notes |
|---|---|---|
| Current | Raspberry Pi 4 (4 GB) | Running DMR stack |
| Pre-beta | Raspberry Pi 5 (8 GB) | Better compute for parallel decoders + ADS-B + Meshtastic |

**SDR dongles needed (estimate):**
- Dongle 1 — DMR / APRS / airband scanner (shared, one at a time, or scanning)
- Dongle 2 — ADS-B dedicated (1090 MHz, benefits from always-on)
- Optional dongle 3 — simultaneous airband while DMR is active

---

## Pre-Beta Feature Roadmap

### 1. ADS-B Dashboard

Decode aircraft transponder broadcasts on 1090 MHz and display live traffic on a map.

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
- May share an SDR dongle with DMR via time-division or use a dedicated stick on 144 MHz

---

### 3. Meshtastic Decoding

Monitor a local Meshtastic LoRa mesh network — node positions, messages, telemetry.

**Backend:**
- Connect to a Meshtastic device via USB serial or TCP using the `meshtastic` Python package
- Subscribe to `meshtastic.mesh_pb2` packet stream
- Decode: `NODEINFO`, `POSITION`, `TELEMETRY`, `TEXT_MESSAGE`, `TRACEROUTE` packet types
- Maintain a node registry (ID → long name, short name, hardware model, last heard, position, battery)
- WebSocket endpoint `/ws/meshtastic` — broadcast decoded packets
- REST endpoint `GET /api/meshtastic/nodes` — current node snapshot

**Frontend:**
- Dedicated Meshtastic panel / tab
- Node map — positions plotted on Leaflet, labelled with short names
- Click node: long name, hardware, firmware, last heard, SNR/RSSI of last packet, battery %
- Message log — channel text messages with sender, timestamp, hop count
- Node list table — sortable, shows online/offline (last heard < 15 min = online)
- Telemetry sparklines (battery voltage, temperature if reported)

**Notes:**
- Does not require an SDR — communicates directly with a Meshtastic USB device
- No RF licensing required for monitoring-only (no TX needed)

---

### 4. Airband AM Reception

Receive VHF airband voice (118–137 MHz) with AM demodulation.

**Backend:**
- Extend `sdr.py` `SDREngine` with AM demodulation path alongside existing FM
- Demodulation: frequency-shift to target → decimate 2.4 MHz → 48 kHz → AM envelope detection (abs + LPF) → AGC → int16 PCM
- Scanner mode: cycle through a configurable frequency list with configurable dwell time; hold on squelch break
- Config: frequency list stored in `config.yaml` (see Infrastructure below) with labels (e.g., "ATIS", "Ground", "Tower", "Approach")
- WebSocket endpoint `/ws/airband` — raw PCM audio, same format as DMR audio stream

**Frontend:**
- Airband panel with frequency list — highlight active (squelch open) frequency
- Integrated audio player (same AudioWorklet path as DMR)
- Squelch control slider
- Scanner on/off toggle and dwell-time setting
- Optionally display current ATIS text if a separate ATIS decoder is added later

**Notes:**
- Sharing the RTL-SDR with DMR requires time-multiplexing or a second dongle
- A second dongle dedicated to 118–137 MHz is the recommended path for simultaneous airband + DMR
- AM demodulation is straightforward to add to `sdr.py` — significantly simpler than FM discriminator

---

## Current DMR Dashboard — Remaining Pre-Beta Items

These are open items on the existing DMR stack before calling it stable.

### Audio (highest priority)
- [ ] Fix audio choppiness — root cause still under investigation; PACE_AHEAD increase helped but not resolved
- [ ] Volume control slider in the UI
- [ ] Per-talkgroup squelch / mute
- [ ] Audio recording — save decoded voice to timestamped WAV files per call (was implemented, removed; re-add when audio pipeline is stable)

### DMR Intelligence
- [ ] Talkgroup alias file — CSV import mapping TG numbers to friendly names (e.g., "91 → Worldwide", "3116 → Texas")
- [ ] Full RadioID.net database import — local SQLite snapshot for offline ID lookups (removes API rate limits and latency)

### Infrastructure
- [ ] Systemd service file — `hampi-dashboard.service` for auto-start on boot, restart on failure
- [ ] Config file (`config.yaml` / `config.toml`) — frequencies, gain, talkgroup aliases, scan lists, squelch levels; replaces hard-coded env vars
- [ ] Multi-dongle support — parallel receive on different bands simultaneously

---

## Infrastructure (Applies to All Modes)

### Web Server
- FastAPI continues to serve all modes from a single process on port 8000
- Each new mode adds its own WebSocket endpoint(s) and REST routes
- Static frontend served from `frontend/dist` — single React app with tab/page routing per mode

### Frontend Routing
- React Router for mode switching: `/` (DMR), `/adsb`, `/aprs`, `/meshtastic`, `/airband`
- Persistent nav bar across all pages
- Each mode is an independently mounted React subtree; disconnects its WebSocket on unmount

### Config File
```yaml
# config.yaml (planned)
sdr:
  primary_freq: 438800000
  gain: 49.6
  sample_rate: 2400000

airband:
  frequencies:
    - { freq: 121500000, label: "Guard" }
    - { freq: 123450000, label: "CTAF" }
  dwell_ms: 2000
  squelch: 0.02

aprs:
  freq: 144390000

talkgroups:
  91: "Worldwide"
  93: "North America"
  3116: "Texas"
```

### Hardware / OS
- Migrate to Pi 5 (8 GB) before adding ADS-B + APRS simultaneously
- Blacklist `dvb_usb_rtl28xxu` permanently (`/etc/modprobe.d/rtlsdr.conf`) to prevent USB re-grab
- Assign each SDR dongle a stable USB alias via udev rules so dongle roles don't swap on reboot
- `systemd` service per long-running subprocess (`rtl_tcp`, `dump1090`, `direwolf`) with `Restart=on-failure`

---

## Rough Priority Order

1. Fix DMR audio (blocking for good demo quality)
2. Systemd + config file (quality of life — stops manual start sessions)
3. Airband AM (extends the SDR already present; AM demod is a small backend change)
4. ADS-B (needs second dongle; high visual impact; `dump1090` does all the heavy lifting)
5. APRS (needs second dongle or time-share; `direwolf` handles decoding)
6. Meshtastic (needs a Meshtastic USB device; no SDR required)
7. Talkgroup aliases + RadioID local DB (DMR polish)
8. Full beta tag
