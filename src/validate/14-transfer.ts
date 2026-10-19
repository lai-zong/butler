/**
 * 验证 14：数据导出 / 导入（v8 · 方案 §5.5）
 *
 * ★ 本验证要证明四件事（对应方案的验收标准「导出→导入→状态等价」）：
 *
 *   ① **导出是完整的**：事件一条不少，摘要统计与内容自洽
 *   ② **导出不含凭证**：扫描结果为 0，且文档显式声明 `includesCredentials: false`
 *   ③ **导入校验真的会拒绝**：版本不符 / seq 不连续 / 结构损坏 —— 各自给出**明确原因**
 *      （方案原话：不兼容时给明确提示而非静默失败）
 *   ④ ★★ **状态等价**：把导出的文档"导入"回去，用同一套 bootstrap 重建，
 *      得到的状态哈希与重建前**完全一致**
 *
 * ⚠️ ④ 是这条链路的真正判据。只验"能导出、能解析"是不够的 ——
 *    那只能证明格式对，证明不了"换一份历史之后行为一样"。
 */

import { EventLog } from '../core/events/log.js';
import { FixedClock } from '../core/ports/clock.js';
import { bootstrap } from '../core/runtime/bootstrap.js';
import { exportDocumentSchema, EXPORT_SCHEMA } from '../core/transfer/schema.js';
import { buildExport } from '../core/transfer/export.js';
import { describeRejection, parseImportDocument } from '../core/transfer/import.js';
import { replay } from '../core/checkpoint/replay.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

const T0 = 1_760_000_000_000;
const USER = 'local';
const APP = 'v8';

/**
 * 造一条有真实内容的事件流（覆盖记忆 / 产出物 / 会话 / 画像快照 / 题目）
 *
 * ★★ 这里必须用 **replay 真正认的 payload 形状**，否则会造出"假绿"：
 *    第一版用了 `memory.candidate` + `memory.approved` —— 但那两个是**状态迁移**事件，
 *    记忆是由 `memory.created`（payload 里带完整 `entry`）创建的。
 *    结果 `restored.memories` 双方都是 0，那条「记忆条数一致 0 / 0」的断言
 *    **什么都没证明**。产出物同理（`artifact.created` 要 `artifact` 快照，不是 `artifactId`）。
 *
 *    教训：等价性断言的双方同时为 0 时，它证明的只是"两个空集合相等"。
 */
function buildFixtureLog(): EventLog {
  const log = new EventLog('__event_log__');

  // ── 记忆：必须走 memory.created，payload 里带完整 entry ──
  log.append({
    type: 'memory.created',
    actor: 'butler',
    payload: {
      entry: {
        id: 'm1',
        owner: { kind: 'butler', userId: USER },
        memClass: 'global_constraint',
        kind: 'fact',
        content: '用户对花生严重过敏',
        confidence: 0.95,
        evidence: ['ev_1'],
        fitness: 0.8,
        lifecycle: 'active',
        hitCount: 3,
      },
    },
    createdAt: T0,
  });
  log.append({
    type: 'memory.created',
    actor: 'butler',
    payload: {
      entry: {
        id: 'm2',
        owner: { kind: 'butler', userId: USER },
        memClass: 'global_shared',
        kind: 'preference',
        content: '用户偏好清淡口味',
        confidence: 0.7,
        evidence: [],
        fitness: 0.6,
        lifecycle: 'active',
        hitCount: 1,
      },
    },
    createdAt: T0 + 1,
  });

  // ── 产出物：必须走 artifact.created，且 payload 里要有 **`snapshot`**（不是 artifact）──
  //
  // ⚠️ `replayArtifacts` 读的是 `payload.snapshot`（见 `artifact/replay.ts:52`），
  //    里面再取 `snapshot.artifact` 与 `snapshot.revisions`。
  //    第一版写成 `{ artifact, revisions }` → 被判定"没有 snapshot 字段"而跳过，
  //    于是「产出物条数一致 0 / 0」又一次是假绿。
  log.append({
    type: 'artifact.created',
    actor: 'butler',
    payload: {
      snapshot: {
        artifact: {
          id: 'a1',
          label: '晚餐方案',
          kind: 'list',
          status: 'active',
          currentVersion: 1,
          producedByStep: 'step_1',
          createdAt: T0 + 2,
          updatedAt: T0 + 2,
        },
        revisions: [],
      },
    },
    createdAt: T0 + 2,
  });

  // ── 会话与消息 ──
  log.append({ type: 'session.message', actor: 'user', payload: { sessionId: 'chat_1', messageId: 'm1', role: 'user', text: '今晚吃什么', status: 'done' }, createdAt: T0 + 3 });
  log.append({ type: 'session.reply', actor: 'butler', payload: { sessionId: 'chat_1', messageId: 'r1', role: 'butler', text: '三套方案', status: 'done' }, createdAt: T0 + 4 });

  // ── 画像快照 ──
  log.append({ type: 'profile.snapshot', actor: 'system', payload: { capturedAt: T0 + 5 }, createdAt: T0 + 5 });
  log.append({
    type: 'quiz.created',
    actor: 'butler',
    payload: {
      taskId: 'chat_1',
      artifactIndex: 0,
      questions: [{ id: 'q1', stem: '哪种用油最少？', options: ['油炸', '清蒸'] }],
      answers: [{ id: 'q1', correct: 'B' }],
    },
    createdAt: T0 + 6,
  });
  log.append({ type: 'session.ended', actor: 'butler', payload: {}, createdAt: T0 + 7 });

  return log;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'butler-validate14-'));
  try {
    hr('① 导出：完整 + 自洽');

    const sourceLog = buildFixtureLog();
    const original = sourceLog.all();
    const doc = buildExport({ events: original, userId: USER, appVersion: APP, now: T0 + 100 });

    check('导出成功', doc.events.length > 0);
    check('事件一条不少', doc.events.length === original.length, `${doc.events.length} / ${original.length}`);
    check('counts.events 与内容一致', doc.counts.events === doc.events.length);
    check('counts.lastSeq = 最大 seq', doc.counts.lastSeq === Math.max(...doc.events.map((e) => e.seq)));
    check('schema 版本号存在', doc.schema === EXPORT_SCHEMA, doc.schema);
    check('自动脱敏策略已声明', doc.sanitization.policy === 'auto');

    hr('② 导出不含凭证');

    check('★ includesCredentials 显式为 false', doc.includesCredentials === false);
    check(
      '★ 正常数据没有凭证被脱敏',
      !doc.sanitization.fields.some((f) => f.kind === 'credential'),
    );
    check('★ 练习答案剥离被计数', doc.sanitization.redacted === 1, String(doc.sanitization.redacted));
    const dumped = JSON.stringify(doc);
    check('★ 文档里没有 sk- 形式的密钥', !/sk-[A-Za-z0-9]{16,}/.test(dumped));
    check('文档里没有真实密钥字段名', !/"apiKey"\s*:\s*"[^"]+"/.test(dumped));
    check('★ 练习答案没有进入导出文件', !/"answers"\s*:/.test(dumped));

    hr('③ 导入校验：该拒绝的都明确拒绝');

    const serialize = (d: unknown): string => JSON.stringify(d);

    // ③-a 非 JSON
    const bad1 = parseImportDocument('这不是 JSON');
    check('非 JSON 被拒', !bad1.ok);
    if (!bad1.ok) check('  给了明确原因', describeRejection(bad1.rejection).includes('JSON'), describeRejection(bad1.rejection));

    // ③-b 版本不符
    const wrongVersion = { ...doc, schema: 'butler-export@0' };
    const bad2 = parseImportDocument(serialize(wrongVersion));
    check('★ 版本不符被拒（不做"尽力兼容"）', !bad2.ok);
    if (!bad2.ok) {
      const msg = describeRejection(bad2.rejection);
      check('  提示里说明了文件版本与所需版本', msg.includes('butler-export@0') && msg.includes(EXPORT_SCHEMA), msg);
    }

    // ③-c seq 不连续（删掉中间一条）
    const brokenSeq = { ...doc, events: doc.events.filter((e) => e.seq !== 3), counts: { ...doc.counts } };
    brokenSeq.counts = { events: brokenSeq.events.length, lastSeq: 8 };
    const bad3 = parseImportDocument(serialize(brokenSeq));
    check('★ seq 不连续被拒', !bad3.ok);
    if (!bad3.ok) check('  原因指明了 seq', describeRejection(bad3.rejection).includes('seq'), describeRejection(bad3.rejection));

    // ③-d counts 与内容不一致（文件被改过）
    const tampered = { ...doc, counts: { events: 999, lastSeq: doc.counts.lastSeq } };
    const bad4 = parseImportDocument(serialize(tampered));
    check('★ counts 被改过 → 拒绝', !bad4.ok);

    // ③-e 空文档
    const empty = { ...doc, events: [], counts: { events: 0, lastSeq: 0 } };
    const bad5 = parseImportDocument(serialize(empty));
    check('空文档被拒', !bad5.ok);

    hr('④ ★★ 状态等价（这条才是真正判据）');

    const okImport = parseImportDocument(serialize(doc));
    check('合法文档通过校验', okImport.ok);
    if (!okImport.ok) {
      console.log('\n▶ 验证 14 未通过（合法文档被拒）\n');
      process.exit(1);
    }
    check('导入后事件数与导出相同', okImport.candidate.eventCount === original.length);

    // 用**同一套 bootstrap** 对比：原事件 vs 导入后的事件
    const clock = new FixedClock(T0);
    // ⚠️ `RandomPort` 有两个方法：next() 与 pick()。少一个就编译不过 ——
    //    这是好事：它逼着调用方想清楚"从数组里取一个"的随机性从哪来。
    const random = {
      next: () => 0.5,
      pick: <T,>(items: readonly T[]): T | undefined => items[0],
    };

    const before = bootstrap({
      sessionId: '__event_log__',
      userId: USER,
      clock,
      random,
      historicalEvents: original,
    });

    /**
     * ★★ 防假绿护栏：等价性断言的双方**必须非空**。
     *
     * 这条断言是本脚本自己踩过坑之后加的：
     * 第一版 fixture 用了 `memory.candidate`（状态迁移）而不是 `memory.created`，
     * 于是 `restored.memories` 双方都是 0，而「记忆条数一致 0 / 0」照样显示 ✓。
     * **两个空集合相等，证明不了任何等价性。**
     *
     * 所以这里先确认"样本里真的有东西"，后面那些"一致"才有意义。
     */
    check(
      '★★ 样本非空（否则后面的"一致"都是 0===0 的假绿）',
      before.restored.memories > 0 &&
        before.restored.artifacts > 0 &&
        before.restored.chatSessions > 0,
      `记忆 ${before.restored.memories} / 产出物 ${before.restored.artifacts} / 会话 ${before.restored.chatSessions}`,
    );

    const inPath = join(dir, 'events.jsonl');
    const after = bootstrap({
      sessionId: '__event_log__',
      userId: USER,
      clock,
      random,
      // ★ 用**校验后已收窄类型**的事件（`candidate.events`）。
      //   它和 `doc.events` 内容一致，但 type 已从 string 收窄为 EventType ——
      //   没有这一步就只能 `as` 强转，那等于关掉类型检查。
      historicalEvents: okImport.candidate.events,
    });

    check(
      '★ 记忆条数一致',
      before.restored.memories === after.restored.memories,
      `${before.restored.memories} / ${after.restored.memories}`,
    );
    check(
      '★ 产出物条数一致',
      before.restored.artifacts === after.restored.artifacts,
      `${before.restored.artifacts} / ${after.restored.artifacts}`,
    );
    check(
      '★ 会话数一致',
      before.restored.chatSessions === after.restored.chatSessions,
      `${before.restored.chatSessions} / ${after.restored.chatSessions}`,
    );
    check('★ 历史事件数一致', before.historicalEvents === after.historicalEvents);

    // 最强的判据：重放状态哈希一致
    const hashBefore = JSON.stringify(replay(before.log.all()).state);
    const hashAfter = JSON.stringify(replay(after.log.all()).state);
    check('★★ 重放状态完全一致（状态哈希相同）', hashBefore === hashAfter, `${hashBefore.length} 字节`);

    // 题目也还在（跨模块的串验）
    check('★ 题目事件在导入后仍可读', after.log.byType('quiz.created').length === 1);
    check('★ 画像快照事件在导入后仍在', after.log.byType('profile.snapshot').length === 1);

    hr('⑤ 导入文档能通过自己的 schema 校验（自洽）');

    const reparsed = exportDocumentSchema.safeParse(JSON.parse(serialize(doc)));
    check('★ 导出的文档能被自己的 schema 校验通过', reparsed.success);

    // 清理：确认临时目录可用（本验证不写业务文件）
    void inPath;

    hr('结果');
    console.log(`  通过 ${passed}/${passed + failed}`);
    if (failed > 0) {
      console.log(`  ✗ 失败 ${failed} 项`);
      console.log('\n▶ 验证 14 未通过\n');
      process.exit(1);
    }
    console.log('\n▶ 验证 14 通过：导出完整、不含凭证、导入校验明确、状态等价\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
