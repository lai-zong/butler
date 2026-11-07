/**
 * 会话级设置与每轮快照
 *
 * ★★ 设计边界（用户确认过的）：
 *
 *   ① `persona` 是**每个 session 一份**，不是请求级临时字段。
 *      它只影响当前对话的「执行/答复」与「流式叙述」，
 *      不影响任务契约、监督员、记忆提取、标题、翻译。
 *
 *   ② `reasoning` 是统一四档 `off | low | high | max`，新对话默认 `high`。
 *      实际发什么字段由 `planReasoning`（core/model/reasoning.ts）决定；
 *      前端不做模型能力判断。
 *
 *   ③ `memoryMode` 是会话级 `on | off`（运维层仍可用 shadow 覆盖）。
 *
 *   ④ **每轮快照**：`POST /api/chat` 开始时把设置读成 `TurnSettings`，
 *      本轮全程只用这一份。执行中 PATCH 不改变当前轮，下一轮才生效。
 *
 *   ⑤ `workspace` / `permission` 是会话级工具作用域：
 *      · `workspace: null` → 使用应用默认工作区（app 层传入）；
 *      · `permission: null` → 跟随应用当前默认权限（app 层传入）；
 *      · 快照里同时记下 **配置值** 与 **实际生效值**，
 *        工具作用域只读快照，不再读全局可变状态。
 *
 * ★ 旧 session 兼容：
 *   `ChatSession` 上这些字段是可选，`sessionSettingsOf()` 负责补默认值。
 *   这样历史事件 replay 出来的会话（没有这些字段）不会被破坏。
 */

import type { GlobalAgentsSnapshot } from '../prompts/globalAgentsTypes.js';
import {
  emptyGlobalAgentsSnapshot,
} from '../prompts/globalAgents.js';
import {
  isReasoningLevel,
  planReasoning,
  reasoningFromLegacyThinkingLevel,
  isLegacyThinkingLevel,
  type ReasoningLevel,
  type ReasoningPlan,
  type ReasoningProvider,
} from '../model/reasoning.js';
import type { ChatSession } from './types.js';

// ═══════════════════════════════════════════════════════════
// 默认值与校验
// ═══════════════════════════════════════════════════════════

export const DEFAULT_REASONING: ReasoningLevel = 'high';
export const DEFAULT_MEMORY_MODE: SessionMemoryMode = 'on';
export const PERSONA_MAX_CHARS = 8_000;

export type SessionMemoryMode = 'on' | 'off';
/** 运行时记忆模式：`shadow` 只给运维/AB 用，不是会话设置。 */
export type TurnMemoryMode = 'on' | 'shadow' | 'off';

/**
 * 会话级工具权限档位。
 *
 * ★ 与全局 C5 的 `PermissionMode`（view / workspace / full）是**同一套能力语义**，
 *   但会话设置用更直白的 `read-only` 命名；两者在 app 层做显式映射，
 *   不在核心层互相复用枚举 —— 那样改一个全局值会悄悄改变所有会话。
 */
export type SessionPermission = 'read-only' | 'workspace' | 'full';

export const SESSION_PERMISSIONS: readonly SessionPermission[] = [
  'read-only',
  'workspace',
  'full',
];

export function isSessionPermission(value: unknown): value is SessionPermission {
  return value === 'read-only' || value === 'workspace' || value === 'full';
}

export interface SessionSettings {
  readonly persona: string;
  readonly reasoning: ReasoningLevel;
  readonly memoryMode: SessionMemoryMode;
  /** 该对话的工具根目录；null = 应用默认工作区。 */
  readonly workspace: string | null;
  /** 该对话的工具权限；null = 跟随应用当前默认权限。 */
  readonly permission: SessionPermission | null;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  persona: '',
  reasoning: DEFAULT_REASONING,
  memoryMode: DEFAULT_MEMORY_MODE,
  workspace: null,
  permission: null,
};

export function isSessionMemoryMode(value: unknown): value is SessionMemoryMode {
  return value === 'on' || value === 'off';
}

/**
 * 规范化会话工作区配置值。
 *
 * ⚠️ 只做 trim / 空值归一，**不**校验存在性与目录类型 ——
 *    那是 app 层的职责（需要真实 `stat`/`realpath`，core 不碰文件系统）。
 */
export function normalizeSessionWorkspace(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 读取 session 上的一份设置；旧 session 缺字段时补默认值。
 *
 * ⚠️ 这里**不修改** session，只投影。旧事件 replay 出来的对象
 *   可能没有 `reasoning` / `memoryMode` / `workspace` / `permission`，
 *   直接读会得到 undefined。
 */
export function sessionSettingsOf(session: ChatSession): SessionSettings {
  const persona = typeof session.persona === 'string' ? session.persona : '';
  const reasoning = isReasoningLevel(session.reasoning)
    ? session.reasoning
    : DEFAULT_REASONING;
  const memoryMode = isSessionMemoryMode(session.memoryMode)
    ? session.memoryMode
    : DEFAULT_MEMORY_MODE;
  const workspace = normalizeSessionWorkspace(session.workspace);
  const permission = isSessionPermission(session.permission) ? session.permission : null;
  return { persona, reasoning, memoryMode, workspace, permission };
}

export function normalizePersona(persona: string): string {
  const t = persona.trim();
  return t.length > PERSONA_MAX_CHARS ? t.slice(0, PERSONA_MAX_CHARS) : t;
}

/**
 * 旧桌宠请求的 `thinkingLevel` 兼容映射。
 *
 * ⚠️ 只在 **session 没有 reasoning 字段**（旧会话）时调用。
 *    新会话/Web 已设置过 reasoning 时，调用方必须直接使用 session 值 ——
 *    旧请求不能覆盖会话设置。
 */
export function reasoningFromRequestFallback(
  value: unknown,
  sessionReasoning: ReasoningLevel,
): { readonly reasoning: ReasoningLevel; readonly usedLegacy: boolean } {
  if (isLegacyThinkingLevel(value)) {
    return {
      reasoning: reasoningFromLegacyThinkingLevel(value),
      usedLegacy: true,
    };
  }
  return { reasoning: sessionReasoning, usedLegacy: false };
}

// ═══════════════════════════════════════════════════════════
// 哈希（审计用，不是密码学用途）
// ═══════════════════════════════════════════════════════════

/**
 * FNV-1a 32 位哈希，输出 8 位十六进制。
 *
 * ★ 为什么不用 crypto：
 *   core 层保持可以跑在非 Node 环境（测试/验证脚本）里；
 *   这里只需要“同一内容得到同一短标识”，不需要抗碰撞。
 *   全局 AGENTS 的文件哈希由 app 层用 SHA-256 计算。
 */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sessionSettingsHash(settings: SessionSettings): string {
  return shortHash(
    JSON.stringify({
      persona: settings.persona,
      reasoning: settings.reasoning,
      memoryMode: settings.memoryMode,
      workspace: settings.workspace,
      permission: settings.permission,
    }),
  );
}

// ═══════════════════════════════════════════════════════════
// 每轮快照
// ═══════════════════════════════════════════════════════════

export type PersonaSource = 'session' | 'request' | 'none';

export interface TurnSettings {
  readonly sessionId: string;
  /** 本轮实际使用的人格正文（可能是 session 的，也可能是请求级回退） */
  readonly persona: string;
  readonly personaSource: PersonaSource;
  readonly personaHash: string;
  readonly personaLength: number;

  readonly reasoning: ReasoningLevel;
  /** 本轮推理强度的来源：会话设置 / 桌宠旧请求 / 默认 */
  readonly reasoningSource: 'session' | 'request-legacy' | 'default';
  readonly reasoningPlan: ReasoningPlan;

  readonly memoryMode: TurnMemoryMode;

  /** 会话配置的工具工作区；null = 跟随应用默认 */
  readonly workspace: string | null;
  /** 会话配置的工具权限；null = 跟随应用默认 */
  readonly permission: SessionPermission | null;
  readonly workspaceSource: 'session' | 'default';
  readonly permissionSource: 'session' | 'default';
  /** 本轮实际使用的工具根目录（快照，执行中不再解析） */
  readonly effectiveWorkspace: string;
  /** 本轮实际使用的权限档位（快照，执行中不再读全局设置） */
  readonly effectivePermission: SessionPermission;

  readonly modelProfileId?: string;
  readonly modelId?: string;

  /** 本轮设置快照的整体哈希（事件里只记这个 + 长度） */  readonly settingsHash: string;
  readonly capturedAt: number;

  /** 全局 AGENTS 快照（文件缺失时是空正文） */
  readonly globalAgents: GlobalAgentsSnapshot;
}

export interface CreateTurnSettingsInput {
  readonly session: ChatSession;
  /** 请求 body 里的 persona（旧桌宠兼容；session persona 非空时忽略） */
  readonly requestPersona?: string | undefined;
  /**
   * 请求 body 里的 `thinkingLevel`（旧桌宠兼容）。
   * 新 Web 不发送；会话设置优先。
   */
  readonly legacyThinkingLevel?: unknown;
  /** 运行时记忆模式覆盖（例如 `BUTLER_MEMORY_MODE=shadow`） */
  readonly memoryModeOverride?: TurnMemoryMode | undefined;
  /** 模型供应商信息（用于把四档映射成供应商字段） */
  readonly reasoningProvider?: ReasoningProvider | undefined;
  readonly model?: string | undefined;
  /**
   * 本轮**实际使用**的模型（可能来自旧请求 body / 最近使用模型兜底）。
   * ⚠️ 只进快照，不写回 session —— session 仍是权威，body 不能覆盖。
   */
  readonly effectiveModelProfileId?: string | undefined;
  readonly effectiveModelId?: string | undefined;
  readonly globalAgents?: GlobalAgentsSnapshot | undefined;
  /**
   * 应用层默认工具工作区（`WORKSPACE_ROOT`）。
   * ⚠️ 由 app 层传入：core 不读进程环境，也不自己决定“应用默认”是什么。
   */
  readonly defaultWorkspace?: string | undefined;
  /**
   * 应用层当前默认权限（由 permissionStore / 配置解析后的具体档位）。
   * ⚠️ 同样由 app 层传入，core 不读全局可变策略。
   */
  readonly defaultPermission?: SessionPermission | undefined;
  readonly capturedAt: number;
}

/**
 * 生成一轮的设置快照。
 *
 * ★ 这个函数在 `POST /api/chat` 开始时**只调用一次**。
 *   返回的对象里的字段全是值拷贝（字符串/枚举/对象），
 *   之后再 PATCH session 也不会改变它 —— 这就是“当前轮快照不变”。
 *
 * ★ 优先级（**session 是权威**）：
 *   persona：session 非空 → session；否则请求 body → request；否则空。
 *   reasoning：session.reasoning 已存在（新会话一定有）→ session；
 *              **只在该字段缺失的旧 session 上**才用旧桌宠请求的
 *              `thinkingLevel` 兜底。
 *   memoryMode：运维覆盖（shadow/off）→ 覆盖值；否则 session.memoryMode。
 *
 * ⚠️ 旧桌宠请求不能覆盖 Web 会话已经选好的推理强度：
 *   否则用户在 Web 里把会话设成 off，桌宠右键的旧 high 会把它覆盖掉。
 *   桌宠要改思考强度，必须 PATCH 对应 session（见 scripts/petapp）。
 */
export function createTurnSettings(input: CreateTurnSettingsInput): TurnSettings {
  const session = sessionSettingsOf(input.session);

  const requestPersona = normalizePersona(input.requestPersona ?? '');
  const useRequestPersona = session.persona.trim().length === 0 && requestPersona.length > 0;
  const persona = useRequestPersona ? requestPersona : session.persona;
  const personaSource: PersonaSource = useRequestPersona
    ? 'request'
    : persona.trim().length > 0
      ? 'session'
      : 'none';

  const sessionHasReasoning = input.session.reasoning !== undefined;
  const legacy = sessionHasReasoning
    ? { reasoning: session.reasoning, usedLegacy: false }
    : reasoningFromRequestFallback(input.legacyThinkingLevel, session.reasoning);
  const reasoning = legacy.reasoning;
  const reasoningSource = legacy.usedLegacy
    ? 'request-legacy'
    : sessionHasReasoning
      ? 'session'
      : 'default';

  const provider = input.reasoningProvider ?? 'unknown';
  const model = input.model ?? '';
  const reasoningPlan = planReasoning({ level: reasoning, provider, model });

  const memoryMode = input.memoryModeOverride ?? session.memoryMode;
  const modelProfileId = input.effectiveModelProfileId ?? input.session.modelProfileId;
  const modelId = input.effectiveModelId ?? input.session.modelId;

  /**
   * ★ 工具作用域也进入快照。
   *
   *   `workspace` / `permission` 保留会话配置值（null 表示跟随应用）；
   *   `effective*` 是**本轮真正使用的值** —— 执行中改全局权限或 PATCH 会话，
   *   都不会再改变它们。工具作用域只从这里取值。
   */
  const workspace = session.workspace;
  const permission = session.permission;
  const effectiveWorkspace = workspace ?? input.defaultWorkspace ?? '';
  const effectivePermission =
    permission ?? input.defaultPermission ?? ('read-only' satisfies SessionPermission);

  const globalAgents = input.globalAgents ?? emptyGlobalAgentsSnapshot();

  const settingsHash = shortHash(
    JSON.stringify({
      sessionId: input.session.id,
      personaHash: shortHash(persona),
      personaLength: persona.length,
      reasoning,
      reasoningApplied: reasoningPlan.applied,
      memoryMode,
      workspace,
      permission,
      effectiveWorkspace,
      effectivePermission,
      modelProfileId: modelProfileId ?? null,
      modelId: modelId ?? null,
      globalAgentsHash: globalAgents.hash,
      globalAgentsLength: globalAgents.length,
    }),
  );

  return {
    sessionId: input.session.id,
    persona,
    personaSource,
    personaHash: shortHash(persona),
    personaLength: persona.length,
    reasoning,
    reasoningSource,
    reasoningPlan,
    memoryMode,
    workspace,
    permission,
    workspaceSource: workspace === null ? 'default' : 'session',
    permissionSource: permission === null ? 'default' : 'session',
    effectiveWorkspace,
    effectivePermission,
    ...(modelProfileId !== undefined ? { modelProfileId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    settingsHash,
    capturedAt: input.capturedAt,
    globalAgents,
  };
}

/**
 * 事件 payload —— **只记摘要，不记人格正文**。
 *
 * ★ 人格正文存在 session 状态（以及 app 层的 session-settings.json），
 *   事件里只有 hash / 长度。这样审计能核对“这一轮用的是哪份人格”，
 *   又不会把用户写的人格复制进每一轮日志。
 */
export function turnSettingsEventPayload(settings: TurnSettings): Record<string, unknown> {
  return {
    sessionId: settings.sessionId,
    source: 'turn',
    settingsHash: settings.settingsHash,
    personaHash: settings.personaHash,
    personaLength: settings.personaLength,
    personaSource: settings.personaSource,
    reasoning: settings.reasoning,
    reasoningSource: settings.reasoningSource,
    reasoningApplied: settings.reasoningPlan.applied,
    reasoningStyle: settings.reasoningPlan.style,
    reasoningSentFields: settings.reasoningPlan.sentFields,
    ...(settings.reasoningPlan.fallbackReason !== undefined
      ? { reasoningFallback: settings.reasoningPlan.fallbackReason }
      : {}),
    memoryMode: settings.memoryMode,
    workspace: settings.workspace,
    permission: settings.permission,
    workspaceSource: settings.workspaceSource,
    permissionSource: settings.permissionSource,
    effectiveWorkspace: settings.effectiveWorkspace,
    effectivePermission: settings.effectivePermission,
    ...(settings.modelProfileId !== undefined
      ? { modelProfileId: settings.modelProfileId }
      : {}),
    ...(settings.modelId !== undefined ? { modelId: settings.modelId } : {}),
    globalAgents: {
      hash: settings.globalAgents.hash,
      length: settings.globalAgents.length,
      loaded: settings.globalAgents.loaded,
      truncated: settings.globalAgents.truncated,
      ...(settings.globalAgents.error !== undefined
        ? { error: settings.globalAgents.error }
        : {}),
    },
    capturedAt: settings.capturedAt,
  };
}

/** 回退：老调用方（定时任务等）没有 TurnSettings 时，用显式参数构造。 */
export function fallbackTurnSettings(args: {
  readonly sessionId: string;
  readonly persona?: string | undefined;
  readonly memoryMode?: TurnMemoryMode | undefined;
  readonly capturedAt: number;
}): TurnSettings {
  return {
    sessionId: args.sessionId,
    persona: normalizePersona(args.persona ?? ''),
    personaSource: (args.persona ?? '').trim().length > 0 ? 'request' : 'none',
    personaHash: shortHash(normalizePersona(args.persona ?? '')),
    personaLength: normalizePersona(args.persona ?? '').length,
    reasoning: DEFAULT_REASONING,
    reasoningSource: 'default',
    reasoningPlan: {
      requested: DEFAULT_REASONING,
      provider: 'unknown',
      style: 'none',
      dispatch: { style: 'none' },
      applied: null,
      fallbackReason: '旧调用方未提供会话设置快照，不发送推理强度字段',
      sentFields: [],
    },
    memoryMode: args.memoryMode ?? DEFAULT_MEMORY_MODE,
    workspace: null,
    permission: null,
    workspaceSource: 'default',
    permissionSource: 'default',
    effectiveWorkspace: '',
    effectivePermission: 'read-only',
    settingsHash: shortHash(`legacy|${args.sessionId}|${args.persona ?? ''}|${args.memoryMode ?? ''}`),
    capturedAt: args.capturedAt,
    globalAgents: emptyGlobalAgentsSnapshot(),
  };
}
