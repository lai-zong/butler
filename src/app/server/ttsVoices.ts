/**
 * TTS 预置音色目录（第一版只做预置音色，不做音色设计/克隆）。
 * 供应商返回的 voice 字符串可能随账户/集群变化，因此 UI 允许手动覆盖。
 */
export interface TtsVoiceOption {
  readonly id: string;
  readonly label: string;
}

export const MIMO_TTS_VOICES: readonly TtsVoiceOption[] = [
  { id: 'mimo_default', label: 'MiMo 默认' },
  { id: '冰糖', label: '冰糖（中文女声）' },
  { id: '茉莉', label: '茉莉（中文女声）' },
  { id: '苏打', label: '苏打（中文男声）' },
  { id: '白桦', label: '白桦（中文男声）' },
  { id: 'Mia', label: 'Mia（英文女声）' },
  { id: 'Chloe', label: 'Chloe（英文女声）' },
  { id: 'Milo', label: 'Milo（英文男声）' },
  { id: 'Dean', label: 'Dean（英文男声）' },
];

export const OPENAI_TTS_VOICES: readonly TtsVoiceOption[] = [
  { id: 'alloy', label: 'Alloy' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'nova', label: 'Nova' },
  { id: 'shimmer', label: 'Shimmer' },
];

export function voicesForTtsPreset(presetId: string | undefined): readonly TtsVoiceOption[] {
  if (presetId === 'mimo-tts') return MIMO_TTS_VOICES;
  if (presetId === 'openai-tts' || presetId === 'openai-compatible-tts') return OPENAI_TTS_VOICES;
  return OPENAI_TTS_VOICES;
}

export const TTS_VOICES_BY_PRESET: Readonly<Record<string, readonly TtsVoiceOption[]>> = {
  'mimo-tts': MIMO_TTS_VOICES,
  'openai-tts': OPENAI_TTS_VOICES,
  'openai-compatible-tts': OPENAI_TTS_VOICES,
};
