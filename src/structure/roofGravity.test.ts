/**
 * Phase 31 — R1: roof panels fail under snow / ice / gravity loads (reduced roof-system capacity), the load path
 * redistributes, the failed panels fall as debris and the ledgers close; gravity ratios scale dead and surcharge loads.
 */
import { describe, expect, it } from 'vitest';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { GRAVITY } from '@/core/units';
import { CollapseModel, FALL_MIN } from './collapse';
import { graphOf, MT_BEAM, MT_ROOF, MT_COLUMN, MT_WALL } from './graph';
import { MS } from './types';
import { ROOF_DESIGN_LOAD, ROOF_RESISTANCE } from './capacity';

const design = (id: string) => createDesign(presetSpec(id)!, id);
const area = (m: CollapseModel, i: number) => (m.g.box[6 * i + 3] - m.g.box[6 * i]) * (m.g.box[6 * i + 5] - m.g.box[6 * i + 2]);
const roofs = (m: CollapseModel) => Array.from({ length: m.n }, (_, i) => i).filter((i) => m.g.type[i] === MT_ROOF && m.g.roofCap[i] > 0);

function model(id: string) {
  const m = new CollapseModel(graphOf(design(id)));
  const pending = m.init(0.3);
  expect(pending).toEqual([]);
  m.s.enableRoofCheck();
  return m;
}
/** Snow / ice of `kPa` (Earth weight) on every spanning roof panel, as the climate adapter applies it. */
function load(m: CollapseModel, kPa: number, hazard = 'climate') {
  for (const i of roofs(m)) m.addLoad(i, kPa * 1000 * area(m, i), hazard);
}
function gravity(m: CollapseModel, k: number | ((i: number) => number)) {
  for (let i = 0; i < m.n; i++) m.setGravityRatio(i, typeof k === 'number' ? k : k(i));
}
function run(m: CollapseModel, seconds: number, g = GRAVITY) {
  for (let t = 0; t < seconds * 60; t++) m.step(1 / 60, t / 60, undefined, g);
}
const failedRoofs = (m: CollapseModel) => roofs(m).filter((i) => m.state[i] >= MS.FAILED).length;
const structuralFailures = (m: CollapseModel) => m.records.filter((r) => m.g.structural[r.i]).length;

describe('R1 — roof panels under snow and gravity', () => {
  it('the capacity is the documented roof-system value: ROOF_RESISTANCE·(own weight + 1 kPa·area)', () => {
    const m = model('warehouse');
    for (const i of roofs(m)) expect(m.g.roofCap[i]).toBeCloseTo(ROOF_RESISTANCE * (m.g.weight[i] + ROOF_DESIGN_LOAD * area(m, i)), 6);
  });

  it('1. normal gravity, no snow: nothing fails (roof utilisation < 1)', () => {
    const m = model('warehouse');
    run(m, 2);
    expect(m.records).toEqual([]);
    for (const i of roofs(m)) expect(m.s.util[i]).toBeLessThan(0.5);
  });

  it('2. normal gravity, light snow (0.5 kPa): nothing fails', () => {
    for (const id of ['warehouse', 'house']) {
      const m = model(id);
      load(m, 0.5);
      run(m, 2);
      expect(m.records, id).toEqual([]);
    }
  });

  it('3. normal gravity, heavy snow (3 kPa ≈ 1 m of 300 kg/m³ snow): the roof panels fail by themselves (R1), cause bending, hazard climate', () => {
    for (const id of ['warehouse', 'house']) {
      const m = model(id);
      load(m, 3);
      run(m, 3);
      expect(failedRoofs(m), id).toBe(roofs(m).length);
      const r = m.records.find((x) => m.g.type[x.i] === MT_ROOF)!;
      expect(r.cause).toBe('bending');
      expect(r.hazard).toBe('climate');
      expect(r.u).toBeGreaterThanOrEqual(1.25);
    }
  });

  it('4. double gravity + moderate snow (1.2 kPa at g₀): the same snow mass fails the roof at 2 g', () => {
    const a = model('warehouse');
    load(a, 1.2);
    run(a, 2);
    expect(failedRoofs(a)).toBe(0);
    const b = model('warehouse');
    load(b, 1.2);
    gravity(b, 2);
    run(b, 3, 2 * GRAVITY);
    expect(failedRoofs(b)).toBe(roofs(b).length);
    expect(b.records.find((x) => b.g.type[x.i] === MT_ROOF)!.hazard).toBe('gravity');
  });

  it('5. high gravity + ice (density 917 kg/m³, 12 cm ≈ 1.08 kPa) at 2.5 g fails the panels', () => {
    const m = model('house');
    load(m, (0.12 * 917 * GRAVITY) / 1000);
    gravity(m, 2.5);
    run(m, 3, 2.5 * GRAVITY);
    expect(failedRoofs(m)).toBe(roofs(m).length);
  });

  it('6. low gravity, same snow mass: 3 kPa of Earth weight is 0.5 kPa at Moon-like gravity — nothing fails', () => {
    const m = model('warehouse');
    load(m, 3);
    gravity(m, 1.62 / GRAVITY);
    run(m, 3, 1.62);
    expect(failedRoofs(m)).toBe(0);
    expect(Math.max(...roofs(m).map((i) => m.s.util[i]))).toBeLessThan(0.5);
  });

  it('7. partial roof failure: a local gravity increase over half the roof fails only those panels', () => {
    const m = model('warehouse');
    load(m, 1.2);
    const g = m.g;
    const xs = roofs(m).map((i) => (g.box[6 * i] + g.box[6 * i + 3]) / 2);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    gravity(m, (i) => ((g.box[6 * i] + g.box[6 * i + 3]) / 2 > mid ? 2.2 : 1));
    run(m, 3);
    const n = failedRoofs(m);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(roofs(m).length);
    for (const i of roofs(m)) if ((g.box[6 * i] + g.box[6 * i + 3]) / 2 < mid) expect(m.state[i]).toBeLessThan(MS.FAILED);
  });

  it('8. load redistribution after a roof failure: the members that carried the panels are relieved', () => {
    const m = model('warehouse');
    const sup = new Set<number>();
    for (const i of roofs(m)) for (let e = m.g.eStart[i]; e < m.g.eStart[i + 1]; e++) sup.add(m.g.eTo[e]);
    load(m, 3);
    m.step(1 / 60, 0); // loads in, panels over capacity → they fail in this round
    const before = new Map([...sup].map((j) => [j, m.s.load[j]]));
    run(m, 1);
    expect(failedRoofs(m)).toBeGreaterThan(0);
    let relieved = 0;
    for (const j of sup) if (m.alive(j) && m.s.load[j] < before.get(j)! - 1) relieved++;
    expect(relieved).toBeGreaterThan(0);
    // The frame itself survives the loss of its roof covering (no structural member failed; falling panels may break
    // cladding / openings on their way down).
    expect(structuralFailures(m)).toBe(0);
  });

  it('9. failed panels become debris: falling blocks that land as rubble / rest on what is under them', () => {
    const m = model('warehouse');
    load(m, 3);
    run(m, 5);
    const states = roofs(m).map((i) => m.state[i]);
    expect(states.every((s) => s === MS.SETTLED || s === MS.RESTING)).toBe(true);
    expect(m.blocks.length).toBeGreaterThan(0);
    expect(m.blocks.every((b) => !b.active)).toBe(true);
  });

  it('10. after the collapse: structural mass ledger and falling-block energy close', () => {
    const m = model('house');
    load(m, 3.5);
    run(m, 5);
    const L = m.ledger;
    const total = Object.values(L.mass).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    expect(Math.abs(L.residual())).toBeLessThan(1e-9 * total);
    expect(L.energy.released).toBeGreaterThan(0);
    const out = L.energy.collision + L.energy.absorbed + L.energy.ground + L.energy.kinetic;
    expect(Math.abs(L.energy.released - out)).toBeLessThan(1e-6 * L.energy.released);
  });

  it('gravity ratio 1 is bitwise the Phase 25 solver (identity of loads and utilisations)', () => {
    const a = new CollapseModel(graphOf(design('apartment')));
    const b = new CollapseModel(graphOf(design('apartment')));
    a.init(0.3); b.init(0.3);
    gravity(b, 1);
    b.step(1 / 60, 0);
    a.step(1 / 60, 0);
    expect(Array.from(b.s.load)).toEqual(Array.from(a.s.load));
    expect(Array.from(b.s.util)).toEqual(Array.from(a.s.util));
  });

  it('dead load scales with g: at 1.5 g every carried load is 1.5×, utilisations 1.5× (linear model)', () => {
    const a = new CollapseModel(graphOf(design('office')));
    const b = new CollapseModel(graphOf(design('office')));
    a.init(0.3); b.init(0.3);
    gravity(b, 1.5);
    b.step(1 / 60, 0, undefined, 1.5 * GRAVITY);
    for (let i = 0; i < a.n; i++) {
      if (!a.alive(i)) continue;
      expect(b.s.load[i]).toBeCloseTo(1.5 * a.s.load[i], 6);
      if (a.g.type[i] === MT_COLUMN || a.g.type[i] === MT_WALL || a.g.type[i] === MT_BEAM) expect(b.s.util[i]).toBeCloseTo(1.5 * a.s.util[i], 5);
    }
  });

  it('high gravity collapses a frame (4 g on the office block): members fail with hazard gravity, rubble forms', () => {
    const m = new CollapseModel(graphOf(design('office')));
    m.init(0.3);
    gravity(m, 4);
    run(m, 8, 4 * GRAVITY);
    const struct = m.records.filter((r) => m.g.structural[r.i]);
    expect(struct.length).toBeGreaterThan(0);
    expect(struct[0].hazard).toBe('gravity');
    expect(m.piles.length + m.blocks.filter((b) => !b.active).length).toBeGreaterThan(0);
  });

  it('without downward gravity failed members leave as fragments (exit events), never as stalled blocks', () => {
    const m = model('warehouse');
    load(m, 3);
    m.step(1 / 60, 0, undefined, GRAVITY); // the panels fail and form blocks
    m.events = [];
    m.step(1 / 60, 1 / 60, undefined, 0.5 * FALL_MIN);
    expect(m.blocks.every((b) => !b.active)).toBe(true);
    expect(m.events.filter((e) => e.kind === 'exit').length).toBeGreaterThan(0);
  });
});
