import { describe, expect, it } from 'vitest';

import type { ActionTier } from '@/core/tools/types.js';
import { SessionPermissionPolicy } from '../sessionPermission.js';
import { sessionPermissionFromMode } from '../sessionScope.js';

function ask(policy: SessionPermissionPolicy, tier: ActionTier) {
  return policy.ask({ toolName: 'test_tool', tier, args: {}, summary: '测试' });
}

describe('SessionPermissionPolicy（每个会话独立、不可变）', () => {
  it('read-only 只开只读；写/移动/高风险全部拒绝；dangerous 恒关', () => {
    const p = new SessionPermissionPolicy('read-only');
    expect(p.mode).toBe('view');
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(false);
    expect(p.isTierEnabled('highRisk')).toBe(false);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('workspace 只开只读 + 常规写；highRisk（移动等）不开放；dangerous 恒关', () => {
    const p = new SessionPermissionPolicy('workspace');
    expect(p.mode).toBe('workspace');
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(true);
    expect(p.isTierEnabled('highRisk')).toBe(false);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('full 才开放 highRisk；dangerous 仍不放开', () => {
    const p = new SessionPermissionPolicy('full');
    expect(p.mode).toBe('full');
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(true);
    expect(p.isTierEnabled('highRisk')).toBe(true);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('没有确认通道：normal 按会话档位授权；highRisk 一律拒绝', async () => {
    await expect(ask(new SessionPermissionPolicy('workspace'), 'normal')).resolves.toBe('allow');
    await expect(ask(new SessionPermissionPolicy('full'), 'normal')).resolves.toBe('allow');
    // 没有 asker 时绝不静默执行高风险动作
    await expect(ask(new SessionPermissionPolicy('full'), 'highRisk')).resolves.toBe('deny');
    await expect(ask(new SessionPermissionPolicy('workspace'), 'highRisk')).resolves.toBe('deny');
    // 凭证类等走到 ask 的只读工具也 fail-closed
    await expect(ask(new SessionPermissionPolicy('read-only'), 'readOnly')).resolves.toBe('deny');
  });

  it('关闭确认：按档位直接放行，dangerous 仍拒绝', async () => {
    await expect(ask(new SessionPermissionPolicy('full', false), 'highRisk')).resolves.toBe('allow');
    await expect(ask(new SessionPermissionPolicy('workspace', false), 'normal')).resolves.toBe('allow');
    // highRisk 在 workspace 档仍被档位门禁挡住
    await expect(ask(new SessionPermissionPolicy('workspace', false), 'highRisk')).resolves.toBe('deny');
    await expect(ask(new SessionPermissionPolicy('read-only', false), 'normal')).resolves.toBe('deny');
  });

  it('两个实例互不影响（不共享可变 mode）', () => {
    const a = new SessionPermissionPolicy('read-only');
    const b = new SessionPermissionPolicy('full');
    expect(a.mode).toBe('view');
    expect(b.mode).toBe('full');
    expect(a.isTierEnabled('normal')).toBe(false);
    expect(b.isTierEnabled('normal')).toBe(true);
  });
});

describe('应用默认权限映射', () => {
  it('view → read-only / workspace → workspace / full → full', () => {
    expect(sessionPermissionFromMode('view')).toBe('read-only');
    expect(sessionPermissionFromMode('workspace')).toBe('workspace');
    expect(sessionPermissionFromMode('full')).toBe('full');
  });

  it('未配置（undefined）按只读，安全默认', () => {
    expect(sessionPermissionFromMode(undefined)).toBe('read-only');
  });
});
