"""
adsb.py - ADS-B decoder backed by rtl_adsb subprocess + pyModeS.

Runs rtl_adsb, parses hex messages, decodes via pyModeS, maintains a live
aircraft registry keyed by ICAO hex, and fires aircraft_callback on updates.
Stale aircraft (unseen for EXPIRE_S) are pruned periodically.

Position decoding uses CPR two-message decoding (odd+even pair) with an
optional lat/lon reference fallback (set ADSB_LAT / ADSB_LON env vars).
"""

import asyncio
import logging
import time
from typing import Callable, Awaitable, Optional

import pyModeS as pms

logger = logging.getLogger(__name__)

EXPIRE_S  = 60.0   # remove aircraft unseen for this many seconds
PRUNE_S   = 15.0   # prune-loop interval
MAX_TRACK = 60     # max position history points per aircraft


AircraftCb = Callable[[dict], Awaitable[None]]


class ADSBDecoder:
    """
    Wraps rtl_adsb subprocess, decodes ADS-B messages via pyModeS, and
    maintains a live aircraft dict keyed by ICAO hex.
    """

    def __init__(
        self,
        device_index: int = 2,
        gain: float = -1.0,       # negative = auto gain
        lat_ref: float = 0.0,     # reference position for CPR fallback
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

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

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
        logger.info("ADSBDecoder started — device=%d", self.device_index)

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
        """Return current aircraft as a list, excluding internal CPR state."""
        return [_public(ac) for ac in self.aircraft.values()]

    # ------------------------------------------------------------------
    # Internal loops
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Message decoding
    # ------------------------------------------------------------------

    async def _process(self, msg: str) -> None:
        try:
            if len(msg) < 14:
                return
            df = pms.df(msg)
            if df != 17:          # DF-17 = Extended Squitter (ADS-B only)
                return

            icao = pms.icao(msg).lower()
            tc   = pms.adsb.typecode(msg)

            if icao not in self.aircraft:
                self.aircraft[icao] = {
                    "icao":      icao,
                    "callsign":  None,
                    "altitude":  None,
                    "lat":       None,
                    "lon":       None,
                    "speed":     None,
                    "heading":   None,
                    "vrate":     None,
                    "last_seen": time.time(),
                    "track":     [],
                    # internal CPR state — excluded from aircraft_list()
                    "_cpr_odd":  None,
                    "_cpr_even": None,
                }

            ac           = self.aircraft[icao]
            ac["last_seen"] = time.time()

            # Identification (callsign)
            if 1 <= tc <= 4:
                cs = pms.adsb.callsign(msg).strip()
                if cs:
                    ac["callsign"] = cs

            # Airborne position
            elif 9 <= tc <= 18:
                alt = pms.adsb.altitude(msg)
                if alt is not None:
                    ac["altitude"] = alt

                oe  = pms.adsb.oe_flag(msg)
                now = time.time()
                if oe == 1:
                    ac["_cpr_odd"]  = (msg, now)
                else:
                    ac["_cpr_even"] = (msg, now)

                pos = None
                odd, even = ac["_cpr_odd"], ac["_cpr_even"]

                # Two-message CPR (preferred — works without reference position)
                if odd and even and abs(odd[1] - even[1]) < 10:
                    try:
                        pos = pms.adsb.airborne_position(
                            odd[0], even[0], odd[1], even[1]
                        )
                    except Exception:
                        pass

                # Single-message CPR with reference position (fallback)
                if pos is None and (self.lat_ref or self.lon_ref):
                    try:
                        pos = pms.adsb.airborne_position_with_ref(
                            msg, self.lat_ref, self.lon_ref
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
                vel = pms.adsb.velocity(msg)
                if vel:
                    spd, hdg, vr, _ = vel
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
    """Return aircraft dict without internal CPR state fields."""
    return {k: v for k, v in ac.items() if not k.startswith("_")}
