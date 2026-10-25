/**
 * UI E2E 种子数据（仅测试用）
 *
 * 只写临时 BUTLER_DATA_DIR 的 events.jsonl，不碰真实 .butler-data。
 * 产出一条敏感记忆、两条可比较的活跃记忆、一个产出物。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventLog } from '../src/core/events/log.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { InMemoryArtifactStore } from '../src/core/artifact/store.js';
import { ActivityObserver } from '../src/core/activity/observe.js';
import { SessionStore } from '../src/core/chat/types.js';
import { DocumentStore } from '../src/core/documents/store.js';

const dir = process.argv[2];
if (dir === undefined || dir.length === 0) {
  throw new Error('usage: seed-ui-fixture.ts <data-dir>');
}

const now = 1_760_000_000_000;
const clock = { now: () => now };
const log = new EventLog('seed_ui');
const memory = new MemoryStore(log, clock, 'ui_user');
const activity = new ActivityObserver(log, clock, 'ui_user');
activity.grantConsent();

const sensitive = memory.create(
  { kind: 'butler', userId: 'ui_user' },
  {
    memClass: 'sensitive',
    kind: 'fact',
    content: '用户对花生过敏，点餐与采购必须避开。',
    confidence: 0.94,
    evidence: ['seed:allergy'],
    lifecycle: 'active',
    domain: 'life',
  },
);
if (!sensitive.ok) throw new Error(`seed sensitive failed: ${sensitive.reason}`);

const preferenceIds: string[] = [];
for (const content of [
  '喜欢安静的位置，提前 10 分钟到。',
  '喜欢热闹的靠窗位，最好靠近吧台。',
]) {
  const r = memory.create(
    { kind: 'butler', userId: 'ui_user' },
    {
      memClass: 'global_shared',
      kind: 'preference',
      content,
      confidence: 0.86,
      evidence: ['seed:conflict'],
      lifecycle: 'active',
    },
  );
  if (!r.ok) throw new Error(`seed preference failed: ${r.reason}`);
  preferenceIds.push(r.entry.id);
}

// 自动冲突检测的事件种子（UI 只从事件读取；不改 MemoryEntry）。
if (preferenceIds[0] !== undefined && preferenceIds[1] !== undefined) {
  log.append({
    type: 'conflict.detected',
    actor: 'system',
    payload: {
      candidateId: 'seed_conflict',
      memoryId: preferenceIds[0],
      memoryIds: [preferenceIds[1]],
      reason: '两条偏好对“安静/热闹”的结论相反，可能冲突。',
      detector: 'model',
    },
    createdAt: now,
  });
}

// C8：一个已取消的会话，供对话页的取消回执做真实 UI 验证。
const chat = new SessionStore(log, clock, 'ui_user');
const cancelledSession = chat.createSession('seed_cancel');
const cancellationFromSeq = log.nextSeq();
chat.appendMessage(cancelledSession.id, {
  role: 'user',
  text: '帮我把这周的体检报告整理成一份摘要，重点看血脂和睡眠。',
});
log.append({
  type: 'session.cancelled',
  actor: 'user',
  payload: {
    sessionId: cancelledSession.id,
    reason: 'user_cancelled',
    phase: 'execute',
    fromSeq: cancellationFromSeq,
    toSeq: log.length,
    toolCalls: 3,
    toolResults: 2,
  },
  createdAt: now + 1_000,
});

const artifacts = new InMemoryArtifactStore(log, clock);
const artifact = artifacts.create({
  label: '周末晚餐清单',
  kind: 'list',
  content: '清蒸鲈鱼\n蒜蓉西兰花\n番茄牛腩',
  items: ['清蒸鲈鱼', '蒜蓉西兰花', '番茄牛腩'],
  producedByStep: 'seed_ui',
  author: 'butler',
  reason: 'UI E2E fixture',
});

mkdirSync(dir, { recursive: true });
const body = log.all().map((e) => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(join(dir, 'events.jsonl'), body, 'utf8');

// 文档库种子：和 E2E 的临时数据目录一致，不碰真实 .butler-data。
const documents = new DocumentStore(join(dir, 'documents'), () => now);
await documents.ingest({
  name: '体检报告-2026-10.txt',
  text:
    '血脂检查\n\n低密度脂蛋白 LDL 为 3.8 mmol/L，建议三个月后复查。\n\n' +
    '睡眠记录\n\n最近一周平均睡眠 6.2 小时，入睡时间多在 00:30 之后。\n\n肝功能正常。',
});
await documents.ingest({
  name: '项目合同-秋季版.txt',
  text:
    '付款条款\n\n甲方应在验收后三十天内付款。逾期需提前书面通知，并协商新的付款日期。\n\n' +
    '交付范围\n\n包含设计稿、前端页面与部署文档，不包含后续运营维护。',
});
await documents.ingest({
  name: '数据库变更规范.txt',
  text:
    '数据库变更规范\n\n任何 schema 变更必须先写迁移脚本，经过审查后才能上线。不要直接改生产库。\n\n' +
    '回滚要求\n\n每个迁移脚本必须包含可执行的回滚步骤。',
});

process.stdout.write(JSON.stringify({
  artifactId: artifact.id,
  sensitiveId: sensitive.entry.id,
  events: log.all().length,
}));
