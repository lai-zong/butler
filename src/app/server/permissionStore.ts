/** C5 权限模式的本地持久化（应用数据目录 settings.json）。 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PermissionMode } from '@/core/tools/types.js';

interface SettingsFile {
  readonly permissionMode?: PermissionMode;
}

export const SETTINGS_FILE = 'settings.json';

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'view' || v === 'workspace' || v === 'full';
}

export async function loadPermissionMode(dataDir: string): Promise<PermissionMode | undefined> {
  try {
    const raw = await readFile(join(dataDir, SETTINGS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as SettingsFile;
    return isPermissionMode(parsed.permissionMode) ? parsed.permissionMode : undefined;
  } catch {
    return undefined;
  }
}

export async function savePermissionMode(
  dataDir: string,
  mode: PermissionMode,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, SETTINGS_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify({ permissionMode: mode }, null, 2), 'utf8');
  await rename(temp, target);
}
