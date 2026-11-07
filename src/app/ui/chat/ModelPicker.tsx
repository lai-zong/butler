'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '@/app/ui/components/Icon';

export interface PickableModel {
  readonly id: string;
  readonly kind: 'chat' | 'embedding' | 'rerank';
}

export interface PickableProfile {
  readonly id: string;
  readonly name: string;
  readonly models: readonly PickableModel[];
  readonly hasKey: boolean;
  readonly requiresKey?: boolean;
}

export interface ModelChoice {
  readonly profileId: string;
  readonly modelId: string;
}

interface ModelPickerProps {
  readonly profiles: readonly PickableProfile[];
  readonly value: ModelChoice | null;
  readonly onSelect: (choice: ModelChoice) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly note?: string;
}

interface Option {
  readonly profileId: string;
  readonly profileName: string;
  readonly modelId: string;
  readonly available: boolean;
}

/** 对话/审查共用的模型选择器；只展示对话模型。 */
export function ModelPicker({
  profiles,
  value,
  onSelect,
  open,
  onOpenChange,
  disabled = false,
  label = '选择模型',
  note = '只影响当前对话；新对话会沿用最近一次修改使用的配置。',
}: ModelPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo<readonly Option[]>(() => {
    const out: Option[] = [];
    for (const profile of profiles) {
      for (const model of profile.models) {
        if (model.kind !== 'chat') continue;
        out.push({
          profileId: profile.id,
          profileName: profile.name,
          modelId: model.id,
          available: !(profile.requiresKey ?? true) || profile.hasKey,
        });
      }
    }
    return out;
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return options;
    return options.filter(
      (o) =>
        o.modelId.toLowerCase().includes(q) ||
        o.profileName.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onOpenChange]);

  const selected = value === null
    ? null
    : options.find((o) => o.profileId === value.profileId && o.modelId === value.modelId) ?? null;

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="model-picker-mark">◇</span>
        <span className="model-picker-current">{selected?.modelId ?? value?.modelId ?? '选择模型'}</span>
        <Icon name="chevronDown" size={11} />
      </button>

      {open && (
        <div className="model-picker-pop" role="dialog" aria-label={label}>
          <div className="model-picker-head">
            <strong>{label}</strong>
          </div>
          <label className="model-picker-search">
            <Icon name="search" size={13} />
            <input
              value={query}
              placeholder="搜索模型…"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="model-picker-note">{note}</p>
          <div className="model-picker-list" role="listbox">
            {filtered.length === 0 ? (
              <p className="model-picker-empty">没有匹配的对话模型。</p>
            ) : (
              filtered.map((option, index) => {
                const previous = filtered[index - 1];
                const showGroup = previous === undefined || previous.profileId !== option.profileId;
                const active =
                  value !== null &&
                  value.profileId === option.profileId &&
                  value.modelId === option.modelId;
                return (
                  <div key={`${option.profileId}::${option.modelId}`}>
                    {showGroup && <div className="model-picker-group">{option.profileName}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`model-picker-option${active ? ' is-active' : ''}`}
                      disabled={!option.available}
                      onClick={() => {
                        onSelect({ profileId: option.profileId, modelId: option.modelId });
                        onOpenChange(false);
                      }}
                    >
                      <span className="model-picker-radio" />
                      <span className="model-picker-option-main">
                        <code>{option.modelId}</code>
                        <small>{option.profileName}</small>
                      </span>
                      <span className="model-picker-option-meta">
                        {!option.available ? '缺少 Key' : active ? '当前' : ''}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
