'use client';

/**
 * 专注空间底部的上拉面板。
 *
 * ★ 只用一条中线、几组发丝分隔，不堆卡片：
 *   背景、音乐、专注计时、主题各自是一段安静的编辑区。
 * ★ 面板宽度由外层 CSS 限制在中间列；它不向左右延伸到侧栏区域。
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import type { Theme } from '../theme/useTheme';
import { formatFileSize, formatTimer } from './focusFormat.js';
import {
  FOCUS_SURFACE_IDS,
  SURFACE_LIMITS,
  type FocusSurfaceId,
} from './focusSurfaces.js';
import { FOCUS_DURATIONS, type FocusTimerValue } from './useFocusTimer.js';
import type { FocusBackdropValue } from './useFocusBackdrop.js';
import type { FocusMusicValue } from './useFocusMusic.js';
import type { FocusSurfacesValue } from './useFocusSurfaces.js';

export type FocusPanelTab = 'background' | 'surface' | 'music' | 'timer' | 'theme';

const TABS: readonly {
  readonly id: FocusPanelTab;
  readonly label: string;
  readonly icon: 'image' | 'layers' | 'music' | 'clock' | 'sun';
}[] = [
  { id: 'background', label: '背景', icon: 'image' },
  { id: 'surface', label: '浮层', icon: 'layers' },
  { id: 'music', label: '音乐', icon: 'music' },
  { id: 'timer', label: '专注计时', icon: 'clock' },
  { id: 'theme', label: '主题', icon: 'sun' },
];

const SURFACE_LABEL: Record<FocusSurfaceId, string> = {
  chat: 'AI 对话',
  schedule: '日程',
  panel: '空间调节',
};

interface FocusBottomPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 哪一侧抽屉正开着；关闭键会换到另一侧，避免被抽屉压住点不到。 */
  readonly drawer: 'left' | 'right' | null;
  readonly backdrop: FocusBackdropValue;
  /** 当前背景；浮层页用它做玻璃预览。 */
  readonly mediaUrl: string | null;
  readonly mediaKind: 'image' | 'video' | null;
  readonly music: FocusMusicValue;
  readonly timer: FocusTimerValue;
  readonly surfaces: FocusSurfacesValue;
  /** 没有自定义背景时，玻璃参数禁用；窗口保持实色纸面。 */
  readonly hasBackdrop: boolean;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}

export function FocusBottomPanel({
  open,
  onOpenChange,
  drawer,
  backdrop,
  mediaUrl,
  mediaKind,
  music,
  timer,
  surfaces,
  hasBackdrop,
  theme,
  onToggleTheme,
}: FocusBottomPanelProps): JSX.Element {
  const [tab, setTab] = useState<FocusPanelTab>('background');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousOpenRef = useRef(open);

  // 面板收起时只是移出画面，内容仍挂载；必须同时移出 Tab 顺序与读屏树。
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.inert = !open;
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  }, [open]);

  // 打开时焦点进入面板关闭键，收起后还给底部入口。
  useEffect(() => {
    if (previousOpenRef.current === open) return;
    if (open) closeRef.current?.focus();
    else triggerRef.current?.focus();
    previousOpenRef.current = open;
  }, [open]);

  return (
    <>
      <div className="focus-panel-anchor">
        <button
          ref={triggerRef}
          type="button"
          className={`focus-panel-trigger${open ? ' is-open' : ''}`}
          aria-expanded={open}
          aria-controls="focus-bottom-panel"
          onClick={() => onOpenChange(!open)}
          title="背景、音乐、专注计时与主题"
          hidden={open}
        >
          <span className="focus-panel-grip" aria-hidden="true" />
          <span>空间调节</span>
          <Icon name="chevronUp" size={13} />
        </button>
      </div>

      <section
        className={`focus-panel${open ? ' is-open' : ''}${
          drawer !== null ? ` is-drawer-${drawer}` : ''
        }`}
        id="focus-bottom-panel"
        ref={panelRef}
        aria-label="空间调节"
      >
        <header className="focus-panel-head">
          <span className="focus-panel-title">空间调节</span>
          <button
            ref={closeRef}
            type="button"
            className="focus-icon-btn"
            onClick={() => onOpenChange(false)}
            aria-label="收起到下面"
            title="收起"
          >
            <Icon name="chevronDown" size={16} />
          </button>
        </header>

        <div className="focus-panel-tabs" role="tablist" aria-label="空间调节分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`focus-panel-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className="focus-panel-body">
          {tab === 'background' && <BackdropSection backdrop={backdrop} />}
          {tab === 'surface' && (
            <SurfaceSection
              surfaces={surfaces}
              hasBackdrop={hasBackdrop}
              mediaUrl={mediaUrl}
              mediaKind={mediaKind}
              dim={backdrop.settings.dim}
            />
          )}
          {tab === 'music' && <MusicSection music={music} />}
          {tab === 'timer' && <TimerSection timer={timer} />}
          {tab === 'theme' && <ThemeSection theme={theme} onToggleTheme={onToggleTheme} />}
        </div>
      </section>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 背景
// ═══════════════════════════════════════════════════════════

function BackdropSection({ backdrop }: { readonly backdrop: FocusBackdropValue }): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasBackdrop = backdrop.mediaUrl !== null;
  const hasVideo = backdrop.mediaKind === 'video';

  return (
    <div className="focus-section">
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,video/ogg,video/quicktime,video/x-m4v,.mp4,.webm,.ogv,.mov,.m4v"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          setError(null);
          void backdrop.chooseMedia(file).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        }}
      />

      <div className="focus-row focus-row--between">
        <div className="focus-bg-current">
          {backdrop.mediaUrl !== null && !hasVideo ? (
            <span
              className="focus-bg-thumb"
              style={{ backgroundImage: `url("${backdrop.mediaUrl}")` }}
              aria-hidden="true"
            />
          ) : hasVideo ? (
            <span className="focus-bg-thumb focus-bg-thumb--video" aria-hidden="true">
              <Icon name="play" size={15} />
            </span>
          ) : (
            <span className="focus-bg-thumb focus-bg-thumb--empty" aria-hidden="true">
              <Icon name="image" size={16} />
            </span>
          )}
          <div className="focus-row-copy">
            <strong>{hasBackdrop ? (hasVideo ? '动态背景' : '自定义背景') : '默认纸面'}</strong>
            <small>
              {hasBackdrop
                ? `${backdrop.mediaName ?? (hasVideo ? '本地视频' : '本地图片')}${
                    backdrop.mediaSize !== null ? ` · ${formatFileSize(backdrop.mediaSize)}` : ''
                  } · 只在本地保存`
                : '选择图片或视频，画面会更安静'}
            </small>
          </div>
        </div>
        <div className="focus-row-actions">
          <button
            type="button"
            className="focus-text-btn"
            disabled={backdrop.saving}
            onClick={() => fileRef.current?.click()}
          >
            {hasBackdrop ? '更换' : '选择图片 / 视频'}
          </button>
          {hasBackdrop && (
            <button
              type="button"
              className="focus-text-btn is-muted"
              disabled={backdrop.saving}
              onClick={backdrop.clearMedia}
            >
              移除
            </button>
          )}
        </div>
      </div>

      {error !== null && <p className="focus-inline-error" role="alert">{error}</p>}
      {backdrop.saving && (
        <p className="focus-note">正在把大文件写入本地存储，请稍候…</p>
      )}
      {backdrop.storageNote !== null && <p className="focus-note is-warn">{backdrop.storageNote}</p>}

      <div className="focus-controls" aria-disabled={!hasBackdrop}>
        <div className="focus-seg" role="group" aria-label="背景填充方式">
          <button
            type="button"
            className={backdrop.settings.fit === 'cover' ? 'is-active' : ''}
            aria-pressed={backdrop.settings.fit === 'cover'}
            disabled={!hasBackdrop}
            onClick={() => backdrop.updateSettings({ fit: 'cover' })}
          >
            填充
          </button>
          <button
            type="button"
            className={backdrop.settings.fit === 'contain' ? 'is-active' : ''}
            aria-pressed={backdrop.settings.fit === 'contain'}
            disabled={!hasBackdrop}
            onClick={() => backdrop.updateSettings({ fit: 'contain' })}
          >
            完整
          </button>
        </div>

        <RangeControl
          label="明暗"
          value={backdrop.settings.dim}
          min={58}
          max={88}
          step={1}
          suffix="%"
          disabled={!hasBackdrop}
          onChange={(value) => backdrop.updateSettings({ dim: value })}
        />
        <RangeControl
          label="模糊"
          value={backdrop.settings.blur}
          min={0}
          max={24}
          step={1}
          suffix="px"
          disabled={!hasBackdrop}
          onChange={(value) => backdrop.updateSettings({ blur: value })}
        />
        <RangeControl
          label="缩放"
          value={backdrop.settings.scale}
          min={100}
          max={140}
          step={1}
          suffix="%"
          disabled={!hasBackdrop}
          onChange={(value) => backdrop.updateSettings({ scale: value })}
        />
      </div>

      {hasVideo && (
        <>
          <div className="focus-switch-row">
            <div>
              <strong>动态背景声音</strong>
              <small>默认静音并自动循环；开启后播放视频原声。</small>
            </div>
            <Switch
              checked={backdrop.settings.videoSound}
              onChange={(videoSound) => backdrop.updateSettings({ videoSound })}
              label="动态背景声音"
            />
          </div>
          {backdrop.settings.videoSound && (
            <RangeControl
              label="音量"
              value={backdrop.settings.videoVolume}
              min={0}
              max={100}
              step={1}
              suffix="%"
              disabled={false}
              onChange={(value) => backdrop.updateSettings({ videoVolume: value })}
            />
          )}
        </>
      )}

      <p className="focus-note">
        支持 JPG / PNG / WebP 图片与 MP4 / WebM 视频。图片最大 20 MB，视频最大 4 GB；
        全部只存进这台电脑的浏览器，不会发往服务端。视频会在本地自动无缝循环，
        切换开关即可打开或关闭原声。
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 浮层
// ═══════════════════════════════════════════════════════════

function SurfaceSection({
  surfaces,
  hasBackdrop,
  mediaUrl,
  mediaKind,
  dim,
}: {
  readonly surfaces: FocusSurfacesValue;
  readonly hasBackdrop: boolean;
  readonly mediaUrl: string | null;
  readonly mediaKind: 'image' | 'video' | null;
  readonly dim: number;
}): JSX.Element {
  const [target, setTarget] = useState<FocusSurfaceId>('chat');
  const style = surfaces.settings[target];

  return (
    <div className="focus-section">
      {hasBackdrop && mediaUrl !== null && (
        <div
          className="focus-glass-preview"
          style={mediaKind === 'video' ? undefined : { backgroundImage: `url("${mediaUrl}")` }}
          aria-hidden="true"
        >
          {mediaKind === 'video' && (
            <video
              className="focus-glass-preview-video"
              src={mediaUrl}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
            />
          )}
          <span className="focus-glass-preview-scrim" style={{ opacity: dim / 100 }} />
          <div
            className="focus-glass-preview-pane"
            style={
              {
                '--preview-alpha': style.opacity / 100,
                '--preview-blur': `${style.blur}px`,
                '--preview-saturate': (1 - style.desaturate / 100).toFixed(2),
                '--preview-brightness': (style.brightness / 100).toFixed(2),
              } as CSSProperties
            }
          >
            <span>{SURFACE_LABEL[target]}</span>
            <small>
              {style.opacity === 0 ? '全透明' : `黑纱 ${style.opacity}%`} · {style.blur}px ·{' '}
              {style.desaturate === 0 ? '原色' : `去色 ${style.desaturate}%`}
            </small>
          </div>
        </div>
      )}

      <div className="focus-seg focus-seg--wide" role="group" aria-label="选择要调整的浮层">
        {FOCUS_SURFACE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={target === id ? 'is-active' : ''}
            aria-pressed={target === id}
            onClick={() => setTarget(id)}
          >
            {SURFACE_LABEL[id]}
          </button>
        ))}
      </div>

      <div className="focus-controls" aria-disabled={!hasBackdrop}>
        <RangeControl
          label="玻璃浓度"
          value={style.opacity}
          min={SURFACE_LIMITS.minOpacity}
          max={SURFACE_LIMITS.maxOpacity}
          step={1}
          suffix="%"
          disabled={!hasBackdrop}
          onChange={(value) => surfaces.update(target, { opacity: value })}
        />
        <RangeControl
          label="模糊"
          value={style.blur}
          min={0}
          max={SURFACE_LIMITS.maxBlur}
          step={1}
          suffix="px"
          disabled={!hasBackdrop}
          onChange={(value) => surfaces.update(target, { blur: value })}
        />
        <RangeControl
          label="去色"
          value={style.desaturate}
          min={0}
          max={100}
          step={1}
          suffix="%"
          disabled={!hasBackdrop}
          onChange={(value) => surfaces.update(target, { desaturate: value })}
        />
        <RangeControl
          label="背景亮度"
          value={style.brightness}
          min={SURFACE_LIMITS.minBrightness}
          max={SURFACE_LIMITS.maxBrightness}
          step={1}
          suffix="%"
          disabled={!hasBackdrop}
          onChange={(value) => surfaces.update(target, { brightness: value })}
        />
      </div>

      <div className="focus-surface-foot">
        <p className="focus-note">
          仅在有自定义背景时生效。玻璃默认完全透明，只保留模糊，背景原本的颜色直接透出；
          若背景太花，可增加一点中性黑纱提升文字可读性。去色默认 0，保留原色；
          背景亮度只影响虚化的背景，不改变文字与控件。三个窗口可以分别调整。
        </p>
        <div className="focus-row-actions">
          <button
            type="button"
            className="focus-text-btn"
            disabled={!hasBackdrop}
            onClick={() => surfaces.applyToAll(target)}
          >
            同步到三个窗口
          </button>
          <button type="button" className="focus-text-btn is-muted" onClick={surfaces.reset}>
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 音乐
// ═══════════════════════════════════════════════════════════

function MusicSection({ music }: { readonly music: FocusMusicValue }): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="focus-section">
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length === 0) return;
          setError(null);
          void music.addFiles(files).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        }}
      />

      <div className="focus-row focus-row--between">
        <div className="focus-row-copy">
          <strong>{music.current?.name ?? '还没有本地音乐'}</strong>
          <small>
            {music.current !== null
              ? `${formatFileSize(music.current.size)} · ${music.playing ? '正在播放' : '已暂停'}`
              : '选择本机音频，只在本次专注里播放'}
          </small>
        </div>
        <button
          type="button"
          className="focus-text-btn"
          onClick={() => fileRef.current?.click()}
        >
          选择音频
        </button>
      </div>

      <div className="focus-music-controls">
        <button
          type="button"
          className="focus-icon-btn"
          onClick={music.previous}
          disabled={music.tracks.length < 2}
          aria-label="上一首"
          title="上一首"
        >
          <Icon name="arrowLeft" size={16} />
        </button>
        <button
          type="button"
          className="focus-play-btn"
          onClick={music.togglePlay}
          disabled={music.tracks.length === 0}
          aria-label={music.playing ? '暂停' : '播放'}
          title={music.playing ? '暂停' : '播放'}
        >
          <Icon name={music.playing ? 'pause' : 'play'} size={18} />
        </button>
        <button
          type="button"
          className="focus-icon-btn"
          onClick={music.next}
          disabled={music.tracks.length < 2}
          aria-label="下一首"
          title="下一首"
        >
          <Icon name="chevronRight" size={16} />
        </button>

        <label className="focus-volume">
          <Icon name="volume" size={15} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={music.volume}
            onChange={(event) => music.setVolume(Number(event.target.value))}
            aria-label="音量"
          />
        </label>
        <div className="focus-loop">
          <span>循环</span>
          <Switch checked={music.loop} onChange={music.setLoop} label="循环播放" />
        </div>
      </div>

      {music.tracks.length > 0 && (
        <ul className="focus-track-list" aria-label="本地音乐列表">
          {music.tracks.map((track) => (
            <li key={track.id} className={`focus-track${track.id === music.currentId ? ' is-current' : ''}`}>
              <button
                type="button"
                className="focus-track-main"
                onClick={() => music.toggleTrack(track.id)}
                aria-label={`${music.playing && track.id === music.currentId ? '暂停' : '播放'} ${track.name}`}
              >
                <span className="focus-track-icon">
                  <Icon
                    name={track.id === music.currentId && music.playing ? 'pause' : 'play'}
                    size={12}
                  />
                </span>
                <span className="focus-track-name">{track.name}</span>
                <span className="focus-track-size">{formatFileSize(track.size)}</span>
              </button>
              <button
                type="button"
                className="focus-track-remove"
                onClick={() => music.remove(track.id)}
                aria-label={`移除 ${track.name}`}
                title="移除"
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && <p className="focus-inline-error" role="alert">{error}</p>}
      {music.error !== null && <p className="focus-inline-error" role="alert">{music.error}</p>}
      <p className="focus-note">
        只播放你选择的本地音频，不接在线音乐，也不会识别电脑上正在播放的内容。
        退出专注空间后停止。
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 专注计时
// ═══════════════════════════════════════════════════════════

function TimerSection({ timer }: { readonly timer: FocusTimerValue }): JSX.Element {
  return (
    <div className="focus-section">
      <div className="focus-timer-face">
        <span className="focus-timer-value">{formatTimer(timer.remainingMs)}</span>
        <span className="focus-timer-sub">
          {timer.finished
            ? `这一轮 ${timer.durationMin} 分钟完成了`
            : timer.running
              ? `专注 ${timer.durationMin} 分钟`
              : '准备好了再开始'}
        </span>
      </div>

      <div className="focus-timer-track" aria-hidden="true">
        <span style={{ width: `${Math.round(timer.progress * 100)}%` }} />
      </div>

      <div className="focus-timer-durations" role="group" aria-label="专注时长">
        {FOCUS_DURATIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className={timer.durationMin === minutes ? 'is-active' : ''}
            aria-pressed={timer.durationMin === minutes}
            disabled={timer.running}
            onClick={() => timer.selectDuration(minutes)}
          >
            {minutes} 分
          </button>
        ))}
      </div>

      <div className="focus-timer-actions">
        {timer.running ? (
          <button type="button" className="focus-primary-btn" onClick={timer.pause}>
            <Icon name="pause" size={15} /> 暂停
          </button>
        ) : (
          <button type="button" className="focus-primary-btn" onClick={timer.start}>
            <Icon name="play" size={15} />
            {timer.finished ? '再来一轮' : timer.remainingMs < timer.durationMin * 60_000 ? '继续' : '开始专注'}
          </button>
        )}
        <button type="button" className="focus-text-btn is-muted" onClick={timer.reset}>
          重置
        </button>
      </div>

      <p className="focus-note">
        计时只在这个界面里进行：离开专注空间就结束，不发系统通知，也不在后台调度。
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 主题
// ═══════════════════════════════════════════════════════════

function ThemeSection({
  theme,
  onToggleTheme,
}: {
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}): JSX.Element {
  return (
    <div className="focus-section">
      <div className="focus-theme-choices" role="group" aria-label="界面主题">
        <button
          type="button"
          className={theme === 'light' ? 'is-active' : ''}
          aria-pressed={theme === 'light'}
          onClick={() => {
            if (theme !== 'light') onToggleTheme();
          }}
        >
          <Icon name="sun" size={17} />
          <span>浅色</span>
          <small>暖纸与墨色</small>
        </button>
        <button
          type="button"
          className={theme === 'dark' ? 'is-active' : ''}
          aria-pressed={theme === 'dark'}
          onClick={() => {
            if (theme !== 'dark') onToggleTheme();
          }}
        >
          <Icon name="moon" size={17} />
          <span>深色</span>
          <small>近黑与微光</small>
        </button>
      </div>
      <p className="focus-note">主题会同时作用于工作台与专注空间；背景图片保持不变。</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 通用滑杆
// ═══════════════════════════════════════════════════════════

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="focus-range">
      <span className="focus-range-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
      <span className="focus-range-value">
        {value}
        {suffix}
      </span>
    </label>
  );
}
