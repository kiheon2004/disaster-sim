/**
 * Phase 31: gravity in the shallow-water model — wave speed √(g·h) (dam-break front), Archimedes under any downward g
 * (the buoyancy / weight ratio does not depend on g), a horizontal component as a tilted reference surface (still
 * water leans by g_h / g_n), the CFL bound, and the held state without downward gravity (no fake 3D liquid).
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { defaultWaterSettings, type BoundarySide, type WorldDocument } from '@/core/model';
import { WaterField } from '@/simulation/water/WaterField';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { captureWaterState } from '@/simulation/water/waterStateCodec';
import type { EventSpec } from '@/events/specs';
import { gravity } from './testSpecs';

function doc(inputs: CreateObjectInput[] = []): WorldDocument {
  const d = createEmptyDocument('gravity-water');
  for (const input of inputs) {
    const o = createWorldObject({ seed: 7, ...input }, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  const w = defaultWaterSettings();
  for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
  w.infiltration = false;
  w.drainageCapacity = 0;
  w.initialFromReference = false;
  d.settings.simulation.water = w;
  return d;
}
function waterState(d: WorldDocument, depth: (x: number, z: number) => number) {
  const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
  for (let iz = 0; iz < f.nz; iz++) for (let ix = 0; ix < f.nx; ix++) f.h[iz * f.nx + ix] = Math.max(0, depth(f.cellX(ix), f.cellZ(iz)));
  return captureWaterState(f, 0);
}
const nudge: EventSpec = { event: 'rain', intensity: 0.1, duration: 600 };
async function run(d: WorldDocument, specs: EventSpec[], seconds: number, initial: ReturnType<typeof waterState>) {
  const c = new SimulationController({ headless: true });
  c.setInitialWaterState(initial);
  await c.load(d);
  for (const s of specs) c.addEvent(s);
  c.advance(seconds);
  return c;
}
const car = (x: number, z: number): CreateObjectInput => ({ type: 'car', transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } });
/** Furthest x reached by the dam-break front along the centre row (h > 1 cm). */
function front(c: SimulationController): number {
  const f = c.getEnvironment().flood.field!;
  const iz = Math.floor(f.nz / 2);
  let x = -Infinity;
  for (let ix = 0; ix < f.nx; ix++) if (f.h[iz * f.nx + ix] > 0.01) x = Math.max(x, f.cellX(ix));
  return x;
}

describe('variable gravity: shallow water', { timeout: 600_000 }, () => {
  it('dam-break: Froude similarity — the front at 4 g after t equals the front at 1 g after 2t (wave speed ∝ √g; bed friction keeps its physical roughness)', async () => {
    const d = doc();
    const init = waterState(d, (x) => (x < 0 ? 1 : 0));
    const earth3 = front(await run(d, [nudge], 3, init));
    const earth6 = front(await run(d, [nudge], 6, init));
    const four3 = front(await run(d, [nudge, gravity({ magnitude: 4 * 9.81 })], 3, init));
    // Ritter: x_f = 2√(g h₀) t (frictionless) — friction and the wetting front slow it.
    expect(earth3).toBeGreaterThan(0.3 * 2 * Math.sqrt(9.81) * 3);
    expect(earth6).toBeGreaterThan(earth3 + 2);
    expect(Math.abs(four3 - earth6)).toBeLessThanOrEqual(1.01); // one 1 m cell
  });

  it('the CFL bound follows √g: more substeps at 4 g, fewer at Moon-like gravity', async () => {
    const d = doc();
    const init = waterState(d, () => 3);
    const n = async (g?: number) => {
      const c = await run(d, g === undefined ? [nudge] : [nudge, gravity({ magnitude: g })], 1, init);
      return c.getEnvironment().flood.solver!.substeps;
    };
    const e = await n(), h = await n(4 * 9.81), m = await n(1.62);
    expect(h).toBeGreaterThan(e);
    expect(m).toBeLessThanOrEqual(e);
  });

  it('Archimedes under any downward g: the car floats in 1.3 m of water at 1 g and at Moon-like g; buoyancy = ρ·g·V·submerged share', async () => {
    const d = doc([car(0, 0)]);
    const init = waterState(d, () => 1.3);
    const a = await run(d, [nudge], 6, init);
    const b = await run(d, [nudge, gravity({ magnitude: 1.62 })], 6, init);
    const ea = [...a.getRuntime()!.entities.values()][0], eb = [...b.getRuntime()!.entities.values()][0];
    expect(ea.flood!.floated).toBe(true);
    expect(eb.flood!.floated).toBe(true);
    // Same displaced volume per submerged share under both gravities (ρ_w·V): the force scales with g only.
    const va = ea.flood!.buoyancy / (9.81 * ea.flood!.submerged), vb = eb.flood!.buoyancy / (1.62 * eb.flood!.submerged);
    expect(vb / va).toBeCloseTo(1, 6);
  });

  it('horizontal gravity: water already leaning with slope g_x / g_n is at rest (tilted reference surface); without the tilt it sloshes', async () => {
    const d = doc();
    // Depth 2 m + 0.01·x (1 … 3 m across the 200 m world): the equilibrium surface of g_x = 0.01·g_n.
    const init = waterState(d, (x) => 2 + 0.01 * x);
    const g = 9.81;
    const umax = (c: SimulationController) => { const f = c.getEnvironment().flood.field!; let m = 0; for (let i = 0; i < f.count; i++) if (f.h[i] > 0.1) m = Math.max(m, Math.hypot(f.u[i], f.v[i])); return m; };
    const tilted = await run(d, [nudge, gravity({ magnitude: Math.hypot(g, 0.01 * g), direction: [0.01, -1, 0] })], 20, init);
    const flat = await run(d, [nudge], 20, init);
    expect(umax(tilted)).toBeLessThan(0.05);
    expect(umax(flat)).toBeGreaterThan(0.2);
  });

  it('zero gravity: the water is held (no free-surface model without downward gravity), volume unchanged', async () => {
    const d = doc();
    const init = waterState(d, (x) => (x < 0 ? 1 : 0));
    const c = await run(d, [nudge, gravity({ magnitude: 0, startTime: 0 })], 3, init);
    const f = c.getEnvironment().flood.field!;
    expect(front(c)).toBeLessThan(1);
    expect(Math.abs(f.budget.error)).toBeLessThan(1e-6 * f.budget.initial + 1e-6);
    const sys = c.getSystems().find((s) => s.name === 'waterSolver') as unknown as { held: number };
    expect(sys.held).toBeGreaterThan(2.5);
  });
});
