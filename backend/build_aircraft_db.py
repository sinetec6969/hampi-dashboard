"""
build_aircraft_db.py - one-time build of the local ADS-B aircraft database.

Downloads the OpenSky aircraft metadata CSV (~95 MB) and distills it into
../aircraft.db (sqlite, ~30 MB): icao24 → registration, type, model, operator.
Re-run whenever a refresh is wanted. No runtime cloud dependency — lookups
are local sqlite reads.

Usage: venv/bin/python build_aircraft_db.py [source.csv]
"""

import csv
import os
import sqlite3
import sys
import urllib.request

URL = "https://opensky-network.org/datasets/metadata/aircraftDatabase.csv"
DB  = os.path.join(os.path.dirname(__file__), "..", "aircraft.db")


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/aircraftDatabase.csv"
    if len(sys.argv) < 2 and not os.path.isfile(src):
        print(f"downloading {URL} …")
        urllib.request.urlretrieve(URL, src)
        print(f"saved {os.path.getsize(src) / 1e6:.0f} MB → {src}")

    con = sqlite3.connect(DB + ".tmp")
    con.execute("CREATE TABLE aircraft (icao TEXT PRIMARY KEY, reg TEXT, "
                "type TEXT, model TEXT, operator TEXT)")
    n = 0
    with open(src, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            icao = (row.get("icao24") or "").strip().lower()
            if len(icao) != 6:
                continue
            reg      = (row.get("registration") or "").strip()
            typecode = (row.get("typecode") or "").strip()
            model    = (row.get("model") or "").strip()
            operator = (row.get("operator") or row.get("owner") or "").strip()
            if not (reg or typecode or model or operator):
                continue
            con.execute("INSERT OR REPLACE INTO aircraft VALUES (?,?,?,?,?)",
                        (icao, reg, typecode, model, operator))
            n += 1
    con.commit()
    con.close()
    os.replace(DB + ".tmp", DB)
    print(f"wrote {n} aircraft → {os.path.abspath(DB)} "
          f"({os.path.getsize(DB) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
