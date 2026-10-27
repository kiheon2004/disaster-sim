import type { ReactNode } from 'react';
import styles from './Segmented.module.css';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  tone?: 'sim';
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  size?: 'small';
  ariaLabel?: string;
}) {
  const activeTone = props.options.find((o) => o.value === props.value)?.tone;
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      className={`${styles.group} ${props.size === 'small' ? styles.small : ''} ${activeTone === 'sim' ? styles.sim : ''}`}
    >
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === props.value}
          title={o.title}
          disabled={o.disabled}
          className={`${styles.item} ${o.value === props.value ? styles.active : ''}`}
          onClick={() => o.value !== props.value && props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
