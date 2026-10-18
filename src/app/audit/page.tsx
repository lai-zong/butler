/**
 * `/audit` —— 审计
 *
 * ★ 回答：**「它凭什么这么说？」**
 *   一次对话的链条：想起了什么 → 告诉它什么 → 复核结果。
 *
 * ★ 两种看法，按需要选：
 *   ① **按区间查**（输入 from/to seq）→ 一组结构化的"依据"
 *   ② **最近事件**（倒序）→ 原始流水，排障时看
 *
 * ⚠️ 术语翻人话：`memory.recalled` → 「想起了这条」；
 *    `constraint.injected` → 「告诉它这条」。
 */

import { hasAuditContent, readTurnAudit } from '@/core/audit/readAudit.js';

import { Badge, Empty, Page, Section, clockText } from '@/app/ui/primitives.js';
import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 120;

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const sp = await searchParams;
  const fromRaw = typeof sp['from'] === 'string' ? sp['from'] : '';
  const toRaw = typeof sp['to'] === 'string' ? sp['to'] : '';
  const from = Number.parseInt(fromRaw, 10);
  const to = Number.parseInt(toRaw, 10);
  const hasRange = Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from;

  const rt = await getRuntime();
  const log = rt.bootstrapped.log;

  const audit = hasRange ? readTurnAudit(log, { fromSeq: from, toSeq: to }) : null;
  const recent = log.all().slice(-RECENT_LIMIT).reverse();

  return (
    <Page
      title="审计"
      desc="它每次结论的依据都能查：想起了哪些记忆、被告诉了哪些约束、复核是过还是打回。事件流是只追加的，改不了。"
    >
      <Section title="按事件区间查一轮" hint="seq 区间可以从下面的最近事件里看到">
        <form method="get" className="card card-pad">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="field" style={{ width: 160 }}>
              <span className="small muted">起始 seq</span>
              <input className="input" name="from" defaultValue={fromRaw} inputMode="numeric" placeholder="例如 1200" />
            </label>
            <label className="field" style={{ width: 160 }}>
              <span className="small muted">结束 seq</span>
              <input className="input" name="to" defaultValue={toRaw} inputMode="numeric" placeholder="例如 1240" />
            </label>
            <div style={{ alignSelf: 'flex-end', paddingBottom: 2 }}>
              <button type="submit" className="btn">
                查看依据
              </button>
            </div>
          </div>
        </form>

        {audit !== null && (
          <div className="stack" style={{ marginTop: 16 }}>
            <div className="note">{audit.summary}</div>

            {!hasAuditContent(audit) ? (
              <Empty>这段区间里没有"依据类"事件（可能是不含执行的轮次）。</Empty>
            ) : (
              <>
                {audit.recalls.length > 0 && (
                  <div className="card card-pad">
                    <div className="small muted" style={{ marginBottom: 10 }}>
                      想起了这些（{audit.recalls.reduce((n, r) => n + r.count, 0)} 条）
                    </div>
                    <div className="stack">
                      {audit.recalls.flatMap((r) =>
                        r.items.map((it) => (
                          <div key={`${String(r.seq)}_${it.memoryId}`} className="row" style={{ alignItems: 'flex-start' }}>
                            <Badge>{it.memClassLabel}</Badge>
                            <span className="small" style={{ flex: 1 }}>
                              {it.memoryId}
                            </span>
                            <span className="dim tiny">相关度 {Math.round(it.relevance * 100)}%</span>
                          </div>
                        )),
                      )}
                    </div>
                  </div>
                )}

                {audit.injections.length > 0 && (
                  <div className="card card-pad">
                    <div className="small muted" style={{ marginBottom: 10 }}>
                      告诉它这些（{audit.injections.length} 条）
                    </div>
                    <div className="stack">
                      {audit.injections.map((it, i) => (
                        <div key={`${String(it.seq)}_${String(i)}`}>
                          <div className="small">{it.content}</div>
                          <div className="dim tiny">
                            {it.domainLabel} · 来源 {it.source}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {audit.hardChecks.length > 0 && (
                  <div className="card card-pad">
                    <div className="small muted" style={{ marginBottom: 10 }}>
                      硬约束检查（{audit.hardChecks.length} 条）
                    </div>
                    <div className="stack">
                      {audit.hardChecks.map((h, i) => (
                        <div key={`${String(h.seq)}_${String(i)}`} className="row" style={{ alignItems: 'flex-start' }}>
                          <Badge tone={h.outcome === 'blocked' ? 'danger' : 'ok'}>
                            {h.outcome === 'blocked' ? '拦住了' : '通过'}
                          </Badge>
                          <span className="small" style={{ flex: 1 }}>
                            {h.content}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {audit.writeAttempts.length > 0 && (
                  <div className="card card-pad">
                    <div className="small muted" style={{ marginBottom: 10 }}>
                      写入尝试（{audit.writeAttempts.length} 条）
                    </div>
                    <div className="stack">
                      {audit.writeAttempts.map((w, i) => (
                        <div key={`${String(w.seq)}_${String(i)}`} className="row">
                          <Badge tone={w.rejected ? 'danger' : 'ok'}>
                            {w.rejected ? '被拒' : '允许'}
                          </Badge>
                          <span className="small">
                            {w.actor} → {w.memoryId}
                          </span>
                          {w.reason.length > 0 && <span className="dim tiny">{w.reason}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="最近事件" count={recent.length} hint={`最近 ${RECENT_LIMIT} 条，倒序`}>
        {recent.length === 0 ? (
          <Empty>还没有任何事件。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>seq</th>
                <th style={{ width: 130 }}>时间</th>
                <th style={{ width: 220 }}>类型</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={`${String(e.seq)}_${e.id}`}>
                  <td className="mono dim">{e.seq}</td>
                  <td className="dim tiny">{clockText(e.createdAt)}</td>
                  <td>
                    <code className="tiny">{e.type}</code>
                  </td>
                  <td className="dim tiny" style={{ wordBreak: 'break-word' }}>
                    {summarize(e.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Page>
  );
}

/** 把 payload 压成一行摘要（只取标量，不展开嵌套）*/
function summarize(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}[${String(v.length)}]`);
    }
    if (parts.length >= 5) break;
  }
  return parts.join(' · ');
}
