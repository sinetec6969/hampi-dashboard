<div align="center">

```
██╗  ██╗ █████╗ ███╗   ███╗██████╗ ██╗
██║  ██║██╔══██╗████╗ ████║██╔══██╗██║
███████║███████║██╔████╔██║██████╔╝██║
██╔══██║██╔══██║██║╚██╔╝██║██╔═══╝ ██║
██║  ██║██║  ██║██║ ╚═╝ ██║██║     ██║
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═╝
      ▚ 0.9-b3t8 · r3b0rn ▚
```

### The whole spectrum. One Raspberry Pi. Zero cloud.

![Version](https://img.shields.io/badge/version-0.9--b3t8_r3b0rn-00ff88?style=for-the-badge&labelColor=030604)
![Status](https://img.shields.io/badge/status-beta-ffb000?style=for-the-badge&labelColor=030604)
![Cloud](https://img.shields.io/badge/cloud-none-ff3355?style=for-the-badge&labelColor=030604)

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-asyncio-009688?style=flat-square&logo=fastapi&logoColor=white)
![RTL-SDR](https://img.shields.io/badge/RTL--SDR-Blog_V4-ff6600?style=flat-square)
![Platform](https://img.shields.io/badge/Raspberry_Pi_4-trixie-c51a4a?style=flat-square&logo=raspberry-pi&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**DMR voice · WebSDR · ADS-B · pagers · TPMS · BLE trackers · mesh · satellites**
*decoded on-device, served to any browser on your LAN or tailnet*

</div>

---

> **A Raspberry Pi that hears everything in the air around you — and shows it in a browser.**

One Pi 4. One RTL-SDR Blog V4. A dark browser tab on your phone.
Digital voice decoded. Aircraft tracked. Pagers, tire sensors and Bluetooth trackers
logged. Mesh nodes mapped. A WebSDR-style receiver you can zoom, tune and tag.
**No cloud. No subscription. No API keys. Nothing leaves your network unless you
flip a switch that says so.**

### ⚡ New in r3b0rn

Wiped the SD card, rebuilt the Pi from nothing on Debian 13 — and it came back with more ears.

| | |
|---|---|
| 🎛️ **WebSDR** | Zoom the waterfall from 2.4 MHz down to 19 kHz. NFM · AM · WFM · USB · LSB · CW. Drag the passband. Tag what you find. |
| 📟 **Pager** | POCSAG + FLEX, live-retunable. Found the local FLEX carrier and pulled 34 pages in 90 seconds. |
| 🚗 **Sub-GHz** | rtl_433 hopping 433.92 ↔ 315 MHz — weather stations, doorbells, remotes, and the tire-pressure sensors of cars going by. |
| 🔵 **BLE** | The Pi's own Bluetooth, running beside every SDR mode. Flags AirTags separated from their owner, Tiles, SmartTags. |
| 🗺️ **Offline maps** | Self-hosted vector tiles. No tile server, no API key — your map views stay home. |

---

## What HamPi is

A single-box, on-device radio station. Everything is decoded on the Pi, served by
one FastAPI process, and viewed from any browser on the LAN or tailnet. It is a
**depth play**: every mode below was exercised on real hardware and classified
honestly — "live" means it decoded real off-air signals, not "it compiled."

Two ideas run through all of it:

- **Hear everything.** DMR voice, trunked systems, aircraft, pagers, ISM sensors,
  mesh radio, satellites, BLE advertisers, and a general-purpose receiver for
  whatever else turns up on the waterfall.
- **Know what's around you.** The same receivers double as surveillance awareness:
  static TPMS IDs from passing cars, Find My / Tile / SmartTag trackers that
  separated from their owner, Ring-class devices announcing themselves. You can't
  defend against what you can't see.

## What's live

| Mode | Status | What it does |
|---|---|---|
| 📡 DMR digital voice | ✅ Live | decode + **live audio** · talkgroup aliases · offline RadioID DB (314k users) · call history · dsd-fme self-restarts |
| 🎛️ **WebSDR** | ✅ Live | zoomable waterfall (2.4 MHz → ~19 kHz) · NFM/AM/WFM/USB/LSB/CW audio · drag-to-resize passband · **frequency tags** on the scale |
| ✈️ ADS-B 1090 MHz | ✅ Live | aircraft map · CPR positions · local fleet DB (516k airframes) · track history |
| 📟 **Pager** | ✅ Live | POCSAG 512/1200/2400 + FLEX via multimon-ng · live retune · 34 pages / 90 s on the local FLEX channel |
| 🚗 **Sub-GHz ISM** | ✅ Live | rtl_433, 300+ protocols · hops 433.92 / 315 MHz (US TPMS) · device table |
| 🔵 **BLE scan** | ✅ Live | built-in Bluetooth, runs beside any SDR mode · ~80 devices · Find My / Tile / Chipolo / SmartTag / Google FMDN tracker flags |
| 📻 Scanner AM/FM | ✅ Live (AM) | AM + FM anywhere in VHF/UHF · editable `.ini` favourites · dwell + hold · FM not yet confirmed off-air |
| 🌐 Meshtastic LoRa | ✅ Live | node map · messages · send/DM — 202-node mesh |
| 🗺️ **Offline maps** | ✅ Live | self-hosted Protomaps vector tiles — world + Carolinas to street level, no tile server |
| 🕐 HamClock | ✅ Live | OpenHamClock on-device · propagation, DX, greyline |
| 🚔 Trunked DMR | ⚠️ Not rebuilt | worked on the old SD card; SDRTrunk not yet reinstalled on the trixie rebuild |
| 📻 APRS / 📟 AX.25 | ⏳ Waiting on antenna | direwolf TNC, station map, KISS terminal — chain runs, but a 70cm whip is deaf on 2m |
| 📺 SSTV | ⏳ Waiting on a bird | five-mode decoder + satellite tracking with Doppler auto-tune |
| 🌍 METEOR LRPT | ⏳ Waiting on a pass | SatDump chain verified; first image needs a satellite overhead. The only 137 MHz imagery left — NOAA APT died in 2025 |
| 🛰️ Satellite telemetry | ⏳ Board unplugged | TinyGS → local MQTT; replug the LilyGO and it flows |
| 📶 Radio TX (Phase A) | 🚧 Not RF-confirmed | Digirig PTT + tone calibration, hard-gated off. Nobody has seen the radio's TX LED yet. **Not done.** |

Status comes from [AUDIT.md](AUDIT.md) and [STATE.md](STATE.md) — rows are exercised
on hardware, and the ⏳ rows say exactly which piece of RF or hardware they're waiting on.

## What it wants to be

**A complete, self-contained radio station on one Pi — receive, understand, and
transmit — that never needs the internet to do any of it.**

Concretely, "done" looks like:

1. **Every receive mode confirmed off-air**, not just "pipeline runs." No ⏳ left in the table.
2. **Transmit that's real and safe** — APRS beacons and messaging, AX.25 connected
   sessions to a BBS, SSTV out, Winlink email over RF, and HamPi serving as a LAN
   TNC for phones and laptops. Every TX path behind the same hard gates as Phase A.
3. **An awareness layer over all the streams** — one watchlist engine that alerts
   on an ICAO, a DMR ID, a TPMS ID, a pager capcode, or a BLE tracker that keeps
   showing up. The receivers already see it; the dashboard should *notice* it.
4. **A receiver you explore with** — the WebSDR page is where unknown signals get
   found, identified, tagged and turned into memory.
5. **Appliance-grade ops** — survives power cuts and SD wear, rebuilds from this
   repo in an afternoon, reachable anywhere over the tailnet.

What it will not become: a cloud service, a login-walled multi-user platform, or a
bundle of desktop apps behind VNC. One Pi, one process, native classes per mode.

## How we get there

In order. Each step is small enough to verify on hardware before the next.

**1. Close the RF gates** — mostly hardware and patience, no new code:
- 2m antenna on the SDR → first real APRS / AX.25 decodes
- sit METEOR mode through a pass → first MSU-MR image
- catch an ARISS SSTV event → first SSTV image
- 315 MHz TPMS decode near traffic; Scanner FM confirmed off-air; one Meshtastic send
- rebuild SDRTrunk on trixie ([SDRTRUNK.md](SDRTRUNK.md)); replug the TinyGS board

**2. Finish transmit Phase A** — a person at the radio confirms the BF-F8HP keys,
deviation set by ear, then the loopback: HamPi's own APRS receiver decodes HamPi's
own beacon. Plan: [ROADMAP-NEXT.md](ROADMAP-NEXT.md).

**3. The transmit suite** — APRS beacon + messaging → LAN KISS TNC → AX.25 connected
mode → SSTV transmit → Winlink (pat). Internet-touching pieces (iGate, Winlink CMS)
ship off by default with a "this leaves the LAN" warning.

**4. The awareness layer** — a generic alert/watchlist engine over the existing
WebSocket streams; BLE "seen-over-time" for trackers that follow you; a persistent
TPMS log; signal identification (sigidwiki-derived table) wired into WebSDR tags.

**5. More ears** — ACARS/VDL2 joined against the local airframe DB, utility meters
(rtlamr), CW decode; FT8 receive via the V4's HF coverage. A **second dongle** turns
the one-owner mode switcher into real concurrency.

**6. Hardening** — read-only root filesystem option, log rotation, a one-shot
install script that reproduces this Pi.

The receive-side plan and its sources are in [INTERCEPT.md](INTERCEPT.md); the
transmit side is [ROADMAP-NEXT.md](ROADMAP-NEXT.md); the RX era that got us here is
[ROADMAP.md](ROADMAP.md).

## Hardware

| | |
|---|---|
| **Pi** | Raspberry Pi 4 (4 GB), Debian 13 (trixie) |
| **SDR** | RTL-SDR Blog V4 — one dongle covers every SDR mode via the switcher |
| **Mesh** | Heltec WiFi LoRa 32 V3 (any Meshtastic USB device works) |
| **Bluetooth** | the Pi's built-in radio — BLE scan needs nothing else |
| **Satellite RX** | LilyGO T3 LoRa32 running TinyGS firmware (optional) |
| **TX (Phase A)** | Digirig Mobile + an HT (BF-F8HP Pro here) — optional, gated off by default |

## Setup

Several tools must be **built from source** into `/usr/local` — apt either lacks
them, ships a version without V4 support, or lacks `--json`:

| Build | Why |
|---|---|
| [rtl-sdr-blog](https://github.com/rtlsdrblog/rtl-sdr-blog) (`-DDETACH_KERNEL_DRIVER=ON`) | the stock librtlsdr doesn't know the V4's tuner |
| [mbelib](https://github.com/lwvmobile/mbelib) (`ambe_tones` branch) → [dsd-fme](https://github.com/lwvmobile/dsd-fme) | DMR voice; not packaged |
| [rtl_433](https://github.com/merbanan/rtl_433) | build against rtl-sdr-blog — apt `rtl-433` drags in the stock librtlsdr |
| [multimon-ng](https://github.com/EliasOenal/multimon-ng) | apt 1.3 has no `--json` |

Don't install apt `rtl-sdr` or `rtl-433` alongside these.

```bash
# apt: TNC, METEOR, local MQTT, frontend toolchain, build deps
sudo apt install direwolf satdump mosquitto nodejs npm cmake build-essential pkg-config \
  libusb-1.0-0-dev libsndfile1-dev libpulse-dev libncurses-dev libitpp-dev libcodec2-dev \
  libfftw3-dev liblapack-dev

# Keep the kernel DVB driver off the dongle
printf "blacklist dvb_usb_rtl28xxu\nblacklist rtl2832\nblacklist rtl2830\n" | \
  sudo tee /etc/modprobe.d/blacklist-rtlsdr.conf

# Bluetooth ships soft-blocked on Pi OS
rfkill unblock bluetooth

# Serial access for Meshtastic / TinyGS / Digirig
sudo usermod -aG dialout $USER

# Backend
cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt

# Local databases — one-time downloads, then every lookup is a local sqlite read
venv/bin/python build_radioid_db.py    # DMR users   → radioid.db  (~17 MB)
venv/bin/python build_aircraft_db.py   # ADS-B fleet → aircraft.db (~34 MB)

# Offline map tiles (Protomaps extracts, pmtiles CLI from go-pmtiles releases)
cd .. && mkdir -p tiles
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles tiles/world.pmtiles --maxzoom=6
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles tiles/region.pmtiles \
  --bbox=-85.5,32.0,-75.0,37.0 --maxzoom=14      # set the bbox to your region

# Frontend
cd frontend && npm install && npm run build && cd ..

# Configure — every key is documented in the example
cp config.yaml.example config.yaml
```

Run it in the foreground once (`cd backend && venv/bin/python main.py`), then open
`http://<pi-ip>:8000`. `GET /api/capabilities` reports which modes have their
binaries; missing ones grey out on the home page with an install hint.

### Run on boot

```bash
sudo cp hampi-dashboard.service /etc/systemd/system/   # check the paths/user inside
sudo systemctl daemon-reload && sudo systemctl enable --now hampi-dashboard
```

Stopping the service kills the whole subprocess tree via cgroup — no orphans holding the dongle.

### Remote access (Tailscale)

```bash
sudo tailscale serve --bg http://localhost:8000
```

Gives `https://<host>.<tailnet>.ts.net` with a real certificate, tailnet-only (not
Funnel). HTTPS matters: some browser APIs the UI uses need a secure context.

### Stable device names (udev)

```bash
sudo cp 99-hampi.rules /etc/udev/rules.d/    # edit the serials to match YOUR hardware
sudo udevadm control --reload && sudo udevadm trigger
```

Gives `/dev/meshtastic`, `/dev/tinygs` and `/dev/digirig` regardless of plug order.
RTL dongles select by index or EEPROM serial instead — write non-numeric serials
(`rtl_eeprom -d 0 -s HAMPI0`) and use them in the `rtl_device:` keys.

## Configuration

Everything lives in `config.yaml` — [`config.yaml.example`](config.yaml.example)
documents every key. The old env var names (`SDR_FREQ`, `SCAN_SQUELCH_FM`, …) still
work and **override** the yaml. Anything set nowhere falls back to a default.

```yaml
sdr:      { freq: 438800000, gain: 49.6 }   # device 0 — DMR home base
qth:      { grid: EM95of }                  # drives satellite pass prediction
subghz:   { freqs: [433920000, 315000000], hop_s: 60 }
pager:    { freq: 929612500, gain: 40.0 }   # retune live from the Pager page
websdr:   { freq: 162400000, gain: 40.0 }   # starting centre
ble:      { enable: true, ttl_s: 600 }
geocode:
  enable: false          # DMR caller-map pins query OSM Nominatim — heard callers'
                         # city/state leaves the LAN. Your call. Off = empty map.
station:
  callsign: ""           # REQUIRED before any transmit
radio:
  tx_enable: false       # the TX master switch. Default: off.
```

### The mode switcher

Device 0 has one owner at a time. The home page moves it between
**DMR · Scanner · ADS-B · SSTV · APRS · METEOR · Sub-GHz · Pager · WebSDR · Trunk**
with no restart. If a switch fails, the backend rolls back to DMR automatically —
that path is tested, not aspirational. Meshtastic, TinyGS and BLE run on their own
hardware beside whatever device 0 is doing.

## The modes, briefly

**DMR** — dsd-fme decodes Tier II metadata (timeslot, color code, talkgroup, source
ID, talker alias) and blasts decoded voice back over UDP for live listening. Every
caller resolves against the offline RadioID snapshot. If dsd-fme dies it restarts itself.

**WebSDR** — a general-purpose receiver in the spirit of websdr.org. Each 2.4 MS/s
chunk becomes one spectrum line of the current view (zoom cut from an FFT of up to
131k points) and 48 kHz audio from a tunable receiver: NFM, AM, WFM with de-emphasis,
USB, LSB and CW. Click to tune, drag to pan, wheel to zoom, drag the passband edges
to set bandwidth. Tags you drop on a signal show as markers on the scale and tune
straight back to it with the same mode and bandwidth. Tuned to fit a Pi 4: worst
case 25 ms of DSP per 55 ms chunk.

**ADS-B** — rtl_adsb + pyModeS on 1090 MHz. Positions from CPR pairs (set
`adsb.lat_ref`/`lon_ref` to decode from single frames). Registration, type and
operator joined from the local fleet DB.

**Pager** — rtl_fm straight into `multimon-ng --json`; POCSAG and FLEX folded into
one page format. Retune live from the page to hunt local channels. Pages are kept
in memory only (last 300), never written to disk. *In the US, intercepting
alphanumeric pages falls under ECPA — know what you're doing.*

**Sub-GHz** — `rtl_433 -F json` hopping 433.92 MHz (sensors, doorbells, remotes) and
315 MHz (US tire-pressure sensors — static IDs, one per wheel, unencrypted).

**BLE** — BlueZ active scan on the Pi's own radio (sends scan requests to learn names), never touches the dongle. Vendors
resolved offline from the Bluetooth SIG company list; trackers flagged, including
the Find My "separated from owner" advert.

**Scanner** — AM and FM anywhere the tuner reaches, modulation per channel, squelch
on carrier magnitude taken *before* the FM discriminator. Favourites in an editable `.ini`.

**APRS + AX.25** — direwolf fed demodulated FM over stdin; positions/weather/messages
on a map, raw frames in a KISS terminal. Verified to the antenna jack.

**SSTV** — five modes decoded live, line by line; ISS and CubeSat SSTV birds tracked
with per-second Doppler retuning.

**METEOR LRPT** — SatDump does QPSK → Viterbi → Reed-Solomon → image; the dashboard
owns the pass workflow (dedicated rtl_tcp, live SNR, gallery, AOS countdowns).

**Meshtastic** — USB serial, mesh map, broadcasts and DMs, traceroute and link probes.

**Maps** — every map (ADS-B, APRS, Meshtastic, DMR callers) renders self-hosted
Protomaps vector tiles from `tiles/`. Map views don't leave the LAN.

**Radio TX (Phase A)** — RTS-line PTT through a Digirig, a tone generator for
deviation calibration, and three hard gates: `tx_enable: false` by default, a
callsign on every TX call, and the serial port never opened until both pass.

## Architecture

```
Device 0 — one owner at a time (home-page switcher)
  ├─ [DMR]     rtl_tcp → SDREngine → FM demod → dsd-fme ─ stderr → /ws/dmr
  │                                             └ UDP audio → /ws/dmr-audio
  ├─ [WebSDR]  rtl_tcp → SDREngine → WebSDRReceiver ─ zoomed FFT → /ws/websdr
  │                                                 └ demod audio → /ws/websdr/audio
  ├─ [Scanner] rtl_tcp → SDREngine → AM/FM demod → squelch → /ws/scanner
  ├─ [ADS-B]   rtl_adsb → pyModeS → /ws/adsb
  ├─ [Pager]   rtl_fm | multimon-ng --json → /ws/pager
  ├─ [Sub-GHz] rtl_433 -F json (hopping) → /ws/subghz
  ├─ [SSTV]    rtl_tcp → SDREngine → FM demod → SSTVDecoder → /ws/sstv
  ├─ [APRS]    rtl_tcp → SDREngine → FM demod → direwolf → /ws/aprs + KISS → /ws/ax25
  ├─ [METEOR]  rtl_tcp :1236 → SatDump live → image watcher → /ws/meteor
  └─ [Trunk]   SDRTrunk (systemd user svc) → log/CSV tail → /ws/trunk

Always on, own hardware:
  Heltec V3 (USB)      → MeshtasticHandler → /ws/meshtastic
  hci0 (built-in BT)   → BLEScanner        → /ws/ble
  LilyGO T3 (TinyGS)   → local Mosquitto   → SatelliteMonitor → /ws/satellite
  Digirig (USB, gated) → RadioInterface    → /api/radio/*

FastAPI on :8000 — one process, WS + REST per mode, static frontend + /tiles
```

Separate class per mode, each owning its subprocess or serial connection; all
WebSocket and REST endpoints registered in `main.py`. New modes copy that pattern.

## Troubleshooting

**`usb_claim_interface error -6` / device won't open** — the kernel DVB driver grabbed
the dongle. Blacklist it (Setup) and reboot.

**Mode switch failed and I'm back in DMR** — that's the rollback working. Check
`journalctl -u hampi-dashboard` for what the target mode choked on.

**A mode tile says NOT INSTALLED** — its binary isn't on `PATH`; the tile shows which
one and how to get it.

**Maps are blank or say "API KEY REQUIRED"** — `tiles/` is missing its `.pmtiles`
files (see Setup), or the browser cached the old CARTO build — hard refresh.

**BLE page: scanner not running** — `rfkill list bluetooth`; unblock and restart the service.

**Pager: pipeline up, no pages** — wrong frequency. Hunt with the live retune; US
paging lives at 152–159 and 929–932 MHz. The WebSDR waterfall finds the carriers fast.

**WebSDR: loud hiss** — there's no squelch yet; NFM on an empty channel is all noise.

**APRS/AX.25: pipeline up, zero frames** — 144.39 needs a 2m-capable antenna.

**SSTV / METEOR: nothing** — no satellite overhead. The pass tables say when.

**Meshtastic: "Searching for device…"** — `dialout` group, and
`sudo systemctl disable --now ModemManager` if it's stealing the port.

**DMR caller map is empty** — geocoding is off by default for privacy. `geocode: enable: true` if you're fine with that.

## Version history

### 0.9-b3t8 · r3b0rn — 2026-09-24
Rebuilt from scratch on a new SD card (Debian 13 trixie) and re-audited — every mode
switches clean, no zombies. New: **WebSDR** receiver page with zoom, six demod modes
and frequency tags; **Pager** (POCSAG/FLEX); **Sub-GHz** (rtl_433 with 315 MHz TPMS
hopping); **BLE** scanner with tracker flags; capability probe; **offline vector
maps** after CARTO's keyless basemaps started requiring an API key; Tailscale HTTPS.
Fixed: dsd-fme shutdown crash on a dead process, dsd-fme auto-restart, noisy
exception on every switch away from DMR. Dropped: NOAA APT — the satellites were
decommissioned in 2025. Details in [STATE.md](STATE.md).

### 0.9-b3t7 — 2026-07-31
**Airband became Scanner** — AM/FM across the whole VHF/UHF range, modulation per
channel, two squelch values (AM and FM metrics aren't the same quantity), live dwell
and hold, favourites in an editable [scanner_favorites.ini](scanner_favorites.ini).

<details>
<summary>Earlier releases</summary>

### 0.9-b3t6 — 2026-07-23 · Code Named HamPi
OpenHamClock folded in as `/hamclock` with an on-device config generator. Matrix
motif across every page; RX home redesigned; SPA deep-link fix; DMR live-audio and
SDRTrunk fixes; BrandMeister talkgroup aliases.

### 0.9-b3t5 — 2026-07-06
The audit release — every feature exercised and classified in [AUDIT.md](AUDIT.md),
four bugs fixed. Since b3t4: METEOR LRPT, SSTV satellite tracking, trunked DMR, DMR
live audio, TX Phase A started.

### 0.9-b3t4 — 2026-06-12 · BETA
Every numbered roadmap item shipped: AX.25 terminal, ADS-B fleet DB, offline RadioID
DB, talkgroup aliases.

### 0.3.0_p4ck3t5 — 2026-06-12
APRS via direwolf over stdin; config.yaml; systemd service + udev rules.

### 0.2.2_rustylives — 2026-06-08
TinyGS satellite telemetry via local MQTT.

### 0.2.1_piperrrrr — 2026-06-05/07
SSTV decoder; mobile layout.

### 0.2.0 and earlier — 2026-05/06
ADS-B live map, SDR mode switcher, Meshtastic send/DM, airband scanner, first light.

</details>

[Full commit history →](https://github.com/sinetec6969/hampi-dashboard/commits/master)

---

*Built on a Pi. Runs on your LAN. Hears everything.*
