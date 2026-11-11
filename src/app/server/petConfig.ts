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
export type PetDisplayMode = 'desktop' | 'web';
export type PetProactiveFrequency = 'rare' | 'normal' | 'often';

export interface PetProactiveScenarios {
  readonly lateNight: boolean;
  readonly longSession: boolean;
  readonly return: boolean;
}

export interface PetModelChoice {
  readonly profileId: string;
  readonly modelId: string;
  readonly label: string;
}

export interface PetConfig {
  readonly version: 1;
  /** 安装配置存在；不代表进程正在运行。 */
  readonly enabled: boolean;
  /**
   * 显示位置：
   * desktop = 独立桌面 Tk 进程
   * web     = Web 页面内嵌悬浮桌宠（不启动 Tk）
   */
  readonly displayMode: PetDisplayMode;
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
  /** 允许桌宠根据使用节奏主动说话；默认关闭，由用户在桌宠设置中开启。 */
  readonly proactiveEnabled: boolean;
  /** 主动说话的频率上限；只控制“能不能说”，不控制人格语气。 */
  readonly proactiveFrequency: PetProactiveFrequency;
  /** 安静时段（本地时间，HH:mm）；与 proactiveFrequency 一起由服务端判定。 */
  readonly quietStart: string;
  readonly quietEnd: string;
  /** 允许主动说话的触发场景。 */
  readonly proactiveScenarios: PetProactiveScenarios;
  /**
   * 服务端固定的宠物会话 id。
   * 桌宠和 Web 悬浮桌宠共用这一条；为空时由 /api/pet/session 创建。
   * 不由设置页直接编辑。
   */
  readonly sessionId: string | null;
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
  readonly displayMode?: PetDisplayMode;
  readonly autoStart?: boolean;
  readonly size?: number;
  readonly sprite?: string;
  readonly alwaysOnTop?: boolean;
  readonly model?: PetModelChoice | null;
  readonly thinkingLevel?: PetThinkingLevel;
  readonly persona?: string;
  readonly proactiveEnabled?: boolean;
  readonly proactiveFrequency?: PetProactiveFrequency;
  readonly quietStart?: string;
  readonly quietEnd?: string;
  readonly proactiveScenarios?: PetProactiveScenarios;
  /** 仅供服务端宠物会话端点使用；设置页不提交。 */
  readonly sessionId?: string | null;
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
    displayMode: 'desktop',
    autoStart: false,
    size: 220,
    sprite: 'butler',
    alwaysOnTop: true,
    model: null,
    thinkingLevel: 'default',
    persona: '',
    proactiveEnabled: false,
    proactiveFrequency: 'normal',
    quietStart: '22:30',
    quietEnd: '08:00',
    proactiveScenarios: { lateNight: true, longSession: true, return: true },
    sessionId: null,
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

function normalizeDisplayMode(value: unknown, fallback: PetDisplayMode): PetDisplayMode {
  return value === 'desktop' || value === 'web' ? value : fallback;
}

export function isPetProactiveFrequency(value: unknown): value is PetProactiveFrequency {
  return value === 'rare' || value === 'normal' || value === 'often';
}

function normalizeTime(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function normalizeScenarios(value: unknown, fallback: PetProactiveScenarios): PetProactiveScenarios {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  return {
    lateNight: bool(v['lateNight'], fallback.lateNight),
    longSession: bool(v['longSession'], fallback.longSession),
    return: bool(v['return'], fallback.return),
  };
}

function normalizeSessionId(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
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
    displayMode: normalizeDisplayMode(v['displayMode'], fallback.displayMode),
    autoStart: bool(v['autoStart'], fallback.autoStart),
    size: clampSize(v['size'], fallback.size),
    sprite,
    alwaysOnTop: bool(v['alwaysOnTop'], fallback.alwaysOnTop),
    model: normalizeModel(v['model']),
    thinkingLevel: normalizeThinking(v['thinkingLevel'], fallback.thinkingLevel),
    persona,
    proactiveEnabled: bool(v['proactiveEnabled'], fallback.proactiveEnabled),
    proactiveFrequency: isPetProactiveFrequency(v['proactiveFrequency'])
      ? v['proactiveFrequency']
      : fallback.proactiveFrequency,
    quietStart: normalizeTime(v['quietStart'], fallback.quietStart),
    quietEnd: normalizeTime(v['quietEnd'], fallback.quietEnd),
    proactiveScenarios: normalizeScenarios(v['proactiveScenarios'], fallback.proactiveScenarios),
    sessionId: normalizeSessionId(v['sessionId'], fallback.sessionId),
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

export function isPetDisplayMode(value: unknown): value is PetDisplayMode {
  return value === 'desktop' || value === 'web';
}
