/**
 * OpenAI 兼容 /audio/speech 适配器。
 *
 * 适用于 OpenAI 以及确实公开相同协议的兼容网关。
 * MiMo 不使用这个协议，见 mimo.ts。
 */
import type { TtsAudio, TtsFormat, TtsPort, TtsRequest } from '../../core/ports/tts.js';
import { TtsError } from '../../core/ports/tts.js';

export interface OpenAiTtsConfig {
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
  return `${base}/audio/speech`;
}

export class OpenAiTts implements TtsPort {
  constructor(private readonly config: OpenAiTtsConfig) {}

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
          input: request.text,
          voice: request.voice,
          response_format: request.format === 'pcm' ? 'pcm' : request.format,
          ...(request.speed !== undefined ? { speed: request.speed } : {}),
        }),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } catch (err) {
      if (request.signal?.aborted === true) throw new TtsError('朗读已取消', 'aborted');
      throw new TtsError(`语音服务连接失败：${err instanceof Error ? err.message : String(err)}`, 'network');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const code = res.status === 401 || res.status === 403 ? 'auth' : 'bad_output';
      throw new TtsError(`语音服务返回 HTTP ${res.status}${detail.length > 0 ? `：${detail.slice(0, 300)}` : ''}`, code);
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength === 0) throw new TtsError('语音服务返回了空音频', 'bad_output');
    return {
      audio,
      contentType: res.headers.get('content-type')?.split(';')[0] ?? CONTENT_TYPE[request.format],
      model: this.config.model,
    };
  }
}
