# HamPi SDR Dashboard

A real-time SDR (Software Defined Radio) dashboard for the Raspberry Pi, built around an RTL-SDR dongle. Streams a live waterfall, decodes DMR digital voice, plays decoded audio, and transcribes speech to text — all in a browser.

**Stack:** FastAPI (Python) backend + React/Vite frontend  
**Version:** 0.0.3_all_ur_base_r_belong_to_us

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
- 48 kHz PCM, scheduled playback with underrun detection

### Speech-to-Text
- faster-whisper (tiny model, CPU int8) transcribes decoded DMR voice
- Dual VAD: DMR VOICE frame trigger + energy-based fallback (RMS threshold)
- Pre-roll buffer so no leading audio is lost
- Transcript log with timeslot badge and timestamp, auto-scrolls

---

## Hardware Requirements

- Raspberry Pi 4 (4 GB recommended) or Pi 5
- RTL-SDR Blog V4 dongle (or compatible RTL2832U device)

## Software Dependencies

- Python 3.11+, `uvicorn`, `fastapi`, `numpy`, `scipy`, `faster-whisper`, `httpx`
- Node 18+, Vite, React 19
- `dsd` (Digital Speech Decoder) — must be in `$PATH`
- `rtl_tcp`, `rtl_fm` from `rtl-sdr` package
- `stdbuf` (GNU coreutils — for real-time DSD output, almost always pre-installed)

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

### Backend hangs at "Loading Whisper model" forever
faster-whisper was trying to phone home to Hugging Face over IPv6, which was timing out. Fixed in v0.0.3 (`local_files_only=True`). If the model hasn't been downloaded yet, run once with internet access:
```python
from faster_whisper import WhisperModel
WhisperModel("tiny", device="cpu", compute_type="int8")
```

### Waterfall / DMR / STT WebSocket errors in browser console
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

### STT panel stays yellow (connecting)
The WebSocket connects on page load; yellow briefly then goes green. If it stays yellow, the WebSocket upgrade is failing — check that the backend is up and the browser can reach port 8000 (or 5173 via the Vite proxy).

---

## Architecture

```
RTL-SDR dongle
    └── rtl_tcp (managed by backend, 127.0.0.1:1234)
            └── SDREngine (Python)
                    ├── FFT → ws/waterfall → browser canvas
                    └── FM demodulate → PCM 48kHz
                            └── DMRDecoder (dsd via stdbuf)
                                    ├── stdout text lines → DMRFrame → ws/dmr → browser
                                    ├── stdout binary PCM → ws/audio → Web Audio API
                                    └── DMRFrame + PCM → STTDecoder (faster-whisper)
                                                              └── transcript → ws/stt → browser
```

---

## Version History

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
