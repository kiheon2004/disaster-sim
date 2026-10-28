import { useMemo } from 'react';
import type * as THREE from 'three';
import type { HumanParams } from '@/objects/definitions/human';
import { MergedBoxes, type BoxPart } from './MergedBoxes';
import type { ViewProps } from './types';

const SKIN = '#e2b48c';
const HAIR = '#3b2a1d';

/** Minecraft-like blocky person (3 draw calls: body + two arms that can animate). */
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
  const tw = h * 0.21;
  const td = h * 0.12;
  const lw = tw / 2;
  const aw = h * 0.09;
  const shoulderY = leg + torso;

  const body = useMemo<BoxPart[]>(() => [
    { size: [lw * 0.96, leg, td], position: [-lw / 2, leg / 2, 0], color: p.pantsColor },
    { size: [lw * 0.96, leg, td], position: [lw / 2, leg / 2, 0], color: p.pantsColor },
    { size: [lw * 0.98, leg * 0.12, td * 1.15], position: [-lw / 2, leg * 0.06, 0.01], color: '#26262a' },
    { size: [lw * 0.98, leg * 0.12, td * 1.15], position: [lw / 2, leg * 0.06, 0.01], color: '#26262a' },
    { size: [tw, torso, td * 1.05], position: [0, leg + torso / 2, 0], color: p.shirtColor },
    { size: [head * 0.92, head * 0.92, head * 0.92], position: [0, shoulderY + head * 0.48, 0], color: SKIN },
    { size: [head * 0.96, head * 0.3, head * 0.96], position: [0, shoulderY + head * 0.84, -0.005], color: HAIR },
    { size: [head * 0.14, head * 0.1, 0.02], position: [-head * 0.2, shoulderY + head * 0.52, head * 0.47], color: '#1d2433' },
    { size: [head * 0.14, head * 0.1, 0.02], position: [head * 0.2, shoulderY + head * 0.52, head * 0.47], color: '#1d2433' },
  ], [lw, leg, td, tw, torso, head, shoulderY, p.pantsColor, p.shirtColor]);

  const arm = useMemo<BoxPart[]>(() => [
    { size: [aw, torso, td], position: [0, -torso / 2, 0], color: p.shirtColor },
    { size: [aw * 0.98, torso * 0.22, td * 0.98], position: [0, -torso * 0.9, 0], color: SKIN },
  ], [aw, torso, td, p.shirtColor]);

  return (
    <group>
      <MergedBoxes parts={body} />
      {/* Arms pivot at the shoulders so they can be raised during a gust */}
      <group ref={armLRef} position={[-(tw / 2 + aw / 2), shoulderY - 0.02, 0]}>
        <MergedBoxes parts={arm} />
      </group>
      <group ref={armRRef} position={[tw / 2 + aw / 2, shoulderY - 0.02, 0]}>
        <MergedBoxes parts={arm} />
      </group>
    </group>
  );
}
