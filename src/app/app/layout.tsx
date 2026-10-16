/**
 * `/app` 的统一外壳（**所有页面共享这一个**）
 *
 * ★★ 这一层是被用户指出问题后加的：
 *
 *   用户：「你没有把各个界面整合到同一个窗口里」
 *
 *   ⚠️ 查证结果（当时的实情）：
 *     · `/app` 自己不用 Shell，而是在 `Conversation` 里渲染
 *     · 其余三页各自 `<Shell>` 包一层
 *     → **每页各有一套外壳**：切换页面时侧栏重建、
 *       收起状态与深浅色偏好不共享、右栏只在对华页存在。
 *       视觉上像"几个独立的小工具"，而不是一个应用。
 *
 *   ★ 现在改为**布局级包一次**（Next 的 `layout.tsx`）：
 *     侧栏与顶栏跨路由保持挂载，状态天然共享。
 *
 * ★ 右栏（仆人窗口）怎么进布局：
 *   它在语义上属于**对话**（仆人只在对话时出现），
 *   但视觉上属于**外壳**（它是第二栏）。
 *   所以用 context：对话页把右栏内容发布出去，外壳渲染它。
 *   ⚠️ 不用 portal —— 那要额外的 DOM 节点与手动样式同步。
 */

import { AppShell } from './shell.js';

export default function AppLayout({ children }: { readonly children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
