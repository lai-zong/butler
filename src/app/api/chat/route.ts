/**
 * 对话端点 —— SSE 流式
 *
 * 设计依据：字符级流式与增量输出
 *
 * ★ 为什么用 SSE 而不是普通 POST：
 *   方案要求「**过程可见**」——用户要看到「判断该由谁处理 → 拆解任务 →
 *   派发给生活仆人 → 校验产出」这一串实时推进。
 *   普通 POST 只能在结束时一次性返回，那就成了转圈等待。
 *
 * ⚠️ 长任务不能用 Serverless：一次对话可能跑十几秒，
 *    而 Serverless 有执行时长上限。这也是方案 § 14 要求长驻进程的原因之一。
 *
 * 事件协议（每条 `data:` 一个 JSON）：
 *   { type: 'progress', ... }   —— 编排进度
 *   { type: 'user', ... }       —— 用户消息已记录（带 id）
 *   { type: 'reply', ... }      —— 管家回复（完整文本）
 *   { type: 'verdict', ... }    —— 审查结论
 *   { type: 'error', message }  —— 出错
 *   { type: 'done' }            —— 结束
 */

import type { NextRequest } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { supervisionConfig } from '@/core/config/env.js';
import { runTurn } from '@/core/chat/service.js';
import { denyAllPending, SseApprovals } from '@/core/tools/approval.js';
import { normalizeRequestImages } from '@/core/multimodal/requestImages.js';
import type { ProgressEvent } from '@/core/runtime/orchestrator.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** 长任务允许跑久一点（有些任务要跑十几个仆人步骤）。 */
export const maxDuration = 300;

interface ChatBody {
  readonly sessionId?: string;
  readonly text?: string;
  /**
   * 调用方是否**能处理确认请求**（`{ type:'approval' }` 事件 + POST 答复）。
   *
   * ⚠️ 默认 false，必须由调用方**显式声明**。
   *    原因（真实回归）：C6 通道建好后，如果无条件启用，
   *    而调用方还没实现确认流程，那么任何"需要确认"的工具调用都会
   *    **挂满 120 秒超时**才被拒绝 —— 比改造前（立刻拒绝）体验更差。
   *    所以这里按能力协商：能处理才开，不能处理就退回"立即拒绝"。
   */
  readonly supportsApproval?: boolean;
  /**
   * 本轮图片：`data:image/png;base64,...` 或 http(s) 链接。
   *
   * ⚠️ 只对**这一轮**有效 —— 不落历史、不进事件、不写长期记忆。
   *    调用方重新加载后图片不会回来（消息文本仍在）。
   */
  readonly images?: readonly {
    readonly url?: unknown;
    readonly detail?: unknown;
  }[];
}


// 图片校验已移到 core（路由文件不允许导出其它符号）：见 `core/multimodal/requestImages.ts`

export async function POST(req: NextRequest): Promise<Response> {
  const rt = await getRuntime();

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const text = (body.text ?? '').trim();
  const imageCheck = normalizeRequestImages(body.images);
  if (!imageCheck.ok) {
    return Response.json({ error: imageCheck.error }, { status: 400 });
  }
  const images = imageCheck.images;

  // 只有图片、没有文字也允许（"这张图里是什么"是最常见的问法）
  if (text.length === 0 && images.length === 0) {
    return Response.json({ error: '消息内容为空' }, { status: 400 });
  }

  if (rt.model === null) {
    return Response.json(
      {
        error:
          '未配置模型。请在 .env.local 里设置 DEEPSEEK_API_KEY 后重启服务。' +
          '（记忆治理相关功能不依赖模型，仍可使用）',
      },
      { status: 503 },
    );
  }

  // 会话：没给就取最近的，还没有就新建
  const session = body.sessionId !== undefined
    ? (rt.bootstrapped.chat.getSession(body.sessionId) ?? rt.bootstrapped.chat.createSession())
    : rt.bootstrapped.chat.latestOrCreate();

  const encoder = new TextEncoder();

  /**
   * ★ 用户点“停止”时，浏览器会 abort fetch。
   *   这里把请求信号接到本轮任务：不是只停止发送，而是真的停止后台循环。
   */
  const abort = new AbortController();
  const onRequestAbort = (): void => abort.abort();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener('abort', onRequestAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // 客户端已断开 —— 只标记停止发送；后台取消由 request.signal / cancel() 负责
          closed = true;
        }
      };

      // 立刻告诉客户端会话 id（界面需要它来续接）
      send({ type: 'session', sessionId: session.id });

      /**
       * ★ C6 询问通道：**仅当调用方声明能处理时才启用**。
       *
       * ⚠️ 无条件启用会造成真实回归：调用方还没做确认流程时，
       *    "需要确认"的工具调用会挂满 120 秒才拒绝，
       *    而改造前是**立刻拒绝**。
       *    所以这里是能力协商：能处理才开，否则退回原行为。
       */
      const approvals =
        body.supportsApproval === true
          ? new SseApprovals({
              emit: (req) =>
                send({
                  type: 'approval',
                  id: req.id,
                  toolName: req.toolName,
                  tier: req.tier,
                  summary: req.summary,
                  ...(req.preview !== undefined ? { preview: req.preview } : {}),
                  timeoutMs: req.timeoutMs,
                }),
            })
          : undefined;

      /**
       * ★ 记下这一轮的起始 seq —— 界面据此取「本轮依据」。
       *
       *   ⚠️ 用 seq 区间而不是消息 id 关联：
       *      事件流是线性的，一轮对话对应一段连续 seq，
       *      这是**由事件流结构本身给出的**，不需要额外记账表。
       *      （而记账表本身会成为需要维护、也可能出错的东西 ——
       *        「这条注入属于哪一轮」在没有唯一答案时怎么办？）
       */
      const fromSeq = rt.bootstrapped.log.length + 1;

      // 本轮开始前的会话累计用量（界面用“累计”= 已完成轮次 + 本轮实时）。
      const priorVerdicts = rt.bootstrapped.chat.verdictsOf(session.id);
      const baseInputTokens = priorVerdicts.reduce(
        (n, v) => n + (v.sessionUsage?.inputTokens ?? v.usage.inputTokens),
        0,
      );
      const baseOutputTokens = priorVerdicts.reduce(
        (n, v) => n + (v.sessionUsage?.outputTokens ?? v.usage.outputTokens),
        0,
      );

      // 取消事件需要知道“取消在哪一步”；只记阶段名，不记正文/参数。
      let lastStage = 'starting';

      rt.activeTurns += 1;
      try {
        const result = await runTurn({
          sessionId: session.id,
          userText: text,
    // ★ 本轮图片（只这一次有效，不落历史）
    ...(images.length > 0 ? { images } : {}),
          // ★ 本轮询问通道（C6）：仅调用方声明能处理时才有，否则退回"立即拒绝"
          ...(approvals !== undefined ? { asker: approvals } : {}),
          // ★ 监督员触发：默认 manual（用户按需），可用 SUPERVISOR_MODE=auto 回退
          supervisionMode: supervisionConfig.mode,
          userId: session.userId,
          model: rt.model!,
          random: rt.random,
          log: rt.bootstrapped.log,
          clock: rt.clock,
          store: rt.bootstrapped.memory,
          evolution: rt.evolution,
          semantic: rt.semantic,
          chat: rt.bootstrapped.chat,
          // ★ 装配好的工具框架 —— 不给则仆人不调工具
          tools: rt.tools,
          signal: abort.signal,
          onProgress: (e: ProgressEvent) => {
            lastStage = e.kind === 'stage' ? e.stage : e.kind;
            send({ type: 'progress', event: e });
          },

          /**
           * ★ 流式叙述 —— 与仆人执行**并发**跑。
           *
           *   实测：仆人执行 30—60 秒，而叙述只要 1.6—2.4 秒。
           *   所以叙述会在死时间里先说完，逐字推给界面。
           *
           * ⚠️ 用 `streamModel`（`NARRATION_MODEL`，默认 deepseek-flash），
           *    **不是** `model` —— 两者用途不同：叙述是"轻活"（短、快），
           *    用便宜快的模型就够，不必占用主模型。
           *    ⚠️ 接错模型的后果很隐蔽：**推理流永远是空的，且不报错**。
           */
          ...(rt.streamModel !== null ? { streamModel: rt.streamModel } : {}),
          ...(rt.translator !== null ? { translatorPort: rt.translator } : {}),
          onNarration: (s) =>
            send({
              type: 'narration',
              reasoning: s.reasoning,
              reasoningTranslated: s.reasoningTranslated,
              answer: s.answer,
              firstChunkMs: s.firstChunkMs,
              done: s.done,
            }),

          /**
           * ★★ 工具循环进度 —— 「思考 → 工具 → 再思考」画面的来源。
           *
           *   实测（一次真实工具循环，3 轮 4 次调用）：
           *     ▸ 调用 list_dir → ⚙ 执行 → ✓ 结果 32 字（8ms）
           *     ▸ 调用 read_file → ⚙ 执行 → ✓ 结果 26 字（2ms）
           *     ▸ 调用 submit_report → ✓ 13 字（20ms）
           *
           *   ⚠️ 只推**必要**字段：
           *      工具结果可能几十 KB，而界面只需要看开头
           *      （完整内容用户可展开审计视图看）。
           *      `accumulated` 已经截断在 agentLoop 里。
           */
          onAgentProgress: (e) => {
            switch (e.kind) {
              case 'roundStarted':
                send({ type: 'agent', kind: 'round', round: e.round });
                break;
              case 'reasoning':
                send({
                  type: 'agent',
                  kind: 'reasoning',
                  round: e.round,
                  accumulated: e.accumulated.slice(-4000),
                });
                break;
              case 'text':
                send({
                  type: 'agent',
                  kind: 'text',
                  round: e.round,
                  accumulated: e.accumulated.slice(-4000),
                });
                break;
              case 'toolCall':
                send({
                  type: 'agent',
                  kind: 'toolCall',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                  argsDelta: e.argsDelta,
                  partial: e.partial,
                });
                break;
              case 'toolStarted':
                send({
                  type: 'agent',
                  kind: 'toolStarted',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                });
                break;
              case 'toolResult':
                send({
                  type: 'agent',
                  kind: 'toolResult',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                  ok: e.ok,
                  denied: e.denied,
                  output: e.output,
                  durationMs: e.durationMs,
                });
                break;
              case 'usage':
                send({
                  type: 'usage',
                  round: e.round,
                  inputTokens: e.inputTokens,
                  outputTokens: e.outputTokens,
                  totalInputTokens: e.totalInputTokens,
                  totalOutputTokens: e.totalOutputTokens,
                  sessionInputTokens: baseInputTokens + e.totalInputTokens,
                  sessionOutputTokens: baseOutputTokens + e.totalOutputTokens,
                });
                break;
              case 'finished':
                send({
                  type: 'agent',
                  kind: 'finished',
                  rounds: e.rounds,
                  reason: e.reason,
                });
                break;
            }
          },
        });

        send({ type: 'user', messageId: result.userMessageId });

        /**
         * ★ 本轮「承诺了什么」—— 任务契约与假设。
         *
         *   契约原本只在事件里（`contract.written`），界面上看不到；
         *   而它是监督员逐条核对的**唯一标准**，也是用户判断
         *   “它理解对了没有”的直接依据。所以随结果一并推给界面。
         *
         * ⚠️ 只推展示所需字段，`contract.raw` 是模型原始产出，留在事件里。
         */
        const contract = result.session.contract;
        send({
          type: 'contract',
          contract:
            contract !== undefined
              ? {
                  deliverable: contract.deliverable,
                  criteria: contract.criteria,
                  mustObey: contract.mustObey,
                  domains: contract.domains,
                  confidence: contract.confidence,
                  clarifyingQuestion: contract.clarifyingQuestion ?? null,
                }
              : null,
          assumption: result.session.assumption ?? null,
          injectedConstraints: result.session.injectedConstraints.map((c) => ({
            memoryId: c.memoryId,
            content: c.content,
            source: c.source,
            negotiable: c.negotiable,
          })),
        });

        // 最终用量以 verdict 为准：它包含工具循环之后的监督/反思调用。
        const finalSessionUsage = result.verdict.sessionUsage ?? {
          inputTokens: baseInputTokens + result.verdict.usage.inputTokens,
          outputTokens: baseOutputTokens + result.verdict.usage.outputTokens,
        };
        send({
          type: 'usage',
          round: 0,
          inputTokens: result.verdict.usage.inputTokens,
          outputTokens: result.verdict.usage.outputTokens,
          totalInputTokens: result.verdict.usage.inputTokens,
          totalOutputTokens: result.verdict.usage.outputTokens,
          sessionInputTokens: finalSessionUsage.inputTokens,
          sessionOutputTokens: finalSessionUsage.outputTokens,
        });

        send({ type: 'reply', messageId: result.replyMessageId, text: result.replyText });
        send({ type: 'verdict', verdict: result.verdict });
        /**
         * ★ 本轮反思的结果 —— 「刚学到几条、几条等你确认」。
         *
         *   反思发生在对话之后，用户本来完全看不到。
         *   把 pendingReview 推给界面，治理闭环才在**对话现场**成立：
         *   用户当场就知道“它想记什么”，而不是过几天在记忆页里翻出来。
         */
        send({
          type: 'reflection',
          reflection:
            result.reflection !== undefined
              ? {
                  pendingReview: result.reflection.pendingReview,
                  admittedAutonomously: result.reflection.admittedAutonomously,
                  skippedDuplicates: result.reflection.skippedDuplicates,
                  failed: result.reflection.failed,
                  failureReason: result.reflection.failureReason ?? null,
                }
              : null,
        });
        /**
         * ★ 各仆人各自的产出 —— 右侧「仆人面板」的数据。
         *
         *   与落进消息的那一份是**同一个对象**（在 runTurn 里只转换一次）——
         *   否则会出现「界面上看到的」与「刷新后看到的」不一致。
         */
        send({ type: 'reports', reports: result.executionReports });

        /**
         * ★ 本轮的 seq 区间 —— 界面据此拉「它凭什么这么说」。
         *
         *   只发区间不发内容：内容可能不小（召回 + 注入 + 校验），
         *   而用户在多数轮次里不会展开看。**按需拉取**比一次性推更省。
         */
        send({
          type: 'audit',
          range: { fromSeq, toSeq: rt.bootstrapped.log.length },
        });
      } catch (err) {
        // 用户主动停止不是错误：界面已经标记“已断开接收”，不要再补一条报错。
        if (abort.signal.aborted) {
          /**
           * ★ C8：取消也要可回放。
           *
           * 只记“取消在哪一步 + 已经发生过多少次工具调用/结果”，
           * 不记工具参数、结果正文或模型输出 —— 那会把取消事件变成新的泄露点。
           */
          const recent = rt.bootstrapped.log.range(fromSeq, rt.bootstrapped.log.length);
          rt.bootstrapped.log.append({
            type: 'session.cancelled',
            actor: 'user',
            payload: {
              sessionId: session.id,
              reason: 'user_cancelled',
              phase: lastStage,
              fromSeq,
              toSeq: rt.bootstrapped.log.length,
              toolCalls: recent.filter((e) => e.type === 'tool.call').length,
              toolResults: recent.filter((e) => e.type === 'tool.result').length,
            },
            createdAt: rt.clock.now(),
          });
          // 取消也意味着任务结束：该任务的敏感授权立即失效
          rt.bootstrapped.memory.revokeGrantsForTask(session.id);
        } else {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        rt.activeTurns = Math.max(0, rt.activeTurns - 1);
        req.signal.removeEventListener('abort', onRequestAbort);
        /**
         * ★ 流结束 → 把所有还挂着的确认**全部拒绝**。
         *
         * ⚠️ 不这么做的话，工具循环会一直等到超时（最长 2 分钟），
         *    而实际上客户端已经结束了，没人会来点"允许"。
         */
        denyAllPending();

        send({ type: 'done' });
        try {
          controller.close();
        } catch {
          // 已关闭
        }
        // ★ 每轮结束都刷盘 —— 用户重新加载不该看到"刚才说的话没了"
        await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
      }
    },
    cancel() {
      // 客户端断开连接时，ReadableStream 会走这里；与 request.signal 双保险。
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
