"""CLI smoke checks: synthetic options only, no platform or production services."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CLI = Path(__file__).resolve().parents[1] / "rhtv.py"


class CliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(CLI), *args], capture_output=True, text=True)

    def test_snippet_uses_the_requested_port_and_local_options(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({"concurrency": 1, "generateNum": 2}))
            result = self.run_cli("snippet", "--port", "47639", "--config", str(config))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("http://127.0.0.1:47639/runner.mjs", result.stdout)
            self.assertIn('"generateNum": 2', result.stdout)

    def test_snippet_refuses_credentials_or_unknown_options(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({"cookie": "demo"}))
            result = self.run_cli("snippet", "--config", str(config))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("demo", result.stdout)

    def test_invalid_port_is_rejected_without_connecting(self):
        self.assertNotEqual(self.run_cli("status", "--port", "0").returncode, 0)


if __name__ == "__main__":
    unittest.main()
