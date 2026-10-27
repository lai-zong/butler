/**
 * 为临时 E2E 数据目录造一个真实可被 App 启动的会话。
 * 不写正式 .butler-data。
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { JsonlEventStore } from '../src/adapters/storage/jsonlEvents.js';
import { EventLog } from '../src/core/events/log.js';
import { FixedClock } from '../src/core/ports/clock.js';
import { SessionStore } from '../src/core/chat/types.js';

const source = join(process.cwd(), '.butler-data');
const target = join(process.cwd(), '.tmp-e2e-diary');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(join(source, 'model-profiles.json'), join(target, 'model-profiles.json'));
await cp(join(source, 'model-roles.json'), join(target, 'model-roles.json'));

const start = new Date(2026, 9, 26, 10, 0, 0).getTime();
const clock = new FixedClock(start);
const log = new EventLog('e2e_diary');
const persistence = new JsonlEventStore({
  file: join(target, 'events.jsonl'),
  flushIntervalMs: 0,
});
log.attachPersistence(persistence);
const chat = new SessionStore(log, clock, 'local');
const session = chat.createSession('e2e_day');
const texts = [
  '我平时不吃香菜，这个一直是这样。',
  '我一般十二点以后才睡，早上七点半起。',
  '我做前端重构习惯先补测试再改实现。',
  '我喜欢美式咖啡，不加糖。',
];
for (let i = 0; i < texts.length; i += 1) {
  clock.advance(i * 1000);
  chat.appendMessage(session.id, { role: 'user', text: texts[i]!, status: 'done' });
}

const second = chat.createSession('e2e_day_2');
const secondTexts = [
  '我做海报时偏好低饱和的蓝绿色。',
  '我不喜欢高对比的配色。',
  '标题周围要留比较多的空白。',
  '这次海报是 1080×1440。',
];
for (let i = 0; i < secondTexts.length; i += 1) {
  clock.advance(i * 1000);
  chat.appendMessage(second.id, { role: 'user', text: secondTexts[i]!, status: 'done' });
}

await log.flushPersistence();
console.log(
  JSON.stringify(
    { target, sessions: [session.id, second.id], messages: texts.length + secondTexts.length },
    null,
    2,
  ),
);

