/**
 * 桌宠主动说话领取。
 *
 * 由桌宠前端轮询；服务端用确定性策略决定能不能说，并记录本次领取。
 * 返回的 text 是平稳兜底句，人格如何改写这句话由桌宠自己处理。
 */

import { NextResponse } from 'next/server';

import { decideProactive, type ProactiveUsage } from '@/core/pet/proactive.js';
import { loadPetConfig, resolveDataDir } from '@/app/server/petConfig.js';
import { withPetProactiveLock } from '@/app/server/petProactiveLock.js';
import { loadPetProactiveState, savePetProactiveState } from '@/app/server/petProactiveState.js';
import { getPetSession } from '@/app/server/petSession.js';
import { loadUsagePings } from '@/app/server/usageStore.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SESSION_GAP_MS = 10 * 60 * 1000;
const ACTIVE_STALE_MS = 15 * 60 * 1000;

function currentUsage(pings: readonly { at: number; active: boolean }[], now: number): ProactiveUsage {
  const active = pings
    .filter((p) => p.active && p.at <= now)
    .slice()
    .sort((a, b) => a.at - b.at);
  const latest = active[active.length - 1];
  if (latest === undefined) {
    return { sessionMinutes: 0, lastActiveAt: null, previousActiveAt: null };
  }
  if (now - latest.at > ACTIVE_STALE_MS) {
    return { sessionMinutes: 0, lastActiveAt: latest.at, previousActiveAt: null };
  }

  let start = active.length - 1;
  while (start > 0) {
    const previous = active[start - 1];
    const current = active[start];
    if (previous === undefined || current === undefined) break;
    if (current.at - previous.at > SESSION_GAP_MS) break;
    start -= 1;
  }
  const first = active[start];
  const before = start > 0 ? active[start - 1] : undefined;
  return {
    sessionMinutes: first === undefined ? 0 : Math.max(0, (now - first.at) / 60_000),
    lastActiveAt: latest.at,
    previousActiveAt: before?.at ?? null,
  };
}

async function claim(): Promise<NextResponse> {
  const now = Date.now();
  const [config, pings, state] = await Promise.all([
    loadPetConfig(),
    loadUsagePings(resolveDataDir()),
    loadPetProactiveState(),
  ]);

  const decision = decideProactive({
    now,
    config: {
      enabled: config.proactiveEnabled,
      frequency: config.proactiveFrequency,
      quietStart: config.quietStart,
      quietEnd: config.quietEnd,
      scenarios: config.proactiveScenarios,
    },
    usage: currentUsage(pings, now),
    history: state.history,
    suppressedUntil: state.suppressedUntil,
  });

  if (!decision.speak || decision.trigger === undefined || decision.text === undefined) {
    return NextResponse.json({
      ok: true,
      shouldSpeak: false,
      reason: decision.reason,
    });
  }

  // 先写入桌宠会话，再记录“已经说过”。
  // 写入失败则本次不领取，宁可下一轮重试，也不让气泡成为无上下文的漂浮通知。
  const petSession = await getPetSession();
  petSession.chat.appendMessage(petSession.sessionId, {
    role: 'butler',
    text: decision.text,
  });

  await savePetProactiveState({
    history: [
      ...state.history,
      { at: now, trigger: decision.trigger },
    ].slice(-50),
    suppressedUntil: state.suppressedUntil,
  });

  return NextResponse.json({
    ok: true,
    shouldSpeak: true,
    trigger: decision.trigger,
    text: decision.text,
    cooldownUntil: decision.cooldownUntil ?? null,
  });
}

export async function POST(): Promise<NextResponse> {
  return withPetProactiveLock(claim);
}
