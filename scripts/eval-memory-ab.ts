/**
 * 真实模型记忆 A/B（小样本）。
 *
 * 同一请求分别给“无记忆 / 有记忆”两组上下文，再用模型盲评。
 * 这不是统计显著的线上 A/B，只用于发现明显退化或“记忆完全没被用上”。
 */

import { z } from 'zod';

import { join } from 'node:path';
import { DeepSeekModel } from '../src/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '../src/adapters/model/openaiCompatible.js';
import { loadEnvFile } from '../src/core/config/env.js';
import { msg } from '../src/core/ports/model.js';
import type { ModelPort } from '../src/core/ports/model.js';
import { resolveActiveModel } from '../src/app/server/modelProfiles.js';

loadEnvFile(process.cwd());
const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
const resolved = await resolveActiveModel(DATA_DIR);
if (resolved === null) {
  console.error('no active chat model');
  process.exit(2);
}
const model: ModelPort =
  resolved.preset.adapter === 'deepseek'
    ? new DeepSeekModel(resolved.config)
    : new OpenAICompatibleModel(
        resolved.config,
        resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
      );

const cases = [
  {
    name: 'food',
    memory: '用户不吃香菜。',
    query: '晚上想点一碗牛肉面，帮我选一个默认口味。',
  },
  {
    name: 'work',
    memory: '用户偏好先补测试再改实现。',
    query: '登录页有个 bug，帮我安排修改步骤。',
  },
  {
    name: 'health',
    memory: '用户通常十二点以后才睡，早上七点半起床。',
    query: '帮我安排今晚的时间。',
  },
  {
    name: 'art',
    memory: '用户偏好低饱和的蓝绿色，不喜欢高对比。',
    query: '给这张产品海报一个配色方向。',
  },
] as const;

const judgeSchema = z.object({
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string().min(1).max(400),
});

async function answer(memory: string | null, query: string): Promise<string> {
  const system = [
    '你是一个简洁、可靠的管家。',
    memory === null ? '' : `已知用户长期记忆：\n- ${memory}`,
    '回答控制在 120 字以内。',
  ]
    .filter(Boolean)
    .join('\n');
  const r = await model.complete({
    purpose: 'chat',
    temperature: 0.3,
    thinking: 'disabled',
    maxOutputTokens: 300,
    messages: [msg.system(system), msg.user(query)],
  });
  return r.text.trim();
}

const results = [];
for (const c of cases) {
  const without = await answer(null, c.query);
  const withMemory = await answer(c.memory, c.query);
  // 交替隐藏 A/B 位置，降低固定位置偏差。
  const memoryFirst = c.name.length % 2 === 0;
  const a = memoryFirst ? withMemory : without;
  const b = memoryFirst ? without : withMemory;
  const judged = await model.completeStructured({
    purpose: 'chat',
    schema: judgeSchema,
    schemaName: 'MemoryABJudge',
    temperature: 0,
    thinking: 'disabled',
    maxOutputTokens: 400,
    messages: [
      msg.system('你是盲评员。A/B 中有一个回答使用了用户长期记忆。只判断哪一个更符合用户长期偏好；无法判断选 tie。'),
      msg.user(`用户请求：${c.query}\n\nA：\n${a}\n\nB：\n${b}`),
    ],
  });
  const winner =
    judged.value.winner === 'tie'
      ? 'tie'
      : (judged.value.winner === 'A') === memoryFirst
        ? 'with_memory'
        : 'without_memory';
  results.push({
    case: c.name,
    memory: c.memory,
    without,
    withMemory,
    winner,
    reason: judged.value.reason,
  });
}

console.log(JSON.stringify({ model: resolved.model.id, results }, null, 2));
