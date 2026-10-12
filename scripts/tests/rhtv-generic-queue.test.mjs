import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGenericQueue, MANIFEST_NAME } from '../runninghub/rhtv-generic-queue.mjs';
import { sha256, PRODUCTION_SETTINGS } from '../runninghub/rhtv-queue-common.mjs';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-test')]);
async function sandbox(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h3-queue-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}
const readQueue = async batch => JSON.parse(await fs.readFile(path.join(batch, 'formal-video-queue.json'), 'utf8'));

test('scan pairs image and prompt, binds bytes, and emits only a native queue', async t => {
  const source = await sandbox(t, { 's001.png': PNG, 's001.txt': '  A paper pinwheel turns.  ', 'orphan.png': PNG });
  const result = await buildGenericQueue({ sourceRoot: source });
  const [job] = (await readQueue(result.batch_root)).jobs;
  assert.equal(result.queued, 1);
  assert.deepEqual(result.missing_prompt, ['orphan.png']);
  assert.equal(job.prepared_prompt, 'A paper pinwheel turns.');
  assert.equal(job.first_frame.sha256, sha256(PNG));
  assert.deepEqual(job.settings, PRODUCTION_SETTINGS);
  assert.equal(job.status, 'READY_FOR_PRODUCTION');
  assert.equal(job.prompt_review, undefined);
  assert.deepEqual(await fs.readdir(result.batch_root), ['formal-video-queue.json']);
});

test('manifest wins, supports prompt files and per-shot generation settings', async t => {
  const source = await sandbox(t, { 's.png': PNG, 's.txt': 'ignored', 'prompt.txt': 'from file',
    [MANIFEST_NAME]: JSON.stringify({ shots: [{ shot_id: 'demo_s001', image: 's.png', prompt_file: 'prompt.txt',
      ratio: '9:16', duration: 11, resolution: '768p' }] }) });
  const result = await buildGenericQueue({ sourceRoot: source });
  const [job] = (await readQueue(result.batch_root)).jobs;
  assert.equal(result.input_mode, 'manifest');
  assert.equal(job.shot_id, 'demo_s001');
  assert.equal(job.prepared_prompt, 'from file');
  assert.equal(job.settings.ratio, '9:16');
  assert.equal(job.settings.duration_seconds, 11);
});

test('rebuilding never resets native progress or rediscovers batch material', async t => {
  const source = await sandbox(t, { 'a.png': PNG, 'a.txt': 'demo' });
  const { batch_root } = await buildGenericQueue({ sourceRoot: source });
  const state = JSON.stringify({ jobs: { a: { status: 'RUNNING', task_id: 'synthetic-task' } } });
  await fs.writeFile(path.join(batch_root, 'native-state.json'), state);
  await fs.writeFile(path.join(batch_root, 'internal.png'), PNG);
  await fs.writeFile(path.join(batch_root, 'internal.txt'), 'must not be ingested');
  await buildGenericQueue({ sourceRoot: source });
  assert.equal(await fs.readFile(path.join(batch_root, 'native-state.json'), 'utf8'), state);
  assert.deepEqual((await readQueue(batch_root)).jobs.map(j => j.shot_id), ['a']);
});

test('duplicate IDs, invalid materials and unsupported parameters fail before writing a queue', async t => {
  const source = await sandbox(t, { 'a.png': PNG });
  const manifest = path.join(source, MANIFEST_NAME);
  for (const [shots, code] of [
    [[{ image: 'a.png', prompt: 'a' }, { image: 'a.png', prompt: 'b' }], 'SHOT_ID_DUPLICATE'],
    [[{ image: 'a.png', prompt: 'a', duration: 16 }], 'SETTING_DURATION_INVALID'],
    [[{ image: 'a.png', prompt: 'a', ratio: '8:3' }], 'SETTING_RATIO_INVALID'],
    [[{ image: 'a.png', prompt: '' }], 'PROMPT_MISSING'],
  ]) {
    await fs.writeFile(manifest, JSON.stringify({ shots }));
    await assert.rejects(buildGenericQueue({ sourceRoot: source }), e => e.code === code);
  }
  await fs.writeFile(path.join(source, 'a.png'), 'not an image');
  await fs.writeFile(manifest, JSON.stringify({ shots: [{ image: 'a.png', prompt: 'a' }] }));
  await assert.rejects(buildGenericQueue({ sourceRoot: source }), e => e.code === 'IMAGE_CONTENT_INVALID');
});

test('explicit absolute roots and valid JSON are required', async t => {
  await assert.rejects(buildGenericQueue({ sourceRoot: 'relative' }), e => e.code === 'ROOT_REQUIRED');
  const source = await sandbox(t, { [MANIFEST_NAME]: '{bad json' });
  await assert.rejects(buildGenericQueue({ sourceRoot: source }), SyntaxError);
});
