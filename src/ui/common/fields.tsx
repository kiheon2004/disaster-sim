import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isImeKey } from '@/editor/input/keys';
import type { Vec3 } from '@/core/types';
import { clamp } from '@/core/math';
import styles from './fields.module.css';

export function FieldRow({ label, children, hint, title }: { label: ReactNode; children: ReactNode; hint?: ReactNode; title?: string }) {
  return (
    <>
      <div className={styles.row} title={title}>
        <span className={styles.label}>{label}</span>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
    </>
  );
}

function format(v: number, precision: number) {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toFixed(precision)));
}

export interface NumberInputProps {
  value: number;
  /** live = true while scrubbing (no undo step per tick). */
  onChange: (v: number, live: boolean) => void;
  onScrubStart?: () => void;
  /** The scrub ended (pointer released / cancelled) — Phase 36: closes the edit's transaction. */
  onScrubEnd?: () => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * Shown while the field is empty (Phase 37). A value that is not a number (NaN) shows as an empty field: the common
   * fields of a multi-selection pass NaN + "—" when the selected objects differ; typing a number commits it.
   */
  placeholder?: string;
  /** `data-testid` of the text input. */
  testId?: string;
}

/** Hook implementing pointer-drag scrubbing on a label element. */
function useScrub(p: NumberInputProps) {
  const start = useRef<{ x: number; v: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (p.disabled) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, v: p.value };
      p.onScrubStart?.();
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      const step = p.step ?? 0.1;
      const factor = e.shiftKey ? 0.1 : 1;
      const raw = start.current.v + Math.round(((e.clientX - start.current.x) / 4) * factor) * step;
      p.onChange(clamp(raw, p.min ?? -Infinity, p.max ?? Infinity), true);
    },
    onPointerUp: () => {
      if (!start.current) return;
      start.current = null;
      p.onScrubEnd?.();
    },
    onPointerCancel: () => {
      if (!start.current) return;
      start.current = null;
      p.onScrubEnd?.();
    },
  };
}

function NumberText(p: NumberInputProps & { className?: string }) {
  const precision = p.precision ?? 2;
  const [text, setText] = useState(format(p.value, precision));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(format(p.value, precision));
  }, [p.value, precision]);

  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v)) {
      const c = clamp(v, p.min ?? -Infinity, p.max ?? Infinity);
      if (c !== p.value) p.onChange(c, false);
      setText(format(c, precision));
    } else setText(format(p.value, precision));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={p.ariaLabel}
      disabled={p.disabled}
      placeholder={p.placeholder}
      data-testid={p.testId}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(format(p.value, precision));
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (p.step ?? 0.1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          p.onChange(clamp(p.value + step, p.min ?? -Infinity, p.max ?? Infinity), false);
        }
      }}
    />
  );
}

export function NumberField(p: NumberInputProps & { label: ReactNode; hint?: ReactNode; title?: string }) {
  const scrub = useScrub(p);
  return (
    <>
      <div className={styles.row} title={p.title}>
        <span className={`${styles.label} ${p.disabled ? '' : styles.scrub}`} {...scrub}>
          {p.label}
        </span>
        <div className={styles.num}>
          <NumberText {...p} ariaLabel={typeof p.label === 'string' ? p.label : p.ariaLabel} />
          {p.unit && <span className={styles.unit}>{p.unit}</span>}
        </div>
      </div>
      {p.hint && <div className={styles.hint}>{p.hint}</div>}
    </>
  );
}

function AxisInput(p: NumberInputProps & { axis: 0 | 1 | 2 }) {
  const scrub = useScrub(p);
  const cls = [styles.x, styles.y, styles.z][p.axis];
  return (
    <div className={styles.axis}>
      <span className={`${styles.axisLabel} ${cls}`} {...scrub}>{'XYZ'[p.axis]}</span>
      <NumberText {...p} />
    </div>
  );
}

export function Vec3Field(p: {
  label: ReactNode;
  value: Vec3;
  onChange: (v: Vec3, live: boolean) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={p.label}>
      <div className={styles.vec}>
        {([0, 1, 2] as const).map((i) => (
          <AxisInput
            key={i}
            axis={i}
            value={p.value[i]}
            step={p.step}
            precision={p.precision}
            min={p.min}
            max={p.max}
            disabled={p.disabled}
            onScrubStart={p.onScrubStart}
            onScrubEnd={p.onScrubEnd}
            ariaLabel={`${typeof p.label === 'string' ? p.label : ''} ${'XYZ'[i]}`}
            onChange={(v, live) => {
              const next: Vec3 = [...p.value];
              next[i] = v;
              p.onChange(next, live);
            }}
          />
        ))}
      </div>
    </FieldRow>
  );
}

export function ColorField(p: { label: ReactNode; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(p.value);
  useEffect(() => setText(p.value), [p.value]);
  return (
    <FieldRow label={p.label}>
      <div className={styles.color}>
        <input type="color" value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value)} />
        <input
          type="text"
          value={text}
          disabled={p.disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => (/^#[0-9a-f]{6}$/i.test(text) ? p.onChange(text) : setText(p.value))}
          onKeyDown={(e) => !isImeKey(e) && e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </FieldRow>
  );
}

export function Toggle(p: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={`${styles.toggle} ${p.disabled ? styles.disabled : ''}`} title={p.title}>
      <span
        role="switch"
        aria-checked={p.checked}
        tabIndex={p.disabled ? -1 : 0}
        className={`${styles.switch} ${p.checked ? styles.on : ''}`}
        onClick={() => !p.disabled && p.onChange(!p.checked)}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !p.disabled && (e.preventDefault(), p.onChange(!p.checked))}
      />
      {p.label && <span onClick={() => !p.disabled && p.onChange(!p.checked)}>{p.label}</span>}
    </label>
  );
}

export function ToggleField(p: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <FieldRow label={p.label} hint={p.hint}>
      <Toggle checked={p.checked} onChange={p.onChange} disabled={p.disabled} />
    </FieldRow>
  );
}

export function SelectField<T extends string>(p: {
  label: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={p.label}>
      <select style={{ width: '100%' }} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value as T)}>
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </FieldRow>
  );
}

export function SliderField(p: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  precision?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={p.label}>
      <div className={styles.slider}>
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={p.step ?? 1}
          value={p.value}
          disabled={p.disabled}
          onChange={(e) => p.onChange(parseFloat(e.target.value))}
        />
        <div className={styles.num}>
          <NumberText value={p.value} min={p.min} max={p.max} step={p.step} precision={p.precision ?? 1} disabled={p.disabled} onChange={(v) => p.onChange(v)} />
          {p.unit && <span className={styles.unit}>{p.unit}</span>}
        </div>
      </div>
    </FieldRow>
  );
}
