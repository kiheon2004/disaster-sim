/**
 * Phase 33: cost of the extended human model in the simulation core (no rendering). Crowds of 1–1000 people in a grid
 * (2 m spacing), each scene run with the legacy model (L0) and the extended model (L1): standing still (5 s), a storm that
 * topples them (wind ramp to 35 m/s, 10 s) and an earthquake (PGA 3 m/s², 10 s). Per scene: ms per simulated second, the
 * profiler sections humans (HumanSystem), physics (Rapier step), damage (DamageSystem incl. contact events), contact
 * episodes / impact events / falls, heap. There is no multibody (L2) model — see HUMAN_PHYSICS.md §4.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/humans.bench --silent=false   (BENCH_OUT=file.json, SIZES=1,10,…, KINDS=stand,storm,quake)
 *   long runs: BENCH=1 LONG=3600 npx vitest run src/bench/humans.bench --silent=false (LONG_SCENES=…)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { rapierWorlds } from '@/physics/RapierEngine';

const S = () => useWorldStore.getState();
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });

function crowd(n: number, extended: boolean): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench33'));
  const side = Math.ceil(Math.sqrt(n));
  const add = [];
  for (let k = 0; k < n; k++) add.push({ type: 'human', seed: k + 1, params: { height: 1.55 + ((k * 37) % 36) / 100, shirtColor: '#2fa39a', pantsColor: '#34406b' }, transform: tf(-side + 2 * (k % side), -side + 2 * Math.floor(k / side)) });
  S().applyEdit({ add: add as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  if (extended) d.settings.simulation.humans = { model: 'extended' };
  return d;
}

const KINDS: Record<string, { seconds: number; events: EventSpec[] }> = {
  stand: { seconds: 5, events: [] },
  storm: { seconds: 10, events: [{ event: 'wind', speed: 35, direction: 'W', duration: 30, gustStrength: 0.25, rampDuration: 6 } as EventSpec] },
  quake: { seconds: 10, events: [{ event: 'earthquake', magnitude: 7.5, pga: 3, duration: 15, seed: 3 } as EventSpec] },
};

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function run(n: number, kind: string, extended: boolean) {
  const k = KINDS[kind];
  const doc = crowd(n, extended);
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const sec = () => (simProfiler as unknown as { sections: Record<string, number> }).sections;
  const s0 = { ...sec() };
  await c.load(doc);
  for (const e of k.events) c.addEvent(e);
  const steps = Math.round(k.seconds * 60);
  let worst = 0;
  const frames: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    const a = performance.now();
    c.advance(1 / 60);
    const ms = performance.now() - a;
    frames.push(ms);
    if (ms > worst) worst = ms;
  }
  const ms = performance.now() - t0;
  const s1 = sec();
  const per = (name: string) => +(((s1[name] ?? 0) - (s0[name] ?? 0)) / k.seconds).toFixed(2);
  frames.sort((x, y) => x - y);
  const people = [...c.getRuntime()!.entities.values()];
  const ev = c.getDamageEvents();
  const out = {
    n, kind, model: extended ? 'L1' : 'L0', simSeconds: k.seconds,
    msPerSimS: +(ms / k.seconds).toFixed(1), stepP50: +frames[Math.floor(steps * 0.5)].toFixed(2), stepP95: +frames[Math.floor(steps * 0.95)].toFixed(2), worstStepMs: +worst.toFixed(1),
    humansMs: per('humans'), physicsMs: per('physics'), damageMs: per('sys.damage'), damageImpactsMs: per('damage.impacts'),
    fallen: people.filter((p) => p.flags.fallen).length, falls: ev.filter((d) => d.eventType === 'FALLEN').length,
    impactEvents: ev.filter((d) => d.eventType === 'IMPACT').length, injuredEvents: ev.filter((d) => d.eventType === 'INJURED').length,
    episodes: extended ? people.reduce((a, p) => a + (p.human?.impacts ?? 0), 0) : null,
    nonFinite: people.some((p) => !p.pose.position.every(Number.isFinite)),
    heapMB: heapMB(),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH || !!process.env.LONG)('human benchmark', () => {
  it('crowds', { timeout: 28_800_000 }, async () => {
    const sizes = (process.env.SIZES ?? '1,10,50,100,250,500,1000').split(',').map(Number);
    const kinds = (process.env.KINDS ?? 'stand,storm,quake').split(',');
    const rows: Any[] = [];
    const live0 = rapierWorlds.live;
    for (const kind of kinds) for (const n of sizes) for (const ext of [false, true]) {
      const r = await run(n, kind, ext);
      rows.push(r);
      console.log(JSON.stringify(r));
    }
    rows.push({ rapierWorldsLeft: rapierWorlds.live - live0 });
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});

/** Long runs (spec §57): 1 s steps; every 60 s: NaN, record growth, heap, Rapier bodies. */
describe.skipIf(!process.env.BENCH || !process.env.LONG)('human long runs', () => {
  it('long', { timeout: 28_800_000 }, async () => {
    const T = +process.env.LONG!;
    const scenes: Record<string, () => { doc: WorldDocument; events: EventSpec[] }> = {
      normal: () => ({ doc: crowd(20, true), events: [] }),
      repeated: () => ({ doc: crowd(20, true), events: [{ event: 'wind', speed: 30, direction: 'W', duration: T, gustStrength: 0.6, rampDuration: 5 } as EventSpec] }),
      crowd: () => ({ doc: crowd(250, true), events: [{ event: 'wind', speed: 32, direction: 'S', duration: 60, gustStrength: 0.3, rampDuration: 5 } as EventSpec] }),
      highG: () => ({ doc: crowd(20, true), events: [{ event: 'gravity', scenario: 'custom', global: true, magnitude: 29.4, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: T, end: 'hold', sources: [] } as unknown as EventSpec] }),
      lowG: () => ({ doc: crowd(20, true), events: [{ event: 'gravity', scenario: 'custom', global: true, magnitude: 1.62, direction: [0, -1, 0], transition: 'vector', profile: 'constant', duration: T, end: 'hold', sources: [] } as unknown as EventSpec] }),
      reversed: () => ({ doc: crowd(20, true), events: [{ event: 'gravity', scenario: 'custom', global: true, magnitude: 9.81, direction: [0, 1, 0], transition: 'vector', profile: 'cyclic', period: 20, duration: T, end: 'hold', sources: [] } as unknown as EventSpec] }),
      flood: () => ({ doc: crowd(20, true), events: [{ event: 'risingWater', boundary: 'W', level: 1.4, riseRate: 0.2 } as EventSpec] }),
      quake: () => ({ doc: crowd(20, true), events: [{ event: 'earthquake', magnitude: 7.5, pga: 4, duration: 60, seed: 3 } as EventSpec] }),
      collapse: () => {
        const d = crowd(20, true);
        return { doc: d, events: [{ event: 'earthquake', magnitude: 8, pga: 8, duration: 40, seed: 5 } as EventSpec] };
      },
      tides: () => ({ doc: crowd(20, true), events: [{ event: 'celestial', scenario: 'custom', sources: [{ kind: 'compact', center: [0, -12, 0], mass: 2000 / 6.6743e-11, softening: 2, capture: 0, ramp: 4 }], probes: [], accretion: { visual: false, particles: 0, inner: 6, outer: 20, particleMass: 1 }, duration: T, startTime: 0 } as unknown as EventSpec] }),
    };
    const only = process.env.LONG_SCENES?.split(',');
    const rows: Any[] = [];
    for (const [name, mk] of Object.entries(scenes)) {
      if (only && !only.includes(name)) continue;
      const { doc, events } = mk();
      const c = new SimulationController({ headless: true });
      await c.load(doc);
      for (const e of events) c.addEvent(e);
      const live0 = rapierWorlds.live;
      const checks: Any[] = [];
      const t0 = performance.now();
      for (let t = 0; t < T; t++) {
        c.advance(1);
        if ((t + 1) % 60 === 0) {
          const ps = [...c.getRuntime()!.entities.values()];
          checks.push({
            t: t + 1,
            nonFinite: ps.some((p) => !p.pose.position.every(Number.isFinite) || !Number.isFinite(p.health)),
            events: c.getDamageEvents().length,
            episodesOpen: ps.reduce((a, p) => a + (p.human?.episodes.size ?? 0), 0),
            series: ps.reduce((a, p) => a + (p.human?.series?.t.length ?? 0), 0),
            heapMB: heapMB(),
          });
        }
      }
      const ms = performance.now() - t0;
      await c.reset();
      c.unload();
      const bad = checks.filter((x) => x.nonFinite).map((x) => x.t);
      const row = { scene: name, seconds: T, wallS: +(ms / 1000).toFixed(1), bad, last: checks[checks.length - 1], first: checks[0], rapierWorldsLeft: rapierWorlds.live - live0 };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
