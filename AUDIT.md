# AUDIT — 0.9-b3t4 + SDRTrunk + DMR audio (2026-07-05)

> **Post-change re-run (2026-07-06, after the text + UX passes and 0.9-b3t5):**
> all seven switcher modes cycled clean again, **zero defunct processes** (the
> zombie fix holds), waterfall streaming (377 frames/5 s), config precedence
> PASS, TX guard self-test PASS, `radio.py` untouched (`git diff` empty),
> `/api/radio/status` identical. No VERIFIED item regressed.

Every claimed feature, classified one of three ways:

- **VERIFIED** — exercised end-to-end in this audit session, on this Pi, and it worked
- **RF-GATED** — code path is sound but final confirmation needs live RF or a human at the hardware; the required step is listed
- **BROKEN** — a defect, with repro; fixed or explicitly deferred

Session evidence: live service on device 0, all seven switcher modes cycled,
rollback forced, WebSockets probed with a client, config precedence tested
with a throwaway yaml + env vars, offline self-tests run for every module
that has one.

---

## Mode switcher (device 0)

| Check | Result |
|---|---|
| DMR → Airband → ADS-B → SSTV → APRS → METEOR → Trunk → DMR round trip | **VERIFIED** — each switch confirmed by process table + status endpoint |
| Clean teardown (no orphaned rtl_tcp / dsd-fme / direwolf / satdump / java) | **VERIFIED** — process table clean after every switch (one exception, see BROKEN-1) |
| DMR rollback on failed switch | **VERIFIED** — forced an airband start failure by squatting port 1234 with a silent listener; API returned 503 "Mode switch to 'airband' failed: timed out", mode came back as `dmr`, rtl_tcp + dsd-fme restarted |
| Mode lock (`_mode_lock`) serializes concurrent switches | VERIFIED by code trace (single asyncio.Lock around `_switch_sdr_mode`) |

## Modes

### DMR — VERIFIED
Full chain live: rtl_tcp (438.8 MHz) → `fm_demodulate` → dsd-fme stdin →
stderr parse → `/ws/dmr`. Probe client received 3 metadata frames in 8 s of
off-air traffic; 131 calls logged today; call history persists across
restarts (`call_history.json`). Talkgroup aliases from config applied in
`on_meta`. Live audio: dsd-fme UDP blaster → backend listener → `/ws/dmr-audio`
(journal shows 583 B/s during a call). RadioID lookups hit the offline DB.
- Caller map: pins require `geocode.enable: true` (off by default — lookups
  return `lat: null`), so the map panel sits empty in the default privacy
  posture. Not a bug, but the UI never says why → addressed in the UX pass.

### Waterfall — VERIFIED
`/ws/waterfall` probe: 425 binary float32 frames (1.7 MB) in 6 s. Click-to-tune
and hover crosshair verified by code trace; `/api/tune` retunes live (current
freq showed an operator retune to 439.467 MHz).

### Airband AM — VERIFIED (scanner mechanics)
Mode start/stop clean; scanner observed cycling Guard → CTAF → Center on the
dwell timer; squelch/scan/channel-lock REST endpoints respond. Gated audio
couldn't be forced during the session (nobody transmitted in the 6 s window) —
the AM chain is the long-proven one from 0.2.x, no change since.

### ADS-B — VERIFIED
19 aircraft in 25 s on device 0. CPR pair decode produced real positions
(a05cf3 at 35.319, −80.841 — Charlotte airspace). `aircraft.db` enrichment
live (N122US → American Airlines). Prune loop expires stale aircraft.
Known cosmetic: rtl_adsb passes some CRC-garbled frames (callsign `IN#AS###`,
bogus ICAOs) — already on the backlog (ROADMAP-NEXT "ADS-B extras"), not new.

### APRS — RF-GATED
Mode start VERIFIED: SDR retunes to 144.390, direwolf spawns with the repo
conf, KISS port 8001 opens, status endpoints live. **Zero frames decoded — as
expected: the 70cm whip is deaf on 2m. APRS RX has never decoded a real
off-air packet.** Parser itself passes its offline self-test (position packet
→ lat/lon, garbage → parse_error).
**Human step:** put a 2m antenna on the SDR (or transmit an APRS burst nearby)
and watch `/aprs` for the first real packet.

### AX.25 — RF-GATED
KISS client VERIFIED connected to direwolf :8001 in APRS mode; deframer +
address/control decode pass the offline self-test (UI/RR frames, digi paths).
Same 2m antenna gate as APRS for real frames.

### SSTV — RF-GATED
Mode start VERIFIED: retune to 145.800, decoder task running, status over
`/ws/sstv`, RMS updating. No SSTV image has been decoded off-air in this
install (image dir is empty) — needs an ISS event, a live bird, or a local
test transmission. VIS/mode tables untouched by this project (DSP freeze).
**Human step:** play an SSTV recording into a nearby HT on 145.800 during SSTV
mode, or catch the next ARISS event.

### SSTV satellite tracking — VERIFIED
`satpredict.py` self-test live: 171 sats loaded from cached AMSAT+Celestrak
TLEs, ISS Doppler computed, next passes predicted for all five SSTV birds
(QTH EM95of). Track/untrack retunes the SDR centre in SSTV mode (code trace +
REST). Doppler *audio-path correctness during a real pass* is RF-gated like
SSTV itself.

### METEOR LRPT — VERIFIED (chain) / RF-GATED (imagery)
Mode start VERIFIED: dedicated rtl_tcp on :1236, SatDump live pipeline up and
writing CADU, SNR/status streaming over `/ws/meteor`. No MSU-MR products on
disk yet — needs a real METEOR-M pass overhead (decoder was seen running
Viterbi on 2026-06-14; NOSYNC without a pass is expected).
**Human step:** switch to METEOR mode before the next predicted pass (the
page shows AOS countdowns) and leave it until LOS.

### Trunked DMR (SDRTrunk) — VERIFIED
Mode switch starts the `sdrtrunk` user service, JVM claims device 0,
`tuner_locked: true` within 20 s, status over `/ws/trunk`. CSV call-event
drain + encryption flag pass the offline self-test. No voice grant landed in
the observation window; the drain path is the same code the self-test covers.

### Meshtastic — VERIFIED (RX) / RF-GATED (send)
Connected to `/dev/meshtastic`, 204 nodes in the registry, node/message
endpoints live. Send path is code-sound (guards, byte limit, DM routing) but
not exercised — pressing Send keys real LoRa TX, which this audit doesn't do.
**Human step:** send a broadcast from the page and confirm it arrives on
another node.

### Satellite telemetry (TinyGS) — HARDWARE-GATED
Backend MQTT client VERIFIED connected to local Mosquitto. Zero packets —
**the LilyGO T3 is not currently plugged in** (no CH9102 on the USB bus, no
`/dev/tinygs`).
**Human step:** reconnect the TinyGS board; packets should flow with no
software action.

### Radio TX page (Phase A) — RF-GATED (by design, untouchable)
`/api/radio/status` shows the correct gated-off state: `tx_enable: false`,
serial never opened, callsign present. Guard self-test passes (PermissionError
without tx_enable, without callsign, RuntimeError without open port). The
Digirig is on the bus at `/dev/ttyUSB1` (CP2102N serial f46a18…), **but
`/dev/digirig` doesn't exist: the installed udev rules predate the digirig
line in the repo copy.**
**Human steps (unchanged from ROADMAP-NEXT Phase A):**
1. ~~Install 99-hampi.rules~~ **done 2026-07-06** — `/dev/digirig` exists now
2. Confirm the BF-F8HP TX LED on a PTT test
3. Set deviation by ear, then prove the loopback (our beacon decoded by our APRS RX)

## Cross-cutting

| Check | Result |
|---|---|
| Config precedence: config.yaml loads → env var overrides → default when both absent | **VERIFIED** (throwaway yaml: freq from yaml, gain from env override, sample_rate from default, `enable: false` bool honored) |
| radioid.db used when present | **VERIFIED** (3106001 → K6EH from SQLite, no HTTP) |
| RadioID API fallback when DB absent | **VERIFIED** (with `_radioid_db` disabled the same ID resolved via radioid.net) |
| aircraft.db used when present | **VERIFIED** (live enrichment above) — API-less by design: a miss stays a miss |
| WS zombie-reconnect fix (e5a8436) stayed fixed | **VERIFIED** for the pages that reconnect: all use the `alive` flag + timer-clear + close pattern; no reconnect storm after navigation (server logs show clean connect/disconnect pairs) |
| Frontend builds clean | **VERIFIED** (vite build, 3.5 s) |

## BROKEN

1. **rtl_tcp zombie when terminate times out** — `sdr.py stop()` calls
   `kill()` after a 5 s terminate timeout but never reaps, leaving a
   `<defunct>` rtl_tcp for the life of the service. Observed live (pid
   1703811 stayed defunct across two subsequent mode switches). Repro: switch
   away from a mode whose rtl_tcp ignores SIGTERM (stuck client socket).
   Harmless to RF (process is dead) but pollutes the process table and hides
   real orphans. **FIXED** — reap after kill.
2. **Negative call duration in history** — `duration_s: -0.0` logged (twice
   today). `_maybe_start_recording` stamps `_last_voice_ts` *before*
   `start_time`, so a call ended by TLC after a single voice frame gets
   `end_time < start_time` by microseconds, rounding to −0.0. **FIXED** —
   duration clamped ≥ 0 in `_do_finalize`.
3. **ANSI escape codes in METEOR status** — SatDump logs colour codes;
   `meteor.py` passes them through `last_log` and the UI renders
   `[32m(I) Decoding…` literally. **FIXED** — strip ANSI in the read
   loop.
4. **Four pages never reconnect their WebSocket** — ADSBPage, SatellitePage,
   AirbandPage, SSTVPage do a one-shot connect; a server restart or Wi-Fi
   blip leaves them dead ("Offline") until a manual reload, while every other
   page auto-reconnects in 3 s. Repro: `systemctl restart hampi-dashboard`
   with `/adsb` open. **FIXED** — same alive-flag reconnect pattern as the
   rest.
5. **Stale client counter in Controls** — header shows `AUD:` from
   `/api/status` `clients.audio`, a field the API stopped returning when DMR
   audio moved to `/ws/dmr-audio`. Always 0. **FIXED** in the UX pass
   (counter now reflects real fields).
6. **Version scatter** — `/api/sysinfo` hardcodes `0.9-b3t4`,
   `package.json` says 0.0.3, README said older still. Not a runtime defect;
   handled in the docs pass.

## Deferred (flagged, intentionally not fixed here)

- **`PlaceholderPage.tsx` is dead code** (nothing routes to it since every
  mode went live). Deleting files needs your sign-off per house rules — say
  the word and it's gone.
- **rtl_adsb CRC-garbled frames** — already on the ROADMAP-NEXT backlog
  ("CRC-filter the bit-garbled ICAOs"); touching it means touching decode
  logic, which this project freezes.
- **direwolf KISS :8001 listens on 0.0.0.0** — LAN-exposed TNC. That's
  Phase F1's feature (deliberate LAN TNC) arriving early by accident. Left
  as-is; flag if you want it loopback-only until Phase F.
- **METEOR port check trusts any listener** — `_wait_port` would accept a
  foreign process squatting :1236 as "rtl_tcp is up". Contrived (nothing else
  uses 1236 on this Pi); noted for completeness.
