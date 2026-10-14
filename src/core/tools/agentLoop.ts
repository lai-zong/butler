/**
 * Agent 工具循环
 *
 * 设计依据：方案 § 6（操作能力）、§ 12（大模型集成质量）
 *
 * 这是"仆人真的能动手"的那一环：模型提出工具调用 → 校验参数 →
 * 经安全闸门执行 → 结果回喂 → 直到模型不再调用工具或达到轮次上限。
 *
 * ★ 三条纪律：
 *   ① **参数在边界校验** —— 模型生成的参数不能直接信，
 *      给出可纠正的反馈（"缺少必填参数 path"）而不是让它以执行错误的面目出现
 *   ② **一切执行走 ToolFramework** —— 循环本身**不**直接调用工具实现，
 *      因此权限闸门无法被绕过（这条是安全设计的核心）
 *   ③ **有界** —— 轮次上限 + 上下文裁剪，防止模型陷入"调工具→看结果→再调"的死循环
 *      把 token 烧光
 */

import type { EventLog } from '../events/log.js';
import { msg, type ModelMessage, type ModelPort, type ModelToolSpec } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import type { ToolFramework } from './framework.js';
import type { ToolSpec } from './types.js';
import { issuesToMessage, validateArgs } from './validate.js';

/** 默认最大轮次。超过就该判断"这个任务不适合用工具解决"。 */
export const DEFAULT_MAX_ROUNDS = 8;

/** 历史里保留的最大工具结果条数（更早的被摘要替换，控制上下文增长）。 */
export const MAX_TOOL_RESULTS_IN_HISTORY = 12;

/** 单个工具结果进上下文的最大字符数。 */
export const TOOL_RESULT_CHAR_LIMIT = 4000;

export interface AgentLoopOptions {
  readonly model: ModelPort;
  readonly tools: ToolFramework;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly taskId: string;
  /** 暴露给模型的工具（默认全部；可按仆人能力收窄） */
  readonly toolFilter?: (t: ToolSpec) => boolean;
  readonly maxRounds?: number;
  /**
   * 终止工具名。该工具**成功执行**后循环立即结束。
   *
   * 用途：仆人通过 `submit_report` 提交结构化汇报 ——
   * 汇报本身就是任务完成的标志，不必再多跑一轮让模型说"我提交完了"。
   *
   * ⚠️ 只有**成功**才算终止：执行失败（如格式不合规）时继续循环，
   *    让模型有机会修正后重新提交。
   */
  readonly terminalTool?: string;
}

export interface ToolCallTrace {
  readonly round: number;
  readonly toolName: string;
  readonly args: unknown;
  /** 校验是否通过 */
  readonly validated: boolean;
  readonly validationMessage?: string;
  /** 执行结果（校验未通过时为空） */
  readonly output?: string;
  readonly ok: boolean;
  readonly denied?: boolean;
  readonly durationMs: number;
}

export interface AgentLoopResult {
  /** 模型最终的文本回答 */
  readonly finalText: string;
  readonly traces: readonly ToolCallTrace[];
  readonly rounds: number;
  /** 是否因为达到轮次上限而中止 */
  readonly hitRoundLimit: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** 最终的消息序列（便于继续对话或审计） */
  readonly messages: readonly ModelMessage[];
}

export async function runAgentLoop(
  opts: AgentLoopOptions,
  initialMessages: readonly ModelMessage[],
): Promise<AgentLoopResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const toolSpecs: readonly ModelToolSpec[] = opts.tools.toModelSpecs(opts.toolFilter);

  const messages: ModelMessage[] = [...initialMessages];
  const traces: ToolCallTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let round = 0;

  while (round < maxRounds) {
    round += 1;

    const res = await opts.model.complete({
      purpose: 'servant',
      messages,
      ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
      temperature: 0.2,
    });
    inputTokens += res.usage.inputTokens;
    outputTokens += res.usage.outputTokens;

    // 模型不再调用工具 → 这就是最终答案
    if (res.toolCalls.length === 0) {
      if (res.text.length > 0) messages.push(msg.assistant(res.text));
      return {
        finalText: res.text,
        traces,
        rounds: round,
        hitRoundLimit: false,
        usage: { inputTokens, outputTokens },
        messages,
      };
    }

    // 记录模型的工具调用意图
    messages.push({
      role: 'assistant',
      content: [
        ...(res.text.length > 0 ? [{ kind: 'text' as const, text: res.text }] : []),
        ...res.toolCalls.map((tc) => ({
          kind: 'toolCall' as const,
          callId: tc.callId,
          name: tc.name,
          args: tc.args,
        })),
      ],
    });

    // 逐个执行（顺序执行：避免并发写同一文件导致的竞态，
    // 也让审计顺序与用户看到的顺序一致）
    for (const tc of res.toolCalls) {
      const started = opts.clock.now();
      const spec = opts.tools.get(tc.name);

      // ① 未知工具
      if (!spec) {
        const message = `未知工具「${tc.name}」。可用工具：${toolSpecs.map((t) => t.name).join(', ')}`;
        traces.push({
          round,
          toolName: tc.name,
          args: tc.args,
          validated: false,
          validationMessage: message,
          ok: false,
          durationMs: opts.clock.now() - started,
        });
        messages.push(msg.toolResult(tc.callId, { error: message }, true));
        continue;
      }

      // ② 参数校验 —— 模型生成的参数不能直接信
      const check = validateArgs(spec.parameters, tc.args);
      if (!check.ok) {
        const message = issuesToMessage(tc.name, check.issues);
        traces.push({
          round,
          toolName: tc.name,
          args: tc.args,
          validated: false,
          validationMessage: message,
          ok: false,
          durationMs: opts.clock.now() - started,
        });
        // ⚠️ 校验失败仍然要落事件：否则"模型反复写错参数"这件事看不见
        opts.log.append({
          type: 'tool.call',
          actor: 'butler',
          payload: {
            toolName: tc.name,
            taskId: opts.taskId,
            round,
            validationFailed: true,
            issues: check.issues,
          },
          createdAt: opts.clock.now(),
        });
        messages.push(msg.toolResult(tc.callId, { error: message }, true));
        continue;
      }

      // ③ 走闸门执行 —— 循环不直接碰工具实现，因此权限无法绕过
      opts.log.append({
        type: 'tool.call',
        actor: 'butler',
        payload: {
          toolName: tc.name,
          taskId: opts.taskId,
          round,
          tier: spec.tier,
          argsSummary: safeSummary(check.value),
        },
        createdAt: opts.clock.now(),
      });

      let output: string;
      let ok: boolean;
      let denied = false;
      try {
        const r = await opts.tools.execute({
          toolName: tc.name,
          args: check.value,
          taskId: opts.taskId,
        });
        output = r.output;
        ok = r.ok;
      } catch (err) {
        // 被闸门拒绝（用户拒绝 / 级别未开启）会走到这里
        output = err instanceof Error ? err.message : String(err);
        ok = false;
        denied = true;
      }

      const trimmed = truncate(output, TOOL_RESULT_CHAR_LIMIT);
      traces.push({
        round,
        toolName: tc.name,
        args: check.value,
        validated: true,
        output: trimmed,
        ok,
        ...(denied ? { denied: true } : {}),
        durationMs: opts.clock.now() - started,
      });

      messages.push(msg.toolResult(tc.callId, denied ? { denied: trimmed } : trimmed, !ok));

      // ★ 终止工具成功执行 → 立即结束，不再多跑一轮。
      //   注意只有成功才算：失败时继续循环，让模型有机会修正后重新提交。
      if (opts.terminalTool !== undefined && tc.name === opts.terminalTool && ok) {
        return {
          finalText: res.text,
          traces,
          rounds: round,
          hitRoundLimit: false,
          usage: { inputTokens, outputTokens },
          messages,
        };
      }
    }

    // 上下文裁剪：保留最近的若干条工具结果，更早的替换成占位
    trimHistory(messages);
  }

  opts.log.append({
    type: 'supervisor.observe',
    actor: 'supervisor',
    payload: {
      taskId: opts.taskId,
      reason: 'agent_round_limit',
      rounds: round,
      note: `达到轮次上限（${maxRounds}），可能陷入循环或被任务本身不适合用工具解决`,
    },
    createdAt: opts.clock.now(),
  });

  return {
    finalText:
      `（已达工具调用轮次上限 ${maxRounds}，中止。最后一次输出：）` +
      (traces.length > 0 ? `\n已执行 ${traces.length} 次工具调用。` : ''),
    traces,
    rounds: round,
    hitRoundLimit: true,
    usage: { inputTokens, outputTokens },
    messages,
  };
}

// ═══════════════════════════════════════════════════════════
// 上下文管理
// ═══════════════════════════════════════════════════════════

/**
 * 裁剪历史里的工具结果。
 *
 * 为什么必须做：一个读文件的工具返回几千字符，
 * 八轮下来上下文就爆了 —— 而且早期结果对后续决策价值递减。
 * 用占位替换既保住了"这里发生过一次工具调用"的事实，
 * 又不让体积无限增长。
 */
export function trimHistory(messages: ModelMessage[]): void {
  const resultIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.content.some((p) => p.kind === 'toolResult')) resultIndexes.push(i);
  }

  const excess = resultIndexes.length - MAX_TOOL_RESULTS_IN_HISTORY;
  if (excess <= 0) return;

  for (let i = 0; i < excess; i++) {
    const idx = resultIndexes[i];
    if (idx === undefined) continue;
    const m = messages[idx];
    if (!m) continue;
    messages[idx] = {
      role: m.role,
      content: m.content.map((p) =>
        p.kind === 'toolResult'
          ? {
              kind: 'toolResult' as const,
              callId: p.callId,
              result: '（较早的工具结果已省略以控制上下文）',
              isError: p.isError ?? false,
            }
          : p,
      ),
    };
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（结果过长已截断，共 ${text.length} 字符）`;
}

function safeSummary(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
  } catch {
    return '(无法序列化)';
  }
}
