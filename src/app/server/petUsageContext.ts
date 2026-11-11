/**
 * 桌宠专用的使用节奏上下文。
 *
 * 只注入桌宠会话，不进入普通任务对话。
 * 只给时段、会话长度和页面偏好；不给任务、工具、消息或记忆内容。
 */

import { aggregateUsage } from '@/core/usage/aggregate.js';
import { loadUsagePings, loadUsageSettings } from './usageStore.js';

/** 构造给桌宠模型的短上下文；数据不足时返回空串。 */
export async function buildPetUsageContext(now = Date.now()): Promise<string> {
  const [pings, settings] = await Promise.all([loadUsagePings(), loadUsageSettings()]);
  if (!settings.enabled) return '';

  const snapshot = aggregateUsage(pings, { now, days: 14, enabled: true });
  if (snapshot.activeDays < 3) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## 桌宠使用节奏（仅用于陪聊的时机与语气，不是任务内容）');
  if (snapshot.habits.length > 0) {
    for (const habit of snapshot.habits.slice(0, 3)) {
      lines.push(`- ${habit.text}（观察 ${habit.observedDays} 天）`);
    }
  }
  if (snapshot.avgSessionMinutes > 0 && snapshot.sessionCount >= 3) {
    lines.push(`- 单次使用通常约 ${snapshot.avgSessionMinutes} 分钟`);
  }
  lines.push(
    '这些只是本地使用节奏，不要主动复述统计数字，也不要把它当成用户的任务内容或健康结论。',
  );
  return lines.join('\n');
}
