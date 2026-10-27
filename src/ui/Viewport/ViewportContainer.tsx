import { Viewport } from '@/rendering/Viewport';
import { useT } from '@/i18n/i18n';
import { Compass } from './Compass';
import styles from './ViewportContainer.module.css';

export function ViewportContainer() {
  const t = useT();
  return (
    <div className={styles.wrap}>
      <Viewport />
      <div className={`${styles.overlay} ${styles.topLeft}`}>
        <span className={styles.badge}>{t('mode.editorShort')}</span>
      </div>
      <div className={`${styles.overlay} ${styles.topRight}`}>
        <Compass />
      </div>
      <div className={`${styles.overlay} ${styles.bottomLeft}`}>
        <span className={styles.hint}>{t('viewport.hint.camera')}</span>
      </div>
    </div>
  );
}
