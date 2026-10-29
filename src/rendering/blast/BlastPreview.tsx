/**
 * Air-blast preview in the 3D view (Phase 24, both modes; render-only — the document and the
 * simulation are untouched). Everything is computed by planBlast() + BlastField, the same model
 * and shielding the simulation uses, on the current document terrain and buildings:
 *   - the source (and its height), the strong-shock (r_t) and weak-shock validity (0.3 p₀) radii;
 *   - expected ground-level peak overpressure (heatmap, log scale) — shielded zones visibly lower;
 *   - arrival-time contours and the 1 / 3 / 10 / 30 kPa contours of the model estimate.
 * Labelled as model estimates; no "destruction radius" is drawn.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import type { PhenomenonInstance } from '@/phenomena/types';
import type { BlastSpec } from '@/blast/types';
import { blastOutlook } from '@/phenomena/blastDefinitions';
import { BlastField, groundOf, PRESSURE_LEVELS, shieldIndexOf, type BlastPlan } from '@/blast/plan';
import type { TerrainData, WorldObject } from '@/core/model';
import { AimMarker, circlePts, GroundLine } from '../ground/GroundTools';
import { FieldGrid, isolines } from './blastGrid';
import { pressureColor } from './blastColors';

/** Preview field step (m). */
export const PREVIEW_STEP = 2;

let cache: { plan: BlastPlan; terrain: TerrainData; objects: unknown; field: BlastField } | null = null;

/** Ground-level field of a plan with the document's buildings as shields (cached). */
export function previewField(plan: BlastPlan, terrain: TerrainData, objects: Record<string, WorldObject>): BlastField {
  if (cache && cache.plan === plan && cache.terrain === terrain && cache.objects === objects) return cache.field;
  const field = new BlastField([plan.wave], groundOf(terrain), shieldIndexOf(Object.values(objects)), PREVIEW_STEP);
  cache = { plan, terrain, objects, field };
  return field;
}

/** A "nice" contour interval (s) for about `n` contours over a duration. */
export function niceInterval(total: number, n = 6): number {
  const raw = total / n, p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

export function BlastPreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const objects = useWorldStore((s) => s.doc.objects);
  const seed = useWorldStore((s) => s.doc.settings.simulation.seed);
  const spec = inst.spec as BlastSpec;
  const plan = useMemo(() => blastOutlook(spec, { seed, terrain }), [spec, terrain, seed]);
  const built = useMemo(() => {
    if (!plan) return null;
    const f = previewField(plan, terrain, objects);
    const grid = new FieldGrid(f);
    grid.paint((i, c) => (f.peak[i] < 100 ? 0 : (pressureColor(f.peak[i], c), 0.55)));
    const rel = Float32Array.from(f.arrival, (t) => t - plan.wave.init.time);
    const dtc = niceInterval(plan.worldExit);
    const arr: number[] = [];
    for (let t = dtc; t < plan.worldExit; t += dtc) arr.push(...isolines(f, rel, t, 0.3));
    const arrival = new THREE.BufferGeometry();
    arrival.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    const lv: number[] = [];
    for (const p of PRESSURE_LEVELS) lv.push(...isolines(f, f.peak, p, 0.35));
    const levels = new THREE.BufferGeometry();
    levels.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lv), 3));
    return { grid, arrival, levels };
  }, [plan, terrain, objects]);
  useEffect(() => () => { built?.grid.dispose(); built?.arrival.dispose(); built?.levels.dispose(); }, [built]);
  if (!plan || !built) return null;
  const [x, z] = spec.position;
  return (
    <group name="blast-preview">
      <mesh geometry={built.grid.geometry} renderOrder={3} raycast={() => null}>
        <meshBasicMaterial vertexColors transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={built.arrival} renderOrder={6} raycast={() => null}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.55} depthTest={false} />
      </lineSegments>
      <lineSegments geometry={built.levels} renderOrder={6} raycast={() => null}>
        <lineBasicMaterial color="#1b1b1b" transparent opacity={0.8} depthTest={false} />
      </lineSegments>
      <AimMarker x={x} z={z} color="#ffd34d" r={1.2} />
      {plan.rt > 0.5 && <GroundLine pts={circlePts(x, z, plan.rt, 72)} color="#b0174f" />}
      {plan.validRadius > 0.5 && <GroundLine pts={circlePts(x, z, plan.validRadius, 96)} color="#f2c230" dashed />}
    </group>
  );
}
