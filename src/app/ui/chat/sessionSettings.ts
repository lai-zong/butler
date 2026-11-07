/**
 * 会话设置的界面投影
 *
 * ★ 这个文件只做**纯函数**：服务端偶尔会返回缺字段的旧会话快照，
 *   组件里到处写 `?? 'high'` 容易漏；集中在这里可以单测。
 *
 * ★ 列表接口不下发完整人格正文。这里的 `sanitizeSessionSummary`
 *   用来在 PATCH 返回详情后写回列表缓存时**主动去掉正文**，
 *   避免把用户写的人格留在列表状态里。
 */

import type {
  ReasoningLevel,
  SessionMemoryMode,
  SessionPermission,
  SessionSettingsDto,
  SessionSummary,
} from '../lib/types.js';

export const DEFAULT_REASONING: ReasoningLevel = 'high';
export const DEFAULT_MEMORY_MODE: SessionMemoryMode = 'on';
export const DEFAULT_PERMISSION: SessionPermission = 'read-only';

export const SESSION_PERMISSION_LABEL: Record<SessionPermission, string> = {
  'read-only': '只读',
  workspace: '工作区',
  full: '完全',
};

/** 三档权限的直白说明；抽屉与“当前实际”共用同一份措辞。 */
export const SESSION_PERMISSION_NOTE: Record<SessionPermission, string> = {
  'read-only': '读文件与目录；不写、不移动、不删除、不执行命令。',
  workspace: '只在本对话工作区内读写文件（新建/覆盖）、建目录；不提供移动、删除或命令执行。',
  full: '允许读写工作区外文件；移动等高风险操作需在 Web 上逐次确认；命令执行不提供（无 OS 沙箱）；系统数据、密钥与 config 始终拒绝。',
};

export interface ReasoningOption {
  readonly value: ReasoningLevel;
  readonly label: string;
  readonly hint: string;
}

export const REASONING_OPTIONS: readonly ReasoningOption[] = [
  { value: 'off', label: 'off', hint: '关闭思考，直接回答' },
  { value: 'low', label: 'low', hint: '轻量思考，速度优先' },
  { value: 'high', label: 'high', hint: '标准强度（新对话默认）' },
  { value: 'max', label: 'max', hint: '深度推理，耗时更长' },
];

export interface SessionSettingsView {
  readonly reasoning: ReasoningLevel;
  readonly memoryMode: SessionMemoryMode;
  readonly hasPersona: boolean;
  readonly personaLength: number;
  readonly personaPreview: string;
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max';
}

export function isSessionMemoryMode(value: unknown): value is SessionMemoryMode {
  return value === 'on' || value === 'off';
}

export function isSessionPermission(value: unknown): value is SessionPermission {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

export interface SessionScopeView {
  /** 会话配置值；null = 跟随应用 */
  readonly workspace: string | null;
  /** 会话配置值；null = 跟随应用 */
  readonly permission: SessionPermission | null;
  /** 服务端解析后的实际工作区 */
  readonly effectiveWorkspace: string;
  /** 服务端解析后的实际权限 */
  readonly effectivePermission: SessionPermission;
}

/**
 * 读取会话的工具作用域投影。
 *
 * ★ 旧服务端/旧缓存可能没有新字段：实际值回退到配置值，再回退到只读。
 *   抽屉的“当前实际”只读这里，避免组件里散落 `??`。
 */
export function scopeOf(session: SessionSummary | null | undefined): SessionScopeView {
  const settings = session?.settings;
  const configuredWorkspace =
    typeof settings?.workspace === 'string' && settings.workspace.trim().length > 0
      ? settings.workspace.trim()
      : null;
  const configuredPermission = isSessionPermission(settings?.permission)
    ? settings.permission
    : null;
  const effectiveWorkspace =
    typeof settings?.effectiveWorkspace === 'string' &&
    settings.effectiveWorkspace.trim().length > 0
      ? settings.effectiveWorkspace.trim()
      : (configuredWorkspace ?? '');
  const effectivePermission = isSessionPermission(settings?.effectivePermission)
    ? settings.effectivePermission
    : (configuredPermission ?? DEFAULT_PERMISSION);
  return {
    workspace: configuredWorkspace,
    permission: configuredPermission,
    effectiveWorkspace,
    effectivePermission,
  };
}

export interface SessionScopeForm {
  /** 输入框原值；空串 = 跟随应用默认 */
  readonly workspace: string;
  /** 下拉值；空串 = 跟随应用默认 */
  readonly permission: '' | SessionPermission;
}

/** 把抽屉的表单值转成 PATCH 体（空串 → null，语义明确）。 */
export function scopePatchOf(form: SessionScopeForm): {
  readonly workspace: string | null;
  readonly permission: SessionPermission | null;
} {
  const trimmed = form.workspace.trim();
  return {
    workspace: trimmed.length > 0 ? trimmed : null,
    permission: form.permission === '' ? null : form.permission,
  };
}

/** 读取一份可渲染的设置；缺字段的旧数据落到新对话默认值。 */
export function settingsOf(session: SessionSummary | null | undefined): SessionSettingsView {
  const settings = session?.settings;
  return {
    reasoning: isReasoningLevel(settings?.reasoning)
      ? settings.reasoning
      : DEFAULT_REASONING,
    memoryMode: isSessionMemoryMode(settings?.memoryMode)
      ? settings.memoryMode
      : DEFAULT_MEMORY_MODE,
    hasPersona: settings?.hasPersona === true,
    personaLength:
      typeof settings?.personaLength === 'number' && settings.personaLength >= 0
        ? settings.personaLength
        : 0,
    personaPreview: typeof settings?.personaPreview === 'string' ? settings.personaPreview : '',
  };
}

export interface SessionModelRef {
  readonly profileId: string;
  readonly modelId: string;
}

/** 从会话投影里取模型；两个字段必须同时存在才算有效。 */
export function modelRefOf(session: SessionSummary | null | undefined): SessionModelRef | null {
  const settings = session?.settings;
  const profileId = settings?.modelProfileId ?? session?.modelProfileId;
  const modelId = settings?.modelId ?? session?.modelId;
  if (
    typeof profileId !== 'string' ||
    profileId.length === 0 ||
    typeof modelId !== 'string' ||
    modelId.length === 0
  ) {
    return null;
  }
  return { profileId, modelId };
}

/** 胶囊上的模型短名：去掉命名空间，过长时截断；没有模型时给出明确文案。 */
export function shortModelName(modelId: string | null | undefined): string {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return '未选模型';
  const trimmed = modelId.trim();
  const tail = trimmed.split('/').pop() ?? trimmed;
  return tail.length > 20 ? `${tail.slice(0, 19)}…` : tail;
}

/**
 * 把详情 DTO 写回列表缓存前去掉正文。
 *
 * ★ 列表状态只保留摘要（长度/预览/hash），人格正文只活在设置抽屉的局部状态里。
 */
export function sanitizeSessionSummary(session: SessionSummary): SessionSummary {
  const settings: SessionSettingsDto = { ...session.settings, persona: null };
  return { ...session, settings };
}
