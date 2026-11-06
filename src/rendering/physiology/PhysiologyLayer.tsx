/**
 * Physiology overlay (Phase 34, physiology runs only; render-only — reads e.physio / e.human, never writes): one marker
 * above every person coloured by the chosen metric (core temperature, thermal strain, O₂ supply index, smoke dose, airway
 * time under water, water deficit, fatigue, action capacity) on a fixed, non-clinical scale; a value the model did not
 * compute is drawn small and dark grey (never as the colour of 0); a ring at the airway point while it is under water.
 * Nothing is mounted (or computed) while the overlay is off. Instance buffers are allocated once; the frame loop allocates
 * nothing.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { CAPACITY_LEVELS, deficitPercent, thermalStrain } from '@/physiology/engine';
import { ZERO_C } from '@/thermal/units';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import type { PhysioEntity } from '@/simulation/physiology/state';
import { physioEntities, type PhysioPerson } from '@/simulation/physiology/summary';
import { CAP_COLORS } from '@/ui/Inspector/PhysiologyInspector';
import { useViewStore, type PhysioMetric } from '../viewStore';
import { useDisposable } from '../useDisposable';

/** People drawn (entity order — bounded GPU buffers in crowds). */
export const MAX_PHYSIO_PEOPLE = 256;
export const NOT_COMPUTED_COLOR = '#4a4f57';
export const AIRWAY_COLOR = '#4fc3f7';

export interface PhysioScale {
  /** Value → colour stops (ascending values; linear between them). */
  stops: readonly (readonly [number, string])[];
  unit: string;
  digits: number;
  /** Discrete levels (capacity): one colour per integer value. */
  discrete?: boolean;
}

/** Fixed scales of the overlay metrics (non-clinical: neutral grey at the reference, blue for cold, amber / brown / violet for load). */
export const PHYSIO_SCALES: Record<PhysioMetric, PhysioScale> = {
  core: { stops: [[30, '#3b6fd6'], [35, '#8fb3e8'], [36.8, '#d0d3d8'], [38.5, '#f0c070'], [42, '#d9822b']], unit: '°C', digits: 1 },
  strain: { stops: [[0, '#d0d3d8'], [1.2, '#e6d58a'], [2.2, '#e0a35e'], [3.2, '#b8735a'], [4.2, '#8f5bb5']], unit: 'K', digits: 1 },
  supply: { stops: [[0, '#6b4fc9'], [0.5, '#9a86de'], [0.8, '#bdb4e6'], [1, '#d0d3d8']], unit: '', digits: 2 },
  smoke: { stops: [[0, '#d0d3d8'], [500, '#c9b48a'], [2000, '#9c7a52'], [6000, '#5a4532']], unit: 'mg·min/m³', digits: 0 },
  airway: { stops: [[0, '#d0d3d8'], [10, '#8fc2ea'], [60, '#3b7fc4'], [180, '#1f4f8a']], unit: 's', digits: 0 },
  deficit: { stops: [[0, '#d0d3d8'], [2, '#e6d58a'], [6, '#d99a5b'], [10, '#9b5a2f']], unit: '%', digits: 1 },
  fatigue: { stops: [[0, '#d0d3d8'], [0.5, '#8fc4bd'], [0.8, '#4f9a92'], [1, '#2f6b66']], unit: '', digits: 2 },
  capacity: { stops: CAP_COLORS.map((c, i) => [i, c] as const), unit: '', digits: 0, discrete: true },
};

/** The metric's value for one person (NaN = not computed). Allocation-free. */
export function physioMetric(pe: PhysioEntity, m: PhysioMetric): number {
  const s = pe.s, mods = pe.cfg.modules, sampled = pe.sample !== null;
  switch (m) {
    case 'core': return mods.thermal && s.last ? s.Tc - ZERO_C : NaN;
    case 'strain': return mods.thermal && s.last ? thermalStrain(s.Tc - ZERO_C) : NaN;
    case 'supply': return mods.respiration && s.resp.supply !== null ? s.resp.supply : NaN;
    case 'smoke': return mods.gas && sampled ? (s.dose.smoke * 1e6) / 60 : NaN;
    case 'airway': return mods.submersion && sampled ? s.airway.cumulative : NaN;
    case 'deficit': return mods.hydration && sampled ? deficitPercent(s, pe.cfg.mass) : NaN;
    case 'fatigue': return mods.fatigue && sampled ? s.fatigue : NaN;
    case 'capacity': return CAPACITY_LEVELS.indexOf(s.combined);
  }
}

/** CSS gradient of a scale (legend). */
export function scaleGradient(sc: PhysioScale): string {
  const lo = sc.stops[0][0], hi = sc.stops[sc.stops.length - 1][0];
  return `linear-gradient(90deg, ${sc.stops.map(([v, c]) => `${c} ${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(', ')})`;
}

const SCALE_RGB = Object.fromEntries(Object.entries(PHYSIO_SCALES).map(([k, sc]) => [k, sc.stops.map(([v, c]) => [v, new THREE.Color(c)] as const)])) as unknown as Record<PhysioMetric, readonly (readonly [number, THREE.Color])[]>;
const C_NC = new THREE.Color(NOT_COMPUTED_COLOR);
const C_RING = new THREE.Color(AIRWAY_COLOR);

/** Colour of a value on a metric's scale into `out` (clamped at the ends). */
export function colorOf(m: PhysioMetric, v: number, out: THREE.Color): THREE.Color {
  const st = SCALE_RGB[m];
  if (!Number.isFinite(v)) return out.copy(C_NC);
  if (PHYSIO_SCALES[m].discrete) return out.copy(st[Math.max(0, Math.min(st.length - 1, Math.round(v)))][1]);
  if (v <= st[0][0]) return out.copy(st[0][1]);
  for (let i = 1; i < st.length; i++) {
    if (v <= st[i][0]) return out.copy(st[i - 1][1]).lerp(st[i][1], (v - st[i - 1][0]) / (st[i][0] - st[i - 1][0]));
  }
  return out.copy(st[st.length - 1][1]);
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, order: number) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.count = 0;
  m.frustumCulled = false;
  m.renderOrder = order;
  m.raycast = () => null;
  return m;
}

export function PhysiologyLayer() {
  const on = useViewStore((s) => s.physioViz.enabled);
  const live = useSimStore((s) => s.runtimeVersion);
  const has = useMemo(() => !!simulationController.getRuntime()?.physiology, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  return on && has ? <PhysiologyOverlay /> : null;
}

function PhysiologyOverlay() {
  const version = useSimStore((s) => s.runtimeVersion);
  const runtime = simulationController.getRuntime();
  const people = useMemo<PhysioPerson[]>(() => (runtime ? physioEntities(runtime.entities.values()).slice(0, MAX_PHYSIO_PEOPLE) : []), [runtime, version]);
  const ballGeo = useDisposable(() => new THREE.SphereGeometry(1, 14, 10));
  const ballMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.95 }));
  const markers = useDisposable(() => instanced(ballGeo, ballMat, MAX_PHYSIO_PEOPLE, 11), [ballGeo, ballMat]);
  const ringGeo = useDisposable(() => new THREE.TorusGeometry(1, 0.12, 6, 24).rotateX(Math.PI / 2));
  const ringMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.9 }));
  const rings = useDisposable(() => instanced(ringGeo, ringMat, MAX_PHYSIO_PEOPLE, 11), [ringGeo, ringMat]);
  const tmp = useMemo(() => ({ q: new THREE.Quaternion(), qi: new THREE.Quaternion(), v: new THREE.Vector3(), s: new THREE.Vector3(), m4: new THREE.Matrix4(), c: new THREE.Color() }), []);

  useFrame(() => {
    const vz = useViewStore.getState().physioViz;
    let nm = 0, nr = 0;
    for (const e of people) {
      const pe = e.physio;
      if (e.flags.captured) continue;
      const p = e.pose.position, q = e.pose.quaternion;
      tmp.q.set(q[0], q[1], q[2], q[3]);
      const com = e.human?.model.com;
      if (com) tmp.v.set(com[0], com[1], com[2]).applyQuaternion(tmp.q);
      else tmp.v.set(0, 1, 0);
      tmp.v.x += p[0]; tmp.v.y += p[1] + 1.15; tmp.v.z += p[2];
      const v = physioMetric(pe, vz.metric);
      const ok = Number.isFinite(v);
      tmp.m4.compose(tmp.v, tmp.qi.identity(), tmp.s.setScalar(ok ? 0.16 : 0.09));
      markers.setMatrixAt(nm, tmp.m4);
      markers.setColorAt(nm++, colorOf(vz.metric, v, tmp.c));
      const a = pe.s.airway.state;
      if (vz.airway && pe.sample && (a === 'submerged' || a === 'intermittent')) {
        const w = pe.sample.airway;
        tmp.v.set(w[0], w[1], w[2]);
        tmp.m4.compose(tmp.v, tmp.qi.identity(), tmp.s.setScalar(0.2));
        rings.setMatrixAt(nr, tmp.m4);
        rings.setColorAt(nr++, C_RING);
      }
    }
    markers.count = nm;
    markers.instanceMatrix.needsUpdate = true;
    if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
    rings.count = nr;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  });

  return (
    <group name="physiology-layer">
      <primitive object={markers} />
      <primitive object={rings} />
    </group>
  );
}
