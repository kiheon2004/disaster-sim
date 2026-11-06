/**
 * Phase 34: cost of the physiology (no rendering). Crowds of 1–5000 people (2 m grid), each scene with the extended human
 * model alone (L1) and with the physiology (L2): calm reference air, a hot humid zone with moderate activity, a cold windy
 * zone. Per run: ms per simulated second, profiler sections physio.sample / physio.step / physio.record, humans, physics,
 * p50 / p95 / worst step, heap; repeats → median and range. A micro-benchmark times the engine parts per call (heat flows,
 * gas FED rates, the whole person step).
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/physiology.bench --silent=false   (BENCH_OUT=file.json, SIZES=…, KINDS=…, REPEATS=3)
 *   long runs: BENCH=1 LONG=3600 npx vitest run src/bench/physiology.bench --silent=false (LONG_SCENES=…)
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
import type { PhysiologySettings, PhysiologyZone } from '@/physiology/settings';
import { createPhysioState, primePhysiology, stepPhysiology, type Exposure, type PhysioConfig } from '@/physiology/engine';
import { flows } from '@/physiology/thermal';
import { fedRates } from '@/physiology/gas';
import { esWater } from '@/climate/psychro';

const S = () => useWorldStore.getState();
const K = 273.15;
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };
const tf = (x: number, z: number, y = 0) => ({ position: [x, y, z] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const big = (o: Partial<PhysiologyZone>): PhysiologyZone => ({ id: 'z', shape: 'box', center: [0, 1, 0], size: [400, 20, 400], ...o });

function crowd(n: number, physiology?: PhysiologySettings): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('bench34'));
  const side = Math.ceil(Math.sqrt(n));
  const add = [];
  for (let k = 0; k < n; k++) add.push({ type: 'human', seed: k + 1, params: { height: 1.55 + ((k * 37) % 36) / 100, shirtColor: '#2fa39a', pantsColor: '#34406b' }, transform: tf(-side + 2 * (k % side), -side + 2 * Math.floor(k / side)) });
  S().applyEdit({ add: add as never });
  const d = structuredClone(S().doc);
  d.settings.simulation.seed = 42;
  d.settings.simulation.humans = { model: 'extended' };
  if (physiology) d.settings.simulation.physiology = physiology;
  return d;
}

const KINDS: Record<string, PhysiologySettings> = {
  calm: { model: 'reduced' },
  heat: { model: 'reduced', activity: 'moderate', clothing: 'light', zones: [big({ airTemperature: 42 + K, humidity: 0.7 })] },
  cold: { model: 'reduced', clothing: 'light', zones: [big({ airTemperature: -10 + K, wind: 10 })] },
};

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

async function run(n: number, kind: string, physio: boolean, seconds: number) {
  const doc = crowd(n, physio ? KINDS[kind] : undefined);
  const c = new SimulationController({ headless: true });
  simProfiler.enabled = true;
  simProfiler.snapshot();
  const sec = () => ({ ...(simProfiler as unknown as { sections: Record<string, number> }).sections });
  await c.load(doc);
  const s0 = sec();
  const steps = Math.round(seconds * 60);
  const frames: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    const a = performance.now();
    c.advance(1 / 60);
    frames.push(performance.now() - a);
  }
  const ms = performance.now() - t0;
  const s1 = sec();
  const per = (k: string) => +(((s1[k] ?? 0) - (s0[k] ?? 0)) / seconds).toFixed(3);
  frames.sort((x, y) => x - y);
  const people = [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');
  const out = {
    msPerSimS: ms / seconds, p50: frames[Math.floor(steps * 0.5)], p95: frames[Math.floor(steps * 0.95)], worst: frames[steps - 1],
    sample: per('physio.sample'), step: per('physio.step'), record: per('physio.record'), physiology: per('physiology'), humans: per('humans'), physics: per('physics'),
    nonFinite: people.some((p) => !Number.isFinite(p.physio?.s.Tc ?? 0)),
    events: c.getDamageEvents().filter((d) => d.cause === 'physiology').length,
    heapMB: heapMB(),
  };
  c.unload();
  simProfiler.enabled = false;
  return out;
}

describe.skipIf(!process.env.BENCH || !!process.env.LONG)('physiology benchmark', () => {
  it('crowds', { timeout: 28_800_000 }, async () => {
    const sizes = (process.env.SIZES ?? '1,10,50,100,250,500,1000,5000').split(',').map(Number);
    const kinds = (process.env.KINDS ?? 'calm,heat,cold').split(',');
    const repeats = +(process.env.REPEATS ?? 3);
    const rows: Any[] = [];
    const live0 = rapierWorlds.live;
    // Engine micro-benchmark (per call).
    {
      const env = { Ta: 40 + K, Tr: 40 + K, pa: 0.6 * esWater(40 + K), vAir: 1, qDir: 0, fWater: 0, Tw: NaN, vWater: 0, fContact: 0, Tsurf: NaN, breathing: true };
      const b = { mass: 70, area: 1.85, clothing: 'normal' as const, wet: 0, radShare: 0.73, setShift: 0, sweatFactor: 1 };
      const N = 200_000;
      let t = performance.now();
      for (let i = 0; i < N; i++) flows(310 + (i % 7) * 0.01, 306, b, env, { Mact: 100 });
      const flowsNs = ((performance.now() - t) / N) * 1e6;
      t = performance.now();
      for (let i = 0; i < N; i++) fedRates({ xO2: 0.18, xCO2: 0.02, xCO: 500e-6 + i * 1e-12, p: 101325, airC: 80, qDir: 3000 });
      const fedNs = ((performance.now() - t) / N) * 1e6;
      const cfg: PhysioConfig = { mass: 70, height: 1.75, activity: 'moderate', clothing: 'normal', intake: 0, modules: { thermal: true, respiration: true, gas: true, submersion: true, hydration: true, fatigue: true } };
      const ex: Exposure = { thermal: env, p: 101325, xO2: 0.2, xCO2: 0.001, xCO: 1e-4, smoke: 1e-5, airwayT: 313, airwaySubmerged: false, lying: false, physical: { incapacitated: false, mobility: 'mobile' } };
      const st = createPhysioState(cfg);
      primePhysiology(st, cfg, ex);
      t = performance.now();
      for (let i = 1; i <= N; i++) stepPhysiology(st, cfg, ex, 0.1, i * 0.1);
      const stepNs = ((performance.now() - t) / N) * 1e6;
      const r = { micro: true, flowsNs: +flowsNs.toFixed(0), fedNs: +fedNs.toFixed(0), personStepNs: +stepNs.toFixed(0) };
      rows.push(r);
      console.log(JSON.stringify(r));
    }
    for (const kind of kinds) for (const n of sizes) for (const physio of [false, true]) {
      if (!physio && kind !== 'calm') continue; // L1 has no physiology: one reference per size
      const reps = n >= 5000 ? 1 : repeats;
      const seconds = n >= 1000 ? 5 : 10;
      const rs: Awaited<ReturnType<typeof run>>[] = [];
      for (let r = 0; r < reps; r++) rs.push(await run(n, kind, physio, seconds));
      const agg = (k: keyof (typeof rs)[0]) => ({ median: +median(rs.map((x) => x[k] as number)).toFixed(3), min: +Math.min(...rs.map((x) => x[k] as number)).toFixed(3), max: +Math.max(...rs.map((x) => x[k] as number)).toFixed(3) });
      const row = {
        n, kind, model: physio ? 'L2' : 'L1', seconds, repeats: reps,
        msPerSimS: agg('msPerSimS'), p95: agg('p95'), worst: agg('worst'),
        physiology: agg('physiology'), sample: agg('sample'), step: agg('step'), record: agg('record'), humans: agg('humans'), physics: agg('physics'),
        nonFinite: rs.some((x) => x.nonFinite), events: rs[0].events, heapMB: rs[rs.length - 1].heapMB, load: os.loadavg().map((v) => +v.toFixed(1)),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    rows.push({ rapierWorldsLeft: rapierWorlds.live - live0 });
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, ncpu: os.cpus().length, load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});

/** Long runs (spec §70): 1 s steps; every 60 s: NaN, negative body water, temperatures out of the model range, events, series, compartments, heap. */
describe.skipIf(!process.env.BENCH || !process.env.LONG)('physiology long runs', () => {
  it('long', { timeout: 28_800_000 }, async () => {
    const T = +process.env.LONG!;
    const P = (o: Partial<PhysiologySettings>): PhysiologySettings => ({ model: 'reduced', ...o });
    const scenes: Record<string, () => { doc: WorldDocument; events: EventSpec[]; buried?: boolean }> = {
      baseline: () => ({ doc: crowd(20, P({})), events: [] }),
      cold: () => ({ doc: crowd(20, P({ clothing: 'normal', zones: [big({ airTemperature: -15 + K, wind: 12 })] })), events: [] }),
      heatwave: () => ({ doc: crowd(20, P({ activity: 'light', clothing: 'light', zones: [big({ airTemperature: 40 + K, humidity: 0.35 })] })), events: [] }),
      hotHumid: () => ({ doc: crowd(20, P({ activity: 'light', clothing: 'light', zones: [big({ airTemperature: 35 + K, humidity: 0.9 })] })), events: [] }),
      smoke: () => ({ doc: crowd(20, P({ zones: [big({ smoke: 2e-4, co: 300e-6, co2: 0.01 })] })), events: [] }),
      hypoxia: () => ({ doc: crowd(20, P({ zones: [big({ o2: 0.15 })] })), events: [] }),
      submersion: () => ({ doc: crowd(20, P({ clothing: 'light', zones: [big({ water: { level: 1.2, amplitude: 0.6, period: 20, temperature: 12 + K } })] })), events: [] }),
      dehydration: () => ({ doc: crowd(20, P({ activity: 'moderate', clothing: 'light', zones: [big({ airTemperature: 36 + K, humidity: 0.3 })] })), events: [] }),
      buried: () => ({ doc: crowd(20, P({ zones: [big({ confined: { volume: 40, exchange: 0.2 } })] })), events: [], buried: true }),
      combined: () => ({ doc: crowd(20, P({ activity: 'moderate', zones: [big({ airTemperature: 38 + K, humidity: 0.6, smoke: 5e-5, co: 100e-6, radiantFlux: 1500 })] })), events: [{ event: 'earthquake', magnitude: 7, pga: 3, duration: 20, seed: 4 } as EventSpec] }),
    };
    const only = process.env.LONG_SCENES?.split(',');
    const rows: Any[] = [];
    for (const [name, mk] of Object.entries(scenes)) {
      if (only && !only.includes(name)) continue;
      const { doc, events, buried } = mk();
      const c = new SimulationController({ headless: true });
      await c.load(doc);
      for (const e of events) c.addEvent(e);
      // Harness: buried people (burial needs a sediment / collapse scene; the flag is what the physiology reads).
      if (buried) for (const e of c.getRuntime()!.entities.values()) if (e.human) e.human.buried = true;
      const checks: Any[] = [];
      const t0 = performance.now();
      for (let t = 0; t < T; t++) {
        c.advance(1);
        if ((t + 1) % 60 === 0) {
          const ps = [...c.getRuntime()!.entities.values()].filter((e) => e.physio);
          const comps = [...(c.getRuntime()!.physiology?.compartments.values() ?? [])];
          checks.push({
            t: t + 1,
            nonFinite: ps.some((p) => !Number.isFinite(p.physio!.s.Tc) || !Number.isFinite(p.physio!.s.Ts) || !Number.isFinite(p.pose.position[1])),
            negativeWater: ps.some((p) => p.physio!.s.bodyWater - p.physio!.s.waterLost + p.physio!.s.waterIntake < 0),
            outOfRange: ps.filter((p) => p.physio!.s.flags.has('temperatureOutOfModelRange')).length,
            coreMin: +Math.min(...ps.map((p) => p.physio!.s.Tc - K)).toFixed(2), coreMax: +Math.max(...ps.map((p) => p.physio!.s.Tc - K)).toFixed(2),
            events: c.getDamageEvents().filter((d) => d.cause === 'physiology').length,
            series: ps.reduce((a, p) => a + (p.physio!.series?.t.length ?? 0), 0),
            residual: +Math.max(...ps.map((p) => Math.abs(p.physio!.s.ledger.residual))).toExponential(2),
            o2: comps.length ? +Math.min(...comps.map((x) => x.o2 / x.total)).toFixed(4) : null,
            heapMB: heapMB(),
          });
        }
      }
      const ms = performance.now() - t0;
      const eventTypes: Record<string, number> = {};
      for (const d of c.getDamageEvents()) if (d.cause === 'physiology') { const k = `${d.eventType}:${d.physio?.to ?? ''}`; eventTypes[k] = (eventTypes[k] ?? 0) + 1; }
      await c.reset();
      c.unload();
      const row = { scene: name, seconds: T, wallS: +(ms / 1000).toFixed(1), bad: checks.filter((x) => x.nonFinite || x.negativeWater).map((x) => x.t), first: checks[0], last: checks[checks.length - 1], eventsAt: checks.map((x) => x.events).filter((_, i) => i % 10 === 9), eventTypes };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), load: os.loadavg().map((v) => +v.toFixed(1)), rows }, null, 2));
  });
});
