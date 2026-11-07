'use client';

/**
 * 重命名对话 —— 居中小对话框
 *
 * ★ 不用浏览器 prompt：prompt 无法显示字数、错误与保存中状态，
 *   而且会阻塞页面。这里复用 Modal 的 Esc/遮罩/焦点回收。
 * ★ 只负责输入与校验；PATCH 与侧栏行补丁在 sessionIndex.renameSession，
 *   失败时把服务端原因原样显示，不假装成功。
 */

import { useEffect, useRef, useState } from 'react';

import { errorMessage } from '../lib/api.js';
import { Modal } from './Modal';

const TITLE_MAX = 60;

interface RenameSessionDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  /** 抛错 = 保存失败，对话框保留并显示错误。 */
  readonly onSubmit: (title: string) => Promise<void>;
}

export function RenameSessionDialog({
  open,
  title,
  onClose,
  onSubmit,
}: RenameSessionDialogProps): JSX.Element {
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次打开都从当前标题重新开始；关闭时丢弃未保存输入。
  useEffect(() => {
    if (!open) return;
    setValue(title);
    setSaving(false);
    setError(null);
  }, [open, title]);

  const normalized = value.replace(/\s+/g, ' ').trim();
  const tooLong = normalized.length > TITLE_MAX;
  const invalid = normalized.length === 0 || tooLong;

  async function save(): Promise<void> {
    if (saving || invalid) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="重命名对话"
      variant="dialog"
      rootClassName="modal-root--raised"
      panelClassName="rename-dialog"
      initialFocusRef={inputRef}
      footer={
        <div className="rename-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || invalid}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <label className="rename-field">
        <span className="rename-field-label">对话标题</span>
        <input
          ref={inputRef}
          className="task-input rename-input"
          value={value}
          disabled={saving}
          spellCheck={false}
          autoComplete="off"
          aria-label="对话标题"
          aria-invalid={tooLong}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <span className={`rename-count mono${tooLong ? ' is-over' : ''}`}>
          {normalized.length}/{TITLE_MAX}
        </span>
      </label>
      <p className="rename-hint">1–60 字。保存后会变成手动标题，自动生成不会覆盖。</p>
      {error !== null && (
        <p className="rename-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
