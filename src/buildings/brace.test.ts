/**
 * Phase 36 (structure 2, spec §37): braces — end-point links, gravity hung on the two end members, tension-only axial
 * storey stiffness and strength, buckling / fracture drifts, the braced period band, warnings, save / load, and in a
 * running earthquake: a braced steel frame drifts less than the same frame unbraced; braces buckle and fracture at their
 * drifts; deterministic.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { SimulationController } from '@/simulation/SimulationController';
import { graphOf, MT_BRACE } from '@/structure/graph';
import { CK } from '@/structure/types';
import { createDesign } from './design';
import { defaultSpec } from './spec';
import { analyzeBuilding } from './analysis';
import { addMembers, braceJoints, braceMember, moveMembers, nearestJoint, nextUserIds } from './edit';
import { braceEnds, braceProps, BRACE_SECTION, BUCKLED_DAMAGE } from './brace';
import { planGrid } from './generate';
import { parseDesign } from './schema';
import type { BuildingDesign, BuildingMember, BuildingSpec } from './types';

const steel = (p: Partial<BuildingSpec> = {}): BuildingSpec => ({ ...defaultSpec(), system: 'steelFrame', structureMaterial: 'structuralSteel', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'glass', width: 16, depth: 16, floors: 3, bay: 8, floorHeight: 3.6, groundFloorHeight: 3.6, core: false, ...p });

/** X-braces (two opposite diagonals, column foot → column top) in the first bay of every perimeter line, every storey. */
function braced(d: BuildingDesign, section = BRACE_SECTION, allBays = false): BuildingDesign {
  const g = planGrid(d.spec);
  const cols = d.members.filter((m) => m.type === 'column');
  const at = (x: number, z: number, s: number) => cols.find((m) => m.level === s && Math.abs(m.position[0] - x) < 0.3 && Math.abs(m.position[2] - z) < 0.3)!;
  const foot = (c: BuildingMember): Vec3 => [c.position[0], c.position[1] - c.size[1] / 2 + 0.05, c.position[2]];
  const head = (c: BuildingMember): Vec3 => [c.position[0], c.position[1] + c.size[1] / 2 - 0.05, c.position[2]];
  const ids = nextUserIds(d, 1000);
  let k = 0;
  const out: BuildingMember[] = [];
  const x2 = (a: BuildingMember, b: BuildingMember) => {
    for (const [p, q] of [[foot(a), head(b)], [foot(b), head(a)]] as const) {
      const m = braceMember(d, ids[k++], p, q);
      out.push({ ...m, size: [m.size[0], section, section] });
    }
  };
  const bays = (n: number) => (allBays ? Array.from({ length: n }, (_, i) => i) : [0]);
  for (let s = 0; s < d.spec.floors; s++) {
    for (const z of [g.zs[0], g.zs[g.nz]]) for (const i of bays(g.nx)) x2(at(g.xs[i], z, s), at(g.xs[i + 1], z, s));
    for (const x of [g.xs[0], g.xs[g.nx]]) for (const i of bays(g.nz)) x2(at(x, g.zs[i], s), at(x, g.zs[i + 1], s));
  }
  return addMembers(d, out);
}

describe('brace model (analysis)', () => {
  const d0 = createDesign(steel());
  const d1 = braced(d0);
  const a0 = analyzeBuilding(d0), a1 = analyzeBuilding(d1);
  const braces = d1.members.map((m, i) => (m.type === 'brace' ? i : -1)).filter((i) => i >= 0);

  it('links by its END POINTS to the two columns (not to the bay it spans); nothing rests on a brace', () => {
    expect(braces.length).toBe(3 * 4 * 2);
    for (const i of braces) {
      const sup = a1.members[i].supports.map((j) => d1.members[j]);
      expect(sup.map((m) => m.type)).toEqual(['column', 'column']);
      // Each end point lies in its column's box.
      const ends = braceEnds(d1.members[i]);
      for (const m of sup) expect(ends.some((p) => Math.abs(p[0] - m.position[0]) <= m.size[0] / 2 && Math.abs(p[2] - m.position[2]) <= m.size[2] / 2)).toBe(true);
    }
    for (const m of a1.members) for (const j of m.supports) expect(d1.members[j].type).not.toBe('brace');
    // The structural graph: gusset connections to the same two members, tier 0; no edge into a brace.
    const g = graphOf(d1);
    for (const i of braces) {
      const to = []; for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) { expect(g.eKind[e]).toBe(CK.GUSSET); to.push(g.eTo[e]); }
      expect(to.sort()).toEqual([...a1.members[i].supports].sort());
      expect(g.lateral[i]).toBe(1);
    }
    for (let e = 0; e < g.edges; e++) expect(g.type[g.eTo[e]]).not.toBe(MT_BRACE);
  });

  it('gravity: its weight hangs half on each end member; its mass goes half / half into the storeys it joins', () => {
    for (const i of braces.slice(0, 4)) {
      const [c0, c1] = a1.members[i].supports;
      const w = a1.members[i].mass * 9.81;
      expect(a1.members[i].supported).toBe(true);
      // The end columns carry at least half the brace weight more than in the unbraced frame (several braces may meet).
      expect(a1.members[c0].load - a0.members[c0].load).toBeGreaterThanOrEqual(w / 2 - 1e-6);
      expect(a1.members[c1].load - a0.members[c1].load).toBeGreaterThanOrEqual(w / 2 - 1e-6);
    }
    const bm = (s: number) => braces.filter((i) => d1.members[i].level === s).reduce((t, i) => t + a1.members[i].mass, 0);
    for (let s = 0; s < 3; s++) expect(a1.stories[s].mass - a0.stories[s].mass).toBeCloseTo(bm(s) / 2 + (s + 1 < 3 ? bm(s + 1) / 2 : 0), 6);
  });

  it('lateral: k = E·A·cos²α/L/2 along its plane (tension-only), V = (f_y·A + 0.3·N_cr)·cos α/2; stiffer storeys, shorter period', () => {
    const b = d1.members[braces[0]];
    const p = braceProps(b, a1.members[braces[0]].size);
    expect(p.k).toBeCloseTo((210e9 * p.A * p.cosA ** 2) / p.L / 2, 0);
    expect(p.V).toBeCloseTo(((355e6 * p.A + 0.3 * p.Ncr) * p.cosA) / 2, 0);
    // A 0.15 m steel box (A = 27 cm², I = 1.5e-5 m⁴) on an 8 m × 3.3 m diagonal: λ̄ ≈ 1.5 (EN 1998-1 X-brace range 1.3–2.0).
    expect(Math.sqrt(p.Ny / p.Ncr)).toBeGreaterThan(1.3);
    expect(Math.sqrt(p.Ny / p.Ncr)).toBeLessThan(2);
    const am = a1.members[braces[0]];
    expect(am.kx + am.kz).toBeCloseTo(p.k, 3);
    // Buckling ≈ 0.2 % drift, fracture ≈ 2.8 % (1 % axial strain).
    expect(am.buckleDrift).toBeCloseTo(((Math.min(p.Ncr, p.Ny) / (p.E * p.A)) * p.L) / (p.dy * p.cosA), 12);
    expect(am.driftCapacity).toBeCloseTo((0.01 * p.L) / (p.dy * p.cosA), 12);
    expect(am.buckleDrift!).toBeGreaterThan(0.0015);
    expect(am.buckleDrift!).toBeLessThan(0.003);
    expect(am.driftCapacity).toBeGreaterThan(0.02);
    expect(am.driftCapacity).toBeLessThan(0.035);
    // Each storey: + 4 braces per direction.
    for (let s = 0; s < 3; s++) {
      const add = braces.filter((i) => d1.members[i].level === s).reduce((t, i) => t + a1.members[i].kx, 0);
      expect(a1.stories[s].kx - a0.stories[s].kx).toBeCloseTo(add, 0);
      expect(a1.stories[s].kx).toBeGreaterThan(1.4 * a0.stories[s].kx);
      expect(a1.stories[s].vx).toBeGreaterThan(a0.stories[s].vx);
    }
    expect(a1.periodRaw[0]).toBeLessThan(0.7 * a0.periodRaw[0]);
    expect(a1.periodX).toBeLessThan(0.7 * a0.periodX);
    expect(a1.warnings.some((w) => w.code === 'braceDangling' || w.code === 'braceNoLateral')).toBe(false);
  });

  it('period calibration: a braced direction gets the braced-frame code period — its added stiffness is not calibrated away', () => {
    // Heavy bracing (0.25 m boxes in every perimeter bay): raw period below 0.6 × the moment-frame formula.
    const d = braced(d0, 0.25, true);
    const a = analyzeBuilding(d);
    const H = a.height;
    const tMRF = 0.0724 * H ** 0.8;
    expect(a.periodRaw[0]).toBeLessThan(0.6 * tMRF);
    // With the moment-frame band the stiffness would be scaled by (T_raw / 0.6·T_MRF)² < 1; the braced band keeps it.
    const lost = 1 - (a.periodRaw[0] / (0.6 * tMRF)) ** 2;
    expect(lost).toBeGreaterThan(0.1);
    expect(a.calibration[0]).toBeCloseTo(1, 9);
    expect(a.periodX).toBeCloseTo(a.periodRaw[0], 12);
    expect(a.periodBand[0]).toBeLessThan(0.6 * tMRF);
    // An unbraced frame keeps exactly its band.
    expect(a0.periodBand[0]).toBeCloseTo(0.6 * tMRF, 12);
  });

  it('a brace with an end in the air warns (dangling) and adds no stiffness; a flat brace is reported; old designs are untouched', () => {
    const cols = d0.members.filter((m) => m.type === 'column' && m.level === 0);
    const c = cols[0];
    const dangling = braceMember(d0, 'bx1', [c.position[0], c.position[1] - c.size[1] / 2 + 0.05, c.position[2]], [c.position[0] + 3, 3, c.position[2] + 3]);
    const a = analyzeBuilding(addMembers(d0, [dangling]));
    expect(a.warnings.find((w) => w.code === 'braceDangling')?.members).toEqual(['bx1']);
    const bi = a.members.length - 1;
    expect(a.members[bi].kx + a.members[bi].kz).toBe(0);
    expect(a.stories[0].kx).toBe(a0.stories[0].kx);
    // Joint → joint but flat (both ends at the top of two ground columns): no storey stiffness, reported.
    const c2 = cols.find((m) => Math.abs(m.position[2] - c.position[2]) < 0.1 && m !== c)!;
    const flat = braceMember(d0, 'bx2', [c.position[0], c.position[1] + c.size[1] / 2 - 0.05, c.position[2]], [c2.position[0], c2.position[1] + c2.size[1] / 2 - 0.05, c2.position[2]]);
    const af = analyzeBuilding(addMembers(d0, [flat]));
    expect(af.warnings.find((w) => w.code === 'braceNoLateral')?.members).toEqual(['bx2']);
    // No brace: the analysis is the same object graph as before (no brace warnings, no buckle field).
    expect(a0.warnings.some((w) => w.code.startsWith('brace'))).toBe(false);
    expect(a0.members.some((m) => m.buckleDrift !== undefined)).toBe(false);
  });

  it('editor joints: column ends and beam middles; a brace placed joint → joint follows moves into its storey', () => {
    const j = braceJoints(d0);
    expect(j.length).toBe(d0.members.filter((m) => m.type === 'column').length * 2 + d0.members.filter((m) => m.type === 'beam').length);
    const c = d0.members.find((m) => m.type === 'column' && m.level === 1)!;
    const near = nearestJoint(d0, [c.position[0] + 0.4, c.position[1] + c.size[1] / 2 - 0.2, c.position[2]])!;
    expect(near).toEqual([c.position[0], c.position[1] + c.size[1] / 2 - 0.05, c.position[2]]);
    const b = braceMember(d0, 'u900', [-8, 3.65, -8], [0, 6.85, -8]);
    expect(b.level).toBe(1);
    const ends = braceEnds(b);
    expect(ends[0][0]).toBeCloseTo(-8, 9);
    expect(ends[1][1]).toBeCloseTo(6.85, 9);
    const moved = moveMembers(addMembers(d0, [b]), ['u900'], [0, -3.6, 0]).members.find((m) => m.id === 'u900')!;
    expect(moved.level).toBe(0);
  });

  it('save / load: a braced design round-trips; the member type enum accepts old files unchanged', () => {
    const back = parseDesign(JSON.parse(JSON.stringify(d1)));
    expect(back.dropped).toBe(0);
    expect(back.repaired).toBe(0);
    expect(back.design!.members).toEqual(d1.members);
    const old = parseDesign(JSON.parse(JSON.stringify(d0)));
    expect(old.design!.members).toEqual(d0.members);
    // A world document with a braced building through the file format.
    const doc = createEmptyDocument('braced');
    const o = createWorldObject({ type: 'building', building: d1, seed: 3, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(doc.objects, 'building'));
    doc.objects[o.id] = o;
    const r = parseDocument(serializeDocument(doc));
    expect(r.ok).toBe(true);
    expect(r.ok && r.doc.objects[o.id].building!.members.filter((m) => m.type === 'brace').length).toBe(braces.length);
  });
});

async function quakeRun(design: BuildingDesign, v2: boolean, pga: number, seconds = 14) {
  const d = createEmptyDocument('p36-brace');
  const o = createWorldObject({ type: 'building', building: design, seed: 9, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(d.objects, 'building'));
  d.objects[o.id] = o;
  d.settings.simulation.seed = 42;
  if (v2) d.settings.simulation.structure = { model: 'v2' };
  const c = new SimulationController({ headless: true });
  await c.load(d);
  c.addEvent({ event: 'earthquake', magnitude: 7, pga, duration: 20, seed: 3 } as EventSpec);
  c.advance(seconds);
  const e = c.getRuntime()!.entities.get(o.id)!;
  return { c, e };
}

describe('braces in an earthquake', { timeout: 600_000 }, () => {
  const d0 = createDesign(steel());
  const d1 = braced(d0);

  it('the braced frame drifts less than the same frame unbraced (0.45 g): a quarter of the peak storey drift, a shorter period', async () => {
    const r0 = await quakeRun(d0, false, 0.45);
    const r1 = await quakeRun(d1, false, 0.45);
    const peak = (e: typeof r0.e) => Math.max(...Array.from(e.modular!.storyPeak));
    const p0 = peak(r0.e), p1 = peak(r1.e);
    expect(p1).toBeLessThan(0.75 * p0);
    // The lumped model got the braces' stiffness: shorter period.
    expect(r1.e.modular!.unit!.period[0]).toBeLessThan(0.75 * r0.e.modular!.unit!.period[0]);
    r0.c.unload();
    r1.c.unload();
  });

  it('braces buckle past θ_cr (≈ 0.2 %) and fracture at their drift capacity (≈ 3 %): checked brace by brace (0.45 g, 1.0 g)', async () => {
    let buckled = 0, fractured = 0;
    for (const pga of [0.45, 1.0]) {
      const r1 = await quakeRun(d1, false, pga);
      // Every brace: buckled ⇔ its in-plane peak drift passed θ_cr; failed by drift ⇔ it passed its fracture capacity.
      const mr = r1.e.modular!;
      const ms = mr.design.members;
      for (let i = 0; i < ms.length; i++) {
        if (ms[i].type !== 'brace') continue;
        const s = ms[i].level, y = ms[i].rotation[1];
        const dem = Math.abs(Math.cos(y)) * mr.storyPeakAxis[2 * s] + Math.abs(Math.sin(y)) * mr.storyPeakAxis[2 * s + 1];
        const rec = mr.structure?.model.records.find((x) => x.i === i);
        if (rec?.cause === 'drift') { fractured++; expect(dem).toBeGreaterThanOrEqual(mr.capacity[i] * 0.995); continue; }
        if (rec) continue; // fell with the frame (support / impact), not by its own drift
        if (dem >= mr.buckle![i] * 1.005) { buckled++; expect(mr.damage[i]).toBeGreaterThanOrEqual(BUCKLED_DAMAGE); } else expect(mr.damage[i]).toBeLessThan(BUCKLED_DAMAGE);
        expect(dem).toBeLessThan(mr.capacity[i] * 1.005);
      }
      r1.c.unload();
    }
    expect(buckled).toBeGreaterThan(0);
    expect(fractured).toBeGreaterThan(0);
  });

  it('deterministic, v1 and v2: the same braced run twice gives the same records and drifts', async () => {
    for (const v2 of [false, true]) {
      const one = async () => {
        const { c, e } = await quakeRun(d1, v2, 0.6, 10);
        const out = JSON.stringify({ peak: Array.from(e.modular!.storyPeak), dmg: Array.from(e.modular!.damage), rec: e.modular!.structure?.model.records.map((r) => [r.i, r.time, r.cause]) ?? [] });
        c.unload();
        return out;
      };
      expect(await one()).toBe(await one());
    }
  });
});
