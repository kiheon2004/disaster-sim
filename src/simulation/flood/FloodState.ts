/**
 * Per-object flood state (Phase 14) and its lazy construction.
 *
 * Nothing here exists until the water model activates: wind- and earthquake-only runs create no
 * flood state, and every `if (e.flood)` branch in the shared damage behaviors stays cold, so
 * their results are bit-identical to Phase 13.
 */
import type { EntityId, Vec3 } from '@/core/types';
import { qRotate, seededRandom } from '@/core/math';
import { hashString } from '@/core/math';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';

export interface FloodEntityState {
  /** Water depth above the ground at the object (m). Buildings: deepest point around them. */
  depth: number;
  /** Buildings: mean depth around the footprint (m). */
  meanDepth: number;
  /** Water surface elevation (m) at the object (−Infinity = dry). */
  surface: number;
  /** Flow velocity at the object (m/s, world x / z) and its magnitude. */
  flow: [number, number];
  speed: number;
  /** Fraction of the body's height under water (free bodies). */
  submerged: number;
  /** Current buoyancy (N) and buoyancy / weight. */
  buoyancy: number;
  buoyancyRatio: number;
  /** Current hydrodynamic + hydrostatic load used for damage (N). */
  load: number;
  /** Flood demand / capacity (1 = at capacity). */
  loadRatio: number;
  peakLoadRatio: number;
  /** Seconds spent in water ≥ FLOOD_DEPTH. */
  exposure: number;
  peakDepth: number;
  peakSpeed: number;
  /** Flood damage channel: 1 → 0, folded into the shared health with min() (like seismic). */
  health: number;
  /** Buildings: structural flood damage index (≥ 1 = collapse) and finishes / contents damage 0–1. */
  damage: number;
  finish: number;
  /** Buildings: water depth inside above the floor (m) — follows the outside with a lag. */
  inside: number;
  /** Vehicles: 0–1 how far water has entered the cabin (reduces the sealed volume). */
  ingress: number;
  /** People: balance reserve 1 → 0 (falls). */
  balance: number;
  /** Highest inundation level already recorded (0 none, 1 shallow, 2 deep, 3 very deep). */
  level: number;
  floated: boolean;
  /** Roads: scour index (≥ 1 = surface damaged); impassable already recorded. */
  scour: number;
  /** Water surface last applied to a sleeping body (wake when it changes). */
  lastEta: number;
  /** Sample points [x0, z0, x1, z1, …] around a building / along a road or wall (world). */
  points: Float64Array | null;
  /** Walls: unit normal (x, z) — depth difference across the wall. */
  normal: [number, number];
  /** Per-component flood capacity scatter (×), deterministic per object seed. */
  scatter: Float64Array | null;
  /** Dominant force on a free body this step came from the water (for hazard attribution). */
  dominant: boolean;
}

export interface FloodRuntime {
  /** Every entity with a flood state (non-inert + roads). */
  entities: RuntimeEntity[];
  byId: Map<EntityId, RuntimeEntity>;
}

function createState(): FloodEntityState {
  return {
    depth: 0, meanDepth: 0, surface: -Infinity, flow: [0, 0], speed: 0, submerged: 0, buoyancy: 0, buoyancyRatio: 0, load: 0,
    loadRatio: 0, peakLoadRatio: 0, exposure: 0, peakDepth: 0, peakSpeed: 0, health: 1, damage: 0, finish: 0, inside: 0, ingress: 0,
    balance: 1, level: 0, floated: false, scour: 0, lastEta: -Infinity, points: null, normal: [0, 1], scatter: null, dominant: false,
  };
}

/** World point of a local (object space, scaled) offset on a static object. */
function worldOf(e: RuntimeEntity, x: number, z: number): Vec3 {
  const r = qRotate(e.initialPose.quaternion, [x, 0, z]);
  const p = e.initialPose.position;
  return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
}

/** Points around a rectangle footprint, `offset` outside it, about every `step` m. */
function perimeter(e: RuntimeEntity, offset: number, step: number): Float64Array {
  const hx = e.dims[0] / 2 + offset;
  const hz = e.dims[2] / 2 + offset;
  const pts: number[] = [];
  const nx = Math.max(1, Math.round((2 * hx) / step));
  const nz = Math.max(1, Math.round((2 * hz) / step));
  for (let i = 0; i <= nx; i++) {
    const x = -hx + (2 * hx * i) / nx;
    for (const z of [-hz, hz]) {
      const w = worldOf(e, x, z);
      pts.push(w[0], w[2]);
    }
  }
  for (let i = 1; i < nz; i++) {
    const z = -hz + (2 * hz * i) / nz;
    for (const x of [-hx, hx]) {
      const w = worldOf(e, x, z);
      pts.push(w[0], w[2]);
    }
  }
  return Float64Array.from(pts);
}

/** Points along the local x axis (roads, walls), `side` m off the axis along local z. */
function along(e: RuntimeEntity, side: number, step: number): Float64Array {
  const L = e.dims[0];
  const n = Math.max(1, Math.round(L / step));
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const w = worldOf(e, -L / 2 + (L * i) / n, side);
    pts.push(w[0], w[2]);
  }
  return Float64Array.from(pts);
}

/** ±35 % capacity scatter per component (object seed + component id; independent of the sim RNG). */
function componentScatter(e: RuntimeEntity): Float64Array {
  const out = new Float64Array(e.components.length);
  e.components.forEach((c, i) => {
    const r = seededRandom((e.source.seed ^ hashString(`flood.${c.spec.id}`)) >>> 0)();
    out[i] = 0.65 + 0.7 * r;
  });
  return out;
}

export function ensureFloodRuntime(rt: SimulationRuntime): FloodRuntime {
  if (rt.flood) return rt.flood;
  const entities: RuntimeEntity[] = [];
  const byId = new Map<EntityId, RuntimeEntity>();
  for (const e of rt.entities.values()) {
    const type = e.source.type;
    if (e.def.inert && type !== 'road') continue;
    const st = createState();
    if (type === 'building') {
      st.points = perimeter(e, 0.8, 2);
      st.scatter = componentScatter(e);
    } else if (type === 'road') {
      st.points = along(e, 0, 3);
    } else if (type === 'wall') {
      const n = qRotate(e.initialPose.quaternion, [0, 0, 1]);
      const h = Math.hypot(n[0], n[2]) || 1;
      st.normal = [n[0] / h, n[2] / h];
      // Two rows of points 0.9 m in front of / behind the wall.
      const a = along(e, 0.9 + e.dims[2] / 2, 2);
      const b = along(e, -0.9 - e.dims[2] / 2, 2);
      const pts = new Float64Array(a.length + b.length);
      pts.set(a);
      pts.set(b, a.length);
      st.points = pts;
    }
    e.flood = st;
    entities.push(e);
    byId.set(e.id, e);
  }
  rt.flood = { entities, byId };
  return rt.flood;
}

/** Hazard to blame for a push / overturn of a free body (flood when the water dominated). */
export function pushHazard(e: RuntimeEntity): 'flood' | undefined {
  return e.flood && e.flood.dominant ? 'flood' : undefined;
}
