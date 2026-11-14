'use client';

/**
 * 设置 → 网页桌宠
 *
 * ★ 只保存网页桌宠读取的偏好（形象、大小、模型、思考强度、人格与主动说话），
 *   不再启动或检查任何外部程序：桌宠只存在于 Web 页面右下角。
 *
 * ★ enabled 表示“在 Web 页面里显示桌宠”：保存后广播给 WebPet，
 *   页面里的桌宠立即显示/隐藏，不需要刷新。
 *
 * ★ 人格留空就保存空字符串：前端不拼默认提示词，
 *   否则“恢复默认”会说不清。
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
  PetModelChoice,
  PetProactiveFrequency,
  PetProactiveScenarios,
  PetThinkingLevel,
  ToastMessage,
} from '../lib/types.js';

const SIZE_MIN = 120;
const SIZE_MAX = 480;
const SIZE_DEFAULT = 220;
const PERSONA_MAX = 4000;

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
  readonly size: number;
  readonly sprite: string;
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

function formFromConfig(config: PetConfigView): PetFormState {
  const scenarios = config.proactiveScenarios;
  return {
    enabled: config.enabled,
    size: clampSize(config.size),
    sprite: config.sprite,
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

  // 表单里的尺寸变化（加载/滑块）同步到输入框文本
  useEffect(() => {
    if (form !== null) setSizeText(String(form.size));
  }, [form?.size]);

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
    if (form === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetchJson<PetConfigResponse>('/api/pet/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          size: clampSize(form.size),
          sprite: form.sprite,
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
      // enabled 也可能在这一步变化；通知页面里的 WebPet。
      publishPetConfig(res.config);
      notify('网页桌宠设置已保存', 'success');
    } catch (err) {
      if (!mountedRef.current) return;
      setSaveError(errorMessage(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  if (form === null) {
    return (
      <section className="panel settings-panel" aria-label="网页桌宠设置">
        <SectionHeading
          title="网页桌宠偏好"
          description="形象、大小、模型与人格都会保存到 pet-config；网页桌宠读到后立即生效。"
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

  return (
    <>
      <section className="panel settings-panel" aria-label="网页桌宠设置">
        <SectionHeading
          title="网页桌宠偏好"
          description="形象、大小、模型与人格都由网页桌宠读取；保存后页面里的桌宠立即跟着变。"
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
          <div className="settings-row pet-toggle-row">
            <span className="settings-key">显示网页桌宠</span>
            <span className="settings-val">
              <Switch
                checked={form.enabled}
                disabled={saving}
                label="显示网页桌宠"
                onChange={(next) => patch({ enabled: next })}
              />
              <span className="settings-muted">
                关闭后页面右下角的网页桌宠立即隐藏；其它偏好保留。
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
                disabled={saving}
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
                disabled={saving}
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
                120–480，默认 220；网页桌宠按这个高度显示（窄屏会按视口收一点）。
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
                disabled={saving || spriteChoices.length === 0}
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
        </div>

        <div className="pet-section">
          <p className="pet-section-title">对话</p>

          <label className="pet-field">
            <span>使用模型</span>
            <select
              className="pet-select"
              value={form.modelKey}
              disabled={saving}
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
                  : '留空 = 使用主界面最近使用的对话模型。')}
            </small>
          </label>

          <label className="pet-field">
            <span>思考强度</span>
            <select
              className="pet-select"
              value={form.thinkingLevel}
              disabled={saving}
              onChange={(e) => patch({ thinkingLevel: e.target.value as PetThinkingLevel })}
            >
              {THINKING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>网页桌宠右键切换思考强度会同步到当前对话；这里保存的是桌宠偏好。</small>
          </label>

          <label className="pet-field">
            <span>人格</span>
            <textarea
              className="pet-textarea"
              rows={5}
              maxLength={PERSONA_MAX}
              value={form.persona}
              placeholder="留空 = 默认管家。可以写它怎么称呼你、说话的分寸和忌讳。"
              disabled={saving}
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
                  disabled={saving}
                  label="允许桌宠主动说话"
                  onChange={(next) => patch({ proactiveEnabled: next })}
                />
                <span className="settings-muted">
                  默认关闭。打开后网页桌宠按下面的频率与场景开口；关闭时不会领取新的主动提醒。
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
                        disabled={saving}
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
                    disabled={saving}
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
                    disabled={saving}
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
                      disabled={saving}
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
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </>
  );
}
