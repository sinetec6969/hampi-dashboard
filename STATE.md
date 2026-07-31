# Project State — snapshot

**Version:** 0.9-b3t7 · **Code Named HamPi** · **Updated:** 2026-07-31 · **QTH:** EM95of (Charlotte NC) · **Call:** KR4BPW

A single Raspberry Pi 4 + one RTL-SDR Blog V4, all decoding on-device, no cloud.
Every claim below was exercised on hardware 2026-07-05/06 — see [AUDIT.md](AUDIT.md)
for the full VERIFIED / RF-GATED / BROKEN breakdown.

## Live modes (device 0 — home-page SDR switcher)

| Mode | Audit status | Notes |
|---|---|---|
| DMR | verified | metadata + **live audio** (UDP blaster) · TG aliases · offline RadioID DB (307k) · call history |
| Trunked DMR | verified | Carolina Connect Site 004 via SDRTrunk user service · tuner lock ~20 s · encrypted-TG flags |
| Scanner AM/FM | verified (AM) | AM + FM anywhere in VHF/UHF · `.ini` favourites · adjustable dwell/hold · squelch-gated browser audio. FM path verified against synthetic IQ, not yet off-air |
| ADS-B | verified | 1090 MHz · CPR positions live · local fleet DB (516k) · track map |
| SSTV | RF-gated | decoder + sat tracking/Doppler verified; no off-air image yet (needs an ISS event or test TX) |
| APRS | RF-gated | chain runs to the antenna jack; **zero real decodes — 70cm whip is deaf on 2m** |
| AX.25 | RF-gated | KISS terminal live against direwolf; same antenna gate |
| METEOR LRPT | RF-gated | SatDump chain verified decoding; first MSU-MR composite needs a pass |
| Meshtastic | verified | `/dev/meshtastic` · 204 nodes · send is code-sound, not exercised (real TX) |
| Satellite telemetry | hardware-gated | MQTT path verified; **LilyGO T3 currently unplugged** — replug and it flows |

## Transmit — Phase A (in progress, NOT RF-confirmed)

Digirig wired, `/dev/digirig` udev rule now **installed** (2026-07-06). Radio TX page
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

Source builds required: rtl-sdr-blog driver + dsd-fme (both in `/usr/local/bin`).
Apt: `sudo apt install direwolf satdump`. Python deps in `backend/requirements.txt`.
Config via `config.yaml` (env vars override, defaults below both — precedence
tested). Optional local DBs: `backend/build_aircraft_db.py`, `build_radioid_db.py`.
Auto-start: `hampi-dashboard.service`. Stable device names: `99-hampi.rules`
(installed). Frontend: `npm run build` in `frontend/`.

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
