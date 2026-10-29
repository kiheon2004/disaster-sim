import { Fragment } from 'react';
import { useT } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import { AIR_DENSITY } from '@/core/units';
import { Y_O2_AIR, boilingPoint } from '@/atmosphere/reference';
import { overlayValue } from '@/rendering/atmosphere/AtmosphereLayer';
import type { AtmosphereRuntime } from '@/simulation/atmosphere/runtime';
import styles from './Inspector.module.css';

const kPa = (p: number) => (Math.abs(p) >= 1000 ? `${fmt(p / 1000, 3)} kPa` : `${fmt(p, 2)} Pa`);
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

/** Air at a world point: pressure, density, temperature, the computed flow, O₂, smoke, gas, ash, and what changes it. */
function airRows(ar: AtmosphereRuntime, x: number, y: number, z: number, t: ReturnType<typeof useT>): { rows: [string, string][]; sources: string } {
  const a = ar.column(x, z), f = ar.field;
  const h = y - f.ground[a];
  const p = ar.pressureAt(x, y, z), rho = ar.densityAt(x, y, z), T = ar.temperatureAt(a, h);
  const flow: [number, number] = [0, 0];
  ar.flowAt(x, z, h, flow);
  const fire = simulationController.getEnvironment().fire.rt;
  const o2 = (Y_O2_AIR * f.layerMass(a) - (fire ? fire.fw.o2def[a] : 0)) / (f.H * f.area);
  const rows: [string, string][] = [
    [t('atmos.inspect.pressure'), kPa(p)],
    [t('atmos.inspect.change'), kPa((f.sigma[a] - f.sigma0[a]) * 9.81)],
    [t('atmos.inspect.density'), `${fmt(rho, 4)} kg/m³ · ${fmt((rho / AIR_DENSITY) * 100, 1)} %`],
    [t('atmos.inspect.temperature'), `${C(T)}${h > f.H ? ` · ${t('atmos.inspect.aloft')}` : ''}`],
    [t('atmos.inspect.flow'), `${fmt(Math.hypot(flow[0], flow[1]), 3)} m/s`],
    [t('atmos.inspect.o2'), `${fmt(o2, 4)} kg/m³ · ${fmt((o2 / Math.max(1e-12, f.layerDensity(a))) * 100, 1)} %`],
  ];
  const smoke = overlayValue('smoke', a, null), gas = overlayValue('gas', a, null);
  if (smoke > 0) rows.push([t('atmos.inspect.smoke'), `${fmt(smoke, 1)} mg/m³`]);
  if (gas > 0) rows.push([t('atmos.inspect.gas'), `${fmt(gas, 3)} g/m³`]);
  const up = ar.trt.world.air.updraft(a);
  if (up > 0) rows.push([t('atmos.inspect.updraft'), `${fmt(up, 2)} m/s`]);
  // What changes the air here (attribution by mechanism, not by object).
  const src: string[] = [];
  if (ar.spec.removal !== 'none') src.push(t(ar.spec.extent === 'local' ? 'atmos.inspect.src.sink' : 'atmos.inspect.src.removal'));
  if (ar.spec.restore && ar.spec.restore !== 'none') src.push(t(ar.spec.restore === 'boundary' ? 'atmos.inspect.src.boundary' : 'atmos.inspect.src.reservoir'));
  if (f.mass.boundaryIn + f.mass.boundaryOut > 0) src.push(t('atmos.inspect.src.edges'));
  if (gas > 0) src.push(t('atmos.inspect.src.volcano'));
  if (smoke > 0) src.push(t('atmos.inspect.src.fire'));
  if (up > 0) src.push(t('atmos.inspect.src.heat'));
  return { rows, sources: `${t('atmos.inspect.sources')}: ${src.length ? src.join(' · ') : t('atmos.inspect.src.none')}` };
}

/**
 * Atmosphere at the selected object (Phase 29): the air at its centre of pressure and the dynamic
 * pressure ½ρv² it feels (density ratio to the sea-level design value). Computed values only.
 */
export function AtmosphereObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const ar = simulationController.getEnvironment().atmosphere.rt;
  if (!ar) return null;
  const e = simulationController.getRuntime()?.entities.get(id);
  if (!e) return null;
  const p = e.pose.position;
  const y = p[1] + (e.copLocal?.[1] ?? 0);
  const { rows, sources } = airRows(ar, p[0], y, p[2], t);
  const rho = ar.densityAt(p[0], y, p[2]);
  rows.push([t('atmos.inspect.q'), `${fmt(0.5 * rho * e.windAtCop * e.windAtCop, 1)} Pa`]);
  return (
    <Section title={t('atmos.inspect.title')}>
      <Rows testId="atmos-object" rows={rows} />
      <div className={styles.note}>{sources}</div>
      {e.source.type === 'human' && <div className={styles.note}>{t('atmos.inspect.noPhysiology')}</div>}
    </Section>
  );
}

/** Atmosphere at the probed ground point (Phase 29) with its vertical profile and the water boiling point there. */
export function AtmosphereProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.atmosphere !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active || !probe) return null;
  const ar = simulationController.getEnvironment().atmosphere.rt;
  if (!ar) return null;
  const a = ar.column(probe.x, probe.z), g = ar.field.ground[a];
  const { rows, sources } = airRows(ar, probe.x, g + 1, probe.z, t);
  rows.unshift([t('atmos.probe.at'), `(${fmt(probe.x, 1)}, ${fmt(probe.z, 1)})`], [t('atmos.probe.ground'), `${fmt(g, 1)} m`]);
  for (const h of [0, 10, 100, 1000]) rows.push([`${t('atmos.probe.profile')} ${h} m`, `${kPa(ar.pressureAt(probe.x, g + h, probe.z))} · ${fmt(ar.densityAt(probe.x, g + h, probe.z), 3)}`]);
  rows.push([t('atmos.probe.boiling'), C(boilingPoint(ar.field.surfacePressure(a)))]);
  return (
    <Section title={t('atmos.probe.title')}>
      <Rows testId="atmos-probe" rows={rows} />
      <div className={styles.note}>{sources}</div>
      <div className={styles.note}>{t('atmos.probe.note')}</div>
    </Section>
  );
}
