import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { simulationController } from '@/simulation/SimulationController';
import { createGroundMotionSample } from '@/simulation/seismic/GroundMotionField';
import { useViewStore } from '../../viewStore';

const sample = createGroundMotionSample();
const offset = new THREE.Vector3();

/**
 * Optional camera shake (off by default): a purely visual effect that offsets the camera by
 * the (strongly exaggerated) reference ground displacement after the orbit controls have
 * updated, and removes the offset again before they run on the next frame. The simulation
 * never sees it.
 */
export function CameraShake() {
  const applied = useRef(false);
  // Remove last frame's offset before the controls update (drei OrbitControls: priority −1).
  useFrame(({ camera }) => {
    if (applied.current) camera.position.sub(offset);
    applied.current = false;
  }, -2);
  useFrame(({ camera }) => {
    if (!useViewStore.getState().quakeViz.cameraShake) return;
    const env = simulationController.getEnvironment();
    if (!env.groundMotion.active) return;
    env.groundMotion.reference(env.time, sample);
    const k = 6; // m of camera motion per m of ground motion (visual)
    offset.set(sample.d[0] * k, sample.d[1] * k, sample.d[2] * k).clampLength(0, 0.6);
    camera.position.add(offset);
    applied.current = true;
  });
  return null;
}
