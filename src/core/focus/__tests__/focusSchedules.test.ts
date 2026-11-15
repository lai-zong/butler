import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FixedClock } from '@/core/ports/clock.js';

import { FocusScheduleService } from '../service.js';
import { loadFocusSchedules } from '../store.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-focus-schedule-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function at(hour: number, minute = 0): number {
  return new Date(2026, 0, 1, hour, minute, 0, 0).getTime();
}

describe('专注日程', () => {
  it('创建、排序、设当前、更新、删除并持久化', async () => {
    const dir = await tempDir();
    const clock = new FixedClock(at(8));
    const service = new FocusScheduleService(dir, clock);

    const later = await service.create({
      title: '  写周报  ',
      note: '  留一点时间给下周。  ',
      startAt: at(15),
      endAt: at(16),
      remind: true,
    });
    const earlier = await service.create({
      title: '整理素材',
      startAt: at(9),
      endAt: at(10),
    });

    expect(later.currentId).toBeNull();
    expect(earlier.schedules.map((item) => item.title)).toEqual(['整理素材', '写周报']);
    expect(earlier.schedules.find((item) => item.title === '写周报')?.note).toBe(
      '留一点时间给下周。',
    );
    expect(earlier.schedules.find((item) => item.title === '写周报')?.remind).toBe(true);

    const target = earlier.schedules.find((item) => item.title === '写周报');
    if (target === undefined) throw new Error('missing created schedule');

    const selected = await service.setCurrent(target.id);
    expect(selected.currentId).toBe(target.id);

    clock.advance(60_000);
    const updated = await service.update(target.id, {
      title: '写周报（二稿）',
      startAt: at(14),
      endAt: at(15),
    });
    const changed = updated.schedules.find((item) => item.id === target.id);
    expect(changed?.title).toBe('写周报（二稿）');
    expect(changed?.updatedAt).toBe(at(8, 1));

    const removed = await service.remove(target.id);
    expect(removed.currentId).toBeNull();
    expect(removed.schedules.map((item) => item.title)).toEqual(['整理素材']);

    const persisted = await loadFocusSchedules(dir);
    expect(persisted.version).toBe(1);
    expect(persisted.currentId).toBeNull();
    expect(persisted.schedules.map((item) => item.title)).toEqual(['整理素材']);
  });

  it('拒绝空标题、非法时间和不存在的 id', async () => {
    const dir = await tempDir();
    const service = new FocusScheduleService(dir, new FixedClock(at(8)));

    await expect(
      service.create({ title: '   ', startAt: at(9), endAt: at(10) }),
    ).rejects.toThrow('日程标题不能为空');
    await expect(
      service.create({ title: '反向时间', startAt: at(10), endAt: at(9) }),
    ).rejects.toThrow('结束时间必须晚于开始时间');
    await expect(
      service.create({ title: '相同时间', startAt: at(10), endAt: at(10) }),
    ).rejects.toThrow('结束时间必须晚于开始时间');

    const state = await service.create({ title: '正常', startAt: at(9), endAt: at(10) });
    const id = state.schedules[0]?.id;
    if (id === undefined) throw new Error('missing created schedule');

    await expect(service.update('focus_missing', { title: '不存在' })).rejects.toThrow(
      '找不到这条日程',
    );
    await expect(service.remove('focus_missing')).rejects.toThrow('找不到这条日程');
    await expect(service.setCurrent('focus_missing')).rejects.toThrow('找不到这条日程');
    await expect(service.update(id, { title: '   ' })).rejects.toThrow('日程标题不能为空');
  });
});
