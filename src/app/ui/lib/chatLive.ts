/**
 * 对话流的事件折叠 —— 把 SSE 事件折叠成界面要渲染的“正在发生”
 *
 * ★ 为什么单独成模块：
 *   SSE 的九种事件有明确顺序，但界面更新必须是**纯函数**才能可靠地
 *   在动画帧里重放。放在组件里用一堆 setState 处理很容易出现
 *   「工具结果到了、但那一轮还没建」这类竞态。
 */

import type { LiveAssistant, LiveRound, LiveTool, SseEvent } from './types.js';

export function emptyAssistant(): LiveAssistant {
  return {
    text: '',
    narration: '',
    narrationReasoning: '',
    narrationTranslated: '',
    stages: [],
    rounds: [],
    usage: null,
    finished: null,
    contract: null,
    assumption: null,
    injectedConstraints: [],
    verdict: null,
    reports: [],
    reflection: null,
    auditRange: null,
    audit: null,
    status: 'waiting',
    error: null,
    firstChunkMs: null,
  };
}

function ensureRound(
  rounds: readonly LiveRound[],
  round: number,
): { readonly rounds: LiveRound[]; readonly index: number } {
  const index = rounds.findIndex((r) => r.round === round);
  if (index >= 0) return { rounds: [...rounds], index };
  const created: LiveRound = {
    round,
    reasoning: '',
    text: '',
    tools: [],
  };
  return { rounds: [...rounds, created], index: rounds.length };
}

function ensureTool(
  rounds: readonly LiveRound[],
  round: number,
  callId: string,
  name: string,
): { readonly rounds: LiveRound[]; readonly index: number; readonly toolIndex: number } {
  const r = ensureRound(rounds, round);
  const next = [...r.rounds];
  const current = next[r.index];
  if (current === undefined) {
    return { rounds: next, index: r.index, toolIndex: -1 };
  }
  const toolIndex = current.tools.findIndex((t) => t.callId === callId);
  if (toolIndex >= 0) {
    if (name.length > 0) {
      const tools = [...current.tools];
      const tool = tools[toolIndex];
      if (tool !== undefined && tool.name.length === 0) {
        tools[toolIndex] = { ...tool, name };
      }
      next[r.index] = { ...current, tools };
    }
    return { rounds: next, index: r.index, toolIndex };
  }
  const tool: LiveTool = {
    callId,
    name,
    argsText: '',
    status: 'pending',
    output: '',
    durationMs: null,
  };
  next[r.index] = { ...current, tools: [...current.tools, tool] };
  return { rounds: next, index: r.index, toolIndex: current.tools.length };
}

function patchRound(
  rounds: readonly LiveRound[],
  round: number,
  patch: Partial<LiveRound>,
): LiveRound[] {
  const r = ensureRound(rounds, round);
  const next = [...r.rounds];
  const current = next[r.index];
  if (current === undefined) return next;
  next[r.index] = { ...current, ...patch };
  return next;
}

/** 把单个 SSE 事件折叠进当前助手消息。返回新对象（不修改入参）。 */
export function applyEvent(a: LiveAssistant, e: SseEvent): LiveAssistant {
  switch (e.type) {
    case 'progress': {
      const label = e.event.label.trim();
      if (label.length === 0 || a.stages[a.stages.length - 1] === label) return a;
      return { ...a, stages: [...a.stages, label].slice(-6) };
    }

    case 'usage': {
      return {
        ...a,
        usage: {
          turnInputTokens: e.totalInputTokens,
          turnOutputTokens: e.totalOutputTokens,
          sessionInputTokens: e.sessionInputTokens,
          sessionOutputTokens: e.sessionOutputTokens,
        },
      };
    }

    case 'narration': {
      return {
        ...a,
        narration: e.answer,
        narrationReasoning: e.reasoning,
        narrationTranslated: e.reasoningTranslated,
        firstChunkMs: e.firstChunkMs,
        status: a.status === 'waiting' ? 'streaming' : a.status,
      };
    }

    case 'agent': {
      switch (e.kind) {
        case 'round': {
          const { rounds } = ensureRound(a.rounds, e.round);
          return { ...a, rounds, status: 'streaming' };
        }
        case 'reasoning': {
          return { ...a, rounds: patchRound(a.rounds, e.round, { reasoning: e.accumulated }) };
        }
        case 'text': {
          return { ...a, rounds: patchRound(a.rounds, e.round, { text: e.accumulated }) };
        }
        case 'toolCall': {
          const { rounds, index, toolIndex } = ensureTool(a.rounds, e.round, e.callId, e.name);
          const current = rounds[index];
          if (current === undefined) return a;
          const tools = [...current.tools];
          const tool = tools[toolIndex];
          // 参数是逐片到达的；界面只需要一个可读片段，不必无限增长。
          if (tool !== undefined && e.argsDelta.length > 0 && tool.argsText.length < 4000) {
            const room = 4000 - tool.argsText.length;
            tools[toolIndex] = {
              ...tool,
              argsText: `${tool.argsText}${e.argsDelta.slice(0, room)}`,
            };
          }
          const next = [...rounds];
          next[index] = { ...current, tools };
          return { ...a, rounds: next, status: 'streaming' };
        }
        case 'toolStarted': {
          const { rounds, index, toolIndex } = ensureTool(a.rounds, e.round, e.callId, e.name);
          const current = rounds[index];
          if (current === undefined) return a;
          const tools = [...current.tools];
          const tool = tools[toolIndex];
          if (tool !== undefined) tools[toolIndex] = { ...tool, status: 'running' };
          const next = [...rounds];
          next[index] = { ...current, tools };
          return { ...a, rounds: next };
        }
        case 'toolResult': {
          const { rounds, index, toolIndex } = ensureTool(a.rounds, e.round, e.callId, e.name);
          const current = rounds[index];
          if (current === undefined) return a;
          const tools = [...current.tools];
          const tool = tools[toolIndex];
          if (tool !== undefined) {
            tools[toolIndex] = {
              ...tool,
              name: tool.name.length > 0 ? tool.name : e.name,
              status: e.denied ? 'denied' : e.ok ? 'ok' : 'error',
              output: e.output,
              durationMs: e.durationMs,
            };
          }
          const next = [...rounds];
          next[index] = { ...current, tools };
          return { ...a, rounds: next };
        }
        case 'finished': {
          return {
            ...a,
            finished: {
              rounds: e.rounds,
              reason: e.reason,
            },
          };
        }
        default:
          return a;
      }
    }

    case 'contract': {
      return {
        ...a,
        contract: e.contract,
        assumption: e.assumption,
        injectedConstraints: e.injectedConstraints,
      };
    }

    case 'reply': {
      return { ...a, text: e.text, status: 'done' };
    }

    case 'verdict': {
      return { ...a, verdict: e.verdict };
    }

    case 'reflection': {
      return { ...a, reflection: e.reflection };
    }

    case 'reports': {
      return { ...a, reports: e.reports };
    }

    case 'audit': {
      return { ...a, auditRange: e.range };
    }

    case 'error': {
      return { ...a, error: e.message, status: 'error' };
    }

    case 'done': {
      return {
        ...a,
        status: a.status === 'error' || a.status === 'aborted' ? a.status : 'done',
      };
    }

    case 'session':
    case 'user':
    case 'approval':
      return a;

    default:
      return a;
  }
}

/** 从解析后的 JSON 里收窄成 SSE 事件（形状不可信）。 */
export function asSseEvent(value: unknown): SseEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['type'] !== 'string') return null;

  /**
   * ★ 按类型做字段级收窄，而不是"只查 type 就强转"。
   *
   *   旧实现 `return value as SseEvent` 只保证 type 是字符串；一条缺字段的
   *   `{"type":"progress"}` 会让 `applyEvent` 在 `e.event.label.trim()` 上抛
   *   TypeError（实测），而这个异常发生在流式渲染路径里 ——
   *   整页会被 error boundary 替换，正在输出的内容一起消失。
   *
   *   这里对**会解引用字段的类型**逐条校验；校验失败返回 null，调用方会跳过
   *   这一条坏事件，本轮其余内容继续渲染。未知类型保持原行为（放过），
   *   避免前端比后端"更早知道"新事件类型而把它们全丢掉。
   */
  const str = (v: unknown): v is string => typeof v === 'string';
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const obj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

  switch (rec['type']) {
    case 'progress': {
      const event = rec['event'];
      if (!obj(event) || !str(event['label']) || !str(event['stage'])) return null;
      return value as SseEvent;
    }
    case 'narration':
      return str(rec['answer']) && str(rec['reasoning']) ? (value as SseEvent) : null;
    case 'agent': {
      const kind = rec['kind'];
      if (!str(kind) || !num(rec['round'])) return null;
      if (kind === 'reasoning' || kind === 'text') {
        return str(rec['accumulated']) ? (value as SseEvent) : null;
      }
      if (kind === 'toolCall') {
        return str(rec['callId']) && str(rec['name']) && str(rec['argsDelta'])
          ? (value as SseEvent)
          : null;
      }
      if (kind === 'toolStarted') {
        return str(rec['callId']) && str(rec['name']) ? (value as SseEvent) : null;
      }
      if (kind === 'toolResult') {
        return str(rec['callId']) && str(rec['name']) && str(rec['output'])
          ? (value as SseEvent)
          : null;
      }
      if (kind === 'finished') return str(rec['reason']) ? (value as SseEvent) : null;
      return value as SseEvent;
    }
    case 'usage':
      return num(rec['totalInputTokens']) &&
        num(rec['totalOutputTokens']) &&
        num(rec['sessionInputTokens']) &&
        num(rec['sessionOutputTokens'])
        ? (value as SseEvent)
        : null;
    case 'reply':
      return str(rec['text']) ? (value as SseEvent) : null;
    case 'error':
      return str(rec['message']) ? (value as SseEvent) : null;
    case 'approval':
      return str(rec['id']) && str(rec['toolName']) ? (value as SseEvent) : null;
    case 'contract':
      return obj(rec['contract']) || rec['contract'] === null
        ? Array.isArray(rec['injectedConstraints'])
          ? (value as SseEvent)
          : null
        : null;
    case 'reports':
      return Array.isArray(rec['reports']) ? (value as SseEvent) : null;
    default:
      return value as SseEvent;
  }
}
