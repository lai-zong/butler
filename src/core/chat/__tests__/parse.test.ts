/**
 * 持久化数据解析的测试
 *
 * ★★ 这个文件锁的是**一次真实崩溃**（有服务器日志与落盘数据为证）。
 *
 *   事故经过：
 *     ① 给仆人产出加了必填字段 `reply`（「对用户说的那段话」）
 *     ② 首页立刻 500：
 *          `Cannot read properties of undefined (reading 'length')`
 *          at `ServantPanel` → `cur.reply.length`
 *     ③ 查落盘数据：6 份仆人产出**全部没有 `reply` 字段**
 *        （旧代码写的，而新代码假设它一定在）
 *
 *   ⚠️ 根因不是"忘了改界面"，而是**恢复路径只信任、不校验**：
 *
 *     ```ts
 *     ...(Array.isArray(p['servantReports'])
 *       ? { servantReports: p['servantReports'] as ExecutionReportData[] }
 *       : {}),
 *     ```
 *
 *     只检查"是不是数组"，然后用 `as` 贴类型标签。
 *     数据里没有的字段，**类型系统再也不会管** ——
 *     断言是单向的：编译器相信你，运行时不。
 *
 * ★ 这类 bug 的特征是「**只在老用户身上出现**」：
 *   新装的机器永远复现不了（没有旧数据），
 *   而老用户一打开就崩 —— 最难查的一类。
 */

import { describe, expect, it } from 'vitest';

import { parseAgentTrace, parseExecutionReports } from '../parse.js';

/** 旧版本写下的仆人产出（**没有 `reply` 字段**）—— 就是崩溃时的那份数据。 */
const LEGACY_REPORT = {
  servant: 'life',
  taskId: 's1',
  status: 'done',
  instruction: '读取文件并照录原始清单',
  artifacts: [{ kind: 'list', text: '鸡蛋 5 个', itemCount: 5 }],
  findings: [{ kind: 'risk', statement: '有交叉污染风险', evidence: ['抹刀残留'] }],
  uncertainties: ['文件未标注保质期'],
  injectedConstraints: [{ content: '用户对花生严重过敏。', negotiable: false }],
};

describe('★ 旧数据（加 reply 之前写的）', () => {
  it('★ 不再崩溃 —— reply 缺字段时补空串', () => {
    const out = parseExecutionReports([LEGACY_REPORT]);
    expect(out).toBeDefined();
    expect(out?.[0]?.reply).toBe('');
  });

  it('★ 其余字段照常读出（不因为一个字段缺就整条丢弃）', () => {
    const out = parseExecutionReports([LEGACY_REPORT]);
    expect(out?.[0]?.servant).toBe('life');
    expect(out?.[0]?.artifacts[0]?.text).toBe('鸡蛋 5 个');
    expect(out?.[0]?.findings[0]?.evidence).toEqual(['抹刀残留']);
    expect(out?.[0]?.uncertainties).toEqual(['文件未标注保质期']);
  });

  it('⚠️ 不编假话 —— 缺 reply 就补空串，而不是「（无说明）」这类占位', () => {
    const out = parseExecutionReports([LEGACY_REPORT]);
    // 界面据空串走「这次没有留下说明」的兜底分支；
    // 若这里编一句假的，它会与模型真的说过的话混在一起，用户分不清
    expect(out?.[0]?.reply).toBe('');
  });
});

describe('★ 恶意 / 畸形数据（不可信输入）', () => {
  it('不是数组 → undefined', () => {
    expect(parseExecutionReports('nope')).toBeUndefined();
    expect(parseExecutionReports(null)).toBeUndefined();
    expect(parseExecutionReports({})).toBeUndefined();
  });

  it('数组里混着非对象 → 跳过它们，不整体失败', () => {
    const out = parseExecutionReports([null, 'x', 42, LEGACY_REPORT]);
    expect(out).toHaveLength(1);
  });

  it('字段类型全错 → 补默认值，不抛', () => {
    const out = parseExecutionReports([
      { servant: 123, taskId: null, status: 'weird', artifacts: 'not-array', reply: {} },
    ]);
    expect(out?.[0]?.servant).toBe('');
    expect(out?.[0]?.status).toBe('done');
    expect(out?.[0]?.artifacts).toEqual([]);
    expect(out?.[0]?.reply).toBe('');
  });

  it('空数组 → undefined（界面据此整块不渲染）', () => {
    expect(parseExecutionReports([])).toBeUndefined();
  });

  it('★ 缺 negotiable 时按「不可协商」处理（保守方向）', () => {
    const out = parseExecutionReports([
      { ...LEGACY_REPORT, injectedConstraints: [{ content: '硬约束' }] },
    ]);
    // 把软约束误当硬约束，只是提示多一句；
    // 反过来会让真正的硬约束被当成可放宽的 —— 那个方向不能错
    expect(out?.[0]?.injectedConstraints[0]?.negotiable).toBe(false);
  });
});

describe('工具循环过程的解析', () => {
  it('正常数据原样读出', () => {
    const t = parseAgentTrace({
      rounds: [
        {
          round: 1,
          maxRounds: 20,
          reasoning: '先列目录',
          text: '',
          toolCalls: [
            {
              callId: 'c1',
              name: 'list_dir',
              argsText: '{"path":"."}',
              ok: true,
              denied: false,
              output: '冰箱盘点.txt',
              durationMs: 12,
            },
          ],
        },
      ],
      finished: { rounds: 1, hitRoundLimit: false, reason: 'noToolCalls' },
    });
    expect(t?.rounds).toHaveLength(1);
    expect(t?.rounds[0]?.toolCalls[0]?.durationMs).toBe(12);
    expect(t?.finished?.reason).toBe('noToolCalls');
  });

  it('形状不符 → undefined（界面上没有过程，比有半截过程好）', () => {
    expect(parseAgentTrace(null)).toBeUndefined();
    expect(parseAgentTrace({ rounds: 'nope' })).toBeUndefined();
    expect(parseAgentTrace({ rounds: [] })).toBeUndefined();
  });

  it('缺 finished → 补 null（表示还在跑）', () => {
    const t = parseAgentTrace({ rounds: [{ round: 1 }] });
    expect(t?.finished).toBeNull();
  });
});
