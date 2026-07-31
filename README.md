# HamPi SDR Dashboard

![Python](https://img.shields.io/badge/Python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-asyncio-009688?style=flat-square&logo=fastapi&logoColor=white)
![RTL-SDR](https://img.shields.io/badge/RTL--SDR-Blog_V4-ff6600?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Raspberry_Pi-c51a4a?style=flat-square&logo=raspberry-pi&logoColor=white)
![Version](https://img.shields.io/badge/version-0.9--b3t6_HamPi-blueviolet?style=flat-square)
![Status](https://img.shields.io/badge/status-beta-orange?style=flat-square)

---

> **A $50 Raspberry Pi that hears everything in the air around you — and shows it in a browser.**

One Pi. One RTL-SDR dongle (more if you're greedy). A dark browser tab on your phone.
Digital voice decoded. Aircraft tracked. Mesh nodes mapped. Weather satellites imaged.
**No cloud. No subscription. Nothing leaves your network unless you flip a switch that says so.**

---

## What's live

| Mode | Status | What it does |
|---|---|---|
| 📡 DMR digital voice | ✅ Live | decode + **live audio** · talkgroup aliases · offline RadioID DB (307k users) · call history |
| 🚔 Trunked DMR | ✅ Live | Connect Plus control-channel tracking via SDRTrunk · call log · encryption flags |
| ✈️ ADS-B 1090 MHz | ✅ Live | aircraft map · CPR positions · local fleet DB (516k airframes) · track history |
| 📻 Scanner AM/FM | ✅ Live | AM + FM anywhere in VHF/UHF · editable `.ini` favourites · adjustable dwell + hold |
| 📻 APRS | ⏳ Waiting on antenna | direwolf TNC · station map · packet log — chain runs, but a 70cm whip is deaf on 2m, so no off-air decode yet |
| 📟 AX.25 | ⏳ Waiting on antenna | KISS terminal · raw frames · click-to-tune waterfall — same 2m problem |
| 📺 SSTV | ⏳ Waiting on a bird | Scottie/Martin/Robot36 decoder + live canvas · satellite tracking with Doppler auto-tune — needs an ISS event or a local test signal |
| 🌍 METEOR LRPT | ⏳ Waiting on a pass | 137 MHz QPSK via SatDump · decoder verified running · first MSU-MR composite needs a satellite overhead |
| 🌐 Meshtastic LoRa | ✅ Live | node map · messages · send/DM — 204-node mesh on the bench |
| 🛰️ Satellite telemetry | ✅ Live | TinyGS board → local MQTT · packet feed with hex dump |
| 🕐 HamClock | ✅ Live | OpenHamClock on-device (port 3001) · propagation, DX, greyline · `/hamclock` page + home widget · config generated locally |
| 📊 Waterfall | ✅ Live | 2.4 MHz FFT · click-to-tune · memory channels |
| 📱 Mobile | ✅ Live | responsive layout, phone-first tested |
| 📶 Radio TX (Phase A) | 🚧 Started, not RF-confirmed | Digirig PTT + tone calibration page. A valid APRS beacon left the software; nobody has yet seen the radio's TX LED. Honest status: **not done.** |

The status column is real — it comes from [AUDIT.md](AUDIT.md), where every row was
exercised on hardware and classified. "Live" means verified end-to-end this month,
not "compiled once."

One dongle covers every SDR mode through the home-page mode switcher. Extra dongles
let modes run simultaneously.

## Hardware

| | |
|---|---|
| **Pi** | Raspberry Pi 4 (4 GB) — what this runs on. Pi 5 has headroom to spare |
| **SDR** | RTL-SDR Blog V4 (or any RTL2832U) |
| **Dongles** | 1 → mode-switch everything · 2 → DMR + scanner at once · 3 → add dedicated ADS-B |
| **Mesh** | any Meshtastic USB device — here: Heltec WiFi LoRa 32 V3 |
| **Satellite RX** | LilyGO T3 LoRa32 running TinyGS firmware (optional) |
| **TX (Phase A)** | Digirig Mobile + an HT (BF-F8HP Pro here) — optional, gated off by default |

## Setup

Two things do **not** come from apt and have to be built from source first:
the RTL-SDR Blog V4 driver (the stock `librtlsdr` doesn't know the V4's tuner)
and `dsd-fme` (not packaged anywhere). Follow their READMEs:

- https://github.com/rtlsdrblog/rtl-sdr-blog — build, install, then the blacklist step below
- https://github.com/lwvmobile/dsd-fme — build; it lands in `/usr/local/bin`

```bash
# Free the dongle from the kernel DVB driver (once, then replug)
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null; true

# These two ARE in apt (direwolf = APRS/AX.25 TNC, satdump = METEOR LRPT)
sudo apt install direwolf satdump

# Serial access for Meshtastic / TinyGS / Digirig
sudo usermod -aG dialout $USER   # log out and back in

# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install && npm run build

# Configure
cd ..
cp config.yaml.example config.yaml   # then edit: QTH, talkgroups, frequencies

# Run once in the foreground to see it come up
cd backend && python main.py
```

Open `http://<pi-ip>:8000` from anything on your LAN. Works over
[Tailscale](https://tailscale.com) too.

### Run on boot

```bash
sudo cp hampi-dashboard.service /etc/systemd/system/   # check the paths/user inside
sudo systemctl daemon-reload
sudo systemctl enable --now hampi-dashboard
```

Stopping the service kills the whole subprocess tree (rtl_tcp, dsd-fme,
direwolf, satdump) via cgroup — no orphans holding the dongle.

### Stable device names (udev)

```bash
sudo cp 99-hampi.rules /etc/udev/rules.d/    # edit the serials to match YOUR hardware
sudo udevadm control --reload && sudo udevadm trigger
```

Gives you `/dev/meshtastic`, `/dev/tinygs`, and `/dev/digirig` regardless of plug
order. RTL dongles are different: udev symlinks don't help because the tools select
by index or EEPROM serial. Write non-numeric serials (`rtl_eeprom -d 0 -s HAMPI0`,
replug) and put those in the `rtl_device:` keys in config.yaml.

### Local databases (optional, worth it)

```bash
cd backend
venv/bin/python build_radioid_db.py    # DMR users   → radioid.db   (17 MB, 307k)
venv/bin/python build_aircraft_db.py   # ADS-B fleet → aircraft.db  (34 MB, 516k)
```

One-time downloads. With these present, every caller and aircraft lookup is a local
sqlite read and nothing touches the internet. Re-run whenever you want a fresh
snapshot. Without `radioid.db` the DMR page falls back to the RadioID.net API per
lookup — it works, but that's your monitoring habits leaving the LAN.

## Configuration

Everything lives in `config.yaml` at the repo root —
[`config.yaml.example`](config.yaml.example) documents every key. The old env var
names (`SDR_FREQ`, `SCAN_SQUELCH_FM`, …) still work and **override** the yaml, so
systemd drop-ins and one-off shell overrides behave as expected. Anything set
nowhere falls back to a sane default.

```yaml
sdr:      { freq: 438800000, gain: 49.6 }     # device 0 — mode switcher home base
qth:      { grid: EM95of }                    # drives all satellite pass prediction
scanner:
  rtl_device: 1                               # index or EEPROM serial ("HAMPI1")
  squelch_am: 0.01                            # AM and FM squelch on different metrics
  squelch_fm: 0.05
  dwell_ms: 2000                              # time on a quiet channel
  hold_s: 1.0                                 # extra time held after a signal drops
  favorites: ../scanner_favorites.ini         # channel list; wins over the seed below
talkgroups:                                   # DMR aliases shown next to TG numbers
  91: "Worldwide"
  3116: "Texas"
geocode:
  enable: false                               # caller-map pins query OSM Nominatim —
                                              # city/state of heard calls leaves the
                                              # LAN. Your call. Off means empty map.
station:
  callsign: ""                                # REQUIRED before any transmit
radio:
  tx_enable: false                            # the TX master switch. Default: off.
```

### The mode switcher

Device 0 has one owner at a time. The home-page toggle moves it between
**DMR · Scanner · ADS-B · SSTV · APRS · METEOR · Trunk** with no restart. APRS mode
also feeds the AX.25 terminal (one direwolf, two decoders). METEOR hands the dongle
to SatDump; Trunk hands it to the SDRTrunk service. If a switch fails, the backend
rolls back to DMR automatically — that path is tested, not aspirational.

## The modes, briefly

**DMR** — dsd-fme decodes Tier II metadata (timeslot, color code, talkgroup, source
ID, talker alias) and now blasts decoded voice back over UDP for live listening in
the browser. Every caller resolves against the offline RadioID snapshot. Call
history survives restarts.

**Trunked DMR** — a MOTOTRBO Connect Plus site tracked by SDRTrunk running as a
systemd user service; the dashboard starts and stops it so there's never a fight
over the dongle. Decoded call events (and who's encrypted) land in the page; the
full SDRTrunk UI is a VNC hop away if you need it.

**ADS-B** — rtl_adsb + pyModeS on 1090 MHz. Positions from CPR pairs (set
`adsb.lat_ref`/`lon_ref` to decode from single frames too). Registration, type,
operator joined from the local fleet DB at first sighting.

**Scanner** — AM and FM anywhere the tuner reaches, one channel list, modulation
picked per channel. AM is envelope detection with a 3.5 kHz voice LPF and AGC; FM
is a discriminator with AGC that squelches on carrier magnitude taken *before* the
discriminator, because FM audio is loudest on pure noise. Squelch is two values for
that reason. Dwell and hold are adjustable live; click a channel to lock it.
Favourites live in an editable `.ini` you can edit in the page, upload, or download.

**APRS + AX.25** — direwolf fed demodulated FM straight over stdin, no soundcard
loopback. aprslib parses positions/weather/messages onto a map; the raw AX.25
frames go to a green-on-black terminal via KISS. Both verified to the antenna
jack — see the audit for why the packet counter reads zero.

**SSTV** — five modes decoded via Hilbert instantaneous frequency, live canvas
painting line by line. The satellite panel tracks ISS and four CubeSat SSTV birds
with pass prediction and per-second Doppler retuning for your grid square.

**METEOR LRPT** — SatDump does the QPSK → Viterbi → Reed-Solomon → image chain
(nobody should hand-roll that); the dashboard owns the pass workflow: dedicated
rtl_tcp, live SNR, gallery, AOS countdowns from Celestrak TLEs.

**Meshtastic** — auto-connects over USB serial, maps the mesh, sends broadcasts and
DMs with the 228-byte limit enforced.

**Satellite telemetry** — a TinyGS LilyGO publishes received satellite packets to
the Pi's own Mosquitto; the dashboard subscribes and shows RSSI/SNR/frames with a
hex dump. The board's firmware is patched to talk to local MQTT instead of the
TinyGS cloud.

**Radio TX (Phase A)** — the beginning of the transmit era. RTS-line PTT through a
Digirig, tone generator for deviation calibration, and three hard gates in front of
all of it: `radio.tx_enable: false` by default, a callsign requirement on every TX
call, and the serial port never opened until both are satisfied. Current truth:
software made a valid beacon, RF confirmation still pending an operator at the
radio. [ROADMAP-NEXT.md](ROADMAP-NEXT.md) has the plan.

## Architecture

```
Device 0 — one owner at a time (home-page switcher)
  ├─ [DMR]     rtl_tcp :1234 → SDREngine → FM demod → dsd-fme ─ stderr → /ws/dmr
  │                                                   └ UDP audio → /ws/dmr-audio
  ├─ [Scanner] rtl_tcp :1234 → SDREngine → AM/FM demod → squelch gate → /ws/scanner
  ├─ [ADS-B]   rtl_adsb -d 0 → pyModeS → /ws/adsb
  ├─ [SSTV]    rtl_tcp :1234 → SDREngine → FM demod → SSTVDecoder → /ws/sstv
  │                              └ sat tracker retunes for Doppler once/second
  ├─ [APRS]    rtl_tcp :1234 → SDREngine → FM demod → direwolf ─ stdout → /ws/aprs
  │                                                   └ KISS :8001 → /ws/ax25
  ├─ [METEOR]  rtl_tcp :1236 → SatDump live pipeline → image watcher → /ws/meteor
  └─ [Trunk]   SDRTrunk (systemd user svc, libusb) → log/CSV tail → /ws/trunk

Always on, own hardware:
  Heltec V3 (USB)      → MeshtasticHandler → /ws/meshtastic
  LilyGO T3 (TinyGS)   → local Mosquitto  → SatelliteMonitor → /ws/satellite
  Digirig (USB, gated) → RadioInterface   → /api/radio/*

FastAPI on :8000 — one process, WS + REST per mode, static frontend from dist/
```

Separate class per mode, each owning its subprocess or serial connection; all
WebSocket and REST endpoints registered in `main.py`. That pattern is load-bearing —
new modes copy it.

## Troubleshooting

**`usb_claim_interface error -6` / device won't open**
The kernel DVB driver grabbed the dongle. Run the blacklist step in Setup, replug.

**Mode switch failed and I'm back in DMR**
That's the rollback doing its job. Check `journalctl -u hampi-dashboard` for what
the target mode choked on — usually the dongle was still settling from the last
owner; try again in a few seconds.

**Scanner: silence**
Silence is the squelch working. If you never hear anything, lower the squelch
slider for that channel's mode — AM and FM have separate ones; if it's all static,
raise it. With one dongle make sure device 0 is actually in Scanner mode — it's the
first thing to check for any "no data" symptom.

**ADS-B: aircraft in the list but not on the map**
Position needs two CPR frames (even+odd) per aircraft, or one frame plus
`adsb.lat_ref`/`lon_ref` in config.yaml. Set your coordinates; it decodes faster.

**APRS/AX.25: pipeline up, zero frames**
direwolf sitting at ~15% CPU means audio is flowing — the silence is RF. 144.39
needs a 2m-capable antenna; a 70cm whip is deaf there. This install is living
proof: full audit passed, zero packets heard.

**SSTV: canvas stays black**
Check the mode first (device 0 must be in SSTV mode). The RMS bar should twitch on
any signal. ISS events are announced at [amsat.org](https://www.amsat.org) — between
events, 145.800 is quiet, that's normal.

**METEOR: SNR bouncing around 0, "NOSYNC"**
No satellite overhead. The pass table on the page tells you when the next one is;
switch to METEOR mode a minute before AOS and let it run through LOS.

**Trunk: "Starting" never becomes "Locked"**
SDRTrunk takes ~20 s to claim the tuner. Stuck longer: something else has device 0
— go to the home page, switch back to Trunk to force a clean handoff.

**Meshtastic: "Searching for device…"**
`groups $USER` must include `dialout`. ModemManager loves to steal serial ports:
`sudo systemctl disable --now ModemManager`. Multiple serial devices? Pin
`meshtastic: port:` in config.yaml or install the udev rules.

**DMR caller map is empty**
Not broken — geocoding is off by default because it sends heard callers'
city/state to OpenStreetMap. `geocode: enable: true` if you're fine with that.

**Two dongles fighting**
Same device index. Give them EEPROM serials (see udev section).

## Version history

### 0.9-b3t7 — 2026-07-31
**Airband became Scanner.** The AM airband scanner is now a general AM/FM scanner
across the tuner's whole VHF/UHF range, modulation picked per channel — an airband
AM channel and a 2 m FM repeater can sit in the same list. New `nbfm_demodulate()`
in [sdr.py](backend/sdr.py) (AGC + carrier-magnitude squelch metric taken before
the discriminator; the DMR/APRS/SSTV FM path is untouched). Squelch is two values,
AM and FM, because the metrics are not the same quantity. Dwell and hold are now
adjustable live — the old dwell slider posted nothing. Favourites moved to an
editable [scanner_favorites.ini](scanner_favorites.ini) you can edit in the page,
upload, or download; it wins over `config.yaml`, which is now just the seed.
`airband.py` → `scanner.py`, `/airband` → `/scanner`, `AIRBAND_*` → `SCAN_*`.

### 0.9-b3t6 — 2026-07-23 · Code Named HamPi
The polish release. **OpenHamClock** folded in as a first-class page (`/hamclock`)
with an on-device config generator ([gen_hamclock_config.py](backend/gen_hamclock_config.py)) —
no cloud, runs on port 3001. Matrix motif applied across every page; RX home
redesigned with live feeds, a mode-lock light, and honest empty states. Deep-links
and hard-reloads on subpages no longer 404 (SPA fallback fixed). DMR live audio
re-prime bug fixed and the audio worklet hardened; SDRTrunk encryption-flag and
call-log handling improved; BrandMeister talkgroup aliases ([talkgroups_bm.json](talkgroups_bm.json))
added.

<details>
<summary>Earlier releases</summary>

### 0.9-b3t5 — 2026-07-06
The audit release. Every feature exercised on hardware and classified in
[AUDIT.md](AUDIT.md); four bugs found and fixed (rtl_tcp zombie on kill-timeout,
negative call durations, ANSI codes in the METEOR log, four pages that never
reconnected their WebSocket). All user-facing text rewritten by hand. UI unified —
shared status indicators, honest empty states, mode switcher front and center.
Since 0.9-b3t4: **METEOR LRPT** (SatDump), **SSTV satellite tracking** (Doppler
auto-tune), **trunked DMR** (SDRTrunk Connect Plus), **DMR live audio** (UDP
blaster), and **TX Phase A** started — beacon built, RF unconfirmed.

### 0.9-b3t4 — 2026-06-12 · BETA
Every numbered roadmap item shipped. AX.25 packet terminal (KISS on the shared
direwolf), ADS-B local fleet DB, offline RadioID DB, talkgroup aliases, direwolf
hardening.

### 0.3.0_p4ck3t5 — 2026-06-12
APRS live via direwolf over stdin. config.yaml became the primary config. systemd
service + udev rules. DMR call end-time fix. WS zombie-reconnect fix.

### 0.2.2_rustylives — 2026-06-08
TinyGS satellite telemetry via local MQTT (firmware cert bypass against the local
broker). Meshtastic multi-device crash fix.

### 0.2.1_piperrrrr — 2026-06-05/07
SSTV decoder (five modes, live canvas). Mobile-responsive layout. DMR audio
removed (came back better in b3t5).

### 0.2.0 and earlier — 2026-05/06
ADS-B live map + pyModeS 3.3 rewrite, SDR mode switcher, Meshtastic send/DM,
airband scanner, first light.

</details>

[Full commit history →](https://github.com/sinetec6969/hampi-dashboard/commits/master)

## Roadmap

Roadmap I (RX) is done — [ROADMAP.md](ROADMAP.md). The TX era is
[ROADMAP-NEXT.md](ROADMAP-NEXT.md):

- **Phase A, in progress:** Digirig bring-up. Blocked on a human confirming the
  radio actually keys (TX LED), then deviation by ear, then decoding our own
  beacon. Also: a 2m antenna, which unblocks APRS/AX.25 RX at the same time.
- **Then:** APRS beacon + messaging, AX.25 connected mode, HamPi as a LAN KISS
  TNC, SSTV transmit, Winlink.

---

*Built on a Pi. Runs on your LAN. Hears everything.*
