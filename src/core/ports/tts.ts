/**
 * TTS 端口 —— 核心/服务端只依赖这个接口，不依赖具体厂商协议。
 *
 * ★ 对话消息的「朗读」和设置页的试听都走同一端口。
 * ★ 不在这里做鉴权、长度限制或缓存；那些属于 HTTP 路由/服务层。
 */
export type TtsFormat = 'mp3' | 'wav' | 'pcm';

export interface TtsRequest {
  readonly text: string;
  readonly voice: string;
  /** MiMo 等支持自然语言风格控制的供应商使用；其它适配器可忽略。 */
  readonly style?: string;
  readonly format: TtsFormat;
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

export interface TtsAudio {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly model: string;
}

export interface TtsPort {
  synthesize(request: TtsRequest): Promise<TtsAudio>;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'auth' | 'network' | 'bad_output' | 'aborted' | 'unknown',
  ) {
    super(message);
    this.name = 'TtsError';
  }
}
