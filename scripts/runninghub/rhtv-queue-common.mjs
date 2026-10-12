import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PRODUCTION_SETTINGS = Object.freeze({ model: 'Minimax H3 RH Enhanced',
  duration_seconds: 15, resolution: '768p', ratio: '16:9', mode: '首帧', quantity: 1, required_fee: 0 });
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
