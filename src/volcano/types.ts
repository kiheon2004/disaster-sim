/**
 * Volcano scenario spec (Phase 28) — saved in the experiment plan (schema v7, validated per instance).
 *
 * A LOCAL eruption on the 200 m world: one or more vents (a central vent = a disc, a fissure = a line
 * segment with a width) supply lava at a bulk volume rate following a time profile, at an eruption
 * temperature. Optional shares of the erupted mass leave the vent as ballistic bombs / spatter (they fly
 * and land hot) and as ash (lofted to a small plume height, carried by the wind, settling). Nothing
 * here models a magma reservoir, conduit pressure or crustal failure: the supply is PRESCRIBED.
 */
import type { ProfileSpec } from '@/thermal/profiles';
import type { LavaMaterialId } from './materials';

export type VentKind = 'central' | 'fissure';
export const VENT_KINDS: readonly VentKind[] = ['central', 'fissure'];

export interface VentSpec {
  kind: VentKind;
  /** World [x, z] (m): centre of a central vent, first end of a fissure. */
  position: [number, number];
  /** Fissure: second end (m). */
  end?: [number, number];
  /** Central vent radius / fissure half-width (m). */
  radius: number;
  /** Share of the eruption's supply (weights, normalized over the vents; default equal). */
  share?: number;
}

/** Eruption time profiles: Phase 26 profile shapes plus staged levels and a scheduled stop with a decline. */
export type EruptionProfile = 'constant' | 'ramp' | 'pulse' | 'staged' | 'wane';
export const ERUPTION_PROFILES: readonly EruptionProfile[] = ['constant', 'ramp', 'pulse', 'staged', 'wane'];

export interface VolcanoSpec {
  event: 'volcano';
  vents: VentSpec[];
  material: LavaMaterialId;
  /** Eruption temperature (°C). */
  temperature: number;
  /** Peak bulk lava supply (m³/s of vesicular lava at the material's bulk density). */
  rate: number;
  /** Eruption duration (s). */
  duration: number;
  profile: EruptionProfile;
  /** ramp: time to reach the peak (s). */
  rampTime?: number;
  /** pulse: period and active part (s). */
  period?: number;
  pulseWidth?: number;
  /** staged: relative levels of equal-length stages (0–1, at least one 1 is not required). */
  stages?: number[];
  /** wane: length of the linear decline before the scheduled stop (s). */
  declineTime?: number;
  /** Share of the erupted mass thrown out as ballistic bombs / spatter (0–0.3). */
  bombFraction?: number;
  /** Share fragmented into ash and lofted (0–0.3). */
  ashFraction?: number;
  /** Height the ash is released at above the vent (m). */
  plumeHeight?: number;
  /** Absolute simulation time to start at (default: now). */
  startTime?: number;
  name?: string;
}

export const VOLCANO_LIMITS = {
  radius: [0.5, 10],
  fissureLength: [2, 120],
  rate: [0.01, 20],
  duration: [10, 21600],
  rampTime: [1, 21600],
  bombFraction: [0, 0.3],
  ashFraction: [0, 0.3],
  plumeHeight: [10, 300],
  vents: [1, 6],
  stages: [2, 8],
} as const;

export const DEFAULT_PLUME_HEIGHT = 60;
/** Magmatic gas released per kg of erupted magma (kg/kg) — ledger only (no transport or chemistry). */
export const GAS_FRACTION = 0.005;

/** The spec's time profile as a Phase 26 profile where one exists (exact integrals reused). */
export function profileOf(s: VolcanoSpec): ProfileSpec | null {
  switch (s.profile) {
    case 'constant': return { profile: 'constant', duration: s.duration };
    case 'ramp': return { profile: 'ramp', duration: s.duration, rampTime: s.rampTime ?? s.duration / 4 };
    case 'pulse': return { profile: 'pulse', duration: s.duration, period: s.period ?? 60, pulseWidth: s.pulseWidth ?? 20 };
    default: return null;
  }
}

/** Problems of a spec as i18n keys (empty = valid). */
export function volcanoIssues(s: VolcanoSpec, materials: readonly string[] = ['basalt', 'andesite'], Trange?: (m: string) => [number, number]): string[] {
  const out: string[] = [];
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const inRange = (v: number | undefined, [lo, hi]: readonly [number, number]) => fin(v) && v >= lo && v <= hi;
  if (!Array.isArray(s.vents) || s.vents.length < VOLCANO_LIMITS.vents[0] || s.vents.length > VOLCANO_LIMITS.vents[1]) out.push('volcano.invalid.vents');
  else for (const v of s.vents) {
    if (!v || !Array.isArray(v.position) || !fin(v.position[0]) || !fin(v.position[1])) { out.push('volcano.invalid.position'); break; }
    if (!inRange(v.radius, VOLCANO_LIMITS.radius)) { out.push('volcano.invalid.radius'); break; }
    if (v.kind === 'fissure') {
      if (!v.end || !fin(v.end[0]) || !fin(v.end[1])) { out.push('volcano.invalid.fissure'); break; }
      const L = Math.hypot(v.end[0] - v.position[0], v.end[1] - v.position[1]);
      if (!inRange(L, VOLCANO_LIMITS.fissureLength)) { out.push('volcano.invalid.fissure'); break; }
    } else if (v.kind !== 'central') { out.push('volcano.invalid.vents'); break; }
    if (v.share !== undefined && !(fin(v.share) && v.share > 0)) { out.push('volcano.invalid.share'); break; }
  }
  if (!materials.includes(s.material)) out.push('volcano.invalid.material');
  else if (Trange) { const [lo, hi] = Trange(s.material); if (!inRange(s.temperature, [lo, hi])) out.push('volcano.invalid.temperature'); }
  if (!inRange(s.rate, VOLCANO_LIMITS.rate)) out.push('volcano.invalid.rate');
  if (!inRange(s.duration, VOLCANO_LIMITS.duration)) out.push('volcano.invalid.duration');
  if (!ERUPTION_PROFILES.includes(s.profile)) out.push('volcano.invalid.profile');
  if (s.profile === 'ramp' && s.rampTime !== undefined && !(inRange(s.rampTime, VOLCANO_LIMITS.rampTime) && s.rampTime <= s.duration)) out.push('volcano.invalid.ramp');
  if (s.profile === 'pulse') {
    const P = s.period ?? 60, w = s.pulseWidth ?? 20;
    if (!(fin(P) && P > 0 && P <= s.duration)) out.push('volcano.invalid.period');
    if (!(fin(w) && w > 0 && w < P)) out.push('volcano.invalid.pulseWidth');
  }
  if (s.profile === 'staged') {
    const st = s.stages ?? [];
    if (st.length < VOLCANO_LIMITS.stages[0] || st.length > VOLCANO_LIMITS.stages[1] || !st.every((v) => fin(v) && v >= 0 && v <= 1) || !st.some((v) => v > 0)) out.push('volcano.invalid.stages');
  }
  if (s.profile === 'wane' && s.declineTime !== undefined && !(fin(s.declineTime) && s.declineTime > 0 && s.declineTime <= s.duration)) out.push('volcano.invalid.decline');
  if (s.bombFraction !== undefined && !inRange(s.bombFraction, VOLCANO_LIMITS.bombFraction)) out.push('volcano.invalid.bombs');
  if (s.ashFraction !== undefined && !inRange(s.ashFraction, VOLCANO_LIMITS.ashFraction)) out.push('volcano.invalid.ash');
  if ((s.bombFraction ?? 0) + (s.ashFraction ?? 0) > 0.5) out.push('volcano.invalid.fractions');
  if (s.plumeHeight !== undefined && !inRange(s.plumeHeight, VOLCANO_LIMITS.plumeHeight)) out.push('volcano.invalid.plume');
  return out;
}
