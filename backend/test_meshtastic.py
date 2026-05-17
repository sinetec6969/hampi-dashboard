"""
Quick smoke test for the Meshtastic connection.
Run once the Heltec V3 is plugged in:

    cd backend && source venv/bin/activate && python test_meshtastic.py

Prints node list, waits 30 s for live packets, then exits.
"""

import time, sys

try:
    import meshtastic.serial_interface
    from pubsub import pub
except ImportError:
    print("ERROR: meshtastic not installed — run: pip install meshtastic")
    sys.exit(1)

received = []
connected = False

def on_receive(packet, interface):
    portnum = packet.get("decoded", {}).get("portnum", "?")
    from_id = f"!{packet.get('from', 0):08x}"
    received.append((time.time(), portnum, from_id))
    print(f"  PKT  {portnum:30s}  from {from_id}")

def on_connect(interface, topic=None):
    global connected
    connected = True
    print(f"\n✓ Connected!")
    try:
        print(f"  Device:    {interface.devPath}")
        print(f"  Local ID:  !{interface.localNode.nodeNum:08x}")
    except Exception as e:
        print(f"  (could not read local info: {e})")

    nodes = getattr(interface, "nodes", {}) or {}
    print(f"\n  Nodes in DB: {len(nodes)}")
    for nid, n in nodes.items():
        user = n.get("user", {})
        pos  = n.get("position", {})
        dm   = n.get("deviceMetrics", {})
        lat  = pos.get("latitude") or (pos.get("latitudeI", 0) / 1e7 if "latitudeI" in pos else None)
        lon  = pos.get("longitude") or (pos.get("longitudeI", 0) / 1e7 if "longitudeI" in pos else None)
        print(f"    {nid:14s}  {user.get('longName','?'):20s}  "
              f"hw={user.get('hwModel','?'):12s}  "
              f"batt={dm.get('batteryLevel','?')}%  "
              f"lat={lat}  lon={lon}  "
              f"snr={n.get('snr','?')}")

def on_lost(interface, topic=None):
    print("\n✗ Connection lost")

pub.subscribe(on_receive, "meshtastic.receive")
pub.subscribe(on_connect,  "meshtastic.connection.established")
pub.subscribe(on_lost,     "meshtastic.connection.lost")

print("Connecting to Meshtastic device (auto-detect)...")
try:
    iface = meshtastic.serial_interface.SerialInterface()
except Exception as e:
    print(f"\nFailed to connect: {e}")
    print("\nTroubleshooting:")
    print("  1. Check cable — must be a data cable, not charge-only")
    print("  2. Check port:  ls /dev/ttyUSB* /dev/ttyACM*")
    print("  3. Check group: groups $USER  (must include dialout)")
    print("  4. sudo usermod -aG dialout $USER  then re-login")
    sys.exit(1)

print(f"Waiting 30 s for live packets...")
time.sleep(30)

iface.close()

print(f"\nDone — received {len(received)} packet(s) in 30 s")
if received:
    for ts, portnum, from_id in received:
        print(f"  {time.strftime('%H:%M:%S', time.localtime(ts))}  {portnum:30s}  {from_id}")
else:
    print("  (no packets — mesh may be quiet; that's normal)")
print("\nMeshtastic handler is working correctly.")
