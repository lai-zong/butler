import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../lib/types.js';
import {
  SESSION_PERMISSION_LABEL,
  SESSION_PERMISSION_NOTE,
  modelRefOf,
  sanitizeSessionSummary,
  scopeOf,
  scopePatchOf,
  settingsOf,
  shortModelName,
} from '../sessionSettings.js';

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    title: '测试',
    titleGenerated: true,
    pinnedAt: null,
    pinnedWorkspace: null,
    createdAt: 1,
    updatedAt: 2,
    turnCount: 3,
    messageCount: 4,
    verdictCount: 0,
    lastPreview: '预览',
    workspace: null,
    permission: null,
    effectiveWorkspace: 'C:\\app',
    effectivePermission: 'read-only',
    settings: {
      reasoning: 'max',
      memoryMode: 'off',
      hasPersona: true,
      personaLength: 5,
      personaPreview: '人格…',
      persona: '人格正文',
      personaHash: 'abcd1234',
      workspace: null,
      permission: null,
      effectiveWorkspace: 'C:\\app',
      effectivePermission: 'read-only',
    },
    ...patch,
  };
}

describe('settingsOf', () => {
  it('读取会话设置', () => {
    expect(settingsOf(summary())).toEqual({
      reasoning: 'max',
      memoryMode: 'off',
      hasPersona: true,
      personaLength: 5,
      personaPreview: '人格…',
    });
  });

  it('缺字段/旧数据回落到新对话默认值', () => {
    const legacy = {
      ...summary(),
      settings: undefined,
    } as unknown as SessionSummary;
    expect(settingsOf(legacy)).toEqual({
      reasoning: 'high',
      memoryMode: 'on',
      hasPersona: false,
      personaLength: 0,
      personaPreview: '',
    });
    expect(settingsOf(undefined).reasoning).toBe('high');
  });
});

describe('scopeOf', () => {
  it('配置为 null 时显示服务端给出的实际值（跟随应用）', () => {
    expect(scopeOf(summary())).toEqual({
      workspace: null,
      permission: null,
      effectiveWorkspace: 'C:\\app',
      effectivePermission: 'read-only',
    });
  });

  it('配置了工作区/权限时优先返回配置值', () => {
    const configured = summary({
      settings: {
        ...summary().settings,
        workspace: 'C:\\work\\alpha',
        permission: 'workspace',
        effectiveWorkspace: 'C:\\work\\alpha',
        effectivePermission: 'workspace',
      },
    });
    expect(scopeOf(configured)).toEqual({
      workspace: 'C:\\work\\alpha',
      permission: 'workspace',
      effectiveWorkspace: 'C:\\work\\alpha',
      effectivePermission: 'workspace',
    });
  });

  it('旧服务端缺 effective 字段时回退到配置值/只读', () => {
    const legacy = summary({
      settings: {
        ...summary().settings,
        workspace: 'C:\\work\\alpha',
        permission: null,
        effectiveWorkspace: undefined,
        effectivePermission: undefined,
      } as unknown as SessionSummary['settings'],
    });
    expect(scopeOf(legacy)).toEqual({
      workspace: 'C:\\work\\alpha',
      permission: null,
      effectiveWorkspace: 'C:\\work\\alpha',
      effectivePermission: 'read-only',
    });
  });

  it('三档权限标签齐全，文案与实际能力一致', () => {
    expect(SESSION_PERMISSION_LABEL['read-only']).toBe('只读');
    expect(SESSION_PERMISSION_LABEL.workspace).toBe('工作区');
    expect(SESSION_PERMISSION_LABEL.full).toBe('完全');
    // workspace 不宣称移动/删除/执行
    expect(SESSION_PERMISSION_NOTE.workspace).toContain('不提供移动');
    expect(SESSION_PERMISSION_NOTE.workspace).toContain('不提供移动、删除或命令执行');
    // full 说明命令工具不可用、受保护路径拒绝
    expect(SESSION_PERMISSION_NOTE.full).toContain('命令执行不提供');
    expect(SESSION_PERMISSION_NOTE.full).toContain('config');
  });
});

describe('scopePatchOf', () => {
  it('留空 = 跟随应用（null），不是空字符串', () => {
    expect(scopePatchOf({ workspace: '  ', permission: '' })).toEqual({
      workspace: null,
      permission: null,
    });
  });

  it('路径 trim 后提交，权限原样提交', () => {
    expect(
      scopePatchOf({ workspace: '  C:\\work\\alpha  ', permission: 'full' }),
    ).toEqual({ workspace: 'C:\\work\\alpha', permission: 'full' });
  });
});

describe('modelRefOf', () => {
  it('只有成对字段才返回模型', () => {
    expect(
      modelRefOf(
        summary({
          settings: {
            ...summary().settings,
            modelProfileId: 'p1',
            modelId: 'deepseek-chat',
          },
        }),
      ),
    ).toEqual({ profileId: 'p1', modelId: 'deepseek-chat' });
  });

  it('缺一个字段视为未选模型', () => {
    expect(
      modelRefOf({
        ...summary(),
        settings: { ...summary().settings, modelProfileId: 'p1' },
      }),
    ).toBeNull();
  });
});

describe('shortModelName', () => {
  it('取命名空间最后一段并截断', () => {
    expect(shortModelName('deepseek/deepseek-chat')).toBe('deepseek-chat');
    expect(shortModelName('  glm-4.6  ')).toBe('glm-4.6');
    expect(shortModelName('x'.repeat(30))).toHaveLength(20);
    expect(shortModelName(null)).toBe('未选模型');
  });
});

describe('sanitizeSessionSummary', () => {
  it('写回列表缓存前去掉完整人格正文', () => {
    const sanitized = sanitizeSessionSummary(summary());
    expect(sanitized.settings.persona).toBeNull();
    expect(sanitized.settings.personaPreview).toBe('人格…');
    expect(sanitized.settings.personaHash).toBe('abcd1234');
    expect(sanitized.settings.hasPersona).toBe(true);
  });
});
