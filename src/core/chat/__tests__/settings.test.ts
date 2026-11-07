/**
 * 会话级设置与每轮快照（用户确认过的设计）
 *
 * 覆盖：
 *   ① 新 session 默认 reasoning=high / persona 空 / memory on
 *   ② 旧 session 缺字段按默认补齐（不破坏历史）
 *   ③ 每轮快照：PATCH 只影响下一轮，当前轮不读 session
 *   ④ persona 请求级回退（旧桌宠）
 *   ⑤ session.settings 事件只记摘要，不写人格正文
 *   ⑥ 重放：旧事件补默认；turn 快照不覆盖持久设置
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { SessionStore, replaySessions } from '../types.js';
import {
  createTurnSettings,
  sessionSettingsOf,
  turnSettingsEventPayload,
} from '../settings.js';

const T0 = 1_760_000_000_000;
const clock = { now: () => T0 };

function freshStore(): { chat: SessionStore; log: EventLog } {
  const log = new EventLog('s_test');
  const chat = new SessionStore(log, clock, 'u');
  return { chat, log };
}

describe('① 新会话默认值', () => {
  it('persona 空 / reasoning high / memory on', () => {
    const { chat } = freshStore();
    const s = chat.createSession();
    expect(s.persona).toBe('');
    expect(s.reasoning).toBe('high');
    expect(s.memoryMode).toBe('on');
    expect(sessionSettingsOf(s)).toEqual({ persona: '', reasoning: 'high', memoryMode: 'on', workspace: null, permission: null });
  });
});

describe('② 旧会话缺字段按默认补齐', () => {
  it('只有 id/title 的历史会话 → 默认 high / on / 空人格', () => {
    const { chat } = freshStore();
    chat.restoreSession({
      id: 'old',
      userId: 'u',
      title: '旧对话',
      createdAt: 1,
      updatedAt: 1,
      turnCount: 3,
    });
    const old = chat.getSession('old');
    expect(old).toBeDefined();
    expect(sessionSettingsOf(old!)).toEqual({
      persona: '',
      reasoning: 'high',
      memoryMode: 'on',
      workspace: null,
      permission: null,
    });
  });
});

describe('③ 每轮快照：当前轮不变，下一轮生效', () => {
  it('PATCH 后旧快照保持原值，新快照用新值', () => {
    const { chat } = freshStore();
    const session = chat.createSession();
    chat.setSessionSettings(session.id, {
      persona: 'A 人格',
      reasoning: 'high',
      memoryMode: 'on',
      workspace: null,
      permission: null,
    });

    const turn1 = createTurnSettings({
      session: chat.getSession(session.id)!,
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0,
    });
    expect(turn1.persona).toBe('A 人格');
    expect(turn1.reasoning).toBe('high');
    expect(turn1.memoryMode).toBe('on');

    // 执行中用户 PATCH
    chat.setSessionSettings(session.id, {
      persona: 'B 人格',
      reasoning: 'off',
      memoryMode: 'off',
    });

    // 当前轮快照不变
    expect(turn1.persona).toBe('A 人格');
    expect(turn1.reasoning).toBe('high');
    expect(turn1.reasoningPlan.applied).toBe('high');
    expect(turn1.memoryMode).toBe('on');

    // 下一轮才用新值
    const turn2 = createTurnSettings({
      session: chat.getSession(session.id)!,
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0 + 1,
    });
    expect(turn2.persona).toBe('B 人格');
    expect(turn2.reasoning).toBe('off');
    expect(turn2.reasoningPlan.applied).toBe('off');
    expect(turn2.memoryMode).toBe('off');
  });
});

describe('④ persona 兼容回退', () => {
  it('session 为空时用请求 body 的人格，并标记来源 request', () => {
    const { chat } = freshStore();
    const session = chat.createSession();
    const turn = createTurnSettings({
      session,
      requestPersona: '桌宠人格',
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0,
    });
    expect(turn.persona).toBe('桌宠人格');
    expect(turn.personaSource).toBe('request');
  });

  it('session 有 persona 时请求 body 不能覆盖（会话设置优先）', () => {
    const { chat } = freshStore();
    const session = chat.createSession();
    chat.setSessionSettings(session.id, { persona: '会话人格' });
    const turn = createTurnSettings({
      session: chat.getSession(session.id)!,
      requestPersona: '桌宠人格',
      capturedAt: T0,
    });
    expect(turn.persona).toBe('会话人格');
    expect(turn.personaSource).toBe('session');
  });

  it('新会话已有 reasoning 时，旧桌宠 thinkingLevel 不能覆盖', () => {
    const { chat } = freshStore();
    const session = chat.createSession(); // reasoning = high
    const turn = createTurnSettings({
      session,
      legacyThinkingLevel: 'low',
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0,
    });
    expect(turn.reasoning).toBe('high');
    expect(turn.reasoningSource).toBe('session');
  });

  it('Web 会话 off + 桌宠旧 high → 仍用会话 off', () => {
    const { chat } = freshStore();
    const session = chat.createSession();
    chat.setSessionSettings(session.id, { reasoning: 'off' });
    const turn = createTurnSettings({
      session: chat.getSession(session.id)!,
      legacyThinkingLevel: 'high',
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0,
    });
    expect(turn.reasoning).toBe('off');
    expect(turn.reasoningSource).toBe('session');
    expect(turn.reasoningPlan.applied).toBe('off');
  });

  it('只有旧 session（缺 reasoning 字段）才用旧桌宠档位兜底', () => {
    const { chat } = freshStore();
    chat.restoreSession({
      id: 'old-thinking',
      userId: 'u',
      title: '旧对话',
      createdAt: 1,
      updatedAt: 1,
      turnCount: 0,
    });
    const old = chat.getSession('old-thinking')!;

    const low = createTurnSettings({
      session: old,
      legacyThinkingLevel: 'low',
      reasoningProvider: 'deepseek',
      model: 'deepseek-flash',
      capturedAt: T0,
    });
    expect(low.reasoning).toBe('low');
    expect(low.reasoningSource).toBe('request-legacy');

    for (const legacy of ['default', 'medium', 'high'] as const) {
      const turn = createTurnSettings({
        session: old,
        legacyThinkingLevel: legacy,
        reasoningProvider: 'deepseek',
        model: 'deepseek-flash',
        capturedAt: T0,
      });
      expect(turn.reasoning).toBe('high');
    }
  });
});

describe('⑤ session.settings 事件只记摘要', () => {
  it('不写人格正文，只写 hash / 长度 / 档位', () => {
    const { chat, log } = freshStore();
    const session = chat.createSession();
    chat.setSessionSettings(session.id, {
      persona: '这是我的秘密人格，不要在事件里出现',
      reasoning: 'max',
      memoryMode: 'off',
    });

    const event = log.all().find((e) => e.type === 'session.settings');
    expect(event).toBeDefined();
    const payload = event!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('秘密人格');
    expect(payload['personaLength']).toBe('这是我的秘密人格，不要在事件里出现'.length);
    expect(typeof payload['personaHash']).toBe('string');
    expect(payload['reasoning']).toBe('max');
    expect(payload['memoryMode']).toBe('off');
    expect(payload['source']).toBe('patch');
  });

  it('每轮快照事件同样只记摘要', () => {
    const { chat } = freshStore();
    const session = chat.createSession();
    chat.setSessionSettings(session.id, { persona: '正文不应进事件' });
    const turn = createTurnSettings({
      session: chat.getSession(session.id)!,
      capturedAt: T0,
    });
    const payload = turnSettingsEventPayload(turn);
    expect(JSON.stringify(payload)).not.toContain('正文不应进事件');
    expect(payload['personaLength']).toBe('正文不应进事件'.length);
    expect(payload['source']).toBe('turn');
  });
});

describe('⑦ 会话工具作用域（workspace / permission）', () => {
  it('新会话默认 null/null；PATCH 后进 session.settings 事件', () => {
    const { chat, log } = freshStore();
    const s = chat.createSession();
    expect(s.workspace).toBeNull();
    expect(s.permission).toBeNull();

    chat.setSessionSettings(s.id, {
      workspace: 'C:\\work\\alpha',
      permission: 'workspace',
    });
    const next = chat.getSession(s.id)!;
    expect(next.workspace).toBe('C:\\work\\alpha');
    expect(next.permission).toBe('workspace');

    const event = log
      .all()
      .filter((e) => e.type === 'session.settings')
      .find((e) => (e.payload as Record<string, unknown>)['source'] === 'patch');
    expect(event).toBeDefined();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload['workspace']).toBe('C:\\work\\alpha');
    expect(payload['permission']).toBe('workspace');
  });

  it('TurnSettings 记下配置值与生效值；执行中 PATCH 不改变当前轮', () => {
    const { chat } = freshStore();
    const s = chat.createSession();
    chat.setSessionSettings(s.id, {
      workspace: 'C:\\work\\alpha',
      permission: 'workspace',
    });

    const turn1 = createTurnSettings({
      session: chat.getSession(s.id)!,
      defaultWorkspace: 'C:\\app',
      defaultPermission: 'read-only',
      capturedAt: T0,
    });
    expect(turn1.workspace).toBe('C:\\work\\alpha');
    expect(turn1.permission).toBe('workspace');
    expect(turn1.workspaceSource).toBe('session');
    expect(turn1.permissionSource).toBe('session');
    expect(turn1.effectiveWorkspace).toBe('C:\\work\\alpha');
    expect(turn1.effectivePermission).toBe('workspace');

    chat.setSessionSettings(s.id, {
      workspace: 'C:\\work\\beta',
      permission: 'full',
    });

    // 当前轮快照不变
    expect(turn1.effectiveWorkspace).toBe('C:\\work\\alpha');
    expect(turn1.effectivePermission).toBe('workspace');

    // 下一轮才用新值
    const turn2 = createTurnSettings({
      session: chat.getSession(s.id)!,
      defaultWorkspace: 'C:\\app',
      defaultPermission: 'read-only',
      capturedAt: T0 + 1,
    });
    expect(turn2.effectiveWorkspace).toBe('C:\\work\\beta');
    expect(turn2.effectivePermission).toBe('full');
  });

  it('配置为 null 时使用应用默认，并标记来源 default', () => {
    const { chat } = freshStore();
    const s = chat.createSession();
    const turn = createTurnSettings({
      session: s,
      defaultWorkspace: 'C:\\app',
      defaultPermission: 'workspace',
      capturedAt: T0,
    });
    expect(turn.workspace).toBeNull();
    expect(turn.permission).toBeNull();
    expect(turn.workspaceSource).toBe('default');
    expect(turn.permissionSource).toBe('default');
    expect(turn.effectiveWorkspace).toBe('C:\\app');
    expect(turn.effectivePermission).toBe('workspace');
  });

  it('每轮快照事件带上作用域字段（不含人格正文）', () => {
    const { chat } = freshStore();
    const s = chat.createSession();
    chat.setSessionSettings(s.id, { workspace: 'C:\\work\\alpha', permission: 'workspace' });
    const turn = createTurnSettings({
      session: chat.getSession(s.id)!,
      defaultWorkspace: 'C:\\app',
      defaultPermission: 'read-only',
      capturedAt: T0,
    });
    const payload = turnSettingsEventPayload(turn);
    expect(payload['workspace']).toBe('C:\\work\\alpha');
    expect(payload['permission']).toBe('workspace');
    expect(payload['effectiveWorkspace']).toBe('C:\\work\\alpha');
    expect(payload['effectivePermission']).toBe('workspace');
  });

  it('重放恢复 workspace/permission；显式 null 清空；旧事件缺字段不清空', () => {
    const restored = replaySessions([
      { type: 'session.forked', payload: { sessionId: 's1' }, createdAt: 10 },
      {
        type: 'session.settings',
        payload: {
          sessionId: 's1',
          source: 'patch',
          workspace: 'C:\\work\\alpha',
          permission: 'workspace',
        },
        createdAt: 20,
      },
      // 旧版本事件：没有 workspace/permission 字段，不应清掉已有值
      {
        type: 'session.settings',
        payload: { sessionId: 's1', source: 'patch', reasoning: 'low' },
        createdAt: 30,
      },
    ]);
    expect(restored.sessions[0]!.workspace).toBe('C:\\work\\alpha');
    expect(restored.sessions[0]!.permission).toBe('workspace');

    const cleared = replaySessions([
      ...restored.sessions.map((s) => ({
        type: 'session.forked',
        payload: { sessionId: s.id },
        createdAt: 10,
      })),
      {
        type: 'session.settings',
        payload: {
          sessionId: 's1',
          source: 'patch',
          workspace: null,
          permission: null,
        },
        createdAt: 40,
      },
    ]);
    expect(cleared.sessions[0]!.workspace).toBeNull();
    expect(cleared.sessions[0]!.permission).toBeNull();
  });
});

describe('⑥ 重放兼容', () => {
  it('旧 session.forked 重放后补默认设置', () => {
    const r = replaySessions([
      { type: 'session.forked', payload: { sessionId: 's1' }, createdAt: 10 },
    ]);
    expect(r.sessions).toHaveLength(1);
    expect(sessionSettingsOf(r.sessions[0]!)).toEqual({
      persona: '',
      reasoning: 'high',
      memoryMode: 'on',
      workspace: null,
      permission: null,
    });
  });

  it('PATCH 事件重放生效', () => {
    const r = replaySessions([
      { type: 'session.forked', payload: { sessionId: 's1' }, createdAt: 10 },
      {
        type: 'session.settings',
        payload: { sessionId: 's1', source: 'patch', reasoning: 'max', memoryMode: 'off' },
        createdAt: 20,
      },
    ]);
    expect(sessionSettingsOf(r.sessions[0]!)).toEqual({
      persona: '',
      reasoning: 'max',
      memoryMode: 'off',
      workspace: null,
      permission: null,
    });
  });

  it('turn 快照事件不覆盖持久设置（桌宠旧档位只影响当轮）', () => {
    const r = replaySessions([
      { type: 'session.forked', payload: { sessionId: 's1' }, createdAt: 10 },
      {
        type: 'session.settings',
        payload: { sessionId: 's1', source: 'turn', reasoning: 'max', memoryMode: 'off' },
        createdAt: 20,
      },
    ]);
    expect(sessionSettingsOf(r.sessions[0]!)).toEqual({
      persona: '',
      reasoning: 'high',
      memoryMode: 'on',
      workspace: null,
      permission: null,
    });
  });
});
