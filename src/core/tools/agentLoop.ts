/**
 * Agent 工具循环
 *
 * 设计依据：方案 § 6（操作能力）、§ 12（大模型集成质量）
 *
 * 这是「仆人真的能动手」的那一环：模型提出工具调用 → 校验参数 →
 * 经安全闸门执行 → 结果回喂 → 直到模型不再调用工具或达到轮次上限。
 *
 * ★ 三条纪律：
 *   ① **参数在边界校验** —— 模型生成的参数不能直接信，
 *      给出可纠正的反馈（「缺少必填参数 path」）而不是让它以执行错误的面目出现
 *   ② **一切执行走 ToolFramework** —— 循环本身**不**直接调用工具实现，
 *      因此权限闸门无法被绕过（这条是安全设计的核心）
 *   ③ **有界** —— 轮次上限 + 上下文裁剪，防止模型陷入「调工具→看结果→再调」的死循环
 *      把 token 烧光
 *
 * ★★ 关于流式（`streamPort`）：
 *
 *   给出 `streamPort` 时，每一轮走**流式**，并把过程通过 `onProgress`
 *   实时推给界面：思考分片、正文分片、工具调用分片、工具结果。
 *
 *   **这才是 dsh / codex 那种「思考 → 工具 → 再思考」画面的来源** ——
 *   在此之前工具循环完全不可见（grep 全 `src/app` 搜 `toolCall` 无匹配），
 *   用户只能看到一行行进度文字。
 *
 *   ⚠️ 不给 `streamPort` 时行为与之前**完全一致**（走 `model.complete`）——
 *      既有 40+ 测试与验证脚本不受影响。
 *      这个"两条路径并存"是刻意的：流式要拿到真实模型才能验证，
 *      而单元测试用 MockModel 走非流式路径更稳定。
 */

import { DEFAULT_TOOL_RESULT_CHAR_LIMIT } from '../config/budget.js';
import { limitsConfig } from '../config/env.js';
import type { EventLog } from '../events/log.js';
import { msg, type ModelMessage, type ModelPort, type ModelToolSpec } from '../ports/model.js';
import type { ClockPort } from '../ports/clock.js';
import type { ModelStreamPort } from '../ports/stream.js';
import type { ToolFramework } from './framework.js';
import type { ToolSpec } from './types.js';
import { issuesToMessage, validateArgs } from './validate.js';
import {
  buildAlert,
  isUntrusted,
  wrapUntrusted,
  type InputAlert,
  type SourcedContent,
  type TrustLevel,
} from '../security/injection.js';

/** 默认最大轮次。超过就该判断"这个任务不适合用工具解决"。 */
/**
 * 默认最大推理轮次。
 *
 * ★ v8 · 2026-10-18：默认**不设上限**（`Infinity`）—— 方案 §14 / D-30。
 *   可用 `MAX_ROUNDS_PER_SESSION` 环境变量人为收紧（调试/压测用）。
 *
 * ⚠️ getter 而非常量：环境变量在模块加载后才载入。
 */
export function defaultMaxRounds(): number {
  return limitsConfig.maxRoundsPerSession;
}

/**
 * @deprecated 用 `defaultMaxRounds()`。
 *
 * ★ v8 · 2026-10-18：由 8 改为 `Infinity`，与"不设上限"的决策一致。
 *   ⚠️ 保留符号只是因为既有测试引用了它；**生产代码用 `defaultMaxRounds()`**。
 */
export const DEFAULT_MAX_ROUNDS = Number.POSITIVE_INFINITY;

/** 历史里保留的最大工具结果条数。 */
export const MAX_TOOL_RESULTS_IN_HISTORY = 12;

// ═══════════════════════════════════════════════════════════
// 循环进度（供界面实时呈现）
// ═══════════════════════════════════════════════════════════

/**
 * 循环进度事件。
 *
 * ★ 这是「让模型干活的过程可见」的载体 —— 界面上那条
 *   「思考 → 工具 → 再思考」的流，就是这些事件拼出来的。
 *
 * ⚠️ 刻意**逐类区分**而不是一个通用的 `message`：
 *   界面要对它们做不同渲染（思考是灰字、工具是卡片、结果是代码块），
 *   一个通用事件会让界面不得不自己解析文本去猜类型。
 */
export type AgentProgressEvent =
  /** 新一轮开始（模型开始思考） */
  | { readonly kind: 'roundStarted'; readonly round: number; readonly maxRounds: number }
  /** 思考分片（可能为空 —— 实测模型按任务难度分配思考量） */
  | { readonly kind: 'reasoning'; readonly round: number; readonly delta: string; readonly accumulated: string }
  /** 正文分片（模型对用户说的话） */
  | {
      readonly kind: 'text';
      readonly round: number;
      readonly delta: string;
      readonly accumulated: string;
    }
  /** 工具调用开始（参数可能还在拼接 —— `partial` 为 true 时表示未完成） */
  | {
      readonly kind: 'toolCall';
      readonly round: number;
      readonly callId: string;
      readonly name: string;
      readonly argsDelta: string;
      readonly partial: boolean;
    }
  /** 工具开始执行（参数已校验通过，进入闸门） */
  | { readonly kind: 'toolStarted'; readonly round: number; readonly callId: string; readonly name: string }
  /** 工具结果（可能是执行结果，也可能是被拒绝/校验失败） */
  | {
      readonly kind: 'toolResult';
      readonly round: number;
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly denied: boolean;
      readonly output: string;
      readonly durationMs: number;
    }
  /** 循环结束 */
  | {
      readonly kind: 'finished';
      readonly rounds: number;
      readonly hitRoundLimit: boolean;
      readonly reason: 'noToolCalls' | 'terminalTool' | 'roundLimit';
    };

/** 一轮的产出（流式与非流式共用同一形状 —— 让主循环不必分叉）。 */
interface RoundOutcome {
  readonly text: string;
  readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly args: string }[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * 跑一轮（流式）。
 *
 * ★★ 工具调用分片的拼接是这里的**技术核心**，也是最容易写错的地方：
 *
 *   OpenAI 兼容协议里，工具调用以**分片**到达：
 *     · `id` 与 `function.name` 只在**该调用的第一个分片**里出现
 *     · `function.arguments` 是**逐段拼接**的 JSON 字符串
 *     · `index` 是**稳定标识**，每个分片都带
 *
 *   ⚠️ 所以必须按 **`index`** 聚合，不能按 `id`（后续分片可能没有 id）。
 *      按 id 聚合会把一次调用拆成多个，参数拼不起来 ——
 *      症状是"参数是残缺的 JSON"，而这个错很难从现象推回原因。
 */
async function runRoundStreaming(args: {
  readonly port: ModelStreamPort;
  readonly messages: readonly ModelMessage[];
  readonly toolSpecs: readonly ModelToolSpec[];
  readonly round: number;
  readonly maxRounds: number;
  readonly onProgress?: (e: AgentProgressEvent) => void;
}): Promise<RoundOutcome> {
  const emit = (e: AgentProgressEvent): void => {
    try {
      args.onProgress?.(e);
    } catch {
      // ⚠️ 界面出错不该拖垮工具循环 —— 这是「回调是纯通知」的落实
    }
  };

  emit({ kind: 'roundStarted', round: args.round, maxRounds: args.maxRounds });

  let text = '';
  let reasoning = '';
  const usage = { inputTokens: 0, outputTokens: 0 };

  /** ⚠️ 按 `index` 聚合，不按 id —— 见上方说明。 */
  const byIndex = new Map<number, { callId: string; name: string; args: string }>();

  for await (const chunk of args.port.stream({
    purpose: 'execution',
    messages: args.messages,
    ...(args.toolSpecs.length > 0 ? { tools: args.toolSpecs } : {}),
    temperature: 0.2,
  })) {
    switch (chunk.kind) {
      case 'reasoning':
        reasoning += chunk.delta;
        emit({
          kind: 'reasoning',
          round: args.round,
          delta: chunk.delta,
          accumulated: reasoning,
        });
        break;

      case 'text':
        text += chunk.delta;
        emit({ kind: 'text', round: args.round, delta: chunk.delta, accumulated: text });
        break;

      case 'toolCall': {
        /**
         * ★★ 按 `index` 聚合 —— 这是唯一稳定正确的做法。
         *
         *   ⚠️ **不能按 `callId` 或 `name` 聚合**，原因见
         *      `ModelStreamChunk` 里那段说明：`id` 与 `name`
         *      **只在一次调用的第一个分片出现**。
         *
         *      正确的分片形状（实测原始 SSE）：
         *        #1  index=0  name="list_dir"  argsDelta=""
         *        #2  index=0  name=""          argsDelta="{"
         *        …   index=0  name=""          argsDelta="}"
         *
         *   ⚠️ 我第一版按 `name`/`callId` 聚合，结果一次调用被拆成两个：
         *      一个只有名字没参数、一个只有参数没名字 ——
         *      **两者都通不过参数校验**。
         *      实测症状：20 轮、25 次调用、参数全空、6.9 万输入 token 烧光。
         */
        const prev = byIndex.get(chunk.index) ?? { callId: chunk.callId, name: '', args: '' };
        byIndex.set(chunk.index, {
          callId: chunk.callId.length > 0 ? chunk.callId : prev.callId,
          name: chunk.name.length > 0 ? chunk.name : prev.name,
          args: prev.args + chunk.argsDelta,
        });

        emit({
          kind: 'toolCall',
          round: args.round,
          callId: chunk.callId,
          name: chunk.name,
          argsDelta: chunk.argsDelta,
          // 参数还在拼 —— 界面据此显示「正在生成参数」
          partial: true,
        });
        break;
      }

      case 'done':
        usage.inputTokens = chunk.usage.inputTokens;
        usage.outputTokens = chunk.usage.outputTokens;
        break;
    }
  }

  const toolCalls = [...byIndex.values()]
    .filter((c) => c.name.length > 0)
    .map((c) => ({ callId: c.callId, name: c.name, args: c.args }));

  // 工具调用的参数拼完了 —— 再推一次，标记 partial: false
  for (const tc of toolCalls) {
    emit({
      kind: 'toolCall',
      round: args.round,
      callId: tc.callId,
      name: tc.name,
      argsDelta: '',
      partial: false,
    });
  }

  return { text, toolCalls, usage };
}

/**
 * 把流式拼接出来的参数 JSON 串解析成对象。
 *
 * ⚠️ 为什么失败时返回一个**带 `__raw` 的对象**而不是 `null`：
 *   返回 `null` 会让下游的 `validateArgs` 报「缺少全部必填参数」——
 *   那对模型是**误导性的反馈**（它会以为参数名写错了，而不是参数没拼完）。
 *   带上 `__raw` 后校验器能给出「参数格式不合规」这类准确提示。
 */
function parseStreamedArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  try {
    const v: unknown = JSON.parse(trimmed);
    return v;
  } catch {
    return { __raw: trimmed, __parseError: '工具调用参数不是合法 JSON（可能被截断）' };
  }
}

/**
 * 单个工具结果进上下文的最大字符数。
 *
 * ★ v8 · 2026-10-18：由 4,000 改为标准档的 **8,192**（方案 §14）。
 *
 *   ⚠️ 这是**真正生效**的那个阈值 —— 不是 `compaction.ts` 里那个
 *      `TOOL_OUTPUT_PRUNE_CHARS`（那个已删除，它生产无调用方）。
 *      方案 §14 的「工具输出的三个不同位置」把这件事写清了。
 *
 *   DSH 对应实现是 `dsh-compaction-tool-result-pruner`：
 *   threshold 8,192 / keepHead 4,096 / keepTail 1,024。
 */
export const TOOL_RESULT_CHAR_LIMIT = DEFAULT_TOOL_RESULT_CHAR_LIMIT;

export interface AgentLoopOptions {
  readonly model: ModelPort;
  readonly tools: ToolFramework;
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly taskId: string;
  /**
   * 本次任务的**自然语言目标**，透传到 `ToolContext.task`。
   *
   * ★ 用途：桌面工具据此记录"这类任务用哪种方式成功"（方案 §6.3 ①）。
   *   ⚠️ 不传就意味着操作记忆拿不到签名 —— 那宁可不记录，也不编造。
   */
  readonly task?: string;
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
  /**
   * 该工具结果的**信任级别**。缺省按工具名推断（见 `defaultTrustFor`）。
   *
   * ★ 这是输入侧防护的接入点（方案 § 11 第一层）：
   *   工具结果是外部内容进入上下文的**唯一入口**，
   *   所以注入防护必须挂在这里 —— 挂在别处都会漏。
   */
  readonly trustOf?: (toolName: string) => TrustLevel;
  /** 需要用户确认的告警回调（高风险内容） */
  readonly onAlert?: (alert: InputAlert) => void;
  /**
   * 流式端口。给出时每一轮走流式，并把过程实时推给 onProgress。
   *
   * ⚠️ 不给则行为与之前**完全一致**（走 model.complete）——
   *    既有 40+ 测试与验证脚本不受影响。
   *    这个「两条路径并存」是刻意的：流式要真实模型才能验证，
   *    而单元测试用 MockModel 走非流式路径更稳定。
   */
  readonly streamPort?: ModelStreamPort;
  /**
   * 循环进度回调 —— 「思考 → 工具 → 再思考」画面的来源。
   *
   * ⚠️ 回调是**纯通知**：它抛错会被吞掉，不影响循环。
   */
  readonly onProgress?: (e: AgentProgressEvent) => void;
}

/**
 * 按工具名推断结果信任级别。
 *
 * 判据：这个工具的结果**来自哪里**。
 *   · 读本地文件、列目录、看路径  → tool（本机数据，半可信）
 *   · 抓网页、调第三方 API        → external（最低）
 *   · 执行命令                    → tool（输出可能是任何东西，但通常来自本机）
 *
 * ⚠️ 默认值取 `tool` 而非 `external`：把一切都当"最低信任"会让包裹失去区分度，
 *    模型面对满屏警告会开始忽略它们 —— 那比不警告更糟。
 */
export function defaultTrustFor(toolName: string): TrustLevel {
  if (/^(fetch|web|http|browse|search_web|crawl)/i.test(toolName)) return 'external';
  return 'tool';
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
  const maxRounds = opts.maxRounds ?? defaultMaxRounds();
  const toolSpecs: readonly ModelToolSpec[] = opts.tools.toModelSpecs(opts.toolFilter);

  const messages: ModelMessage[] = [...initialMessages];
  const traces: ToolCallTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let round = 0;

  const emitProgress = (e: AgentProgressEvent): void => {
    try {
      opts.onProgress?.(e);
    } catch {
      // 界面出错不影响循环
    }
  };

  while (round < maxRounds) {
    round += 1;

    /**
     * ★★ 两条路径共用同一份「一轮的产出」形状，主循环不必分叉。
     *
     *   ⚠️ 走流式时**工具调用的参数是拼接出来的字符串**，
     *      而非流式时 `complete()` 已经给了解析后的对象。
     *      所以这里要把字符串解析回对象，才能进 `validateArgs`。
     *
     *   ⚠️ 用 if/else 而不是三元表达式：TS 无法在三元的两个分支里
     *      收窄 `opts.streamPort`（它只在同一次属性访问上有效）。
     *      用局部常量显式收窄，而不是加 `!` —— 断言会掩盖真正的 undefined。
     */
    interface RoundResult {
      readonly text: string;
      readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly args: unknown }[];
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    }

    let res: RoundResult;
    const streamPort = opts.streamPort;

    if (streamPort !== undefined) {
      const raw = await runRoundStreaming({
        port: streamPort,
        messages,
        toolSpecs,
        round,
        maxRounds,
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      });
      res = {
        text: raw.text,
        toolCalls: raw.toolCalls.map((tc) => ({
          callId: tc.callId,
          name: tc.name,
          // 参数是逐段拼出来的 JSON 字符串；残缺时给出明确的错误标记，
          // 让它以「参数不合规」的面目出现，而不是一个诡异的崩溃
          args: parseStreamedArgs(tc.args),
        })),
        usage: raw.usage,
      };
    } else {
      const r = await opts.model.complete({
        purpose: 'execution',
        messages,
        ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        temperature: 0.2,
      });
      res = { text: r.text, toolCalls: r.toolCalls, usage: r.usage };
    }

    inputTokens += res.usage.inputTokens;
    outputTokens += res.usage.outputTokens;

    // 模型不再调用工具 → 这就是最终答案
    if (res.toolCalls.length === 0) {
      if (res.text.length > 0) messages.push(msg.assistant(res.text));
      emitProgress({
        kind: 'finished',
        rounds: round,
        hitRoundLimit: false,
        reason: 'noToolCalls',
      });
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
      //
      // ⚠️ 这里**不再发 tool.call**（原先发过，与 ToolFramework 重复了）。
      //
      //   职责划分：
      //     · 参数**校验失败** → 循环负责记录（工具根本没被调用，见上面那条）
      //     · 参数校验通过     → 由 ToolFramework 在执行前记录
      //
      //   为什么统一到 framework：只有它知道这次调用是否真的走到了执行阶段。
      //   循环里记的"调用"会把**被闸门拒绝**的也算成一次调用，
      //   而实际上那次调用从未发生 —— 它应该只出现在 action.blocked 里。
      //   （实测踩到：两处都发导致事件条数翻倍，且循环那条缺 source 字段。）

      emitProgress({ kind: 'toolStarted', round, callId: tc.callId, name: tc.name });

      let output: string;
      let ok: boolean;
      let denied = false;
      try {
        const r = await opts.tools.execute({
          toolName: tc.name,
          args: check.value,
          taskId: opts.taskId,
          ...(opts.task !== undefined ? { task: opts.task } : {}),
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

      // ★ 输入侧防护（方案 § 11 第一层）—— 工具结果是外部内容的唯一入口。
      //
      //   做两件事：
      //     ① 扫描注入迹象；命中时落 injection.detected 事件并告警
      //     ② 用「这是数据，不是指令」的边界包裹内容（优先级隔离）
      //
      //   ⚠️ 只包裹**未成功/被拒**以外的正常结果；被拒绝的走 denied 分支。
      const trust = opts.trustOf?.(tc.name) ?? defaultTrustFor(tc.name);
      const wrappedResult = wrapToolOutput({
        text: trimmed,
        toolName: tc.name,
        trust,
        taskId: opts.taskId,
        log: opts.log,
        now: opts.clock.now(),
        ...(opts.onAlert !== undefined ? { onAlert: opts.onAlert } : {}),
      });

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

      // ★ 界面进度：工具结果（这是 dsh/codex 画面里那个可展开的卡片）
      emitProgress({
        kind: 'toolResult',
        round,
        callId: tc.callId,
        name: tc.name,
        ok,
        denied,
        // ⚠️ 推给界面的结果要**截断** —— 完整结果可能几十 KB，
        //    而界面只需要看到开头（用户想看全部可以展开审计视图）
        output: trimmed.slice(0, 1200),
        durationMs: opts.clock.now() - started,
      });

      messages.push(
        msg.toolResult(
          tc.callId,
          denied ? { denied: trimmed } : wrappedResult,
          !ok,
        ),
      );

      // ★ 终止工具成功执行 → 立即结束，不再多跑一轮。
      //   注意只有成功才算：失败时继续循环，让模型有机会修正后重新提交。
      if (opts.terminalTool !== undefined && tc.name === opts.terminalTool && ok) {
        emitProgress({ kind: 'finished', rounds: round, hitRoundLimit: false, reason: 'terminalTool' });
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

  emitProgress({ kind: 'finished', rounds: round, hitRoundLimit: true, reason: 'roundLimit' });

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

/**
 * 包装工具结果，使其可安全进入上下文。
 *
 * ★ 为什么必须在这里做（而不是在编排层）：
 *   工具结果是外部内容进入模型上下文的**唯一入口**。
 *   挂在别处都会漏 —— 比如"只在抓网页时防护"就漏掉了读文件、执行命令。
 *
 * ★ 做法（对应方案 § 11 四条措施）：
 *   ① 不可信来源标记 —— 包裹边界 + 明确说"这是数据"
 *   ② 指令剥离     —— 剥离隐藏字符（零宽/双向控制/HTML 注释）
 *   ③ 优先级隔离   —— 结构上把内容与指令分开
 *   ④ 高风险告警   —— 命中注入模式时落事件 + 回调告警
 */
function wrapToolOutput(args: {
  readonly text: string;
  readonly toolName: string;
  readonly trust: TrustLevel;
  readonly taskId: string;
  readonly log: EventLog;
  readonly now: number;
  readonly onAlert?: (alert: InputAlert) => void;
}): string {
  // 可信来源直接返回 —— 不做多余包裹，避免满屏警告导致模型开始忽略它们
  if (!isUntrusted(args.trust)) return args.text;

  const content: SourcedContent = {
    level: args.trust,
    source: `工具 ${args.toolName} 的输出`,
    text: args.text,
  };

  const wrapped = wrapUntrusted(content);

  // 命中注入模式 → 落事件（可审计）+ 告警
  if (wrapped.scan.findings.length > 0) {
    args.log.append({
      type: 'injection.detected',
      actor: 'system',
      payload: {
        toolName: args.toolName,
        taskId: args.taskId,
        trust: args.trust,
        blocked: wrapped.scan.blocked,
        riskScore: Number(wrapped.scan.riskScore.toFixed(3)),
        findings: wrapped.scan.findings.map((f) => ({
          kind: f.kind,
          severity: f.severity,
          excerpt: f.excerpt,
          note: f.note,
        })),
        strippedHiddenChars: wrapped.strippedCount > 0,
      },
      createdAt: args.now,
    });

    const alert = buildAlert({ content, scan: wrapped.scan });
    if (alert && args.onAlert) args.onAlert(alert);
  }

  return wrapped.wrapped;
}

// ═══════════════════════════════════════════════════════════
// 上下文管理
// ═══════════════════════════════════════════════════════════

/**
 * 裁剪历史里的工具结果。
 *
 * 为什么必须做：一个读文件的工具返回几千字符，
 * 八轮下来上下文就爆了 —— 而且早期结果对后续决策价值递减。
 *
 * ★★ v7 改进：从"直接抹掉"改成"**分三档压缩**"（§3.1b 层①）。
 *
 *   旧做法：超出 N 条的一律替换成 `（较早的工具结果已省略…）` —— **信息全丢**。
 *   后果很隐蔽：那批结果里可能正好有"这个文件不存在"这种关键结论，
 *   抹掉之后模型会**重复踩同一个坑**（再读一次、再失败一次）。
 *
 *   新做法（三档，按新旧程度）：
 *   ```
 *   最近 N 条        → 完整保留
 *   中间那批         → 剪枝成「头 + 中略 + 尾」（**保住结论**）
 *   最老的（再 N 条外）→ 占位符（此时确实已无决策价值）
 *   ```
 *
 *   ⚠️ 为什么保留**尾部**：命令/文件的结论常在最末
 *      （`EXIT 0`、`共 12 项`、`未找到`）。剪掉尾巴等于剪掉答案。
 *
 *   ⚠️ **原文不受影响**：完整结果已在 `tool.result` 事件里落盘，
 *      审计视图与精确重放读的都是事件而非这里的消息数组。
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

  // 超出部分里，**较新的那一半剪枝**（保结论），**更老的那一半才占位**
  const pruneCount = Math.ceil(excess / 2);

  for (let i = 0; i < excess; i++) {
    const idx = resultIndexes[i];
    if (idx === undefined) continue;
    const m = messages[idx];
    if (!m) continue;

    const shouldPrune = i >= excess - pruneCount;

    messages[idx] = {
      role: m.role,
      content: m.content.map((p) => {
        if (p.kind !== 'toolResult') return p;
        if (!shouldPrune) {
          return {
            kind: 'toolResult' as const,
            callId: p.callId,
            result: '（较早的工具结果已省略以控制上下文 · 原文见审计）',
            isError: p.isError ?? false,
          };
        }
        // 剪枝：保住头尾
        const flat = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? null);
        return {
          kind: 'toolResult' as const,
          callId: p.callId,
          result: shrinkResult(flat, 600),
          isError: p.isError ?? false,
        };
      }),
    };
  }
}

/**
 * 把一段工具结果缩成「头 + 中略 + 尾」。
 *
 * ⚠️ 与 `core/chat/compaction.ts` 的 `pruneToolOutput` 同构，
 *    但这里是**消息内**的体积控制，阈值更小（默认 600 字）。
 *    没有复用那个函数是因为它面向 `ChatMessage`，这里是 `ModelMessage` 的内容块，
 *    强行统一会把两处都拧成不自然的样子。
 */
function shrinkResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(100, Math.floor((maxChars - 40) / 2));
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n（中间略去 ${text.length - head.length - tail.length} 字 · 原文见审计）\n${tail}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（结果过长已截断，共 ${text.length} 字符）`;
}

