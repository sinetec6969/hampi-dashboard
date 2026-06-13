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

## Phase A — TX Foundation (Digirig bring-up)

Everything downstream depends on this.

- [ ] udev rule for Digirig (CP2102 serial → `/dev/digirig`, sound card by id) — extend `99-hampi.rules`
- [ ] `radio.py` (`RadioInterface`): owns the Digirig — ALSA playback/capture device discovery, TX audio out, RTS PTT keying, busy-channel lockout (carrier detect before key)
- [ ] direwolf TX config: second channel or dedicated instance with `ADEVICE plughw:digirig`, `PTT /dev/digirig RTS`
- [ ] TX audio calibration page — level slider + test tone + deviation check (DigiPi's mixer UI, done our way)
- [ ] `station:` config section — callsign, SSID, grid/lat-lon, comment (legal ID for every TX mode)
- [ ] **Safety rail:** global `tx_enable: false` default in config.yaml; every TX endpoint refuses without it + callsign set

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

- [ ] **Satellite pass prediction** — `skyfield` + Celestrak TLE, pass window overlay on SatellitePage, auto-tune hook for ISS SSTV
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
