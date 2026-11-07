/**
 * 桌宠配置 —— 独立于聊天/任务数据的用户偏好。
 *
 * ★ 为什么单独一个文件：
 *   桌宠是一个会在主界面之外独立运行的 Python 进程，它需要稳定读取
 *   “用哪张形象、多大、哪个模型、什么人格”；把这些混进 events.jsonl
 *   会让一个外观偏好也变成不可清理的聊天事件。
 *
 * ★ 位置状态（x/y、隐藏、当前 sessionId）由 Python 进程写 `pet-state.json`；
 *   这里只保存用户可编辑的配置，避免设置页与桌宠同时写同一个文件。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PET_CONFIG_FILE = 'pet-config.json';
export const PET_STATE_FILE = 'pet-state.json';

export type PetThinkingLevel = 'default' | 'low' | 'medium' | 'high';

export interface PetModelChoice {
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

export interface PetConfig {
  readonly version: 1;
  /** 安装配置存在；不代表进程正在运行。 */
  readonly enabled: boolean;
  /** 主应用启动时是否尝试拉起桌宠（第一版只记录，启动器后续接入）。 */
  readonly autoStart: boolean;
  /** 人物显示高度，120–480。 */
  readonly size: number;
  /** `public/pet/<sprite>/base.png` 的目录名。 */
  readonly sprite: string;
  readonly alwaysOnTop: boolean;
  /** 为空表示跟随主界面当前聊天模型。 */
  readonly model: PetModelChoice | null;
  readonly thinkingLevel: PetThinkingLevel;
  /** 只在桌宠会话使用的额外人格说明；空 = 默认管家。 */
  readonly persona: string;
  readonly updatedAt: number;
}

export interface PetAssetView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface PetConfigPayload {
  readonly ok: true;
  readonly config: PetConfig;
  readonly assets: readonly PetAssetView[];
}

export interface PetConfigUpdate {
  readonly enabled?: boolean;
  readonly autoStart?: boolean;
  readonly size?: number;
  readonly sprite?: string;
  readonly alwaysOnTop?: boolean;
  readonly model?: PetModelChoice | null;
  readonly thinkingLevel?: PetThinkingLevel;
  readonly persona?: string;
}

const MAX_PERSONA = 4000;
const SPRITE_LABEL: Record<string, string> = {
  butler: '管家',
};

export function resolveDataDir(): string {
  return process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
}

export function petConfigPath(dir = resolveDataDir()): string {
  return join(dir, PET_CONFIG_FILE);
}

export function petStatePath(dir = resolveDataDir()): string {
  return join(dir, PET_STATE_FILE);
}

export function petAssetsDir(): string {
  return join(process.cwd(), 'public', 'pet');
}

export function defaultPetConfig(now = Date.now()): PetConfig {
  return {
    version: 1,
    enabled: true,
    autoStart: false,
    size: 220,
    sprite: 'butler',
    alwaysOnTop: true,
    model: null,
    thinkingLevel: 'default',
    persona: '',
    updatedAt: now,
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(120, Math.min(480, Math.round(value)));
}

function normalizeModel(value: unknown): PetModelChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['profileId'] !== 'string' || typeof v['modelId'] !== 'string') return null;
  const profileId = v['profileId'].trim();
  const modelId = v['modelId'].trim();
  if (profileId.length === 0 || modelId.length === 0) return null;
  return {
    profileId,
    modelId,
    label: typeof v['label'] === 'string' && v['label'].trim().length > 0 ? v['label'] : modelId,
  };
}

function normalizeThinking(value: unknown, fallback: PetThinkingLevel): PetThinkingLevel {
  return value === 'default' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : fallback;
}

function normalize(raw: unknown, fallback: PetConfig, now: number): PetConfig {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const persona = typeof v['persona'] === 'string' ? v['persona'].slice(0, MAX_PERSONA) : fallback.persona;
  const sprite = typeof v['sprite'] === 'string' && v['sprite'].trim().length > 0
    ? v['sprite'].trim().slice(0, 80)
    : fallback.sprite;
  return {
    version: 1,
    enabled: bool(v['enabled'], fallback.enabled),
    autoStart: bool(v['autoStart'], fallback.autoStart),
    size: clampSize(v['size'], fallback.size),
    sprite,
    alwaysOnTop: bool(v['alwaysOnTop'], fallback.alwaysOnTop),
    model: normalizeModel(v['model']),
    thinkingLevel: normalizeThinking(v['thinkingLevel'], fallback.thinkingLevel),
    persona,
    updatedAt: now,
  };
}

/** 读取配置；文件不存在时返回默认值，不主动写盘。 */
export async function loadPetConfig(dir = resolveDataDir()): Promise<PetConfig> {
  try {
    const raw = await readFile(petConfigPath(dir), 'utf8');
    return normalize(JSON.parse(raw) as unknown, defaultPetConfig(), Date.now());
  } catch {
    return defaultPetConfig();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function savePetConfig(
  patch: PetConfigUpdate,
  dir = resolveDataDir(),
): Promise<PetConfig> {
  const current = await loadPetConfig(dir);
  const merged = normalize({ ...current, ...patch }, current, Date.now());
  await writeJsonAtomic(petConfigPath(dir), merged);
  return merged;
}

export async function listPetAssets(): Promise<readonly PetAssetView[]> {
  try {
    const entries = await readdir(petAssetsDir(), { withFileTypes: true });
    const assets: PetAssetView[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const info = await stat(join(petAssetsDir(), entry.name, 'base.png'));
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      assets.push({
        id: entry.name,
        label: SPRITE_LABEL[entry.name] ?? entry.name,
        url: `/pet/${encodeURIComponent(entry.name)}/base.png`,
      });
    }
    return assets.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export function isPetThinkingLevel(value: unknown): value is PetThinkingLevel {
  return value === 'default' || value === 'low' || value === 'medium' || value === 'high';
}
