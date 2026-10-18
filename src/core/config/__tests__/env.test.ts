/**
 * 环境配置的测试
 *
 * ★ 这个文件的存在理由是一个**真实发生过的问题**：
 *
 *   `.env.example` 曾声明 17 个变量，而代码只读了 2 个 ——
 *   其余改了**没有任何作用**。而这件事**不会报错**，
 *   只有把模板和代码逐行对照才会发现。
 *
 *   所以这里加的测试都是「防漂移」类型的：
 *   它们在模板与代码不同步时失败，而不是在功能坏掉时失败。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KNOWN_KEYS,
  RESERVED_KEYS,
  configProblems,
  limitsConfig,
  memoryConfig,
  modelConfig,
  privacyConfig,
  routingConfig,
  storageConfig,
  visionConfig,
} from '../env.js';

// ═══════════════════════════════════════════════════════════
// 默认值：必须与原硬编码值完全一致
// ═══════════════════════════════════════════════════════════

describe('★ 默认值与原硬编码值一致（这次改动不改变任何现有行为）', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [...KNOWN_KEYS];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function clearAll(): void {
    for (const k of KEYS) {
      saved[k] ??= process.env[k];
      delete process.env[k];
    }
  }

  it('未设环境变量时全部取原值', () => {
    clearAll();

    expect(modelConfig.baseUrl).toBe('https://api.deepseek.com');
    expect(routingConfig.confidenceThreshold).toBe(0.6);
    expect(memoryConfig.emaAlpha).toBe(0.15);
    expect(memoryConfig.dormantAfterMs).toBe(60 * 24 * 60 * 60 * 1000);
    expect(memoryConfig.archiveBelowFitness).toBe(0.25);
    expect(memoryConfig.exploratoryRatio).toBe(0.1);
    // ★ v8：默认**不设轮次上限**（方案 §14 / D-30），不再是 8
    expect(limitsConfig.maxRoundsPerSession).toBe(Number.POSITIVE_INFINITY);
    expect(limitsConfig.toolTimeoutMs).toBe(15_000);
    expect(limitsConfig.dailyTokenTaskLimit).toBe(10);
    expect(privacyConfig.behaviorObservationEnabled).toBe(false);
    expect(privacyConfig.activityRawRetentionDays).toBe(7);
    expect(storageConfig.localFirst).toBe(true);
    expect(storageConfig.exportIncludeCredentials).toBe(false);
    expect(storageConfig.userId).toBe('local');
  });

  it('设了环境变量时真的生效（这就是修这个问题的目的）', () => {
    clearAll();

    process.env['MAX_ROUNDS_PER_SESSION'] = '20';
    expect(limitsConfig.maxRoundsPerSession).toBe(20);

    process.env['FITNESS_EMA_ALPHA'] = '0.4';
    expect(memoryConfig.emaAlpha).toBe(0.4);

    process.env['MEMORY_DORMANT_DAYS'] = '30';
    expect(memoryConfig.dormantAfterMs).toBe(30 * 24 * 60 * 60 * 1000);

    process.env['TOOL_TIMEOUT_MS'] = '30000';
    expect(limitsConfig.toolTimeoutMs).toBe(30_000);

    process.env['ROUTING_CONFIDENCE_THRESHOLD'] = '0.8';
    expect(routingConfig.confidenceThreshold).toBe(0.8);

    process.env['BEHAVIOR_OBSERVATION_ENABLED'] = 'true';
    expect(privacyConfig.behaviorObservationEnabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 解析失败：退回默认值，不抛错，但要记下问题
// ═══════════════════════════════════════════════════════════

describe('★ 写错不崩，而是退回默认值并记录', () => {
  const SAVED = process.env['TOOL_TIMEOUT_MS'];

  afterEach(() => {
    if (SAVED === undefined) delete process.env['TOOL_TIMEOUT_MS'];
    else process.env['TOOL_TIMEOUT_MS'] = SAVED;
  });

  it('非数字 → 退回默认值', () => {
    process.env['TOOL_TIMEOUT_MS'] = 'abc';
    expect(limitsConfig.toolTimeoutMs).toBe(15_000);
    // ⚠️ 关键：不是静默退回，而是记下问题供 doctor 展示
    expect(configProblems().some((p) => p.key === 'TOOL_TIMEOUT_MS')).toBe(true);
  });

  it('超时低于下限 → 退回默认值（太短的超时会让所有命令都失败）', () => {
    process.env['TOOL_TIMEOUT_MS'] = '10';
    expect(limitsConfig.toolTimeoutMs).toBe(15_000);
  });

  it('空字符串视为未设置（不是"设成了空"）', () => {
    process.env['TOOL_TIMEOUT_MS'] = '   ';
    expect(limitsConfig.toolTimeoutMs).toBe(15_000);
  });
});

// ═══════════════════════════════════════════════════════════
// 边界：防止把服务配成不可用
// ═══════════════════════════════════════════════════════════

describe('边界保护', () => {
  const KEYS = ['ROUTING_CONFIDENCE_THRESHOLD', 'MAX_ROUNDS_PER_SESSION', 'FITNESS_EMA_ALPHA'] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('★ 路由阈值 > 1 会让所有请求都转询问 —— 必须挡住', () => {
    saved['ROUTING_CONFIDENCE_THRESHOLD'] = process.env['ROUTING_CONFIDENCE_THRESHOLD'];
    process.env['ROUTING_CONFIDENCE_THRESHOLD'] = '1.5';
    // 退回默认值，而不是让路由全部失效
    expect(routingConfig.confidenceThreshold).toBe(0.6);
  });

  it('★ 轮次上限 0 会让工具循环一次都不跑 —— 必须挡住', () => {
    saved['MAX_ROUNDS_PER_SESSION'] = process.env['MAX_ROUNDS_PER_SESSION'];
    process.env['MAX_ROUNDS_PER_SESSION'] = '0';
    // v8：拦截后回退到"不设上限"（Infinity），而不是 8
    expect(limitsConfig.maxRoundsPerSession).toBe(Number.POSITIVE_INFINITY);
  });

  it('★ EMA α = 0 会让适应度永不更新 —— 必须挡住', () => {
    saved['FITNESS_EMA_ALPHA'] = process.env['FITNESS_EMA_ALPHA'];
    process.env['FITNESS_EMA_ALPHA'] = '0';
    expect(memoryConfig.emaAlpha).toBe(0.15);
  });
});

// ═══════════════════════════════════════════════════════════
// ★★ 防漂移：模板与代码必须同步
// ═══════════════════════════════════════════════════════════

describe('★★ .env.example 与代码一致（防的就是那个真实发生过的问题）', () => {
  const root = join(process.cwd());
  const example = readFileSync(join(root, '.env.example'), 'utf8');

  /** 模板里的**活跃**行（未被注释）的变量名。 */
  const activeInTemplate = example
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => l.split('=')[0] ?? '');

  /** 模板里出现过的变量名（含注释掉的预留位）。 */
  const mentionedInTemplate = new Set(
    example
      .split('\n')
      .map((l) => l.replace(/^#\s*/, ''))
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split('=')[0] ?? ''),
  );

  it('模板里的活跃变量都被代码认识（否则会静默无效）', () => {
    const unknown = activeInTemplate.filter((k) => !KNOWN_KEYS.includes(k));
    expect(unknown, `模板活跃但代码不认识：${unknown.join(', ')}`).toEqual([]);
  });

  it('★ 模板的活跃变量**不含**预留位（预留位不能是活跃行）', () => {
    const wronglyActive = activeInTemplate.filter((k) => RESERVED_KEYS.includes(k));
    expect(
      wronglyActive,
      `以下变量尚未接入，在模板里不能是活跃行（会让人以为配了就生效）：${wronglyActive.join(', ')}`,
    ).toEqual([]);
  });

  it('预留位必须在模板里以注释形式出现（说明位置，但不误导）', () => {
    const missing = RESERVED_KEYS.filter((k) => !mentionedInTemplate.has(k));
    expect(missing, `预留位未在模板中说明：${missing.join(', ')}`).toEqual([]);
  });

  it('★ 代码认识的**非预留**变量都必须在模板里有活跃行（可配但无文档 = 隐患）', () => {
    const undocumented = KNOWN_KEYS.filter(
      (k) => !RESERVED_KEYS.includes(k) && !activeInTemplate.includes(k),
    );
    expect(undocumented, `可配但模板未列：${undocumented.join(', ')}`).toEqual([]);
  });

  it('RESERVED_KEYS 是 KNOWN_KEYS 的子集', () => {
    const notKnown = RESERVED_KEYS.filter((k) => !KNOWN_KEYS.includes(k));
    expect(notKnown).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 预留位必须自报家门
// ═══════════════════════════════════════════════════════════

describe('预留位如实标注', () => {
  it('visionConfig 明确标记为预留', () => {
    // 这个断言的价值在于：将来真接入视觉模型时，必须**主动**改掉它，
    // 而不是忘了改而让人以为已经支持
    expect(visionConfig.reserved).toBe(true);
  });
});
