# HamPi SDR Dashboard

A real-time SDR (Software Defined Radio) dashboard for the Raspberry Pi, built around an RTL-SDR dongle. Streams a live waterfall, decodes DMR digital voice, plays decoded audio, and plots callers on a live world map — all in a browser.

**Stack:** FastAPI (Python) backend + React/Vite frontend  
**Version:** 0.0.5-2FIXEDPHOENIX

---

## Features

### Live Waterfall
- Continuous 1024-point FFT spectrum display at 2.4 MHz bandwidth
- Colour-mapped dBFS scale (blue → cyan → green → yellow → red)
- Frequency axis auto-labelled from centre frequency
- WebSocket-driven, updates as fast as the SDR loop runs

### Tune Control
- Frequency input (Hz) and gain slider (0–50 dB)
- POST to `/api/tune` — tunes the RTL-SDR in real time without restarting
- Status bar shows connected client counts per stream

### DMR Decode
- DSD (Digital Speech Decoder) decodes DMR/MOTOTRBO frames
- Sync indicator goes green on active voice traffic
- Per-frame display: timeslot, frame type (VOICE/TLC/MBC/DATA), error count
- Active call info: timeslot, talkgroup, source ID
- RadioID.net lookup for DMR IDs (callsign, name, city, state) — cached 1 hour

### Audio Playback
- Decoded DMR voice streamed via WebSocket to Web Audio API
- 8 kHz mono PCM (dsd-fme AMBE output), scheduled playback with underrun detection

### Live Caller Map
- Mercator world map (CartoDB Dark Matter tiles — no API key required)
- Each heard DMR ID is geocoded via Nominatim OSM and pinned with a glowing green dot
- Click any pin for callsign, name, city/state, DMR ID, timeslot, talkgroup, and QRZ link
- Geocoding cached permanently in memory; RadioID lookups cached 1 hour

---

## Hardware Requirements

- Raspberry Pi 4 (4 GB recommended) or Pi 5
- RTL-SDR Blog V4 dongle (or compatible RTL2832U device)

## Software Dependencies

- Python 3.11+, `uvicorn`, `fastapi`, `numpy`, `scipy`, `httpx`
- Node 18+, Vite, React 19, `leaflet`, `react-leaflet`
- `dsd-fme` — must be in `$PATH`
- `rtl_tcp`, `rtl_fm` from `rtl-sdr` package
- `stdbuf` (GNU coreutils — almost always pre-installed)

## Setup

```bash
# Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install
npm run build          # builds dist/ served by FastAPI at :8000
# OR: npm run dev -- --host   # Vite dev server at :5173
```

## Starting Services

On first boot, the kernel DVB driver may claim the RTL-SDR device. Free it once:

```bash
echo "1-1.4" | sudo tee /sys/bus/usb/drivers/usb/unbind
sleep 2
echo "1-1.4" | sudo tee /sys/bus/usb/drivers/usb/bind
```

> Find your device's USB path with `ls /sys/bus/usb/devices/` and check `idVendor` for `0bda`.

Then start the backend — it manages `rtl_tcp` internally:

```bash
cd backend && source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://<pi-ip>:8000/` in a browser (or `:5173` if using the Vite dev server).

---

## Troubleshooting

### `usb_claim_interface error -6` / `Failed to open rtlsdr device`
Kernel DVB driver is holding the device. Run the USB unbind/bind commands above. To make this permanent so you never have to do it again:
```bash
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/rtlsdr.conf
```

### Waterfall / DMR WebSocket errors in browser console
The browser was loading a stale built frontend. Hard-refresh (`Ctrl+Shift+R`) or rebuild:
```bash
cd frontend && npm run build
```

### DMR sync dot stays grey even on an active channel
Two known root causes fixed in v0.0.3:
1. **DSD output buffering** — DSD batches its stdout in an 8 KB pipe buffer, so frames arrived seconds late (or never if the transmission ended first). Fixed with `stdbuf -oL`.
2. **DSD writes metadata to stdout, not stderr** — the backend was reading the wrong file descriptor. Fixed by rewriting the DMR reader to split text lines from binary audio on stdout.

### DMR decode shows wrong timeslot
DSD prints both slots on every line, e.g. `[SLOT0]  slot1`. The regex was matching the inactive `slot1` label. Fixed in v0.0.3 by requiring brackets around the active slot.

### SDR loop crashes and waterfall goes blank
If `rtl_tcp` drops the connection, the SDR loop now automatically reconnects after 3 seconds (fixed v0.0.3).

### Tune button shows "Error"
Usually means the SDR connection is broken. The backend now returns HTTP 503 with a message instead of a raw 500. Refresh the page — the SDR loop will have reconnected by then.

---

## Architecture

```
RTL-SDR dongle
    └── rtl_tcp (managed by backend, 127.0.0.1:1234)
            └── SDREngine (Python)
                    ├── FFT ×4 → ws/waterfall → browser canvas
                    └── FM demodulate → PCM 48kHz (thread executor, pipelined)
                            └── DMRDecoder (dsd-fme)
                                    ├── stderr text → DMRFrame → ws/dmr → browser
                                    │       └── src_id → /api/lookup → RadioID.net + Nominatim
                                    │                                    └── lat/lon → MapPanel pins
                                    └── WAV file (stereo 8kHz) → buf → mix mono → pace → ws/audio → AudioWorklet
```

---

## Version History

### 0.0.5-2FIXEDPHOENIX
- **Fix: DMRPanel active call freezes after ~5 minutes** — `lastSrcRef` was set on first contact and never reset between transmissions. When the same caller keyed up again: the VLC header frame has `src_id=0` (backend calls `_clear_call`), which is falsy, so the `if (f.src_id && ...)` guard short-circuited and `lastSrcRef` stayed at the old value. Subsequent VC\* frames with the same src_id then failed the `!== lastSrcRef` check, so `setActiveSrc`, `setLookup`, and the RadioID fetch never fired. Contacts and Map were unaffected because they update `lastSeen` on every VOICE frame without a src_id guard. Fix: on VLC frame (`src_id === 0`) reset `lastSrcRef` to 0 and clear `activeAlias` so the next VC\* frame — even from a repeat caller — is always treated as a new call.

### 0.0.5-1WORKINGPHOENIX
- **Fix: FM demodulation channel filter was ineffective** — the 64-tap FIR applied at 2.4 MHz had only −0.7 dB attenuation at the adjacent DMR channel (12.5 kHz). Adjacent channels bled straight through, corrupting the 4-FSK symbol decisions and causing near-constant `FLCO FEC ERR` in dsd-fme. Moved the LPF to 48 kHz (post-decimation) where the same 64 taps give −72 dB at 12.5 kHz. Also eliminated `oaconvolve` entirely — lfilter on 2,621 samples at 48 kHz takes 1.1 ms vs 46 ms at 2.4 MHz, giving 53 ms of headroom per chunk.
- **Fix: Partial WAV reads caused irregular chunk sizes** — dsd-fme writes AMBE audio in 640-byte frame bursts; reading 3,200 bytes at a time would often return partial chunks of unpredictable size. The browser's Web Audio scheduler received buffers of varying duration (60 ms, 80 ms, 100 ms …) making gapless scheduling impossible. WAV reader now accumulates raw stereo bytes in a bytearray and only emits complete fixed-size chunks. Silence gap > 300 ms discards any partial buffer and resets pacing so long quiet periods don't corrupt timing.
- **Fix: Audio playback replaced with AudioWorklet** — `AudioBufferSourceNode.start(scheduledTime)` relies on the JS main thread for scheduling; on a Pi running SDR processing simultaneously, GC/CPU pressure causes 5–15 ms slips that produce audible gaps at every buffer boundary. Replaced with an `AudioWorklet` (`audio-processor.js`) that runs in a dedicated real-time audio thread: `process()` fires every 128 samples regardless of main-thread congestion, drains a sample queue, and fills silence during underruns. Main thread resamples 8 kHz → native context rate with linear interpolation before zero-copy transfer to the worklet. Primes with 150 ms of audio before opening output to hide initial jitter.

### 0.0.5_WORLDWIDEBBY
- **Live caller map** — Mercator world map using CartoDB Dark Matter tiles (free, no API key, dark-themed) rendered with react-leaflet. Each unique DMR ID heard is geocoded via Nominatim OSM and plotted as a glowing green pin. Clicking a pin shows callsign, name, city/state, DMR ID, timeslot, talkgroup, and a direct QRZ link.
- **Geocoding pipeline** — `/api/lookup` extended to call Nominatim after RadioID.net; resolves city+state+country to lat/lon. Results cached permanently in `_geo_cache` (city locations don't change), independent of the 1-hour RadioID TTL. Frontend only plots pins when lat/lon are present; contacts without a resolvable location appear in the Contacts panel only.
- **Map layout** — map panel occupies all remaining vertical space below the waterfall and control panels via `flex:1`, scaling naturally with window height.

### 0.0.4-3_phoenixroseagain
- **Fix: Waterfall extremely slow** — `lfilter` (direct FIR convolution) at 2.4 MHz sample rate was running at 2.4× slower than real-time on the Pi, causing a growing socket buffer backlog and ~5 fps waterfall. Replaced with `oaconvolve` (overlap-add FFT convolution), which is 3× faster and keeps up with the data rate. Added overlap-save state (`_lpf_tail`) so the filter has correct history at every chunk boundary — no startup transient between chunks.
- **Fix: 4 FFT frames per chunk** — was computing one waterfall line per IQ read (every ~100 ms = ~10 fps). Now spreads 4 FFT slices across each chunk, giving 40–87 waterfall lines/sec depending on buffer state.
- **Fix: Audio choppy / underruns** — two root causes. (1) Sequential read→demod loop fed dsd-fme at 0.54× real-time: pipelined read_iq and fm_demodulate to run concurrently in the thread executor, so dsd-fme now receives audio at real-time rate. (2) WAV reader sent chunks in bursts whenever dsd-fme had buffered output, causing the browser's Web Audio scheduler to jump far ahead then stall. Added server-side pacing: tracks audio-time sent vs wall clock, sleeps when more than 100 ms ahead, resets reference on every silence gap so long pauses don't corrupt timing.
- **Browser audio buffer** — initial jitter buffer raised 200 ms → 500 ms; underrun reset also raised to 500 ms ahead, absorbing burst/gap transitions at transmission start.

### 0.0.4-2_phoenixrising
- **Fix: DMR contacts never populated** — `VC*` (Voice Continuation) frames were mapped to `UNKNOWN` instead of `VOICE` because `_map_ftype` stripped the trailing `*` before checking the map key `'VC*'`. The VLC header frame (correctly typed VOICE) has src_id=0 from `_clear_call`; all subsequent frames with the real src_id were `UNKNOWN`. Frontend filters on `frame_type === 'VOICE'` so no RadioID lookup ever fired and the Contacts panel stayed empty.
- **Fix: Audio played at half speed** — dsd-fme `-w` outputs stereo WAV (TS1 left, TS2 right) at 8 kHz. The WAV reader was sending raw stereo bytes; the frontend and STT both treated them as mono, so 800 stereo frames (100 ms) were interpreted as 1600 mono samples (200 ms) — exactly 0.5× speed. WAV reader now mixes L+R to mono before broadcasting.
- **Fix: Waterfall latency / choppiness** — `fm_demodulate` (64-tap FIR over 131072 samples) ran in the asyncio event loop, blocking it for ~30 ms every 55 ms cycle. Moved to thread executor; event loop now free to dispatch WebSocket frames promptly throughout the read+demodulate cycle.
- **Removed STT** — faster-whisper speech-to-text removed for now; `stt.py` preserved on disk for future reimplementation.

### 0.0.4-1_dsdfmehatesme
- **Switch decoder: dsd → dsd-fme** — original DSD never output LC header data (src/dst IDs) to any accessible stream; dsd-fme outputs structured metadata to stderr including talkgroup, DMR ID, talker alias, and color code
- **DMR IDs and talkgroups now decode correctly** — `TGT=X SRC=Y` parsed from dsd-fme stderr
- **Timeslot fix** — dsd-fme correctly identifies TS1/TS2; stopped LC lines from overriding the slot detected in BS-mode bracket notation (`[slot2]`); slots now correctly show TS2 for TS2 traffic
- **Talker alias cleanup** — strips ` DMR ID` suffix and trailing bare DMR ID numbers that some radios append; alias assembled incrementally across dsd-fme blocks and never replaced by a shorter/partial block
- **Alias cleared on new call** — VLC (Voice LC Header) now resets slot context so a previous caller's name doesn't persist into the next transmission
- **New Contacts panel** — accumulates callers heard this session, each callsign links directly to `qrz.com/db/{callsign}`; falls back to RadioID.net lookup when no talker alias is broadcast
- **Dashboard script** — `dashboard` now builds the frontend and serves everything through FastAPI on port 8000; eliminates Vite dev server and its WebSocket proxy race condition (no more port 5173)
- **Waterfall fix** — replaced self-copy `drawImage(canvas → itself)` with ping-pong double buffer; debounced ResizeObserver to prevent infinite layout loop that was crashing Firefox on Pi
- **AudioPlayer sample rate** — fixed 6× pitch error; context stays at 48 kHz for hardware compatibility, buffer declared at 8 kHz (dsd-fme AMBE output rate) so browser resamples correctly
- **FM LPF tightened** — cutoff 15 kHz → 6 kHz for 12.5 kHz DMR channel; reduces adjacent channel noise into the demodulator

### 0.0.3_all_ur_base_r_belong_to_us
- **Fix: DMR audio never reached STT** — DSD's portaudio backend cannot write decoded PCM to a subprocess socket pipe (`-o -` silently dropped all audio). Switched to `-n -w /tmp/dsd_audio.wav`: DSD writes decoded audio to a WAV file via standard file I/O, which works correctly. Backend streams PCM from the file continuously.
- **Fix: Timeslot displayed as TS0/TS1** — DSD uses 0-indexed slots (SLOT0/SLOT1); DMR convention is TS1/TS2. Frontend now displays `timeslot + 1`.
- **Fix: DSD stderr now captured** — previously discarded (`DEVNULL`); now piped and logged to `/tmp/dsd_stderr.log` for LC header debugging.
- **Fix: DSD stdout is now pure text** — removed the binary/text stream-splitter entirely now that audio travels on a separate path. `_read_stdout` uses `readline()` cleanly.
- **STT energy thresholds lowered** — `ENERGY_START` 600 → 300, `ENERGY_HOLD` 200 → 100. AMBE vocoder decoded audio has lower RMS than natural speech; old thresholds were gating out real voice.
- **Improved LC regex coverage** — added patterns for DSD's `CC: X SLOT: X SRC: X DST: X GRP: X` and `mfid:` formats; ANSI escape codes stripped before parsing.
- **Audio flow diagnostics** — STT logs chunk count, max RMS, and voice-active state every 500 chunks so audio health is visible in the backend log.

### 0.0.3 — th3r3i5n0g0d
- Fixed `local_files_only=True` on Whisper model load (prevented IPv6 Hugging Face timeout on Pi)
- Fixed DSD output buffering with `stdbuf -oL`
- Fixed DMR sync dot — text/binary stream splitter on DSD stdout
- Fixed timeslot regex — require brackets around active slot label
- SDR loop auto-reconnects on `rtl_tcp` drop
- Tune endpoint returns HTTP 503 instead of 500 on SDR error

### 0.0.2 — Initial public release
- FastAPI backend, React/Vite frontend
- Live waterfall (1024-point FFT, WebSocket)
- DMR decode via DSD, frame metadata over WebSocket
- DSD audio playback via Web Audio API
- faster-whisper STT with dual VAD (DMR frame + energy)
- RadioID.net lookup with 1-hour cache
- Tune control (frequency + gain)

---

## Version 1.0 Roadmap

### Signal & Decoding
- [ ] Multi-channel scanning — hop between a list of frequencies, dwell on active ones
- [ ] P25 Phase 1 & 2 support (DSD already handles it, needs routing)
- [ ] NXDN / D-STAR decode modes
- [ ] Trunked DMR system support (control channel parsing, follow traffic)
- [ ] Signal strength meter and SNR display on the waterfall
- [ ] Click-to-tune on the waterfall canvas

### Audio
- [ ] Audio recording — save decoded voice to timestamped WAV files per call
- [ ] Per-talkgroup squelch and mute
- [ ] Volume control in the UI

### DMR Intelligence
- [ ] Full RadioID.net database import for offline ID lookups (no API rate limits)
- [ ] Call history log — persist calls with timestamp, duration, TG, ID, transcript
- [ ] Talkgroup alias file (CSV import — map TG numbers to friendly names)
- [ ] DTMF and MDC-1200 decode for analog channels

### STT & AI
- [ ] Whisper small/medium model option (better accuracy, more Pi RAM required)
- [ ] GPU acceleration on Pi 5 / external accelerator
- [ ] Keyword alert — notify when specific words appear in transcripts
- [ ] Transcript export (JSON / CSV / plain text)

### Infrastructure
- [ ] Systemd service file for auto-start on boot
- [ ] Config file (YAML/TOML) for frequencies, talkgroup aliases, STT model, gain
- [ ] Multi-dongle support (parallel receive on different bands)
- [ ] WebRTC audio option for lower-latency playback
- [ ] Docker container for easy deployment
- [ ] Dark/light theme toggle
