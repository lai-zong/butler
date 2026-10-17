/**
 * 验证 9：上下文压缩（§3.1b 三层记忆的层① + 层②）
 *
 * ★ 本验证要回答一个问题，用**数据**而不是说法：
 *
 *   改之前：只带最近 4 轮、每轮 800 字，超出**直接丢**。
 *           实测后果 —— 用户说"那今晚就按你说的做"，
 *           模型答"我看不到那个方案"。
 *
 *   改之后：① 按 token 预算装（约 30—60 轮）
 *           ② 装不下时**压缩成摘要**，而不是丢掉
 *           ③ 工具结果剪枝**保住头尾**（结论常在尾部）
 *
 * ⚠️ 本脚本**默认不调真实模型**（除了最后一节，可用 --real 跳过）。
 *    理由是：压缩逻辑的正确性可以完全用确定性断言验证，
 *    真实模型只在"摘要质量"这一节才必要。
 */

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import {
  HISTORY_TOKEN_BUDGET,
  TOOL_OUTPUT_PRUNE_CHARS,
  estimateTokens,
  planHistory,
  pressureOf,
  pruneToolOutput,
  summarizeOlder,
  buildSummaryPrompt,
  normalizeSummary,
} from '../core/chat/compaction.js';
import { buildHistoryMessages, MAX_HISTORY_CHARS } from '../core/chat/history.js';
import { trimHistory } from '../core/tools/agentLoop.js';
import { msg } from '../core/ports/model.js';
import type { ChatMessage } from '../core/chat/types.js';
import type { ModelMessage } from '../core/ports/model.js';

// ═══════════════════════════════════════════════════════════
// 断言框架
// ═══════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}

function hr(title: string): void {
  console.log(`\n${'─'.repeat(66)}\n${title}\n${'─'.repeat(66)}`);
}

const T0 = 1_760_000_000_000;
const clock = new FixedClock(T0);
const log = new EventLog('v9');

function mkMsg(id: string, role: 'user' | 'butler', text: string): ChatMessage {
  return { id, sessionId: 's1', role, text, status: 'done', createdAt: T0 } as ChatMessage;
}

/** 造一段"每轮都有实质内容"的会话。 */
function longConversation(turns: number, charsPerMsg: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(mkMsg(`u${i}`, 'user', `第${i}轮：${'问'.repeat(charsPerMsg - 8)}`));
    out.push(mkMsg(`b${i}`, 'butler', `第${i}轮答复：${'答'.repeat(charsPerMsg - 12)}`));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
console.log('\n▶ 验证 9：上下文压缩（三层记忆的浅层）\n');

hr('① token 估算 —— 保守，不低估中文');

check('中文每字 1 token', estimateTokens('花生过敏') === 4);
check('英文每 4 字符 1 token', estimateTokens('abcdefgh') === 2);
check('全角标点计入中文', estimateTokens('你好，世界。') === 6, '「你好，世界。」= 6');
check('空串 0', estimateTokens('') === 0);

hr('② ★ 与旧实现对比：同样一段会话，各自能看到多少');

const turns = 30;
const conv = longConversation(turns, 200); // 60 条消息，每条约 200 字
const totalTokens = conv.reduce((s, m) => s + estimateTokens(m.text) + 16, 0);

console.log(`  会话规模：${turns} 轮 / ${conv.length} 条消息 / 约 ${totalTokens} token`);
console.log(`  旧实现（4 轮 × 800 字）可覆盖：约 ${4 * 2 * 200} 字`);
console.log(`  新预算：${HISTORY_TOKEN_BUDGET} token`);

const plan = planHistory(conv, { excludeLast: false });
const oldTurns = 4;
const newTurns = Math.floor(plan.recent.length / 2);

check(
  `★ 新实现覆盖 ${newTurns} 轮，远超旧的 ${oldTurns} 轮`,
  newTurns > oldTurns * 2,
  `${newTurns} vs ${oldTurns}`,
);
check('预算内无需压缩（这段会话装得下）', plan.layered === false, `recent=${plan.recent.length}`);
check(
  '★ 旧实现会丢掉的轮次，新实现全部保住了',
  plan.recent.length === conv.length,
  `${plan.recent.length}/${conv.length}`,
);

hr('③ ★ 超预算时：压缩而不是丢弃');

const hugeConv = longConversation(200, 400); // 400 条消息，约 16 万 token
const hugeTokens = hugeConv.reduce((s, m) => s + estimateTokens(m.text) + 16, 0);
const hugePlan = planHistory(hugeConv, { excludeLast: false });

console.log(`  会话规模：400 条 / 约 ${hugeTokens} token（超过预算 ${HISTORY_TOKEN_BUDGET}）`);
console.log(`  recent ${hugePlan.recent.length} 条 · older ${hugePlan.older.length} 条`);

check('确实触发了分层', hugePlan.layered === true);
check('★ 老的进入 older（可摘要），不是被丢弃', hugePlan.older.length > 0);
check(
  '★ 一条都没丢：recent + older = 全部',
  hugePlan.recent.length + hugePlan.older.length === hugeConv.length,
  `${hugePlan.recent.length}+${hugePlan.older.length}=${hugeConv.length}`,
);
check('保留的是最新的（最后一条在 recent）', hugePlan.recent[hugePlan.recent.length - 1]?.id === hugeConv[hugeConv.length - 1]?.id);

hr('④ ★ 工具结果剪枝：保住头尾（旧实现全丢）');

// ⚠️ 必须超过 TOOL_OUTPUT_PRUNE_CHARS 才会触发剪枝 ——
//    我第一次只造了 669 字，低于阈值 1200，于是"没剪枝"被判成失败
//    （是测试数据错，不是代码错 —— 这条注释留着防止再犯）
const longOutput = `${'头'.repeat(1_400)}...中间...${'尾'.repeat(50)}结论：文件共 12 项`;
const pruned = pruneToolOutput(longOutput);

check('超阈值触发剪枝', pruned.pruned === true, `${pruned.originalChars} 字 > ${TOOL_OUTPUT_PRUNE_CHARS}`);
check('★ 头部保留', pruned.text.startsWith('头'));
check('★★ 尾部结论保留', pruned.text.includes('结论：文件共 12 项'));
check('标注了略去多少字', pruned.text.includes('中间略去'));
check(
  `剪枝后不超过阈值 + 标注开销`,
  pruned.text.length <= TOOL_OUTPUT_PRUNE_CHARS + 80,
  `${pruned.text.length} 字`,
);

// 旧行为：占位符 —— 结论丢失
const beforeTrim: ModelMessage[] = [msg.user('起点')];
for (let i = 0; i < 20; i++) {
  beforeTrim.push(msg.toolResult(`c${i}`, `${'X'.repeat(900)}结论#${i}#`));
}
trimHistory(beforeTrim);
const flat = JSON.stringify(beforeTrim);
check('★ 最老的 4 条已占位（确实压掉了）', !flat.includes('结论#0#') && !flat.includes('结论#3#'));
check('★★ 中间档保住结论（旧实现这里也会丢）', flat.includes('结论#5#'));
check('最新的完整', flat.includes('结论#19#'));

hr('⑤ ★ 压力判断：用真实 usage，不靠估算');

const p1 = pressureOf({});
check('无观测视为无压力', p1.atPressure === false && p1.used === 0);

const budget = 1_000_000 * 0.8 - 65_536;
check('1M 窗口的预算约 73.4 万 token', Math.abs(p1.budget - budget) < 10, `${p1.budget}`);
check(
  '★ 现状事实：普通用量远达不到（所以预算才是主判据）',
  pressureOf({ lastInputTokens: 50_000 }).atPressure === false,
);

hr('⑥ 摘要压缩：失败绝不让对话失败');

const older = [mkMsg('u0', 'user', '我花生过敏'), mkMsg('b0', 'butler', '记下了')];

const failRes = await summarizeOlder({
  model: { complete: () => Promise.reject(new Error('模拟网络失败')) },
  older,
});
check('★ 模型失败 → 返回 failure，不抛出', failRes.failure !== undefined, failRes.failure?.slice(0, 30));

const emptyRes = await summarizeOlder({ model: { complete: () => Promise.resolve({ text: '' }) }, older });
check('★ 空摘要 → failure（不许"压缩成没有"）', emptyRes.summary === undefined);

const okRes = await summarizeOlder({
  model: { complete: () => Promise.resolve({ text: '用户想安排晚饭；已确认花生过敏为硬约束。' }) },
  older,
});
check('正常摘要可用', okRes.summary !== undefined);
check('★ 压完比压前短', okRes.afterTokens < okRes.beforeTokens, `${okRes.beforeTokens} → ${okRes.afterTokens}`);

check('拒答被拦', normalizeSummary('抱歉，我无法总结') === undefined);

const prompt = buildSummaryPrompt(older);
check('提示词含"必须保留/必须丢弃"两段', prompt.system.includes('必须保留') && prompt.system.includes('必须丢弃'));
check(
  '★ 保留清单点名了"已做的决定"与"被否决的方案"（最易被总结丢掉）',
  prompt.system.includes('已经做出的决定') && prompt.system.includes('被否决的方案'),
);

hr('⑦ 组装后的实际 prompt 形状');

const assembled = buildHistoryMessages(conv, { excludeLast: false });
check('产出 1 条 system 消息（不是多轮 user/assistant）', assembled.length === 1);
const sysText = String((assembled[0]?.content[0] as { text?: string }).text ?? '');
check('含"最近对话"小节', sysText.includes('本次会话的最近对话'));
check('含"背景，不是当前任务"的边界说明', sysText.includes('背景'));
check('单条消息被限制在 MAX_HISTORY_CHARS 内', !sysText.includes('问'.repeat(MAX_HISTORY_CHARS + 1)));

const layeredAssembled = buildHistoryMessages(hugeConv, { excludeLast: false });
const layeredText = String((layeredAssembled[0]?.content[0] as { text?: string }).text ?? '');
check('★ 有更老内容时标注"未压缩"（不假装完整）', layeredText.includes('更早的内容（未压缩）'));
check('★ 明确要求"问清是哪一个"而不是猜', layeredText.includes('问清是哪一个'));

const withSummary = buildHistoryMessages(hugeConv, {
  excludeLast: false,
  olderSummary: '用户先问了晚饭，后转到采购清单；已否决外卖方案（太贵）。',
});
const withSummaryText = String((withSummary[0]?.content[0] as { text?: string }).text ?? '');
check('给了摘要就放进上下文', withSummaryText.includes('更早的摘要'));
check('摘要内容可见', withSummaryText.includes('已否决外卖方案'));

hr('⑧ 事件可核（压缩尺寸要能被审计）');

log.append({
  type: 'context.compacted',
  actor: 'butler',
  payload: { compactedCount: older.length, beforeTokens: okRes.beforeTokens, afterTokens: okRes.afterTokens, ok: true },
  createdAt: clock.now(),
});
const ev = log.byType('context.compacted');
check('★ context.compacted 事件已落地', ev.length === 1);
check('事件带前后 token（可核对省了多少）', typeof (ev[0]?.payload as { beforeTokens?: unknown }).beforeTokens === 'number');

// ═══════════════════════════════════════════════════════════
hr('结果');

console.log(`  通过 ${passed}/${passed + failed}`);
if (failed > 0) {
  console.log(`  ✗ 失败 ${failed} 项`);
  console.log('\n▶ 验证 9 未通过\n');
  process.exit(1);
}
console.log('\n▶ 验证 9 通过：上下文压缩成立（旧实现丢信息，新实现压缩保留）\n');
