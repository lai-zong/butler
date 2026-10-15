/**
 * 页面外壳 —— 侧边栏 + 主内容区
 *
 * 所有页面共用。放在这里而不是 layout.tsx，是因为**角标数字要实时读状态**，
 * 而 layout 无法方便地做数据获取。
 */

import { getRuntime } from './runtime';
import { Sidebar } from './sidebar';

export async function Shell({
  children,
  title,
  subtitle,
}: {
  readonly children: React.ReactNode;
  readonly title?: string;
  readonly subtitle?: string;
}) {
  const rt = await getRuntime();
  const pendingReview = rt.bootstrapped.memory
    .all()
    .filter((m) => m.lifecycle === 'candidate').length;

  return (
    <div className="shell">
      <Sidebar counts={{ pendingReview }} />
      <main className="main">
        <div className="content">
          {title !== undefined && (
            <>
              <h1>{title}</h1>
              {subtitle !== undefined && <div className="page-sub">{subtitle}</div>}
            </>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
