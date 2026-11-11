/**
 * 桌宠主动说话状态。
 *
 * 与 pet-config.json 分开：配置是用户偏好；这里是“最近说过没有”和
 * “用户点了稍后”的运行状态，不能因为一次设置保存就被清空。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProactiveHistoryEntry, ProactiveTrigger } from '@/core/pet/proactive.js';
import { resolveDataDir } from './petConfig.js';

export const PET_PROACTIVE_STATE_FILE = 'pet-proactive.json';

export interface PetProactiveState {
  readonly history: readonly ProactiveHistoryEntry[];
  readonly suppressedUntil: number | null;
}

const EMPTY: PetProactiveState = { history: [], suppressedUntil: null };

export function petProactiveStatePath(dir = resolveDataDir()): string {
  return join(dir, PET_PROACTIVE_STATE_FILE);
}

function isTrigger(value: unknown): value is ProactiveTrigger {
  return value === 'late_night' || value === 'long_session' || value === 'return';
}

export async function loadPetProactiveState(
  dir = resolveDataDir(),
): Promise<PetProactiveState> {
  try {
    const raw = JSON.parse(
      await readFile(petProactiveStatePath(dir), 'utf8'),
    ) as Record<string, unknown>;
    const history = Array.isArray(raw['history'])
      ? raw['history']
          .filter(
            (x): x is { at: number; trigger: ProactiveTrigger } =>
              typeof x === 'object' &&
              x !== null &&
              typeof (x as Record<string, unknown>)['at'] === 'number' &&
              isTrigger((x as Record<string, unknown>)['trigger']),
          )
          .slice(-50)
      : [];
    return {
      history,
      suppressedUntil:
        typeof raw['suppressedUntil'] === 'number' ? raw['suppressedUntil'] : null,
    };
  } catch {
    return EMPTY;
  }
}

export async function savePetProactiveState(
  state: PetProactiveState,
  dir = resolveDataDir(),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = petProactiveStatePath(dir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(
    temp,
    `${JSON.stringify(
      {
        history: state.history.slice(-50),
        suppressedUntil: state.suppressedUntil,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await rename(temp, target);
}
