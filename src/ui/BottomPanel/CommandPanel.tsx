import { useT } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import styles from './BottomPanel.module.css';

/** Command console — implemented in Phase 6. */
export function CommandPanel() {
  const t = useT();
  return (
    <>
      <div className={styles.colHead}>
        <Icon name="terminal" size={14} /> {t('panel.command')}
      </div>
      <div className={styles.colBody} style={{ color: 'var(--text-3)' }}>{t('common.comingSoon')}</div>
    </>
  );
}
