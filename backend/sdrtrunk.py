"""
sdrtrunk.py - SDRTrunk trunked-DMR (Connect Plus) monitor as an SDR mode.

SDRTrunk is a Java app that claims the RTL-SDR over libusb directly (not via
rtl_tcp), so it owns device 0 the same way SatDump does in meteor.py. We don't
spawn the JVM ourselves — it runs as the `sdrtrunk` systemd *user* service
(headless GUI on DISPLAY=:0). This mode just starts/stops that service so the
dashboard is the single arbiter of the one dongle: no auto-start on boot, no
3-second rtl_tcp war.

Status/decodes come from two files SDRTrunk writes under its app dir:
  logs/sdrtrunk_app.log  → tuner-lock state (channelizer up vs "in-use" error)
  event_logs/*call_events*.csv → decoded call events (incl. encryption flag)
"""

import asyncio
import csv
import glob
import logging
import os
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

StatusCb = Callable[[dict], Awaitable[None]]
EventCb  = Callable[[dict], Awaitable[None]]

# app-log substrings — last match wins for lock state
_LOCK_OK  = "providing ["          # ComplexPolyphaseChannelizer: tuner streaming
_LOCK_BAD = "in-use by another"    # USBTunerController: tuner busy

# The dashboard backend may run without a session env; systemctl --user needs
# the user bus address to reach the per-user systemd instance (lingering is on).
_ENV = {**os.environ,
        "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"}


def _is_encrypted(row: dict) -> bool:
    return any("encrypt" in str(v).lower() for v in row.values())


class TrunkMonitor:
    def __init__(
        self,
        app_dir: str,
        service: str = "sdrtrunk",
        site: str = "Site 004",
        control_freq: int = 454_031_250,
        vnc_url: str = "",
        status_callback: Optional[StatusCb] = None,
        event_callback: Optional[EventCb] = None,
    ):
        self.app_dir      = app_dir
        self.service      = service
        self.site         = site
        self.control_freq = control_freq
        self.vnc_url      = vnc_url
        self._status_cb   = status_callback
        self._event_cb    = event_callback

        self.running        = False
        self.tuner_locked   = False
        self.encrypted_seen = False
        self._recent: list[dict] = []      # last N call events
        self._csv_path  = ""
        self._csv_rows  = 0                # data rows already consumed
        self._poll_task: Optional[asyncio.Task] = None

    async def _systemctl(self, action: str) -> None:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "--user", action, self.service,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            env=_ENV,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"systemctl {action} {self.service}: "
                               f"{err.decode('utf-8', 'replace').strip()}")

    async def _is_active(self) -> bool:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "--user", "is-active", self.service,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env=_ENV,
        )
        out, _ = await proc.communicate()
        return out.decode().strip() == "active"

    async def start(self) -> None:
        await self._systemctl("start")
        # Baseline: skip call events already in the newest CSV so we only emit
        # calls decoded during this session.
        self._latest_csv(seek_end=True)
        self.running = True
        self._poll_task = asyncio.create_task(self._poll_loop(), name="trunk-poll")
        logger.info("TrunkMonitor started — service=%s site=%s", self.service, self.site)

    async def stop(self) -> None:
        self.running = False
        if self._poll_task is not None:
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
            self._poll_task = None
        try:
            await self._systemctl("stop")
        except Exception:
            logger.exception("TrunkMonitor: service stop failed")
        logger.info("TrunkMonitor stopped")

    def status_dict(self) -> dict:
        return {
            "type":          "status",
            "running":       self.running,
            "tuner_locked":  self.tuner_locked,
            "site":          self.site,
            "control_freq":  self.control_freq,
            "encrypted_seen": self.encrypted_seen,
            "vnc_url":       self.vnc_url,
            "recent":        self._recent[-30:],
        }

    # ------------------------------------------------------------------

    def _read_lock_state(self) -> bool:
        path = os.path.join(self.app_dir, "logs", "sdrtrunk_app.log")
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 8192))
                tail = f.read().decode("utf-8", "replace")
        except OSError:
            return False
        ok = tail.rfind(_LOCK_OK)
        bad = tail.rfind(_LOCK_BAD)
        return ok > bad

    def _latest_csv(self, seek_end: bool = False) -> None:
        # SDRTrunk v0.6.1 writes CSV-formatted files with a .log extension.
        pattern = os.path.join(self.app_dir, "event_logs", "*call_events*.log")
        files = sorted(glob.glob(pattern), key=os.path.getmtime)
        if not files:
            return
        newest = files[-1]
        if newest != self._csv_path:
            self._csv_path = newest
            self._csv_rows = 0
        if seek_end:
            self._csv_rows = self._count_rows(newest)

    @staticmethod
    def _count_rows(path: str) -> int:
        try:
            with open(path, "r", newline="") as f:
                return max(0, sum(1 for _ in csv.reader(f)) - 1)  # minus header
        except OSError:
            return 0

    async def _drain_csv(self) -> None:
        self._latest_csv()
        if not self._csv_path:
            return
        try:
            with open(self._csv_path, "r", newline="") as f:
                rows = list(csv.reader(f))
        except OSError:
            return
        if len(rows) < 2:
            return
        header, data = rows[0], rows[1:]
        for cols in data[self._csv_rows:]:
            if not cols or len(cols) < len(header):
                continue
            row = dict(zip(header, cols))
            enc = _is_encrypted(row)
            self.encrypted_seen = self.encrypted_seen or enc
            row["_encrypted"] = enc
            self._recent.append(row)
            if len(self._recent) > 200:
                self._recent = self._recent[-100:]
            if self._event_cb:
                await self._event_cb({"type": "call", **row})
        self._csv_rows = len(data)

    async def _poll_loop(self) -> None:
        try:
            while self.running:
                self.running = await self._is_active()
                self.tuner_locked = self.running and self._read_lock_state()
                await self._drain_csv()
                if self._status_cb:
                    await self._status_cb(self.status_dict())
                await asyncio.sleep(2.0)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("TrunkMonitor poll loop error")


if __name__ == "__main__":
    import tempfile
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "event_logs"))
    csv_path = os.path.join(d, "event_logs", "20260705_Control_call_events.log")
    with open(csv_path, "w") as f:
        f.write("TIMESTAMP,PROTOCOL,EVENT,FROM,TO,DETAILS\n")
        f.write("19:20:01,DMR,CALL,1234567,9001,Voice Grant\n")
        f.write("19:20:05,DMR,CALL,7654321,9002,ENCRYPTED Voice\n")

    async def _t():
        seen = []
        async def cb(e):
            seen.append(e)
        tm = TrunkMonitor(d, event_callback=cb)
        await tm._drain_csv()
        assert len(seen) == 2, seen
        assert tm.encrypted_seen is True
        assert seen[0]["_encrypted"] is False and seen[1]["_encrypted"] is True
        await tm._drain_csv()                 # idempotent: no new rows
        assert len(seen) == 2, seen
        # baseline skip: a fresh monitor seeking to end emits nothing
        tm2 = TrunkMonitor(d, event_callback=cb)
        tm2._latest_csv(seek_end=True)
        await tm2._drain_csv()
        assert len(seen) == 2, seen
        print("PASS: csv drain + encryption flag + row tracking + baseline skip")

    asyncio.run(_t())
