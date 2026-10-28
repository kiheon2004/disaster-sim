import { TerrainLayer } from './terrain/TerrainLayer';

export const SKY_COLOR = '#9fc3e6';

/** Lights, sky, terrain and grid. Pure presentation. */
export function SceneEnvironment({ showGrid = true }: { showGrid?: boolean }) {
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

      <TerrainLayer showGrid={showGrid} />
    </>
  );
}
