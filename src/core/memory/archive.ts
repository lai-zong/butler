/**
 * 记忆存档区（第一步删除的落点）
 *
 * ★ 删除分两步（用户确认的产品规则）：
 *   ① 记忆页点「删除」→ 记忆移出记忆库、**原文移进存档区**，可恢复；
 *   ② 存档区点「彻底删除」→ 抹除事件流原文 + 删掉存档记录，只留指纹。
 *
 * ★ 为什么单独成模块而不是并进 MemoryStore：
 *   记忆库的职责是"当前生效的记忆"，存档区是"已退出使用但还能找回"的冷数据。
 *   两者的生命周期、保留策略、可见性都不同，混在一起会让 `all()` / 召回
 *   无意间把冷数据带回来。
 *
 * ⚠️ 数据边界：存档区**默认不进导出**。换设备迁移时不应该把"已删除的记忆"
 *   一起带走 —— 那等于绕过用户的删除意图。
 */

import type { MemoryEntry } from './types.js';

/** 存档区里的一条记录。 */
export interface ArchivedMemoryRecord {
  /** 存档记录 id（与记忆 id 解耦：同一条记忆多轮删除也不会撞号） */
  readonly archiveId: string;
  /** 完整记忆条目，**含原文** —— 恢复要靠它 */
  readonly memory: MemoryEntry;
  /** 删除原因（用户可写，也可由系统填） */
  readonly reason: string;
  readonly archivedAt: number;
  /** 从哪个会话删的（便于回溯上下文） */
  readonly sessionId?: string;
}

/**
 * 存档区端口。
 *
 * 核心层不碰文件系统（ADR 0004），具体落盘由 `adapters/storage` 实现。
 */
export interface MemoryArchivePort {
  append(record: ArchivedMemoryRecord): Promise<void>;
  list(): Promise<readonly ArchivedMemoryRecord[]>;
  get(archiveId: string): Promise<ArchivedMemoryRecord | null>;
  /** 彻底删除：从存档里移除这一条。返回是否真的删掉了。 */
  remove(archiveId: string): Promise<boolean>;
  /** 存档占用（条数 + 文件字节数）—— 界面要显示"它占了多少" */
  stats(): Promise<{ readonly count: number; readonly bytes: number }>;
  /** 清空整个存档区，返回清掉的条数。 */
  clear(): Promise<number>;
}

/** 生成存档 id —— 与记忆 id 解耦，避免同一条被删多次时冲突。 */
export function newArchiveId(now: number, seq: number): string {
  return `arc_${now.toString(36)}_${seq.toString(36)}`;
}
