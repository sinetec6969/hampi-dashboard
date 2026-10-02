# deploy/ — field & network scripts

Operational scripts that touch the host (WiFi, firewall). **None run automatically
and none are invoked by the dashboard.** You run them by hand, and the risky one is
meant for the console, not a remote session.

| Script | Phase | Risk | What it does |
|---|---|---|---|
| `hampi-hotspot.sh` | H1 | ⚠️ **drops your WiFi link** | Turns `wlan0` into an access point (`up`) so the console runs off-grid, or restores normal WiFi (`down`). NetworkManager-based, fully reversible. **Run at the console.** |
| `harden-kiss.sh` | F1 | safe (only TCP 8001) | Firewalls direwolf's KISS TNC to loopback (`restrict`) or opens it to the LAN (`allow`). Safe over SSH/Tailscale. |

## Phase H1 — AP / hotspot field mode

```bash
sudo deploy/hampi-hotspot.sh up            # become HamPi-Field / hampi-field, dashboard at 10.42.0.1:8000
sudo deploy/hampi-hotspot.sh up MySSID MyPassword
sudo deploy/hampi-hotspot.sh down          # rejoin normal WiFi
sudo deploy/hampi-hotspot.sh status
```

`up` disconnects the Pi from its current WiFi (that's the point — it becomes the
AP). If you're on Tailscale/SSH over that WiFi, the session ends; reconnect by
joining `HamPi-Field`. `autoconnect` is left off so a reboot comes back on your
normal network, not the hotspot.

Not yet done (future H1 polish): a physical toggle (GPIO/boot flag) to enter field
mode without a keyboard, and a dashboard button (which can only *start* the AP — it
can't show you the result over the link it just dropped).

## Phase F1 — LAN KISS TNC

direwolf opens KISS on `:8001` while SDR 0 is in APRS mode. `ax25.py` uses it on
localhost; the dashboard shows the LAN address on the APRS page. Set
`aprs.kiss_lan` in `config.yaml` to declare intent, then enforce it:

```bash
sudo deploy/harden-kiss.sh restrict   # loopback-only (default posture)
sudo deploy/harden-kiss.sh allow      # deliberate LAN TNC for phones/laptops
sudo deploy/harden-kiss.sh status
```
