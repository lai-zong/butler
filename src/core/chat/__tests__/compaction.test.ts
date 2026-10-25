/**
 * 上下文压缩测试 —— 锁住 §3.1b「三层记忆」最浅一层的五个性质
 *
 * 核心要回答：为什么这个方案比"固定 4 轮 + 800 字"更好？
 *   · ① 预算驱动，不是轮数驱动（4 轮会丢掉大量本可保留的信息）
 *   · ② 从最新往前装（最近的指代上下文一定在）
 *   · ③ 装不下的进 older，**不是直接丢**
 *   · ④ 工具结果剪枝**不调模型**，且保头保尾
 *   · ⑤ 摘要失败不静默（交给调用方标注）
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACTION_HEADROOM_TOKENS,
  COMPACTION_THRESHOLD_RATIO,
  CONTEXT_WINDOW_TOKENS,
  HISTORY_TOKEN_BUDGET,
  HISTORY_RETAIN_RATIO,
  buildSummaryPrompt,
  estimateTokens,
  historyBudgetForPressure,
  normalizeSummary,
  planHistory,
  pressureOf,
  pruneToolOutput,
  olderAfterCoverage,
  summarizeOlder,
} from '../compaction.js';
// ★ `pruneToolOutput` 现在**必须显式传阈值**（旧常量已删除，它生产无调用方）。
//   测试用标准档的真实阈值，与生产路径（agentLoop）保持一致。
import { DEFAULT_TOOL_RESULT_CHAR_LIMIT } from '../../config/budget.js';
import type { ChatMessage } from '../types.js';

function mkMsg(
  id: string,
  role: 'user' | 'butler',
  text: string,
  status: 'done' | 'streaming' = 'done',
): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    text,
    status,
    createdAt: 0,
  } as ChatMessage;
}

describe('① estimateTokens · 保守估算', () => {
  it('中文按每字 1 token', () => {
    expect(estimateTokens('花生过敏')).toBe(4);
  });

  it('英文按每 4 字符 1 token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('中英混排分别计', () => {
    // 4 个汉字 + 4 个英文字符(1 token)
    expect(estimateTokens('花生过敏abcd')).toBe(5);
  });

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('★ 全角标点也算中文（避免低估）', () => {
    expect(estimateTokens('你好，世界。')).toBe(6);
  });
});

describe('② pruneToolOutput · 剪枝不调模型', () => {
  it('未超阈值时原样返回', () => {
    const r = pruneToolOutput('短内容', DEFAULT_TOOL_RESULT_CHAR_LIMIT);
    expect(r.pruned).toBe(false);
    expect(r.text).toBe('短内容');
  });

  it('超阈值时剪成头 + 中略 + 尾', () => {
    // ★ 阈值由 1,200 改为标准档的 8,192（v8 · 方案 §14）—— 样本要真的超过它
    const long = 'A'.repeat(DEFAULT_TOOL_RESULT_CHAR_LIMIT + 2_000);
    const r = pruneToolOutput(long, DEFAULT_TOOL_RESULT_CHAR_LIMIT);
    expect(r.pruned).toBe(true);
    expect(r.text).toContain('中间略去');
    expect(r.text).toContain('原文见事件日志');
    expect(r.originalChars).toBe(DEFAULT_TOOL_RESULT_CHAR_LIMIT + 2_000);
    expect(r.text.length).toBeLessThan(DEFAULT_TOOL_RESULT_CHAR_LIMIT + 80);
  });

  it('★ 保留头部与尾部（尾部常有结论，如 EXIT 0）', () => {
    const body = `${'HEAD'.repeat(2_500)}${'-'.repeat(2_000)}TAIL_MARKER`;
    const r = pruneToolOutput(body, DEFAULT_TOOL_RESULT_CHAR_LIMIT);
    expect(r.text.startsWith('HEAD')).toBe(true);
    expect(r.text.endsWith('TAIL_MARKER')).toBe(true);
  });

  it('边界：刚好等于阈值不剪', () => {
    const exact = 'x'.repeat(DEFAULT_TOOL_RESULT_CHAR_LIMIT);
    expect(pruneToolOutput(exact, DEFAULT_TOOL_RESULT_CHAR_LIMIT).pruned).toBe(false);
  });
});

describe('③ pressureOf · 用真实 usage，不靠估算', () => {
  it('无观测时视为无压力（第一次调用本来就没上文）', () => {
    const p = pressureOf({});
    expect(p.used).toBe(0);
    expect(p.atPressure).toBe(false);
  });

  it('预算 = 窗口×阈值 − 输出预留 − headroom', () => {
    const p = pressureOf({ contextWindow: 100_000, reservedOutputTokens: 0 });
    const expected = 100_000 * COMPACTION_THRESHOLD_RATIO - COMPACTION_HEADROOM_TOKENS;
    expect(p.budget).toBe(Math.floor(expected));
  });

  it('达到预算即视为有压力', () => {
    const budget = 100_000 * COMPACTION_THRESHOLD_RATIO - COMPACTION_HEADROOM_TOKENS;
    expect(pressureOf({ contextWindow: 100_000, lastInputTokens: budget }).atPressure).toBe(true);
    expect(pressureOf({ contextWindow: 100_000, lastInputTokens: budget - 1 }).atPressure).toBe(false);
  });

  it('★ 现状事实：1M 窗口下压力几乎不会触发', () => {
    // 这不是缺陷，是必须记录的现实 —— 所以"预算"才是主判据
    const p = pressureOf({ lastInputTokens: 50_000 });
    expect(p.atPressure).toBe(false);
    expect(p.budget).toBeGreaterThan(700_000);
    expect(CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
  });

  it('★ 命中压力后历史保留预算按 retainRatio 收缩', () => {
    expect(historyBudgetForPressure(50_000)).toBe(HISTORY_TOKEN_BUDGET);
    const budget = 1_000_000 * COMPACTION_THRESHOLD_RATIO - COMPACTION_HEADROOM_TOKENS;
    const tight = historyBudgetForPressure(budget);
    expect(tight).toBeLessThan(HISTORY_TOKEN_BUDGET);
    expect(tight).toBe(Math.max(16_000, Math.floor(budget * HISTORY_RETAIN_RATIO)));
  });
});

describe('④ planHistory · 预算驱动而非轮数驱动', () => {
  it('空输入返回空计划', () => {
    const p = planHistory([]);
    expect(p.recent).toHaveLength(0);
    expect(p.layered).toBe(false);
  });

  it('★ 预算足够时装下远超 4 轮（旧实现只有 4 轮）', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(mkMsg(`u${i}`, 'user', `第${i}个问题`));
      msgs.push(mkMsg(`b${i}`, 'butler', `第${i}个回答`));
    }
    const p = planHistory(msgs, { excludeLast: false });
    // 20 轮全装得下（每轮约 10 token，远小于 24K）
    expect(p.recent).toHaveLength(40);
    expect(p.older).toHaveLength(0);
    expect(p.layered).toBe(false);
  });

  it('★ 预算不够时从最新往前装，更老的进 older（不是丢掉）', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(mkMsg(`u${i}`, 'user', '问'.repeat(200)));
      msgs.push(mkMsg(`b${i}`, 'butler', '答'.repeat(200)));
    }
    const p = planHistory(msgs, { excludeLast: false, budgetTokens: 2_000 });
    expect(p.recent.length).toBeGreaterThan(0);
    expect(p.recent.length).toBeLessThan(60);
    // 关键：老的没被丢弃，而是归入 older 等摘要
    expect(p.older.length).toBeGreaterThan(0);
    expect(p.recent.length + p.older.length).toBe(60);
    expect(p.layered).toBe(true);
  });

  it('★ 保留的一定是最近的（最后一条必在 recent 里）', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(mkMsg(`u${i}`, 'user', `问题${i}`));
      msgs.push(mkMsg(`b${i}`, 'butler', '答'.repeat(500)));
    }
    const p = planHistory(msgs, { excludeLast: false, budgetTokens: 1_500 });
    const lastId = msgs[msgs.length - 1]?.id;
    expect(p.recent[p.recent.length - 1]?.id).toBe(lastId);
  });

  it('older 保持时间正序', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(mkMsg(`u${i}`, 'user', '长'.repeat(300)));
      msgs.push(mkMsg(`b${i}`, 'butler', '长'.repeat(300)));
    }
    const p = planHistory(msgs, { excludeLast: false, budgetTokens: 1_000 });
    const ids = p.older.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)));
  });

  it('默认排除最后一条（调用方自己会带本轮消息）', () => {
    const msgs = [mkMsg('u0', 'user', '第一问'), mkMsg('b0', 'butler', '第一答'), mkMsg('u1', 'user', '本轮')];
    const p = planHistory(msgs);
    expect(p.recent.map((m) => m.id)).toEqual(['u0', 'b0']);
  });

  it('只算 done 状态的消息（未完成的不进上下文）', () => {
    const msgs: ChatMessage[] = [
      mkMsg('u0', 'user', '问'),
      mkMsg('b0', 'butler', '答', 'streaming'),
    ];
    const p = planHistory(msgs, { excludeLast: false });
    expect(p.recent.map((m) => m.id)).toEqual(['u0']);
  });
});

describe('⑤ 摘要提示词与校验', () => {
  it('提示词含保留与丢弃清单', () => {
    const p = buildSummaryPrompt([mkMsg('u0', 'user', '我花生过敏')]);
    expect(p.system).toContain('必须保留');
    expect(p.system).toContain('必须丢弃');
    expect(p.user).toContain('我花生过敏');
    // 保留清单里必须有"决定"与"被否决的方案" —— 这是最容易被总结丢掉的
    expect(p.system).toContain('已经做出的决定');
    expect(p.system).toContain('被否决的方案');
  });

  it('要求第三人称与纯文本输出', () => {
    const p = buildSummaryPrompt([mkMsg('u0', 'user', 'x')]);
    expect(p.system).toContain('第三人称');
    expect(p.system).toContain('只输出摘要正文');
  });

  it('★★ 空串摘要 → undefined（不许"压缩成没有"）', () => {
    expect(normalizeSummary('')).toBeUndefined();
    expect(normalizeSummary('   ')).toBeUndefined();
  });

  it('★★ 只有标点 → undefined', () => {
    expect(normalizeSummary('。。。')).toBeUndefined();
    expect(normalizeSummary('...')).toBeUndefined();
  });

  it('★★ 拒答 → undefined（交给调用方标注未压缩）', () => {
    expect(normalizeSummary('抱歉，我无法总结这段对话')).toBeUndefined();
    expect(normalizeSummary('sorry, cannot summarize')).toBeUndefined();
  });

  it('正常摘要保留', () => {
    const s = '用户想安排晚饭；已确认花生过敏为硬约束；曾否决外卖方案（太贵）。';
    expect(normalizeSummary(s)).toBe(s);
  });

  it('超长摘要截断', () => {
    const s = '长'.repeat(3000);
    const out = normalizeSummary(s, 100);
    expect(out).toBeDefined();
    expect(out!.length).toBe(101); // 100 + '…'
  });
});

describe('⑥ 预算常量的合理性（防回归）', () => {
  it('预算远大于旧实现的约 3K token', () => {
    expect(HISTORY_TOKEN_BUDGET).toBeGreaterThan(10_000);
  });

  it('★ 预算是上下文窗口的一小部分（否则等于没约束）', () => {
    /**
     * ⚠️ 原断言是 `< 窗口 / 10`（即 < 100,000）。
     *    v8 把预算提到标准档的 160,000（= DSH `retainRatio 0.16` × 1M）后，
     *    那个断言不再成立 —— **但它守的性质仍然成立**：
     *    预算必须明显小于窗口，否则"预算"就不成其为预算。
     *
     *    160,000 / 1,000,000 = 16%，仍在安全范围内（DSH 自己就是 16%）。
     */
    const ratio = HISTORY_TOKEN_BUDGET / CONTEXT_WINDOW_TOKENS;
    expect(ratio).toBeLessThan(0.25);
    expect(ratio).toBeGreaterThan(0.01);
  });

  it('headroom 与阈值来自 dsh 的默认值', () => {
    expect(COMPACTION_THRESHOLD_RATIO).toBe(0.8);
    expect(COMPACTION_HEADROOM_TOKENS).toBe(65_536);
  });
});

describe('⑦ summarizeOlder · 失败绝不让对话失败', () => {
  /** 造一个只实现 complete 的假模型 */
  function fakeModel(reply: string | Error): {
    complete: () => Promise<{ text: string }>;
  } {
    return {
      complete: () =>
        reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ text: reply }),
    };
  }

  const older = [mkMsg('u0', 'user', '第一问'), mkMsg('b0', 'butler', '第一答')];

  it('成功时返回摘要与前后 token', async () => {
    const r = await summarizeOlder({
      model: fakeModel('用户想安排晚饭；已确认花生过敏。'),
      older,
    });
    expect(r.summary).toBe('用户想安排晚饭；已确认花生过敏。');
    expect(r.compactedCount).toBe(2);
    expect(r.afterTokens).toBeGreaterThan(0);
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
    expect(r.failure).toBeUndefined();
  });

  it('★ 模型抛异常 → 返回 failure，不抛出', async () => {
    const r = await summarizeOlder({
      model: fakeModel(new Error('网络超时')),
      older,
    });
    expect(r.summary).toBeUndefined();
    expect(r.failure).toContain('网络超时');
  });

  it('★ 模型返回空 → failure（不许"压缩成没有"）', async () => {
    const r = await summarizeOlder({ model: fakeModel(''), older });
    expect(r.summary).toBeUndefined();
    expect(r.failure).toContain('有效摘要');
  });

  it('★ 模型拒答 → failure', async () => {
    const r = await summarizeOlder({ model: fakeModel('抱歉，我无法总结'), older });
    expect(r.summary).toBeUndefined();
    expect(r.failure).toBeDefined();
  });

  it('空 older 直接返回，不调模型', async () => {
    let called = false;
    const r = await summarizeOlder({
      model: {
        complete: () => {
          called = true;
          return Promise.resolve({ text: 'x' });
        },
      },
      older: [],
    });
    expect(called).toBe(false);
    expect(r.compactedCount).toBe(0);
  });

  it('★ 增量压缩：previousSummary 会带进请求', async () => {
    let seen = '';
    await summarizeOlder({
      model: {
        complete: (call: { messages: readonly { content: readonly unknown[] }[] }) => {
          const last = call.messages[call.messages.length - 1];
          const part = last?.content[0] as { text?: string } | undefined;
          seen = part?.text ?? '';
          return Promise.resolve({ text: '合并后的摘要' });
        },
      },
      older,
      previousSummary: '更早的事：用户叫示例用户',
    });
    expect(seen).toContain('已有摘要');
    expect(seen).toContain('用户叫示例用户');
    expect(seen).toContain('第一问');
  });

  it('增量摘要只选上次覆盖边界之后的 older', () => {
    const all = [
      mkMsg('m1', 'user', '一'),
      mkMsg('m2', 'butler', '二'),
      mkMsg('m3', 'user', '三'),
      mkMsg('m4', 'butler', '四'),
      mkMsg('m5', 'user', '五'),
    ];
    expect(olderAfterCoverage([all[0]!, all[1]!, all[2]!], all, 'm2').map((m) => m.id)).toEqual(['m3']);
    expect(olderAfterCoverage([all[0]!, all[1]!], all, 'm2')).toEqual([]);
    // 边界不存在（回退/旧事件）时宁可重摘，不静默跳过
    expect(olderAfterCoverage([all[0]!], all, 'missing').map((m) => m.id)).toEqual(['m1']);
  });
});
