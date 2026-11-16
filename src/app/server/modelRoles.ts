/**
 * 固定模型角色：记忆模型 / 重排模型。
 *
 * ★ 与“当前对话模型”分开存：
 *   - 对话模型是会话选择；
 *   - 记忆模型是长期记忆生成的固定角色，不跟随对话切换；
 *   - 重排模型只负责召回排序。
 *
 * 文件存储而不是塞进 model-profiles.json：模式不同，且角色为空必须
 * 如实表示“未配置”，不能静默回退到对话模型。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MODEL_ROLES_FILE = 'model-roles.json';

export interface ModelRoleSelection {
  readonly profileId: string;
  readonly modelId: string;
}

export interface TtsRole {
  readonly profileId: string;
  readonly modelId: string;
  readonly voice: string;
  readonly style: string;
  readonly format: 'mp3' | 'wav';
}

export interface ModelRoles {
  readonly version: 1;
  readonly memory: ModelRoleSelection | null;
  readonly rerank: ModelRoleSelection | null;
  readonly tts: TtsRole | null;
}

const EMPTY: ModelRoles = { version: 1, memory: null, rerank: null, tts: null };

function parseSelection(raw: unknown): ModelRoleSelection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v['profileId'] !== 'string' || typeof v['modelId'] !== 'string') return null;
  return { profileId: v['profileId'], modelId: v['modelId'] };
}

function parseTts(raw: unknown): TtsRole | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v['profileId'] !== 'string' || typeof v['modelId'] !== 'string') return null;
  const voice = typeof v['voice'] === 'string' ? v['voice'].trim() : '';
  if (voice.length === 0) return null;
  return {
    profileId: v['profileId'],
    modelId: v['modelId'],
    voice,
    style: typeof v['style'] === 'string' ? v['style'].slice(0, 500) : '',
    format: v['format'] === 'wav' ? 'wav' : 'mp3',
  };
}

export async function loadModelRoles(dataDir: string): Promise<ModelRoles> {
  try {
    const raw = await readFile(join(dataDir, MODEL_ROLES_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      version: 1,
      memory: parseSelection(parsed['memory']),
      rerank: parseSelection(parsed['rerank']),
      tts: parseTts(parsed['tts']),
    };
  } catch {
    return EMPTY;
  }
}

export async function saveModelRoles(dataDir: string, roles: ModelRoles): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, MODEL_ROLES_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      { version: 1, memory: roles.memory, rerank: roles.rerank, tts: roles.tts },
      null,
      2,
    ),
    'utf8',
  );
  await rename(tmp, file);
}
