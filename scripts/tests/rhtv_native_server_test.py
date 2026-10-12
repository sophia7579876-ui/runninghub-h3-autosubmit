"""Delivery interface of rhtv-native-server.py: POST /enqueue, GET /status, and the inbox folder."""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "rhtv_native_server", Path(__file__).resolve().parents[1] / "runninghub" / "rhtv-native-server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)

PNG = b"\x89PNG\r\n\x1a\n" + b"frame-bytes"
JPG = b"\xff\xd8\xff" + b"jpeg-bytes"


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "batch"
        self.root.mkdir()
        (self.root / "formal-video-queue.json").write_text(json.dumps({"jobs": [
            {"shot_id": "main-1", "status": "READY_FOR_PRODUCTION", "prepared_prompt": "主队列",
             "settings": dict(server.DEFAULT_SETTINGS), "first_frame": {"rel_path": "m.png"}}]}))
        (self.root / "m.png").write_bytes(PNG)
        self.batch = server.Batch(self.root)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.handler(self.batch, 0))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.image = Path(self.tmp.name) / "s.png"
        self.image.write_bytes(PNG)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def queue_ids(self):
        return [j["shot_id"] for j in self.call("GET", "/queue")[1]["jobs"]]

    def test_enqueue_copies_the_image_and_reaches_the_runner_queue(self):
        code, r = self.call("POST", "/enqueue", {"shot_id": "p1__S01", "prompt": " 镜头 ", "image_path": str(self.image),
                                                "ratio": "9:16", "duration": 11})
        self.assertEqual(code, 201)
        self.assertEqual(r["status"], "queued")
        self.image.unlink()  # the batch keeps its own copy
        job = self.call("GET", "/queue")[1]["jobs"][-1]
        self.assertEqual(job["shot_id"], "p1__S01")
        self.assertEqual(job["prompt"], "镜头")
        self.assertEqual((job["settings"]["ratio"], job["settings"]["duration_seconds"]), ("9:16", 11))
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/frame/p1__S01") as f:
            self.assertEqual(f.read(), PNG)

    def test_base64_image_is_accepted(self):
        code, _ = self.call("POST", "/enqueue", {"shot_id": "b64", "prompt": "p", "image_base64": base64.b64encode(JPG).decode()})
        self.assertEqual(code, 201)
        self.assertTrue((self.root / "intake" / "frames" / "b64.jpg").exists())

    def test_priority_high_goes_before_the_main_queue_and_normal_after(self):
        self.call("POST", "/enqueue", {"shot_id": "late", "prompt": "p", "image_path": str(self.image)})
        self.call("POST", "/enqueue", {"shot_id": "urgent", "prompt": "p", "image_path": str(self.image), "priority": "high"})
        self.assertEqual(self.queue_ids(), ["urgent", "main-1", "late"])

    def test_same_delivery_twice_is_idempotent_but_a_changed_one_is_refused(self):
        spec = {"shot_id": "dup", "prompt": "p", "image_path": str(self.image)}
        self.assertEqual(self.call("POST", "/enqueue", spec)[0], 201)
        code, r = self.call("POST", "/enqueue", spec)
        self.assertEqual((code, r["duplicate"]), (200, True))
        self.assertEqual(self.queue_ids().count("dup"), 1)
        code, r = self.call("POST", "/enqueue", {**spec, "prompt": "改过"})
        self.assertEqual(code, 400)
        self.assertIn("已存在", r["error"])
        # A shot already in the main queue is protected the same way.
        self.assertEqual(self.call("POST", "/enqueue", {**spec, "shot_id": "main-1"})[0], 400)

    def test_invalid_deliveries_are_refused_with_a_reason(self):
        bad = [
            {"prompt": "p", "image_path": str(self.image)},
            {"shot_id": "a b", "prompt": "p", "image_path": str(self.image)},
            {"shot_id": "x", "prompt": "", "image_path": str(self.image)},
            {"shot_id": "x", "prompt": "p"},
            {"shot_id": "x", "prompt": "p", "image_path": "relative.png"},
            {"shot_id": "x", "prompt": "p", "image_path": str(self.image), "ratio": "21:9"},
            {"shot_id": "x", "prompt": "p", "image_path": str(self.image), "duration": 30},
            {"shot_id": "x", "prompt": "p", "image_path": str(self.image), "duration": 1.5},
            {"shot_id": "x", "prompt": "p", "image_path": str(self.image), "priority": "urgent"},
            {"shot_id": "x", "prompt": "p", "image_base64": base64.b64encode(b"not an image").decode()},
        ]
        for spec in bad:
            code, r = self.call("POST", "/enqueue", spec)
            self.assertEqual(code, 400, spec)
            self.assertFalse(r["ok"])
        self.assertEqual(self.queue_ids(), ["main-1"], "被拒的投递不进入队列")

    def test_text_mode_needs_no_image_and_is_never_implied(self):
        code, r = self.call("POST", "/enqueue", {"shot_id": "t1", "prompt": "文生", "mode": "text", "ratio": "16:9"})
        self.assertEqual(code, 201)
        job = self.call("GET", "/queue")[1]["jobs"][-1]
        self.assertEqual((job["shot_id"], job["settings"]["mode"]), ("t1", "文生视频"))
        self.assertEqual(self.call("POST", "/enqueue", {"shot_id": "t2", "prompt": "p"})[0], 400, "没写 mode 又没图片就拒绝")
        self.assertEqual(self.call("POST", "/enqueue", {"shot_id": "t3", "prompt": "p", "mode": "text",
                                                       "image_path": str(self.image)})[0], 400)

    def frame_bytes(self, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as f:
                return f.status, f.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read()

    def test_first_last_mode_queues_both_frames_and_serves_each(self):
        last = Path(self.tmp.name) / "end.jpg"
        last.write_bytes(JPG)
        code, _ = self.call("POST", "/enqueue", {"shot_id": "fl1", "prompt": "首尾", "mode": "first_last",
                                                "image_path": str(self.image), "last_image_path": str(last)})
        self.assertEqual(code, 201)
        job = self.call("GET", "/queue")[1]["jobs"][-1]
        self.assertEqual((job["shot_id"], job["settings"]["mode"]), ("fl1", "首尾帧"))
        self.assertEqual(self.frame_bytes("/frame/fl1"), (200, PNG))
        self.assertEqual(self.frame_bytes("/frame/fl1/last"), (200, JPG))
        record = json.loads((self.root / "intake-queue.json").read_text())["jobs"][-1]
        self.assertEqual(record["last_frame"]["rel_path"], "intake/frames/fl1.last.jpg")
        # base64 for the last frame works too, and the same delivery twice is a duplicate, not a second job.
        spec = {"shot_id": "fl2", "prompt": "p", "mode": "first_last", "image_path": str(self.image),
                "last_image_base64": base64.b64encode(JPG).decode()}
        self.assertEqual(self.call("POST", "/enqueue", spec)[0], 201)
        self.assertEqual(self.call("POST", "/enqueue", spec)[0], 200)
        changed = {**spec, "last_image_base64": base64.b64encode(PNG).decode()}
        self.assertEqual(self.call("POST", "/enqueue", changed)[0], 400, "尾帧换了就不是同一条投递")

    def test_first_last_mode_refuses_missing_frames_and_never_degrades(self):
        last = Path(self.tmp.name) / "end.png"
        last.write_bytes(PNG)
        bad = [
            {"shot_id": "x1", "prompt": "p", "mode": "first_last", "image_path": str(self.image)},
            {"shot_id": "x2", "prompt": "p", "mode": "first_last", "last_image_path": str(last)},
            {"shot_id": "x3", "prompt": "p", "mode": "first_last", "image_path": str(self.image),
             "last_image_path": "/nope/end.png"},
            {"shot_id": "x4", "prompt": "p", "image_path": str(self.image), "last_image_path": str(last)},
            {"shot_id": "x5", "prompt": "p", "mode": "text", "last_image_path": str(last)},
            {"shot_id": "x6", "prompt": "p", "mode": "keyframes", "image_path": str(self.image)},
        ]
        for spec in bad:
            code, r = self.call("POST", "/enqueue", spec)
            self.assertEqual(code, 400, spec)
            self.assertFalse(r["ok"])
        self.assertEqual(self.queue_ids(), ["main-1"])

    def test_reference_mode_queues_every_image_in_order(self):
        second = Path(self.tmp.name) / "r2.jpg"
        second.write_bytes(JPG)
        code, _ = self.call("POST", "/enqueue", {"shot_id": "r1", "prompt": "全能", "mode": "reference",
                                                "images": [str(self.image), {"path": str(second)},
                                                           {"base64": base64.b64encode(PNG).decode()}]})
        self.assertEqual(code, 201)
        job = self.call("GET", "/queue")[1]["jobs"][-1]
        self.assertEqual((job["settings"]["mode"], job["reference_count"]), ("全能参考", 3))
        self.assertEqual(self.frame_bytes("/frame/r1/ref/1"), (200, PNG))
        self.assertEqual(self.frame_bytes("/frame/r1/ref/2"), (200, JPG))
        self.assertEqual(self.frame_bytes("/frame/r1/ref/3")[0], 200)
        self.assertEqual(self.frame_bytes("/frame/r1/ref/4")[0], 404, "没有第 4 张")
        self.assertEqual(self.frame_bytes("/frame/r1")[0], 404, "全能参考没有首帧")
        self.assertEqual(self.frame_bytes("/frame/r1/ref/0")[0], 404)

    def test_reference_mode_refuses_missing_or_too_many_images(self):
        too_many = [str(self.image)] * (server.MAX_REFERENCE_IMAGES + 1)
        bad = [
            {"shot_id": "y1", "prompt": "p", "mode": "reference"},
            {"shot_id": "y2", "prompt": "p", "mode": "reference", "images": []},
            {"shot_id": "y3", "prompt": "p", "mode": "reference", "images": too_many},
            {"shot_id": "y4", "prompt": "p", "mode": "reference", "images": [str(self.image), "/nope.png"]},
            {"shot_id": "y5", "prompt": "p", "mode": "reference", "images": [{"url": "https://x/a.png"}]},
            {"shot_id": "y6", "prompt": "p", "mode": "reference", "images": [str(self.image)], "image_path": str(self.image)},
            {"shot_id": "y7", "prompt": "p", "images": [str(self.image)], "image_path": str(self.image)},
            {"shot_id": "y8", "prompt": "p", "mode": "reference", "images": "not-a-list"},
        ]
        for spec in bad:
            code, r = self.call("POST", "/enqueue", spec)
            self.assertEqual(code, 400, spec)
            self.assertFalse(r["ok"])
        self.assertEqual(self.queue_ids(), ["main-1"], "被拒的投递不进入队列，也不截断参考图")
        self.assertFalse((self.root / "intake" / "frames").exists() and any((self.root / "intake" / "frames").iterdir()))
        exact = [str(self.image)] * server.MAX_REFERENCE_IMAGES
        self.assertEqual(self.call("POST", "/enqueue", {"shot_id": "y9", "prompt": "p", "mode": "reference", "images": exact})[0], 201)

    def test_inbox_moves_every_named_image_of_a_multi_image_delivery(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        for name in ("a.png", "b.png", "c.png", "d.png"):
            (inbox / name).write_bytes(PNG)
        (inbox / "fl.json").write_text(json.dumps({"shot_id": "ifl", "prompt": "p", "mode": "first_last",
                                                    "image": "a.png", "last_image": "b.png"}))
        (inbox / "rf.json").write_text(json.dumps({"shot_id": "irf", "prompt": "p", "mode": "reference",
                                                    "images": ["c.png", {"path": "d.png"}]}))
        old = time.time() - 10
        for f in inbox.iterdir():
            os.utime(f, (old, old))
        results = {r["file"]: r for r in self.batch.scan_inbox()}
        self.assertTrue(results["fl.json"]["ok"], results)
        self.assertTrue(results["rf.json"]["ok"], results)
        done = sorted(p.name.split("-", 2)[-1] for p in (inbox / "done").iterdir())
        self.assertEqual(done, ["a.png", "b.png", "c.png", "d.png", "fl.json", "rf.json"])

    def test_a_web_page_cannot_deliver(self):
        code, _ = self.call("POST", "/enqueue", {"shot_id": "x", "prompt": "p", "image_path": str(self.image)},
                            headers={"Origin": "https://evil.example"})
        self.assertEqual(code, 403)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/enqueue", method="POST",
                                     data=b'{"shot_id":"x","prompt":"p"}', headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        e.exception.close()
        self.assertEqual(e.exception.code, 415)

    def test_status_follows_the_runner_state(self):
        self.call("POST", "/enqueue", {"shot_id": "s1", "prompt": "p", "image_path": str(self.image)})
        self.assertEqual(self.call("GET", "/status/s1")[1]["status"], "queued")
        (self.root / "native-state.json").write_text(json.dumps({"jobs": {
            "s1": {"status": "COMPLETED", "task_id": "9", "outputs": ["https://cdn/v.mp4"]}}}))
        (self.root / "videos").mkdir()
        (self.root / "videos" / "s1.mp4").write_bytes(b"v")
        r = self.call("GET", "/status/s1")[1]
        self.assertEqual((r["status"], r["task_id"]), ("completed", "9"))
        self.assertTrue(r["video_path"].endswith("videos/s1.mp4"))
        self.assertEqual(self.call("GET", "/status/nope")[0], 404)

    def test_inbox_ingests_settled_files_and_moves_them_aside(self):
        inbox = self.root / "inbox"
        inbox.mkdir()
        (inbox / "k1.png").write_bytes(PNG)
        (inbox / "k1.json").write_text(json.dumps({"shot_id": "k1", "prompt": "厨房", "image": "k1.png", "ratio": "9:16"}))
        (inbox / "bad.json").write_text(json.dumps({"shot_id": "bad", "prompt": "p", "image": "missing.png"}))
        (inbox / "broken.json").write_text("{not json")
        old = time.time() - 10
        for f in inbox.iterdir():
            os.utime(f, (old, old))
        (inbox / "fresh.json").write_text(json.dumps({"shot_id": "fresh", "prompt": "p", "image": "k1.png"}))
        results = {r["file"]: r for r in self.batch.scan_inbox()}
        self.assertTrue(results["k1.json"]["ok"])
        self.assertFalse(results["bad.json"]["ok"])
        self.assertFalse(results["broken.json"]["ok"])
        self.assertNotIn("fresh.json", results, "刚写入、可能还没写完的文件下一轮再处理")
        self.assertIn("k1", self.queue_ids())
        self.assertEqual(sorted(p.name.split("-", 2)[-1] for p in (inbox / "done").iterdir()), ["k1.json", "k1.png"])
        failed = sorted(p.name.split("-", 2)[-1] for p in (inbox / "failed").iterdir())
        self.assertIn("bad.error.txt", failed)
        self.assertIn("broken.error.txt", failed)
        self.assertTrue((inbox / "fresh.json").exists())


class Served(unittest.TestCase):
    """A server on a free port over an empty batch, with a controllable clock."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "batch"
        self.root.mkdir()
        self.batch = server.Batch(self.root)
        self.t = 1_000_000.0
        self.batch.clock = lambda: self.t
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.handler(self.batch, 0))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    call = DeliveryTest.call

    def register(self, iid, **info):
        return self.call("POST", "/instance/register", {"instance_id": iid, "canvasId": "9", "generateNum": 1,
                                                        "concurrency": 2, "code_version": {"sha256": "abc"}, **info})


class InstanceTest(Served):
    def test_a_second_runner_is_refused_while_the_first_heartbeats(self):
        self.assertEqual(self.register("a")[0], 200)
        code, r = self.register("b")
        self.assertEqual(code, 409)
        self.assertEqual(r["active"]["instance_id"], "a")
        self.t += 200
        self.assertEqual(self.call("POST", "/instance/heartbeat", {"instance_id": "a"})[1]["stop"], False)
        self.t += 200
        self.assertEqual(self.register("b")[0], 409, "心跳续上了，仍然拒绝")
        self.assertEqual(self.register("a")[0], 200, "同一个实例重复登记不受影响")

    def test_a_runner_silent_for_five_minutes_can_be_replaced_and_is_then_told_to_stop(self):
        self.register("a")
        self.t += server.INSTANCE_TTL + 1
        self.assertEqual(self.register("b")[0], 200)
        r = self.call("POST", "/instance/heartbeat", {"instance_id": "a"})[1]
        self.assertEqual((r["stop"], r["reason"]), (True, "superseded"), "睡醒的旧标签页自己停")
        self.assertFalse(self.call("POST", "/instance/heartbeat", {"instance_id": "b"})[1]["stop"])

    def test_stop_reaches_the_runner_and_unregister_frees_the_batch(self):
        self.register("a")
        code, r = self.call("POST", "/stop", {"reason": "换人接手"})
        self.assertEqual((code, r["instance"]["instance_id"]), (200, "a"))
        r = self.call("POST", "/instance/heartbeat", {"instance_id": "a"})[1]
        self.assertEqual((r["stop"], r["reason"]), (True, "换人接手"))
        self.assertTrue(self.call("POST", "/instance/unregister", {"instance_id": "a"})[1]["released"])
        self.assertIsNone(self.call("GET", "/health")[1]["instance"])
        self.assertEqual(self.register("b")[0], 200)
        self.assertFalse(self.call("POST", "/instance/heartbeat", {"instance_id": "b"})[1]["stop"], "停止只针对旧实例")
        self.assertFalse(self.call("POST", "/instance/unregister", {"instance_id": "a"})[1]["released"], "旧实例注销不影响新实例")

    def test_stop_with_nobody_registered_is_harmless(self):
        self.assertIsNone(self.call("POST", "/stop", {})[1]["instance"])

    def test_a_web_page_cannot_send_stop_and_instance_calls_need_json(self):
        self.register("a")
        self.assertEqual(self.call("POST", "/stop", {}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.call("POST", "/instance/register", {"instance_id": "x"}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "/instance/register", {"instance_id": "../x"})[0], 400)

    def test_the_lease_survives_a_server_restart(self):
        self.register("a")
        again = server.Batch(self.root)
        again.clock = lambda: self.t + 10
        ok, r = again.register({"instance_id": "b"})
        self.assertFalse(ok)

    def test_only_the_live_runner_may_write_the_state(self):
        self.register("a")
        body = {"batch": str(self.root), "jobs": {}}
        self.assertEqual(self.call("POST", "/state", {**body, "instance": {"instance_id": "b"}})[0], 409)
        self.assertEqual(self.call("POST", "/state", {**body, "instance": {"instance_id": "a"}})[0], 200)
        self.assertEqual(self.call("POST", "/state", body)[0], 200, "旧版本 runner 没有 instance 字段，照常写")

    def test_health_shows_the_running_instance_and_its_settings(self):
        self.register("a", page="https://rhtv.runninghub.cn/project/canvas/9")
        (self.root / "native-state.json").write_text(json.dumps({"status": "RUNNING", "counts": {"RUNNING": 2},
            "instance": {"instance_id": "a", "generateNum": 1, "concurrency": 2}, "jobs": {}}))
        h = self.call("GET", "/health")[1]
        self.assertEqual(h["batch"], str(self.root))
        self.assertEqual(h["instance"]["instance_id"], "a")
        self.assertTrue(h["instance"]["alive"])
        self.assertEqual((h["instance"]["info"]["generateNum"], h["instance"]["info"]["concurrency"],
                          h["instance"]["info"]["canvasId"]), (1, 2, "9"))
        self.assertEqual(h["runner"]["status"], "RUNNING")
        self.assertEqual(h["runner"]["instance"]["generateNum"], 1)
        self.assertEqual(len(h["server"]["runner_on_disk"]["sha256"]), 16)
        self.assertEqual(h["missing_videos"], 0)

    def test_stop_command_line(self):
        self.assertEqual(server.stop_command(self.port, "r", 0, out=lambda *_: None), 0, "没人在跑也算成功")
        self.register("a")
        threading.Timer(0.3, lambda: self.call("POST", "/instance/unregister", {"instance_id": "a"})).start()
        lines = []
        self.assertEqual(server.stop_command(self.port, "r", 5, poll=0.1, out=lines.append), 0)
        self.assertIn("已停止", lines[-1])
        self.register("b")
        self.assertEqual(server.stop_command(self.port, "r", 0.3, poll=0.1, out=lines.append), 1, "等不到注销返回 1")
        self.assertEqual(server.stop_command(1, "r", 0, out=lines.append), 2, "服务连不上返回 2")


class BackfillTest(Served):
    def output(self, name, data=b"video"):
        f = Path(self.tmp.name) / name
        f.write_bytes(data)
        return f.as_uri()

    def state(self, jobs):
        (self.root / "native-state.json").write_text(json.dumps({"jobs": jobs}))

    def test_completed_outputs_without_a_file_are_downloaded_with_the_usual_names(self):
        u1, u2 = self.output("a.mp4", b"one"), self.output("b.mp4", b"two")
        self.state({"s1": {"status": "COMPLETED", "task_id": "7", "outputs": [u1, u2]},
                    "s2": {"status": "RUNNING", "outputs": [u1]},
                    "s3": {"status": "COMPLETED", "outputs": [u1]}})
        (self.root / "videos").mkdir()
        (self.root / "videos" / "s3.mp4").write_bytes(b"already")
        self.assertEqual(self.call("GET", "/health")[1]["missing_videos"], 2)
        results = self.batch.backfill()
        self.assertEqual(sorted((r["shot_id"], r["index"], r["ok"]) for r in results), [("s1", 0, True), ("s1", 1, True)])
        self.assertEqual((self.root / "videos" / "s1.mp4").read_bytes(), b"one")
        self.assertEqual((self.root / "videos" / "s1-2.mp4").read_bytes(), b"two")
        self.assertEqual((self.root / "videos" / "s3.mp4").read_bytes(), b"already", "已有的文件不动")
        self.assertEqual(self.batch.backfill(), [], "补齐后不再下载")
        events = [json.loads(l) for l in (self.root / "native-events.jsonl").read_text().splitlines()]
        self.assertTrue(all(e["via"] == "backfill" for e in events if e["type"] == "downloaded"))

    def test_a_dead_link_is_retried_a_few_times_then_left_alone(self):
        self.state({"s1": {"status": "COMPLETED", "outputs": [(Path(self.tmp.name) / "gone.mp4").as_uri()]}})
        for _ in range(server.MAX_DOWNLOAD_FAILURES):
            self.assertFalse(self.batch.backfill()[0]["ok"])
        self.assertEqual(self.batch.backfill(), [])
        self.assertFalse((self.root / "videos" / "s1.part").exists())

    def test_shot_ids_from_the_state_cannot_escape_the_videos_folder(self):
        self.state({"../evil": {"status": "COMPLETED", "outputs": [self.output("a.mp4")]}})
        self.assertEqual(self.batch.backfill(), [])
        self.assertEqual(self.call("POST", "/done", {"shot_id": "../evil", "urls": []})[0], 400)

    def test_done_still_downloads_immediately(self):
        u = self.output("a.mp4", b"x")
        self.assertEqual(self.call("POST", "/done", {"shot_id": "d1", "task_id": "1", "urls": [u]})[0], 200)
        for _ in range(50):
            if (self.root / "videos" / "d1.mp4").exists():
                break
            time.sleep(0.05)
        self.assertEqual((self.root / "videos" / "d1.mp4").read_bytes(), b"x")


class RunnerPortTest(unittest.TestCase):
    def test_the_served_runner_points_at_the_serving_port(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        batch = server.Batch(Path(tmp.name))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.handler(batch, 47699))
        self.addCleanup(httpd.server_close)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/runner.mjs") as r:
            src = r.read().decode()
        self.assertIn("DEFAULT_SERVER = 'http://127.0.0.1:47699'", src)
        self.assertNotIn("127.0.0.1:47615", src)
        # The served copy names its own build, so a running page can report which code it runs.
        self.assertNotIn("RUNNER_BUILD = { sha256: null", src)
        self.assertIn(f'"sha256": "{server.runner_build()["sha256"]}"', src)


if __name__ == "__main__":
    unittest.main()
