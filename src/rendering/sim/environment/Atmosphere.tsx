import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SKY_COLOR } from '../../SceneEnvironment';
import { weatherIntensity } from './intensity';

const STORM_SKY = new THREE.Color('#4d5661');
const FOG_NEAR = 180;
const FOG_FAR = 650;
const SUN = 2.1;
const HEMI = 0.9;

/** Sky color, fog distance and scene brightness follow the storm intensity. */
export function Atmosphere() {
  const scene = useThree((s) => s.scene);
  const base = useMemo(() => new THREE.Color(SKY_COLOR), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  const smooth = useMemo(() => ({ k: 0 }), []);

  const apply = (k: number) => {
    tmp.copy(base).lerp(STORM_SKY, k * 0.9);
    if (scene.background instanceof THREE.Color) scene.background.copy(tmp);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(tmp);
      scene.fog.near = FOG_NEAR - k * 150;
      scene.fog.far = FOG_FAR - k * 430;
    }
    const sun = scene.getObjectByName('sun') as THREE.DirectionalLight | undefined;
    if (sun) sun.intensity = SUN * (1 - k * 0.7);
    const hemi = scene.getObjectByName('hemi') as THREE.HemisphereLight | undefined;
    if (hemi) hemi.intensity = HEMI * (1 - k * 0.35);
  };

  useFrame((_, dt) => {
    // Ease toward the target so gust-to-gust changes don't flicker the whole sky.
    smooth.k += (weatherIntensity() - smooth.k) * Math.min(1, dt * 1.5);
    apply(smooth.k);
  });
  useEffect(() => () => apply(0), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
