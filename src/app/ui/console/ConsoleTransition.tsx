'use client';

/**
 * 进入控制台的转场 —— 从暖纸工作台进入深色治理终端
 *
 * ★ 进度由 ButlerApp 计算（真实阶段）后传入，组件本身不跑计时器：
 *   · 首次打开：完整内容层 + 真实进度（0.18 → 0.8 → 1）；
 *   · 二次打开：只保留“从中线展开”的画面（线 + 深色面板），
 *     不渲染 logo / 标题 / 读数 / 进度条，也不再假装有加载进度。
 *
 * ★ 退场由 `leaving` 控制（淡出），父组件在动画结束后卸载。
 */

import { Icon } from '../components/Icon';

interface ConsoleTransitionProps {
  readonly mode: 'first' | 'quick';
  readonly progress: number;
  readonly stage: string;
  readonly leaving: boolean;
}

export function ConsoleTransition({
  mode,
  progress,
  stage,
  leaving,
}: ConsoleTransitionProps): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const quick = mode === 'quick';

  return (
    <div
      className={`ct-overlay${quick ? ' is-quick' : ''}${leaving ? ' is-leaving' : ''}`}
      role={quick ? undefined : 'status'}
      aria-live={quick ? undefined : 'polite'}
      aria-label={quick ? undefined : '正在进入控制台'}
      aria-hidden={quick || undefined}
    >
      <div className="ct-dark" aria-hidden="true" />
      <div className="ct-line" aria-hidden="true" />
      {!quick && <div className="ct-scan" aria-hidden="true" />}

      {!quick && (
        <div className="ct-content">
          <header className="ct-top">
            <span className="ct-brand" aria-hidden="true">
              <Icon name="console" size={14} />
            </span>
          </header>

          <div className="ct-center">
            <div className="ct-glyph" aria-hidden="true">
              <Icon name="console" size={22} />
              <span />
            </div>
            <h2>正在进入控制台</h2>

            <div className="ct-readouts mono">
              <span>
                本地运行时 <b>已连接</b>
              </span>
              <span>
                记忆库 <b>{progress >= 0.8 ? '已载入' : '读取中'}</b>
              </span>
              <span>
                事件审计 <b>{progress >= 0.8 ? '已就绪' : '同步中'}</b>
              </span>
              <span>
                演化引擎 <b>{progress >= 1 ? '已就绪' : '准备中'}</b>
              </span>
            </div>

            <div className="ct-progress-meta mono">
              <span>{stage}</span>
              <span>{pct}%</span>
            </div>

            <div
              className="ct-progress"
              role="progressbar"
              aria-label="进入控制台进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={stage}
            >
              <span style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
