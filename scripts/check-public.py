#!/usr/bin/env python3
"""Audit the exact staged Git snapshot before publishing. Prints no matched secret values."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = {
    ".gitignore", "README.md", "AGENTS.md", "CLAUDE.md", "config.example.json",
    "docs/deploy.md", "docs/inputs.md", "docs/sharing.md",
    "examples/rhtv-manifest.example.json",
    "scripts/check-public.py", "scripts/rhtv.py",
    "scripts/launchd/rhtv-native-launchd.sh",
    "scripts/runninghub/rhtv-native-runner.mjs",
    "scripts/runninghub/rhtv-native-server.py",
    "scripts/runninghub/rhtv-native-watchdog.py",
    "scripts/runninghub/rhtv-native-doctor.py",
    "scripts/runninghub/rhtv-generic-queue.mjs",
    "scripts/runninghub/rhtv-queue-common.mjs",
    "scripts/tests/rhtv-native-runner.test.mjs",
    "scripts/tests/rhtv-generic-queue.test.mjs",
    "scripts/tests/rhtv_cli_test.py",
    "scripts/tests/rhtv_native_server_test.py",
    "scripts/tests/rhtv_native_watchdog_test.py",
    "scripts/tests/rhtv_native_launchd_test.py",
}
PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "api-key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b"),
    "credential-literal": re.compile(r'''(?i)(?:api[_-]?key|authorization|cookie|secret|password)\s*[:=]\s*['"][^'"\n]{16,}['"]'''),
    "personal-home": re.compile(r"(?:/Users/|/home/)[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\"),
    "private-platform-id": re.compile(r"/(?:project/canvas|canvas/task)/[0-9]{12,}"),
    "signed-url": re.compile(r"https?://[^\s'\"<>]+[?&](?:token|signature|x-amz-signature|access_token)=[^\s'\"<>]+", re.I),
}


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main() -> int:
    try:
        entries = git("ls-files", "--stage", "-z").split(b"\0")
    except subprocess.CalledProcessError:
        print("Initialize Git and stage the explicit source files before running this audit.")
        return 1
    failures = []
    count = total = 0
    for entry in filter(None, entries):
        meta, raw_path = entry.split(b"\t", 1)
        mode, oid, stage = meta.split()
        name = raw_path.decode("utf-8")
        count += 1
        if name not in PUBLIC_FILES:
            failures.append((name, "not in public file allowlist"))
            continue
        if mode not in (b"100644", b"100755") or stage != b"0":
            failures.append((name, "not a regular, resolved source file"))
            continue
        data = git("cat-file", "blob", oid.decode("ascii"))
        total += len(data)
        if len(data) > 128 * 1024 or b"\0" in data:
            failures.append((name, "oversized or binary content"))
            continue
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            failures.append((name, "not UTF-8 text"))
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(content):
                failures.append((name, label))
    if not count:
        failures.append(("index", "no staged source files"))
    for name, reason in failures:
        print(f"REJECT {name}: {reason}")
    if failures:
        return 1
    print(f"Public snapshot check passed: {count} text files, {total / 1024:.1f} KiB.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
