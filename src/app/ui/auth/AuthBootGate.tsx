'use client';

/**
 * 登录页/首次设置页的启动门。
 *
 * ★ 为什么复用 BootScreen：
 *   认证检查发生在进入工作台之前，不能等 ButlerApp 的启动动画；
 *   否则用户会先看到一张“正在检查…”的卡片，再看到工作台。
 *   这里把认证检查放进同一条启动进度条里，检查完成后再淡出。
 */

import { BootScreen } from '../components/BootScreen';

interface AuthBootGateProps {
  /** 还在检查登录状态。 */
  readonly checking: boolean;
  /** 检查完成，可以淡出启动门。 */
  readonly ready: boolean;
  readonly onDone: () => void;
}

export function AuthBootGate({ checking, ready, onDone }: AuthBootGateProps): JSX.Element {
  return (
    <BootScreen
      progress={checking ? 0.45 : 0.98}
      stage={checking ? '正在检查本地登录' : '正在进入 butler'}
      ready={ready}
      error={null}
      onRetry={() => window.location.reload()}
      onDone={onDone}
    />
  );
}
