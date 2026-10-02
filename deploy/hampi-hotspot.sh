#!/bin/bash
# [Phase H1] AP / hotspot field mode — NetworkManager-based, reversible.
#
# ⚠️  RUN THIS AT THE CONSOLE, NOT OVER SSH/TAILSCALE.
#     'up' turns wlan0 into an access point, which DROPS whatever WiFi network
#     the Pi is on — including the link you'd be running this over. That is the
#     whole point of field mode, but it will disconnect a remote session.
#
# Uses `nmcli device wifi hotspot`, so it's fully reversible: 'down' brings back
# your normal WiFi. Nothing here runs automatically; you invoke it explicitly.
#
# Usage:
#   deploy/hampi-hotspot.sh up      [SSID] [PASSWORD]   # become an AP (default HamPi-Field / hampi-field)
#   deploy/hampi-hotspot.sh down                         # tear the AP down, rejoin normal WiFi
#   deploy/hampi-hotspot.sh status
set -euo pipefail

IFACE="${HAMPI_HOTSPOT_IFACE:-wlan0}"
CON="hampi-hotspot"
SSID="${2:-HamPi-Field}"
PASS="${3:-hampi-field}"

case "${1:-status}" in
  up)
    [ "${#PASS}" -ge 8 ] || { echo "password must be >= 8 chars (WPA2)"; exit 1; }
    echo "Bringing up AP '$SSID' on $IFACE — this drops the current WiFi link."
    # NM assigns 10.42.0.1 to the Pi and runs DHCP/DNS for clients automatically.
    nmcli device wifi hotspot ifname "$IFACE" con-name "$CON" ssid "$SSID" password "$PASS"
    nmcli connection modify "$CON" connection.autoconnect no
    echo "AP up. Dashboard: http://10.42.0.1:8000  (join SSID '$SSID')."
    ;;
  down)
    nmcli connection down "$CON" 2>/dev/null || true
    echo "Hotspot down. NetworkManager will reconnect your normal WiFi."
    nmcli -t -f NAME,DEVICE connection show --active | grep "$IFACE" || true
    ;;
  status)
    echo "iface=$IFACE"
    nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active | grep -E "wifi|$CON" || echo "no active wifi connection"
    ;;
  *)
    sed -n '2,20p' "$0"; exit 1 ;;
esac
