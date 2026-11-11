/**
 * 权限页的纯逻辑：GET 归一、PUT 请求体与失败回滚。
 *
 * ★ 为什么单独一层：
 *   面板只负责渲染与交互，真正的“点一下发什么、失败怎么退回去”放在这里，
 *   可以脱离 DOM 单测（项目没有 jsdom；网络出口用 stub fetch 覆盖）。
 *
 * ⚠️ 语义约定（后端 /api/permissions）：
 *   · mode 未配置时是 null，实际按仅查看运行；界面预选 view，但不再展示
 *     “未配置/默认只读”字样。
 *   · confirmActions 缺省 true；每次切换立即持久化。
 *   · 没有 timeoutMs —— 确认请求只由用户答复或连接关闭收敛。
 */

import { fetchJson } from '../lib/api.js';

export type PermissionMode = 'view' | 'workspace' | 'full';

/** 界面上展示的权限状态；mode 不可能是 null（未配置 → view）。 */
export interface PermissionsSnapshot {
  readonly mode: PermissionMode;
  readonly confirmActions: boolean;
}

export interface PermissionsGetResponse {
  readonly mode: PermissionMode | null;
  readonly confirmActions: boolean;
  /** 旧数据标记；界面不再展示，仅用于确认后端契约。 */
  readonly legacy?: boolean;
}

export interface PermissionsPutResponse {
  readonly ok?: boolean;
  readonly mode: PermissionMode | null;
  readonly confirmActions: boolean;
}

/** PUT 只接受部分更新；一次请求只改一个字段。 */
export type PermissionsPatch =
  | { readonly mode: PermissionMode }
  | { readonly confirmActions: boolean };

export type PermissionsPut = (
  patch: PermissionsPatch,
) => Promise<PermissionsPutResponse>;

export interface PermissionsSaveResult {
  readonly snapshot: PermissionsSnapshot;
  readonly ok: boolean;
  /** 失败时保留原始错误，由调用方用 errorMessage() 转成文案。 */
  readonly error: unknown;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'view' || value === 'workspace' || value === 'full';
}

/**
 * GET → 选中态。
 *
 * ★ 未配置时预选 view：界面不写“默认只读”，选中态本身就是答案。
 * ★ confirmActions 只在明确为 false 时关闭，其余按后端默认 true 处理。
 */
export function snapshotsFromGet(res: PermissionsGetResponse): PermissionsSnapshot {
  return {
    mode: isPermissionMode(res.mode) ? res.mode : 'view',
    confirmActions: res.confirmActions !== false,
  };
}

/**
 * PUT 返回 → 新状态。
 *
 * 服务端返回字段缺失或异常时保留旧值，绝不把界面推进到非法档位。
 */
export function applyPutResult(
  previous: PermissionsSnapshot,
  res: PermissionsPutResponse,
): PermissionsSnapshot {
  return {
    mode: isPermissionMode(res.mode) ? res.mode : previous.mode,
    confirmActions:
      typeof res.confirmActions === 'boolean'
        ? res.confirmActions
        : previous.confirmActions,
  };
}

/**
 * 网络出口：PUT /api/permissions。
 *
 * ★ 与 saveMode / saveConfirmActions 拆开是为了让“发什么请求”和
 *   “失败怎么回滚”能分别验证。
 */
export async function putPermissions(
  patch: PermissionsPatch,
): Promise<PermissionsPutResponse> {
  return fetchJson<PermissionsPutResponse>('/api/permissions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * 点击模式卡：PUT `{ mode }`。
 *
 * 调用方先乐观更新选中态；这里返回“落定后”的快照：
 * 成功取服务端结果，失败回到 previous（调用方据此回滚并 notify）。
 */
export async function saveMode(
  previous: PermissionsSnapshot,
  next: PermissionMode,
  put: PermissionsPut,
): Promise<PermissionsSaveResult> {
  if (next === previous.mode) {
    return { snapshot: previous, ok: true, error: null };
  }
  const optimistic: PermissionsSnapshot = { ...previous, mode: next };
  try {
    const res = await put({ mode: next });
    return { snapshot: applyPutResult(optimistic, res), ok: true, error: null };
  } catch (error) {
    return { snapshot: previous, ok: false, error };
  }
}

/**
 * 切换“需要确认时弹窗”：PUT `{ confirmActions }`。
 *
 * 失败同样回滚到 previous；没有超时、没有自动拒绝。
 */
export async function saveConfirmActions(
  previous: PermissionsSnapshot,
  next: boolean,
  put: PermissionsPut,
): Promise<PermissionsSaveResult> {
  if (next === previous.confirmActions) {
    return { snapshot: previous, ok: true, error: null };
  }
  const optimistic: PermissionsSnapshot = { ...previous, confirmActions: next };
  try {
    const res = await put({ confirmActions: next });
    return { snapshot: applyPutResult(optimistic, res), ok: true, error: null };
  } catch (error) {
    return { snapshot: previous, ok: false, error };
  }
}
