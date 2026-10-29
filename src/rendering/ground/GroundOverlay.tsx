/**
 * Ground-failure overlay in simulation mode (Phase 22, render-only):
 *
 *  - stability   factor of safety of the evaluated vertices (landslide areas, sinkhole surroundings);
 *                failed vertices dark red;
 *  - sediment    thickness of the MOBILE layer (bulked, m);
 *  - deposit     loose material deposited on the ground (m);
 *  - change      height change of the field (bed + mobile layer, blue down / red up);
 *  - arrows      flow direction and speed of the mobile layer (from the solver's face fluxes);
 *  - sources     outlines of the landslide source areas and of the sinkhole pits;
 *  - dust        a VISUAL EFFECT ONLY above fast-moving sediment (never part of the sediment
 *                budget or of any force — the panel says so).
 *
 * Refreshed only when the field changed (field.rev) or the mode changed; the patch covers the
 * models' vertices and the active runout box (not the whole world).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GridRect } from '@/terrain/TerrainData';
import type { DeformationEngine } from '@/deformation/engine';
import type { GroundFailureChannel } from '@/simulation/ground/GroundFailureChannel';
import { simulationController } from '@/simulation/SimulationController';
import { useViewStore } from '../viewStore';
import { useDeformationEngine } from '../terrain/runtimeGround';
import { FieldPatch } from '../deformation/fieldMesh';
import { displacementAlpha, displacementColor, displacementScale } from '../deformation/deformColors';
import { depositColor, FAILED_COLOR, flowColor, fsColor, sedimentColor } from './groundColors';
import { GroundLine, areaOutline } from './GroundTools';

const MAX_ARROWS = 3000;
const MAX_DUST = 1500;
const LATTICE = 2;

/** Vertex rectangle covering every model's vertices and the runout box (padded). */
function regionOf(ch: GroundFailureChannel): GridRect | null {
  const f = ch.field;
  if (!f) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const m of [...ch.sinkholes, ...ch.landslides]) for (const i of m.cells) {
    const ix = i % f.nx, iz = (i - ix) / f.nx;
    if (ix < x0) x0 = ix;
    if (ix > x1) x1 = ix;
    if (iz < z0) z0 = iz;
    if (iz > z1) z1 = iz;
  }
  const a = f.active;
  if (a.x1 >= a.x0) {
    x0 = Math.min(x0, a.x0); x1 = Math.max(x1, a.x1); z0 = Math.min(z0, a.z0); z1 = Math.max(z1, a.z1);
  }
  if (x1 < x0) return null;
  const pad = 6;
  return { x0: Math.max(0, x0 - pad), z0: Math.max(0, z0 - pad), x1: Math.min(f.nx - 1, x1 + pad), z1: Math.min(f.nz - 1, z1 + pad) };
}

const contains = (a: GridRect, b: GridRect) => b.x0 >= a.x0 && b.z0 >= a.z0 && b.x1 <= a.x1 && b.z1 <= a.z1;

/** Mobile-layer velocity at vertex i (mean of the adjacent face fluxes / thickness). */
function velocityAt(ch: GroundFailureChannel, i: number, out: [number, number]): number {
  const f = ch.field!;
  const ix = i % f.nx, iz = (i - ix) / f.nx;
  const h = f.h[i];
  if (h < 0.02) { out[0] = out[1] = 0; return 0; }
  const fx = f.nx - 1;
  let qx = 0, nqx = 0, qz = 0, nqz = 0;
  if (ix > 0) { qx += f.qx[iz * fx + ix - 1]; nqx++; }
  if (ix < f.nx - 1) { qx += f.qx[iz * fx + ix]; nqx++; }
  if (iz > 0) { qz += f.qz[(iz - 1) * f.nx + ix]; nqz++; }
  if (iz < f.nz - 1) { qz += f.qz[iz * f.nx + ix]; nqz++; }
  out[0] = (nqx ? qx / nqx : 0) / h;
  out[1] = (nqz ? qz / nqz : 0) / h;
  return Math.hypot(out[0], out[1]);
}

function Overlay({ engine, ch }: { engine: DeformationEngine; ch: GroundFailureChannel }) {
  const viz = useViewStore((s) => s.groundViz);
  const patchRef = useRef<FieldPatch | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const last = useRef({ rev: -1, mode: '' });
  const [outlineRev, setOutlineRev] = useState(0);
  const { gl, camera } = useThree();
  useEffect(() => {
    if (groupRef.current) gl.compile(groupRef.current, camera);
  }, [gl, camera]);
  const arrows = useMemo(() => {
    const geo = new THREE.ConeGeometry(0.35, 1, 6).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }), MAX_ARROWS);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ARROWS * 3).fill(1), 3);
    m.renderOrder = 6;
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    return m;
  }, []);
  const dust = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_DUST * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#c9b08a', size: 0.9, transparent: true, opacity: 0.35, depthWrite: false }));
    p.frustumCulled = false;
    p.raycast = () => {};
    return { points: p, pos, life: new Float32Array(MAX_DUST), vel: new Float32Array(MAX_DUST * 3), n: 0 };
  }, []);
  useEffect(() => () => {
    patchRef.current?.dispose();
    arrows.geometry.dispose();
    (arrows.material as THREE.Material).dispose();
    dust.points.geometry.dispose();
    (dust.points.material as THREE.Material).dispose();
  }, [arrows, dust]);

  const v2: [number, number] = [0, 0];
  useFrame((_s, delta) => {
    const f = ch.field;
    if (!f) return;
    const t = engine.terrain;
    // Dust (visual only): particles drift up and fade; respawned above fast sediment.
    if (viz.dust && dust.n > 0) {
      let k = 0;
      for (let i = 0; i < dust.n; i++) {
        dust.life[i] -= delta;
        if (dust.life[i] <= 0) continue;
        dust.pos[k * 3] = dust.pos[i * 3] + dust.vel[i * 3] * delta;
        dust.pos[k * 3 + 1] = dust.pos[i * 3 + 1] + dust.vel[i * 3 + 1] * delta;
        dust.pos[k * 3 + 2] = dust.pos[i * 3 + 2] + dust.vel[i * 3 + 2] * delta;
        dust.vel[k * 3] = dust.vel[i * 3]; dust.vel[k * 3 + 1] = dust.vel[i * 3 + 1]; dust.vel[k * 3 + 2] = dust.vel[i * 3 + 2];
        dust.life[k] = dust.life[i];
        k++;
      }
      dust.n = k;
      dust.points.geometry.setDrawRange(0, k);
      dust.points.geometry.attributes.position.needsUpdate = true;
    }
    dust.points.visible = viz.dust;
    const modeKey = `${viz.mode}|${viz.arrows}|${viz.dust}`;
    if (f.rev === last.current.rev && modeKey === last.current.mode) return;
    const revChanged = f.rev !== last.current.rev;
    last.current = { rev: f.rev, mode: modeKey };
    // Patch: grows with the runout box.
    const r = regionOf(ch);
    if (r && (!patchRef.current || !contains(patchRef.current.rect, r))) {
      patchRef.current?.dispose();
      patchRef.current = new FieldPatch(t, r);
      if (meshRef.current) meshRef.current.geometry = patchRef.current.geometry;
    }
    const p = patchRef.current;
    if (p && meshRef.current) {
      meshRef.current.visible = viz.mode !== 'off';
      if (viz.mode === 'stability') {
        p.write(t.heights, 0.05, (_l, g, out) => {
          if (f.failed[g]) return (out.copy(FAILED_COLOR), 0.8);
          if (!f.evaluate[g] || !Number.isFinite(f.fs[g])) return 0;
          return (fsColor(f.fs[g], out), 0.7);
        });
      } else if (viz.mode === 'sediment') {
        p.write(t.heights, 0.05, (_l, g, out) => (f.h[g] < 0.01 ? 0 : (sedimentColor(f.h[g], out), 0.45 + 0.4 * Math.min(1, f.h[g]))));
      } else if (viz.mode === 'deposit') {
        p.write(t.heights, 0.05, (_l, g, out) => (f.loose[g] < 0.01 ? 0 : (depositColor(f.loose[g], out), 0.45 + 0.4 * Math.min(1, f.loose[g]))));
      } else if (viz.mode === 'change') {
        let max = 0;
        for (let iz = p.rect.z0; iz <= p.rect.z1; iz++) for (let ix = p.rect.x0; ix <= p.rect.x1; ix++) max = Math.max(max, Math.abs(f.bed[iz * f.nx + ix] + f.h[iz * f.nx + ix]));
        const scale = displacementScale(max);
        p.write(t.heights, 0.05, (_l, g, out) => {
          const w = f.bed[g] + f.h[g];
          return (displacementColor(w, scale, out), displacementAlpha(w, scale));
        });
      }
    }
    // Flow arrows on a 2 m lattice over the runout box.
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    const a = f.active;
    const step = Math.max(1, Math.round(LATTICE / f.dx));
    let spawn = 0;
    if (a.x1 >= a.x0) {
      for (let iz = a.z0; iz <= a.z1; iz += step) for (let ix = a.x0; ix <= a.x1; ix += step) {
        const i = iz * f.nx + ix;
        const v = velocityAt(ch, i, v2);
        if (v < 0.05) continue;
        const x = f.originX + ix * f.dx, z = f.originZ + iz * f.dx, y = t.heights[i] + 0.3;
        if (viz.arrows && n < MAX_ARROWS) {
          q.setFromAxisAngle(up, Math.atan2(-v2[1], v2[0]));
          const len = Math.min(4, 0.6 + v * 0.35);
          m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(len, 1, 1));
          arrows.setMatrixAt(n, m4);
          arrows.setColorAt(n, flowColor(v, col));
          n++;
        }
        // Dust: a few particles where the sediment moves fast (visual only).
        if (viz.dust && revChanged && v > 1.5 && dust.n < MAX_DUST && spawn < 120) {
          const k = dust.n++;
          spawn++;
          dust.pos[k * 3] = x + (Math.random() - 0.5) * f.dx * step;
          dust.pos[k * 3 + 1] = y + Math.random() * 0.5;
          dust.pos[k * 3 + 2] = z + (Math.random() - 0.5) * f.dx * step;
          dust.vel[k * 3] = v2[0] * 0.3;
          dust.vel[k * 3 + 1] = 0.6 + Math.random() * 0.8;
          dust.vel[k * 3 + 2] = v2[1] * 0.3;
          dust.life[k] = 1.5 + Math.random() * 1.5;
        }
      }
    }
    arrows.count = n;
    arrows.instanceMatrix.needsUpdate = true;
    if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
    // Outlines follow the ground: rebuilt at most every ~10 field revisions.
    if (viz.sources && revChanged && f.rev - outlineRev > 10) setOutlineRev(f.rev);
  });

  const outlines = useMemo(() => {
    const out: { key: string; pts: [number, number][]; color: string }[] = [];
    for (const m of ch.landslides) out.push({ key: m.id, pts: areaOutline(m.spec.area), color: m.failedCells > 0 ? '#ff7a45' : '#ffd34d' });
    for (const m of ch.sinkholes) {
      const r = Math.max(m.a, m.pitRadius);
      const n = 48;
      out.push({ key: m.id, pts: Array.from({ length: n }, (_, i) => [m.spec.center[0] + Math.cos((i / n) * Math.PI * 2) * r, m.spec.center[1] + Math.sin((i / n) * Math.PI * 2) * r] as [number, number]), color: m.phase === 'stable' ? '#7fb6ff' : '#ff7a45' });
    }
    return out;
  }, [ch, outlineRev]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <group name="ground-failure-overlay" ref={groupRef}>
      <mesh ref={meshRef} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-3} />
      </mesh>
      <primitive object={arrows} />
      <primitive object={dust.points} />
      {viz.sources && outlines.map((o) => <GroundLine key={`${o.key}:${outlineRev}`} pts={o.pts} color={o.color} />)}
    </group>
  );
}

export function GroundOverlay() {
  const engine = useDeformationEngine();
  const [ch, setCh] = useState<GroundFailureChannel | null>(null);
  useFrame(() => {
    const c = simulationController.getEnvironment().groundFailure;
    const next = engine && c.active ? c : null;
    if (next !== ch) setCh(next);
  });
  if (!engine || !ch) return null;
  return <Overlay engine={engine} ch={ch} />;
}
