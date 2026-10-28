import { useMemo, useState } from 'react';
import { translateMessage, useLocale, useT, type MessageKey } from '@/i18n/i18n';
import { BOUNDARY_SIDES, defaultFloodScenario, defaultWaterSettings, type BoundarySide, type FloodScenario, type WaterBoundaryType, type WaterSettings } from '@/core/model';
import type { EventSpec, RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec } from '@/events/specs';
import { FLOOD_LIMITS, rainAssumptions, resolveRisingWater, sourceAssumptions } from '@/events/flood/resolveFlood';
import { resolveBoundary } from '@/simulation/water/WaterForcing';
import { useEditorStore } from '@/editor/editorStore';
import { useWorldStore } from '@/world/worldStore';
import { useSimStore } from '@/simulation/simStore';
import { clearWaterState, loadWaterState, runSimulation, saveWaterState } from '@/app/actions';
import { NumberField, SliderField, Toggle } from '@/ui/common/fields';
import { Segmented } from '@/ui/common/Segmented';
import { Icon } from '@/ui/common/Icon';
import styles from './BottomPanel.module.css';
import eq from './EarthquakeForm.module.css';

export const DEFAULT_RAIN: RainEventSpec = { event: 'rain', intensity: 80, duration: 1800 };
export const DEFAULT_RISING: RisingWaterEventSpec = { event: 'risingWater', boundary: 'S', level: 2, riseRate: 0.5 };
export const DEFAULT_SOURCE: WaterSourceEventSpec = { event: 'waterSource', position: [0, 0], rate: 5, duration: 600 };

type Kind = 'rain' | 'risingWater' | 'sources';

/**
 * Flood settings (Phase 14). The configured events ARE the project's saved flood scenario
 * (doc.scenario.flood) and the water settings live in doc.settings.simulation.water, so both
 * are stored with the project. Units are shown on every field; levels are surface ELEVATIONS.
 */
export function FloodForm({ tabs }: { tabs: React.ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const scenario = useWorldStore((s) => s.doc.scenario.flood) ?? defaultFloodScenario();
  const water = useWorldStore((s) => s.doc.settings.simulation.water) ?? defaultWaterSettings();
  const terrain = useWorldStore((s) => s.doc.terrain);
  const mode = useEditorStore((s) => s.mode);
  const status = useSimStore((s) => s.status);
  const initialWater = useSimStore((s) => s.initialWaterTime);
  const [kind, setKind] = useState<Kind>('rain');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inSim = mode === 'simulation';

  const set = (patch: Partial<FloodScenario>) => useWorldStore.getState().setFloodScenario(patch);
  const setEnabled = (k: Kind, v: boolean) => set({ enabled: { ...scenario.enabled, [k]: v } });
  const rain = scenario.rain ?? DEFAULT_RAIN;
  const rising = scenario.risingWater ?? DEFAULT_RISING;
  const setRain = (p: Partial<RainEventSpec>) => set({ rain: clean({ ...rain, ...p }) });
  const setRising = (p: Partial<RisingWaterEventSpec>) => set({ risingWater: clean({ ...rising, ...p }) });
  const setSource = (i: number, p: Partial<WaterSourceEventSpec>) => set({ sources: scenario.sources.map((s, k) => (k === i ? clean({ ...s, ...p }) : s)) });
  const setWater = (p: Partial<WaterSettings>) => useWorldStore.getState().updateSimulationSettings({ water: p });

  const resolved = useMemo(() => resolveRisingWater(rising, terrain, water), [rising, terrain, water]);
  const specs: EventSpec[] = [];
  if (scenario.enabled.rain) specs.push({ ...rain });
  if (scenario.enabled.risingWater) specs.push({ ...rising });
  if (scenario.enabled.sources) specs.push(...scenario.sources.map((s) => ({ ...s })));
  const assumptions = kind === 'rain' ? rainAssumptions(rain) : kind === 'risingWater' ? resolved.assumptions : scenario.sources.flatMap(sourceAssumptions);
  const area = 200 * 200;

  return (
    <>
      <div className={styles.colHead}>
        {tabs}
        <span className={styles.aside}>
          <span className={eq.badge} style={{ color: '#9fd3ff', background: 'rgba(70,160,230,0.16)' }} title={t('flood.disclaimer')}>{t('flood.badge')}</span>
        </span>
      </div>
      <div className={styles.colBody}>
        <div className={eq.grid}>
          <div className={eq.fields}>
            <Segmented
              size="small"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'rain', label: t('flood.form.kind.rain') },
                { value: 'risingWater', label: t('flood.form.kind.risingWater') },
                { value: 'sources', label: t('flood.form.kind.source') },
              ]}
            />
            <Toggle checked={scenario.enabled[kind]} onChange={(v) => setEnabled(kind, v)} label={t('flood.form.include')} />
            {kind === 'rain' && (
              <>
                <SliderField label={t('flood.form.intensity')} value={rain.intensity} min={1} max={200} step={1} precision={0} unit="mm/h" onChange={(v) => setRain({ intensity: Math.round(v) })} />
                <NumberField label={t('flood.form.duration')} value={rain.duration / 60} min={0.5} max={FLOOD_LIMITS.duration[1] / 60} step={1} precision={1} unit="min" onChange={(v, live) => !live && setRain({ duration: Math.round(v * 60) })} />
                <div className={`${eq.row} ${eq.wrapRow}`}>
                  <span className={eq.label}>{t('flood.form.area')}</span>
                  <Segmented size="small" value={rain.area ? 'circle' : 'whole'} onChange={(m) => setRain({ area: m === 'whole' ? null : { center: [0, 0], radius: 50 } })}
                    options={[{ value: 'whole', label: t('flood.form.area.whole') }, { value: 'circle', label: t('flood.form.area.circle') }]} />
                </div>
                {rain.area && (
                  <>
                    <NumberField label={t('flood.form.centerX')} value={rain.area.center[0]} min={-100} max={100} step={1} precision={0} unit="m" onChange={(v, live) => !live && setRain({ area: { ...rain.area!, center: [v, rain.area!.center[1]] } })} />
                    <NumberField label={t('flood.form.centerZ')} value={rain.area.center[1]} min={-100} max={100} step={1} precision={0} unit="m" onChange={(v, live) => !live && setRain({ area: { ...rain.area!, center: [rain.area!.center[0], v] } })} />
                    <NumberField label={t('flood.form.radius')} value={rain.area.radius} min={1} max={100} step={1} precision={0} unit="m" onChange={(v, live) => !live && setRain({ area: { ...rain.area!, radius: v } })} />
                  </>
                )}
                <div className={eq.info} title={t('flood.form.intensity.hint')}>
                  {t('flood.form.total', { mm: ((rain.intensity * rain.duration) / 3600).toFixed(1), m3: Math.round((rain.intensity / 1000) * (rain.duration / 3600) * (rain.area ? Math.PI * rain.area.radius ** 2 : area)) })}
                </div>
              </>
            )}
            {kind === 'risingWater' && (
              <>
                <div className={`${eq.row} ${eq.wrapRow}`}>
                  <span className={eq.label}>{t('flood.form.boundary')}</span>
                  <Segmented size="small" value={rising.boundary} onChange={(b) => setRising({ boundary: b })}
                    options={BOUNDARY_SIDES.map((s) => ({ value: s, label: t(`side.${s}` as MessageKey) }))} />
                </div>
                <NumberField label={t('flood.form.level')} hint={t('flood.form.level.hint')} value={rising.level} min={FLOOD_LIMITS.level[0]} max={FLOOD_LIMITS.level[1]} step={0.1} precision={2} unit="m" onChange={(v, live) => !live && setRising({ level: v })} />
                <NumberField label={t('flood.form.riseRate')} value={rising.riseRate ?? 0.5} min={0.01} max={10} step={0.05} precision={2} unit="m/min" onChange={(v, live) => !live && setRising({ riseRate: v })} />
                <div className={eq.autoRow}>
                  <NumberField label={t('flood.form.duration')} value={(rising.duration ?? resolved.duration) / 60} min={0.5} max={360} step={1} precision={1} unit="min"
                    disabled={rising.duration === undefined} onChange={(v, live) => !live && setRising({ duration: Math.round(v * 60) })} />
                  <Toggle checked={rising.duration === undefined} onChange={(b) => setRising({ duration: b ? undefined : resolved.duration })} label={t('eq.form.auto')} />
                </div>
                <div className={eq.info}>
                  {t('flood.form.edgeInfo', { lo: resolved.edgeGround[0].toFixed(2), hi: resolved.edgeGround[1].toFixed(2), depth: Math.max(0, rising.level - resolved.edgeGround[0]).toFixed(2), rise: Math.round(resolved.riseTime) })}
                </div>
              </>
            )}
            {kind === 'sources' && (
              <>
                {scenario.sources.length === 0 && <div className={eq.info}>{t('flood.form.noSources')}</div>}
                {scenario.sources.map((s, i) => (
                  <div key={i} className={eq.fields} style={{ paddingBottom: 4, borderBottom: '1px solid var(--line)' }}>
                    <NumberField label={t('flood.form.rate')} hint={i === 0 ? t('flood.form.rate.hint') : undefined} value={s.rate} min={0.001} max={200} step={0.5} precision={3} unit="m³/s" onChange={(v, live) => !live && setSource(i, { rate: v })} />
                    <NumberField label={t('flood.form.sourceX')} value={s.position[0]} min={-100} max={100} step={1} precision={0} unit="m" onChange={(v, live) => !live && setSource(i, { position: [v, s.position[1]] })} />
                    <NumberField label={t('flood.form.sourceZ')} value={s.position[1]} min={-100} max={100} step={1} precision={0} unit="m" onChange={(v, live) => !live && setSource(i, { position: [s.position[0], v] })} />
                    <NumberField label={t('flood.form.duration')} value={s.duration / 60} min={0.5} max={360} step={1} precision={1} unit="min" onChange={(v, live) => !live && setSource(i, { duration: Math.round(v * 60) })} />
                    <div className={eq.row}>
                      <span className={eq.info}>{t('flood.form.sourceTotal', { m3: Math.round(s.rate * s.duration) })}</span>
                      <button className={eq.small} onClick={() => set({ sources: scenario.sources.filter((_, k) => k !== i) })}>{t('flood.form.removeSource')}</button>
                    </div>
                  </div>
                ))}
                <button className={eq.small} onClick={() => set({ sources: [...scenario.sources, { ...DEFAULT_SOURCE }], enabled: { ...scenario.enabled, sources: true } })}>
                  <Icon name="water" size={12} /> {t('flood.form.addSource')}
                </button>
              </>
            )}
          </div>
          <div className={eq.side}>
            {assumptions.length > 0 && (
              <div className={eq.assumptions}>
                <b>{t('flood.form.assumptions')}</b>
                {assumptions.map((a, i) => <div key={i}>· {translateMessage(locale, a)}</div>)}
              </div>
            )}
            <button className={eq.disclosure} onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}>
              <Icon name={settingsOpen ? 'chevronDown' : 'chevronRight'} size={12} /> {t('flood.form.settings')}
            </button>
            {settingsOpen && <WaterSettingsFields water={water} setWater={setWater} readOnly={inSim} />}
            <div className={eq.info}>
              {terrain.settings.waterLevel !== null ? t('flood.form.reference', { m: terrain.settings.waterLevel.toFixed(2) }) : t('flood.form.reference.none')}
            </div>
            <div className={eq.fields}>
              <span className={eq.label}>{t('flood.form.state')}</span>
              <div className={`${eq.row} ${eq.wrapRow}`}>
                <button className={eq.small} disabled={!inSim} onClick={saveWaterState}><Icon name="save" size={12} /> {t('flood.form.state.save')}</button>
                <button className={eq.small} onClick={() => void loadWaterState()}><Icon name="folder" size={12} /> {t('flood.form.state.load')}</button>
                {initialWater !== null && <button className={eq.small} onClick={clearWaterState}>{t('flood.form.state.clear')}</button>}
              </div>
              {initialWater !== null && <div className={eq.assumed}>{t('flood.form.state.active', { t: Math.round(initialWater) })}</div>}
              <div className={eq.info} style={{ fontSize: 10.5 }}>{t('flood.form.state.hint')}</div>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={status === 'loading' || specs.length === 0} title={specs.length === 0 ? t('flood.form.nothing') : undefined}
            onClick={() => void runSimulation(specs)}>
            <Icon name="play" size={14} /> {inSim ? t('flood.form.applyNow') : t('flood.form.run')}
          </button>
          <div className={eq.disclaimer}>{t('flood.disclaimer')}</div>
        </div>
      </div>
    </>
  );
}

function clean<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

const BC_TYPES: WaterBoundaryType[] = ['auto', 'closed', 'open', 'fixedLevel'];

function WaterSettingsFields({ water, setWater, readOnly }: { water: WaterSettings; setWater: (p: Partial<WaterSettings>) => void; readOnly: boolean }) {
  const t = useT();
  const terrain = useWorldStore((s) => s.doc.terrain);
  const setEdge = (side: BoundarySide, type: WaterBoundaryType, level?: number) =>
    setWater({ boundaries: { ...water.boundaries, [side]: type === 'fixedLevel' ? { type, level: level ?? water.boundaries[side].level ?? terrain.settings.waterLevel ?? 0 } : { type } } });
  return (
    <div className={eq.fields}>
      <span className={eq.label} title={t('flood.form.bc.hint')}>{t('flood.form.boundaries')} ⓘ</span>
      {BOUNDARY_SIDES.map((side) => {
        const b = water.boundaries[side];
        const r = resolveBoundary(b, side, terrain);
        return (
          <div key={side} className={`${eq.row} ${eq.wrapRow}`}>
            <span className={eq.label} style={{ width: 34 }}>{t(`side.${side}` as MessageKey)}</span>
            <select value={b.type} disabled={readOnly} onChange={(e) => setEdge(side, e.target.value as WaterBoundaryType)} aria-label={t(`side.${side}` as MessageKey)}>
              {BC_TYPES.map((ty) => <option key={ty} value={ty}>{t(`flood.form.bc.${ty}` as MessageKey)}</option>)}
            </select>
            {b.type === 'fixedLevel' && (
              <NumberField label="" value={b.level ?? 0} min={-30} max={60} step={0.1} precision={2} unit="m" disabled={readOnly} onChange={(v, live) => !live && setEdge(side, 'fixedLevel', v)} />
            )}
            {b.type === 'auto' && <span className={eq.info}>{t('flood.form.bc.resolved', { type: t(`flood.form.bc.${r.type}` as MessageKey) + (r.type === 'fixedLevel' ? ` ${r.level.toFixed(2)} m` : '') })}</span>}
          </div>
        );
      })}
      <Toggle checked={water.infiltration} disabled={readOnly} onChange={(v) => setWater({ infiltration: v })} label={t('flood.form.infiltration')} />
      {water.infiltration && (
        <NumberField label={t('flood.form.infiltrationScale')} value={water.infiltrationScale} min={0} max={5} step={0.1} precision={2} unit="×" disabled={readOnly} onChange={(v, live) => !live && setWater({ infiltrationScale: v })} />
      )}
      <NumberField label={t('flood.form.drainage')} hint={t('flood.form.drainage.hint')} value={water.drainageCapacity} min={0} max={200} step={5} precision={0} unit="mm/h" disabled={readOnly} onChange={(v, live) => !live && setWater({ drainageCapacity: v })} />
      <NumberField label={t('flood.form.roughness')} value={water.roughnessScale} min={0.2} max={5} step={0.1} precision={2} unit="×" disabled={readOnly} onChange={(v, live) => !live && setWater({ roughnessScale: v })} />
      <Toggle checked={water.initialFromReference} disabled={readOnly} onChange={(v) => setWater({ initialFromReference: v })} label={t('flood.form.initialRef')} title={t('flood.form.initialRef.hint')} />
    </div>
  );
}
