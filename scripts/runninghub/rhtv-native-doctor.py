#!/usr/bin/env python3
"""Self-check for running the RunningHub native submitter on a (new) computer.

    python3 scripts/runninghub/rhtv-native-doctor.py [--batch <batch_root>] [--port 47615]

Checks what can be checked without touching the account: Python and Node versions, that the needed
scripts are present, whether the port is free or already served by this submitter, and - with
--batch - that the queue is readable and every pending image (first / last frame, references) exists
with its recorded hash.
Prints the browser start snippet for the chosen port. Exit code 0 means nothing blocking was found.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEEDED = ["rhtv-native-runner.mjs", "rhtv-native-server.py", "rhtv-generic-queue.mjs",
          "rhtv-queue-common.mjs"]
problems: list[str] = []
# settings.mode -> the images that mode needs; mirrors job_materials() in rhtv-native-server.py.
MODE_KEYS = {"首帧": "first", "首尾帧": "first_last", "全能参考": "reference", "文生视频": "text"}


def job_materials(job: dict) -> list[tuple[str, dict | None]]:
    mode = MODE_KEYS.get((job.get("settings") or {}).get("mode"), "first")
    if mode == "text":
        return []
    out = [("首帧", job.get("first_frame"))] if mode in ("first", "first_last") else []
    if mode == "first_last":
        out.append(("尾帧", job.get("last_frame")))
    if mode == "reference":
        refs = job.get("reference_images") or []
        out += [(f"第 {i} 张参考图", r) for i, r in enumerate(refs, 1)] or [("参考图", None)]
    return out


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def bad(msg: str, fix: str) -> None:
    problems.append(msg)
    print(f"  ✗ {msg}\n      → {fix}")


def note(msg: str) -> None:
    print(f"  · {msg}")


def check_runtime() -> None:
    print("运行环境")
    if sys.version_info >= (3, 10):
        ok(f"Python {sys.version.split()[0]}")
    else:
        bad(f"Python {sys.version.split()[0]} 太旧", "安装 Python 3.10 或更高版本")
    node = shutil.which("node")
    if not node:
        bad("找不到 node", "安装 Node.js 18 或更高版本（生成队列需要）")
        return
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    major = int(version.lstrip("v").split(".")[0] or 0)
    if major >= 18:
        ok(f"Node {version}")
    else:
        bad(f"Node {version} 太旧", "安装 Node.js 18 或更高版本")


def check_scripts() -> None:
    print("脚本文件")
    missing = [n for n in NEEDED if not (HERE / n).resolve().exists()]
    if missing:
        bad("缺少脚本：" + "、".join(missing), "重新克隆仓库，或 git pull 到最新的 main")
    else:
        ok(f"提交器所需的 {len(NEEDED)} 个脚本齐全")


def check_port(port: int) -> dict | None:
    print(f"端口 {port}")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            health = json.load(r)
        ok(f"本机服务已在运行，批次：{health.get('batch')}")
        return health
    except Exception:
        pass
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            bad(f"端口 {port} 被别的程序占用", f"换一个端口，例如 --port {port + 1}")
        else:
            ok("端口空闲，可以启动本机服务")
    return None


def check_batch(root: Path) -> None:
    print(f"批次 {root}")
    queue = root / "formal-video-queue.json"
    if not queue.exists():
        bad("没有 formal-video-queue.json", "先运行 rhtv-generic-queue.mjs 生成队列，或用 /enqueue 投递（服务会自动建空队列）")
        return
    jobs = json.loads(queue.read_text()).get("jobs", [])
    intake_file = root / "intake-queue.json"
    if intake_file.exists():
        jobs += json.loads(intake_file.read_text()).get("jobs", [])
    state_file = root / "native-state.json"
    state = json.loads(state_file.read_text()).get("jobs", {}) if state_file.exists() else {}
    pending = [j for j in jobs if state.get(j.get("shot_id"), {}).get("status") in (None, "PENDING", "RUNNING")]
    done = sum(1 for j in state.values() if j.get("status") == "COMPLETED")
    ok(f"队列 {len(jobs)} 条，已完成 {done}，待提交 {len(pending)}")
    missing, changed = [], []
    for j in pending:
        # Each mode needs its own images: 首帧 one, 首尾帧 two, 全能参考 every reference, 文生视频 none.
        for label, frame in job_materials(j):
            if not frame:
                missing.append(f"{j['shot_id']}: 队列里没有{label}")
                continue
            rel = frame.get("rel_path")
            path = root / rel if rel and not os.path.isabs(rel) and ".." not in Path(rel).parts else Path(frame.get("path", ""))
            if not path.is_file():
                missing.append(f"{j['shot_id']} {label}: {path}")
            elif frame.get("sha256") and hashlib.sha256(path.read_bytes()).hexdigest() != frame["sha256"]:
                changed.append(f"{j['shot_id']} {label}")
    if missing:
        bad(f"{len(missing)} 张待提交素材找不到（例：{missing[0]}）",
            "队列里记的是生成队列那台电脑上的绝对路径；把素材放到这台电脑后，重新运行 rhtv-generic-queue.mjs")
    if changed:
        bad(f"{len(changed)} 张素材内容与队列记录不一致（例：{changed[0]}）", "图片被改过；确认无误后重新生成队列")
    if not missing and not changed:
        ok("所有待提交任务的素材（首帧 / 尾帧 / 参考图）都在，内容与记录一致")
    inbox = root / "inbox"
    if inbox.exists() and not os.access(inbox, os.W_OK):
        bad("inbox/ 不可写", "检查目录权限")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--batch", help="批次目录（含 formal-video-queue.json）")
    parser.add_argument("--port", type=int, default=47615)
    args = parser.parse_args()
    check_runtime()
    check_scripts()
    health = check_port(args.port)
    if args.batch:
        check_batch(Path(args.batch).expanduser().resolve())
    elif health and health.get("batch"):
        check_batch(Path(health["batch"]))
    print("手动确认（无法自动检查）")
    note("Chrome 已登录有会员免费权益的账号，并打开一个 rhtv 画布页（/project/canvas/<id>）")
    note("Chrome 设置 → 性能 → 「始终让这些网站保持活动状态」里有 rhtv.runninghub.cn")
    note("同一个账号同一时间只在一台电脑上提交")
    print(f"\n浏览器启动代码（在画布页的开发者工具控制台执行）：\n"
          f"  const src = await (await fetch('http://127.0.0.1:{args.port}/runner.mjs')).text();\n"
          f"  const m = await import(URL.createObjectURL(new Blob([src], {{ type: 'text/javascript' }})));\n"
          f"  await m.bootstrap();")
    print("\n结论：" + ("没有发现阻塞问题" if not problems else f"有 {len(problems)} 个问题需要先处理"))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
