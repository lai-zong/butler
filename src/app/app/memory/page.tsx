/**
 * `/app/memory` —— 记忆库
 *
 * ★★ 这一页回答一个问题：**「它记住了我哪些事？」**
 *
 *   ⚠️ 这是本项目最核心的价值（记忆治理），但对大众用户来说，
 *      它在**绝大多数时候不需要看** —— 所以我把它放在侧栏按需进入，
 *      而不是摆在主界面上。
 *
 * ★ 排版的三条硬线（与用户定的"一眼看完、不拥挤"一致）：
 *
 *   ① **一行一条记忆** —— 不做卡片。
 *      一屏能看 15—20 条，而不是 4—5 张卡片。
 *
 *   ② **术语全部翻成人话** ——
 *      `global_constraint` → 「硬性要求」
 *      `dormant` → 「暂时不用了」
 *      `fitness 0.72` → 「比较管用」
 *      ⚠️ 数值对大众没有意义，反而像仪表盘。
 *
 *   ③ **默认只显示"在用"的** ——
 *      待确认的、暂时不用的、已归档的都收进折叠区。
 *      用户最常想看的就是"它现在拿我哪些信息在办事"。
 */

import { getRuntime } from '../../runtime.js';
/**
 * ⚠️ 这里分了**两个**导入来源，不能合并：
 *
 *   · `Row` / `Sep` / `Tag` 是**组件** → 从 `ui.js` 导入（它有 'use client'）
 *   · `fitnessTone` 等是**纯函数与常量** → 必须从 `labels.js` 导入
 *
 *   ⚠️ 踩过的坑：一开始全部从 `ui.js` 导入，运行时直接报
 *
 *        ⨯ Attempted to call fitnessTone() from the server
 *          but fitnessTone is on the client.
 *
 *      `'use client'` 是**模块级**标记 ——
 *      **re-export 跨不过这条边界**（`ui.js` 里 re-export 了一次也没用）。
 *
 *   ★ 规律：**纯数据与纯函数放在没有 'use client' 的文件里，
 *     并且从那里直接导入。** 只有需要交互的东西才标 'use client'。
 */
import { fitnessTone, fitnessWord, MEMORY_KIND, MEMORY_STATE } from '../labels.js';
import { Row, Sep, Tag } from '../ui.js';

export const dynamic = 'force-dynamic';

export default async function MemoryPage() {
  const rt = await getRuntime();
  const all = rt.bootstrapped.memory.all();

  const active = all.filter((m) => m.lifecycle === 'active');
  const others = all.filter((m) => m.lifecycle !== 'active');

  return (
      <div className="nv-scroll">
        <div className="nv-scroll-inner">
          <div style={{ marginBottom: 'var(--n-sp-4)' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>它记住了什么</div>
            <div
              style={{
                marginTop: 2,
                fontSize: 'var(--n-fs-cap)',
                color: 'var(--n-text-faint)',
              }}
            >
              共 {all.length} 条 · {active.length} 条正在使用
              {others.length > 0 && ` · ${others.length} 条未启用`}
            </div>
          </div>

          {all.length === 0 && (
            <div className="nv-empty">
              <div className="nv-empty-title">还没有记住任何事</div>
              <div className="nv-empty-sub">
                跟它说几句你的情况（比如「我对花生过敏」），
                它会把值得长期记住的存下来，下次直接用。
              </div>
            </div>
          )}

          {active.length > 0 && (
            <Section title="正在使用" count={active.length}>
              {active.map((m) => (
                <MemoryRow
                  key={m.id}
                  kind={m.memClass}
                  state={m.lifecycle}
                  content={m.content}
                  fitness={m.fitness}
                  evidence={m.evidence.length}
                  hitCount={m.hitCount}
                />
              ))}
            </Section>
          )}

          {others.length > 0 && (
            <Section title="未启用" count={others.length} note="它暂时不会拿这些办事">
              {others.map((m) => (
                <MemoryRow
                  key={m.id}
                  kind={m.memClass}
                  state={m.lifecycle}
                  content={m.content}
                  fitness={m.fitness}
                  evidence={m.evidence.length}
                  hitCount={m.hitCount}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
  );
}

function Section({
  title,
  count,
  note,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly note?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 'var(--n-sp-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--n-sp-2)',
          marginBottom: 'var(--n-sp-1)',
        }}
      >
        <span style={{ fontSize: 'var(--n-fs-sub)', fontWeight: 600 }}>{title}</span>
        <span className="nv-mono" style={{ color: 'var(--n-text-faint)' }}>
          {count}
        </span>
        {note !== undefined && (
          <span style={{ fontSize: 'var(--n-fs-tiny)', color: 'var(--n-text-faint)' }}>
            {note}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * 一条记忆 —— **一行**。
 *
 * ⚠️ 刻意不做成卡片：一屏 15—20 条 vs 4—5 张卡，
 *    这是"一眼看完"能否成立的关键。
 *
 * ⚠️ 证据条数只在**有证据时**显示 ——
 *    「依据 0 条」是噪音，而且会让人误以为"没有依据 = 不可信"，
 *    实际上用户亲口说的话本来就不需要额外证据。
 */
function MemoryRow({
  kind,
  state,
  content,
  fitness,
  evidence,
  hitCount,
}: {
  readonly kind: string;
  readonly state: string;
  readonly content: string;
  readonly fitness: number;
  readonly evidence: number;
  readonly hitCount: number;
}) {
  const isHard = kind === 'global_constraint';

  return (
    <Row
      caret=" "
      leading={
        // 硬性要求给一个实心标记 —— 它是唯一"不能被放宽"的一类，
        // 值得比其它记忆更显眼一点
        <span
          className="nv-dot"
          style={{ color: isHard ? 'var(--n-danger)' : 'var(--n-text-faint)' }}
          aria-hidden
        />
      }
      label={
        <>
          <span>{content}</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--n-sp-2)',
              marginTop: 2,
              fontSize: 'var(--n-fs-tiny)',
              color: 'var(--n-text-faint)',
            }}
          >
            <Tag tone={isHard ? 'danger' : 'quiet'}>
              {MEMORY_KIND[kind] ?? kind}
            </Tag>
            {MEMORY_STATE[state] ?? state}
            <Sep />
            {/* ⚠️ 不显示适应度原始数值 —— 大众看不懂 0.72 意味着什么 */}
            <Tag tone={fitnessTone(fitness)}>{fitnessWord(fitness)}</Tag>
            {/*
              ⚠️ 这里原先还有一栏「来源」（你亲口说的 / 它推断的）。
                  但 MemoryEntry **没有 source 字段** —— 来源只在
                  memory.approved 事件里（decidedBy / source）。
                  我没有去猜或编一个值，而是**去掉这一栏**。
                  要显示它得先把来源落到条目上，那是另一件事。
            */}
            {hitCount > 0 && (
              <>
                <Sep />
                用过 {hitCount} 次
              </>
            )}
            {evidence > 0 && (
              <>
                <Sep />
                依据 {evidence} 条
              </>
            )}
          </span>
        </>
      }
    />
  );
}


