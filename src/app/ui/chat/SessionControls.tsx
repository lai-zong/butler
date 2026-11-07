'use client';

/**
 * 输入框右下角的「模型 · 思考强度」胶囊
 *
 * ★ 为什么放在 composer 里：
 *   它改的是**这段对话**下一轮怎么答，和发送动作在同一处；
 *   放进对话设置抽屉会把“当前轮的口味”藏远。
 *
 * ★ 面板向上打开，并做视口夹取：
 *   对话输入框在屏幕底部，向上是常态；靠近顶部/窄屏时自动改成向下，
 *   左右也不会超出视口。面板通过 portal 渲染，避免被 composer 的圆角裁切。
 *
 * ★ 只负责渲染和交互；PATCH 与错误处理在 ChatView，
 *   这样切换会话时的竞态只在一个地方收口。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import type { ReasoningLevel } from '../lib/types.js';
import type { ModelChoice, PickableProfile } from './ModelPicker';
import {
  REASONING_OPTIONS,
  shortModelName,
  type SessionModelRef,
} from './sessionSettings.js';

interface SessionControlsProps {
  readonly profiles: readonly PickableProfile[];
  readonly model: ModelChoice | null;
  readonly reasoning: ReasoningLevel;
  readonly streaming: boolean;
  readonly saving: boolean;
  readonly catalogLoading: boolean;
  readonly catalogError: string | null;
  readonly settingsError: string | null;
  readonly onRefreshCatalog: () => void;
  readonly onSelectModel: (choice: ModelChoice) => void;
  readonly onSelectReasoning: (level: ReasoningLevel) => void;
  readonly onOpenSettings?: () => void;
  /** 本轮开始时的快照档位（来自 SSE `settings` 事件）。 */
  readonly turnReasoning: ReasoningLevel | null;
}

interface ModelOption {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly available: boolean;
}

interface PopoverPosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly placement: 'up' | 'down';
}

const POPOVER_MAX_HEIGHT = 520;
const VIEWPORT_MARGIN = 10;

function optionsOf(profiles: readonly PickableProfile[]): readonly ModelOption[] {
  const out: ModelOption[] = [];
  for (const profile of profiles) {
    for (const item of profile.models) {
      if (item.kind !== 'chat') continue;
      out.push({
        profileId: profile.id,
        profileName: profile.name,
        modelId: item.id,
        available: !(profile.requiresKey ?? true) || profile.hasKey,
      });
    }
  }
  return out;
}

function sameChoice(model: ModelChoice | null, option: SessionModelRef): boolean {
  return model !== null && model.profileId === option.profileId && model.modelId === option.modelId;
}

export function SessionControls({
  profiles,
  model,
  reasoning,
  streaming,
  saving,
  catalogLoading,
  catalogError,
  settingsError,
  onRefreshCatalog,
  onSelectModel,
  onSelectReasoning,
  onOpenSettings,
  turnReasoning,
}: SessionControlsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(() => optionsOf(profiles), [profiles]);
  const selected = useMemo(
    () => options.find((option) => sameChoice(model, option)) ?? null,
    [model, options],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return options;
    return options.filter(
      (option) =>
        option.modelId.toLowerCase().includes(q) ||
        option.profileName.toLowerCase().includes(q),
    );
  }, [options, query]);

  const modelLabel = catalogLoading && model === null
    ? '读取模型…'
    : catalogError !== null && model === null
      ? '模型未加载'
      : shortModelName(model?.modelId);

  const differsFromTurn =
    streaming && turnReasoning !== null && turnReasoning !== reasoning;

  // ── 定位：向上优先，空间不足翻到下方，水平/垂直都夹在视口内 ──
  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const panel = panelRef.current;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - VIEWPORT_MARGIN * 2);
    const maxHeight = Math.min(POPOVER_MAX_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
    // panel 还没挂载时按最大高度估：宁可初始高一点，也不能让它伸出屏幕。
    const measured = panel?.offsetHeight ?? maxHeight;
    const height = Math.min(measured, maxHeight);
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const up = spaceAbove >= height || spaceAbove >= spaceBelow;
    const left = Math.min(
      Math.max(rect.right - width, VIEWPORT_MARGIN),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const wantedTop = up ? rect.top - height - 8 : rect.bottom + 8;
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(wantedTop, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    setPosition((previous) =>
      previous !== null &&
      Math.abs(previous.top - top) < 0.5 &&
      Math.abs(previous.left - left) < 0.5 &&
      Math.abs(previous.width - width) < 0.5 &&
      previous.placement === (up ? 'up' : 'down')
        ? previous
        : { top, left, width, placement: up ? 'up' : 'down' },
    );
  }, []);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  // 面板内容加载（模型列表变长）会改变高度：观察到尺寸变化就重新贴住。
  const panelMounted = position !== null;
  useEffect(() => {
    if (!open || !panelMounted || typeof ResizeObserver === 'undefined') return;
    const panel = panelRef.current;
    if (panel === null) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, panelMounted, place]);

  // ── 点击外部 / Esc 关闭 ──
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const panel = open && position !== null
    ? createPortal(
        <div
          ref={panelRef}
          className={`session-controls-pop is-${position.placement}`}
          role="dialog"
          aria-label="对话模型与思考强度"
          style={{ top: position.top, left: position.left, width: position.width }}
        >
          <div className="session-controls-head">
            <strong>模型与思考</strong>
            <span>仅当前对话</span>
          </div>

          <div className="session-controls-section">
            <div className="session-controls-label">
              <span>模型</span>
              {saving && <span className="session-controls-saving">保存中…</span>}
            </div>

            {catalogError !== null && options.length > 0 && (
              <p className="session-controls-warnline">
                <span>模型列表刷新失败，显示上次结果。</span>
                <button type="button" className="text-btn" onClick={onRefreshCatalog}>
                  重试
                </button>
              </p>
            )}

            {catalogLoading && options.length === 0 ? (
              <p className="session-controls-empty">正在读取模型列表…</p>
            ) : catalogError !== null && options.length === 0 ? (
              <div className="session-controls-error" role="alert">
                <span>模型列表加载失败：{catalogError}</span>
                <button type="button" className="text-btn" onClick={onRefreshCatalog}>
                  重试
                </button>
              </div>
            ) : options.length === 0 ? (
              <div className="session-controls-empty">
                <span>还没有可用的对话模型。</span>
                {onOpenSettings !== undefined && (
                  <button type="button" className="text-btn" onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}>
                    去设置 → 模型接入
                  </button>
                )}
              </div>
            ) : (
              <>
                <label className="session-controls-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={query}
                    placeholder="搜索模型或配置…"
                    aria-label="搜索模型"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="session-controls-models" role="listbox" aria-label="对话模型">
                  {filtered.length === 0 ? (
                    <p className="session-controls-empty">没有匹配的模型。</p>
                  ) : (
                    filtered.map((option) => {
                      const active = sameChoice(model, option);
                      return (
                        <button
                          key={`${option.profileId}::${option.modelId}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`session-controls-model${active ? ' is-active' : ''}`}
                          disabled={!option.available || saving}
                          onClick={() => {
                            onSelectModel({ profileId: option.profileId, modelId: option.modelId });
                          }}
                        >
                          <span className="session-controls-model-text">
                            <small>
                              {option.profileName}
                              {!option.available ? ' · 缺少 Key' : ''}
                            </small>
                            <strong>{option.modelId}</strong>
                          </span>
                          {active && <Icon name="check" size={14} />}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          <div className="session-controls-section">
            <div className="session-controls-label">
              <span>思考强度</span>
              <span className="session-controls-count">off / low / high / max</span>
            </div>
            <div className="session-controls-reasoning" role="radiogroup" aria-label="思考强度">
              {REASONING_OPTIONS.map((option) => {
                const active = option.value === reasoning;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`session-controls-level${active ? ' is-active' : ''}`}
                    disabled={saving}
                    title={option.hint}
                    onClick={() => onSelectReasoning(option.value)}
                  >
                    <span className="session-controls-level-main">
                      <code>{option.label}</code>
                      <small>{option.hint}</small>
                    </span>
                    {active && <Icon name="check" size={14} />}
                  </button>
                );
              })}
            </div>
          </div>

          {settingsError !== null && (
            <p className="session-controls-error-text" role="alert">
              {settingsError}
            </p>
          )}

          <p className="session-controls-foot">
            {differsFromTurn
              ? `本轮仍按 ${turnReasoning} 执行（开始时的快照）；改动下一轮生效。`
              : streaming
                ? turnReasoning === null
                  ? '当前轮的设置快照已固定；执行中修改只影响下一轮。'
                  : `本轮快照：${turnReasoning}。执行中修改会在下一轮生效。`
                : '只影响这段对话；新对话默认 high。'}
          </p>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="session-controls">
      <button
        ref={triggerRef}
        type="button"
        className={`session-controls-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`对话模型与思考强度：${selected?.modelId ?? model?.modelId ?? modelLabel}，${reasoning}`}
        title={`模型：${selected?.modelId ?? model?.modelId ?? '未选择'} · 思考强度：${reasoning}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`session-controls-model-name${selected === null ? ' is-muted' : ''}`}>
          {selected?.modelId ?? modelLabel}
        </span>
        <span className="session-controls-sep" aria-hidden="true">·</span>
        <span className="session-controls-reasoning-name">{reasoning}</span>
        {catalogError !== null && (
          <span
            className="session-controls-alert"
            role="img"
            aria-label="模型列表加载失败"
            title={catalogError}
          >
            !
          </span>
        )}
        <Icon name="chevronDown" size={11} />
      </button>
      {panel}
    </div>
  );
}
