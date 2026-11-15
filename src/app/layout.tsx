import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './styles/base.css';
import './styles/auth.css';
import './styles/boot.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/settings.css';
import './styles/tasks.css';
import './styles/console.css';
import './styles/memory.css';
import './styles/changes.css';
import './styles/usage.css';

export const metadata: Metadata = {
  title: 'butler · 记忆治理',
  description:
    '一个常驻在电脑里的管家式 AI：记得你、替你办事；干前写契约，干完逐条复核，而你拥有完全的可视、可改、可撤销权。',
  applicationName: 'butler',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f5f3ee',
  colorScheme: 'light dark',
};

/**
 * 主题首帧脚本 —— 必须小而阻塞，且只作用于第一界面。
 *
 * ★ 为什么放在 body 开头：App Router 不提供可编程的 <head>，
 *   而放在 body 首个子节点同样会在工作台标记之前同步执行，
 *   不会出现“先画暖纸色、再变黑”的闪烁。
 * ★ 只认 pathname === '/'：登录页、首次设置页没有 .app-shell，
 *   它们的 CSS 仍用 :root 的暖纸令牌，不会被 data-theme 影响。
 * ★ 启动层自己会在深色下重置浅色令牌（见 base.css），
 *   所以“刷新时启动动画保持浅色”与“刷新后直接深色”可以同时成立。
 */
const THEME_BOOT_SCRIPT = `(function(){try{if(window.location.pathname!=='/')return;var t=window.localStorage.getItem('butler.theme');if(t!=='dark')return;var r=document.documentElement;r.setAttribute('data-theme','dark');var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content','#070707');}}catch(e){}})();`;

export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {/* 无 JS 时不要把用户永久留在启动层里；工作台本身是服务端渲染的。 */}
        <noscript>
          <style>
            {'#boot-screen{display:none!important}.app-shell.is-boot-pending{visibility:visible!important}'}
          </style>
        </noscript>
        {children}
      </body>
    </html>
  );
}

