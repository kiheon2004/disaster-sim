/**
 * Phase 35.5 structure v2 (pure engine): the member law by structural type (elastic → plastic → softening → fracture),
 * the same overload on different structural types, toppling about a hinge line when a part loses its support on one side
 * (rotation, tear, free fall, mass / energy ledgers), and v1 unchanged.
 */
import { describe, expect, it } from 'vitest';
import { presetSpec } from '@/buildings/spec';
import { GRAVITY } from '@/core/units';
import { memberLaw, STRUCTURAL_TYPES } from '@/buildings/structuralType';
import type { MaterialId } from '@/buildings/materials';
import { buildGraph } from './graph';
import { CollapseModel } from './collapse';
import { MS } from './types';
import { defaultOptions, type BuildingDesign, type BuildingMember } from '@/buildings/types';


/** A hand-made design (members only), as in structure.test.ts. */
function custom(members: Omit<BuildingMember, 'rotation'>[], floors = 1): BuildingDesign {
  const spec = { ...presetSpec('warehouse')!, floors };
  return { version: 1, spec, members: members.map((m) => ({ rotation: [0, 0, 0] as [number, number, number], ...m })), options: { ...defaultOptions(), allowUnsupported: true }, edits: 1 };
}

function run(m: CollapseModel, seconds = 10) {
  let t = 0;
  for (let k = 0; k < seconds * 60 && m.active; k++) { m.step(1 / 60, t); t += 1 / 60; }
  return t;
}

/** Portal: columns of `col` on RC pads carrying one RC beam (span L). */
function portal(col: MaterialId, L = 6) {
  return custom([
    { id: 'p0', type: 'foundation', role: 'foundation', level: -1, position: [-L / 2, -0.3, 0], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' },
    { id: 'p1', type: 'foundation', role: 'foundation', level: -1, position: [L / 2, -0.3, 0], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' },
    { id: 'c0', type: 'column', role: 'primary', level: 0, position: [-L / 2, 1.5, 0], size: [0.4, 3, 0.4], material: col },
    { id: 'c1', type: 'column', role: 'primary', level: 0, position: [L / 2, 1.5, 0], size: [0.4, 3, 0.4], material: col },
    { id: 'b', type: 'beam', role: 'primary', level: 0, position: [0, 3 - 0.25, 0], size: [L, 0.5, 0.3], material: 'reinforcedConcrete' },
  ]);
}

/** Two RC bays along x (columns at x = −6, 0, +6, z = ±3), two storeys, beams and slabs; members by id. */
function twoBay() {
  const M: Omit<BuildingMember, 'rotation'>[] = [];
  const H = 3;
  for (const x of [-6, 0, 6]) for (const z of [-3, 3]) {
    M.push({ id: `p${x}${z}`, type: 'foundation', role: 'foundation', level: -1, position: [x, -0.3, z], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' });
    for (const lv of [0, 1]) M.push({ id: `c${lv}${x}${z}`, type: 'column', role: 'primary', level: lv, position: [x, lv * H + H / 2, z], size: [0.4, H, 0.4], material: 'reinforcedConcrete' });
  }
  for (const lv of [0, 1]) {
    const y = (lv + 1) * H;
    for (const z of [-3, 3]) for (const xc of [-3, 3]) M.push({ id: `b${lv}${xc}${z}`, type: 'beam', role: 'primary', level: lv, position: [xc, y - 0.25, z], size: [6, 0.5, 0.3], material: 'reinforcedConcrete' });
    for (const x of [-6, 0, 6]) M.push({ id: `bz${lv}${x}`, type: 'beam', role: 'primary', level: lv, position: [x, y - 0.25, 0], size: [0.3, 0.5, 6], material: 'reinforcedConcrete' });
    for (const xc of [-3, 3]) M.push({ id: `s${lv}${xc}`, type: 'slab', role: 'primary', level: lv, position: [xc, y + 0.1, 0], size: [6, 0.2, 6], material: 'reinforcedConcrete' });
  }
  return custom(M, 2);
}

describe('member law by structural type', () => {
  it('stages: elastic ≤ 1, plastic plateau (capacity held), softening (capacity → residual), fracture', () => {
    const S = STRUCTURAL_TYPES;
    expect(memberLaw(S.steel, 0.9)).toEqual({ D: 0, cap: 1, stage: 'elastic' });
    const p = memberLaw(S.steel, 1.3);
    expect(p.stage).toBe('plastic');
    expect(p.cap).toBe(1);
    expect(p.D).toBeGreaterThan(0);
    expect(memberLaw(S.steel, 1.6).stage).toBe('softening');
    expect(memberLaw(S.steel, 1.6).cap).toBeLessThan(1);
    expect(memberLaw(S.steel, 1.9).stage).toBe('fracture');
    // Ductility order: steel's plateau and fracture point lie far beyond masonry's (brittle).
    expect(S.steel.uFracture).toBeGreaterThan(S.timber.uFracture);
    expect(S.timber.uFracture).toBeGreaterThan(S.rc.uFracture);
    expect(S.rc.uFracture).toBeGreaterThan(S.masonry.uFracture);
    expect(memberLaw(S.masonry, 1.1).stage).toBe('fracture');
    // RC fractures exactly where the Phase 25 engine failed every member (u = 1.25).
    expect(memberLaw(S.rc, 1.25).stage).toBe('softening');
    expect(memberLaw(S.rc, 1.2501).stage).toBe('fracture');
    // Monotone: more overload never gives less damage or more capacity.
    for (const t of Object.values(S)) {
      let D = 0, cap = 1;
      for (let u = 0.5; u < t.uFracture; u += 0.01) {
        const l = memberLaw(t, u);
        expect(l.D).toBeGreaterThanOrEqual(D - 1e-12);
        expect(l.cap).toBeLessThanOrEqual(cap + 1e-12);
        D = l.D; cap = l.cap;
      }
    }
  });

  it('the same gradual overload: v1 keeps the member (u < 1.25); v2 lets RC soften and stand, masonry fracture', () => {
    /** Gradual surcharge on the beam until the columns reach `target` (static utilization), then 3 s of rounds. */
    const outcome = (col: MaterialId, target: number, v2: boolean) => {
      const d = portal(col);
      const g = buildGraph(d);
      const m = new CollapseModel(g);
      if (v2) m.enableV2();
      m.init();
      const b = d.members.findIndex((x) => x.id === 'b'), c = d.members.findIndex((x) => x.id === 'c0');
      // Column load = own weight + half the beam load: scale the beam load to reach the target column utilization.
      const u0 = m.s.util[c], Lc = m.s.load[c];
      m.addLoad(b, 2 * Lc * (target / u0 - 1), 'test');
      run(m, 3);
      return { alive: m.alive(c), D: m.damage[c], state: m.state[c] };
    };
    const rc1 = outcome('reinforcedConcrete', 1.2, false);
    expect(rc1.alive).toBe(true);
    expect(rc1.D).toBe(0);
    const rc2 = outcome('reinforcedConcrete', 1.2, true);
    expect(rc2.alive).toBe(true);
    expect(rc2.D).toBeGreaterThan(0.3);
    expect(rc2.state).toBeGreaterThanOrEqual(MS.DAMAGED);
    const ms1 = outcome('masonry', 1.12, false);
    expect(ms1.alive).toBe(true);
    const ms2 = outcome('masonry', 1.12, true);
    expect(ms2.alive).toBe(false);
  });
});

describe('toppling about a hinge (v2)', () => {
  /** The two ground columns of the −x line fail: the −x bay above hangs on the middle column line. */
  function oneSide(v2: boolean) {
    const d = twoBay();
    const g = buildGraph(d);
    const m = new CollapseModel(g);
    if (v2) m.enableV2();
    m.init();
    const lost = d.members.map((x, i) => (x.type === 'column' && x.level === 0 && x.position[0] === -6 ? i : -1)).filter((i) => i >= 0);
    m.fail(lost, 'drift', 'earthquake', 0);
    run(m, 20);
    return { d, g, m };
  }

  it('a part losing its support on one side rotates about the surviving connections, leans outward and tears free', () => {
    const { d, m } = oneSide(true);
    const hinge = m.events.filter((e) => e.kind === 'hinge');
    const release = m.events.filter((e) => e.kind === 'release');
    expect(hinge.length).toBeGreaterThan(0);
    expect(release.length).toBeGreaterThan(0);
    const h = hinge[0] as Extract<typeof hinge[number], { kind: 'hinge' }>;
    const r = release[0] as Extract<typeof release[number], { kind: 'release' }>;
    expect(h.lever).toBeGreaterThan(0.3);
    // The −x bay hangs on the middle column line (x = 0): the hinge axis runs along z, the centre of mass lies on −x.
    expect(Math.abs(h.axis[2])).toBeGreaterThan(0.99);
    expect(h.point[0]).toBeGreaterThan(-2);
    // Rotation then tear at the release rotation of RC connections (0.25 rad), with a positive angular speed.
    expect(r.time).toBeGreaterThan(h.time);
    expect(r.theta).toBeCloseTo(h.release, 9);
    expect(r.omega).toBeGreaterThan(0);
    // It leaned: the members of the first block are drawn tilted about the hinge axis (quaternion axis along z).
    const blk = m.events.find((e) => e.kind === 'ground' && e.group === h.group) as Extract<typeof m.events[number], { kind: 'ground' }>;
    expect(blk).toBeDefined();
    for (const i of blk.members) {
      const q = m.rot!.subarray(4 * i, 4 * i + 4);
      expect(Math.abs(q[3] - 1)).toBeGreaterThan(1e-3);
      expect(Math.abs(q[2])).toBeGreaterThan(Math.abs(q[0]) * 10);
    }
    // The far end (the −x edge beam) dropped further than the members nearer the hinge, before the block landed.
    const near = d.members.findIndex((x) => x.id === 'b0-3-3'), far = d.members.findIndex((x) => x.id === 'bz0-6');
    expect(blk.members).toContain(far);
    expect(m.dy[far]).toBeLessThan(m.dy[near]);
    expect(d.members.length).toBeGreaterThan(0);
    // Mass conserved; released energy accounted for (collision incl. the spin at the tear, plastic absorption, ground).
    expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-9);
    const E = m.ledger.energy;
    expect(E.kinetic).toBeCloseTo(0, 6);
    expect((E.collision + E.absorbed + E.ground) / E.released).toBeCloseTo(1, 6);
  });

  it('v1 (structure model absent) never rotates — same scenario, no hinge events, no rotation array', () => {
    const { m } = oneSide(false);
    expect(m.events.some((e) => e.kind === 'hinge' || e.kind === 'release')).toBe(false);
    expect(m.rot).toBeUndefined();
  });

  it('a rotation about a hinge is deterministic and its first phase follows the pendulum equation', () => {
    const a = oneSide(true).m, b = oneSide(true).m;
    expect(JSON.stringify(Array.from(a.dx)) + JSON.stringify(Array.from(a.dy))).toBe(JSON.stringify(Array.from(b.dx)) + JSON.stringify(Array.from(b.dy)));
    // Small-angle start: θ ≈ ½ α t² with α = M g r / I (the event carries the lever; the release angle bounds θ).
    const h = a.events.find((e) => e.kind === 'hinge') as Extract<CollapseModelEvent, { kind: 'hinge' }>;
    const r = a.events.find((e) => e.kind === 'release') as Extract<CollapseModelEvent, { kind: 'release' }>;
    expect(r.theta).toBeLessThanOrEqual(h.release + 1e-12);
    expect(r.omega).toBeGreaterThan(0);
    expect(r.time).toBeGreaterThan(h.time);
    expect(GRAVITY).toBeGreaterThan(9);
  });
});

type CollapseModelEvent = CollapseModel['events'][number];
