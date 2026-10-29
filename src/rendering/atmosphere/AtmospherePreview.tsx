/**
 * Atmosphere preview in the editor (Phase 29): the initial surface-pressure field over the actual
 * terrain (hydrostatic, the same relation the run uses — fixed kPa legend), the world boundary (solid =
 * closed, dashed = open) and the local sink / source disc. No flow is predicted.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { AtmosphereSpec } from '@/atmosphere/types';
import { datumState } from '@/events/atmosphere/AtmosphereEvent';
import { scaleHeight } from '@/atmosphere/reference';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useWorldStore } from '@/world/worldStore';
import { useDisposable } from '../useDisposable';
import { GroundLine, circlePts } from '../ground/GroundTools';
import { columnGridGeometry, paintColumns } from './columnGrid';
import { atmosColor } from './atmosColors';

export function AtmospherePreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const spec = inst.spec as AtmosphereSpec;
  const W = (terrain.nx - 1) * terrain.cellSize, D = (terrain.nz - 1) * terrain.cellSize;
  const grid = useMemo(() => ({ originX: terrain.originX, originZ: terrain.originZ, nx: Math.ceil(W / 5 - 1e-9), nz: Math.ceil(D / 5 - 1e-9), dx: 5 }), [terrain, W, D]);
  const sampler = useMemo(() => samplerFor(terrain), [terrain]);
  const geo = useDisposable(() => columnGridGeometry(grid, (x, z) => sampler.sampleHeight(x, z)), [grid, sampler]);
  const mat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
  const { p, T } = datumState(spec);
  useEffect(() => {
    const Hs = scaleHeight(T);
    paintColumns(geo, grid.nx * grid.nz, (a) => {
      const ix = a % grid.nx, iz = (a - ix) / grid.nx;
      const g = sampler.sampleHeight(grid.originX + (ix + 0.5) * 5, grid.originZ + (iz + 0.5) * 5);
      return (p * Math.exp(-g / Hs)) / 1000;
    }, (v, out) => atmosColor('pressure', v, out));
  }, [geo, grid, sampler, p, T]);
  const x0 = terrain.originX, z0 = terrain.originZ;
  const edge: [number, number][] = [[x0 + 0.5, z0 + 0.5], [x0 + W - 0.5, z0 + 0.5], [x0 + W - 0.5, z0 + D - 0.5], [x0 + 0.5, z0 + D - 0.5]];
  const local = spec.extent === 'local' && (spec.removal !== 'none' || spec.restore === 'reservoir') && spec.position;
  return (
    <group name="atmosphere-preview">
      <mesh geometry={geo} material={mat} renderOrder={2} raycast={() => null} />
      <GroundLine pts={edge} color={spec.boundary === 'open' ? '#5fb8ff' : '#e0e6ee'} dashed={spec.boundary === 'open'} />
      {local && <GroundLine pts={circlePts(spec.position![0], spec.position![1], spec.radius ?? 25, 60)} color="#5fb8ff" />}
    </group>
  );
}
