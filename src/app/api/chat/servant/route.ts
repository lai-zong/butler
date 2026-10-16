/**
 * 直接与仆人对话 —— SSE 端点
 *
 * ★ 与 `/api/chat`（走管家）的分工，按用户定的规则：
 *
 *   `/api/chat`         ：路由 → 拆解 → 派发 → **管家验收** → 打回或放行
 *   `/api/chat/servant` ：**不派发、不验收** ——
 *                         用户说什么，仆人就直接做什么。
 *                         管家只能在事后于对话流里提醒，
 *                         **不改动仆人的产出**（"不截断仆人进程"）。
 *
 * ⚠️ 「不拦截」讲的是**流程**（不打断、不打回），
 *    不是"安全底线可以让步" —— 硬约束照样注入、权限闸门照样生效。
 *    注入是"让它知道"，不是"拦住它"。
 */

import { NextResponse } from 'next/server';

import { runServantTurn } from '@/core/chat/directServant.js';
import type { ServantId } from '@/core/servants/types.js';
import { getRuntime } from '../../../runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 一次可能跑几十秒（要读文件、调多轮工具）—— 不能被默认超时掐断 */
export const maxDuration = 300;

const VALID: readonly string[] = ['life', 'health', 'study', 'work', 'code'];

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const text = typeof b['text'] === 'string' ? b['text'].trim() : '';
  const servant = typeof b['servant'] === 'string' ? b['servant'] : '';

  if (text.length === 0) {
    return NextResponse.json({ error: '消息不能为空' }, { status: 400 });
  }
  /**
   * ⚠️ 仆人名**必须校验**（不是"信任前端"）——
   *    它会被拼进会话 id（`servant_${servant}`），
   *    不校验就是一个注入点。
   */
  if (!VALID.includes(servant)) {
    return NextResponse.json({ error: `未知仆人：${servant}` }, { status: 400 });
  }

  const rt = await getRuntime();
  if (rt.model === null) {
    return NextResponse.json({ error: '未配置模型' }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端断开后 enqueue 会抛 —— 忽略即可 */
        }
      };

      try {
        const sessionId = `servant_${servant}`;
        send({ type: 'session', sessionId });

        /**
         * 会话不存在就建。
         *
         * ⚠️ 一个仆人**一个固定会话**（`servant_life` 等）、历史累积 ——
         *    这是用户明确选的方案：「每个仆人一个固定窗口，历史累积」。
         *    也顺便从这里拿到 `userId`（归属在会话上）。
         */
        const chatSession =
          rt.bootstrapped.chat.getSession(sessionId) ??
          rt.bootstrapped.chat.createSession(sessionId);

        const result = await runServantTurn({
          servant: servant as ServantId,
          userText: text,
          /**
           * ⚠️ userId 从**会话**拿，不从运行时拿 ——
           *    与管家路径一致；会话才真正持有归属。
           */
          userId: chatSession.userId,
          // 上方已判空；! 是为了穿过 TS 的收窄（此处确实非空）
          model: rt.model!,
          streamModel: rt.streamModel,
          log: rt.bootstrapped.log,
          clock: rt.clock,
          random: rt.random,
          store: rt.bootstrapped.memory,
          chat: rt.bootstrapped.chat,
          tools: rt.tools,
          onAgentProgress: (e) => {
            // 与管家路径同一套事件形状 —— 界面复用同一个组件渲染过程
            switch (e.kind) {
              case 'roundStarted':
                send({ type: 'agent', kind: 'round', round: e.round, maxRounds: e.maxRounds });
                break;
              case 'reasoning':
                send({
                  type: 'agent',
                  kind: 'reasoning',
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
              case 'finished':
                send({
                  type: 'agent',
                  kind: 'finished',
                  rounds: e.rounds,
                  hitRoundLimit: e.hitRoundLimit,
                  reason: e.reason,
                });
                break;
            }
          },
        });

        send({
          type: 'reply',
          messageId: result.replyMessageId,
          text: result.replyText,
          reports: result.servantReports,
        });
        send({ type: 'done' });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}