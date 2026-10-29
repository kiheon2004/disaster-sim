/**
 * Gravity field in the simulation (Phase 31, render-only — reads env.gravity, never writes):
 *  - arrows: the computed g(x, t) on a 9 m grid at 2 m and 14 m above the ground — direction of the field, length
 *    0.25 m per m/s², colour |g| on the fixed magnitude legend
 *  - overlay: |g| or its downward component on the ground (fixed m/s² legends; distinct from the pressure overlays),
 *    or the structural gravity ratio of each modular building (box tint, × g₀), or the normal load of each dynamic body
 *    (m·g_down above it, log kN)
 *  - sources: wireframe sphere / column of each local source in force, its strength factor as the opacity
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { columnGridGeometry, paintColumns } from '../atmosphere/columnGrid';
import { arrowColor, gravityColor } from './gravityColors';

const ARROW_MAX = 2 * 23 * 23;
const SPACING = 9;
const LENGTH_PER_G = 0.25;
const REFRESH = 0.25;

/** A 3D arrow along +y of unit length (shaft + cone). */
export function arrow3d(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.04, 0.04, 0.72, 6).translate(0, 0.36, 0);
  const head = new THREE.ConeGeometry(0.14, 0.28, 8).translate(0, 0.86, 0);
  const g = new THREE.BufferGeometry();
  const a = shaft.toNonIndexed(), b = head.toNonIndexed();
  const pa = a.getAttribute('position').array as Float32Array, pb = b.getAttribute('position').array as Float32Array;
  const pos = new Float32Array(pa.length + pb.length);
  pos.set(pa); pos.set(pb, pa.length);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  shaft.dispose(); head.dispose(); a.dispose(); b.dispose();
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Orient / scale instance k as an arrow from p along g (length ∝ |g|). */
export function placeArrow(mesh: THREE.InstancedMesh, k: number, p: readonly number[], g: readonly number[], m4: THREE.Matrix4, q: THREE.Quaternion, v: THREE.Vector3, s: THREE.Vector3, c: THREE.Color) {
  const mag = Math.hypot(g[0], g[1], g[2]);
  v.set(g[0], g[1], g[2]);
  if (mag > 1e-9) v.multiplyScalar(1 / mag); else v.set(0, -1, 0);
  q.setFromUnitVectors(UP, v);
  const L = Math.max(0.05, mag * LENGTH_PER_G);
  s.set(L, L, L);
  m4.compose(v.set(p[0], p[1], p[2]), q, s);
  mesh.setMatrixAt(k, m4);
  mesh.setColorAt(k, arrowColor(mag, c));
}

export function GravityLayer() {
  const live = useSimStore((s) => s.gravity !== null);
  return live ? <GravityScene /> : null;
}

function GravityScene() {
  const viz = useViewStore((s) => s.gravityViz);
  const env = simulationController.getEnvironment();
  const t = env.terrain.data;
  const W = (t.nx - 1) * t.cellSize, D = (t.nz - 1) * t.cellSize;
  const grid = useMemo(() => ({ originX: t.originX, originZ: t.originZ, nx: Math.ceil(W / 3), nz: Math.ceil(D / 3), dx: 3 }), [t, W, D]);
  const geo = useDisposable(() => columnGridGeometry(grid, (x, z) => env.terrain.sampleHeight(x, z), 0.3), [grid]);
  const mat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 }));
  const aGeo = useDisposable(() => arrow3d());
  const aMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92, depthWrite: false }));
  const arrows = useDisposable(() => { const m = new THREE.InstancedMesh(aGeo, aMat, ARROW_MAX); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [aGeo, aMat]);
  const boxGeo = useDisposable(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const boxMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }));
  const boxes = useDisposable(() => { const m = new THREE.InstancedMesh(boxGeo, boxMat, 1024); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [boxGeo, boxMat]);
  const dotGeo = useDisposable(() => new THREE.SphereGeometry(0.45, 12, 8));
  const dotMat = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
  const dots = useDisposable(() => { const m = new THREE.InstancedMesh(dotGeo, dotMat, 2048); m.count = 0; m.frustumCulled = false; m.raycast = () => null; return m; }, [dotGeo, dotMat]);
  const srcGeo = useDisposable(() => new THREE.SphereGeometry(1, 24, 12));
  const colGeo = useDisposable(() => new THREE.CylinderGeometry(1, 1, 80, 32, 1, true));
  const srcMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffb35c', wireframe: true, transparent: true, opacity: 0.35, depthWrite: false }));
  const tmp = useMemo(() => ({ m4: new THREE.Matrix4(), q: new THREE.Quaternion(), v: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), g: [0, 0, 0] as [number, number, number], last: -1, viz: null as unknown }), []);
  const group = useMemo(() => new THREE.Group(), []);

  useFrame(() => {
    const f = env.gravity.field;
    const time = simulationController.getTime();
    const vs = useViewStore.getState().gravityViz;
    // Refresh every REFRESH s of simulated time, and at once when the view options change (also while paused).
    if (!f || (Math.abs(time - tmp.last) < REFRESH && tmp.last >= 0 && tmp.viz === vs)) return;
    tmp.last = time;
    tmp.viz = vs;
    // Arrows.
    let n = 0;
    if (vs.arrows) {
      for (const h of [2, 14]) for (let z = t.originZ + SPACING / 2; z < t.originZ + D && n < ARROW_MAX; z += SPACING) for (let x = t.originX + SPACING / 2; x < t.originX + W && n < ARROW_MAX; x += SPACING) {
        const y = env.terrain.sampleHeight(x, z) + h;
        f.sample(x, y, z, tmp.g);
        placeArrow(arrows, n++, [x, y, z], tmp.g, tmp.m4, tmp.q, tmp.v, tmp.s, tmp.c);
      }
    }
    arrows.count = n;
    arrows.instanceMatrix.needsUpdate = true;
    if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
    // Ground overlay.
    const o = vs.overlay;
    if (o === 'magnitude' || o === 'down') {
      paintColumns(geo, grid.nx * grid.nz, (a) => {
        const ix = a % grid.nx, iz = (a - ix) / grid.nx;
        const x = grid.originX + (ix + 0.5) * grid.dx, z = grid.originZ + (iz + 0.5) * grid.dx;
        f.sample(x, env.terrain.sampleHeight(x, z) + 1, z, tmp.g);
        return o === 'magnitude' ? Math.hypot(tmp.g[0], tmp.g[1], tmp.g[2]) : -tmp.g[1];
      }, (v, out) => gravityColor(o, v, out));
    }
    // Buildings: structural gravity ratio.
    let b = 0;
    if (o === 'structLoad') {
      for (const e of simulationController.getRuntime()?.entities.values() ?? []) {
        const m = e.modular?.structure?.model;
        if (!e.modular || e.flags.collapsed || b >= 1024) continue;
        let k = 1;
        if (m) { let s = 0, c = 0; for (let i = 0; i < m.n; i++) if (m.alive(i)) { s += m.s.kM[i]; c++; } k = c ? s / c : 1; }
        const p = e.pose.position;
        tmp.m4.compose(tmp.v.set(p[0], p[1], p[2]), tmp.q.set(e.pose.quaternion[0], e.pose.quaternion[1], e.pose.quaternion[2], e.pose.quaternion[3]), tmp.s.set(e.dims[0] + 0.3, e.dims[1] + 0.3, e.dims[2] + 0.3));
        boxes.setMatrixAt(b, tmp.m4);
        boxes.setColorAt(b++, gravityColor('structLoad', k, tmp.c));
      }
    }
    boxes.count = b;
    boxes.instanceMatrix.needsUpdate = true;
    // Bodies: the normal load a resting body puts on what it stands on — m·g_down (a weight, not the contact solver's force).
    let nd = 0;
    if (o === 'contactLoad') {
      const rt = simulationController.getRuntime();
      for (const e of rt?.entities.values() ?? []) {
        if (!e.dynamic || e.body === null || nd >= 2048) continue;
        const p = e.pose.position;
        f.sample(p[0], p[1], p[2], tmp.g);
        const N = (e.source.physics.mass * Math.max(0, -tmp.g[1])) / 1000;
        tmp.m4.compose(tmp.v.set(p[0], p[1] + e.dims[1] + 0.8, p[2]), tmp.q.identity(), tmp.s.set(1, 1, 1));
        dots.setMatrixAt(nd, tmp.m4);
        dots.setColorAt(nd++, gravityColor('contactLoad', Math.log10(Math.max(1e-3, N)), tmp.c));
      }
    }
    dots.count = nd;
    dots.instanceMatrix.needsUpdate = true;
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    // Sources.
    group.clear();
    if (vs.sources) for (const l of f.liveSources()) {
      const s = l.src;
      const mesh = new THREE.Mesh(s.kind === 'region' && s.shape === 'column' ? colGeo : srcGeo, srcMat);
      mesh.position.set(s.center[0], s.kind === 'region' && s.shape === 'column' ? env.terrain.sampleHeight(s.center[0], s.center[2]) + 40 : s.center[1], s.center[2]);
      mesh.scale.set(s.radius, s.kind === 'region' && s.shape === 'column' ? 1 : s.radius, s.radius);
      mesh.raycast = () => null;
      group.add(mesh);
    }
  });

  return (
    <group name="gravity-layer">
      <primitive object={arrows} visible={viz.arrows} />
      <mesh geometry={geo} material={mat} visible={viz.overlay === 'magnitude' || viz.overlay === 'down'} renderOrder={2} raycast={() => null} />
      <primitive object={boxes} visible={viz.overlay === 'structLoad'} />
      <primitive object={dots} visible={viz.overlay === 'contactLoad'} />
      <primitive object={group} visible={viz.sources} />
    </group>
  );
}
