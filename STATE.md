# Project State — snapshot

**Version:** 0.9-b3t4 (beta) · **Updated:** 2026-06-14 · **QTH:** EM95of (Charlotte NC) · **Call:** KR4BPW

A single Raspberry Pi 4 + one RTL-SDR Blog V4, all decoding on-device, no cloud.

## Live modes (device 0 — home-page SDR switcher)

| Mode | Notes |
|---|---|
| DMR | metadata · talkgroup aliases · offline RadioID DB (307k) · caller map · call history |
| Airband AM | 118–137 MHz scanner · AudioWorklet playback |
| ADS-B | 1090 MHz · local flight lookup (`aircraft.db`, 516k) · track map |
| Meshtastic | LoRa mesh over USB (`/dev/meshtastic`) · node map · send/DM |
| SSTV | Scottie/Martin/Robot36 · satellite tracking + Doppler auto-tune |
| APRS | direwolf TNC · station map · packet log |
| AX.25 | KISS terminal · raw frame log · waterfall click-to-tune |
| **METEOR LRPT** | METEOR-M2 137 MHz QPSK via SatDump · MSU-MR composites · pass prediction |
| Satellite telemetry | TinyGS hardware (LilyGO T3, `/dev/tinygs`) → local MQTT |

## Transmit — Phase A (in progress)

Digirig Mobile (RTS PTT + audio) wired; `Radio TX` page; gated behind `radio.tx_enable` + `station.callsign`. A valid APRS beacon was sent on 144.390 (BF-F8HP Pro + Signal Stick 2m), but radio keying/deviation are **not yet RF-confirmed**. TX roadmap: [ROADMAP-NEXT.md](ROADMAP-NEXT.md).

## Hardware

RTL-SDR Blog V4 (dev 0) · Heltec WiFi LoRa 32 V3 · LilyGO T3 LoRa32 (TinyGS) · Digirig Mobile · Baofeng BF-F8HP Pro · Signal Stick 1/4-wave 2m.

## Build / run

System deps: `sudo apt install rtl-sdr dsd-fme direwolf satdump`. Python deps in `backend/requirements.txt`. Config via `config.yaml` (copy from `config.yaml.example`; env vars override). Optional local DBs: `backend/build_aircraft_db.py`, `backend/build_radioid_db.py`. Auto-start: `hampi-dashboard.service`. Stable device names: `99-hampi.rules`.

## Roadmap

- [ROADMAP.md](ROADMAP.md) — RX era (complete through 0.9-b3t4)
- [ROADMAP-NEXT.md](ROADMAP-NEXT.md) — TX era: Digirig PTT → APRS/AX.25/SSTV transmit, Winlink, plus backlog
