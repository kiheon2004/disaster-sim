/**
 * Phase 36 (render-only): per-storey earthquake drawing of modular buildings — storey displacements from the storey
 * model's dofs (current flexibility shares), the affine storey shears, and the member matrices the adapter writes with them.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { createDesign } from '@/buildings/design';
import { defaultSpec, presetSpec } from '@/buildings/spec';
import { isLateralRole, type BuildingDesign, type BuildingSpec } from '@/buildings/types';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { SimRenderAdapter } from './SimRenderAdapter';
import type { MemberLayer } from './MemberLayer';
import { currentShares, memberRootIndex, rootAtHeight, storeyDisplacements, storeyShears } from './storeyDrift';

/** A soft ground storey: an RC frame with a shear-wall core whose ground-storey walls are missing (open ground floor). */
function softStorey() {
  const d = createDesign({ ...defaultSpec(), system: 'rcFrame', width: 12, depth: 12, floors: 4, bay: 6, core: true });
  return { ...d, members: d.members.map((m) => (m.level === 0 && m.type === 'wall' && isLateralRole(m.role) ? { ...m, initialDamage: 1 } : m)), edits: d.edits + 1 };
}

async function quakeRun(spec: BuildingSpec | BuildingDesign, preset: string | undefined, pga: number) {
  const d = createEmptyDocument('p36-drift');
  const design = 'members' in spec ? spec : createDesign(spec, preset);
  const o = createWorldObject({ type: 'building', building: design, seed: 5, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0.4, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(d.objects, 'building'));
  d.objects[o.id] = o;
  d.settings.simulation.seed = 42;
  const c = new SimulationController({ headless: true });
  await c.load(d);
  c.addEvent({ event: 'earthquake', magnitude: 7, pga, duration: 20, seed: 3 } as EventSpec);
  return { c, e: c.getRuntime()!.entities.get(o.id)! };
}
const modelOf = (c: SimulationController) => c.getRuntime()!.seismic!.model;
const world = (c: SimulationController, e: RuntimeEntity, j: number): [number, number] => {
  const m = modelOf(c), ui = e.seismic!.unit, o = m.off[ui], cs = m.cos[ui], sn = m.sin[ui];
  const lx = m.u[2 * (o + j)] - m.u[2 * o], lz = m.u[2 * (o + j) + 1] - m.u[2 * o + 1];
  return [lx * cs + lz * sn, -lx * sn + lz * cs];
};

describe('per-storey drift (render-only)', { timeout: 300_000 }, () => {
  it('a soft ground storey drifts more than the storeys above it; the storey tops are the model dofs exactly', async () => {
    const { c, e } = await quakeRun(softStorey(), undefined, 0.15);
    const mr = e.modular!;
    // The analysis sees it: the ground storey is the softest.
    const st = mr.initial.stories;
    for (let s = 1; s < mr.floors; s++) expect(st[0].kx).toBeLessThan(st[s].kx);
    const D = new Float64Array(2 * (mr.floors + 1));
    const peak = new Array(mr.floors).fill(0);
    for (let k = 0; k < 80; k++) {
      c.advance(0.1);
      const live = storeyDisplacements(mr, modelOf(c), e.seismic!.unit, D);
      expect(live).toBe(Math.min(mr.floors, mr.collapsedFrom));
      for (let s = 0; s < live; s++) {
        const r = Math.hypot(D[2 * (s + 1)] - D[2 * s], D[2 * (s + 1) + 1] - D[2 * s + 1]) / mr.initial.stories[s].height;
        peak[s] = Math.max(peak[s], r);
      }
      // ≤ 5 floors: one dof per storey — every storey top IS its dof (relative to the foundation, world axes) …
      for (let s = 0; s < live; s++) {
        const w = world(c, e, s + 1);
        expect(D[2 * (s + 1)]).toBeCloseTo(w[0], 12);
        expect(D[2 * (s + 1) + 1]).toBeCloseTo(w[1], 12);
      }
      // … and the top one is the model's top − base output the single shear used.
      expect(D[2 * live]).toBeCloseTo(e.seismic!.top[0] - e.seismic!.base[0], 12);
      expect(D[2 * live + 1]).toBeCloseTo(e.seismic!.top[1] - e.seismic!.base[1], 12);
    }
    expect(peak[0]).toBeGreaterThan(0);
    for (let s = 1; s < mr.floors; s++) expect(peak[0]).toBeGreaterThan(peak[s]);
    c.unload();
  });

  it('more than 5 floors: storeys of a dof group take their flexibility share, the group top is the dof itself', async () => {
    const { c, e } = await quakeRun(presetSpec('apartment')!, 'apartment', 0.2);
    c.advance(4);
    const mr = e.modular!;
    const L = mr.unit!.lumps;
    const share = currentShares(mr);
    // Shares of each group sum to 1 per axis.
    for (let j = 0; j < L.first.length; j++) {
      const s0 = L.first[j], s1 = j + 1 < L.first.length ? L.first[j + 1] : mr.floors;
      for (const ax of [0, 1]) { let sum = 0; for (let s = s0; s < s1; s++) sum += share[2 * s + ax]; expect(sum).toBeCloseTo(1, 12); }
    }
    const D = new Float64Array(2 * (mr.floors + 1));
    const live = storeyDisplacements(mr, modelOf(c), e.seismic!.unit, D);
    expect(live).toBe(mr.floors);
    for (let j = 1; j <= L.first.length; j++) {
      const last = (j < L.first.length ? L.first[j] : mr.floors) - 1;
      const w = world(c, e, j);
      expect(D[2 * (last + 1)]).toBeCloseTo(w[0], 12);
      expect(D[2 * (last + 1) + 1]).toBeCloseTo(w[1], 12);
    }
    c.unload();
  });

  it('storey shears: a storey goes from its bottom displacement to its top one; floors translate; above the live storeys rigid', () => {
    const stories = [{ base: 0, height: 4 }, { base: 4, height: 3 }, { base: 7, height: 3 }];
    const D = Float64Array.from([0, 0, 0.4, -0.2, 0.5, -0.1, 0.55, 0]);
    const sh = storeyShears(D, 2, stories, 3, 2, new Float64Array(4 * 8));
    const at = (r: number, y: number) => [sh[4 * r] + sh[4 * r + 2] * y, sh[4 * r + 1] + sh[4 * r + 3] * y];
    expect(at(0, 5)).toEqual([0, 0]);
    // Storey 0 from 0 to D(0)·k, storey 1 from D(0)·k to D(1)·k.
    expect(at(1, 0)[0]).toBeCloseTo(0, 12);
    expect(at(1, 4)[0]).toBeCloseTo(0.8, 12);
    expect(at(1, 4)[1]).toBeCloseTo(-0.4, 12);
    expect(at(2, 4)[0]).toBeCloseTo(0.8, 12);
    expect(at(2, 7)[0]).toBeCloseTo(1.0, 12);
    // The floor of level 0 moves with the top of storey 0; storey 2 is not live: rigid with the top live storey.
    expect(at(1 + 3 + 0, 99)).toEqual([0.8, -0.4]);
    expect(at(3, 8)).toEqual([1.0, -0.2]);
    expect(at(1 + 2 * 3, 0)).toEqual([1.0, -0.2]);
    expect(rootAtHeight(-0.1, 2, stories, 3)).toBe(0);
    expect(rootAtHeight(3.9, 2, stories, 3)).toBe(1);
    expect(rootAtHeight(6.5, 2, stories, 3)).toBe(2);
    expect(rootAtHeight(8, 2, stories, 3)).toBe(7);
    expect([memberRootIndex('column', 1, 3), memberRootIndex('slab', 1, 3), memberRootIndex('roof', 3, 3), memberRootIndex('foundation', -1, 3), memberRootIndex('window', 2, 3)]).toEqual([2, 5, 7, 0, 3]);
  });

  it('the adapter draws a ground-storey column sheared by its own storey drift, a top-storey column by its own, the slabs moved with their storey top', async () => {
    const { c, e } = await quakeRun(softStorey(), undefined, 0.15);
    const adapter = new SimRenderAdapter(c.getRuntime()!);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 30, 40);
    camera.updateMatrixWorld();
    const k = 3;
    c.advance(5);
    adapter.update(camera, 5, 0, { exaggeration: k, stress: false });
    const mr = e.modular!;
    const layer = (adapter as unknown as { memberLayer: MemberLayer }).memberLayer;
    const set = layer.get(e.id)!;
    const ms = mr.design.members;
    const mat = new THREE.Matrix4();
    const point = (i: number, y: number) => { layer.meshes[set.look[i]].getMatrixAt(set.inst[i], mat); return new THREE.Vector3(0, y, 0).applyMatrix4(mat); };
    const D = new Float64Array(2 * (mr.floors + 1));
    const live = storeyDisplacements(mr, modelOf(c), e.seismic!.unit, D);
    expect(live).toBe(4);
    const model = mr.structure?.model;
    const standing = (i: number) => !model || model.state[i] <= 2;
    // The residual foundation tilt turns the whole drawing (as the single shear did).
    const sq = e.seismic!, tilt = sq.tiltMag;
    const axis = tilt > 1e-6 ? new THREE.Vector3(sq.tilt[1] / tilt, 0, -sq.tilt[0] / tilt) : new THREE.Vector3(1, 0, 0);
    const tilted = (v: THREE.Vector3) => (tilt > 1e-6 ? v.applyAxisAngle(axis, tilt) : v);
    for (const s of [0, 3]) {
      const col = ms.findIndex((m, i) => m.type === 'column' && m.level === s && standing(i));
      const d = point(col, 0.5).sub(point(col, -0.5));
      // Sheared over the storey height (base to next base, slab included): the column's own height takes its part of it.
      const f = ms[col].size[1] / mr.initial.stories[s].height;
      const want = tilted(new THREE.Vector3((D[2 * (s + 1)] - D[2 * s]) * k * f, ms[col].size[1], (D[2 * (s + 1) + 1] - D[2 * s + 1]) * k * f));
      expect(d.x).toBeCloseTo(want.x, 6);
      expect(d.z).toBeCloseTo(want.z, 6);
    }
    // A level-0 slab is translated, not sheared: its bottom and top move alike, by D(0)·k relative to a foundation pad.
    const slab = ms.findIndex((m, i) => m.type === 'slab' && m.level === 0 && standing(i));
    const pad = ms.findIndex((m) => m.level < 0);
    expect(point(slab, 0.5).x - point(slab, -0.5).x).toBeCloseTo(0, 9);
    const rest = new THREE.Vector3(...ms[slab].position).sub(new THREE.Vector3(...ms[pad].position)).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    const moved = point(slab, 0).sub(point(pad, 0));
    const want = tilted(rest.clone().add(new THREE.Vector3(D[2] * k, 0, D[3] * k)));
    expect(moved.x).toBeCloseTo(want.x, 6);
    expect(moved.z).toBeCloseTo(want.z, 6);
    c.unload();
  });
});
