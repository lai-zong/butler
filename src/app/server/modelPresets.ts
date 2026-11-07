/**
 * 模型接入预设。
 *
 * 预设只负责预填连接信息，不锁定用户配置；KEY 仍由用户自己填写。
 * 这里不做“自动发现能力”——能力由用户在模型上显式勾选，避免静默失效。
 */
export type ModelPresetAdapter = 'deepseek' | 'openai' | 'ollama';
export type ModelPresetKind = 'chat' | 'embedding' | 'rerank';

export interface ModelPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: ModelPresetKind;
  readonly baseUrl: string;
  readonly adapter: ModelPresetAdapter;
  readonly requiresKey: boolean;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  // 国内
  { kind: 'chat', id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', adapter: 'deepseek', requiresKey: true },
  { kind: 'chat', id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'volcengine', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'hunyuan', label: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'qianfan', label: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'stepfun', label: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'baichuan', label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'lingyi', label: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'sensenova', label: '商汤日日新', baseUrl: 'https://api.sensenova.cn/compatible-mode/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'spark', label: '讯飞星火', baseUrl: 'https://spark-api-open.xf-yun.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'modelscope', label: 'ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'ppio', label: 'PPIO', baseUrl: 'https://api.ppinfra.com/v3/openai', adapter: 'openai', requiresKey: true },

  // 国际
  { kind: 'chat', id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'chat', id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', adapter: 'openai', requiresKey: true },

  // 本地与网关
  { kind: 'chat', id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', adapter: 'ollama', requiresKey: false },
  { kind: 'chat', id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', adapter: 'openai', requiresKey: false },
  { kind: 'chat', id: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', adapter: 'openai', requiresKey: false },
  { kind: 'chat', id: 'litellm', label: 'LiteLLM', baseUrl: 'http://127.0.0.1:4000/v1', adapter: 'openai', requiresKey: false },

  // 嵌入
  { kind: 'embedding', id: 'openai-embedding', label: 'OpenAI Embeddings', baseUrl: 'https://api.openai.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'embedding', id: 'dashscope-embedding', label: '阿里云百炼 Embeddings', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: 'openai', requiresKey: true },
  { kind: 'embedding', id: 'siliconflow-embedding', label: '硅基流动 Embeddings', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'openai', requiresKey: true },
  { kind: 'embedding', id: 'ollama-embedding', label: 'Ollama Embeddings', baseUrl: 'http://127.0.0.1:11434/v1', adapter: 'openai', requiresKey: false },

  // 重排：当前使用 OpenAI 兼容的 LLM 精排接口；不是专用 rerank HTTP 协议。
  { kind: 'rerank', id: 'custom-rerank-llm', label: '自定义 LLM 重排（OpenAI 兼容）', baseUrl: 'https://api.openai.com/v1', adapter: 'openai', requiresKey: true },
  { kind: 'rerank', id: 'ollama-rerank-llm', label: 'Ollama 本地 LLM 重排', baseUrl: 'http://127.0.0.1:11434/v1', adapter: 'ollama', requiresKey: false },
];

export function presetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
