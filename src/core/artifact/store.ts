/**
 * 产出物仓储实现
 *
 * 设计依据：方案 § 5.2
 *
 * 所有变更都写事件（`artifact.created` / `artifact.revised` / `artifact.superseded`），
 * 因此产出物的历史与检查点回退是**同一套真相源** —— 不需要额外的同步机制。
 */

import type { EventLog } from '../events/log.js';
import { artifactSnapshotOf } from './snapshot.js';
import type { ClockPort } from '../ports/clock.js';
import type {
  Artifact,
  ArtifactRevision,
  ArtifactStore,
  CreateArtifactInput,
  ReviseArtifactInput,
} from './types.js';

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();
  private readonly revisionsById = new Map<string, ArtifactRevision[]>();
  private seq = 0;

  constructor(
    private readonly log: EventLog,
    private readonly clock: ClockPort,
  ) {}

  create(input: CreateArtifactInput): Artifact {
    const now = this.clock.now();
    const id = input.id ?? this.nextId();

    const artifact: Artifact = {
      id,
      label: input.label,
      kind: input.kind,
      status: 'active',
      currentVersion: 1,
      producedByStep: input.producedByStep,
      createdAt: now,
      updatedAt: now,
    };

    const revision: ArtifactRevision = {
      artifactId: id,
      version: 1,
      content: input.content,
      ...(input.items !== undefined ? { items: input.items } : {}),
      author: input.author,
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      reason: input.reason ?? '初次产出',
      producedBy: input.producedBy ?? [],
      createdAt: now,
    };

    this.artifacts.set(id, artifact);
    this.revisionsById.set(id, [revision]);

    this.log.append({
      type: 'artifact.created',
      actor: input.author === 'user' ? 'user' : input.author === 'servant' ? 'servant' : 'butler',
      ...(input.author === 'servant' && input.authorId !== undefined
        ? { servantId: input.authorId }
        : {}),
      payload: {
        artifactId: id,
        label: input.label,
        kind: input.kind,
        stepId: input.producedByStep,
        version: 1,
        // 内容不进语义事件的正文（体积大），但下面的 snapshot 里带全
        size: input.items ? input.items.length : input.content.length,
        // ★ 完整状态快照 —— 让重放能重建（含内容与版本历史）
        snapshot: artifactSnapshotOf(artifact, this.revisionsById.get(id) ?? []),
      },
      createdAt: now,
    });

    return artifact;
  }

  revise(input: ReviseArtifactInput): Artifact {
    const existing = this.artifacts.get(input.artifactId);
    if (!existing) throw new Error(`产出物不存在：${input.artifactId}`);

    const now = this.clock.now();
    const version = existing.currentVersion + 1;

    const revision: ArtifactRevision = {
      artifactId: input.artifactId,
      version,
      content: input.content,
      ...(input.items !== undefined ? { items: input.items } : {}),
      author: input.author,
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      reason: input.reason,
      producedBy: input.producedBy ?? [],
      createdAt: now,
    };

    // 修订让"被取代"的产出物重新有效（用户可能是在恢复旧版本），
    // 同时清掉取代标记 —— 否则界面会一直显示"已被取代"。
    const { supersededBy: _dropBy, supersededByRollback: _dropRollback, ...base } = existing;
    const updated: Artifact = {
      ...base,
      currentVersion: version,
      updatedAt: now,
      status: 'active',
    };
    void _dropBy;
    void _dropRollback;

    this.artifacts.set(input.artifactId, updated);
    const list = this.revisionsById.get(input.artifactId) ?? [];
    list.push(revision);
    this.revisionsById.set(input.artifactId, list);

    this.log.append({
      type: 'artifact.revised',
      actor: input.author === 'user' ? 'user' : input.author === 'servant' ? 'servant' : 'butler',
      ...(input.author === 'servant' && input.authorId !== undefined
        ? { servantId: input.authorId }
        : {}),
      payload: {
        artifactId: input.artifactId,
        version,
        reason: input.reason,
        size: input.items ? input.items.length : input.content.length,
        // ★ 完整状态快照
        snapshot: artifactSnapshotOf(updated, this.revisionsById.get(input.artifactId) ?? []),
      },
      createdAt: now,
    });

    return updated;
  }

  // ── 重放注入（仅供重放器使用）──

  /**
   * 直接注入产出物与它的版本历史。
   *
   * ★ 为什么不能用 `create()` / `revise()` 重放：
   *   它们会**发事件**，重放时会把历史事件再发一遍 —— 事件流被污染，
   *   且下一次重放会翻倍。重放必须走一条不发事件的注入路径。
   *
   * ⚠️ 只应由产出物重放器调用。业务代码用 create/revise。
   */
  restoreArtifact(artifact: Artifact, revisions: readonly ArtifactRevision[]): void {
    this.artifacts.set(artifact.id, artifact);
    this.revisionsById.set(artifact.id, [...revisions]);
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  currentRevision(id: string): ArtifactRevision | undefined {
    const a = this.artifacts.get(id);
    if (!a) return undefined;
    return this.revision(id, a.currentVersion);
  }

  revision(id: string, version: number): ArtifactRevision | undefined {
    return this.revisionsById.get(id)?.find((r) => r.version === version);
  }

  revisions(id: string): readonly ArtifactRevision[] {
    return this.revisionsById.get(id) ?? [];
  }

  all(): readonly Artifact[] {
    return [...this.artifacts.values()];
  }

  listByStatus(status: Artifact['status']): readonly Artifact[] {
    return this.all().filter((a) => a.status === status);
  }

  /**
   * 标记为已取代。
   *
   * ⚠️ **不删除、不移除历史** —— 方案 § 5.2 要求"被取代产出物不删除，可对比"。
   *    所以旧版本仍然可以通过 `revision(id, n)` 取到，界面能并排展示新旧。
   */
  supersede(id: string, options?: { readonly by?: string; readonly byRollback?: string }): boolean {
    const a = this.artifacts.get(id);
    if (!a) return false;
    if (a.status === 'superseded') return true; // 幂等

    const now = this.clock.now();
    this.artifacts.set(id, {
      ...a,
      status: 'superseded',
      updatedAt: now,
      ...(options?.by !== undefined ? { supersededBy: options.by } : {}),
      ...(options?.byRollback !== undefined ? { supersededByRollback: options.byRollback } : {}),
    });

    this.log.append({
      type: 'artifact.superseded',
      actor: options?.byRollback !== undefined ? 'user' : 'butler',
      payload: {
        artifactId: id,
        label: a.label,
        by: options?.by ?? null,
        byRollback: options?.byRollback ?? null,
        // 明确记录"仍可查看" —— 这是设计承诺，不只是实现细节
        retained: true,
        versionCount: this.revisionsById.get(id)?.length ?? 0,
      },
      createdAt: now,
    });

    return true;
  }

  discard(id: string): boolean {
    const a = this.artifacts.get(id);
    if (!a) return false;
    this.artifacts.set(id, { ...a, status: 'discarded', updatedAt: this.clock.now() });
    this.log.append({
      type: 'artifact.superseded',
      actor: 'user',
      payload: { artifactId: id, label: a.label, discarded: true, retained: true },
      createdAt: this.clock.now(),
    });
    return true;
  }

  private nextId(): string {
    this.seq += 1;
    return `art_${this.seq.toString(36)}_${this.clock.now().toString(36)}`;
  }
}
