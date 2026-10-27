import { LOCALES, useLocaleStore, useT } from '@/i18n/i18n';
import { Icon } from '@/ui/common/Icon';
import { Segmented } from '@/ui/common/Segmented';

/** KO / EN switch. The choice is persisted in localStorage; default is Korean. */
export function LanguageToggle() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={t('topbar.languageToggle')}>
      <Icon name="globe" size={15} style={{ color: 'var(--text-2)' }} />
      <Segmented
        size="small"
        ariaLabel={t('topbar.language')}
        value={locale}
        onChange={setLocale}
        options={LOCALES.map((l) => ({ value: l.id, label: l.short, title: l.label }))}
      />
    </div>
  );
}
