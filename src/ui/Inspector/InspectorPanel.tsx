import { ClimateObjectSection, ClimateProbeSection } from './ClimateInspector';
import { GravityObjectSection, GravityProbeSection } from './GravityInspector';
import { CelestialObjectSection, CelestialProbeSection } from './CelestialInspector';
import { HumanObjectSection } from './HumanInspector';
import { countRender } from '@/utils/renderCounter';
import { useMemo } from 'react';
import { useT } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { allDefinitions } from '@/objects/registry';
import { Panel, Section } from '@/ui/common/Panel';
import { ObjectInspector } from './ObjectInspector';
import { LiveStatusSection, SimSummary } from './SimInspector';
import { SimulationSettingsSection } from './SimulationSettings';
import { TerrainInspector } from './TerrainInspector';
import { QuakeLiveSection } from './SeismicInspector';
import { FloodLiveSection, FloodProbeSection } from './FloodInspector';
import { DeformationLiveSection, DeformationProbeSection } from './DeformationInspector';
import { GroundObjectSection, GroundProbeSection, ImpactObjectSection } from './GroundInspector';
import { BlastObjectSection, BlastProbeSection } from './BlastInspector';
import { ThermalObjectSection, ThermalProbeSection } from './ThermalInspector';
import { FireObjectSection } from './FireInspector';
import { VolcanoObjectSection, VolcanoProbeSection } from './VolcanoInspector';
import { AtmosphereObjectSection, AtmosphereProbeSection } from './AtmosphereInspector';
import { PhenomenaLiveSection } from './PhenomenaInspector';
import { MultiInspector } from './MultiInspector';
import { MemberInspector } from '@/ui/Building/MemberInspector';
import { RoadInspector } from '@/ui/Roads/RoadInspector';
import { RoadSimSection } from '@/ui/Roads/RoadSimSection';
import styles from './Inspector.module.css';

export function InspectorPanel() {
  countRender('InspectorPanel');
  const t = useT();
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const mode = useEditorStore((s) => s.mode);
  const obj = useWorldStore((s) => (selectedId ? s.doc.objects[selectedId] : undefined));
  const inSim = mode === 'simulation';
  const terrainMode = useEditorStore((s) => s.tool === 'terrain');
  const buildingMode = useEditorStore((s) => s.tool === 'building');
  const roadMode = useEditorStore((s) => s.tool === 'road');

  return (
    <Panel title={t('panel.inspector')}>
      {terrainMode && !inSim ? (
        <TerrainInspector />
      ) : buildingMode && !inSim ? (
        <MemberInspector />
      ) : roadMode && !inSim ? (
        <RoadInspector />
      ) : selectedIds.length > 1 && !inSim ? (
        <MultiInspector ids={selectedIds} readOnly={inSim} />
      ) : obj ? (
        <>
          {inSim && <LiveStatusSection id={obj.id} />}
          {inSim && <HumanObjectSection id={obj.id} />}
          {inSim && <QuakeLiveSection id={obj.id} />}
          {inSim && <FloodLiveSection id={obj.id} />}
          {inSim && <DeformationLiveSection id={obj.id} />}
          {inSim && <GroundObjectSection id={obj.id} />}
          {inSim && <ImpactObjectSection id={obj.id} />}
          {inSim && <BlastObjectSection id={obj.id} />}
          {inSim && <ThermalObjectSection id={obj.id} />}
          {inSim && <VolcanoObjectSection id={obj.id} />}
          {inSim && <AtmosphereObjectSection id={obj.id} />}
          {inSim && <ClimateObjectSection id={obj.id} />}
          {inSim && <GravityObjectSection id={obj.id} />}
          {inSim && <CelestialObjectSection id={obj.id} />}
          {inSim && <FireObjectSection id={obj.id} />}
          {inSim && <PhenomenaLiveSection id={obj.id} />}
          <ObjectInspector obj={obj} readOnly={inSim} />
        </>
      ) : inSim ? (
        <>
          <VolcanoProbeSection />
          <AtmosphereProbeSection />
          <ClimateProbeSection />
          <GravityProbeSection />
          <CelestialProbeSection />
          <GroundProbeSection />
          <BlastProbeSection />
          <ThermalProbeSection />
          <DeformationProbeSection />
          <FloodProbeSection />
          <SimSummary />
          <RoadSimSection />
        </>
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
    ['V / P / B / L / A', 'shortcut.tools'],
    ['Shift + click / drag', 'shortcut.multiSelect'],
    ['Ctrl/⌘ + C / V', 'shortcut.copyPaste'],
    ['Ctrl/⌘ + A', 'shortcut.selectAll'],
    ['Ctrl/⌘ + G', 'shortcut.group'],
    ['W / E / R', 'shortcut.transform'],
    ['F', 'shortcut.focus'],
    ['Ctrl/⌘ + D', 'shortcut.duplicate'],
    ['Delete', 'shortcut.delete'],
    ['Ctrl/⌘ + Z', 'shortcut.undo'],
    ['G', 'shortcut.snap'],
    ['[ / ]', 'shortcut.brush'],
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
