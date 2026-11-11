/**
 * 审查 SSE 的纯数据层
 *
 * ★ 与 chatLive.ts 同一思路：把网络分片折成稳定的视图状态，
 *   组件只负责渲染，不在 JSX 里处理「工具结果先到、toolCall 后到」这类竞态。
 * ★ 以服务端的 accumulated 为准；completed.finalText 再由 ChatView 覆盖一次，
 *   避免分片拼接误差被当成最终结论。
 */

export type ReviewRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface ReviewUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 与后端 ReviewTrace 对齐；旧记录可能没有 traces，字段也按缺失容忍。 */
export interface ReviewTrace {
  readonly round: number;
  readonly toolName: string;
  readonly args?: unknown;
  readonly validated?: boolean;
  readonly validationMessage?: string;
  readonly output?: string;
  readonly ok?: boolean;
  readonly denied?: boolean;
  readonly durationMs?: number;
}

export type ReviewVerdict = 'pass' | 'fail' | 'unknown';
export type ReviewFindingSeverity = 'block' | 'warn' | 'info';

/** 结构化审查发现；problem/message 兼容旧记录。 */
export interface ReviewFinding {
  readonly severity: ReviewFindingSeverity;
  readonly problem?: string;
  readonly message?: string;
  readonly evidence: readonly string[];
  readonly suggestion?: string;
}

export interface ReviewRunReportDto {
  /** 旧监督员记录仍可能有；新审查不再生成。 */
  readonly criteriaChecks?: readonly unknown[];
  readonly findings?: readonly ReviewFinding[];
  readonly summary?: string;
  readonly verdict?: ReviewVerdict;
  readonly unverified?: readonly string[];
  /** 完整审查正文 Markdown。 */
  readonly markdown?: string;
  /** 读取时归一化的旧记录。 */
  readonly legacy?: boolean;
}

export interface ReviewRunDto {
  readonly id?: string;
  readonly sessionId?: string;
  readonly turnIds?: readonly string[];
  readonly status?: ReviewRunStatus;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly snapshotHash?: string;
  readonly stages?: readonly {
    readonly name?: string;
    readonly status?: string;
  }[];
  readonly report?: ReviewRunReportDto | null;
  readonly traces?: readonly ReviewTrace[];
  readonly usage?: ReviewUsage;
  readonly error?: string;
  readonly createdAt?: number;
}

export interface ReviewHistoryResponse {
  readonly ok?: boolean;
  readonly reviews?: readonly ReviewRunDto[];
  readonly error?: string;
}

export type ReviewToolStatus = 'pending' | 'running' | 'ok' | 'denied' | 'error';

export interface ReviewToolProcess {
  readonly callId: string;
  readonly round: number;
  readonly name: string;
  readonly argsText: string;
  readonly status: ReviewToolStatus;
  readonly output: string;
  readonly durationMs: number | null;
}

export interface ReviewRoundProcess {
  readonly round: number;
  readonly reasoning: string;
  readonly text: string;
  readonly tools: readonly ReviewToolProcess[];
}

export interface ReviewProcessState {
  readonly rounds: readonly ReviewRoundProcess[];
  readonly usage: ReviewUsage | null;
  readonly finished: { readonly rounds: number; readonly reason: string } | null;
  readonly model: string | null;
  readonly streamed: boolean | null;
}

export function emptyReviewProcess(): ReviewProcessState {
  return {
    rounds: [],
    usage: null,
    finished: null,
    model: null,
    streamed: null,
  };
}

interface StartedEvent {
  readonly type: 'started';
  readonly sessionId: string;
  readonly turnIds: readonly string[];
  readonly model: string;
  readonly streamed: boolean;
}

interface RoundEvent {
  readonly type: 'round';
  readonly round: number;
}

interface ReasoningEvent {
  readonly type: 'reasoning';
  readonly round: number;
  readonly delta: string;
  readonly accumulated: string;
}

interface TextEvent {
  readonly type: 'text';
  readonly round: number;
  readonly delta: string;
  readonly accumulated: string;
}

interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly round: number;
  readonly callId: string;
  readonly name: string;
  readonly argsDelta: string;
  readonly partial: boolean;
}

interface ToolStartedEvent {
  readonly type: 'tool_started';
  readonly round: number;
  readonly callId: string;
  readonly name: string;
}

interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly round: number;
  readonly toolName: string;
  readonly output: string;
  readonly ok: boolean;
  readonly denied?: boolean;
  readonly durationMs: number;
}

interface UsageEvent {
  readonly type: 'usage';
  readonly round: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

interface FinishedEvent {
  readonly type: 'finished';
  readonly rounds: number;
  readonly reason: string;
}

export interface ReviewCompletedEvent {
  readonly type: 'completed';
  readonly ok: boolean;
  readonly run: ReviewRunDto;
  readonly finalText: string;
  readonly traces: readonly ReviewTrace[];
  readonly rounds: number;
  readonly usage: ReviewUsage | null;
}

export interface ReviewErrorEvent {
  readonly type: 'error';
  readonly error: string;
  readonly runId?: string;
  readonly aborted: boolean;
}

export type ReviewStreamEvent =
  | StartedEvent
  | RoundEvent
  | ReasoningEvent
  | TextEvent
  | ToolCallEvent
  | ToolStartedEvent
  | ToolResultEvent
  | UsageEvent
  | FinishedEvent
  | ReviewCompletedEvent
  | ReviewErrorEvent;

const MAX_ARGS_TEXT = 4000;
const MAX_OUTPUT_TEXT = 6000;
const MAX_REASONING_TEXT = 40_000;
const MAX_ROUND_TEXT = 24_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function parseUsage(value: unknown): ReviewUsage | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const input = rec['inputTokens'];
  const output = rec['outputTokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}

function parseTrace(value: unknown): ReviewTrace | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const toolName = str(rec['toolName']).trim();
  if (toolName.length === 0) return null;
  const round = Math.max(0, Math.trunc(num(rec['round'], 0)));
  const args = rec['args'];
  const validated = bool(rec['validated']);
  const validationMessage = str(rec['validationMessage']);
  const output = rec['output'];
  const ok = bool(rec['ok']);
  const denied = bool(rec['denied']);
  const durationMs = rec['durationMs'];
  return {
    round,
    toolName,
    ...(args !== undefined ? { args } : {}),
    ...(validated !== undefined ? { validated } : {}),
    ...(validationMessage.length > 0 ? { validationMessage } : {}),
    ...(typeof output === 'string' ? { output } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(denied !== undefined ? { denied } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

/** 只把 data 段交给这个函数；event 名与 JSON 负载必须同时合法。 */
export function parseReviewEvent(eventName: string, data: string): ReviewStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (rec === null) return null;

  switch (eventName) {
    case 'started':
      return {
        type: 'started',
        sessionId: str(rec['sessionId']),
        turnIds: stringList(rec['turnIds']),
        model: str(rec['model']),
        streamed: rec['streamed'] === true,
      };

    case 'round':
      return { type: 'round', round: Math.max(0, Math.trunc(num(rec['round'], 0))) };

    case 'reasoning':
      return {
        type: 'reasoning',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        delta: str(rec['delta']),
        accumulated: str(rec['accumulated']),
      };

    case 'text':
      return {
        type: 'text',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        delta: str(rec['delta']),
        accumulated: str(rec['accumulated']),
      };

    case 'tool_call':
      return {
        type: 'tool_call',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        callId: str(rec['callId']),
        name: str(rec['name']),
        argsDelta: str(rec['argsDelta']),
        partial: rec['partial'] === true,
      };

    case 'tool_started':
      return {
        type: 'tool_started',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        callId: str(rec['callId']),
        name: str(rec['name']),
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        toolName: str(rec['toolName']),
        output: str(rec['output']),
        ok: rec['ok'] !== false,
        ...(bool(rec['denied']) !== undefined ? { denied: bool(rec['denied']) === true } : {}),
        durationMs: Math.max(0, num(rec['durationMs'], 0)),
      };

    case 'usage':
      return {
        type: 'usage',
        round: Math.max(0, Math.trunc(num(rec['round'], 0))),
        inputTokens: num(rec['inputTokens'], 0),
        outputTokens: num(rec['outputTokens'], 0),
        totalInputTokens: num(rec['totalInputTokens'], num(rec['inputTokens'], 0)),
        totalOutputTokens: num(rec['totalOutputTokens'], num(rec['outputTokens'], 0)),
      };

    case 'finished':
      return {
        type: 'finished',
        rounds: Math.max(0, Math.trunc(num(rec['rounds'], 0))),
        reason: str(rec['reason']),
      };

    case 'completed': {
      const run = asRecord(rec['run']);
      if (run === null) return null;
      const runUsage = parseUsage(run['usage']);
      const runDto: ReviewRunDto = {
        ...(str(run['id']).length > 0 ? { id: str(run['id']) } : {}),
        ...(str(run['sessionId']).length > 0 ? { sessionId: str(run['sessionId']) } : {}),
        ...(Array.isArray(run['turnIds']) ? { turnIds: stringList(run['turnIds']) } : {}),
        ...(typeof run['status'] === 'string'
          ? { status: run['status'] as ReviewRunStatus }
          : {}),
        ...(str(run['model']).length > 0 ? { model: str(run['model']) } : {}),
        ...(asRecord(run['report']) !== null
          ? { report: run['report'] as ReviewRunReportDto }
          : run['report'] === null
            ? { report: null }
            : {}),
        ...(Array.isArray(run['traces']) ? { traces: run['traces'].map(parseTrace).filter((t): t is ReviewTrace => t !== null) } : {}),
        ...(runUsage !== null ? { usage: runUsage } : {}),
        ...(str(run['error']).length > 0 ? { error: str(run['error']) } : {}),
        ...(typeof run['createdAt'] === 'number' ? { createdAt: run['createdAt'] } : {}),
      };
      const traces = Array.isArray(rec['traces'])
        ? rec['traces'].map(parseTrace).filter((t): t is ReviewTrace => t !== null)
        : (runDto.traces ?? []);
      const finalText = str(rec['finalText']);
      const summary = runDto.report?.summary;
      return {
        type: 'completed',
        ok: rec['ok'] !== false,
        run: runDto,
        finalText: finalText.length > 0 ? finalText : (typeof summary === 'string' ? summary : ''),
        traces,
        rounds: Math.max(0, Math.trunc(num(rec['rounds'], 0))),
        usage: parseUsage(rec['usage']) ?? runDto.usage ?? null,
      };
    }

    case 'error':
      return {
        type: 'error',
        error: str(rec['error']),
        ...(str(rec['runId']).length > 0 ? { runId: str(rec['runId']) } : {}),
        aborted: rec['aborted'] === true,
      };

    default:
      return null;
  }
}

function ensureRound(
  rounds: readonly ReviewRoundProcess[],
  round: number,
): { readonly rounds: ReviewRoundProcess[]; readonly index: number } {
  const index = rounds.findIndex((r) => r.round === round);
  if (index >= 0) return { rounds: [...rounds], index };
  return {
    rounds: [...rounds, { round, reasoning: '', text: '', tools: [] }],
    index: rounds.length,
  };
}

function patchRound(
  rounds: readonly ReviewRoundProcess[],
  round: number,
  patch: Partial<ReviewRoundProcess>,
): ReviewRoundProcess[] {
  const next = ensureRound(rounds, round);
  const current = next.rounds[next.index];
  if (current === undefined) return next.rounds;
  next.rounds[next.index] = { ...current, ...patch };
  return next.rounds;
}

function findToolIndex(tools: readonly ReviewToolProcess[], callId: string): number {
  return tools.findIndex((tool) => tool.callId === callId);
}

/** tool_result 没有 callId：优先匹配同轮同名的 running 工具，再退回 pending。 */
function findToolResultIndex(tools: readonly ReviewToolProcess[], name: string): number {
  let pending = -1;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (tool === undefined || tool.name !== name) continue;
    if (tool.status === 'running') return i;
    if (tool.status === 'pending' && pending < 0) pending = i;
  }
  return pending;
}

function appendTool(
  rounds: readonly ReviewRoundProcess[],
  round: number,
  tool: ReviewToolProcess,
): ReviewRoundProcess[] {
  const next = ensureRound(rounds, round);
  const current = next.rounds[next.index];
  if (current === undefined) return next.rounds;
  next.rounds[next.index] = { ...current, tools: [...current.tools, tool] };
  return next.rounds;
}

function updateTool(
  rounds: readonly ReviewRoundProcess[],
  round: number,
  toolIndex: number,
  patch: Partial<ReviewToolProcess>,
): ReviewRoundProcess[] {
  const next = ensureRound(rounds, round);
  const current = next.rounds[next.index];
  if (current === undefined) return next.rounds;
  const tool = current.tools[toolIndex];
  if (tool === undefined) return next.rounds;
  const tools = [...current.tools];
  tools[toolIndex] = { ...tool, ...patch };
  next.rounds[next.index] = { ...current, tools };
  return next.rounds;
}

/** 把单个审查事件折叠进过程状态。返回新对象（不修改入参）。 */
export function applyReviewEvent(
  state: ReviewProcessState,
  event: ReviewStreamEvent,
): ReviewProcessState {
  switch (event.type) {
    case 'started':
      return { ...state, model: event.model, streamed: event.streamed };

    case 'round':
      return { ...state, rounds: ensureRound(state.rounds, event.round).rounds };

    case 'reasoning': {
      const current = state.rounds.find((r) => r.round === event.round);
      const nextText =
        event.accumulated.length > 0
          ? event.accumulated
          : `${current?.reasoning ?? ''}${event.delta}`;
      return {
        ...state,
        rounds: patchRound(state.rounds, event.round, {
          reasoning: clip(nextText, MAX_REASONING_TEXT),
        }),
      };
    }

    case 'text': {
      const current = state.rounds.find((r) => r.round === event.round);
      const nextText =
        event.accumulated.length > 0 ? event.accumulated : `${current?.text ?? ''}${event.delta}`;
      return {
        ...state,
        rounds: patchRound(state.rounds, event.round, {
          text: clip(nextText, MAX_ROUND_TEXT),
        }),
      };
    }

    case 'tool_call': {
      const round = ensureRound(state.rounds, event.round);
      const current = round.rounds[round.index];
      if (current === undefined) return state;
      const callId =
        event.callId.length > 0 ? event.callId : `call-${event.round}-${current.tools.length}`;
      const tools = [...current.tools];
      const existing = findToolIndex(tools, callId);
      if (existing >= 0) {
        const tool = tools[existing];
        if (tool !== undefined) {
          tools[existing] = {
            ...tool,
            name: tool.name.length > 0 ? tool.name : event.name,
            argsText:
              event.argsDelta.length > 0
                ? clip(`${tool.argsText}${event.argsDelta}`, MAX_ARGS_TEXT)
                : tool.argsText,
          };
        }
      } else {
        tools.push({
          callId,
          round: event.round,
          name: event.name,
          argsText: clip(event.argsDelta, MAX_ARGS_TEXT),
          status: 'pending',
          output: '',
          durationMs: null,
        });
      }
      const rounds = [...round.rounds];
      rounds[round.index] = { ...current, tools };
      return { ...state, rounds };
    }

    case 'tool_started': {
      const round = ensureRound(state.rounds, event.round);
      const current = round.rounds[round.index];
      if (current === undefined) return state;
      const existing = findToolIndex(current.tools, event.callId);
      if (existing >= 0) {
        return {
          ...state,
          rounds: updateTool(round.rounds, event.round, existing, {
            status: 'running',
            name: event.name.length > 0 ? event.name : current.tools[existing]?.name ?? '',
          }),
        };
      }
      return {
        ...state,
        rounds: appendTool(round.rounds, event.round, {
          callId: event.callId.length > 0 ? event.callId : `started-${event.round}-${current.tools.length}`,
          round: event.round,
          name: event.name,
          argsText: '',
          status: 'running',
          output: '',
          durationMs: null,
        }),
      };
    }

    case 'tool_result': {
      const round = ensureRound(state.rounds, event.round);
      const current = round.rounds[round.index];
      if (current === undefined) return state;
      const status: ReviewToolStatus =
        event.denied === true ? 'denied' : event.ok ? 'ok' : 'error';
      const patch: Partial<ReviewToolProcess> = {
        status,
        output: clip(event.output, MAX_OUTPUT_TEXT),
        durationMs: event.durationMs,
      };
      const existing = findToolResultIndex(current.tools, event.toolName);
      if (existing >= 0) {
        return {
          ...state,
          rounds: updateTool(round.rounds, event.round, existing, patch),
        };
      }
      return {
        ...state,
        rounds: appendTool(round.rounds, event.round, {
          callId: `result-${event.round}-${current.tools.length}`,
          round: event.round,
          name: event.toolName,
          argsText: '',
          status,
          output: clip(event.output, MAX_OUTPUT_TEXT),
          durationMs: event.durationMs,
        }),
      };
    }

    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: event.totalInputTokens,
          outputTokens: event.totalOutputTokens,
        },
      };

    case 'finished':
      return {
        ...state,
        finished: { rounds: event.rounds, reason: event.reason },
      };

    case 'completed':
    case 'error':
      return state;

    default:
      return state;
  }
}

function argsToText(args: unknown): string {
  if (args === undefined) return '';
  if (typeof args === 'string') return clip(args, MAX_ARGS_TEXT);
  try {
    return clip(JSON.stringify(args, null, 2) ?? '', MAX_ARGS_TEXT);
  } catch {
    return '';
  }
}

/** 旧 ReviewRun 的 traces → 过程轮次；没有 reasoning/text 时不伪造。 */
export function processFromTraces(traces: readonly ReviewTrace[]): readonly ReviewRoundProcess[] {
  const byRound = new Map<number, ReviewToolProcess[]>();
  traces.forEach((trace, index) => {
    const round = Number.isFinite(trace.round) ? Math.max(1, Math.trunc(trace.round)) : 1;
    const status: ReviewToolStatus =
      trace.denied === true ? 'denied' : trace.ok === false ? 'error' : 'ok';
    const tool: ReviewToolProcess = {
      callId: `trace-${round}-${index}`,
      round,
      name: trace.toolName,
      argsText: argsToText(trace.args),
      status,
      output: clip(typeof trace.output === 'string' ? trace.output : '', MAX_OUTPUT_TEXT),
      durationMs:
        typeof trace.durationMs === 'number' && Number.isFinite(trace.durationMs)
          ? trace.durationMs
          : null,
    };
    const tools = byRound.get(round);
    if (tools === undefined) byRound.set(round, [tool]);
    else tools.push(tool);
  });
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, tools]) => ({ round, reasoning: '', text: '', tools }));
}

/** 实时渲染用的草稿正文：取最后一个有文字的轮次。 */
export function latestReviewText(state: ReviewProcessState): string {
  for (let i = state.rounds.length - 1; i >= 0; i -= 1) {
    const round = state.rounds[i];
    if (round !== undefined && round.text.trim().length > 0) return round.text;
  }
  return '';
}

function parseSseBlock(block: string): { readonly event: string; readonly data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    let value = colon >= 0 ? rawLine.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value.trim();
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * 逐块读取 SSE。支持 CRLF 与跨 chunk 的 \n\n 边界；单条坏事件不会中断整条流。
 */
export async function readReviewSse(
  response: Response,
  onEvent: (event: ReviewStreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('服务端没有返回可读的流');

  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (): void => {
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const parsed = parseSseBlock(block);
      if (parsed !== null) {
        const event = parseReviewEvent(parsed.event, parsed.data);
        if (event !== null) onEvent(event);
      }
      index = buffer.indexOf('\n\n');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      consume();
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (buffer.trim().length > 0) {
      const parsed = parseSseBlock(buffer);
      if (parsed !== null) {
        const event = parseReviewEvent(parsed.event, parsed.data);
        if (event !== null) onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
