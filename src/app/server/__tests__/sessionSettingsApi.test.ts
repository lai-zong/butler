/**
 * PATCH 会话设置的输入校验
 *
 * ★ 非法输入必须 400，且不能静默写入任何字段。
 *   这里直接测解析器，路由只负责把 `ok:false` 转成 400。
 */

import { describe, expect, it } from 'vitest';

import { parseSessionSettingsPatch } from '../sessionSettingsApi.js';

describe('parseSessionSettingsPatch', () => {
  it('persona / reasoning / memoryMode 合法', () => {
    const r = parseSessionSettingsPatch({
      persona: '你是一位耐心的管家',
      reasoning: 'max',
      memoryMode: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toEqual({
      persona: '你是一位耐心的管家',
      reasoning: 'max',
      memoryMode: 'off',
    });
  });

  it('memoryMode 接受 on/off 字符串', () => {
    const r = parseSessionSettingsPatch({ memoryMode: 'off' });
    expect(r.ok && r.patch.memoryMode).toBe('off');
  });

  it('persona 超过 8000 字 → 拒绝', () => {
    const r = parseSessionSettingsPatch({ persona: 'a'.repeat(8001) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('8000');
  });

  it('reasoning 非枚举 → 拒绝', () => {
    for (const value of ['medium', 'HIGH', '', 3, null]) {
      const r = parseSessionSettingsPatch({ reasoning: value });
      expect(r.ok).toBe(false);
    }
  });

  it('memoryMode 非布尔/枚举 → 拒绝', () => {
    for (const value of ['yes', 1, null, {}]) {
      const r = parseSessionSettingsPatch({ memoryMode: value });
      expect(r.ok).toBe(false);
    }
  });

  it('模型必须成对出现', () => {
    expect(parseSessionSettingsPatch({ modelProfileId: 'p' }).ok).toBe(false);
    expect(parseSessionSettingsPatch({ modelId: 'm' }).ok).toBe(false);
    expect(parseSessionSettingsPatch({ modelProfileId: '', modelId: 'm' }).ok).toBe(false);
    const ok = parseSessionSettingsPatch({ modelProfileId: 'p', modelId: 'm' });
    expect(ok.ok && ok.patch).toMatchObject({ modelProfileId: 'p', modelId: 'm' });
  });

  it('workspace 接受绝对路径 / null；拒绝相对路径与空串', () => {
    const absolute = 'C:\\work\\alpha';
    expect(parseSessionSettingsPatch({ workspace: absolute })).toEqual({
      ok: true,
      patch: { workspace: absolute },
    });
    expect(parseSessionSettingsPatch({ workspace: null })).toEqual({
      ok: true,
      patch: { workspace: null },
    });
    for (const value of ['relative/path', '', '   ', 3, {}]) {
      const r = parseSessionSettingsPatch({ workspace: value });
      expect(r.ok).toBe(false);
    }
  });

  it('permission 只接受三档枚举或 null', () => {
    for (const permission of ['read-only', 'workspace', 'full'] as const) {
      expect(parseSessionSettingsPatch({ permission })).toEqual({
        ok: true,
        patch: { permission },
      });
    }
    expect(parseSessionSettingsPatch({ permission: null })).toEqual({
      ok: true,
      patch: { permission: null },
    });
    for (const value of ['view', 'readonly', 'FULL', '', 0, true]) {
      expect(parseSessionSettingsPatch({ permission: value }).ok).toBe(false);
    }
  });

  it('空对象 / 非对象 / 未知字段 → 拒绝（未知字段不静默写入）', () => {
    expect(parseSessionSettingsPatch({}).ok).toBe(false);
    expect(parseSessionSettingsPatch(null).ok).toBe(false);
    expect(parseSessionSettingsPatch([]).ok).toBe(false);
    expect(parseSessionSettingsPatch({ somethingElse: '/tmp' }).ok).toBe(false);
  });
});
