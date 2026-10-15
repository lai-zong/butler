/**
 * 主界面 —— 与管家的对话
 *
 * 设计依据：用户手绘的默认状态图
 *
 * ★ 这里是**纯服务端壳**：它读状态、传数据，对话交互全在
 *   `ConversationView`（客户端组件）里。
 *
 *   分开的理由：会话状态是可持久化、可重放的**领域状态**（core 负责），
 *   而滚动、输入、SSE 连接是**界面状态**（客户端负责）。
 *   混在一起会让"刷新页面后对话还在吗"变成需要解释的问题。
 */

import { getRuntime } from './runtime';
import { ConversationView } from './conversation-view';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const rt = await getRuntime();
  const { chat } = rt.bootstrapped;

  // 取最近一个会话的消息（刷新后对话还在 —— 这正是持久化的意义）
  const session = chat.listSessions()[0] ?? null;
  const messages = session !== null ? chat.messagesOf(session.id) : [];

  return (
    <ConversationView
      sessionId={session?.id ?? null}
      modelConfigured={rt.model !== null}
      restoreSummary={rt.restoreSummary}
      initialMessages={messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        status: m.status,
        createdAt: m.createdAt,
        ...(m.memoryRefs !== undefined ? { memoryRefs: m.memoryRefs } : {}),
        // ★ 工具循环过程随消息一起恢复 —— 刷新后仍看得到「它读了哪个文件」
        ...(m.agentTrace !== undefined ? { agentTrace: m.agentTrace } : {}),
        // ★ 仆人各自的产出 —— 右侧「仆人面板」的数据（刷新后仍在）
        ...(m.servantReports !== undefined ? { servantReports: m.servantReports } : {}),
      }))}
    />
  );
}
