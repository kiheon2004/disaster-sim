/**
 * Thermal visuals in simulation mode (Phase 26, render-only — they never feed the simulation), all
 * read from the run's thermal state:
 *  - temperature heatmap draped on the ground over the active tiles: surface (ground, or water where
 *    wet), the air-layer temperature, the peak surface temperature so far, or the surface gradient
 *    (K/m) — on the fixed °C scale chosen in the view options (no auto-rescaling); cells within
 *    0.5 K of the ambient stay clear (hot AND cold regions are colored);
 *  - isotherms at 50 / 100 / 300 / 600 °C (hot / cold region outlines);
 *  - conductive heat-flux arrows −λ∇T of the ground surface layer, colored by |q| (W/m², log);
 *  - a ring above every heated object / rubble heap colored by its surface temperature;
 *  - source markers (point, disc, sphere); `glow` adds an incandescent visual tint to hot sources —
 *    the computed thermal radiation itself is infrared and drawn only as its effect (temperatures).
 * Updated 4 times per second; every GPU resource is released with the component.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { BK } from '@/thermal/ThermalBodies';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { isolines } from '../blast/blastGrid';
import { fluxColor, temperatureColor } from './thermalColors';

const LIFT = 0.12;
const MAX_RINGS = 3000;
const MAX_ARROWS = 6000;
export const ISOTHERMS_C = [50, 100, 300, 600];

const c0 = new THREE.Color();
const m4 = new THREE.Matrix4();
const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const v0 = new THREE.Vector3();
const s0 = new THREE.Vector3();

export function ThermalLayer() {
  const live = useSimStore((s) => s.thermal !== null);
  if (!live) return null;
  return <ThermalScene />;
}

function ThermalScene() {
  const viz = useViewStore((s) => s.thermalViz);
  const env = simulationController.getEnvironment();
  const rt0 = env.thermal.rt!;
  const n = rt0.world.terrain.count;
  const grid = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(n * 6);
    for (let k = 0; k < n; k++) { const a = 4 * k; idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], 6 * k); }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    return g;
  }, [n]);
  const gridMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
  const iso = useDisposable(() => new THREE.BufferGeometry());
  const isoMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#111111', transparent: true, opacity: 0.75, depthTest: false }));
  const arrows = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_ARROWS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_ARROWS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    return g;
  });
  const arrowMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
  const ringGeo = useDisposable(() => new THREE.RingGeometry(0.45, 0.7, 20));
  const ringMat = useDisposable(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  const rings = useMemo(() => {
    const m = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => null;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3);
    return m;
  }, [ringGeo, ringMat]);
  const sphereGeo = useDisposable(() => new THREE.SphereGeometry(1, 32, 16));
  const srcMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffd34d', wireframe: true, transparent: true, opacity: 0.5 }));
  const glowMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ff7a1a', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const srcGroup = useRef<THREE.Group>(null);
  const last = useRef(-1);

  useFrame(({ clock }) => {
    const rt = env.thermal.rt;
    if (!rt) return;
    const t = clock.elapsedTime;
    if (t - last.current < 0.25) return;
    last.current = t;
    const w = rt.world, g = w.terrain, tr = env.terrain, nl = g.nl;
    const vs = useViewStore.getState().thermalViz;
    const scale = vs.scale;
    // ── Heatmap over the active tiles.
    const pos = grid.attributes.position.array as Float32Array, col = grid.attributes.color.array as Float32Array;
    let k = 0;
    const valueOf = (c: number): number => {
      if (vs.field === 'air') { const [x, z] = g.cellCenter(c); return w.air.T(w.air.index(x, z, 1)) - 273.15; }
      if (vs.field === 'peak') return (Number.isFinite(g.Tpeak[c]) ? g.Tpeak[c] : w.Tref) - 273.15;
      if (w.water && w.water.h[c] > WATER_MERGE) return w.waterT(c) - 273.15;
      return g.T(c, 0) - 273.15;
    };
    const gradAt = (c: number) => {
      const ix = c % g.nx, iz = (c / g.nx) | 0;
      const T = g.T(c, 0);
      const gx = ix + 1 < g.nx ? g.T(c + 1, 0) - T : T - g.T(c - 1, 0);
      const gz = iz + 1 < g.nz ? g.T(c + g.nx, 0) - T : T - g.T(c - g.nx, 0);
      return [gx / g.cell, gz / g.cell];
    };
    if (vs.field !== 'off') {
      const amb = w.Tref - 273.15;
      g.forActive((c, ix, iz) => {
        let v: number, color: THREE.Color;
        if (vs.field === 'gradient') {
          const [gx, gz] = gradAt(c);
          v = Math.hypot(gx, gz);
          if (v < 0.5) return;
          color = temperatureColor(v, 50, c0);
        } else {
          v = valueOf(c);
          if (Math.abs(v - amb) < 0.5) return;
          color = temperatureColor(v, scale, c0);
        }
        const x0 = g.originX + ix * g.cell, z0 = g.originZ + iz * g.cell, x1 = x0 + g.cell, z1 = z0 + g.cell;
        const water = w.water && w.water.h[c] > WATER_MERGE ? w.water.h[c] : 0;
        const pts = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]];
        for (let p = 0; p < 4; p++) {
          const j = 4 * k + p;
          pos[3 * j] = pts[p][0];
          pos[3 * j + 1] = tr.sampleHeight(pts[p][0], pts[p][1]) + LIFT + water;
          pos[3 * j + 2] = pts[p][1];
          col[4 * j] = color.r; col[4 * j + 1] = color.g; col[4 * j + 2] = color.b; col[4 * j + 3] = 0.68;
        }
        k++;
      });
    }
    grid.setDrawRange(0, k * 6);
    grid.attributes.position.needsUpdate = true;
    grid.attributes.color.needsUpdate = true;
    grid.computeBoundingSphere();
    // ── Isotherms and flux arrows over the bounding box of the active tiles.
    let segs = new Float32Array(0);
    let na = 0;
    if ((vs.isotherms || vs.vectors) && g.tiles.length) {
      let tx0 = Infinity, tz0 = Infinity, tx1 = -1, tz1 = -1;
      for (const tt of g.tiles) { const tx = tt % g.ntx, tz = (tt / g.ntx) | 0; tx0 = Math.min(tx0, tx); tz0 = Math.min(tz0, tz); tx1 = Math.max(tx1, tx); tz1 = Math.max(tz1, tz); }
      const ix0 = tx0 * 10, iz0 = tz0 * 10, ix1 = Math.min(g.nx, tx1 * 10 + 10), iz1 = Math.min(g.nz, tz1 * 10 + 10);
      const bw = ix1 - ix0, bh = iz1 - iz0;
      if (vs.isotherms && bw > 1 && bh > 1) {
        const vals = new Float32Array(bw * bh), ys = new Float32Array(bw * bh);
        for (let iz = 0; iz < bh; iz++) for (let ix = 0; ix < bw; ix++) {
          const c = (iz + iz0) * g.nx + ix + ix0;
          const tile = (((iz + iz0) / 10) | 0) * g.ntx + (((ix + ix0) / 10) | 0);
          vals[iz * bw + ix] = g.tileOn[tile] ? valueOf(c) : w.Tref - 273.15;
          const [x, z] = g.cellCenter(c);
          ys[iz * bw + ix] = tr.sampleHeight(x, z) + 1.5;
        }
        const field = { nx: bw, nz: bh, x0: g.originX + (ix0 + 0.5) * g.cell, z0: g.originZ + (iz0 + 0.5) * g.cell, step: g.cell, y: ys };
        const parts: Float32Array[] = [];
        for (const level of ISOTHERMS_C) parts.push(isolines(field as unknown as Parameters<typeof isolines>[0], vals, level, 0.3));
        const total = parts.reduce((s, p) => s + p.length, 0);
        segs = new Float32Array(total);
        let o = 0;
        for (const p of parts) { segs.set(p, o); o += p.length; }
      }
      if (vs.vectors) {
        const ap = arrows.attributes.position.array as Float32Array, ac = arrows.attributes.color.array as Float32Array;
        for (let iz = iz0 + 1; iz < iz1 - 1 && na < MAX_ARROWS; iz += 2) for (let ix = ix0 + 1; ix < ix1 - 1 && na < MAX_ARROWS; ix += 2) {
          const c = iz * g.nx + ix;
          const tile = ((iz / 10) | 0) * g.ntx + ((ix / 10) | 0);
          if (!g.tileOn[tile]) continue;
          const [gx, gz] = gradAt(c);
          const kk = g.k[c * nl];
          const qx = -kk * gx, qz = -kk * gz, q = Math.hypot(qx, qz);
          if (q < 10) continue;
          const L = Math.min(1.8, 0.4 * (Math.log10(q) - 0.5));
          const [x, z] = g.cellCenter(c);
          const y = tr.sampleHeight(x, z) + 0.35;
          fluxColor(q, c0);
          ap.set([x, y, z, x + (qx / q) * L, y, z + (qz / q) * L], 6 * na);
          ac.set([c0.r * 0.6, c0.g * 0.6, c0.b * 0.6, c0.r, c0.g, c0.b], 6 * na);
          na++;
        }
        arrows.attributes.position.needsUpdate = true;
        arrows.attributes.color.needsUpdate = true;
      }
    }
    iso.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    iso.computeBoundingSphere();
    arrows.setDrawRange(0, na * 2);
    arrows.computeBoundingSphere();
    // ── Object rings.
    let r = 0;
    if (vs.objects) {
      const B = w.bodies;
      for (let i = 0; i < B.n && r < MAX_RINGS; i++) {
        if (!B.alive[i] || B.kind[i] === BK.member) continue;
        const T = B.TS[i] - 273.15;
        if (Math.abs(T - (w.Tref - 273.15)) < 0.5) continue;
        const size = Math.max(0.6, Math.min(4, Math.max(B.sx[i], B.sz[i]) * 0.6));
        m4.compose(v0.set(B.x[i], B.y[i] + B.sy[i] / 2 + 0.6, B.z[i]), q0, s0.set(size, size, size));
        rings.setMatrixAt(r, m4);
        rings.setColorAt(r, temperatureColor(T, scale, c0));
        r++;
      }
    }
    rings.count = r;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    // ── Source markers.
    const grp = srcGroup.current;
    if (grp) {
      const srcs = env.thermal.sources;
      while (grp.children.length < srcs.length * 2) {
        const a = new THREE.Mesh(sphereGeo, srcMat); a.raycast = () => {}; grp.add(a);
        const b = new THREE.Mesh(sphereGeo, glowMat); b.raycast = () => {}; grp.add(b);
      }
      grp.children.forEach((o, j) => { o.visible = false; void j; });
      srcs.forEach((s, j) => {
        const sp = s.spec, local = simulationController.getTime() - s.start;
        const on = local >= 0 && (sp.profile === 'instant' ? local < 1 : local < sp.duration);
        const y = tr.sampleHeight(sp.position[0], sp.position[1]) + sp.height;
        const R = sp.kind === 'point' ? 0.35 : sp.kind === 'area' ? sp.radius : sp.radius;
        const a = grp.children[2 * j] as THREE.Mesh, b = grp.children[2 * j + 1] as THREE.Mesh;
        a.position.set(sp.position[0], sp.kind === 'area' ? tr.sampleHeight(sp.position[0], sp.position[1]) : y, sp.position[1]);
        a.scale.set(R, sp.kind === 'area' ? 0.05 : R, R);
        a.visible = true;
        b.position.copy(a.position);
        b.scale.copy(a.scale).multiplyScalar(1.05);
        b.visible = vs.glow && on;
      });
    }
  });

  return (
    <group name="thermal-layer">
      <mesh geometry={grid} material={gridMat} renderOrder={3} raycast={() => null} frustumCulled={false} />
      {viz.isotherms && <lineSegments geometry={iso} material={isoMat} renderOrder={6} raycast={() => null} />}
      {viz.vectors && <lineSegments geometry={arrows} material={arrowMat} renderOrder={7} raycast={() => null} frustumCulled={false} />}
      <primitive object={rings} />
      <group ref={srcGroup} />
    </group>
  );
}
