/**
 * `PATCH /api/sessions/[id]` 的请求校验。
 *
 * ★ 放在独立模块是为了**能直接单测非法输入**：
 *   路由文件在测试里要 mock 整个 runtime，校验逻辑不该被它拖住。
 *
 * 支持的字段（本轮范围）：
 *   · persona       string ≤ 8000 字符
 *   · reasoning     off | low | high | max
 *   · memoryMode    boolean 或 'on' | 'off'（前端可发布尔，也可发枚举）
 *   · workspace     string（绝对路径，trim 后非空）或 null（跟随应用默认）
 *   · permission    'read-only' | 'workspace' | 'full' 或 null（跟随应用默认）
 *   · modelProfileId + modelId  必须成对出现
 *
 * ★ 这里只做**类型与语法**校验：
 *   工作区是否存在、是否目录、realpath、是否受保护目录，需要访问磁盘，
 *   由路由里的 `assertSessionWorkspace` 负责（见 `sessionWorkspace.ts`）。
 */

import { isAbsolute } from 'node:path';

import {
  PERSONA_MAX_CHARS,
  isSessionMemoryMode,
  isSessionPermission,
  type SessionMemoryMode,
  type SessionPermission,
} from '@/core/chat/settings.js';
import { isReasoningLevel, type ReasoningLevel } from '@/core/model/reasoning.js';

export interface SessionSettingsPatch {
  readonly persona?: string;
  readonly reasoning?: ReasoningLevel;
  readonly memoryMode?: SessionMemoryMode;
  readonly workspace?: string | null;
  readonly permission?: SessionPermission | null;
  readonly modelProfileId?: string;
  readonly modelId?: string;
  /** 本会话启用的技能 id；空数组 = 不使用技能。 */
  readonly skills?: readonly string[];
}

export type ParseSessionSettingsPatchResult =
  | { readonly ok: true; readonly patch: SessionSettingsPatch }
  | { readonly ok: false; readonly error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseSessionSettingsPatch(
  raw: unknown,
): ParseSessionSettingsPatchResult {
  const body = asRecord(raw);
  if (body === null) return { ok: false, error: '请求体必须是 JSON 对象' };

  let persona: string | undefined;
  if ('persona' in body) {
    if (typeof body['persona'] !== 'string') {
      return { ok: false, error: 'persona 必须是字符串' };
    }
    if (body['persona'].length > PERSONA_MAX_CHARS) {
      return { ok: false, error: `persona 最多 ${PERSONA_MAX_CHARS} 个字符` };
    }
    persona = body['persona'];
  }

  let reasoning: ReasoningLevel | undefined;
  if ('reasoning' in body) {
    if (!isReasoningLevel(body['reasoning'])) {
      return { ok: false, error: 'reasoning 只能是 off / low / high / max' };
    }
    reasoning = body['reasoning'];
  }

  let memoryMode: SessionMemoryMode | undefined;
  if ('memoryMode' in body) {
    const value = body['memoryMode'];
    if (typeof value === 'boolean') {
      memoryMode = value ? 'on' : 'off';
    } else if (isSessionMemoryMode(value)) {
      memoryMode = value;
    } else {
      return { ok: false, error: 'memoryMode 必须是布尔值或 on / off' };
    }
  }

  let modelProfileId: string | undefined;
  let modelId: string | undefined;
  const hasProfile = 'modelProfileId' in body;
  const hasModel = 'modelId' in body;
  if (hasProfile || hasModel) {
    if (!hasProfile || !hasModel) {
      return { ok: false, error: 'modelProfileId 与 modelId 必须同时提供' };
    }
    if (
      typeof body['modelProfileId'] !== 'string' ||
      body['modelProfileId'].trim().length === 0 ||
      typeof body['modelId'] !== 'string' ||
      body['modelId'].trim().length === 0
    ) {
      return { ok: false, error: 'modelProfileId 与 modelId 必须是非空字符串' };
    }
    modelProfileId = body['modelProfileId'].trim();
    modelId = body['modelId'].trim();
  }

  let skills: readonly string[] | undefined;
  if ('skills' in body) {
    const value = body['skills'];
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
      return { ok: false, error: 'skills 必须是字符串数组' };
    }
    const clean = [...new Set(value.map((x) => x.trim()).filter((x) => x.length > 0))];
    if (clean.length > 20) return { ok: false, error: '每段对话最多启用 20 个技能' };
    skills = clean;
  }

  let workspace: string | null | undefined;
  if ('workspace' in body) {
    const value = body['workspace'];
    if (value === null) {
      workspace = null;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: 'workspace 必须是非空绝对路径，或 null（跟随应用默认）' };
      }
      if (!isAbsolute(trimmed)) {
        return { ok: false, error: `workspace 必须是绝对路径：${trimmed}` };
      }
      workspace = trimmed;
    } else {
      return { ok: false, error: 'workspace 必须是字符串路径或 null' };
    }
  }

  let permission: SessionPermission | null | undefined;
  if ('permission' in body) {
    const value = body['permission'];
    if (value === null) {
      permission = null;
    } else if (isSessionPermission(value)) {
      permission = value;
    } else {
      return { ok: false, error: 'permission 只能是 read-only / workspace / full 或 null' };
    }
  }

  const patch: SessionSettingsPatch = {
    ...(persona !== undefined ? { persona } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(memoryMode !== undefined ? { memoryMode } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(modelProfileId !== undefined && modelId !== undefined
      ? { modelProfileId, modelId }
      : {}),
  };

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: '没有可更新的设置' };
  }
  return { ok: true, patch };
}
