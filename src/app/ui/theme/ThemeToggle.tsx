'use client';

/**
 * 品牌行右侧的主题开关
 *
 * ★ 只做一个图标按钮：浅色显示月亮，深色显示太阳。
 *   aria-label / title 说明“切到哪一边”；按钮紧挨品牌内容、不占导航位置。
 */

import { Icon } from '../components/Icon';
import type { Theme } from './useTheme';

interface ThemeToggleProps {
  readonly theme: Theme;
  readonly onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps): JSX.Element {
  const dark = theme === 'dark';
  const label = dark ? '切换到浅色模式' : '切换到深色模式';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={label}
      title={label}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={16} />
    </button>
  );
}
