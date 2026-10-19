'use client';

/**
 * 图标 —— 手写的一小组线性图标
 *
 * ★ 为什么不用图标库：
 *   只有二十多个，手写可以保证**线宽、端点、圆角完全一致**；
 *   引一个库反而会带来一整套视觉语言与额外体积。
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'chat'
  | 'memory'
  | 'audit'
  | 'growth'
  | 'settings'
  | 'plus'
  | 'search'
  | 'close'
  | 'chevronDown'
  | 'chevronRight'
  | 'arrowUp'
  | 'arrowLeft'
  | 'paperclip'
  | 'stop'
  | 'check'
  | 'checkCircle'
  | 'alert'
  | 'info'
  | 'clock'
  | 'trash'
  | 'download'
  | 'upload'
  | 'refresh'
  | 'sparkle'
  | 'history'
  | 'copy'
  | 'eye'
  | 'eyeOff'
  | 'command'
  | 'menu'
  | 'filter'
  | 'database'
  | 'quote'
  | 'shield'
  | 'user'
  | 'lock'
  | 'external'
  | 'pause'
  | 'play'
  | 'file'
  | 'calendar'
  | 'xCircle'
  | 'more';

const ICONS: Record<IconName, ReactNode> = {
  chat: (
    <>
      <path d="M4 6.8A2.8 2.8 0 0 1 6.8 4h10.4A2.8 2.8 0 0 1 20 6.8v6.4a2.8 2.8 0 0 1-2.8 2.8H9.4L4 20v-4.6a2.8 2.8 0 0 1 0-1.2Z" />
      <path d="M8.5 9.5h7M8.5 12.8h4.5" />
    </>
  ),
  memory: (
    <>
      <path d="m12 3.5 8 4.2-8 4.3-8-4.3 8-4.2Z" />
      <path d="m4 12 8 4.2 8-4.2" />
      <path d="m4 16.2 8 4.3 8-4.3" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3.2 19 6v5.6c0 4.4-2.9 7.5-7 9.2-4.1-1.7-7-4.8-7-9.2V6l7-2.8Z" />
      <path d="m9 12 2.1 2.1L15.2 10" />
    </>
  ),
  growth: (
    <>
      <path d="M4 4v16h16" />
      <path d="m7.5 15.5 3.2-4.3 3 2.1 4.6-6.1" />
      <circle cx="18.3" cy="7.2" r="1.2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h4.2M12.8 7H20" />
      <circle cx="10.5" cy="7" r="2.2" />
      <path d="M4 17h7.2M15.8 17H20" />
      <circle cx="13.5" cy="17" r="2.2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.4 15.4 4.1 4.1" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  paperclip: (
    <path d="M20 11.3 12.4 19a5 5 0 0 1-7.1-7.1l7.6-7.6a3.4 3.4 0 0 1 4.8 4.8l-7.5 7.6a1.8 1.8 0 0 1-2.6-2.6l6.9-6.9" />
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.6" />,
  check: <path d="m5 12.5 4.2 4.2L19 6.8" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.2 2.4 2.4 4.8-5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5 21 19.5H3L12 4.5Z" />
      <path d="M12 10v4.2M12 17.2v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2M12 7.8v.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.6V12l3 1.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5.4c0-.8.6-1.4 1.4-1.4h2.2c.8 0 1.4.6 1.4 1.4V7" />
      <path d="M6.5 7l.8 12c0 .9.7 1.5 1.6 1.5h6.2c.9 0 1.6-.6 1.6-1.5l.8-12" />
      <path d="M10.2 11v5.6M13.8 11v5.6" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 16.5v1.8c0 .9.7 1.7 1.7 1.7h11.6c1 0 1.7-.8 1.7-1.7v-1.8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4.5M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 16.5v1.8c0 .9.7 1.7 1.7 1.7h11.6c1 0 1.7-.8 1.7-1.7v-1.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.8 4.5v5h-5" />
    </>
  ),
  sparkle: (
    <>
      <path d="m12 3.5 1.5 4.7 4.7 1.5-4.7 1.5L12 16l-1.5-4.8L5.8 9.7l4.7-1.5L12 3.5Z" />
      <path d="m18.6 15.4.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" />
    </>
  ),
  history: (
    <>
      <path d="M4.4 11.2A7.7 7.7 0 1 1 6.7 17" />
      <path d="M4.2 5.5v5.5h5.3" />
      <path d="M12 8.3V12l2.6 1.6" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5v-2c0-1.1-.9-2-2-2h-7c-1.1 0-2 .9-2 2v7c0 1.1.9 2 2 2h2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.7" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10 10 0 0 1 12 6c5.8 0 9.2 6 9.2 6a17 17 0 0 1-3 3.7" />
      <path d="M6.6 7.2A17.7 17.7 0 0 0 2.8 12S6.2 18 12 18c1.4 0 2.6-.3 3.7-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  command: (
    <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9Zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15Zm0 0H9m0 0v2.5A2.5 2.5 0 1 1 6.5 15H9Z" />
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  filter: <path d="M4 5.5h16l-6.2 7.2v5.1l-3.6 1.8v-6.9L4 5.5Z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </>
  ),
  quote: (
    <>
      <path d="M9.5 6.5C6.9 7.6 5.5 9.7 5.5 12.7h3.4v4.8H4.5v-4.9c0-4.2 1.9-7 5-8.4V6.5Z" />
      <path d="M19.5 6.5c-2.6 1.1-4 3.2-4 6.2h3.4v4.8h-4.4v-4.9c0-4.2 1.9-7 5-8.4V6.5Z" />
    </>
  ),
  shield: (
    <path d="M12 3.2 19 6v5.6c0 4.4-2.9 7.5-7 9.2-4.1-1.7-7-4.8-7-9.2V6l7-2.8Z" />
  ),
  user: (
    <>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.8 20.2c.6-3.5 3.5-5.8 7.2-5.8s6.6 2.3 7.2 5.8" />
    </>
  ),
  lock: (
    <>
      <rect x="5.2" y="10.2" width="13.6" height="9.8" rx="2.2" />
      <path d="M8.5 10.2V7.8a3.5 3.5 0 0 1 7 0v2.4" />
      <path d="M12 14.2v2.2" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="m19.5 4.5-7.8 7.8" />
      <path d="M18.5 13.5v5c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8V7.6c0-1 .8-1.8 1.8-1.8h5" />
    </>
  ),
  pause: <path d="M9 6.5v11M15 6.5v11" />,
  play: <path d="M8 5.8v12.4L19 12 8 5.8Z" />,
  file: (
    <>
      <path d="M6 3.8h7.2L19 9.6v10.6H6V3.8Z" />
      <path d="M13 3.8v6h6" />
      <path d="M9 13h6M9 16.2h4.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}

export function Icon({ name, size = 18, strokeWidth = 1.6, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
