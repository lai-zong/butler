'use client';

/**
 * 带显示/隐藏切换的密码输入。
 *
 * ★ 只负责一个字段：标签、输入、可见性、错误/提示、焦点引用。
 *   校验规则留在调用方——登录只要求非空，设置/重置才检查 8 位下限。
 */

import { useState, type RefObject } from 'react';

import { Icon } from '../components/Icon';

interface PasswordFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: 'current-password' | 'new-password' | 'off';
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly inputRef?: RefObject<HTMLInputElement> | undefined;
  readonly maxLength?: number | undefined;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  error,
  disabled = false,
  autoFocus = false,
  inputRef,
  maxLength,
}: PasswordFieldProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const note = error ?? hint ?? null;
  const noteId = `${id}-note`;
  const invalid = typeof error === 'string' && error.length > 0;

  return (
    <div className={`auth-field${invalid ? ' is-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="auth-input">
        <input
          id={id}
          ref={inputRef}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={maxLength}
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={note !== null ? noteId : undefined}
        />
        <button
          type="button"
          className="auth-reveal"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? '隐藏密码' : '显示密码'}
          title={revealed ? '隐藏密码' : '显示密码'}
          disabled={disabled}
        >
          <Icon name={revealed ? 'eyeOff' : 'eye'} size={15} />
        </button>
      </div>
      {note !== null && (
        <p
          id={noteId}
          className={`auth-field-note${invalid ? ' is-error' : ''}`}
          role={invalid ? 'alert' : undefined}
        >
          {note}
        </p>
      )}
    </div>
  );
}
