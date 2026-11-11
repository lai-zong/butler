/**
 * 侧栏会话列表的排序 / 分组 —— 纯函数，可单测
 *
 * 两种排列互斥：
 *   · 时间模式：置顶优先；置顶内按 updatedAt 倒序；其余按 updatedAt 倒序。
 *     不产生“置顶 / 最近”分组标题，只用图钉表示置顶。
 *   · 工作区模式：按 effectiveWorkspace 分组，组按组内最新 updatedAt 排序；
 *     组内置顶只认 `pinnedWorkspace === effectiveWorkspace`，不跨工作区冒泡。
 *     桌宠会话用服务端 /api/pet/session 的 sessionId 单独成区，不混入普通工作区。
 *
 * ★ 这里不读 React、不发请求：排序规则只有一份，界面只负责渲染。
 */

import type { SessionSummary } from './types.js';

export type SessionListMode = 'time' | 'workspace';

/** 桌宠分区的固定 key（真实工作区不会以 \u0000 开头）。 */
export const PET_GROUP_KEY = '\u0000pet';

/** 空工作区（服务端没解析出路径）的显示名。 */
export const EMPTY_WORKSPACE_LABEL = '未指定工作区';

export interface WorkspaceGroup {
  /** 分组依据的原始 effectiveWorkspace；桌宠分区用 PET_GROUP_KEY。 */
  readonly key: string;
  /** 侧栏里显示的名称：路径末段；重名时加短路径消歧。 */
  readonly label: string;
  /** 悬停提示：完整路径（桌宠分区给固定说明）。 */
  readonly tooltip: string;
  /** 是否桌宠独立分区。 */
  readonly pet: boolean;
  /** 组内置顶（时间模式只用于排序，不单独成组）。 */
  readonly pinned: readonly SessionSummary[];
  /** 组内其余会话。 */
  readonly rest: readonly SessionSummary[];
  /** 组内最新 updatedAt，用于分组排序。 */
  readonly latestUpdatedAt: number;
}

export function isPinnedAtAll(session: SessionSummary): boolean {
  return session.pinnedAt !== null;
}

/**
 * 工作区模式的置顶判定。
 *
 * ★ 置顶写入时记录当时的工作区；会话改过工作区后 pinnedAt 仍在，
 *   但不属于当前工作区，因此不能在本组显示为置顶，也绝不跨组冒泡。
 */
export function isPinnedInWorkspace(session: SessionSummary): boolean {
  return session.pinnedAt !== null && session.pinnedWorkspace === session.effectiveWorkspace;
}

/** updatedAt 倒序；同一毫秒用 id 兜底，保证顺序稳定。 */
export function compareUpdatedAtDesc(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id.localeCompare(b.id);
}

/** 时间模式：置顶优先（组内仍按 updatedAt），其余按 updatedAt。 */
export function sortByTime(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  const pinned = sessions.filter(isPinnedAtAll).sort(compareUpdatedAtDesc);
  const rest = sessions.filter((s) => !isPinnedAtAll(s)).sort(compareUpdatedAtDesc);
  return [...pinned, ...rest];
}

export interface TimePartition {
  /** 普通会话：置顶优先，其余按 updatedAt。 */
  readonly rows: readonly SessionSummary[];
  /** 桌宠固定会话：单独分区，不混进普通列表。 */
  readonly pet: readonly SessionSummary[];
}

/**
 * 时间模式的最终排列。
 *
 * ★ 桌宠会话即使有更新的 updatedAt，也不混进普通列表：
 *   它有自己的“桌宠”分区（放在普通列表之后），避免一条固定会话打断时间线。
 * ★ 普通列表内部规则不变：置顶优先，置顶内按 updatedAt，其余按 updatedAt。
 */
function isPetSession(session: SessionSummary, petSessionId: string | null): boolean {
  return session.isPet === true || (petSessionId !== null && session.id === petSessionId);
}

export function partitionByTime(
  sessions: readonly SessionSummary[],
  petSessionId: string | null,
): TimePartition {
  const pet = sessions.filter((session) => isPetSession(session, petSessionId));
  const normal = sessions.filter((session) => !isPetSession(session, petSessionId));
  return {
    rows: sortByTime(normal),
    pet: sortByTime(pet),
  };
}

/** 把路径拆成段；Windows / POSIX 分隔符都接受，空段丢弃。 */
export function workspaceSegments(path: string): readonly string[] {
  return path
    .trim()
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** 完整路径的末段；没有段时给一个明确的占位名。 */
export function workspaceBaseLabel(path: string): string {
  const segments = workspaceSegments(path);
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : EMPTY_WORKSPACE_LABEL;
}

interface GroupDraft {
  readonly key: string;
  readonly path: string;
  readonly pet: boolean;
  readonly sessions: SessionSummary[];
}

function makeGroup(draft: GroupDraft, label: string, tooltip: string): WorkspaceGroup {
  const pinned = draft.sessions.filter(isPinnedInWorkspace).sort(compareUpdatedAtDesc);
  const rest = draft.sessions.filter((s) => !isPinnedInWorkspace(s)).sort(compareUpdatedAtDesc);
  const latestUpdatedAt = draft.sessions.reduce(
    (latest, session) => (session.updatedAt > latest ? session.updatedAt : latest),
    0,
  );
  return {
    key: draft.key,
    label,
    tooltip,
    pet: draft.pet,
    pinned,
    rest,
    latestUpdatedAt,
  };
}

/**
 * 重名消歧：默认只显示末段，重名时逐步加父目录，直到唯一或路径用尽。
 * tooltip 始终是完整路径。
 */
function disambiguate(drafts: readonly GroupDraft[]): Map<string, string> {
  const labels = new Map<string, string>();
  const maxDepth = drafts.reduce(
    (depth, draft) => {
      const length = draft.pet ? 1 : workspaceSegments(draft.path).length;
      return length > depth ? length : depth;
    },
    1,
  );

  let depth = 1;
  for (;;) {
    const counts = new Map<string, number>();
    const current = new Map<string, string>();
    for (const draft of drafts) {
      const segments = workspaceSegments(draft.path);
      const take = Math.min(depth, segments.length);
      const label = draft.pet
        ? '桌宠'
        : take === 0
          ? EMPTY_WORKSPACE_LABEL
          : segments.slice(segments.length - take).join('/');
      current.set(draft.key, label);
      const folded = label.toLowerCase();
      counts.set(folded, (counts.get(folded) ?? 0) + 1);
    }

    const duplicated = new Set<string>();
    for (const draft of drafts) {
      const label = (current.get(draft.key) ?? '').toLowerCase();
      if ((counts.get(label) ?? 0) > 1) duplicated.add(draft.key);
    }

    if (duplicated.size === 0 || depth >= maxDepth) {
      for (const draft of drafts) {
        const label = current.get(draft.key) ?? workspaceBaseLabel(draft.path);
        // 路径用尽仍重名（几乎不可能）：退到完整路径，至少不会指错。
        labels.set(
          draft.key,
          duplicated.has(draft.key) && !draft.pet ? draft.path.trim() || EMPTY_WORKSPACE_LABEL : label,
        );
      }
      return labels;
    }
    depth += 1;
  }
}

/**
 * 工作区模式：分组 + 组内排序 + 分组排序。
 *
 * ★ 分组排序只用组内最新的 updatedAt；桌宠分区也按同一规则参与排序，
 *   它只是“独立分区”，不是置顶区。
 */
export function groupByWorkspace(
  sessions: readonly SessionSummary[],
  petSessionId: string | null,
): readonly WorkspaceGroup[] {
  const drafts = new Map<string, GroupDraft>();

  for (const session of sessions) {
    const isPet = isPetSession(session, petSessionId);
    const key = isPet ? PET_GROUP_KEY : session.effectiveWorkspace.trim();
    const existing = drafts.get(key);
    if (existing !== undefined) {
      existing.sessions.push(session);
      continue;
    }
    drafts.set(key, {
      key,
      path: session.effectiveWorkspace,
      pet: isPet,
      sessions: [session],
    });
  }

  const list = [...drafts.values()];
  const labels = disambiguate(list);
  const groups = list.map((draft) =>
    makeGroup(
      draft,
      labels.get(draft.key) ?? (draft.pet ? '桌宠' : workspaceBaseLabel(draft.path)),
      draft.pet ? '桌宠固定会话' : draft.path.trim().length > 0 ? draft.path.trim() : EMPTY_WORKSPACE_LABEL,
    ),
  );

  return groups.sort((a, b) => {
    if (b.latestUpdatedAt !== a.latestUpdatedAt) return b.latestUpdatedAt - a.latestUpdatedAt;
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
}

/** 当前会话是否已经需要懒生成标题：有消息、且标题还是第一句话兜底。 */
export function needsGeneratedTitle(session: SessionSummary | undefined): boolean {
  return session !== undefined && session.messageCount > 0 && !session.titleGenerated;
}
