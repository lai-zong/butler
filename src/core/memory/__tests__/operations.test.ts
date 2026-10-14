/**
 * 记忆化执行测试
 *
 * ★ 这个模块要证明方案里那句差异化主张**真的成立**：
 *   "竞品是无状态的 —— 每次任务都从零判断该用什么方法。
 *    本项目有记忆 —— 同一个任务做得越多越快越准。"
 *
 *   具体到可验证的形式：
 *     第 1 次：试 UI 失败 → 试 COM 成功
 *     第 5 次：**直接推荐 COM**
 */

import { describe, expect, it } from 'vitest';

import { EventLog } from '../../events/log.js';
import { FixedClock, SeededRandom } from '../../ports/clock.js';
import {
  GIVE_UP_AFTER_FAILURES,
  OperationMemoryStore,
  PATH_PRIOR,
  successRate,
  summarizeOperation,
} from '../operations.js';
import { PATH_LABEL, sameTaskKind, taskSignature } from '../operation.js';

const T0 = 1_760_000_000_000;
const USER = 'u_op';

function setup() {
  const log = new EventLog('s_op');
  const clock = new FixedClock(T0);
  const store = new OperationMemoryStore(log, clock, USER, new SeededRandom(7));
  return { log, clock, store };
}

// ═══════════════════════════════════════════════════════════
// ① 任务签名
// ═══════════════════════════════════════════════════════════

describe('① 任务签名 · 跨表述稳定', () => {
  it('★ 同一任务的不同说法得到同一签名', () => {
    const a = taskSignature({ task: '给 Excel 加一列', app: 'excel' });
    const b = taskSignature({ task: '在 Excel 里插入一列', app: 'excel' });
    const c = taskSignature({ task: 'Excel 新增一列', app: 'excel' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('能自动从文本里识别常见应用', () => {
    const s = taskSignature({ task: '给 Excel 加一列' });
    expect(s).toContain('excel');
  });

  it('不同任务得到不同签名', () => {
    const add = taskSignature({ task: '给表格加一列' });
    const del = taskSignature({ task: '删除表格里的空行' });
    expect(add).not.toBe(del);
  });

  it('签名包含动作与对象两个可比较部分', () => {
    const s = taskSignature({ task: '导出成 PDF' });
    expect(s.split('|').length).toBeGreaterThanOrEqual(2);
  });

  it('sameTaskKind 判定同类（应用可以不同）', () => {
    const a = taskSignature({ task: '加一列', app: 'excel' });
    const b = taskSignature({ task: '加一列', app: 'wps' });
    // 同一个操作方法常跨应用通用，所以应用不同仍算同类
    expect(sameTaskKind(a, b)).toBe(true);
  });

  it('动作不同则不同类', () => {
    const a = taskSignature({ task: '加一列' });
    const b = taskSignature({ task: '删除一列' });
    expect(sameTaskKind(a, b)).toBe(false);
  });

  it('空文本不崩溃', () => {
    expect(() => taskSignature({ task: '' })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// ② ★ 核心主张：越做越准
// ═══════════════════════════════════════════════════════════

describe('② ★ 同一个任务做得越多越快越准', () => {
  it('★ 第 1 次：无历史，按先验排序（api 优先）', () => {
    const { store } = setup();
    const r = store.recommend({ task: '给 Excel 加一列', app: 'excel' });

    expect(r.usedMemory).toBe(false);
    expect(r.ranked[0]?.path).toBe('api');
    expect(r.ranked[0]?.why).toContain('尚无');
    expect(r.ranked[0]?.fromExperience).toBe(false);
  });

  it('★ 记录"UI 失败、COM 成功"后，推荐顺序改变', () => {
    const { store } = setup();

    // 第 1 次：试 UIA 失败
    store.recordAttempt({
      task: '给 Excel 加一列',
      app: 'excel',
      path: 'uia',
      success: false,
      durationMs: 3200,
      failureReason: '找不到"插入列"按钮（界面版本不同）',
    });
    // 改用 COM 成功
    store.recordAttempt({
      task: '给 Excel 加一列',
      app: 'excel',
      path: 'api',
      success: true,
      durationMs: 210,
      method: '用 COM 的 Columns.Add()',
    });

    const r = store.recommend({ task: '给 Excel 加一列', app: 'excel' });

    expect(r.usedMemory).toBe(true);
    // ★ 现在 api 排第一，且理由是历史数据
    expect(r.ranked[0]?.path).toBe('api');
    expect(r.ranked[0]?.fromExperience).toBe(true);
    expect(r.ranked[0]?.why).toContain('成功 1 次');
    // uia 掉下去
    const uia = r.ranked.find((x) => x.path === 'uia');
    expect(uia?.score).toBeLessThan(r.ranked[0]!.score);
    expect(uia?.why).toContain('上次失败原因');
  });

  it('★ 多次成功后 api 的分数持续领先', () => {
    const { store } = setup();
    for (let i = 0; i < 5; i++) {
      store.recordAttempt({ task: '给 Excel 加一列', app: 'excel', path: 'api', success: true, durationMs: 200 });
    }
    store.recordAttempt({ task: '给 Excel 加一列', app: 'excel', path: 'uia', success: false, durationMs: 3000, failureReason: '元素找不到' });

    const r = store.recommend({ task: '给 Excel 加一列', app: 'excel' });
    expect(r.ranked[0]?.path).toBe('api');
    expect(r.ranked[0]?.why).toContain('尝试 5 次、成功 5 次');
  });

  it('耗时进理由（"这条路更快"是可解释的）', () => {
    const { store } = setup();
    store.recordAttempt({ task: '导出 PDF', path: 'cli', success: true, durationMs: 800 });
    const r = store.recommend({ task: '导出 PDF' });
    const cli = r.ranked.find((x) => x.path === 'cli');
    expect(cli?.why).toContain('平均耗时 800ms');
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 效果统计
// ═══════════════════════════════════════════════════════════

describe('③ 效果统计', () => {
  it('累加尝试与成功次数', () => {
    const { store } = setup();
    store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    const m = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 120 });
    expect(m.effectiveness?.attempts).toBe(2);
    expect(m.effectiveness?.succeeded).toBe(2);
    expect(successRate(m)).toBe(1);
  });

  it('失败记录原因，供下次规避', () => {
    const { store } = setup();
    const m = store.recordAttempt({
      task: '加一列',
      path: 'vision',
      success: false,
      durationMs: 4000,
      failureReason: 'DPI 缩放导致坐标偏移',
    });
    expect(m.effectiveness?.lastFailure).toContain('DPI');
    expect(m.effectiveness?.attempts).toBe(1);
    expect(m.effectiveness?.succeeded).toBe(0);
  });

  it('★ 平均耗时用 EMA 平滑（单次极端值只占 α 份额）', () => {
    const { store } = setup();
    // 先把均值稳定在 100 附近
    for (let i = 0; i < 20; i++) {
      store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    }
    const before = store.all()[0]?.effectiveness?.avgDurationMs ?? 0;
    expect(before).toBeCloseTo(100, 0);

    // 一次极慢的尝试
    const m = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 10000 });
    const after = m.effectiveness?.avgDurationMs ?? 0;

    // ★ EMA：跳升幅度约为 α × (10000 − 100) ≈ 1485，而不是直接跳到极端值
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(2000);
  });

  it('连续变慢后均值会收敛上去（EMA 不是"忽略"）', () => {
    const { store } = setup();
    for (let i = 0; i < 20; i++) {
      store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    }
    let last = 0;
    for (let i = 0; i < 40; i++) {
      const m = store.recordAttempt({
        task: '加一列',
        path: 'api',
        success: true,
        durationMs: 10000,
      });
      last = m.effectiveness?.avgDurationMs ?? 0;
    }
    // 长期变慢后均值应当接近新水平 —— 平滑不等于迟钝
    expect(last).toBeGreaterThan(8000);
  });

  it('★ 首次记录置信度不高（一次成功不足以证明永远可行）', () => {
    const { store } = setup();
    const m = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    expect(m.confidence).toBeLessThanOrEqual(0.5);
  });

  it('置信度有上限（做过 100 次也不是"绝对真理"）', () => {
    const { store } = setup();
    let last = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    for (let i = 0; i < 50; i++) {
      last = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    }
    expect(last.confidence).toBeLessThanOrEqual(0.95);
  });

  it('失败会降低置信度', () => {
    const { store } = setup();
    store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    const m = store.recordAttempt({ task: '加一列', path: 'api', success: false, durationMs: 200, failureReason: 'x' });
    expect(m.confidence).toBeLessThan(0.5);
  });

  it('每次尝试落事件（可审计）', () => {
    const { store, log } = setup();
    store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    const ev = log.byType('fitness.updated');
    expect(ev.length).toBeGreaterThan(0);
    expect((ev[0]?.payload as { kind?: string }).kind).toBe('operation');
  });
});

// ═══════════════════════════════════════════════════════════
// ④ ★ 不能无条件相信记忆
// ═══════════════════════════════════════════════════════════

describe('④ ★ 记忆不是绝对真理', () => {
  it('★ 反复失败的路径被提示放弃（而不是无限重试）', () => {
    const { store } = setup();
    for (let i = 0; i < GIVE_UP_AFTER_FAILURES; i++) {
      store.recordAttempt({
        task: '加一列',
        path: 'vision',
        success: false,
        durationMs: 5000,
        failureReason: '坐标偏移',
      });
    }

    const r = store.recommend({ task: '加一列' });
    expect(r.discouraged).toContain('vision');
    const v = r.ranked.find((x) => x.path === 'vision');
    expect(v?.adviseGivingUp).toBe(true);
    expect(v?.why).toContain('建议放弃');
  });

  it('★ 失败路径仍然在列表里（环境可能变了，不能永久排除）', () => {
    const { store } = setup();
    for (let i = 0; i < 5; i++) {
      store.recordAttempt({ task: '加一列', path: 'uia', success: false, durationMs: 3000, failureReason: 'x' });
    }
    const r = store.recommend({ task: '加一列' });
    // 仍然排在列表里，只是靠后且被提示
    expect(r.ranked.some((x) => x.path === 'uia')).toBe(true);
  });

  it('★ 失败后成功，分数会回升（记忆可被修正）', () => {
    const { store } = setup();
    for (let i = 0; i < 3; i++) {
      store.recordAttempt({ task: '加一列', path: 'uia', success: false, durationMs: 3000, failureReason: 'x' });
    }
    const before = store.recommend({ task: '加一列' }).ranked.find((x) => x.path === 'uia');
    if (!before) throw new Error('missing');

    // 环境变了，现在能用了
    for (let i = 0; i < 4; i++) {
      store.recordAttempt({ task: '加一列', path: 'uia', success: true, durationMs: 900 });
    }
    const after = store.recommend({ task: '加一列' }).ranked.find((x) => x.path === 'uia');
    if (!after) throw new Error('missing');

    expect(after.score).toBeGreaterThan(before.score);
    expect(after.adviseGivingUp).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 偏好与环境记忆
// ═══════════════════════════════════════════════════════════

describe('⑤ 偏好与环境记忆', () => {
  it('记录用户偏好', () => {
    const { store } = setup();
    const m = store.recordPreference({
      content: '删除文件前先确认',
      taskLabel: '删除文件',
      evidence: '用户三次在删除前手动确认',
    });
    expect(m.kind).toBe('preference');
    expect(m.content).toContain('确认');
  });

  it('记录环境事实', () => {
    const { store } = setup();
    const m = store.recordEnvironment({
      content: 'Python 装在 D:\\Python311',
      taskLabel: '运行 Python 脚本',
    });
    expect(m.kind).toBe('environment');
  });

  it('★ 环境记忆与任务无关时也应注入（它对任何任务都成立）', () => {
    const { store } = setup();
    store.recordEnvironment({ content: '显示器缩放 150%，坐标点击需换算', taskLabel: '界面操作' });
    const guidance = store.relevantGuidance({ task: '给 Excel 加一列' });
    expect(guidance.some((g) => g.kind === 'environment')).toBe(true);
  });

  it('偏好记忆只在相关任务时注入', () => {
    const { store } = setup();
    store.recordPreference({ content: '删除前先确认', taskLabel: '删除文件' });
    store.recordPreference({ content: '导出用 PDF/A', taskLabel: '导出文档' });

    const forDelete = store.relevantGuidance({ task: '删除一个文件' });
    const forExport = store.relevantGuidance({ task: '导出文档' });

    expect(forDelete.some((g) => g.content.includes('确认'))).toBe(true);
    expect(forExport.some((g) => g.content.includes('PDF/A'))).toBe(true);
  });

  it('方法记忆不出现在 guidance 里（它走 recommend 那条路径）', () => {
    const { store } = setup();
    store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    const guidance = store.relevantGuidance({ task: '加一列' });
    expect(guidance.every((g) => g.kind !== 'method')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 路径先验与展示
// ═══════════════════════════════════════════════════════════

describe('⑥ 路径先验', () => {
  it('★ 先验顺序与方案 § 6.1 的三层模型一致', () => {
    expect(PATH_PRIOR.api).toBeGreaterThan(PATH_PRIOR.uia);
    expect(PATH_PRIOR.uia).toBeGreaterThan(PATH_PRIOR.vision);
    expect(PATH_PRIOR.vision).toBeGreaterThan(PATH_PRIOR.manual);
    expect(PATH_PRIOR.cli).toBeGreaterThan(PATH_PRIOR.uia);
  });

  it('每条路径都有中文标签', () => {
    for (const label of Object.values(PATH_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('摘要可读（界面展示用）', () => {
    const { store } = setup();
    store.recordAttempt({ task: '给 Excel 加一列', app: 'excel', path: 'api', success: true, durationMs: 200 });
    const m = store.all()[0];
    if (!m) throw new Error('missing');
    const s = summarizeOperation(m);
    expect(s).toContain('加一列');
    expect(s).toContain('应用接口');
    expect(s).toContain('100%');
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ 可复现（ADR 0004）
// ═══════════════════════════════════════════════════════════

describe('⑦ 确定性', () => {
  it('同一批记录产生同一份推荐（可重放）', () => {
    const build = (): string => {
      const { store } = setup();
      store.recordAttempt({ task: '加一列', path: 'uia', success: false, durationMs: 3000, failureReason: 'x' });
      store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 200 });
      return store.recommend({ task: '加一列' }).ranked.map((r) => `${r.path}:${r.score.toFixed(4)}`).join(',');
    };
    expect(build()).toBe(build());
  });

  it('时间来自 ClockPort（不读 Date.now）', () => {
    const { store, clock } = setup();
    const m = store.recordAttempt({ task: '加一列', path: 'api', success: true, durationMs: 100 });
    expect(m.createdAt).toBe(clock.now());
  });
});
