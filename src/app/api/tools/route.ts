/**
 * 工具分级矩阵 —— 只读数据源（方案 § 10.3 / § 9.4）
 *
 * GET /api/tools
 *   → { ok, mode, enabledTiers, tools: [...] }
 *
 * ★ 为什么需要它：
 *   方案要求"每条工具落在哪一级"必须让用户看见。当前设置页只显示
 *   C5 三档模式，看不到具体工具，也看不到 rung（执行手段）。
 *   这个端点把 `ToolFramework.list()` 的 tier / rung / 凭证标记
 *   如实暴露给界面，不写入、不改策略。
 *
 * ★ 为什么不在这里改 tier：
 *   tier 是工具定义的一部分，不是用户偏好；让界面改它会让
 *   "工具能做什么"和"用户允许什么"混为一谈。授权仍由
 *   `PermissionPolicy.isTierEnabled()` 在核心层判定。
 */

import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { MCP_TOOL_PREFIX } from '@/core/mcp/types.js';
import type { ActionTier } from '@/core/tools/types.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIER_ORDER: readonly ActionTier[] = ['readOnly', 'normal', 'highRisk', 'dangerous'];

function tierIndex(tier: ActionTier): number {
  return TIER_ORDER.indexOf(tier);
}

export async function GET(): Promise<NextResponse> {
  const rt = await getRuntime();

  const tools = rt.tools
    .list()
    .map((t) => ({
      name: t.name,
      description: t.description,
      tier: t.tier,
      rung: t.rung ?? null,
      touchesCredentials: t.touchesCredentials === true,
      actionApp: t.actionApp ?? null,
      source: t.name.startsWith(MCP_TOOL_PREFIX) ? 'mcp' : 'native',
    }))
    .sort((a, b) => tierIndex(a.tier) - tierIndex(b.tier) || a.name.localeCompare(b.name));

  return NextResponse.json({
    ok: true,
    mode: rt.permissionPolicy.mode ?? null,
    enabledTiers: {
      readOnly: rt.permissionPolicy.isTierEnabled('readOnly'),
      normal: rt.permissionPolicy.isTierEnabled('normal'),
      highRisk: rt.permissionPolicy.isTierEnabled('highRisk'),
      dangerous: rt.permissionPolicy.isTierEnabled('dangerous'),
    },
    tools,
  });
}
