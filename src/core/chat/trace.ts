/**
 * 工具循环过程的收集器
 *
 * ★★ 职责：把 `AgentProgressEvent` 流收成一份**可持久化**的 `AgentTraceData`。
 *
 * ⚠️ 为什么需要它 —— 与界面内存里那份的分工：
 *
 *   | | 界面内存 | 本收集器 |
 *   | 用途 | 流式渲染（逐片更新）| 持久化（收完写进消息）|
 *   | 生命周期 | 本轮结束即丢 | 跨刷新留存 |
 *
 *   只做前者的话，用户**刷新后就再也看不到**
 *   「它读了哪个文件、拿到什么结果」—— 而那是「可审计」的核心内容。
 *
 * ★ 三条纪律：
 *   ① **截断** —— 工具结果可能几十 KB，而事件流要长期保存。
 *      完整内容在审计视图里能查（`constraint.injected` 等事件），
 *      这里只留足够的上下文。
 *   ② **思考也留存** —— 实测它是"它为什么这么做"的唯一痕迹。
 *      但同样要截断（一轮的思考可能有几千字）。
 *   ③ **不抛错** —— 收集过程中出问题不该影响对话。
 */

import type { AgentProgressEvent } from '../tools/agentLoop.js';
import type { AgentTraceData } from './types.js';

/** 单条工具结果留存的最大字符数。 */
export const TRACE_RESULT_LIMIT = 1200;

/** 单轮思考留存的最大字符数（超出保留**尾部** —— 结论在最后）。 */
export const TRACE_REASONING_LIMIT = 4000;

/** 单轮正文留存的最大字符数。 */
export const TRACE_TEXT_LIMIT = 2000;

export interface TraceCollector {
  onEvent(e: AgentProgressEvent): void;
  hasContent(): boolean;
  build(): AgentTraceData;
}

export function createTraceCollector(): TraceCollector {
  /** round → 该轮的累积状态（可变，收集期间就地更新） */
  const rounds = new Map<number, RoundState>();

  let finished: AgentTraceData['finished'] = null;
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  /**
   * ⚠️ 返回类型显式写出来而不是用 NonNullable<ReturnType<...>> ——
   *    后者在 Map 上会推导成 T | undefined，导致调用处到处要判空。
   */
  interface RoundState {
    round: number;
    reasoning: string;
    text: string;
    toolCalls: {
      callId: string;
      name: string;
      argsText: string;
      argsComplete: boolean;
      started: boolean;
      ok: boolean;
      denied: boolean;
      output: string;
      durationMs: number;
    }[];
  }

  const ensureRound = (n: number): RoundState => {
    const existing = rounds.get(n);
    if (existing !== undefined) return existing;
    const fresh: RoundState = { round: n, reasoning: '', text: '', toolCalls: [] };
    rounds.set(n, fresh);
    return fresh;
  };

  return {
    onEvent(e: AgentProgressEvent): void {
      try {
        switch (e.kind) {
          case 'roundStarted': {
            ensureRound(e.round);
            break;
          }

          case 'reasoning': {
            const r = ensureRound(e.round);
            // ⚠️ 保留**尾部** —— 思考的结论在最后，开头往往是铺垫
            r.reasoning =
              e.accumulated.length > TRACE_REASONING_LIMIT
                ? `（前文略）…${e.accumulated.slice(-TRACE_REASONING_LIMIT)}`
                : e.accumulated;
            break;
          }

          case 'text': {
            const r = ensureRound(e.round);
            r.text =
              e.accumulated.length > TRACE_TEXT_LIMIT
                ? `（前文略）…${e.accumulated.slice(-TRACE_TEXT_LIMIT)}`
                : e.accumulated;
            break;
          }

          case 'toolCall': {
            const r = ensureRound(e.round);
            // 按 callId 找；找不到就用名字（分片首片才带 id）
            let entry = r.toolCalls.find((t) => t.callId === e.callId);
            if (entry === undefined) {
              entry = {
                callId: e.callId,
                name: e.name,
                argsText: '',
                argsComplete: false,
                started: false,
                ok: false,
                denied: false,
                output: '',
                durationMs: 0,
              };
              r.toolCalls.push(entry);
            }
            if (e.name.length > 0) entry.name = e.name;
            if (e.argsDelta.length > 0) entry.argsText += e.argsDelta;
            if (!e.partial) entry.argsComplete = true;
            break;
          }

          case 'toolStarted': {
            const r = ensureRound(e.round);
            const entry = r.toolCalls.find((t) => t.callId === e.callId);
            if (entry !== undefined) entry.started = true;
            break;
          }

          case 'toolResult': {
            const r = ensureRound(e.round);
            const entry = r.toolCalls.find((t) => t.callId === e.callId);
            if (entry !== undefined) {
              entry.ok = e.ok;
              entry.denied = e.denied;
              entry.argsComplete = true;
              entry.output =
                e.output.length > TRACE_RESULT_LIMIT
                  ? `${e.output.slice(0, TRACE_RESULT_LIMIT)}…（共 ${e.output.length} 字，完整内容见审计视图）`
                  : e.output;
              entry.durationMs = e.durationMs;
            }
            break;
          }

          case 'usage': {
            usage = {
              inputTokens: e.totalInputTokens,
              outputTokens: e.totalOutputTokens,
            };
            break;
          }

          case 'finished': {
            finished = {
              rounds: e.rounds,
              reason: e.reason,
            };
            break;
          }
        }
      } catch {
        // ⚠️ 收集出错不影响对话 —— 它是"记录"，不是"执行"
      }
    },

    hasContent(): boolean {
      return rounds.size > 0;
    },

    build(): AgentTraceData {
      return {
        rounds: [...rounds.values()]
          .sort((a, b) => a.round - b.round)
          .map((r) => ({
            round: r.round,
            reasoning: r.reasoning,
            text: r.text,
            toolCalls: r.toolCalls.map((t) => ({
              callId: t.callId,
              name: t.name,
              argsText: t.argsText,
              ok: t.ok,
              denied: t.denied,
              output: t.output,
              durationMs: t.durationMs,
            })),
          })),
        ...(usage !== null ? { usage } : {}),
        finished,
      };
    },
  };
}
