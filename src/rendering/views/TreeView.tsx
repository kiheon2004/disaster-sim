import { useMemo } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from '@/core/types';
import { seededRandom } from '@/core/math';
import { SNAP_FRACTION, trunkHeight, type TreeParams } from '@/objects/definitions/tree';
import { shade } from '../materials';
import { Box } from './Box';
import type { ViewProps } from './types';

interface Voxel { pos: Vec3; size: Vec3; color: string }

/** Deterministic voxel canopy so the same tree always looks the same. */
export function buildCanopy(p: TreeParams, seed: number): Voxel[] {
  const rnd = seededRandom(seed);
  const th = trunkHeight(p);
  const r = p.canopyRadius;
  const base = p.species === 'conifer' ? '#2f6b3a' : '#4f8f3a';
  const out: Voxel[] = [];
  if (p.species === 'conifer') {
    const tiers = 4;
    const h = (p.height - th) / tiers;
    for (let i = 0; i < tiers; i++) {
      const s = 2 * r * (1 - (i / tiers) * 0.72);
      out.push({ pos: [0, th + h * (i + 0.5), 0], size: [s, h * 1.12, s], color: shade(base, i % 2 ? 0.03 : -0.02) });
    }
    out.push({ pos: [0, p.height - h * 0.15, 0], size: [r * 0.35, h * 0.6, r * 0.35], color: shade(base, 0.04) });
  } else {
    const cy = p.height - r * 0.95;
    out.push({ pos: [0, cy, 0], size: [r * 1.7, r * 1.5, r * 1.7], color: base });
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
      const d = r * (0.45 + rnd() * 0.25);
      const s = r * (0.75 + rnd() * 0.4);
      out.push({
        pos: [Math.cos(a) * d, cy + (rnd() - 0.4) * r * 0.7, Math.sin(a) * d],
        size: [s, s * (0.8 + rnd() * 0.3), s],
        color: shade(base, (rnd() - 0.5) * 0.1),
      });
    }
  }
  return out;
}

export function TreeView({
  obj,
  upperRef,
  canopyRef,
}: ViewProps & { upperRef?: React.Ref<THREE.Group>; canopyRef?: React.Ref<THREE.Group> }) {
  const p = obj.params as TreeParams;
  const canopy = useMemo(() => buildCanopy(p, obj.seed), [p, obj.seed]);
  const snapH = p.height * SNAP_FRACTION;
  const th = trunkHeight(p);
  const trunkW = p.trunkRadius * 2;
  const bark = '#6b4a2f';

  return (
    <group>
      {/* Stump: stays in place when the trunk snaps */}
      <Box size={[trunkW, snapH, trunkW]} position={[0, snapH / 2, 0]} color={bark} />
      {/* Upper part: sways as one unit and becomes the falling body after failure */}
      <group ref={upperRef}>
        <Box
          size={[trunkW * 0.92, th - snapH + 0.4, trunkW * 0.92]}
          position={[0, snapH + (th - snapH + 0.4) / 2, 0]}
          color={shade(bark, 0.03)}
        />
        <group ref={canopyRef}>
          {canopy.map((v, i) => (
            <Box key={i} size={v.size} position={v.pos} color={v.color} mat={{ roughness: 0.95 }} />
          ))}
        </group>
      </group>
    </group>
  );
}
