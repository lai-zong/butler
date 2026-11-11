/**
 * Web 桌宠的对话流 —— 纯函数 + 最小请求封装
 *
 * ★ 为什么单独成模块：
 *   SSE 的折叠、历史恢复、错误文案都要能被单测；把这些混进组件里的
 *   一堆 setState，会出现「事件到了、但状态还没建」的竞态。
 *
 * ★ 这里只保留**最终答复**（reply）与**里程碑摘要**（milestone）：
 *   旧的 progress / narration / stage 一律丢弃 —— 桌宠不展示
 *   “写任务契约”“开始执行”这类内部阶段，也不展示推理与工具细节。
 */

import { isReasoningLevel, modelRefOf, settingsOf, type SessionModelRef } from '../chat/sessionSettings.js';
import { errorMessage, fetchJson, patchJson, postJson } from '../lib/api.js';
import type {
  MessageDto,
  ModelChoicesResponse,
  ModelChoiceProfileView,
  PetConfigResponse,
  PetProactiveClaimResponse,
  PetProactiveFeedbackResponse,
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

/**
 * 气泡类型：
 *   user      用户消息
 *   progress  任务中的一个里程碑摘要（只出现在本轮，不进历史）
 *   final     最终回答（聊天或任务都只有一条）
 */
export type PetMessageKind = 'user' | 'progress' | 'final';

export interface PetMessage {
  readonly role: PetMessageRole;
  readonly kind?: PetMessageKind;
  readonly text: string;
  /** 消息时间（毫秒）；null/缺省表示暂时未知（例如本轮尚未落盘）。 */
  readonly at?: number | null;
}

export type PetTurnStatus = 'running' | 'done' | 'cancelled' | 'error';

/** 一轮正在进行的对话。只保留可展示字段。 */
export interface PetTurn {
  readonly id: string;
  /** 气泡里显示的用户文本（不含文档正文）。 */
  readonly userText: string;
  /** 实际发给 /api/chat 的文本（含已提取的文档正文）。 */
  readonly outgoingText: string;
  /** 任务里程碑摘要；聊天通常为空。每条单独一个轻气泡。 */
  milestones: readonly string[];
  reply: string;
  status: PetTurnStatus;
  error: string | null;
  readonly startedAt: number;
}

/** 桌宠能看懂的事件子集；其它 SSE 事件在本层就被丢弃。 */
export type PetEvent =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'milestone'; readonly text: string }
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

  if (type === 'milestone') {
    const text = rec['text'];
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    return trimmed.length > 0 ? { kind: 'milestone', text: trimmed } : null;
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

  // progress（阶段名）/ narration（叙述）/ stage 等内部过程不再进入桌宠；
  // agent / reasoning / tool / approval / usage / verdict 同样丢弃。
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
    case 'milestone': {
      // 服务端已对连续相同文案去重一次；这里再做一次，避免重放/重连时重复。
      if (turn.milestones.includes(event.text)) return turn;
      return { ...turn, milestones: [...turn.milestones, event.text] };
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

/**
 * 取服务端历史里的全部用户/管家消息，供刷新后恢复。
 *
 * ★ 不再截断：桌板要能翻到这条固定会话的第一句话。
 *   只过滤无法展示的空文本；reasoning / 工具 / system 一律不进来。
 */
export function petMessagesFromHistory(messages: readonly MessageDto[]): readonly PetMessage[] {
  const list: PetMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'butler') continue;
    const text = (message.role === 'user' ? displayUserText(message.text) : message.text).trim();
    if (text.length === 0) continue;
    list.push({
      role: message.role === 'user' ? 'user' : 'assistant',
      kind: message.role === 'user' ? 'user' : 'final',
      text,
      at: message.createdAt,
    });
  }
  return list;
}

export interface PetMessageGroup {
  readonly role: PetMessageRole;
  readonly kind: PetMessageKind;
  readonly text: string;
  /** 这一组第一条消息的时间。 */
  readonly at: number | null;
  /** 这一组最后一条消息的时间。 */
  readonly endAt: number | null;
  /** 这一组第一条消息在原始列表里的下标，用作稳定 key。 */
  readonly startIndex: number;
}

function kindOf(message: PetMessage): PetMessageKind {
  return message.kind ?? (message.role === 'user' ? 'user' : 'final');
}

/**
 * 把连续同角色、同为最终回答的消息合并成一组，供“微信式”气泡渲染。
 *
 * ★ 阶段摘要（progress）每条独立显示，不和 final 合并、也不彼此合并；
 *   否则“读文件 → 改文件 → 检查”会被压成一大段，看不出执行节奏。
 */
export function groupPetMessages(messages: readonly PetMessage[]): readonly PetMessageGroup[] {
  const groups: PetMessageGroup[] = [];
  messages.forEach((message, index) => {
    const kind = kindOf(message);
    const at = typeof message.at === 'number' && Number.isFinite(message.at) ? message.at : null;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.role === message.role && last.kind === kind && kind === 'final') {
      groups[groups.length - 1] = {
        ...last,
        text: `${last.text}\n\n${message.text}`,
        endAt: at ?? last.endAt,
      };
      return;
    }
    groups.push({
      role: message.role,
      kind,
      text: message.text,
      at,
      endAt: at,
      startIndex: index,
    });
  });
  return groups;
}

/**
 * 当前已完成的一轮是否已经存在于服务端历史里。
 *
 * 这是修复“关闭/重新打开桌板后同一轮出现两次”的关键：
 * 服务端历史已经包含本轮时，前端不能再把内存里的 turn 追加一遍。
 */
export function historyContainsTurn(
  history: readonly PetMessage[],
  turn: PetTurn | null,
): boolean {
  if (turn === null || turn.status === 'running' || turn.reply.trim().length === 0) {
    return false;
  }
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastFinal = [...history]
    .reverse()
    .find((m) => m.role === 'assistant' && (m.kind === undefined || m.kind === 'final'));
  return (
    lastUser !== undefined &&
    lastFinal !== undefined &&
    lastUser.text.trim() === turn.userText.trim() &&
    lastFinal.text.trim() === turn.reply.trim()
  );
}

/** 两条气泡之间超过这个间隔才显示时间（微信式：不是每条都带时间）。 */
export const PET_TIME_GAP_MS = 5 * 60_000;

/**
 * 新开一轮前，把上一轮折进历史。
 *
 * ★ 不设条数上限：历史只增不减，桌板内部滚动查看。
 *   这里只追加，不做任何 slice —— 截断会让用户永远看不到更早的对话。
 */
export function foldPetTurn(
  history: readonly PetMessage[],
  turn: PetTurn | null,
): readonly PetMessage[] {
  if (turn === null) return history;
  // 历史已经包含本轮（例如打开桌板时刷新过）时，不能重复追加。
  if (historyContainsTurn(history, turn)) return history;
  // 里程碑是过程摘要，不写进持久历史；只折叠最终回答。
  const answer = turn.reply.trim();
  const next: PetMessage[] = [...history];
  if (turn.userText.trim().length > 0) {
    next.push({ role: 'user', kind: 'user', text: turn.userText });
  }
  if (answer.length > 0) {
    next.push({ role: 'assistant', kind: 'final', text: answer });
  }
  return next;
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

/**
 * 领取一次主动说话。
 *
 * ★ 这里不判断频率或安静时段：那些由服务端决定。
 *   前端只负责在页面可见、桌板未打开时问一句“现在可以说吗”。
 */
export async function claimPetProactive(): Promise<PetProactiveClaimResponse> {
  return fetchJson<PetProactiveClaimResponse>('/api/pet/proactive/claim', {
    method: 'POST',
  });
}

/** 用户对主动气泡的回应；mute 会由服务端关闭 proactiveEnabled。 */
export async function sendPetProactiveFeedback(
  action: 'dismiss' | 'snooze' | 'mute',
): Promise<PetProactiveFeedbackResponse> {
  return postJson<PetProactiveFeedbackResponse>('/api/pet/proactive/feedback', { action });
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
