import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clamp } from '@/core/math';
import { simulationController } from '@/simulation/SimulationController';
import { SKY_COLOR } from '../SceneEnvironment';

const STORM = new THREE.Color('#5d6670');
const FOG_NEAR = 180;
const FOG_FAR = 650;
const SUN = 2.1;

/** Darkens sky, fog and sunlight as the wind strengthens; restores defaults on unmount. */
export function StormAmbience() {
  const scene = useThree((s) => s.scene);
  const base = useMemo(() => new THREE.Color(SKY_COLOR), []);
  const tmp = useMemo(() => new THREE.Color(), []);

  const apply = (k: number) => {
    tmp.copy(base).lerp(STORM, k);
    if (scene.background instanceof THREE.Color) scene.background.copy(tmp);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(tmp);
      scene.fog.near = FOG_NEAR - k * 120;
      scene.fog.far = FOG_FAR - k * 380;
    }
    const sun = scene.getObjectByName('sun') as THREE.DirectionalLight | undefined;
    if (sun) sun.intensity = SUN * (1 - k * 0.6);
  };

  useFrame(() => apply(clamp(simulationController.getEnvironment().wind.baseSpeed / 55, 0, 1) * 0.85));
  useEffect(() => () => apply(0), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
