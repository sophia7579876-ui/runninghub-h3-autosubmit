#!/usr/bin/env node
/** Build a native-runner queue from user-supplied images and prompts. Offline only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_SETTINGS, readJson, writeJson, sha256 } from './rhtv-queue-common.mjs';

export const MANIFEST_NAME = 'rhtv-manifest.json';
export const QUEUE_SCHEMA = 'rhtv-generic-queue/v1';
const PROMPT_EXT = ['.txt', '.md', '.prompt', '.json'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const MAGIC = { png: [137, 80, 78, 71, 13, 10, 26, 10], jpg: [255, 216, 255] };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const slug = value => String(value).normalize('NFC').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

/** Absolute, and never silently defaulted: a wrong root would quietly submit the wrong material. */
export function requireRoot(value, label = '素材目录') {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value))
    fail('ROOT_REQUIRED', `必须显式提供${label}的绝对路径`);
  return path.resolve(value);
}

async function imageBinding(file, batchRoot) {
  const bytes = await fs.readFile(file);
  const kind = IMAGE_EXT.includes(path.extname(file).toLowerCase()) ? path.extname(file).toLowerCase() : null;
  if (!kind) fail('IMAGE_TYPE_UNSUPPORTED', `不支持的图片类型：${file}`);
  const magic = kind === '.png' ? MAGIC.png : ['.jpg', '.jpeg'].includes(kind) ? MAGIC.jpg : null;
  if (magic && !bytes.subarray(0, magic.length).equals(Buffer.from(magic)))
    fail('IMAGE_CONTENT_INVALID', `文件内容与扩展名不符：${file}`);
  // A relative binding survives a move to another machine; outside material keeps its absolute path.
  const rel = path.relative(batchRoot, file);
  const portable = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return { ...(portable ? { rel_path: rel } : { path: file }), sha256: sha256(bytes) };
}

const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
/** Per-shot ratio / duration / resolution from a manifest entry; anything else stays at the default. */
export function shotSettings(entry = {}) {
  const settings = { ...PRODUCTION_SETTINGS };
  if (entry.ratio != null) {
    if (!RATIOS.includes(entry.ratio)) fail('SETTING_RATIO_INVALID', `不支持的比例：${entry.ratio}`);
    settings.ratio = entry.ratio;
  }
  const duration = entry.duration_seconds ?? entry.duration;
  if (duration != null) {
    const n = Number(duration);
    if (!Number.isInteger(n) || n < 1 || n > 15) fail('SETTING_DURATION_INVALID', `时长须为 1–15 秒整数：${duration}`);
    settings.duration_seconds = n;
  }
  if (entry.resolution != null) {
    if (!/^\d{3,4}p$/.test(entry.resolution)) fail('SETTING_RESOLUTION_INVALID', `不支持的分辨率：${entry.resolution}`);
    settings.resolution = entry.resolution;
  }
  return settings;
}

function buildJob({ shotId, prompt, frame, projectId, settings = { ...PRODUCTION_SETTINGS } }) {
  const shot_id = slug(shotId);
  if (!shot_id) fail('SHOT_ID_INVALID', `无法从 ${shotId} 推导出有效 shot_id`);
  if (typeof prompt !== 'string' || !prompt.trim()) fail('PROMPT_MISSING', `${shot_id} 缺少提示词`);
  const job = { shot_id, job_id: slug(`${projectId}-${shot_id}`), status: 'READY_FOR_PRODUCTION',
    settings, first_frame: frame,
    prepared_prompt: prompt, prepared_prompt_sha256: sha256(prompt) };
  return job;
}

async function fromManifest(manifest, { sourceRoot, batchRoot, projectId }) {
  if (!Array.isArray(manifest?.shots) || !manifest.shots.length) fail('MANIFEST_EMPTY', '清单缺少 shots');
  const jobs = [];
  for (const entry of manifest.shots) {
    const image = entry?.image ?? entry?.first_frame ?? entry?.frame;
    if (!image) fail('MANIFEST_IMAGE_MISSING', `清单条目缺少 image：${JSON.stringify(entry).slice(0, 120)}`);
    const file = path.isAbsolute(image) ? image : path.resolve(sourceRoot, image);
    let prompt = entry.prompt;
    if (prompt === undefined && entry.prompt_file)
      prompt = await fs.readFile(path.isAbsolute(entry.prompt_file) ? entry.prompt_file
        : path.resolve(sourceRoot, entry.prompt_file), 'utf8');
    jobs.push(buildJob({ shotId: entry.shot_id ?? path.basename(file, path.extname(file)),
      prompt: typeof prompt === 'string' ? prompt.trim() : prompt,
      frame: await imageBinding(file, batchRoot), projectId, settings: shotSettings(entry) }));
  }
  return { jobs, mode: 'manifest' };
}

async function readPromptBeside(file) {
  const base = file.slice(0, -path.extname(file).length);
  for (const ext of PROMPT_EXT) {
    for (const candidate of [base + ext, base + '.prompt' + ext]) {
      let text;
      try { text = await fs.readFile(candidate, 'utf8'); } catch { continue; }
      if (ext === '.json') {
        let parsed;
        try { parsed = JSON.parse(text); } catch { fail('PROMPT_JSON_INVALID', `无法解析 ${candidate}`); }
        const prompt = parsed?.prompt ?? parsed?.prepared_prompt;
        if (typeof prompt === 'string' && prompt.trim()) return { prompt: prompt.trim(), from: candidate };
        continue;
      }
      if (text.trim()) return { prompt: text.trim(), from: candidate };
    }
  }
  return null;
}

async function scanDirectory({ sourceRoot, batchRoot, projectId }) {
  const jobs = [], missing = [];
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The batch writes its own receipts and executions under batchRoot; never re-ingest them.
        if (entry.name.startsWith('.') || full === batchRoot) continue;
        await walk(full, depth + 1);
      } else if (IMAGE_EXT.includes(path.extname(entry.name).toLowerCase())) {
        const found = await readPromptBeside(full);
        if (!found) { missing.push(path.relative(sourceRoot, full)); continue; }
        jobs.push(buildJob({ shotId: path.basename(entry.name, path.extname(entry.name)),
          prompt: found.prompt, frame: await imageBinding(full, batchRoot), projectId }));
      }
    }
  };
  await walk(sourceRoot, 0);
  return { jobs, mode: 'scan', missing_prompt: missing };
}

/** Writes only formal-video-queue.json. Native progress is kept separately and never reset. */
export async function buildGenericQueue({ sourceRoot, batchRoot, projectId, manifest } = {}) {
  sourceRoot = requireRoot(sourceRoot);
  batchRoot = batchRoot ? requireRoot(batchRoot, '批次目录') : path.join(sourceRoot, 'rhtv-batch');
  projectId = slug(projectId ?? path.basename(sourceRoot)) || 'rhtv';
  const manifestFile = manifest ? (path.isAbsolute(manifest) ? manifest : path.resolve(sourceRoot, manifest))
    : path.join(sourceRoot, MANIFEST_NAME);
  const loaded = await readJson(manifestFile);
  if (manifest && !loaded) fail('MANIFEST_MISSING', `找不到清单：${manifestFile}`);
  const built = loaded ? await fromManifest(loaded, { sourceRoot, batchRoot, projectId })
    : await scanDirectory({ sourceRoot, batchRoot, projectId });
  const seen = new Set();
  for (const job of built.jobs)
    if (seen.size === seen.add(job.shot_id).size) fail('SHOT_ID_DUPLICATE', `shot_id 重复：${job.shot_id}`);
  if (!built.jobs.length)
    fail('NO_MATERIAL', built.mode === 'scan'
      ? `${sourceRoot} 下没有「图片 + 同名提示词」配对${built.missing_prompt?.length ? `（${built.missing_prompt.length} 张图缺提示词）` : ''}`
      : '清单未产出任何任务');
  const jobs = built.jobs;
  await writeJson(path.join(batchRoot, 'formal-video-queue.json'),
    { schema_version: QUEUE_SCHEMA, project_id: projectId, source_root: sourceRoot,
      input_mode: built.mode, generated_at: new Date().toISOString(), jobs });
  return { project_id: projectId, batch_root: batchRoot, source_root: sourceRoot, input_mode: built.mode,
    queued: jobs.length,
    missing_prompt: built.missing_prompt ?? [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const get = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes('--help') || !get('--source')) {
    console.log(`用法：node scripts/runninghub/rhtv-generic-queue.mjs --source <素材目录绝对路径> [选项]

  --source <dir>     素材目录（必填，绝对路径）
  --batch <dir>      批次目录（默认 <source>/rhtv-batch）
  --project <id>     项目标识（默认取素材目录名）
  --manifest <file>  显式指定清单；默认自动探测 <source>/${MANIFEST_NAME}

两种输入都支持，清单优先：
  1) 清单  ${MANIFEST_NAME}：{"shots":[{"shot_id":"s001","image":"a.png","prompt":"...",
       "ratio":"9:16","duration":11,"resolution":"768p"}]}   比例/时长/分辨率可选，默认 16:9 / 15 秒 / 768p
  2) 目录扫描：a.png 配 a.txt / a.md / a.json({"prompt":"..."}) / a.prompt.txt

提示词仅去除首尾空白，不改写正文；生成队列不会提交任务，也不会重置 native-state.json。`);
    process.exit(get('--source') ? 0 : 1);
  }
  buildGenericQueue({ sourceRoot: get('--source'), batchRoot: get('--batch'),
    projectId: get('--project'), manifest: get('--manifest') })
    .then(r => { console.log(JSON.stringify(r, null, 2)); })
    .catch(e => { console.error(`${e.code ?? 'ERROR'}: ${e.message}`); process.exit(1); });
}
