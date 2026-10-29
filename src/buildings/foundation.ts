/**
 * Foundation ↔ terrain contact (Phase 17). Explicit, sampled, deterministic:
 *
 *  - the footprint (plus the foundation margin) is sampled on a grid in the building's frame;
 *  - at each sample, the foundation bottom is the lowest of: the foundation members covering it
 *    and the slope plinth (floor → plinth depth + 0.3 m embedment);
 *  - ground ≥ bottom − 5 cm → the point bears (embedment = ground − bottom); otherwise there is a
 *    gap and the point is UNSUPPORTED;
 *  - ground support capacity = soil allowable bearing pressure × foundation-type factor × the
 *    bearing area, against the weight of building + foundation (static bearing ratio).
 *
 * Policy ('refit' / 'preserve', DesignOptions.foundationPolicy) decides what a terrain edit does:
 * refit re-seats the building and regrows the plinth (Phase 13–16 behavior); preserve keeps the
 * world transform and the plinth depth, so lowered ground opens gaps and raised ground buries.
 */
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { GRAVITY } from '@/core/units';
import { getDefinition } from '@/objects/registry';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { foundationPlinth, yawOf } from '@/terrain/groundPlacement';
import { FOUNDATION_TYPES } from '@/simulation/seismic/structuralProps';
import { memberBounds } from './geometry';
import { analysisOf } from './design';

export interface FoundationSample {
  /** World position of the sample (x, ground y, z). */
  point: Vec3;
  /** Foundation bottom elevation (world, m). */
  bottom: number;
  /** ground − bottom: > 0 embedded, < 0 gap (m). */
  embed: number;
  supported: boolean;
}

export interface FoundationContact {
  samples: FoundationSample[];
  /** Fraction of the samples that bear on the ground. */
  contact: number;
  /** Footprint area without ground contact (m²). */
  unsupportedArea: number;
  footprintArea: number;
  embedMin: number;
  embedMax: number;
  embedMean: number;
  /** Steepest ground slope across the footprint (deg). */
  slope: number;
  /** Plinth depth below the floor (m) and the floor elevation (world). */
  plinth: number;
  floor: number;
  /** Floor below the ground somewhere (buried ground floor). */
  buried: boolean;
  /** Static bearing pressure / capacity. */
  bearingRatio: number;
  /** Allowable bearing pressure under the building (kPa, soil × foundation type). */
  bearingCapacity: number;
}

const N = 7;

export function foundationContact(obj: WorldObject, terrain: TerrainSampler): FoundationContact {
  const def = getDefinition(obj.type);
  const d = def.getDimensions(obj.params);
  const k = obj.transform.scale;
  const [x, floor, z] = obj.transform.position;
  const yaw = yawOf(obj.transform.rotation);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const plinth = foundationPlinth(obj, terrain);
  const plinthBottom = plinth > 0 ? floor - plinth - 0.3 : floor;
  const hx = (d[0] * k[0]) / 2;
  const hz = (d[2] * k[2]) / 2;
  // Foundation members (modular) in the building frame.
  const fms = (obj.building?.members ?? []).filter((m) => m.type === 'foundation' || (m.type === 'slab' && m.level < 0)).map((m) => memberBounds(m, k));
  const samples: FoundationSample[] = [];
  let sum = 0, mn = Infinity, mx = -Infinity, ok = 0, buried = false;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lx = -hx + (2 * hx * i) / (N - 1);
      const lz = -hz + (2 * hz * j) / (N - 1);
      const wx = x + lx * c + lz * s;
      const wz = z - lx * s + lz * c;
      const g = terrain.sampleHeight(wx, wz);
      let bottom = plinthBottom;
      for (const b of fms) {
        if (lx >= b.min[0] - 0.05 && lx <= b.max[0] + 0.05 && lz >= b.min[2] - 0.05 && lz <= b.max[2] + 0.05) bottom = Math.min(bottom, floor + b.min[1]);
      }
      // Without any foundation member, the floor itself bears (legacy / flat ground).
      const embed = g - bottom;
      const supported = embed >= -0.05;
      if (supported) ok++;
      if (g > floor + 0.05) buried = true;
      sum += embed;
      mn = Math.min(mn, embed);
      mx = Math.max(mx, embed);
      samples.push({ point: [wx, g, wz], bottom, embed, supported });
    }
  }
  const n = samples.length;
  const area = 4 * hx * hz;
  const contact = ok / n;
  // Steepest slope from the corner samples.
  const h = (i: number, j: number) => samples[i * N + j].point[1];
  const sx = Math.abs(h(N - 1, 0) - h(0, 0)) / Math.max(0.1, 2 * hx);
  const sz = Math.abs(h(0, N - 1) - h(0, 0)) / Math.max(0.1, 2 * hz);
  const slope = (Math.atan(Math.hypot(sx, sz)) * 180) / Math.PI;
  const soil = terrain.sampleSoil(x, z);
  const ft = FOUNDATION_TYPES[obj.seismic?.foundation.type ?? 'mat'];
  const cap = soil.bearingCapacity * ft.bearingFactor; // kPa
  const mass = obj.building ? analysisOf(obj.building).totalMass + analysisOf(obj.building).foundationMass : obj.physics.mass * (1 + ft.massFraction);
  const pressure = (mass * GRAVITY) / Math.max(1, area * Math.max(0.05, contact)) / 1000;
  return {
    samples, contact, unsupportedArea: area * (1 - contact), footprintArea: area,
    embedMin: mn, embedMax: mx, embedMean: sum / n, slope, plinth, floor, buried,
    bearingRatio: pressure / cap, bearingCapacity: cap,
  };
}

/** A user move puts a 'preserve' building on new ground on purpose: its plinth refits there. */
export function releasePlinth(o: WorldObject): WorldObject {
  const opts = o.building?.options;
  if (!opts || opts.plinthDepth === null) return o;
  return { ...o, building: { ...o.building!, options: { ...opts, plinthDepth: null } } };
}

/**
 * Terrain edited under a 'preserve' building: it keeps its world transform and freezes the
 * plinth depth it had on the old terrain (once — later edits keep the same foundation).
 */
export function preserveOnTerrainEdit(o: WorldObject, before: TerrainSampler): WorldObject {
  const opts = o.building!.options;
  if (opts.plinthDepth !== null) return o;
  return { ...o, building: { ...o.building!, options: { ...opts, plinthDepth: Math.round(foundationPlinth(o, before) * 1000) / 1000 } } };
}
