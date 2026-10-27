import { useT } from '@/i18n/i18n';

export function BottomPanel() {
  const t = useT();
  return <div style={{ height: 180, padding: 12, color: 'var(--text-2)' }}>{t('panel.timeline')}</div>;
}
