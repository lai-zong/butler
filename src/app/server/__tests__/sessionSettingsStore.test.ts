/**
 * 人格正文 sidecar
 *
 * ★ 事件里只有 hash/长度，正文必须能跨重启保留。
 *   这里验证：写入、合并、损坏文件不阻断。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_SETTINGS_FILE,
  loadSessionPersonas,
  saveSessionPersona,
  sessionSettingsPath,
} from '../sessionSettingsStore.js';

let dir: string | null = null;

async function root(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'butler-session-settings-'));
  return dir;
}

afterEach(async () => {
  if (dir !== null) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe('session-settings.json', () => {
  it('保存后能读回；多个 session 互不覆盖', async () => {
    const r = await root();
    await saveSessionPersona(r, 's1', '人格一');
    await saveSessionPersona(r, 's2', '人格二');
    const map = await loadSessionPersonas(r);
    expect(map.get('s1')).toBe('人格一');
    expect(map.get('s2')).toBe('人格二');
  });

  it('清空人格写成空字符串', async () => {
    const r = await root();
    await saveSessionPersona(r, 's1', '旧人格');
    await saveSessionPersona(r, 's1', '');
    const map = await loadSessionPersonas(r);
    expect(map.get('s1')).toBe('');
  });

  it('文件不存在 → 空 map，不抛错', async () => {
    const r = await root();
    const map = await loadSessionPersonas(r);
    expect(map.size).toBe(0);
  });

  it('文件损坏 → 空 map，不抛错', async () => {
    const r = await root();
    await writeFile(sessionSettingsPath(r), '{ 这不是 JSON', 'utf8');
    const map = await loadSessionPersonas(r);
    expect(map.size).toBe(0);
  });

  it('文件名稳定（不随版本漂移）', () => {
    expect(SESSION_SETTINGS_FILE).toBe('session-settings.json');
    expect(sessionSettingsPath('x')).toContain(SESSION_SETTINGS_FILE);
  });
});
