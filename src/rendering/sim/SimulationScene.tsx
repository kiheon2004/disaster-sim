import { countRender } from '@/utils/renderCounter';
import { useFrame } from '@react-three/fiber';
import { simulationController } from '@/simulation/SimulationController';
import { useSimStore } from '@/simulation/simStore';
import { useEditorStore } from '@/editor/editorStore';
import { SimRenderLayer } from './SimRenderLayer';
import { DebrisLayer } from './DebrisLayer';
import { RubbleLayer } from './RubbleLayer';
import { StructureOverlay } from './StructureOverlay';
import { ParticleLayer } from './ParticleLayer';
import { WindStreaks } from './WindStreaks';
import { WindArrows } from './WindArrows';
import { TyphoonEnvironment } from './environment/TyphoonEnvironment';
import { DamageOverlay } from './DamageOverlay';
import { RoadDamageOverlay } from '../roads/RoadDamageOverlay';
import { GroundMotionLayer } from './seismic/GroundMotionLayer';
import { EpicenterMarker } from './seismic/EpicenterMarker';
import { CameraShake } from './seismic/CameraShake';
import { WaterLayer } from './water/WaterLayer';
import { DeformationOverlay } from '../deformation/DeformationOverlay';
import { SceneCompile, ShaderWarmup } from '../deformation/ShaderWarmup';
import { DeformationPicker, DeformationPreview } from '../deformation/DeformationTools';
import { GroundOverlay } from '../ground/GroundOverlay';
import { ImpactLayer } from '../impact/ImpactLayer';
import { BlastLayer } from '../blast/BlastLayer';
import { ThermalLayer } from '../thermal/ThermalLayer';
import { FireLayer } from '../fire/FireLayer';
import { VolcanoLayer } from '../volcano/VolcanoLayer';
import { AtmosphereLayer } from '../atmosphere/AtmosphereLayer';
import { ClimateLayer } from '../climate/ClimateLayer';
import { GravityLayer } from '../gravity/GravityLayer';
import { CelestialLayer } from '../celestial/CelestialLayer';
import { HumanLayer } from '../human/HumanLayer';
import { PhysiologyLayer } from '../physiology/PhysiologyLayer';
import { VehicleLayer } from '../vehicle/VehicleLayer';
import { GroundPicker, GroundPreview } from '../ground/GroundTools';
import { PlacementLayer } from '@/rendering/placement/PlacementLayer';
import { useViewStore } from '../viewStore';
import type { Vec3 } from '@/core/types';

const hit: Vec3 = [0, 0, 0];

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
      onClick={(e) => {
        if (e.delta > 5) return;
        useEditorStore.getState().select(null);
        // The point on the actual terrain under the cursor (Phase 14).
        // Flood, deformation (Phase 21), ground-failure (Phase 22), air-blast (Phase 24) and thermal (Phase 26) inspectors.
        const ss = useSimStore.getState();
        if (!ss.flood && !ss.deform && !ss.ground && !ss.blasts && !ss.thermal) return;
        const o = e.ray.origin;
        const d = e.ray.direction;
        const terrain = simulationController.getEnvironment().terrain;
        if (terrain.raycast([o.x, o.y, o.z], [d.x, d.y, d.z], 3000, hit)) useViewStore.getState().setWaterProbe({ x: hit[0], z: hit[2] });
      }}
    >
      <planeGeometry args={[600, 600]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** Simulation-mode scene: renders the runtime (never the editable document). */
export function SimulationScene() {
  countRender('SimulationScene');
  const version = useSimStore((s) => s.runtimeVersion);
  const runtime = simulationController.getRuntime();
  const entities = runtime ? [...runtime.entities.values()] : [];
  return (
    <>
      <SimulationDriver />
      <TyphoonEnvironment />
      <GroundDeselect />
      <group key={version}>
        {runtime && <SimRenderLayer runtime={runtime} />}
        <DamageOverlay entities={entities} />
        {runtime && <RoadDamageOverlay runtime={runtime} />}
        <DebrisLayer />
        <RubbleLayer />
        <StructureOverlay />
        <ParticleLayer />
      </group>
      <WindStreaks />
      <WindArrows />
      <WaterLayer />
      <DeformationOverlay />
      <GroundOverlay />
      <ImpactLayer />
      <BlastLayer />
      <ThermalLayer />
      <FireLayer />
      <VolcanoLayer />
      <AtmosphereLayer />
      <ClimateLayer />
      <GravityLayer />
      <CelestialLayer />
      <HumanLayer />
      <PhysiologyLayer />
      <VehicleLayer />
      <ShaderWarmup />
      <SceneCompile version={version} />
      <DeformationPreview />
      <DeformationPicker />
      <GroundPreview />
      <GroundPicker />
      <PlacementLayer />
      <GroundMotionLayer />
      <EpicenterMarker />
      <CameraShake />
    </>
  );
}
