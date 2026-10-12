"""scripts/launchd/rhtv-native-launchd.sh render: valid plists with the configured paths. Installs nothing."""
from __future__ import annotations

import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "launchd" / "rhtv-native-launchd.sh"


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "HOME": self.tmp.name}

    def render(self, *args, check=True):
        r = subprocess.run(["bash", str(SCRIPT), "render", *args], capture_output=True, text=True, env=self.env)
        if check:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def test_server_plist_keeps_the_server_alive_with_the_given_batch_port_and_python(self):
        out = self.render("server", "--batch", "/x/My Batch & Co", "--port", "47635", "--python", "/opt/py/bin/python3",
                          "--repo", "/r").stdout
        p = plistlib.loads(out.encode())
        self.assertEqual(p["Label"], "io.runninghub-h3-autosubmit.native-server.47635")
        self.assertEqual(p["ProgramArguments"], ["/opt/py/bin/python3", "/r/scripts/runninghub/rhtv-native-server.py",
                                                 "--batch", "/x/My Batch & Co", "--port", "47635", "--keep-awake"])
        self.assertIs(p["RunAtLoad"], True)
        self.assertIs(p["KeepAlive"], True)
        self.assertTrue(p["StandardErrorPath"].startswith(self.tmp.name + "/Library/Logs/"))
        path = Path(self.tmp.name) / "s.plist"
        path.write_text(out)
        self.assertEqual(subprocess.run(["plutil", "-lint", str(path)], capture_output=True).returncode, 0)

    def test_keep_awake_can_be_turned_off(self):
        p = plistlib.loads(self.render("server", "--batch", "/b", "--python", "/p", "--no-keep-awake").stdout.encode())
        self.assertNotIn("--keep-awake", p["ProgramArguments"])
        self.assertEqual(p["ProgramArguments"][1], str(SCRIPT.parents[1] / "runninghub" / "rhtv-native-server.py"))

    def test_watchdog_plist_runs_every_five_minutes(self):
        p = plistlib.loads(self.render("watchdog", "--batch", "/b", "--python", "/p").stdout.encode())
        self.assertEqual(p["Label"], "io.runninghub-h3-autosubmit.native-watchdog.47615")
        self.assertEqual(p["StartInterval"], 300)
        self.assertNotIn("KeepAlive", p)
        self.assertIn("rhtv-native-watchdog.py", p["ProgramArguments"][1])

    def test_bad_input_is_refused(self):
        self.assertNotEqual(self.render("server", "--python", "/p", check=False).returncode, 0, "没有 --batch")
        self.assertNotEqual(self.render("server", "--batch", "rel/path", "--python", "/p", check=False).returncode, 0)
        self.assertNotEqual(self.render("server", "--batch", "/b", "--port", "x", check=False).returncode, 0)
        self.assertNotEqual(subprocess.run(["bash", str(SCRIPT), "render", "nope"], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
