/**
 * 桌宠进程的启动 / 状态。
 *
 * ★ 为什么由 Next API 启动：
 *   用户在设置页点“重新打开桌宠”时，不能再要求他去终端敲命令；
 *   但设置页也不能直接执行任意 shell —— 这里只允许固定的
 *   `scripts/desktop_pet.py`，并且由 Python 自己持有单实例锁。
 *
 * ★ 状态以 PID 文件为准，不靠“设置页内存里刚点过按钮”：
 *   桌宠可能从托盘退出、崩溃或被外部结束；PID 不存活就必须显示可重新启动。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadPetConfig, resolveDataDir } from './petConfig.js';

export const PET_PID_FILE = 'pet.pid';

export function petPidPath(dir = resolveDataDir()): string {
  return join(dir, PET_PID_FILE);
}

export function petScriptPath(): string {
  return join(process.cwd(), 'scripts', 'desktop_pet.py');
}

export interface PetRuntimeStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly script: string;
}

function readPidRaw(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function petRuntimeStatus(): Promise<PetRuntimeStatus> {
  const path = petPidPath();
  const pid = readPidRaw(path);
  const running = pid !== null && isAlive(pid);
  if (!running && existsSync(path)) {
    await rm(path, { force: true }).catch(() => undefined);
  }
  return { running, pid: running ? pid : null, script: petScriptPath() };
}

export interface PetLaunchResult {
  readonly ok: boolean;
  readonly alreadyRunning: boolean;
  readonly status: PetRuntimeStatus;
}

function pythonCommand(): string {
  const configured = process.env['BUTLER_PYTHON'];
  if (configured !== undefined && configured.trim().length > 0) return configured.trim();
  return process.platform === 'win32' ? 'pythonw' : 'python3';
}

/**
 * 异步等 Python 把 PID 文件写出来；不然设置页会闪一下“启动中”又显示未运行。
 */
async function waitForPid(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidRaw(petPidPath());
    if (pid !== null && isAlive(pid)) return pid;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return null;
}

export async function launchPet(): Promise<PetLaunchResult> {
  const config = await loadPetConfig();
  if (config.displayMode === 'web') {
    throw new Error('当前设置为 Web 界面显示；请先在设置中切回桌面显示');
  }

  const before = await petRuntimeStatus();
  if (before.running) return { ok: true, alreadyRunning: true, status: before };

  const dir = resolveDataDir();
  await mkdir(dir, { recursive: true });
  const script = petScriptPath();
  if (!existsSync(script)) {
    throw new Error(`找不到桌宠脚本：${script}`);
  }

  const baseUrl =
    process.env['BUTLER_URL']?.trim() ||
    `http://127.0.0.1:${process.env['PORT']?.trim() || '3000'}`;
  const child = spawn(pythonCommand(), [script], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      BUTLER_URL: baseUrl,
      BUTLER_DATA_DIR: dir,
    },
  });

  const spawnError = new Promise<Error | null>((resolve) => {
    child.once('error', (err) => resolve(err));
    child.once('spawn', () => resolve(null));
  });
  const error = await spawnError;
  if (error !== null) {
    throw new Error(`启动桌宠失败：${error.message}`);
  }
  child.unref();

  const pid = await waitForPid(8000);
  const status = await petRuntimeStatus();
  if (pid === null) {
    // 进程可能启动后立刻退出；把错误说清楚，而不是返回一个假成功。
    throw new Error('桌宠进程没有在预期时间内启动；请查看桌面/控制台错误，或确认 Python 可用');
  }
  return { ok: true, alreadyRunning: false, status };
}

/**
 * 停止桌面桌宠进程。
 *
 * 只结束 PID 文件指向的、且当前仍存活的进程；不会按进程名杀一堆 Python。
 * Web 模式切换/启动前需要它，避免两个界面同时存在。
 */
export async function stopPet(): Promise<PetRuntimeStatus> {
  const before = await petRuntimeStatus();
  if (!before.running || before.pid === null) return before;

  const pid = before.pid;
  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 进程可能刚好自己退出；以最终 PID 状态为准，不把竞态当失败。
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!isAlive(pid)) {
    await rm(petPidPath(), { force: true }).catch(() => undefined);
  }
  return petRuntimeStatus();
}

/** 仅用于测试/诊断：写一个 PID 文件但不启动进程。 */
export async function writePetPidForTest(pid: number, dir = resolveDataDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(petPidPath(dir), `${pid}\n`, 'utf8');
}
