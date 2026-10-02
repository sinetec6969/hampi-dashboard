"""
netlog.py - net-control logging, backed by the termnetlog data layer.

Reuses termnetlog (github.com/sinetec6969/termnetlog, MIT) as a library: its
`Repo` (SQLite), `callsign.parse`, async `LookupService` (QRZ/HamDB), and
`export.to_adif`. The Textual TUI isn't used; HamPi puts REST + a React page
over the same data.

DB is HamPi's own file (separate from the TUI's, by config), so the connection
is created on the event-loop thread in lifespan and every Repo call happens on
that same thread — matching how main.py uses radioid.db / aircraft.db inline.
termnetlog.db.connect enables WAL. QRZ creds + the offline flag come from
termnetlog's own config.toml (LookupService.from_config).
"""

import logging
from dataclasses import asdict
from typing import Awaitable, Callable, Optional

from termnetlog import db, callsign, export, config as tnl_config
from termnetlog.repo import Repo, DuplicateCheckIn
from termnetlog.lookup.service import LookupService

logger = logging.getLogger(__name__)

UpdateCb = Callable[[dict], Awaitable[None]]


def _net(n) -> dict:
    return asdict(n)


def _row(r) -> dict:
    return {"checkin": asdict(r.checkin),
            "operator": asdict(r.operator) if r.operator else None,
            "nth": r.nth, "prev_seen": r.prev_seen}


def _opsum(s) -> dict:
    return {"operator": asdict(s.operator), "checkin_count": s.checkin_count,
            "first_seen": s.first_seen, "last_seen": s.last_seen}


class NetLog:
    def __init__(self, db_path: str, update_callback: Optional[UpdateCb] = None):
        self.db_path = db_path
        self._cb = update_callback
        self._conn = db.connect(db_path)
        self.repo = Repo(self._conn)
        self.lookups: Optional[LookupService] = None
        self.offline = True
        try:
            cfg = tnl_config.load()
            self.lookups = LookupService.from_config(self.repo, cfg)
            self.offline = bool(getattr(cfg, "offline", False))
        except Exception:
            logger.warning("netlog: lookup service unavailable (no termnetlog config?) — logging only",
                           exc_info=True)
        logger.info("NetLog ready — db=%s, lookups=%s", db_path,
                    "off" if (self.offline or not self.lookups) else "on")

    async def stop(self) -> None:
        if self.lookups is not None:
            try:
                await self.lookups.aclose()
            except Exception:
                pass
        try:
            self._conn.close()
        except Exception:
            pass

    # ---------------------------------------------------------------- nets

    def list_nets(self, search: str = "", limit: int = 200) -> list[dict]:
        return [{**_net(n), "checkin_count": c} for n, c in self.repo.list_nets(limit, search=search)]

    def open_nets(self) -> list[dict]:
        return [_net(n) for n in self.repo.open_nets()]

    def create_net(self, **kw) -> dict:
        n = self.repo.create_net(
            name=kw["name"], frequency=kw.get("frequency", ""), mode=kw.get("mode", ""),
            band=kw.get("band", ""), ncs_callsign=kw.get("ncs_callsign", ""),
            my_role=kw.get("my_role", "NCS"), notes=kw.get("notes", ""))
        return _net(n)

    def end_net(self, net_id: int) -> dict:
        self.repo.end_net(net_id)
        n = self.repo.get_net(net_id)
        if n is None:
            raise ValueError(f"no net {net_id}")
        return _net(n)

    def checkins(self, net_id: int) -> list[dict]:
        return [_row(r) for r in self.repo.list_checkins(net_id)]

    # ---------------------------------------------------------------- check-ins

    async def add_checkin(self, net_id: int, text: str, relayed_by: str = "") -> dict:
        if self.repo.get_net(net_id) is None:
            raise ValueError(f"no net {net_id}")
        parsed = callsign.parse(text)
        if parsed is None:
            raise ValueError(f"not a callsign: {text!r}")
        ci = self.repo.add_checkin(net_id, parsed, relayed_by)   # raises DuplicateCheckIn
        await self._push(net_id)                                 # row shows instantly
        if self.lookups is not None and not self.offline:
            try:
                await self.lookups.resolve(parsed.base)          # writes enriched Operator back
                await self._push(net_id)                         # row now has name/QTH
            except Exception:
                logger.debug("netlog lookup failed for %s", parsed.base, exc_info=True)
        return asdict(ci)

    def toggle_flag(self, checkin_id: int, flag: str) -> dict:
        return asdict(self.repo.toggle_flag(checkin_id, flag))

    # ---------------------------------------------------------------- operators

    def operator(self, call: str) -> Optional[dict]:
        s = self.repo.operator_summary(call)
        if s is None:
            return None
        hist = [{"checkin": asdict(ci), "net": _net(n)} for ci, n in self.repo.operator_history(call)]
        return {**_opsum(s), "history": hist}

    def search_operators(self, query: str = "", limit: int = 100) -> list[dict]:
        return [_opsum(s) for s in self.repo.search_operators(query, limit)]

    # ---------------------------------------------------------------- export

    def adif(self, net_id: int) -> tuple[str, str]:
        net = self.repo.get_net(net_id)
        if net is None:
            raise ValueError(f"no net {net_id}")
        rows = self.repo.list_checkins(net_id)
        text = export.to_adif(net, rows, net.ncs_callsign or "")
        fname = f"{(net.name or 'net').replace(' ', '_')}_{net_id}.adi"
        return text, fname

    # ---------------------------------------------------------------- status/push

    def status_dict(self) -> dict:
        nets, ops = self.repo.counts()
        return {"db_path": self.db_path, "nets": nets, "operators": ops,
                "open_nets": self.open_nets(),
                "lookups": bool(self.lookups and not self.offline)}

    async def _push(self, net_id: int) -> None:
        if self._cb:
            await self._cb({"type": "checkins", "net_id": net_id,
                            "checkins": self.checkins(net_id), "status": self.status_dict()})


if __name__ == "__main__":
    import asyncio, tempfile, os
    tmp = tempfile.mkdtemp()
    nl = NetLog(os.path.join(tmp, "netlog.db"))
    nl.offline = True   # no network in the self-test
    net = nl.create_net(name="Test Net", frequency="146.520", mode="FM", band="2m", ncs_callsign="KR4BPW")
    assert net["id"] and net["name"] == "Test Net"
    ci = asyncio.run(nl.add_checkin(net["id"], "W1AW"))
    assert ci["callsign"] == "W1AW" and ci["seq"] == 1, ci
    ci2 = asyncio.run(nl.add_checkin(net["id"], "K6EH/M"))   # mobile suffix
    assert ci2["mobile"] == 1, ci2
    rows = nl.checkins(net["id"])
    assert len(rows) == 2 and rows[0]["checkin"]["callsign"] == "W1AW"
    try:
        asyncio.run(nl.add_checkin(net["id"], "W1AW")); raise SystemExit("dup not caught")
    except DuplicateCheckIn:
        pass
    flagged = nl.toggle_flag(rows[0]["checkin"]["id"], "has_traffic")
    assert flagged["has_traffic"] == 1
    adi, fname = nl.adif(net["id"])
    assert "<CALL:4>W1AW" in adi and fname.endswith(".adi"), adi[:200]
    assert nl.status_dict()["nets"] == 1
    assert nl.operator("W1AW")["operator"]["callsign"] == "W1AW"
    asyncio.run(nl.stop())
    print("PASS: net create + check-in (parse/mobile/dup) + flag + ADIF + operator")
