/**
 * MiMo TTS 适配器。
 *
 * ⚠️ MiMo 的 TTS 虽然标称 “OpenAI API 兼容”，但实际端点是
 *    /v1/chat/completions：user 放风格指令，assistant 放待朗读文本，
 *    audio 参数选择格式和预置音色。它不是 /v1/audio/speech。
 *
 * 第一版只支持预置音色；voicedesign / voiceclone 不在当前范围。
 */
import type { TtsAudio, TtsFormat, TtsPort, TtsRequest } from '../../core/ports/tts.js';
import { TtsError } from '../../core/ports/tts.js';

export interface MimoTtsConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

const CONTENT_TYPE: Record<TtsFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

function decodeAudio(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record['choices']) ? record['choices'] : [];
  const first = typeof choices[0] === 'object' && choices[0] !== null
    ? (choices[0] as Record<string, unknown>)
    : null;
  const message = first !== null && typeof first['message'] === 'object' && first['message'] !== null
    ? (first['message'] as Record<string, unknown>)
    : null;
  const candidates = [
    message?.['audio'],
    first?.['audio'],
    record['audio'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const data = (candidate as Record<string, unknown>)['data'];
    if (typeof data === 'string' && data.length > 0) return data;
  }
  return null;
}

export class MimoTts implements TtsPort {
  constructor(private readonly config: MimoTtsConfig) {}

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(endpoint(this.config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(request.style !== undefined && request.style.trim().length > 0
              ? [{ role: 'user', content: request.style.trim() }]
              : []),
            { role: 'assistant', content: request.text },
          ],
          audio: {
            format: request.format,
            voice: request.voice,
          },
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (err) {
      if (request.signal?.aborted === true) throw new TtsError('朗读已取消', 'aborted');
      throw new TtsError(`MiMo 语音服务连接失败：${err instanceof Error ? err.message : String(err)}`, 'network');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const code = res.status === 401 || res.status === 403 ? 'auth' : 'bad_output';
      throw new TtsError(`MiMo 语音服务返回 HTTP ${res.status}${detail.length > 0 ? `：${detail.slice(0, 300)}` : ''}`, code);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new TtsError('MiMo 语音服务没有返回合法 JSON', 'bad_output');
    }
    const base64 = decodeAudio(payload);
    if (base64 === null) {
      throw new TtsError('MiMo 语音服务没有返回音频数据', 'bad_output');
    }
    let audio: Uint8Array;
    try {
      audio = new Uint8Array(Buffer.from(base64, 'base64'));
    } catch {
      throw new TtsError('MiMo 返回的音频不是合法 base64', 'bad_output');
    }
    if (audio.byteLength === 0) throw new TtsError('MiMo 返回了空音频', 'bad_output');
    return {
      audio,
      contentType: CONTENT_TYPE[request.format],
      model: this.config.model,
    };
  }
}
