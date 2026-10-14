/**
 * 工具执行框架 —— 唯一的外部副作用出口
 *
 * 设计依据：方案 § 6、§ 11（动作侧防护）
 *
 * ⚠️ 这个类**没有**"跳过权限检查"的开关。要执行工具，只能走 `execute()`，
 *    而它一定经过：分级判定 → 策略授权 → （必要时）预览 → 执行 → 审计。
 *
 *    这不是"防御性设计"，而是**唯一路径设计**：
 *    如果存在第二条路径，那么总有一天会有人从那条路走。
 */

import type { EventLog } from '../events/log.js';
import type { ClockPort } from '../ports/clock.js';
import { redactArgs, redactText } from './redact.js';
import {
  ToolError,
  type ActionTier,
  type Authorization,
  type PermissionPolicy,
  type ToolAudit,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from './types.js';

/** 各分级需要什么授权（未记住时）。 */
const TIER_REQUIREMENT: Record<ActionTier, 'auto' | 'ask' | 'disabled'> = {
  readOnly: 'auto',
  normal: 'ask',
  highRisk: 'ask',
  dangerous: 'disabled',
};

export interface ToolFrameworkOptions {
  readonly log: EventLog;
  readonly clock: ClockPort;
  readonly policy: PermissionPolicy;
  /** 审计回调（界面展示"本次会话做了哪些操作"用） */
  readonly onAudit?: (audit: ToolAudit) => void;
}

export class ToolFramework {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly log: EventLog;
  private readonly clock: ClockPort;
  private readonly policy: PermissionPolicy;
  private readonly onAudit: ((a: ToolAudit) => void) | undefined;

  /** 全量审计记录。事件日志是真相源，这里是便于查询的视图。 */
  private readonly audits: ToolAudit[] = [];

  constructor(opts: ToolFrameworkOptions) {
    this.log = opts.log;
    this.clock = opts.clock;
    this.policy = opts.policy;
    this.onAudit = opts.onAudit;
  }

  // ── 注册 ──

  /**
   * 注册工具。
   *
   * 重名直接抛错 —— 静默覆盖会让"某个工具被悄悄换掉"成为可能。
   */
  /**
   * 注册工具。
   *
   * ⚠️ 重名**默认抛错** —— 静默覆盖会让「某个工具被悄悄换掉」成为可能。
   *    确实需要覆盖（如测试或多环境复用）时必须显式传 `overwrite: true`。
   */
  register(spec: ToolSpec, opts?: { readonly overwrite?: boolean }): void {
    if (this.tools.has(spec.name) && opts?.overwrite !== true) {
      throw new ToolError(`工具 ${spec.name} 已注册，不允许静默覆盖`, 'invalid_args');
    }
    this.tools.set(spec.name, spec);
  }

  registerAll(specs: readonly ToolSpec[]): void {
    for (const s of specs) this.register(s);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolSpec[] {
    return [...this.tools.values()];
  }

  /** 供模型用的工具声明（只需 name/description/parameters）。 */
  toModelSpecs(filter?: (t: ToolSpec) => boolean): readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[] {
    return this.list()
      .filter((t) => (filter ? filter(t) : true))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  // ── 执行（唯一路径）──

  /**
   * 执行一次工具调用。
   *
   * 流程：查工具 → 分级判定 → 策略授权 → 预览（高风险）→ 执行 → 审计
   *
   * 任何一步不通过都抛 ToolError，并**仍然写审计与事件** ——
   * "被拒绝的调用"本身就是重要的安全信号。
   */
  async execute(args: {
    readonly toolName: string;
    readonly args: unknown;
    readonly taskId: string;
  }): Promise<ToolResult> {
    const started = this.clock.now();
    const spec = this.tools.get(args.toolName);

    if (!spec) {
      this.finishAudit({
        toolName: args.toolName,
        tier: 'readOnly',
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization: 'deny',
        outcome: 'denied',
        started,
        outputSummary: '未知工具',
      });
      this.emitDenied(args.toolName, args.taskId, 'unknown_tool');
      throw new ToolError(`未知工具：${args.toolName}`, 'unknown_tool');
    }

    // ① 分级是否已被用户开启
    const requirement = TIER_REQUIREMENT[spec.tier];
    if (requirement === 'disabled' && !this.policy.isTierEnabled(spec.tier)) {
      const blockedAudit = this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization: 'blocked',
        outcome: 'denied',
        started,
        outputSummary: '该风险级别默认禁用',
      });
      this.emitBlocked(spec, args.taskId, blockedAudit);
      throw new ToolError(
        `「${spec.name}」属于 ${spec.tier} 级别，默认禁用。需要在设置中显式开启。`,
        'tier_disabled',
      );
    }

    // ② 授权
    let authorization: Authorization;
    if (this.policy.isRemembered(spec.name)) {
      authorization = 'allow';
    } else if (requirement === 'auto') {
      authorization = 'allow';
    } else {
      authorization = await this.askUser(spec, args.args, args.taskId);
    }

    if (authorization !== 'allow') {
      this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization,
        outcome: 'denied',
        started,
        outputSummary: authorization === 'blocked' ? '级别未开启' : '用户拒绝',
      });
      this.emitDenied(spec.name, args.taskId, authorization === 'blocked' ? 'tier_disabled' : 'user_denied');
      throw new ToolError(
        authorization === 'blocked' ? '该风险级别未开启' : `用户拒绝执行「${spec.name}」`,
        authorization === 'blocked' ? 'tier_disabled' : 'user_denied',
      );
    }

    // ③ 执行
    const ctx: ToolContext = { clock: this.clock, taskId: args.taskId };
    let result: ToolResult;
    try {
      result = await spec.execute(args.args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization,
        outcome: 'error',
        started,
        outputSummary: redactText(message),
      });
      this.log.append({
        type: 'tool.result',
        actor: 'butler',
        payload: {
          toolName: spec.name,
          tier: spec.tier,
          isError: true,
          error: redactText(message),
          taskId: args.taskId,
        },
        createdAt: this.clock.now(),
      });
      return {
        ok: false,
        output: `工具执行失败：${message}`,
        isError: true,
        durationMs: this.clock.now() - started,
      };
    }

    // ④ 结果脱敏 —— 接触凭证的工具，结果绝不原样回传
    const safeOutput = spec.touchesCredentials ? redactText(result.output) : result.output;

    this.finishAudit({
      toolName: spec.name,
      tier: spec.tier,
      taskId: args.taskId,
      argsSummary: redactArgs(args.args),
      authorization,
      outcome: result.ok ? 'success' : 'error',
      started,
      outputSummary: redactText(safeOutput).slice(0, 200),
    });

    this.log.append({
      type: 'tool.result',
      actor: 'butler',
      payload: {
        toolName: spec.name,
        tier: spec.tier,
        ok: result.ok,
        isError: result.isError ?? false,
        touchesCredentials: spec.touchesCredentials ?? false,
        durationMs: result.durationMs,
        taskId: args.taskId,
        // 结果摘要（脱敏后）
        outputSummary: redactText(safeOutput).slice(0, 200),
      },
      createdAt: this.clock.now(),
    });

    return { ...result, output: safeOutput };
  }

  // ── 审计 ──

  allAudits(): readonly ToolAudit[] {
    return this.audits;
  }

  auditsFor(taskId: string): readonly ToolAudit[] {
    return this.audits.filter((a) => a.taskId === taskId);
  }

  // ── 内部 ──

  private async askUser(spec: ToolSpec, args: unknown, taskId: string): Promise<Authorization> {
    const ctx: ToolContext = { clock: this.clock, taskId };

    let preview: string | undefined;
    if (spec.preview) {
      try {
        preview = await spec.preview(args, ctx);
      } catch {
        // 预览失败不阻塞流程，但要在审计里看得出来（留空即表示无预览）
        preview = undefined;
      }
    }

    // 记录"动作分级判定"事件 —— 方案 § 11 要求这一步可审计
    this.log.append({
      type: 'action.classified',
      actor: 'butler',
      payload: {
        toolName: spec.name,
        tier: spec.tier,
        taskId,
        summary: spec.summarize(args),
        hasPreview: preview !== undefined,
      },
      createdAt: this.clock.now(),
    });

    try {
      return await this.policy.ask({
        toolName: spec.name,
        tier: spec.tier,
        args,
        summary: spec.summarize(args),
        ...(preview !== undefined ? { preview } : {}),
      });
    } catch {
      // 策略本身出错 → 保守拒绝（fail-closed），不是放行
      return 'deny';
    }
  }

  private finishAudit(input: {
    toolName: string;
    tier: ActionTier;
    taskId: string;
    argsSummary: string;
    authorization: Authorization;
    outcome: ToolAudit['outcome'];
    started: number;
    outputSummary: string;
  }): ToolAudit {
    const audit: ToolAudit = {
      toolName: input.toolName,
      tier: input.tier,
      taskId: input.taskId,
      argsSummary: input.argsSummary,
      authorization: input.authorization,
      outcome: input.outcome,
      durationMs: this.clock.now() - input.started,
      at: this.clock.now(),
      outputSummary: input.outputSummary,
    };
    this.audits.push(audit);
    this.onAudit?.(audit);
    return audit;
  }

  private emitDenied(toolName: string, taskId: string, reason: string): void {
    this.log.append({
      type: 'action.blocked',
      actor: 'butler',
      payload: { toolName, taskId, reason, stage: 'authorization' },
      createdAt: this.clock.now(),
    });
  }

  private emitBlocked(spec: ToolSpec, taskId: string, audit: ToolAudit): void {
    this.log.append({
      type: 'action.blocked',
      actor: 'butler',
      payload: {
        toolName: spec.name,
        tier: spec.tier,
        taskId,
        reason: 'tier_disabled',
        stage: 'classification',
      },
      createdAt: this.clock.now(),
    });
    void audit;
  }
}
