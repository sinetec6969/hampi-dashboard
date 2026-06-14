# HamPi Dashboard — Roadmap II (post-beta)

Beta 0.9-b3t4 closed out the RX story: eight live modes, all decoded on-device.
Roadmap II is about **transmit**, deeper packet networking, and the leftover
backlog — informed by what [DigiPi](https://digipi.org/) ships, but built the
HamPi way: native classes in our own backend, not a bundle of desktop apps
behind VNC. Same rules as always — separate class per mode, own
subprocess/serial connection, WS + REST in main.py, nothing leaves the LAN
unless we explicitly decide it should.

---

## Hardware on hand

| Device | What it gives us | Status |
|---|---|---|
| **Digirig Mobile** | USB audio codec + CP2102 serial, **RTS hardware PTT** | On hand — the TX keystone |
| **BTech APRS-K1** | Audio-only cable (Kenwood 2-pin), VOX PTT | On hand — RX audio tap / backup TX path |
| RTL-SDR Blog V4 (×1, more planned) | RX everything | Live |
| Heltec WiFi LoRa 32 V3 | Meshtastic | Live |
| LilyGO T3 LoRa32 (TinyGS fw) | Satellite RX | Live |
| HT with Kenwood 2-pin (Baofeng-class) | The actual transmitter | Needed for all TX phases |
| 2m-tuned antenna | APRS/AX.25 RX that actually hears | **Needed — current 70cm whip is deaf on 144 MHz** |
| HF transceiver | FT8/JS8/Winlink-HF/ARDOP | Stretch, not owned |

Digirig vs APRS-K1: direwolf supports `PTT /dev/ttyUSB0 RTS` natively — no
VOX tail, no clipped first syllable, deterministic keying. The K1 stays
useful as a second radio's RX tap or a glovebox spare.

---

## Phase A — TX Foundation (Digirig bring-up)  🚧 UNFINISHED

Everything downstream depends on this. Software path is built and a valid APRS
beacon transmitted (KR4BPW, 144.390, 2026-06-13), but **RF is not yet
confirmed** — the loopback (RTL-SDR self-RX) decoded nothing, and we haven't
verified the BF-F8HP actually keys. Phase A is **not done** until someone at
the radio confirms the TX LED lights on a burst, then deviation is set by ear.

- [x] udev rule for Digirig (CP2102N serial `f46a18…` → `/dev/digirig`) — in `99-hampi.rules` (install + reload pending)
- [x] `radio.py` (`RadioInterface`): RTS PTT via held-open serial (no key on open), ALSA tone-out for calibration
- [x] TX calibration page — `RadioPage`: status, PTT test, 1 kHz tone, safety banner (level set via `alsamixer` for now)
- [x] `station:` config section — callsign, SSID, lat/lon, comment
- [x] **Safety rail:** `radio.tx_enable: false` default; every TX call refuses without tx_enable + callsign; Digirig serial not even opened until enabled (no startup key blip)
- [~] one-shot direwolf TX proven from a standalone conf (`ADEVICE null plughw:CARD=Device`, `PTT /dev/ttyUSB1 RTS`) — sent a valid APRS Status Report. Not yet folded into the service (deferred to Phase B as a proper APRSTX class).
- [ ] busy-channel lockout (carrier detect before key) — deferred to Phase B
- [ ] **BLOCKER — confirm the BF-F8HP actually keys on a burst (TX LED).** Disambiguates PTT-keying vs RX-side before any further TX work.
- [ ] set TX deviation by ear (Digirig `Speaker` mixer, currently 38%/−23 dB) once keying is confirmed
- [ ] prove the loopback: dashboard APRS RX decodes our own beacon (also validates the APRS RX path, never yet confirmed against a real signal)
- [ ] install `99-hampi.rules` so `/dev/digirig` exists (one-shot test used `/dev/ttyUSB1` directly)

> **Gotcha banked:** direwolf `every=0:00` means *beacon continuously*, not once
> — it queued ~59k frames in 7 s. One-shot = `delay=0:03 every=30:00`, kill
> after the first. The half-duplex Digirig must be TX-only (`ADEVICE null …`)
> or direwolf's RX queue floods with DLQ-leak errors.

## Phase B — APRS TX Suite

- [ ] Position beacon — configurable interval/smart beaconing, symbol, comment; direwolf handles encoding
- [ ] APRS messaging from the dashboard — compose/ack in APRSPage (RX side already parses `message_text`)
- [ ] Digipeater (WIDE1-1 fill-in) — direwolf config flip, service toggle in UI
- [ ] iGate — **decision needed**: RX-only igate still uploads heard traffic to APRS-IS. Ship off by default with a clear "this leaves the LAN" warning, or skip entirely
- [ ] Object/item beacons (event markers on the local map → RF)

## Phase C — AX.25 Connected Mode (Roadmap I phases 4–5)

- [ ] Connected sessions — SABM/UA/I-frame state machine over KISS, or `ax25d`+`axcall` subprocess if the lazy path wins
- [ ] In-browser packet terminal upgrade: connect/disconnect to remote BBS, session scrollback (AX25Page already has the console shell)
- [ ] Beacon inject (CQ/ID beacon via KISS write)
- [ ] *(stretch)* Host our own node/BBS (uronode/linbpq-class) — HamPi as a destination, not just a monitor

## Phase D — Winlink Email (pat)

RF email, fits the off-grid brief (caveat: Winlink CMS is an internet-side
service — it's radio *to* the gateway, not LAN-only; flag it like the igate).

- [ ] `pat` (Go, single binary) with AX.25/KISS transport over the shared direwolf
- [ ] Drive pat's HTTP API from a HamPi page (compose/inbox) — or iframe its web UI first and replace later
- [ ] Telnet transport as a no-RF test path

## Phase E — SSTV TX

We decode five modes; encoding is the easy direction.

- [ ] `sstv_tx.py` — Scottie S1/Martin M1 encoder (we already own the timing tables), image upload → 48 kHz AFSK-style audio → Digirig out, PTT via `radio.py`
- [ ] SSTVPage: "transmit image" tab — upload/crop to 320×256, mode picker, progress bar

## Phase F — HamPi as LAN TNC

Nearly free wins off the existing direwolf:

- [ ] Expose KISS :8001 to the LAN (config flag) → APRSdroid / RadioMail / YAAC use HamPi as their TNC
- [ ] *(stretch)* Bluetooth rfcomm KISS for phones in the field (DigiPi does this; Pi 4 BT can too)

## Phase G — HF (hardware-gated)

Parked until an HF rig (or direct-sampling experiments) happen:

- [ ] FT8 **RX-only** via RTL-SDR V4 direct sampling (14.074 MHz) — decode-and-map page, no TX needed
- [ ] FT8/JS8Call TX, ARDOP, Winlink-HF — needs the rig
- [ ] HF SSTV RX at 14.230 MHz (Roadmap I leftover — direct sampling mode not yet wired)

---

## Carried-over backlog (Roadmap I)

- [x] **SSTV satellite tracking** (2026-06-13) — `satpredict.py`: AMSAT TLEs (cached/daily), skyfield pass prediction + Doppler for QTH `EM95of`, curated SSTV bird list (ISS / UmKA-1 / SONATE-2). SSTVPage `SatPanel`: live el/az, next-pass countdown, descriptors, click-to-track. Tracking retunes the SDR to the downlink and the SSTV loop follows Doppler per-chunk.
- [x] **METEOR LRPT** (2026-06-14) — `meteor.py`: SatDump live decoder as a subprocess on device 0 (dedicated `rtl_tcp` + satdump `rtltcp` source; native `rtlsdr` plugin doesn't register in the apt 1.2.2 build). METEOR-M2-3/4 137 MHz QPSK → MSU-MR composites. `MeteorPage` with live status/SNR, image gallery, pass prediction (Celestrak weather TLEs merged into `satpredict`). Home-page mode choice. Decode chain verified live on hardware (Viterbi running, NOSYNC pending a real pass).
- [ ] **Satellite pass prediction — broaden** — same engine on SatellitePage for the TinyGS LoRa birds; pass-window alerts / auto-tune for scheduled ISS SSTV events
- [ ] **Trunked DMR** — control channel parsing; P25 Phase 1/2, NXDN, D-STAR beyond that
- [ ] **ADS-B extras** — range rings, squawk/emergency flags, ICAO watchlist alerts, CRC-filter the bit-garbled ICAOs from rtl_adsb
- [ ] **SSTV slant correction** — sample-rate drift estimate across 240 lines
- [ ] **Airband ATIS text decode**
- [ ] **Meshtastic polish** — TRACEROUTE display, telemetry sparklines
- [ ] **Ops hardening** — read-only root filesystem option (SD wear — DigiPi's best idea), log rotation for packet/call logs

---

## Proposed priority order

1. **2m antenna** — $0–30, makes APRS/AX.25 RX real; everything in B/C is unverifiable without it
2. **Phase A** — Digirig bring-up + safety rails (one focused session)
3. **Phase B1–B2** — beacon + APRS messaging (first actual TX, high payoff)
4. **Phase F1** — LAN KISS TNC (config flag + docs, nearly free)
5. **Phase C** — connected-mode terminal (the packet BBS itch)
6. **Satellite pass prediction** — pure software, no new hardware, long-promised
7. **Phase E** — SSTV TX (fun demo, reuses everything)
8. **Phase D** — Winlink
9. Trunked DMR / ADS-B extras / HF — as the mood strikes

---

*Roadmap I (RX era, complete): [ROADMAP.md](ROADMAP.md)*
