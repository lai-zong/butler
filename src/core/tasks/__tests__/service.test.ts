import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@/core/ports/clock.js';
import { loadUserTasks } from '../store.js';
import { nextOccurrence } from '../schedule.js';
import { UserTaskService } from '../service.js';
import type { WorkTaskRunner } from '../types.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-user-task-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function at(hour: number, minute = 0, day = 1): number {
  return new Date(2026, 0, day, hour, minute, 0, 0).getTime();
}

describe('用户定时任务', () => {
  it('创建提醒、持久化、到期可见', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const service = new UserTaskService(dir, clock, async () => ({
      outcome: 'succeeded',
      summary: '不应被调用',
    }));
    const dueAt = at(9);
    const task = await service.create({
      kind: 'reminder',
      title: '带身份证',
      schedule: { repeat: 'once', dueAt, timeOfDay: null, weekday: null },
    });
    expect(task.permission).toBe('read-only');
    expect(task.nextRunAt).toBe(dueAt);
    expect((await service.list())[0]?.due).toBe(false);

    clock.advance(60 * 60_000);
    expect((await service.list())[0]?.due).toBe(true);
    expect((await loadUserTasks(dir))[0]?.title).toBe('带身份证');
  });

  it('完成提醒会停止再次到期', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const service = new UserTaskService(dir, clock, async () => ({
      outcome: 'succeeded',
      summary: 'x',
    }));
    const task = await service.create({
      kind: 'reminder',
      title: '提醒',
      schedule: { repeat: 'daily', dueAt: null, timeOfDay: '09:00', weekday: null },
    });
    const done = await service.complete(task.id);
    expect(done.status).toBe('completed');
    expect(done.nextRunAt).toBeNull();
    expect((await service.list())[0]?.due).toBe(false);
  });

  it('工作 tick 执行一次并记录结果', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const runner = vi.fn<WorkTaskRunner>(async () => ({
      outcome: 'succeeded',
      summary: '周报已生成',
    }));
    const service = new UserTaskService(dir, clock, runner);
    const task = await service.create({
      kind: 'work',
      title: '生成周报',
      instruction: '汇总本周内容',
      schedule: { repeat: 'once', dueAt: at(9), timeOfDay: null, weekday: null },
    });
    expect(task.permission).toBe('full');
    clock.advance(60 * 60_000);
    const ran = await service.tick();
    expect(ran).toEqual([task.id]);
    expect(runner).toHaveBeenCalledOnce();
    const saved = (await loadUserTasks(dir))[0]!;
    expect(saved.status).toBe('completed');
    expect(saved.lastOutcome).toBe('succeeded');
    expect(saved.lastSummary).toContain('周报');
  });

  it('重复工作执行后会推进到下一次', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const service = new UserTaskService(dir, clock, async () => ({
      outcome: 'succeeded',
      summary: 'ok',
    }));
    await service.create({
      kind: 'work',
      title: '每日汇总',
      instruction: '汇总',
      schedule: { repeat: 'daily', dueAt: null, timeOfDay: '09:00', weekday: null },
    });
    clock.advance(60 * 60_000);
    await service.tick();
    const saved = (await loadUserTasks(dir))[0]!;
    expect(saved.status).toBe('active');
    expect(saved.nextRunAt).toBeGreaterThan(clock.now());
  });

  it('工作失败仍写入可见错误', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const service = new UserTaskService(dir, clock, async () => ({
      outcome: 'failed',
      summary: '模型不可用',
    }));
    await service.create({
      kind: 'work',
      title: '失败任务',
      instruction: '做事',
      schedule: { repeat: 'once', dueAt: at(9), timeOfDay: null, weekday: null },
    });
    clock.advance(60 * 60_000);
    await service.tick();
    const saved = (await service.list())[0]!;
    expect(saved.lastOutcome).toBe('failed');
    expect(saved.lastError).toBe('模型不可用');
  });

  it('重复规则从下一次本地时间计算', () => {
    const next = nextOccurrence(
      { repeat: 'daily', dueAt: null, timeOfDay: '09:00', weekday: null },
      at(10),
    );
    expect(new Date(next!).getHours()).toBe(9);
    expect(new Date(next!).getDate()).toBe(2);
  });
});
