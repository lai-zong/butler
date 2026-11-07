'use client';

/**
 * 记忆文本目录
 *
 * ★ 星图回答“它们如何相连”，文本目录回答“它到底说了什么”。
 *   两处共用同一批记忆与同一套筛选；在文本里点一行，打开的是同一个详情侧栏。
 *
 * ★ 候选优先排序不是为了好看：试行记忆是唯一需要人做决定的记忆，
 *   它们应该先出现。其余按更新时间倒序。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { LIFECYCLE_LABEL, relativeTime } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import type { MemoryClass, MemoryLifecycle, ViewId } from '../lib/types.js';
import { MemoryDiary } from './MemoryDiary';
import { LIFECYCLE_COLOR, LIFECYCLE_ORDER, type StarNode } from './starMap.js';

interface MemoryTextProps {
  readonly nodes: readonly StarNode[];
  readonly counts: Record<MemoryLifecycle, number>;
  readonly total: number;
  readonly filter: 'all' | MemoryLifecycle;
  readonly query: string;
  readonly selectedId: string | null;
  readonly onFilter: (filter: 'all' | MemoryLifecycle) => void;
  readonly onQuery: (query: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onNavigate: (view: ViewId) => void;
}

const LIFECYCLE_RANK: Record<MemoryLifecycle, number> = {
  candidate: 0,
  active: 1,
  dormant: 2,
  archived: 3,
};

const CLASS_TONE: Record<MemoryClass, string> = {
  global_constraint: 'is-danger',
  global_shared: 'is-neutral',
  sensitive: 'is-warn',
  domain: 'is-info',
};

export function MemoryText({
  nodes,
  counts,
  total,
  filter,
  query,
  selectedId,
  onFilter,
  onQuery,
  onSelect,
  onNavigate,
}: MemoryTextProps): JSX.Element {
  const now = useNow(30_000);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<'memories' | 'diary'>('memories');

  const sorted = useMemo(() => {
    return [...nodes].sort((a, b) => {
      const rank = LIFECYCLE_RANK[a.item.lifecycle] - LIFECYCLE_RANK[b.item.lifecycle];
      return rank !== 0 ? rank : b.item.updatedAt - a.item.updatedAt;
    });
  }, [nodes]);

  // 搜索 / 筛选改变结果集时回到顶部；选中记忆则由下面的 effect 负责滚到它。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [nodes]);

  // 从侧栏的“关联记忆”跳过来时，把目标行滚进视野。
  useEffect(() => {
    if (selectedId === null) return;
    const element = rowRefs.current.get(selectedId);
    if (element === undefined) return;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [selectedId]);

  return (
    <section
      className={`mm-text${selectedId !== null ? ' is-panel-open' : ''}`}
      aria-label="记忆文本目录"
    >
      <div className="mm-text-inner">
        <nav className="mm-text-subnav" aria-label="文本内容">
          <button
            type="button"
            className={`mm-text-subnav-btn${pane === 'memories' ? ' is-active' : ''}`}
            aria-pressed={pane === 'memories'}
            onClick={() => setPane('memories')}
          >
            记忆列表
            <em className="mono">{total}</em>
          </button>
          <button
            type="button"
            className={`mm-text-subnav-btn${pane === 'diary' ? ' is-active' : ''}`}
            aria-pressed={pane === 'diary'}
            onClick={() => setPane('diary')}
          >
            日记
          </button>
        </nav>

        {pane === 'diary' ? (
          <MemoryDiary nodes={nodes} onSelect={onSelect} onNavigate={onNavigate} />
        ) : (
          <>
        <div className="mm-text-bar">
          <div className="mm-search">
            <Icon name="search" size={14} />
            <input
              type="text"
              value={query}
              placeholder="搜索内容、主题、领域…"
              aria-label="搜索记忆"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onQuery(event.target.value)}
            />
            {query.length > 0 && (
              <button
                type="button"
                className="mm-search-clear"
                onClick={() => onQuery('')}
                aria-label="清空搜索"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          <div className="mm-text-filters" role="group" aria-label="按生命周期筛选">
            <button
              type="button"
              className={`mm-text-filter${filter === 'all' ? ' is-active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => onFilter('all')}
            >
              <i className="mm-filter-dot mm-filter-dot--all" aria-hidden="true" />
              <span>全部</span>
              <em className="mono">{total}</em>
            </button>
            {LIFECYCLE_ORDER.map((lifecycle) => {
              const count = counts[lifecycle];
              const active = filter === lifecycle;
              return (
                <button
                  key={lifecycle}
                  type="button"
                  className={`mm-text-filter${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  disabled={count === 0 && !active}
                  onClick={() => onFilter(active ? 'all' : lifecycle)}
                >
                  <i
                    className="mm-filter-dot"
                    aria-hidden="true"
                    style={{
                      background: LIFECYCLE_COLOR[lifecycle],
                      boxShadow: `0 0 8px ${LIFECYCLE_COLOR[lifecycle]}88`,
                    }}
                  />
                  <span>
                    {LIFECYCLE_LABEL[lifecycle]}
                  </span>
                  <em className="mono">{count}</em>
                </button>
              );
            })}
          </div>

        </div>

        <div className="mm-text-scroll" ref={scrollRef}>
          {sorted.length === 0 ? (
            <div className="mm-text-empty">
              <span className="mm-text-empty-mark" aria-hidden="true">
                <Icon name="search" size={17} />
              </span>
              <p>没有匹配的记忆</p>
              <button
                type="button"
                className="mm-btn"
                onClick={() => {
                  onQuery('');
                  onFilter('all');
                }}
              >
                清除筛选
              </button>
            </div>
          ) : (
            <ul className="mm-text-list">
              {sorted.map((node) => {
                const item = node.item;
                const selected = node.id === selectedId;
                const candidate = item.lifecycle === 'candidate';
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      ref={(element) => {
                        if (element === null) rowRefs.current.delete(node.id);
                        else rowRefs.current.set(node.id, element);
                      }}
                      className={`mm-text-row${selected ? ' is-selected' : ''}${
                        candidate ? ' is-candidate' : ''
                      }`}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelect(node.id)}
                    >
                      <span
                        className="mm-text-orb"
                        aria-hidden="true"
                        style={{
                          background: `radial-gradient(circle at 34% 30%, #ffffff 0%, ${LIFECYCLE_COLOR[item.lifecycle]} 38%, rgba(6, 13, 15, 0.9) 100%)`,
                          boxShadow: `0 0 12px ${LIFECYCLE_COLOR[item.lifecycle]}55`,
                        }}
                      />
                      <span className="mm-text-main">
                        <span className="mm-text-head">
                          <span className="mm-text-title">{item.subject ?? item.kindLabel}</span>
                          <span className="mm-text-tags">
                            <span className={`mm-text-tag is-${item.lifecycle}`}>
                              {item.lifecycleLabel}
                            </span>
                            <span className={`mm-text-tag ${CLASS_TONE[item.memClass]}`}>
                              {item.memClassLabel}
                            </span>
                            <span className="mm-text-tag">{item.kindLabel}</span>
                            {item.domainLabel !== null && (
                              <span className="mm-text-tag">{item.domainLabel}</span>
                            )}
                          </span>
                          <span className="mm-text-time mono">{relativeTime(item.updatedAt, now)}</span>
                        </span>
                        <span className="mm-text-content">{item.content}</span>
                        <span className="mm-text-meta mono">
                          置信 {Math.round(item.confidence * 100)}% · 适应{' '}
                          {Math.round(item.fitness * 100)}% · 召回 {item.hitCount} · {node.degree}{' '}
                          条关系 · v{item.version}
                        </span>
                      </span>
                      <span className="mm-text-go" aria-hidden="true">
                        <Icon name="chevronRight" size={14} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
          </>
        )}
      </div>
    </section>
  );
}
