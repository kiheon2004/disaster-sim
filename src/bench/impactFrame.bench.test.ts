/**
 * Phase 24 residual 2.1: where the long simulation step at an impact comes from. The Phase 23
 * first-frame probe scene (town of 121 houses, direct 1 m stony impact landing 0.3 s after the
 * start) is stepped one fixed step at a time; every step's systems and the physics step are timed
 * (SimProfiler sections), and the steps above a threshold are reported with their split:
 *
 *   plan        planImpact() inside ImpactEvent.onStart (entry + arc + crater + ejecta flights + shock)
 *   impact      ImpactSystem: crater front, rim, launches, landings, object responses
 *   ground      GroundFailureSystem (granular runout of slumping walls)
 *   deformation DeformationSystem: field → heights, collider rebuild, water bed, object responses
 *   physics     Rapier step (debris bodies spawned by collapsing buildings)
 *   damage      structural / seismic damage and the DamageSystem
 *
 *   BENCH=1 npx vitest run src/bench/impactFrame --silent=false     (BENCH_OUT=file.json)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import { simProfiler } from '@/simulation/profiling/SimProfiler';
import { PROBE_IMPACT, townDoc } from './scenes';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';

const sections = () => (simProfiler as unknown as { sections: Record<string, number> }).sections;

export interface StepRow { step: number; t: number; ms: number; parts: Record<string, number> }

/** Step a run one fixed step at a time, timing each step and its systems. */
export async function profileSteps(doc: WorldDocument, events: EventSpec[], seconds: number, prepare = false): Promise<{ rows: StepRow[]; c: SimulationController }> {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  if (prepare) c.prepareGround(true);
  simProfiler.enabled = true;
  const rows: StepRow[] = [];
  const steps = Math.round(seconds * 60);
  for (let k = 0; k < steps; k++) {
    if (k === 0) {
      // Events are added at t = 0 exactly as the UI does (their onStart runs in the first step).
      for (const e of events) c.addEvent(e);
    }
    simProfiler.snapshot();
    const before = { ...sections() };
    const t0 = performance.now();
    c.advance(1 / 60);
    const ms = performance.now() - t0;
    const after = sections();
    const parts: Record<string, number> = {};
    for (const [key, v] of Object.entries(after)) {
      const d = v - (before[key] ?? 0);
      if (d > 0.05) parts[key] = +d.toFixed(2);
    }
    rows.push({ step: k, t: +c.getTime().toFixed(3), ms: +ms.toFixed(2), parts });
  }
  simProfiler.enabled = false;
  return { rows, c };
}

describe.skipIf(!process.env.BENCH)('impact moment profile', () => {
  it('per-step split around the impact', { timeout: 600_000 }, async () => {
    const out: Record<string, unknown> = { date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)) };
    for (const prepare of [false, true]) {
      const runs = [];
      for (let r = 0; r < 3; r++) {
        const { rows, c } = await profileSteps(townDoc(), [PROBE_IMPACT], 4, prepare);
        const top = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 6);
        runs.push({ worst: top, totalMs: +rows.reduce((s, x) => s + x.ms, 0).toFixed(1), debris: c.getRuntime()!.debris.length });
        c.unload();
      }
      out[prepare ? 'prepared' : 'plain'] = runs;
      console.log(prepare ? 'prepared' : 'plain', JSON.stringify(runs.map((r) => r.worst.slice(0, 3)), null, 0));
    }
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2));
  });
});
