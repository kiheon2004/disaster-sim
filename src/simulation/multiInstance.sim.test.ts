/**
 * Phase 35.5: independent instances of the same phenomenon — deterministic keys and names, coexistence (no supersede),
 * earthquake superposition (one earthquake = the single-source field), area-rain cells, per-instance controls (cancel,
 * stop, pause / resume) replayed exactly after a reset, the heat-source stop, and the placed vortex wind (profile,
 * superposition, forces through the existing wind path).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { resolveEarthquake } from '@/events/earthquake/resolveEarthquake';
import type { EarthquakeEventSpec, EventSpec } from '@/events/specs';
import { createGroundMotionSample, createWaveform, GroundMotionField } from '@/simulation/seismic/GroundMotionField';
import { EventScheduler } from '@/events/EventScheduler';
import type { SimulationEvent } from '@/events/SimulationEvent';
import type { BlastSpec } from '@/blast/types';
import type { HeatSourceSpec } from '@/thermal/types';
import type { TornadoSpec } from '@/vortex/types';
import { addVortexWind, hollandShape, vortexState } from '@/vortex/model';
import { buildWorld, car } from '@/human/demos';
import { FORCE_SOURCES } from '@/simulation/forces/ForceLedger';
import { phenomena } from '@/phenomena/registry';

const S = () => useWorldStore.getState();
const flat = () => {
  S().setLocked(false);
  S().newDocument();
  return structuredClone(S().doc);
};
beforeEach(() => flat());

const Q1: EarthquakeEventSpec = { event: 'earthquake', magnitude: 6.5, pga: 0.3, duration: 20, dominantFrequency: 2, seed: 7, epicenter: [-40_000, 0] };
const Q2: EarthquakeEventSpec = { event: 'earthquake', magnitude: 5.8, pga: 0.2, duration: 15, dominantFrequency: 3.5, seed: 11, epicenter: [0, 30_000], direction: 30 };

function quakeField(...specs: [EarthquakeEventSpec, number][]) {
  const f = new GroundMotionField(new TerrainSampler(createFlatTerrain()));
  specs.forEach(([s, t0], k) => {
    const q = resolveEarthquake(s, 1);
    f.start(q, createWaveform(q), t0, `q${k}`);
  });
  return f;
}

describe('earthquakes superpose', () => {
  it('two earthquakes = the sum of each alone (d, v, a; every axis), at several points and times', () => {
    const both = quakeField([Q1, 0], [Q2, 4]);
    const a = quakeField([Q1, 0]);
    const b = quakeField([Q2, 4]);
    const sAB = createGroundMotionSample(), sA = createGroundMotionSample(), sB = createGroundMotionSample();
    let checked = 0;
    for (const [x, z] of [[0, 0], [60, -30], [-90, 80]]) for (let t = 0; t < 22; t += 0.37) {
      both.sample(x, z, t, sAB); a.sample(x, z, t, sA); b.sample(x, z, t, sB);
      for (const k of ['d', 'v', 'a'] as const) for (let i = 0; i < 3; i++) {
        const ref = sA[k][i] + sB[k][i];
        expect(Math.abs(sAB[k][i] - ref)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(ref)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('one earthquake: bit-identical to the single-source field (default id), and stopping one leaves the other', () => {
    const q = resolveEarthquake(Q1, 1);
    const f1 = new GroundMotionField(new TerrainSampler(createFlatTerrain()));
    f1.start(q, createWaveform(q), 0);
    const f2 = quakeField([Q1, 0]);
    const s1 = createGroundMotionSample(), s2 = createGroundMotionSample();
    for (let t = 0; t < 20; t += 0.13) {
      f1.sample(13, -27, t, s1); f2.sample(13, -27, t, s2);
      expect([...s2.d, ...s2.v, ...s2.a]).toEqual([...s1.d, ...s1.v, ...s1.a]);
    }
    const both = quakeField([Q1, 0], [Q2, 0]);
    both.stop('q0');
    expect(both.activeQuakes()).toEqual(['q1']);
    const b = quakeField([Q2, 0]);
    const sb = createGroundMotionSample();
    both.sample(5, 5, 7, s1); b.sample(5, 5, 7, sb);
    expect([...s1.a]).toEqual([...sb.a]);
  });

  it('in a run, two earthquakes both stay active (no supersede) and the field shakes with both', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(flat());
    c.addEvent({ ...Q1, startTime: 0 });
    c.addEvent({ ...Q2, startTime: 2 });
    c.advance(5);
    const st = c.instances();
    expect(st.map((i) => [i.key, i.status])).toEqual([['earthquake#1', 'active'], ['earthquake#2', 'active']]);
    expect(c.getEnvironment().groundMotion.activeQuakes().length).toBe(2);
    c.unload();
  });
});

describe('instances: keys, names, coexistence', () => {
  it('direct starts get "<type>#<n>" keys and named phenomena get their key as source name; experiment ids are kept', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(flat());
    const bl = (x: number): BlastSpec => ({ event: 'blast', position: [x, 0], height: 1, energy: 1e6, model: 'weakShock', waveform: 'nWave', startTime: 0.2 });
    expect(c.addEvent(bl(-50))).toBe('blast#1');
    expect(c.addEvent(bl(50))).toBe('blast#2');
    expect(c.addEvent(bl(0), { key: 'p7' })).toBe('p7');
    expect(c.addEvent(bl(10), { key: 'p7' })).toBe('p7~2');
    expect(c.instances().map((i) => (i.spec as BlastSpec).name)).toEqual(['blast#1', 'blast#2', 'p7', 'p7~2']);
    c.advance(1);
    // Four independent waves in the pressure channel, one ledger each.
    expect(c.getEnvironment().blast.ledger(c.getTime()).length).toBe(4);
    expect(c.instances().every((i) => i.status === 'active' || i.status === 'done')).toBe(true);
    c.unload();
  });

  it('area rain cells coexist (separate channels); a second map-wide rain still replaces the first', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(flat());
    c.addEvent({ event: 'rain', intensity: 50, duration: 60, area: { center: [-40, 0], radius: 20 }, startTime: 0 });
    c.addEvent({ event: 'rain', intensity: 80, duration: 60, area: { center: [40, 0], radius: 20 }, startTime: 0 });
    c.addEvent({ event: 'rain', intensity: 10, duration: 60, startTime: 0 });
    c.addEvent({ event: 'rain', intensity: 20, duration: 60, startTime: 1 });
    c.advance(3);
    expect(c.instances().map((i) => i.status)).toEqual(['active', 'active', 'superseded', 'active']);
    c.unload();
  });
});

/** A trivial sustained event that counts its updates (scheduler-level checks). */
function counter(id: string, start: number, duration: number) {
  const log: string[] = [];
  const ev: SimulationEvent = {
    id, type: 'wind', channel: `c:${id}`, spec: { event: 'wind', speed: 1, direction: 0, duration } as EventSpec, startTime: start, duration,
    onStart: () => log.push('start'), update: (_c, local) => log.push(`u${local.toFixed(1)}`), onEnd: (_c, r) => log.push(`end:${r}`),
    stop: () => log.push('stop'), pause: () => log.push('pause'), resume: (_c, shift) => log.push(`resume+${shift}`),
    intensityAt: () => 1, describe: () => ({ key: 'app.title' }),
  };
  return { ev, log };
}

describe('per-instance controls', () => {
  it('scheduler: cancel before start, pause freezes the local clock, resume continues, stop ends early', () => {
    const s = new EventScheduler();
    const a = counter('a', 0, 3), b = counter('b', 5, 1);
    s.add(a.ev, 'A');
    s.add(b.ev, 'B');
    const ctx = { env: null as never, time: 0 };
    const step = () => { s.update(ctx, 1); ctx.time += 1; };
    step(); // t0: A starts, u0
    s.control('A', 'pause', 1);
    s.control('B', 'cancel', 1);
    step(); step(); // t1 pause (no update), t2 paused
    s.control('A', 'resume', 3);
    step(); step(); // t3 resume (+2), local 1; t4 local 2
    s.control('A', 'stop', 5);
    step();
    expect(a.log).toEqual(['start', 'u0.0', 'pause', 'resume+2', 'u1.0', 'u2.0', 'stop']);
    expect(s.find('A')!.status).toBe('stopped');
    expect(s.find('B')!.status).toBe('cancelled');
    expect(b.log).toEqual([]);
  });

  it('controller: controls are refused when not supported, recorded otherwise, and a reset replays them bit-identically', async () => {
    const doc = flat();
    const run = async (withReset: boolean) => {
      const c = new SimulationController({ headless: true });
      await c.load(structuredClone(doc));
      c.addEvent({ event: 'blast', position: [0, 0], height: 1, energy: 1e6, model: 'weakShock', waveform: 'nWave', startTime: 0.1 } as BlastSpec);
      c.addEvent({ ...Q1, startTime: 0, duration: 30 });
      c.addEvent({ event: 'waterSource', position: [10, 10], rate: 2, duration: 100, startTime: 0 });
      c.advance(2);
      expect(c.controlEvent('blast#1', 'stop')).toBe(false); // a released wave cannot be stopped
      expect(c.controlEvent('earthquake#1', 'pause')).toBe(true);
      c.advance(3);
      expect(c.controlEvent('earthquake#1', 'resume')).toBe(true);
      c.advance(2);
      expect(c.controlEvent('waterSource#1', 'stop')).toBe(true);
      c.advance(3);
      if (withReset) {
        await c.reset();
        c.advance(10);
      }
      const gm = c.getEnvironment().groundMotion;
      const sample = createGroundMotionSample();
      gm.sample(20, 20, c.getTime(), sample);
      const out = { status: c.instances().map((i) => i.status), water: c.getEnvironment().flood.field?.totalVolume?.() ?? null, a: [...sample.a], fp: c.getRuntime()!.entities.size };
      c.unload();
      return out;
    };
    const live = await run(false);
    const replay = await run(true);
    expect(live.status.slice(1)).toEqual(['active', 'stopped']); // the blast event lasts until its wave left the world + ring-down
    expect(replay).toEqual(live);
  });

  it('heat source stop: no heat after the stop time', async () => {
    const c = new SimulationController({ headless: true });
    await c.load(flat());
    const hs: HeatSourceSpec = { ...(phenomena.implemented('heatSource')!.defaults() as HeatSourceSpec), startTime: 0, duration: 120 };
    const key = c.addEvent(hs);
    c.advance(5);
    expect(c.controlEvent(key, 'stop')).toBe(true);
    const at = () => c.getEnvironment().thermal.rt?.world.ledger.bySource.get(key) ?? 0;
    c.advance(1);
    const e1 = at();
    c.advance(10);
    expect(e1).toBeGreaterThan(0);
    expect(at()).toBe(e1);
    c.unload();
  });
});

describe('placed vortex wind', () => {
  const spec = (x: Partial<TornadoSpec> = {}): TornadoSpec => ({ event: 'tornado', position: [0, 0], maxSpeed: 50, coreRadius: 15, outerRadius: 80, duration: 60, ...x });

  it('profile: peak V_max at the core radius, inflow angle, rotation sense, finite footprint, translation', () => {
    expect(hollandShape(15, 15, 1)).toBe(1);
    expect(hollandShape(5, 15, 1)).toBeLessThan(1);
    expect(hollandShape(45, 15, 1)).toBeLessThan(1);
    const v = vortexState('v', spec());
    v.amp = 1;
    const out = [0, 0, 0];
    addVortexWind(v, 15, 0, 1, out); // east of the centre
    // ccw seen from above: east point moves north (−z); inflow 20° toward the centre (−x).
    expect(out[2]).toBeCloseTo(-50, 9);
    expect(out[0]).toBeCloseTo(-50 * Math.tan((20 * Math.PI) / 180), 9);
    const cw = vortexState('w', spec({ rotation: 'cw' }));
    cw.amp = 1;
    const o2 = [0, 0, 0];
    addVortexWind(cw, 15, 0, 1, o2);
    expect(o2[2]).toBeCloseTo(50, 9);
    const far = [0, 0, 0];
    addVortexWind(v, 81, 0, 1, far);
    expect(far).toEqual([0, 0, 0]);
    const tr = vortexState('t', spec({ trackSpeed: 10, trackBearing: 90, inflowAngle: 0 }));
    tr.amp = 1;
    const o3 = [0, 0, 0];
    addVortexWind(tr, 0, -15, 1, o3); // north of the centre: ccw → toward west (−x); plus 10 m/s east
    expect(o3[0]).toBeCloseTo(-50 + 10, 9);
  });

  it('two vortices add; the wind loads a free body through the wind source (no global wind needed), once per step', async () => {
    const doc = buildWorld({ objects: [car(20, 0, 1)], seed: 5, name: 'vortex' });
    doc.settings.simulation.humans = undefined as never;
    const c = new SimulationController({ headless: true });
    await c.load(doc);
    c.addEvent({ ...spec({ position: [0, 0], maxSpeed: 60, coreRadius: 20, rampDuration: 1 }), startTime: 0 });
    c.addEvent({ ...spec({ position: [200, 200], maxSpeed: 60, coreRadius: 20, rampDuration: 1 }), startTime: 0 });
    c.advance(3);
    const env = c.getEnvironment();
    expect(env.wind.baseSpeed).toBe(0);
    expect(env.wind.vortices.length).toBe(2);
    const w = env.windField.sample([20, 10, 0], c.getTime());
    // At (20, 0) 20 m east of vortex 1: wind mostly toward north (−z), ~60 m/s × height factor at 10 m (= 1).
    expect(w.velocity[2]).toBeLessThan(-40);
    const carE = [...c.getRuntime()!.entities.values()].find((e) => e.source.type === 'car')!;
    expect(carE.forces![FORCE_SOURCES.indexOf('wind')]).toBeGreaterThan(0);
    expect(c.duplicateForces()).toBe(0);
    c.unload();
  });
});
