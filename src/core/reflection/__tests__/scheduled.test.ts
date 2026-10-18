/**
 * 定时反思测试
 *
 * ★ 重点验三件事（都是"会出错但不容易发现"的地方）：
 *   ① **时间窗过滤**：每日只看 24 小时，前天的不该混进来
 *   ② **领域隔离**：每日反思按领域分组，每个领域只喂自己的材料
 *   ③ **候选必须过审**：定时产出的候选不能因为"系统自己跑的"就自动生效
 */
import { describe, expect, it } from 'vitest';

import { collectRecentReports, reflectScheduled, windowMsFor } from '../scheduled.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore, type ExecutionReportData } from '../../chat/types.js';
import type { ModelPort } from '../../ports/model.js';

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** 假模型：返回一条候选，并记下喂进去的提示词（用于断言领域隔离） */
function fakeModel(seen: string[] = []): ModelPort {
  return {
    capability: () => ({ supportsVision: false, supportsThinking: false }),
    complete: async () => {
      throw new Error('定时反思应当走 completeStructured');
    },
    completeStructured: async (args: { messages: readonly unknown[] }) => {
      seen.push(JSON.stringify(args.messages));
      return {
        value: {
          candidates: [
            {
              kind: 'fact',
              content: '这是一条来自定时反思的候选',
              confidence: 0.6,
              evidence: ['ev_1'],
              rationale: '测试用',
              memClass: 'global_shared',
            },
          ],
          collaborationIssues: [],
          rhythmChanges: [],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  } as unknown as ModelPort;
}

function setup() {
  const log = new EventLog('s_reflect');
  const clock = new FixedClock(T0);
  const store = new MemoryStore(log, clock, 'local');
  const chat = new SessionStore(log, clock, 'local');

  /**
   * 造一条带执行汇报的助手消息。
   *
   * ⚠️ `appendMessage` 不接受 `createdAt`（时间由 clock 给），
   *    所以用 `clock.advance()` 控制"消息发生在什么时候"。
   */
  const seed = (opts: { at: number; domain: string; reply: string; taskId: string }): void => {
    clock.advance(opts.at - clock.now());
    const session = chat.latestOrCreate();
    const report: ExecutionReportData = {
      servant: opts.domain,
      taskId: opts.taskId,
      status: 'done',
      reply: opts.reply,
      instruction: '',
      artifacts: [],
      findings: [],
      uncertainties: [],
      injectedConstraints: [],
    };
    chat.appendMessage(session.id, {
      role: 'butler',
      text: opts.reply,
      status: 'done',
      servantReports: [report],
    });
  };

  return { log, clock, store, chat, seed };
}

describe('collectRecentReports —— 时间窗与领域', () => {
  it('★ 只收时间窗内的汇报', () => {
    const { chat, seed, clock } = setup();
    seed({ at: T0 - 2 * DAY, domain: 'health', reply: '前天的事', taskId: 't2' });
    seed({ at: T0 - 1000, domain: 'health', reply: '今天做了体检', taskId: 't1' });

    const got = collectRecentReports({ chat, now: clock.now(), since: clock.now() - DAY });
    expect(got).toHaveLength(1);
    expect(got[0]?.taskId).toBe('t1');
    expect(got[0]?.summary).toBe('今天做了体检');
  });

  it('★★ 判不出领域的汇报被丢弃（不硬塞默认领域）', () => {
    const { chat, seed, clock } = setup();
    seed({ at: T0 - 1000, domain: 'not-a-domain', reply: 'x', taskId: 't1' });
    const got = collectRecentReports({ chat, now: clock.now(), since: clock.now() - DAY });
    expect(got).toHaveLength(0);
  });

  it('窗口长度：每日 1 天、每周 7 天', () => {
    expect(windowMsFor('daily')).toBe(DAY);
    expect(windowMsFor('weekly')).toBe(7 * DAY);
  });
});

describe('★★★ reflectScheduled', () => {
  it('★ 没有材料 → 直接跳过，不调模型', async () => {
    const { log, clock, store, chat } = setup();
    const seen: string[] = [];
    const model = fakeModel(seen);

    const r = await reflectScheduled({ scope: 'daily', model, log, clock, store, chat, userId: 'local' });
    expect(r.candidateCount).toBe(0);
    expect(r.summary).toContain('没有执行记录');
    expect(seen).toHaveLength(0);
  });

  it('★★ daily 按领域分组 —— 每个领域只看到自己的材料', async () => {
    const { log, clock, store, chat, seed } = setup();
    seed({ at: T0 - 2000, domain: 'study', reply: '学习任务B', taskId: 't2' });
    seed({ at: T0 - 1000, domain: 'health', reply: '健康任务A', taskId: 't1' });

    const seen: string[] = [];
    const r = await reflectScheduled({
      scope: 'daily',
      model: fakeModel(seen),
      log,
      clock,
      store,
      chat,
      userId: 'local',
    });

    // 两个领域 → 两次反思
    expect(seen.length).toBe(2);
    // ★ 隔离：喂给 health 的那次里不该出现 study 的材料
    const healthCall = seen.find((s) => s.includes('健康任务A'));
    expect(healthCall).toBeDefined();
    expect(healthCall).not.toContain('学习任务B');
    expect(r.candidateCount).toBeGreaterThan(0);
  });

  it('★★ weekly 走跨领域复盘（一次调用涵盖全部材料）', async () => {
    const { log, clock, store, chat, seed } = setup();
    seed({ at: T0 - 2000, domain: 'study', reply: '学习任务B', taskId: 't2' });
    seed({ at: T0 - 1000, domain: 'health', reply: '健康任务A', taskId: 't1' });

    const seen: string[] = [];
    await reflectScheduled({
      scope: 'weekly',
      model: fakeModel(seen),
      log,
      clock,
      store,
      chat,
      userId: 'local',
    });
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('健康任务A');
    expect(seen[0]).toContain('学习任务B');
  });

  it('★★★ 定时产出的候选**必须过审**（不能自动生效）', async () => {
    const { log, clock, store, chat, seed } = setup();
    seed({ at: T0 - 1000, domain: 'health', reply: '做了体检', taskId: 't1' });

    await reflectScheduled({
      scope: 'daily',
      model: fakeModel(),
      log,
      clock,
      store,
      chat,
      userId: 'local',
    });

    const all = store.all();
    expect(all.length).toBeGreaterThan(0);
    // 至少一条处于候选态（需用户审核）
    expect(all.some((e) => e.lifecycle === 'candidate')).toBe(true);
    // 事件流里有"产生候选"的事件（可审计）
    expect(log.byType('memory.candidate').length).toBeGreaterThan(0);
  });

  it('★★★ 时间维度规律真的进了反思提示词（方案 §7.4）', async () => {
    /**
     * ⚠️ 改造前这里恒为空数组：周复盘算出的规律只进了界面与画像快照，
     *    **反思完全看不到** —— "时间维度画像"的意义就落空了。
     */
    const { log, clock, store, chat, seed } = setup();
    seed({ at: T0 - 1000, domain: 'health', reply: '做了体检', taskId: 't1' });

    const seen: string[] = [];
    await reflectScheduled({
      scope: 'weekly',
      model: fakeModel(seen),
      log,
      clock,
      store,
      chat,
      userId: 'local',
      temporalPatterns: ['工作日 9—18 通常较忙', '晚上 21 点后偏学习'],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('工作日 9—18 通常较忙');
    expect(seen[0]).toContain('晚上 21 点后偏学习');
  });
});
