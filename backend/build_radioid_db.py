"""
build_radioid_db.py - one-time build of the offline RadioID user database.

Downloads the RadioID.net user CSV dump (~17 MB) into ../radioid.db
(sqlite). With the DB present, DMR user lookups are local reads — no
radioid.net API calls. (City→coords geocoding for the map still uses
Nominatim, cached.) Re-run whenever a refresh is wanted.

Usage: venv/bin/python build_radioid_db.py [source.csv]
"""

import csv
import os
import sqlite3
import sys
import urllib.request

URL = "https://radioid.net/static/user.csv"
DB  = os.path.join(os.path.dirname(__file__), "..", "radioid.db")


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/radioid_user.csv"
    if len(sys.argv) < 2 and not os.path.isfile(src):
        print(f"downloading {URL} …")
        urllib.request.urlretrieve(URL, src)
        print(f"saved {os.path.getsize(src) / 1e6:.0f} MB → {src}")

    con = sqlite3.connect(DB + ".tmp")
    con.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, callsign TEXT, "
                "name TEXT, city TEXT, state TEXT, country TEXT)")
    n = 0
    with open(src, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        cols = {c.lower(): c for c in reader.fieldnames or []}
        def col(row, *names):
            for nm in names:
                if nm in cols:
                    return (row.get(cols[nm]) or "").strip()
            return ""
        for row in reader:
            rid = col(row, "radio_id", "id")
            if not rid.isdigit():
                continue
            con.execute(
                "INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?)",
                (int(rid), col(row, "callsign"),
                 f'{col(row, "first_name", "fname")} {col(row, "last_name", "surname")}'.strip(),
                 col(row, "city"), col(row, "state"), col(row, "country")),
            )
            n += 1
    con.commit()
    con.close()
    os.replace(DB + ".tmp", DB)
    print(f"wrote {n} users → {os.path.abspath(DB)} ({os.path.getsize(DB) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
