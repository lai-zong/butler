'use client';

/**
 * 开关 —— 只有一个语义：用户显式改变了一个状态
 *
 * ★ 行为观察的同意开关也用它，所以文案必须由调用方提供；
 *   组件本身**不允许**默认打开任何东西。
 */

interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled = false }: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}
