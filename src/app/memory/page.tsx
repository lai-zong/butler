/**
 * `/memory` —— 记忆库
 *
 * ★ 回答一个问题：**「它记住了我哪些事？」**
 *   一行一条，不做卡片（卡片一屏只能放四五条，而记忆是要扫的）。
 *
 * ★★ 候选在这里**可以处理**：批准生效 / 驳回。
 *   在此之前这一页只读，候选等于"永远排队" —— 治理闭环缺了人类那一半。
 *
 * ⚠️ 术语全部翻成人话：
 *    `candidate` → 「待你确认」；`dormant` → 「暂时不用了」；
 *    `fitness 0.72` → 「比较管用」。数值对大众没有意义，反而像仪表盘。
 */

import Link from 'next/link';

import { autonomousIdsOf, toMemoryCard } from '@/app/server/view.js';
import { Badge, Empty, Page, Section, clockText } from '@/app/ui/primitives.js';
import { ReviewActions } from '@/app/ui/memory-review.js';
import { getRuntime } from '@/app/runtime';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'candidate', label: '待你确认' },
  { key: 'active', label: '生效中' },
  { key: 'dormant', label: '暂时不用' },
  { key: 'archived', label: '已归档' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

export default async function MemoryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const sp = await searchParams;
  const raw = typeof sp['filter'] === 'string' ? sp['filter'] : 'all';
  const filter: FilterKey = FILTERS.some((f) => f.key === raw) ? (raw as FilterKey) : 'all';

  const rt = await getRuntime();
  const autonomous = autonomousIdsOf(rt.bootstrapped);
  const all = rt.bootstrapped.memory.all().map((m) => toMemoryCard(m, autonomous));

  const counts: Record<string, number> = {};
  for (const m of all) counts[m.lifecycle] = (counts[m.lifecycle] ?? 0) + 1;

  const list = filter === 'all' ? all : all.filter((m) => m.lifecycle === filter);
  const candidates = all.filter((m) => m.lifecycle === 'candidate');

  return (
    <Page
      title="记忆"
      desc="它记住的每一条都在这里：什么类型、多可信、用了多久。待你确认的条目会排在最前。"
    >
      <div className="row" style={{ marginBottom: 20, justifyContent: 'space-between' }}>
        <div className="tabs">
          {FILTERS.map((f) => {
            const n = f.key === 'all' ? all.length : (counts[f.key] ?? 0);
            return (
              <Link
                key={f.key}
                href={f.key === 'all' ? '/memory' : `/memory?filter=${f.key}`}
                data-on={filter === f.key ? '' : undefined}
              >
                {f.label}
                <span className="dim"> {n}</span>
              </Link>
            );
          })}
        </div>
        <span className="dim small">共 {all.length} 条</span>
      </div>

      {candidates.length > 0 && filter !== 'candidate' && (
        <div className="note" data-tone="warn" style={{ marginBottom: 24 }}>
          有 <b>{candidates.length}</b> 条在等你确认 ——{' '}
          <Link href="/memory?filter=candidate">去处理</Link>
          。确认之前它们不会影响任何判断。
        </div>
      )}

      <Section
        title={filter === 'all' ? '全部记忆' : (FILTERS.find((f) => f.key === filter)?.label ?? '记忆')}
        count={list.length}
        hint={filter === 'candidate' ? '批准后立刻参与召回' : undefined}
      >
        {list.length === 0 ? (
          <Empty>
            {filter === 'candidate'
              ? '没有待确认的记忆。用过几次之后，复盘会自动产出候选。'
              : '这一类还没有内容。'}
          </Empty>
        ) : (
          <div className="rows">
            {list.map((m) => (
              <div className="item" key={m.id}>
                <div className="body">{m.content}</div>
                {m.principle !== undefined && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    当 {m.principle.condition} 时 → {m.principle.action}
                  </div>
                )}
                <div className="meta">
                  <Badge tone={lifeTag(m.lifecycle)}>{m.lifecycleLabel}</Badge>
                  <span>{m.kindLabel}</span>
                  <span>{m.memClassLabel}</span>
                  <span>{m.ownerLabel}</span>
                  <span>{fitnessWord(m.fitnessPercent)}</span>
                  <span>证据 {m.evidenceCount} 条</span>
                  {m.autonomous && <span>系统自主生效</span>}
                  <span>{clockText(m.updatedAt)}</span>
                </div>
                {m.lifecycle === 'candidate' && <ReviewActions id={m.id} />}
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="note">
        记忆分四类：<b>硬性要求</b>（永不过期）、<b>全局共享</b>、<b>领域记忆</b>、
        <b>敏感域</b>（需临时授权）。候选只有在你批准后才会参与召回；
        长期不用会被自动休眠，而不是删除。
      </div>
    </Page>
  );
}

function lifeTag(lifecycle: string): 'ok' | 'warn' | undefined {
  if (lifecycle === 'candidate') return 'warn';
  if (lifecycle === 'active') return 'ok';
  return undefined;
}

/** 把适应度翻译成人话 —— 数值对大众没有意义。 */
function fitnessWord(percent: number): string {
  if (percent >= 75) return '很管用';
  if (percent >= 50) return '比较管用';
  if (percent >= 30) return '有时管用';
  return '还看不出效果';
}
