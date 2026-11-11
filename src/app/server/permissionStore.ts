/** C5 权限模式 + 确认开关的本地持久化（应用数据目录 settings.json）。 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PermissionMode } from '@/core/tools/types.js';

interface SettingsFile {
  readonly permissionMode?: PermissionMode;
  readonly confirmActions?: boolean;
}

export interface PermissionSettings {
  readonly mode: PermissionMode | undefined;
  /** true=每次都问；false=按权限模式直接执行（dangerous 仍禁用）。 */
  readonly confirmActions: boolean;
}

export const SETTINGS_FILE = 'settings.json';
export const DEFAULT_CONFIRM_ACTIONS = true;

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'view' || v === 'workspace' || v === 'full';
}

export async function loadPermissionSettings(dataDir: string): Promise<PermissionSettings> {
  try {
    const raw = await readFile(join(dataDir, SETTINGS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as SettingsFile;
    return {
      mode: isPermissionMode(parsed.permissionMode) ? parsed.permissionMode : undefined,
      confirmActions:
        typeof parsed.confirmActions === 'boolean'
          ? parsed.confirmActions
          : DEFAULT_CONFIRM_ACTIONS,
    };
  } catch {
    return { mode: undefined, confirmActions: DEFAULT_CONFIRM_ACTIONS };
  }
}

export async function savePermissionSettings(
  dataDir: string,
  settings: PermissionSettings,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, SETTINGS_FILE);
  const temp = `${target}.tmp`;
  await writeFile(
    temp,
    JSON.stringify(
      {
        ...(settings.mode !== undefined ? { permissionMode: settings.mode } : {}),
        confirmActions: settings.confirmActions,
      },
      null,
      2,
    ),
    'utf8',
  );
  await rename(temp, target);
}

/** 兼容旧调用：只返回模式。 */
export async function loadPermissionMode(dataDir: string): Promise<PermissionMode | undefined> {
  return (await loadPermissionSettings(dataDir)).mode;
}

/** 兼容旧调用：只改模式，保留确认开关。 */
export async function savePermissionMode(dataDir: string, mode: PermissionMode): Promise<void> {
  const current = await loadPermissionSettings(dataDir);
  await savePermissionSettings(dataDir, { ...current, mode });
}
