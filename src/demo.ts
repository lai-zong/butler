/**
 * 事件内核自检页
 *
 * 目的：让方案 § 4.1（事件模型）与 § 2.2⑥（记忆分权）在浏览器里**可验证**，
 * 而不是只停留在文档里。每次改动核心模块，打开这一页就能看到是否仍成立。
 */

import { EventLog } from './core/events/log.js';
import { EVENT_FAMILIES, type EventActor, type EventType } from './core/events/types.js';
import {
  isButlerWriteOnly,
  isForceVisible,
  isSearchableByAll,
  MEMORY_CLASS_LABEL,
  participatesInEvolution,
  type MemoryClass,
} from './core/memory/types.js';
import { SERVANT_BOUNDARY, SERVANT_IDS, type ServantId } from './core/servants/types.js';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ═══════════════════════════════════════════════════════
// 1 · 不变量
// ═══════════════════════════════════════════════════════

interface InvariantResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: InvariantResult[] = [];
function check(name: string, fn: () => boolean, detail: string): void {
  let pass = false;
  try {
    pass = fn();
  } catch {
    pass = false;
  }
  results.push({ name, pass, detail });
}

const probe = new EventLog('probe');
const e1 = probe.append({ type: 'thought.done', payload: {}, actor: 'butler' });
const e2 = probe.append({ type: 'plan.created', payload: {}, actor: 'butler' });

check('I1 · seq 从 1 开始、单调递增', () => e1.seq === 1 && e2.seq === 2, 'seq 1 → 2');
check(
  'I2 · parentEventId 只能指向更早事件',
  () => {
    const c = probe.append({
      type: 'tool.call',
      payload: {},
      actor: 'butler',
      parentEventId: e2.id,
    });
    return c.parentEventId === e2.id;
  },
  '因果链可建立',
);
check(
  'I2 · 悬空 parentEventId 被拒绝',
  () => {
    try {
      probe.append({ type: 'tool.result', payload: {}, actor: 'butler', parentEventId: 'nope' });
      return false;
    } catch {
      return true;
    }
  },
  '抛 EventInvariantError',
);
check(
  'I4 · actor=servant 必须带 servantId',
  () => {
    try {
      probe.append({ type: 'servant.report', payload: {}, actor: 'servant' });
      return false;
    } catch {
      return true;
    }
  },
  '抛 EventInvariantError',
);
check(
  'appendMany 中途失败不留中间态',
  () => {
    const log = new EventLog('atomic');
    log.append({ type: 'thought.done', payload: {}, actor: 'butler' });
    try {
      log.appendMany([
        { type: 'plan.created', payload: {}, actor: 'butler' },
        { type: 'plan.revised', payload: {}, actor: 'butler', parentEventId: 'nope' },
      ]);
    } catch {
      /* 预期失败 */
    }
    return log.length === 1;
  },
  '回滚到调用前长度',
);

$('invariants').innerHTML = results
  .map(
    (r) =>
      `<div class="kv"><span class="${r.pass ? 'ok' : 'warn'}">${r.pass ? '✓' : '✗'}</span>` +
      `<span style="min-width:280px">${esc(r.name)}</span>` +
      `<span class="k" style="min-width:auto;flex:1">${esc(r.detail)}</span></div>`,
  )
  .join('');

// ═══════════════════════════════════════════════════════
// 2 · 一次完整会话的事件流
// ═══════════════════════════════════════════════════════

const SESSION = 's_weekend_dinner';
const log = new EventLog(SESSION);

type Emit = {
  type: EventType;
  actor: EventActor;
  servantId?: ServantId;
  note: string;
};

const script: readonly Emit[] = [
  { type: 'thought.done', actor: 'butler', note: '理解目标：跨领域请求（生活 + 健康）' },
  { type: 'memory.recalled', actor: 'butler', note: '双层检索命中 4 条（全球化 2 / 领域 2）' },
  { type: 'route.decided', actor: 'butler', note: '路由置信度 0.94 → 派发给生活 + 健康' },
  { type: 'dispatch.created', actor: 'butler', note: '任务分解：3 步，含依赖关系' },
  {
    type: 'constraint.injected',
    actor: 'butler',
    note: '★ 给生活仆人注入：避开花生、需有素食',
  },
  {
    type: 'constraint.injected',
    actor: 'butler',
    note: '★ 给健康仆人注入：花生过敏（硬）、减脂目标（软）',
  },
  { type: 'dispatch.stepStarted', actor: 'butler', note: 'step1 → 生活仆人' },
  { type: 'servant.report', actor: 'servant', servantId: 'life', note: '产出餐厅清单 v1（3 家）' },
  { type: 'dispatch.stepDone', actor: 'butler', note: 'step1 完成' },
  { type: 'dispatch.stepStarted', actor: 'butler', note: 'step2 → 健康仆人' },
  {
    type: 'conflict.detected',
    actor: 'servant',
    servantId: 'health',
    note: '★ CF-007：火锅高油高盐 ↔ 减脂目标',
  },
  { type: 'conflict.resolved', actor: 'user', note: '用户裁决：健康优先 → 记入事件日志' },
  { type: 'artifact.created', actor: 'butler', note: '聚餐方案 v2 + 采购清单 v1' },
  { type: 'reflection.started', actor: 'system', note: '会话结束，进入反思阶段' },
];

const emitted: { seq: number; type: EventType; actor: string; note: string }[] = [];
for (const step of script) {
  const ev = log.append({
    type: step.type,
    payload: { note: step.note },
    actor: step.actor,
    ...(step.servantId !== undefined ? { servantId: step.servantId } : {}),
  });
  emitted.push({ seq: ev.seq, type: ev.type, actor: ev.actor, note: step.note });
}

$('events').innerHTML =
  '<table><thead><tr><th style="width:44px">seq</th><th style="width:200px">type</th>' +
  '<th style="width:80px">actor</th><th>说明</th></tr></thead><tbody>' +
  emitted
    .map(
      (e) =>
        `<tr><td class="seq">${e.seq}</td><td><code class="${e.note.startsWith('★') ? 'brand' : ''}">${esc(e.type)}</code></td>` +
        `<td><code>${esc(e.actor)}</code></td><td style="color:var(--sub)">${esc(e.note)}</td></tr>`,
    )
    .join('') +
  '</tbody></table>';

// ═══════════════════════════════════════════════════════
// 3 · 回退演示
// ═══════════════════════════════════════════════════════

const before = log.length;
const checkpointSeq = 9; // step2 开始之前
const discarded = log.truncateTo({
  sessionId: SESSION,
  seq: checkpointSeq,
  reason: '健康仆人检出冲突，回退到 step2 之前重做',
});

$('rollback').innerHTML =
  `<div class="kv"><span class="k">回退目标</span><span class="v">seq ${checkpointSeq}（step2 开始前）</span></div>` +
  `<div class="kv"><span class="k">回退前</span><span class="v">${before} 条事件</span></div>` +
  `<div class="kv"><span class="k">回退后</span><span class="v">${log.length} 条事件，保留 seq 1—${log.length}</span></div>` +
  `<div class="kv"><span class="k">被丢弃</span><span class="v warn">${discarded.length} 条 —— 已返回供归档，<b>不是删除</b></span></div>` +
  '<div style="margin-top:12px;color:var(--sub);font-size:12px;line-height:1.8">' +
  '关键点：<code>truncateTo</code> 把被丢弃的事件**返回**给调用方，由检查点管理器归档。' +
  '因此"被取代"的产出物仍可查看与对比（方案 § 5.2）。' +
  '</div>';

// ═══════════════════════════════════════════════════════
// 4 · 记忆分权矩阵
// ═══════════════════════════════════════════════════════

const CLASSES: readonly MemoryClass[] = [
  'global_constraint',
  'global_shared',
  'sensitive',
  'domain',
];
const yn = (b: boolean): string => (b ? '<span class="ok">✓</span>' : '<span style="color:#4b5058">—</span>');

$('partition').innerHTML =
  '<table><thead><tr><th>类别</th><th style="width:120px">强制可见</th>' +
  '<th style="width:120px">按需可检索</th><th style="width:130px">仅管家可写</th>' +
  '<th style="width:130px">参与演化淘汰</th></tr></thead><tbody>' +
  CLASSES.map(
    (c) =>
      `<tr><td>${esc(MEMORY_CLASS_LABEL[c])} <code style="color:#4b5058">${c}</code></td>` +
      `<td>${yn(isForceVisible(c))}</td><td>${yn(isSearchableByAll(c))}</td>` +
      `<td>${yn(isButlerWriteOnly(c))}</td><td>${yn(participatesInEvolution(c))}</td></tr>`,
  ).join('') +
  '</tbody></table>' +
  '<div style="margin-top:14px;color:var(--sub);font-size:12px;line-height:1.9">' +
  '<b>读法</b>：<br>' +
  '· <b>全局硬约束</b>对全部仆人强制可见、且<b>不参与淘汰</b>——否则会出现"把你的过敏史淘汰掉"。<br>' +
  '· <b>敏感域</b>既不强制可见也不可被任意检索，且<b>只能管家写入</b>——委托写入会破坏隔离。<br>' +
  '· <b>领域记忆</b>是唯一由仆人自写的类别，各仆人互不可见、独立演化。<br>' +
  '</div>' +
  '<div style="margin-top:14px;color:var(--sub);font-size:12px">五个仆人（完全平等，无否决权）：' +
  SERVANT_IDS.map(
    (s: ServantId) =>
      `<code>${SERVANT_BOUNDARY[s].name}</code> <span style="color:#4b5058">= ${esc(SERVANT_BOUNDARY[s].test)}</span>`,
  ).join('　·　') +
  '</div>';


// ═══════════════════════════════════════════════════════
// 控制台输出（便于 CI / 人工核对）
// ═══════════════════════════════════════════════════════

const families = Object.keys(EVENT_FAMILIES).length;
console.info(
  `[butler-ai] 事件内核自检完成：${results.filter((r) => r.pass).length}/${results.length} 项不变量通过 · ` +
    `${families} 个事件族 · 会话 ${SESSION} 现有 ${log.length} 条事件`,
);
