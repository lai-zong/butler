/**
 * 对话端点 —— SSE 流式
 *
 * 设计依据：方案 § 13.3（流式呈现规范）
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
import { runTurn } from '@/core/chat/service.js';
import type { ProgressEvent } from '@/core/runtime/orchestrator.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** 长任务允许跑久一点（有些任务要跑十几个仆人步骤）。 */
export const maxDuration = 300;

interface ChatBody {
  readonly sessionId?: string;
  readonly text?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const rt = await getRuntime();

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const text = (body.text ?? '').trim();
  if (text.length === 0) {
    return Response.json({ error: '消息内容为空' }, { status: 400 });
  }

  if (rt.model === null) {
    return Response.json(
      {
        error:
          '未配置模型。请在 .env.local 里设置 DEEPSEEK_API_KEY 后重启服务。' +
          '（记忆治理相关页面不依赖模型，仍可使用）',
      },
      { status: 503 },
    );
  }

  // 会话：没给就取最近的，还没有就新建
  const session = body.sessionId !== undefined
    ? (rt.bootstrapped.chat.getSession(body.sessionId) ?? rt.bootstrapped.chat.createSession())
    : rt.bootstrapped.chat.latestOrCreate();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // 客户端已断开 —— 标记后停止发送，但**不中断任务**
          closed = true;
        }
      };

      // 立刻告诉客户端会话 id（界面需要它来续接）
      send({ type: 'session', sessionId: session.id });

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

      try {
        const result = await runTurn({
          sessionId: session.id,
          userText: text,
          userId: session.userId,
          model: rt.model!,
          random: rt.random,
          log: rt.bootstrapped.log,
          clock: rt.clock,
          store: rt.bootstrapped.memory,
          chat: rt.bootstrapped.chat,
          onProgress: (e: ProgressEvent) => send({ type: 'progress', event: e }),
        });

        send({ type: 'user', messageId: result.userMessageId });
        send({ type: 'reply', messageId: result.replyMessageId, text: result.replyText });
        send({ type: 'verdict', verdict: result.verdict });

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
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        send({ type: 'done' });
        try {
          controller.close();
        } catch {
          // 已关闭
        }
        // ★ 每轮结束都刷盘 —— 用户刷新页面不该看到"刚才说的话没了"
        await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
      }
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
