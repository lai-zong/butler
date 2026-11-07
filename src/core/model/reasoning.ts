/**
 * 思考强度：统一四档 + 供应商映射（产品级）
 *
 * ★★ 这一层存在的理由：
 *
 *   前端只给 `off | low | high | max`，**不判断模型能力**；
 *   后端负责把它翻译成各供应商真正接受的字段。
 *   前端如果自己做能力判断，换模型/换供应商时必然漂移。
 *
 * ★ 统一四档（会话设置里的值）：
 *
 *   off   显式关闭思考；关不掉时回退到该模型能接受的最低档，并记录实际值
 *   low   供应商支持就发 low；只支持开关的，如实记成“已开启”
 *   high  新对话默认值
 *   max   深度推理
 *
 * ★ 映射表（2026-11 依据官方文档，详见各分支注释）：
 *
 *   | 档位 | DeepSeek | GLM-4.5/4.6/4.7/5/5.1 | GLM-5.2 | GLM-5.3 | MiMo |
 *   |---|---|---|---|---|---|
 *   | off  | thinking=disabled | thinking=disabled | thinking=disabled | 不能关 → enabled+low | reasoning_effort=none |
 *   | low  | enabled+low | enabled（默认 high） | enabled+low（文档映射为 high） | enabled+low | 开启（强度不区分） |
 *   | high | enabled+high | enabled（默认 high） | enabled+high | enabled+high | 开启（强度不区分） |
 *   | max  | enabled+max | enabled（默认 high） | enabled+max | enabled+max | 开启（强度不区分） |
 *
 *   ⚠️ 其它 OpenAI 兼容 / Ollama：**没有把握就不发送**，
 *      不报错、不阻断；事件里如实记 `applied: null`。
 *
 * ★ 关键约束：`applied` 是**实际语义档位**，不是用户请求值。
 *   例如 GLM-5.3 请求 off，实际是 low —— 事件必须写 low，
 *   否则审计时无法解释“为什么它还是思考了”。
 */

export type ReasoningLevel = 'off' | 'low' | 'high' | 'max';

export type ReasoningProvider =
  | 'deepseek'
  | 'glm'
  | 'mimo'
  | 'openai-compatible'
  | 'ollama'
  | 'unknown';

export type ReasoningStyle = 'deepseek' | 'glm' | 'mimo' | 'none';

/** 适配器实际要写进请求体的字段（值已经是供应商能接受的字面量）。 */
export interface ReasoningDispatch {
  readonly style: ReasoningStyle;
  /** DeepSeek / GLM 的 `thinking.type` */
  readonly thinking?: 'enabled' | 'disabled';
  /** DeepSeek / GLM 的 `reasoning_effort`（只发供应商文档支持的枚举） */
  readonly reasoningEffort?: 'low' | 'high' | 'max';
  /**
   * MiMo 的 Chat Completions 用 `reasoning_effort`；
   * 官方只区分 `none`（关）与其余（开），所以这里只在关闭时发送。
   */
  readonly mimoEffort?: 'none';
}

export interface ReasoningPlan {
  /** 用户/会话请求的档位 */
  readonly requested: ReasoningLevel;
  readonly provider: ReasoningProvider;
  readonly style: ReasoningStyle;
  readonly dispatch: ReasoningDispatch;
  /**
   * 实际生效的语义档位。
   * `null` = 没有发送/无法判断（例如未知 OpenAI 兼容端点）。
   */
  readonly applied: ReasoningLevel | null;
  /** 回退原因（没有回退时缺省） */
  readonly fallbackReason?: string;
  /** 实际写进请求体的字段名（审计用，不含值） */
  readonly sentFields: readonly string[];
}

export const REASONING_LEVELS: readonly ReasoningLevel[] = ['off', 'low', 'high', 'max'];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max';
}

/** 桌宠旧设置只有这四档；`default` / `medium` 都映射到 high。 */
export type LegacyThinkingLevel = 'default' | 'low' | 'medium' | 'high';

export function isLegacyThinkingLevel(value: unknown): value is LegacyThinkingLevel {
  return value === 'default' || value === 'low' || value === 'medium' || value === 'high';
}

/**
 * 桌宠旧档位 → 统一四档。
 *
 * ★ `default` 与 `medium` 都映射到 `high`：
 *   旧实现里 default 就是“模型默认”（DeepSeek 默认 high），
 *   medium 与 high 在实际请求里也没有区别。映射到 high 最诚实。
 */
export function reasoningFromLegacyThinkingLevel(level: LegacyThinkingLevel): ReasoningLevel {
  switch (level) {
    case 'low':
      return 'low';
    case 'default':
    case 'medium':
    case 'high':
      return 'high';
  }
}

/**
 * 从模型配置/预设/模型名推断该用哪套供应商字段。
 *
 * ⚠️ 只做**后端映射**，前端不参与。
 *   未识别的走 openai-compatible，从而“不发送”。
 */
export function detectReasoningProvider(input: {
  readonly presetId?: string | undefined;
  readonly adapter?: string | undefined;
  readonly model: string;
}): ReasoningProvider {
  const preset = (input.presetId ?? '').toLowerCase();
  const adapter = (input.adapter ?? '').toLowerCase();
  const model = input.model.toLowerCase();

  if (preset === 'deepseek' || adapter === 'deepseek') return 'deepseek';
  if (preset === 'zhipu' || preset === 'bigmodel') return 'glm';
  // MiMo 没有内置预设，只能按模型名识别。
  if (/(^|[/:_-])mimo([-_.]|$)/i.test(model)) return 'mimo';
  // GLM 允许通过聚合器使用；字段名与官方一致。
  if (/(^|[/:_-])glm([-_.]|$)/i.test(model)) return 'glm';
  if (adapter === 'ollama' || preset === 'ollama') return 'ollama';
  return 'openai-compatible';
}

function glmVersion(model: string): { major: number; minor: number } | null {
  const m = /glm[-_ ]?(\d+)(?:\.(\d+))?/i.exec(model);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** GLM-5.3 系列官方明确：`thinking.type=disabled` 会报错。 */
function glmCannotDisable(model: string): boolean {
  const v = glmVersion(model);
  return v !== null && v.major === 5 && v.minor === 3;
}

/**
 * GLM 的 `reasoning_effort` 仅 GLM-5.2 及以上支持。
 * 官方枚举：max / high / low（5.3 只接受这三个）。
 */
function glmSupportsEffort(model: string): boolean {
  const v = glmVersion(model);
  if (v === null) return false;
  if (v.major > 5) return true;
  return v.major === 5 && v.minor >= 2;
}

/** GLM-5.2 官方映射：low / medium → high。 */
function glmEffortApplied(model: string, requested: 'low' | 'high' | 'max'): ReasoningLevel {
  const v = glmVersion(model);
  if (v !== null && v.major === 5 && v.minor === 2 && requested === 'low') return 'high';
  return requested;
}

export function planReasoning(input: {
  readonly level: ReasoningLevel;
  readonly provider: ReasoningProvider;
  readonly model: string;
}): ReasoningPlan {
  const level = input.level;
  const model = input.model;

  switch (input.provider) {
    case 'deepseek': {
      if (level === 'off') {
        return {
          requested: level,
          provider: 'deepseek',
          style: 'deepseek',
          dispatch: { style: 'deepseek', thinking: 'disabled' },
          applied: 'off',
          sentFields: ['thinking'],
        };
      }
      return {
        requested: level,
        provider: 'deepseek',
        style: 'deepseek',
        dispatch: { style: 'deepseek', thinking: 'enabled', reasoningEffort: level },
        applied: level,
        sentFields: ['thinking', 'reasoning_effort'],
      };
    }

    case 'glm': {
      const canDisable = !glmCannotDisable(model);
      const supportsEffort = glmSupportsEffort(model);

      if (level === 'off') {
        if (canDisable) {
          return {
            requested: level,
            provider: 'glm',
            style: 'glm',
            dispatch: { style: 'glm', thinking: 'disabled' },
            applied: 'off',
            sentFields: ['thinking'],
          };
        }
        // 关不掉 → 最低档 low（5.3 支持 low）。
        return {
          requested: level,
          provider: 'glm',
          style: 'glm',
          dispatch: { style: 'glm', thinking: 'enabled', reasoningEffort: 'low' },
          applied: 'low',
          fallbackReason: '该 GLM 型号不支持关闭思考，已回退到最低档 low',
          sentFields: ['thinking', 'reasoning_effort'],
        };
      }

      if (!supportsEffort) {
        return {
          requested: level,
          provider: 'glm',
          style: 'glm',
          dispatch: { style: 'glm', thinking: 'enabled' },
          applied: 'high',
          fallbackReason: '该 GLM 型号不支持 reasoning_effort，只开启思考（默认 high）',
          sentFields: ['thinking'],
        };
      }

      const applied = glmEffortApplied(model, level);
      return {
        requested: level,
        provider: 'glm',
        style: 'glm',
        dispatch: { style: 'glm', thinking: 'enabled', reasoningEffort: level },
        applied,
        ...(applied !== level
          ? { fallbackReason: `该 GLM 型号把 ${level} 映射为 ${applied}` }
          : {}),
        sentFields: ['thinking', 'reasoning_effort'],
      };
    }

    case 'mimo': {
      if (level === 'off') {
        return {
          requested: level,
          provider: 'mimo',
          style: 'mimo',
          dispatch: { style: 'mimo', mimoEffort: 'none' },
          applied: 'off',
          sentFields: ['reasoning_effort'],
        };
      }
      /**
       * ⚠️ 官方明确：`none` 关，其余档位**行为完全一致**。
       *    所以不要假装有 low/high/max —— 只发“开启”，实际记 high。
       */
      return {
        requested: level,
        provider: 'mimo',
        style: 'mimo',
        dispatch: { style: 'mimo' },
        applied: 'high',
        fallbackReason: 'MiMo 仅区分思考开/关，不区分强度；已按开启处理',
        sentFields: [],
      };
    }

    case 'ollama':
    case 'openai-compatible':
    case 'unknown':
      return {
        requested: level,
        provider: input.provider,
        style: 'none',
        dispatch: { style: 'none' },
        applied: null,
        fallbackReason: '未知/不支持的供应商，不发送思考强度字段（不阻断对话）',
        sentFields: [],
      };
  }
}
