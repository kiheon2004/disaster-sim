import { MATERIALS } from './materials';
import { tint } from './design';
import type { BuildingDesign, BuildingMember } from './types';

/** Base color of a member (cladding and parapets follow the facade tint). */
export function memberColor(m: BuildingMember, design: BuildingDesign): string {
  const mat = MATERIALS[m.material];
  if (m.type === 'wall' && (m.role === 'cladding' || m.role === 'nonStructural') && m.material !== 'glass') return tint(mat.color, design.spec.color);
  if (m.type === 'wall' && m.role === 'bearing' && m.facade && m.material !== 'reinforcedConcrete') return tint(mat.color, design.spec.color, 0.35);
  return mat.color;
}
