import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useEditorStore } from '@/editor/editorStore';
import { graphOf, type StructuralGraph } from '@/structure/graph';
import { StructuralSolver } from '@/structure/solver';
import { MS, OVERLOAD } from '@/structure/types';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { useDisposable } from '../useDisposable';
import { useViewStore } from '../viewStore';

/** Original-world solution of a graph (before any change in the run), cached per graph. */
const initial = new WeakMap<StructuralGraph, StructuralSolver>();
function initialSolver(g: StructuralGraph): StructuralSolver {
  let s = initial.get(g);
  if (!s) { s = new StructuralSolver(g); s.init(); initial.set(g, s); }
  return s;
}

const cA = new THREE.Color(), cB = new THREE.Color();
const LOW = new THREE.Color('#3fbf7f'), MID = new THREE.Color('#f2c94c'), HIGH = new THREE.Color('#e0443a');
const LOST = new THREE.Color('#e0443a'), PARTIAL = new THREE.Color('#f08a24'), BLOCK = new THREE.Color('#38c6e0'), PICK = new THREE.Color('#ffffff');
const v = new THREE.Vector3(), q = new THREE.Quaternion();

function ramp(u: number, out: THREE.Color) {
  const x = Math.min(1, u / OVERLOAD);
  return x < 0.5 ? out.copy(LOW).lerp(MID, x / 0.5) : out.copy(MID).lerp(HIGH, (x - 0.5) / 0.5);
}

/**
 * Structural overlays of the SELECTED modular building (Phase 25, render-only; every line from the
 * engine's computed state):
 *  - load path: each connection that transfers load, member centre → support centre, colored by the
 *    connection's share / capacity (governed-by-members connections: by the support's utilization);
 *  - connections: failed connections as red crosses;
 *  - foundation support: ground-bearing members with reduced (orange) / lost (red) ground support;
 *  - falling blocks (cyan boxes) and the member picked in the inspector (white box).
 * Before the building's first structural change the original-world solution is shown.
 */
export function StructureOverlay() {
  const ref = useRef<THREE.LineSegments>(null);
  const material = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }), []);
  const geom = useRef<THREE.BufferGeometry | null>(null);
  const key = useRef('');
  useEffect(() => () => geom.current?.dispose(), []);
  useFrame(() => {
    const ls = ref.current;
    if (!ls) return;
    const viz = useViewStore.getState().structureViz;
    const pick = useViewStore.getState().simMember;
    const id = useEditorStore.getState().selectedId;
    const e = id ? simulationController.getRuntime()?.entities.get(id) : undefined;
    const on = !!e?.modular && (viz.loadPath || viz.connections || viz.support || pick?.owner === id);
    ls.visible = on;
    if (!on || !e) return;
    const m = e.modular!.structure?.model;
    const k = `${id}|${m?.rev ?? -1}|${viz.loadPath}|${viz.connections}|${viz.support}|${pick?.owner}|${pick?.member}|${e.rev}`;
    if (k === key.current) return;
    key.current = k;
    const pos: number[] = [], col: number[] = [];
    build(e, viz, pick?.owner === id ? pick.member : -1, pos, col);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geom.current?.dispose();
    geom.current = g;
    ls.geometry = g;
  });
  return <lineSegments ref={ref} material={material} renderOrder={10} frustumCulled={false} raycast={() => null} />;
}

function build(e: RuntimeEntity, viz: { loadPath: boolean; connections: boolean; support: boolean }, picked: number, pos: number[], col: number[]) {
  const mr = e.modular!;
  const model = mr.structure?.model;
  const g = model?.g ?? graphOf(mr.design, mr.scale);
  const s = model?.s ?? initialSolver(g);
  const p = e.pose.position;
  q.set(e.pose.quaternion[0], e.pose.quaternion[1], e.pose.quaternion[2], e.pose.quaternion[3]);
  const W = (x: number, y: number, z: number) => { v.set(x, y, z).applyQuaternion(q); return [p[0] + v.x, p[1] + v.y, p[2] + v.z]; };
  const C = (i: number) => { const o = 6 * i; return W((g.box[o] + g.box[o + 3]) / 2 + (model?.dx[i] ?? 0), (g.box[o + 1] + g.box[o + 4]) / 2 + (model?.dy[i] ?? 0), (g.box[o + 2] + g.box[o + 5]) / 2 + (model?.dz[i] ?? 0)); };
  const seg = (a: number[], b: number[], c: THREE.Color) => { pos.push(...a, ...b); col.push(c.r, c.g, c.b, c.r, c.g, c.b); };
  const box = (i: number, c: THREE.Color, pad = 0.05) => {
    const o = 6 * i;
    const x0 = g.box[o] - pad + (model?.dx[i] ?? 0), x1 = g.box[o + 3] + pad + (model?.dx[i] ?? 0);
    const dy = model?.dy[i] ?? 0;
    const y0 = g.box[o + 1] - pad + dy, y1 = g.box[o + 4] + pad + dy;
    const z0 = g.box[o + 2] - pad + (model?.dz[i] ?? 0), z1 = g.box[o + 5] + pad + (model?.dz[i] ?? 0);
    const P = [W(x0, y0, z0), W(x1, y0, z0), W(x1, y0, z1), W(x0, y0, z1), W(x0, y1, z0), W(x1, y1, z0), W(x1, y1, z1), W(x0, y1, z1)];
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(P[a], P[b], c);
  };
  if (viz.loadPath) {
    let n = 0;
    for (let e2 = 0; e2 < g.edges && n < 20000; e2++) {
      if (!s.edgeAlive[e2] || s.share[e2] <= 0) continue;
      const i = g.eFrom[e2], j = g.eTo[e2];
      if (!s.alive[i] || !s.alive[j]) continue;
      const u = g.eCap[e2] === Infinity ? s.util[j] : s.eUtil[e2];
      seg(C(i), C(j), ramp(u, cA));
      n++;
    }
  }
  if (viz.connections && model) {
    for (let e2 = 0; e2 < g.edges; e2++) {
      if (s.edgeAlive[e2]) continue;
      const a = C(g.eFrom[e2]), b = C(g.eTo[e2]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      seg([m[0] - 0.3, m[1] - 0.3, m[2]], [m[0] + 0.3, m[1] + 0.3, m[2]], LOST);
      seg([m[0] - 0.3, m[1] + 0.3, m[2]], [m[0] + 0.3, m[1] - 0.3, m[2]], LOST);
    }
  }
  if (viz.support) {
    for (let i = 0; i < g.n; i++) {
      if (!(g.ground[i] || g.soilFallback[i])) continue;
      const f = s.groundFactor[i];
      if (f >= 0.999) continue;
      box(i, f < 0.05 ? LOST : cB.copy(PARTIAL).lerp(LOST, 1 - f));
    }
  }
  if (model) for (const b of model.blocks) if (b.active) for (const k of b.bottomK) box(b.members[k], BLOCK, 0.02);
  if (picked >= 0 && picked < g.n && model?.state[picked] !== MS.ABSENT) box(picked, PICK, 0.12);
}
