import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useViewStore } from './viewStore';
import { radToDeg } from '@/core/math';

/**
 * Free orbit camera: left-drag orbit, right-drag pan, wheel zoom.
 * Also services focus requests and publishes the azimuth for the compass overlay.
 */
export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const anim = useRef<{ fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3; t: number } | null>(null);
  const focusRequest = useViewStore((s) => s.focusRequest);
  const lastAz = useRef(999);

  useEffect(() => {
    if (!focusRequest || !controls.current) return;
    const c = controls.current;
    const toT = new THREE.Vector3(...focusRequest.target);
    const offset = camera.position.clone().sub(c.target).normalize().multiplyScalar(focusRequest.distance);
    anim.current = { fromT: c.target.clone(), toT, fromP: camera.position.clone(), toP: toT.clone().add(offset), t: 0 };
  }, [focusRequest, camera]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    if (anim.current) {
      const a = anim.current;
      a.t = Math.min(1, a.t + dt * 2.5);
      const k = 1 - Math.pow(1 - a.t, 3);
      c.target.lerpVectors(a.fromT, a.toT, k);
      camera.position.lerpVectors(a.fromP, a.toP, k);
      if (a.t >= 1) anim.current = null;
    }
    // Azimuth: direction the camera looks, clockwise from north (-Z).
    const dir = c.target.clone().sub(camera.position);
    const az = (radToDeg(Math.atan2(dir.x, -dir.z)) + 360) % 360;
    if (Math.abs(az - lastAz.current) > 0.5) {
      lastAz.current = az;
      useViewStore.getState().setAzimuth(az);
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      minDistance={3}
      maxDistance={400}
      maxPolarAngle={Math.PI / 2 - 0.04}
      screenSpacePanning={false}
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
    />
  );
}
