/**
 * Heat-source preview in the 3D view (Phase 26, both modes; render-only — the document and the
 * simulation are untouched). The ground receivers come from groundReceivers(), the SAME function the
 * run uses for its weights: the expected absorbed flux on the ground at the source's peak output
 * (W/m², log colors), the source position and its coverage (disc / sphere), the reach where the
 * irradiance falls below 1 W/m², and the prescribed-temperature boundary sphere. It is a flux map,
 * not a temperature forecast (temperatures depend on time, materials and losses); objects that shade
 * or cover the ground are applied by the run, not here (stated in the editor).
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { HeatSourceSpec } from '@/thermal/types';
import { samplerFor } from '@/terrain/TerrainSampler';
import type { TerrainData, WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { GROUND_EMISSIVITY } from '@/thermal/materials';
import { groundReceivers, receiverFlux, sourceReach, type GroundReceiver } from '@/thermal/geometry';
import { STANDARD_AMBIENT } from '@/thermal/units';
import { AimMarker, circlePts, GroundLine } from '../ground/GroundTools';
import { fluxColor } from './thermalColors';

export interface ThermalOutlook {
  receivers: GroundReceiver[];
  flux: Float32Array;
  reach: number;
  /** Ground area receiving at least 1 / 5 / 10 kW/m² at peak output (m²). */
  areas: [number, number, number];
  ambient: number;
  /** The source lies inside a building: it heats that room and its members, not the ground outside. */
  inside: boolean;
}

interface Footprint { x: number; z: number; hx: number; hz: number; c: number; s: number; top: number }

/** Building footprints of the document (the ground under them is covered, as in the run). */
function footprints(objects: Record<string, WorldObject> | undefined): Footprint[] {
  const out: Footprint[] = [];
  for (const o of Object.values(objects ?? {})) {
    if (o.type !== 'building') continue;
    const d = getDefinition(o.type).getDimensions(o.params);
    const [sx, sy, sz] = o.transform.scale;
    const yaw = o.transform.rotation[1];
    out.push({ x: o.transform.position[0], z: o.transform.position[2], hx: (d[0] * sx) / 2, hz: (d[2] * sz) / 2, c: Math.cos(yaw), s: Math.sin(yaw), top: o.transform.position[1] + d[1] * sy });
  }
  return out;
}
const inFootprint = (f: Footprint, x: number, z: number) => {
  const dx = x - f.x, dz = z - f.z;
  const lx = dx * f.c - dz * f.s, lz = dx * f.s + dz * f.c;
  return Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz;
};

let cache: { spec: HeatSourceSpec; terrain: TerrainData; ambient: number; objects: unknown; out: ThermalOutlook } | null = null;

/** Preview of a source on a terrain with the document's buildings (cached per spec / terrain / objects). */
export function thermalOutlook(spec: HeatSourceSpec, terrain: TerrainData, ambient = STANDARD_AMBIENT, objects?: Record<string, WorldObject>): ThermalOutlook {
  if (cache && cache.spec === spec && cache.terrain === terrain && cache.ambient === ambient && cache.objects === objects) return cache.out;
  const s = samplerFor(terrain);
  const vx = terrain.nx;
  const fps = footprints(objects);
  const nx = terrain.nx - 1;
  const cx = (c: number) => terrain.originX + ((c % nx) + 0.5) * terrain.cellSize, cz = (c: number) => terrain.originZ + (((c / nx) | 0) + 0.5) * terrain.cellSize;
  const grid = {
    nx, nz: terrain.nz - 1, cell: terrain.cellSize, originX: terrain.originX, originZ: terrain.originZ,
    height: (x: number, z: number) => s.sampleHeight(x, z),
    covered: (c: number) => fps.some((f) => inFootprint(f, cx(c), cz(c))),
    emissivity: (c: number) => GROUND_EMISSIVITY[Math.min(GROUND_EMISSIVITY.length - 1, terrain.ground[((c / (vx - 1)) | 0) * vx + vx + (c % (vx - 1)) + 1])],
  };
  const [px, pz] = spec.position;
  const inside = (spec.kind === 'point' || spec.kind === 'temperature' || spec.kind === 'volume') && fps.some((f) => inFootprint(f, px, pz) && s.sampleHeight(px, pz) + spec.height < f.top);
  const receivers = inside ? [] : groundReceivers(spec, grid, ambient);
  const A = terrain.cellSize * terrain.cellSize;
  const flux = receiverFlux(spec, receivers, A, ambient);
  const areas: [number, number, number] = [0, 0, 0];
  for (const q of flux) { if (q >= 1e3) areas[0] += A; if (q >= 5e3) areas[1] += A; if (q >= 1e4) areas[2] += A; }
  const out = { receivers, flux, reach: sourceReach(spec, ambient), areas, ambient, inside };
  cache = { spec, terrain, ambient, objects, out };
  return out;
}

export function ThermalPreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const ambient = useWorldStore((s) => s.doc.settings.simulation.thermal?.ambient ?? STANDARD_AMBIENT);
  const objects = useWorldStore((s) => s.doc.objects);
  const spec = inst.spec as HeatSourceSpec;
  const out = useMemo(() => thermalOutlook(spec, terrain, ambient, objects), [spec, terrain, ambient, objects]);
  const geo = useMemo(() => {
    const s = samplerFor(terrain);
    const n = out.receivers.length;
    const pos = new Float32Array(n * 4 * 3), col = new Float32Array(n * 4 * 4), idx = new Uint32Array(n * 6);
    const c = new THREE.Color();
    const nx = terrain.nx - 1, cs = terrain.cellSize;
    out.receivers.forEach((r, k) => {
      const ix = r.cell % nx, iz = (r.cell / nx) | 0;
      const x0 = terrain.originX + ix * cs, z0 = terrain.originZ + iz * cs;
      fluxColor(out.flux[k], c);
      const a = out.flux[k] < 50 ? 0 : 0.6;
      [[x0, z0], [x0 + cs, z0], [x0, z0 + cs], [x0 + cs, z0 + cs]].forEach(([x, z], p) => {
        pos.set([x, s.sampleHeight(x, z) + 0.15, z], (4 * k + p) * 3);
        col.set([c.r, c.g, c.b, a], (4 * k + p) * 4);
      });
      const b = 4 * k;
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], 6 * k);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }, [out, terrain]);
  useEffect(() => () => geo.dispose(), [geo]);
  const [x, z] = spec.position;
  const y = samplerFor(terrain).sampleHeight(x, z) + spec.height;
  return (
    <group name="thermal-preview">
      <mesh geometry={geo} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} side={THREE.DoubleSide} />
      </mesh>
      <AimMarker x={x} z={z} color="#ff8a3d" r={spec.kind === 'point' ? 1 : 0.6} />
      {spec.kind !== 'point' && <GroundLine pts={circlePts(x, z, spec.radius, 64)} color="#ff8a3d" />}
      {!out.inside && out.reach > spec.radius + 0.5 && <GroundLine pts={circlePts(x, z, out.reach, 96)} color="#f2c230" dashed />}
      {(spec.kind === 'point' || spec.kind === 'surface' || spec.kind === 'volume' || spec.kind === 'temperature') && (
        <mesh position={[x, y, z]} scale={spec.kind === 'point' ? 0.4 : spec.radius} raycast={() => null}>
          <sphereGeometry args={[1, 24, 12]} />
          <meshBasicMaterial color={spec.kind === 'temperature' ? '#ff5a2a' : '#ffd34d'} wireframe transparent opacity={0.55} />
        </mesh>
      )}
    </group>
  );
}
