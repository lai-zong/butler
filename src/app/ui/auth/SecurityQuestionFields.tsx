'use client';

/**
 * 找回问题的两个字段：问题选择 + 答案。
 *
 * ★ 问题列表来自服务端同一份常量（纯数据，可被客户端导入），
 *   避免前端另抄一份、拼错 id。
 * ★ 答案按普通文本输入：用户需要能核对自己写了什么；
 *   服务端只保存哈希，前端不保存、不回显答案。
 */

import type { RefObject } from 'react';

import { SECURITY_QUESTIONS } from '../../server/localAuthQuestions.js';

interface SecurityQuestionSelectProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly hint?: string | undefined;
}

export function SecurityQuestionSelect({
  id,
  value,
  onChange,
  disabled = false,
  error,
  hint,
}: SecurityQuestionSelectProps): JSX.Element {
  const note = error ?? hint ?? null;
  const noteId = `${id}-note`;
  const invalid = typeof error === 'string' && error.length > 0;

  return (
    <div className={`auth-field${invalid ? ' is-invalid' : ''}`}>
      <label htmlFor={id}>找回问题</label>
      <div className="auth-select-wrap">
        <select
          id={id}
          className="auth-select"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={note !== null ? noteId : undefined}
        >
          <option value="">请选择一个只有你知道答案的问题</option>
          {SECURITY_QUESTIONS.map((question) => (
            <option key={question.id} value={question.id}>
              {question.label}
            </option>
          ))}
        </select>
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

interface SecurityAnswerFieldProps {
  readonly id: string;
  readonly label?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly inputRef?: RefObject<HTMLInputElement> | undefined;
  readonly maxLength?: number | undefined;
}

export function SecurityAnswerField({
  id,
  label = '找回问题答案',
  value,
  onChange,
  placeholder,
  hint,
  error,
  disabled = false,
  inputRef,
  maxLength,
}: SecurityAnswerFieldProps): JSX.Element {
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
          className="auth-answer-input"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={note !== null ? noteId : undefined}
        />
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
