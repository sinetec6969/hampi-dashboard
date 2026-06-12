import asyncio
import logging
import os
import sqlite3
import time
from typing import Callable, Awaitable, Optional

import pyModeS as pms
import pyModeS.position as pms_pos

logger = logging.getLogger(__name__)

EXPIRE_S  = 60.0
PRUNE_S   = 15.0
MAX_TRACK = 60

# Local aircraft registry — build with build_aircraft_db.py (optional)
_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "aircraft.db")
_db: Optional[sqlite3.Connection] = None
if os.path.isfile(_DB_PATH):
    _db = sqlite3.connect(_DB_PATH, check_same_thread=False)
    logger.info("aircraft.db loaded: %s", _DB_PATH)


def db_lookup(icao: str) -> dict:
    if _db is None:
        return {"reg": None, "actype": None, "model": None, "operator": None}
    row = _db.execute(
        "SELECT reg, type, model, operator FROM aircraft WHERE icao=?", (icao,)
    ).fetchone()
    return {
        "reg":      (row and row[0]) or None,
        "actype":   (row and row[1]) or None,
        "model":    (row and row[2]) or None,
        "operator": (row and row[3]) or None,
    }

AircraftCb = Callable[[dict], Awaitable[None]]


class ADSBDecoder:
    def __init__(
        self,
        device_index: int | str = 2,
        gain: float = -1.0,
        lat_ref: float = 0.0,
        lon_ref: float = 0.0,
        aircraft_callback: Optional[AircraftCb] = None,
    ):
        self.device_index = device_index
        self.gain         = gain
        self.lat_ref      = lat_ref
        self.lon_ref      = lon_ref
        self._cb          = aircraft_callback

        self.aircraft: dict[str, dict] = {}

        self._proc:       Optional[asyncio.subprocess.Process] = None
        self._read_task:  Optional[asyncio.Task] = None
        self._prune_task: Optional[asyncio.Task] = None
        self._active      = False

    async def start(self) -> None:
        cmd = ["rtl_adsb", "-d", str(self.device_index)]
        if self.gain >= 0:
            cmd += ["-g", str(int(self.gain))]
        logger.info("Starting rtl_adsb: %s", " ".join(cmd))
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._active     = True
        self._read_task  = asyncio.create_task(self._read_loop(),  name="adsb-read")
        self._prune_task = asyncio.create_task(self._prune_loop(), name="adsb-prune")
        logger.info("ADSBDecoder started — device=%s", self.device_index)

    async def stop(self) -> None:
        self._active = False
        for t in (self._read_task, self._prune_task):
            if t:
                t.cancel()
        await asyncio.gather(
            *(t for t in (self._read_task, self._prune_task) if t),
            return_exceptions=True,
        )
        self._read_task = self._prune_task = None
        if self._proc:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
            self._proc = None
        logger.info("ADSBDecoder stopped")

    def aircraft_list(self) -> list[dict]:
        return [_public(ac) for ac in self.aircraft.values()]

    async def _read_loop(self) -> None:
        while self._active and self._proc:
            try:
                raw = await self._proc.stdout.readline()
                if not raw:
                    logger.warning("rtl_adsb stdout closed unexpectedly")
                    break
                line = raw.decode("ascii", errors="ignore").strip()
                if line.startswith("*") and line.endswith(";"):
                    await self._process(line[1:-1].upper())
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("adsb read error", exc_info=True)

    async def _prune_loop(self) -> None:
        while self._active:
            await asyncio.sleep(PRUNE_S)
            now   = time.time()
            stale = [k for k, v in self.aircraft.items()
                     if now - v["last_seen"] > EXPIRE_S]
            for k in stale:
                del self.aircraft[k]
            if stale and self._cb:
                await self._cb({"type": "prune", "expired": stale})

    async def _process(self, msg: str) -> None:
        try:
            if len(msg) < 14:
                return
            m = pms.Message(msg)
            if m.df != 17:
                return

            icao = m.icao.lower()
            tc   = m.typecode

            if icao not in self.aircraft:
                self.aircraft[icao] = {
                    "icao":      icao,
                    **db_lookup(icao),
                    "callsign":  None,
                    "altitude":  None,
                    "lat":       None,
                    "lon":       None,
                    "speed":     None,
                    "heading":   None,
                    "vrate":     None,
                    "last_seen": time.time(),
                    "track":     [],
                    "_cpr_odd":  None,   # (cpr_lat, cpr_lon, t)
                    "_cpr_even": None,
                }

            ac           = self.aircraft[icao]
            ac["last_seen"] = time.time()

            d = m.decode()

            # Identification (callsign)
            if 1 <= tc <= 4:
                cs = d.get("callsign", "").strip()
                if cs:
                    ac["callsign"] = cs

            # Airborne position
            elif 9 <= tc <= 18:
                alt = d.get("altitude")
                if alt is not None:
                    ac["altitude"] = alt

                cpr_lat = d.get("cpr_lat")
                cpr_lon = d.get("cpr_lon")
                cpr_fmt = d.get("cpr_format")

                if cpr_lat is not None and cpr_lon is not None:
                    now = time.time()
                    if cpr_fmt == 1:
                        ac["_cpr_odd"]  = (cpr_lat, cpr_lon, now)
                    else:
                        ac["_cpr_even"] = (cpr_lat, cpr_lon, now)

                    pos = None
                    odd, even = ac["_cpr_odd"], ac["_cpr_even"]

                    if odd and even and abs(odd[2] - even[2]) < 10:
                        try:
                            pos = pms_pos.airborne_position_pair(
                                even[0], even[1],
                                odd[0],  odd[1],
                                even_is_newer=(even[2] > odd[2]),
                            )
                        except Exception:
                            pass

                    if pos is None and (self.lat_ref or self.lon_ref):
                        try:
                            pos = pms_pos.airborne_position_with_ref(
                                cpr_fmt, cpr_lat, cpr_lon,
                                self.lat_ref, self.lon_ref,
                            )
                        except Exception:
                            pass

                    if pos:
                        lat, lon = pos
                        ac["lat"] = round(lat, 6)
                        ac["lon"] = round(lon, 6)
                        track = ac["track"]
                        if (not track
                                or abs(lat - track[-1][0]) > 1e-5
                                or abs(lon - track[-1][1]) > 1e-5):
                            track.append([round(lat, 5), round(lon, 5)])
                            if len(track) > MAX_TRACK:
                                track.pop(0)

            # Airborne velocity
            elif tc == 19:
                spd = d.get("groundspeed")
                hdg = d.get("track")
                vr  = d.get("vertical_rate")
                if spd is not None:
                    ac["speed"]   = round(spd)
                if hdg is not None:
                    ac["heading"] = round(hdg)
                if vr is not None:
                    ac["vrate"]   = round(vr)

            if self._cb:
                await self._cb({"type": "aircraft", "aircraft": _public(ac)})

        except Exception:
            logger.debug("adsb decode error for %r", msg, exc_info=True)


def _public(ac: dict) -> dict:
    return {k: v for k, v in ac.items() if not k.startswith("_")}
