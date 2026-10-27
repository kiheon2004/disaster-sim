import { useT } from '@/i18n/i18n';
import { DAMAGE_STATE_COLORS, DAMAGE_STATE_IDS, type DamageState } from '@/simulation/damage/DamageState';
import styles from './StateBadge.module.css';

export function StateDot({ state }: { state: DamageState }) {
  return <span className={styles.dot} style={{ background: DAMAGE_STATE_COLORS[state] }} />;
}

export function StateBadge({ state }: { state: DamageState }) {
  const t = useT();
  const c = DAMAGE_STATE_COLORS[state];
  return (
    <span className={styles.badge} style={{ color: c, borderColor: c, background: `${c}1f` }}>
      <span className={styles.dot} style={{ background: c }} />
      {t(`damage.${DAMAGE_STATE_IDS[state]}`)}
    </span>
  );
}
