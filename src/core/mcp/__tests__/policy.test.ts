/**
 * MCP 策略解析测试。
 *
 * ★ 锁住三条：
 *   ① 非法 level / 非字符串数组必须拒绝；
 *   ② 未提供的字段沿用旧值（避免界面只改 level 时重置危险开关）；
 *   ③ 默认值保守（危险工具默认 false）。
 */

import { describe, expect, it } from 'vitest';

import { parseMcpPolicy } from '../policy.js';
import { DEFAULT_POLICY, type McpServerPolicy } from '../types.js';

const current: McpServerPolicy = {
  level: 'readOnly',
  disabledTools: ['delete_everything'],
  allowMemoryWrite: true,
  allowDangerousTools: true,
};

describe('MCP 策略解析', () => {
  it('接受完整合法策略', () => {
    const r = parseMcpPolicy({
      level: 'normal',
      disabledTools: ['delete_note', 'write_file'],
      allowMemoryWrite: false,
      allowDangerousTools: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.level).toBe('normal');
      expect(r.policy.disabledTools).toEqual(['delete_note', 'write_file']);
      expect(r.policy.allowDangerousTools).toBe(false);
    }
  });

  it('只给 level 时沿用旧字段', () => {
    const r = parseMcpPolicy({ level: 'manual' }, current);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy).toEqual({
        level: 'manual',
        disabledTools: current.disabledTools,
        allowMemoryWrite: true,
        allowDangerousTools: true,
      });
    }
  });

  it('没有旧值时默认保守', () => {
    const r = parseMcpPolicy({ level: 'manual' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy).toEqual(DEFAULT_POLICY);
    }
  });

  it('拒绝非法 level', () => {
    expect(parseMcpPolicy({ level: 'full' }).ok).toBe(false);
    expect(parseMcpPolicy({ level: 1 }).ok).toBe(false);
    expect(parseMcpPolicy({}).ok).toBe(false);
  });

  it('拒绝非字符串数组 / 非布尔值', () => {
    expect(parseMcpPolicy({ level: 'manual', disabledTools: 'x' }).ok).toBe(false);
    expect(parseMcpPolicy({ level: 'manual', disabledTools: [1] }).ok).toBe(false);
    expect(parseMcpPolicy({ level: 'manual', allowMemoryWrite: 'yes' }).ok).toBe(false);
    expect(parseMcpPolicy({ level: 'manual', allowDangerousTools: 'yes' }).ok).toBe(false);
  });

  it('去空白、去重、拒绝空项', () => {
    const r = parseMcpPolicy({
      level: 'readOnly',
      disabledTools: ['  a  ', 'a', '', 'b'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.disabledTools).toEqual(['a', 'b']);
  });
});
