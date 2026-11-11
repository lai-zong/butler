'use client';

/**
 * 设置 → 桌面宠物
 *
 * ★ 偏好（形象、大小、模型、思考强度与人格）由设置页保存。
 *   页面底部的「启动桌宠」可以启动 / 重新打开桌宠进程，
 *   但不会结束它；关闭这个页面也不会影响正在运行的桌宠。
 *
 * ★ enabled 表示“这份配置被启用”，不代表进程正在运行；
 *   文案必须把这两件事分开说，autoStart 也只记录偏好。
 *
 * ★ 进程状态只信 GET /api/pet/status（PID 文件 + 进程存活）：
 *   用户可能从托盘退出或被外部结束，不能拿“点过按钮”当运行证据。
 *
 * ★ 人格留空就保存空字符串：默认管家由桌宠进程决定，
 *   前端塞一段默认提示词会让“恢复默认”说不清。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Switch } from '../components/Switch';
import { errorMessage, fetchJson } from '../lib/api.js';
import { formatClock } from '../lib/format.js';
import { publishPetConfig } from '../pet/usePetConfig.js';
import type {
  ModelChoicesResponse,
  PetAssetView,
  PetConfigResponse,
  PetConfigView,
  PetDisplayMode,
  PetModelChoice,
  PetProactiveFrequency,
  PetProactiveScenarios,
  PetRuntimeView,
  PetStartResponse,
  PetStatusResponse,
  PetStopResponse,
  PetThinkingLevel,
  ToastMessage,
} from '../lib/types.js';

const SIZE_MIN = 120;
const SIZE_MAX = 480;
const SIZE_DEFAULT = 220;
const PERSONA_MAX = 4000;
/** 轮询进程状态的间隔；用户从托盘退出后，按钮要能自动恢复。 */
const STATUS_POLL_MS = 5_000;

const THINKING_OPTIONS: readonly { readonly value: PetThinkingLevel; readonly label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const PROACTIVE_FREQUENCY_OPTIONS: readonly {
  readonly value: PetProactiveFrequency;
  readonly label: string;
  readonly hint: string;
}[] = [
  { value: 'rare', label: '少', hint: '更克制' },
  { value: 'normal', label: '正常', hint: '默认' },
  { value: 'often', label: '多', hint: '更主动' },
];

const PROACTIVE_SCENARIO_OPTIONS: readonly {
  readonly key: keyof PetProactiveScenarios;
  readonly label: string;
  readonly hint: string;
}[] = [
  { key: 'lateNight', label: '深夜', hint: '夜深还在用' },
  { key: 'longSession', label: '长会话', hint: '连续用了一阵' },
  { key: 'return', label: '回来', hint: '隔了很久回来' },
];

interface ModelOption {
  /** `${profileId}::${modelId}`，与后端存储的 model 字段一一对应。 */
  readonly key: string;
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

interface SpriteChoice {
  readonly id: string;
  readonly label: string;
}

interface PetFormState {
  readonly enabled: boolean;
  readonly displayMode: PetDisplayMode;
  readonly autoStart: boolean;
  readonly size: number;
  readonly sprite: string;
  readonly alwaysOnTop: boolean;
  /** 空字符串 = 未指定，使用主界面最近使用的对话模型。 */
  readonly modelKey: string;
  readonly thinkingLevel: PetThinkingLevel;
  readonly persona: string;
  readonly proactiveEnabled: boolean;
  readonly proactiveFrequency: PetProactiveFrequency;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly proactiveScenarios: PetProactiveScenarios;
}

interface PetSettingsPanelProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

function choiceKey(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return SIZE_DEFAULT;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(value)));
}

/** 状态没变时保留原对象，避免每次轮询都把整个面板重渲染一遍。 */
function sameRuntime(prev: PetRuntimeView | null, next: PetRuntimeView): boolean {
  return (
    prev !== null &&
    prev.running === next.running &&
    prev.pid === next.pid &&
    prev.script === next.script
  );
}

function formFromConfig(config: PetConfigView): PetFormState {
  const scenarios = config.proactiveScenarios;
  return {
    enabled: config.enabled,
    displayMode: config.displayMode,
    autoStart: config.autoStart,
    size: clampSize(config.size),
    sprite: config.sprite,
    alwaysOnTop: config.alwaysOnTop,
    modelKey:
      config.model === null ? '' : choiceKey(config.model.profileId, config.model.modelId),
    thinkingLevel: config.thinkingLevel,
    persona: config.persona,
    proactiveEnabled: config.proactiveEnabled === true,
    proactiveFrequency: config.proactiveFrequency ?? 'normal',
    quietStart: typeof config.quietStart === 'string' ? config.quietStart : '22:30',
    quietEnd: typeof config.quietEnd === 'string' ? config.quietEnd : '08:00',
    proactiveScenarios: {
      lateNight: scenarios?.lateNight !== false,
      longSession: scenarios?.longSession !== false,
      return: scenarios?.return !== false,
    },
  };
}

function modelOptionsFrom(res: ModelChoicesResponse | null): readonly ModelOption[] {
  if (res === null) return [];
  const options: ModelOption[] = [];
  for (const profile of res.profiles) {
    for (const model of profile.models) {
      if (model.kind !== 'chat') continue;
      options.push({
        key: choiceKey(profile.id, model.id),
        profileId: profile.id,
        modelId: model.id,
        label: `${profile.name} · ${model.id}`,
      });
    }
  }
  return options;
}

/**
 * 把表单里的 `profileId::modelId` 还原成接口要的结构。
 * 配置里的模型被删掉时仍保留原 label，避免一次打开设置页就把它悄悄清空。
 */
function resolveModelChoice(
  key: string,
  options: readonly ModelOption[],
  saved: PetConfigView | null,
): PetModelChoice | null {
  if (key === '') return null;
  if (
    saved !== null &&
    saved.model !== null &&
    key === choiceKey(saved.model.profileId, saved.model.modelId)
  ) {
    return saved.model;
  }
  const option = options.find((item) => item.key === key);
  if (option !== undefined) {
    return { profileId: option.profileId, modelId: option.modelId, label: option.label };
  }
  return null;
}

export function PetSettingsPanel({ notify }: PetSettingsPanelProps): JSX.Element {
  const [form, setForm] = useState<PetFormState | null>(null);
  const [assets, setAssets] = useState<readonly PetAssetView[]>([]);
  const [savedConfig, setSavedConfig] = useState<PetConfigView | null>(null);
  const [models, setModels] = useState<readonly ModelOption[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * 数字输入框的**文本态**。
   *
   * ★ 旧实现把 `value` 直接绑在 `form.size` 上，且只在 `valueAsNumber` 是有限数时
   *   才更新状态：用户清空输入框时 `valueAsNumber` 是 NaN，不更新 → 受控值立刻
   *   弹回旧数字，**整段删不掉**。这里保留文本态，失焦时才提交并夹紧范围。
   */
  const [sizeText, setSizeText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [brokenSprite, setBrokenSprite] = useState<string | null>(null);

  /** 显示位置是即时生效的独立动作：与“保存偏好”互不覆盖。 */
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [runtime, setRuntime] = useState<PetRuntimeView | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [everRunning, setEverRunning] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    setSaveError(null);
    setModeError(null);
    setModelsError(null);
    try {
      const [petRes, modelRes] = await Promise.all([
        fetchJson<PetConfigResponse>('/api/pet/config'),
        fetchJson<ModelChoicesResponse>('/api/model').catch(() => null),
      ]);
      if (!mountedRef.current) return;
      setSavedConfig(petRes.config);
      setAssets(petRes.assets);
      setForm(formFromConfig(petRes.config));
      setModels(modelOptionsFrom(modelRes));
      setModelsError(modelRes === null ? '模型列表读取失败，暂时无法切换模型。' : null);
      setBrokenSprite(null);
      setSavedAt(null);
      setDirty(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 状态只以服务端为准；失败时保留上一次已知值，但把错误显示出来。
   * 状态加载与偏好加载彼此独立：状态挂了也不影响表单。
   */
  const refreshRuntime = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchJson<PetStatusResponse>('/api/pet/status');
      if (!mountedRef.current) return;
      setRuntime((prev) => (sameRuntime(prev, res) ? prev : res));
      setRuntimeError(null);
      if (res.running) {
        setEverRunning(true);
        // 进程已经真的起来了，之前那次启动超时的提示就不该继续挂着。
        setStartError(null);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setRuntimeError(errorMessage(err));
    }
  }, []);

  // 表单里的尺寸变化（加载/滑块）同步到输入框文本
  useEffect(() => {
    if (form !== null) setSizeText(String(form.size));
  }, [form?.size]);

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      if (cancelled) return;
      void refreshRuntime();
    };
    poll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, STATUS_POLL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshRuntime]);

  const patch = (next: Partial<PetFormState>): void => {
    setForm((prev) => (prev === null ? prev : { ...prev, ...next }));
    setDirty(true);
    setSaveError(null);
  };

  const spriteChoices = useMemo<readonly SpriteChoice[]>(() => {
    const list: SpriteChoice[] = assets.map((asset) => ({ id: asset.id, label: asset.label }));
    const current = form === null ? '' : form.sprite;
    if (current === '' || list.some((item) => item.id === current)) return list;
    return [{ id: current, label: `${current}（素材未找到）` }, ...list];
  }, [assets, form]);

  const modelOptions = useMemo<readonly ModelOption[]>(() => {
    const current = form === null ? '' : form.modelKey;
    if (current === '' || models.some((item) => item.key === current)) return models;
    const saved = savedConfig === null ? null : savedConfig.model;
    if (saved === null || choiceKey(saved.profileId, saved.modelId) !== current) return models;
    return [
      {
        key: current,
        profileId: saved.profileId,
        modelId: saved.modelId,
        label: `${saved.label}（不在模型列表里）`,
      },
      ...models,
    ];
  }, [form, models, savedConfig]);

  const save = async (): Promise<void> => {
    if (form === null || saving || modeSaving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetchJson<PetConfigResponse>('/api/pet/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          displayMode: form.displayMode,
          autoStart: form.autoStart,
          size: clampSize(form.size),
          sprite: form.sprite,
          alwaysOnTop: form.alwaysOnTop,
          model: resolveModelChoice(form.modelKey, modelOptions, savedConfig),
          thinkingLevel: form.thinkingLevel,
          persona: form.persona.slice(0, PERSONA_MAX),
          proactiveEnabled: form.proactiveEnabled,
          proactiveFrequency: form.proactiveFrequency,
          quietStart: form.quietStart,
          quietEnd: form.quietEnd,
          proactiveScenarios: form.proactiveScenarios,
        }),
      });
      if (!mountedRef.current) return;
      setSavedConfig(res.config);
      setAssets(res.assets);
      setForm(formFromConfig(res.config));
      setDirty(false);
      setSavedAt(Date.now());
      // enabled / displayMode 也可能在这一步变化；通知页面里的 WebPet。
      publishPetConfig(res.config);
      notify('桌宠设置已保存', 'success');
    } catch (err) {
      if (!mountedRef.current) return;
      setSaveError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  /**
   * 切换显示位置 —— 立即生效，不等“保存偏好”。
   *
   * ★ 切到 Web 前必须先结束桌面进程：
   *   否则两个界面会同时说话，而用户以为只切了一个显示位置。
   *   stop 失败/进程仍存活时不写配置，并明确报错 —— 不能假装成功。
   *
   * ★ 只 PUT displayMode，不提交表单里其它未保存的修改。
   */
  const changeDisplayMode = async (next: PetDisplayMode): Promise<void> => {
    if (form === null || saving || modeSaving) return;
    if (form.displayMode === next) return;
    const previous = form.displayMode;
    let stoppedDesktop = false;
    setModeError(null);
    setStartError(null);
    setModeSaving(true);
    setForm((prev) => (prev === null ? prev : { ...prev, displayMode: next }));

    try {
      if (next === 'web') {
        const status = await fetchJson<PetStatusResponse>('/api/pet/status');
        if (!mountedRef.current) return;
        setRuntime(status);
        setRuntimeError(null);
        if (status.running) {
          const stopped = await fetchJson<PetStopResponse>('/api/pet/stop', { method: 'POST' });
          if (!mountedRef.current) return;
          setRuntime(stopped.status);
          if (stopped.status.running) {
            throw new Error('桌面桌宠进程没有停下，仍占用显示；请先手动结束后再切换。');
          }
          stoppedDesktop = true;
        }
      }

      const res = await fetchJson<PetConfigResponse>('/api/pet/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayMode: next }),
      });
      if (!mountedRef.current) return;
      setSavedConfig(res.config);
      setAssets(res.assets);
      setForm((prev) =>
        prev === null ? prev : { ...prev, displayMode: res.config.displayMode },
      );
      publishPetConfig(res.config);
      notify(
        next === 'web' ? '已切换为 Web 界面显示' : '已切换为桌面显示',
        'success',
      );
      void refreshRuntime();
    } catch (err) {
      if (!mountedRef.current) return;
      setForm((prev) => (prev === null ? prev : { ...prev, displayMode: previous }));
      const message = errorMessage(err);
      setModeError(
        stoppedDesktop
          ? `桌面桌宠已停止，但保存显示位置失败：${message}`
          : message,
      );
    } finally {
      if (mountedRef.current) setModeSaving(false);
    }
  };

  /**
   * 启动由服务端执行固定的 scripts/desktop_pet.py，前端只发一个空 POST。
   * 启动按钮与保存按钮互不依赖：不需要先保存偏好。
   */
  const startPet = async (): Promise<void> => {
    if (form === null) return;
    if (form.displayMode === 'web') {
      setStartError('当前由 Web 页面显示；切回桌面显示后才能打开独立桌宠。');
      return;
    }
    if (starting || (runtime !== null && runtime.running)) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetchJson<PetStartResponse>('/api/pet/start', { method: 'POST' });
      if (!mountedRef.current) return;
      // 服务端返回前已确认 PID 存活，先用它更新按钮，避免闪回“未运行”。
      setRuntime(res.status);
      setRuntimeError(null);
      if (res.status.running) setEverRunning(true);
      notify('桌宠已打开', 'success');
      // 再拉一次，确认真实进程状态（也包括 alreadyRunning 的情况）。
      void refreshRuntime();
    } catch (err) {
      if (!mountedRef.current) return;
      setStartError(errorMessage(err));
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  if (form === null) {
    return (
      <section className="panel settings-panel" aria-label="桌面宠物设置">
        <SectionHeading
          title="桌宠偏好"
          description="形象、大小、模型与人格都由桌宠进程直接读取。"
        />
        {error !== null ? (
          <InlineError message={error} onRetry={() => void load()} />
        ) : (
          <Skeleton rows={6} height={14} />
        )}
      </section>
    );
  }

  const activeSprite = form.sprite;
  const previewAsset = assets.find((asset) => asset.id === activeSprite);
  const previewLabel =
    spriteChoices.find((item) => item.id === activeSprite)?.label ?? activeSprite;
  const statusText = dirty
    ? '有未保存的修改'
    : savedAt !== null
      ? `已保存 · ${formatClock(savedAt)}`
      : '';

  const runtimeRunning = runtime !== null && runtime.running;
  const webMode = form.displayMode === 'web';
  const opening = starting && !runtimeRunning;
  const startDisabled = opening || runtimeRunning || webMode;
  const startLabel = webMode
    ? 'Web 页面显示中'
    : runtimeRunning
      ? '桌宠正在运行'
      : opening
        ? '正在打开…'
        : everRunning
          ? '重新打开桌宠'
          : '打开桌宠';

  return (
    <>
      <section className="panel settings-panel" aria-label="桌面宠物设置">
        <SectionHeading
          title="桌宠偏好"
          description="形象与人格两个界面共用；显示位置决定它出现在桌面窗口还是 Web 页面里。"
          actions={
            <Badge tone={form.enabled ? 'accent' : 'neutral'}>
              {form.enabled ? '已启用' : '未启用'}
            </Badge>
          }
        />

        {error !== null && (
          <div className="pet-inline-error">
            <InlineError message={error} onRetry={() => void load()} />
          </div>
        )}

        <div className="settings-rows">
          <div className="settings-row pet-mode-row">
            <span className="settings-key">显示位置</span>
            <span className="settings-val pet-mode-val">
              <div className="pet-mode-choices" role="radiogroup" aria-label="桌宠显示位置">
                <label
                  className={`pet-mode-option${form.displayMode === 'desktop' ? ' is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name="pet-display-mode"
                    value="desktop"
                    checked={form.displayMode === 'desktop'}
                    disabled={saving || modeSaving}
                    onChange={() => void changeDisplayMode('desktop')}
                  />
                  <span className="pet-mode-text">
                    <span className="pet-mode-title">桌面显示</span>
                    <span className="pet-mode-desc">
                      独立桌面窗口：可置顶、贴边、托盘与系统语音；不会内嵌在 Web 页面里。
                    </span>
                  </span>
                </label>
                <label
                  className={`pet-mode-option${form.displayMode === 'web' ? ' is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name="pet-display-mode"
                    value="web"
                    checked={form.displayMode === 'web'}
                    disabled={saving || modeSaving}
                    onChange={() => void changeDisplayMode('web')}
                  />
                  <span className="pet-mode-text">
                    <span className="pet-mode-title">Web 界面显示</span>
                    <span className="pet-mode-desc">
                      悬浮在页面右下角：没有系统托盘、窗口置顶、贴边和系统语音；关闭标签页即不显示。
                    </span>
                  </span>
                </label>
              </div>
              <span className="settings-muted">
                {modeSaving
                  ? '正在切换显示位置…'
                  : webMode
                    ? '当前由 Web 页面显示；要打开独立桌宠，请先切回桌面显示。'
                    : '切换会立即保存；切到 Web 前会先停止正在运行的桌面桌宠。'}
              </span>
              {modeError !== null && <InlineError message={modeError} />}
            </span>
          </div>

          <div className="settings-row pet-toggle-row">
            <span className="settings-key">启用桌宠</span>
            <span className="settings-val">
              <Switch
                checked={form.enabled}
                disabled={saving || modeSaving}
                label="启用桌宠"
                onChange={(next) => patch({ enabled: next })}
              />
              <span className="settings-muted">
                只记录偏好；禁用不会结束正在运行的桌宠，进程状态见下方「启动桌宠」。
              </span>
            </span>
          </div>

          <div className="settings-row pet-toggle-row">
            <span className="settings-key">自动打开</span>
            <span className="settings-val">
              <Switch
                checked={form.autoStart}
                disabled={saving || modeSaving || webMode}
                label="应用启动时自动打开桌宠"
                onChange={(next) => patch({ autoStart: next })}
              />
              <span className="settings-muted">
                {webMode
                  ? 'Web 模式不启动桌面进程，自动打开只对桌面显示生效。'
                  : '应用启动时自动打开桌宠；第一版由启动器接入，目前只保存偏好。'}
              </span>
            </span>
          </div>

          <div className="settings-row">
            <span className="settings-key">桌宠大小</span>
            <span className="settings-val pet-size">
              <input
                type="range"
                min={SIZE_MIN}
                max={SIZE_MAX}
                step={10}
                value={clampSize(form.size)}
                aria-label="桌宠显示大小"
                disabled={saving || modeSaving}
                onChange={(e) => patch({ size: Number(e.target.value) })}
              />
              <input
                type="number"
                min={SIZE_MIN}
                max={SIZE_MAX}
                step={1}
                value={sizeText}
                aria-label="桌宠显示大小（像素）"
                className="pet-size-number"
                disabled={saving || modeSaving}
                onChange={(e) => setSizeText(e.target.value)}
                onBlur={() => {
                  const clamped = clampSize(Number(sizeText));
                  patch({ size: clamped });
                  setSizeText(String(clamped));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <span className="pet-size-unit">px</span>
              <span className="settings-muted">
                120–480，默认 220；Web 模式也使用这个高度（窄屏会按视口收一点）。
              </span>
            </span>
          </div>

          <div className="settings-row">
            <span className="settings-key">人物形象</span>
            <span className="settings-val pet-sprite-row">
              <span
                className={`pet-sprite-preview${
                  previewAsset !== undefined && brokenSprite !== activeSprite ? '' : ' is-fallback'
                }`}
                aria-hidden="true"
              >
                {previewAsset !== undefined && brokenSprite !== activeSprite ? (
                  <img
                    src={previewAsset.url}
                    alt=""
                    onError={() => setBrokenSprite(activeSprite)}
                  />
                ) : (
                  <span>{previewLabel}</span>
                )}
              </span>
              <select
                className="pet-select"
                aria-label="人物形象"
                value={form.sprite}
                disabled={saving || modeSaving || spriteChoices.length === 0}
                onChange={(e) => {
                  setBrokenSprite(null);
                  patch({ sprite: e.target.value });
                }}
              >
                {spriteChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
                {spriteChoices.length === 0 && <option value={form.sprite}>未找到形象素材</option>}
              </select>
              <span className="settings-muted">
                {assets.length === 0
                  ? 'public/pet 下没有可用形象；放入素材后回到这里选择。'
                  : `来自 public/pet，共 ${assets.length} 个形象。`}
              </span>
            </span>
          </div>

          <div className="settings-row pet-toggle-row">
            <span className="settings-key">始终置顶</span>
            <span className="settings-val">
              <Switch
                checked={form.alwaysOnTop}
                disabled={saving || modeSaving || webMode}
                label="始终置顶"
                onChange={(next) => patch({ alwaysOnTop: next })}
              />
              <span className="settings-muted">
                {webMode
                  ? 'Web 界面显示没有系统窗口置顶；切回桌面显示后生效。'
                  : '由桌宠窗口自己实现；这里只写偏好。'}
              </span>
            </span>
          </div>
        </div>

        <div className="pet-section">
          <p className="pet-section-title">对话</p>

          <label className="pet-field">
            <span>使用模型</span>
            <select
              className="pet-select"
              value={form.modelKey}
              disabled={saving || modeSaving}
              onChange={(e) => patch({ modelKey: e.target.value })}
            >
              <option value="">未指定（使用主界面最近使用的模型）</option>
              {modelOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>
              {modelsError ??
                (models.length === 0
                  ? '还没有配置对话模型；可以到「模型接入」里添加。'
                  : webMode
                    ? 'Web 界面显示时以桌宠输入框右下角的会话设置为准；这里留给桌面桌宠。'
                    : '留空 = 使用主界面最近使用的对话模型。')}
            </small>
          </label>

          <label className="pet-field">
            <span>思考强度</span>
            <select
              className="pet-select"
              value={form.thinkingLevel}
              disabled={saving || modeSaving}
              onChange={(e) => patch({ thinkingLevel: e.target.value as PetThinkingLevel })}
            >
              {THINKING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>
              {webMode
                ? 'Web 界面显示时以桌宠右下角的会话设置为准；这里留给桌面桌宠。'
                : '桌宠右键切换思考强度会同步到当前对话；这里保存的是桌宠偏好。'}
            </small>
          </label>

          <label className="pet-field">
            <span>人格</span>
            <textarea
              className="pet-textarea"
              rows={5}
              maxLength={PERSONA_MAX}
              value={form.persona}
              placeholder="留空 = 默认管家。可以写它怎么称呼你、说话的分寸和忌讳。"
              disabled={saving || modeSaving}
              onChange={(e) => patch({ persona: e.target.value.slice(0, PERSONA_MAX) })}
            />
            <span className="pet-persona-meta">
              <small>留空就是默认管家，不会自动填入提示词。</small>
              <small>
                {form.persona.length}/{PERSONA_MAX}
              </small>
            </span>
          </label>
        </div>

        <div className="pet-section pet-proactive">
          <p className="pet-section-title">主动说话</p>
          <p className="pet-proactive-intro">
            开不开、什么时候说由服务端按使用节奏决定；这里只限制频率、安静时段与允许的场景。
            人格影响的是措辞，不会改变开口的时机。
          </p>

          <div className="settings-rows">
            <div className="settings-row pet-toggle-row">
              <span className="settings-key">允许主动说话</span>
              <span className="settings-val">
                <Switch
                  checked={form.proactiveEnabled}
                  disabled={saving || modeSaving}
                  label="允许桌宠主动说话"
                  onChange={(next) => patch({ proactiveEnabled: next })}
                />
                <span className="settings-muted">
                  默认关闭。打开后，Web 桌宠与桌面桌宠共用这一份开关；关闭时不会领取新的主动提醒。
                </span>
              </span>
            </div>

            <div className="settings-row">
              <span className="settings-key">频率</span>
              <span className="settings-val">
                <div className="pet-proactive-freq" role="radiogroup" aria-label="主动说话频率">
                  {PROACTIVE_FREQUENCY_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`pet-proactive-freq-option${
                        form.proactiveFrequency === option.value ? ' is-active' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="pet-proactive-frequency"
                        value={option.value}
                        checked={form.proactiveFrequency === option.value}
                        disabled={saving || modeSaving}
                        onChange={() => patch({ proactiveFrequency: option.value })}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.hint}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <span className="settings-muted">
                  这是上限；服务端还会看今天已经说过几次、离上一次多久。
                </span>
              </span>
            </div>

            <div className="settings-row">
              <span className="settings-key">安静时段</span>
              <span className="settings-val pet-quiet">
                <label className="pet-quiet-field">
                  <span>从</span>
                  <input
                    type="time"
                    className="pet-time"
                    value={form.quietStart}
                    aria-label="安静时段开始"
                    disabled={saving || modeSaving}
                    onChange={(e) => {
                      if (e.target.value.length > 0) patch({ quietStart: e.target.value });
                    }}
                  />
                </label>
                <label className="pet-quiet-field">
                  <span>到</span>
                  <input
                    type="time"
                    className="pet-time"
                    value={form.quietEnd}
                    aria-label="安静时段结束"
                    disabled={saving || modeSaving}
                    onChange={(e) => {
                      if (e.target.value.length > 0) patch({ quietEnd: e.target.value });
                    }}
                  />
                </label>
                <span className="settings-muted">
                  跨午夜也生效；这段时间内不会主动开口。留空或格式不对时服务端会忽略。
                </span>
              </span>
            </div>

            <div className="settings-row">
              <span className="settings-key">允许的场景</span>
              <span className="settings-val pet-proactive-scenarios">
                {PROACTIVE_SCENARIO_OPTIONS.map((option) => (
                  <label
                    key={option.key}
                    className={`pet-scenario${
                      form.proactiveScenarios[option.key] ? ' is-active' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={form.proactiveScenarios[option.key]}
                      disabled={saving || modeSaving}
                      onChange={(e) =>
                        patch({
                          proactiveScenarios: {
                            ...form.proactiveScenarios,
                            [option.key]: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.hint}</small>
                    </span>
                  </label>
                ))}
                <span className="settings-muted">
                  三个都关掉时，服务端不会主动开口；其它设置仍会保留。
                </span>
              </span>
            </div>
          </div>
        </div>

        {saveError !== null && (
          <div className="pet-inline-error">
            <InlineError message={saveError} />
          </div>
        )}

        <div className="pet-actions">
          <span
            className={`pet-actions-status${dirty ? ' is-dirty' : savedAt !== null ? ' is-saved' : ''}`}
            role="status"
          >
            {statusText}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || modeSaving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>

      <section className="panel settings-panel pet-launch" aria-label="启动桌宠">
        <SectionHeading
          title="启动桌宠"
          description={
            webMode
              ? '当前由 Web 页面显示，不会启动独立桌面进程。'
              : '桌宠是独立的桌面进程，需要主应用正在运行。'
          }
        />

        <div className="pet-launch-status" role="status" aria-live="polite">
          <span
            className={`pet-launch-dot${webMode ? ' is-web' : runtimeRunning ? ' is-running' : ''}`}
            aria-hidden="true"
          />
          <span>
            {webMode
              ? runtimeRunning
                ? 'Web 界面显示中（检测到桌面进程仍在运行）'
                : 'Web 界面显示中'
              : runtime === null
                ? runtimeError === null
                  ? '正在读取桌宠状态…'
                  : '桌宠状态未知'
                : runtimeRunning
                  ? '桌宠正在运行'
                  : '桌宠未运行'}
          </span>
          {!webMode && runtime !== null && runtimeRunning && runtime.pid !== null && (
            <span className="pet-launch-pid">PID {runtime.pid}</span>
          )}
        </div>

        {runtimeError !== null && (
          <div className="pet-inline-error">
            <InlineError
              message={`无法读取桌宠状态：${runtimeError}`}
              onRetry={() => void refreshRuntime()}
            />
          </div>
        )}

        <div className="pet-launch-controls">
          <button
            type="button"
            className="btn btn-primary"
            disabled={startDisabled}
            onClick={() => void startPet()}
          >
            {startLabel}
          </button>
          <span className="pet-launch-hint">
            {webMode
              ? '切回“桌面显示”后会恢复启动按钮；不会自动启动。'
              : '启动不需要先保存上方的偏好。'}
          </span>
        </div>

        {startError !== null && (
          <div className="pet-inline-error">
            <InlineError message={startError} />
          </div>
        )}

        {!webMode && (
          <div className="pet-launch-cmds">
            <p>
              如果启动按钮没有反应，也可以在项目根目录运行：<code>pnpm pet</code>
            </p>
            <p>
              或双击：<code>启动桌宠.bat</code>
            </p>
          </div>
        )}
        <p className="pet-launch-note">
          {webMode
            ? 'Web 模式没有系统托盘、窗口置顶、贴边和系统语音；关闭这个标签页就不会显示桌宠。启动接口在 Web 模式下会被服务端拒绝，所以这里不提供启动按钮。'
            : '桌面模式不会把桌宠内嵌到 Web 页面里；设置页可以启动或重新打开桌宠，但不会结束正在运行的桌宠。'}
        </p>
      </section>
    </>
  );
}
