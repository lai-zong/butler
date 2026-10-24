import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './styles/base.css';
import './styles/boot.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/memory.css';
import './styles/audit.css';
import './styles/growth.css';
import './styles/settings.css';
import './styles/console.css';

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
  colorScheme: 'light',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="zh-CN">
      <body>
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
