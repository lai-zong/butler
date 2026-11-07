/**
 * POST /api/chat 的每轮设置快照
 *
 * ★ 这是本轮最核心的验收：
 *   请求开始时读一次 session 设置 → 生成 TurnSettings；
 *   执行中 PATCH 不改变当前轮，下一轮才生效。
 *   工作区/权限同样进快照，并且本轮 tools 是用旧快照构造的独立作用域。
 *
 * 做法：mock 掉 `runTurn`，让它挂起；
 * 挂起期间改 session，再放行并检查它收到的 settings 与 tools。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  runTurn: vi.fn(),
  loadProfileStore: vi.fn(),
  saveProfileStore: vi.fn(),
  resolveProfileModel: vi.fn(),
  loadGlobalAgents: vi.fn(),
}));

vi.mock('@/app/runtime', () => ({
  getRuntime: mocks.getRuntime,
  DATA_DIR: 'C:/tmp/butler-chat-route-test',
}));
vi.mock('@/core/chat/service.js', () => ({ runTurn: mocks.runTurn }));
vi.mock('@/app/server/modelProfiles.js', () => ({
  loadProfileStore: mocks.loadProfileStore,
  saveProfileStore: mocks.saveProfileStore,
  resolveProfileModel: mocks.resolveProfileModel,
}));
vi.mock('@/app/server/globalAgents.js', () => ({
  loadGlobalAgents: mocks.loadGlobalAgents,
}));

import { EventLog } from '@/core/events/log.js';
import { SessionStore } from '@/core/chat/types.js';
import { ToolFramework } from '@/core/tools/framework.js';
import { SessionPermissionPolicy } from '@/app/server/sessionPermission.js';
import { POST } from '../route.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };
const GLOBAL = {
  text: '全局规则',
  hash: 'a'.repeat(64),
  length: 4,
  loaded: true,
  truncated: false,
};

let chat: SessionStore;
let log: EventLog;
let runtime: Record<string, unknown>;
let captured: Array<Record<string, unknown>>;
let baseDir = '';
let wsA = '';
let wsB = '';
let globalTools: ToolFramework;
let previousDataDir: string | undefined;
let previousWorkspaceEnv: string | undefined;

function fakeRunTurnResult() {
  return {
    userMessageId: 'u1',
    replyMessageId: 'r1',
    replyText: '好的',
    verdict: {
      id: 'v1',
      sessionId: 's1',
      forMessageId: 'u1',
      outcome: 'accepted',
      summary: '已完成',
      issues: [],
      criteriaChecks: [],
      steps: [],
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      artifactIds: [],
      createdAt: T0,
    },
    session: {
      contract: undefined,
      assumption: undefined,
      injectedConstraints: [],
    },
    executionReports: [],
  };
}

function request(sessionId = 's1'): NextRequest {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '你好' }),
  }) as unknown as NextRequest;
}

function requestWith(
  overrides: Record<string, unknown>,
  sessionId = 's1',
): NextRequest {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '你好', ...overrides }),
  }) as unknown as NextRequest;
}

async function waitForCall(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (mocks.runTurn.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('runTurn 没有被调用');
}

beforeEach(async () => {
  captured = [];
  log = new EventLog('s_test');
  chat = new SessionStore(log, clock, 'u');
  chat.createSession('s1');
  chat.setSessionSettings('s1', {
    persona: 'A 人格',
    reasoning: 'high',
    memoryMode: 'on',
  });

  baseDir = await mkdtemp(join(tmpdir(), 'butler-chat-snapshot-'));
  wsA = join(baseDir, 'workspace-a');
  wsB = join(baseDir, 'workspace-b');
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  await writeFile(join(wsA, 'who.txt'), '来自工作区 A', 'utf8');
  await writeFile(join(wsB, 'who.txt'), '来自工作区 B', 'utf8');
  previousDataDir = process.env['BUTLER_DATA_DIR'];
  previousWorkspaceEnv = process.env['BUTLER_WORKSPACE'];
  process.env['BUTLER_DATA_DIR'] = join(baseDir, 'data');
  process.env['BUTLER_WORKSPACE'] = wsA;

  globalTools = new ToolFramework({
    log,
    clock,
    policy: new SessionPermissionPolicy('read-only'),
  });

  runtime = {
    bootstrapped: { chat, log },
    clock,
    dataDir: join(baseDir, 'data'),
    workspaceRoot: wsA,
    permissionPolicy: { mode: 'view' },
    random: { next: () => 0.5 },
    model: {
      describe: () => ({
        provider: 'deepseek',
        model: 'deepseek-flash',
        capabilities: {
          supportsVision: true,
          supportsStreaming: true,
          supportsTools: true,
          supportsThinking: true,
        },
      }),
    },
    streamModel: null,
    translator: null,
    rerankModel: null,
    rerankScorer: null,
    evolution: undefined,
    semantic: undefined,
    tools: globalTools,
    activeTurns: 0,
  };
  mocks.getRuntime.mockResolvedValue(runtime);
  mocks.loadProfileStore.mockResolvedValue({
    version: 1,
    profiles: [],
    active: null,
    lastChat: null,
    lastReview: null,
    embedding: { kind: 'builtin', label: 'x', dimension: 768 },
  });
  mocks.saveProfileStore.mockResolvedValue(undefined);
  mocks.resolveProfileModel.mockResolvedValue(null);
  mocks.loadGlobalAgents.mockResolvedValue(GLOBAL);
  mocks.runTurn.mockImplementation((args: Record<string, unknown>) => {
    captured.push(args);
    return Promise.resolve(fakeRunTurnResult());
  });
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env['BUTLER_DATA_DIR'];
  else process.env['BUTLER_DATA_DIR'] = previousDataDir;
  if (previousWorkspaceEnv === undefined) delete process.env['BUTLER_WORKSPACE'];
  else process.env['BUTLER_WORKSPACE'] = previousWorkspaceEnv;
  await rm(baseDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('POST /api/chat · TurnSettings 快照', () => {
  it('执行中 PATCH 不影响当前轮（含工作区/权限/工具作用域）；下一轮才生效', async () => {
    chat.setSessionSettings('s1', {
      workspace: wsA,
      permission: 'workspace',
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.runTurn.mockImplementationOnce(
      async (args: Record<string, unknown>) => {
        captured.push(args);
        await gate;
        return fakeRunTurnResult();
      },
    );

    const res1 = await POST(request());
    const text1 = res1.text();

    await waitForCall();
    expect(captured[0]!['settings']).toBeDefined();
    const first = captured[0]!['settings'] as {
      persona: string;
      reasoning: string;
      globalAgents: { hash: string };
      effectiveWorkspace: string;
      effectivePermission: string;
    };
    expect(first.persona).toBe('A 人格');
    expect(first.reasoning).toBe('high');
    expect(first.globalAgents.hash).toBe(GLOBAL.hash);
    expect(first.effectiveWorkspace).toBe(wsA);
    expect(first.effectivePermission).toBe('workspace');

    // ★ 本轮 tools 是独立作用域，不是共享的 rt.tools；root 是工作区 A
    const firstTools = captured[0]!['tools'] as ToolFramework;
    expect(firstTools).toBeInstanceOf(ToolFramework);
    expect(firstTools).not.toBe(globalTools);
    const firstRead = await firstTools.execute({
      toolName: 'read_file',
      args: { path: 'who.txt' },
      taskId: 't-a',
    });
    expect(firstRead.output).toContain('来自工作区 A');

    // 当前轮执行中修改设置
    chat.setSessionSettings('s1', {
      persona: 'B 人格',
      reasoning: 'off',
      memoryMode: 'off',
      workspace: wsB,
      permission: 'full',
    });

    release();
    await text1;

    // 当前轮快照、当前轮工具作用域仍是旧值
    expect(first.persona).toBe('A 人格');
    expect(first.reasoning).toBe('high');
    expect(first.effectiveWorkspace).toBe(wsA);
    expect(first.effectivePermission).toBe('workspace');
    const afterPatchRead = await firstTools.execute({
      toolName: 'read_file',
      args: { path: 'who.txt' },
      taskId: 't-a-2',
    });
    expect(afterPatchRead.output).toContain('来自工作区 A');
    await expect(
      firstTools.execute({
        toolName: 'read_file',
        args: { path: join(wsB, 'who.txt') },
        taskId: 't-a-3',
      }),
    ).rejects.toThrow(/工作区权限拒绝/);

    // 下一轮用新值（工作区 B + full）
    const res2 = await POST(request());
    await res2.text();
    const second = captured[1]!['settings'] as {
      persona: string;
      reasoning: string;
      memoryMode: string;
      effectiveWorkspace: string;
      effectivePermission: string;
    };
    expect(second.persona).toBe('B 人格');
    expect(second.reasoning).toBe('off');
    expect(second.memoryMode).toBe('off');
    expect(second.effectiveWorkspace).toBe(wsB);
    expect(second.effectivePermission).toBe('full');

    const secondTools = captured[1]!['tools'] as ToolFramework;
    const secondRead = await secondTools.execute({
      toolName: 'read_file',
      args: { path: 'who.txt' },
      taskId: 't-b',
    });
    expect(secondRead.output).toContain('来自工作区 B');
  });

  it('两个并发会话各自用不同的工作区/权限作用域，工具不串', async () => {
    chat.createSession('s2');
    chat.setSessionSettings('s1', { workspace: wsA, permission: 'workspace' });
    chat.setSessionSettings('s2', { workspace: wsB, permission: 'full' });

    const [r1, r2] = await Promise.all([POST(request('s1')), POST(request('s2'))]);
    await Promise.all([r1.text(), r2.text()]);

    const first = captured.find((c) => c['sessionId'] === 's1');
    const second = captured.find((c) => c['sessionId'] === 's2');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const firstSettings = first!['settings'] as {
      effectiveWorkspace: string;
      effectivePermission: string;
    };
    const secondSettings = second!['settings'] as {
      effectiveWorkspace: string;
      effectivePermission: string;
    };
    expect(firstSettings.effectiveWorkspace).toBe(wsA);
    expect(firstSettings.effectivePermission).toBe('workspace');
    expect(secondSettings.effectiveWorkspace).toBe(wsB);
    expect(secondSettings.effectivePermission).toBe('full');

    const firstTools = first!['tools'] as ToolFramework;
    const secondTools = second!['tools'] as ToolFramework;
    expect(firstTools).not.toBe(secondTools);
    expect(firstTools).not.toBe(globalTools);
    expect(secondTools).not.toBe(globalTools);

    const [readA, readB] = await Promise.all([
      firstTools.execute({ toolName: 'read_file', args: { path: 'who.txt' }, taskId: 'c-a' }),
      secondTools.execute({ toolName: 'read_file', args: { path: 'who.txt' }, taskId: 'c-b' }),
    ]);
    expect(readA.output).toContain('来自工作区 A');
    expect(readB.output).toContain('来自工作区 B');

    // 权限不串：读只读档位在 A 可以用，但 A 的 scope 不能读 B 的绝对路径
    await expect(
      firstTools.execute({
        toolName: 'read_file',
        args: { path: join(wsB, 'who.txt') },
        taskId: 'c-a-2',
      }),
    ).rejects.toThrow(/工作区权限拒绝/);
  });

  it('每轮写 session.settings 事件，且事件不包含人格正文，但包含作用域', async () => {
    chat.setSessionSettings('s1', { workspace: wsA, permission: 'workspace' });
    const res = await POST(request());
    await res.text();

    const events = log.all().filter((e) => e.type === 'session.settings');
    // 至少一条 turn 快照
    const turnEvents = events.filter(
      (e) => (e.payload as Record<string, unknown>)['source'] === 'turn',
    );
    expect(turnEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(turnEvents[0]!.payload)).not.toContain('A 人格');
    const payload = turnEvents[0]!.payload as Record<string, unknown>;
    expect(payload['personaLength']).toBe('A 人格'.length);
    expect(payload['reasoning']).toBe('high');
    expect(payload['reasoningApplied']).toBe('high');
    expect(payload['workspace']).toBe(wsA);
    expect(payload['permission']).toBe('workspace');
    expect(payload['effectiveWorkspace']).toBe(wsA);
    expect(payload['effectivePermission']).toBe('workspace');
    expect((payload['globalAgents'] as Record<string, unknown>)['hash']).toBe(GLOBAL.hash);
  });

  it('会话工作区在落库后被删除 → POST /api/chat 返回 400，而不是流式里才炸', async () => {
    chat.setSessionSettings('s1', { workspace: join(baseDir, 'gone'), permission: 'workspace' });
    const res = await POST(request());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('工作区不可用');
  });

  it('Web 会话 reasoning=off / model=GLM → 桌宠旧 high/deepseek 不覆盖', async () => {
    chat.setSessionModel('s1', 'p-glm', 'glm-4.6');
    chat.setSessionSettings('s1', { reasoning: 'off' });
    mocks.loadProfileStore.mockResolvedValue({
      version: 1,
      profiles: [],
      active: null,
      // 最近使用模型是 deepseek —— 也不能盖过 session 的 GLM
      lastChat: { profileId: 'p-deepseek', modelId: 'deepseek-flash' },
      lastReview: null,
      embedding: { kind: 'builtin', label: 'x', dimension: 768 },
    });
    mocks.resolveProfileModel.mockImplementation(
      async (_dir: string, profileId: string, modelId: string) =>
        profileId === 'p-glm' && modelId === 'glm-4.6'
          ? {
              profile: { id: 'p-glm' },
              model: { id: 'glm-4.6', kind: 'chat' },
              preset: { id: 'zhipu', adapter: 'openai' },
              config: { apiKey: 'k', model: 'glm-4.6' },
            }
          : null,
    );

    const res = await POST(
      requestWith({
        modelProfileId: 'p-deepseek',
        modelId: 'deepseek-flash',
        thinkingLevel: 'high',
      }),
    );
    await res.text();

    const settings = captured[0]!['settings'] as {
      reasoning: string;
      modelProfileId: string;
      modelId: string;
    };
    expect(settings.reasoning).toBe('off');
    expect(settings.modelProfileId).toBe('p-glm');
    expect(settings.modelId).toBe('glm-4.6');
    expect(mocks.resolveProfileModel).toHaveBeenCalledWith(
      expect.anything(),
      'p-glm',
      'glm-4.6',
      'chat',
    );
    // session 模型/设置不能被 body 回写
    expect(chat.getSession('s1')!.modelProfileId).toBe('p-glm');
    expect(chat.getSession('s1')!.modelId).toBe('glm-4.6');
    expect(chat.getSession('s1')!.reasoning).toBe('off');
  });

  it('session 没有模型时 body 模型只兜底本轮，不写回 session', async () => {
    chat.createSession('s2');
    mocks.resolveProfileModel.mockResolvedValue({
      profile: { id: 'p-deepseek' },
      model: { id: 'deepseek-flash', kind: 'chat' },
      preset: { id: 'deepseek', adapter: 'deepseek' },
      config: { apiKey: 'k', model: 'deepseek-flash' },
    });

    const res = await POST(
      requestWith({ modelProfileId: 'p-deepseek', modelId: 'deepseek-flash' }, 's2'),
    );
    await res.text();

    const settings = captured[0]!['settings'] as {
      modelProfileId: string;
      modelId: string;
    };
    expect(settings.modelProfileId).toBe('p-deepseek');
    expect(settings.modelId).toBe('deepseek-flash');
    // ★ 只兜底本轮，session 仍是“未选模型”
    expect(chat.getSession('s2')!.modelProfileId).toBeUndefined();
    expect(chat.getSession('s2')!.modelId).toBeUndefined();
  });
});
