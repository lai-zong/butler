/**
 * 总览页 —— 打开就看到"它现在知道什么"
 *
 * 设计依据：方案 § 3.3（成长对比是"最强演示件"）、§ 8.6（演化可观测）
 *
 * ★ 这一页的回答顺序是刻意的：
 *   ① 它记得你多少（数字，一眼看到）
 *   ② 有没有需要你处理的事（待审核）
 *   ③ 它在哪些方面了解你（领域分布）
 *   ④ 它学到的东西有没有用（原则效果）
 *   ⑤ 它的"经验"（记忆化执行 / 行为规律）
 *
 *   ——先给结论，再给细节。这是"管家"该有的汇报方式。
 */

import Link from 'next/link';

import { getRuntime } from '@/app/runtime';
import { Shell } from '@/app/shell';
import { buildOverview } from '@/app/server/view';

export const dynamic = 'force-dynamic';

function Stat({ value, label, tone }: { readonly value: string | number; readonly label: string; readonly tone?: 'warn' | 'ok' }) {
  return (
    <div className="stat">
      <div className="stat-value" style={tone === 'warn' ? { color: 'var(--warn)' } : tone === 'ok' ? { color: 'var(--ok)' } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default async function OverviewPage() {
  const rt = await getRuntime();
  const view = buildOverview(rt.bootstrapped, {
    model: rt.model !== null ? rt.model.describe().model : null,
  });

  const { memory, principles, resume, domains, patterns, operations } = view;

  return (
    <Shell title="总览" subtitle="它现在知道什么，以及它的判断有多少依据">
      {/* ── 启动恢复提示（持久化是否真的生效，用户应当看得见）── */}
      <div className={resume.resumed ? 'notice notice-info' : 'notice notice-info'}>
        <div>
          {resume.resumed ? (
            <>
              已从历史恢复 <b className="mono">{resume.historicalEvents}</b> 条事件 —— 记忆{' '}
              <b className="mono">{resume.restored.memories}</b> 条、产出物{' '}
              <b className="mono">{resume.restored.artifacts}</b> 个、操作记忆{' '}
              <b className="mono">{resume.restored.operationMemories}</b> 条。
              {resume.badLines > 0 && <> 事件文件有 {resume.badLines} 行损坏（已跳过）。</>}
              {resume.issues > 0 && <> {resume.issues} 处信息不足（多为加字段前写入的老事件）。</>}
            </>
          ) : (
            <>首次启动，还没有历史记录。所有的记忆都会随着对话逐步积累，并写入本地事件文件。</>
          )}
          {!view.model.configured && (
            <>
              {' '}
              <b>当前未配置模型</b>（.env.local 里缺 DEEPSEEK_API_KEY），
              记忆治理功能可用，但对话与反思不可用。
            </>
          )}
        </div>
      </div>

      {/* ── ① 核心数字 ── */}
      <h2>它记得你多少</h2>
      <div className="stats">
        <Stat value={memory.total} label="记忆总数" />
        <Stat value={memory.byLifecycle['active'] ?? 0} label="生效中" tone="ok" />
        <Stat
          value={memory.pendingReview}
          label="待你确认"
          {...(memory.pendingReview > 0 ? { tone: 'warn' as const } : {})}
        />
        <Stat value={principles.total} label="原则" />
        <Stat value={memory.autonomous} label="它自己学的" />
        <Stat value={patterns.total} label="生活节奏" />
      </div>

      {memory.pendingReview > 0 && (
        <div className="notice notice-warn" style={{ marginTop: 16 }}>
          <div>
            有 <b className="mono">{memory.pendingReview}</b> 条记忆在等你确认 ——
            它们是 AI 的**推断**而非你的原话，所以没有自动生效。
            <Link href="/memory?filter=candidate" style={{ textDecoration: 'underline', marginLeft: 6 }}>
              去看
            </Link>
          </div>
        </div>
      )}

      {/* ── ② 原则效果：学过的东西有没有用 ── */}
      <h2>它学到的东西有用吗</h2>
      {principles.total === 0 ? (
        <div className="empty">
          还没有提炼出可复用的原则
          <div className="empty-hint">原则来自多次同类任务后的反思，需要先积累一些对话</div>
        </div>
      ) : (
        <>
          <div className="stats">
            <Stat
              value={`${principles.avgSuccessPercent}%`}
              label="平均奏效率"
              {...(principles.avgSuccessPercent >= 70 ? { tone: 'ok' as const } : {})}
            />
            <Stat value={principles.applied} label="累计应用次数" />
            <Stat value={principles.succeeded} label="其中奏效" />
            <Stat value={principles.everApplied} label="被用过的原则" />
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {(await getRuntime()).bootstrapped.memory
              .all()
              .filter((m) => m.kind === 'principle' && m.lifecycle === 'active')
              .sort((a, b) => (b.effectiveness?.applied ?? 0) - (a.effectiveness?.applied ?? 0))
              .slice(0, 5)
              .map((p) => {
                const applied = p.effectiveness?.applied ?? 0;
                const succeeded = p.effectiveness?.succeeded ?? 0;
                const rate = applied === 0 ? null : Math.round((succeeded / applied) * 100);
                return (
                  <div className="row" key={p.id}>
                    <div className="row-main">
                      <div className="row-title">{p.content}</div>
                      <div className="row-meta">
                        <span>适应度 {Math.round(p.fitness * 100)}%</span>
                        {rate !== null && (
                          <>
                            <span>·</span>
                            <span>
                              用 {applied} 次 / 奏效 {succeeded} 次（{rate}%）
                            </span>
                          </>
                        )}
                        {rate === null && (
                          <>
                            <span>·</span>
                            <span>尚未被用到</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* ── ③ 领域分布（v8：原「仆人分布」；「职责边界」列改为「专业纪律」）── */}
      <h2>它在哪些方面了解你</h2>
      <table className="table">
        <thead>
          <tr>
            <th>领域</th>
            <th>专业纪律</th>
            <th style={{ textAlign: 'right' }}>记忆</th>
            <th style={{ textAlign: 'right' }}>原则</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((s) => (
            <tr key={s.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{s.name}</td>
              <td style={{ color: 'var(--text-mute)', fontSize: 12 }}>
                {s.disciplineCount > 0 ? `${s.disciplineCount} 条` : '—'}
              </td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {s.memories}
              </td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {s.principles}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── ④ 记忆化执行：越做越快 ── */}
      {operations.length > 0 && (
        <>
          <h2>它记住的操作方法</h2>
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>走哪条路</th>
                <th style={{ textAlign: 'right' }}>尝试</th>
                <th style={{ textAlign: 'right' }}>成功</th>
                <th style={{ textAlign: 'right' }}>平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((o) => (
                <tr key={o.id}>
                  <td>{o.task}</td>
                  <td>
                    <span className={o.successPercent >= 50 ? 'tag tag-ok' : 'tag tag-warn'}>
                      {o.pathLabel}
                    </span>
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {o.attempts}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {o.succeeded}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {o.avgDurationMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ── ⑤ 生活节奏 ── */}
      {patterns.list.length > 0 && (
        <>
          <h2>它观察到的生活节奏</h2>
          <div className="row-meta" style={{ marginTop: -4, marginBottom: 8 }}>
            基于 <span className="mono">{patterns.observedDays}</span> 天的行为观察
          </div>
          <div className="list">
            {patterns.list.slice(0, 6).map((p) => (
              <div className="row" key={p.id}>
                <div className="row-main">
                  <div className="row-title">{p.pattern}</div>
                  <div className="row-meta">
                    <span className="tag">{p.kindLabel}</span>
                    <span>{p.appliesToLabel}</span>
                    <span>·</span>
                    <span>置信度 {p.confidencePercent}%</span>
                    <span>·</span>
                    <span>观察 {p.observedDays} 天</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
