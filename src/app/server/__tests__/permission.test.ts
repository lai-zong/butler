import { describe, expect, it } from 'vitest';

import { WebPermissionPolicy } from '../permission.js';

describe('C5 三档权限', () => {
  it('view 只放行 readOnly', () => {
    const p = new WebPermissionPolicy({ mode: 'view' });
    expect(p.mode).toBe('view');
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(false);
    expect(p.isTierEnabled('highRisk')).toBe(false);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('workspace 放行 readOnly + normal', () => {
    const p = new WebPermissionPolicy({ mode: 'workspace' });
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(true);
    expect(p.isTierEnabled('highRisk')).toBe(false);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('full 放行 highRisk，但 dangerous 仍是硬底线', () => {
    const p = new WebPermissionPolicy({ mode: 'full' });
    expect(p.isTierEnabled('readOnly')).toBe(true);
    expect(p.isTierEnabled('normal')).toBe(true);
    expect(p.isTierEnabled('highRisk')).toBe(true);
    expect(p.isTierEnabled('dangerous')).toBe(false);
  });

  it('未配置 mode 时保持旧的 allowWrite 行为', () => {
    expect(new WebPermissionPolicy().isTierEnabled('normal')).toBe(false);
    expect(new WebPermissionPolicy({ allowWrite: true }).isTierEnabled('normal')).toBe(true);
  });

  it('关闭确认时按档位自动放行；dangerous 仍拒绝', async () => {
    const full = new WebPermissionPolicy({ mode: 'full', confirmActions: false });
    await expect(full.ask({ tier: 'normal' })).resolves.toBe('allow');
    await expect(full.ask({ tier: 'highRisk' })).resolves.toBe('allow');
    await expect(full.ask({ tier: 'dangerous' })).resolves.toBe('deny');

    const workspace = new WebPermissionPolicy({ mode: 'workspace', confirmActions: false });
    await expect(workspace.ask({ tier: 'highRisk' })).resolves.toBe('deny');
  });
});
