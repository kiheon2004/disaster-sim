/**
 * Phase 31 audit (M3): structural models of a town under a gravity change — created within the per-step budget, yet
 * every building takes the change in the same step, the result does not depend on the order the town was built in,
 * and a model applied late takes the field's history (a gradual ramp is never applied as a sudden jump).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { CollapseModel, SUDDEN_RATIO } from '@/structure/collapse';
import type { Vec3 } from '@/core/types';
import { CREATE_BUDGET } from './structures';
import { gravity } from './testSpecs';

const S = () => useWorldStore.getState();
function town(n: number, reverse = false) {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('m3'));
  const d = createDesign({ ...presetSpec('house')!, floors: 2 }, 'house');
  const add: unknown[] = [];
  for (let z = -94; z <= 94 && add.length < n; z += 6) for (let x = -94; x <= 94 && add.length < n; x += 6) add.push({ type: 'building', building: d, seed: add.length + 1, transform: { position: [x, 0, z] as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] } });
  if (reverse) add.reverse();
  S().applyEdit({ add: add as never });
  const w = structuredClone(S().doc);
  w.settings.simulation.seed = 42;
  return w;
}

/** Time of each model's first gravity ratio and whether it was applied as sudden. */
async function run(n: number, ev: ReturnType<typeof gravity>, steps: number, reverse = false) {
  const c = new SimulationController({ headless: true });
  await c.load(town(n, reverse));
  c.addEvent(ev);
  const first = new Map<CollapseModel, { t: number; sudden: boolean }>();
  const orig = CollapseModel.prototype.setGravityRatio;
  CollapseModel.prototype.setGravityRatio = function (this: CollapseModel, i: number, k: number, h?: string, sd?: boolean) {
    if (!first.has(this)) first.set(this, { t: c.getTime(), sudden: sd ?? Math.abs(Math.abs(k) - this.s.kM[i]) > SUDDEN_RATIO });
    return orig.call(this, i, k, h, sd);
  };
  try {
    c.advance(steps / 60);
  } finally {
    CollapseModel.prototype.setGravityRatio = orig;
  }
  const ents = [...c.getRuntime()!.entities.values()].filter((e) => e.modular);
  const per = ents.map((e) => ({ key: `${e.pose.position[0]},${e.pose.position[2]}`, m: e.modular!.structure?.model ?? null }));
  const firstOf = per.map((p) => (p.m ? first.get(p.m) : undefined));
  const outcome = per.map((p) => `${p.key}:${p.m?.records.map((r) => `${r.i}@${r.time.toFixed(4)}`).join(',') ?? '-'}`).sort().join('|');
  c.unload();
  return { firstOf, hash: createHash('md5').update(outcome).digest('hex'), failures: per.reduce((s, p) => s + (p.m?.records.length ?? 0), 0) };
}

describe('structural models under gravity in a town (M3)', { timeout: 1_800_000 }, () => {
  it(`a sudden 5 g step over ${2.5 * CREATE_BUDGET} houses: every building takes it in the same step; built in reverse order → the same result`, async () => {
    const ev = gravity({ magnitude: 5 * 9.81, startTime: 1 });
    const a = await run(100, ev, 120), b = await run(100, ev, 120, true);
    const ta = a.firstOf.map((f) => f!.t);
    expect(Math.max(...ta)).toBe(Math.min(...ta));
    // Models for 100 buildings at 40 per step: answered after ⌈100 / 40⌉ − 1 = 2 steps.
    expect(Math.min(...ta)).toBeCloseTo(1 + 2 / 60, 9);
    expect(a.firstOf.every((f) => f!.sudden)).toBe(true);
    expect(a.failures).toBeGreaterThan(0);
    expect(b.hash).toBe(a.hash);
  });

  it(`${CREATE_BUDGET} and ${CREATE_BUDGET + 1} houses: on time within the budget, one step later beyond it (all together)`, async () => {
    const ev = gravity({ magnitude: 3 * 9.81, startTime: 1 });
    const a = await run(CREATE_BUDGET, ev, 70), b = await run(CREATE_BUDGET + 1, ev, 70);
    expect(a.firstOf.every((f) => Math.abs(f!.t - 1) < 1e-9)).toBe(true);
    expect(b.firstOf.every((f) => Math.abs(f!.t - (1 + 1 / 60)) < 1e-9)).toBe(true);
  });

  it('a gradual ramp (linear, 2 s to 3 g) over 200 houses: no building is loaded as a sudden jump', async () => {
    const r = await run(200, gravity({ magnitude: 3 * 9.81, profile: 'linear', ramp: 2, duration: 60, end: 'hold' }), 90);
    expect(r.firstOf.filter((f) => f).length).toBe(200);
    expect(r.firstOf.filter((f) => f!.sudden).length).toBe(0);
  });
});
