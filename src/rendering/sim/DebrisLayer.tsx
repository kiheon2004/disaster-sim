import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../useDisposable';
import { simulationController } from '@/simulation/SimulationController';
import { MAX_DEBRIS } from '@/simulation/damage/spawn';
import { FRAGMENT_LIMITS } from '@/simulation/structure/fragments';
import { UNIT_BOX } from '../geometry/primitives';
import { createGroundMotionSample } from '@/simulation/seismic/GroundMotionField';
import { useViewStore } from '../viewStore';
import { hashString } from '@/core/math';
import type { DebrisPiece } from '@/simulation/SimulationRuntime';
import { chunkCount, debrisChunks, debrisLook, MAX_CHUNKS } from './debrisVisual';

const ground = createGroundMotionSample();
/** Phase 0–24 pieces + structural fragments (Phase 25, up to MAX_CHUNKS drawn pieces each, Phase 36) — allocated once. */
const CAPACITY = MAX_DEBRIS + MAX_CHUNKS * (FRAGMENT_LIMITS.total + 64);
/** Drawn chunks of a structural fragment (by its member's structural type), cached per piece. */
const chunksOf = new WeakMap<DebrisPiece, number>();
const chunkBuf = new Float32Array(6 * MAX_CHUNKS);
const offset = new THREE.Vector3();
const MOVING = new THREE.Color('#f08a24');
const RESTING = new THREE.Color('#6d8fb0');

const m = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
/** Parsed colors cached by hex string. */
const colorCache = new Map<string, THREE.Color>();
function cachedColor(hex: string) {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new THREE.Color(hex)));
  return c;
}

/**
 * Detached building parts and collapse chunks (rigid bodies): one InstancedMesh, matrices from
 * the physics poses every frame, colors rewritten only when the set of pieces changes.
 */
export function DebrisLayer() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const rev = useRef(-1);
  const mode = useRef(false);
  const frame = useRef(0);
  const material = useDisposable(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0, flatShading: true }), []);
  useFrame(() => {
    const mesh = ref.current;
    const rt = simulationController.getRuntime();
    if (!mesh || !rt) return;
    const list = rt.debris;
    // Debris-state view (Phase 25): fragments colored moving / at rest (re-colored every 15 frames).
    const byState = useViewStore.getState().structureViz.debris;
    frame.current++;
    const colors = rt.debrisRev !== rev.current || byState !== mode.current || (byState && frame.current % 15 === 0);
    rev.current = rt.debrisRev;
    mode.current = byState;
    // Earthquake: debris moves with the (exaggerated) ground like every other object (visual).
    const gm = simulationController.getEnvironment().groundMotion;
    const k = gm.active ? useViewStore.getState().quakeViz.exaggeration : 0;
    const time = simulationController.getEnvironment().time;
    let n = 0;
    for (let i = 0; i < list.length && n < CAPACITY; i++) {
      const d = list[i];
      const p = d.pose.position;
      const q = d.pose.quaternion;
      pos.set(p[0], p[1], p[2]);
      if (k > 0) {
        gm.sample(p[0], p[2], time, ground);
        pos.x += ground.d[0] * k;
        pos.y += ground.d[1] * k;
        pos.z += ground.d[2] * k;
      }
      quat.set(q[0], q[1], q[2], q[3]);
      const color = colors ? (byState && d.structural ? (d.structural.settled ? RESTING : MOVING) : cachedColor(d.color)) : null;
      // Phase 36: a structural fragment is drawn as the pieces its type breaks into, all inside its one body box.
      let c = chunksOf.get(d);
      if (c === undefined) {
        const g = d.structural ? rt.entities.get(d.structural.owner)?.modular?.structure?.model.g : undefined;
        c = g ? chunkCount(debrisLook(g, d.structural!.member).size) : 1;
        chunksOf.set(d, c);
      }
      if (c === 1 || n + c > CAPACITY) {
        m.compose(pos, quat, scale.set(d.size[0], d.size[1], d.size[2]));
        mesh.setMatrixAt(n, m);
        if (color) mesh.setColorAt(n, color);
        n++;
        continue;
      }
      debrisChunks(d.size, c, hashString(d.id), chunkBuf);
      for (let j = 0; j < c; j++) {
        const o = 6 * j;
        offset.set(chunkBuf[o], chunkBuf[o + 1], chunkBuf[o + 2]).applyQuaternion(quat).add(pos);
        m.compose(offset, quat, scale.set(chunkBuf[o + 3], chunkBuf[o + 4], chunkBuf[o + 5]));
        mesh.setMatrixAt(n, m);
        if (color) mesh.setColorAt(n, color);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (colors && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[UNIT_BOX, material, CAPACITY]} frustumCulled={false} castShadow receiveShadow raycast={() => null} />;
}
