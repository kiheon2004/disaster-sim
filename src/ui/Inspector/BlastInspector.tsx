import { Fragment } from 'react';
import { useT, type MessageKey } from '@/i18n/i18n';
import type { EntityId, Vec3 } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '@/rendering/viewStore';
import { FIELD_HEIGHT } from '@/blast/plan';
import { peakOf, positiveImpulseOf, pressure, type Arrival } from '@/blast/pulse';
import { ShieldIndex, shielding, type Contribution, type ShieldBox } from '@/blast/wave';
import { obstacleFromEntity } from '@/simulation/wind/obstacles';
import { Section } from '@/ui/common/Panel';
import { fmt } from '@/ui/format';
import styles from './Inspector.module.css';

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

const NEAR = 30;
let shieldCache: { rev: number; rt: unknown; index: ShieldIndex } | null = null;

function shieldIndex(): ShieldIndex | null {
  const rt = simulationController.getRuntime();
  if (!rt) return null;
  if (shieldCache && shieldCache.rt === rt && shieldCache.rev === rt.debrisRev) return shieldCache.index;
  const boxes: ShieldBox[] = [];
  for (const e of rt.entities.values()) {
    if (e.flags.collapsed) continue;
    const o = obstacleFromEntity(e);
    if (o) boxes.push(o);
  }
  shieldCache = { rev: rt.debrisRev, rt, index: new ShieldIndex(boxes) };
  return shieldCache.index;
}

/**
 * The air-pressure field at the clicked point (Phase 24): per wave its arrival, peak overpressure,
 * positive impulse and duration (computed with the run's shielding), the overpressure now, the
 * ambient pressure, exposure classification and model-validity zone, and the objects nearby that the
 * wave loaded.
 */
export function BlastProbeSection() {
  const t = useT();
  const time = useSimStore((s) => s.time);
  const active = useSimStore((s) => s.blasts !== null);
  const probe = useViewStore((s) => s.waterProbe);
  if (!active) return null;
  const env = simulationController.getEnvironment();
  if (!probe) {
    return (
      <Section title={t('blast.inspect.title')}>
        <div className={styles.note}>{t('deform.inspect.hint')}</div>
      </Section>
    );
  }
  const { x, z } = probe;
  const p: Vec3 = [x, env.terrain.sampleHeight(x, z) + FIELD_HEIGHT, z];
  const index = shieldIndex();
  const rows: [string, string][] = [[t('flood.inspect.position'), `${fmt(x, 1)}, ${fmt(z, 1)} (${t('blast.inspect.height', { h: FIELD_HEIGHT })})`]];
  const all: Contribution[] = [];
  for (const rec of env.blast.waves) {
    const w = rec.wave;
    const s = w.sample(Math.hypot(p[0] - w.init.position[0], p[1] - w.init.position[1], p[2] - w.init.position[2]));
    const sh = shielding(w.init.position, p, s.T, w.sourceAmbient.c, env.terrain, index);
    const cs = w.contributions(p, sh, []);
    all.push(...cs);
    const first = Math.min(...cs.map((c) => c.t));
    const exposure = sh.kind === 'direct' ? t('blast.exposure.direct') : `${t(`blast.exposure.${sh.kind}` as MessageKey)} −${fmt(sh.il, 1)} dB`;
    const zone = cs.reduce((a, c) => (['weak', 'transition', 'strong', 'core'].indexOf(c.zone) > ['weak', 'transition', 'strong', 'core'].indexOf(a) ? c.zone : a), 'weak' as Contribution['zone']);
    rows.push(
      [t('blast.inspect.source'), `${w.init.name} · ${w.init.source}`],
      [t('blast.inspect.ambient'), `${fmt(s.p / 1000, 2)} kPa`],
      [t('blast.inspect.arrival'), `${fmt((first - w.init.time) * 1000, 0)} ms (${t('blast.inspect.at')} ${fmt(first, 3)} s)`],
      [t('blast.inspect.peak'), `${fmt(peakOf(cs) / 1000, 3)} kPa (${fmt(peakOf(cs) / s.p, 3)} p₀)`],
      [t('blast.inspect.impulse'), `${fmt(positiveImpulseOf(cs), 1)} Pa·s · T₊ ${fmt(cs[0]?.T * 1000, 1)} ms`],
      [t('blast.inspect.exposure'), `${exposure}${cs.some((c) => c.path === 'image') ? ` · ${t('blast.exposure.reflected')}` : ''}`],
      [t('blast.inspect.zone'), t(`blast.zone.${zone}` as MessageKey)],
    );
  }
  let now = 0;
  for (const c of all) now += pressure(c as Arrival, time);
  rows.splice(1, 0, [t('blast.inspect.now'), `${now >= 0 ? '+' : '−'}${fmt(Math.abs(now) / 1000, 3)} kPa`]);
  const rt = simulationController.getRuntime();
  const near: { d: number; text: string }[] = [];
  if (rt) for (const e of rt.entities.values()) {
    const b = e.blast;
    if (!b) continue;
    const d = Math.hypot(e.pose.position[0] - x, e.pose.position[2] - z);
    if (d > NEAR) continue;
    near.push({ d, text: t('blast.inspect.objectRow', { name: e.source.name ?? e.id, d: fmt(d, 0), p: fmt(b.peak / 1000, 1), J: fmt(b.J / 1000, 2), n: b.broken }) });
  }
  near.sort((a, b) => a.d - b.d);
  for (const n of near.slice(0, 5)) rows.push([t('blast.inspect.object'), n.text]);
  return (
    <Section title={t('blast.inspect.title')}>
      <Rows rows={rows} testId="blast-inspector" />
      <div className={styles.note}>{t('blast.inspect.note')}</div>
    </Section>
  );
}

/** Air-blast response of the selected object (Phase 24). */
export function BlastObjectSection({ id }: { id: EntityId }) {
  const t = useT();
  useSimStore((s) => s.time);
  const e = simulationController.getRuntime()?.entities.get(id);
  const b = e?.blast;
  if (!e || !b) return null;
  const rows: [string, string][] = [
    [t('blast.obj.peak'), `${fmt(b.peak / 1000, 2)} kPa`],
    [t('blast.obj.impulse'), `${fmt(b.impulse, 1)} Pa·s`],
    [t('blast.obj.arrival'), `${fmt(b.arrival, 3)} s`],
    [t('blast.inspect.exposure'), b.exposure === 'direct' ? t('blast.exposure.direct') : `${t(`blast.exposure.${b.exposure}` as MessageKey)} −${fmt(b.il, 1)} dB`],
    [t('blast.inspect.zone'), t(`blast.zone.${b.zone}` as MessageKey)],
    [t('blast.obj.mechanical'), `${fmt(b.J / 1000, 3)} kN·s · ${t('blast.obj.peakForce')} ${fmt(b.peakForce / 1000, 1)} kN`],
  ];
  if (b.aEq > 0) rows.push([t('blast.obj.aEq'), `${fmt(b.aEq / 9.81, 2)} g (${t('blast.obj.aEqNote')})`]);
  if (e.source.type === 'human') rows.push([t('blast.obj.dv'), `${fmt(b.dvPeak, 2)} m/s`]);
  if (b.broken) rows.push([t('blast.obj.broken'), `${b.broken}`]);
  if (b.sdof) rows.push([t('blast.obj.moment'), `${fmt(b.sdof.peak, 2)} × ${t('blast.obj.capacity')}`]);
  rows.push([t('deform.inspect.source'), b.source]);
  return (
    <Section title={t('blast.obj.title')}>
      <Rows rows={rows} testId="blast-object" />
      <div className={styles.note}>{t(e.source.type === 'human' ? 'blast.obj.noteHuman' : 'blast.obj.note')}</div>
    </Section>
  );
}
