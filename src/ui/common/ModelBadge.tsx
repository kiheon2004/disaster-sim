import { useState } from 'react';
import { useT } from '@/i18n/i18n';
import { MODELS } from '@/phenomena/models';
import type { ModelLevel } from '@/phenomena/types';
import styles from './ModelBadge.module.css';

export const LEVEL_COLOR: Record<ModelLevel, string> = { physics: '#4fc27a', empirical: '#f2b33d', hypothetical: '#b98cf5', visual: '#8a8f98' };

/**
 * Scientific level of a model (Phase 15) — click for assumptions, units, valid range,
 * limitations, documentation and the validation status (never validated in this project).
 */
export function ModelBadge({ id, compact = false }: { id: string; compact?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const m = MODELS[id];
  if (!m) return null;
  return (
    <span className={styles.wrap}>
      <button className={styles.badge} style={{ borderColor: LEVEL_COLOR[m.level], color: LEVEL_COLOR[m.level] }} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={`${t(m.labelKey)} — ${t(`model.level.${m.level}`)}`}>
        {compact ? t(`model.level.${m.level}`).split(' ')[0] : t(m.labelKey)}
      </button>
      {open && (
        <div className={styles.pop} role="dialog" onMouseLeave={() => setOpen(false)}>
          <b>{t(m.labelKey)}</b>
          <div style={{ color: LEVEL_COLOR[m.level] }}>{t(`model.level.${m.level}`)} · {t('model.validated.no')}</div>
          {m.assumptions.length > 0 && <div><i>{t('model.assumptions')}</i>{m.assumptions.map((k) => <div key={k}>· {t(k)}</div>)}</div>}
          <div><i>{t('model.units')}</i> {m.units.join(', ') || '—'}</div>
          <div><i>{t('model.range')}</i> {m.validRange}</div>
          <div><i>{t('model.limitations')}</i>{m.limitations.map((k) => <div key={k}>· {t(k)}</div>)}</div>
          <div><i>{t('model.reference')}</i> <code>{m.reference}</code></div>
        </div>
      )}
    </span>
  );
}
