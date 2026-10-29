/**
 * Impact visuals in simulation mode (Phase 23, render-only), synchronized with the computed state:
 *  - trajectory: the arc through the world (from the plan) and, before the impact, the body drawn at
 *    its COMPUTED position on that arc (it is inside the world only for the last 1500 m — at
 *    km/s that is a fraction of a second; the HUD counts down the entry stage instead of faking a
 *    slow approach). A glow is drawn while the body is faster than ~3 km/s (luminous flight; slower
 *    bodies fall "dark");
 *  - flash at the impact point for 0.3 s (visual effect, no energy applied). A sprite only — no
 *    light: adding a light changes the scene's light count, which recompiles every lit material
 *    (all buildings, the terrain) at the start of the run (measured 90–360 ms stall);
 *  - ejecta: every parcel drawn at its computed position along its integrated path between its
 *    launch and landing time, with a short trail; fragment size × the chosen exaggeration
 *    (labelled — the computed size is used by the physics);
 *  - dust: a visual particle cloud over the crater (NOT part of the mass budget, labelled).
 * The crater itself and the deposits are the terrain (Phase 21 path) — nothing is drawn on top.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GRAVITY } from '@/core/units';
import { simulationController } from '@/simulation/SimulationController';
import type { ImpactModel } from '@/impact/ImpactModel';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';

const MAX_PARCELS = 512;
const MAX_DUST = 1200;
const FLASH_TIME = 0.3;
const TRAIL = 0.25;
const GLOW_SPEED = 3000;

function parcelAt(path: Float32Array, t: number, out: THREE.Vector3): boolean {
  // Samples every 0.05 s from launch; the last sample is the landing point.
  const n = path.length / 3;
  if (n < 2 || t < 0) return false;
  const f = t / 0.05;
  const i = Math.floor(f);
  if (i >= n - 1) { out.set(path[(n - 1) * 3], path[(n - 1) * 3 + 1], path[(n - 1) * 3 + 2]); return false; }
  const a = f - i;
  out.set(path[i * 3] + (path[i * 3 + 3] - path[i * 3]) * a, path[i * 3 + 1] + (path[i * 3 + 4] - path[i * 3 + 1]) * a, path[i * 3 + 2] + (path[i * 3 + 5] - path[i * 3 + 2]) * a);
  return true;
}

function ImpactVisual({ model }: { model: ImpactModel }) {
  const viz = useViewStore((s) => s.impactViz);
  const plan = model.plan;
  const { gl, camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const arc = useDisposable(() => {
    const a = plan.arc, pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 80; k++) {
      const t = (a.time * k) / 80;
      pts.push(new THREE.Vector3(a.start[0] + a.velocity0[0] * t, a.start[1] + a.velocity0[1] * t - 0.5 * GRAVITY * t * t, a.start[2] + a.velocity0[2] * t));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [plan]);
  const arcMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#ff7a45', transparent: true, opacity: 0.6, depthWrite: false }));
  const bodyGeo = useDisposable(() => new THREE.IcosahedronGeometry(Math.max(0.3, plan.projectile.diameter / 2), 1));
  const bodyMat = useDisposable(() => new THREE.MeshStandardMaterial({ color: plan.projectile.material === 'iron' ? '#6f6a66' : plan.projectile.material === 'icy' ? '#cfe3ef' : '#7d7266', roughness: 0.9, flatShading: true }));
  const glowGeo = useDisposable(() => new THREE.SphereGeometry(1, 16, 12));
  const glowMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#ffb35c', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const flashMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#fff4d6', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const rocks = useDisposable(() => {
    const m = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.5, 0), new THREE.MeshStandardMaterial({ color: '#8a7358', roughness: 1, flatShading: true }), MAX_PARCELS);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    return Object.assign(m, { dispose: () => { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  });
  const trails = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARCELS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    return g;
  });
  const trailMat = useDisposable(() => new THREE.LineBasicMaterial({ color: '#c8a77a', transparent: true, opacity: 0.55, depthWrite: false }));
  const dust = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    return g;
  });
  const dustMat = useDisposable(() => new THREE.PointsMaterial({ color: '#b8a184', size: 1.4, transparent: true, opacity: 0.35, depthWrite: false }));
  const dustState = useMemo(() => ({ vel: new Float32Array(MAX_DUST * 3), life: new Float32Array(MAX_DUST), n: 0, spawned: false }), []);
  useEffect(() => {
    if (groupRef.current) gl.compile(groupRef.current, camera);
  }, [gl, camera]);

  const v = new THREE.Vector3(), w = new THREE.Vector3(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  // The trajectory line is hidden one second after the impact.
  const [landed, setLanded] = useState(false);
  useFrame((_s, delta) => {
    const time = simulationController.getTime();
    const tau = time - model.impactTime;
    if ((tau > 1) !== landed) setLanded(tau > 1);
    // Body on the world arc (computed position), before the impact.
    const body = bodyRef.current, glow = glowRef.current;
    if (body && glow) {
      const ta = plan.arc.time + tau; // time along the arc (0 at hand-over)
      const visible = !plan.airburst && tau < 0 && ta >= 0;
      body.visible = visible && viz.trajectory;
      if (visible) {
        const a = plan.arc;
        body.position.set(a.start[0] + a.velocity0[0] * ta, a.start[1] + a.velocity0[1] * ta - 0.5 * GRAVITY * ta * ta, a.start[2] + a.velocity0[2] * ta);
        glow.position.copy(body.position);
      }
      glow.visible = body.visible && plan.speed > GLOW_SPEED;
      glow.scale.setScalar(Math.max(1, plan.projectile.diameter * 2.5));
    }
    // Flash.
    const flash = flashRef.current;
    const fa = !plan.airburst && viz.flash && tau >= 0 && tau < FLASH_TIME ? 1 - tau / FLASH_TIME : 0;
    if (flash) {
      flash.visible = fa > 0;
      (flash.material as THREE.MeshBasicMaterial).opacity = 0.9 * fa;
      flash.scale.setScalar(Math.max(2, (plan.crater?.radius ?? 1) * (1 + 2 * (1 - fa))));
    }
    // Ejecta parcels.
    let n = 0, tn = 0;
    const tr = trails.attributes.position.array as Float32Array;
    if (viz.ejecta && tau >= 0) {
      for (const p of plan.parcels) {
        if (n >= MAX_PARCELS) break;
        const tl = tau - p.t0;
        if (tl < 0 || tau > p.t1) continue;
        if (!parcelAt(p.path, tl, v)) continue;
        const s = Math.max(0.12, p.size * viz.fragmentScale);
        m4.compose(v, q, sc.set(s, s, s));
        rocks.setMatrixAt(n++, m4);
        if (viz.trails && tl > TRAIL) {
          parcelAt(p.path, tl - TRAIL, w);
          tr.set([w.x, w.y, w.z, v.x, v.y, v.z], tn * 6);
          tn++;
        }
      }
    }
    rocks.count = n;
    rocks.instanceMatrix.needsUpdate = true;
    trails.setDrawRange(0, tn * 2);
    trails.attributes.position.needsUpdate = true;
    // Dust (visual only): spawned once at impact, rises and spreads, fades.
    if (viz.dust && !plan.airburst && plan.crater && tau >= 0) {
      const pos = dust.attributes.position.array as Float32Array;
      const [cx, cy, cz] = plan.arc.point, R = plan.crater.radius;
      if (!dustState.spawned) {
        dustState.spawned = true;
        dustState.n = Math.min(MAX_DUST, Math.round(200 + 200 * Math.log10(1 + plan.energy / 1e8)));
        for (let k = 0; k < dustState.n; k++) {
          const a = Math.random() * Math.PI * 2, r = R * Math.sqrt(Math.random());
          pos[k * 3] = cx + Math.cos(a) * r; pos[k * 3 + 1] = cy + Math.random(); pos[k * 3 + 2] = cz + Math.sin(a) * r;
          dustState.vel[k * 3] = Math.cos(a) * (1 + Math.random() * 3); dustState.vel[k * 3 + 1] = 2 + Math.random() * 6; dustState.vel[k * 3 + 2] = Math.sin(a) * (1 + Math.random() * 3);
          dustState.life[k] = 4 + Math.random() * 8;
        }
      }
      const dt = Math.min(0.1, delta);
      let alive = 0;
      for (let k = 0; k < dustState.n; k++) {
        dustState.life[k] -= dt;
        if (dustState.life[k] <= 0) { pos[k * 3 + 1] = -1000; continue; }
        alive++;
        dustState.vel[k * 3 + 1] *= 1 - 0.4 * dt;
        pos[k * 3] += dustState.vel[k * 3] * dt; pos[k * 3 + 1] += dustState.vel[k * 3 + 1] * dt; pos[k * 3 + 2] += dustState.vel[k * 3 + 2] * dt;
      }
      dust.setDrawRange(0, alive ? dustState.n : 0);
      dust.attributes.position.needsUpdate = true;
      dustMat.opacity = 0.35 * Math.min(1, alive / Math.max(1, dustState.n) * 2);
    } else dust.setDrawRange(0, 0);
  });

  const [px, py, pz] = plan.arc.point;
  return (
    <group name="impact-layer" ref={groupRef}>
      {viz.trajectory && !plan.airburst && !landed && (
        <line>
          <primitive object={arc} attach="geometry" />
          <primitive object={arcMat} attach="material" />
        </line>
      )}
      <mesh ref={bodyRef} geometry={bodyGeo} material={bodyMat} visible={false} />
      <mesh ref={glowRef} geometry={glowGeo} material={glowMat} visible={false} raycast={() => null} />
      <mesh ref={flashRef} geometry={glowGeo} material={flashMat} position={[px, py + 1, pz]} visible={false} raycast={() => null} />
      <primitive object={rocks} />
      <lineSegments geometry={trails} material={trailMat} frustumCulled={false} />
      <points geometry={dust} material={dustMat} frustumCulled={false} />
    </group>
  );
}

export function ImpactLayer() {
  const [models, setModels] = useState<ImpactModel[]>([]);
  useFrame(() => {
    const ms = simulationController.getEnvironment().impact.models;
    if (ms.length !== models.length || ms.some((m, i) => m !== models[i])) setModels([...ms]);
  });
  return <>{models.map((m) => <ImpactVisual key={m.id} model={m} />)}</>;
}
