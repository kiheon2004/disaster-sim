/**
 * Volcano preview in the editor (Phase 28): the vents and their source area, and the potential downslope
 * directions traced on the bare terrain (dashed) — where lava could start to go, NOT its predicted reach.
 */
import { useMemo } from 'react';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { VolcanoSpec } from '@/volcano/types';
import { volcanoOutlook } from '@/volcano/outlook';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useWorldStore } from '@/world/worldStore';
import { GroundLine, circlePts } from '../ground/GroundTools';

/** Outline of a fissure: the segment grown by its half-width. */
export function fissureOutline(a: [number, number], b: [number, number], r: number): [number, number][] {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  const nx = (-dz / L) * r, nz = (dx / L) * r;
  return [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
}

export function VolcanoPreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const spec = inst.spec as VolcanoSpec;
  const o = useMemo(() => { const s = samplerFor(terrain); return volcanoOutlook(spec, terrain, (x, z) => s.sampleHeight(x, z)); }, [spec, terrain]);
  return (
    <group name="volcano-preview">
      {spec.vents.map((v, k) => (v.kind === 'fissure' && v.end
        ? <GroundLine key={k} pts={fissureOutline(v.position, v.end, v.radius)} color="#ff6a1a" />
        : <GroundLine key={k} pts={circlePts(v.position[0], v.position[1], v.radius, 40)} color="#ff6a1a" />))}
      {o.paths.map((p, k) => <GroundLine key={`p${k}`} pts={p} closed={false} color="#ffb070" dashed />)}
    </group>
  );
}
