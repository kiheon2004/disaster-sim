/**
 * Human body overlay (Phase 33, extended model only; render-only — reads e.human / the gravity channel, never writes):
 *  - com: the whole-body centre of mass (white; leaned with the balance lean of a standing person, as drawn)
 *  - support: the support rectangle at the feet of standing people (model.support half extents, body frame)
 *  - gravity: local gravity direction at the COM (blue, unit length 0.8 m)
 *  - velocity: the body's velocity (green, 0.5 m per m/s, capped 5 m)
 *  - contact: the last contact episode's point and impulse direction on the person (magenta, 1 m per 100 N·s, capped 3 m)
 *  - segments: one marker per body segment coloured by its educational risk level
 *  - trail: COM positions sampled while the body is released and moving (the fall trajectory, last TRAIL samples)
 * Nothing is mounted (or computed) while the overlay is off. Buffers are allocated once per run and reused every frame.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Vec3 } from '@/core/types';
import { levelRank } from '@/human/injury';
import { SEGMENT_IDS } from '@/human/anthropometry';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { humanEntities, type HumanEntity } from '@/simulation/human/summary';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { leanQuaternion } from './lean';

/** People drawn (entity order — bounded GPU buffers in crowds). */
export const MAX_PEOPLE = 128;
const TRAIL = 48;
const TRAIL_DT = 0.05;
const MARKERS = 2 + SEGMENT_IDS.length;
/** Line segments per person: 3 arrows × 3 + the trail. */
const LINES = 9 + TRAIL - 1;
const LEVEL_RGB = ['#8a8f98', '#e6d14a', '#f5973b', '#ef4d4d', '#c43bd6'].map((c) => new THREE.Color(c));
const C_COM = new THREE.Color('#ffffff');
const C_CONTACT = new THREE.Color('#ff4fd8');
const C_GRAV = new THREE.Color('#5fa8ff');
const C_VEL = new THREE.Color('#5cf08a');
const C_TRAIL = new THREE.Color('#ffc46b');
const C_SUPPORT_OK = new THREE.Color('#4fd1a0');
const C_SUPPORT_LOW = new THREE.Color('#ef4d4d');

interface Trail { buf: Float32Array; n: number; head: number; t: number }

/** Instanced mesh with its colour attribute created up front (the shader is compiled with instance colours once). */
function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, order: number) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.count = 0;
  m.frustumCulled = false;
  m.renderOrder = order;
  m.raycast = () => null;
  return m;
}

export function HumanLayer() {
  const on = useViewStore((s) => s.humanViz.enabled);
  return on ? <HumanOverlay /> : null;
}

function HumanOverlay() {
  const version = useSimStore((s) => s.runtimeVersion);
  const runtime = simulationController.getRuntime();
  const people = useMemo<HumanEntity[]>(() => (runtime ? humanEntities(runtime.entities.values()).slice(0, MAX_PEOPLE) : []), [runtime, version]);
  const trails = useMemo(() => new Map<string, Trail>(), [runtime, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const ball = useDisposable(() => new THREE.SphereGeometry(1, 10, 8));
  const ballMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.95 }));
  const markers = useDisposable(() => instanced(ball, ballMat, MAX_PEOPLE * MARKERS, 10), [ball, ballMat]);
  const rectGeo = useDisposable(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const rectMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  const rects = useDisposable(() => instanced(rectGeo, rectMat, MAX_PEOPLE, 9), [rectGeo, rectMat]);
  const lineGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PEOPLE * LINES * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PEOPLE * LINES * 6), 3));
    g.setDrawRange(0, 0);
    return g;
  });
  const lineMat = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
  const lines = useMemo(() => { const l = new THREE.LineSegments(lineGeo, lineMat); l.frustumCulled = false; l.renderOrder = 10; l.raycast = () => null; return l; }, [lineGeo, lineMat]);
  const tmp = useMemo(() => ({
    q: new THREE.Quaternion(), ql: new THREE.Quaternion(), qt: new THREE.Quaternion(), eu: new THREE.Euler(), v: new THREE.Vector3(), c: new THREE.Vector3(),
    s: new THREE.Vector3(), m4: new THREE.Matrix4(), d: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), g: [0, 0, 0] as Vec3, t: -1,
  }), []);

  useFrame(() => {
    const vs = useViewStore.getState().humanViz;
    const env = simulationController.getEnvironment();
    const time = simulationController.getTime();
    if (time < tmp.t) trails.clear();
    const sample = time - tmp.t >= TRAIL_DT || time < tmp.t;
    if (sample) tmp.t = time;
    const pa = lineGeo.getAttribute('position') as THREE.BufferAttribute, ca = lineGeo.getAttribute('color') as THREE.BufferAttribute;
    const P = pa.array as Float32Array, C = ca.array as Float32Array;
    let ni = 0, nr = 0, nl = 0;
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: THREE.Color) => {
      const o = 6 * nl++;
      P[o] = x0; P[o + 1] = y0; P[o + 2] = z0; P[o + 3] = x1; P[o + 4] = y1; P[o + 5] = z1;
      C[o] = C[o + 3] = col.r; C[o + 1] = C[o + 4] = col.g; C[o + 2] = C[o + 5] = col.b;
    };
    // Arrow from `from` along the unit `dir` (shaft + two head strokes in a plane containing dir).
    const arrow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, col: THREE.Color) => {
      const ex = from.x + dir.x * len, ey = from.y + dir.y * len, ez = from.z + dir.z * len;
      seg(from.x, from.y, from.z, ex, ey, ez, col);
      tmp.a.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.9) tmp.a.set(1, 0, 0);
      tmp.a.cross(dir).normalize();
      const h = Math.min(0.25, len * 0.3);
      const bx = ex - dir.x * h, by = ey - dir.y * h, bz = ez - dir.z * h, w = h * 0.5;
      seg(ex, ey, ez, bx + tmp.a.x * w, by + tmp.a.y * w, bz + tmp.a.z * w, col);
      seg(ex, ey, ez, bx - tmp.a.x * w, by - tmp.a.y * w, bz - tmp.a.z * w, col);
    };
    const marker = (p: THREE.Vector3, r: number, col: THREE.Color) => {
      tmp.m4.compose(p, tmp.qt.identity(), tmp.s.setScalar(r));
      markers.setMatrixAt(ni, tmp.m4);
      markers.setColorAt(ni++, col);
    };
    for (const e of people) {
      const st = e.human;
      if (e.flags.captured) continue;
      const p = e.pose.position;
      // Drawn pose: the physics pose, leaned like the person's mesh while standing.
      if (st.standing) leanQuaternion(e.pose.quaternion, st.bal.th, tmp.ql, tmp.qt, tmp.eu);
      else tmp.ql.set(e.pose.quaternion[0], e.pose.quaternion[1], e.pose.quaternion[2], e.pose.quaternion[3]);
      const com = tmp.c.set(st.model.com[0], st.model.com[1], st.model.com[2]).applyQuaternion(tmp.ql).add(tmp.v.set(p[0], p[1], p[2]));
      if (vs.com) marker(com, 0.08, C_COM);
      if (vs.segments) {
        for (const s of st.model.segments) {
          const r = st.risk[s.id];
          tmp.b.set(s.centre[0], s.centre[1], s.centre[2]).applyQuaternion(tmp.ql).add(tmp.v.set(p[0], p[1], p[2]));
          marker(tmp.b, r.level === 'none' ? 0.035 : 0.05, LEVEL_RGB[levelRank(r.level)]);
        }
      }
      const L = st.last;
      if (vs.contact && L && L.point[0] === L.point[0]) {
        tmp.b.set(L.point[0], L.point[1], L.point[2]);
        marker(tmp.b, 0.06, C_CONTACT);
        const len = Math.min(3, L.impulse / 100);
        if (len > 0.02) {
          // The impulse acts on the person: the arrow ends at the contact point.
          tmp.d.set(L.dir[0], L.dir[1], L.dir[2]);
          arrow(tmp.v.copy(tmp.b).addScaledVector(tmp.d, -len), tmp.d, len, C_CONTACT);
        }
      }
      if (vs.support && st.standing) {
        tmp.q.set(e.pose.quaternion[0], e.pose.quaternion[1], e.pose.quaternion[2], e.pose.quaternion[3]);
        tmp.b.set(0, 0.03, 0).applyQuaternion(tmp.q).add(tmp.v.set(p[0], p[1], p[2]));
        tmp.m4.compose(tmp.b, tmp.q, tmp.s.set(2 * st.model.support.lateral, 1, 2 * st.model.support.forward));
        rects.setMatrixAt(nr, tmp.m4);
        rects.setColorAt(nr++, st.bal.margin < 0.25 ? C_SUPPORT_LOW : C_SUPPORT_OK);
      }
      if (vs.gravity) {
        const g = env.gravity.at(com.x, com.y, com.z, tmp.g);
        const gm = Math.hypot(g[0], g[1], g[2]);
        if (gm > 1e-6) arrow(com, tmp.d.set(g[0] / gm, g[1] / gm, g[2] / gm), 0.8, C_GRAV);
      }
      const speed = Math.hypot(st.v[0], st.v[1], st.v[2]);
      if (vs.velocity && speed > 0.05) arrow(com, tmp.d.set(st.v[0] / speed, st.v[1] / speed, st.v[2] / speed), Math.min(5, speed * 0.5), C_VEL);
      // Fall trajectory: sampled while released and moving (allocated on a person's first release only).
      let tr = trails.get(e.id);
      if (sample && !st.standing && (speed > 0.1 || Math.hypot(st.w[0], st.w[1], st.w[2]) > 0.2)) {
        if (!tr) trails.set(e.id, (tr = { buf: new Float32Array(TRAIL * 3), n: 0, head: 0, t: time }));
        tr.buf[3 * tr.head] = com.x; tr.buf[3 * tr.head + 1] = com.y; tr.buf[3 * tr.head + 2] = com.z;
        tr.head = (tr.head + 1) % TRAIL;
        tr.n = Math.min(TRAIL, tr.n + 1);
        tr.t = time;
      }
      if (vs.trail && tr) {
        for (let k = 1; k < tr.n; k++) {
          const i = (tr.head - k + TRAIL) % TRAIL, j = (tr.head - k - 1 + TRAIL) % TRAIL;
          seg(tr.buf[3 * i], tr.buf[3 * i + 1], tr.buf[3 * i + 2], tr.buf[3 * j], tr.buf[3 * j + 1], tr.buf[3 * j + 2], C_TRAIL);
        }
      }
    }
    markers.count = ni;
    markers.instanceMatrix.needsUpdate = true;
    if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
    rects.count = nr;
    rects.instanceMatrix.needsUpdate = true;
    if (rects.instanceColor) rects.instanceColor.needsUpdate = true;
    lineGeo.setDrawRange(0, 2 * nl);
    pa.needsUpdate = true;
    ca.needsUpdate = true;
  });

  return (
    <group name="human-layer">
      <primitive object={rects} />
      <primitive object={lines} />
      <primitive object={markers} />
    </group>
  );
}
