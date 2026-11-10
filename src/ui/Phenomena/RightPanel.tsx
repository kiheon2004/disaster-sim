/**
 * Right context panel (Phase 35.5): one panel, four tabs — Selection (what is selected / world overview), Disasters (library,
 * placement, the placed instances with their own controls, the detailed hazard forms folded), Analysis (simulation summary,
 * probes, results), Settings. The tab follows the context (selecting an object shows Selection, choosing a disaster shows
 * Disasters) and the panel can be closed to give the 3D view the whole width. UI state only.
 */
import { useEffect, useRef, useState } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import { useEditorStore } from '@/editor/editorStore';
import { useSimStore } from '@/simulation/simStore';
import { useUiStore, type RightTab } from '@/ui/uiStore';
import { usePlacementStore } from '@/ui/placement/placementStore';
import { useWorldStore } from '@/world/worldStore';
import { Icon } from '@/ui/common/Icon';
import { Section } from '@/ui/common/Panel';
import { Toggle } from '@/ui/common/fields';
import { AnalysisContent, InspectorContent, SettingsContent } from '@/ui/Inspector/InspectorPanel';
import { ExperimentPanel } from '@/ui/BottomPanel/ExperimentPanel';
import { WindForm } from '@/ui/BottomPanel/WindForm';
import { EarthquakeForm } from '@/ui/BottomPanel/EarthquakeForm';
import { FloodForm } from '@/ui/BottomPanel/FloodForm';
import eq from '@/ui/BottomPanel/EarthquakeForm.module.css';
import { DisasterLibrary } from './DisasterLibrary';
import { PlacementBar } from './PlacementBar';
import s from './Phenomena.module.css';

const TABS: { id: RightTab; icon: 'cursor' | 'flask' | 'probe' | 'gear' }[] = [
  { id: 'selection', icon: 'cursor' },
  { id: 'phenomena', icon: 'flask' },
  { id: 'analysis', icon: 'probe' },
  { id: 'settings', icon: 'gear' },
];

export function RightPanel() {
  const t = useT();
  const tab = useUiStore((st) => st.rightTab);
  const open = useUiStore((st) => st.rightOpen);
  const selectedId = useEditorStore((st) => st.selectedId);
  const tool = useEditorStore((st) => st.tool);
  const mode = useEditorStore((st) => st.mode);
  const armed = usePlacementStore((st) => st.type);
  const placedSel = usePlacementStore((st) => st.selected);
  const count = useWorldStore((st) => st.doc.scenario.experiment?.instances.length ?? 0);
  const active = useSimStore((st) => st.events.filter((e) => e.status === 'active' || e.status === 'paused').length);
  // Follow the context: a new object selection / an editing tool → Selection; a disaster chosen / its pin → Disasters.
  const prevSel = useRef(selectedId);
  useEffect(() => {
    if (selectedId && selectedId !== prevSel.current) useUiStore.getState().setRightTab('selection');
    prevSel.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    if (tool === 'terrain' || tool === 'building' || tool === 'road') useUiStore.getState().setRightTab('selection');
  }, [tool]);
  useEffect(() => {
    if (armed || placedSel) useUiStore.getState().setRightTab('phenomena');
  }, [armed, placedSel]);

  if (!open) return null;
  const badge = (id: RightTab) => (id === 'phenomena' && count ? <span className={s.tabN} data-active={active > 0}>{active || count}</span> : null);
  return (
    <div className={s.right} data-testid="right-panel">
      <div className={s.tabs} role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={s.tab} onClick={() => useUiStore.getState().setRightTab(x.id)} data-tab={x.id}>
            <span>{t(`tab.${x.id}` as MessageKey)}</span>
            {badge(x.id)}
          </button>
        ))}
        <button className={s.close} title={t('panel.close')} aria-label={t('panel.close')} onClick={() => useUiStore.getState().setRightOpen(false)} data-testid="right-close">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className={s.body}>
        {tab === 'selection' && <InspectorContent />}
        {tab === 'phenomena' && <PhenomenaTab />}
        {tab === 'analysis' && (mode === 'simulation' ? <AnalysisContent /> : <div className={s.note}>{t('analysis.empty')}</div>)}
        {tab === 'settings' && <SettingsTab readOnly={mode === 'simulation'} />}
      </div>
    </div>
  );
}

function PhenomenaTab() {
  const t = useT();
  const count = useWorldStore((st) => st.doc.scenario.experiment?.instances.length ?? 0);
  return (
    <>
      <PlacementBar />
      <Section title={t('lib.title')}>
        <DisasterLibrary />
      </Section>
      <Section title={t('tab.instances')} aside={count || undefined}>
        <ExperimentPanel />
      </Section>
      <LegacyForms />
    </>
  );
}

const LEGACY_KEY = 'ds.hazardTab';
type Legacy = 'wind' | 'earthquake' | 'flood';

/** The detailed hazard forms of earlier phases (single-scenario wind / earthquake / flood), folded under the library. */
function LegacyForms() {
  const t = useT();
  const [tab, setTabState] = useState<Legacy>(() => {
    try {
      const v = localStorage.getItem(LEGACY_KEY);
      return v === 'earthquake' || v === 'flood' ? v : 'wind';
    } catch {
      return 'wind';
    }
  });
  const openByDefault = (() => {
    try {
      const v = localStorage.getItem(LEGACY_KEY);
      return v === 'wind' || v === 'earthquake' || v === 'flood';
    } catch {
      return false;
    }
  })();
  const setTab = (v: Legacy) => {
    setTabState(v);
    try {
      localStorage.setItem(LEGACY_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const tabs = (
    <span className={eq.tabs} role="tablist" aria-label={t('tab.legacyForms')}>
      <button role="tab" className={eq.tab} aria-selected={tab === 'wind'} onClick={() => setTab('wind')}><Icon name="wind" size={13} /> {t('hazard.tab.wind')}</button>
      <button role="tab" className={eq.tab} aria-selected={tab === 'earthquake'} onClick={() => setTab('earthquake')}><Icon name="quake" size={13} /> {t('hazard.tab.earthquake')}</button>
      <button role="tab" className={eq.tab} aria-selected={tab === 'flood'} onClick={() => setTab('flood')}><Icon name="water" size={13} /> {t('hazard.tab.flood')}</button>
    </span>
  );
  return (
    <Section title={t('tab.legacyForms')} defaultOpen={openByDefault}>
      <div className={s.legacy}>
        {tab === 'wind' ? <WindForm tabs={tabs} /> : tab === 'earthquake' ? <EarthquakeForm tabs={tabs} /> : <FloodForm tabs={tabs} />}
      </div>
    </Section>
  );
}

function SettingsTab({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const interactions = useWorldStore((st) => st.doc.settings.simulation.interactions?.enabled ?? true);
  const v2 = useWorldStore((st) => st.doc.settings.simulation.structure?.model === 'v2');
  return (
    <>
      <div className={s.settingRow} title={t('exp.interactions.hint')}>
        <Toggle checked={interactions} onChange={(v) => useWorldStore.getState().updateSimulationSettings({ interactions: v })} label={t('exp.interactions')} disabled={readOnly} />
      </div>
      <div className={s.settingRow} data-testid="structure-v2">
        <Toggle checked={v2} onChange={(v) => useWorldStore.getState().updateSimulationSettings({ structure: v ? { model: 'v2' } : null })} label={t('struct.v2')} disabled={readOnly} />
        <div className={s.settingHint}>{t('struct.v2.hint')}</div>
      </div>
      <SettingsContent readOnly={readOnly} />
    </>
  );
}
