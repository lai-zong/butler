/**
 * 根布局 —— 全站唯一外壳
 *
 * ★ 这一层只做两件事：
 *   ① 装全局样式
 *   ② 把「待审核条数」交给侧栏（用户一眼能看到有没有事要处理）
 *
 * ⚠️ 外壳**只在这里包一次**。页面自己不再包 `<Shell>` ——
 *    否则切换路由时侧栏会重建、收起状态与深浅色会丢。
 */

import type { Metadata, Viewport } from 'next';

import './globals.css';
import { Shell } from './ui/shell.js';
import { getRuntime } from './runtime.js';

export const metadata: Metadata = {
  title: '管家式 AI · 记忆治理',
  description: '可审计的记忆治理与自进化系统 —— 它记得你，且你能看见它记住了什么',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.ReactElement> {
  /**
   * ⚠️ 取不到运行时（例如数据目录不可写）时**不能让整站白屏**：
   *    外壳仍要渲染，页面自己会显示错误。
   */
  let pendingReview = 0;
  try {
    const rt = await getRuntime();
    pendingReview = rt.bootstrapped.memory
      .all()
      .filter((m) => m.lifecycle === 'candidate').length;
  } catch {
    pendingReview = 0;
  }

  return (
    <html lang="zh-CN">
      <body>
        <Shell pendingReview={pendingReview}>{children}</Shell>
      </body>
    </html>
  );
}
