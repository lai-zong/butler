/**
 * 模型接入预设。
 *
 * 预设只负责预填连接信息，不锁定用户配置；KEY 仍由用户自己填写。
 * 这里不做“自动发现能力”——能力由用户在模型上显式勾选，避免静默失效。
 */
export type ModelPresetAdapter = 'deepseek' | 'openai' | 'ollama';

export interface ModelPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly adapter: ModelPresetAdapter;
  readonly requiresKey: boolean;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  // 国内
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', adapter: 'deepseek', requiresKey: true },
  { id: 'dashscope', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: 'openai', requiresKey: true },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'openai', requiresKey: true },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', adapter: 'openai', requiresKey: true },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'openai', requiresKey: true },
  { id: 'volcengine', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'openai', requiresKey: true },
  { id: 'hunyuan', label: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'qianfan', label: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', adapter: 'openai', requiresKey: true },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'stepfun', label: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'baichuan', label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'lingyi', label: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'sensenova', label: '商汤日日新', baseUrl: 'https://api.sensenova.cn/compatible-mode/v1', adapter: 'openai', requiresKey: true },
  { id: 'spark', label: '讯飞星火', baseUrl: 'https://spark-api-open.xf-yun.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'modelscope', label: 'ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1', adapter: 'openai', requiresKey: true },
  { id: 'ppio', label: 'PPIO', baseUrl: 'https://api.ppinfra.com/v3/openai', adapter: 'openai', requiresKey: true },

  // 国际
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', adapter: 'openai', requiresKey: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openai', requiresKey: true },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', adapter: 'openai', requiresKey: true },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', adapter: 'openai', requiresKey: true },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', adapter: 'openai', requiresKey: true },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', adapter: 'openai', requiresKey: true },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'openai', requiresKey: true },
  { id: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', adapter: 'openai', requiresKey: true },
  { id: 'nvidia', label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', adapter: 'openai', requiresKey: true },
  { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', adapter: 'openai', requiresKey: true },

  // 本地与网关
  { id: 'ollama', label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', adapter: 'ollama', requiresKey: false },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', adapter: 'openai', requiresKey: false },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', adapter: 'openai', requiresKey: false },
  { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://127.0.0.1:4000/v1', adapter: 'openai', requiresKey: false },
];

export function presetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
