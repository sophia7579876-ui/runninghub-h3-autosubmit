// Continuous RunningHub submitter that runs inside the logged-in rhtv page.
// No UI clicks: upload, submit and status all go through the page's own authenticated
// module functions. Their minified export names change on every site release, so they are
// resolved at runtime from stable anchors (the API paths they call), never hard-coded.
//
// Core loop: keep up to `concurrency` tasks running; the moment one finishes, submit the next;
// on a platform rate limit (code 1859) wait out retryAfterSeconds, then continue.

// Filled in by rhtv-native-server.py when it serves this file (hash of the file on disk + git commit),
// so a running page can say which code it runs. Keep this line exactly as it is.
export const RUNNER_BUILD = { sha256: null, git: null };

export const MODEL_CODE = /minimax-h3-rh-enhanced-i2va-app$/;
// Text-to-video member model; the same name without -app is excluded.
export const TEXT_MODEL_CODE = /minimax-h3-rh-enhanced-t2va-app$/;
/** A job is text-to-video only when it says so; a missing image is never silently accepted. */
export const isTextJob = job => job?.settings?.mode === '文生视频' || job?.mode === 'text';

// Other H3 member modes are separate model codes in the platform list, grouped by type.
// All modes must pass the explicit zero-quote gate at submission time.
export const MEMBER_H3 = /minimax-h3-rh-enhanced[\w-]*-app$/;
export const REFERENCE_MODEL_CODE = /minimax-h3-rh-enhanced-(?:ref2va|r2va?)-app$/;
/** Video node mode (data.subType) per job mode. */
export const SUBTYPES = { first: 'start-video', first_last: 'start-end-video', reference: 'multimodal-video', text: 'text-video' };
const SETTINGS_MODES = { 首帧: 'first', 首尾帧: 'first_last', 全能参考: 'reference', 文生视频: 'text' };
/** first / first_last / reference / text. Named by the queue (settings.mode) or the job; 首帧 when absent. */
export function jobMode(job) {
  if (isTextJob(job)) return 'text';
  return SETTINGS_MODES[job?.settings?.mode] ?? (SUBTYPES[job?.mode] ? job.mode : 'first');
}

/**
 * The member model for one mode from a /canvas/model/list answer ([{type, modelList}]). Only an -app
 * code of H3 Enhanced in that type's group qualifies; more than one candidate without a preferred
 * match is ambiguous and yields null rather than a guess.
 */
export function pickModel(groups, type, preferred = null) {
  const found = (groups ?? []).filter(g => g?.type === type).flatMap(g => g.modelList ?? [])
    .filter(m => MEMBER_H3.test(m?.modelCode ?? ''));
  const unique = [...new Map(found.map(m => [m.modelCode, m])).values()];
  const best = preferred ? unique.filter(m => preferred.test(m.modelCode)) : [];
  return best.length === 1 ? best[0] : unique.length === 1 ? unique[0] : null;
}

const configOf = model => {
  const c = model?.config;
  if (Array.isArray(c)) return c;
  try { const v = typeof c === 'string' ? JSON.parse(c) : null; return Array.isArray(v) ? v : []; } catch { return []; }
};
const paramOf = (model, ...types) => configOf(model).find(c => types.includes(c?.type) && c.paramName);
// Measured 2026-10-12: the H3 全能参考 model takes references as one parameter per image
// (stringImageUrl1..9 -> refImage1..refImage9); the site fills them in order and leaves unused ones out.
const referenceSlots = model => configOf(model).filter(c => /^stringImageUrl\d+$/.test(c?.type ?? '') && c.paramName)
  .sort((a, b) => Number(a.type.slice(14)) - Number(b.type.slice(14))).map(c => c.paramName);
/** How many reference images the model takes: its per-image slots, else its imageUrls / imageRef maxNum. */
export function referenceLimit(model) {
  const slots = referenceSlots(model).length;
  if (slots) return slots;
  const n = Number(paramOf(model, 'imageUrls', 'imageRef')?.maxNum);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

/** A quote that really says "free": a known currency and a total of 0. A failed quote also reads 0
 *  in the site's own helper (with no currency), so that is not proof of a free submission. */
export function isZeroQuote(q) {
  return !!q && !q.error && q.currency != null && Number(q.totalPrice) === 0 && Number(q.unitPaidPrice ?? 0) === 0;
}

/** The member free window, 21:00-10:00 Asia/Taipei. Outside it no new task is submitted. */
export function inFreeWindow(ms, { startHour = 21, endHour = 10, utcOffsetHours = 8 } = {}) {
  const hour = new Date(ms + utcOffsetHours * 3600e3).getUTCHours();
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

const esc = s => s.replace(/[$]/g, '\\$');
const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };

/** Resolve the module exports we need from the bundle text. Throws on any ambiguity. */
export function discoverApi(t) {
  const fnAt = i => {
    const s = Math.max(t.lastIndexOf('async function ', i), t.lastIndexOf('function ', i));
    return t.slice(s).match(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/)?.[1] ?? null;
  };
  // A function body ends where the next declaration begins: short functions sit right next to others.
  const bodyOf = fn => {
    const s = t.indexOf(`function ${fn}(`); if (s < 0) return '';
    const next = t.slice(s + 9, s + 4000).search(/(?:async )?function [A-Za-z_$][\w$]*\(/);
    return t.slice(s, next < 0 ? s + 4000 : s + 9 + next);
  };
  const exportOf = fn => {
    const found = [...new Set([...t.matchAll(new RegExp(`(?:^|[,{\\s])${esc(fn)} as ([A-Za-z_$][\\w$]*)`, 'g'))].map(m => m[1]))];
    if (found.length !== 1) fail('API_EXPORT_CHANGED', `${fn} 导出数为 ${found.length}`);
    return found[0];
  };
  const exported = fn => { try { exportOf(fn); return true; } catch { return false; } };
  const byEndpoint = ep => {
    const hits = [];
    for (let i = t.indexOf(`"${ep}"`); i >= 0; i = t.indexOf(`"${ep}"`, i + 1)) hits.push(fnAt(i));
    const fns = [...new Set(hits)];
    if (fns.length !== 1) fail('API_ANCHOR_CHANGED', `${ep} 定位到 ${fns.length} 个函数`);
    return fns[0];
  };
  const callersOf = fn => [...new Set([...t.matchAll(new RegExp(`(?<![\\w$.])${esc(fn)}\\(`, 'g'))]
    .map(m => fnAt(m.index)).filter(c => c && c !== fn))];

  const run = byEndpoint('/canvas/task/run');
  const client = t.match(/([A-Za-z_$][\w$]*)\.post\("\/canvas\/task\/run"/)?.[1];
  if (!client) fail('API_ANCHOR_CHANGED', '找不到鉴权请求客户端');
  const price = byEndpoint('/canvas/price/calculate');
  const quote = [...new Set([...t.matchAll(new RegExp(`(?<![\\w$.])${esc(price)}\\(\\{skuId:`, 'g'))].map(m => fnAt(m.index)))]
    .filter(f => exported(f) && /e\?\.skuId/.test(bodyOf(f).slice(0, 120)) && /currency:/.test(bodyOf(f)));
  // Upload: credentials endpoint -> its single caller -> the exported single-file uploader.
  const creds = byEndpoint('/api/storage/getCredentials');
  const session = callersOf(creds);
  if (session.length !== 1) fail('API_ANCHOR_CHANGED', `上传会话函数 ${session.length} 个`);
  const upload = callersOf(session[0]).filter(f => exported(f) && !/concurrency/.test(bodyOf(f)));
  if (quote.length !== 1) fail('API_ANCHOR_CHANGED', `报价函数 ${quote.length} 个`);
  // The canvas store: the one factory every "X().pasteGraph(" call goes through.
  const stores = [...new Set([...t.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\(\)\.pasteGraph\(/g)].map(m => m[1]))];
  if (stores.length !== 1) fail('API_ANCHOR_CHANGED', `画布存储 ${stores.length} 个`);
  if (upload.length !== 1) fail('API_ANCHOR_CHANGED', `上传函数 ${upload.length} 个`);
  return { client: exportOf(client), run: exportOf(run), quote: exportOf(quote[0]), upload: exportOf(upload[0]),
    status: exportOf(byEndpoint('/canvas/task/batchStatus')), detail: exportOf(byEndpoint('/canvas/getCanvasDetail')),
    store: exportOf(stores[0]) };
}

// Measured 2026-10-09: when the account is full the submit still returns a taskId, and the task
// then fails with errorCode 1520. Nothing was generated, so it is a wait, never a failure.
export const CAPACITY_ERROR = /\b1520\b|并发已达上限|并发|concurrency limit|concurren/i;

// Measured 2026-10-10 10:14 Taipei: outside the free window the submit still returns a taskId and the
// quote still reads 0, but the task then fails with errorCode 605 "账户余额不足". Nothing was generated.
export const BALANCE_ERROR = /\b605\b|余额不足|insufficient balance/i;

// Measured 2026-10-10 21:00: after the account was logged out, every upload-credential request
// answered {code: 412, msg: "TOKEN_INVALID"} while other calls still worked. Nothing was submitted.
export const AUTH_ERROR = /TOKEN_INVALID|token[ _-]?(invalid|expired)|未登录|登录(已)?(过期|失效)/i;

/** The next start of the free window after `ms` (21:00 Taipei by default). */
export function nextFreeWindowStart(ms, { startHour = 21, utcOffsetHours = 8 } = {}) {
  const local = new Date(ms + utcOffsetHours * 3600e3);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), startHour) - utcOffsetHours * 3600e3;
  return start > ms ? start : start + 24 * 3600e3;
}

/** Which nightly window `ms` belongs to: the Taipei date on which that window opened. */
export function windowKey(ms, opts = {}) {
  const offset = (opts.utcOffsetHours ?? 8) * 3600e3;
  return new Date(nextFreeWindowStart(ms, opts) - 24 * 3600e3 + offset).toISOString().slice(0, 10);
}

/** What a failed submit means for scheduling. */
export function classifySubmitError(error) {
  const body = error?.payload ?? error?.response?.data ?? {};
  const code = Number(error?.code ?? body?.code);
  // Some page clients reject with a plain {code, msg} object rather than an Error.
  const text = `${error?.message ?? ''} ${error?.msg ?? ''} ${body?.msg ?? ''}`;
  if (AUTH_ERROR.test(text) || ((code === 412 || code === 401) && !BALANCE_ERROR.test(text)))
    return { kind: 'auth_invalid', code, message: text.trim() || `code ${code}` };
  if (code === 1859) {
    const s = Number(body?.errorMessages?.retryAfterSeconds);
    return { kind: 'rate_limited', code, retryAfterMs: Number.isFinite(s) && s >= 0 ? s * 1000 : 300000,
      scope: body?.errorMessages?.limitScope ?? null, message: body?.msg ?? error?.message };
  }
  if (code === 605 || BALANCE_ERROR.test(text)) return { kind: 'insufficient_balance', code, message: text.trim() };
  if (code === 1520 || CAPACITY_ERROR.test(text)) return { kind: 'concurrency_full', code, message: text.trim() };
  return { kind: 'error', code: Number.isFinite(code) ? code : null, message: text.trim() };
}

/** Status of our node inside a batchStatus task row. */
export function classifyTask(task, nodeId) {
  if (!task) return { status: 'unknown' };
  const plan = (task.plans ?? []).find(p => p.nodeId === nodeId) ?? (task.plans?.length === 1 ? task.plans[0] : null);
  const s = String(plan?.status ?? task.status ?? '').toUpperCase();
  const videos = (plan?.outputs ?? []).filter(o => o?.success === true && o.code === 0 && /^https:\/\//.test(o.url ?? ''));
  if (s === 'SUCCESS' && videos.length) return { status: 'completed', urls: videos.map(o => o.url) };
  if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED'].includes(s)) {
    const error = plan?.errorMessage ?? task.errorMessage ?? s;
    if (BALANCE_ERROR.test(String(error))) return { status: 'insufficient_balance', error };
    return { status: CAPACITY_ERROR.test(String(error)) ? 'capacity_full' : 'failed', error };
  }
  return { status: 'running', api_status: s };
}

/** Videos per submission: the site's "生成数量" 1x/2x (a count, not a speed). The platform counts
 *  concurrency per task, so 2x yields two takes at no slot cost; the default is one. A job's
 *  `settings.generate_num` wins over the runner-wide `generateNum` option. */
export const DEFAULT_GENERATE_NUM = 1;

/** Build the run graph the site itself submits: image -> start-frame video, or a lone text-video node.
 *  首尾帧 links two images (first, then last); 全能参考 links every reference image in order. */
export function buildRun({ canvasId, job, imageUrl, lastImageUrl, referenceUrls, model, now = Date.now(), ids, slot = 0, generateNum = DEFAULT_GENERATE_NUM }) {
  const count = job.settings?.generate_num ?? generateNum;
  const mode = jobMode(job);
  if (mode === 'text') return buildTextRun({ canvasId, job, model, now, ids, slot, count });
  if (mode !== 'first') return buildMultiRun({ canvasId, job, mode, imageUrl, lastImageUrl, referenceUrls, model, now, ids, slot, count });
  const rand = () => Math.random().toString(36).slice(2, 9);
  const videoId = ids?.videoId ?? `node_${now}_${rand()}`, imageId = ids?.imageIds?.[0] ?? ids?.imageId ?? `node_${now}_${rand()}`;
  // One row of five pairs per round, so nodes written to the canvas never overlap.
  const x = (slot % 5) * 1000, y = Math.floor(slot / 5) * 900;
  const s = job.settings ?? {};
  const params = { prompt: job.prompt, aspectRatio: s.ratio ?? '16:9', resolution: s.resolution ?? '768p',
    duration: String(s.duration_seconds ?? 15), audioMode: 'native', firstFrameUrl: imageUrl };
  return { videoId, params, run: { canvasId, targetType: 'NODE', targetId: videoId, canvas: {
    nodes: [
      { id: videoId, type: 'rh-video', position: { x: x + 520, y }, selectable: true, style: { width: 380, height: 220 },
        data: { label: '视频', title: job.shot_id, width: 380, height: 214, generateNum: count,
          maxConnect: { image: null, text: null, video: null }, modelCode: model.modelCode, subType: 'start-video',
          status: 'idle', output: [], prompt: job.prompt, params } },
      { id: imageId, type: 'rh-image', position: { x, y }, selectable: true, style: { width: 480, height: 270 },
        data: { label: `${job.shot_id}.png`, title: job.shot_id, width: 480, height: 270, aspectRatio: params.aspectRatio,
          sourceObjects: [imageUrl], status: 'idle', subType: 'text-image' } },
    ], edges: [{ id: `e-${imageId}-${videoId}`, source: imageId, target: videoId, sourceHandle: 'output', targetHandle: 'input', type: 'default' }] } },
    imageId, imageIds: [imageId] };
}

function buildTextRun({ canvasId, job, model, now, ids, slot, count }) {
  const videoId = ids?.videoId ?? `node_${now}_${Math.random().toString(36).slice(2, 9)}`;
  const x = (slot % 5) * 1000, y = Math.floor(slot / 5) * 900;
  const s = job.settings ?? {};
  const params = { prompt: job.prompt, aspectRatio: s.ratio ?? '16:9', resolution: s.resolution ?? '768p',
    duration: String(s.duration_seconds ?? 15), audioMode: 'native' };
  return { videoId, params, imageId: null, imageIds: [], run: { canvasId, targetType: 'NODE', targetId: videoId, canvas: {
    nodes: [{ id: videoId, type: 'rh-video', position: { x: x + 520, y }, selectable: true, style: { width: 380, height: 220 },
      data: { label: '视频', title: job.shot_id, width: 380, height: 214, generateNum: count,
        maxConnect: { image: null, text: null, video: null }, modelCode: model.modelCode, subType: 'text-video',
        status: 'idle', output: [], prompt: job.prompt, params } }],
    edges: [] } } };
}

// Parameter names come from the model's own config, the way the site fills them (first/last frame by
// type, references as one list); the names below are only the fallback when a config is missing.
function buildMultiRun({ canvasId, job, mode, imageUrl, lastImageUrl, referenceUrls, model, now, ids, slot, count }) {
  const rand = () => Math.random().toString(36).slice(2, 9);
  const s = job.settings ?? {};
  const params = { prompt: job.prompt, aspectRatio: s.ratio ?? '16:9', resolution: s.resolution ?? '768p',
    duration: String(s.duration_seconds ?? 15), audioMode: 'native' };
  let urls;
  if (mode === 'first_last') {
    if (!imageUrl || !lastImageUrl) fail('MATERIAL_INVALID', `${job.shot_id} 首尾帧需要首帧和尾帧两张图`);
    urls = [imageUrl, lastImageUrl];
    params[paramOf(model, 'firstFrameUrl', 'firstImageUrl')?.paramName ?? 'firstFrameUrl'] = imageUrl;
    params[paramOf(model, 'lastFrameUrl', 'lastImageUrl')?.paramName ?? 'lastFrameUrl'] = lastImageUrl;
  } else {
    urls = referenceUrls ?? [];
    if (!urls.length || urls.some(u => !u)) fail('MATERIAL_INVALID', `${job.shot_id} 全能参考至少需要 1 张参考图`);
    const limit = referenceLimit(model);
    if (urls.length > limit) fail('MATERIAL_INVALID', `${job.shot_id} 参考图 ${urls.length} 张，模型最多 ${limit} 张`);
    const slots = referenceSlots(model);
    if (slots.length) urls.forEach((u, i) => { params[slots[i]] = u; });
    else params[paramOf(model, 'imageUrls', 'imageRef')?.paramName ?? 'imageUrls'] = [...urls];
  }
  const videoId = ids?.videoId ?? `node_${now}_${rand()}`;
  const imageIds = urls.map((_, i) => ids?.imageIds?.[i] ?? `node_${now}_${rand()}`);
  const x = (slot % 5) * 1000, y = Math.floor(slot / 5) * 900;
  // 首尾帧: two frames stacked; 全能参考: small tiles three to a row. Both stay inside the slot's cell.
  const tile = mode === 'first_last' ? { w: 480, h: 270, at: i => ({ x, y: y + i * 300 }) }
    : { w: 160, h: 90, at: i => ({ x: x + (i % 3) * 170, y: y + Math.floor(i / 3) * 110 }) };
  const roles = mode === 'first_last' ? ['首帧', '尾帧'] : urls.map((_, i) => `参考${i + 1}`);
  const images = urls.map((url, i) => ({ id: imageIds[i], type: 'rh-image', position: tile.at(i), selectable: true,
    style: { width: tile.w, height: tile.h },
    data: { label: `${job.shot_id}-${roles[i]}.png`, title: `${job.shot_id} ${roles[i]}`, width: tile.w, height: tile.h,
      aspectRatio: params.aspectRatio, sourceObjects: [url], status: 'idle', subType: 'text-image' } }));
  const video = { id: videoId, type: 'rh-video', position: { x: x + 520, y }, selectable: true, style: { width: 380, height: 220 },
    data: { label: '视频', title: job.shot_id, width: 380, height: 214, generateNum: count,
      maxConnect: { image: null, text: null, video: null }, modelCode: model.modelCode, subType: SUBTYPES[mode],
      status: 'idle', output: [], prompt: job.prompt, params } };
  // Edge order is image order: the site reads the first connected image as the first frame.
  const edges = imageIds.map(id => ({ id: `e-${id}-${videoId}`, source: id, target: videoId, sourceHandle: 'output', targetHandle: 'input', type: 'default' }));
  return { videoId, params, imageId: imageIds[0], imageIds,
    run: { canvasId, targetType: 'NODE', targetId: videoId, canvas: { nodes: [video, ...images], edges } } };
}

const OCCUPIED = new Set(['SUBMITTING', 'RUNNING']);

/**
 * The scheduler. `api` wraps the page functions; `io` talks to the local server.
 * Pure of DOM so it can be tested in node with fakes.
 */
export function createScheduler({ api, io, canvasId, model, textModel = null, models = {}, now = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)), concurrency = 5, pollMs = 15000, submitGapMs = [10000, 20000],
  // Conservative pacing and occasional probes let capacity recover after temporary reductions.
  stepTimeoutMs = 120000,
  maxAttempts = 3, idleReloadMs = 60000, tickMs = 2000, capacityBackoffMs = 60000, maxBackoffSteps = 6,
  // windowHours: the account's free window. freeWindow: null submits around the clock.
  windowHours = { startHour: 21, endHour: 10, utcOffsetHours: 8 },
  rejectionWindowMs = 2 * 3600e3, maxRejectionsPerWindow = 6, freeWindow = ms => inFreeWindow(ms, windowHours), calibrate = true,
  // 'completion': probe after any of our completions (additive increase per ACK).
  // 'round': probe only after a full round - as many completions as the current capacity - without a
  // refusal, like TCP congestion avoidance (+1 per RTT).
  probeAfter = 'round',
  // Videos per submission: 2 = the site's 2x, 1 = 1x.
  generateNum = DEFAULT_GENERATE_NUM,
  // instance: { instance_id, canvasId, code_version, ... } - registers with the server, which refuses a
  // second runner on the same batch, and is reported in the state. null: no registration (tests, old servers).
  instance = null,
  random = Math.random, log = () => {} } = {}) {
  // `capacity` is what the account really accepts right now. It starts at `concurrency`, drops to
  // what was actually running when the platform says "full", and probes back up over time.
  //
  // Account-full refusals may contribute to rate limits. Probe after completions, back off
  // exponentially when full, and send one submission first after a rate-limit cooldown.
  const state = { jobs: {}, cooldown_until: 0, slot_blocked_until: 0, last_submit_at: 0, next_submit_at: 0, next_poll_at: 0,
    next_reload_at: 0, status: 'STARTING', counts: {}, last_rate_limit: null, capacity: concurrency, next_probe_at: 0,
    full_streak: 0, rate_probe: false, rate_probe_job: null, rejections: [] };
  // Stop probing once maxRejectionsPerWindow refusals accumulate in the configured window.
  const recentRejections = () => (state.rejections = (state.rejections ?? []).filter(t => t > now() - rejectionWindowMs)).length;
  // A spacing between submissions, drawn fresh each time from [min, max].
  const gap = () => Array.isArray(submitGapMs)
    ? Math.round(submitGapMs[0] + random() * (submitGapMs[1] - submitGapMs[0])) : submitGapMs;
  let stopped = false, started = false;
  // The member model per job mode; `model` / `textModel` stay the names for the two original modes.
  const modelFor = { first: model, text: textModel, ...models };
  const iso = ms => new Date(ms).toISOString();
  const event = (type, data = {}) => { const e = { at: iso(now()), type, ...data }; log(e); return io.event?.(e); };
  const jobs = () => Object.values(state.jobs);
  // A step that must not hold the whole queue hostage. Only for steps before the submission: a
  // timed-out submit may still have been accepted, and retrying it would create a duplicate.
  const within = (promise, code) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${code}: ${stepTimeoutMs} ms`), { code })), stepTimeoutMs);
    })]).finally(() => clearTimeout(timer));
  };
  const inflight = () => jobs().filter(j => OCCUPIED.has(j.status)).length;
  const limit = () => Math.max(1, Math.min(concurrency, state.capacity ?? concurrency));
  // `running` is how many of ours the platform holds at the moment it said "full".
  // Nightly calibration: at the start of each free window, ramp one confirmed submission at a time
  // up to the target. The first 1520 refusal (or reaching the target) is tonight's real capacity.
  // At most one refused submission is spent to learn it.
  const finishCalibration = async how => {
    state.calibrating = false; state.calibration_job = null;
    state.capacity_history = [...(state.capacity_history ?? []), { window: state.calibrated_window, at: iso(now()), capacity: state.capacity, how }].slice(-30);
    await event('capacity_calibrated', { window: state.calibrated_window, capacity: state.capacity, how });
  };
  // A 605 means "this would be paid now": nothing was generated, so the job goes back unchanged and
  // nothing more is submitted until the next free window opens.
  const balanceRefused = async (j, message) => {
    Object.assign(j, { status: 'PENDING', task_id: null, confirmed_running: false, probe: false });
    if (state.rate_probe_job === j.shot_id) state.rate_probe_job = null;
    // Inside our window the platform's own boundary may simply lag a few minutes: retry soon.
    // Outside it, wait for tonight's window.
    state.balance_block_until = freeWindow && freeWindow(now()) ? now() + 10 * 60e3 : nextFreeWindowStart(now(), windowHours);
    await event('insufficient_balance', { shot_id: j.shot_id, until: iso(state.balance_block_until), message: String(message ?? '').slice(0, 160) });
  };
  // `bump` is false for the 2nd+ refusal found in the same poll: one "full" event, one backoff step.
  const accountFull = async (j, message, running, bump = true) => {
    j.status = 'PENDING'; j.capacity_rejections = (j.capacity_rejections ?? 0) + 1; j.probe = false; state.probe_open = false;
    if (state.rate_probe_job === j.shot_id) state.rate_probe_job = null;
    state.capacity = Math.max(1, Math.min(limit(), running));
    state.rejections = [...(state.rejections ?? []), now()];
    state.round_completions = 0;
    // 1, 2, 4, 8 minutes for consecutive refusals; a confirmed probe resets the streak.
    if (bump || !state.full_streak) state.full_streak = Math.min(maxBackoffSteps, (state.full_streak ?? 0) + 1);
    const backoff = capacityBackoffMs * 2 ** (state.full_streak - 1);
    state.slot_blocked_until = now() + backoff;
    state.next_probe_at = now() + backoff;
    state.last_capacity_rejection = { at: iso(now()), shot_id: j.shot_id, capacity: state.capacity, backoff_ms: backoff };
    if (state.calibrating) await finishCalibration('refused');
    await event('concurrency_full', { shot_id: j.shot_id, capacity: state.capacity, inflight: inflight(), backoff_ms: backoff,
      rejections_2h: recentRejections(), message: String(message ?? '').slice(0, 160) });
  };
  const save = async () => {
    state.counts = jobs().reduce((a, j) => (a[j.status] = (a[j.status] ?? 0) + 1, a), {});
    state.updated_at = iso(now());
    await io.saveState?.(state);
  };
  const merge = (queue, saved) => {
    for (const [id, j] of Object.entries(saved?.jobs ?? {})) state.jobs[id] ??= j;
    // A restart keeps what the account taught us. Starting again at the full target cost two or three
    // refused submissions per restart, and those refusals are what the long rate limit counts.
    for (const k of ['cooldown_until', 'last_rate_limit', 'rate_probe', 'capacity', 'full_streak', 'next_probe_at', 'rejections', 'auth_invalid_since',
      'balance_block_until', 'calibrated_window', 'calibrating', 'calibration_job', 'capacity_history'])
      if (saved?.[k] != null) state[k] = saved[k];
    // Self-heal: a job that "failed" only because the account was full was never generated.
    for (const j of jobs()) if (j.status === 'FAILED' && [CAPACITY_ERROR, BALANCE_ERROR, AUTH_ERROR].some(re => re.test(String(j.last_error ?? '')))) {
      Object.assign(j, { status: 'PENDING', attempts: 0, last_error: null });
    }
    // The queue file's order is the priority: material put at the front runs next, even if it
    // was added while a long batch was already running.
    queue.forEach((q, order) => {
      const j = state.jobs[q.shot_id];
      if (!j) state.jobs[q.shot_id] = { shot_id: q.shot_id, status: 'PENDING', attempts: 0, job: q, order };
      else Object.assign(j, { job: q, order });
    });
    // A crash between "call submit" and "got taskId" leaves no handle: retry it.
    for (const j of jobs()) if (j.status === 'SUBMITTING') { j.status = 'PENDING'; j.recovered = true; }
  };

  async function poll() {
    const running = jobs().filter(j => j.status === 'RUNNING' && j.task_id);
    state.next_poll_at = now() + pollMs;
    if (!running.length) return;
    let rows;
    try { rows = (await api.status(running.map(j => j.task_id))).tasks ?? []; }
    catch (error) { await event('poll_error', { message: error.message }); return; }
    // Classify everything first, so "what is really running" is known before any capacity decision.
    const results = running.map(j => [j, classifyTask(rows.find(t => String(t.taskId) === String(j.task_id)), j.node_id)]);
    for (const [j, r] of results) {
      j.observed_at = iso(now());
      if (state.calibration_job === j.shot_id && r.status !== 'running') state.calibration_job = null;
      // The single submission sent after a rate limit has been settled: release the rest.
      if (state.rate_probe_job === j.shot_id && r.status !== 'running') { state.rate_probe = false; state.rate_probe_job = null; }
      if (r.status !== 'running') continue;
      j.confirmed_running = true;
      if (state.rate_probe_job === j.shot_id) {
        state.rate_probe = false; state.rate_probe_job = null;
        await event('rate_limit_cleared', { shot_id: j.shot_id });
      }
      // The platform kept a probe running: that slot is real. The next probe still waits for
      // one of our tasks to finish, so no submission is sent on speculation.
      if (j.probe) { j.probe = false; state.full_streak = 0; await event('capacity_confirmed', { capacity: state.capacity }); }
      if (state.calibrating && state.calibration_job === j.shot_id) {
        state.calibration_job = null;
        const confirmed = jobs().filter(x => x.status === 'RUNNING' && x.confirmed_running).length;
        await event('calibration_step', { running: confirmed });
        if (confirmed >= concurrency) await finishCalibration('reached_target');
      }
    }
    const stillRunning = results.filter(([, r]) => r.status === 'running').length
      + jobs().filter(j => j.status === 'RUNNING' && !running.includes(j)).length;
    let bumped = false;
    for (const [j, r] of results) {
      if (r.status === 'insufficient_balance') { await balanceRefused(j, r.error); continue; }
      if (r.status === 'capacity_full') {
        j.task_id = null; j.confirmed_running = false;
        await accountFull(j, r.error, stillRunning, !bumped); bumped = true; continue;
      }
      if (r.status === 'completed') {
        Object.assign(j, { status: 'COMPLETED', outputs: r.urls, completed_at: iso(now()) });
        state.slot_blocked_until = 0; // a slot just opened
        // Our own task just freed a slot: the only moment worth trying one more.
        // Only worth a probe when a submission can actually follow; a paused runner would otherwise
        // raise capacity with every daytime completion and open the night with refused submissions.
        const canSubmit = (!freeWindow || freeWindow(now())) && now() >= (state.balance_block_until ?? 0);
        state.round_completions = (state.round_completions ?? 0) + 1;
        const roundDone = probeAfter !== 'round' || state.round_completions >= state.capacity;
        if (canSubmit && roundDone && state.capacity < concurrency && now() >= state.next_probe_at) {
          state.round_completions = 0;
          if (recentRejections() >= maxRejectionsPerWindow) {
            await event('probe_suppressed', { capacity: state.capacity, rejections_2h: recentRejections() });
          } else {
            state.capacity++; state.probe_open = true;
            await event('capacity_probe', { capacity: state.capacity, after: j.shot_id });
          }
        }
        await event('completed', { shot_id: j.shot_id, task_id: j.task_id, url: r.urls[0] });
        await deliver(j);
      } else if (r.status === 'failed') {
        j.attempts++; j.last_error = r.error; state.slot_blocked_until = 0;
        j.status = j.attempts < maxAttempts ? 'PENDING' : 'FAILED';
        await event('generation_failed', { shot_id: j.shot_id, task_id: j.task_id, error: r.error, will_retry: j.status === 'PENDING' });
      }
    }
    await save();
  }

  async function submit(j) {
    // The submission that takes us past the old capacity is the probe.
    const isProbe = state.probe_open === true && inflight() + 1 >= limit();
    if (isProbe) state.probe_open = false;
    if (state.rate_probe) state.rate_probe_job = j.shot_id;
    if (state.calibrating) state.calibration_job = j.shot_id;
    j.status = 'SUBMITTING'; j.submit_started_at = iso(now()); await save();
    try {
      const mode = jobMode(j.job);
      const jobModel = modelFor[mode];
      if (!jobModel) fail(mode === 'text' ? 'TEXT_MODEL_UNAVAILABLE' : 'MODE_MODEL_UNAVAILABLE',
        mode === 'text' ? '找不到免费的文生视频模型（-t2va-app）' : `找不到免费的${{ first: '首帧', first_last: '首尾帧', reference: '全能参考' }[mode]}模型（H3 Enhanced -app）`);
      // Material is checked before anything is uploaded: a shot that cannot be submitted as asked fails
      // as it is, never in a reduced form.
      if (mode === 'reference') {
        const n = Number(j.job.reference_count ?? 0), limit = referenceLimit(jobModel);
        if (!(n >= 1)) fail('MATERIAL_INVALID', `${j.shot_id} 全能参考没有参考图`);
        if (n > limit) fail('MATERIAL_INVALID', `${j.shot_id} 参考图 ${n} 张，模型最多 ${limit} 张`);
      }
      if ((mode === 'first' || mode === 'first_last') && !j.image_url) j.image_url = await within(api.upload(j.job), 'UPLOAD_TIMEOUT');
      if (mode === 'first_last' && !j.last_image_url) j.last_image_url = await within(api.upload(j.job, 'last'), 'UPLOAD_TIMEOUT');
      if (mode === 'reference') {
        j.reference_urls = (j.reference_urls ?? []).slice(0, j.job.reference_count);
        while (j.reference_urls.length < j.job.reference_count)
          j.reference_urls.push(await within(api.upload(j.job, `ref/${j.reference_urls.length + 1}`), 'UPLOAD_TIMEOUT'));
      }
      const ids = j.persisted ? { videoId: j.node_id, imageId: j.image_node_id, imageIds: j.image_node_ids } : undefined;
      if (j.slot == null) j.slot = state.next_slot = (state.next_slot ?? -1) + 1;
      const { run, videoId, imageId, imageIds, params } = buildRun({ canvasId, job: j.job, imageUrl: j.image_url,
        lastImageUrl: j.last_image_url, referenceUrls: j.reference_urls, model: jobModel, now: now(), ids, slot: j.slot, generateNum });
      // Every mode requires an explicit zero quote before writing nodes or submitting a task.
      j.quote = await api.quote(jobModel, params).catch(e => ({ error: e.message }));
      if (!isZeroQuote(j.quote)) fail('QUOTE_NOT_FREE', `${j.shot_id} 报价不是 0：${JSON.stringify(j.quote).slice(0, 160)}`);
      // The platform writes results back into existing canvas nodes. Persist them before submission.
      if (!j.persisted && api.persist) {
        await within(api.persist(run.canvas), 'CANVAS_PERSIST_TIMEOUT');
        Object.assign(j, { persisted: true, node_id: videoId, image_node_id: imageId, image_node_ids: imageIds });
        await save();
      }
      const res = await api.run(run, { freeLimit: j.quote?.freeLimit });
      const taskId = res?.taskId ?? res?.data?.taskId;
      if (!taskId) fail('NO_TASK_ID', `提交返回没有 taskId：${JSON.stringify(res).slice(0, 200)}`);
      Object.assign(j, { status: 'RUNNING', task_id: String(taskId), node_id: videoId, submitted_at: iso(now()), last_error: null,
        probe: isProbe });
      state.last_submit_at = now(); state.next_submit_at = now() + gap();
      await event('submitted', { shot_id: j.shot_id, task_id: j.task_id, inflight: inflight() });
    } catch (error) {
      j.status = 'PENDING';
      // Wrong material or a paid quote will not change by retrying: stop this shot, keep the rest going.
      if (error?.code === 'MATERIAL_INVALID' || error?.code === 'QUOTE_NOT_FREE') {
        Object.assign(j, { status: 'FAILED', last_error: error.message });
        if (state.rate_probe_job === j.shot_id) state.rate_probe_job = null;
        if (state.calibration_job === j.shot_id) state.calibration_job = null;
        await event(error.code === 'QUOTE_NOT_FREE' ? 'quote_not_free' : 'material_invalid', { shot_id: j.shot_id, message: String(error.message).slice(0, 200) });
        await save(); return 'refused_locally';
      }
      // A frame that cannot be read (e.g. its folder was just moved) is the material's problem, not
      // the platform's: skip this job for a minute without spending an attempt; others continue.
      if (error?.code === 'FRAME_UNAVAILABLE' || error?.code === 'UPLOAD_TIMEOUT') {
        j.frame_retry_at = now() + 60000; j.last_error = error.message;
        await event('frame_unavailable', { shot_id: j.shot_id, message: String(error.message).slice(0, 200) });
        await save(); return;
      }
      // An idle background tab can lose its canvas connection. Pause without spending an attempt.
      if (/^CANVAS_/.test(error?.code ?? '')) {
        state.canvas_down_since ??= now();
        await event('canvas_disconnected', { shot_id: j.shot_id, code: error.code });
        state.last_submit_at = now(); state.next_submit_at = now() + gap();
        await save(); return;
      }
      const c = classifySubmitError(error);
      if (c.kind === 'auth_invalid') {
        state.auth_invalid_since ??= now(); state.next_auth_check_at = now() + 60000;
        if (state.rate_probe_job === j.shot_id) state.rate_probe_job = null;
        if (state.calibration_job === j.shot_id) state.calibration_job = null;
        await event('auth_invalid', { shot_id: j.shot_id, code: c.code, message: c.message });
        state.last_submit_at = now(); state.next_submit_at = now() + gap();
        await save(); return;
      }
      if (c.kind === 'rate_limited') {
        state.cooldown_until = now() + c.retryAfterMs;
        // When the window reopens, send one submission and wait for it to be accepted first.
        state.rate_probe = true; state.rate_probe_job = null;
        state.last_rate_limit = { at: iso(now()), until: iso(state.cooldown_until), scope: c.scope, message: c.message };
        await event('rate_limited', { shot_id: j.shot_id, until: iso(state.cooldown_until), retry_after_ms: c.retryAfterMs });
      } else if (c.kind === 'insufficient_balance') {
        await balanceRefused(j, c.message);
      } else if (c.kind === 'concurrency_full') {
        // Refused at submit time: everything we already hold a taskId for is what the account runs.
        await accountFull(j, c.message, jobs().filter(x => x.status === 'RUNNING' && x.task_id).length);
      } else {
        j.attempts++; j.last_error = c.message;
        if (j.attempts >= maxAttempts) j.status = 'FAILED';
        await event('submit_error', { shot_id: j.shot_id, code: c.code, message: c.message, attempts: j.attempts });
        if (state.rate_probe_job === j.shot_id) state.rate_probe_job = null;
      }
      if (state.calibration_job === j.shot_id && j.status !== 'RUNNING') state.calibration_job = null;
      state.last_submit_at = now(); state.next_submit_at = now() + gap();
    }
    await save();
  }

  // The server downloads the outputs. When it cannot be told (it is down), the outputs stay in the
  // saved state and the server's backfill scan picks them up once it is back.
  async function deliver(j) {
    try {
      await io.done?.({ shot_id: j.shot_id, task_id: j.task_id, urls: j.outputs });
      j.delivered = true;
    } catch (error) {
      j.delivered = false;
      await event('done_failed', { shot_id: j.shot_id, task_id: j.task_id, message: String(error?.message ?? error).slice(0, 160) });
    }
  }

  // Lease + stop switch, once per tick. A server that cannot be reached never stops production.
  async function stopRequested() {
    if (!instance || !io.heartbeat) return false;
    const r = await Promise.resolve(io.heartbeat({ instance_id: state.instance.instance_id, ...state.instance })).catch(() => null);
    if (!r?.stop) return false;
    stopped = true; state.stop_reason = r.reason ?? 'requested';
    await event('stop_acknowledged', { reason: state.stop_reason });
    return true;
  }

  async function reload() {
    state.next_reload_at = now() + idleReloadMs;
    try { merge(await io.loadQueue(), null); } catch (error) { await event('queue_reload_error', { message: error.message }); }
  }

  return {
    state,
    stop() { stopped = true; },
    async start() {
      if (instance) {
        state.instance = { ...instance, generateNum, concurrency, started_at: iso(now()) };
        const r = io.register ? await io.register(state.instance) : null;
        if (r && r.ok === false) {
          const a = r.active ?? {};
          fail('INSTANCE_ACTIVE', `本批次已有提交程序在运行：${a.instance_id}（画布 ${a.info?.canvasId}，${a.heartbeat_age_s}s 前心跳）。`
            + '先停止它：python3 scripts/runninghub/rhtv-native-server.py --stop --wait 180');
        }
      }
      started = true;
      merge(await io.loadQueue(), await io.loadState?.());
      state.status = 'RUNNING'; state.stop_reason = null;
      await event('started', { jobs: jobs().length, pending: jobs().filter(j => j.status === 'PENDING').length });
      await save();
    },
    /** One scheduling step; the loop calls it every tickMs. */
    async tick() {
      if (stopped || await stopRequested()) return state;
      if (now() >= state.next_poll_at) await poll();
      // Outside the free window, or the platform just said it would charge: keep watching what is
      // running, submit nothing new.
      if ((freeWindow && !freeWindow(now())) || now() < (state.balance_block_until ?? 0)) {
        if (state.status !== 'OUTSIDE_FREE_WINDOW') await event('paused_outside_free_window', {});
        state.status = 'OUTSIDE_FREE_WINDOW';
        if (now() >= state.next_reload_at) await reload();
        await save(); return state;
      }
      if (state.status === 'OUTSIDE_FREE_WINDOW') await event('resumed_free_window', {});
      const win = windowKey(now(), windowHours);
      if (calibrate && state.calibrated_window !== win && jobs().some(j => j.status === 'PENDING')) {
        Object.assign(state, { calibrated_window: win, calibrating: true, calibration_job: null,
          capacity: concurrency, full_streak: 0, next_probe_at: 0, slot_blocked_until: 0 });
        await event('calibration_started', { window: win, target: concurrency });
      }
      if (state.slot_blocked_until && now() >= state.slot_blocked_until) state.slot_blocked_until = 0;
      // Logged out: submit nothing, spend nothing, and check once a minute whether login is back.
      if (state.auth_invalid_since) {
        if (now() < (state.next_auth_check_at ?? 0) || !(await api.authOk?.().catch(() => false))) {
          if (now() >= (state.next_auth_check_at ?? 0)) state.next_auth_check_at = now() + 60000;
          state.status = 'AUTH_INVALID';
          if (now() >= state.next_reload_at) await reload();
          await save(); return state;
        }
        await event('auth_restored', { down_ms: now() - state.auth_invalid_since });
        state.auth_invalid_since = null;
      }
      if (state.canvas_down_since) {
        if (api.canvasActive?.() !== true) {
          state.status = 'CANVAS_DISCONNECTED';
          if (now() >= state.next_reload_at) await reload();
          await save(); return state;
        }
        state.canvas_down_since = null;
        await event('canvas_reconnected', {});
      }
      while (!stopped && inflight() < limit() && now() >= state.cooldown_until && now() >= state.slot_blocked_until &&
             now() >= state.next_submit_at) {
        // After a rate limit, one submission at a time until the platform accepts it.
        if (state.rate_probe && state.rate_probe_job) break;
        // While calibrating, one confirmed step at a time.
        if (state.calibrating && state.calibration_job) break;
        const next = jobs().filter(j => j.status === 'PENDING' && !(j.frame_retry_at > now()))
          .reduce((a, b) => (a && (a.order ?? Infinity) <= (b.order ?? Infinity) ? a : b), null);
        if (!next) break;
        // Refused before reaching the run endpoint (bad material, paid quote): the next shot may go now.
        if (await submit(next) === 'refused_locally') continue;
        // next_submit_at now lies one random gap ahead, so the loop condition spaces submissions.
        if (next.status !== 'RUNNING') break; // rate limit / full / error: re-evaluate next tick
      }
      const pending = jobs().filter(j => j.status === 'PENDING').length;
      if (state.calibrating && !pending && !state.calibration_job) {
        state.capacity = Math.max(1, jobs().filter(j => j.status === 'RUNNING').length);
        await finishCalibration('queue_empty');
      }
      state.status = now() < state.cooldown_until ? 'RATE_LIMITED'
        : !pending && !inflight() ? 'DRAINED' : 'RUNNING';
      // Drained or not, pick up material added to the queue while running.
      if (now() >= state.next_reload_at) await reload();
      await save();
      return state;
    },
    async loop() {
      if (!started) await this.start();
      while (!stopped) {
        try { await this.tick(); } catch (error) { await event('tick_error', { message: error.message }); }
        if (!stopped) await sleep(tickMs);
      }
      state.status = 'STOPPED'; await save();
      if (instance) await Promise.resolve(io.unregister?.(state.instance.instance_id)).catch(() => {});
    },
  };
}

export const DEFAULT_SERVER = 'http://127.0.0.1:47615';
/** Browser entry. The page CSP refuses a module import from loopback, so load it as a blob:
 *  const src = await (await fetch('http://127.0.0.1:47615/runner.mjs')).text();
 *  const m = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
 *  await m.bootstrap();
 */
export async function bootstrap({ server = DEFAULT_SERVER, concurrency = 2, global = '__rhtvNative', ...options } = {}) {
  // `global` lets a second, separate runner (e.g. an end-to-end test against another server) live
  // beside the production one; `options` reach the scheduler (freeWindow, maxAttempts, ...).
  if (window[global]?.running) return window[global];
  const canvasId = location.pathname.match(/\/project\/canvas\/(\d+)/)?.[1];
  if (!canvasId) fail('NOT_ON_CANVAS', '请在 rhtv 画布页面（/project/canvas/<id>）运行');
  const moduleUrl = [...document.scripts].map(s => s.src).find(u => /\/project\/assets\/index-[^/]+\.js$/.test(u));
  if (!moduleUrl) fail('PAGE_MODULE_MISSING', '页面主模块未加载');
  const names = discoverApi(await (await fetch(moduleUrl)).text());
  const M = await import(moduleUrl);
  const list = await M[names.client].post('/canvas/model/list', { types: ['START_VIDEO', 'TEXT_VIDEO', 'START_END_VIDEO', 'MULTIMODAL_VIDEO'] });
  const groups = list.data?.data ?? [];
  const all = groups.flatMap(g => g.modelList ?? []);
  const model = all.find(m => MODEL_CODE.test(m.modelCode));
  const textModel = all.find(m => TEXT_MODEL_CODE.test(m.modelCode)) ?? null;
  if (!model) fail('MODEL_UNAVAILABLE', '找不到 Minimax H3 RH Enhanced 会员版');
  // Missing ones only stop the shots that need them (MODE_MODEL_UNAVAILABLE), never the whole runner.
  const models = { first_last: pickModel(groups, 'START_END_VIDEO'), reference: pickModel(groups, 'MULTIMODAL_VIDEO', REFERENCE_MODEL_CODE) };
  const json = async (path, body) => {
    const r = await fetch(server + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) fail('SERVER_' + r.status, `${path} -> ${r.status}`);
    return r.json();
  };
  const store = M[names.store]();
  if (typeof store?.pasteGraph !== 'function') fail('CANVAS_STORE_UNAVAILABLE', '页面画布存储不可用');
  // The server closes an idle tab's canvas socket ("idle-suspended"). The site's own write path
  // calls resumeFromIdle("business-write") before writing; do the same, then wait for "synced".
  const active = () => typeof store.isActiveRoom !== 'function' || store.isActiveRoom(canvasId) === true;
  const reconnect = async (waitMs = 20000) => {
    if (active()) return true;
    if (store.getStatus?.() === 'idle-suspended' || store.idleSuspended) store.resumeFromIdle?.('business-write');
    // Bounded by the wall clock, not by a count: Chrome may run a hidden tab's chained timers only
    // once a minute; counting timer iterations would greatly extend the intended deadline.
    const until = Date.now() + waitMs;
    while (!active() && Date.now() < until) await new Promise(r => setTimeout(r, 500));
    return active();
  };
  if (!await reconnect()) fail('CANVAS_NOT_ACTIVE', `当前画布 ${canvasId} 未连接（${store.getStatus?.()}），请刷新页面后再启动`);
  const api = {
    // The upload-credential endpoint is the one that rejects a logged-out session.
    authOk: async () => {
      try { const r = await M[names.client].post('/api/storage/getCredentials', { scene: 'canvas' }); return r?.data?.code === 0; }
      catch { return false; }
    },
    // Checked every tick while the canvas is down: nudge an idle-suspended room back, then report.
    canvasActive: () => {
      if (!active() && (store.getStatus?.() === 'idle-suspended' || store.idleSuspended)) store.resumeFromIdle?.('business-write');
      return active();
    },
    // Write the pair into the open canvas exactly as the site does, then wait until the server-side
    // document holds both nodes; only then may a task target them.
    persist: async canvas => {
      if (!await reconnect()) fail('CANVAS_DISCONNECTED', `画布 ${canvasId} 连接已断开（${store.getStatus?.()}）`);
      store.pasteGraph(canvas.nodes, canvas.edges, { immediate: true });
      store.flushOperationQueue?.(true);
      if (typeof store.getRemoteData !== 'function') return;
      const ids = canvas.nodes.map(n => n.id);
      for (const until = Date.now() + 10000; Date.now() < until;) {
        const remote = store.getRemoteData();
        if (remote && ids.every(id => remote.nodes.some(n => String(n.id) === id))) return;
        await new Promise(r => setTimeout(r, 250));
      }
      fail('CANVAS_PERSIST_TIMEOUT', `节点未写入画布：${ids.join(',')}`);
    },
    // which: undefined (first frame), 'last', or 'ref/<n>' (1-based reference image).
    upload: async (job, which) => {
      const label = !which ? '首帧' : which === 'last' ? '尾帧' : `参考图 ${which.slice(4)}`;
      // A missing or changed frame comes back as a JSON error body; never upload that as an image.
      const res = await fetch(`${server}/frame/${encodeURIComponent(job.shot_id)}${which ? `/${which}` : ''}`);
      if (!res.ok) fail('FRAME_UNAVAILABLE', `${job.shot_id} ${label}取不到（HTTP ${res.status}）：${(await res.text()).slice(0, 160)}`);
      const blob = await res.blob();
      if (!blob.size || !/^image\//.test(blob.type)) fail('FRAME_UNAVAILABLE', `${job.shot_id} ${label}不是图片（${blob.type || '空'}）`);
      const name = `${job.shot_id}${which ? `-${which.replace('/', '')}` : ''}.${blob.type.split('/')[1] || 'png'}`;
      return M[names.upload](new File([blob], name, { type: blob.type }), 'canvas', {});
    },
    quote: (m, params) => M[names.quote](m, params),
    run: (run, opts) => M[names.run](run, opts),
    status: ids => M[names.status](ids, { includeResults: true }),
  };
  // Every write names its batch, so a runner stopped after the server switched batches
  // cannot write its last state into the new one.
  const { batch } = await json('/health');
  const io = {
    loadQueue: async () => (await json('/queue')).jobs,
    loadState: async () => json('/state'),
    saveState: s => json('/state', { ...s, batch }).catch(() => {}),
    event: e => json('/event', e).catch(() => {}),
    // Not swallowed: the scheduler records a failed hand-over; the server's backfill catches it up.
    done: d => json('/done', d),
    // A 409 here is an answer (another runner holds the batch), not a transport error.
    register: async info => (await fetch(server + '/instance/register', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(info) })).json(),
    heartbeat: info => json('/instance/heartbeat', info).catch(() => null),
    unregister: id => json('/instance/unregister', { instance_id: id }).catch(() => {}),
  };
  const instance = { instance_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    canvasId, global, code_version: RUNNER_BUILD, page: location.href };
  const scheduler = createScheduler({ api, io, canvasId, model, textModel, models, concurrency, instance, ...options,
    log: e => console.log(`[${global}]`, e.type, e) });
  // Registration happens here, so a refused bootstrap rejects instead of failing silently in the loop.
  await scheduler.start();
  const control = { running: true, api: names, model: model.modelCode, canvasId, state: scheduler.state,
    models: { first: model.modelCode, text: textModel?.modelCode ?? null, first_last: models.first_last?.modelCode ?? null, reference: models.reference?.modelCode ?? null },
    instance: scheduler.state.instance, stop: () => { scheduler.stop(); control.running = false; } };
  window[global] = control;
  scheduler.loop().finally(() => { control.running = false; });
  return control;
}
