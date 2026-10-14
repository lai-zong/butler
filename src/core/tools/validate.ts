/**
 * 工具参数校验
 *
 * 设计依据：方案 § 12「输出稳定可控」
 *
 * ⚠️ **模型生成的工具参数不能直接信。**
 *    它会漏必填字段、会把数组写成字符串、会把数字写成 "5"。
 *    如果不校验就透传给工具，错误会在执行阶段以"文件系统错误"之类的
 *    面目出现，而用户看到的是"AI 连参数都写不对"。
 *
 *    在边界校验，才能给出**可纠正的反馈**：
 *    "缺少必填参数 path" 比 "路径不存在：undefined" 有用得多。
 *
 * 不引入 ajv 之类的完整校验器：工具的 JSON Schema 由我们自己声明，
 * 形状很简单（object + 基础类型 + 数组 + enum），手写足够且无依赖。
 */

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /** 校验通过时的规范化值（如 "5" → 5） */
  readonly value?: unknown;
}

type JsonSchema = Record<string, unknown>;

export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const normalized = validateNode(schema, args, '', issues);
  return issues.length === 0
    ? { ok: true, issues: [], value: normalized }
    : { ok: false, issues };
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown {
  const type = schema['type'];

  // 处理 enum（放在类型前，因为 enum 常与 string 同时出现）
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues)) {
    if (!enumValues.includes(value as never)) {
      issues.push({
        path: path || '(root)',
        message: `必须是以下之一：${enumValues.map((v) => JSON.stringify(v)).join(' / ')}`,
      });
      return value;
    }
    return value;
  }

  switch (type) {
    case 'object':
      return validateObject(schema, value, path, issues);

    case 'array':
      return validateArray(schema, value, path, issues);

    case 'string':
      if (typeof value !== 'string') {
        issues.push({ path: path || '(root)', message: `应为字符串，收到 ${typeName(value)}` });
        return value;
      }
      return value;

    case 'number':
    case 'integer': {
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (type === 'integer' && !Number.isInteger(value)) {
          issues.push({ path: path || '(root)', message: '应为整数' });
        }
        return value;
      }
      // 温和纠正：模型常把数字写成字符串
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        const n = Number(value);
        if (type === 'integer' && !Number.isInteger(n)) {
          issues.push({ path: path || '(root)', message: '应为整数' });
          return value;
        }
        return n;
      }
      issues.push({ path: path || '(root)', message: `应为数字，收到 ${typeName(value)}` });
      return value;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      // 温和纠正："true" / "false"
      if (value === 'true') return true;
      if (value === 'false') return false;
      issues.push({ path: path || '(root)', message: `应为布尔值，收到 ${typeName(value)}` });
      return value;
    }

    default:
      // 未声明 type 的字段不做限制（schema 可能只给了 description）
      return value;
  }
}

function validateObject(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path: path || '(root)', message: `应为对象，收到 ${typeName(value)}` });
    return value;
  }

  const obj = value as Record<string, unknown>;
  const properties = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (schema['required'] ?? []) as readonly string[];
  const out: Record<string, unknown> = {};

  // 必填检查
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      issues.push({ path: path ? `${path}.${key}` : key, message: '缺少必填参数' });
    }
  }

  for (const [key, v] of Object.entries(obj)) {
    const childSchema = properties[key];
    const childPath = path ? `${path}.${key}` : key;
    if (childSchema === undefined) {
      // 未声明的字段：保留但不动（有些工具会用到额外字段）
      out[key] = v;
      continue;
    }
    out[key] = validateNode(childSchema, v, childPath, issues);
  }

  return out;
}

function validateArray(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown {
  if (!Array.isArray(value)) {
    issues.push({ path: path || '(root)', message: `应为数组，收到 ${typeName(value)}` });
    return value;
  }

  const itemSchema = schema['items'] as JsonSchema | undefined;
  if (!itemSchema) return value;

  return value.map((item, i) => validateNode(itemSchema, item, `${path}[${i}]`, issues));
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 把校验问题转成给模型看的一句话（要可纠正，不能只说"参数错"）。 */
export function issuesToMessage(toolName: string, issues: readonly ValidationIssue[]): string {
  const lines = issues.slice(0, 5).map((i) => `  · ${i.path}：${i.message}`);
  const more = issues.length > 5 ? `\n  …另有 ${issues.length - 5} 处` : '';
  return `调用「${toolName}」的参数校验未通过：\n${lines.join('\n')}${more}\n请修正后重新调用。`;
}
