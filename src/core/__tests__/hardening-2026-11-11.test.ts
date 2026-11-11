/**
 * 2026-11-11 加固回归（后端）
 *
 * 每一条都对应一次**实测复现**过的缺陷：
 *   · remove('.') 能删掉整个工作区根（实测 workspace 目录消失）
 *   · 连续失败 7 次后 confidence 变负（实测 -0.08）
 *   · 调度器超时后 handler 仍在跑，下一次 runNow 又起一份（实测并发 2）
 *   · `path: ""` 通过必填校验（实测 true）
 *   · `search_and_replace_files` 被判只读（实测 readOnly）
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../adapters/fs/node.js';
import { EventLog } from '../events/log.js';
import { FixedClock, SeededRandom } from '../ports/clock.js';
import { OperationMemoryStore } from '../memory/operations.js';
import { Scheduler } from '../schedule/scheduler.js';
import { validateArgs } from '../tools/validate.js';
import { inferTier } from '../mcp/types.js';

const T0 = 1_760_000_000_000;

describe('文件系统：不能删除工作区根', () => {
  it('remove(".") 被拒绝，工作区还在', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-fs-root-'));
    writeFileSync(join(root, 'a.txt'), 'x');
    const fsPort = new NodeFileSystem({ root });

    await expect(fsPort.remove('.', { recursive: true })).rejects.toThrow('工作区根目录');
    await expect(fsPort.remove('./', { recursive: true })).rejects.toThrow('工作区根目录');

    // 普通子目录仍然可删
    const sub = join(root, 'sub');
    await fsPort.mkdir('sub');
    await fsPort.remove(sub, { recursive: true });
  });
});

describe('操作记忆：置信度不会变负', () => {
  it('连续失败 7 次后仍 ≥ 0', () => {
    const log = new EventLog('s_conf_reg');
    const clock = new FixedClock(T0);
    const store = new OperationMemoryStore(log, clock, 'u1', new SeededRandom(1));
    for (let i = 0; i < 7; i++) {
      store.recordAttempt({
        task: '转 PDF',
        path: 'api',
        success: false,
        durationMs: 1000,
        failureReason: '弹窗',
      });
    }
    const confidence = store.all()[0]?.confidence ?? -1;
    expect(confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('调度器：超时后不允许再起一份', () => {
  it('handler 未结束时 runNow 返回 null，且只启动一次', async () => {
    const log = new EventLog('s_sched_reg');
    const clock = new FixedClock(T0);
    const sched = new Scheduler(log, clock, undefined, { taskTimeoutMs: 40 });
    let started = 0;
    let running = 0;
    let peak = 0;
    sched.register({
      kind: 'activityAggregate',
      handler: async () => {
        started += 1;
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 200));
        running -= 1;
        return { summary: 'ok' };
      },
    });

    await sched.runNow('activityAggregate'); // 超时返回
    const second = await sched.runNow('activityAggregate');
    expect(second).toBeNull();

    await new Promise((r) => setTimeout(r, 260));
    expect(started).toBe(1);
    expect(peak).toBe(1);
  });
});

describe('参数校验：空字符串算缺参', () => {
  it('path:"" 不通过 required', () => {
    const res = validateArgs(
      { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      { path: '' },
    );
    expect(res.ok).toBe(false);
  });

  it('非空字符串照常通过', () => {
    const res = validateArgs(
      { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      { path: 'a.txt' },
    );
    expect(res.ok).toBe(true);
  });
});

describe('MCP 工具分级：只读前缀不能掩盖写动作', () => {
  it('search_and_replace_files 不再是 readOnly', () => {
    expect(inferTier('search_and_replace_files').tier).not.toBe('readOnly');
  });

  it('真正的只读工具不被误伤', () => {
    for (const name of ['list_files', 'get_settings', 'get_updated_at', 'read_file']) {
      expect(inferTier(name).tier).toBe('readOnly');
    }
  });

  it('delete_all 仍是 dangerous', () => {
    expect(inferTier('delete_all').tier).toBe('dangerous');
  });
});
