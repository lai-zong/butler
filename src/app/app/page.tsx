/**
 * `/app` —— 新版对话界面
 *
 * ★ 与旧版 `/` 的关系：**完全独立**。
 *   旧版仍在跑，两套可以同时打开对比，做完再决定换不换。
 *
 * ⚠️ 服务端只做一件事：**把最近的会话读出来**。
 *    所有交互在客户端（`conversation.tsx`）。
 */

import { getRuntime } from '../runtime.js';
import type { AgentTraceData } from '@/core/chat/types.js';

import { parseServantReports } from '@/core/chat/parse.js';
import { Conversation } from '../app/conversation.js';

export const dynamic = 'force-dynamic';

export default async function AppPage() {
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;

  const session = chat.listSessions()[0] ?? null;
  const raw = session !== null ? chat.messagesOf(session.id) : [];

  /**
   * ★ 右栏「仆人窗口」的初值 —— **从最近一轮带仆人产出的消息里取**。
   *
   * ⚠️ 走解析器（parseServantReports），不用 s 断言。
   *    事故记录：加过一个必填字段后直接断言，
   *    旧落盘数据里没有该字段 → 页面 500。
   *    **跨持久化边界的数据是不可信输入。**
   */
  const lastWithReports = [...raw]
    .reverse()
    .map((m) => parseServantReports(m.servantReports))
    .find((r) => r !== undefined);

  const messages = raw.map((m) => {
    /**
     * ⚠️ 走解析器，不用 `as` 断言。
     *
     *   事故记录：我加过一个必填字段后直接 `as` 断言，
     *   旧落盘数据里没有该字段 → 首页 500。
     *   **跨持久化边界的数据是不可信输入。**
     */
    const trace = m.agentTrace;
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      ...(trace !== undefined && isTrace(trace) ? { agentTrace: trace } : {}),
    };
  });

  return (
    <Conversation
      sessionId={session?.id ?? null}
      initialMessages={messages}
      modelConfigured={rt.model !== null}
      initialReports={lastWithReports ?? []}
    />
  );
}

/**
 * 工具过程的形状检查。
 *
 * ⚠️ 旧数据里 `agentTrace` 可能缺字段 —— 形状不对就**整体不显示过程**，
 *    而不是显示半截（半截会让用户以为"它只做了一半"）。
 */
function isTrace(v: AgentTraceData): boolean {
  return Array.isArray(v.rounds) && v.rounds.length > 0;
}
