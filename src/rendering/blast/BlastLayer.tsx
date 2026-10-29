/**
 * Air-blast visuals in simulation mode (Phase 24, render-only), synchronized with the simulation:
 *  - the computed pressure field at ground level (current overpressure, peak so far, arrival time or
 *    positive impulse) from a BlastField over the run's terrain and buildings — the same waves,
 *    tables and shielding the BlastSystem loads objects with (4 m grid);
 *  - the wavefront: a translucent shell at the COMPUTED front radius of each wave (its glow can be
 *    exaggerated ×3 — visual only, labelled), and the ground image for elevated releases;
 *  - pressure vectors: arrows along the wave at ground points, length ∝ log of the current
 *    overpressure (8 m spacing);
 *  - affected objects: a ring above every object the wave reached, colored by the side-on peak it felt;
 *  - flash at the release point for 0.15 s (visual effect only — no thermal model, Phase 26–27).
 * Every GPU resource is created through useDisposable (released with the component).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { BlastField } from '@/blast/plan';
import { ShieldIndex, type ShieldBox } from '@/blast/wave';
import { obstacleFromEntity } from '@/simulation/wind/obstacles';
import type { WaveRecord } from '@/simulation/blast/BlastChannel';
import { useViewStore } from '../viewStore';
import { useDisposable } from '../useDisposable';
import { FieldGrid } from './blastGrid';
import { arrivalColor, impulseColor, pressureColor } from './blastColors';

const STEP = 4;
const MAX_ARROWS = 900;
const MAX_RINGS = 1500;
const FLASH = 0.15;

function runtimeField(waves: readonly WaveRecord[]): BlastField | null {
  const env = simulationController.getEnvironment(), rt = simulationController.getRuntime();
  if (!rt || !waves.length) return null;
  const boxes: ShieldBox[] = [];
  for (const e of rt.entities.values()) {
    if (e.flags.collapsed) continue;
    const o = obstacleFromEntity(e);
    if (o) boxes.push(o);
  }
  return new BlastField(waves.map((w) => w.wave), env.terrain, new ShieldIndex(boxes), STEP);
}

export function BlastLayer() {
  const [waves, setWaves] = useState<WaveRecord[]>([]);
  const viz = useViewStore((s) => s.blastViz);
  const { gl, camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    const ws = simulationController.getEnvironment().blast.waves;
    if (ws.length !== waves.length) setWaves([...ws]);
  });
  const field = useMemo(() => runtimeField(waves), [waves]);
  const grid = useMemo(() => (field ? new FieldGrid(field, 0.12) : null), [field]);
  useEffect(() => () => grid?.dispose(), [grid]);
  const gridMat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
  const shellGeo = useDisposable(() => new THREE.SphereGeometry(1, 48, 24));
  const shellMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#d9ecff', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  const flashMat = useDisposable(() => new THREE.MeshBasicMaterial({ color: '#fff4d6', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const arrows = useDisposable(() => {
    const geo = new THREE.ConeGeometry(0.35, 1, 6).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ vertexColors: false, toneMapped: false }), MAX_ARROWS);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ARROWS * 3), 3);
    return Object.assign(m, { dispose: () => { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  });
  const rings = useDisposable(() => {
    const geo = new THREE.TorusGeometry(0.9, 0.12, 6, 24).rotateX(Math.PI / 2);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_RINGS);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = () => {};
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3);
    return Object.assign(m, { dispose: () => { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  });
  const shells = useRef<(THREE.Mesh | null)[]>([]);
  const flashes = useRef<(THREE.Mesh | null)[]>([]);
  useEffect(() => {
    if (groupRef.current) gl.compile(groupRef.current, camera);
  }, [gl, camera, field]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), x: new THREE.Vector3(1, 0, 0), d: new THREE.Vector3(), last: -1, mode: '' }), []);
  useFrame(() => {
    const time = simulationController.getTime();
    // Field.
    if (grid && field) {
      const passing = waves.some((w) => time >= w.wave.init.time && time <= w.exit + 0.1);
      const dirty = tmp.mode !== viz.field || (viz.field === 'current' && (passing || tmp.last !== time)) || ((viz.field === 'peak' || viz.field === 'impulse' || viz.field === 'arrival') && tmp.last !== time && passing);
      if (dirty) {
        tmp.mode = viz.field;
        tmp.last = time;
        const t0 = waves[0]?.wave.init.time ?? 0, span = Math.max(1e-3, Math.max(...waves.map((w) => w.exit)) - t0);
        grid.paint((i, c) => {
          switch (viz.field) {
            case 'current': {
              const p = field.pressureAt(i, time);
              if (Math.abs(p) < 100) return 0;
              pressureColor(Math.abs(p), c);
              if (p < 0) c.multiplyScalar(0.55); // suction phase: darker
              return 0.65;
            }
            case 'peak':
              return field.arrival[i] > time || field.peak[i] < 100 ? 0 : (pressureColor(field.peak[i], c), 0.6);
            case 'impulse':
              return field.arrival[i] > time || field.impulse[i] < 1 ? 0 : (impulseColor(field.impulse[i], c), 0.6);
            case 'arrival':
              return field.arrival[i] > time ? 0 : (arrivalColor((field.arrival[i] - t0) / span, c), 0.55);
            default:
              return 0;
          }
        });
      }
    }
    // Wavefronts and flashes.
    waves.forEach((w, k) => {
      const sh = shells.current[k], fl = flashes.current[k];
      const local = time - w.wave.init.time;
      const r = local > 0 ? w.wave.frontRadius(time) : 0;
      if (sh) {
        sh.visible = viz.front && local > 0 && time <= w.exit;
        sh.scale.setScalar(Math.max(0.01, r));
        (sh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.35, 0.1 * viz.frontGlow);
      }
      if (fl) {
        const a = viz.flash && local >= 0 && local < FLASH ? 1 - local / FLASH : 0;
        fl.visible = a > 0;
        (fl.material as THREE.MeshBasicMaterial).opacity = 0.9 * a;
        fl.scale.setScalar(Math.max(1.5, Math.min(30, 0.3 * w.wave.main.rt)) * (1 + 1.5 * (1 - a)));
      }
    });
    // Pressure vectors (every second field point = 8 m), along the strongest contribution.
    let n = 0;
    if (viz.vectors && field) {
      for (let iz = 0; iz < field.nz && n < MAX_ARROWS; iz += 2) for (let ix = 0; ix < field.nx && n < MAX_ARROWS; ix += 2) {
        const i = iz * field.nx + ix;
        const p = field.pressureAt(i, time);
        if (Math.abs(p) < 100) continue;
        const cs = field.contributionsAt(i);
        const main = cs.reduce((a, b) => (b.dp > a.dp ? b : a));
        tmp.d.set(main.k[0], 0, main.k[2]);
        if (tmp.d.lengthSq() < 1e-9) continue;
        tmp.d.normalize().multiplyScalar(p < 0 ? -1 : 1);
        tmp.q.setFromUnitVectors(tmp.x, tmp.d);
        const L = 1.5 + 1.5 * Math.log10(Math.abs(p) / 100);
        tmp.m.compose(tmp.p.set(field.x0 + ix * field.step, field.y[i] - 0.5, field.z0 + iz * field.step), tmp.q, tmp.s.set(L, 1, 1));
        arrows.setMatrixAt(n, tmp.m);
        arrows.setColorAt(n, pressureColor(Math.abs(p), tmp.c));
        n++;
      }
    }
    arrows.count = n;
    arrows.instanceMatrix.needsUpdate = true;
    if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
    // Affected objects.
    let m = 0;
    const rt = simulationController.getRuntime();
    if (viz.objects && rt) {
      for (const e of rt.entities.values()) {
        const b = e.blast;
        if (!b || m >= MAX_RINGS || b.arrival > time || e.def.inert) continue;
        const pos = e.pose.position;
        tmp.m.compose(tmp.p.set(pos[0], pos[1] + e.dims[1] + 0.6, pos[2]), tmp.q.identity(), tmp.s.setScalar(Math.max(0.6, Math.min(4, Math.max(e.dims[0], e.dims[2]) * 0.35))));
        rings.setMatrixAt(m, tmp.m);
        rings.setColorAt(m, pressureColor(b.peak, tmp.c));
        m++;
      }
    }
    rings.count = m;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  });

  return (
    <group name="blast-layer" ref={groupRef}>
      {grid && viz.field !== 'off' && <mesh geometry={grid.geometry} material={gridMat} renderOrder={4} raycast={() => null} />}
      {waves.map((w, k) => (
        <group key={w.wave.init.id}>
          <mesh ref={(el) => { shells.current[k] = el; }} geometry={shellGeo} material={shellMat} position={w.wave.init.position} visible={false} raycast={() => null} renderOrder={5} />
          <mesh ref={(el) => { flashes.current[k] = el; }} geometry={shellGeo} material={flashMat} position={w.wave.init.position} visible={false} raycast={() => null} />
        </group>
      ))}
      <primitive object={arrows} />
      <primitive object={rings} />
    </group>
  );
}
