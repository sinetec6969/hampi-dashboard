# SDRTrunk — Carolina Connect Site 004 (Connect Plus) Monitor

Headless RX-only monitor for the "Carolina Connect" MOTOTRBO Connect Plus system
(RadioReference SID 8561), Site 004 — Bank of America Plaza, Charlotte.

## What's installed

| Piece | Location |
|---|---|
| SDRTrunk v0.6.1 (bundled JRE 23, aarch64) | `~/sdr-trunk-linux-aarch64-v0.6.1/` |
| JMBE 1.0.9 codec (AMBE decode) | `~/SDRTrunk/jmbe-1.0.9.jar` |
| Playlist (Site 004) | `~/SDRTrunk/playlist/default.xml` |
| App config / logs / recordings | `~/SDRTrunk/` |
| systemd units (user) | `~/.config/systemd/user/sdrtrunk.service`, `wayvnc-tailscale.service` |

Site 004 channels (from RadioReference): control **454.03125** (alt 454.11875),
voice 452.875 / 454.01875 / 454.33125 / 454.46875. LCN 1–6 mapped in the playlist.
Spectrum/waterfall disabled (`spectral.display.enabled=false` in `~/SDRTrunk/SDRTrunk.properties`).

## Start / stop — via the dashboard (preferred)

SDRTrunk is a **selectable SDR mode** in the HamPi dashboard: open the **Trunk**
tab and click *Switch to Trunk mode*. The dashboard stops its own rtl_tcp, hands
device 0 to the SDRTrunk service, and shows lock state + decoded calls (encrypted
calls flagged red). Switching to any other mode stops SDRTrunk and reclaims the
dongle. This makes the dashboard the single arbiter of the one dongle — no race.

Backend: `backend/sdrtrunk.py` (`TrunkMonitor`, mirrors the meteor mode). Config
under `trunk:` in `config.yaml`. REST `/api/trunk/status`, WS `/ws/trunk`.

## Start / stop — manual (service directly)

```bash
systemctl --user start|stop|restart sdrtrunk
systemctl --user status sdrtrunk
journalctl --user -u sdrtrunk -f          # service log
tail -f ~/SDRTrunk/logs/sdrtrunk_app.log  # app log
```

`sdrtrunk.service` is installed but **boot auto-start is disabled** — the dashboard
owns start/stop so both never fight for the dongle. `wayvnc-tailscale.service`
stays enabled (independent UI transport). Lingering is on. SDRTrunk renders to the
existing labwc/Xwayland desktop (`DISPLAY=:0`); no monitor needed.

## Where output lands

- **Call audio recordings**: `~/SDRTrunk/recordings/*.wav` — the playlist has a
  record-all alias (TG range 1–16777215). **Watch disk: the SD card is ~96% full.**
- **Call event CSVs**: `~/SDRTrunk/event_logs/` (control + traffic call events, incl.
  encrypted-call flags).

## Reaching it over Tailscale

`wayvnc-tailscale.service` runs a second wayvnc bound to the Pi's Tailscale IP only:

```
VNC → 100.77.41.97:5901   (no auth — tailnet-private, not exposed publicly)
```

Point any VNC client at it to see/drive the SDRTrunk UI (Now Playing, channel status,
playlist editor). The rpi-connect screen share also works and shows the same desktop.

## THE dongle conflict (resolved by the dashboard integration)

There is **one** RTL-SDR V4. The dashboard is now the single arbiter: selecting a
mode stops the previous consumer before starting the next, and Trunk mode
start/stops the SDRTrunk service. Boot auto-start on `sdrtrunk.service` is disabled
so nothing claims the dongle behind the dashboard's back.

If you ever run SDRTrunk manually *while the dashboard is decoding*, they'll fight
(SDRTrunk won't retry a busy tuner): switch the dashboard to Trunk mode instead, or
`pkill -x rtl_tcp` in a loop while `systemctl --user restart sdrtrunk` claims it.
Permanent multi-consumer fix: **second dongle**. See below.

## Adding a second dongle (or a split-band site)

1. Give the new dongle a unique serial: `rtl_eeprom -d 1 -s 00000002`.
2. In the SDRTrunk UI (VNC): Tuners view → note the new tuner name, then in the
   playlist editor set the channel's *preferred tuner* so SDRTrunk stops competing
   with the dashboard for serial 00000001.
3. A site whose channels span more than ~2.4 MHz needs two tuners: SDRTrunk
   automatically pulls traffic channels from any available tuner — just leave the
   second tuner unassigned and SDRTrunk will use it for out-of-band voice channels.

## Rebuilding JMBE (if ever needed)

```bash
unzip jmbe-creator-linux-aarch64-v1.0.9.zip && creator-linux-aarch64-v1.0.9/bin/creator
# emits jmbe-1.0.9.jar; path is set in Java prefs (User Preferences → JMBE Library)
```
