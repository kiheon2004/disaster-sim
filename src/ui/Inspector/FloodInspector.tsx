import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId } from '@/core/types';
import { nearestCompass } from '@/core/compass';
import { GRAVITY } from '@/core/units';
import { groundMaterial } from '@/terrain/GroundMaterials';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { FLOOD_DEPTH } from '@/simulation/water/waterParams';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

/** Bearing (deg, 0 = N, 90 = E) the water flows TOWARD, from a world velocity (x = E, z = S). */
export function flowBearing(vx: number, vz: number): number {
  return ((Math.atan2(vx, -vz) * 180) / Math.PI + 360) % 360;
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <div className={styles.liveGrid} data-testid="flood-inspector">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Water at the point clicked on the ground (simulation mode). */
export function FloodProbeSection() {
  const t = useT();
  useSimStore((s) => s.time);
  const active = useSimStore((s) => s.flood !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  if (!probe) {
    return (
      <Section title={t('flood.inspect.title')}>
        <div className={styles.note}>{t('flood.inspect.hint')}</div>
      </Section>
    );
  }
  const env = simulationController.getEnvironment();
  const field = env.flood.field;
  const ground = env.terrain.sampleHeight(probe.x, probe.z);
  const cell = field?.sampleCell(probe.x, probe.z) ?? null;
  const eta = field?.sampleSurface(probe.x, probe.z) ?? -Infinity;
  const depth = eta === -Infinity ? 0 : Math.max(0, eta - ground);
  const vel: [number, number] = [0, 0];
  field?.sampleVelocity(probe.x, probe.z, vel);
  const speed = depth > 0.005 ? Math.hypot(vel[0], vel[1]) : 0;
  const bearing = flowBearing(vel[0], vel[1]);
  const groundLabel = !cell ? t(groundMaterial(env.terrain.sampleGroundType(probe.x, probe.z)).labelKey)
    : cell.blocked ? t('flood.inspect.building')
      : cell.ground === 255 ? t('flood.inspect.road')
        : t(groundMaterial(cell.ground).labelKey);
  const ref = env.terrain.data.settings.waterLevel;
  const rows: [string, string][] = [
    [t('flood.inspect.position'), `${fmt(probe.x, 1)}, ${fmt(probe.z, 1)}`],
    [t('flood.inspect.elevation'), `${fmt(ground, 2)} m`],
    [t('flood.inspect.surface'), depth > 0.001 ? `${fmt(eta, 2)} m` : t('flood.inspect.dry')],
    [t('flood.inspect.depth'), `${fmt(depth, 3)} m`],
    [t('flood.inspect.speed'), `${fmt(speed, 2)} m/s`],
    [t('flood.inspect.direction'), speed > 0.02 ? t('flood.inspect.toward', { dir: t(`compass.${nearestCompass(bearing)}` as MessageKey), deg: Math.round(bearing) }) : '–'],
    [t('flood.inspect.ground'), groundLabel],
  ];
  if (ref !== null) rows.push([t('flood.inspect.reference'), `${fmt(ref, 2)} m`]);
  if (cell && field) {
    rows.push(
      [t('flood.inspect.maxDepth'), `${fmt(field.maxDepth[cell.index], 2)} m`],
      [t('flood.inspect.floodTime'), `${fmt(field.floodTime[cell.index], 0)} s`],
      [t('flood.inspect.infiltrated'), `${fmt(field.infiltrated[cell.index] * 1000, 1)} mm`],
    );
  }
  return (
    <Section title={t('flood.inspect.title')}>
      <Rows rows={rows} />
      <div className={styles.note}>{t('flood.badge')} · <button onClick={() => useViewStore.getState().setWaterProbe(null)} style={{ fontSize: 10.5, padding: '0 6px' }}>{t('flood.inspect.clear')}</button></div>
    </Section>
  );
}

/** Live flood response of the selected object (simulation mode). */
export function FloodLiveSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  const st = e?.flood;
  if (!e || !st) return null;
  const type = e.source.type;
  const rows: [string, string][] = [
    [t('live.flood.depth'), `${fmt(st.depth, 2)} m`],
    [t('live.flood.speed'), `${fmt(st.speed, 2)} m/s`],
    [t('live.flood.exposure'), `${fmt(st.exposure, 0)} s (≥ ${FLOOD_DEPTH} m)`],
  ];
  if (e.dynamic) {
    rows.push([t('live.flood.submerged'), `${Math.round(st.submerged * 100)} %`], [t('live.flood.buoyancy'), `${fmt(st.buoyancyRatio, 2)} (${fmt(st.buoyancy / 1000, 2)} kN / ${fmt((e.source.physics.mass * simulationController.getEnvironment().gravity.down(e.pose.position[0], e.pose.position[1], e.pose.position[2], GRAVITY)) / 1000, 2)} kN)`]);
  }
  if (type === 'building') {
    rows.push(
      [t('live.flood.inside'), `${fmt(st.inside, 2)} m`],
      [t('live.flood.finish'), `${Math.round(st.finish * 100)} %`],
      [t('live.flood.load'), `${fmt(st.loadRatio * 100, 0)} %`],
      [t('live.flood.structure'), fmt(st.damage, 3)],
    );
  } else if (type === 'car') {
    rows.push([t('live.flood.ingress'), `${Math.round(st.ingress * 100)} %`]);
  } else if (type === 'human') {
    rows.push([t('live.flood.load'), `${fmt(st.loadRatio * 100, 0)} %`], [t('live.flood.balance'), `${Math.round(st.balance * 100)} %`]);
  } else if (type === 'streetLight' || type === 'sign' || type === 'wall') {
    rows.push([t('live.flood.load'), `${fmt(st.loadRatio * 100, 0)} %`]);
  }
  rows.push([t('live.flood.health'), `${Math.round((1 - st.health) * 100)} %`]);
  return (
    <Section title={t('live.flood.title')}>
      <Rows rows={rows} />
      <div className={styles.note}>{t('live.flood.note')}</div>
    </Section>
  );
}
