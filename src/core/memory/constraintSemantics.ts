/**
 * 约束语义与适用性 —— 硬约束校验的前置判别
 *
 * 背景（2026-11-17 实机事故）：
 *   「我最近在控糖，晚上尽量不吃甜的和油炸的」被模型归成 constraint，
 *   并自动成为 global_constraint；之后:
 *     · 硬约束恒被召回；
 *     · 工具循环 report.artifacts 恒为空；
 *     · 硬约束校验只看 artifacts，不看 reply；
 *     · 每轮都被判「未处理」，连写文件任务也被 blocking。
 *
 * 本模块把两个概念拆开：
 *   1. 语义：什么才算真正的安全硬约束；偏好不能被当成安全规则。
 *   2. 适用性：这条硬约束是否真的和本次任务/产出有关。
 *
 * 原则：
 *   · 硬约束是安全边界，不能因为“任务看起来无关”就无条件跳过；
 *   · 也不能因为一条全局记忆存在，就要求所有任务都提它；
 *   · 不确定时不静默 blocking，先按 not_applicable/unknown 交给上层审计。
 */

import type { DomainId } from '../domain/types.js';
import type { ExecutionReport } from '../execution/types.js';
import { coreOf, hasAnyNgram } from '../text/keywords.js';

/** 真正的安全语义：过敏、用药、医嘱、明确禁令等。 */
const STRONG_SAFETY_PATTERN =
  /过敏|过敏性|禁用|禁止|医嘱|药物|用药|华法林|中毒|休克|急救|肾上腺素|乳糖不耐|疾病|手术|怀孕|哺乳|不能(吃|喝|用|碰|接|服)|不得(吃|喝|用|碰|接|服)|忌口|禁忌/;

/**
 * 偏好/软约束语义。
 *
 * 注意：这里刻意不把「避免」「不要」放进来 —— 它们可能是安全禁令。
 * 「尽量」「希望」「优先」「控糖」这类才是明确的软表达。
 */
const SOFT_PREFERENCE_PATTERN =
  /尽量|希望|优先|偏好|喜欢|不喜欢|少吃|减少|控制|控糖|减脂|减肥|最好|建议|以后|习惯|倾向|不想|不爱/;

/** 饮食/健康/身体相关话题。用于判断硬约束是否与本次任务/产出有关。 */
const FOOD_HEALTH_PATTERN =
  /过敏|过敏原|食物|食品|饮食|吃|喝|餐|饭|外卖|餐厅|菜|食谱|食材|零食|饮料|水果|蔬菜|肉|蛋|奶|花生|坚果|海鲜|大豆|豆腐|油炸|甜|糖|营养|健康|医嘱|医生|药|服药|用药|药物|华法林|维生素|忌口|忌|血糖|血压|减脂|减肥|乳糖|火锅|烧烤|奶茶|咖啡/;

export type FactCategory = 'identity' | 'constraint' | 'preference' | 'context';
export type ConstraintApplicability = 'applicable' | 'not_applicable' | 'unknown';

export interface ApplicabilityResult {
  readonly applicability: ConstraintApplicability;
  readonly reason: string;
}

/** 是否具有不可协商的安全语义。 */
export function isStrongSafetyContent(content: string): boolean {
  return STRONG_SAFETY_PATTERN.test(content);
}

/** 是否是明确的偏好/软表达（且没有安全语义）。 */
export function isSoftPreferenceContent(content: string): boolean {
  return SOFT_PREFERENCE_PATTERN.test(content) && !isStrongSafetyContent(content);
}

/**
 * 归一化模型给出的类别。
 *
 * 模型把「尽量/控糖」标成 constraint 是这次事故的起点。
 * 在进入准入之前加一道确定性护栏：
 *   · 有安全语义 → 提升为 constraint；
 *   · 只是软表达 → 降为 preference；
 *   · 其它保持原样。
 */
export function normalizeFactCategory(
  category: FactCategory,
  content: string,
): FactCategory {
  if (isStrongSafetyContent(content)) return 'constraint';
  if (category === 'constraint' && isSoftPreferenceContent(content)) return 'preference';
  return category;
}

/** 饮食/健康类偏好适合归到 health 领域；不强行给硬约束塞 domain。 */
export function domainForFactContent(content: string): DomainId | undefined {
  return FOOD_HEALTH_PATTERN.test(content) ? 'health' : undefined;
}

/** 文本是否触及饮食/健康话题。 */
export function hasFoodHealthTopic(text: string): boolean {
  return FOOD_HEALTH_PATTERN.test(text);
}

function reportText(report: ExecutionReport): string {
  const artifactText = report.artifacts
    .map((artifact) => {
      if (artifact.kind === 'text') return artifact.content;
      if (artifact.kind === 'list' || artifact.kind === 'plan') return artifact.content.join('\n');
      if (artifact.kind === 'table') {
        return [
          artifact.content.columns.join(' | '),
          ...artifact.content.rows.map((row) => row.join(' | ')),
        ].join('\n');
      }
      if (artifact.kind === 'quiz') {
        return artifact.content.map((q) => `${q.stem} ${q.options.join(' ')}`).join('\n');
      }
      return '';
    })
    .join('\n');
  const findingText = (report.findings ?? []).map((f) => f.statement).join('\n');
  return [report.reply, artifactText, findingText].filter((s) => s.length > 0).join('\n');
}

/**
 * 判断一条硬约束对本次任务是否适用。
 *
 * 判断顺序：
 *   1. 遗留的软偏好 global_constraint：不参与机械 blocking（兼容旧数据）；
 *   2. 任务/产出明确触及饮食健康：适用；
 *   3. 其它语义：用核心词的连续片段做相关性检查；
 *   4. 没有任务/产出文本：unknown（上层不得把它当成“违反”）。
 *
 * 这不是“按 domain 简单跳过”。domain 只是线索之一，真正看的是
 * 任务目标、执行产出和工具结果是否触及约束话题。
 */
export function assessConstraintApplicability(args: {
  readonly content: string;
  readonly taskGoal: string;
  readonly taskDomains: readonly DomainId[];
  readonly reports: readonly ExecutionReport[];
}): ApplicabilityResult {
  const content = args.content.trim();
  if (content.length === 0) {
    return { applicability: 'unknown', reason: '约束内容为空，无法判断适用性' };
  }

  // 旧数据兼容：曾经被错存为硬约束的“尽量/希望/控糖”不得继续 blocking。
  // 新数据在提取/准入阶段就会被降级；这里只负责让旧库不再卡死对话。
  if (isSoftPreferenceContent(content)) {
    return {
      applicability: 'not_applicable',
      reason: '该条为偏好/软表达，不应作为机械硬约束拦截',
    };
  }

  const context = [
    args.taskGoal,
    ...args.reports.map(reportText),
    ...args.taskDomains,
  ]
    .filter((s) => s.trim().length > 0)
    .join('\n');

  if (context.trim().length === 0) {
    return {
      applicability: 'unknown',
      reason: '没有任务/产出文本，无法判断是否适用',
    };
  }

  if (hasFoodHealthTopic(content)) {
    if (hasFoodHealthTopic(context) || args.taskDomains.includes('health')) {
      return {
        applicability: 'applicable',
        reason: '任务或产出触及饮食/健康话题',
      };
    }
    return {
      applicability: 'not_applicable',
      reason: '任务与产出均未触及饮食/健康话题',
    };
  }

  // 非饮食健康类硬约束：用约束核心词的连续片段判断是否共现。
  const core = coreOf(content);
  if (core.length >= 2 && hasAnyNgram(context, core, 2)) {
    return {
      applicability: 'applicable',
      reason: '任务或产出命中了约束核心词',
    };
  }

  return {
    applicability: 'not_applicable',
    reason: '任务与产出均未触及该约束',
  };
}
