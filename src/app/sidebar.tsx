/**
 * 侧边导航
 *
 * 分组依据是**用户的心智模型**，不是代码模块划分：
 *   · 对话   —— 我让它做的事
 *   · 记忆   —— 它记住的我（**产品核心**，所以单列且带待办角标）
 *   · 能力   —— 它能做的事（仆人 / 工具 / MCP / 定时）
 *   · 记录   —— 发生过什么（任务 / 产出物 / 检查点）
 *
 * ⚠️ 角标只标**需要用户动作**的数字（待审核），
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
    items: [{ href: '/', label: '开始对话' }],
  },
  {
    label: '记忆',
    items: [
      { href: '/memory', label: '记忆库', badge: 'review' },
      { href: '/principles', label: '原则与效果' },
      { href: '/evolution', label: '演化状态' },
      { href: '/growth', label: '成长对比' },
      { href: '/profile', label: '行为画像' },
    ],
  },
  {
    label: '能力',
    items: [
      { href: '/servants', label: '仆人' },
      { href: '/operations', label: '记忆化执行' },
      { href: '/tools', label: '工具与权限' },
      { href: '/mcp', label: 'MCP 服务' },
      { href: '/schedule', label: '定时任务' },
    ],
  },
  {
    label: '记录',
    items: [
      { href: '/tasks', label: '历史任务' },
      { href: '/artifacts', label: '产出物' },
      { href: '/checkpoints', label: '检查点与回退' },
    ],
  },
  {
    label: '设置',
    items: [{ href: '/settings', label: '偏好与隐私' }],
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
