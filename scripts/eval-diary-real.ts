/**
 * 真实记忆模型日记验证（会调用已配置的 memory model）。
 *
 * 不写任何记忆/事件，只生成日记并检查来源约束。
 * 运行：pnpm eval:diary:real
 */

import { join } from 'node:path';

import { DeepSeekModel } from '../src/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '../src/adapters/model/openaiCompatible.js';
import { SystemClock } from '../src/adapters/clock/system.js';
import { generateDiary } from '../src/core/diary/generate.js';
import type { DiarySourceMessage } from '../src/core/diary/types.js';
import { loadEnvFile } from '../src/core/config/env.js';
import { loadModelRoles } from '../src/app/server/modelRoles.js';
import { resolveProfileModel } from '../src/app/server/modelProfiles.js';

loadEnvFile(process.cwd());
const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
const roles = await loadModelRoles(DATA_DIR);
if (roles.memory === null) {
  console.error('memory model role is not configured');
  process.exit(2);
}
const resolved = await resolveProfileModel(
  DATA_DIR,
  roles.memory.profileId,
  roles.memory.modelId,
  'chat',
);
if (resolved === null) {
  console.error('memory model role points to a missing model');
  process.exit(2);
}
const model =
  resolved.preset.adapter === 'deepseek'
    ? new DeepSeekModel(resolved.config)
    : new OpenAICompatibleModel(
        resolved.config,
        resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
      );

const now = Date.now();
const cases = [
  {
    name: 'work',
    messages: [
      '我下周要交一个前端重构，先把旧组件全部替换掉。',
      '不要为了省事只改样式，行为要一致。',
      '测试先补，再动实现。',
      '如果时间不够，先做登录和列表两页。',
    ],
  },
  {
    name: 'life',
    messages: [
      '周末我想在家做一顿简单的饭。',
      '我不吃香菜，别的都能接受。',
      '家里有鸡蛋、豆腐和西兰花。',
      '最好半小时内能做完。',
    ],
  },
  {
    name: 'health',
    messages: [
      '我最近睡眠不太好，想调整一下作息。',
      '我一般十二点以后才睡。',
      '早上七点半要起床。',
      '先不要建议吃药，我想先改习惯。',
    ],
  },
  {
    name: 'art',
    messages: [
      '我在做一张产品海报。',
      '想要低饱和的蓝绿色，不要高对比。',
      '标题要留很多空白。',
      '先给我三个构图方向。',
    ],
  },
] as const;

const results: unknown[] = [];
for (const c of cases) {
  const messages: DiarySourceMessage[] = c.messages.map((text, i) => ({
    id: `${c.name}_u${i}`,
    role: 'user',
    text,
    createdAt: now + i,
  }));
  messages.push({
    id: `${c.name}_a0`,
    role: 'butler',
    text: '收到，我按这些条件处理。',
    createdAt: now + 10,
  });
  try {
    const r = await generateDiary({
      model,
      clock: new SystemClock(),
      sessionId: `eval_${c.name}`,
      userId: 'eval',
      dayKey: '2026-10-28',
      messages,
      minUserMessages: 4,
    });
    results.push({
      case: c.name,
      diary: r.entry.content,
      items: r.entry.items.map((i) => ({
        kind: i.kind,
        content: i.content,
        confidence: i.confidence,
        evidence: i.evidence,
        userBacked: i.evidence.some((id) => id.startsWith(`${c.name}_u`)),
        principle: i.principle ?? null,
      })),
      usage: r.usage,
    });
  } catch (err) {
    results.push({ case: c.name, error: err instanceof Error ? err.message : String(err) });
  }
}

const allItems = results.flatMap((r) => {
  const x = r as { items?: { userBacked: boolean }[] };
  return x.items ?? [];
});
console.log(
  JSON.stringify(
    {
      ok: allItems.every((i) => i.userBacked),
      model: roles.memory,
      cases: results,
    },
    null,
    2,
  ),
);
