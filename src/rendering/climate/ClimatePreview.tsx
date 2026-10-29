/**
 * Climate preview in the editor (Phase 30): the shortwave the bare ground would absorb at the start time — the same
 * sun, albedo, incidence and shading function the run uses (computeShade) — on a fixed W/m² legend, and the
 * precipitation area (dashed = the whole world). No surface temperature or snow is predicted here. The obstacles are
 * boxes from the editor document (building spec floors × floor height + 1 m, axis-aligned): the run uses the bodies'
 * own dimensions and rotations, so shadow edges can differ by about a cell and heights by about a metre.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { ClimateSpec } from '@/climate/types';
import { ClimateForcing } from '@/climate/forcing';
import { cellGeometry, computeShade } from '@/climate/ClimateWorld';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useWorldStore } from '@/world/worldStore';
import { useDisposable } from '../useDisposable';
import { GroundLine, circlePts } from '../ground/GroundTools';
import { columnGridGeometry, paintColumns } from '../atmosphere/columnGrid';
import { climateColor } from './climateColors';

export function ClimatePreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const objects = useWorldStore((s) => s.doc.objects);
  const spec = inst.spec as ClimateSpec;
  const W = (terrain.nx - 1) * terrain.cellSize, D = (terrain.nz - 1) * terrain.cellSize;
  const grid = useMemo(() => ({ originX: terrain.originX, originZ: terrain.originZ, nx: Math.ceil(W / 2), nz: Math.ceil(D / 2), dx: 2 }), [terrain, W, D]);
  const sampler = useMemo(() => samplerFor(terrain), [terrain]);
  const geo = useDisposable(() => columnGridGeometry(grid, (x, z) => sampler.sampleHeight(x, z), 0.4), [grid, sampler]);
  const mat = useDisposable(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
  useEffect(() => {
    const geo0 = cellGeometry(terrain);
    const nx = terrain.nx - 1, nz = terrain.nz - 1, n = nx * nz;
    // Obstacles: buildings / walls of the document as axis-aligned boxes of their footprint (rotation ignored in the preview).
    const top = new Float32Array(n).fill(-Infinity);
    for (const o of Object.values(objects)) {
      if (o.type !== 'building' && o.type !== 'wall') continue;
      const p = o.transform.position;
      const b = (o as { building?: { spec?: { width?: number; depth?: number; floors?: number; floorHeight?: number } } }).building?.spec;
      const hx = (b?.width ?? 8) / 2, hz = (b?.depth ?? 8) / 2, h = (b?.floors ?? 1) * (b?.floorHeight ?? 3) + 1;
      for (let iz = Math.max(0, Math.floor((p[2] - hz - terrain.originZ) / terrain.cellSize)); iz <= Math.min(nz - 1, Math.floor((p[2] + hz - terrain.originZ) / terrain.cellSize)); iz++)
        for (let ix = Math.max(0, Math.floor((p[0] - hx - terrain.originX) / terrain.cellSize)); ix <= Math.min(nx - 1, Math.floor((p[0] + hx - terrain.originX) / terrain.cellSize)); ix++)
          top[iz * nx + ix] = Math.max(top[iz * nx + ix], sampler.sampleHeight(p[0], p[2]) + h);
    }
    const f = new ClimateForcing(spec, 101325);
    const sun = f.sun(0);
    const cos = new Float32Array(n), shade = new Uint8Array(n);
    if (sun.elevation > 0) computeShade({ nx, nz, cell: terrain.cellSize, groundH: geo0.groundH, nX: geo0.nX, nY: geo0.nY, nZ: geo0.nZ, obstacleTop: top }, sun.dir, cos, shade);
    paintColumns(geo, grid.nx * grid.nz, (a) => {
      const px = a % grid.nx, pz = (a - px) / grid.nx;
      const c = Math.min(nz - 1, pz * 2) * nx + Math.min(nx - 1, px * 2);
      if (!(sun.elevation > 0) || spec.solar === 'off') return 0;
      return (1 - geo0.albedo[c]) * (sun.direct * (shade[c] ? 0 : cos[c]) + sun.diffuse);
    }, (v, out) => climateColor('solar', v, out));
  }, [geo, grid, sampler, terrain, objects, spec]);
  const x0 = terrain.originX, z0 = terrain.originZ;
  const edge: [number, number][] = [[x0 + 0.5, z0 + 0.5], [x0 + W - 0.5, z0 + 0.5], [x0 + W - 0.5, z0 + D - 0.5], [x0 + 0.5, z0 + D - 0.5]];
  const precip = (spec.precipitation ?? 0) > 0;
  return (
    <group name="climate-preview">
      <mesh geometry={geo} material={mat} renderOrder={2} raycast={() => null} />
      {precip && !spec.area && <GroundLine pts={edge} color="#bfe3ff" dashed />}
      {precip && spec.area && <GroundLine pts={circlePts(spec.area.center[0], spec.area.center[1], spec.area.radius, 72)} color="#bfe3ff" />}
    </group>
  );
}
