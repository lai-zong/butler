'use client';

/**
 * 快速切换（⌘K / Ctrl+K）
 *
 * ★ 不是“炫技”：这个界面有五个空间，键盘切换比来回点侧栏快得多。
 *   同时把两个高频动作（新建对话、导出数据）放进来。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from './Icon';
import { Kbd } from './Common';
import type { ViewId } from '../lib/types.js';

interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  readonly keywords: string;
  readonly icon: IconName;
  readonly run: () => void;
}

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (view: ViewId) => void;
  readonly onNewChat: () => void;
  readonly onExport: () => void;
  readonly onRefresh: () => void;
}

const EXIT_MS = 180;

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onNewChat,
  onExport,
  onRefresh,
}: CommandPaletteProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery('');
      setIndex(0);
      const raf = requestAnimationFrame(() => {
        setVisible(true);
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const items = useMemo<readonly PaletteItem[]>(
    () => [
      {
        id: 'go-chat',
        group: '前往',
        label: '对话',
        hint: '与管家工作',
        keywords: 'chat 对话 聊天',
        icon: 'chat',
        run: () => onNavigate('chat'),
      },
      {
        id: 'go-memory',
        group: '前往',
        label: '记忆治理',
        hint: '审核候选 / 调权 / 遗忘',
        keywords: 'memory 记忆 治理 审核',
        icon: 'memory',
        run: () => onNavigate('memory'),
      },
      {
        id: 'go-audit',
        group: '前往',
        label: '审计',
        hint: '召回、注入与事件流',
        keywords: 'audit 审计 依据 事件',
        icon: 'audit',
        run: () => onNavigate('audit'),
      },
      {
        id: 'go-growth',
        group: '前往',
        label: '演化',
        hint: '生命周期与行为画像',
        keywords: 'growth 演化 成长 画像',
        icon: 'growth',
        run: () => onNavigate('growth'),
      },
      {
        id: 'go-settings',
        group: '前往',
        label: '设置',
        hint: '运行、隐私与数据',
        keywords: 'settings 设置 配置 隐私',
        icon: 'settings',
        run: () => onNavigate('settings'),
      },
      {
        id: 'act-new-chat',
        group: '操作',
        label: '新建对话',
        hint: '开一个干净的上下文',
        keywords: 'new chat 新建 对话 会话',
        icon: 'plus',
        run: onNewChat,
      },
      {
        id: 'act-refresh',
        group: '操作',
        label: '刷新状态',
        hint: '重新读取运行概览',
        keywords: 'refresh 刷新 状态',
        icon: 'refresh',
        run: onRefresh,
      },
      {
        id: 'act-export',
        group: '操作',
        label: '导出数据',
        hint: '下载单文件 JSON 备份',
        keywords: 'export 导出 备份 下载',
        icon: 'download',
        run: onExport,
      },
    ],
    [onNavigate, onNewChat, onRefresh, onExport],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.hint.toLowerCase().includes(q) ||
        i.keywords.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const runItem = (item: PaletteItem): void => {
    onClose();
    window.setTimeout(() => item.run(), 60);
  };

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div className={`palette-root ${visible ? 'is-open' : ''}`}>
      <div className="palette-backdrop" onMouseDown={onClose} aria-hidden="true" />
      <div className="palette-panel" role="dialog" aria-modal="true" aria-label="快速切换">
        <div className="palette-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="前往… / 搜索动作"
            aria-label="搜索页面或动作"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) =>
                  filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = filtered[index];
                if (item !== undefined) runItem(item);
              }
            }}
          />
          <Kbd>ESC</Kbd>
        </div>

        <div className="palette-list" role="listbox" aria-label="结果">
          {filtered.length === 0 && <p className="palette-empty">没有匹配的页面或动作</p>}
          {filtered.map((item, i) => {
            const prev = filtered[i - 1];
            const showGroup = prev === undefined || prev.group !== item.group;
            return (
              <div key={item.id}>
                {showGroup && <p className="palette-group">{item.group}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item ${i === index ? 'is-active' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => runItem(item)}
                >
                  <span className="palette-item-icon">
                    <Icon name={item.icon} size={17} />
                  </span>
                  <span className="palette-item-text">
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {i === index && <span className="palette-enter">↵</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 选择
          </span>
          <span>
            <Kbd>↵</Kbd> 执行
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
