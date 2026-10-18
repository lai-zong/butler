/**
 * `/overview` —— 概览
 *
 * ★ 回答"它现在知道什么、学到了什么"，顺序刻意如此：
 *   先给数字（一眼看到）→ 再给结论（原则有没有用）→ 最后给细节（领域/规律/操作/外部工具）
 *
 * ⚠️ 数字都来自 `buildOverview`，页面**不做二次计算** ——
 *    否则同一件事在两个地方算出两个值，是"界面与事实不一致"的根源。
 */

import { toMemoryCard, autonomousIdsOf, buildOverview } from '@/app/server/view.js';
import {
  Badge,
  Bars,
  Empty,
  KV,
  Page,
  Section,
  Stat,
  clockText,
  humanDuration,
} from '@/app/ui/primitives.js';
import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';

export default async function OverviewPage(): Promise<React.ReactElement> {
  const rt = await getRuntime();
  const view = buildOverview(rt.bootstrapped, {
    model: rt.model !== null ? rt.model.describe().model : null,
  });

  const autonomous = autonomousIdsOf(rt.bootstrapped);
  const topPrinciples = rt.bootstrapped.memory
    .all()
    .filter((m) => m.kind === 'principle')
    .map((m) => toMemoryCard(m, autonomous))
    .sort((a, b) => (b.effectiveness?.applied ?? 0) - (a.effectiveness?.applied ?? 0))
    .slice(0, 5);

  const kindBar = Object.entries(view.memory.byKind).map(([k, n]) => ({
    label: kindName(k),
    value: n,
    text: String(n),
  }));
  const maxDomain = Math.max(1, ...view.domains.map((d) => d.memories));

  return (
    <Page
      title="概览"
      desc="它记得你多少、学到了什么、这些经验有没有用。数字都来自事件重放，不是估算。"
    >
      {view.resume.resumed && (
        <div className="note" style={{ marginBottom: 24 }}>
          已从历史恢复：{view.resume.historicalEvents} 条事件 · 记忆{' '}
          {view.resume.restored.memories} 条 · 产出物 {view.resume.restored.artifacts} 个
          {view.resume.issues > 0
            ? ` · ${view.resume.issues} 条数据问题（已跳过并记录）`
            : ''}
        </div>
      )}

      <div className="stats" style={{ marginBottom: 40 }}>
        <Stat
          k="记忆总数"
          v={view.memory.total}
          u={`${view.memory.byLifecycle['active'] ?? 0} 条正在使用`}
        />
        <Stat
          k="待你审核"
          v={view.memory.pendingReview}
          u={view.memory.pendingReview > 0 ? '去「记忆」处理' : '没有待办'}
        />
        <Stat k="原则生效" v={view.principles.active} u={`累计应用 ${view.principles.applied} 次`} />
        <Stat k="行为规律" v={view.patterns.total} u={`观察 ${view.patterns.observedDays} 天`} />
      </div>

      <Section title="它学到的东西有用吗" hint="原则被用了几次、成了几次">
        {view.principles.total === 0 ? (
          <Empty>还没有提炼出原则。做过几次任务之后，复盘会产出候选。</Empty>
        ) : (
          <div className="stack-lg">
            <div className="card card-pad">
              <KV
                rows={[
                  ['原则总数', `${view.principles.total} 条（生效 ${view.principles.active} 条）`],
                  ['被应用过', `${view.principles.everApplied} 条`],
                  ['应用次数', `${view.principles.applied} 次`],
                  ['成功率', `${view.principles.avgSuccessPercent}%`],
                ]}
              />
            </div>
            {topPrinciples.length > 0 && (
              <div className="rows">
                {topPrinciples.map((p) => (
                  <div className="item" key={p.id}>
                    <div className="body">{p.content}</div>
                    <div className="meta">
                      <Badge tone={p.lifecycle === 'active' ? 'ok' : undefined}>
                        {p.lifecycleLabel}
                      </Badge>
                      {p.effectiveness !== undefined ? (
                        <span>
                          应用 {p.effectiveness.applied} 次 · 成功 {p.effectiveness.succeeded} 次（
                          {p.effectiveness.successPercent}%）
                        </span>
                      ) : (
                        <span>还没被应用过</span>
                      )}
                      {p.autonomous && <span>系统自主生效</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="它在哪些方面了解你" count={view.domains.length}>
        {view.domains.length === 0 ? (
          <Empty>还没有按领域归类的内容。</Empty>
        ) : (
          <div className="card card-pad">
            <div className="bars">
              {view.domains.map((d) => (
                <div className="line" key={d.id}>
                  <span className="label">{d.name}</span>
                  <span className="bar">
                    <i style={{ width: `${Math.round((d.memories / maxDomain) * 100)}%` }} />
                  </span>
                  <span className="num">{d.memories}</span>
                </div>
              ))}
            </div>
            {kindBar.length > 0 && (
              <>
                <div className="dim tiny" style={{ margin: '20px 0 10px' }}>
                  按类型
                </div>
                <Bars items={kindBar} />
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="它观察到的生活节奏" count={view.patterns.total} hint="样本不足时不会产出规律">
        {view.patterns.list.length === 0 ? (
          <Empty>
            还没有足够的数据（需要连续观察若干天）。行为观察默认关闭，可在「设置」里开启。
          </Empty>
        ) : (
          <div className="rows">
            {view.patterns.list.map((p) => (
              <div className="item" key={p.id}>
                <div className="body">{p.pattern}</div>
                <div className="meta">
                  <span>{p.kindLabel}</span>
                  <span>{p.appliesToLabel}</span>
                  <span>把握 {p.confidencePercent}%</span>
                  <span>观察 {p.observedDays} 天</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="它记住的操作方法" count={view.operations.length} hint="同一任务下次该走哪条路">
        {view.operations.length === 0 ? (
          <Empty>还没有桌面/接口类操作记录。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>路径</th>
                <th>成功 / 尝试</th>
                <th>平均耗时</th>
                <th>最近失败</th>
              </tr>
            </thead>
            <tbody>
              {view.operations.map((o) => (
                <tr key={o.id}>
                  <td>{o.task}</td>
                  <td className="dim">{o.pathLabel}</td>
                  <td>
                    {o.succeeded}/{o.attempts}
                    <span className="dim tiny">（{o.successPercent}%）</span>
                  </td>
                  <td className="dim">{humanDuration(o.avgDurationMs)}</td>
                  <td className="dim tiny">{o.lastFailure ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="外部工具（MCP）" count={view.mcp.length}>
        {view.mcp.length === 0 ? (
          <Empty>
            还没有接入外部 MCP 服务器。在项目根目录放 <code>mcp.json</code> 后重启即可接入。
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>传输</th>
                <th>状态</th>
                <th>工具数</th>
                <th>权限</th>
              </tr>
            </thead>
            <tbody>
              {view.mcp.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="dim">{m.transport}</td>
                  <td>
                    <Badge tone={m.stateLabel.includes('已连接') ? 'ok' : undefined}>
                      {m.stateLabel}
                    </Badge>
                  </td>
                  <td>{m.toolCount}</td>
                  <td className="dim">{m.policyLevel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="定时任务" count={view.schedule.length}>
        {view.schedule.length === 0 ? (
          <Empty>定时任务还没注册（首次启动后会自动注册）。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>上次运行</th>
                <th>结果</th>
                <th>总次数</th>
                <th>失败</th>
              </tr>
            </thead>
            <tbody>
              {view.schedule.map((s) => (
                <tr key={s.kind}>
                  <td>
                    {s.label}
                    {s.costsTokens && <span className="dim tiny"> · 耗 token</span>}
                  </td>
                  <td className="dim">{s.lastRunAt > 0 ? clockText(s.lastRunAt) : '还没跑过'}</td>
                  <td className="dim">{s.lastOutcome ?? '—'}</td>
                  <td>{s.totalRuns}</td>
                  <td className={s.failedRuns > 0 ? undefined : 'dim'}>{s.failedRuns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="系统状态">
        <div className="card card-pad">
          <KV
            rows={[
              ['模型', view.model.configured ? <code key="m">{view.model.name ?? '—'}</code> : '未配置'],
              [
                '产出物',
                view.artifacts.length === 0
                  ? '暂无'
                  : `${view.artifacts.length} 个（最新：${view.artifacts[0]?.label ?? '—'} v${String(
                      view.artifacts[0]?.currentVersion ?? 0,
                    )}）`,
              ],
              ['检查点', `${view.checkpoints} 个`],
              ['系统自主生效的记忆', `${view.memory.autonomous} 条`],
            ]}
          />
        </div>
      </Section>
    </Page>
  );
}

function kindName(k: string): string {
  return (
    ({ fact: '事实', preference: '偏好', principle: '原则', summary: '长期总结' } as Record<
      string,
      string
    >)[k] ?? k
  );
}
