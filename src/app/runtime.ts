/**
 * 服务端运行时 —— 请求间共享的**单例**
 *
 * 设计依据：方案 § 14（技术栈：必须长驻进程，不能用 Serverless）
 *
 * ★ 这个文件解决一个具体问题：
 *   Next.js 的 Route Handler 每次请求都可能重新求值模块。
 *   如果没有单例，每次请求都会重新 `bootstrap()` ——
 *   于是：
 *     · 进程内积累的记忆在请求之间丢失
 *     · 事件文件被并发追加（JSONL 交错损坏）
 *     · 定时任务被重复启动
 *
 *   **持久化做完但没接单例，等于白做。**
 *
 * ⚠️ 为什么用 `globalThis` 而不是模块级变量：
 *   Next.js 开发模式会热重载模块 —— 模块级变量在每次热重载时重置，
 *   于是开发时表现成"状态老是丢"，而生产环境却正常，极难排查。
 *   `globalThis` 在热重载之间存活。
 *
 * ⚠️ 为什么不能部署到 Serverless：
 *   本模块的正确性依赖"进程持续存在"。
 *   Vercel 之类的 Serverless 每个请求可能落在不同实例上，
 *   单例与内存状态都不成立，事件文件也会并发写坏。
 *   ——这也正是方案 § 14 明确要求长驻进程的原因。
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { JsonlEventStore, loadEvents } from '@/adapters/storage/jsonlEvents.js';
import { JsonlMemoryArchive } from '@/adapters/storage/jsonlMemoryArchive.js';
import { TrashStore } from '@/adapters/storage/trashStore.js';
import type { MemoryArchivePort } from '@/core/memory/archive.js';
import { SeededRandom } from '@/core/ports/clock.js';
import { SystemClock } from '@/adapters/clock/system.js';
import { bootstrap, renderRestoreSummary, type BootstrapResult } from '@/core/runtime/bootstrap.js';
import { DeepSeekModel } from '@/adapters/model/deepseek.js';
import { OpenAICompatibleModel } from '@/adapters/model/openaiCompatible.js';
import { buildProviderConfig, isProviderEnvLocked, loadSelection } from './server/modelProvider.js';
import {
  loadProfileStore,
  resolveActiveModel,
  resolveProfileModel,
  type ResolvedModel,
} from './server/modelProfiles.js';
import { loadModelRoles } from './server/modelRoles.js';
import { limitsConfig, modelConfig } from '@/core/config/env.js';
import { ToolFramework } from '@/core/tools/framework.js';
import { fileTools } from '@/core/tools/builtin/file.js';
import { webTools } from '@/core/tools/builtin/web.js';
import { documentSearchTool } from '@/core/tools/builtin/documents.js';
import { getKnowledgeService } from './server/knowledge.js';
import { execTool } from '@/core/tools/builtin/exec.js';
import { NodeFileSystem } from '@/adapters/fs/node.js';
import { NodeExec } from '@/adapters/exec/node.js';
import { PythonDesktopBridge } from '@/adapters/desktop/pythonBridge.js';
import { isDesktopPlatform } from '@/core/desktop/port.js';
import { desktopFacadeTools, desktopTools } from '@/core/tools/builtin/desktop.js';
import { WebPermissionPolicy } from './server/permission.js';
import {
  isPermissionMode,
  loadPermissionSettings,
  savePermissionSettings,
  type PermissionSettings,
} from './server/permissionStore.js';
import { getCredentialVault } from './server/credentials.js';
import { ActivityObserver, DEFAULT_CONSENT } from '@/core/activity/observe.js';
import { EvolutionEngine } from '@/core/memory/evolution.js';
import { mergeAll } from '@/core/memory/merge.js';
import { SemanticIndex } from '@/core/memory/semantic.js';
import type { RerankScorer } from '@/core/memory/rerank.js';
import { LocalBgeEmbedding } from '@/adapters/embedding/localBge.js';
import { LocalBgeReranker } from '@/adapters/rerank/localBgeReranker.js';
import { OpenAIEmbedding } from '@/adapters/embedding/openaiEmbedding.js';
import { reflectScheduled } from '@/core/reflection/scheduled.js';
import { DiaryStore } from '@/core/diary/store.js';
import { diarySummary, runDailyDiaries } from '@/core/diary/pipeline.js';
import { weeklyDiaryDigest } from '@/core/diary/weekly.js';
import { loadMcpConfigFile, wireMcpServers } from '@/core/mcp/wiring.js';
import { stdioTransportFactory } from '@/adapters/mcp/stdio.js';
import { httpTransportFactory } from '@/adapters/mcp/http.js';
import { sseTransportFactory } from '@/adapters/mcp/sse.js';
import { createActivityRuntime, startActivityLoop, stopActivityLoop } from '@/core/activity/runtime.js';
import type { ActivityRuntime } from '@/core/activity/runtime.js';
import { DeepSeekStream } from '@/adapters/model/deepseekStream.js';
import { deepSeekTranslationPort } from '@/adapters/model/translation.js';
import type { ModelPort } from '@/core/ports/model.js';
import type { ModelStreamPort } from '@/core/ports/stream.js';
import type { TranslationPort } from '@/core/stream/translate.js';
import { runTurn } from '@/core/chat/service.js';
import {
  startUserTaskLoop,
  stopUserTaskLoop,
  UserTaskService,
  type UserTask,
  type WorkTaskResult,
} from '@/core/tasks/index.js';
import { TaskPermissionPolicy } from './server/taskPermission.js';
import { assertWorkspaceDirectory, workspacePathGuard } from './server/taskWorkspace.js';
import { loadSessionPersonas } from './server/sessionSettingsStore.js';

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

/** 程序安装根目录（不是用户工作区）。 */
export const APP_ROOT = process.cwd();

/** 数据目录（可用环境变量覆盖）。 */
export const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(APP_ROOT, '.butler-data');

/** 事件文件路径。 */
export function eventsFile(customDir?: string): string {
  return join(customDir ?? DATA_DIR, 'events.jsonl');
}

/** 默认用户 id。
 *
 * ⚠️ 仍是固定的单用户 —— 本地登录（src/app/server/localAuth.ts）只做本机
 *    访问控制，不改变数据归属；所有记忆都归属这一个 id，
 *    所以"多用户隔离"当前不成立，
 *    不能对外宣称支持多用户。
 */
export const DEFAULT_USER_ID = process.env['BUTLER_USER_ID'] ?? 'local';

/**
 * 工具的工作根目录。
 *
 * ★ 默认是专门的 `APP_ROOT/workplace`，不是应用启动目录本身。
 *   否则模型默认能看到 src/、scripts/、config/ 等程序文件。
 *   `BUTLER_WORKSPACE` 仍可显式覆盖。
 *
 * ⚠️ 程序脚本、config/、.env.local 仍挂在 APP_ROOT 下，不能跟着工作区走。
 */
export const WORKSPACE_ROOT = process.env['BUTLER_WORKSPACE'] ?? join(APP_ROOT, 'workplace');
try {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
} catch {
  // 目录创建失败时让后续文件工具报明确错误，不在模块加载阶段崩掉。
}

// ═══════════════════════════════════════════════════════════
// 运行时形状
// ═══════════════════════════════════════════════════════════

export interface ButlerRuntime {
  readonly bootstrapped: BootstrapResult;
  readonly clock: SystemClock;
  readonly random: SeededRandom;
  /** 系统数据目录（与 `DATA_DIR` 同源；供会话工具作用域做受保护路径校验）。 */
  readonly dataDir: string;
  /** 应用默认工具工作区（与 `WORKSPACE_ROOT` 同源）。 */
  readonly workspaceRoot: string;
  /** 程序安装根（与 `APP_ROOT` 同源）：`.env.local`、`config/` 在这里。 */
  readonly appRoot: string;
  /**
   * 记忆存档区（第一步删除的落点）。
   *
   * ⚠️ 每个功能域各有自己的存档区：记忆的在这里，文档的由文档服务管理，
   *    工作区文件将来有自己的回收站。**不要合并成一个大归档区。**
   */
  readonly memoryArchive: MemoryArchivePort;
  /**
   * 工作区文件回收站（`remove_path` 删掉的东西进这里）。
   *
   * ⚠️ 与两个存档区（记忆/文档）互相独立：文件是磁盘真实对象，
   *    不参与导出迁移。
   */
  readonly trash: TrashStore;
  /** 主模型（文本 + 结构化 + 工具） */
  readonly model: ModelPort | null;
  /** 固定的记忆模型；不跟随对话模型切换。 */
  readonly memoryModel: ModelPort | null;
  /** 固定的召回重排模型；不跟随对话模型切换。 */
  readonly rerankModel: ModelPort | null;
  /** 没有独立重排模型时使用本地 embedding 打分；它不是对话模型。 */
  readonly rerankScorer: RerankScorer | null;
  /** 流式模型（推理流用） */
  readonly streamModel: ModelStreamPort | null;
  /** 英文思考增量翻译；没有模型时为 null */
  readonly translator: TranslationPort | null;
  /**
   * 工具框架。
   *
   * ⚠️ 不给它，仆人就走「纯推理」路径 ——
   *    界面上也就看不到任何工具调用。
   */
  readonly tools: ToolFramework;
  readonly permissionPolicy: WebPermissionPolicy;
  readonly setPermissionMode: (mode: 'view' | 'workspace' | 'full') => Promise<void>;
  readonly setPermissionSettings: (settings: Partial<PermissionSettings>) => Promise<void>;
  /** 启动时间 */
  readonly startedAt: number;
  /** 启动摘要（供界面"已恢复 N 条记忆"展示） */
  readonly restoreSummary: string;
  /** 当前会话 id */
  sessionId: string;
  /** 正在执行的对话轮数（回退前必须为 0，避免截断运行中的事件流） */
  activeTurns: number;
  /** 记忆演化引擎（命中反馈 + 日级迁移） */
  readonly evolution: EvolutionEngine;
  /** 本地语义索引；模型缺失时 scores 会抛错，调用方回退字面召回。 */
  readonly semantic: SemanticIndex;
  /** 每日日记仓储（事件溯源、每作用域每天唯一）。 */
  readonly diary: DiaryStore;
  /** 行为观察器（同意开关由界面通过 /api/observation 操作）*/
  readonly activityObserver: ActivityObserver;
  /** 定时任务运行时（调度器在任务注册后才是完整的） */
  readonly activityRuntime: ActivityRuntime;
  /** 用户自建的提醒 / 工作 */
  readonly userTasks: UserTaskService;
  /** MCP 配置文件路径（管理界面写回用） */
  readonly mcpConfigPath: string;
}

const GLOBAL_KEY = '__butlerRuntime__';

interface GlobalWithRuntime {
  [GLOBAL_KEY]?: Promise<ButlerRuntime>;
}

/**
 * 取运行时（单例）。
 *
 * ★ 返回 Promise 而不是同步值 —— 因为首次初始化要读盘。
 *   并发调用会共享同一个 Promise，**不会重复初始化**。
 */
export function getRuntime(): Promise<ButlerRuntime> {
  const g = globalThis as GlobalWithRuntime;

  const existing = g[GLOBAL_KEY];
  if (existing !== undefined) return existing;

  const created = initRuntime();
  g[GLOBAL_KEY] = created;

  /**
   * ★ 初始化失败**不能**留在缓存里。
   *
   *   旧写法 `g[GLOBAL_KEY] ??= initRuntime()` 会把 rejected Promise 永久缓存：
   *   第一次启动时磁盘刚好被占用 / 事件文件读失败，之后**每个请求**
   *   都拿到同一个失败结果 —— 即使原因已经消失，进程也永远好不了，只能重启。
   *
   *   这里在 reject 时清掉缓存（只清自己那一个，避免误删并发重建的新实例），
   *   下一个请求就会重试初始化。
   */
  created.catch(() => {
    if (g[GLOBAL_KEY] === created) delete g[GLOBAL_KEY];
  });

  return created;
}

/** 仅供测试/重置使用。 */
export async function resetRuntime(): Promise<void> {
  const g = globalThis as GlobalWithRuntime;
  // 旧 timer 引用旧 runtime；不停止会在重建后继续空转/复用旧 handle。
  stopActivityLoop();
  stopUserTaskLoop();
  const current = g[GLOBAL_KEY];
  try {
    if (current) {
      const rt = await current;
      await rt.bootstrapped.log.flushPersistence();
    }
  } finally {
    /**
     * ★ `delete` 必须放在 finally 里。
     *
     *   旧写法的顺序是 `await current` 然后 `delete` —— 一旦那个 Promise 是
     *   rejected（初始化失败过），await 会先把异常抛出去，`delete` 永远不执行，
     *   失败的实例就被永久钉在缓存里。
     */
    delete g[GLOBAL_KEY];
  }
}

class UnavailableEmbedding {
  readonly model = 'unavailable';

  constructor(private readonly reason: string) {}

  async embed(): Promise<readonly (readonly number[])[]> {
    throw new Error(this.reason);
  }
}

async function createSemantic(dir: string, modelRoot: string): Promise<SemanticIndex> {
  const store = await loadProfileStore(dir);
  const role = store.embedding;
  if (role.kind === 'builtin') {
    return new SemanticIndex(new LocalBgeEmbedding(modelRoot));
  }
  if (role.profileId === undefined || role.modelId === undefined) {
    return new SemanticIndex(new LocalBgeEmbedding(modelRoot));
  }
  const resolved = await resolveProfileModel(dir, role.profileId, role.modelId, 'embedding');
  if (resolved === null) {
    return new SemanticIndex(
      new UnavailableEmbedding('当前嵌入模型配置不可用，语义召回回退字面召回。'),
    );
  }
  return new SemanticIndex(
    new OpenAIEmbedding({
      model: resolved.model.id,
      baseUrl: resolved.profile.baseUrl,
      apiKey: resolved.config.apiKey.length > 0 ? resolved.config.apiKey : 'local',
      dimensions: resolved.model.dimension ?? role.dimension,
    }),
  );
}

function buildRoleModel(resolved: ResolvedModel): ModelPort {
  return resolved.preset.adapter === 'deepseek'
    ? new DeepSeekModel(resolved.config)
    : new OpenAICompatibleModel(
        resolved.config,
        resolved.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
      );
}

async function initRuntime(): Promise<ButlerRuntime> {
  const dir = DATA_DIR;
  await mkdir(dir, { recursive: true });

  const file = eventsFile(dir);
  const loaded = await loadEvents(file);

  const clock = new SystemClock();
  const random = new SeededRandom(Date.now() % 2147483647);
  const store = new JsonlEventStore({ file, flushIntervalMs: 300 });

  const sessionId = `s_${clock.now().toString(36)}`;

  const bootstrapped = bootstrap({
    sessionId,
    userId: DEFAULT_USER_ID,
    clock,
    random,
    historicalEvents: loaded.events,
    badLines: loaded.badLines,
    persistence: store,
  });
  bootstrapped.checkpoints.registerArtifactLabels(
    new Map(bootstrapped.artifacts.all().map((a) => [a.id, a.label])),
  );

  /**
   * ★ 会话人格正文的 sidecar 恢复。
   *
   * 事件里的 `session.settings` 只记 hash/长度（不写正文）；
   * 正文存在 `.butler-data/session-settings.json`，启动时补回 SessionStore。
   * 文件缺失/损坏只是“没有人格正文”，不阻断启动。
   */
  try {
    const personas = await loadSessionPersonas(dir);
    for (const [sessionId, persona] of personas) {
      bootstrapped.chat.restoreSessionPersona(sessionId, persona);
    }
  } catch {
    // 读不到就按空人格处理 —— 不阻断启动
  }

  /**
   * 记忆演化引擎：生产实例。
   *
   * ★ 不能在定时任务里每次 new —— 那样 stats/evoSeq 会重置；
   *   它必须跟随 runtime 单例存活，命中反馈与日级迁移共用同一份状态。
   */
  const evolution = new EvolutionEngine({
    log: bootstrapped.log,
    store: bootstrapped.memory,
    clock,
    random,
    userId: DEFAULT_USER_ID,
  });
  // 日记以事件为真相源：构造时自动回放历史 diary.created。
  const diary = new DiaryStore(bootstrapped.log, clock);

  /**
   * 本地语义索引。
   *
   * ⚠️ 这里只构造，不加载 98MB 模型；首次召回才懒加载。
   *    模型缺失时 SemanticIndex.scores() 抛错，service 回退字面召回。
   */
  const configuredModelRoot = process.env['BUTLER_MODEL_DIR']?.trim() ?? '';
  const embeddingModelRoot =
    configuredModelRoot.length > 0 ? configuredModelRoot : join(DATA_DIR, 'models');
  const semantic = await createSemantic(dir, embeddingModelRoot);
  const embeddingScorer: RerankScorer = {
    name: 'local-embedding',
    score: async (query, candidates) =>
      semantic.scores(
        query,
        candidates.map((c) => c.memory),
      ),
  };
  // 默认用经过 dev/test 校准的 embedding 重排；cross-encoder 可显式开启，
  // 但在当前中文 dev/test 集上没有超过 embedding 阈值方案。
  const crossReranker = new LocalBgeReranker(embeddingModelRoot);
  const useCross = process.env['BUTLER_RERANK_CROSS'] === '1';
  const rerankScorer: RerankScorer =
    useCross && crossReranker.isAvailable() ? crossReranker : embeddingScorer;

  // ── 模型（没有 API Key 时为 null，界面据此提示"未配置模型"）──
  let model: ModelPort | null = null;
  let streamModel: ModelStreamPort | null = null;
  let translator: TranslationPort | null = null;
  try {
    /**
     * ★ provider 解析顺序：环境变量 MODEL_PROVIDER > 本机 model-settings.json
     *   > 默认 deepseek。Key 只从环境变量/凭证库取，不写回日志或事件。
     *
     * ⚠️ OpenAI 兼容与 Ollama 当前只承诺**非流式主模型**：
     *    `streamModel` 只在 DeepSeek 下创建；其它 provider 的叙述流会自然缺席，
     *    UI/设置页必须如实说明，不能假装“流式也可用”。
     */
    const active = isProviderEnvLocked() ? null : await resolveActiveModel(dir);
    if (active !== null) {
      const cfg = {
        ...active.config,
        apiKey: active.config.apiKey.length > 0 ? active.config.apiKey : 'local',
      };
      if (active.config.apiKey.length > 0 || !active.preset.requiresKey) {
        model =
          active.preset.adapter === 'deepseek'
            ? new DeepSeekModel(cfg)
            : new OpenAICompatibleModel(
                cfg,
                active.preset.adapter === 'ollama' ? 'ollama' : 'openai-compatible',
              );

        // DeepSeek 有独立叙述流；其它适配器自动走非流式回退。
        if (active.preset.adapter === 'deepseek') {
          streamModel = new DeepSeekStream({ ...cfg, model: cfg.model ?? modelConfig.narrationModel });
        }
        translator = deepSeekTranslationPort(model);
      }
    } else {
      const loaded = await loadSelection(dir);
      const provider = loaded.selection.provider;
      const built = await buildProviderConfig({
        provider,
        selection: loaded.selection,
      });
      const cfg = built.config;
      if (cfg.apiKey.length > 0) {
        model =
          provider === 'deepseek'
            ? new DeepSeekModel(cfg)
            : new OpenAICompatibleModel(
                cfg,
                provider === 'ollama' ? 'ollama' : 'openai-compatible',
              );

        if (provider === 'deepseek') {
          streamModel = new DeepSeekStream({ ...cfg, model: modelConfig.narrationModel });
        }
        translator = deepSeekTranslationPort(model);
      }
    }
  } catch {
    // 没有配置模型不是致命错误 —— 记忆治理界面不需要模型也能用
    model = null;
  }

  // ── 固定模型角色：记忆 / 重排 ──
  // 角色未配置就是 null，绝不静默回退到当前对话模型。
  let memoryModel: ModelPort | null = null;
  let rerankModel: ModelPort | null = null;
  try {
    const roles = await loadModelRoles(dir);
    if (roles.memory !== null) {
      const resolved = await resolveProfileModel(
        dir,
        roles.memory.profileId,
        roles.memory.modelId,
        'chat',
      );
      if (resolved !== null) memoryModel = buildRoleModel(resolved);
    }
    if (roles.rerank !== null) {
      const resolved = await resolveProfileModel(
        dir,
        roles.rerank.profileId,
        roles.rerank.modelId,
        'rerank',
      );
      if (resolved !== null) rerankModel = buildRoleModel(resolved);
    }
  } catch {
    memoryModel = null;
    rerankModel = null;
  }

  /**
   * ── 工具框架 ──
   *
   * ★★ 这一步之前**缺失**，后果很直接：
   *   `runTurn` 只有在拿到 `tools` 时才让仆人走工具循环，
   *   而界面从未装配过它 —— 所以**界面聊天时仆人根本不调工具**，
   *   那张「思考 → 工具 → 再思考」的画面也就无从出现。
   *
   * 权限策略从 settings.json 恢复 mode 与 confirmActions：
   *   · 开启确认：Web 会话通过 asker 逐次询问；
   *   · 关闭确认：按 mode 直接执行 normal/highRisk；
   *   · dangerous 永远由 isTierEnabled 拒绝。
   */
  const persisted = await loadPermissionSettings(DATA_DIR);
  const configuredMode = process.env['BUTLER_PERMISSION_MODE'];
  const initialMode =
    persisted.mode ?? (isPermissionMode(configuredMode) ? configuredMode : undefined);
  const permissionPolicy = new WebPermissionPolicy({
    allowWrite: process.env['BUTLER_ALLOW_WRITE'] === '1',
    ...(initialMode !== undefined ? { mode: initialMode } : {}),
    confirmActions: persisted.confirmActions,
  });

  const tools = new ToolFramework({
    log: bootstrapped.log,
    clock,
    policy: permissionPolicy,
    fuse: {
      windowMs: limitsConfig.toolFuseWindowMs,
      maxWrites: limitsConfig.toolFuseMaxWrites,
    },
  });

  const fsPort = new NodeFileSystem({
    root: WORKSPACE_ROOT,
    // 模型删文件进回收站，而不是直接消失
    trashDir: join(DATA_DIR, 'trash'),
    /**
     * ★★ 受保护路径 —— 模型**不得**读写。
     *
     * ★ 这不是预防性设计，是**实测暴露的漏洞**：
     *   之前的默认配置下，模型调了
     *     `read_file {"path":".butler-data/events.jsonl"}`
     *   然后说出「系统本次未召回任何用户健康记忆
     *   （memory.recalled count = 0）」—— 它读到了内部状态。
     *
     *   事件文件是整个系统的真相源，里面有全部记忆（含敏感域）、
     *   全部对话、全部内部诊断。能读它等于：
     *     · **绕过分权** —— 不走 `canRead`，敏感域隔离形同虚设
     *     · **绕过审计** —— 读文件不产生 `memory.recalled` 事件
     *     · **破坏提示隔离** —— 看到系统写给自己的诊断
     *
     * ⚠️ 同时保护 `.env.local` —— 那里有 API 密钥。
     *    工具层虽有凭证脱敏，但**不让它读到**比"读到再抹掉"更稳。
     */
    protectedPaths: [DATA_DIR, join(APP_ROOT, '.env.local'), join(APP_ROOT, 'config')],
  });
  tools.registerAll(fileTools(fsPort));
  tools.registerAll(webTools());
  tools.register(execTool(new NodeExec({ cwdRoot: WORKSPACE_ROOT }), WORKSPACE_ROOT));
  tools.register(documentSearchTool({
    search: async (query, limit) => (await getKnowledgeService().search(query, limit)).hits,
  }));

  /**
   * ★ 桌面控制（方案 §9）—— **按真实能力注册，失败即降级**。
   *
   * ⚠️ 三条降级纪律：
   *   ① 非 Windows 平台**直接不注册**（COM/UIA 都是 Windows 专有）
   *   ② Python 或模块缺失**不注册对应工具** —— 模型看到的是"没有这个工具"，
   *      而不是"调了才发现不存在"
   *   ③ 探测本身失败**只记日志、不抛错** —— 桌面能力不可用不该让整个应用起不来
   *
   * ⚠️ 这里**不 await**：探测要拉起 Python（几百毫秒）。放在启动路径上会拖慢首屏。
   *    工具在探测完成前不会被注册，而模型要拿到工具清单也得等一轮对话 ——
   *    实际时序上够用，而且失败时只是"少三个工具"，不影响其它能力。
   */
  if (isDesktopPlatform()) {
    const bridge = new PythonDesktopBridge({
      scriptPath: join(APP_ROOT, 'scripts', 'desktop_bridge.py'),
    });
    void bridge
      .ping()
      .then((caps) => {
        /**
         * ★ 把操作记忆仓储传进去（方案 §6.3 ① 方法记忆）：
         *   从这次起，桌面动作的**成功/失败**都会按任务签名归档，
         *   下次同类任务就能给出"该走哪条路"的建议。
         */
        const specs = desktopTools(bridge, caps.capabilities, bootstrapped.operations);
        const facade = desktopFacadeTools(specs);
        if (facade.length === 0) {
          bridge.close();
          return;
        }
        tools.registerAll(facade);
      })
      .catch((err: unknown) => {
        // 仅记录，不抛 —— 桌面能力缺席是"降级"，不是启动失败
        console.warn('[runtime] 桌面控制不可用（已降级）：', err instanceof Error ? err.message : String(err));
        bridge.close();
      });
  }

  /**
   * ★★ B10 MCP 接线。
   *
   * 审计发现（全量引用扫描）：`registerTransport` / `addServer` / `connect` /
   * `toToolSpecs` / `callTool` 的**生产调用各 0 处** ——
   * `McpClient` 构造出来后只被界面读了个空列表，
   * 于是方案 B10「外部 MCP server 的工具可用」在运行时根本达不到。
   *
   * ⚠️ 配置来源：`MCP_CONFIG_PATH`（默认当前目录 `mcp.json`）。
   *    **没有配置文件就不接** —— 不是错误，没配就是没配。
   * ⚠️ 异步、失败隔离：单个 server 挂掉不影响启动，也不影响别的 server。
   */
  const mcpConfigPath = process.env['MCP_CONFIG_PATH'] ?? 'mcp.json';
  // ★ 传输必须无条件注册：没有配置文件时，用户之后从设置页添加第一个 server
  //   也要能连接；不能在“有配置”分支里才注册。
  bootstrapped.mcp.registerTransport(stdioTransportFactory());
  bootstrapped.mcp.registerTransport(httpTransportFactory());
  bootstrapped.mcp.registerTransport(sseTransportFactory());
  try {
    const vault = await getCredentialVault();
    bootstrapped.mcp.setCredentialResolver((ref) => vault.resolve(ref));
  } catch {
    // 凭证库不可用不影响无 envFromVault 的 server
  }
  const mcpConfig = loadMcpConfigFile(mcpConfigPath);
  if (mcpConfig !== null) {
    if (mcpConfig.rejected.length > 0) {
      console.warn(
        `[mcp] 配置里有 ${mcpConfig.rejected.length} 条被丢弃：`,
        mcpConfig.rejected.map((r) => `#${r.index} ${r.reason}`).join('；'),
      );
    }
    void wireMcpServers({
      mcp: bootstrapped.mcp,
      tools,
      configs: mcpConfig.configs,
      transports: [stdioTransportFactory(), httpTransportFactory(), sseTransportFactory()],
      onError: (id, err) => {
        console.warn(`[mcp] ${id} 出错：`, err instanceof Error ? err.message : String(err));
      },
    })
      .then((r) => {
        if (r.connected.length > 0 || r.failed.length > 0) {
          console.log(
            `[mcp] 已连接 ${r.connected.length} 个 server，注册 ${r.toolsRegistered} 个工具` +
              (r.failed.length > 0 ? `；失败 ${r.failed.length} 个：${r.failed.map((f) => f.id).join(',')}` : ''),
          );
        }
      })
      .catch((err: unknown) => {
        // MCP 整体失败同样是"降级"，不是启动失败
        console.warn('[mcp] 接线失败（已降级）：', err instanceof Error ? err.message : String(err));
      });
  }

  /**
   * ★★ A10 行为采集与周期总结的**接线**（方案 §7 / §5.4）。
   *
   * 核查代码发现的事实（改造前）：`Scheduler.register` 生产代码 **0 调用**、
   * `buildTasks` **0 调用方**、`ActivityObserver` **从未实例化** ——
   * 也就是定时任务与行为观察在运行时**完全是空的**。
   *
   * ⚠️ 三条纪律（都写进了 `activity/runtime.ts`）：
   *   ① **同意开关默认关闭**（`BEHAVIOR_OBSERVATION_ENABLED`，env 默认 false）
   *      —— 不"帮你打开"，方案 §7 要求显式同意
   *   ② 没有前台采样数据源时**如实报"没有数据源"**，不编造应用名
   *   ③ 定时循环用 `globalThis` 单例 + `unref()`，避免热重载重复注册、避免挂住进程
   */
  /**
   * 旧的整机行为观察已停止采样。
   *
   * - 不再读取 `BEHAVIOR_OBSERVATION_ENABLED`，也不再把桌面桥接成采样源；
   * - 观察器仍保留给周复盘读取历史事件，但没有 source，不会再产生新记录；
   * - 使用习惯改由独立的 `/api/usage` 记录本程序页面节奏。
   */
  const activityObserver = new ActivityObserver(bootstrapped.log, clock, DEFAULT_USER_ID, DEFAULT_CONSENT);

  const activityRuntime = createActivityRuntime({
    log: bootstrapped.log,
    clock,
    store: bootstrapped.memory,
    userId: DEFAULT_USER_ID,
    observer: activityObserver,
    sessionCount: () => bootstrapped.chat.listSessions().length,
    evolve: () => evolution.runPass(),
    merge: () => {
      const outcomes = mergeAll({
        log: bootstrapped.log,
        store: bootstrapped.memory,
        clock,
      });
      return {
        merged: outcomes.length,
        absorbed: outcomes.reduce((n, o) => n + (o.absorbedIds?.length ?? 0), 0),
      };
    },
    /**
     * ★★ 定时反思接线（A10 的"周期总结"）。
     *
     * 没有模型时**不接** —— 那样每日/周任务会如实返回「未接入反思引擎」，
     * 而不是假装跑过（聚合任务不需要模型，照常工作）。
     */
    reflect: (a: { readonly scope: 'daily' | 'weekly'; readonly temporalPatterns?: readonly string[] }) => {
      // 周复盘已切到日记材料：只汇总，不新增候选。
      if (a.scope === 'weekly') {
        return Promise.resolve(weeklyDiaryDigest({ diary, clock }));
      }
      const memory = memoryModel;
      if (memory === null) {
        return Promise.resolve({
          candidateCount: 0,
          summary: '记忆模型未配置，跳过定时反思；请先在设置中选择记忆模型。',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }
      return reflectScheduled({
        scope: a.scope,
        model: memory,
        log: bootstrapped.log,
        clock,
        store: bootstrapped.memory,
        chat: bootstrapped.chat,
        userId: DEFAULT_USER_ID,
        ...(a.temporalPatterns !== undefined ? { temporalPatterns: a.temporalPatterns } : {}),
      });
    },
    ...(memoryModel !== null
      ? {
          diary: async () => {
            const result = await runDailyDiaries({
              model: memoryModel as ModelPort,
              log: bootstrapped.log,
              clock,
              chat: bootstrapped.chat,
              diary,
              memory: bootstrapped.memory,
              reviewConflicts: true,
            });
            return {
              created: result.created,
              skipped: result.skipped,
              failed: result.failed,
              summary: diarySummary(result),
              usage: result.usage,
            };
          },
        }
      : {}),
  });
  startActivityLoop({
    runtime: activityRuntime,
    onError: (err) => {
      // 定时循环里的异常必须吞掉，只记日志 —— 否则会变成未捕获异常崩进程
      console.warn('[activity] 定时任务异常：', err instanceof Error ? err.message : String(err));
    },
  });

  // ── 用户自建任务：提醒只做视图，工作由这里真正执行 ──
  async function runUserWorkTask(task: UserTask): Promise<WorkTaskResult> {
    const workspace = await assertWorkspaceDirectory(task.workspace);
    const policy = new TaskPermissionPolicy(task.permission);
    const taskFs = new NodeFileSystem({
      root: workspace,
      // 定时任务删文件同样进回收站
      trashDir: join(DATA_DIR, 'trash'),
      // 完整权限由用户任务显式选择；工作区权限仍保护程序内部数据目录
      protectedPaths: task.permission === 'full'
        ? []
        : [DATA_DIR, join(APP_ROOT, '.env.local'), join(APP_ROOT, 'config')],
    });
    const taskTools = new ToolFramework({
      log: bootstrapped.log,
      clock,
      policy,
      fuse: {
        windowMs: limitsConfig.toolFuseWindowMs,
        maxWrites: limitsConfig.toolFuseMaxWrites,
      },
      ...(task.permission === 'workspace'
        ? { pathGuard: workspacePathGuard(workspace) }
        : {}),
    });
    taskTools.registerAll(fileTools(taskFs));
    taskTools.register(execTool(new NodeExec({ cwdRoot: workspace }), workspace));
    taskTools.register(documentSearchTool({
      search: async (query, limit) => (await getKnowledgeService().search(query, limit)).hits,
    }));
    // 复制桌面 / MCP 等非文件工具；文件工具使用任务自己的工作区根目录。
    for (const spec of tools.list()) {
      if (taskTools.get(spec.name) === undefined) taskTools.register(spec);
    }

    let workModel: ModelPort | null = model;
    if (task.model !== null) {
      const resolved = await resolveProfileModel(
        DATA_DIR,
        task.model.profileId,
        task.model.modelId,
        'chat',
      );
      if (resolved === null) throw new Error('定时任务选择的模型不可用');
      workModel = buildRoleModel(resolved);
    }
    if (workModel === null) throw new Error('未配置模型，定时工作无法执行');

    const session = bootstrapped.chat.createSession();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      const fileHint = task.files.length > 0
        ? `\n参考文件：\n${task.files.map((file) => `- ${file}`).join('\n')}`
        : '';
      const result = await runTurn({
        sessionId: session.id,
        userText:
          `【定时工作】${task.title}\n\n` +
          `工作区：${workspace}\n权限：${task.permission}\n\n` +
          `${task.instruction ?? ''}${fileHint}`,
        userId: DEFAULT_USER_ID,
        random,
        model: workModel,
        log: bootstrapped.log,
        clock,
        store: bootstrapped.memory,
        evolution,
        semantic,
        chat: bootstrapped.chat,
        tools: taskTools,
        supervisionMode: 'manual',
        reflectionMode: 'dailyDiary',
        memoryMode: 'on',
        signal: controller.signal,
      });
      return {
        outcome: 'succeeded',
        summary: result.replyText.trim().slice(0, 4000) || '任务执行完成',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  const userTasks = new UserTaskService(DATA_DIR, clock, runUserWorkTask, bootstrapped.log);
  startUserTaskLoop({
    service: userTasks,
    onError: (err) => {
      console.warn('[user-task] 执行异常：', err instanceof Error ? err.message : String(err));
    },
  });

  return {
    permissionPolicy,
    setPermissionMode: async (mode) => {
      permissionPolicy.setMode(mode);
      await savePermissionSettings(DATA_DIR, {
        mode,
        confirmActions: permissionPolicy.confirmActions,
      });
    },
    setPermissionSettings: async (settings) => {
      if (settings.mode !== undefined) permissionPolicy.setMode(settings.mode);
      if (settings.confirmActions !== undefined) {
        permissionPolicy.setConfirmActions(settings.confirmActions);
      }
      await savePermissionSettings(DATA_DIR, {
        mode: permissionPolicy.mode,
        confirmActions: permissionPolicy.confirmActions,
      });
    },
    bootstrapped,
    clock,
    random,
    dataDir: DATA_DIR,
    appRoot: APP_ROOT,
    memoryArchive: new JsonlMemoryArchive({ dataDir: DATA_DIR }),
    trash: new TrashStore(join(DATA_DIR, 'trash')),
    workspaceRoot: WORKSPACE_ROOT,
    model,
    memoryModel,
    rerankModel,
    rerankScorer,
    streamModel,
    translator,
    tools,
    startedAt: clock.now(),
    restoreSummary: renderRestoreSummary(bootstrapped),
    sessionId,
    activeTurns: 0,
    evolution,
    semantic,
    diary,
    activityObserver,
    activityRuntime,
    userTasks,
    mcpConfigPath,
  };
}

// ═══════════════════════════════════════════════════════════
// 便捷取用
// ═══════════════════════════════════════════════════════════

/** 取记忆仓储（最常用）。 */
export async function getMemoryStore() {
  const rt = await getRuntime();
  return rt.bootstrapped.memory;
}

/** 是否已配置模型。 */
export async function hasModel(): Promise<boolean> {
  const rt = await getRuntime();
  return rt.model !== null;
}

/**
 * 进程退出前刷盘。
 *
 * ⚠️ 在 Next.js 里挂进程钩子不可靠（它可能自己管理生命周期），
 *    所以 `JsonlEventStore` 用**定时刷盘 + 缓冲**兜底：
 *    即使没有优雅退出，最多丢最后几百毫秒的事件。
 */
export async function flush(): Promise<void> {
  const rt = await getRuntime();
  await rt.bootstrapped.log.flushPersistence();
}
