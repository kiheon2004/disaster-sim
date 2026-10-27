import { useMemo } from 'react';
import * as THREE from 'three';
import { Grid } from '@react-three/drei';
import { WORLD_SIZE } from '@/core/units';
import { grassTexture } from './textures';

export const SKY_COLOR = '#9fc3e6';

/** Lights, sky, ground and grid. Pure presentation. */
export function SceneEnvironment({ showGrid = true }: { showGrid?: boolean }) {
  const grass = useMemo(() => {
    const t = grassTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(WORLD_SIZE / 2, WORLD_SIZE / 2);
    return t;
  }, []);

  return (
    <>
      <color attach="background" args={[SKY_COLOR]} />
      <fog attach="fog" args={[SKY_COLOR, 180, 650]} />
      <hemisphereLight name="hemi" args={['#dbe9ff', '#5a6b48', 0.9]} />
      <directionalLight
        name="sun"
        position={[60, 90, 40]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-camera-left={-110}
        shadow-camera-right={110}
        shadow-camera-top={110}
        shadow-camera-bottom={-110}
        shadow-camera-near={1}
        shadow-camera-far={300}
      />

      {/* Buildable area */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow name="ground">
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
        <meshStandardMaterial map={grass} roughness={1} />
      </mesh>
      {/* Surroundings out to the horizon */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[3000, 3000]} />
        <meshStandardMaterial color="#56703f" roughness={1} />
      </mesh>
      {/* Boundary outline */}
      <lineSegments position-y={0.03}>
        <edgesGeometry args={[new THREE.BoxGeometry(WORLD_SIZE, 0, WORLD_SIZE)]} />
        <lineBasicMaterial color="#f5f8ff" transparent opacity={0.35} />
      </lineSegments>

      {showGrid && (
        <Grid
          position={[0, 0.02, 0]}
          args={[WORLD_SIZE, WORLD_SIZE]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#2f4a26"
          sectionSize={10}
          sectionThickness={1}
          sectionColor="#24391d"
          fadeDistance={160}
          fadeStrength={1.5}
          infiniteGrid={false}
        />
      )}
    </>
  );
}
