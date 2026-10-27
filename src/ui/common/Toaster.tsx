import { useLocale, translateMessage } from '@/i18n/i18n';
import { useToastStore } from './toast';
import styles from './Toaster.module.css';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const locale = useLocale();
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.tone]}`} onClick={() => useToastStore.getState().dismiss(t.id)}>
          <div>
            <div>{translateMessage(locale, t.message)}</div>
            {t.detail && <div className={styles.detail}>{t.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
