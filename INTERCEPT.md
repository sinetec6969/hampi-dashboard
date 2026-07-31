# iNTERCEPT vs HamPi — comparison and integration plan

Target: [smittix/intercept](https://github.com/smittix/intercept) (Apache 2.0) · reviewed 2026-07-29 against HamPi 0.9-b3t6 (MIT).

---

## 1. What it is

A Flask SIGINT dashboard that wraps ~35 CLI radio tools behind one browser UI.
Same ambition as HamPi, opposite construction: it is a **breadth play** —
every decoder that exists in the RTL-SDR ecosystem gets a route, a template,
and an install profile. HamPi is a **depth play** — ten modes, each one
actually verified on hardware, one dongle, one asyncio process.

## 2. Architecture contrast

| | HamPi | iNTERCEPT |
|---|---|---|
| Backend | FastAPI, asyncio, one process | Flask + SocketIO/SSE, gunicorn + gevent, thread-per-decoder |
| Frontend | React + TS + Vite SPA, dark mono | Jinja templates + vanilla JS (`templates/index.html` is **893 KB**) |
| Python volume | ~5.1 k lines backend | **~4.2 MB** of `.py` (≈100 k lines) |
| Radio access | one dongle, exclusive `_mode_lock` switcher | multi-device, capability-probed, per-route device claim |
| Persistence | JSON + local SQLite (radioid, aircraft) | optional PostgreSQL for ADS-B history |
| Auth | none — LAN only | login page, default `admin/admin` |
| Deploy | one systemd unit | `setup.sh` wizard, Docker Compose profiles, multi-arch build |
| Scale-out | single node by design | `intercept_agent.py` (159 KB) remote agents |
| Config | `config.yaml` + env override | `.env` + `config.py` + in-UI settings route |

**The honest read:** intercept is 20× the code for roughly 3× the features.
Most of that mass is UI plumbing (Flask route + Jinja page + vendored JS per
mode) and defensive install/capability machinery for hardware the author
doesn't have. The *decoders themselves* are thin — and that thin part is the
only part worth taking.

## 3. Where each one wins

**HamPi has that intercept does not:**
- DMR digital voice decode with live browser audio (no dsd-fme anywhere in intercept)
- Trunked DMR / Connect Plus control-channel tracking (SDRTrunk integration)
- **Any transmit path at all** — intercept is 100% receive-only. Digirig RTS PTT, TX safety gate, tone calibration have no counterpart.
- Meshtastic mesh (they have `meshtastic.py`/`meshcore.py` routes, but no node map/DM UX at our level)
- A real SPA. Their waterfall is 125 KB of hand-rolled JS.

**intercept has that HamPi does not** (the actual shopping list):

| Feature | Their tool | Our cost | Verdict |
|---|---|---|---|
| Pager POCSAG/FLEX | `rtl_fm \| multimon-ng` | ~160 lines + apt | **take** |
| 433 MHz sensors / TPMS | `rtl_433 -F json` | ~120 lines + apt | **take first** |
| NOAA APT weather sat | SatDump | ~40 lines, we already wrap SatDump | **take, nearly free** |
| ACARS / VDL2 | `acarsdec`, `dumpvdl2` | ~180 lines + source build | take (P1) |
| Signal-ID database | `data/signals.json` (794 KB, sigidwiki) | data drop + lookup | take (P1) |
| Utility meters | `rtlamr` | ~120 lines + Go build | maybe |
| Radiosondes | `radiosonde_auto_rx` | wide-scan, dongle-hungry | maybe |
| CW / morse decode | own DSP (57 KB) | rewrite small | maybe |
| Weather fax (HF) | own DSP (33 KB) | needs HF | parked |
| AIS maritime | AIS-catcher | works fine — **we're 190 mi inland** | skip |
| BLE scanning | BlueZ / `bleak` | ~140 lines, Pi 4 radio is built in | **take — zero dongle cost** |
| WiFi scanning | aircrack-ng, monitor mode | 80 KB of routes; needs an adapter we don't have | parked on hardware |
| Ubertooth / BLE sniffing | Ubertooth One | no such hardware | skip |
| TSCM sweeps | own (160 KB across 7 files) | huge, needs discipline | skip |
| Drone Remote ID | WiFi monitor mode | same missing adapter as above | parked on hardware |
| WebSDR proxy | remote receivers | **violates the no-data-leaves-LAN rule** | reject |
| Remote agents, Docker, Postgres, auth | — | anti-pattern for a one-Pi build | reject |

## 4. The integration rule

**Do not vendor their code. Copy the command lines and the regexes.**

Every intercept decoder reduces to the same three things:
1. an `rtl_fm`/tool argv,
2. a line-regex per protocol,
3. a queue → SSE fan-out.

We already own (3) twice over (`_broadcast` + per-mode WS). (1) and (2) are
the knowledge worth harvesting — they represent someone else's afternoon of
fighting flag order. Their Flask route wrapper around it is dead weight to us.

Practically: each ported mode is one `backend/<mode>.py` class in the
`Scanner` shape (`start`/`stop`/`status` + callbacks), one `VALID`
entry in the mode switcher, one WS + REST pair, one page. 150–250 lines.
Where a regex or argv came from intercept, credit it in the file docstring —
Apache 2.0 asks for attribution and it costs one line.

## 5. The constraint that sets priority

**One dongle.** Every SDR mode we add competes for device 0 and lengthens the
exclusive-switch list; it does not add parallel capability. So priority is
not "which feature is coolest" — it's:

> unique signal class × how often it's worth *leaving running* ÷ dongle contention

That ranking puts 433 MHz and pagers above ACARS (dense but only near an
airport) — and it puts **non-SDR** modes at the top of the list outright,
because they cost nothing at all. BLE is the only feature on intercept's whole
menu that never touches device 0.

---

## 6. Plan

### P0 — this week, apt-only, no new hardware

**P0.1 · Capability probe** (~30 lines, prereq for everything)

`GET /api/capabilities` → `{tool: bool}` via `shutil.which` over the tool
list; Home-page mode tiles gray out with an install hint when their binary is
missing. Right now `multimon-ng`, `rtl_433`, `acarsdec`, `dumpvdl2`, `rtlamr`,
`sox` are all absent and nothing in the UI would say so. Steal the *idea*
from `utils/capabilities.py`, not the file.

**P0.2 · `rtl_433` mode — best value/effort in the entire repo**

`sudo apt install rtl-433`. `rtl_433 -d 0 -F json -M time:unix` emits one JSON
object per decode — **no parsing to write**, and it covers ~250 device
protocols for free (weather stations, doorbells, TPMS, remotes).

Why first: it's the surveillance-awareness mode. TPMS IDs are static,
per-vehicle, and unencrypted — a passive log of "which cars pass my house"
sits directly on the anti-ALPR / anti-Ring interest line, and Ring/SkyBell
chimes themselves show up in the 433 stream.

```python
# backend/subghz.py
class SubGHzDecoder:
    def __init__(self, freq=433_920_000, rtl_device=0, gain=None,
                 event_callback=None, status_callback=None): ...

    async def start(self):
        cmd = ["rtl_433", "-d", str(self.rtl_device), "-f", str(self.freq),
               "-F", "json", "-M", "time:unix"]
        if self.gain: cmd += ["-g", str(self.gain)]
        self._proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self._task = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        async for line in self._proc.stdout:
            try: ev = json.loads(line)
            except json.JSONDecodeError: continue
            key = f'{ev.get("model")}/{ev.get("id")}'
            self.devices[key] = {**ev, "count": self.devices.get(key, {}).get("count", 0) + 1}
            if self._event_cb: await self._event_cb(ev)
```

Wiring: `VALID += ("subghz",)`, stop/start arms in `_switch_sdr_mode`,
`/ws/subghz` + `/api/subghz/devices`, `SubGHzPage` = device table (model, id,
last seen, count, sparkline) — closest existing page shape is `MeshtasticPage`'s
node list.

Skipped deliberately: their 126 KB `utils/subghz.py` (spectrum-scan +
signature-matching UI). `-F json` covers the actual use case.

**P0.3 · NOAA APT — the cheapest real capability on the list**

`meteor.py` is already parameterized by `pipeline`, and `satpredict.py`
already pulls the Celestrak `weather` TLE group — **NOAA-15/18/19 are already
in our TLE cache.** Adding APT is a pipeline string, three frequencies, and
three entries in the satellite list:

```python
# config.yaml
noaa_apt:
  pipeline: noaa_apt
  satellites:
    - { name: "NOAA 19", freq: 137_100_000 }
    - { name: "NOAA 18", freq: 137_912_500 }
    - { name: "NOAA 15", freq: 137_620_000 }
```

Reuse `MeteorDecoder` with `pipeline="noaa_apt"` (keep the `rtltcp`-source
workaround — same apt SatDump build, same bug). MeteorPage gets a satellite
picker; pass prediction and Doppler already work. NOAA-15/18/19 pass 4–6×
daily and always transmit, unlike METEOR — this is very likely our **first
actual weather image**, which also finally validates the whole 137 MHz chain
that METEOR has been RF-gated on since June.

**P0.4 · Pager POCSAG/FLEX**

`sudo apt install multimon-ng`. Pipeline and regexes lift straight from
`routes/pager.py`:

```
rtl_fm -d 0 -f <freq> -M fm -s 22050 -g <gain> - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -a FLEX -f alpha -
```
```python
POCSAG_RE = re.compile(r"(POCSAG\d+):\s*Address:\s*(\d+)\s+Function:\s*(\d+)\s+(Alpha|Numeric):\s*(.*)")
```

Two notes from reading their implementation: they use a **pty** for
multimon's stdout (it line-buffers otherwise) — keep that, it's the
non-obvious bit. Their threaded RMS relay is unnecessary for us; pipe
`rtl_fm` stdout straight into `multimon-ng` stdin with
`asyncio.create_subprocess_exec` and skip the audio scope. Frequencies are
regional — 152–159 MHz US paging is the place to start hunting.

**P0.5 · BLE scan — the only mode that costs no dongle time**

Pi 4's radio is already there, `bleak` is pip-installable, and this runs
*concurrently with every SDR mode* — it never enters the mode switcher at all,
which makes it the one addition that strictly grows capability instead of
trading it.

```python
# backend/ble.py — continuous passive scan, rolling device table
async def _scan_loop(self):
    def on_found(dev, adv):
        self.devices[dev.address] = {
            "addr": dev.address, "name": adv.local_name,
            "rssi": adv.rssi, "last": time.time(),
            "mfr": list(adv.manufacturer_data.keys()),
            "count": self.devices.get(dev.address, {}).get("count", 0) + 1,
        }
    async with BleakScanner(detection_callback=on_found):
        while self._active:
            await asyncio.sleep(1.0)
```

Company IDs from `adv.manufacturer_data` keys are the useful signal — that's
how Ring/Tile/AirTag-class devices identify themselves, and it's the same
anti-surveillance angle as the 433 MHz TPMS log. Their
`utils/bluetooth/tracker_signatures.py` is a ready-made ID→vendor table worth
lifting; skip the rest of that directory (7 files, distance estimation, IRK
extraction, ring buffers).

Caveat: passive scan only sees advertising packets, and the Pi's built-in
radio has no monitor mode — no connection sniffing, no channel hopping. That's
what an Ubertooth buys, and we don't have one.

### P1 — next, one build each

5. **Signal-ID lookup.** Drop their `data/signals.json` (sigidwiki export) in,
   add `GET /api/signalid?freq=` → candidate matches by frequency range, wire
   it into the waterfall click handler: click a blob, get "probably POCSAG /
   NOAA WX / DMR". Pure data + ~25 lines, no dongle cost, makes the waterfall
   we already have meaningfully smarter.
6. **ACARS + VDL2.** `acarsdec` (VHF 131.55 etc.) and `dumpvdl2` — both source
   builds. Real payoff is the join we already have data for: match ACARS tail
   numbers against the 516 k-row local airframe DB and cross-link to the
   ADS-B track. Their `utils/acars_translator.py` decodes the message
   shorthand — worth reading before writing ours.
7. **Alerts.** A watchlist rule engine (ICAO / DMR ID / TPMS ID / pager cap
   code → toast + log). This is already sitting in ROADMAP-NEXT as
   "ADS-B ICAO watchlist alerts"; do it once, generically, over the existing
   WS event streams instead of per-mode.

### P2 — when the mood strikes

8. `rtlamr` (utility meters — needs a Go build; ERT/SCM smart meters are
   dense in suburbs and genuinely interesting privacy-wise)
9. CW decoder (software-only, works on any of our audio taps)
10. `radiosonde_auto_rx` (fun, but it wants the dongle to itself for wide scans)
11. Recordings (IQ/audio capture + replay) — infrastructure, not a mode

### Explicitly not doing

- **WiFi scanning + drone Remote ID** — both need a monitor-mode USB adapter
  that isn't on the Pi. Parked on hardware, not rejected; ~$25 unblocks both.
- **Ubertooth-based BLE sniffing** — no Ubertooth One here. The passive
  `bleak` scan in P0.5 is the subset that works with the built-in radio.
- **TSCM** — 160 KB of case/baseline/schedule state machines. The one genuinely
  useful 10% (RF baseline delta alarm) is a ~50-line diff against our existing
  FFT if ever wanted.
- **WebSDR proxy** — pulls audio from remote internet receivers. Straight
  violation of the on-device brief.
- **Docker, Postgres, remote agents, auth, install wizard** — one Pi, one
  systemd unit, LAN-only. Not a scaling problem we have.
- **Their entire frontend.**

### Sequencing against the TX roadmap

None of P0 touches the Digirig, the 2m antenna, or `radio.py` — so it does not
compete with [ROADMAP-NEXT.md](ROADMAP-NEXT.md) Phase A. But Phase A stays the
higher priority: it's the last mile on a capability that's already 90% built,
and P0 is net-new surface area. Reasonable split: finish the Phase A TX-LED
check (one session at the radio), then land P0.2–P0.4 while waiting on the
antenna.

---

*Comparison basis: intercept git tree @ HEAD 2026-07-29 (file sizes and module
list read from the GitHub API; `routes/pager.py` read in full). Tool
availability probed on this Pi — `direwolf`, `satdump`, `rtl_fm`, `rtl_tcp`,
`dsd-fme`, `ffmpeg` present; `multimon-ng`, `rtl_433`, `acarsdec`, `dumpvdl2`,
`rtlamr`, `sox` absent.*
