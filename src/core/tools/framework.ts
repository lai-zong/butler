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
import type { ApprovalAsker } from './approval.js';
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
import { ToolFuse, type ToolFuseOptions } from './fuse.js';

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
  /** 操作范围熔断；不传用默认 60s / 30 次 */
  readonly fuse?: Partial<ToolFuseOptions>;
  /** 审计回调（界面展示"本次会话做了哪些操作"用） */
  readonly onAudit?: (audit: ToolAudit) => void;
  /**
   * 可选的路径守卫；用于会话/用户任务的工作区权限。
   *
   * 返回 null 放行，返回字符串则拒绝并作为错误原因。
   * 允许返回 Promise：会话作用域需要 `realpath` 才能识别
   * junction/symlink 逃逸，不能只做同步字面路径判断。
   * 这里只限制文件类动作；完整权限不传。
   */
  readonly pathGuard?: (
    toolName: string,
    args: unknown,
  ) => string | null | Promise<string | null>;
}

export class ToolFramework {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly log: EventLog;
  private readonly clock: ClockPort;
  private readonly policy: PermissionPolicy;
  private readonly onAudit: ((a: ToolAudit) => void) | undefined;
  private readonly pathGuard:
    | ((toolName: string, args: unknown) => string | null | Promise<string | null>)
    | undefined;
  private readonly fuse: ToolFuse;

  /** 全量审计记录。事件日志是真相源，这里是便于查询的视图。 */
  private readonly audits: ToolAudit[] = [];

  constructor(opts: ToolFrameworkOptions) {
    this.log = opts.log;
    this.clock = opts.clock;
    this.policy = opts.policy;
    this.onAudit = opts.onAudit;
    this.pathGuard = opts.pathGuard;
    this.fuse = new ToolFuse(opts.fuse);
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

  /** 移除一个已注册工具（MCP 断连/停用/删除时使用）。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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
    /**
     * 本次任务的自然语言目标 —— 透传给工具的 `ToolContext.task`。
     *
     * ⚠️ **必须逐次传递，不能挂在 ToolFramework 上**：
     *    运行时里所有会话**共享同一个 ToolFramework 实例**，
     *    挂一个"当前任务"字段会在并发会话之间串味。
     */
    readonly task?: string;
    /**
     * 本轮专用的询问通道（C6 询问开关）。
     *
     * ⚠️ 逐次传递，不挂在框架实例上 —— 所有会话共享同一个框架，
     *    挂上去会在并发会话间串味。
     */
    readonly asker?: ApprovalAsker;
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

    const guardError = (await this.pathGuard?.(spec.name, args.args)) ?? null;
    if (guardError !== null) {
      this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization: 'deny',
        outcome: 'denied',
        started,
        outputSummary: guardError,
      });
      this.emitDenied(spec.name, args.taskId, 'user_denied');
      throw new ToolError(guardError, 'user_denied');
    }

    // ① 分级是否已被用户开启
    //    凭证类工具**无论分级都必须逐次确认**：不能因为之前“记住本次会话”
    //    就永久放行密码/密钥读取。
    const requirement = spec.touchesCredentials ? 'ask' : TIER_REQUIREMENT[spec.tier];
    /**
     * C5 三档模式：显式配置时，未开启的档位直接拒绝。
     * 未配置 mode 时保持旧行为（normal/highRisk 仍走 ask）。
     */
    if (this.policy.mode !== undefined && !this.policy.isTierEnabled(spec.tier)) {
      const blockedAudit = this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization: 'blocked',
        outcome: 'denied',
        started,
        outputSummary: `权限模式 ${this.policy.mode} 未开启该档位`,
      });
      this.emitBlocked(spec, args.taskId, blockedAudit);
      throw new ToolError(
        `「${spec.name}」属于 ${spec.tier} 级别，当前权限模式 ${this.policy.mode} 未开启该档位。`,
        'tier_disabled',
      );
    }
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
    if (!spec.touchesCredentials && this.policy.isRemembered(spec.name)) {
      authorization = 'allow';
    } else if (requirement === 'auto') {
      authorization = 'allow';
    } else {
      authorization = await this.askUser(spec, args.args, args.taskId, args.asker);
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
    //
    // ★ 在执行**之前**落 tool.call 事件。
    //
    //   ⚠️ 审查时发现的缺口：此前只发 tool.result，**从不发 tool.call** ——
    //      结果是"AI 调用过哪些工具"这个问题在事件流里查不到。
    //      而 tool.result 里虽然有工具名，但它表达的是"结果"，
    //      用它反推调用会把"发出但未返回"的调用漏掉（超时、进程被杀）。
    //
    //   位置放在授权通过之后：被拒绝的调用走 action.blocked，
    //   不需要重复记一条"调用"——它根本没有发生。
    //
    // ★ 范围熔断：只统计**会改变状态**的非只读调用；只读枚举不消耗额度。
    //   授权被拒的调用也不消耗额度（只有真正要执行的才 record）。
    const executingAt = this.clock.now();
    const sideEffecting = spec.tier !== 'readOnly';
    if (sideEffecting && !this.fuse.allows(executingAt)) {
      const blockedAudit = this.finishAudit({
        toolName: spec.name,
        tier: spec.tier,
        taskId: args.taskId,
        argsSummary: redactArgs(args.args),
        authorization: 'blocked',
        outcome: 'denied',
        started,
        outputSummary: '单位时间内副作用操作超过阈值，已熔断',
      });
      this.emitBlocked(spec, args.taskId, blockedAudit, 'fuse_blocked', 'fuse');
      throw new ToolError(
        `操作范围熔断：单位时间内非只读操作超过 ${this.fuse.count(executingAt)} 次上限，已停止本次调用。`,
        'fuse_blocked',
      );
    }
    if (sideEffecting) this.fuse.record(executingAt);

    this.log.append({
      type: 'tool.call',
      actor: 'butler',
      payload: {
        toolName: spec.name,
        tier: spec.tier,
        // ★ 桌面动作阶梯级（方案 §9.4 / D-32）—— 与 tier 正交，见 `ToolSpec.rung`
        ...(spec.rung !== undefined ? { actionRung: spec.rung } : {}),
        taskId: args.taskId,
        // 参数经脱敏后再入流（方案 § 11 第二层）
        args: redactArgs(args.args),
        argsSummary: redactArgs(args.args),
        authorization,
        source: spec.name.startsWith('mcp__') ? 'mcp' : 'native',
      },
      createdAt: this.clock.now(),
    });

    // 凭证类工具每次使用都留痕；只记工具与任务，不记参数/返回内容。
    if (spec.touchesCredentials) {
      this.log.append({
        type: 'credential.used',
        actor: 'butler',
        payload: { toolName: spec.name, taskId: args.taskId },
        createdAt: this.clock.now(),
      });
    }

    const ctx: ToolContext = {
      clock: this.clock,
      taskId: args.taskId,
      ...(args.task !== undefined ? { task: args.task } : {}),
    };
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

    // ③b 执行后验证：动作成功不等于结果正确
    if (result.ok && spec.verify !== undefined) {
      let verified: { readonly ok: boolean; readonly note?: string };
      try {
        verified = await spec.verify(args.args, result, ctx);
      } catch (err) {
        verified = {
          ok: false,
          note: `校验过程异常：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!verified.ok) {
        let rollbackNote = '';
        if (result.rollback !== undefined) {
          try {
            await result.rollback();
            rollbackNote = '；已撤销本次副作用';
          } catch (err) {
            rollbackNote = `；补偿失败：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const message = `执行后校验失败：${verified.note ?? '目标状态不符合预期'}${rollbackNote}`;
        this.finishAudit({
          toolName: spec.name,
          tier: spec.tier,
          taskId: args.taskId,
          argsSummary: redactArgs(args.args),
          authorization,
          outcome: 'error',
          started,
          outputSummary: redactText(message).slice(0, 200),
        });
        this.log.append({
          type: 'tool.result',
          actor: 'butler',
          payload: {
            toolName: spec.name,
            tier: spec.tier,
            isError: true,
            verified: false,
            rolledBack: result.rollback !== undefined && !rollbackNote.includes('补偿失败'),
            error: redactText(message),
            taskId: args.taskId,
          },
          createdAt: this.clock.now(),
        });
        return {
          ok: false,
          output: message,
          isError: true,
          durationMs: this.clock.now() - started,
        };
      }
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

  private async askUser(
    spec: ToolSpec,
    args: unknown,
    taskId: string,
    /**
     * 本轮专用的询问通道（C6）。
     *
     * ★ 为什么从这里传而不是挂在 `this.policy` 上：
     *   运行时里**所有会话共享同一个策略实例**，
     *   把"本轮怎么问用户"挂在共享对象上会在并发会话之间串味。
     *   没有它时退回 `policy.ask`（Web 版实现直接拒绝，行为与之前一致）。
     */
    asker?: ApprovalAsker,
  ): Promise<Authorization> {
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
      /**
       * ★ 有本轮专用通道就用它（真的停下来问）；否则退回策略默认实现
       *   （Web 版策略直接拒绝 —— 与改造前的行为完全一致）。
       */
      if (asker !== undefined) {
        const allow = await asker.request({
          toolName: spec.name,
          tier: spec.tier,
          summary: spec.summarize(args),
          ...(preview !== undefined ? { preview } : {}),
        });
        return allow ? 'allow' : 'deny';
      }
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

  private emitBlocked(
    spec: ToolSpec,
    taskId: string,
    audit: ToolAudit,
    reason: 'tier_disabled' | 'fuse_blocked' = 'tier_disabled',
    stage: 'classification' | 'fuse' = 'classification',
  ): void {
    this.log.append({
      type: 'action.blocked',
      actor: 'butler',
      payload: {
        toolName: spec.name,
        tier: spec.tier,
        taskId,
        reason,
        stage,
      },
      createdAt: this.clock.now(),
    });
    void audit;
  }
}
