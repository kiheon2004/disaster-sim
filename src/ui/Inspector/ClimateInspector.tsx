import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { STORE } from '@/climate/ClimateWorld';
import type { ClimateRuntime } from '@/simulation/climate/runtime';
import styles from './Inspector.module.css';

const C = (K: number) => (Number.isFinite(K) ? `${fmt(K - 273.15, 1)} °C` : '—');

function Rows({ rows, testId }: { rows: [string, string][]; testId: string }) {
  return (
    <div className={styles.liveGrid} data-testid={testId}>
      {rows.map(([k, v], i) => (
        <Fragment key={`${k}:${i}`}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Climate at a ground point: air, humidity, surface, snow / ice / water, soil, shortwave, friction — computed values. */
function pointRows(r: ClimateRuntime, x: number, z: number, t: ReturnType<typeof useT>): [string, string][] {
  const p = r.probe(x, z);
  if (!p) return [];
  const rows: [string, string][] = [
    [t('climate.inspect.air'), `${C(p.airT)} · ${t('climate.inspect.rh')} ${fmt(p.rh * 100, 0)} %`],
    [t('climate.inspect.dew'), `${C(p.dew)} · q ${fmt(p.q * 1000, 2)} g/kg`],
    [t('climate.inspect.surface'), `${C(p.surfaceT)} · ${t(`climate.state.${p.state}` as MessageKey)}`],
  ];
  if (p.snowDepth > 0.0005 || p.swe > 0.05) rows.push([t('climate.inspect.snow'), `${fmt(p.snowDepth * 100, 1)} cm · ${fmt(p.swe, 1)} kg/m² · ${fmt(p.snowDensity, 0)} kg/m³`]);
  if (p.iceThickness > 0.00005) rows.push([t('climate.inspect.ice'), `${fmt(p.iceThickness * 1000, 1)} mm`]);
  if (p.liquid > 0.001) rows.push([t('climate.inspect.liquid'), `${fmt(p.liquid, 2)} kg/m²`]);
  if (p.water > 0.0001) rows.push([t('climate.inspect.water'), `${fmt(p.water * 1000, 1)} mm`]);
  rows.push([t('climate.inspect.soil'), `${fmt(p.soilWater, 1)} kg/m²${p.soilIce > 0.01 ? ` · ${t('climate.inspect.soilIce')} ${fmt(p.soilIce, 1)} kg/m²` : ''}`]);
  if (p.frostDepth > 0) rows.push([t('climate.inspect.frost'), `${fmt(p.frostDepth * 100, 0)} cm`]);
  rows.push([t('climate.inspect.solar'), `${fmt(p.solar, 0)} W/m² · α ${fmt(p.albedo, 2)}${p.shade ? ` · ${t('climate.inspect.shade')}` : ''}`]);
  rows.push([t('climate.inspect.friction'), fmt(p.friction, 2)]);
  if (p.freezeThaw > 0) rows.push([t('climate.inspect.freezeThaw'), String(p.freezeThaw)]);
  if (p.condensate > 0.001) rows.push([t('climate.inspect.condensate'), `${fmt(p.condensate, 2)} kg`]);
  return rows;
}

/**
 * Climate at the selected object (Phase 30): snow / ice on it (roof, crown, vehicle) and its load, the surface under
 * people (snow, ice, friction, movement) and their air-temperature exposure — no physiology. Computed values only.
 */
export function ClimateObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const r = simulationController.getEnvironment().climate.rt;
  if (!r) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e) return null;
  const p = e.pose.position;
  const rows = pointRows(r, p[0], p[2], t);
  const s = r.stores.find((x) => x.e === e);
  if (s) {
    const cw = r.cw, st = cw.stores[s.k];
    const M = cw.sM[s.k];
    rows.unshift(
      [t('climate.inspect.store'), `${fmt(M, 1)} kg · ${fmt(M / st.area, 1)} kg/m²${cw.sIce[s.k] > 0 ? ` · ${t('climate.inspect.storeIce')} ${fmt(cw.sIce[s.k], 1)} kg` : ''}`],
      [t('climate.inspect.load'), `${fmt((M * 9.81) / st.area / 1000, 3)} kPa · ${fmt(M * 9.81 / 1000, 2)} kN`],
    );
    if (M > 0) rows.unshift([t('climate.inspect.storeT'), C(cw.sT[s.k])]);
    if (st.kind === STORE.roof) rows.push([t('climate.inspect.structural'), t(e.climate?.applied ? 'climate.inspect.applied' : e.modular ? 'climate.inspect.screened' : 'climate.inspect.reported')]);
    if (st.kind === STORE.crown) {
      const cr = r.crownOf.get(e);
      if (cr) rows.push([t('climate.inspect.crownMoisture'), `${fmt(cr.u * 100, 0)} %`]);
    }
    if (cw.sGone[s.k]) rows.push([t('climate.inspect.dropped'), '✓']);
  }
  if (e.source.type === 'human' && e.climate) rows.push([t('climate.inspect.exposure'), `${C(e.climate.minAirT)} … ${C(e.climate.maxAirT)}${e.climate.restricted ? ` · ${t('climate.inspect.restricted')}` : ''}`]);
  return (
    <Section title={t('climate.inspect.title')}>
      <Rows testId="climate-object" rows={rows} />
      {e.source.type === 'human' && <div className={styles.note}>{t('climate.inspect.noPhysiology')}</div>}
      {e.source.type === 'car' && <div className={styles.note}>{t('climate.inspect.noTyre')}</div>}
    </Section>
  );
}

/** Climate at the probed ground point (Phase 30). */
export function ClimateProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.climate !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active || !probe) return null;
  const r = simulationController.getEnvironment().climate.rt;
  if (!r) return null;
  const rows = pointRows(r, probe.x, probe.z, t);
  rows.unshift([t('climate.probe.at'), `(${fmt(probe.x, 1)}, ${fmt(probe.z, 1)})`]);
  return (
    <Section title={t('climate.probe.title')}>
      <Rows testId="climate-probe" rows={rows} />
      <div className={styles.note}>{t('climate.probe.note')}</div>
    </Section>
  );
}
