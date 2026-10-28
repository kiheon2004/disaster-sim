/**
 * Flood event defaults and assumptions (Phase 14). Like resolveEarthquake: whatever a spec
 * leaves out is filled with a documented default and listed as an assumption, so the command
 * preview and the form show exactly what will be simulated.
 */
import type { BoundarySide, TerrainData, WaterSettings } from '@/core/model';
import { defaultWaterSettings } from '@/core/model';
import type { I18nMessage } from '@/i18n/i18n';
import type { RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec } from '../specs';
import { edgeBedRange, resolveBoundary } from '@/simulation/water/WaterForcing';

export const FLOOD_LIMITS = {
  rainIntensity: [0.1, 500] as [number, number], // mm/h
  duration: [1, 6 * 3600] as [number, number], // s
  level: [-30, 60] as [number, number], // m (surface elevation)
  riseRate: [0.01, 10] as [number, number], // m/min
  sourceRate: [0.001, 200] as [number, number], // m³/s
  radius: [0.5, 100] as [number, number], // m
};

export const DEFAULT_RISE_RATE = 0.5; // m/min
export const DEFAULT_HOLD = 180; // s after reaching the level
export const DEFAULT_SOURCE_RADIUS = 2; // m

export interface ResolvedRisingWater {
  boundary: BoundarySide;
  level: number;
  riseRate: number;
  duration: number;
  /** Estimated level at the edge before the event (current fixed level or lowest edge ground). */
  startLevel: number;
  /** Seconds to reach the target from startLevel. */
  riseTime: number;
  /** Lowest / highest ground along the edge (m) — the deepest water at the edge = level − lowest. */
  edgeGround: [number, number];
  assumptions: I18nMessage[];
}

/** Level of an edge before a rising-water event: its fixed level, or the lowest edge ground. */
export function edgeStartLevel(t: TerrainData, side: BoundarySide, water: WaterSettings = defaultWaterSettings()): number {
  const b = resolveBoundary(water.boundaries[side], side, t);
  const [lo] = edgeBedRange(t, side);
  return b.type === 'fixedLevel' ? Math.max(b.level, lo) : lo;
}

export function resolveRisingWater(spec: RisingWaterEventSpec, terrain: TerrainData | null, water?: WaterSettings): ResolvedRisingWater {
  const assumptions: I18nMessage[] = [];
  const riseRate = spec.riseRate ?? DEFAULT_RISE_RATE;
  if (spec.riseRate === undefined) assumptions.push({ key: 'flood.assume.riseRate', params: { rate: riseRate } });
  const edgeGround: [number, number] = terrain ? edgeBedRange(terrain, spec.boundary) : [0, 0];
  const startLevel = terrain ? edgeStartLevel(terrain, spec.boundary, water) : 0;
  const riseTime = (Math.abs(spec.level - startLevel) / riseRate) * 60;
  const duration = spec.duration ?? Math.max(30, Math.round(riseTime + DEFAULT_HOLD));
  if (spec.duration === undefined) assumptions.push({ key: 'flood.assume.duration', params: { s: duration, hold: DEFAULT_HOLD } });
  assumptions.push({ key: 'flood.assume.levelDatum', params: { level: spec.level.toFixed(2), ground: edgeGround[0].toFixed(2), depth: Math.max(0, spec.level - edgeGround[0]).toFixed(2) } });
  return { boundary: spec.boundary, level: spec.level, riseRate, duration, startLevel, riseTime, edgeGround, assumptions };
}

export function rainAssumptions(spec: RainEventSpec): I18nMessage[] {
  const out: I18nMessage[] = [];
  if (!spec.area) out.push({ key: 'flood.assume.rainArea' });
  // Total depth for orientation: 80 mm/h for 30 min = 40 mm.
  out.push({ key: 'flood.assume.rainTotal', params: { mm: ((spec.intensity * spec.duration) / 3600).toFixed(1) } });
  return out;
}

export function sourceAssumptions(spec: WaterSourceEventSpec): I18nMessage[] {
  const out: I18nMessage[] = [];
  if (spec.radius === undefined) out.push({ key: 'flood.assume.sourceRadius', params: { r: DEFAULT_SOURCE_RADIUS } });
  out.push({ key: 'flood.assume.sourceTotal', params: { m3: Math.round(spec.rate * spec.duration) } });
  return out;
}
