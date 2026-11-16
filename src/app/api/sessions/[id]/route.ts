/**
 * 单个会话的完整快照与设置编辑
 *
 * `GET   /api/sessions/[id]` → 会话 + 消息 + 复核结论 + 练习 + **完整设置**
 * `PATCH /api/sessions/[id]` → 更新 persona / reasoning / memoryMode /
 *                              workspace / permission / 模型
 *
 * ★ 为什么不复用 `/api/chat` 的流式数据：
 *   流式只覆盖“这一次”，刷新后要能看到历史 —— 必须从事件重放出的
 *   SessionStore 读。两条路径最终读的是同一份状态。
 *
 * ⚠️ 这里的消息已包含 `agentTrace` / `servantReports`（持久化形状），
 *   界面据此在刷新后仍能展开“它当时调了什么工具”。
 *
 * ★ 设置更新的语义：
 *   · 只影响**下一轮**（当前轮已持有 TurnSettings 快照）
 *   · `persona` 正文写 sidecar（事件只记 hash/长度）
 *   · `reasoning` / `memoryMode` / `workspace` / `permission` 由
 *     `session.settings` 事件重放
 *   · `workspace` 在写状态前做真实磁盘校验（绝对/存在/目录/realpath/非受保护）
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import {
  toMessageDto,
  toSessionDetailDto,
  toVerdictDto,
} from '@/app/server/uiData.js';
import { toSessionCancellations } from '@/app/server/cancellations.js';
import { readQuizzes } from '@/core/quiz/read.js';
import { normalizePersona } from '@/core/chat/settings.js';
import { parseSessionSettingsPatch } from '@/app/server/sessionSettingsApi.js';
import { saveSessionPersona } from '@/app/server/sessionSettingsStore.js';
import { loadSessionSkills, saveSessionSkills } from '@/app/server/sessionSkills.js';
import { loadSkillStore } from '@/app/server/skills.js';
import { resolveProfileModel } from '@/app/server/modelProfiles.js';
import { assertSessionWorkspace } from '@/app/server/sessionWorkspace.js';
import { appRootOf, dataDirOf, scopeDefaultsOf } from '@/app/server/sessionScope.js';
import { readSessionDisplay } from '@/app/server/sessionDisplayStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);

  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const messages = chat.messagesOf(id);
  const verdicts = chat.verdictsOf(id);
  const reviews = chat.reviewRunsOf(id);
  const quizzes = readQuizzes(rt.bootstrapped.log, id);
  const display = await readSessionDisplay(dataDirOf(rt), id);
  const skills = await loadSessionSkills(dataDirOf(rt), id);

  return NextResponse.json({
    ok: true,
    skills,
    // 详情接口带完整人格正文（列表接口只给摘要）
    session: toSessionDetailDto(
      session,
      messages,
      verdicts,
      scopeDefaultsOf(rt),
      display,
    ),
    messages: messages.map(toMessageDto),
    verdicts: verdicts.map(toVerdictDto),
    reviews,
    quizzes,
    cancellations: toSessionCancellations(rt.bootstrapped.log, id),
  });
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const parsed = parseSessionSettingsPatch(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const rt = await getRuntime();
  const chat = rt.bootstrapped.chat;
  const session = chat.getSession(id);
  if (session === undefined) {
    return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
  }

  const patch = parsed.patch;
  const scopeDefaults = scopeDefaultsOf(rt);
  const dir = dataDirOf(rt);

  // 技能启用是会话级 sidecar；只接受技能库中真实存在的 id。
  // ★ 这里只校验，不写入：工作区/模型校验失败时不能留下半套设置。
  let requestedSkills: readonly string[] | undefined;
  if (patch.skills !== undefined) {
    const all = await loadSkillStore(dir);
    const known = new Set(all.map((skill) => skill.id));
    if (patch.skills.some((skillId) => !known.has(skillId))) {
      return NextResponse.json({ error: '包含不存在的技能' }, { status: 400 });
    }
    requestedSkills = patch.skills;
  }

  /**
   * ── 工作区：真实磁盘校验 ──
   *
   * 必须在写状态之前完成：不存在 / 不是目录 / 相对路径 / 受保护目录
   * 直接 400，会话保持原值。通过后存 realpath，后续工具根目录不再二次解析。
   */
  let normalizedWorkspace: string | null | undefined = patch.workspace;
  if (typeof patch.workspace === 'string') {
    try {
      normalizedWorkspace = await assertSessionWorkspace(patch.workspace, {
        dataDir: dir,
        /**
         * ⚠️ 必须是与 chat 路由一致的**应用根**（`process.cwd()`），
         *    不能传默认工作区。传错会让 `config/`、`.env.local` 的受保护判定
         *    变成 `workplace/config`，于是 PATCH 接受 `<repo>/config`（实测 200），
         *    下一轮对话又被 chat 的守卫拒掉 —— 用户看到"设置成功但对话打不开"。
         */
        appRoot: appRootOf(rt),
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  // ── 模型：必须真实存在，且是 chat 类型；缺 Key 也按不可用处理 ──
  if (patch.modelProfileId !== undefined && patch.modelId !== undefined) {
    const resolved = await resolveProfileModel(
      dir,
      patch.modelProfileId,
      patch.modelId,
      'chat',
    );
    if (resolved === null) {
      return NextResponse.json(
        { error: '模型不存在、不可用或缺少 API Key' },
        { status: 400 },
      );
    }
  }

  try {
    // ★ 人格正文先落 sidecar，再改内存/发事件 —— 避免重启后正文丢失。
    if (patch.persona !== undefined) {
      await saveSessionPersona(dir, id, normalizePersona(patch.persona));
    }

    if (patch.modelProfileId !== undefined && patch.modelId !== undefined) {
      const updatedModel = chat.setSessionModel(id, patch.modelProfileId, patch.modelId);
      if (updatedModel === undefined) {
        return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
      }
    }

    const updated = chat.setSessionSettings(id, {
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.memoryMode !== undefined ? { memoryMode: patch.memoryMode } : {}),
      ...(normalizedWorkspace !== undefined ? { workspace: normalizedWorkspace } : {}),
      ...(patch.permission !== undefined ? { permission: patch.permission } : {}),
    });
    if (updated === undefined) {
      return NextResponse.json({ error: '找不到这个会话' }, { status: 404 });
    }

    // ★ 所有校验都通过后才写技能 sidecar，避免 400 后留下部分修改。
    if (requestedSkills !== undefined) {
      await saveSessionSkills(dir, id, requestedSkills);
    }

    // 设置是用户可见的状态变更，尽早落盘。
    await rt.bootstrapped.log.flushPersistence().catch(() => undefined);

    return NextResponse.json({
      ok: true,
      skills: requestedSkills ?? (await loadSessionSkills(dir, id)),
      session: toSessionDetailDto(
        updated,
        chat.messagesOf(id),
        chat.verdictsOf(id),
        scopeDefaults,
      ),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
