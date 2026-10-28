/**
 * 记忆提取效果评测（真实记忆模型）。
 *
 * 不是只测“接口返回 200”，而是用带标准答案的对话测：
 *   · 该记住的稳定事实/偏好是否提取；
 *   · 临时任务参数是否被错误写成长期记忆；
 *   · 每条是否有用户消息来源。
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
if (roles.memory === null) throw new Error('memory role not configured');
const resolved = await resolveProfileModel(
  DATA_DIR,
  roles.memory.profileId,
  roles.memory.modelId,
  'chat',
);
if (resolved === null) throw new Error('memory model missing');
const model =
  resolved.preset.adapter === 'deepseek'
    ? new DeepSeekModel(resolved.config)
    : new OpenAICompatibleModel(
        resolved.config,
        resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
      );

interface Case {
  readonly name: string;
  readonly domain: string;
  readonly messages: readonly string[];
  readonly expected: readonly string[];
  /** 同义表达；避免因为模型换了同义词就被误判为漏提取。 */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  readonly temporary: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: 'food_1',
    domain: '饮食',
    messages: [
      '我平时不吃香菜，这个一直是这样。',
      '我口味偏清淡，不太能吃辣。',
      '今晚家里有鸡蛋、豆腐和西兰花。',
      '想半小时内做一顿饭。',
    ],
    expected: ['香菜', '清淡'],
    temporary: ['鸡蛋', '豆腐', '西兰花'],
  },
  {
    name: 'health_1',
    domain: '健康',
    messages: [
      '我最近睡眠不太好。',
      '我一般十二点以后才睡，早上七点半起。',
      '先不要建议我吃药，我想先改习惯。',
      '这周先记录一下作息。',
    ],
    expected: ['十二点', '七点半', '吃药'],
    aliases: { 吃药: ['用药', '药物'] },
    temporary: ['这周'],
  },
  {
    name: 'coding_1',
    domain: '编程',
    messages: [
      '我做前端重构时习惯先补测试再改实现。',
      '我不喜欢只改样式、行为不一致的改法。',
      '这次先做登录和列表两页。',
      '下周一要交。',
    ],
    expected: ['测试', '行为一致'],
    aliases: { 行为一致: ['行为不一致', '行为保持', '行为一起'] },
    temporary: ['登录', '列表', '下周一'],
  },
  {
    name: 'art_1',
    domain: '美术',
    messages: [
      '我做产品海报时偏好低饱和的蓝绿色。',
      '我不喜欢高对比的配色。',
      '标题周围要留比较多的空白。',
      '这次海报是 1080×1440。',
    ],
    expected: ['低饱和', '蓝绿色', '空白'],
    temporary: ['1080', '1440'],
  },
  {
    name: 'food_2',
    domain: '饮食',
    messages: [
      '我对花生过敏，这个要一直记住。',
      '我平时不太吃甜食。',
      '今天想点一杯饮料。',
      '不要太甜。',
    ],
    expected: ['花生', '甜'],
    temporary: ['今天'],
  },
  {
    name: 'work_2',
    domain: '工作',
    messages: [
      '我开会时喜欢先看结论，再看细节。',
      '我不喜欢一上来讲太多背景。',
      '这次周会讲一下项目进度。',
      '大概十分钟。',
    ],
    expected: ['先看结论', '背景'],
    aliases: { 先看结论: ['先听结论', '结论先', '结论'] },
    temporary: ['周会', '十分钟'],
  },
  {
    name: 'life_2',
    domain: '生活',
    messages: [
      '我周末通常喜欢在家休息，不太爱出门。',
      '我不喜欢太吵的地方。',
      '这周末想找一部纪录片看。',
      '不要太长，两小时以内。',
    ],
    expected: ['在家', '吵'],
    temporary: ['纪录片', '两小时'],
  },
  {
    name: 'study_2',
    domain: '学习',
    messages: [
      '我背单词时更喜欢用例句记，不背孤立词表。',
      '我晚上记忆效果比早上好。',
      '这周要准备一次小测。',
      '范围是前两章。',
    ],
    expected: ['例句', '晚上'],
    temporary: ['这周', '前两章'],
  },
  {
    name: 'finance_3',
    domain: '财务',
    messages: [
      '我买东西习惯先比较性价比，不追求最新款。',
      '大件我会等活动再买。',
      '这次想换一台笔记本。',
      '预算大概五千。',
    ],
    expected: ['性价比', '活动'],
    temporary: ['这次', '五千'],
  },
  {
    name: 'relationship_3',
    domain: '人际',
    messages: [
      '我不喜欢别人临时改计划。',
      '如果有变化，最好提前说。',
      '这周末约了朋友吃饭。',
      '地点还没定。',
    ],
    expected: ['临时', '提前'],
    temporary: ['这周末', '地点'],
  },
  {
    name: 'planning_3',
    domain: '计划',
    messages: [
      '我早上效率最高，重要的事一般放在上午。',
      '晚上不太想处理复杂工作。',
      '明天要交一个报告。',
      '今晚先把数据整理好。',
    ],
    expected: ['早上', '晚上'],
    temporary: ['明天', '今晚'],
  },
  {
    name: 'cooking_3',
    domain: '烹饪',
    messages: [
      '我口味偏淡，做菜不喜欢放太多盐。',
      '我很少吃油炸食品。',
      '今晚想做个汤。',
      '冰箱里有西红柿和鸡蛋。',
    ],
    expected: ['淡', '油炸'],
    temporary: ['今晚', '西红柿'],
  },
  {
    name: 'coding_3',
    domain: '编程',
    messages: [
      '我平时用 VS Code，习惯了。',
      '我不喜欢没有类型检查的项目。',
      '这个项目要接一个支付接口。',
      '本周先把文档看完。',
    ],
    expected: ['VS Code', '类型'],
    temporary: ['这个项目', '本周'],
  },
  {
    name: 'health_3',
    domain: '健康',
    messages: [
      '我对青霉素过敏。',
      '我平时很少吃止痛药。',
      '这次感冒有点咳嗽。',
      '先观察两天。',
    ],
    expected: ['青霉素', '止痛药'],
    temporary: ['这次', '两天'],
  },
  {
    name: 'art_3',
    domain: '美术',
    messages: [
      '我整体偏好极简风。',
      '不喜欢太花哨的装饰。',
      '这张图想做成横版。',
      '主色先用蓝色试试。',
    ],
    expected: ['极简', '花哨'],
    temporary: ['这张图', '蓝色'],
  },
  {
    name: 'study_3',
    domain: '学习',
    messages: [
      '我晚上记忆效果比早上好。',
      '我喜欢用思维导图整理知识。',
      '这周有一次考试。',
      '重点是第三章。',
    ],
    expected: ['晚上', '思维导图'],
    temporary: ['这周', '第三章'],
  },
];

const now = Date.now();
const results = [];
for (const c of CASES) {
  const messages: DiarySourceMessage[] = c.messages.map((text, i) => ({
    id: `${c.name}_u${i}`,
    role: 'user',
    text,
    createdAt: now + i,
  }));
  const r = await generateDiary({
    model,
    clock: new SystemClock(),
    sessionId: `effect_${c.name}`,
    userId: 'effect',
    dayKey: '2026-10-28',
    messages,
    minUserMessages: 4,
  });
  const items = r.entry.items.map((i) => ({
    kind: i.kind,
    content: i.content,
    evidence: i.evidence,
  }));
  const all = items.map((i) => i.content).join('\n');
  const matched = (expected: string): boolean =>
    [expected, ...(c.aliases?.[expected] ?? [])].some((x) => all.includes(x));
  const expectedHits = c.expected.filter(matched);
  const leaks = c.temporary.filter((x) => all.includes(x));
  results.push({
    case: c.name,
    domain: c.domain,
    items,
    expectedHits,
    expectedMisses: c.expected.filter((x) => !matched(x)),
    temporaryLeaks: leaks,
    evidenceUserBacked: items.every((i) =>
      i.evidence.every((id) => id.startsWith(`${c.name}_u`)),
    ),
  });
}

const expectedTotal = CASES.reduce((n, c) => n + c.expected.length, 0);
const expectedHit = results.reduce((n, r) => n + r.expectedHits.length, 0);
const leakCount = results.reduce((n, r) => n + r.temporaryLeaks.length, 0);
const evidenceOk = results.filter((r) => r.evidenceUserBacked).length;
console.log(
  JSON.stringify(
    {
      model: resolved.model.id,
      metrics: {
        expectedTotal,
        expectedHit,
        extractionRecall: Number((expectedHit / expectedTotal).toFixed(3)),
        temporaryLeakCount: leakCount,
        evidenceUserBacked: `${evidenceOk}/${results.length}`,
      },
      results,
    },
    null,
    2,
  ),
);
