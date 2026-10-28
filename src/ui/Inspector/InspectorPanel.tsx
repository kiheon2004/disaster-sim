import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { allDefinitions } from '@/objects/registry';
import { Panel, Section } from '@/ui/common/Panel';
import { ObjectInspector } from './ObjectInspector';
import { LiveStatusSection, SimSummary } from './SimInspector';
import { SimulationSettingsSection } from './SimulationSettings';
import styles from './Inspector.module.css';

export function InspectorPanel() {
  const t = useT();
  const selectedId = useEditorStore((s) => s.selectedId);
  const mode = useEditorStore((s) => s.mode);
  const obj = useWorldStore((s) => (selectedId ? s.doc.objects[selectedId] : undefined));
  const inSim = mode === 'simulation';

  return (
    <Panel title={t('panel.inspector')}>
      {obj ? (
        <>
          {inSim && <LiveStatusSection id={obj.id} />}
          <ObjectInspector obj={obj} readOnly={inSim} />
        </>
      ) : inSim ? (
        <SimSummary />
      ) : (
        <NoSelection />
      )}
    </Panel>
  );
}

function NoSelection() {
  const t = useT();
  const objects = useWorldStore((s) => s.doc.objects);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of Object.values(objects)) c[o.type] = (c[o.type] ?? 0) + 1;
    return c;
  }, [objects]);

  const shortcuts: [string, Parameters<typeof t>[0]][] = [
    ['W / E / R', 'shortcut.transform'],
    ['F', 'shortcut.focus'],
    ['Ctrl/⌘ + D', 'shortcut.duplicate'],
    ['Delete', 'shortcut.delete'],
    ['Ctrl/⌘ + Z', 'shortcut.undo'],
    ['G', 'shortcut.snap'],
    ['Esc', 'shortcut.escape'],
  ];

  return (
    <>
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>{t('inspector.noSelection')}</div>
        {t('inspector.noSelection.hint')}
      </div>
      <Section title={t('inspector.sceneSummary')}>
        <div className={styles.stats}>
          {allDefinitions().map((d) => (
            <FragmentRow key={d.type} label={t(d.labelKey)} value={counts[d.type] ?? 0} />
          ))}
          <FragmentRow label={t('inspector.total')} value={Object.keys(objects).length} />
        </div>
      </Section>
      <SimulationSettingsSection readOnly={false} />
      <Section title={t('inspector.shortcuts')} defaultOpen={false}>
        <div className={styles.shortcuts}>
          {shortcuts.map(([k, key]) => (
            <FragmentRow key={k} label={<span className={styles.kbd}>{k}</span>} value={t(key)} />
          ))}
        </div>
      </Section>
    </>
  );
}

function FragmentRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <span>{value}</span>
    </>
  );
}
