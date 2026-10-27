/**
 * 两日真实记忆管线验证：
 *   · 真实 memory model 生成日记；
 *   · 第一天写入试行；
 *   · 第二天独立证据自动转正；
 *   · 真实模型模糊冲突裁决。
 *
 * 使用内存事件流，不污染 .butler-data。
 */

import { join } from 'node:path';

import { DeepSeekModel } from '../src/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '../src/adapters/model/openaiCompatible.js';
import { EventLog } from '../src/core/events/log.js';
import { FixedClock } from '../src/core/ports/clock.js';
import { SessionStore } from '../src/core/chat/types.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { DiaryStore } from '../src/core/diary/store.js';
import { runDailyDiaries } from '../src/core/diary/pipeline.js';
import { reviewTrialConflicts } from '../src/core/diary/conflicts.js';
import { loadEnvFile } from '../src/core/config/env.js';
import { loadModelRoles } from '../src/app/server/modelRoles.js';
import { resolveProfileModel } from '../src/app/server/modelProfiles.js';
import type { ModelPort } from '../src/core/ports/model.js';

loadEnvFile(process.cwd());
const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
const roles = await loadModelRoles(DATA_DIR);
if (roles.memory === null) throw new Error('memory role not configured');
const resolved = await resolveProfileModel(
  DATA_DIR,
  roles.memory.profileId,
  roles.memory.modelId,
  'chat',
);
if (resolved === null) throw new Error('memory model missing');
const model: ModelPort =
  resolved.preset.adapter === 'deepseek'
    ? new DeepSeekModel(resolved.config)
    : new OpenAICompatibleModel(
        resolved.config,
        resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
      );

const t0 = new Date(2026, 9, 27, 10, 0, 0).getTime();
const clock = new FixedClock(t0);
const log = new EventLog('validate-diary-pipeline');
const store = new MemoryStore(log, clock, 'u1');
const chat = new SessionStore(log, clock, 'u1');
const diary = new DiaryStore(log, clock);
const session = chat.createSession('s_validate');

function addDay(day: number, texts: readonly string[]): void {
  const base = new Date(2026, 9, day, 10, 0, 0).getTime();
  for (let i = 0; i < texts.length; i += 1) {
    // appendMessage 使用 clock；把 clock 拨到对应时间，保证落在正确日窗口。
    clock.advance(base + i * 1000 - clock.now());
    chat.appendMessage(session.id, {
      role: 'user',
      text: texts[i]!,
      status: 'done',
    });
  }
}

// 第一日
clock.advance(new Date(2026, 9, 27, 10, 0, 0).getTime() - clock.now());
addDay(27, [
  '我平时晚上一般十二点以后才睡。',
  '早上七点半要起床。',
  '我不吃香菜。',
  '帮我记一下，之后安排作息和吃饭都按这个来。',
]);
const day1 = await runDailyDiaries({
  model,
  log,
  clock,
  chat,
  diary,
  memory: store,
  dayKey: '2026-10-27',
  minUserMessages: 4,
});
const trialsAfterDay1 = store.all().filter((e) => e.lifecycle === 'candidate');

// 第二日
clock.advance(new Date(2026, 9, 28, 10, 0, 0).getTime() - clock.now());
addDay(28, [
  '我还是十二点以后才睡，七点半起。',
  '晚上别给我安排太晚。',
  '香菜不要放。',
  '就按这个习惯来。',
]);
const day2 = await runDailyDiaries({
  model,
  log,
  clock,
  chat,
  diary,
  memory: store,
  dayKey: '2026-10-28',
  minUserMessages: 4,
  reviewConflicts: true,
});
const promoted = store.all().filter((e) => e.lifecycle === 'active' && e.evidence.some((x) => x.startsWith('diary:')));

// 真实模型模糊冲突：稳定早起时间 vs 试行晚起时间
const stable = store.create(
  { kind: 'butler', userId: 'u1' },
  {
    memClass: 'global_shared',
    kind: 'fact',
    content: '用户通常早上九点起床。',
    confidence: 0.9,
    evidence: ['diary:2026-10-20', 'diary:2026-10-21'],
    lifecycle: 'active',
  },
);
const trial = store.create(
  { kind: 'butler', userId: 'u1' },
  {
    memClass: 'global_shared',
    kind: 'fact',
    content: '用户通常早上七点起床。',
    confidence: 0.7,
    evidence: ['diary:2026-10-28'],
    lifecycle: 'candidate',
  },
);
if (!stable.ok || !trial.ok) throw new Error('seed conflict failed');
const conflict = await reviewTrialConflicts({
  model,
  log,
  clock,
  store,
  userId: 'u1',
  maxPairs: 2,
});

console.log(
  JSON.stringify(
    {
      model: resolved.model.id,
      day1: {
        created: day1.created,
        items: day1.sessions.reduce((n, s) => n + (s.itemCount ?? 0), 0),
        memories: day1.memoriesCreated,
        trials: trialsAfterDay1.length,
        trialContents: trialsAfterDay1.map((e) => e.content),
      },
      day2: {
        created: day2.created,
        memoriesCreated: day2.memoriesCreated,
        memoriesReinforced: day2.memoriesReinforced,
        memoriesPromoted: day2.memoriesPromoted,
        promotedContents: promoted.map((e) => e.content),
      },
      conflict: {
        ...conflict,
        stableLifecycle: store.get(stable.entry.id)?.lifecycle,
        trialLifecycle: store.get(trial.entry.id)?.lifecycle,
      },
      diaryCount: diary.all().length,
    },
    null,
    2,
  ),
);
