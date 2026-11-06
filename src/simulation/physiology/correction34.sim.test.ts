/**
 * Phase 34 correction audit (docs/PHASE34_CORRECTION_AUDIT.md) in the simulation: H3 (O₂ of a confined compartment shared
 * by several occupants), H5 (physiology clock against the simulation clock), H6 (provenance of estimated gases).
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { physioPreset } from '@/physiology/presets';
import { buildPhysioWorld, zoneBox } from '@/physiology/demos';
import { person } from '@/human/demos';
import type { PhysiologySettings } from '@/physiology/settings';
import { physioCsv, physioJson, ESTIMATED_SOURCES, PROVENANCE_FIELDS } from './summary';

const humans = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');
async function load(doc: WorldDocument, events: EventSpec[] = []) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  for (const e of events) c.addEvent(e);
  return c;
}
// The seed (body build) follows the position, so a reversed creation order changes only the order.
const scene = (pts: [number, number][], physiology: Omit<PhysiologySettings, 'model'>) =>
  buildPhysioWorld({ objects: pts.map(([x, z]) => person(x, z, 1 + Math.round((x + 5) * 10) * 100 + Math.round((z + 5) * 10))), physiology: { model: 'reduced', ...physiology }, seed: 3480, name: 'corr' });
const breathedO2 = (e: RuntimeEntity) => e.physio!.s.ledger.o2 - e.physio!.s.ledger.o2Debt;

describe('H3 — confined O₂ shared by several occupants', () => {
  // Four people 3 m apart, well inside a 12 m box (a fallen body's torso stays inside), sharing 0.02 m³ of air (≈ 0.17 mol O₂):
  // the stock runs out within the run, so the occupants' demand exceeds what is left.
  const pts: [number, number][] = [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]];
  const zones = [zoneBox('box', [0, 1, 0], [12, 6, 12], { confined: { volume: 0.02, exchange: 0 } })];

  it('demand larger than the stock: the compartment never goes negative, and the O₂ the occupants breathed from it equals what it gave (the shortfall comes from the body store)', async () => {
    const c = await load(scene(pts, { zones }));
    c.advance(900);
    const comp = c.getRuntime()!.physiology!.compartments.get(0)!;
    expect(comp.o2).toBeGreaterThanOrEqual(0);
    const breathed = humans(c).reduce((a, e) => a + breathedO2(e), 0);
    expect(humans(c).every((e) => e.physio!.provenance.gas === 'confined')).toBe(true);
    expect(breathed).toBeCloseTo(comp.ledger.o2Taken, 9);
    // The stock really ran out during the run (the case under test): a shortfall was supplied from the body stores.
    expect(comp.ledger.clamped).toBeGreaterThan(0);
    expect(comp.o2 / comp.total).toBeLessThan(1e-3);
    c.unload();
  }, 600_000);

  it('allocation does not depend on the creation order: the people added in reverse get the same per-person O₂ (to rounding)', async () => {
    const run = async (order: [number, number][]) => {
      const c = await load(scene(order, { zones }));
      c.advance(900);
      const byPos = new Map(humans(c).map((e) => [`${Math.round(e.source.transform.position[0] * 10)},${Math.round(e.source.transform.position[2] * 10)}`, breathedO2(e)]));
      c.unload();
      return byPos;
    };
    const a = await run(pts), b = await run([...pts].reverse());
    for (const [k, v] of a) expect(b.get(k)!).toBeCloseTo(v, 9);
  }, 900_000);
});

describe('H5 — physiology clock', () => {
  const co = [zoneBox('co', [0, 1, 0], [6, 6, 6], { co: 1000e-6 })];

  it('after the first physics step the physiology has integrated exactly that step (1/60 s), not the whole 0.1 s interval ahead', async () => {
    const c = await load(scene([[0, 0]], { zones: co }));
    c.advance(1 / 60);
    const s = humans(c)[0].physio!.s;
    expect(s.time).toBeCloseTo(1 / 60, 12);
    expect(s.dose.co).toBeCloseTo(1000 / 60, 9);
    c.unload();
  });

  it('at every sample the integrated time equals the physiology time stamp = the simulation time of the sample', async () => {
    const c = await load(scene([[0, 0]], { zones: co }));
    for (const T of [1, 10, 37.3]) {
      c.advance(T - c.getTime());
      const s = humans(c)[0].physio!.s;
      // Constant 1000 ppm: dose (ppm·s) / 1000 = integrated time.
      expect(s.dose.co / 1000).toBeCloseTo(s.time, 9);
      expect(c.getTime() - s.time).toBeGreaterThanOrEqual(-1e-9);
      expect(c.getTime() - s.time).toBeLessThan(0.1);
    }
    c.unload();
  });

  it('pause / resume: 4 s + 6 s gives the state of one 10 s advance; reset restarts the clock at 0', async () => {
    const a = await load(scene([[0, 0]], { zones: co, activity: 'light' }));
    a.advance(10);
    const b = await load(scene([[0, 0]], { zones: co, activity: 'light' }));
    b.advance(4);
    b.advance(6);
    const sa = humans(a)[0].physio!.s, sb = humans(b)[0].physio!.s;
    expect(sb.time).toBe(sa.time);
    expect(sb.Tc).toBe(sa.Tc);
    expect(sb.dose.co).toBe(sa.dose.co);
    await b.reset();
    b.advance(1 / 60);
    expect(humans(b)[0].physio!.s.dose.co).toBeCloseTo(1000 / 60, 9);
    a.unload();
    b.unload();
  });
});

describe('H6 — provenance of estimated gas values', () => {
  it('a fire scene: CO estimated from soot and CO₂ from the O₂ deficit carry their own source codes, marked as estimates, in the inspector fields and both exports', async () => {
    const { doc, events } = physioPreset('smoke')!.build();
    const c = await load(doc, events);
    c.advance(120);
    const pe = humans(c).find((e) => e.physio!.provenance.gas?.startsWith('fire.'))!.physio!;
    expect(pe.provenance.co).toBe('fire.sootRatio');
    expect(pe.provenance.co2).toBe('fire.o2Deficit');
    expect(ESTIMATED_SOURCES.has('fire.sootRatio') && ESTIMATED_SOURCES.has('fire.o2Deficit')).toBe(true);
    expect(PROVENANCE_FIELDS).toContain('co');
    expect(PROVENANCE_FIELDS).toContain('co2');
    const csv = physioCsv(c.getRuntime()!.entities.values(), c.getDamageEvents(), c.getTime());
    expect(csv).toContain('fire.sootRatio');
    expect(csv).toContain('src_co');
    const json = physioJson(c.getRuntime()!.entities.values(), c.getDamageEvents(), c.getRuntime()!.physiology)!;
    expect(json.sourceClasses.estimated).toContain('fire.o2Deficit');
    c.unload();
  }, 600_000);

  it('without a fire the CO / CO₂ sources are the reference air (assumed), not an estimate', async () => {
    const c = await load(scene([[0, 0]], {}));
    c.advance(1);
    const p = humans(c)[0].physio!.provenance;
    expect(p.co).toBe('reference');
    expect(p.co2).toBe('reference');
    c.unload();
  });
});
