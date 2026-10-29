/**
 * Volcano visuals in simulation mode (Phase 28, render-only — they never feed the simulation), all from
 * the run's computed volcano state:
 *  - lava surface: one mesh over the affected vertex box at the computed lava surface (bed + depth),
 *    colored by the computed surface temperature (incandescent above the Draper point, dark crust below);
 *  - deposits: the terrain itself carries them (Phase 21 path); this layer tints them — lava / bombs dark
 *    basalt, ash grey by thickness, hot deposits by their surface temperature;
 *  - bombs: the computed parcels in flight (instanced, bounded); ash: the computed puffs (camera-facing
 *    quads sized by their spread σ);
 *  - steam (visual only — no steam is computed): white puffs where lava lies under water; fountain
 *    (visual only): spatter over vents while they erupt;
 *  - overlays: lava depth, lava temperature, speed, crystal fraction, ash thickness, ground surface
 *    temperature (thermal exposure).
 * Meshes are rebuilt only when the affected box grows; colors / heights refresh every REFRESH frames.
 * Every GPU resource is owned (useDisposable) and released with the component; built-in materials only.
 */
import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { bombAt } from '@/volcano/bombs';
import { crystalFraction } from '@/volcano/materials';
import { ASH_DEPOSIT_DENSITY } from '@/volcano/LavaField';
import { FieldPatch, swapGeometry } from '../deformation/fieldMesh';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { ASH_COLOR, DEPOSIT_COLOR, lavaColor, overlayColor } from './volcanoColors';
import { toC } from '@/thermal/units';

const MAX_BOMBS = 512;
const MAX_PUFFS = 2400;
const MAX_STEAM = 400;
const MAX_SPATTER = 500;
const REFRESH = 10;

const m4 = new THREE.Matrix4();
const v0 = new THREE.Vector3();
const s0 = new THREE.Vector3();
const q0 = new THREE.Quaternion();
const c0 = new THREE.Color();

export function VolcanoLayer() {
  const live = useSimStore((s) => s.volcano !== null);
  if (!live) return null;
  return <VolcanoScene />;
}

function puffTexture(): THREE.Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    const a = r >= 1 ? 0 : (1 - r * r) ** 1.6;
    data.set([255, 255, 255, Math.round(255 * a)], 4 * (y * size + x));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.count = 0;
  m.frustumCulled = false;
  m.raycast = () => null;
  return m;
}

function points(n: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  return g;
}

function VolcanoScene() {
  const viz = useViewStore((s) => s.volcanoViz);
  const lavaMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  const depMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  const bombGeo = useDisposable(() => new THREE.SphereGeometry(1, 8, 6));
  const bombMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ff7a24', toneMapped: false }));
  const quadGeo = useDisposable(() => new THREE.PlaneGeometry(1, 1));
  const puffTex = useDisposable(() => puffTexture());
  const ashMat = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, color: '#6f6862', transparent: true, depthWrite: false, opacity: 0.35 }), [puffTex]);
  const steamMat = useDisposable(() => new THREE.MeshBasicMaterial({ map: puffTex, color: '#f4f6f8', transparent: true, depthWrite: false, opacity: 0.3 }), [puffTex]);
  const spatterGeo = useDisposable(() => points(MAX_SPATTER));
  const spatterMat = useDisposable(() => new THREE.PointsMaterial({ color: '#ffb347', size: 0.25, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const bombs = useDisposable(() => instanced(bombGeo, bombMat, MAX_BOMBS), [bombGeo, bombMat]);
  const ash = useDisposable(() => instanced(quadGeo, ashMat, MAX_PUFFS), [quadGeo, ashMat]);
  const steam = useDisposable(() => instanced(quadGeo, steamMat, MAX_STEAM), [quadGeo, steamMat]);
  const lavaMesh = useRef<THREE.Mesh>(null);
  const depMesh = useRef<THREE.Mesh>(null);
  const st = useRef<{ box: { x0: number; z0: number; x1: number; z1: number } | null; lava: FieldPatch | null; dep: FieldPatch | null; frame: number; surf: Float32Array | null; sp: { x: Float32Array; v: Float32Array; life: Float32Array; n: number }; seed: number }>({
    box: null, lava: null, dep: null, frame: 0, surf: null, sp: { x: new Float32Array(MAX_SPATTER * 3), v: new Float32Array(MAX_SPATTER * 3), life: new Float32Array(MAX_SPATTER), n: 0 }, seed: 1,
  });
  useEffect(() => () => { st.current.lava?.dispose(); st.current.dep?.dispose(); }, []);

  useFrame(({ camera }, delta) => {
    const env = simulationController.getEnvironment();
    const vr = env.volcano.rt;
    if (!vr) return;
    const vw = vr.world, f = vw.field, t = env.terrain.data, S = st.current;
    const vs = useViewStore.getState().volcanoViz;
    S.frame++;
    // ── Surface meshes (box of everything the volcano touched; grows only).
    if (S.frame % REFRESH === 1) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      const grow = (i: number) => { const ix = i % f.nx, iz = (i / f.nx) | 0; if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iz < z0) z0 = iz; if (iz > z1) z1 = iz; };
      for (const i of f.mobile) grow(i);
      for (const i of f.hot) grow(i);
      const d = f.dirty;
      if (d.x1 >= d.x0) { grow(d.z0 * f.nx + d.x0); grow(d.z1 * f.nx + d.x1); }
      if (S.box) { x0 = Math.min(x0, S.box.x0); z0 = Math.min(z0, S.box.z0); x1 = Math.max(x1, S.box.x1); z1 = Math.max(z1, S.box.z1); }
      if (x1 >= x0) {
        x0 = Math.max(0, x0 - 2); z0 = Math.max(0, z0 - 2); x1 = Math.min(f.nx - 1, x1 + 2); z1 = Math.min(f.nz - 1, z1 + 2);
        // Deposits elsewhere (ash fall far away): scan once per refresh for the bounding box of any deposit.
        if (!S.box || x0 < S.box.x0 || z0 < S.box.z0 || x1 > S.box.x1 || z1 > S.box.z1) {
          S.box = { x0, z0, x1, z1 };
          S.lava?.dispose(); S.dep?.dispose();
          S.lava = new FieldPatch(t, S.box);
          S.dep = new FieldPatch(t, S.box);
          if (lavaMesh.current) swapGeometry(lavaMesh.current, S.lava.geometry);
          if (depMesh.current) swapGeometry(depMesh.current, S.dep.geometry);
        }
      }
      if (S.lava && S.dep) {
        if (!S.surf || S.surf.length !== f.n) S.surf = new Float32Array(f.n);
        const surf = S.surf;
        const b = S.box!;
        for (let iz = b.z0; iz <= b.z1; iz++) for (let ix = b.x0; ix <= b.x1; ix++) { const i = iz * f.nx + ix; surf[i] = f.bed(i) + f.depth(i); }
        const ov = vs.overlay;
        const mat = vw.mat, tr = vr.trt.world.terrain;
        S.lava.write(surf, 0.03, (_l, g, out) => {
          const h = f.depth(g);
          if (h <= 0.01) { out.setRGB(0, 0, 0); return 0; }
          if (ov === 'depth') overlayColor('depth', h, out);
          else if (ov === 'temperature') overlayColor('temperature', toC(f.T[g]), out);
          else if (ov === 'speed') overlayColor('speed', f.speed[g], out);
          else if (ov === 'solid') overlayColor('solid', crystalFraction(mat, f.T[g]), out);
          else lavaColor(toC(f.Ts[g]), out);
          return vs.lava ? 1 : 0;
        });
        S.dep.write(t.heights, 0.02, (_l, g, out) => {
          const dl = (f.depM[g] + f.depB[g]) / (f.rho * f.area), da = f.depA[g] / (ASH_DEPOSIT_DENSITY * f.area);
          if (ov === 'ash') { if (da <= 1e-4) return 0; overlayColor('ash', da, out); return 0.85; }
          if (ov === 'exposure') {
            const ix = g % f.nx, iz = (g / f.nx) | 0;
            const c = Math.min(tr.count - 1, Math.max(0, Math.min(tr.nz - 1, iz) * tr.nx + Math.min(tr.nx - 1, ix)));
            const T = toC(tr.T(c, 0));
            if (T < 25) return 0;
            overlayColor('exposure', T, out);
            return 0.8;
          }
          if (dl > 0.01) {
            if (f.depE[g] > 0 && f.Ts[g] > 798) lavaColor(toC(f.Ts[g]), out); else out.copy(DEPOSIT_COLOR);
            if (da > 0.002) out.lerp(ASH_COLOR, Math.min(0.9, da / 0.05));
            return vs.lava ? 0.95 : 0;
          }
          if (da > 5e-4) { out.copy(ASH_COLOR); return vs.ash ? Math.min(0.85, 0.15 + da / 0.05) : 0; }
          return 0;
        });
      }
    }
    // ── Bombs in flight (the computed parcels).
    const now = env.time;
    let nb = 0;
    if (vs.ejecta) for (const b of vw.bombs) {
      if (b.landed || nb >= MAX_BOMBS) continue;
      if (now < b.parcel.t0) continue;
      const p = bombAt(b, now);
      const r = Math.max(0.15, b.parcel.size / 2);
      m4.compose(v0.set(p[0], p[1], p[2]), q0.identity(), s0.set(r, r, r));
      bombs.setMatrixAt(nb++, m4);
    }
    bombs.count = nb;
    bombs.instanceMatrix.needsUpdate = true;
    // ── Ash puffs (the computed puffs; size from their spread, alpha bins by mass would need per-instance alpha).
    let na = 0;
    if (vs.ash) for (const p of vw.puffs) {
      if (na >= MAX_PUFFS) break;
      const sz = Math.min(60, 2.2 * p.sigma);
      m4.compose(v0.set(p.x, p.y, p.z), camera.quaternion, s0.set(sz, sz, 1));
      ash.setMatrixAt(na++, m4);
    }
    ash.count = na;
    ash.instanceMatrix.needsUpdate = true;
    // ── Steam (visual only) over lava standing under water.
    let ns = 0;
    const water = env.flood.field;
    if (vs.steam && water && S.frame % 4 === 0) {
      for (const i of f.mobile) {
        if (ns >= MAX_STEAM) break;
        const x = f.xOf(i), z = f.zOf(i);
        if (water.sampleDepth(x, z) <= 0.02) continue;
        const k = (S.frame * 7 + i) % 97 / 97;
        m4.compose(v0.set(x, water.sampleSurface(x, z) + 0.5 + k * 3, z), camera.quaternion, s0.set(2 + k * 3, 2 + k * 3, 1));
        steam.setMatrixAt(ns++, m4);
      }
      steam.count = ns;
      steam.instanceMatrix.needsUpdate = true;
    } else if (!vs.steam) steam.count = 0;
    // ── Fountain spatter (visual only) over erupting vents.
    const E = S.sp, dtv = Math.min(0.05, delta);
    const rnd = () => ((S.seed = (S.seed * 16807) % 2147483647) / 2147483647);
    if (vs.fountain) for (const e of vw.eruptions) {
      if (e.phase === 'stopped' || e.phase === 'dormant') continue;
      for (const v of e.vents) {
        let spawn = Math.min(20, 60 * dtv);
        while (spawn > 0 && E.n < MAX_SPATTER) {
          spawn -= 1;
          const i = E.n++;
          E.x.set([v.P[0] + (rnd() - 0.5) * v.spec.radius, v.P[1] + 0.3, v.P[2] + (rnd() - 0.5) * v.spec.radius], 3 * i);
          E.v.set([(rnd() - 0.5) * 3, 4 + 6 * rnd(), (rnd() - 0.5) * 3], 3 * i);
          E.life[i] = 0.6 + 1.2 * rnd();
        }
      }
    }
    let k = 0;
    for (let i = 0; i < E.n; i++) {
      E.life[i] -= dtv;
      if (E.life[i] <= 0 || !vs.fountain) continue;
      for (let a = 0; a < 3; a++) E.x[3 * i + a] += E.v[3 * i + a] * dtv;
      E.v[3 * i + 1] -= 9.81 * dtv;
      if (k !== i) { E.x.copyWithin(3 * k, 3 * i, 3 * i + 3); E.v.copyWithin(3 * k, 3 * i, 3 * i + 3); E.life[k] = E.life[i]; }
      k++;
    }
    E.n = k;
    (spatterGeo.attributes.position.array as Float32Array).set(E.x.subarray(0, 3 * k));
    spatterGeo.attributes.position.needsUpdate = true;
    spatterGeo.setDrawRange(0, k);
    void c0;
  });

  return (
    <group name="volcano-layer">
      <mesh ref={depMesh} material={depMat} renderOrder={2} raycast={() => null} frustumCulled={false} />
      <mesh ref={lavaMesh} material={lavaMat} renderOrder={3} raycast={() => null} frustumCulled={false} />
      <primitive object={bombs} />
      <primitive object={ash} />
      <primitive object={steam} />
      <points geometry={spatterGeo} material={spatterMat} frustumCulled={false} raycast={() => null} />
      {viz.overlay !== 'off' && null}
    </group>
  );
}
