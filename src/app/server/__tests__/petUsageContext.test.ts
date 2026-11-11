import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPetUsageContext } from '../petUsageContext.js';

let dir = '';
let previous: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'butler-petctx-'));
  previous = process.env['BUTLER_DATA_DIR'];
  process.env['BUTLER_DATA_DIR'] = dir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env['BUTLER_DATA_DIR'];
  else process.env['BUTLER_DATA_DIR'] = previous;
  await rm(dir, { recursive: true, force: true });
});

function at(dayOffset: number, hour = 21): number {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

describe('pet usage context', () => {
  it('只把使用节奏作为桌宠上下文，不包含任务或工具内容', async () => {
    const lines: string[] = [];
    for (const day of [3, 2, 1]) {
      lines.push(JSON.stringify({ at: at(day), page: 'chat', active: true }));
      lines.push(JSON.stringify({ at: at(day) + 60_000, page: 'chat', active: true }));
    }
    await writeFile(join(dir, 'usage.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    await writeFile(join(dir, 'usage-settings.json'), '{"enabled":true}\n', 'utf8');

    const text = await buildPetUsageContext();
    expect(text).toContain('桌宠使用节奏');
    expect(text).toContain('常在');
    expect(text).not.toContain('工具调用');
    expect(text).not.toContain('write_file');
  });

  it('数据不足时返回空上下文', async () => {
    await writeFile(join(dir, 'usage.jsonl'), `${JSON.stringify({ at: Date.now(), page: 'chat', active: true })}\n`, 'utf8');
    await expect(buildPetUsageContext()).resolves.toBe('');
  });
});
