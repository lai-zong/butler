/**
 * 应用默认作用域映射（安全默认）
 *
 * ★ 未配置全局权限模式时必须落到只读；不能因为“没配置”就默认给写权限。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dataDirOf,
  defaultScopeDefaults,
  scopeDefaultsOf,
  sessionPermissionFromMode,
} from '../sessionScope.js';

let base = '';

afterEach(async () => {
  if (base.length > 0) await rm(base, { recursive: true, force: true });
  base = '';
});

describe('sessionPermissionFromMode', () => {
  it('view → read-only；workspace → workspace；full → full', () => {
    expect(sessionPermissionFromMode('view')).toBe('read-only');
    expect(sessionPermissionFromMode('workspace')).toBe('workspace');
    expect(sessionPermissionFromMode('full')).toBe('full');
  });

  it('undefined（未配置全局模式）→ read-only', () => {
    expect(sessionPermissionFromMode(undefined)).toBe('read-only');
  });
});

describe('scopeDefaultsOf', () => {
  it('运行时给了工作区/模式时使用运行时值', async () => {
    base = await mkdtemp(join(tmpdir(), 'butler-scope-defaults-'));
    const defaults = scopeDefaultsOf({
      workspaceRoot: base,
      dataDir: join(base, 'data'),
      permissionPolicy: { mode: 'workspace' },
    });
    expect(defaults.workspace).toBe(base);
    expect(defaults.permission).toBe('workspace');
    expect(dataDirOf({ workspaceRoot: base, dataDir: join(base, 'data') })).toBe(
      join(base, 'data'),
    );
  });

  it('运行时缺字段（测试 mock）时回退到 env/默认，不抛错', () => {
    const defaults = scopeDefaultsOf({});
    expect(defaults.workspace.length).toBeGreaterThan(0);
    expect(defaults.permission).toBe('read-only');
    expect(defaultScopeDefaults().permission).toBe('read-only');
  });

  it('mode 未配置时默认只读', () => {
    expect(scopeDefaultsOf({ permissionPolicy: { mode: undefined } }).permission).toBe(
      'read-only',
    );
  });
});
