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
  maxRounds: number,
): { readonly rounds: LiveRound[]; readonly index: number } {
  const index = rounds.findIndex((r) => r.round === round);
  if (index >= 0) {
    const next = [...rounds];
    const current = next[index];
    if (current !== undefined && (maxRounds > 0 || current.maxRounds === 0)) {
      next[index] = {
        ...current,
        maxRounds: maxRounds > 0 ? maxRounds : current.maxRounds,
      };
    }
    return { rounds: next, index: index < 0 ? 0 : index };
  }
  const created: LiveRound = {
    round,
    maxRounds: maxRounds > 0 ? maxRounds : 0,
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
  const r = ensureRound(rounds, round, 0);
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
  const r = ensureRound(rounds, round, 0);
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
          const { rounds } = ensureRound(a.rounds, e.round, e.maxRounds);
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
              hitRoundLimit: e.hitRoundLimit,
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
  return value as SseEvent;
}
