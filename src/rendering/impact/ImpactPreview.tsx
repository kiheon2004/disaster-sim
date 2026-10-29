/**
 * Impact preview in the 3D view (Phase 23, both modes; render-only — the document and the
 * simulation are untouched). Everything comes from impactOutlook() = planImpact(), the function the
 * simulation runs, on the current document terrain:
 *   - aim point (yellow) and the ACTUAL impact point where the arc meets the terrain (red), with the
 *     arc through the world and its direction beyond;
 *   - crater rim (radius R, solid) and the reach of the rim uplift (2R, dashed);
 *   - predicted ejecta thickness from the computed parcel landings (same footprints as the run);
 *   - the distance at which the applied ground-shock PGA falls to 0.1 g (dashed orange).
 * Values are model estimates; the panel says so.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { GRAVITY } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { ImpactSpec } from '@/impact/types';
import { impactOutlook } from '@/phenomena/impactDefinitions';
import { shockAt, type ImpactPlan } from '@/impact/plan';
import { FieldPatch } from '../deformation/fieldMesh';
import { depositColor } from '../ground/groundColors';
import { AimMarker, circlePts, GroundLine } from '../ground/GroundTools';

/** Distance (m) at which the applied PGA drops to `g` (bisection; 0 if never reached). */
export function shockRadius(plan: ImpactPlan, g = 0.1): number {
  if (!plan.shock) return 0;
  const at = (r: number) => shockAt(plan, r).pgaApplied / GRAVITY;
  if (at(plan.shock.radius) < g) return 0;
  let lo = plan.shock.radius, hi = 2000;
  if (at(hi) >= g) return hi;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (at(m) >= g) lo = m; else hi = m; }
  return lo;
}

/** Predicted ejecta thickness per vertex (m, bulked) from the parcels' landing footprints. */
export function ejectaThickness(plan: ImpactPlan, t: { nx: number; nz: number; originX: number; originZ: number; cellSize: number }): Float32Array {
  const out = new Float32Array(t.nx * t.nz);
  const B = plan.target.bulking, A = t.cellSize * t.cellSize;
  const [cx, , cz] = plan.arc.point;
  for (const p of plan.parcels) {
    if (p.outflow) continue;
    const [x, , z] = p.p1;
    let rx = x - cx, rz = z - cz;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const sr = p.spreadR, st = p.spreadT, reach = 2 * Math.max(sr, st);
    const cells: [number, number][] = [];
    let wSum = 0;
    for (let iz = Math.max(0, Math.floor((z - reach - t.originZ) / t.cellSize)); iz <= Math.min(t.nz - 1, Math.ceil((z + reach - t.originZ) / t.cellSize)); iz++) {
      for (let ix = Math.max(0, Math.floor((x - reach - t.originX) / t.cellSize)); ix <= Math.min(t.nx - 1, Math.ceil((x + reach - t.originX) / t.cellSize)); ix++) {
        const dx = t.originX + ix * t.cellSize - x, dz = t.originZ + iz * t.cellSize - z;
        const a = dx * rx + dz * rz, b = -dx * rz + dz * rx;
        const w = Math.exp(-0.5 * ((a * a) / (sr * sr) + (b * b) / (st * st)));
        if (w < 1e-3) continue;
        cells.push([iz * t.nx + ix, w]);
        wSum += w;
      }
    }
    for (const [i, w] of cells) out[i] += (p.volume * B * w) / wSum / A;
  }
  return out;
}

export function ImpactPreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const spec = inst.spec as ImpactSpec;
  const plan = useMemo(() => impactOutlook(spec, { seed: inst.seed ?? seed, terrain }), [spec, terrain, seed, inst.seed]);
  const built = useMemo(() => {
    if (!plan) return null;
    // World arc (sampled parabola) from the hand-over point to the impact point.
    const a = plan.arc;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 60; k++) {
      const t = (a.time * k) / 60;
      pts.push(new THREE.Vector3(a.start[0] + a.velocity0[0] * t, a.start[1] + a.velocity0[1] * t - 0.5 * GRAVITY * t * t, a.start[2] + a.velocity0[2] * t));
    }
    const arc = new THREE.BufferGeometry().setFromPoints(pts);
    let deposit: FieldPatch | null = null;
    if (plan.parcels.length) {
      const th = ejectaThickness(plan, terrain);
      let x0 = terrain.nx, x1 = -1, z0 = terrain.nz, z1 = -1;
      for (let i = 0; i < th.length; i++) if (th[i] > 0.005) { const ix = i % terrain.nx, iz = (i - ix) / terrain.nx; x0 = Math.min(x0, ix); x1 = Math.max(x1, ix); z0 = Math.min(z0, iz); z1 = Math.max(z1, iz); }
      if (x1 >= x0) {
        deposit = new FieldPatch(terrain, { x0, z0, x1, z1 });
        deposit.write(terrain.heights, 0.07, (_l, g, out) => (th[g] < 0.005 ? 0 : (depositColor(th[g], out), 0.35 + 0.5 * Math.min(1, th[g]))));
      }
    }
    return { arc, deposit, shock: shockRadius(plan, 0.1) };
  }, [plan, terrain]);
  useEffect(() => () => { built?.arc.dispose(); built?.deposit?.dispose(); }, [built]);
  if (!plan || !built) return null;
  const [px, , pz] = plan.arc.point;
  const R = plan.crater?.radius ?? 0;
  return (
    <group name="impact-preview">
      <line>
        <primitive object={built.arc} attach="geometry" />
        <lineBasicMaterial color="#ff7a45" depthTest={false} transparent opacity={0.9} />
      </line>
      <AimMarker x={spec.target[0]} z={spec.target[1]} color="#ffd34d" />
      {!plan.airburst && <AimMarker x={px} z={pz} color="#e0483a" r={1.2} />}
      {plan.arc.miss > 0.5 && <GroundLine pts={[spec.target, [px, pz]]} closed={false} color="#e0483a" dashed />}
      {R > 0 && <GroundLine pts={circlePts(px, pz, R)} color="#e0483a" />}
      {R > 0 && <GroundLine pts={circlePts(px, pz, 2 * R)} color="#e0483a" dashed />}
      {built.shock > R && <GroundLine pts={circlePts(px, pz, built.shock, 96)} color="#ff9f43" dashed />}
      {built.deposit && (
        <mesh geometry={built.deposit.geometry} renderOrder={3} raycast={() => null}>
          <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
        </mesh>
      )}
    </group>
  );
}
