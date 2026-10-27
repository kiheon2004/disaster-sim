import { useFrame } from '@react-three/fiber';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useEditorStore } from '@/editor/editorStore';
import { SimEntity } from './SimEntities';
import { DebrisLayer } from './DebrisLayer';
import { ParticleLayer } from './ParticleLayer';
import { WindStreaks } from './WindStreaks';
import { StormAmbience } from './StormAmbience';
import { DamageOverlay } from './DamageOverlay';

/** Advances the simulation clock from the render loop (mounted first so it runs before views). */
function SimulationDriver() {
  useFrame((_, dt) => simulationController.tick(dt));
  return null;
}

function GroundDeselect() {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position-y={0.001}
      onClick={(e) => e.delta <= 5 && useEditorStore.getState().select(null)}
    >
      <planeGeometry args={[600, 600]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** Simulation-mode scene: renders the runtime (never the editable document). */
export function SimulationScene() {
  const version = useSimStore((s) => s.runtimeVersion);
  const runtime = simulationController.getRuntime();
  const entities = runtime ? [...runtime.entities.values()] : [];
  return (
    <>
      <SimulationDriver />
      <StormAmbience />
      <GroundDeselect />
      <group key={version}>
        {entities.map((e) => (
          <SimEntity key={e.id} e={e} />
        ))}
        <DamageOverlay entities={entities} />
        <DebrisLayer />
        <ParticleLayer />
      </group>
      <WindStreaks />
    </>
  );
}
