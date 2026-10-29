/**
 * Phase 29 check of Phase 28 residuals (headless, BENCH-gated):
 *  1. crust surface temperature of a stationary basalt column after 1–60 min for convection cases — the
 *     Phase 28 default (natural + 2 m wind function at standard pressure, unchanged by Phase 29), wind,
 *     a thinner atmosphere (Phase 29 pressure ratio), a FLOWGO-type bulk transfer and fixed high
 *     coefficients, and a lower (vesicular) crust conductivity — to see what the 3-min ≈ 690 °C bias
 *     responds to. Same functions as the run (boundaryLayer, surfaceTemperature, hGround).
 *  2. memory of a finished run: heap before / after a volcano and an atmosphere run, what the runtime-state
 *     manifest says is retained, after reset and after unload, and over repeated runs.
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run src/bench/phase28residual.bench --silent=false   (BENCH_OUT=file.json)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import { LAVA_MATERIALS } from '@/volcano/materials';
import { boundaryLayer, surfaceTemperature } from '@/volcano/crust';
import { hGround } from '@/thermal/convection';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { runtimeStateManifest } from '@/simulation/runtimeState';
import type { EventSpec } from '@/events/specs';

const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };

function crustCases() {
  const m = LAVA_MATERIALS.basalt, th = m.thermal;
  const Ti = 1150 + 273.15, Ta = 288.15;
  const U2 = (u10: number) => u10 * Math.pow(0.2, 0.14);
  const cases: { id: string; note: string; hc: (Ts: number) => number; k?: number }[] = [
    { id: 'phase28', note: 'natural + wind function, calm, standard pressure (Phase 28 default; unchanged without an atmosphere experiment)', hc: (Ts) => hGround(Math.max(Ts, Ta), Ta, 0) },
    { id: 'wind5', note: '10 m wind 5 m/s', hc: (Ts) => hGround(Math.max(Ts, Ta), Ta, U2(5)) },
    { id: 'wind10', note: '10 m wind 10 m/s', hc: (Ts) => hGround(Math.max(Ts, Ta), Ta, U2(10)) },
    { id: 'p50', note: 'calm, half the pressure (Phase 29 pressure ratio 0.5)', hc: (Ts) => hGround(Math.max(Ts, Ta), Ta, 0, 1, 0.5) },
    { id: 'bulk5', note: 'bulk transfer ρ·c_p·C_H·U, C_H = 3.6·10⁻³, U = 5 m/s (FLOWGO-type forced convection)', hc: () => 1.2 * 1005 * 3.6e-3 * 5 },
    { id: 'h50', note: 'fixed 50 W/(m²·K) (high, plume-driven convection)', hc: () => 50 },
    { id: 'h100', note: 'fixed 100 W/(m²·K) (upper bound tried)', hc: () => 100 },
    { id: 'kHalf', note: 'Phase 28 convection, crust conductivity halved (vesicular, ~50 % porosity)', hc: (Ts) => hGround(Math.max(Ts, Ta), Ta, 0), k: th.k / 2 },
  ];
  const times = [60, 180, 600, 1800, 3600];
  return cases.map((c) => {
    const k = c.k ?? th.k, kappa = k / (th.bulk * th.cp);
    const Ts: Record<string, number> = {};
    for (const t of times) {
      const d = boundaryLayer(kappa, t, 2);
      let s = Ti;
      // Fixed point on the temperature-dependent coefficient (the run warm-starts the same way).
      for (let it = 0; it < 40; it++) s = surfaceTemperature(Ti, d, k, th.emissivity, Ta, c.hc(s), Ta, s);
      Ts[`${t}s`] = +(s - 273.15).toFixed(1);
    }
    return { id: c.id, note: c.note, hc180: +c.hc(Ts['180s'] + 273.15).toFixed(1), TsC: Ts };
  });
}

async function memory() {
  const S = () => useWorldStore.getState();
  const rows: Record<string, unknown>[] = [];
  const scenes: { name: string; events: EventSpec[]; seconds: number }[] = [
    { name: 'volcano single vent (120 s)', events: [{ event: 'volcano', vents: [{ kind: 'central', position: [-70, 0], radius: 2 }], material: 'basalt', temperature: 1150, rate: 3, duration: 600, profile: 'constant', ashFraction: 0.05 } as EventSpec], seconds: 120 },
    { name: 'atmosphere removal + wind (120 s)', events: [{ event: 'atmosphere', altitude: 0, boundary: 'open', removal: 'linear', target: 0.3, duration: 100 } as EventSpec, { event: 'wind', speed: 15, direction: 'W', duration: 600 } as EventSpec], seconds: 120 },
  ];
  for (const sc of scenes) {
    S().setLocked(false);
    S().replaceDocument(createEmptyDocument('mem'));
    const doc = structuredClone(S().doc);
    const h0 = heapMB();
    const after: number[] = [];
    for (let k = 0; k < 4; k++) {
      const c = new SimulationController({ headless: true });
      await c.load(structuredClone(doc));
      for (const e of sc.events) c.addEvent(e);
      c.advance(sc.seconds);
      const hRun = heapMB();
      const man = runtimeStateManifest(c.getEnvironment(), c.getRuntime(), c.getTime());
      const bytes = man.filter((m) => m.present).reduce((s, m) => s + m.bytes, 0);
      const big = man.filter((m) => m.present && m.bytes > 200_000).map((m) => `${m.id} ${(m.bytes / 1048576).toFixed(1)} MB`);
      await c.reset();
      const hReset = heapMB();
      c.unload();
      const hUnload = heapMB();
      after.push(hUnload);
      if (k === 0) rows.push({ scene: sc.name, heapBeforeMB: h0, heapFinishedMB: hRun, retainedMB: +(hRun - h0).toFixed(1), manifestMB: +(bytes / 1048576).toFixed(1), largest: big, heapAfterResetMB: hReset, heapAfterUnloadMB: hUnload });
    }
    rows.push({ scene: `${sc.name} ×4 (heap after each unload)`, heapMB: after });
  }
  return rows;
}

describe.skipIf(!process.env.BENCH)('Phase 28 residuals (Phase 29)', () => {
  it('crust and memory', { timeout: 3_600_000 }, async () => {
    const crust = crustCases();
    for (const r of crust) console.log(JSON.stringify(r));
    const mem = await memory();
    for (const r of mem) console.log(JSON.stringify(r));
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), crust, memory: mem }, null, 2));
  });
});
