/**
 * 启动重建 —— 把「读盘 → 重放 → 注入」封装成一件事
 *
 * 设计依据：方案 § 4.1（事件是唯一真相源）、§ 5.1（截断 + 重放）
 *
 * ★ 这个模块存在的原因：
 *   在此之前，"重启后状态还在"需要调用方手写四步：
 *     ① 读事件文件 ② 建 EventLog 并灌入历史 ③ replay 各 store ④ hydrate
 *   步骤多、顺序敏感、漏一步就静默失效（记忆少了但不报错）。
 *
 *   封装成一个 `bootstrap()` 之后，"启动"变成一次调用，
 *   而**顺序与依赖关系写在代码里**，不靠调用方记住。
 *
 * ★ 三个必须遵守的顺序约束（都在本文件里保证）：
 *   ① **持久化端口要挂在灌入历史之后** ——
 *      否则重放出来的历史会被当成新事件再写回磁盘，每次启动翻倍
 *   ② **历史事件只灌一次** —— `appendMany` 会重新分配 seq，
 *      所以灌入前必须确认新 log 是空的
 *   ③ **重放结果只注入空 store** —— 混入已有状态会产生无法排查的差异
 */

import { EventLog } from '../events/log.js';
import type { EventPersistencePort } from '../events/log.js';
import type { SessionEvent } from '../events/types.js';
import type { ClockPort, RandomPort } from '../ports/clock.js';
import { MemoryStore } from '../memory/store.js';
import { hydrateStore, replayMemory, type ReplayMemoryResult } from '../memory/replay.js';
import { InMemoryArtifactStore } from '../artifact/store.js';
import {
  hydrateArtifactStore,
  replayArtifacts,
  type ReplayArtifactResult,
} from '../artifact/replay.js';
import { OperationMemoryStore } from '../memory/operations.js';
import {
  hydrateOperationStore,
  replayOperations,
  type ReplayOperationResult,
} from '../memory/operationReplay.js';
import { CheckpointManager } from '../checkpoint/manager.js';
import { McpClient } from '../mcp/client.js';
import { Scheduler, DEFAULT_QUOTA } from '../schedule/scheduler.js';
import { SessionStore, replaySessions } from '../chat/types.js';

// ═══════════════════════════════════════════════════════════
// 结果
// ═══════════════════════════════════════════════════════════

export interface BootstrapIssue {
  readonly area: 'memory' | 'artifact' | 'operation' | 'event';
  readonly detail: string;
}

export interface BootstrapResult {
  readonly log: EventLog;
  readonly memory: MemoryStore;
  readonly artifacts: InMemoryArtifactStore;
  readonly operations: OperationMemoryStore;
  readonly checkpoints: CheckpointManager;
  /**
   * MCP 客户端。
   *
   * ⚠️ 只建了实例，**没有注册任何传输** —— 传输在适配器层
   *    （stdioTransportFactory() 等）。服务端运行时负责注册。
   */
  readonly mcp: McpClient;
  /**
   * 定时任务调度器。
   *
   * ⚠️ 同样只建实例、**没有注册任何任务** —— 任务处理器需要模型与
   *    观察器，由服务端运行时按可用能力装配。
   */
  readonly scheduler: Scheduler;
  /**
   * 会话与消息仓储。
   *
   * ★ 方案 § 5.2 把「对话」列为回退必须覆盖的三方之一，
   *   所以它必须可持久化、可重放 —— 而不只是界面里的一段 UI 状态。
   */
  readonly chat: SessionStore;

  /** 本次启动是否从磁盘恢复（false = 全新开始） */
  readonly resumed: boolean;
  /** 读回的历史事件数 */
  readonly historicalEvents: number;
  /** 事件文件里的坏行数 */
  readonly badLines: number;

  readonly replayed: {
    readonly memory: ReplayMemoryResult;
    readonly artifacts: ReplayArtifactResult;
    readonly operations: ReplayOperationResult;
  };

  /** 重建过程中的异常（事件信息不足、引用不存在等） */
  readonly issues: readonly BootstrapIssue[];

  /** 各 store 恢复出的条数（界面"恢复摘要"用） */
  readonly restored: {
    readonly memories: number;
    readonly artifacts: number;
    readonly operationMemories: number;
    readonly checkpoints: number;
    readonly chatSessions: number;
  };
}

export interface BootstrapArgs {
  readonly sessionId: string;
  readonly userId: string;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  /**
   * 历史事件。
   *
   * ⚠️ 由调用方（适配器层）读盘后传入 —— 核心层不碰文件系统。
   *    不传表示全新开始。
   */
  readonly historicalEvents?: readonly SessionEvent[];
  /** 读盘时的坏行数（如实传递，供界面提示） */
  readonly badLines?: number;
  /** 持久化端口（挂上后新事件会自动落盘） */
  readonly persistence?: EventPersistencePort;
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

/**
 * 从事件流重建所有状态，并准备继续运行。
 *
 * 返回的 `log` 已经**挂着持久化端口**，可以直接继续产生事件。
 *
 * ★★ 使用约定（重要）：**所有事件都必须通过返回的 `log` 产生。**
 *
 *   ⚠️ 本函数会**新建**一个 EventLog —— 传入的 `historicalEvents`
 *      只是用来灌入历史的**数据**，不是「复用某个 log 实例」。
 *
 *   若调用方另外 new 一个 EventLog 并往里 append，那个 log 是**游离的**：
 *   它的 seq 从 1 开始，与这里的 log 重号，落盘后同一 seq 会有两条事件。
 *
 *   验证 7 就是这样抓到问题的：磁盘上出现两个 `seq=1`，
 *   读回时按 seq 去重，**历史悄悄少了一条**（不报错、不告警）。
 */
export function bootstrap(args: BootstrapArgs): BootstrapResult {
  const historical = args.historicalEvents ?? [];
  const issues: BootstrapIssue[] = [];

  // ── ① 建 log 并灌入历史 ──
  //
  // ⚠️ 顺序关键：**先灌历史，再挂持久化端口**。
  //    反过来的话，灌入的历史会被当成新事件写回磁盘 ——
  //    每次启动事件文件翻倍，而且重放会看到重复引用。
  const log = new EventLog(args.sessionId);
  if (historical.length > 0) {
    log.appendMany(
      historical.map((e) => ({
        type: e.type,
        actor: e.actor,
        payload: e.payload,
        createdAt: e.createdAt,
        ...(e.servantId !== undefined ? { servantId: e.servantId } : {}),
        ...(e.parentEventId !== undefined ? { parentEventId: e.parentEventId } : {}),
      })),
    );
  }
  if (args.persistence !== undefined) log.attachPersistence(args.persistence);

  // ── ② 各 store 重放 ──
  const memoryResult = replayMemory(log.all());
  const artifactResult = replayArtifacts(log.all());
  const operationResult = replayOperations(log.all());

  for (const s of memoryResult.skippedEvents) {
    issues.push({ area: 'memory', detail: `seq ${s.seq} ${s.type}：${s.why}` });
  }
  for (const a of memoryResult.anomalies) {
    issues.push({ area: 'memory', detail: a });
  }
  for (const s of artifactResult.skippedEvents) {
    issues.push({ area: 'artifact', detail: `seq ${s.seq} ${s.type}：${s.why}` });
  }
  for (const s of operationResult.skippedEvents) {
    issues.push({ area: 'operation', detail: `seq ${s.seq} ${s.type}：${s.why}` });
  }

  // ── ③ 注入空 store ──
  const memory = new MemoryStore(log, args.clock, args.userId);
  const artifacts = new InMemoryArtifactStore(log, args.clock);
  const operations = new OperationMemoryStore(log, args.clock, args.userId, args.random);

  const memHydrate = hydrateStore({ store: memory, result: memoryResult });
  if (!memHydrate.ok) {
    issues.push({ area: 'memory', detail: memHydrate.reason ?? '注入失败' });
  }

  const artHydrate = hydrateArtifactStore({ store: artifacts, result: artifactResult });
  if (!artHydrate.ok) {
    issues.push({ area: 'artifact', detail: artHydrate.reason ?? '注入失败' });
  }

  const opHydrate = hydrateOperationStore({ store: operations, result: operationResult });
  if (!opHydrate.ok) {
    issues.push({ area: 'operation', detail: opHydrate.reason ?? '注入失败' });
  }

  // ── ④ 检查点 ──
  //
  // ★ 检查点**不需要重放** —— 它本来就是从事件流派生的。
  //   `sync()` 扫一遍事件流就能重建全部检查点。
  //   这是"事件是唯一真相源"的一个直接好处：
  //   派生视图不必单独持久化，重算即可。
  // ⚠️ emitCreatedEvents: false —— 这些检查点的 checkpoint.created 事件
  //    历史里已经有了。重放是**重建**不是**变化**，重建不该产生新事件。
  //    （验证 7 抓到：不加这个标志时每次启动事件文件都会涨。）
  const checkpoints = new CheckpointManager({
    log,
    clock: args.clock,
    emitCreatedEvents: false,
  });
  checkpoints.sync();

  // ── 会话重放 ──
  const sessionReplay = replaySessions(log.all());
  const chat = new SessionStore(log, args.clock, args.userId);
  for (const s of sessionReplay.sessions) {
    chat.restoreSession({ ...s, userId: args.userId });
  }
  for (const m of sessionReplay.messages) chat.restoreMessage(m);
  for (const v of sessionReplay.verdicts) chat.restoreVerdict(v);

  const mcp = new McpClient(log, args.clock);
  const scheduler = new Scheduler(log, args.clock, DEFAULT_QUOTA);

  return {
    log,
    memory,
    artifacts,
    operations,
    checkpoints,
    mcp,
    scheduler,
    chat,
    resumed: historical.length > 0,
    historicalEvents: historical.length,
    badLines: args.badLines ?? 0,
    replayed: { memory: memoryResult, artifacts: artifactResult, operations: operationResult },
    issues,
    restored: {
      memories: memory.all().length,
      artifacts: artifacts.all().length,
      operationMemories: operations.all().length,
      checkpoints: checkpoints.all().length,
      chatSessions: chat.listSessions().length,
    },
  };
}

/**
 * 渲染一份"恢复摘要"（启动时展示给用户）。
 *
 * ★ 为什么要有它：用户需要知道"这次启动恢复了什么"，
 *   否则"它还记得我"这件事是不可见的 ——
 *   而不可见的好事等于没发生。
 */
export function renderRestoreSummary(r: BootstrapResult): string {
  const lines: string[] = [];

  if (!r.resumed) {
    lines.push('首次启动，还没有历史记录。');
    return lines.join('\n');
  }

  lines.push(`已从历史恢复（读回 ${r.historicalEvents} 条事件）：`);
  lines.push(`  · 记忆 ${r.restored.memories} 条`);
  lines.push(`  · 产出物 ${r.restored.artifacts} 个`);
  lines.push(`  · 操作记忆 ${r.restored.operationMemories} 条`);
  lines.push(`  · 检查点 ${r.restored.checkpoints} 个（由事件流派生，无需单独持久化）`);

  if (r.badLines > 0) {
    lines.push(`  ⚠️ 事件文件有 ${r.badLines} 行损坏（已跳过，其余历史正常）`);
  }
  if (r.issues.length > 0) {
    lines.push(`  ⚠️ ${r.issues.length} 处信息不足（多为加字段之前写入的老事件）：`);
    for (const i of r.issues.slice(0, 5)) {
      lines.push(`      [${i.area}] ${i.detail}`);
    }
    if (r.issues.length > 5) lines.push(`      … 还有 ${r.issues.length - 5} 处`);
  }

  return lines.join('\n');
}
