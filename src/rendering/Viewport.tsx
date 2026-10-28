import { Canvas } from '@react-three/fiber';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { SceneEnvironment } from './SceneEnvironment';
import { CameraRig } from './CameraRig';

/** The R3F canvas. Scene content is injected by children so this file stays generic. */
export function Viewport({ children, showGrid }: { children?: ReactNode; showGrid?: boolean }) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [48, 42, 62], fov: 45, near: 0.3, far: 2500 }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, preserveDrawingBuffer: true }}
      onContextMenu={(e) => e.preventDefault()}
      onCreated={(state) => {
        if (import.meta.env.DEV || location.search.includes('devtools')) (window as unknown as Record<string, unknown>).__r3f = state;
      }}
    >
      <SceneEnvironment showGrid={showGrid} />
      <CameraRig />
      {children}
    </Canvas>
  );
}
