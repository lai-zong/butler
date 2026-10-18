/**
 * 侧边导航
 *
 * ★★ v8 修正：**按方案 §13.8 重写为 3 个一级项**。
 *
 * ⚠️ 旧版是 5 组 16 项，而其中 **14 项指向不存在的路由**（实测对照：
 *    只有 `/` 与 `/overview` 有效，另外 14 个全是死链，点了 404）。
 *    那份结构写的是"计划中的 9 页界面"，而方案 §13.8 早已明确废止它：
 *
 *      一级导航（3 项）
 *        💬 对话   ← 只有对话
 *        📜 审计   ← 需要时查
 *        ⚙ 控制台 ← 设置一次长期有效的东西（含记忆库 / 权限 / 外观 / 导出）
 *
 *    ★ 判据（方案原文）：**"设置一次长期有效"→ 控制台；"每轮都要变"→ 对话窗口**。
 *
 * ⚠️ 本文件只放**真实存在**的路由。
 *    新增导航项前先确认 `src/app` 下真的有对应目录与 page 文件 ——
 *    否则用户点到一个 404，比没有这个入口更糟。
 *
 *    ⚠️ 角标只标**需要用户动作**的数字（待审核），
 *    不标"总条数"之类 —— 否则角标会一直亮着，
 *    用户很快就不看了，等于没有。
 */

import Link from 'next/link';

import { NavItem } from './nav-item';

export interface NavCounts {
  readonly pendingReview: number;
}

const GROUPS: readonly {
  readonly label: string;
  readonly items: readonly { readonly href: string; readonly label: string; readonly badge?: 'review' }[];
}[] = [
  {
    label: '对话',
    items: [{ href: '/app', label: '与管家对话' }],
  },
  {
    label: '审计',
    items: [{ href: '/app/audit', label: '操作与记忆审计' }],
  },
  {
    label: '控制台',
    items: [
      { href: '/app/memory', label: '记忆库', badge: 'review' },
      { href: '/overview', label: '它在哪些方面了解你' },
      { href: '/app/settings', label: '设置' },
    ],
  },
];

export function Sidebar({ counts }: { readonly counts: NavCounts }) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <Link href="/">
          <div className="brand-name">管家式 AI</div>
          <div className="brand-sub">记忆治理与自进化</div>
        </Link>
      </div>

      {GROUPS.map((g) => (
        <div className="nav-group" key={g.label}>
          <div className="nav-label">{g.label}</div>
          {g.items.map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={item.label}
              {...(item.badge === 'review' && counts.pendingReview > 0
                ? { badge: counts.pendingReview }
                : {})}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
