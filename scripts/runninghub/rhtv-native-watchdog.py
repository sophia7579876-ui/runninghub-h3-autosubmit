#!/usr/bin/env python3
"""Watchdog for the native RunningHub submitter (rhtv-native-runner.mjs + rhtv-native-server.py).

Run every 5 minutes (launchd: scripts/launchd/rhtv-native-launchd.sh install watchdog). It never
touches the page, the queue or the platform; it only decides whether a human should be told, and why:

  server_down     the local server (127.0.0.1:<port>) does not answer          - any time
  wrong_batch     the server answers, but serves another batch                 - any time
  auth_invalid    the runner reports a logged-out session                      - any time
  state_stale     native-state.json not updated for 5 minutes                  - free window only
                  (a live runner saves it every tick, paused or not)

    python3 scripts/runninghub/rhtv-native-watchdog.py --batch <batch_root> [--port 47615]

Alerts are printed and, on macOS, shown as desktop notifications. An unchanged problem is
repeated at most every 30 minutes. Logs stay local; no messaging service is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOCAL_TZ = timezone(timedelta(hours=8))   # the free window is Taipei time, whatever this Mac's zone
WINDOW_START, WINDOW_END = 21, 10
STALE_MIN = 5
REPEAT_MIN = 30
LOG_DIR = Path.home() / "Library" / "Logs" / "rhtv-native-watchdog"


def parse(ts) -> datetime | None:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        out = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return out if out.tzinfo else out.replace(tzinfo=timezone.utc)


def in_window(now: datetime) -> bool:
    hour = now.astimezone(LOCAL_TZ).hour
    return hour >= WINDOW_START or hour < WINDOW_END


def evaluate(*, batch: str, port: int, health: dict | None, health_error: str | None,
             state: dict | None, state_error: str | None, state_mtime: datetime | None,
             now: datetime, stale_min: float = STALE_MIN) -> list[tuple[str, str]]:
    """(key, message) alerts. Pure: everything it looks at is passed in."""
    alerts: list[tuple[str, str]] = []
    if health is None:
        alerts.append(("server_down", f"本机服务 127.0.0.1:{port} 连不上（{health_error}）。成片不会下载，页面程序也拿不到新队列；"
                                      f"检查 launchd：scripts/launchd/rhtv-native-launchd.sh status"))
    elif health.get("batch") and os.path.realpath(health["batch"]) != os.path.realpath(batch):
        alerts.append(("wrong_batch", f"127.0.0.1:{port} 服务的是另一个批次：{health['batch']}（应为 {batch}）"))
    runner = (health or {}).get("runner") or {}
    # The server's view first; the file directly when the server is down.
    status = runner.get("status") if health else (state or {}).get("status")
    auth_since = runner.get("auth_invalid_since") if health else (state or {}).get("auth_invalid_since")
    updated = parse(runner.get("updated_at") if health else (state or {}).get("updated_at")) or state_mtime
    if auth_since or status == "AUTH_INVALID":
        alerts.append(("auth_invalid", "RunningHub 登录失效（auth_invalid），页面程序暂停提交；请在 Chrome 里重新登录 rhtv，"
                                       "登录恢复后它会自动继续"))
    if in_window(now):
        if state_error and not health:
            alerts.append(("state_unreadable", f"读不到 native-state.json：{state_error}"))
        elif updated is None:
            alerts.append(("state_stale", "免费时段内还没有 native-state.json：页面提交程序没有启动"))
        else:
            age = (now - updated).total_seconds() / 60
            if age > stale_min:
                instance = (health or {}).get("instance") or {}
                who = (f"登记的实例 {instance.get('instance_id')} 已 {instance.get('heartbeat_age_s')} 秒无心跳"
                       if instance else "没有登记的实例")
                alerts.append(("state_stale", f"native-state.json 已 {age:.0f} 分钟没有更新（状态 {status}，{who}）："
                                              f"页面程序停了、标签页被关或电脑睡眠"))
    return alerts


def fetch_health(port: int, timeout: float = 5) -> tuple[dict | None, str | None]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.loads(r.read()), None
    except Exception as error:  # noqa: BLE001 - any failure means "cannot reach it"
        return None, str(getattr(error, "reason", error))


def read_state(root: Path) -> tuple[dict | None, str | None, datetime | None]:
    path = root / "native-state.json"
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        return json.loads(path.read_text()), None, mtime
    except FileNotFoundError:
        return None, None, None
    except PermissionError as error:
        return None, f"{error}（launchd 下多半是桌面目录的隐私权限，见 rhtv-native.md）", None
    except (OSError, json.JSONDecodeError) as error:
        return None, str(error), None


def notify(title: str, message: str, config: dict) -> None:
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", f"display notification {json.dumps(message)} with title {json.dumps(title)}"],
                       check=False, capture_output=True)


def run(root: Path, port: int, now: datetime, log_dir: Path = LOG_DIR, send=notify) -> list[dict]:
    health, health_error = fetch_health(port)
    state, state_error, mtime = read_state(root)
    alerts = evaluate(batch=str(root), port=port, health=health, health_error=health_error, state=state,
                      state_error=state_error, state_mtime=mtime, now=now)
    config = {}
    log_dir.mkdir(parents=True, exist_ok=True)
    tag = hashlib.sha256(f"{root}:{port}".encode()).hexdigest()[:10]
    memo_path = log_dir / f"memo-{tag}.json"
    try:
        memo = json.loads(memo_path.read_text())
    except (OSError, json.JSONDecodeError):
        memo = {}
    sent = []
    for key, message in alerts:
        last = parse(memo.get(key))
        if last and now - last < timedelta(minutes=REPEAT_MIN):
            continue
        send(f"RHTV 原生提交 · {root.name}", message, config)
        memo[key] = now.isoformat()
        sent.append({"key": key, "message": message})
    # A problem that went away may alert again at once when it comes back.
    for key in [k for k in memo if k != "last_check" and k not in {a for a, _ in alerts}]:
        memo.pop(key)
    memo["last_check"] = now.isoformat()
    memo_path.write_text(json.dumps(memo, ensure_ascii=False, indent=2) + "\n")
    with (log_dir / "watchdog.log").open("a") as log:
        log.write(json.dumps({"at": now.isoformat(), "batch": str(root), "port": port,
                              "alerts": [k for k, _ in alerts], "sent": sent}, ensure_ascii=False) + "\n")
    return sent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--batch", default=os.environ.get("RHTV_NATIVE_BATCH"), help="批次目录（或环境变量 RHTV_NATIVE_BATCH）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("RHTV_NATIVE_PORT", 47615)))
    args = parser.parse_args()
    if not args.batch:
        parser.error("需要 --batch")
    for item in run(Path(args.batch).expanduser().resolve(), args.port, datetime.now(timezone.utc)):
        print(f"alert {item['key']}: {item['message']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
