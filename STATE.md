# Project State — snapshot

**Version:** 0.9-b3t7 · **Code Named HamPi** · **Updated:** 2026-09-24 · **QTH:** EM95of (Charlotte NC) · **Call:** KR4BPW

A single Raspberry Pi 4 + one RTL-SDR Blog V4, all decoding on-device, no cloud.
Rebuilt from scratch 2026-09-24 on a new SD card (Debian 13 trixie, host
`hampibase`) — the original audit was re-run there: every mode switches clean,
no zombies, self-tests pass. See [AUDIT.md](AUDIT.md) for the original
VERIFIED / RF-GATED / BROKEN breakdown.

## Live modes (device 0 switcher, plus independent Meshtastic / TinyGS / BLE)

| Mode | Audit status | Notes |
|---|---|---|
| DMR | verified | metadata + **live audio** (UDP blaster) · TG aliases · offline RadioID DB (314k) · call history · dsd-fme auto-restarts if it dies |
| Trunked DMR | **not installed** | verified on the old card; SDRTrunk + JMBE + user service not rebuilt on trixie yet (see SDRTRUNK.md) — switch fails clean and rolls back to DMR |
| Scanner AM/FM | verified (AM) | AM + FM anywhere in VHF/UHF · `.ini` favourites · adjustable dwell/hold · squelch-gated browser audio. FM path verified against synthetic IQ, not yet off-air |
| ADS-B | verified | 1090 MHz · CPR positions live · local fleet DB (516k) · track map |
| SSTV | RF-gated | decoder + sat tracking/Doppler verified; no off-air image yet (needs an ISS event or test TX) |
| APRS | RF-gated | chain runs to the antenna jack; **zero real decodes — 70cm whip is deaf on 2m** |
| AX.25 | RF-gated | KISS terminal live against direwolf; same antenna gate |
| METEOR LRPT | RF-gated | SatDump chain verified decoding; first MSU-MR composite needs a pass. Now the only 137 MHz imagery — NOAA APT is gone (see INTERCEPT.md) |
| Sub-GHz | verified | rtl_433 · hops 433.92 / 315 MHz (US TPMS) every 60 s · Acurite-606TX decoded; no 315 MHz decode yet (needs passing traffic) |
| Pager | verified | rtl_fm → multimon-ng · POCSAG + FLEX · live retune · 34 FLEX pages / 90 s on 929.6125 MHz (found by band survey; 152–159 MHz quiet here) |
| Meshtastic | verified | `/dev/meshtastic` · 202 nodes · send is code-sound, not exercised (real TX) |
| BLE scan | verified | built-in radio, runs beside any SDR mode · ~80 devices · Find My / Tile / Chipolo / SmartTag / Google FMDN tracker flags |
| Satellite telemetry | hardware-gated | MQTT path verified; **LilyGO T3 currently unplugged** — replug and it flows |

## Transmit — Phase A (in progress, NOT RF-confirmed)

Digirig wired, `/dev/digirig` udev rule installed (reinstalled on the new card;
Digirig not plugged in at rebuild time). Radio TX page
live, hard-gated: `radio.tx_enable: false` default + callsign requirement + serial
never opened until both pass (guards self-tested). A valid APRS beacon existed in
software (2026-06-13); **nobody has confirmed the BF-F8HP keys** — that TX-LED check
is the Phase A blocker, then deviation by ear, then the self-decode loopback.
A 2m antenna unblocks APRS/AX.25 RX at the same time. Plan: [ROADMAP-NEXT.md](ROADMAP-NEXT.md).

## Hardware

RTL-SDR Blog V4 (dev 0) · Heltec WiFi LoRa 32 V3 (`/dev/meshtastic`) · LilyGO T3
LoRa32 TinyGS (`/dev/tinygs`, unplugged right now) · Digirig Mobile (`/dev/digirig`)
· Baofeng BF-F8HP Pro · Signal Stick 1/4-wave 2m.

## Build / run

Clone lives at `~/projects/hampi-dashboard`; `~/hampi-dashboard` is a symlink to
it (the service unit uses that path). Source builds in `~/src`, installed to
`/usr/local`:

- **rtl-sdr-blog** (`-DDETACH_KERNEL_DRIVER=ON`) — V4 support. Don't install
  apt `rtl-sdr`/`rtl-433`: they pull in the stock librtlsdr.
- **mbelib** (`ambe_tones` branch) → **dsd-fme**
- **rtl_433** — built against the rtl-sdr-blog lib
- **multimon-ng** — apt 1.3 lacks `--json`

Apt: `direwolf satdump mosquitto nodejs npm` plus the build deps.
`/etc/modprobe.d/blacklist-rtlsdr.conf` keeps `dvb_usb_rtl28xxu` off the dongle.
Bluetooth: `rfkill unblock bluetooth` (it ships soft-blocked). Python deps in
`backend/requirements.txt` (now includes `bleak`, `bluetooth-numbers`). Config
via `config.yaml` (env vars override, defaults below both — precedence tested).
Local DBs: `backend/build_aircraft_db.py`, `build_radioid_db.py`. Auto-start:
`hampi-dashboard.service`. Stable device names: `99-hampi.rules`. Frontend:
`npm run build` in `frontend/`. `GET /api/capabilities` reports which modes
have their binaries — missing ones grey out on the home page.

**Maps:** offline Protomaps vector tiles in `tiles/` (gitignored), served at
`/tiles` — `world.pmtiles` (z0–6, 43 MB) + `region.pmtiles` (Carolinas
-85.5,32 → -75,37, z0–14, 581 MB), extracted from the 2026-09-23 daily build with
`pmtiles extract https://build.protomaps.com/20260923.pmtiles tiles/region.pmtiles
--bbox=-85.5,32.0,-75.0,37.0 --maxzoom=14` (world: `--maxzoom=6`). CARTO's
keyless basemaps started stamping "API KEY REQUIRED" — nothing map-related
leaves the LAN now.

**Remote:** `https://hampibase.tail27c8f9.ts.net` via `tailscale serve --bg
http://localhost:8000` (tailnet only, not Funnel). HTTPS matters: some browser
APIs the UI uses (`crypto.randomUUID` for memory channels) need a secure context.

## Since 0.9-b3t7 (2026-09-24)

New SD card, full rebuild on trixie (above). From the [INTERCEPT.md](INTERCEPT.md)
P0 plan: capability probe, **Sub-GHz** (rtl_433), **BLE** scanner with tracker
flags, **Pager** (POCSAG/FLEX). P0.3 NOAA APT dropped — the satellites were
decommissioned in 2025. Three fixes: `DMRDecoder.stop()` no longer crashes when
dsd-fme is already dead (it used to skip the rest of shutdown and orphan
rtl_tcp), dsd-fme restarts itself after an unexpected exit, and leaving DMR no
longer logs "Future exception was never retrieved".

Pager note: the active 929.6125 channel is hospital paging — patient names in
the clear. Pages live in memory only (last 300), never on disk. Alphanumeric
pages are covered by ECPA in the US.

## Since 0.9-b3t6

Airband became **Scanner** — AM+FM across the whole VHF/UHF range, per-channel
modulation, editable `.ini` favourites, adjustable dwell and hold, separate AM/FM
squelch. New `nbfm_demodulate()` in `sdr.py`; the DMR/APRS/SSTV FM path is
unchanged. `airband.py` → `scanner.py`, `/airband` → `/scanner`, `AIRBAND_*` →
`SCAN_*`. FM verified against synthetic IQ (1 kHz tone recovered, 23:1
signal/noise separation on the squelch metric) — **not yet confirmed off-air.**

## Since 0.9-b3t4

METEOR LRPT · SSTV satellite tracking + Doppler · SDRTrunk trunked-DMR mode ·
DMR live audio · TX Phase A started · **0.9-b3t5:** full functionality audit
(AUDIT.md), four bug fixes (rtl_tcp zombie, negative call duration, ANSI in
METEOR log, four non-reconnecting WebSockets), all user-facing text rewritten,
UX pass (nav SDR pill, switch-failure surfacing, design tokens, mobile fixes).

## Roadmap

- [ROADMAP.md](ROADMAP.md) — RX era (complete)
- [ROADMAP-NEXT.md](ROADMAP-NEXT.md) — TX era: Digirig PTT → APRS/AX.25/SSTV transmit, Winlink, backlog
