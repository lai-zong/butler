/**
 * 根路径 —— 一律转到 `/app`
 *
 * ★★ v8（批次A-1）：这里原来渲染 `ConversationView`（1,967 行的旧界面），
 *    而 `/app` 已经是当前唯一在维护的对话界面。
 *
 * ⚠️ 为什么要重定向而不是"两个都留着"：
 *    两份对话界面并存时，**改一处另一处就漂移**，而且读者分不清哪个是"现在"。
 *    旧界面的 105 处「仆人」引用就是漂移的结果 —— 它写在多仆人架构的时代，
 *    代码早已改成单执行者，界面描述还停在过去。
 *
 * ★ 重定向不丢功能：`/app` 已支持 `initialMessages` 恢复历史会话
 *   （`app/app/page.tsx` 自己从 runtime 取最近会话的消息）。
 *
 * ⚠️ 保留这个文件而不是直接删：
 *    根路径需要一个页面，否则访问 `/` 会 404。
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function HomePage(): never {
  redirect('/app');
}
