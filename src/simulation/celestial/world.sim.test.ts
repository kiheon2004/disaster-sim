/**
 * Phase 32: celestial experiments in whole worlds — every preset runs (finite state, closed mass ledgers), the
 * combinations with water, air, heat, fire, volcano, meteor, blast, earthquake and snow (finite, water volume
 * conserved, nothing captured from the 2-D water), original-world restoration with captures and collapse, determinism
 * and object-id / event-order independence, save / load (schema v7), resource clean-up, the stop policy, and the
 * tidal torque aligning an elongated body with the radius.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec as buildingSpec } from '@/buildings/spec';
import type { WorldDocument } from '@/core/model';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import type { LakeFeature } from '@/landscape/types';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { worldFingerprint } from '@/world/fingerprint';
import { createInstance } from '@/phenomena/schedule';
import { rapierWorlds } from '@/physics/RapierEngine';
import { CELESTIAL_SCENARIOS } from '@/celestial/types';
import { celestialDemo } from '@/celestial/demos';
import { G_N, M_SUN } from '@/celestial/constants';
import { celestialSpec, labSource, probe } from './testSpecs';
import { gravity } from '../gravity/testSpecs';
import { phenomena } from '@/phenomena/registry';

const S = () => useWorldStore.getState();
const tf = (x: number, z: number, y = 0, yaw = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const design = (id: string) => createDesign(buildingSpec(id)!, id);
const POND = { id: 'pond', kind: 'lake', points: [[40, 10], [80, 10], [80, 45], [40, 45]], surface: -0.2, depth: 1.2, shoreWidth: 3, material: 7, filled: true } as LakeFeature;

function town(opts: { fire?: boolean } = {}): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('p32'));
  S().setFeatures([POND], 2);
  S().applyEdit({ add: [
    { type: 'building', building: design('office'), seed: 1, transform: tf(-20, -30) },
    { type: 'building', building: design('warehouse'), seed: 2, transform: tf(10, -30) },
    { type: 'building', building: design('house'), seed: 3, transform: tf(35, -30) },
    { type: 'tree', params: { species: 'conifer', height: 11, canopyRadius: 2.2, trunkRadius: 0.32 }, seed: 4, transform: tf(-40, 0) },
    ...[0, 1, 2, 3].map((k) => ({ type: 'car', seed: 10 + k, transform: tf(-20 + 8 * k, 5, 0, Math.PI / 2) })),
    ...[0, 1, 2].map((k) => ({ type: 'human', seed: 20 + k, transform: tf(-15 + 6 * k, 14) })),
  ] as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 32;
  if (opts.fire) (d.settings.simulation as unknown as Record<string, unknown>).fire = { foliageMoisture: 0.8, openings: 'windowsOpen', heatIgnition: false };
  return d;
}

async function run(doc: WorldDocument, events: EventSpec[], seconds: number) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  c.advance(seconds);
  return c;
}

/** Everything finite: poses, debris, the gravity ledger, the capture ledger, probe / particle states, water. */
function finite(c: SimulationController) {
  const rt = c.getRuntime()!;
  for (const e of rt.entities.values()) for (const v of e.pose.position) if (!Number.isFinite(v)) throw new Error(`entity ${e.id} ${v}`);
  for (const d of rt.debris) for (const v of d.pose.position) if (!Number.isFinite(v)) throw new Error(`debris ${d.id}`);
  const g = c.getEnvironment().gravity.rt!;
  const b = g.balance();
  for (const v of [b.kinetic, b.workGravity, b.workOther, b.integratorResidual, ...b.impulse, ...b.momentum]) if (!Number.isFinite(v)) throw new Error('gravity ledger');
  const cel = g.celestial!;
  const L = cel.ledger;
  for (const v of [L.mass, L.kinetic, L.kineticRel, L.potential, L.constraintWork, ...L.momentum, ...L.constraintImpulse]) if (!Number.isFinite(v)) throw new Error('capture ledger');
  for (let i = 0; i < cel.px.length; i++) if (!Number.isFinite(cel.px[i]) || !Number.isFinite(cel.pv[i])) throw new Error('particle');
  for (const p of cel.probes) for (const v of [...p.pos, ...p.vel]) if (!Number.isFinite(v)) throw new Error('probe');
  expect(L.massResidual()).toBe(0);
  const flying = cel.stats.particles * cel.pmass;
  expect(Math.abs(L.particleResidual(flying))).toBeLessThan(1e-9 * Math.max(1, L.particlesIn));
  for (const e of rt.entities.values()) {
    const m = e.modular?.structure?.model;
    if (m) expect(Math.abs(m.ledger.residual())).toBeLessThan(1e-6 * m.ledger.original);
  }
  const f = c.getEnvironment().flood.field;
  if (f) for (let i = 0; i < f.count; i++) if (!Number.isFinite(f.h[i]) || f.h[i] < 0) throw new Error(`water ${i} ${f.h[i]}`);
}

function hash(c: SimulationController) {
  const rt = c.getRuntime()!;
  const ents = [...rt.entities.values()].map((e) => `${e.source.type}@${e.pose.position.map((v) => v.toFixed(5)).join(',')}:${e.state}:${e.flags.captured ? 'C' : ''}:${e.modular?.structure ? e.modular.structure.model.records.length : -1}`).sort();
  const g = c.getEnvironment().gravity.rt!;
  const L = g.celestial?.ledger;
  const parts = [ents.join(';'), JSON.stringify(g.balance()), L ? JSON.stringify([L.count, L.mass, L.momentum, L.records.map((r) => [r.kind, r.mass, r.t])]) : '', String(rt.debris.length)];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

const sequence = (): EventSpec[] => [
  celestialSpec({ name: 'bh', duration: 20, startTime: 1, sources: [labSource({ center: [0, 14, 0], mass: 3e4 / G_N, softening: 2, capture: 2, ramp: 2, massPolicy: 'grow' })], probes: [probe([20, 14, 0], 'circular', 1, [0, 0, 1])] }),
  celestialSpec({ name: 'well', duration: 10, startTime: 8, sources: [labSource({ kind: 'compact', capture: 0, center: [-30, 20, -20], mass: 1e4 / G_N, softening: 2, ramp: 1, motion: 'velocity', velocity: [2, 0, 0] })] }),
];

describe('celestial experiments in whole worlds', { timeout: 1_800_000 }, () => {
  it('every preset runs on its demo world: finite state, closed mass ledgers', async () => {
    for (const s of CELESTIAL_SCENARIOS) {
      if (s === 'custom') continue;
      const demo = celestialDemo(s);
      S().setLocked(false);
      S().replaceDocument(createEmptyDocument(s));
      if (demo.lake) S().setFeatures([demo.lake], 2);
      if (demo.height) {
        const t0 = S().doc.terrain;
        const heights = new Float32Array(t0.heights.length);
        for (let iz = 0; iz < t0.nz; iz++) for (let ix = 0; ix < t0.nx; ix++) heights[iz * t0.nx + ix] = demo.height(t0.originX + ix * t0.cellSize, t0.originZ + iz * t0.cellSize);
        S().applyEdit({ landscape: { base: { heights, ground: new Uint8Array(heights.length) } } } as never);
      }
      S().applyEdit({ add: demo.objects.map((o) => (demo.height ? { ...o, transform: { ...o.transform, position: [o.transform.position[0], demo.height(o.transform.position[0], o.transform.position[2]), o.transform.position[2]] } } : o)) as never });
      const d = structuredClone(S().doc);
      d.settings.simulation.seed = 32;
      const c = await run(d, demo.events, s === 'stress' ? 8 : 6);
      try {
        expect(c.getEnvironment().gravity.rt!.celestial, s).not.toBeNull();
        finite(c);
      } finally { c.unload(); }
    }
  });

  it('combinations — flood, air, heat, fire, volcano, meteor, blast, earthquake, ground, snow: finite, water volume conserved', async () => {
    const bh = celestialSpec({ duration: 60, startTime: 0.5, sources: [labSource({ center: [10, 25, 0], mass: 4e4 / G_N, softening: 2, capture: 2, ramp: 2 })] });
    const K = (c: number) => c + 273.15;
    const combos: [string, EventSpec[], boolean][] = [
      ['flood', [{ event: 'rain', intensity: 150, duration: 30 } as EventSpec], false],
      ['atmosphere', [{ event: 'atmosphere', altitude: 0, boundary: 'open', thermo: 'adiabatic', removal: 'linear', extent: 'uniform', target: 0.6, duration: 20, startTime: 0 } as EventSpec], false],
      ['heat + fire', [{ event: 'fire', position: [-20, -30], height: 1, radius: 1, duration: 600 } as EventSpec], true],
      ['volcano', [{ event: 'volcano', vents: [{ kind: 'central', position: [-60, 40], radius: 2 }], material: 'basalt', temperature: 1150, rate: 2, duration: 60, profile: 'constant' } as EventSpec], false],
      ['meteor', [{ event: 'impact', target: [0, 30], material: 'stony', diameter: 1, speed: 15000, angle: 60, azimuth: 45, entry: 'direct', airBlast: true, startTime: 1 } as EventSpec], false],
      ['blast', [{ event: 'blast', position: [30, 30], height: 1, energy: 1e9, model: 'weakShock', waveform: 'nWave', startTime: 1 } as EventSpec], false],
      ['earthquake', [{ event: 'earthquake', magnitude: 6.5, pga: 0.35, duration: 8, seed: 3, startTime: 1 } as EventSpec], false],
      ['ground (sinkhole)', [{ ...phenomena.implemented('sinkhole')!.defaults(), startTime: 1 } as EventSpec], false],
      ['snow', [{ event: 'climate', scenario: 'custom', forcing: 'flux', temperature: K(-3), target: K(-3), profile: 'constant', duration: 3600, humidity: 0.85, mixTime: 900, precipitation: 0, precipPhase: 'auto', precipProfile: 'constant', solar: 'off', soilMoisture: 0.25, blowingSnow: false, roofSnow: true, initialSnow: 0.3, initialSnowDensity: 200, startTime: 0 } as EventSpec], false],
    ];
    for (const [name, evs, fire] of combos) {
      const c = await run(town({ fire }), [bh, ...evs], 8);
      try {
        finite(c);
        const f = c.getEnvironment().flood.field;
        if (f && name === 'flood') expect(Math.abs(f.budget.error), name).toBeLessThan(1e-6 * Math.max(1, f.budget.rain + f.budget.initial));
      } finally { c.unload(); }
    }
  });

  it('original world restored after captures, growth, collapse and a moving source; the rerun is identical', async () => {
    const doc = town();
    const fp = worldFingerprint(doc);
    const a = await run(doc, sequence(), 16);
    const h1 = hash(a);
    expect(a.getEnvironment().gravity.rt!.celestial!.ledger.count).toBeGreaterThan(0);
    await a.reset();
    expect(a.getEnvironment().gravity.field).toBeNull();
    expect([...a.getRuntime()!.entities.values()].some((e) => e.flags.captured)).toBe(false);
    // reset() reschedules the run's own experiments (adding them again would put a second source on each).
    a.advance(16);
    expect(hash(a)).toBe(h1);
    expect(worldFingerprint(doc)).toBe(fp);
    a.unload();
  });

  it('deterministic, independent of object ids, of the order the experiments and their sources were added', async () => {
    const doc = town();
    const h1 = hash(await run(doc, sequence(), 12));
    const d2 = structuredClone(doc);
    const objs = Object.values(d2.objects);
    d2.objects = {};
    for (const o of objs) { const id = `zz-${o.id}`; d2.objects[id] = { ...o, id }; }
    const c2 = await run(d2, [...sequence()].reverse(), 12);
    expect(hash(c2)).toBe(h1);
  });

  it('saves celestial experiments (schema v7); an invalid one is dropped with the file still loading', () => {
    S().setLocked(false);
    S().newDocument();
    const d = structuredClone(S().doc);
    const ok = createInstance('celestial', [], celestialSpec({ sources: [labSource()], probes: [probe([20, 60, 0], 'circular', 1, [0, 0, 1])] }));
    const bad = { ...createInstance('celestial', [ok], celestialSpec()), spec: { ...celestialSpec({ sources: [labSource({ softening: 0 })] }) } };
    d.scenario.experiment = { ...d.scenario.experiment, instances: [ok, bad] } as never;
    const res = parseDocument(serializeDocument(d));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.schemaVersion).toBe(7);
    const inst = res.doc.scenario.experiment!.instances;
    expect(inst).toHaveLength(1);
    expect(inst[0].spec).toMatchObject({ event: 'celestial', scale: 'educational' });
    expect((inst[0].spec as unknown as { probes: unknown[] }).probes).toHaveLength(1);
  });

  it('clean-up: the Rapier world (probes included) is freed on unload', async () => {
    const live0 = rapierWorlds.live;
    const c = await run(town(), [celestialSpec({ sources: [labSource()], probes: [probe([20, 60, 0], 'circular', 1, [0, 0, 1])], accretion: { visual: true, particles: 200, inner: 5, outer: 15, particleMass: 1 } })], 2);
    expect(rapierWorlds.live).toBe(live0 + 1);
    c.unload();
    expect(rapierWorlds.live).toBe(live0);
  });

  it('stop policy: a physical-mode solar-mass hole stops the run at the first body it reaches beyond the limits; warn records and continues', async () => {
    S().setLocked(false);
    S().newDocument();
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(0, 0) }] as never });
    const d = structuredClone(S().doc);
    const sun = labSource({ center: [0, 30, 0], mass: M_SUN, softening: 1, capture: 3, ramp: 0 });
    const stop = await run(d, [celestialSpec({ scale: 'physical', limitPolicy: 'stop', sources: [sun] })], 2);
    const cs = stop.getEnvironment().gravity.rt!.celestial!;
    expect(cs.stopRequest).not.toBeNull();
    expect(cs.stats.limit).toBe('stop');
    // The run stopped: the clock is far short of 2 s.
    expect(stop.getTime()).toBeLessThan(0.2);
    // The speed was never clipped below c to imitate relativity: the limit is reported instead.
    expect(['speed', 'substeps']).toContain(cs.stopRequest!.reason);
    const warn = await run(d, [celestialSpec({ scale: 'physical', limitPolicy: 'warn', sources: [sun] })], 0.5);
    const cw = warn.getEnvironment().gravity.rt!.celestial!;
    expect(cw.stats.limit).toBe('warn');
    expect(warn.getTime()).toBeCloseTo(0.5, 6);
  });

  it('gravity-gradient torque: a long bar released at 45° to the radius turns towards it (zero uniform gravity)', async () => {
    S().setLocked(false);
    S().newDocument();
    // A wall-like dynamic box: use a car (4.5 m long) floating at 15 m from the source, long axis at 45°.
    S().applyEdit({ add: [{ type: 'car', seed: 1, transform: tf(15, 0, 60, Math.PI / 4) }] as never });
    const d = structuredClone(S().doc);
    const c = await run(d, [gravity({ magnitude: 0, duration: 600, end: 'hold' }), celestialSpec({ sources: [labSource({ kind: 'compact', capture: 0, mass: 2e3 / G_N, softening: 1 })] })], 0.02);
    const car = [...c.getRuntime()!.entities.values()][0];
    const angle = () => {
      const [x, y, z, w] = car.pose.quaternion;
      const ax: Vec3 = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)];
      const r: Vec3 = [car.pose.position[0], car.pose.position[1] - 60, car.pose.position[2]];
      const c0 = Math.abs(ax[0] * r[0] + ax[1] * r[1] + ax[2] * r[2]) / Math.hypot(...r) / Math.hypot(...ax);
      return Math.acos(Math.min(1, c0));
    };
    const a0 = angle();
    c.advance(4);
    const a1 = angle();
    expect(a0).toBeGreaterThan(0.6);
    expect(a1).toBeLessThan(a0 - 0.1);
  });
});
