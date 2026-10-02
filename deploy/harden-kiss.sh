#!/bin/bash
# [F1] direwolf's KISS TNC (:8001) binds 0.0.0.0, so it's reachable from the whole
# LAN whenever SDR 0 is in APRS mode. ax25.py needs it on 127.0.0.1; the LAN
# exposure is what APRSdroid / YAAC / RadioMail use as a network TNC.
#
# Set aprs.kiss_lan in config.yaml to declare intent. This script enforces it at
# the firewall (nftables), since direwolf itself can't bind loopback-only:
#   restrict  → :8001 reachable only from localhost (loopback). Default posture.
#   allow     → :8001 reachable from the LAN (deliberate TNC).
#
# Safe to run over SSH/Tailscale — it only touches TCP 8001, never the dashboard
# port (8000) or your uplink. Run with sudo.
set -euo pipefail
TABLE="hampi"; PORT=8001

case "${1:-restrict}" in
  restrict)
    nft -f - <<EOF
table inet $TABLE {
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport $PORT ip saddr != 127.0.0.1 drop
    tcp dport $PORT ip6 saddr != ::1 drop
  }
}
EOF
    echo "KISS :$PORT restricted to loopback."
    ;;
  allow)
    nft delete table inet $TABLE 2>/dev/null || true
    echo "KISS :$PORT open to the LAN (deliberate TNC)."
    ;;
  status)
    nft list table inet $TABLE 2>/dev/null || echo "no $TABLE table — :$PORT is at the system default (LAN-reachable)."
    ;;
  *)
    echo "usage: $0 {restrict|allow|status}"; exit 1 ;;
esac
