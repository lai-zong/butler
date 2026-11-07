/**
 * Web 桌宠的对话流 —— 纯函数 + 最小请求封装
 *
 * ★ 为什么单独成模块：
 *   SSE 的折叠、历史恢复、错误文案都要能被单测；把这些混进组件里的
 *   一堆 setState，会出现「事件到了、但状态还没建」的竞态。
 *
 * ★ 这里**故意只看三类事件**：阶段（progress）、叙述（narration）、
 *   最终答复（reply）。`agent` / `reasoning` / `tool` 事件即使到达也
 *   不会进入桌宠的展示状态 —— 桌宠只负责“说人话”，推理与工具留在
 *   对话页的完整视图里。
 */

import { isReasoningLevel, modelRefOf, settingsOf, type SessionModelRef } from '../chat/sessionSettings.js';
import { errorMessage, fetchJson, patchJson } from '../lib/api.js';
import type {
  MessageDto,
  ModelChoicesResponse,
  ModelChoiceProfileView,
  PetConfigResponse,
  PetSessionResponse,
  ReasoningLevel,
  SessionDetailResponse,
  SessionSettingsPatch,
  SessionSettingsPatchResponse,
} from '../lib/types.js';

// ═══════════════════════════════════════════════════════════
// 展示模型
// ═══════════════════════════════════════════════════════════

export type PetMessageRole = 'user' | 'assistant';

export interface PetMessage {
  readonly role: PetMessageRole;
  readonly text: string;
}

export type PetTurnStatus = 'running' | 'done' | 'cancelled' | 'error';

/** 一轮正在进行的对话。只保留可展示字段。 */
export interface PetTurn {
  readonly id: string;
  /** 气泡里显示的用户文本（不含文档正文）。 */
  readonly userText: string;
  /** 实际发给 /api/chat 的文本（含已提取的文档正文）。 */
  readonly outgoingText: string;
  stage: string | null;
  narration: string;
  reply: string;
  status: PetTurnStatus;
  error: string | null;
  readonly startedAt: number;
}

/** 桌宠能看懂的事件子集；其它 SSE 事件在本层就被丢弃。 */
export type PetEvent =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'stage'; readonly label: string }
  | { readonly kind: 'narration'; readonly text: string }
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'settings'; readonly reasoning: ReasoningLevel }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'done' };

// ═══════════════════════════════════════════════════════════
// SSE 解析
// ═══════════════════════════════════════════════════════════

/** 把一条 `data: {...}` 事件收窄成桌宠事件；不是可展示事件时返回 null。 */
export function toPetEvent(raw: unknown): PetEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const type = rec['type'];
  if (typeof type !== 'string') return null;

  if (type === 'session' && typeof rec['sessionId'] === 'string') {
    return { kind: 'session', sessionId: rec['sessionId'] };
  }

  if (type === 'progress') {
    const event = rec['event'];
    if (typeof event !== 'object' || event === null) return null;
    const inner = event as Record<string, unknown>;
    if (inner['kind'] !== 'stage' || typeof inner['label'] !== 'string') return null;
    const label = inner['label'].trim();
    return label.length > 0 ? { kind: 'stage', label } : null;
  }

  if (type === 'narration') {
    const answer = rec['answer'];
    return typeof answer === 'string' ? { kind: 'narration', text: answer } : null;
  }

  if (type === 'reply') {
    const text = rec['text'];
    return typeof text === 'string' ? { kind: 'reply', text } : null;
  }

  if (type === 'error') {
    const message = rec['message'];
    return {
      kind: 'error',
      message: typeof message === 'string' && message.length > 0 ? message : '对话失败',
    };
  }

  // 本轮设置快照：只取 reasoning，用于胶囊说明“本轮已固定、改动下一轮生效”。
  if (type === 'settings') {
    const settings = rec['settings'];
    if (typeof settings !== 'object' || settings === null) return null;
    const reasoning = (settings as Record<string, unknown>)['reasoning'];
    return isReasoningLevel(reasoning) ? { kind: 'settings', reasoning } : null;
  }

  if (type === 'done') return { kind: 'done' };

  // agent / reasoning / tool / approval / usage / verdict ...
  // 桌宠不展示，也不保留。
  return null;
}

/**
 * 增量 SSE 解析器：喂 chunk，吐事件。
 *
 * 只按空行切块；单条坏 JSON 被跳过（不能让一条坏事件中断整轮）。
 */
export interface PetSseParser {
  push(chunk: string): readonly PetEvent[];
  flush(): readonly PetEvent[];
}

function parseSseBlock(block: string): readonly PetEvent[] {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data.length === 0) return [];
  try {
    const event = toPetEvent(JSON.parse(data) as unknown);
    return event === null ? [] : [event];
  } catch {
    return [];
  }
}

export function createPetSseParser(): PetSseParser {
  let buffer = '';
  return {
    push(chunk: string): readonly PetEvent[] {
      buffer += chunk;
      const events: PetEvent[] = [];
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        events.push(...parseSseBlock(buffer.slice(0, index)));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
      return events;
    },
    flush(): readonly PetEvent[] {
      if (buffer.trim().length === 0) return [];
      const events = parseSseBlock(buffer);
      buffer = '';
      return events;
    },
  };
}

/** 把流式响应折叠成桌宠事件。 */
export async function* readPetEvents(res: Response): AsyncGenerator<PetEvent> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('服务端没有返回可读的流');
  const decoder = new TextDecoder();
  const parser = createPetSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      yield event;
    }
  }
  for (const event of parser.flush()) yield event;
}

/** 把事件折叠进当前轮。返回新对象；无变化时返回原对象。 */
export function applyPetEvent(turn: PetTurn, event: PetEvent): PetTurn {
  switch (event.kind) {
    case 'stage': {
      if (turn.stage === event.label) return turn;
      return { ...turn, stage: event.label };
    }
    case 'narration': {
      if (turn.narration === event.text) return turn;
      return { ...turn, narration: event.text };
    }
    case 'reply': {
      return { ...turn, reply: event.text, status: 'done', error: null };
    }
    case 'error': {
      return { ...turn, error: event.message, status: 'error' };
    }
    case 'done': {
      if (turn.status !== 'running') return turn;
      return { ...turn, status: 'done' };
    }
    case 'session':
    case 'settings':
      return turn;
    default:
      return turn;
  }
}

// ═══════════════════════════════════════════════════════════
// 历史与展示辅助
// ═══════════════════════════════════════════════════════════

const DOC_MARKER = '\n\n【附件：';

/**
 * 历史里的用户消息可能包含整份文档正文（发送时拼进去的）。
 * 气泡只显示用户真正输入的部分；正文仍在服务端，可用对话页查看。
 */
export function displayUserText(text: string): string {
  const index = text.indexOf(DOC_MARKER);
  const visible = index >= 0 ? text.slice(0, index) : text;
  return visible.trim();
}

/** 取服务端历史里最后几条用户/管家消息，供刷新后恢复。 */
export function recentPetMessages(
  messages: readonly MessageDto[],
  limit = 4,
): readonly PetMessage[] {
  const list: PetMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'butler') continue;
    const text = (message.role === 'user' ? displayUserText(message.text) : message.text).trim();
    if (text.length === 0) continue;
    list.push({ role: message.role === 'user' ? 'user' : 'assistant', text });
  }
  return list.slice(-limit);
}

/** 新开一轮前，把上一轮折进历史；只保留最近 limit 条。 */
export function foldPetTurn(
  history: readonly PetMessage[],
  turn: PetTurn | null,
  limit = 4,
): readonly PetMessage[] {
  if (turn === null) return history;
  const answer = turn.reply.trim().length > 0 ? turn.reply : turn.narration;
  const next: PetMessage[] = [...history];
  if (turn.userText.trim().length > 0) next.push({ role: 'user', text: turn.userText });
  if (answer.trim().length > 0) next.push({ role: 'assistant', text: answer });
  return next.slice(-limit);
}

export interface PetDocAttachment {
  readonly name: string;
  readonly text: string;
}

/** 把文档正文接到用户输入后面；这是真实发出去的文本。 */
export function composePetText(text: string, docs: readonly PetDocAttachment[]): string {
  const base = text.trim();
  if (docs.length === 0) return base;
  const blocks = docs.map((doc) => `【附件：${doc.name}】\n${doc.text.trim()}`);
  return [base, ...blocks].filter((part) => part.length > 0).join('\n\n');
}

// ═══════════════════════════════════════════════════════════
// 请求封装
// ═══════════════════════════════════════════════════════════

export async function fetchPetConfig(): Promise<PetConfigResponse> {
  return fetchJson<PetConfigResponse>('/api/pet/config');
}

/** 桌面桌宠与 Web 桌宠共用的固定会话。 */
export async function fetchPetSession(): Promise<string> {
  const res = await fetchJson<PetSessionResponse>('/api/pet/session');
  return res.sessionId;
}

export async function fetchPetHistory(sessionId: string): Promise<readonly MessageDto[]> {
  const snapshot = await fetchPetSessionSnapshot(sessionId);
  return snapshot.messages;
}

// ═══════════════════════════════════════════════════════════
// 会话设置（模型 · 思考强度）
//
// ★ Web 桌宠与主对话共用同一条固定会话，所以模型/强度必须读写
//   `/api/sessions/<id>` 的**会话设置**，而不是 pet-config：
//   pet-config 的模型/思考只服务桌面 Tk 桌宠。
// ═══════════════════════════════════════════════════════════

export interface PetSessionSettings {
  readonly reasoning: ReasoningLevel;
  readonly model: SessionModelRef | null;
}

export interface PetSessionSnapshot extends PetSessionSettings {
  readonly messages: readonly MessageDto[];
}

function sessionSettingsOf(session: SessionDetailResponse['session']): PetSessionSettings {
  // settingsOf / modelRefOf 自带旧数据回退：缺字段时 reasoning=high、model=null。
  return {
    reasoning: settingsOf(session).reasoning,
    model: modelRefOf(session),
  };
}

/** 一次读取历史消息 + 当前会话设置，避免两次请求之间出现设置闪烁。 */
export async function fetchPetSessionSnapshot(sessionId: string): Promise<PetSessionSnapshot> {
  const res = await fetchJson<SessionDetailResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  return { ...sessionSettingsOf(res.session), messages: res.messages };
}

/** 只改这一条桌宠会话；不改 pet-config，也不影响主对话。 */
export async function patchPetSessionSettings(
  sessionId: string,
  patch: SessionSettingsPatch,
): Promise<PetSessionSettings> {
  const res = await patchJson<SessionSettingsPatchResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    patch,
  );
  return sessionSettingsOf(res.session);
}

/** `/api/model` 的对话模型列表；没有可选项时返回空数组，不伪造候选。 */
export async function fetchPetModelProfiles(): Promise<readonly ModelChoiceProfileView[]> {
  const res = await fetchJson<ModelChoicesResponse>('/api/model');
  return res.profiles;
}

export interface OpenPetChatInput {
  readonly sessionId: string;
  readonly text: string;
  readonly images: readonly string[];
  readonly signal: AbortSignal;
}

function errorFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null) {
    const rec = payload as Record<string, unknown>;
    if (typeof rec['error'] === 'string' && rec['error'].length > 0) return rec['error'];
  }
  return fallback;
}

/**
 * 发一轮对话并拿回 SSE 流。
 *
 * ⚠️ `supportsApproval: false`：桌宠没有确认 UI，需要确认的工具调用
 *    会被服务端**立即拒绝**，而不是挂到超时。这是刻意的能力协商。
 */
export async function openPetChat(input: OpenPetChatInput): Promise<Response> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        text: input.text,
        supportsApproval: false,
        ...(input.images.length > 0 ? { images: input.images.map((url) => ({ url })) } : {}),
      }),
      signal: input.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new Error(`连不上本地服务（${errorMessage(err)}）`);
  }

  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = (await res.json()) as unknown;
    } catch {
      payload = null;
    }
    throw new Error(errorFromPayload(payload, `请求失败（HTTP ${res.status}）`));
  }
  return res;
}
