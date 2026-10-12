import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { discoverApi, classifySubmitError, classifyTask, buildRun, createScheduler, inFreeWindow, nextFreeWindowStart, windowKey, isTextJob, classifySubmitError as classify,
  jobMode, pickModel, referenceLimit, isZeroQuote, SUBTYPES, RUNNER_BUILD } from '../runninghub/rhtv-native-runner.mjs';

// Contract test: point RHTV_BUNDLE at a downloaded rhtv index-*.js to check that a new site
// release still resolves every export. Skipped when no bundle is available.
const bundle = process.env.RHTV_BUNDLE;
test('a real site bundle resolves every export by its API anchor', { skip: !bundle && 'RHTV_BUNDLE 未设置' }, async () => {
  const api = discoverApi(await fs.readFile(bundle, 'utf8'));
  assert.deepEqual(Object.keys(api).sort(), ['client', 'detail', 'quote', 'run', 'status', 'store', 'upload']);
  for (const v of Object.values(api)) assert.match(v, /^[A-Za-z_$][\w$]*$/);
});

test('discovery follows anchors, not names, and refuses ambiguity', () => {
  const src = `async function Q(e){return C.post("/canvas/task/run",e)}
async function S(e,t){return C.post("/canvas/task/batchStatus",{taskIds:e})}
function D(e){return C.post("/canvas/getCanvasDetail",{id:e})}
async function P(e){return C.post("/canvas/price/calculate",e)}
async function F(e,t={}){const n=e?.skuId?String(e.skuId):"";const o=await P({skuId:n});return{currency:o.currency}}
async function K(e){return C.post("/api/storage/getCredentials",{scene:e})}
async function T(e){return K(e)}
async function U(e,t="canvas",n={}){const r=await T(t);return r}
async function B(e,t="canvas",n={}){const r=await T(t),o=n.concurrency;return r}
function Z(){return store}function paste(n){Z().pasteGraph(n,[],{immediate:!0})}
export{C as a,Q as fs,S as fC,D as b1,F as aW,U as d2,B as mR,Z as bt};`;
  assert.deepEqual(discoverApi(src), { client: 'a', run: 'fs', status: 'fC', detail: 'b1', quote: 'aW', upload: 'd2', store: 'bt' });
  // A second function on the same endpoint must stop discovery, not pick one at random.
  assert.throws(() => discoverApi(src + '\nasync function Q2(e){return C.post("/canvas/task/run",e)}'), e => e.code === 'API_ANCHOR_CHANGED');
});

test('a platform rate limit carries its own retry deadline', () => {
  const e = Object.assign(new Error('limit'), { code: 1859, payload: { code: 1859, msg: '限流', errorMessages: { retryAfterSeconds: '255', limitScope: 'model:h3' } } });
  assert.deepEqual(classifySubmitError(e), { kind: 'rate_limited', code: 1859, retryAfterMs: 255000, scope: 'model:h3', message: '限流' });
  const blind = Object.assign(new Error('limit'), { code: 1859, payload: { code: 1859 } });
  assert.equal(classifySubmitError(blind).retryAfterMs, 300000, '没有给出等待时间时等 5 分钟');
});

test('a concurrency refusal is told apart from an ordinary error', () => {
  assert.equal(classifySubmitError(new Error('同时最多 5 个并发任务')).kind, 'concurrency_full');
  assert.equal(classifySubmitError(Object.assign(new Error('x'), { code: 500 })).kind, 'error');
});

test('only a successful video output counts as completed', () => {
  const ok = { status: 'SUCCESS', plans: [{ nodeId: 'v', status: 'SUCCESS', outputs: [{ success: true, code: 0, url: 'https://cdn/x.mp4' }] }] };
  assert.deepEqual(classifyTask(ok, 'v'), { status: 'completed', urls: ['https://cdn/x.mp4'] });
  assert.equal(classifyTask({ status: 'SUCCESS', plans: [{ nodeId: 'v', status: 'SUCCESS', outputs: [] }] }, 'v').status, 'running');
  assert.equal(classifyTask({ status: 'FAILED', plans: [{ nodeId: 'v', status: 'FAILED', errorMessage: 'bad' }] }, 'v').status, 'failed');
});

test('the run graph links the uploaded frame to a start-frame H3 video node', () => {
  const { run, params } = buildRun({ canvasId: '9', imageUrl: 'https://cdn/a.png', model: { modelCode: 'm-app' },
    job: { shot_id: 's1', prompt: 'p', settings: { ratio: '16:9', resolution: '768p', duration_seconds: 15 } } });
  const [video, image] = run.canvas.nodes;
  assert.equal(run.targetId, video.id);
  assert.deepEqual(run.canvas.edges.map(e => [e.source, e.target]), [[image.id, video.id]]);
  assert.deepEqual(params, { prompt: 'p', aspectRatio: '16:9', resolution: '768p', duration: '15', audioMode: 'native', firstFrameUrl: 'https://cdn/a.png' });
  assert.equal(video.data.subType, 'start-video');
});

test('one video per submission unless told otherwise', () => {
  const nodeOf = (job, extra = {}) => buildRun({ canvasId: '9', imageUrl: 'u', model: { modelCode: 'm' }, job, ...extra }).run.canvas.nodes[0];
  assert.equal(nodeOf({ shot_id: 'a', prompt: 'p' }).data.generateNum, 1);
  assert.equal(nodeOf({ shot_id: 'b', prompt: 'p', settings: { mode: '文生视频' } }).data.generateNum, 1);
  assert.equal(nodeOf({ shot_id: 'c', prompt: 'p' }, { generateNum: 2 }).data.generateNum, 2);
  assert.equal(nodeOf({ shot_id: 'd', prompt: 'p', settings: { generate_num: 2 } }, { generateNum: 1 }).data.generateNum, 2);
});

// A fake platform: tasks finish when the test says so; the account allows `cap` at once.
function platform({ cap = 5, limitAt = null, asyncCap = false } = {}) {
  let clock = 1_000_000, seq = 0;
  const tasks = new Map(), log = [];
  const io = { saved: null, queue: [], finished: [],
    loadQueue: async () => io.queue, loadState: async () => io.saved,
    saveState: async s => { io.saved = JSON.parse(JSON.stringify(s)); }, event: async e => log.push(e), done: async d => io.finished.push(d) };
  const persisted = [];
  const api = {
    persist: async canvas => { persisted.push(canvas.nodes.map(n => n.id)); },
    upload: async job => `https://cdn/${job.shot_id}.png`,
    quote: async () => ({ currency: 'CNY', totalPrice: 0 }),
    run: async run => {
      if (limitAt != null && seq === limitAt) { limitAt = null; throw Object.assign(new Error('limit'), { code: 1859, payload: { code: 1859, errorMessages: { retryAfterSeconds: '120' } } }); }
      const full = [...tasks.values()].filter(t => t.status === 'RUNNING').length >= cap;
      if (full && !asyncCap) throw new Error('同时最多 5 个并发');
      const id = String(++seq);
      // The real platform accepts the submit and fails the task afterwards with errorCode 1520.
      tasks.set(id, full ? { status: 'FAILED', node: run.targetId, error: 'OpenAPI call failed: taskId is empty. errorCode: 1520, errorMessage: 当前账号对该模型的并发已达上限，请稍后重试' }
        : { status: 'RUNNING', node: run.targetId });
      return { taskId: id, status: 'PENDING' };
    },
    status: async ids => ({ tasks: ids.map(id => { const t = tasks.get(id);
      return { taskId: id, status: t.status, plans: [{ nodeId: t.node, status: t.status, errorMessage: t.error,
        outputs: t.status === 'SUCCESS' ? [{ success: true, code: 0, url: `https://cdn/out-${id}.mp4` }] : [] }] }; }) }),
  };
  const finish = id => { tasks.get(String(id)).status = 'SUCCESS'; };
  const setCap = n => { cap = n; };
  const running = () => [...tasks.values()].filter(t => t.status === 'RUNNING').length;
  const make = opts => createScheduler({ api, io, canvasId: '9', model: { modelCode: 'm-app' }, now: () => clock, submitGapMs: 0, pollMs: 0, freeWindow: null, calibrate: false,
    probeAfter: 'completion', maxBackoffSteps: 4, maxRejectionsPerWindow: 20, ...opts });
  return { io, api, log, finish, running, make, setCap, advance: ms => { clock += ms; }, tasks, persisted };
}
const jobs = n => Array.from({ length: n }, (_, i) => ({ shot_id: `s${i + 1}`, prompt: `p${i + 1}`, settings: {} }));

test('five run at once; the sixth waits until one completes, then goes immediately', async () => {
  const p = platform();
  p.io.queue = jobs(8);
  const s = p.make();
  await s.start();
  await s.tick();
  assert.equal(p.running(), 5, '并发补满 5 个');
  assert.equal(s.state.jobs.s6.status, 'PENDING');
  await s.tick();
  assert.equal(p.running(), 5, '没有完成时不超过 5 个');
  p.finish(2);
  await s.tick();
  assert.equal(s.state.jobs.s2.status, 'COMPLETED');
  assert.equal(s.state.jobs.s6.status, 'RUNNING', '完成一个就立刻提交下一个');
  assert.equal(p.running(), 5);
  assert.deepEqual(p.io.finished.map(d => d.shot_id), ['s2'], '完成的成片交给本地服务下载');
});

test('a full account (tasks started elsewhere) backs off until a slot opens', async () => {
  const p = platform({ cap: 3 });
  p.io.queue = jobs(5);
  const s = p.make();
  await s.start();
  await s.tick();
  assert.equal(p.running(), 3);
  assert.equal(s.state.jobs.s4.status, 'PENDING');
  await s.tick();
  assert.equal(p.log.filter(e => e.type === 'concurrency_full').length, 1, '满额后不反复撞墙');
  p.finish(1);
  await s.tick();
  assert.equal(s.state.jobs.s4.status, 'RUNNING', '有任务完成后立刻补位');
});

test('a failed generation is retried, then given up after the attempt limit', async () => {
  const p = platform();
  p.io.queue = jobs(1);
  const s = p.make({ maxAttempts: 2 });
  await s.start();
  await s.tick();
  p.tasks.get('1').status = 'FAILED';
  await s.tick();
  assert.equal(s.state.jobs.s1.status, 'RUNNING', '失败后重提');
  p.tasks.get('2').status = 'FAILED';
  await s.tick();
  assert.equal(s.state.jobs.s1.status, 'FAILED');
});

test('a reloaded page resumes from saved state without resubmitting running work', async () => {
  const p = platform();
  p.io.queue = jobs(6);
  const first = p.make();
  await first.start(); await first.tick();
  assert.equal(p.running(), 5);
  const second = p.make();
  await second.start();
  await second.tick();
  assert.equal(p.tasks.size, 5, '恢复后不重复提交');
  p.finish(1); await second.tick();
  assert.equal(second.state.jobs.s6.status, 'RUNNING');
});

test('material added to the queue while running is picked up', async () => {
  const p = platform();
  p.io.queue = jobs(1);
  const s = p.make({ idleReloadMs: 0 });
  await s.start(); await s.tick();
  p.finish(1); await s.tick();
  assert.equal(s.state.status, 'DRAINED');
  p.io.queue = jobs(3);
  await s.tick(); await s.tick();
  assert.equal(s.state.jobs.s3.status, 'RUNNING', '队列追加的新素材会继续提交');
});

test('a 1520 "account full" task failure is a wait, not a failure, and teaches the real capacity', async () => {
  // Measured on the live account: capacity 2 while the submitter asked for 5.
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(6);
  const s = p.make({ maxAttempts: 2, capacityBackoffMs: 60_000 });
  await s.start();
  await s.tick();                       // submits 5; the platform runs 2 and fails 3 with 1520
  await s.tick();                       // poll learns it
  assert.equal(s.state.capacity, 2, '学到账号实际可用并发 = 2');
  for (const id of ['s3', 's4', 's5']) {
    assert.equal(s.state.jobs[id].status, 'PENDING', `${id} 退回队列`);
    assert.equal(s.state.jobs[id].attempts, 0, `${id} 不扣重试次数`);
  }
  const before = p.tasks.size;
  await s.tick(); await s.tick();
  assert.equal(p.tasks.size, before, '满额期间不再反复提交');
  p.finish(1);
  await s.tick();
  assert.equal(s.state.jobs.s3.status, 'RUNNING', '完成一个立刻补一个');
  assert.equal(p.running(), 2);
});

test('jobs wrongly marked FAILED by an account-full error are healed on restart', async () => {
  const p = platform();
  p.io.queue = jobs(2);
  p.io.saved = { jobs: { s1: { shot_id: 's1', status: 'FAILED', attempts: 3, last_error: 'errorCode: 1520, 当前账号对该模型的并发已达上限' },
    s2: { shot_id: 's2', status: 'FAILED', attempts: 3, last_error: '内容审核未通过' } } };
  const s = p.make();
  await s.start();
  assert.equal(s.state.jobs.s1.status, 'PENDING', '并发满导致的失败自动恢复');
  assert.equal(s.state.jobs.s2.status, 'FAILED', '真实失败保持失败');
});

test('a restart keeps the learned capacity instead of starting again at five', async () => {
  // Restarting at 5 cost refused submissions every time, and refusals are what the long limit counts.
  const p = platform();
  p.io.queue = jobs(6);
  p.io.saved = { capacity: 2, full_streak: 1, jobs: {} };
  const s = p.make();
  await s.start(); await s.tick();
  assert.equal(p.running(), 2, '重启后沿用学到的并发 2');
  assert.equal(s.state.full_streak, 1);
});
test('a refused probe still waits a full backoff before trying again', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(8);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  p.advance(61_000); await s.tick(); await s.tick();          // probe to 3, refused
  const before = p.tasks.size;
  for (let i = 0; i < 10; i++) { p.advance(3_000); await s.tick(); }
  assert.equal(p.tasks.size, before, '被拒后 60 秒内不再试探');
});

test('nodes are written into the canvas once per job, before the task targets them', async () => {
  // Without this the result had nowhere to land: write-back retried for ~15 minutes per task
  // and the account behaved as if it allowed only 2 concurrent runs.
  const p = platform({ cap: 1, asyncCap: true });
  p.io.queue = jobs(2);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();   // s2 is refused with 1520 and goes back to the queue
  const s2 = s.state.jobs.s2;
  assert.equal(s2.status, 'PENDING');
  assert.equal(p.persisted.length, 2, '每个任务写一次节点');
  p.finish(1); await s.tick();                         // s2 resubmitted
  assert.equal(s2.status, 'RUNNING');
  assert.equal(p.persisted.length, 2, '重提复用同一对节点，不重复写入画布');
  const task = [...p.tasks.values()].at(-1);
  assert.equal(task.node, s2.node_id, '提交指向已写入画布的视频节点');
  assert.deepEqual(p.persisted[1], [s2.node_id, s2.image_node_id]);
});

test('pairs are laid out on a grid so canvas nodes never overlap', () => {
  const at = slot => buildRun({ canvasId: '9', imageUrl: 'u', model: { modelCode: 'm' }, job: { shot_id: 'x', prompt: 'p' }, slot })
    .run.canvas.nodes.map(n => `${n.position.x},${n.position.y}`);
  const seen = new Set();
  for (let i = 0; i < 15; i++) for (const p of at(i)) { assert.ok(!seen.has(p), `位置重叠 ${p}`); seen.add(p); }
});

test('a rate limit pauses submission until its deadline, then sends one and waits for it to be accepted', async () => {
  const p = platform({ limitAt: 2 });
  p.io.queue = jobs(5);
  const s = p.make();
  await s.start(); await s.tick();
  assert.equal(p.running(), 2, '第三个被限流');
  assert.equal(s.state.status, 'RATE_LIMITED');
  assert.equal(s.state.jobs.s3.status, 'PENDING', '被限流的任务回到队列，不算失败');
  assert.equal(s.state.jobs.s3.attempts, 0);
  p.advance(119_000); await s.tick();
  assert.equal(p.tasks.size, 2, '限流期内不再提交');
  p.advance(2_000); await s.tick();
  assert.equal(p.tasks.size, 3, '到期后先只提交一个');
  await s.tick();
  assert.equal(p.tasks.size, 5, '平台确认接受后，才补其余的');
  assert.ok(p.log.some(e => e.type === 'rate_limit_cleared'));
});

test('a probe is sent only when one of our own tasks has just freed a slot', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(10);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2);
  const before = p.tasks.size;
  for (let i = 0; i < 20; i++) { p.advance(60_000); await s.tick(); }
  assert.equal(p.tasks.size, before, '没有自己的任务完成时，绝不试探');
  p.setCap(5);
  p.finish(1); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 3, '自己的任务完成后才多试一个');
  assert.equal(p.running(), 3);
});

test('capacity climbs back toward the target one completion at a time', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(20);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.full_streak, 1, '同一次轮询里多个被拒只算一次退避');
  p.setCap(5);
  for (let i = 0; i < 6; i++) {
    const done = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
    p.finish(done); p.advance(61_000);
    await s.tick(); await s.tick();
  }
  assert.equal(s.state.capacity, 5, '每完成一个升一档，最终回到 5');
  assert.equal(p.running(), 5);
});
test('consecutive account-full refusals back off 1, 2, 4, then 8 minutes', async () => {
  const p = platform({ cap: 1, asyncCap: true });
  p.io.queue = jobs(12);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  const backoffs = [s.state.last_capacity_rejection.backoff_ms];
  for (let i = 0; i < 4; i++) {
    p.setCap(1); p.advance(20 * 60_000); await s.tick(); await s.tick();   // get one running again
    const done = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
    p.finish(done); p.setCap(0);                                             // ...then the account fills up elsewhere
    await s.tick(); await s.tick();
    backoffs.push(s.state.last_capacity_rejection.backoff_ms);
  }
  assert.deepEqual(backoffs.map(ms => ms / 60_000), [1, 2, 4, 8, 8], '指数退避，最长 8 分钟');
});
test('submissions are spaced by a fresh random gap between 10 and 20 seconds', async () => {
  const p = platform();
  p.io.queue = jobs(5);
  const draws = [0, 1, 0.5, 0.25];
  const s = p.make({ submitGapMs: [10_000, 20_000], random: () => draws.shift() ?? 0.5 });
  await s.start();
  await s.tick();
  assert.equal(p.tasks.size, 1, '一轮只提交一个');
  const gaps = [];
  for (let i = 0; i < 4; i++) {
    const wait = s.state.next_submit_at - s.state.last_submit_at;
    gaps.push(wait);
    p.advance(wait - 1); await s.tick();
    assert.equal(p.tasks.size, i + 1, '间隔未到不提交');
    p.advance(1); await s.tick();
  }
  assert.deepEqual(gaps, [10_000, 20_000, 15_000, 12_500]);
  assert.equal(p.running(), 5);
});

test('material put at the front of the queue while a batch runs is submitted next', async () => {
  const p = platform({ cap: 1 });
  p.io.queue = jobs(4);
  const s = p.make({ idleReloadMs: 0 });
  await s.start(); await s.tick();
  assert.equal(s.state.jobs.s1.status, 'RUNNING');
  p.io.queue = [{ shot_id: 'urgent', prompt: 'p', settings: {} }, ...jobs(4)];
  await s.tick();                       // reload picks up the new order
  p.finish(1); await s.tick(); await s.tick();
  assert.equal(s.state.jobs.urgent.status, 'RUNNING', '排在队首的新素材先提交');
  assert.equal(s.state.jobs.s2.status, 'PENDING');
});

test('after 20 account-full refusals in two hours, probing stops and only refilling continues', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(30);
  const s = p.make({ capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  s.state.rejections = Array.from({ length: 20 }, (_, i) => 1_000_000 + i);   // 20 refusals just now
  p.setCap(5);
  const done = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
  p.finish(done); p.advance(61_000); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2, '达到 20 次后不再试探');
  assert.equal(p.running(), 2, '照常补位');
  assert.ok(p.log.some(e => e.type === 'probe_suppressed'));
  p.advance(2 * 3600e3);                                                       // the window slides past them
  const next = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
  p.finish(next); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 3, '窗口滑过后恢复试探');
});

test('a lost canvas connection pauses submission without spending attempts, and resumes on reconnect', async () => {
  const p = platform();
  p.io.queue = jobs(3);
  let up = false;
  p.api.canvasActive = () => up;
  const persist = p.api.persist;
  p.api.persist = async canvas => { if (!up) throw Object.assign(new Error('down'), { code: 'CANVAS_DISCONNECTED' }); return persist(canvas); };
  const s = p.make();
  await s.start(); await s.tick();
  assert.equal(p.tasks.size, 0, '断线时不提交');
  assert.equal(s.state.jobs.s1.attempts, 0, '不扣重试次数');
  for (let i = 0; i < 5; i++) { p.advance(10_000); await s.tick(); }
  assert.equal(s.state.status, 'CANVAS_DISCONNECTED');
  assert.equal(p.tasks.size, 0);
  assert.ok(Object.values(s.state.jobs).every(j => j.status === 'PENDING'), '没有任务被标成失败');
  up = true;
  await s.tick();
  assert.equal(p.running(), 3, '重连后自动继续');
  assert.ok(p.log.some(e => e.type === 'canvas_reconnected'));
});

test('the free window is 21:00 to 10:00 Taipei time', () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 10, h - 8, m);   // Taipei wall clock -> UTC ms
  assert.equal(inFreeWindow(at(21)), true);
  assert.equal(inFreeWindow(at(23, 59)), true);
  assert.equal(inFreeWindow(at(9, 59)), true);
  assert.equal(inFreeWindow(at(10)), false);
  assert.equal(inFreeWindow(at(15)), false);
  assert.equal(inFreeWindow(at(20, 59)), false);
});

test('outside the free window nothing new is submitted, running work still completes, and it resumes at 21:00', async () => {
  const p = platform();
  p.io.queue = jobs(4);
  let free = true;
  const s = p.make({ freeWindow: () => free });
  await s.start(); await s.tick();
  assert.equal(p.running(), 4);
  free = false;
  p.io.queue = jobs(6);
  s.state.next_reload_at = 0; await s.tick();
  p.finish(1); await s.tick(); await s.tick();
  assert.equal(s.state.jobs.s1.status, 'COMPLETED', '已在跑的照常完成');
  assert.equal(p.tasks.size, 4, '时段外不提交新任务');
  assert.equal(s.state.status, 'OUTSIDE_FREE_WINDOW');
  free = true; await s.tick();
  assert.ok(p.tasks.size > 4, '回到免费时段自动继续');
  assert.ok(p.log.some(e => e.type === 'resumed_free_window'));
});

test('a 605 "insufficient balance" task failure parks the job and pauses until 21:00', async () => {
  // Measured live: outside the free window the submit is accepted, the quote still reads 0,
  // and the task then fails with errorCode 605. Nothing was generated.
  const p = platform();
  p.io.queue = jobs(3);
  const s = p.make();
  await s.start(); await s.tick();
  for (const t of p.tasks.values()) Object.assign(t, { status: 'FAILED', error: 'OpenAPI call failed: taskId is empty. errorCode: 605, errorMessage: 您的账户余额不足，请充值。' });
  await s.tick();
  for (const id of ['s1', 's2', 's3']) {
    assert.equal(s.state.jobs[id].status, 'PENDING', '退回队列');
    assert.equal(s.state.jobs[id].attempts, 0, '不扣重试次数');
  }
  assert.equal(s.state.balance_block_until, nextFreeWindowStart(1_000_000));
  const before = p.tasks.size;
  p.advance(3600e3); await s.tick();
  assert.equal(p.tasks.size, before, '到晚上 9 点前不再提交');
  p.advance(s.state.balance_block_until - 1_000_000); await s.tick();
  assert.ok(p.tasks.size > before, '到点自动继续');
});

test('the next free window start is the coming 21:00 Taipei', () => {
  const at = (d, h, m = 0) => Date.UTC(2026, 9, d, h - 8, m);
  assert.equal(nextFreeWindowStart(at(10, 10, 14)), at(10, 21));
  assert.equal(nextFreeWindowStart(at(10, 21, 0)), at(11, 21));
  assert.equal(nextFreeWindowStart(at(10, 23, 30)), at(11, 21));
  assert.equal(classify(Object.assign(new Error('余额不足'), { code: 605 })).kind, 'insufficient_balance');
});

test('a 605 inside our own free window pauses only ten minutes, not until tomorrow', async () => {
  const p = platform();
  p.io.queue = jobs(2);
  const s = p.make({ freeWindow: () => true });
  await s.start(); await s.tick();
  for (const t of p.tasks.values()) Object.assign(t, { status: 'FAILED', error: 'errorCode: 605, 您的账户余额不足' });
  await s.tick();
  assert.equal(s.state.balance_block_until, 1_000_000 + 10 * 60e3);
});

test('completions while paused do not raise the learned capacity', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(8);
  let free = true;
  const s = p.make({ freeWindow: () => free, capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2);
  free = false; p.advance(120_000);
  for (const [id, t] of p.tasks) if (t.status === 'RUNNING') p.finish(id);
  await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2, '暂停期间完成的任务不会抬高并发');
});

test('each night opens by measuring the real capacity: target reached with no refusal', async () => {
  const p = platform({ cap: 5, asyncCap: true });
  p.io.queue = jobs(10);
  p.io.saved = { capacity: 2, jobs: {} };                // yesterday's lesson
  const s = p.make({ calibrate: true });
  await s.start();
  for (let i = 0; i < 12; i++) await s.tick();
  assert.equal(s.state.calibrating, false);
  assert.equal(s.state.capacity, 5, '今晚平台给 5 个');
  assert.equal(p.running(), 5);
  assert.equal(p.log.filter(e => e.type === 'concurrency_full').length, 0, '没有浪费任何提交');
  assert.equal(p.log.find(e => e.type === 'capacity_calibrated').how, 'reached_target');
});

test('calibration stops at the first refusal, which reveals the night capacity at the cost of one submission', async () => {
  const p = platform({ cap: 3, asyncCap: true });
  p.io.queue = jobs(10);
  const s = p.make({ calibrate: true });
  await s.start();
  for (let i = 0; i < 12; i++) await s.tick();
  assert.equal(s.state.capacity, 3, '今晚平台给 3 个');
  assert.equal(p.log.filter(e => e.type === 'concurrency_full').length, 1, '只被拒 1 次');
  assert.equal(p.running(), 3);
});

test('calibration submits one step at a time and waits for each to be confirmed', async () => {
  const p = platform({ cap: 5, asyncCap: true });
  p.io.queue = jobs(10);
  const s = p.make({ calibrate: true, pollMs: 15_000 });
  await s.start(); await s.tick();
  assert.equal(p.tasks.size, 1, '先只提交一个');
  await s.tick();
  assert.equal(p.tasks.size, 1, '没确认前不提交下一个');
  p.advance(15_000); await s.tick();
  assert.equal(p.tasks.size, 2, '确认后再提交下一个');
});

test('calibration happens once per night, not again after a restart', async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(10);
  const s = p.make({ calibrate: true });
  await s.start();
  for (let i = 0; i < 8; i++) await s.tick();
  assert.equal(p.log.filter(e => e.type === 'calibration_started').length, 1);
  const again = p.make({ calibrate: true });
  await again.start(); for (let i = 0; i < 4; i++) await again.tick();
  assert.equal(p.log.filter(e => e.type === 'calibration_started').length, 1, '同一晚重启不重测');
  assert.equal(again.state.capacity, 2);
});

test('the window key is the Taipei date on which the night window opened', () => {
  const at = (d, h) => Date.UTC(2026, 9, d, h - 8);
  assert.equal(windowKey(at(9, 22)), '2026-10-09');
  assert.equal(windowKey(at(10, 3)), '2026-10-09');
  assert.equal(windowKey(at(10, 21)), '2026-10-10');
});

test('production pacing defaults are the ones chosen by the replay', async () => {
  // Read them back through behaviour: with defaults, a probe waits for a full round of completions.
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(10);
  const s = createScheduler({ api: p.api, io: p.io, canvasId: '9', model: { modelCode: 'm' }, now: () => 1_000_000,
    submitGapMs: 0, pollMs: 0, freeWindow: null, calibrate: false });
  const src = (await import('node:fs')).readFileSync(new URL('../runninghub/rhtv-native-runner.mjs', import.meta.url), 'utf8');
  assert.match(src, /maxBackoffSteps = 6/);
  assert.match(src, /maxRejectionsPerWindow = 6/);
  assert.match(src, /probeAfter = 'round'/);
  await s.start();
});

test("'round' probing waits for as many completions as the current capacity", async () => {
  const p = platform({ cap: 2, asyncCap: true });
  p.io.queue = jobs(12);
  const s = p.make({ probeAfter: 'round', capacityBackoffMs: 60_000 });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2);
  p.setCap(5); p.advance(61_000);
  const first = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
  p.finish(first); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 2, '一轮没跑完，不试');
  const second = [...p.tasks.entries()].find(([, t]) => t.status === 'RUNNING')[0];
  p.finish(second); await s.tick(); await s.tick();
  assert.equal(s.state.capacity, 3, '跑满一轮（2 个）才试 +1');
});

test('a frame that cannot be read is skipped for a minute without spending an attempt', async () => {
  const p = platform();
  p.io.queue = jobs(3);
  const upload = p.api.upload;
  let broken = new Set(['s1']);
  p.api.upload = async job => { if (broken.has(job.shot_id)) throw Object.assign(new Error('首帧取不到'), { code: 'FRAME_UNAVAILABLE' }); return upload(job); };
  const s = p.make();
  await s.start();
  for (let i = 0; i < 4; i++) await s.tick();
  assert.equal(s.state.jobs.s1.status, 'PENDING');
  assert.equal(s.state.jobs.s1.attempts, 0, '不扣重试次数');
  assert.equal(s.state.jobs.s2.status, 'RUNNING', '其他任务照常提交');
  assert.equal(s.state.jobs.s3.status, 'RUNNING');
  broken = new Set();
  p.advance(61_000); await s.tick();
  assert.equal(s.state.jobs.s1.status, 'RUNNING', '首帧恢复后自动提交');
});

test('another account can declare its own free window, or none at all', async () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 10, h - 8, m);
  let clock = at(19, 30);
  const mk = opts => { const p = platform(); p.io.queue = jobs(2);
    return [p, createScheduler({ api: p.api, io: p.io, canvasId: '9', model: { modelCode: 'm' }, now: () => clock,
      submitGapMs: 0, pollMs: 0, calibrate: false, ...opts })]; };
  const [a, sa] = mk({ windowHours: { startHour: 19, endHour: 7, utcOffsetHours: 8 } });
  await sa.start(); await sa.tick();
  assert.equal(a.running(), 2, '19:30 在自定义的 19:00–07:00 时段内，照常提交');
  const [b, sb] = mk({});
  await sb.start(); await sb.tick();
  assert.equal(b.running(), 0, '默认 21:00–10:00，19:30 不提交');
  const [c, sc] = mk({ freeWindow: null });
  await sc.start(); await sc.tick();
  assert.equal(c.running(), 2, 'freeWindow: null 不限时段');
});

test('a logged-out session (412 TOKEN_INVALID) parks every job without spending attempts and resumes on login', async () => {
  // Measured live: 15 minutes of 412s marked 18 queued shots FAILED before this rule existed.
  const p = platform();
  p.io.queue = jobs(4);
  let loggedIn = false;
  const upload = p.api.upload;
  p.api.upload = async job => { if (!loggedIn) throw { code: 412, msg: 'TOKEN_INVALID' }; return upload(job); };
  p.api.authOk = async () => loggedIn;
  const s = p.make();
  await s.start();
  for (let i = 0; i < 6; i++) { p.advance(20_000); await s.tick(); }
  assert.equal(s.state.status, 'AUTH_INVALID');
  assert.ok(Object.values(s.state.jobs).every(j => j.status === 'PENDING' && j.attempts === 0), '没有任务被标成失败');
  assert.equal(p.log.filter(e => e.type === 'auth_invalid').length, 1, '登录失效后不再继续尝试');
  loggedIn = true;
  p.advance(61_000); await s.tick();
  assert.ok(p.log.some(e => e.type === 'auth_restored'));
  assert.equal(p.running(), 4, '重新登录后自动继续');
});

test('a plain {code, msg} rejection is read, and 412 is recognised as a login problem', () => {
  assert.equal(classify({ code: 412, msg: 'TOKEN_INVALID' }).kind, 'auth_invalid');
  assert.match(classify({ code: 412, msg: 'TOKEN_INVALID' }).message, /TOKEN_INVALID/);
  assert.equal(classify(Object.assign(new Error('x'), { code: 605 })).kind, 'insufficient_balance');
});

test('a step that never returns is cut off without spending an attempt, and the queue keeps moving', async () => {
  // Real timers here: the scheduler's own time limit must fire even if the step hangs forever.
  const p = platform();
  p.io.queue = jobs(2);
  let hang = true;
  const persist = p.api.persist;
  p.api.persist = async canvas => { if (hang) return new Promise(() => {}); return persist(canvas); };
  const s = p.make({ stepTimeoutMs: 50 });
  await s.start();
  await s.tick();
  assert.ok(s.state.canvas_down_since, '写入画布超时，按画布问题处理');
  assert.equal(s.state.jobs.s1.attempts, 0, '不扣重试次数');
  assert.equal(s.state.jobs.s1.status, 'PENDING');
  hang = false; p.api.canvasActive = () => true;
  await s.tick();
  assert.equal(p.running(), 2, '恢复后两条都提交');
});

test('a text-to-video job uploads nothing, writes one node and uses the text model', async () => {
  const p = platform();
  const uploads = [];
  const upload = p.api.upload; p.api.upload = async job => { uploads.push(job.shot_id); return upload(job); };
  p.io.queue = [{ shot_id: 'txt', prompt: '西瓜摊', settings: { mode: '文生视频', ratio: '16:9', duration_seconds: 15 } },
                { shot_id: 'img', prompt: '首帧', settings: {} }];
  const s = p.make({ textModel: { modelCode: 'text-video-x-t2va-app' } });
  await s.start(); await s.tick();
  assert.deepEqual(uploads, ['img'], '只有首帧任务上传图片');
  assert.equal(p.running(), 2);
  assert.equal(p.persisted[0].length, 1, '文生视频只写一个视频节点');
  const { run, params } = buildRun({ canvasId: '9', job: p.io.queue[0], model: { modelCode: 't' } });
  assert.equal(run.canvas.nodes[0].data.subType, 'text-video');
  assert.equal(params.firstFrameUrl, undefined);
  assert.deepEqual(run.canvas.edges, []);
});

test('a text job with no free text model is refused, never sent to the paid model', async () => {
  const p = platform();
  p.io.queue = [{ shot_id: 'txt', prompt: 'p', settings: { mode: '文生视频' } }];
  const s = p.make({ textModel: null, maxAttempts: 1 });
  await s.start(); await s.tick();
  assert.equal(p.tasks.size, 0);
  assert.equal(isTextJob({ settings: {} }), false, '没写模式的任务绝不当成文生视频');
});

// ---- 首尾帧 (start-end-video) and 全能参考 (multimodal-video, r2v) ------------------------------------

test('each job names its mode; 首帧 stays the default and nothing is inferred from material', () => {
  assert.equal(jobMode({ settings: {} }), 'first');
  assert.equal(jobMode({ settings: { mode: '首帧' } }), 'first');
  assert.equal(jobMode({ settings: { mode: '首尾帧' } }), 'first_last');
  assert.equal(jobMode({ settings: { mode: '全能参考' } }), 'reference');
  assert.equal(jobMode({ settings: { mode: '文生视频' } }), 'text');
  assert.equal(jobMode({ mode: 'first_last' }), 'first_last');
  assert.equal(jobMode({ mode: 'reference' }), 'reference');
  assert.equal(jobMode({ reference_count: 3, settings: {} }), 'first', '有参考图数量也不会自动换模式');
  assert.deepEqual(SUBTYPES, { first: 'start-video', first_last: 'start-end-video', reference: 'multimodal-video', text: 'text-video' });
});

test('only a free H3 Enhanced -app model of the right type is picked, never a guess', () => {
  const groups = [
    { type: 'START_END_VIDEO', modelList: [{ modelCode: 'minimax-h3-rh-enhanced-fl2va' }, { modelCode: 'minimax-h3-rh-enhanced-fl2va-app' }, { modelCode: 'kling-x-app' }] },
    { type: 'MULTIMODAL_VIDEO', modelList: [{ modelCode: 'multimodal-video-minimax-h3-rh-enhanced-r2va-app' }, { modelCode: 'minimax-h3-rh-enhanced-r2va' }] },
    { type: 'START_VIDEO', modelList: [{ modelCode: 'minimax-h3-rh-enhanced-i2va-app' }] },
  ];
  assert.equal(pickModel(groups, 'START_END_VIDEO').modelCode, 'minimax-h3-rh-enhanced-fl2va-app', '不带 -app 的收费版不选');
  assert.equal(pickModel(groups, 'MULTIMODAL_VIDEO', /minimax-h3-rh-enhanced-r2va?-app$/).modelCode, 'multimodal-video-minimax-h3-rh-enhanced-r2va-app');
  assert.equal(pickModel(groups, 'IMAGE_VIDEO'), null);
  const two = [{ type: 'MULTIMODAL_VIDEO', modelList: [{ modelCode: 'minimax-h3-rh-enhanced-a-app' }, { modelCode: 'minimax-h3-rh-enhanced-b-app' }] }];
  assert.equal(pickModel(two, 'MULTIMODAL_VIDEO'), null, '两个候选又没有首选时不猜');
  assert.equal(pickModel(two, 'MULTIMODAL_VIDEO', /-b-app$/).modelCode, 'minimax-h3-rh-enhanced-b-app');
  assert.equal(pickModel([{ type: 'START_END_VIDEO', modelList: [{ modelCode: 'minimax-h3-rh-enhanced-fl2va' }] }], 'START_END_VIDEO'), null, '只有收费版时不选');
});

test('only a quote with a currency and a zero total counts as free', () => {
  assert.equal(isZeroQuote({ currency: 'CNY', totalPrice: 0 }), true);
  assert.equal(isZeroQuote({ currency: 'CNY', totalPrice: 0.5 }), false);
  assert.equal(isZeroQuote({ currency: null, totalPrice: 0 }), false, '报价接口失败时网站也返回 0，但没有币种');
  assert.equal(isZeroQuote({ error: 'x' }), false);
  assert.equal(isZeroQuote({ totalPrice: 0, unitPaidPrice: 3.75, currency: 'CNY', freeLimit: true }), false, '单价不为 0 的不算会员免费');
  // Measured 2026-10-12 on the -app models.
  assert.equal(isZeroQuote({ totalPrice: 0, discountTotalPrice: 0, unitPaidPrice: 0, currency: 'CNY', freeLimit: false, freeLimitCount: null }), true);
  assert.equal(isZeroQuote(undefined), false);
});

const flJob = (extra = {}) => ({ shot_id: 'fl', prompt: 'p', settings: { mode: '首尾帧', ratio: '9:16', duration_seconds: 10 }, ...extra });
const refJob = (n, extra = {}) => ({ shot_id: 'rf', prompt: 'p', settings: { mode: '全能参考' }, reference_count: n, ...extra });

test('首尾帧 links first then last frame to a start-end-video node', () => {
  const { run, params, imageIds } = buildRun({ canvasId: '9', job: flJob(), imageUrl: 'https://cdn/a.png', lastImageUrl: 'https://cdn/b.png',
    model: { modelCode: 'fl-app' }, ids: { videoId: 'v', imageIds: ['i1', 'i2'] } });
  const [video, first, last] = run.canvas.nodes;
  assert.equal(video.data.subType, 'start-end-video');
  assert.equal(video.data.modelCode, 'fl-app');
  assert.deepEqual(imageIds, ['i1', 'i2']);
  assert.deepEqual(run.canvas.edges.map(e => [e.source, e.target]), [['i1', 'v'], ['i2', 'v']], '先首帧后尾帧');
  assert.deepEqual([first.data.sourceObjects, last.data.sourceObjects], [['https://cdn/a.png'], ['https://cdn/b.png']]);
  assert.deepEqual(params, { prompt: 'p', aspectRatio: '9:16', resolution: '768p', duration: '10', audioMode: 'native',
    firstFrameUrl: 'https://cdn/a.png', lastFrameUrl: 'https://cdn/b.png' });
  // Parameter names follow the model's config, as the site does.
  const named = buildRun({ canvasId: '9', job: flJob(), imageUrl: 'a', lastImageUrl: 'b',
    model: { modelCode: 'fl-app', config: JSON.stringify([{ type: 'firstImageUrl', paramName: 'img_start' }, { type: 'lastImageUrl', paramName: 'img_end' }]) } });
  assert.equal(named.params.img_start, 'a');
  assert.equal(named.params.img_end, 'b');
  assert.throws(() => buildRun({ canvasId: '9', job: flJob(), imageUrl: 'a', model: { modelCode: 'm' } }), e => e.code === 'MATERIAL_INVALID', '缺尾帧不降级为首帧');
});

test('全能参考 links every reference in order to a multimodal-video node and refuses too many', () => {
  const model = { modelCode: 'r2va-app', config: [{ type: 'imageUrls', paramName: 'imageUrls', maxNum: 3 }] };
  const { run, params } = buildRun({ canvasId: '9', job: refJob(3), referenceUrls: ['u1', 'u2', 'u3'], model, ids: { videoId: 'v', imageIds: ['a', 'b', 'c'] } });
  assert.equal(run.canvas.nodes[0].data.subType, 'multimodal-video');
  assert.deepEqual(params.imageUrls, ['u1', 'u2', 'u3']);
  assert.equal(params.firstFrameUrl, undefined);
  assert.deepEqual(run.canvas.edges.map(e => e.source), ['a', 'b', 'c']);
  assert.equal(run.canvas.nodes.length, 4);
  assert.equal(referenceLimit(model), 3);
  assert.equal(referenceLimit({ config: [] }), Infinity);
  assert.throws(() => buildRun({ canvasId: '9', job: refJob(4), referenceUrls: ['1', '2', '3', '4'], model }), e => e.code === 'MATERIAL_INVALID', '超上限不截断');
  assert.throws(() => buildRun({ canvasId: '9', job: refJob(0), referenceUrls: [], model }), e => e.code === 'MATERIAL_INVALID');
  // Tiles for up to nine references stay inside the slot's 1000 x 900 cell.
  const nine = buildRun({ canvasId: '9', job: refJob(9), referenceUrls: Array(9).fill('u'), model: { modelCode: 'm' }, slot: 0 });
  for (const n of nine.run.canvas.nodes) assert.ok(n.position.x + n.style.width <= 1000 && n.position.y + n.style.height <= 900);
});

function modePlatform({ quote = { currency: 'CNY', totalPrice: 0 } } = {}) {
  const p = platform();
  p.uploads = [];
  p.runs = [];
  p.api.upload = async (job, which) => { p.uploads.push([job.shot_id, which ?? 'first']); return `https://cdn/${job.shot_id}-${which ?? 'first'}.png`; };
  const run = p.api.run;
  p.api.run = async (r, o) => { p.runs.push(r); return run(r, o); };
  p.api.quote = async () => quote;
  return p;
}
const models = { first_last: { modelCode: 'h3-fl-app' }, reference: { modelCode: 'h3-r2va-app', config: [{ type: 'imageUrls', paramName: 'imageUrls', maxNum: 4 }] } };

test('the real H3 全能参考 config fills refImage1..N in order, nine at most', () => {
  // Shape captured from the platform model list on 2026-10-12.
  const slot = n => ({ type: `stringImageUrl${n}`, display: true, maxSize: 100, required: false, paramName: `refImage${n}`, paramDataType: 'string' });
  const model = { modelCode: 'multimodal-video-rhart-video-minimax-h3-rh-enhanced-ref2va-app', config: [
    { type: 'prompt', paramName: 'prompt' }, { type: 'imageDynamicParams', paramNames: [] }, ...[3, 1, 2, 4, 5, 6, 7, 8, 9].map(slot), { type: 'list', paramName: 'audioMode' }] };
  assert.equal(referenceLimit(model), 9);
  const { params } = buildRun({ canvasId: '9', job: refJob(3), referenceUrls: ['a', 'b', 'c'], model });
  assert.deepEqual([params.refImage1, params.refImage2, params.refImage3, params.refImage4], ['a', 'b', 'c', undefined]);
  assert.equal(params.imageUrls, undefined);
  assert.throws(() => buildRun({ canvasId: '9', job: refJob(10), referenceUrls: Array(10).fill('u'), model }), e => e.code === 'MATERIAL_INVALID');
  // The real code names pass the picker.
  const groups = [{ type: 'MULTIMODAL_VIDEO', modelList: [{ modelCode: 'multimodal-video-minimax-hailuo-h3' }, model, { modelCode: 'multimodal-video-rhart-video-minimax-h3-rh-enhanced-ref2va' }] },
    { type: 'START_END_VIDEO', modelList: [{ modelCode: 'start-end-video-rhart-video-minimax-h3-rh-enhanced-i2va' }, { modelCode: 'start-end-video-rhart-video-minimax-h3-rh-enhanced-i2va-app' }] }];
  assert.equal(pickModel(groups, 'MULTIMODAL_VIDEO', /minimax-h3-rh-enhanced-(?:ref2va|r2va?)-app$/), model);
  assert.equal(pickModel(groups, 'START_END_VIDEO').modelCode, 'start-end-video-rhart-video-minimax-h3-rh-enhanced-i2va-app');
});

test('a 首尾帧 job uploads both frames and submits the start-end graph with its own model', async () => {
  const p = modePlatform();
  p.io.queue = [flJob(), { shot_id: 'plain', prompt: 'p', settings: {} }];
  const s = p.make({ models, generateNum: 2 });
  await s.start(); await s.tick();
  assert.deepEqual(p.uploads, [['fl', 'first'], ['fl', 'last'], ['plain', 'first']], '首帧模式仍只传一张');
  const [fl, plain] = p.runs;
  const video = fl.canvas.nodes.find(n => n.type === 'rh-video');
  assert.equal(video.data.subType, 'start-end-video');
  assert.equal(video.data.modelCode, 'h3-fl-app');
  assert.equal(video.data.generateNum, 2, 'generateNum 照常生效');
  assert.equal(fl.canvas.edges.length, 2);
  assert.equal(video.data.params.lastFrameUrl, 'https://cdn/fl-last.png');
  assert.equal(plain.canvas.nodes[0].data.modelCode, 'm-app');
  assert.equal(plain.canvas.nodes[0].data.subType, 'start-video');
  assert.equal(s.state.jobs.fl.status, 'RUNNING');
  assert.equal(p.persisted[0].length, 3, '视频节点和两张图都先写进画布');
  p.finish(1); await s.tick();
  assert.equal(s.state.jobs.fl.status, 'COMPLETED', '结果查询沿用原逻辑');
});

test('a 全能参考 job uploads every reference in order', async () => {
  const p = modePlatform();
  p.io.queue = [refJob(3)];
  const s = p.make({ models });
  await s.start(); await s.tick();
  assert.deepEqual(p.uploads, [['rf', 'ref/1'], ['rf', 'ref/2'], ['rf', 'ref/3']]);
  const video = p.runs[0].canvas.nodes.find(n => n.type === 'rh-video');
  assert.equal(video.data.subType, 'multimodal-video');
  assert.deepEqual(video.data.params.imageUrls, ['https://cdn/rf-ref/1.png', 'https://cdn/rf-ref/2.png', 'https://cdn/rf-ref/3.png']);
  assert.equal(s.state.jobs.rf.status, 'RUNNING');
});

test('wrong material fails that shot before any upload, and the rest keep going', async () => {
  const p = modePlatform();
  p.io.queue = [refJob(5, { shot_id: 'many' }), refJob(0, { shot_id: 'none' }), { shot_id: 'ok', prompt: 'p', settings: {} }];
  const s = p.make({ models });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.jobs.many.status, 'FAILED', '超过模型上限 4 张');
  assert.match(s.state.jobs.many.last_error, /最多 4 张/);
  assert.equal(s.state.jobs.none.status, 'FAILED');
  assert.equal(s.state.jobs.ok.status, 'RUNNING');
  assert.deepEqual(p.uploads, [['ok', 'first']], '素材不对的镜头一张都不上传');
  assert.equal(p.runs.length, 1);
  assert.equal(p.log.filter(e => e.type === 'material_invalid').length, 2);
});

test('a new-mode job with a non-zero quote is never written or submitted', async () => {
  const p = modePlatform({ quote: { currency: 'CNY', totalPrice: 1.2 } });
  p.io.queue = [flJob()];
  const s = p.make({ models });
  await s.start(); await s.tick(); await s.tick();
  assert.equal(s.state.jobs.fl.status, 'FAILED');
  assert.equal(p.runs.length, 0);
  assert.equal(p.persisted.length, 0, '询价不为 0 时连画布都不写');
  assert.equal(p.log.filter(e => e.type === 'quote_not_free').length, 1);
});

test('first-frame and text jobs also refuse paid, failed, or unknown quotes before submission', async () => {
  for (const mode of ['first', 'text']) for (const quote of [
    { currency: 'CNY', totalPrice: 1 }, { totalPrice: 0 }, { error: 'synthetic failure' },
  ]) {
    const p = modePlatform({ quote });
    p.io.queue = [{ shot_id: 'demo', prompt: 'synthetic prompt',
      settings: { mode: mode === 'text' ? '文生视频' : '首帧' } }];
    const s = p.make({ textModel: { modelCode: 'demo-t2va-app' }, models });
    await s.start(); await s.tick();
    assert.equal(s.state.jobs.demo.status, 'FAILED');
    assert.equal(p.runs.length, 0);
    assert.equal(p.persisted.length, 0);
  }
});

test('a mode whose free model is missing never submits with another model', async () => {
  const p = modePlatform();
  p.io.queue = [flJob()];
  const s = p.make({ models: { reference: models.reference }, maxAttempts: 2 });
  await s.start(); await s.tick(); await s.tick(); await s.tick();
  assert.equal(p.runs.length, 0);
  assert.equal(s.state.jobs.fl.status, 'FAILED');
  assert.match(s.state.jobs.fl.last_error, /首尾帧模型/);
});

test('a reload after persisting reuses the same nodes for every image', async () => {
  const p = modePlatform();
  p.io.queue = [flJob()];
  const first = p.make({ models });
  await first.start(); await first.tick();
  const saved = p.io.saved.jobs.fl;
  assert.equal(saved.image_node_ids.length, 2);
  // Simulate a crash between persist and the taskId.
  Object.assign(p.io.saved.jobs.fl, { status: 'SUBMITTING', task_id: null });
  const second = p.make({ models });
  await second.start(); await second.tick();
  const rerun = p.runs.at(-1);
  assert.deepEqual(rerun.canvas.edges.map(e => e.source), saved.image_node_ids, '重提沿用已写入画布的节点');
  assert.equal(p.uploads.filter(u => u[0] === 'fl').length, 2, '已上传的素材不重复上传');
});

// ---- single instance, stop switch, run info, lost hand-overs --------------------------------

const instance = { instance_id: 'i-1', canvasId: '9', code_version: { sha256: 'abc', git: 'def' } };
// A fake server lease: one holder at a time; `stop` is what the next heartbeat answers.
function lease(p, { holder = null } = {}) {
  const calls = { register: [], heartbeat: [], unregister: [] };
  const server = { holder, stop: null, calls, down: false };
  p.io.register = async info => {
    calls.register.push(info);
    if (server.holder && server.holder !== info.instance_id) return { ok: false, active: { instance_id: server.holder, heartbeat_age_s: 12, info: { canvasId: '7' } } };
    server.holder = info.instance_id; return { ok: true };
  };
  p.io.heartbeat = async info => {
    calls.heartbeat.push(info);
    if (server.down) throw new Error('ECONNREFUSED');
    return server.stop ? { ok: true, stop: true, reason: server.stop } : { ok: true, stop: false };
  };
  p.io.unregister = async id => { calls.unregister.push(id); if (server.holder === id) server.holder = null; };
  return server;
}

test('a second runner on the same batch is refused at start and submits nothing', async () => {
  const p = platform();
  p.io.queue = jobs(3);
  lease(p, { holder: 'other' });
  const s = p.make({ instance });
  await assert.rejects(s.start(), e => e.code === 'INSTANCE_ACTIVE' && /other/.test(e.message) && /--stop/.test(e.message));
  assert.equal(p.running(), 0);
  assert.equal(p.io.saved, null, '被拒的实例不写状态');
});

test('the runner heartbeats every tick and stops itself when the server says so', async () => {
  const p = platform();
  p.io.queue = jobs(8);
  const server = lease(p);
  let ticks = 0;
  const s = p.make({ instance, concurrency: 2, sleep: async () => { if (++ticks === 2) server.stop = 'manual stop'; } });
  await s.loop();
  assert.ok(server.calls.heartbeat.length >= 3, '每轮都续心跳');
  assert.equal(server.calls.heartbeat[0].instance_id, 'i-1');
  assert.equal(p.io.saved.status, 'STOPPED');
  assert.equal(p.io.saved.stop_reason, 'manual stop');
  assert.deepEqual(server.calls.unregister, ['i-1'], '停止后注销');
  assert.equal(server.holder, null);
  assert.equal(p.running(), 2, '停止不取消已提交的任务，也不再提交新的');
  assert.ok(p.log.some(e => e.type === 'stop_acknowledged'));
});

test('an unreachable server never stops production', async () => {
  const p = platform();
  p.io.queue = jobs(3);
  const server = lease(p);
  server.down = true;
  const s = p.make({ instance });
  await s.start();
  await s.tick();
  assert.equal(p.running(), 3);
  assert.equal(s.state.status, 'RUNNING');
});

test('the state reports generateNum, concurrency, code version, canvas and start time', async () => {
  const p = platform();
  p.io.queue = jobs(1);
  const server = lease(p);
  const s = p.make({ instance, concurrency: 2, generateNum: 2 });
  await s.start();
  assert.deepEqual(p.io.saved.instance, { instance_id: 'i-1', canvasId: '9', code_version: { sha256: 'abc', git: 'def' },
    generateNum: 2, concurrency: 2, started_at: new Date(1_000_000).toISOString() });
  assert.equal(server.calls.register[0].generateNum, 2, '登记时把设置一并报给服务');
});

test('without an instance nothing is registered (tests, older servers)', async () => {
  const p = platform();
  p.io.queue = jobs(1);
  const server = lease(p);
  const s = p.make();
  await s.start(); await s.tick();
  assert.equal(server.calls.register.length + server.calls.heartbeat.length, 0);
});

test('a failed hand-over to the server is recorded and the outputs stay in the state for backfill', async () => {
  const p = platform();
  p.io.queue = jobs(2);
  p.io.done = async () => { throw new Error('SERVER_500'); };
  const s = p.make();
  await s.start(); await s.tick();
  p.finish(1);
  await s.tick();
  const j = p.io.saved.jobs.s1;
  assert.equal(j.status, 'COMPLETED');
  assert.deepEqual(j.outputs, ['https://cdn/out-1.mp4']);
  assert.equal(j.delivered, false);
  assert.ok(p.log.some(e => e.type === 'done_failed' && e.shot_id === 's1'));
  assert.equal(s.state.jobs.s2.status, 'RUNNING', '队列照常推进');
});

test('the build placeholder the server fills in is present verbatim', async () => {
  assert.deepEqual(RUNNER_BUILD, { sha256: null, git: null });
  const src = await fs.readFile(new URL('../runninghub/rhtv-native-runner.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('export const RUNNER_BUILD = { sha256: null, git: null };'));
});
