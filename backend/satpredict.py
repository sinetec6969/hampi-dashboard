"""
satpredict.py - SSTV satellite tracker: AMSAT TLEs, pass prediction, Doppler.

Computes, for a curated list of SSTV-transmitting satellites and a fixed QTH
(Maidenhead grid), each bird's live elevation/azimuth, the Doppler-shifted
downlink frequency, and the next visible pass (AOS / max-el / LOS). TLEs come
from AMSAT (cached to disk, refreshed daily). All math is local — skyfield +
sgp4, no runtime cloud beyond the periodic TLE pull.
"""

import logging
import os
import time
import urllib.request
from typing import Optional

from skyfield.api import EarthSatellite, load, wgs84

logger = logging.getLogger(__name__)

AMSAT_TLE_URL = "https://www.amsat.org/tle/current/nasabare.txt"
CELESTRAK_WX_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle"
TLE_URLS = [AMSAT_TLE_URL, CELESTRAK_WX_URL]  # amateur birds + weather (METEOR/NOAA)
C = 299_792_458.0  # m/s

# METEOR-M LRPT weather satellites (137 MHz QPSK; decoded by SatDump, see meteor.py).
DEFAULT_METEOR_SATS = [
    {"norad": 59051, "name": "METEOR-M2-4", "freq": 137_900_000, "mode": "QPSK · LRPT 72k",
     "desc": "Russian polar weather sat (2024) — MSU-MR visible/IR LRPT on 137.9 FM. "
             "The most active LRPT bird; SatDump decodes to MSU-MR composites."},
    {"norad": 57166, "name": "METEOR-M2-3", "freq": 137_900_000, "mode": "QPSK · LRPT 72k",
     "desc": "Russian polar weather sat (2023) — MSU-MR LRPT, typically 137.9 FM."},
]

# Curated satellites known to transmit SSTV. Frequencies are downlink centres;
# editable via config.yaml `sstv_satellites:`. ISS is the reliable one.
DEFAULT_SSTV_SATS = [
    {"norad": 25544, "name": "ISS", "freq": 145_800_000, "mode": "FM · PD120",
     "desc": "International Space Station — ARISS SSTV events on 145.800 FM "
             "(usually PD120). Scheduled events only; check ariss-sstv.blogspot.com."},
    {"norad": 57172, "name": "UmKA-1 (RS40S)", "freq": 437_625_000, "mode": "FM · SSTV",
     "desc": "Russian educational CubeSat — telescope imagery via SSTV on 437.625 FM "
             "(70 cm). Also CW + GMSK telemetry on the same downlink."},
    {"norad": 59112, "name": "SONATE-2", "freq": 145_880_000, "mode": "FM · Martin M1",
     "desc": "Würzburg AI tech-demo CubeSat — onboard-camera imagery as SSTV "
             "(Martin M1) on 145.880 FM (2 m). 437.025 is its GMSK telemetry, not SSTV."},
]


def grid_to_latlon(grid: str) -> tuple[float, float]:
    """Maidenhead locator → (lat, lon) at the centre of the subsquare."""
    g = grid.strip()
    lon = (ord(g[0].upper()) - 65) * 20 - 180
    lat = (ord(g[1].upper()) - 65) * 10 - 90
    lon += int(g[2]) * 2
    lat += int(g[3]) * 1
    if len(g) >= 6:
        lon += (ord(g[4].lower()) - 97) * (2 / 24) + (1 / 24)
        lat += (ord(g[5].lower()) - 97) * (1 / 24) + (1 / 48)
    else:
        lon += 1.0
        lat += 0.5
    return round(lat, 4), round(lon, 4)


class SatTracker:
    def __init__(self, grid: str, sstv_sats: Optional[list[dict]] = None,
                 meteor_sats: Optional[list[dict]] = None,
                 cache_path: Optional[str] = None, tle_max_age_h: float = 24.0,
                 tle_urls: Optional[list[str]] = None):
        self.grid = grid
        self.lat, self.lon = grid_to_latlon(grid)
        self.sstv_sats = sstv_sats or DEFAULT_SSTV_SATS
        self.meteor_sats = meteor_sats or DEFAULT_METEOR_SATS
        self._all_cfg = self.sstv_sats + self.meteor_sats
        self.tle_urls = tle_urls or TLE_URLS
        self.cache_path = cache_path or os.path.join(
            os.path.dirname(__file__), "..", "tle_cache.txt")
        self.tle_max_age_h = tle_max_age_h

        self._ts = load.timescale()
        self._obs = wgs84.latlon(self.lat, self.lon)
        self._sats: dict[int, EarthSatellite] = {}
        self._pass_cache: dict[int, tuple[float, Optional[dict]]] = {}
        self.tracked: Optional[int] = None

    # ---- TLE handling -------------------------------------------------

    def refresh_tles(self, force: bool = False) -> bool:
        fresh = (os.path.isfile(self.cache_path) and
                 time.time() - os.path.getmtime(self.cache_path) < self.tle_max_age_h * 3600)
        if force or not fresh:
            merged = []
            for url in self.tle_urls:
                try:
                    with urllib.request.urlopen(url, timeout=20) as r:
                        merged.append(r.read().decode("utf-8", errors="replace"))
                except Exception as exc:
                    logger.warning("TLE fetch failed (%s): %s", url, exc)
            if merged:
                with open(self.cache_path, "w") as f:
                    f.write("\n".join(merged))
                logger.info("TLEs refreshed from %d source(s) → %s",
                            len(merged), self.cache_path)
            elif not os.path.isfile(self.cache_path):
                return False
        self._load()
        return bool(self._sats)

    def _load(self) -> None:
        try:
            lines = [l.rstrip() for l in open(self.cache_path)]
        except FileNotFoundError:
            return
        # Load every 3-line group keyed by NORAD — the set is small (~120).
        self._sats.clear()
        i = 0
        while i + 2 < len(lines) + 1:
            if i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
                try:
                    norad = int(lines[i + 1][2:7])
                    self._sats[norad] = EarthSatellite(lines[i + 1], lines[i + 2],
                                                       lines[i].strip(), self._ts)
                except Exception:
                    pass
                i += 3
            else:
                i += 1

    # ---- per-satellite computation ------------------------------------

    def _next_pass(self, norad: int, min_el: float = 10.0) -> Optional[dict]:
        cached = self._pass_cache.get(norad)
        now = time.time()
        if cached and now - cached[0] < 300 and (cached[1] is None or cached[1]["los_ts"] > now):
            return cached[1]
        sat = self._sats.get(norad)
        if sat is None:
            return None
        t0 = self._ts.now()
        t1 = self._ts.tt_jd(t0.tt + 3.0)  # search 3 days
        result: Optional[dict] = None
        try:
            times, events = sat.find_events(self._obs, t0, t1, altitude_degrees=min_el)
            cur: dict = {}
            for t, e in zip(times, events):
                if e == 0:
                    cur = {"aos_ts": t.utc_datetime().timestamp()}
                elif e == 1 and cur:
                    alt, az, _ = (sat - self._obs).at(t).altaz()
                    cur["max_ts"] = t.utc_datetime().timestamp()
                    cur["max_el"] = round(float(alt.degrees), 1)
                elif e == 2 and cur.get("aos_ts"):
                    cur["los_ts"] = t.utc_datetime().timestamp()
                    result = cur
                    break
        except Exception:
            logger.debug("pass calc failed for %d", norad, exc_info=True)
        self._pass_cache[norad] = (now, result)
        return result

    def _live(self, norad: int, freq: int) -> dict:
        sat = self._sats.get(norad)
        if sat is None:
            return {"visible": False}
        diff = sat - self._obs
        t = self._ts.now()
        alt, az, dist = diff.at(t).altaz()
        # Doppler via numerical range rate over 1 s
        r1 = diff.at(t).distance().m
        r2 = diff.at(self._ts.tt_jd(t.tt + 1.0 / 86400)).distance().m
        rate = r2 - r1
        dopp = int(round(-rate / C * freq))
        return {
            "el": round(float(alt.degrees), 1),
            "az": round(float(az.degrees), 1),
            "range_km": int(round(dist.km)),
            "doppler_hz": dopp,
            "rx_freq": freq + dopp,
            "visible": bool(alt.degrees > 0),
        }

    def info(self, which: Optional[list[dict]] = None) -> list[dict]:
        """Full status for a satellite list (defaults to the SSTV birds)."""
        out = []
        for s in (which if which is not None else self.sstv_sats):
            n = s["norad"]
            row = {**s, "tracked": n == self.tracked, "has_tle": n in self._sats}
            if n in self._sats:
                row.update(self._live(n, s["freq"]))
                row["next_pass"] = self._next_pass(n)
            out.append(row)
        return out

    def tracked_rx_freq(self) -> Optional[int]:
        """Doppler-corrected downlink for the tracked sat, or None."""
        if self.tracked is None:
            return None
        cfg = next((s for s in self._all_cfg if s["norad"] == self.tracked), None)
        if cfg is None:
            return None
        return self._live(self.tracked, cfg["freq"]).get("rx_freq")

    def tracked_downlink(self) -> Optional[int]:
        if self.tracked is None:
            return None
        cfg = next((s for s in self._all_cfg if s["norad"] == self.tracked), None)
        return cfg["freq"] if cfg else None

    def status(self) -> dict:
        return {"grid": self.grid, "lat": self.lat, "lon": self.lon,
                "tracked": self.tracked, "sats_loaded": len(self._sats)}


if __name__ == "__main__":
    assert grid_to_latlon("EM95of") == (35.2292, -80.7917), grid_to_latlon("EM95of")
    t = SatTracker("EM95of")
    # Seed cache from any pre-downloaded /tmp TLE files (amsat + celestrak weather)
    seed = [p for p in ("/tmp/amsat.txt", "/tmp/celestrak_wx.txt") if os.path.isfile(p)]
    if seed:
        with open(t.cache_path, "w") as out:
            for p in seed:
                out.write(open(p).read() + "\n")
    assert t.refresh_tles(), "no TLEs loaded"
    assert 25544 in t._sats, "ISS not loaded"
    if 59051 in t._sats:
        print("METEOR-M2-4 loaded ✓")
    info = t.info()
    iss = next(r for r in info if r["norad"] == 25544)
    assert "el" in iss and "doppler_hz" in iss, iss
    assert abs(iss["rx_freq"] - 145_800_000) < 20_000, iss["rx_freq"]
    t.tracked = 25544
    assert t.tracked_rx_freq() is not None
    print(f"PASS: QTH {t.lat},{t.lon} · {len(t._sats)} SSTV sats loaded")
    for r in info:
        np_ = r.get("next_pass")
        when = time.strftime("%m-%d %H:%MZ", time.gmtime(np_["aos_ts"])) if np_ else "no pass/3d"
        print(f"  {r['name']:<16} el={r.get('el','—')}° dopp={r.get('doppler_hz','—')}Hz next={when}")
