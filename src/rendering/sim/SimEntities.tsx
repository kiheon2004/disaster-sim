import { memo, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Quat, Vec3 } from '@/core/types';
import { qMul, quatFromAxisAngle } from '@/core/math';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { useEditorStore } from '@/editor/editorStore';
import { BuildingView } from '../views/BuildingView';
import { TreeView } from '../views/TreeView';
import { CarView } from '../views/CarView';
import { HumanView } from '../views/HumanView';
import { SelectionBox } from '../SelectionBox';

const tmpQ = new THREE.Quaternion();

function applyPose(g: THREE.Object3D, position: Vec3, q: Quat) {
  g.position.set(position[0], position[1], position[2]);
  g.quaternion.copy(tmpQ.set(q[0], q[1], q[2], q[3]));
}

/** Rotation around a horizontal world axis through the object base (sway / lean). */
function swayed(e: RuntimeEntity, angle: number): Quat {
  if (Math.abs(angle) < 1e-4) return e.initialPose.quaternion;
  return qMul(quatFromAxisAngle(e.visual.swayAxis, angle), e.initialPose.quaternion);
}

function useSelectHandlers(id: string) {
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.delta > 5) return;
      useEditorStore.getState().select(id);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      document.body.style.cursor = '';
    },
  };
}

function Selected({ e }: { e: RuntimeEntity }) {
  const selected = useEditorStore((s) => s.selectedId === e.id);
  if (!selected) return null;
  const k = e.source.transform.scale;
  return <SelectionBox dims={[e.dims[0] / k[0], e.dims[1] / k[1], e.dims[2] / k[2]]} color="#ffb067" />;
}

/** Root group that follows the physics pose every frame. */
function PoseRoot({ e, children, lean }: { e: RuntimeEntity; children: ReactNode; lean?: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const handlers = useSelectHandlers(e.id);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const q = lean && !e.flags.fallen && e.dynamic ? qMul(quatFromAxisAngle(e.visual.swayAxis, e.visual.swayAngle), e.pose.quaternion) : e.pose.quaternion;
    applyPose(g, e.pose.position, q);
  });
  return (
    <group ref={ref} scale={e.source.transform.scale} {...handlers}>
      {children}
      <Selected e={e} />
    </group>
  );
}

const SimBuilding = memo(function SimBuilding({ e }: { e: RuntimeEntity }) {
  const handlers = useSelectHandlers(e.id);
  const { position, rotation, scale } = e.source.transform;
  return (
    <group position={position} rotation={rotation} scale={scale} {...handlers}>
      <BuildingView obj={e.source} live={e} />
      <Selected e={e} />
    </group>
  );
});

const SimTree = memo(function SimTree({ e }: { e: RuntimeEntity }) {
  const stump = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const canopy = useRef<THREE.Group>(null);
  const handlers = useSelectHandlers(e.id);
  useFrame(() => {
    if (!stump.current || !upper.current) return;
    const broken = e.flags.snapped || e.flags.uprooted;
    if (broken) applyPose(upper.current, e.pose.position, e.pose.quaternion);
    else applyPose(upper.current, e.initialPose.position, swayed(e, e.visual.swayAngle));
    if (e.flags.uprooted) applyPose(stump.current, e.pose.position, e.pose.quaternion);
    else applyPose(stump.current, e.initialPose.position, e.initialPose.quaternion);
    if (canopy.current) canopy.current.scale.setScalar(1 - 0.38 * e.visual.foliageLoss);
  });
  const s = e.source.transform.scale;
  return (
    <group {...handlers}>
      <group ref={stump} scale={s}>
        <TreeView obj={e.source} part="stump" />
      </group>
      <group ref={upper} scale={s}>
        <TreeView obj={e.source} part="upper" canopyRef={canopy} />
        <Selected e={e} />
      </group>
    </group>
  );
});

const SimHuman = memo(function SimHuman({ e }: { e: RuntimeEntity }) {
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    const b = e.flags.fallen ? 0.3 : e.visual.brace;
    const t = clock.elapsedTime * (4 + b * 6) + phase;
    if (armL.current) armL.current.rotation.set(-b * 2.2 + Math.sin(t) * 0.25 * b, 0, -b * 0.4);
    if (armR.current) armR.current.rotation.set(-b * 2.0 + Math.cos(t * 1.1) * 0.25 * b, 0, b * 0.4);
  });
  return (
    <PoseRoot e={e} lean>
      <HumanView obj={e.source} armLRef={armL} armRRef={armR} />
    </PoseRoot>
  );
});

const SimCar = memo(function SimCar({ e }: { e: RuntimeEntity }) {
  return (
    <PoseRoot e={e}>
      <CarView obj={e.source} />
    </PoseRoot>
  );
});

export function SimEntity({ e }: { e: RuntimeEntity }) {
  switch (e.source.type) {
    case 'building':
      return <SimBuilding e={e} />;
    case 'tree':
      return <SimTree e={e} />;
    case 'human':
      return <SimHuman e={e} />;
    case 'car':
      return <SimCar e={e} />;
    default:
      return null;
  }
}
