'use client';

/**
 * 语音模型角色：选择一条 TTS 连接、模型、预置音色和朗读风格。
 * 第一版只做预置音色，不做音色设计/克隆。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, postJson } from '../lib/api.js';
import type { ToastMessage } from '../lib/types.js';

export interface TtsProfileModel {
  readonly id: string;
  readonly kind: string;
}

export interface TtsProfile {
  readonly id: string;
  readonly name: string;
  readonly presetId: string;
  readonly baseUrl: string;
  readonly models: readonly TtsProfileModel[];
}

export interface TtsRoleView {
  readonly profileId: string;
  readonly modelId: string;
  readonly voice: string;
  readonly style: string;
  readonly format: 'mp3' | 'wav';
}

interface TtsVoice {
  readonly id: string;
  readonly label: string;
}

interface Props {
  readonly profiles: readonly TtsProfile[];
  readonly role: TtsRoleView | null;
  readonly voices: readonly TtsVoice[];
  readonly voicesByPreset?: Readonly<Record<string, readonly TtsVoice[]>>;
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
  readonly onChanged: () => Promise<void>;
}

interface SaveResponse {
  readonly ok: boolean;
  readonly tts: TtsRoleView;
}

export function TtsSettingsSection({ profiles, role, voices, voicesByPreset, notify, onChanged }: Props): JSX.Element {
  const ttsModels = useMemo(
    () => profiles.flatMap((profile) =>
      profile.models
        .filter((model) => model.kind === 'tts')
        .map((model) => ({ profile, model })),
    ),
    [profiles],
  );
  const initial = role ?? (ttsModels[0] !== undefined
    ? {
        profileId: ttsModels[0].profile.id,
        modelId: ttsModels[0].model.id,
        voice: ttsModels[0].profile.presetId === 'mimo-tts' ? '冰糖' : 'alloy',
        style: '自然、清晰、稍慢地朗读',
        format: 'mp3' as const,
      }
    : null);
  const [profileId, setProfileId] = useState(initial?.profileId ?? '');
  const [modelId, setModelId] = useState(initial?.modelId ?? '');
  const [voice, setVoice] = useState(initial?.voice ?? '');
  const [style, setStyle] = useState(initial?.style ?? '自然、清晰、稍慢地朗读');
  const [format, setFormat] = useState<'mp3' | 'wav'>(initial?.format ?? 'mp3');
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testUrlRef = useRef<string | null>(null);

  function stopTestAudio(): void {
    const audio = testAudioRef.current;
    testAudioRef.current = null;
    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
    }
    if (testUrlRef.current !== null) {
      URL.revokeObjectURL(testUrlRef.current);
      testUrlRef.current = null;
    }
  }

  useEffect(() => () => stopTestAudio(), []);

  useEffect(() => {
    if (role === null) return;
    setProfileId(role.profileId);
    setModelId(role.modelId);
    setVoice(role.voice);
    setStyle(role.style);
    setFormat(role.format);
  }, [role]);

  // 配置可能在组件挂载后才创建完成：profile 列表从空变为有值时，
  // 必须把选择状态补到第一套 TTS 模型上；否则 select 显示配置名，
  // 但 modelId 仍为空，保存时只得到“先选择…模型”的错误。
  useEffect(() => {
    if (role !== null || ttsModels.length === 0) return;
    const current = ttsModels.find(
      (entry) => entry.profile.id === profileId && entry.model.id === modelId,
    );
    if (current !== undefined) return;
    const first = ttsModels[0]!;
    setProfileId(first.profile.id);
    setModelId(first.model.id);
    setVoice(first.profile.presetId === 'mimo-tts' ? '冰糖' : 'alloy');
    setFormat('mp3');
  }, [role, ttsModels, profileId, modelId]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const modelsForProfile = selectedProfile?.models.filter((m) => m.kind === 'tts') ?? [];
  const currentPreset = selectedProfile?.presetId;
  const suggestedVoices = currentPreset !== undefined ? voicesByPreset?.[currentPreset] ?? voices : voices;

  function pickProfile(nextId: string): void {
    const next = profiles.find((p) => p.id === nextId);
    const firstModel = next?.models.find((m) => m.kind === 'tts');
    setProfileId(nextId);
    setModelId(firstModel?.id ?? '');
    if (next?.presetId === 'mimo-tts') {
      setVoice('冰糖');
    } else if (next?.presetId === 'openai-tts' || next?.presetId === 'openai-compatible-tts') {
      setVoice('alloy');
    }
  }

  async function save(): Promise<boolean> {
    if (profileId.length === 0 || modelId.length === 0 || voice.trim().length === 0) {
      setError('先选择语音配置、模型和音色。');
      return false;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await postJson<SaveResponse>('/api/model', {
        action: 'set-tts',
        profileId,
        modelId,
        voice: voice.trim(),
        style: style.trim(),
        format,
      });
      notify('语音朗读配置已保存', 'success');
      setNotice('已保存。');
      await onChanged();
      if (res.tts.voice !== undefined) setVoice(res.tts.voice);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await postJson('/api/model', { action: 'clear-tts' });
      notify('已停用云端朗读，当前使用系统朗读', 'success');
      setNotice('已停用云端朗读，当前使用系统朗读。');
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    if (!(await save())) return;
    setTestBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好，这是当前语音配置的试听。' }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof payload?.error === 'string' ? payload.error : `试听失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      stopTestAudio();
      const url = URL.createObjectURL(blob);
      testUrlRef.current = url;
      const audio = new Audio(url);
      testAudioRef.current = audio;
      audio.onended = () => stopTestAudio();
      audio.onerror = () => {
        stopTestAudio();
        setError('试听音频无法播放。');
      };
      await audio.play();
    } catch (err) {
      stopTestAudio();
      setError(`试听失败：${errorMessage(err)}`);
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <section className="tts-role-card" aria-label="语音朗读配置">
      <div className="tts-role-head">
        <div>
          <span className="model-field-label">语音朗读</span>
          <p>对话消息的「朗读」会优先使用这里配置的云端 TTS；失败时回退系统朗读。</p>
        </div>
        <span className={`tts-role-state${role !== null ? ' is-ready' : ''}`}>
          {role !== null ? '云端已启用' : '云端未启用'}
        </span>
      </div>

      <p className={`tts-role-hint${role === null ? ' is-off' : ''}`}>
        {role === null
          ? '下面的连接、模型和音色只是预设，还没有启用云端朗读。点击「保存并启用云端朗读」后才会请求云端；当前会使用系统朗读。'
          : '云端朗读已启用。请求失败或音频无法播放时，会自动回退系统朗读。'}
      </p>

      {ttsModels.length === 0 ? (
        <p className="model-empty">还没有语音模型。先用上面的「新增配置」添加 MiMo TTS 或 OpenAI 兼容 TTS。</p>
      ) : (
        <>
          <div className="tts-role-fields">
            <label className="model-field">
              <span>语音配置</span>
              <select value={profileId} onChange={(event) => pickProfile(event.target.value)}>
                {profiles.filter((p) => p.models.some((m) => m.kind === 'tts')).map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
            <label className="model-field">
              <span>模型</span>
              <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {modelsForProfile.map((model) => (
                  <option key={model.id} value={model.id}>{model.id}</option>
                ))}
              </select>
            </label>
            <label className="model-field">
              <span>音色</span>
              <input
                list="tts-voice-options"
                value={voice}
                onChange={(event) => setVoice(event.target.value)}
                placeholder={currentPreset === 'mimo-tts' ? '冰糖' : 'alloy'}
              />
              <datalist id="tts-voice-options">
                {suggestedVoices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </datalist>
            </label>
            <label className="model-field">
              <span>格式</span>
              <select value={format} onChange={(event) => setFormat(event.target.value === 'wav' ? 'wav' : 'mp3')}>
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
              </select>
            </label>
          </div>
          <label className="model-field">
            <span>朗读风格（MiMo 等支持自然语言控制）</span>
            <input
              value={style}
              onChange={(event) => setStyle(event.target.value)}
              placeholder="自然、清晰、稍慢地朗读"
              maxLength={500}
            />
          </label>
          <div className="tts-role-actions">
            <button type="button" className="model-primary" disabled={busy || testBusy} onClick={() => void save()}>
              {busy ? '保存中…' : role === null ? '保存并启用云端朗读' : '保存朗读配置'}
            </button>
            <button type="button" className="model-ghost" disabled={busy || testBusy} onClick={() => void test()}>
              {testBusy ? '试听中…' : '试用当前配置'}
            </button>
            {role !== null ? (
              <button type="button" className="model-ghost" disabled={busy || testBusy} onClick={() => void disable()}>
                停用云端朗读
              </button>
            ) : null}
          </div>
        </>
      )}
      {error !== null && <p className="model-error">{error}</p>}
      {notice !== null && <p className="model-notice">{notice}</p>}
    </section>
  );
}
