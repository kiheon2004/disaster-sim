/**
 * Phase 25 structural engine (pure): graph, incremental load-path solver, capacities, collapse
 * mechanics and the mass ledger — against the Phase 17 analysis and closed-form cases.
 */
import { describe, expect, it } from 'vitest';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { analyzeBuilding } from '@/buildings/analysis';
import { defaultOptions, type BuildingDesign, type BuildingMember } from '@/buildings/types';
import { MATERIALS } from '@/buildings/materials';
import { GRAVITY } from '@/core/units';
import { buildGraph, graphOf, MT_BEAM, MT_COLUMN } from './graph';
import { StructuralSolver } from './solver';
import { beamCapacity, columnCapacity, dynamicFactor } from './capacity';
import { CK, OVERLOAD } from './types';

const preset = (id: string) => createDesign(presetSpec(id)!, id);

/** A hand-made design (members only; the spec only supplies floors / occupancy). */
export function custom(members: Omit<BuildingMember, 'rotation'>[], floors = 1): BuildingDesign {
  const spec = { ...presetSpec('warehouse')!, floors };
  return { version: 1, spec, members: members.map((m) => ({ rotation: [0, 0, 0], ...m })), options: { ...defaultOptions(), allowUnsupported: true }, edits: 1 };
}

/** Two RC columns on pads carrying one beam of span L (+ optional point load column on the beam). */
export function portal(L = 6, extra: Omit<BuildingMember, 'rotation'>[] = []) {
  return custom([
    { id: 'p0', type: 'foundation', role: 'foundation', level: -1, position: [-L / 2, -0.3, 0], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' },
    { id: 'p1', type: 'foundation', role: 'foundation', level: -1, position: [L / 2, -0.3, 0], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' },
    { id: 'c0', type: 'column', role: 'primary', level: 0, position: [-L / 2, 1.5, 0], size: [0.4, 3, 0.4], material: 'reinforcedConcrete' },
    { id: 'c1', type: 'column', role: 'primary', level: 0, position: [L / 2, 1.5, 0], size: [0.4, 3, 0.4], material: 'reinforcedConcrete' },
    { id: 'b', type: 'beam', role: 'primary', level: 0, position: [0, 3 - 0.25, 0], size: [L, 0.5, 0.3], material: 'reinforcedConcrete' },
    ...extra,
  ]);
}

describe('structural graph', () => {
  it('builds tiered support candidates with typed connections, ranks supports below what they carry', () => {
    const g = buildGraph(preset('apartment'));
    expect(g.n).toBe(preset('apartment').members.length);
    for (let e = 0; e < g.edges; e++) expect(g.rank[g.eTo[e]]).toBeLessThan(g.rank[g.eFrom[e]]);
    const kinds = new Set(Array.from(g.eKind));
    for (const k of [CK.BEAM_SEAT, CK.SPLICE, CK.BASE, CK.SLAB, CK.HOSTED]) expect(kinds.has(k)).toBe(true);
    // Upper-story columns have a transfer tier (the beams / slab of the joint under them).
    const d = preset('apartment');
    const i = d.members.findIndex((m) => m.id === 'c2-1-1');
    const tiers = new Set<number>();
    for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) tiers.add(g.eTier[e]);
    expect([...tiers].sort()).toEqual([0, 1]);
  });

  it('is cached per design and scale and shared (designs are immutable)', () => {
    const d = preset('house');
    expect(graphOf(d)).toBe(graphOf(d));
    expect(graphOf(d, [1.2, 1, 1])).not.toBe(graphOf(d));
  });
});

describe('solver vs Phase 17 analysis', () => {
  for (const id of ['house', 'apartment', 'office', 'warehouse', 'industrial']) {
    it(`initial state = analysis of the original world (${id})`, () => {
      const d = preset(id);
      const a = analyzeBuilding(d);
      const s = new StructuralSolver(buildGraph(d));
      const pending = s.init();
      expect(pending).toEqual([]);
      for (let i = 0; i < s.n; i++) {
        expect(s.supported[i]).toBe(a.members[i].supported ? 1 : 0);
        expect(s.load[i]).toBeCloseTo(a.members[i].load, 6);
      }
      // Gravity check: columns, bearing walls and suspended slabs reproduce Phase 17 exactly. Beams:
      // the engine places each share where it acts (a neighbouring slab touching the beam only at a
      // support adds no moment; Phase 17 smears every share over the span) → never more than Phase 17.
      for (let i = 0; i < s.n; i++) {
        const m = d.members[i], am = a.members[i];
        if (!am.bearing || am.utilization <= 1e-6 || s.g.ground[i]) continue;
        if (m.type === 'beam') expect(s.uM[i]).toBeLessThanOrEqual(am.utilization * 1.01);
        else expect(s.util[i] / am.utilization).toBeCloseTo(1, 6);
      }
    });
  }

  it('incremental re-analysis after a member loss = full Phase 17 re-analysis rounds (loads, support)', () => {
    const d = preset('apartment');
    const g = buildGraph(d);
    // Losses without a vertical member left standing on a transfer (there the engine adds frame action, below).
    for (const id of ['c5-1-1', 'c5-0-0', 'bx3-1-1', 'sl2-1-1', 'bz0-0-0', 'w2-s-1']) {
      const s = new StructuralSolver(g);
      s.init();
      const k = d.members.findIndex((m) => m.id === id);
      s.kill(k);
      // Static propagation: members left without support leave the structure.
      const r = s.propagate(false);
      const failed = new Set([id, ...r.lost.map((x) => d.members[x.i].id)]);
      // Phase 17: re-analyse until no member is unsupported (failed members removed each round).
      let a = analyzeBuilding(d, { failed });
      for (let round = 0; round < 20; round++) {
        const next = d.members.filter((m, i) => !failed.has(m.id) && !a.members[i].supported).map((m) => m.id);
        if (!next.length) break;
        next.forEach((x) => failed.add(x));
        a = analyzeBuilding(d, { failed });
      }
      for (let i = 0; i < s.n; i++) {
        expect(s.alive[i] === 1).toBe(!failed.has(d.members[i].id));
        if (!s.alive[i]) continue;
        expect(s.load[i]).toBeCloseTo(a.members[i].load, 4);
      }
    }
  });

  it('after a lost ground column every floor above picks up its own load through its joint (frame action)', () => {
    const d = preset('apartment');
    const g = buildGraph(d);
    const s = new StructuralSolver(g);
    s.init();
    const idx = (id: string) => d.members.findIndex((m) => m.id === id);
    const line = [1, 2, 3, 4, 5].map((k) => idx(`c${k}-1-0`));
    const before = line.map((i) => s.load[i]);
    s.kill(idx('c0-1-0'));
    const r = s.propagate(false);
    expect(r.lost).toEqual([]);
    // c1 stands on the joint-0 beams / slab (transfer); c2…c5 share between the column below and their joint.
    expect(s.tier[line[0]]).toBe(1);
    for (const i of line.slice(1)) expect(s.tier[i]).toBe(5);
    // The column directly above the loss carries far less than the whole line it carried before.
    expect(s.load[line[0]]).toBeLessThan(0.5 * before[0]);
    // Total gravity load is conserved: the foundations still carry the whole building.
    let base = 0, base0 = 0;
    const s0 = new StructuralSolver(g); s0.init();
    for (let i = 0; i < s.n; i++) if (g.ground[i]) { base += s.load[i]; base0 += s0.load[i]; }
    expect(base / (base0 - g.weight[idx('c0-1-0')])).toBeCloseTo(1, 12);
  });

  it('visits only the affected region (cost proportional to the change)', () => {
    const d = preset('tower');
    const s = new StructuralSolver(buildGraph(d));
    s.init();
    const before = Float64Array.from(s.load);
    s.visits = 0;
    s.kill(d.members.findIndex((m) => m.id === 'c20-0-0'));
    s.propagate(false);
    let changed = 0;
    for (let i = 0; i < s.n; i++) if (Math.abs(s.load[i] - before[i]) > 1e-12 * Math.max(1, before[i])) changed++;
    // Each member of the affected region (the load path under the lost column) is visited at most
    // once per pass; the rest of the building is never touched.
    expect(changed).toBeGreaterThan(0);
    expect(s.visits).toBeLessThanOrEqual(2 * changed + 64);
    expect(s.visits).toBeLessThan(s.n / 2);
  });
});

describe('member demand / capacity (closed forms)', () => {
  const rc = MATERIALS.reinforcedConcrete;

  it('beam under its own weight: M = W·L/8, V = W/2; columns carry half each', () => {
    const d = portal(6);
    const g = buildGraph(d);
    const s = new StructuralSolver(g);
    s.init();
    const b = d.members.findIndex((m) => m.id === 'b');
    const W = g.weight[b];
    const cap = beamCapacity('reinforcedConcrete', 6, 0.5, 0.3);
    expect(s.uM[b]).toBeCloseTo((W * 6) / 8 / cap.M, 6);
    expect(s.uV[b]).toBeCloseTo(W / 2 / cap.V, 6);
    const c0 = d.members.findIndex((m) => m.id === 'c0');
    expect(s.load[c0]).toBeCloseTo(W / 2 + g.weight[c0], 6);
    expect(s.uN[c0]).toBeCloseTo(s.load[c0] / columnCapacity(rc, 0.4, 3, 0.4), 6);
  });

  it('a column standing on the beam at midspan adds P·L/4; the load positions matter', () => {
    const post = { id: 'post', type: 'column' as const, role: 'secondary' as const, level: 1, position: [0, 4, 0] as [number, number, number], size: [0.3, 2, 0.3] as [number, number, number], material: 'reinforcedConcrete' as const };
    const d = portal(6, [post]);
    const g = buildGraph(d);
    const s = new StructuralSolver(g);
    s.init();
    const b = d.members.findIndex((m) => m.id === 'b');
    const p = d.members.findIndex((m) => m.id === 'post');
    expect(s.load[b]).toBeCloseTo(g.weight[b] + g.weight[p], 6);
    const cap = beamCapacity('reinforcedConcrete', 6, 0.5, 0.3);
    // UDL + (almost) point load at midspan (footprint 0.3 m: exact partial-UDL value).
    const P = g.weight[p], W = g.weight[b], c = 0.3;
    const M = (W * 6) / 8 + (P * 6) / 4 - (P * c) / 8;
    expect(s.uM[b] * cap.M).toBeCloseTo(M, 3);
  });

  it('losing one support turns the beam into a cantilever (M = W·L/2) — and a weak beam fails', () => {
    const d = portal(6);
    const g = buildGraph(d);
    const s = new StructuralSolver(g);
    s.init();
    const b = d.members.findIndex((m) => m.id === 'b');
    const W = g.weight[b];
    s.kill(d.members.findIndex((m) => m.id === 'c1'));
    s.propagate(true);
    const cap = beamCapacity('reinforcedConcrete', 6, 0.5, 0.3);
    // Cantilever from the remaining column (support at the beam end, -L/2).
    expect(s.uM[b] * cap.M).toBeCloseTo((W * 6) / 2, 1);
    expect(s.alive[b]).toBe(1);
  });

  it('dynamic increase factor (GSA 2016): ductile 1.14, semi-ductile 1.27, brittle ≈ 2', () => {
    expect(dynamicFactor(MATERIALS.reinforcedConcrete)).toBeCloseTo(1.04 + 0.45 / 4.48, 9);
    expect(dynamicFactor(MATERIALS.timber)).toBeCloseTo(1.04 + 0.45 / 1.98, 9);
    expect(dynamicFactor(MATERIALS.masonry)).toBeCloseTo(1.04 + 0.45 / 0.48, 9);
  });

  it('a sudden overload is reported with the amplified utilization; a gradual one is not amplified', () => {
    const d = portal(6);
    const g = buildGraph(d);
    for (const dyn of [false, true]) {
      const s = new StructuralSolver(g);
      s.init();
      const b = d.members.findIndex((m) => m.id === 'b');
      const u0 = s.util[b];
      // Surcharge that brings the static utilization to exactly 1.2 (below OVERLOAD). The beam's
      // own weight + surcharge act as one uniform load, so u scales with it.
      const target = 1.2;
      const W = g.weight[b];
      s.addExtra(b, ((target / u0) - 1) * W);
      expect(s.util[b] === u0).toBe(true);
      const r = s.propagate(dyn);
      expect(s.util[b]).toBeCloseTo(target, 3);
      const f = r.failed.find((x) => x.i === b);
      if (!dyn) expect(f).toBeUndefined();
      else {
        const om = dynamicFactor(MATERIALS.reinforcedConcrete);
        expect(target + (om - 1) * (target - u0)).toBeGreaterThan(OVERLOAD);
        // Short deep RC beam: shear governs (V = W/2 on 1.5 MPa·b·0.9h vs M = W·L/8).
        expect(f?.cause).toBe(s.uV[b] > s.uM[b] ? 'shear' : 'bending');
      }
    }
  });

  it('member types: beams / columns are flagged in the graph', () => {
    const g = buildGraph(portal(6));
    expect(Array.from(g.type).filter((t) => t === MT_BEAM).length).toBe(1);
    expect(Array.from(g.type).filter((t) => t === MT_COLUMN).length).toBe(2);
    expect(g.weight[4]).toBeCloseTo(g.mass[4] * GRAVITY, 9);
  });
});

// ── Collapse mechanics ────────────────────────────────────────────────

import { impactOutcome, fallTime } from './falling';
import { moundHeight, moundVolume, outsideFraction, pileHeightAt, settlePile } from './rubble';
import { CollapseModel } from './collapse';
import { MS } from './types';
import { MassLedger } from './ledger';

function runModel(m: CollapseModel, seconds = 10) {
  let t = 0;
  for (let k = 0; k < seconds * 60 && m.active; k++) { m.step(1 / 60, t); t += 1 / 60; }
  return t;
}

describe('falling block impact (closed forms)', () => {
  it('momentum-conserving collision + rigid-plastic arrest: energy balance closes exactly', () => {
    for (const P of [0, 2e6, 5e7, 1e9, Infinity]) {
      for (const deltaU of [0.01, 0.12, 0.5]) {
        const inp = { M: 4e5, v: 7, mR: 1.5e5, P, deltaU, g: GRAVITY };
        const o = impactOutcome(inp);
        const Mt = inp.M + inp.mR;
        expect(o.vCollision).toBeCloseTo((inp.M * inp.v) / Mt, 12);
        expect(o.collisionLoss).toBeCloseTo(0.5 * inp.M * inp.v ** 2 * (inp.mR / Mt), 6);
        const lhs = o.K0 + o.potential;
        const rhs = o.collisionLoss + o.absorbed + 0.5 * Mt * o.vResidual ** 2;
        expect(lhs).toBeCloseTo(rhs, 4);
        if (P === Infinity) expect(o.arrested).toBe(true);
        if (P <= Mt * GRAVITY) expect(o.arrested).toBe(false);
        if (o.arrested && P !== Infinity) expect(o.distance).toBeCloseTo(o.K1 / (P - Mt * GRAVITY), 9);
      }
    }
  });

  it('free fall time over a gap is exact', () => {
    expect(fallTime(2.9, 0, 9.81)).toBeCloseTo(Math.sqrt((2 * 2.9) / 9.81), 12);
    const t = fallTime(3, 2, 9.81);
    expect(2 * t + 0.5 * 9.81 * t * t).toBeCloseTo(3, 12);
  });
});

describe('rubble pile geometry', () => {
  it('mound height inverts the volume; slopes at the angle of repose; outside share', () => {
    for (const [W, D, V] of [[10, 8, 50], [30, 30, 8000], [2, 1, 0.5]]) {
      const H = moundHeight(W, D, V);
      expect(moundVolume(W, D, H)).toBeCloseTo(V, 6);
      const p = settlePile({ x0: 0, z0: 0, x1: W, z1: D, y: 0, mass: 1, volume: V, height: 0 });
      expect(pileHeightAt(p, W / 2, D / 2)).toBeCloseTo(H, 9);
      expect(pileHeightAt(p, W + H / Math.tan((37 * Math.PI) / 180), D / 2)).toBeCloseTo(0, 9);
      expect(outsideFraction(W, D, H)).toBeGreaterThan(0);
      expect(outsideFraction(W, D, H)).toBeLessThan(1);
    }
  });
});

describe('collapse model (time evolution)', () => {
  it('a beam whose columns are crushed falls freely and lands after √(2h/g); columns stay as rubble in place', () => {
    const d = portal(6);
    const m = new CollapseModel(buildGraph(d));
    m.init();
    const c = ['c0', 'c1'].map((id) => d.members.findIndex((x) => x.id === id));
    m.fail(c, 'axial', 'earthquake', 0);
    runModel(m, 5);
    const b = d.members.findIndex((x) => x.id === 'b');
    expect(m.state[b]).toBe(MS.SETTLED);
    for (const i of c) expect(m.state[i]).toBe(MS.SETTLED);
    const block = m.events.find((e) => e.kind === 'block');
    const ground = m.events.find((e) => e.kind === 'ground');
    expect(block && ground).toBeTruthy();
    // The beam bottom (2.5 m) falls onto the crushed column rubble (0.4 m thick) on the pads → 2.1 m … or the ground floor.
    const t = ground!.time - block!.time;
    const h = 2.5 - 0.4;
    expect(Math.abs(t - Math.sqrt((2 * h) / GRAVITY))).toBeLessThan(0.3);
    expect(Math.abs(m.ledger.residual())).toBeLessThan(1e-6);
    expect(m.ledger.mass.rubble).toBeCloseTo(m.ledger.original - m.ledger.mass.structure, 6);
  });

  it('ground-story loss → global collapse, the whole superstructure in a rubble pile, mass conserved', () => {
    const d = preset('apartment');
    const m = new CollapseModel(buildGraph(d));
    m.init();
    m.failStory(0, 'story', 'earthquake', 0);
    runModel(m, 20);
    expect(m.active).toBe(false);
    expect(m.collapseLevel()).toBe('global');
    for (let i = 0; i < m.n; i++) expect(m.state[i] === MS.FALLING).toBe(false);
    expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-12);
    expect(m.ledger.mass.falling).toBeCloseTo(0, 6);
    expect(m.piles.length).toBeGreaterThan(0);
    // Every failure is attributed to the earthquake chain; members that lost support have a trigger.
    for (const r of m.records) expect(r.hazard).toBe('earthquake');
    expect(m.records.some((r) => r.cause === 'support' && r.trigger >= 0)).toBe(true);
  });

  it('top-story loss → the falling roof crushes the floors below (progressive collapse), energy ledger consistent', () => {
    const d = preset('apartment');
    const m = new CollapseModel(buildGraph(d));
    m.init();
    m.failStory(5, 'story', 'earthquake', 0);
    runModel(m, 20);
    const impacts = m.events.filter((e) => e.kind === 'impact');
    expect(impacts.length).toBeGreaterThan(0);
    // Floors failed under impact, in time order (crush-down from the top).
    const crushed = m.records.filter((r) => r.cause === 'impact' && d.members[r.i].type === 'slab');
    expect(crushed.length).toBeGreaterThan(0);
    for (let k = 1; k < crushed.length; k++) expect(crushed[k].time).toBeGreaterThanOrEqual(crushed[k - 1].time);
    // Energy: everything released went into collisions, absorption or the ground (no kinetic energy left).
    const E = m.ledger.energy;
    expect(E.kinetic).toBeCloseTo(0, 6);
    expect((E.collision + E.absorbed + E.ground) / E.released).toBeCloseTo(1, 6);
  });

  it('partial collapse: a light roof falling onto a strong floor is arrested, the floor below stands', () => {
    const d = preset('house');
    const m = new CollapseModel(buildGraph(d));
    m.init();
    m.failStory(1, 'story', 'wind', 0);
    runModel(m, 10);
    expect(m.collapseLevel()).toBe('partial');
    expect(m.events.some((e) => e.kind === 'impact' && e.arrested)).toBe(true);
    // The ground story still stands and carries the rubble resting on it.
    const standing = d.members.filter((x, i) => x.level === 0 && x.type === 'wall' && x.role === 'bearing' && m.alive(i));
    expect(standing.length).toBeGreaterThan(0);
    let extra = 0;
    for (let i = 0; i < m.n; i++) if (m.alive(i)) extra += m.s.extra[i];
    expect(extra).toBeCloseTo(m.ledger.mass.resting * GRAVITY, 3);
  });

  it('single column loss stays local (the transfer beams fail, the frame above re-routes)', () => {
    const d = preset('apartment');
    const m = new CollapseModel(buildGraph(d));
    m.init();
    m.fail([d.members.findIndex((x) => x.id === 'c0-1-0')], 'drift', 'earthquake', 0);
    runModel(m, 10);
    expect(m.collapseLevel()).toBe('local');
    expect(m.standingMass()).toBeGreaterThan(0.95 * m.superMass);
  });

  it('deterministic: the same failure gives the same sequence, bit for bit', () => {
    const seq = () => {
      const d = preset('office');
      const m = new CollapseModel(buildGraph(d));
      m.init();
      m.failStory(4, 'story', 'earthquake', 0);
      runModel(m, 20);
      return JSON.stringify(m.records.map((r) => [r.seq, r.i, r.time, r.cause, r.trigger, r.root, r.u])) + JSON.stringify(Array.from(m.dy));
    };
    expect(seq()).toBe(seq());
  });

  it('state transitions are explicit (illegal ones throw)', () => {
    const m = new CollapseModel(buildGraph(portal(6)));
    m.init();
    expect(() => (m as unknown as { set(i: number, s: number): void }).set(0, MS.SETTLED)).toThrow();
  });

  it('mass ledger moves never create or lose mass', () => {
    const L = new MassLedger(1000);
    L.move('structure', 'falling', 300);
    L.move('falling', 'rubble', 200);
    L.move('falling', 'bodies', 100);
    expect(L.residual()).toBe(0);
    expect(L.detached()).toBe(300);
  });
});
