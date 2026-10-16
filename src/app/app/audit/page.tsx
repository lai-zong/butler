/**
 * `/app/audit` —— 审计
 *
 * ★★ 这一页回答：**「它凭什么这么说？」**
 *
 *   一次对话的完整链条：
 *     读到了什么（召回的记忆）→ 给仆人交代了什么（注入的约束）
 *     → 用到了哪些记忆（引用）→ 管家的判定
 *
 * ★ 用户要"深挖"时才来，所以这里**可以密一点** ——
 *   但依然守一行一信息的规矩，不做卡片。
 *
 * ⚠️ 与旧版 `/` 的审计区不同：这里按**轮次**分组（一次对话一轮），
 *    而不是把所有事件平铺 —— 平铺出来的时间线用户读不懂"哪段属于哪次提问"。
 *
 * ⚠️ 术语同样翻人话：
 *    `constraint.injected` → 「告诉它这条」
 *    `memory.recalled` → 「想起了这条」
 */

import { getRuntime } from '../../runtime.js';
import { Shell } from '../shell.js';
import { Row, Tag } from '../ui.js';

export const dynamic = 'force-dynamic';

/**
 * 一轮的审计内容。
 *
 * ⚠️ 累积期间要**可变** —— 事件是流式来的，逐个往里加。
 *    但对外暴露的形状仍是只读的（uildTurns 返回后不再改）。
 */
interface Turn {
  seq: number;
  at: number;
  recalled: { content: string; kind: string }[];
  injected: { content: string; servant: string }[];
  toolCalls: { name: string; ok: boolean }[];
  blocked: string | null;
}

export default async function AuditPage() {
  const rt = await getRuntime();
  const log = rt.bootstrapped.log;
  const events = log.all();

  const turns = buildTurns(events);

  return (
    <Shell>
      <div className="nv-scroll">
        <div className="nv-scroll-inner nv-col">
          <div style={{ marginBottom: 'var(--n-sp-4)' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>结论的依据</div>
            <div
              style={{
                marginTop: 2,
                fontSize: 'var(--n-fs-cap)',
                color: 'var(--n-text-faint)',
              }}
            >
              共 {turns.length} 轮对话 · {events.length} 条记录
            </div>
          </div>

          {turns.length === 0 && (
            <div className="nv-empty">
              <div className="nv-empty-title">还没有可查的记录</div>
              <div className="nv-empty-sub">
                先跟它聊一句。之后每次结论用到了什么、依据是什么，都会记在这里。
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <TurnBlock key={t.seq} turn={t} index={turns.length - i} />
          ))}
        </div>
      </div>
    </Shell>
  );
}

function TurnBlock({ turn, index }: { readonly turn: Turn; readonly index: number }) {
  const has =
    turn.recalled.length > 0 ||
    turn.injected.length > 0 ||
    turn.toolCalls.length > 0 ||
    turn.blocked !== null;

  return (
    <section style={{ marginBottom: 'var(--n-sp-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--n-sp-2)',
          height: 'var(--n-row)',
          borderTop: '0.5px solid var(--n-border)',
        }}
      >
        <span style={{ fontSize: 'var(--n-fs-sub)', fontWeight: 600 }}>
          第 {index} 轮
        </span>
        <span className="nv-mono" style={{ color: 'var(--n-text-faint)' }}>
          {new Date(turn.at).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        {turn.blocked !== null && <Tag tone="danger">被拦下</Tag>}
      </div>

      {!has && (
        <Row caret=" " label={<span style={{ color: 'var(--n-text-faint)' }}>这一轮没有用到记忆</span>} />
      )}

      {turn.recalled.length > 0 && (
        <Group title="想起了这些" count={turn.recalled.length}>
          {turn.recalled.map((r, i) => (
            <Row
              key={i}
              caret=" "
              label={r.content}
              {...(r.kind === 'global_constraint'
                ? { leading: <Tag tone="danger">硬性要求</Tag> }
                : {})}
            />
          ))}
        </Group>
      )}

      {turn.injected.length > 0 && (
        <Group title="告诉它这些" count={turn.injected.length}>
          {turn.injected.map((r, i) => (
            <Row
              key={i}
              caret=" "
              leading={<Tag>{r.servant}</Tag>}
              label={r.content}
            />
          ))}
        </Group>
      )}

      {turn.toolCalls.length > 0 && (
        <Group title="它做的操作" count={turn.toolCalls.length}>
          {turn.toolCalls.map((t, i) => (
            <Row
              key={i}
              caret=" "
              leading={
                <span
                  className={`nv-dot nv-dot-${t.ok ? 'ok' : 'fail'}`}
                  aria-hidden
                />
              }
              label={t.name}
              tail={t.ok ? undefined : <Tag tone="warn">失败</Tag>}
            />
          ))}
        </Group>
      )}

      {turn.blocked !== null && (
        <Row
          caret=" "
          leading={<Tag tone="danger">拦下</Tag>}
          label={turn.blocked}
        />
      )}
    </section>
  );
}

function Group({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 'var(--n-sp-1)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--n-sp-2)',
          fontSize: 'var(--n-fs-cap)',
          color: 'var(--n-text-mute)',
        }}
      >
        {title}
        <span className="nv-mono" style={{ color: 'var(--n-text-faint)' }}>
          {count}
        </span>
      </div>
      <div className="nv-sub">{children}</div>
    </div>
  );
}

/**
 * 把事件流按**轮次**切块。
 *
 * ⚠️ 切分依据是 `session.message`（用户发言）——
 *    它是一条轮次的起点。用它而不是"每个 route.decided"，
 *    因为一次用户发言可能触发多次路由（打回重做）。
 */
function buildTurns(
  events: readonly { readonly type: string; readonly seq: number; readonly createdAt: number; readonly payload: unknown }[],
): Turn[] {
  const out: Turn[] = [];
  let cur: Turn | null = null;

  const p = (e: { readonly payload: unknown }): Record<string, unknown> =>
    typeof e.payload === 'object' && e.payload !== null
      ? (e.payload as Record<string, unknown>)
      : {};

  for (const e of events) {
    if (e.type === 'session.message' && p(e)['role'] === 'user') {
      if (cur !== null) out.push(cur);
      cur = {
        seq: e.seq,
        at: e.createdAt,
        recalled: [],
        injected: [],
        toolCalls: [],
        blocked: null,
      };
      continue;
    }
    if (cur === null) continue;

    const d = p(e);
    if (e.type === 'memory.recalled') {
      const content = d['content'];
      if (typeof content === 'string' && content.length > 0) {
        cur.recalled.push({
          content,
          kind: typeof d['memClass'] === 'string' ? d['memClass'] : '',
        });
      }
    } else if (e.type === 'constraint.injected') {
      const content = d['content'];
      if (typeof content === 'string' && content.length > 0) {
        cur.injected.push({
          content,
          servant: typeof d['servant'] === 'string' ? d['servant'] : '',
        });
      }
    } else if (e.type === 'tool.call') {
      cur.toolCalls.push({
        name: typeof d['toolName'] === 'string' ? d['toolName'] : '',
        ok: true,
      });
    } else if (e.type === 'tool.result') {
      const ok = d['ok'];
      const last = cur.toolCalls[cur.toolCalls.length - 1];
      if (last !== undefined && ok === false) {
        cur.toolCalls[cur.toolCalls.length - 1] = { name: last.name, ok: false };
      }
    } else if (e.type === 'constraint.hardBlocked') {
      const unhandled = d['unhandledBy'];
      if (Array.isArray(unhandled) && unhandled.length > 0) {
        cur.blocked = `硬性要求没有被这些步骤覆盖：${unhandled.join('、')}`;
      }
    }
  }

  if (cur !== null) out.push(cur);
  return out.reverse();
}
