'use client';

/**
 * 启动门 —— 服务端首帧就存在，等真实加载单元完成后才放行。
 *
 * 设计纪律：
 *   · 没有“跳过”；失败只能重试，不能带着半加载界面进入
 *   · 进度由真实单元计算，组件自身不跑计时器
 *   · 就绪后等一帧再淡出，避免工作台还没画完就露出来
 *   · 启动期间背景应用由 ButlerApp 设为 inert
 */

import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icon';

interface BootScreenProps {
  readonly progress: number;
  readonly stage: string;
  readonly ready: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onDone: () => void;
}

export function BootScreen({ progress, stage, ready, error, onRetry, onDone }: BootScreenProps): JSX.Element {
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));

  // 锁定滚动 + 把键盘焦点留在启动层。应用主体由 ButlerApp 设为 inert。
  useEffect(() => {
    const root = rootRef.current;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root?.focus();

    return () => {
      document.body.style.overflow = bodyOverflow;
    };
  }, []);

  // 错误出现时把焦点交给“重试”，不要留在启动层背景。
  useEffect(() => {
    if (error === null) return;
    const button = rootRef.current?.querySelector<HTMLButtonElement>('.boot-retry');
    button?.focus();
  }, [error]);

  // 只有 ready 才启动淡出；等一帧，让背后的工作台完成首次绘制。
  useEffect(() => {
    if (!ready) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let timer = 0;
    raf = window.requestAnimationFrame(() => {
      setLeaving(true);
      timer = window.setTimeout(() => onDoneRef.current(), reduce ? 0 : 430);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [ready]);

  return (
    <div
      id="boot-screen"
      ref={rootRef}
      className={`boot-screen ${leaving ? 'is-leaving' : ''}`}
      tabIndex={-1}
      aria-busy={!leaving}
    >
      <div className="boot-texture" aria-hidden="true" />

      <div className="boot-center">
        <div className="boot-orbit" aria-hidden="true">
          <span className="boot-ring boot-ring--1" />
          <span className="boot-ring boot-ring--2" />
          <span className="boot-mark">
            <Icon name="memory" size={23} strokeWidth={1.7} />
          </span>
        </div>

        <div className="boot-brand">
          <strong>butler</strong>
          <span>一个懂你的管家、助手，也是伙伴</span>
        </div>

        <p className="boot-tagline">正在唤醒你的 butler</p>

        {error === null ? (
          <div className="boot-progress">
            <div className="boot-progress-meta">
              <span className="boot-stage" aria-hidden="true">
                <i className="boot-stage-dot" />
                {stage}
              </span>
              <span className="boot-percent" aria-hidden="true">
                {percent}%
              </span>
            </div>
            <div
              className="boot-track"
              role="progressbar"
              aria-label="启动进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={stage}
            >
              <span className="boot-fill" style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </div>
            <span className="sr-only" role="status">
              {stage}
            </span>
          </div>
        ) : (
          <div className="boot-error" role="alert">
            <strong className="boot-error-title">启动失败</strong>
            <p className="boot-error-text">{error}</p>
            <button type="button" className="boot-retry" onClick={onRetry}>
              重试
            </button>
            <p className="boot-error-hint">终端窗口里通常有更完整的错误信息。</p>
          </div>
        )}
      </div>
    </div>
  );
}
