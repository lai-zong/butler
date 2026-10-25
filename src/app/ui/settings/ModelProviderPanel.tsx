'use client';

/**
 * 设置 · 模型接入
 *
 * 只做三件事：展示当前 provider、验证所选 provider、确认后切换。
 * 约束：
 *   · 未配置的 provider 不可点，不展示假选项；
 *   · 验证通过前不允许切换；
 *   · 当前 provider 在切换成功前不变；
 *   · OpenAI 兼容 / Ollama 只承诺非流式，界面如实标注。
 */

import { useCallback, useEffect, useState } from 'react';

import { Badge, InlineError, SectionHeading, Skeleton } from '../components/Common';
import { Modal } from '../components/Modal';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import type { ModelCapabilities, ToastMessage } from '../lib/types.js';

type ProviderId = 'deepseek' | 'openai' | 'ollama';

interface ProviderStatus {
  readonly id: ProviderId;
  readonly label: string;
  readonly configured: boolean;
  readonly keySource: 'env' | 'vault' | 'none';
  readonly model: string;
  readonly baseUrl: string;
  readonly note?: string;
}

interface ModelStatusResponse {
  readonly current: {
    readonly provider: ProviderId;
    readonly model: string | null;
    readonly providerLabel: string;
    readonly capabilities: ModelCapabilities | null;
    readonly streaming: boolean;
  };
  readonly selection: { readonly provider: ProviderId; readonly model?: string };
  readonly envLocked: boolean;
  readonly providers: readonly ProviderStatus[];
}

interface ValidateResponse {
  readonly ok: true;
  readonly provider: ProviderId;
  readonly model: string;
  readonly latencyMs: number;
  readonly text: string;
}

interface SwitchResponse {
  readonly ok: true;
  readonly switched: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly latencyMs: number;
    readonly streaming: boolean;
  };
  readonly current: {
    readonly provider: ProviderId;
    readonly model: string | null;
    readonly capabilities: ModelCapabilities | null;
  };
}

interface ModelProviderPanelProps {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onRefreshOverview: () => void;
}

const KEY_SOURCE_LABEL: Record<ProviderStatus['keySource'], string> = {
  env: '环境变量',
  vault: '本机凭证库',
  none: '未配置',
};

export function ModelProviderPanel({
  notify,
  onRefreshOverview,
}: ModelProviderPanelProps): JSX.Element {
  const [data, setData] = useState<ModelStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProviderId | null>(null);
  const [validated, setValidated] = useState<ValidateResponse | null>(null);
  const [busy, setBusy] = useState<'validate' | 'switch' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<ModelStatusResponse>('/api/model');
      setData(next);
      setSelected(next.current.provider);
      setValidated(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedStatus = data?.providers.find((p) => p.id === selected) ?? null;
  const currentStatus = data?.providers.find((p) => p.id === data.current.provider) ?? null;
  const currentLabel = currentStatus?.label ?? data?.current.providerLabel ?? '—';
  const isCurrent = data !== null && selected === data.current.provider;
  const canValidate =
    data !== null &&
    selectedStatus !== null &&
    selectedStatus.configured &&
    !data.envLocked &&
    busy === null;
  const canSwitch =
    data !== null &&
    validated !== null &&
    validated.provider === selected &&
    !isCurrent &&
    !data.envLocked &&
    busy === null;

  async function validate(): Promise<void> {
    if (data === null || selected === null || !canValidate) return;
    setBusy('validate');
    setActionError(null);
    setValidated(null);
    try {
      const result = await postJson<ValidateResponse>('/api/model', {
        action: 'validate',
        provider: selected,
      });
      setValidated(result);
      notify(`端点验证通过：${result.model} · ${(result.latencyMs / 1000).toFixed(1)}s`, 'success');
    } catch (err) {
      setActionError(`验证失败：${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function switchProvider(): Promise<void> {
    if (data === null || selected === null || !canSwitch) return;
    setConfirmOpen(false);
    setBusy('switch');
    setActionError(null);
    try {
      const result = await postJson<SwitchResponse>('/api/model', {
        action: 'switch',
        provider: selected,
      });
      notify(
        `已切换到 ${result.switched.provider} · ${result.switched.model}` +
          (result.switched.streaming ? '（流式）' : '（非流式）'),
        'success',
      );
      await load();
      onRefreshOverview();
    } catch (err) {
      setActionError(`切换失败：${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel settings-panel model-provider-panel">
      <SectionHeading
        title="模型接入"
        description="选择主模型厂商；切换会重建运行时，有对话正在执行时会被拒绝。"
        actions={
          data !== null ? (
            <>
              <Badge tone="accent">当前 · {currentLabel}</Badge>
              <Badge tone="outline">{data.current.streaming ? '流式' : '非流式'}</Badge>
              {selected !== null && !isCurrent ? <Badge tone="warn">待切换</Badge> : null}
            </>
          ) : undefined
        }
      />

      {loading ? (
        <Skeleton rows={3} height={16} />
      ) : loadError !== null ? (
        <InlineError message={`读取模型状态失败：${loadError}`} onRetry={() => void load()} />
      ) : data === null ? (
        <InlineError message="模型状态为空" onRetry={() => void load()} />
      ) : (
        <>
          {data.envLocked ? (
            <div className="model-provider-env-lock" role="status">
              <code>MODEL_PROVIDER</code> 已由环境变量锁定；要切换请先删除该环境变量并重启。
            </div>
          ) : null}

          <div className="model-provider-grid" role="group" aria-label="模型厂商">
            {data.providers.map((provider) => {
              const checked = provider.id === selected;
              const current = provider.id === data.current.provider;
              const disabled = !provider.configured || data.envLocked || busy !== null;
              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`model-provider-card${checked ? ' is-selected' : ''}`}
                  aria-pressed={checked}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setSelected(provider.id);
                    setValidated(null);
                    setActionError(null);
                  }}
                >
                  <span className="model-provider-radio" aria-hidden="true" />
                  <span className="model-provider-body">
                    <span className="model-provider-title">
                      <strong>{provider.label}</strong>
                      {current ? <Badge tone="accent">当前</Badge> : null}
                      {!provider.configured ? <Badge tone="warn">未配置</Badge> : null}
                    </span>
                    <span className="model-provider-desc">
                      {provider.model} ·{' '}
                      {provider.id === 'deepseek' ? '流式主模型' : '非流式主模型'} · 工具调用
                    </span>
                    <span className="model-provider-meta">
                      {provider.configured
                        ? provider.id === 'ollama'
                          ? `已检测 · ${provider.baseUrl}`
                          : `已配置 · ${KEY_SOURCE_LABEL[provider.keySource]}`
                        : provider.note ?? '未配置'}
                    </span>
                  </span>
                  <span className="model-provider-state">
                    {current ? '已启用' : checked ? '待切换' : provider.configured ? '可切换' : '不可切换'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="model-provider-note">
            <strong>能力边界：</strong>
            DeepSeek 支持流式叙述；OpenAI 兼容与 Ollama 当前只支持非流式主模型，切换后叙述流会缺席。
            未配置的 provider 不可点；不存在“未配置却可切换”的假选项。
          </div>

          {validated !== null ? (
            <div className="model-provider-validation" role="status">
              ✓ 端点验证通过 · <code>{validated.model}</code> ·{' '}
              {(validated.latencyMs / 1000).toFixed(1)}s ·{' '}
              {validated.provider === 'deepseek' ? '流式' : '非流式'} · 切换后会重建运行时
            </div>
          ) : null}

          {actionError !== null ? <InlineError message={actionError} /> : null}

          <div className="model-provider-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canValidate}
              onClick={() => void validate()}
            >
              {busy === 'validate' ? '验证中…' : '验证所选端点'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSwitch}
              onClick={() => setConfirmOpen(true)}
            >
              {busy === 'switch' ? '切换中…' : '切换并重启模型'}
            </button>
            <span className="model-provider-hint">
              {validated !== null && validated.provider === selected && !isCurrent
                ? '验证通过，可以切换；切换会重建运行时。'
                : isCurrent
                  ? '当前正在使用这个 provider。'
                  : '先验证，再切换；未验证的端点不会写入配置。'}
            </span>
          </div>
        </>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="切换模型 provider？"
        description="切换会重建运行时；正在执行的对话会被拒绝。"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void switchProvider()}>
              确认切换
            </button>
          </>
        }
      >
        <p className="model-provider-confirm">
          将从 <strong>{currentLabel}</strong> 切换到{' '}
          <strong>{selectedStatus?.label ?? '所选模型'}</strong>（{selectedStatus?.model ?? '—'}）。
          完成前不会写入配置；切换后本轮之后的请求使用新模型。
        </p>
      </Modal>
    </section>
  );
}
