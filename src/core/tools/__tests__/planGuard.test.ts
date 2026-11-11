import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../adapters/fs/memory.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { fileTools } from '../builtin/file.js';
import { createTaskPlanState, planTaskTool } from '../builtin/plan.js';
import { ToolFramework } from '../framework.js';
import type {
  ActionTier,
  Authorization,
  PermissionPolicy,
} from '../types.js';

const T0 = 1_760_000_000_000;

class AllowPolicy implements PermissionPolicy {
  isRemembered(): boolean {
    return true;
  }
  async ask(): Promise<Exclude<Authorization, 'blocked'>> {
    return 'allow';
  }
  isTierEnabled(_tier: ActionTier): boolean {
    return true;
  }
}

describe('plan_task 副作用门禁', () => {
  it('没有契约时拒绝写文件，调用 plan_task 后放行', async () => {
    const state = createTaskPlanState();
    const fs = new MemoryFileSystem({ now: T0 });
    const fw = new ToolFramework({
      log: new EventLog('s_plan_guard'),
      clock: new FixedClock(T0),
      policy: new AllowPolicy(),
      planGuard: () =>
        state.contract === null
          ? '需要先调用 plan_task'
          : null,
    });
    fw.registerAll(fileTools(fs));
    fw.register(planTaskTool(state));

    await expect(
      fw.execute({
        toolName: 'write_file',
        args: { path: 'a.txt', content: 'x' },
        taskId: 't1',
      }),
    ).rejects.toThrow('plan_task');

    const plan = planTaskTool(state);
    await plan.execute(
      {
        deliverable: '写入 a.txt',
        criteria: ['文件存在'],
        mustObey: [],
        domains: ['work'],
        confidence: 0.9,
      },
      undefined as never,
    );

    const r = await fw.execute({
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
      taskId: 't1',
    });
    expect(r.ok).toBe(true);
  });

  it('只读工具不需要契约', async () => {
    const fs = new MemoryFileSystem({ now: T0 });
    fs.seedFile('a.txt', 'ok');
    const fw = new ToolFramework({
      log: new EventLog('s_plan_read'),
      clock: new FixedClock(T0),
      policy: new AllowPolicy(),
      planGuard: () => '需要先调用 plan_task',
    });
    fw.registerAll(fileTools(fs));
    const r = await fw.execute({ toolName: 'read_file', args: { path: 'a.txt' }, taskId: 't1' });
    expect(r.output).toBe('ok');
  });
});
