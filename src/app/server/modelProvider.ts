/**
 * 模型厂商选择与配置解析（服务端）。
 *
 * 分工：
 *   · 这里只负责“当前用哪个 provider、从哪里取 Key、怎么构造适配器配置”；
 *   · 真正创建模型实例仍在 runtime.ts；
 *   · 不把 Key 返回给 HTTP/UI，也不写进事件流。
 *
 * 优先级（必须可解释）：
 *   1. 环境变量 MODEL_PROVIDER（显式锁定，UI 不允许切换）
 *   2. <DATA_DIR>/model-settings.json（UI 切换后持久化）
 *   3. 默认 deepseek
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ModelError, type ModelPort } from '@/core/ports/model.js';
import {
  DeepSeekModel,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  type DeepSeekConfig,
} from '@/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '@/adapters/model/openaiCompatible.js';
import { getCredentialVault } from './credentials.js';

export type ModelProviderId = 'deepseek' | 'openai' | 'ollama';

export interface ModelSelection {
  readonly provider: ModelProviderId;
  /** 可选：覆盖 provider 的默认模型。 */
  readonly model?: string;
}

export interface ProviderSpec {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly keyName: string;
  readonly modelEnv: string;
  readonly baseUrlEnv: string;
  readonly defaultModel: string;
  readonly defaultBaseUrl: string;
  readonly requiresKey: boolean;
}

export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyName: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    requiresKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    keyName: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    keyName: 'OLLAMA_API_KEY',
    modelEnv: 'OLLAMA_MODEL',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultModel: 'qwen3.5:4b',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
  },
];

export const MODEL_SETTINGS_FILE = 'model-settings.json';

export function isModelProviderId(v: unknown): v is ModelProviderId {
  return v === 'deepseek' || v === 'openai' || v === 'ollama';
}

export function specOf(provider: ModelProviderId): ProviderSpec {
  const spec = PROVIDER_SPECS.find((s) => s.id === provider);
  if (spec === undefined) throw new Error(`未知 provider：${provider}`);
  return spec;
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProviderId | undefined {
  const raw = env['MODEL_PROVIDER']?.trim().toLowerCase();
  return isModelProviderId(raw) ? raw : undefined;
}

/** 判断 MODEL_PROVIDER 是否显式锁定（哪怕值非法，也不让 UI 悄悄覆盖）。 */
export function isProviderEnvLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MODEL_PROVIDER'] !== undefined && env['MODEL_PROVIDER'].trim().length > 0;
}

export interface LoadedSelection {
  readonly selection: ModelSelection;
  readonly source: 'env' | 'file' | 'default';
  readonly envLocked: boolean;
}

export async function loadSelection(dataDir: string): Promise<LoadedSelection> {
  const envProvider = providerFromEnv();
  if (envProvider !== undefined) {
    return { selection: { provider: envProvider }, source: 'env', envLocked: true };
  }
  try {
    const raw = await readFile(join(dataDir, MODEL_SETTINGS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    if (isModelProviderId(parsed.provider)) {
      return {
        selection: {
          provider: parsed.provider,
          ...(typeof parsed.model === 'string' && parsed.model.trim().length > 0
            ? { model: parsed.model.trim() }
            : {}),
        },
        source: 'file',
        envLocked: false,
      };
    }
  } catch {
    // 没有配置文件 / 文件损坏：退回默认，不抛错。
  }
  return { selection: { provider: 'deepseek' }, source: 'default', envLocked: false };
}

export async function saveSelection(dataDir: string, selection: ModelSelection): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, MODEL_SETTINGS_FILE);
  const temp = `${target}.tmp`;
  const payload = {
    version: 1,
    provider: selection.provider,
    ...(selection.model !== undefined && selection.model.trim().length > 0
      ? { model: selection.model.trim() }
      : {}),
  };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export interface SecretSource {
  readonly key: string;
  readonly source: 'env' | 'vault' | 'none';
}

/**
 * 解析 Key：环境变量优先，其次本机保险库。
 * 对 Ollama，Key 不是必需的；用占位值满足 OpenAI 兼容客户端。
 */
export async function resolveSecret(provider: ModelProviderId): Promise<SecretSource> {
  const spec = specOf(provider);
  const fromEnv = process.env[spec.keyName]?.trim() ?? '';
  if (fromEnv.length > 0) return { key: fromEnv, source: 'env' };

  if (!spec.requiresKey) {
    return { key: 'ollama-local', source: 'none' };
  }

  try {
    const vault = await getCredentialVault();
    const metas = await vault.list();
    if (metas.some((m) => m.name === spec.keyName)) {
      const key = await vault.resolve(spec.keyName);
      if (key !== null && key.trim().length > 0) {
        return { key: key.trim(), source: 'vault' };
      }
    }
  } catch {
    // DPAPI/保险库不可用：当作未配置，由调用方给出明确错误。
  }
  return { key: '', source: 'none' };
}

export interface ProviderConfigResult {
  readonly config: DeepSeekConfig;
  readonly model: string;
  readonly baseUrl: string;
  readonly keySource: SecretSource['source'];
}

/** 构造指定 provider 的适配器配置；缺 Key 时抛 ModelError。 */
export async function buildProviderConfig(args: {
  readonly provider: ModelProviderId;
  readonly selection?: ModelSelection;
}): Promise<ProviderConfigResult> {
  const spec = specOf(args.provider);
  const secret = await resolveSecret(args.provider);
  if (spec.requiresKey && secret.key.length === 0) {
    throw new ModelError(
      `未配置 ${spec.keyName}；请在 .env.local 或本机凭证库中配置后再切换。`,
      'AUTH',
    );
  }
  const model =
    args.selection?.model?.trim() ||
    process.env[spec.modelEnv]?.trim() ||
    spec.defaultModel;
  const baseUrl =
    process.env[spec.baseUrlEnv]?.trim() || spec.defaultBaseUrl;
  return {
    config: {
      apiKey: secret.key,
      baseUrl,
      model,
      timeoutMs: Number(process.env['MODEL_TIMEOUT_MS'] ?? 90_000),
      maxStructuredRetries: 2,
      // 只有 DeepSeek 认 thinking / reasoning_effort 字段。
      thinkingParam: args.provider === 'deepseek',
    },
    model,
    baseUrl,
    keySource: secret.source,
  };
}

/** 按 provider 创建适配器；调用方负责校验配置与处理错误。 */
export function createProviderModel(provider: ModelProviderId, config: DeepSeekConfig): ModelPort {
  if (provider === 'deepseek') return new DeepSeekModel(config);
  return new OpenAICompatibleModel(
    config,
    provider === 'ollama' ? 'ollama' : 'openai-compatible',
  );
}

export interface ProviderStatus {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly configured: boolean;
  readonly keySource: SecretSource['source'];
  readonly model: string;
  readonly baseUrl: string;
  readonly note?: string;
}

/** 检查 Ollama 本地端点是否可达；不加载模型、不生成内容。 */
async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 各 provider 的“是否可切换”状态。
 * 只返回配置状态与模型名，不返回值。
 */
export async function listProviderStatuses(): Promise<readonly ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const spec of PROVIDER_SPECS) {
    const secret = await resolveSecret(spec.id);
    const model = process.env[spec.modelEnv]?.trim() || spec.defaultModel;
    const baseUrl = process.env[spec.baseUrlEnv]?.trim() || spec.defaultBaseUrl;
    if (spec.id === 'ollama') {
      const reachable = await ollamaReachable(baseUrl);
      out.push({
        id: spec.id,
        label: spec.label,
        configured: reachable,
        keySource: secret.source,
        model,
        baseUrl,
        ...(reachable ? {} : { note: '未检测到本地 Ollama 端点' }),
      });
      continue;
    }
    out.push({
      id: spec.id,
      label: spec.label,
      configured: secret.key.length > 0,
      keySource: secret.source,
      model,
      baseUrl,
      ...(secret.key.length > 0 ? {} : { note: `未配置 ${spec.keyName}` }),
    });
  }
  return out;
}
