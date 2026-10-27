import type * as THREE from 'three';
import type { HumanParams } from '@/objects/definitions/human';
import { Box } from './Box';
import type { ViewProps } from './types';

const SKIN = '#e2b48c';
const HAIR = '#3b2a1d';

/** Minecraft-like blocky person. Proportions: legs 3/8, torso 3/8, head 1/4 of height. */
export function HumanView({
  obj,
  armLRef,
  armRRef,
}: ViewProps & { armLRef?: React.Ref<THREE.Group>; armRRef?: React.Ref<THREE.Group> }) {
  const p = obj.params as HumanParams;
  const h = p.height;
  const leg = h * 0.375;
  const torso = h * 0.375;
  const head = h * 0.25;
  const tw = h * 0.21; // torso width
  const td = h * 0.12; // depth
  const lw = tw / 2;
  const aw = h * 0.09;
  const shoulderY = leg + torso;

  return (
    <group>
      {/* Legs */}
      <Box size={[lw * 0.96, leg, td]} position={[-lw / 2, leg / 2, 0]} color={p.pantsColor} />
      <Box size={[lw * 0.96, leg, td]} position={[lw / 2, leg / 2, 0]} color={p.pantsColor} />
      <Box size={[lw * 0.98, leg * 0.12, td * 1.15]} position={[-lw / 2, leg * 0.06, 0.01]} color="#26262a" shadow={false} />
      <Box size={[lw * 0.98, leg * 0.12, td * 1.15]} position={[lw / 2, leg * 0.06, 0.01]} color="#26262a" shadow={false} />
      {/* Torso */}
      <Box size={[tw, torso, td * 1.05]} position={[0, leg + torso / 2, 0]} color={p.shirtColor} />
      {/* Arms pivot at the shoulders so they can be raised during a gust */}
      <group ref={armLRef} position={[-(tw / 2 + aw / 2), shoulderY - 0.02, 0]}>
        <Box size={[aw, torso, td]} position={[0, -torso / 2, 0]} color={p.shirtColor} />
        <Box size={[aw * 0.98, torso * 0.22, td * 0.98]} position={[0, -torso * 0.9, 0]} color={SKIN} shadow={false} />
      </group>
      <group ref={armRRef} position={[tw / 2 + aw / 2, shoulderY - 0.02, 0]}>
        <Box size={[aw, torso, td]} position={[0, -torso / 2, 0]} color={p.shirtColor} />
        <Box size={[aw * 0.98, torso * 0.22, td * 0.98]} position={[0, -torso * 0.9, 0]} color={SKIN} shadow={false} />
      </group>
      {/* Head */}
      <Box size={[head * 0.92, head * 0.92, head * 0.92]} position={[0, shoulderY + head * 0.48, 0]} color={SKIN} />
      <Box size={[head * 0.96, head * 0.3, head * 0.96]} position={[0, shoulderY + head * 0.84, -0.005]} color={HAIR} shadow={false} />
      {/* Eyes facing +Z */}
      <Box size={[head * 0.14, head * 0.1, 0.02]} position={[-head * 0.2, shoulderY + head * 0.52, head * 0.47]} color="#1d2433" shadow={false} />
      <Box size={[head * 0.14, head * 0.1, 0.02]} position={[head * 0.2, shoulderY + head * 0.52, head * 0.47]} color="#1d2433" shadow={false} />
    </group>
  );
}
