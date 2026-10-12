#!/usr/bin/env python3
"""Local companion for rhtv-native-runner.mjs.

The submitter runs inside the logged-in rhtv page and cannot read local files, so this
server hands it the queue and the first-frame images, keeps its progress on disk (a page
reload resumes from it), and downloads finished videos.

    python3 scripts/runninghub/rhtv-native-server.py --batch <batch_root> [--port 47615]

<batch_root> is the output of rhtv-generic-queue.mjs (it holds formal-video-queue.json).
Only the loopback interface is bound, and only the rhtv origin may read it.

Other local services deliver material in either of two ways; both land in the same queue:

  POST /enqueue        JSON {shot_id, prompt, image_path | image_base64, ratio?, duration?, resolution?, priority?}
                       mode "first_last": also last_image_path | last_image_base64 (首尾帧)
                       mode "reference":  images [path | {path} | {base64}, ...] instead of image_* (全能参考)
                       mode "text":       no image at all (文生视频)
  GET  /frame/<id>[/last | /ref/<n>]   the first frame, the last frame, or the n-th (1-based) reference
  GET  /status/<id>    queued / running / completed (+ video path) / failed
  <batch_root>/inbox/  drop <name>.json (same fields; "image" may name a file next to it);
                       processed files move to inbox/done/ or inbox/failed/ (+ .error.txt)

One runner per batch: a runner registers on start and heartbeats every tick; while one is alive
(heartbeat within INSTANCE_TTL) a second bootstrap is refused. Stop it from a shell:

    python3 scripts/runninghub/rhtv-native-server.py --stop [--port 47615] [--wait 180]
    python3 scripts/runninghub/rhtv-native-server.py --status [--port 47615]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import re
import shutil
import subprocess
import sys
import time
import json
import os
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ORIGIN = "https://rhtv.runninghub.cn"
RATIOS = ("16:9", "9:16", "1:1", "4:3", "3:4")
DEFAULT_SETTINGS = {"model": "Minimax H3 RH Enhanced", "duration_seconds": 15, "resolution": "768p",
                    "ratio": "16:9", "mode": "首帧", "quantity": 1, "required_fee": 0}
MAX_IMAGE_BYTES = 25 * 1024 * 1024
# 全能参考: how many reference images one shot may carry. The site reads the real cap from the model's
# config (maxNum of its imageUrls parameter); the runner checks that too and refuses, never truncates.
MAX_REFERENCE_IMAGES = 9
# Delivery mode -> settings.mode, the name the runner and the queue files use.
MODES = {None: "首帧", "first": "首帧", "first_last": "首尾帧", "reference": "全能参考", "text": "文生视频"}
SETTINGS_MODE_KEYS = {v: k for k, v in MODES.items() if k}
SHOT_ID = re.compile(r"^[\w.\-]{1,120}$")
STATUS = {"PENDING": "queued", "SUBMITTING": "running", "RUNNING": "running", "COMPLETED": "completed", "FAILED": "failed"}
RUNNER = Path(__file__).with_name("rhtv-native-runner.mjs")
# The served runner learns its own build from this line, so a running page reports what it runs.
RUNNER_BUILD_LINE = b"export const RUNNER_BUILD = { sha256: null, git: null };"
LOCK = threading.Lock()
# A hidden tab may tick only once a minute; five quiet minutes means the runner is gone.
INSTANCE_TTL = 300
MAX_DOWNLOAD_FAILURES = 3


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Rejected(ValueError):
    """A delivery that cannot be queued; the message is returned to the sender."""


def image_kind(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    raise Rejected("图片必须是 PNG / JPEG / WEBP")


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def git_commit(where: Path) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(where), "rev-parse", "--short=12", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def runner_build() -> dict:
    """What the served runner is: the hash of the file on disk and the commit it was checked out at."""
    return {"sha256": hashlib.sha256(RUNNER.read_bytes()).hexdigest()[:16], "git": git_commit(RUNNER.parent)}


class Batch:
    def __init__(self, root: Path):
        self.root = root
        self.queue_file = root / "formal-video-queue.json"
        self.state_file = root / "native-state.json"
        self.events_file = root / "native-events.jsonl"
        self.videos = root / "videos"
        self.intake_file = root / "intake-queue.json"
        self.intake_frames = root / "intake" / "frames"
        self.inbox = root / "inbox"
        self.instance_file = root / "native-instance.json"
        self.clock = time.time
        self.started_at = now()
        self._fetching: set[Path] = set()
        self._fetch_failures: dict[Path, int] = {}
        if not self.queue_file.exists():
            # A batch fed only through /enqueue or the inbox starts with an empty main queue.
            write_json(self.queue_file, {"schema_version": "rhtv-generic-queue/v1", "jobs": []})

    def formal_jobs(self) -> list[dict]:
        return json.loads(self.queue_file.read_text()).get("jobs", [])

    def intake_jobs(self) -> list[dict]:
        return json.loads(self.intake_file.read_text()).get("jobs", []) if self.intake_file.exists() else []

    def jobs(self) -> list[dict]:
        return self.formal_jobs() + self.intake_jobs()

    def frame_path(self, job: dict, frame: dict | None = None) -> Path:
        frame = (job.get("first_frame") or {}) if frame is None else frame
        rel = frame.get("rel_path")
        path = (self.root / rel) if rel and not os.path.isabs(rel) and ".." not in Path(rel).parts else Path(frame.get("path", ""))
        return path

    def queue_payload(self) -> dict:
        # The runner submits in this order: urgent deliveries, then the main queue, then the rest.
        intake = self.intake_jobs()
        ordered = ([j for j in intake if j.get("priority") == "high"] + self.formal_jobs()
                   + [j for j in intake if j.get("priority") != "high"])
        out = []
        for job in ordered:
            if job.get("status") != "READY_FOR_PRODUCTION":
                continue
            item = {"shot_id": job["shot_id"], "prompt": job.get("prepared_prompt") or job.get("prompt"),
                    "settings": job.get("settings") or {}}
            if job_mode(job) == "reference":
                item["reference_count"] = len(job.get("reference_images") or [])
            out.append(item)
        return {"jobs": out}

    def frame(self, shot_id: str, which: str = "first") -> tuple[bytes, str]:
        """which: "first", "last" or "ref/<n>" (1-based)."""
        job = next((j for j in self.jobs() if j.get("shot_id") == shot_id), None)
        if not job:
            raise FileNotFoundError(shot_id)
        if which == "first":
            frame, label = job.get("first_frame"), "首帧"
        elif which == "last":
            frame, label = job.get("last_frame"), "尾帧"
        elif re.fullmatch(r"ref/[1-9]\d*", which):
            n = int(which[4:])
            refs = job.get("reference_images") or []
            frame, label = (refs[n - 1] if n <= len(refs) else None), f"第 {n} 张参考图"
        else:
            raise FileNotFoundError(f"{shot_id}/{which}")
        if not frame:
            raise FileNotFoundError(f"{shot_id} 没有{label}")
        path = self.frame_path(job, frame)
        data = path.read_bytes()
        expected = frame.get("sha256")
        # The queue binds each frame to its bytes; a swapped image must not be submitted silently.
        if expected and hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"{shot_id} {label}内容与队列记录不一致")
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(path.suffix.lower(), "application/octet-stream")
        return data, mime

    # ---- delivery -----------------------------------------------------------------------------
    def enqueue(self, spec: dict, base_dir: Path | None = None) -> dict:
        """Validate one delivery, copy its image into the batch and append it to the intake queue."""
        if not isinstance(spec, dict):
            raise Rejected("请求体必须是 JSON 对象")
        shot_id = str(spec.get("shot_id") or "").strip()
        if not SHOT_ID.match(shot_id):
            raise Rejected("shot_id 只能包含字母、数字、下划线、点和横线，最长 120 个字符")
        prompt = spec.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise Rejected("prompt 不能为空")
        prompt = prompt.replace("\r\n", "\n").strip()
        # Every mode is asked for by name and must bring exactly its own material: a forgotten image is
        # an error, never a switch to another mode, and nothing is dropped to make a delivery fit.
        mode = spec.get("mode")
        if mode not in MODES:
            raise Rejected("mode 只能是 first（默认）、first_last、reference 或 text")
        mode = mode or "first"
        has_first = bool(spec.get("image_path") or spec.get("image_base64") or spec.get("image"))
        has_last = bool(spec.get("last_image_path") or spec.get("last_image_base64") or spec.get("last_image"))
        has_refs = spec.get("images") is not None
        if mode == "text" and (has_first or has_last or has_refs):
            raise Rejected("mode=text 不能同时带首帧图片")
        if mode != "first_last" and has_last:
            raise Rejected("只有 mode=first_last 才能带尾帧（last_image_*）")
        if mode != "reference" and has_refs:
            raise Rejected("只有 mode=reference 才能带参考图列表 images")
        if mode == "reference" and has_first:
            raise Rejected("mode=reference 的图片全部放在 images 里，不要再给 image_path / image_base64")
        materials: list[tuple[str, bytes]] = []  # (role, bytes); role: first / last / ref
        if mode in ("first", "first_last"):
            materials.append(("first", self._image_bytes(spec, base_dir)))
        if mode == "first_last":
            if not has_last:
                raise Rejected("mode=first_last 需要尾帧：last_image_path 或 last_image_base64")
            materials.append(("last", self._image_bytes(spec, base_dir, prefix="last_image")))
        if mode == "reference":
            refs = spec.get("images")
            if not isinstance(refs, list) or not refs:
                raise Rejected("mode=reference 需要 images：至少 1 张参考图")
            if len(refs) > MAX_REFERENCE_IMAGES:
                raise Rejected(f"参考图最多 {MAX_REFERENCE_IMAGES} 张，收到 {len(refs)} 张")
            for i, ref in enumerate(refs, 1):
                materials.append(("ref", self._reference_bytes(ref, i, base_dir)))
        kinds = [(role, data, image_kind(data), hashlib.sha256(data).hexdigest()) for role, data in materials]
        digests = [d for _, _, _, d in kinds]
        settings = self._settings(spec)
        settings["mode"] = MODES[mode]
        priority = spec.get("priority", "normal")
        if priority not in ("high", "normal"):
            raise Rejected("priority 只能是 high 或 normal")
        with LOCK:
            existing = next((j for j in self.jobs() if j.get("shot_id") == shot_id), None)
            if existing:
                same = (material_digests(existing) == digests
                        and (existing.get("prepared_prompt") or existing.get("prompt")) == prompt
                        and (existing.get("settings") or {}) == settings)
                if not same:
                    raise Rejected(f"shot_id {shot_id} 已存在且内容不同；换一个 shot_id 再投递")
                return {"ok": True, "duplicate": True, **self.status(shot_id)}
            stored: dict[str, list[dict]] = {"first": [], "last": [], "ref": []}
            if kinds:
                self.intake_frames.mkdir(parents=True, exist_ok=True)
            for role, data, kind, digest in kinds:
                suffix = {"first": "", "last": ".last"}.get(role, f".ref{len(stored['ref']) + 1}")
                frame = self.intake_frames / f"{shot_id}{suffix}{kind}"
                frame.write_bytes(data)
                stored[role].append({"rel_path": str(frame.relative_to(self.root)), "sha256": digest})
            job = {"shot_id": shot_id, "job_id": shot_id, "status": "READY_FOR_PRODUCTION", "priority": priority,
                   "settings": settings, "prepared_prompt": prompt,
                   "prepared_prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                   "first_frame": (stored["first"] or [None])[0],
                   **({"last_frame": stored["last"][0]} if stored["last"] else {}),
                   **({"reference_images": stored["ref"]} if stored["ref"] else {}),
                   "source": str(spec.get("source") or "enqueue")[:200], "received_at": now(),
                   "review_policy": "auto_release"}
            intake = self.intake_jobs() + [job]
            write_json(self.intake_file, {"schema_version": "rhtv-intake-queue/v1", "jobs": intake})
        self.event({"at": now(), "type": "enqueued", "shot_id": shot_id, "priority": priority, "source": job["source"]})
        return {"ok": True, "duplicate": False, **self.status(shot_id)}

    def _image_bytes(self, spec: dict, base_dir: Path | None, prefix: str = "image") -> bytes:
        if spec.get(f"{prefix}_base64"):
            try:
                data = base64.b64decode(spec[f"{prefix}_base64"], validate=True)
            except Exception as error:  # noqa: BLE001
                raise Rejected(f"{prefix}_base64 无法解码：{error}") from None
        else:
            raw = spec.get(f"{prefix}_path") or spec.get(prefix)
            if not raw:
                raise Rejected(f"需要 {prefix}_path 或 {prefix}_base64")
            data = self._read_image(raw, base_dir, f"{prefix}_path")
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise Rejected("图片为空或超过 25 MB")
        return data

    def _reference_bytes(self, ref, index: int, base_dir: Path | None) -> bytes:
        """One entry of images[]: a path string, {"path": ...} or {"base64": ...}."""
        if isinstance(ref, str):
            ref = {"path": ref}
        if not isinstance(ref, dict) or not (ref.get("path") or ref.get("base64")):
            raise Rejected(f"images 第 {index} 项必须是图片路径，或 {{\"path\": ...}} / {{\"base64\": ...}}")
        if ref.get("base64"):
            try:
                data = base64.b64decode(ref["base64"], validate=True)
            except Exception as error:  # noqa: BLE001
                raise Rejected(f"images 第 {index} 项 base64 无法解码：{error}") from None
        else:
            data = self._read_image(ref["path"], base_dir, f"images 第 {index} 项")
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise Rejected(f"images 第 {index} 项图片为空或超过 25 MB")
        return data

    @staticmethod
    def _read_image(raw: str, base_dir: Path | None, label: str) -> bytes:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            if base_dir is None:
                raise Rejected(f"{label} 必须是绝对路径")
            path = base_dir / path
        try:
            return path.read_bytes()
        except OSError as error:
            raise Rejected(f"读不到图片 {path}：{error.strerror}") from None

    @staticmethod
    def _settings(spec: dict) -> dict:
        settings = dict(DEFAULT_SETTINGS)
        if spec.get("ratio") is not None:
            if spec["ratio"] not in RATIOS:
                raise Rejected(f"ratio 只能是 {', '.join(RATIOS)}")
            settings["ratio"] = spec["ratio"]
        duration = spec.get("duration", spec.get("duration_seconds"))
        if duration is not None:
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or int(duration) != duration or not 1 <= duration <= 15:
                raise Rejected("duration 必须是 1–15 的整数秒")
            settings["duration_seconds"] = int(duration)
        if spec.get("resolution") is not None:
            if not re.fullmatch(r"\d{3,4}p", str(spec["resolution"])):
                raise Rejected("resolution 格式应为 768p 这样")
            settings["resolution"] = str(spec["resolution"])
        return settings

    def status(self, shot_id: str) -> dict:
        state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        job = (state.get("jobs") or {}).get(shot_id)
        queued = any(j.get("shot_id") == shot_id for j in self.jobs())
        if not job and not queued:
            raise FileNotFoundError(shot_id)
        status = STATUS.get((job or {}).get("status"), "queued")
        out = {"shot_id": shot_id, "status": status}
        if job:
            out.update({k: job[k] for k in ("task_id", "submitted_at", "completed_at", "attempts") if job.get(k) is not None})
            if status == "failed":
                out["error"] = job.get("last_error")
            if status == "completed":
                video = self.videos / f"{shot_id}.mp4"
                out["video_path"] = str(video) if video.exists() else None
                out["video_urls"] = job.get("outputs") or []
        return out

    def scan_inbox(self, settle_seconds: float = 3.0) -> list[dict]:
        """Ingest every settled <name>.json in the inbox; move it (and its image) to done/ or failed/."""
        self.inbox.mkdir(parents=True, exist_ok=True)
        results = []
        for spec_file in sorted(self.inbox.glob("*.json")):
            if time.time() - spec_file.stat().st_mtime < settle_seconds:
                continue  # still being written
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            moved = [spec_file]
            try:
                spec = json.loads(spec_file.read_text(encoding="utf-8"))
                for image in inbox_images(spec):
                    if not Path(image).is_absolute():
                        moved.append(self.inbox / image)
                result = self.enqueue(spec, base_dir=self.inbox)
                target, note = self.inbox / "done", None
            except (Rejected, json.JSONDecodeError, UnicodeDecodeError) as error:
                result, target, note = {"ok": False, "error": str(error)}, self.inbox / "failed", str(error)
            target.mkdir(parents=True, exist_ok=True)
            for f in moved:
                if f.exists():
                    shutil.move(str(f), str(target / f"{stamp}-{f.name}"))
            if note:
                (target / f"{stamp}-{spec_file.stem}.error.txt").write_text(note + "\n", encoding="utf-8")
            results.append({"file": spec_file.name, **result})
        return results

    # ---- single instance ----------------------------------------------------------------------
    def _instance_doc(self) -> dict:
        try:
            return json.loads(self.instance_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _alive(self, active: dict | None) -> bool:
        return bool(active) and self.clock() - float(active.get("heartbeat_ts") or 0) < INSTANCE_TTL

    def _public(self, active: dict | None) -> dict | None:
        if not active:
            return None
        return {**{k: v for k, v in active.items() if k != "heartbeat_ts"}, "alive": self._alive(active),
                "heartbeat_age_s": round(self.clock() - float(active.get("heartbeat_ts") or 0))}

    @staticmethod
    def _instance_id(body: dict) -> str:
        iid = str((body or {}).get("instance_id") or "")
        if not re.fullmatch(r"[\w.\-]{1,80}", iid):
            raise Rejected("instance_id 无效")
        return iid

    def _claim(self, doc: dict, iid: str, body: dict) -> dict:
        t = self.clock()
        info = {k: v for k, v in body.items() if k != "instance_id"}
        doc["active"] = {"instance_id": iid, "info": info, "registered_at": iso(t), "heartbeat_at": iso(t),
                         "heartbeat_ts": t, "stop_requested": None}
        return doc["active"]

    def register(self, body: dict) -> tuple[bool, dict]:
        """Claim the batch for one runner. Refused while another one has heartbeated recently."""
        iid = self._instance_id(body)
        with LOCK:
            doc = self._instance_doc()
            active = doc.get("active")
            if active and active.get("instance_id") != iid and self._alive(active):
                return False, {"ok": False, "error": "本批次已有提交程序在运行；先停止它（--stop），或等它 5 分钟无心跳后再启动",
                               "active": self._public(active)}
            replaced = active.get("instance_id") if active and active.get("instance_id") != iid else None
            self._claim(doc, iid, body)
            write_json(self.instance_file, doc)
        self.event({"at": now(), "type": "instance_registered", "instance_id": iid, "replaced_stale": replaced,
                    **{k: body.get(k) for k in ("canvasId", "generateNum", "concurrency", "code_version")}})
        return True, {"ok": True, "instance_id": iid}

    def heartbeat(self, body: dict) -> dict:
        """Refresh the runner's lease and tell it whether to stop."""
        iid = self._instance_id(body)
        with LOCK:
            doc = self._instance_doc()
            active = doc.get("active")
            if active and active.get("instance_id") != iid and self._alive(active):
                # A tab that slept past its lease while another runner took over: it must go.
                return {"ok": False, "stop": True, "reason": "superseded", "active": active.get("instance_id")}
            if not active or active.get("instance_id") != iid:
                active = self._claim(doc, iid, body)  # the lease had lapsed and nobody took it
            else:
                t = self.clock()
                active.update(heartbeat_at=iso(t), heartbeat_ts=t)
            write_json(self.instance_file, doc)
            stop = active.get("stop_requested")
        return {"ok": True, "stop": bool(stop), "reason": (stop or {}).get("reason")}

    def unregister(self, body: dict) -> dict:
        iid = self._instance_id(body)
        with LOCK:
            doc = self._instance_doc()
            active = doc.get("active")
            if not active or active.get("instance_id") != iid:
                return {"ok": True, "released": False}
            doc["active"], doc["last"] = None, {**active, "stopped_at": now()}
            write_json(self.instance_file, doc)
        self.event({"at": now(), "type": "instance_unregistered", "instance_id": iid})
        return {"ok": True, "released": True}

    def request_stop(self, reason: str | None = None) -> dict:
        """Ask the registered runner to stop at its next tick. Submitted tasks keep running."""
        with LOCK:
            doc = self._instance_doc()
            active = doc.get("active")
            if not active:
                return {"ok": True, "instance": None, "message": "没有已登记的提交程序"}
            active["stop_requested"] = {"reason": (reason or "requested")[:200], "requested_at": now()}
            write_json(self.instance_file, doc)
        self.event({"at": now(), "type": "stop_requested", "instance_id": active["instance_id"], "reason": reason})
        return {"ok": True, "instance": self._public(active)}

    def state_writer_allowed(self, body: dict) -> bool:
        """Only the live registered runner (or a runner too old to register) may write the state."""
        iid = ((body or {}).get("instance") or {}).get("instance_id")
        active = self._instance_doc().get("active")
        return not iid or not active or active.get("instance_id") == iid or not self._alive(active)

    def health(self, port: int | None = None) -> dict:
        state = self.read_state()
        try:
            state_age = round(self.clock() - self.state_file.stat().st_mtime)
        except FileNotFoundError:
            state_age = None
        return {"ok": True, "batch": str(self.root), "port": port,
                "server": {"pid": os.getpid(), "started_at": self.started_at, "runner_on_disk": runner_build()},
                "instance": self._public(self._instance_doc().get("active")),
                "runner": {k: state.get(k) for k in ("status", "updated_at", "counts", "auth_invalid_since",
                                                     "capacity", "instance", "stop_reason")},
                "state_age_s": state_age, "missing_videos": len(self.missing_videos())}

    def event(self, record: dict) -> None:
        with LOCK, self.events_file.open("a") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def done(self, record: dict) -> None:
        self.video_target(record.get("shot_id"), 0)  # refuse a bad shot id before anything starts
        self.event({"at": now(), "type": "download_requested", **record})
        threading.Thread(target=self._download, args=(record,), daemon=True).start()

    def _download(self, record: dict) -> None:
        for index, url in enumerate(record.get("urls") or []):
            self._fetch(record["shot_id"], index, url, record.get("task_id"))

    def video_target(self, shot: str, index: int) -> Path:
        """Output n of a shot: <shot>.mp4 for the first, <shot>-N.mp4 from the second on."""
        if not isinstance(shot, str) or not SHOT_ID.match(shot):
            raise Rejected(f"非法 shot_id：{shot!r}")
        return self.videos / (f"{shot}.mp4" if index == 0 else f"{shot}-{index + 1}.mp4")

    def _fetch(self, shot: str, index: int, url: str, task_id=None, via: str = "done") -> bool:
        target = self.video_target(shot, index)
        with LOCK:
            if target in self._fetching:
                return False  # the same file is already on its way
            self._fetching.add(target)
        try:
            self.videos.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".part")
            with urllib.request.urlopen(url, timeout=300) as response, tmp.open("wb") as fh:
                while chunk := response.read(1 << 20):
                    fh.write(chunk)
            os.replace(tmp, target)
            self._fetch_failures.pop(target, None)
            self.event({"at": now(), "type": "downloaded", "shot_id": shot, "task_id": task_id,
                        "file": str(target), "bytes": target.stat().st_size, "via": via})
            return True
        except Exception as error:  # noqa: BLE001 - recorded, the runner keeps going
            self._fetch_failures[target] = self._fetch_failures.get(target, 0) + 1
            self.event({"at": now(), "type": "download_failed", "shot_id": shot, "url": url, "error": str(error), "via": via})
            return False
        finally:
            with LOCK:
                self._fetching.discard(target)

    # ---- backfill -----------------------------------------------------------------------------
    def read_state(self) -> dict:
        try:
            return json.loads(self.state_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def missing_videos(self) -> list[dict]:
        """Every output of a COMPLETED shot that has no file under videos/ yet."""
        missing = []
        for shot, job in (self.read_state().get("jobs") or {}).items():
            if not isinstance(job, dict) or job.get("status") != "COMPLETED" or not SHOT_ID.match(str(shot)):
                continue
            for index, url in enumerate(job.get("outputs") or []):
                if isinstance(url, str) and url and not self.video_target(shot, index).exists():
                    missing.append({"shot_id": shot, "index": index, "url": url, "task_id": job.get("task_id")})
        return missing

    def backfill(self) -> list[dict]:
        """Download what the runner finished while nobody listened (a lost /done, a server restart).
        An output that failed MAX_DOWNLOAD_FAILURES times in this process is left alone."""
        results = []
        for m in self.missing_videos():
            target = self.video_target(m["shot_id"], m["index"])
            if self._fetch_failures.get(target, 0) >= MAX_DOWNLOAD_FAILURES:
                continue
            ok = self._fetch(m["shot_id"], m["index"], m["url"], m["task_id"], via="backfill")
            results.append({**m, "ok": ok})
        return results


def job_mode(job: dict) -> str:
    """first / first_last / reference / text, from the queue record's settings.mode (首帧 when absent)."""
    return SETTINGS_MODE_KEYS.get((job.get("settings") or {}).get("mode"), "first")


def job_materials(job: dict) -> list[tuple[str, dict | None]]:
    """(label, frame record) for every image this job's mode needs; a None record is missing material."""
    mode = job_mode(job)
    if mode == "text":
        return []
    out = [("首帧", job.get("first_frame"))] if mode in ("first", "first_last") else []
    if mode == "first_last":
        out.append(("尾帧", job.get("last_frame")))
    if mode == "reference":
        refs = job.get("reference_images") or []
        out += [(f"第 {i} 张参考图", r) for i, r in enumerate(refs, 1)] or [("参考图", None)]
    return out


def material_digests(job: dict) -> list:
    return [(frame or {}).get("sha256") for _, frame in job_materials(job)]


def inbox_images(spec) -> list[str]:
    """Image files an inbox spec names, so they move to done/ or failed/ together with it."""
    if not isinstance(spec, dict):
        return []
    names = [spec.get("image"), spec.get("last_image")]
    for ref in spec.get("images") or [] if isinstance(spec.get("images"), list) else []:
        names.append(ref if isinstance(ref, str) else ref.get("path") if isinstance(ref, dict) else None)
    return [n for n in names if isinstance(n, str) and n]


def handler(batch: Batch, port: int = 47615):
    # The runner is loaded from a blob, so it cannot see where it came from: hand it this server's
    # own address, so the start snippet names the port only once (in the URL it fetches).
    def runner_source() -> bytes:
        build = json.dumps(runner_build()).encode()
        return (RUNNER.read_bytes().replace(b"http://127.0.0.1:47615", f"http://127.0.0.1:{port}".encode())
                .replace(RUNNER_BUILD_LINE, b"export const RUNNER_BUILD = " + build + b";"))

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", ORIGIN)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Cache-Control", "no-store")

        def reply(self, code: int, body: bytes, mime="application/json"):
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def json(self, value, code=200):
            self.reply(code, json.dumps(value, ensure_ascii=False).encode())

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_GET(self):
            try:
                if self.path == "/runner.mjs":
                    self.reply(200, runner_source(), "text/javascript")
                elif self.path == "/queue":
                    self.json(batch.queue_payload())
                elif self.path == "/state":
                    self.json(json.loads(batch.state_file.read_text()) if batch.state_file.exists() else {})
                elif self.path.startswith("/frame/"):
                    shot, _, which = self.path[len("/frame/"):].partition("/")
                    data, mime = batch.frame(unquote(shot), which or "first")
                    self.reply(200, data, mime)
                elif self.path.startswith("/status/"):
                    self.json(batch.status(unquote(self.path[len("/status/"):])))
                elif self.path == "/health":
                    self.json(batch.health(port))
                else:
                    self.json({"error": "not found"}, 404)
            except FileNotFoundError as error:
                self.json({"error": f"not found: {error}"}, 404)
            except Exception as error:  # noqa: BLE001
                self.json({"error": str(error)}, 500)

        def enqueue(self):
            # Deliveries come from local services, never from a web page: a page could otherwise
            # make this machine read a local image and submit it. Browsers always send Origin.
            if self.headers.get("Origin"):
                return self.json({"ok": False, "error": "投递接口只接受本机服务直接调用"}, 403)
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self.json({"ok": False, "error": "Content-Type 必须是 application/json"}, 415)
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_IMAGE_BYTES * 2:
                return self.json({"ok": False, "error": "请求体过大"}, 413)
            try:
                result = batch.enqueue(json.loads(self.rfile.read(length) or b"{}"))
            except (Rejected, json.JSONDecodeError) as error:
                return self.json({"ok": False, "error": str(error)}, 400)
            self.json(result, 200 if result.get("duplicate") else 201)

        def instance(self, body: dict):
            # JSON only, so a browser page of another origin cannot reach it without a CORS preflight.
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self.json({"ok": False, "error": "Content-Type 必须是 application/json"}, 415)
            if self.path == "/instance/register":
                ok, result = batch.register(body)
                return self.json(result, 200 if ok else 409)
            if self.path == "/instance/heartbeat":
                return self.json(batch.heartbeat(body))
            return self.json(batch.unregister(body))

        def do_POST(self):
            try:
                if self.path == "/enqueue":
                    return self.enqueue()
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path in ("/instance/register", "/instance/heartbeat", "/instance/unregister"):
                    return self.instance(body)
                if self.path == "/stop":
                    # A shell command, never a web page.
                    if self.headers.get("Origin"):
                        return self.json({"ok": False, "error": "停止命令只接受本机调用"}, 403)
                    return self.json(batch.request_stop(body.get("reason")))
                if self.path == "/state":
                    # A runner still attached to a previous batch must not overwrite this one.
                    if body.get("batch") != str(batch.root):
                        return self.json({"error": "state belongs to another batch"}, 409)
                    if not batch.state_writer_allowed(body):
                        return self.json({"error": "state belongs to another runner"}, 409)
                    with LOCK:
                        write_json(batch.state_file, body)
                elif self.path == "/event":
                    batch.event(body)
                elif self.path == "/done":
                    batch.done(body)
                else:
                    return self.json({"error": "not found"}, 404)
                self.json({"ok": True})
            except Rejected as error:
                self.json({"ok": False, "error": str(error)}, 400)
            except Exception as error:  # noqa: BLE001
                self.json({"error": str(error)}, 500)

    return H


def call(port: int, method: str, path: str, body: dict | None = None, timeout: float = 10) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def stop_command(port: int, reason: str, wait: float, poll: float = 5, out=print) -> int:
    """--stop: ask the runner to stop; with --wait, until it has unregistered (exit 0) or not (exit 1)."""
    try:
        result = call(port, "POST", "/stop", {"reason": reason})
    except (urllib.error.URLError, OSError) as error:
        out(f"连不上本机服务 127.0.0.1:{port}：{error}")
        return 2
    inst = result.get("instance")
    if not inst:
        out("没有已登记的提交程序，不需要停止")
        return 0
    out(f"已请求停止 {inst['instance_id']}（canvas {inst.get('info', {}).get('canvasId')}，"
        f"{'在线' if inst.get('alive') else '已 %ss 无心跳' % inst.get('heartbeat_age_s')}）")
    deadline = time.time() + wait
    while wait and time.time() < deadline:
        time.sleep(poll)
        active = (call(port, "GET", "/health").get("instance") or {})
        if active.get("instance_id") != inst["instance_id"]:
            out("提交程序已停止并注销")
            return 0
    if wait:
        out(f"{wait:.0f} 秒内没有注销：页面可能已关闭或在睡眠；它下次运行时会自己停止，5 分钟无心跳后可启动新的")
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--batch", help="批次目录（含 formal-video-queue.json）；启动服务时必填")
    parser.add_argument("--port", type=int, default=47615)
    parser.add_argument("--inbox-interval", type=float, default=30, help="扫描 inbox/ 的间隔秒数")
    parser.add_argument("--max-reference-images", type=int, default=MAX_REFERENCE_IMAGES,
                        help="全能参考每个镜头最多几张参考图")
    parser.add_argument("--backfill-interval", type=float, default=300, help="补漏下载的扫描间隔秒数")
    parser.add_argument("--keep-awake", action="store_true", help="服务运行期间用 caffeinate 阻止系统睡眠")
    parser.add_argument("--stop", action="store_true", help="让正在运行的页面提交程序停止（不启动服务）")
    parser.add_argument("--reason", default="manual stop", help="--stop 的原因，记在事件里")
    parser.add_argument("--wait", type=float, default=0, help="--stop 后最多等几秒确认它已注销")
    parser.add_argument("--status", action="store_true", help="打印服务的 /health（不启动服务）")
    args = parser.parse_args()
    globals()["MAX_REFERENCE_IMAGES"] = args.max_reference_images
    if args.stop:
        sys.exit(stop_command(args.port, args.reason, args.wait))
    if args.status:
        try:
            print(json.dumps(call(args.port, "GET", "/health"), ensure_ascii=False, indent=2))
        except (urllib.error.URLError, OSError) as error:
            print(f"连不上本机服务 127.0.0.1:{args.port}：{error}")
            sys.exit(2)
        return
    if not args.batch:
        parser.error("启动服务需要 --batch")
    batch = Batch(Path(args.batch).expanduser().resolve())
    if args.keep_awake and Path("/usr/bin/caffeinate").exists():
        # -i idle sleep, -s system sleep on AC power; -w ends it together with this process.
        subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())])

    def watch_backfill():
        while True:
            try:
                for r in batch.backfill():
                    print(f"backfill: {r['shot_id']}#{r['index'] + 1} -> {'ok' if r['ok'] else 'failed'}", flush=True)
            except Exception as error:  # noqa: BLE001 - keep watching
                print(f"backfill error: {error}", flush=True)
            time.sleep(args.backfill_interval)

    def watch_inbox():
        while True:
            try:
                for r in batch.scan_inbox():
                    print(f"inbox: {r['file']} -> {'ok' if r.get('ok') else r.get('error')}", flush=True)
            except Exception as error:  # noqa: BLE001 - keep watching
                print(f"inbox error: {error}", flush=True)
            time.sleep(args.inbox_interval)

    threading.Thread(target=watch_inbox, daemon=True).start()
    threading.Thread(target=watch_backfill, daemon=True).start()  # first pass right at startup
    print(f"rhtv native server: http://127.0.0.1:{args.port}  batch={batch.root}  jobs={len(batch.queue_payload()['jobs'])}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), handler(batch, args.port)).serve_forever()


if __name__ == "__main__":
    main()
