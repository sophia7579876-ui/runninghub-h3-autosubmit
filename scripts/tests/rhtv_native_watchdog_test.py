"""rhtv-native-watchdog.py: what it alerts on, and when it keeps quiet."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / "runninghub"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wd = load("rhtv_native_watchdog", "rhtv-native-watchdog.py")
server = load("rhtv_native_server_for_watchdog", "rhtv-native-server.py")

NIGHT = datetime(2026, 10, 12, 15, 0, tzinfo=timezone.utc)   # 23:00 Taipei
DAY = datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc)      # 14:00 Taipei


def health(batch="/b", updated=NIGHT, **runner):
    return {"ok": True, "batch": batch, "instance": {"instance_id": "i", "heartbeat_age_s": 400},
            "runner": {"status": "RUNNING", "updated_at": updated.isoformat() if updated else None, **runner}}


def keys(**kw):
    base = dict(batch="/b", port=47615, health=None, health_error=None, state=None, state_error=None,
                state_mtime=None, now=NIGHT)
    return [k for k, _ in wd.evaluate(**{**base, **kw})]


class EvaluateTest(unittest.TestCase):
    def test_a_healthy_night_is_quiet(self):
        self.assertEqual(keys(health=health(updated=NIGHT - timedelta(minutes=1))), [])

    def test_state_not_updated_for_five_minutes_at_night(self):
        self.assertEqual(keys(health=health(updated=NIGHT - timedelta(minutes=6))), ["state_stale"])
        self.assertEqual(keys(health=health(updated=NIGHT - timedelta(minutes=4))), [])

    def test_stale_state_in_the_daytime_is_not_an_alert(self):
        self.assertEqual(keys(health=health(updated=DAY - timedelta(hours=3)), now=DAY), [])

    def test_no_state_at_all_at_night_means_the_runner_never_started(self):
        self.assertEqual(keys(health=health(updated=None)), ["state_stale"])

    def test_server_down_alerts_any_time_and_falls_back_to_the_file(self):
        fresh = {"status": "RUNNING", "updated_at": (DAY - timedelta(minutes=1)).isoformat()}
        self.assertEqual(keys(health_error="refused", state=fresh, now=DAY), ["server_down"])
        old = {"status": "RUNNING", "updated_at": (NIGHT - timedelta(minutes=30)).isoformat()}
        self.assertEqual(keys(health_error="refused", state=old), ["server_down", "state_stale"])

    def test_auth_invalid_alerts_any_time(self):
        self.assertEqual(keys(health=health(updated=DAY, status="AUTH_INVALID"), now=DAY), ["auth_invalid"])
        self.assertEqual(keys(health=health(auth_invalid_since=123)), ["auth_invalid"])
        self.assertEqual(keys(health_error="x", state={"auth_invalid_since": 1, "updated_at": NIGHT.isoformat()}),
                         ["server_down", "auth_invalid"])

    def test_a_server_on_another_batch_is_reported(self):
        self.assertEqual(keys(health=health(batch="/other")), ["wrong_batch"])

    def test_an_unreadable_state_file_is_reported_at_night(self):
        self.assertEqual(keys(health_error="x", state_error="Operation not permitted"), ["server_down", "state_unreadable"])


class RunTest(unittest.TestCase):
    """Against a real server on a free port, with notifications captured."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "batch"
        self.root.mkdir()
        self.logs = Path(self.tmp.name) / "logs"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.handler(server.Batch(self.root), 0))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.sent = []

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def run_at(self, now, port=None):
        return wd.run(self.root, port or self.port, now, log_dir=self.logs, send=lambda *a: self.sent.append(a))

    def test_alerts_are_sent_once_per_half_hour_and_logged(self):
        now = datetime.now(timezone.utc)
        night = now if wd.in_window(now) else now + timedelta(hours=12)  # whichever lies in the window
        def check(minutes):  # the runner keeps saving its state while logged out
            at = night + timedelta(minutes=minutes)
            (self.root / "native-state.json").write_text(json.dumps(
                {"status": "AUTH_INVALID", "auth_invalid_since": 1, "updated_at": at.isoformat(), "jobs": {}}))
            return [s["key"] for s in self.run_at(at)]
        self.assertEqual(check(0), ["auth_invalid"])
        self.assertEqual(check(10), [], "30 分钟内不重复")
        self.assertEqual(check(31), ["auth_invalid"])
        self.assertEqual(len(self.sent), 2)
        lines = (self.logs / "watchdog.log").read_text().splitlines()
        self.assertEqual(len(lines), 3)

    def test_a_dead_port_is_server_down(self):
        sent = self.run_at(DAY, port=1)
        self.assertEqual([s["key"] for s in sent], ["server_down"])


if __name__ == "__main__":
    unittest.main()
