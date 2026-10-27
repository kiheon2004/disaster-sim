import { useT } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import { Segmented } from '@/ui/common/Segmented';
import { LanguageToggle } from './LanguageToggle';
import styles from './TopBar.module.css';

export function TopBar() {
  const t = useT();
  return (
    <div className={styles.bar}>
      <div className={styles.brand}>
        <img src="/favicon.svg" className={styles.logo} alt="" />
        <span>{t('app.title')}</span>
      </div>
      <div className={styles.sep} />
      <input className={styles.name} defaultValue={t('app.untitled')} aria-label={t('topbar.projectName')} />
      <div className={styles.group}>
        <button className={styles.iconBtn} disabled title={t('topbar.save')}>
          <Icon name="save" /> {t('topbar.save')}
        </button>
        <button className={styles.iconBtn} disabled title={t('topbar.load')}>
          <Icon name="folder" /> {t('topbar.load')}
        </button>
      </div>
      <div className={styles.center}>
        <Segmented
          value="editor"
          onChange={() => {}}
          options={[
            { value: 'editor', label: t('mode.editor') },
            { value: 'simulation', label: t('mode.simulation'), tone: 'sim', disabled: true },
          ]}
        />
      </div>
      <div className={styles.right}>
        <LanguageToggle />
      </div>
    </div>
  );
}
