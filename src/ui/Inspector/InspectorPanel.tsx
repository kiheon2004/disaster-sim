import { useT } from '@/i18n/i18n';
import { Panel } from '@/ui/common/Panel';

export function InspectorPanel() {
  const t = useT();
  return <Panel title={t('panel.inspector')}>{null}</Panel>;
}
