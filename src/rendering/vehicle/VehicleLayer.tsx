/**
 * Vehicle layer (Phase 35, vehicle-dynamics runs only; render-only — reads e.vehicle / the body pose, never writes).
 *
 * Wheels (always drawn for wheeled cars): the legacy car draws its four wheel boxes merged into the body geometry, which can
 * neither spin nor steer; for a wheeled ('vehicle') car the adapter leaves them out and this layer draws four wheels from the
 * model state instead — centre = strut mount − (free length − compression) along the body's up axis, turned by the road-wheel
 * steer angle about the strut, rotated by the integrated wheel spin about the axle (a light spoke bar makes the spin visible).
 * Seated occupants (their person is hidden by the adapter — a standing figure would poke through the roof) are drawn as a
 * small seat marker visible through the cabin: blue restrained, amber unrestrained.
 *
 * Debug overlay (viewStore.vehicleViz, off by default):
 *  - contacts: wheel contact points, coloured by the tyre state (grip / high slip / sliding / locked / ABS releasing)
 *  - normals: the contact normal (unit 0.6 m; WheelState.normal when the model records it, else the terrain normal at the
 *    point, else the body's up axis — drawn approximation)
 *  - tyre: the tyre force in the ground plane (F_x, F_y), suspension: the strut force along the body up axis (1 m per 5 kN)
 *  - com: the centre of mass, coloured by the lateral load-transfer ratio LTR (rollover risk) when `ltr` is on
 *  - velocity: the body's velocity (0.2 m per m/s), impulse: the last collision episode's impulse at its contact point
 *    (1 m per 2 kN·s)
 * Buffers are allocated once per run (count of wheeled cars) and reused every frame; everything is disposed on unmount.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Vec3 } from '@/core/types';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { vehicleEntities, type VehicleCarEntity } from '@/simulation/vehicle/summary';
import { seatLocal } from '@/simulation/vehicle/VehicleMonitorSystem';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';

/** Wheeled cars drawn (entity order — bounded GPU buffers). */
export const MAX_VEHICLES = 512;
/** Arrow scales of the debug overlay (legend). */
export const VEHICLE_SCALES = { forcePerM: 5000, velocityPerM: 5, impulsePerM: 2000, normal: 0.6, cap: 6 } as const;
export const SLIP_COLORS = { grip: '#4fd1a0', slip: '#f5c13b', sliding: '#ef4d4d', locked: '#c43bd6', abs: '#7fd0ff' } as const;
export const LTR_STOPS: readonly (readonly [number, string])[] = [[0, '#4fd1a0'], [0.5, '#e6d14a'], [0.8, '#f5973b'], [1, '#ef4d4d']];
export const VEC_COLORS = { normal: '#ffffff', tyre: '#ffc46b', suspension: '#5fa8ff', velocity: '#5cf08a', impulse: '#ff4fd8' } as const;
/** |κ| or |α| (rad) above which a gripping tyre is drawn as "high slip". */
export const SLIP_MARK = 0.1;
const TYRE_W = { sedan: 0.22, suv: 0.26, truck: 0.32 } as const;
const LINES_PER_CAR = 14;
const MARKS_PER_CAR = 5;
const MAX_SEATS = 4;

const C = Object.fromEntries(Object.entries({ ...SLIP_COLORS, ...VEC_COLORS }).map(([k, v]) => [k, new THREE.Color(v)])) as Record<keyof typeof SLIP_COLORS | keyof typeof VEC_COLORS, THREE.Color>;
const C_WHITE = new THREE.Color('#ffffff');
const C_RESTRAINED = new THREE.Color('#5fa8ff');
const C_UNRESTRAINED = new THREE.Color('#f5973b');
const LTR_RGB = LTR_STOPS.map(([v, c]) => [v, new THREE.Color(c)] as const);

/** LTR → colour (clamped, linear between the stops). */
export function ltrColor(v: number, out: THREE.Color): THREE.Color {
  if (!Number.isFinite(v) || v <= LTR_RGB[0][0]) return out.copy(LTR_RGB[0][1]);
  for (let i = 1; i < LTR_RGB.length; i++) if (v <= LTR_RGB[i][0]) return out.copy(LTR_RGB[i - 1][1]).lerp(LTR_RGB[i][1], (v - LTR_RGB[i - 1][0]) / (LTR_RGB[i][0] - LTR_RGB[i - 1][0]));
  return out.copy(LTR_RGB[LTR_RGB.length - 1][1]);
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, order: number, colors: boolean) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  if (colors) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.count = 0;
  m.frustumCulled = false;
  m.renderOrder = order;
  m.raycast = () => null;
  return m;
}

export function VehicleLayer() {
  const version = useSimStore((s) => s.runtimeVersion);
  const cars = useMemo<VehicleCarEntity[]>(() => {
    const rt = simulationController.getRuntime();
    return rt?.vehicles ? vehicleEntities(rt.entities.values()).filter((e) => e.vehicle.level === 'vehicle').slice(0, MAX_VEHICLES) : [];
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const debug = useViewStore((s) => s.vehicleViz.enabled);
  if (!cars.length) return null;
  return (
    <group name="vehicle-layer">
      <VehicleWheels cars={cars} />
      {debug && <VehicleDebug cars={cars} />}
    </group>
  );
}

function VehicleWheels({ cars }: { cars: VehicleCarEntity[] }) {
  const n = cars.length * 4;
  const seats = cars.length * MAX_SEATS;
  const tyreGeo = useDisposable(() => new THREE.CylinderGeometry(1, 1, 1, 18).rotateX(Math.PI / 2));
  const tyreMat = useDisposable(() => new THREE.MeshStandardMaterial({ color: '#1c1d20', roughness: 0.9 }));
  const tyres = useDisposable(() => instanced(tyreGeo, tyreMat, n, 0, false), [tyreGeo, tyreMat, n]);
  const spokeGeo = useDisposable(() => new THREE.BoxGeometry(1, 1, 1));
  const spokeMat = useDisposable(() => new THREE.MeshStandardMaterial({ color: '#9aa0a8', roughness: 0.6, metalness: 0.3 }));
  const spokes = useDisposable(() => instanced(spokeGeo, spokeMat, n * 2, 0, false), [spokeGeo, spokeMat, n]);
  const seatGeo = useDisposable(() => new THREE.SphereGeometry(1, 10, 8));
  const seatMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.9 }));
  const seatMarks = useDisposable(() => instanced(seatGeo, seatMat, seats, 10, true), [seatGeo, seatMat, seats]);
  const tmp = useMemo(() => ({
    body: new THREE.Matrix4(), local: new THREE.Matrix4(), m: new THREE.Matrix4(), part: new THREE.Matrix4(), q: new THREE.Quaternion(), qs: new THREE.Quaternion(),
    qw: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1), ay: new THREE.Vector3(0, 1, 0), az: new THREE.Vector3(0, 0, 1),
  }), []);

  useFrame(() => {
    const rt = simulationController.getRuntime();
    let nt = 0, ns = 0, nm = 0;
    for (const e of cars) {
      const v = e.vehicle, g = v.geo;
      if (e.flags.captured || e.body === null) continue;
      const pp = e.pose.position, pq = e.pose.quaternion;
      tmp.body.compose(tmp.p.set(pp[0], pp[1], pp[2]), tmp.q.set(pq[0], pq[1], pq[2], pq[3]), tmp.one);
      const R = g.spec.wheelRadius, w = TYRE_W[v.variant] ?? 0.24;
      for (let i = 0; i < 4; i++) {
        const W = v.dyn.wheels[i], mt = g.mounts[i];
        const drop = g.freeLength[i] - Math.min(W.compression, g.freeLength[i]);
        tmp.qs.setFromAxisAngle(tmp.ay, W.steer).multiply(tmp.qw.setFromAxisAngle(tmp.az, -W.spin));
        tmp.local.compose(tmp.p.set(mt[0], mt[1] - drop, mt[2]), tmp.qs, tmp.one);
        tmp.m.multiplyMatrices(tmp.body, tmp.local);
        tyres.setMatrixAt(nt++, tmp.part.copy(tmp.m).scale(tmp.s.set(R, R, w)));
        // Two crossed spoke bars, slightly wider than the tyre.
        spokes.setMatrixAt(ns++, tmp.part.copy(tmp.m).scale(tmp.s.set(R * 1.7, R * 0.2, w + 0.02)));
        tmp.part.copy(tmp.m).multiply(tmp.local.makeRotationZ(Math.PI / 2)).scale(tmp.s.set(R * 1.7, R * 0.2, w + 0.02));
        spokes.setMatrixAt(ns++, tmp.part);
      }
      if (rt) for (const o of v.occupants) {
        if (o.state !== 'seated' || nm >= seats) continue;
        const he = rt.entities.get(o.human);
        if (!he?.occupant) continue;
        const sl = seatLocal(v, o.seat);
        tmp.local.compose(tmp.p.set(sl[0], sl[1] + 0.55, sl[2]), tmp.qw.identity(), tmp.s.setScalar(0.11));
        seatMarks.setMatrixAt(nm, tmp.m.multiplyMatrices(tmp.body, tmp.local));
        seatMarks.setColorAt(nm++, o.restrained ? C_RESTRAINED : C_UNRESTRAINED);
      }
    }
    tyres.count = nt;
    tyres.instanceMatrix.needsUpdate = true;
    spokes.count = ns;
    spokes.instanceMatrix.needsUpdate = true;
    seatMarks.count = nm;
    seatMarks.instanceMatrix.needsUpdate = true;
    if (seatMarks.instanceColor) seatMarks.instanceColor.needsUpdate = true;
  });

  return (
    <group name="vehicle-wheels">
      <primitive object={tyres} />
      <primitive object={spokes} />
      <primitive object={seatMarks} />
    </group>
  );
}

function VehicleDebug({ cars }: { cars: VehicleCarEntity[] }) {
  const nL = cars.length * LINES_PER_CAR, nM = cars.length * MARKS_PER_CAR;
  const ballGeo = useDisposable(() => new THREE.SphereGeometry(1, 10, 8));
  const ballMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.95 }));
  const marks = useDisposable(() => instanced(ballGeo, ballMat, nM, 11, true), [ballGeo, ballMat, nM]);
  const lineGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nL * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nL * 6), 3));
    g.setDrawRange(0, 0);
    return g;
  }, [nL]);
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
  const lines = useMemo(() => { const l = new THREE.LineSegments(lineGeo, lineMat); l.frustumCulled = false; l.renderOrder = 11; l.raycast = () => null; return l; }, [lineGeo, lineMat]);
  const tmp = useMemo(() => ({ q: new THREE.Quaternion(), qi: new THREE.Quaternion(), v: new THREE.Vector3(), up: new THREE.Vector3(), s: new THREE.Vector3(), m4: new THREE.Matrix4(), c: new THREE.Color(), n: [0, 1, 0] as Vec3 }), []);

  useFrame(() => {
    const vz = useViewStore.getState().vehicleViz;
    const physics = simulationController.getPhysics();
    const terrain = simulationController.getEnvironment().terrain;
    const pos = lineGeo.getAttribute('position') as THREE.BufferAttribute, col = lineGeo.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, K = col.array as Float32Array;
    let nl = 0, nm = 0;
    const seg = (ax: number, ay: number, az: number, dx: number, dy: number, dz: number, scale: number, c: THREE.Color) => {
      const len = Math.hypot(dx, dy, dz) / scale;
      if (len < 1e-3 || nl >= nL) return;
      const k = (len > VEHICLE_SCALES.cap ? VEHICLE_SCALES.cap / len : 1) / scale;
      const o = nl * 6;
      P[o] = ax; P[o + 1] = ay; P[o + 2] = az;
      P[o + 3] = ax + dx * k; P[o + 4] = ay + dy * k; P[o + 5] = az + dz * k;
      K[o] = K[o + 3] = c.r; K[o + 1] = K[o + 4] = c.g; K[o + 2] = K[o + 5] = c.b;
      nl++;
    };
    const mark = (x: number, y: number, z: number, r: number, c: THREE.Color) => {
      tmp.m4.compose(tmp.v.set(x, y, z), tmp.qi.identity(), tmp.s.setScalar(r));
      marks.setMatrixAt(nm, tmp.m4);
      marks.setColorAt(nm++, c);
    };
    for (const e of cars) {
      const v = e.vehicle;
      if (e.flags.captured || e.body === null) continue;
      const pq = e.pose.quaternion, pp = e.pose.position;
      tmp.q.set(pq[0], pq[1], pq[2], pq[3]);
      tmp.up.set(0, 1, 0).applyQuaternion(tmp.q);
      for (const W of v.dyn.wheels) {
        if (!W.contact) continue;
        const [x, y, z] = W.point;
        const i = v.dyn.wheels.indexOf(W);
        if (vz.contacts) {
          const c = !vz.slip ? C_WHITE : W.locked ? C.locked : v.dyn.abs[i] ? C.abs : W.sliding ? C.sliding : Math.abs(W.kappa) > SLIP_MARK || Math.abs(W.alpha) > SLIP_MARK ? C.slip : C.grip;
          mark(x, y, z, 0.09, c);
        }
        if (vz.normals) {
          const wn = (W as { normal?: Vec3 }).normal;
          let n: readonly number[] = [tmp.up.x, tmp.up.y, tmp.up.z];
          if (wn) n = wn;
          else if (Math.abs(y - terrain.sampleHeight(x, z)) < 0.1) n = terrain.sampleNormal(x, z, tmp.n);
          seg(x, y, z, n[0], n[1], n[2], 1 / VEHICLE_SCALES.normal, C.normal);
        }
        // Strut force along the body up axis; the rest of the applied force is the tyre force in the ground plane.
        const fs = W.Fs;
        if (vz.suspension) seg(x, y, z, tmp.up.x * fs, tmp.up.y * fs, tmp.up.z * fs, VEHICLE_SCALES.forcePerM, C.suspension);
        if (vz.tyre) seg(x, y, z, W.force[0] - tmp.up.x * fs, W.force[1] - tmp.up.y * fs, W.force[2] - tmp.up.z * fs, VEHICLE_SCALES.forcePerM, C.tyre);
      }
      tmp.v.set(v.geo.com[0], v.geo.com[1], v.geo.com[2]).applyQuaternion(tmp.q);
      const cx = pp[0] + tmp.v.x, cy = pp[1] + tmp.v.y, cz = pp[2] + tmp.v.z;
      if (vz.com) mark(cx, cy, cz, 0.16, vz.ltr ? ltrColor(v.ltr, tmp.c) : C_WHITE);
      if (vz.velocity && physics && physics.hasBody(e.body)) {
        const lv = physics.getLinearVelocity(e.body);
        seg(cx, cy, cz, lv[0], lv[1], lv[2], VEHICLE_SCALES.velocityPerM, C.velocity);
      }
      if (vz.impulse) {
        let ep = v.episodes.length ? v.episodes[v.episodes.length - 1] : null;
        for (const o of v.open.values()) if (!ep || o.start >= ep.start) ep = o;
        if (ep) seg(ep.point[0], ep.point[1], ep.point[2], ep.impulse[0], ep.impulse[1], ep.impulse[2], VEHICLE_SCALES.impulsePerM, C.impulse);
      }
    }
    lineGeo.setDrawRange(0, nl * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    marks.count = nm;
    marks.instanceMatrix.needsUpdate = true;
    if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
  });

  return (
    <group name="vehicle-debug">
      <primitive object={marks} />
      <primitive object={lines} />
    </group>
  );
}
