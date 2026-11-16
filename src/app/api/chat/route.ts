/**
 * 对话端点 —— SSE 流式
 *
 * 设计依据：字符级流式与增量输出
 *
 * ★ 为什么用 SSE 而不是普通 POST：
 *   方案要求「**过程可见**」——用户要看到「判断该由谁处理 → 拆解任务 →
 *   派发给生活仆人 → 校验产出」这一串实时推进。
 *   普通 POST 只能在结束时一次性返回，那就成了转圈等待。
 *
 * ⚠️ 长任务不能用 Serverless：一次对话可能跑十几秒，
 *    而 Serverless 有执行时长上限。这也是方案 § 14 要求长驻进程的原因之一。
 *
 * 事件协议（每条 `data:` 一个 JSON）：
 *   { type: 'progress', ... }   —— 编排进度
 *   { type: 'user', ... }       —— 用户消息已记录（带 id）
 *   { type: 'reply', ... }      —— 管家回复（完整文本）
 *   { type: 'verdict', ... }    —— 审查结论
 *   { type: 'error', message }  —— 出错
 *   { type: 'done' }            —— 结束
 */

import type { NextRequest } from 'next/server';

import { DATA_DIR, getRuntime } from '@/app/runtime';
import { acquireSessionTurn, trackActiveTurn } from '@/app/server/activeTurns.js';
import { createChatToolScope } from '@/app/server/chatToolScope.js';
import { externalGrantsFor } from '@/app/server/externalFiles.js';
import { browserPageSummary } from '@/app/server/browserSession.js';
import { getMarkedPetSessionId, latestNormalSessionOrCreate } from '@/app/server/petSession.js';
import { buildPetUsageContext } from '@/app/server/petUsageContext.js';
import { loadPetConfig } from '@/app/server/petConfig.js';
import { classifyTurnFailure, interruptedNote } from '@/app/server/turnInterrupt.js';
import { createTraceCollector } from '@/core/chat/trace.js';
import { milestoneForTool } from '@/app/server/petMilestones.js';
import { createTaskPlanState } from '@/core/tools/builtin/plan.js';
import { getKnowledgeService } from '@/app/server/knowledge.js';
import { dataDirOf, scopeDefaultsOf } from '@/app/server/sessionScope.js';
import { supervisionConfig } from '@/core/config/env.js';
import { runTurn } from '@/core/chat/service.js';
import type { ToolFramework } from '@/core/tools/framework.js';
import { beginTurnSteering } from '@/core/tools/steering.js';
import {
  createTurnSettings,
  turnSettingsEventPayload,
  type TurnMemoryMode,
} from '@/core/chat/settings.js';
import {
  detectReasoningProvider,
  reasoningFromLegacyThinkingLevel,
  type ReasoningProvider,
} from '@/core/model/reasoning.js';
import { loadGlobalAgents } from '@/app/server/globalAgents.js';
import { SseApprovals } from '@/core/tools/approval.js';
import { normalizeRequestImages } from '@/core/multimodal/requestImages.js';
import { DeepSeekModel } from '@/adapters/model/deepseek.js';
import { DeepSeekStream } from '@/adapters/model/deepseekStream.js';
import { OpenAICompatibleModel } from '@/adapters/model/openaiCompatible.js';
import { deepSeekTranslationPort } from '@/adapters/model/translation.js';
import {
  loadProfileStore,
  resolveProfileModel,
} from '@/app/server/modelProfiles.js';
import type { ProgressEvent } from '@/core/runtime/orchestrator.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** 长任务允许跑久一点（有些任务要跑十几个仆人步骤）。 */
export const maxDuration = 300;

interface ChatBody {
  readonly sessionId?: string;
  readonly text?: string;
  readonly modelProfileId?: string;
  readonly modelId?: string;
  /** 桌宠设置里的附加人格；只追加在管家不变量之后。 */
  readonly persona?: string;
  /**
   * 旧桌宠的思考档位（`default|low|medium|high`）。
   *
   * ★ 只做兼容：新 Web 用会话级 `reasoning`，不发送这个字段。
   *   映射见 `core/chat/settings.ts`（default / medium → high）。
   */
  readonly thinkingLevel?: unknown;
  /**
   * 调用方是否**能处理确认请求**（`{ type:'approval' }` 事件 + POST 答复）。
   *
   * ⚠️ 默认 false，必须由调用方**显式声明**。
   *    原因（真实回归）：C6 通道建好后，如果无条件启用，
   *    而调用方还没实现确认流程，那么任何"需要确认"的工具调用都会
   *    **挂满 120 秒超时**才被拒绝 —— 比改造前（立刻拒绝）体验更差。
   *    所以这里按能力协商：能处理才开，不能处理就退回"立即拒绝"。
   */
  readonly supportsApproval?: boolean;
  /**
   * 本轮图片：`data:image/png;base64,...` 或 http(s) 链接。
   *
   * ⚠️ 只对**这一轮**有效 —— 不落历史、不进事件、不写长期记忆。
   *    调用方重新加载后图片不会回来（消息文本仍在）。
   */
  readonly images?: readonly {
    readonly url?: unknown;
    readonly detail?: unknown;
  }[];
}


// 图片校验已移到 core（路由文件不允许导出其它符号）：见 `core/multimodal/requestImages.ts`

export async function POST(req: NextRequest): Promise<Response> {
  const rt = await getRuntime();

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  /**
   * ⚠️ 类型守卫必须在 `.trim()` 之前。
   *
   *    旧写法 `(body.text ?? '').trim()`：传 `{"text":123}` 时 `trim` 不存在，
   *    TypeError 冒到外层直接 500（实测）。跨 HTTP 边界的数据是不可信输入。
   */
  if (body.text !== undefined && typeof body.text !== 'string') {
    return Response.json({ error: 'text 必须是字符串' }, { status: 400 });
  }
  const text = (body.text ?? '').trim();
  const imageCheck = normalizeRequestImages(body.images);
  if (!imageCheck.ok) {
    return Response.json({ error: imageCheck.error }, { status: 400 });
  }
  const images = imageCheck.images;

  // 只有图片、没有文字也允许（"这张图里是什么"是最常见的问法）
  if (text.length === 0 && images.length === 0) {
    return Response.json({ error: '消息内容为空' }, { status: 400 });
  }

  // 会话：没给就取最近的，还没有就新建
  const session = body.sessionId !== undefined
    ? (rt.bootstrapped.chat.getSession(body.sessionId) ?? rt.bootstrapped.chat.createSession())
    : await latestNormalSessionOrCreate(rt.bootstrapped.chat);

  // 使用节奏只进入桌宠会话；普通任务对话不注入。
  const markedPetId = await getMarkedPetSessionId();
  const isPetSession = markedPetId !== null && markedPetId === session.id;
  const petContext = isPetSession ? await buildPetUsageContext() : undefined;
  // 桌宠设置里的模型/思考/人格只在桌宠会话生效。
  const petConfig = isPetSession ? await loadPetConfig() : null;

  let model = rt.model;
  let streamModel = rt.streamModel;
  let translator = rt.translator;
  /**
   * 推理强度映射需要的供应商信息。
   *
   * ★ 只在这里**推断一次**，结果是本轮快照的一部分；
   *   之后适配器/事件都读同一份 plan，不会两边各算一遍。
   */
  const baseDescription = rt.model?.describe();
  let reasoningProvider: ReasoningProvider = detectReasoningProvider({
    ...(baseDescription !== undefined ? { adapter: baseDescription.provider } : {}),
    model: baseDescription?.model ?? '',
  });
  let reasoningModel = baseDescription?.model ?? '';

  const profileStore = await loadProfileStore(DATA_DIR);
  const bodyProfileId =
    typeof body.modelProfileId === 'string' && body.modelProfileId.trim().length > 0
      ? body.modelProfileId.trim()
      : undefined;
  const bodyModelId =
    typeof body.modelId === 'string' && body.modelId.trim().length > 0
      ? body.modelId.trim()
      : undefined;
  const bodyHasModel = bodyProfileId !== undefined && bodyModelId !== undefined;
  const sessionHasModel =
    typeof session.modelProfileId === 'string' &&
    session.modelProfileId.trim().length > 0 &&
    typeof session.modelId === 'string' &&
    session.modelId.trim().length > 0;

  /**
   * ★★ 模型也以 session 为权威（与 reasoning 同一规则）。
   *
   *   session 有模型 → 只认 session；body 里的模型**不覆盖**、也不回写。
   *   session 没有模型 → 才用 body 里的旧桌宠模型兜底；
   *   再没有 → 最近使用模型。
   *
   * ⚠️ 不能把 body 模型写回 session：
   *    否则桌宠旧请求会悄悄改掉 Web 会话选好的模型。
   *    桌宠右键切模型要 PATCH 对应 session（scripts/petapp）。
   */
  const petModel = petConfig?.model ?? null;
  const petHasModel =
    petModel !== null &&
    petModel.profileId.trim().length > 0 &&
    petModel.modelId.trim().length > 0;
  const selection: { profileId: string; modelId: string } | null = petHasModel && petModel !== null
    ? { profileId: petModel.profileId.trim(), modelId: petModel.modelId.trim() }
    : sessionHasModel
      ? { profileId: session.modelProfileId.trim(), modelId: session.modelId.trim() }
      : bodyHasModel
        ? { profileId: bodyProfileId, modelId: bodyModelId }
        : profileStore.lastChat;
  let effectiveModelProfileId: string | undefined;
  let effectiveModelId: string | undefined;
  if (selection !== null) {
    const resolved = await resolveProfileModel(
      DATA_DIR,
      selection.profileId,
      selection.modelId,
      'chat',
    );
    if (resolved === null) {
      return Response.json(
        { error: '当前选择的对话模型不可用：配置不存在、模型不存在或缺少 API Key。' },
        { status: 503 },
      );
    }
    const cfg = {
      ...resolved.config,
      apiKey: resolved.config.apiKey.length > 0 ? resolved.config.apiKey : 'local',
    };
    model =
      resolved.preset.adapter === 'deepseek'
        ? new DeepSeekModel(cfg)
        : new OpenAICompatibleModel(
            cfg,
            resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
          );
    streamModel = resolved.preset.adapter === 'deepseek'
      ? new DeepSeekStream({ ...cfg, model: cfg.model ?? selection.modelId })
      : null;
    translator = deepSeekTranslationPort(model);
    reasoningProvider = detectReasoningProvider({
      presetId: resolved.preset.id,
      adapter: resolved.preset.adapter,
      model: resolved.model.id,
    });
    reasoningModel = resolved.model.id;
    effectiveModelProfileId = resolved.profile.id;
    effectiveModelId = resolved.model.id;
  }

  if (model === null) {
    return Response.json(
      {
        error:
          '未配置模型。请先在设置 → 模型接入里添加对话模型。' +
          '（记忆治理相关功能不依赖模型，仍可使用）',
      },
      { status: 503 },
    );
  }

  /**
   * ★★ 本轮设置快照 —— 只在这里读一次 session。
   *
   *   之后执行中 PATCH 只改 session 状态，不会影响这一轮：
   *   persona / reasoning / memoryMode / 模型都按这里的值走。
   */
  const currentSession = rt.bootstrapped.chat.getSession(session.id) ?? session;
  /**
   * 桌宠设置的人格/思考强度的真相源是 pet-config，而不是通用 session。
   * 这里只在桌宠会话生效；普通对话仍使用自己的 session 设置。
   */
  const sessionForSettings =
    petConfig !== null
      ? {
          ...currentSession,
          persona: petConfig.persona,
          reasoning: reasoningFromLegacyThinkingLevel(petConfig.thinkingLevel),
        }
      : currentSession;
  const globalAgents = await loadGlobalAgents();
  const envMemoryMode = process.env['BUTLER_MEMORY_MODE'];
  const memoryModeOverride: TurnMemoryMode | undefined =
    envMemoryMode === 'shadow' ? 'shadow' : envMemoryMode === 'off' ? 'off' : undefined;
  const scopeDefaults = scopeDefaultsOf(rt);
  const turnSettings = createTurnSettings({
    session: sessionForSettings,
    requestPersona: typeof body.persona === 'string' ? body.persona : undefined,
    legacyThinkingLevel: body.thinkingLevel,
    ...(memoryModeOverride !== undefined ? { memoryModeOverride } : {}),
    reasoningProvider,
    model: reasoningModel,
    ...(effectiveModelProfileId !== undefined ? { effectiveModelProfileId } : {}),
    ...(effectiveModelId !== undefined ? { effectiveModelId } : {}),
    globalAgents,
    defaultWorkspace: scopeDefaults.workspace,
    defaultPermission: scopeDefaults.permission,
    capturedAt: rt.clock.now(),
  });

  /**
   * ★★ 本会话/本轮的独立工具作用域。
   *
   * 不再使用 `rt.tools`：那个框架的 fs root 与权限策略是所有会话共享的，
   * 并发对话会串工作区/串权限。这里按 `turnSettings` 快照构造一份全新框架：
   *   · 工作区 = 快照的 effectiveWorkspace；
   *   · 权限 = 快照的 effectivePermission（不可变策略）；
   *   · 受保护路径始终含 DATA_DIR 与 `.env.local`。
   *
   * ★ 执行中 PATCH 只改 session；本轮已经拿走快照，下一轮才重建作用域。
   */
  const taskPlan = createTaskPlanState();
  let chatTools: ToolFramework;
  try {
    const scope = await createChatToolScope({
      log: rt.bootstrapped.log,
      clock: rt.clock,
      workspace: turnSettings.effectiveWorkspace,
      permission: turnSettings.effectivePermission,
      dataDir: dataDirOf(rt),
      // 外部文件面板授权的路径：只影响本会话本轮的工具作用域。
      allowedPaths: externalGrantsFor(session.id),
      // config/ 与 .env.local 的受保护根必须跟随应用根，而不是用户工作区；
      // 否则设置 BUTLER_WORKSPACE 后 config/AGENTS.md 会落到保护区之外。
      appRoot: process.cwd(),
      baseTools: rt.tools,
      confirmActions: rt.permissionPolicy.confirmActions,
      taskPlan,
      documentSearch: {
        search: async (query, limit) =>
          (await getKnowledgeService().search(query, limit)).hits,
      },
    });
    chatTools = scope.tools;
  } catch (err) {
    return Response.json(
      {
        error:
          '本对话的工作区不可用：' +
          (err instanceof Error ? err.message : String(err)) +
          '。请在对话设置里重新选择已存在的目录。',
      },
      { status: 400 },
    );
  }

  const chatModel = model;
  const chatStreamModel = streamModel;
  const chatTranslator = translator;
  const encoder = new TextEncoder();

  /**
   * ★ 用户点“停止”时，浏览器会 abort fetch。
   *   这里把请求信号接到本轮任务：不是只停止发送，而是真的停止后台循环。
   */
  const abort = new AbortController();
  const onRequestAbort = (): void => abort.abort();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener('abort', onRequestAbort, { once: true });

  /**
   * ★ 会话级互斥：同一个会话同时只能跑一轮。
   *
   *   没有它的时候，双击发送 / 前端重试 / 两个标签页会让同一 session
   *   并行跑两轮 `runTurn`：事件交错写入、两个 ToolFramework 各一份熔断计数
   *   （写次数上限失效）、模型被调两次（重复计费）。
   *
   * ⚠️ 锁必须在**流建立之前**拿：拿不到就直接回 409。
   *    等进了流再报错就晚了 —— 那时已经回了 200，前端只能看到一条诡异的错误事件。
   */
  const releaseTurn = acquireSessionTurn(session.id);
  if (releaseTurn === null) {
    req.signal.removeEventListener('abort', onRequestAbort);
    return Response.json(
      {
        error: '这个会话上一轮还在执行，等它结束（或点停止）后再发。',
        code: 'turn_in_progress',
      },
      { status: 409 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // 客户端已断开 —— 只标记停止发送；后台取消由 request.signal / cancel() 负责
          closed = true;
        }
      };

      // 立刻告诉客户端会话 id（界面需要它来续接）
      send({ type: 'session', sessionId: session.id });

      /**
       * ★ C6 询问通道：**仅当调用方声明能处理时才启用**。
       *
       * ⚠️ 能力协商：调用方能处理确认，且全局确认开关开启时才启用。
       *    开关关闭时按权限模式直接执行；本轮不产生 approval 事件。
       */
      const approvals =
        body.supportsApproval === true && rt.permissionPolicy.confirmActions
          ? new SseApprovals({
              emit: (req) =>
                send({
                  type: 'approval',
                  id: req.id,
                  toolName: req.toolName,
                  tier: req.tier,
                  summary: req.summary,
                  ...(req.preview !== undefined ? { preview: req.preview } : {}),
                }),
            })
          : undefined;

      const endSteering = beginTurnSteering(session.id, {
        cancelApprovals: () => approvals?.denyAll() ?? 0,
        onMessage: (text) => {
          // 中途消息立即进入会话历史；模型侧在下一个安全边界收到它。
          rt.bootstrapped.chat.appendMessage(session.id, { role: 'user', text });
          send({ type: 'steering', text });
        },
      });

      /**
       * ★ 记下这一轮的起始 seq —— 界面据此取「本轮依据」。
       *
       *   ⚠️ 用 seq 区间而不是消息 id 关联：
       *      事件流是线性的，一轮对话对应一段连续 seq，
       *      这是**由事件流结构本身给出的**，不需要额外记账表。
       *      （而记账表本身会成为需要维护、也可能出错的东西 ——
       *        「这条注入属于哪一轮」在没有唯一答案时怎么办？）
       */
      const fromSeq = rt.bootstrapped.log.length + 1;

      /**
       * ★ 落本轮设置快照事件（审计）。
       *
       * ⚠️ 事件里**不写人格正文**，只有 hash / 长度；
       *   推理强度会记录 requested 与 applied（含回退原因），
       *   这样验收时能回答“实际发的是哪一档”。
       */
      rt.bootstrapped.log.append({
        type: 'session.settings',
        actor: 'user',
        payload: turnSettingsEventPayload(turnSettings),
        createdAt: rt.clock.now(),
      });
      send({
        type: 'settings',
        settings: {
          reasoning: turnSettings.reasoning,
          reasoningApplied: turnSettings.reasoningPlan.applied,
          reasoningStyle: turnSettings.reasoningPlan.style,
          memoryMode: turnSettings.memoryMode,
          workspace: turnSettings.workspace,
          permission: turnSettings.permission,
          effectiveWorkspace: turnSettings.effectiveWorkspace,
          effectivePermission: turnSettings.effectivePermission,
          personaSource: turnSettings.personaSource,
          personaLength: turnSettings.personaLength,
          globalAgents: {
            hash: turnSettings.globalAgents.hash,
            length: turnSettings.globalAgents.length,
            loaded: turnSettings.globalAgents.loaded,
          },
        },
      });

      // 本轮开始前的会话累计用量（界面用“累计”= 已完成轮次 + 本轮实时）。
      const priorVerdicts = rt.bootstrapped.chat.verdictsOf(session.id);
      const baseInputTokens = priorVerdicts.reduce(
        (n, v) => n + (v.sessionUsage?.inputTokens ?? v.usage.inputTokens),
        0,
      );
      const baseOutputTokens = priorVerdicts.reduce(
        (n, v) => n + (v.sessionUsage?.outputTokens ?? v.usage.outputTokens),
        0,
      );

      // 取消事件需要知道“取消在哪一步”；只记阶段名，不记正文/参数。
      let lastStage = 'starting';
      /**
       * ★ 中断也要能审查：进程里已经发生过的工具调用要留住。
       *
       *   成功时 `runTurn` 会自己 build 一份 trace 落进消息；
       *   但它在异常路径直接 throw，拿不到那份 trace。
       *   这里顺手用同一个收集器接住进度事件 —— 中断消息因此也带轨迹。
       */
      const turnTrace = createTraceCollector();
      /**
       * ★ 中断保留：流式回调里的完整累积内容。
       *
       *   turnTrace 为了事件体积只保留尾部；这里另存完整正文/思考，
       *   让用户点停止时能看到的最后状态原样落盘。
       */
      const partialTexts = new Map<number, string>();
      const partialReasoning = new Map<number, string>();
      const lastNarration = { answer: '', reasoning: '', reasoningTranslated: '' };
      let lastMilestone = '';
      let milestoneCount = 0;
      const emitMilestone = (text: string | null): void => {
        if (!isPetSession || text === null || text === lastMilestone || milestoneCount >= 6) return;
        lastMilestone = text;
        milestoneCount += 1;
        send({ type: 'milestone', text });
      };
      const endActiveTurn = trackActiveTurn({
        sessionId: session.id,
        startedAt: Date.now(),
        text,
      });

      rt.activeTurns += 1;
      try {
        // 浏览器被动上下文：默认开启；只放标题/URL，正文由 browser_read 工具按需读取。
        const browserPage = await browserPageSummary().catch(() => null);
        const browserContext =
          browserPage === null
            ? undefined
            : [
                '[浏览器上下文] 用户当前正在看的内嵌浏览器页面：',
                `标题：${browserPage.title || '（无标题）'}`,
                `URL：${browserPage.url}`,
                '需要正文时调用 browser_read；需要标签或选区时用 browser_tabs / browser_selection。',
              ].join('\n');
        const result = await runTurn({
          sessionId: session.id,
          userText: text,
          optionalPlan: true,
          // ★ 本轮设置快照：persona / reasoning / memoryMode / global AGENTS
          //   全部来自这里，执行中 PATCH 不影响当前轮。
          settings: turnSettings,
          ...(petContext !== undefined && petContext.length > 0 ? { petContext } : {}),
          ...(browserContext !== undefined ? { browserContext } : {}),
          // ★ 本轮图片（只这一次有效，不落历史）
          ...(images.length > 0 ? { images } : {}),
          // ★ 本轮询问通道（C6）：仅调用方声明能处理时才有，否则退回"立即拒绝"
          ...(approvals !== undefined ? { asker: approvals } : {}),
          // ★ 监督员触发：默认 manual（用户按需），可用 SUPERVISOR_MODE=auto 回退
          supervisionMode: supervisionConfig.mode,
          reflectionMode: 'dailyDiary',
          userId: currentSession.userId,
          model: chatModel,
          ...(rt.rerankModel !== null ? { rerankModel: rt.rerankModel } : {}),
          ...(rt.rerankScorer !== null ? { reranker: rt.rerankScorer } : {}),
          random: rt.random,
          log: rt.bootstrapped.log,
          clock: rt.clock,
          store: rt.bootstrapped.memory,
          evolution: rt.evolution,
          semantic: rt.semantic,
          chat: rt.bootstrapped.chat,
          // ★ 本会话/本轮的独立工具作用域 —— 不再用共享的 rt.tools
          tools: chatTools,
          signal: abort.signal,
          onProgress: (e: ProgressEvent) => {
            lastStage = e.kind === 'stage' ? e.stage : e.kind;
            send({ type: 'progress', event: e });
          },

          /**
           * ★ 流式叙述 —— 与仆人执行**并发**跑。
           *
           *   实测：仆人执行 30—60 秒，而叙述只要 1.6—2.4 秒。
           *   所以叙述会在死时间里先说完，逐字推给界面。
           *
           * ⚠️ 用 `streamModel`（`NARRATION_MODEL`，默认 deepseek-flash），
           *    **不是** `model` —— 两者用途不同：叙述是"轻活"（短、快），
           *    用便宜快的模型就够，不必占用主模型。
           *    ⚠️ 接错模型的后果很隐蔽：**推理流永远是空的，且不报错**。
           */
          ...(chatStreamModel !== null ? { streamModel: chatStreamModel } : {}),
          ...(chatTranslator !== null ? { translatorPort: chatTranslator } : {}),
          onNarration: (s) => {
            lastNarration.answer = s.answer;
            lastNarration.reasoning = s.reasoning;
            lastNarration.reasoningTranslated = s.reasoningTranslated;
            send({
              type: 'narration',
              reasoning: s.reasoning,
              reasoningTranslated: s.reasoningTranslated,
              answer: s.answer,
              firstChunkMs: s.firstChunkMs,
              done: s.done,
            });
          },

          /**
           * ★★ 工具循环进度 —— 「思考 → 工具 → 再思考」画面的来源。
           *
           *   实测（一次真实工具循环，3 轮 4 次调用）：
           *     ▸ 调用 list_dir → ⚙ 执行 → ✓ 结果 32 字（8ms）
           *     ▸ 调用 read_file → ⚙ 执行 → ✓ 结果 26 字（2ms）
           *     ▸ 调用 submit_report → ✓ 13 字（20ms）
           *
           *   ⚠️ 只推**必要**字段：
           *      工具结果可能几十 KB，而界面只需要看开头
           *      （完整内容用户可展开审计视图看）。
           *      `accumulated` 已经截断在 agentLoop 里。
           */
          onAgentProgress: (e) => {
            // 中断时靠这份轨迹说明"它已经做过什么"
            if (e.kind === 'text') partialTexts.set(e.round, e.accumulated);
            else if (e.kind === 'reasoning') partialReasoning.set(e.round, e.accumulated);
            turnTrace.onEvent(e);
            switch (e.kind) {
              case 'roundStarted':
                send({ type: 'agent', kind: 'round', round: e.round });
                break;
              case 'reasoning':
                send({
                  type: 'agent',
                  kind: 'reasoning',
                  round: e.round,
                  accumulated: e.accumulated.slice(-4000),
                });
                break;
              case 'text':
                send({
                  type: 'agent',
                  kind: 'text',
                  round: e.round,
                  accumulated: e.accumulated.slice(-4000),
                });
                break;
              case 'toolCall':
                send({
                  type: 'agent',
                  kind: 'toolCall',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                  argsDelta: e.argsDelta,
                  partial: e.partial,
                });
                break;
              case 'toolStarted':
                send({
                  type: 'agent',
                  kind: 'toolStarted',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                });
                break;
              case 'toolResult':
                send({
                  type: 'agent',
                  kind: 'toolResult',
                  round: e.round,
                  callId: e.callId,
                  name: e.name,
                  ok: e.ok,
                  denied: e.denied,
                  output: e.output,
                  durationMs: e.durationMs,
                });
                emitMilestone(
                  milestoneForTool({ name: e.name, ok: e.ok, denied: e.denied }),
                );
                break;
              case 'usage':
                send({
                  type: 'usage',
                  round: e.round,
                  inputTokens: e.inputTokens,
                  outputTokens: e.outputTokens,
                  totalInputTokens: e.totalInputTokens,
                  totalOutputTokens: e.totalOutputTokens,
                  sessionInputTokens: baseInputTokens + e.totalInputTokens,
                  sessionOutputTokens: baseOutputTokens + e.totalOutputTokens,
                });
                break;
              case 'finished':
                send({
                  type: 'agent',
                  kind: 'finished',
                  rounds: e.rounds,
                  reason: e.reason,
                });
                break;
            }
          },
        });

        send({ type: 'user', messageId: result.userMessageId });

        /**
         * ★ 本轮「承诺了什么」—— 任务契约与假设。
         *
         *   契约原本只在事件里（`contract.written`），界面上看不到；
         *   而它是监督员逐条核对的**唯一标准**，也是用户判断
         *   “它理解对了没有”的直接依据。所以随结果一并推给界面。
         *
         * ⚠️ 只推展示所需字段，`contract.raw` 是模型原始产出，留在事件里。
         */
        const contract = result.session.contract;
        send({
          type: 'contract',
          contract:
            contract !== undefined
              ? {
                  deliverable: contract.deliverable,
                  criteria: contract.criteria,
                  mustObey: contract.mustObey,
                  domains: contract.domains,
                  confidence: contract.confidence,
                  clarifyingQuestion: contract.clarifyingQuestion ?? null,
                }
              : null,
          assumption: result.session.assumption ?? null,
          injectedConstraints: result.session.injectedConstraints.map((c) => ({
            memoryId: c.memoryId,
            content: c.content,
            source: c.source,
            negotiable: c.negotiable,
          })),
        });

        // 最终用量以 verdict 为准：它包含工具循环之后的监督/反思调用。
        const finalSessionUsage = result.verdict.sessionUsage ?? {
          inputTokens: baseInputTokens + result.verdict.usage.inputTokens,
          outputTokens: baseOutputTokens + result.verdict.usage.outputTokens,
        };
        send({
          type: 'usage',
          round: 0,
          inputTokens: result.verdict.usage.inputTokens,
          outputTokens: result.verdict.usage.outputTokens,
          totalInputTokens: result.verdict.usage.inputTokens,
          totalOutputTokens: result.verdict.usage.outputTokens,
          sessionInputTokens: finalSessionUsage.inputTokens,
          sessionOutputTokens: finalSessionUsage.outputTokens,
        });

        send({ type: 'reply', messageId: result.replyMessageId, text: result.replyText });
        send({ type: 'verdict', verdict: result.verdict });
        /**
         * ★ 本轮反思的结果 —— 「刚学到几条、几条等你确认」。
         *
         *   反思发生在对话之后，用户本来完全看不到。
         *   把 pendingReview 推给界面，治理闭环才在**对话现场**成立：
         *   用户当场就知道“它想记什么”，而不是过几天在记忆页里翻出来。
         */
        send({
          type: 'reflection',
          reflection:
            result.reflection !== undefined
              ? {
                  pendingReview: result.reflection.pendingReview,
                  admittedAutonomously: result.reflection.admittedAutonomously,
                  skippedDuplicates: result.reflection.skippedDuplicates,
                  failed: result.reflection.failed,
                  failureReason: result.reflection.failureReason ?? null,
                }
              : null,
        });
        /**
         * ★ 各仆人各自的产出 —— 右侧「仆人面板」的数据。
         *
         *   与落进消息的那一份是**同一个对象**（在 runTurn 里只转换一次）——
         *   否则会出现「界面上看到的」与「刷新后看到的」不一致。
         */
        send({ type: 'reports', reports: result.executionReports });

        /**
         * ★ 本轮的 seq 区间 —— 界面据此拉「它凭什么这么说」。
         *
         *   只发区间不发内容：内容可能不小（召回 + 注入 + 校验），
         *   而用户在多数轮次里不会展开看。**按需拉取**比一次性推更省。
         */
        send({
          type: 'audit',
          range: { fromSeq, toSeq: rt.bootstrapped.log.length },
        });
      } catch (err) {
        /**
         * ★ 中途停止（用户点停止 / 网络断 / 余额不足 / 内部错误）也要落一条消息。
         *
         *   旧行为：异常路径下什么都不写，于是历史里只剩用户那句话，
         *   轮次轨道显示"运行中"，而且**不可审查**。
         *
         *   现在的取舍：
         *   · status = 'interrupted'（界面已有"中断（可审查）"状态）；
         *   · interruptReason 区分四种原因，处置方式完全不同；
         *   · auditRange 指向本轮已经发生的事件区间，审查面板照样能展开；
         *   · 不伪造模型没说过的正文，只写一句"发生了什么"。
         */
        const interruptedReason = abort.signal.aborted ? 'user_stopped' : classifyTurnFailure(err);
        const toSeq = rt.bootstrapped.log.length;
        const recentEvents = rt.bootstrapped.log.range(fromSeq, toSeq);
        const toolCalls = recentEvents.filter((e) => e.type === 'tool.call').length;
        const toolResults = recentEvents.filter((e) => e.type === 'tool.result').length;

        const note = interruptedNote({
          reason: interruptedReason,
          toolCalls,
          toolResults,
          error: err,
        });

        const lastNonEmpty = (values: Map<number, string>): string => {
          for (const value of [...values.values()].reverse()) {
            if (value.trim().length > 0) return value;
          }
          return '';
        };
        const partialText = lastNonEmpty(partialTexts);
        const partialThinking = lastNonEmpty(partialReasoning);
        const narration = lastNarration.answer;
        const narrationReasoning = lastNarration.reasoning || partialThinking;
        /**
         * ★ 有正文就保留正文；没有正文至少保留 narration。
         *
         *   中断说明追加在末尾，绝不替换已生成内容。
         *   超过 12k 的正文保留前段并明确告知截断；
         *   思考由 agentTrace 保留尾部（其自身有上限）。
         */
        const body =
          partialText.trim().length > 0
            ? `${partialText.trim().slice(0, 12_000)}${
                partialText.length > 12_000 ? '\n\n（后续内容因长度上限未写入）' : ''
              }\n\n---\n\n${note}`
            : note;

        try {
          rt.bootstrapped.chat.appendMessage(session.id, {
            role: 'butler',
            text: body,
            ...(narration.length > 0 ? { narration: narration.slice(0, 4_000) } : {}),
            ...(narrationReasoning.length > 0
              ? { reasoning: narrationReasoning.slice(-8_000) }
              : {}),
            status: 'interrupted',
            interruptReason: interruptedReason,
            auditRange: { fromSeq, toSeq },
            ...(turnTrace.hasContent() ? { agentTrace: turnTrace.build() } : {}),
          });
        } catch {
          // 落消息失败不能掩盖原始错误
        }

        if (abort.signal.aborted) {
          /**
           * ★ C8：取消也要可回放。
           *
           * 只记“取消在哪一步 + 已经发生过多少次工具调用/结果”，
           * 不记工具参数、结果正文或模型输出 —— 那会把取消事件变成新的泄露点。
           */
          const recent = rt.bootstrapped.log.range(fromSeq, rt.bootstrapped.log.length);
          rt.bootstrapped.log.append({
            type: 'session.cancelled',
            actor: 'user',
            payload: {
              sessionId: session.id,
              reason: 'user_cancelled',
              phase: lastStage,
              fromSeq,
              toSeq: rt.bootstrapped.log.length,
              toolCalls: recent.filter((e) => e.type === 'tool.call').length,
              toolResults: recent.filter((e) => e.type === 'tool.result').length,
            },
            createdAt: rt.clock.now(),
          });
          // 取消也意味着任务结束：该任务的敏感授权立即失效
          rt.bootstrapped.memory.revokeGrantsForTask(session.id);
        } else {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        endActiveTurn();
        /**
         * ★ 释放会话锁。
         *
         *   正常结束、异常、用户中止都会走这里 —— 锁不释放的话，
         *   这个会话会永久 409，只能重启进程才能恢复。
         */
        releaseTurn();
        rt.activeTurns = Math.max(0, rt.activeTurns - 1);
        req.signal.removeEventListener('abort', onRequestAbort);
        /**
         * ★ 流结束 → 只拒绝**本轮 asker** 还挂着的确认。
         *
         * ⚠️ 不能用全局 denyAllPending：并发会话会互相误伤。
         *    没有超时后，这条清理是 pending 唯一的自动收敛路径。
         */
        endSteering();
        approvals?.denyAll();

        send({ type: 'done' });
        try {
          controller.close();
        } catch {
          // 已关闭
        }
        // ★ 每轮结束都刷盘 —— 用户重新加载不该看到"刚才说的话没了"
        await rt.bootstrapped.log.flushPersistence().catch(() => undefined);
      }
    },
    cancel() {
      // 客户端断开连接时，ReadableStream 会走这里；与 request.signal 双保险。
      //
      // ⚠️ 这里也要释放会话锁：`start` 的 finally 在极端情况下可能还没跑
      //    （流在启动阶段就被取消），不释放会把会话永久锁死。
      releaseTurn();
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}


