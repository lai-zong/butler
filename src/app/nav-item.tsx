'use client';

/**
 * 单个导航项 —— 需要客户端组件才能读当前路径高亮。
 *
 * ⚠️ 只把**这一小块**做成客户端组件，侧边栏其余部分（品牌、分组、
 *    计数）留在服务端渲染。这样高亮变化不会让整棵树重新渲染。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavItem({
  href,
  label,
  badge,
}: {
  readonly href: string;
  readonly label: string;
  readonly badge?: number;
}) {
  const pathname = usePathname();
  // 根路径要精确匹配，否则所有页面都会高亮"开始对话"
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <Link href={href} className={active ? 'nav-item active' : 'nav-item'}>
      <span>{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-badge">{badge}</span>}
    </Link>
  );
}
