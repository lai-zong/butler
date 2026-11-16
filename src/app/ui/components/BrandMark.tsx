'use client';

/**
 * 品牌图标。
 *
 * ★ 只负责图标本身：旁边的 butler 文字、主题色和页面背景都不属于这里。
 * ★ 图片加载失败时回退到旧的 memory 线条图标，避免启动页/登录页出现空洞。
 */

import { useState } from 'react';

import { Icon } from './Icon';

interface BrandMarkProps {
  readonly className: string;
  /** compact = 紧裁切的图标；contrast = 高对比小尺寸版本。 */
  readonly variant?: 'compact' | 'contrast';
  readonly size?: number;
}

const SOURCES: Record<NonNullable<BrandMarkProps['variant']>, string> = {
  compact: '/brand/brand-compact-contrast-128.png',
  contrast: '/brand/brand-contrast-48.png',
};

export function BrandMark({
  className,
  variant = 'compact',
  size = 18,
}: BrandMarkProps): JSX.Element {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={className} aria-hidden="true">
        <Icon name="memory" size={size} strokeWidth={1.7} />
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      <img
        src={SOURCES[variant]}
        alt=""
        draggable={false}
        decoding="async"
        loading="eager"
        fetchPriority="high"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
