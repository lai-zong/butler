/**
 * `/` —— 对话（首页）
 *
 * ★ 服务端只做一件事：把**最近的会话**读出来交给客户端组件。
 *   所有交互都在 `ui/chat.tsx` 里（流式、图片、确认）。
 *
 * ⚠️ 跨持久化边界的数据是**不可信输入**：
 *    落盘消息里的 `agentTrace` 可能缺字段（旧数据），
 *    所以形状不对就**整体不显示过程**，而不是显示半截。
 */

import { parseExecutionReports } from '@/core/chat/parse.js';
import type { AgentTraceData } from '@/core/chat/types.js';

import { getRuntime } from './runtime.js';
import { Chat, type Trace } from './ui/chat.js';

export const dynamic = 'force-dynamic';

export default async function ChatPage(): Promise<React.ReactElement> {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;

  const session = chat.listSessions()[0] ?? null;
  const raw = session !== null ? chat.messagesOf(session.id) : [];

  const messages = raw
    .filter((m) => m.text.trim().length > 0)
    .map((m) => {
      const trace = m.agentTrace !== undefined ? toTrace(m.agentTrace) : null;
      return {
        id: m.id,
        role: m.role === 'user' ? ('user' as const) : ('butler' as const),
        text: m.text,
        ...(trace !== null ? { trace } : {}),
      };
    });

  // 只为触发一次解析校验（旧数据形状不对时不让页面 500）
  void raw.map((m) => parseExecutionReports(m.servantReports));

  return (
    <Chat
      sessionId={session?.id ?? null}
      initialMessages={messages}
      modelConfigured={rt.model !== null}
    />
  );
}

/** 把落盘的执行轨迹转成界面要的形状；形状不对就返回 null（不显示过程）。 */
function toTrace(t: AgentTraceData): Trace | null {
  if (!Array.isArray(t.rounds) || t.rounds.length === 0) return null;
  return {
    rounds: t.rounds.map((r) => ({
      round: r.round,
      reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
      tools: Array.isArray(r.toolCalls)
        ? r.toolCalls.map((c: AgentTraceData['rounds'][number]['toolCalls'][number]) => ({
            callId: c.callId,
            name: c.name,
            ok: c.ok,
            denied: c.denied,
            args: c.argsText,
            output: c.output,
            durationMs: c.durationMs,
          }))
        : [],
    })),
    /**
     * ⚠️ 落盘形状里 `finished` 可能是 `null`（进行中被中断），
     *    而界面用的 `Trace.finished` 是"可选"。null 要转成"不存在"。
     */
    ...(t.finished !== null && t.finished !== undefined ? { finished: t.finished } : {}),
  };
}

