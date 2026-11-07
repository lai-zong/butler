/**
 * 会话 DTO 的设置投影
 *
 * ★ 列表只给摘要（persona=null + preview），详情给完整正文。
 *   这样 Web 会话列表不会因为人格正文变重，但点进详情能编辑。
 */

import { describe, expect, it } from 'vitest';

import type { ChatSession } from '@/core/chat/types.js';
import { toSessionDetailDto, toSessionDto } from '../uiData.js';

const SESSION: ChatSession = {
  id: 's1',
  userId: 'u',
  title: '新对话',
  createdAt: 1,
  updatedAt: 2,
  turnCount: 0,
  persona: '你是一位说话简洁、先给结论的管家。',
  reasoning: 'max',
  memoryMode: 'off',
  workspace: 'C:\\work\\alpha',
  permission: 'workspace',
  modelProfileId: 'p1',
  modelId: 'm1',
};

describe('会话 DTO 的 settings', () => {
  it('列表：只给摘要，不泄露完整人格正文', () => {
    const dto = toSessionDto(SESSION, [], []);
    expect(dto.settings.reasoning).toBe('max');
    expect(dto.settings.memoryMode).toBe('off');
    expect(dto.settings.hasPersona).toBe(true);
    expect(dto.settings.personaLength).toBe(SESSION.persona!.length);
    expect(dto.settings.persona).toBeNull();
    expect(dto.settings.personaPreview.length).toBeGreaterThan(0);
    expect(dto.settings.modelProfileId).toBe('p1');
    expect(dto.settings.modelId).toBe('m1');
    expect(dto.settings.workspace).toBe('C:\\work\\alpha');
    expect(dto.settings.permission).toBe('workspace');
    expect(dto.settings.effectiveWorkspace).toBe('C:\\work\\alpha');
    expect(dto.settings.effectivePermission).toBe('workspace');
    expect(dto.workspace).toBe('C:\\work\\alpha');
    expect(dto.permission).toBe('workspace');
  });

  it('详情：给完整人格正文', () => {
    const dto = toSessionDetailDto(SESSION, [], []);
    expect(dto.settings.persona).toBe(SESSION.persona);
  });

  it('旧 session 缺字段 → DTO 也补默认值', () => {
    const old: ChatSession = {
      id: 'old',
      userId: 'u',
      title: '旧对话',
      createdAt: 1,
      updatedAt: 2,
      turnCount: 0,
    };
    const dto = toSessionDto(old, [], [], {
      scopeDefaults: { workspace: 'C:\\app', permission: 'workspace' },
    });
    expect(dto.settings.reasoning).toBe('high');
    expect(dto.settings.memoryMode).toBe('on');
    expect(dto.settings.hasPersona).toBe(false);
    expect(dto.settings.persona).toBeNull();
    expect(dto.settings.workspace).toBeNull();
    expect(dto.settings.permission).toBeNull();
    expect(dto.settings.effectiveWorkspace).toBe('C:\\app');
    expect(dto.settings.effectivePermission).toBe('workspace');
  });

  it('会话配置为 null 时，effective 用应用默认权限（not 客户端猜测）', () => {
    const dto = toSessionDto(
      { ...SESSION, workspace: null, permission: null },
      [],
      [],
      { scopeDefaults: { workspace: 'D:\\默认', permission: 'full' } },
    );
    expect(dto.settings.workspace).toBeNull();
    expect(dto.settings.permission).toBeNull();
    expect(dto.settings.effectiveWorkspace).toBe('D:\\默认');
    expect(dto.settings.effectivePermission).toBe('full');
  });
});
