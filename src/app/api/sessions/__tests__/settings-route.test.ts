/**
 * PATCH /api/sessions/[id] 的验收
 *
 * 覆盖用户要求的：
 *   · 非法输入 400（reasoning / persona 长度 / memoryMode / 模型成对）
 *   · workspace / permission 的严格校验：
 *     - 工作区必须绝对、存在、是目录、非受保护目录；realpath 归一
 *     - permission 只接受 read-only / workspace / full / null
 *   · 合法更新后 session 状态变化；null = 跟随应用默认
 *   · DTO 带 workspace / permission / effectiveWorkspace / effectivePermission
 *   · session.settings 事件持久化 workspace/permission（可重放）
 *   · persona 正文落 sidecar（事件只记摘要）
 *   · 不存在的会话 → 404
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  resolveProfileModel: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({ getRuntime: mocks.getRuntime }));
vi.mock('@/app/server/modelProfiles.js', () => ({
  resolveProfileModel: mocks.resolveProfileModel,
}));

import { EventLog } from '@/core/events/log.js';
import { SessionStore } from '@/core/chat/types.js';
import { PATCH, GET } from '../[id]/route.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };

let chat: SessionStore;
let log: EventLog;
let base: string;
let dir: string;
let appRoot: string;
let workspace: string;
let previousDataDir: string | undefined;
let previousWorkspaceEnv: string | undefined;

function request(body: unknown): NextRequest {
  return new Request('http://localhost/api/sessions/s1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function context(id = 's1') {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'butler-patch-'));
  dir = join(base, 'data');
  appRoot = join(base, 'app');
  workspace = join(base, 'workspace');
  await mkdir(dir, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });

  previousDataDir = process.env['BUTLER_DATA_DIR'];
  previousWorkspaceEnv = process.env['BUTLER_WORKSPACE'];
  process.env['BUTLER_DATA_DIR'] = dir;

  log = new EventLog('s_test');
  chat = new SessionStore(log, clock, 'u');
  chat.createSession('s1');
  mocks.getRuntime.mockResolvedValue({
    bootstrapped: { chat, log },
    workspaceRoot: appRoot,
    dataDir: dir,
    permissionPolicy: { mode: 'view' },
  });
  mocks.resolveProfileModel.mockResolvedValue(null);
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env['BUTLER_DATA_DIR'];
  else process.env['BUTLER_DATA_DIR'] = previousDataDir;
  if (previousWorkspaceEnv === undefined) delete process.env['BUTLER_WORKSPACE'];
  else process.env['BUTLER_WORKSPACE'] = previousWorkspaceEnv;
  await rm(base, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('PATCH /api/sessions/[id]', () => {
  it('非法 reasoning → 400，状态不变', async () => {
    const res = await PATCH(request({ reasoning: 'ultra' }), context());
    expect(res.status).toBe(400);
    expect(chat.getSession('s1')!.reasoning).toBe('high');
  });

  it('persona 超过 8000 字 → 400', async () => {
    const res = await PATCH(request({ persona: 'a'.repeat(8001) }), context());
    expect(res.status).toBe(400);
  });

  it('memoryMode 非法 → 400', async () => {
    const res = await PATCH(request({ memoryMode: 'yes' }), context());
    expect(res.status).toBe(400);
  });

  it('未知字段 → 400，不静默写入', async () => {
    const res = await PATCH(request({ somethingElse: '/tmp' }), context());
    expect(res.status).toBe(400);
  });

  it('合法更新 → 200，返回值带完整设置；persona 落 sidecar', async () => {
    const res = await PATCH(
      request({ persona: '你是一位简洁的管家', reasoning: 'max', memoryMode: false }),
      context(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        settings: {
          persona: string;
          reasoning: string;
          memoryMode: string;
          workspace: string | null;
          permission: string | null;
          effectiveWorkspace: string;
          effectivePermission: string;
        };
      };
    };
    expect(body.session.settings.persona).toBe('你是一位简洁的管家');
    expect(body.session.settings.reasoning).toBe('max');
    expect(body.session.settings.memoryMode).toBe('off');
    // 未设置工作区/权限 → 跟随应用（全局 mode=view → 只读）
    expect(body.session.settings.workspace).toBeNull();
    expect(body.session.settings.permission).toBeNull();
    expect(body.session.settings.effectiveWorkspace).toBe(appRoot);
    expect(body.session.settings.effectivePermission).toBe('read-only');

    expect(chat.getSession('s1')!.persona).toBe('你是一位简洁的管家');
    expect(chat.getSession('s1')!.reasoning).toBe('max');
    expect(chat.getSession('s1')!.memoryMode).toBe('off');

    const sidecar = JSON.parse(
      await readFile(join(dir, 'session-settings.json'), 'utf8'),
    ) as { sessions: Record<string, { persona: string }> };
    expect(sidecar.sessions['s1']!.persona).toBe('你是一位简洁的管家');
  });

  it('保存工作区 → realpath 归一，DTO 与实际值一致，事件可重放', async () => {
    const raw = join(base, 'workspace', '..', 'workspace');
    const res = await PATCH(request({ workspace: raw, permission: 'workspace' }), context());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        settings: {
          workspace: string | null;
          permission: string | null;
          effectiveWorkspace: string;
          effectivePermission: string;
        };
      };
    };
    const expected = await realpath(workspace);
    expect(body.session.settings.workspace).toBe(expected);
    expect(body.session.settings.permission).toBe('workspace');
    expect(body.session.settings.effectiveWorkspace).toBe(expected);
    expect(body.session.settings.effectivePermission).toBe('workspace');
    expect(chat.getSession('s1')!.workspace).toBe(expected);
    expect(chat.getSession('s1')!.permission).toBe('workspace');

    const event = log
      .all()
      .filter((e) => e.type === 'session.settings')
      .find(
        (e) =>
          (e.payload as Record<string, unknown>)['source'] === 'patch' &&
          (e.payload as Record<string, unknown>)['workspace'] === expected,
      );
    expect(event).toBeDefined();
    expect((event!.payload as Record<string, unknown>)['permission']).toBe('workspace');
  });

  it('workspace/permission 传 null → 回到跟随应用', async () => {
    await PATCH(request({ workspace, permission: 'full' }), context());
    const res = await PATCH(request({ workspace: null, permission: null }), context());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { settings: { workspace: null; permission: null } };
    };
    expect(body.session.settings.workspace).toBeNull();
    expect(body.session.settings.permission).toBeNull();
    expect(chat.getSession('s1')!.workspace).toBeNull();
    expect(chat.getSession('s1')!.permission).toBeNull();
  });

  it('工作区不存在 / 不是目录 / 相对路径 / 系统数据目录 → 400，状态不变', async () => {
    const cases = [
      join(base, 'missing'),
      join(base, 'file.txt'),
      'relative\\workspace',
      dir,
      join(dir, 'sub'),
    ];
    await writeFile(join(base, 'file.txt'), 'x', 'utf8');
    await mkdir(join(dir, 'sub'), { recursive: true });

    for (const bad of cases) {
      const res = await PATCH(request({ workspace: bad }), context());
      expect(res.status, `workspace=${bad}`).toBe(400);
      expect(chat.getSession('s1')!.workspace).toBeNull();
    }
  });

  it('workspace 为 .env.local 文件 / 目录 → 400', async () => {
    const envFile = join(base, '.env.local');
    await writeFile(envFile, 'SECRET=x', 'utf8');
    expect((await PATCH(request({ workspace: envFile }), context())).status).toBe(400);

    const envDir = join(base, 'env-as-dir', '.env.local');
    await mkdir(envDir, { recursive: true });
    expect((await PATCH(request({ workspace: envDir }), context())).status).toBe(400);
  });

  it('workspace 不能设为应用 config 目录 → 400', async () => {
    const configDir = join(appRoot, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'AGENTS.md'), '# 全局规则', 'utf8');
    const res = await PATCH(request({ workspace: configDir }), context());
    expect(res.status).toBe(400);
    expect(chat.getSession('s1')!.workspace).toBeNull();
  });

  it('permission 非枚举 → 400', async () => {
    for (const value of ['view', 'readonly', 'FULL', 1, true]) {
      const res = await PATCH(request({ permission: value }), context());
      expect(res.status).toBe(400);
    }
    expect(chat.getSession('s1')!.permission).toBeNull();
  });

  it('GET 详情同样带配置值与实际值', async () => {
    await PATCH(request({ workspace, permission: 'workspace' }), context());
    const res = await GET(new Request('http://localhost/api/sessions/s1') as NextRequest, context());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: {
        settings: {
          workspace: string | null;
          permission: string | null;
          effectiveWorkspace: string;
          effectivePermission: string;
        };
      };
    };
    expect(body.session.settings.workspace).toBe(await realpath(workspace));
    expect(body.session.settings.permission).toBe('workspace');
    expect(body.session.settings.effectiveWorkspace).toBe(await realpath(workspace));
    expect(body.session.settings.effectivePermission).toBe('workspace');
  });

  it('不存在的会话 → 404', async () => {
    const res = await PATCH(request({ reasoning: 'low' }), context('missing'));
    expect(res.status).toBe(404);
  });

  it('模型不存在 → 400；合法模型 → 200 并更新 session', async () => {
    const bad = await PATCH(
      request({ modelProfileId: 'p1', modelId: 'm1' }),
      context(),
    );
    expect(bad.status).toBe(400);

    mocks.resolveProfileModel.mockResolvedValue({
      profile: { id: 'p1' },
      model: { id: 'm1', kind: 'chat' },
      preset: { id: 'deepseek' },
      config: {},
    });
    const ok = await PATCH(
      request({ modelProfileId: 'p1', modelId: 'm1' }),
      context(),
    );
    expect(ok.status).toBe(200);
    expect(chat.getSession('s1')!.modelProfileId).toBe('p1');
    expect(chat.getSession('s1')!.modelId).toBe('m1');
  });
});
