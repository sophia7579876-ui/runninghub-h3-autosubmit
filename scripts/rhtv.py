#!/usr/bin/env python3
"""Agent-neutral local commands. Uses Python and Node standard libraries only."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent / "runninghub"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    doctor = commands.add_parser("doctor", help="check environment, scripts and optional batch")
    doctor.add_argument("--batch")
    doctor.add_argument("--port", type=int, default=47615)
    queue = commands.add_parser("queue", help="build an offline first-frame queue")
    queue.add_argument("--source", required=True)
    queue.add_argument("--batch")
    queue.add_argument("--manifest")
    queue.add_argument("--project")
    serve = commands.add_parser("serve", help="run companion server in the foreground")
    serve.add_argument("--batch", required=True)
    serve.add_argument("--port", type=int, default=47615)
    serve.add_argument("--keep-awake", action="store_true")
    for name in ("status", "stop", "snippet"):
        command = commands.add_parser(name)
        command.add_argument("--port", type=int, default=47615)
        if name == "stop":
            command.add_argument("--wait", type=float, default=180)
            command.add_argument("--reason", default="manual stop")
        if name == "snippet":
            command.add_argument("--config", help="local JSON bootstrap options; never contains credentials")
    return result


def main() -> int:
    p = parser()
    args = p.parse_args()
    if hasattr(args, "port") and not 1 <= args.port <= 65535:
        p.error("port must be between 1 and 65535")
    if args.command == "snippet":
        options = {}
        if args.config:
            options = json.loads(Path(args.config).expanduser().read_text(encoding="utf-8"))
            allowed = {"concurrency", "generateNum", "windowHours", "maxAttempts", "calibrate"}
            if not isinstance(options, dict) or set(options) - allowed:
                p.error("config only accepts concurrency, generateNum, windowHours, maxAttempts, calibrate")
        print(f"const src = await (await fetch('http://127.0.0.1:{args.port}/runner.mjs')).text();")
        print("const m = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); ")
        print(f"await m.bootstrap({json.dumps(options, ensure_ascii=False)});")
        return 0
    if args.command == "queue":
        node = shutil.which("node")
        if not node:
            p.error("Node.js 18+ is required to build a directory queue")
        command = [node, str(HERE / "rhtv-generic-queue.mjs")]
        for name in ("source", "batch", "manifest", "project"):
            value = getattr(args, name)
            if value:
                if name in ("source", "batch", "manifest"):
                    value = str(Path(value).expanduser().resolve())
                command += ["--" + name, value]
    else:
        script = "rhtv-native-doctor.py" if args.command == "doctor" else "rhtv-native-server.py"
        command = [sys.executable, str(HERE / script), "--port", str(args.port)]
        if args.command in ("doctor", "serve") and args.batch:
            batch = Path(args.batch).expanduser().resolve()
            if args.command == "serve":
                batch.mkdir(parents=True, exist_ok=True)
            command += ["--batch", str(batch)]
        if args.command == "serve" and args.keep_awake:
            command += ["--keep-awake"]
        if args.command in ("status", "stop"):
            command += ["--" + args.command]
        if args.command == "stop":
            command += ["--wait", str(args.wait), "--reason", args.reason]
    try:
        return subprocess.call(command)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
