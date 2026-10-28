/**
 * Approximate seismic properties of structures (Phase 13). The numbers give plausible
 * RELATIVE behavior and are loosely based on public simplified methods (code-style period
 * formulas T = Ct·Hˣ, capacity-curve style yield strengths and drift-based damage thresholds
 * of loss-estimation methods). They are not a structural assessment of any real building.
 */
import type { FoundationSpec, FoundationType, SeismicProperties, StructuralSpec, StructuralSystem, WorldObject } from '@/core/model';
import type { ObjectType } from '@/core/types';

export interface DriftThresholds {
  /** Inter-story drift ratios (rad) of the damage states. */
  slight: number;
  moderate: number;
  extensive: number;
  complete: number;
}

export interface SystemProps {
  /** Period formula T = ct · H^x (H in m). */
  ct: number;
  x: number;
  /** Yield base-shear coefficient (× weight) incl. typical overstrength. */
  cy: number;
  /** Post-yield stiffness ratio. */
  hardening: number;
  drift: DriftThresholds;
  damping: number;
}

export const STRUCTURAL_SYSTEMS: Record<StructuralSystem, SystemProps> = {
  rcFrame: { ct: 0.0466, x: 0.9, cy: 0.25, hardening: 0.05, damping: 0.05, drift: { slight: 0.004, moderate: 0.007, extensive: 0.016, complete: 0.035 } },
  steelFrame: { ct: 0.0724, x: 0.8, cy: 0.18, hardening: 0.06, damping: 0.03, drift: { slight: 0.005, moderate: 0.009, extensive: 0.022, complete: 0.05 } },
  masonry: { ct: 0.0488, x: 0.75, cy: 0.12, hardening: 0.02, damping: 0.06, drift: { slight: 0.002, moderate: 0.005, extensive: 0.012, complete: 0.025 } },
  wood: { ct: 0.0488, x: 0.75, cy: 0.3, hardening: 0.06, damping: 0.07, drift: { slight: 0.005, moderate: 0.012, extensive: 0.03, complete: 0.07 } },
};

/**
 * Drift at which the damage index reaches 1 (collapse capacity): beyond the "complete"
 * damage-state threshold, which in loss-estimation methods still means only a partial
 * probability of collapse.
 */
export const COLLAPSE_FACTOR = 1.4;

export function collapseDrift(system: StructuralSystem): number {
  return STRUCTURAL_SYSTEMS[system].drift.complete * COLLAPSE_FACTOR;
}

export const STRUCTURAL_SYSTEM_IDS = Object.keys(STRUCTURAL_SYSTEMS) as StructuralSystem[];

export interface FoundationTypeProps {
  /** Foundation mass as a fraction of the superstructure mass. */
  massFraction: number;
  /** Multiplier on the elastic half-space spring (embedment, piles). */
  stiffnessFactor: number;
  /** Default lateral resistance (× weight) before slip. */
  anchorage: number;
  /** Multiplier on the soil's bearing capacity (piles reach firmer strata). */
  bearingFactor: number;
}

export const FOUNDATION_TYPES: Record<FoundationType, FoundationTypeProps> = {
  spread: { massFraction: 0.2, stiffnessFactor: 0.8, anchorage: 0.55, bearingFactor: 1 },
  mat: { massFraction: 0.35, stiffnessFactor: 1, anchorage: 0.7, bearingFactor: 1.3 },
  pile: { massFraction: 0.3, stiffnessFactor: 1.6, anchorage: 1.2, bearingFactor: 2.5 },
};

export const FOUNDATION_TYPE_IDS = Object.keys(FOUNDATION_TYPES) as FoundationType[];

export function defaultStructure(system: StructuralSystem = 'rcFrame'): StructuralSpec {
  return { system, dampingRatio: STRUCTURAL_SYSTEMS[system].damping, stiffnessFactor: 1, strengthFactor: 1, periodOverride: 0 };
}

export function defaultFoundation(type: FoundationType = 'mat'): FoundationSpec {
  return { type, stiffness: 1, damping: 0, anchorage: FOUNDATION_TYPES[type].anchorage, groundContact: 1, failureThreshold: 2 };
}

/** Seismic properties stored on new objects of a type (buildings only; others use type defaults). */
export function defaultSeismic(type: ObjectType): SeismicProperties | undefined {
  if (type !== 'building') return undefined;
  return { structure: defaultStructure(), foundation: defaultFoundation() };
}

/** Normalize possibly partial / out-of-range stored values (load path, inspector). */
export function normalizeSeismic(type: ObjectType, s: Partial<{ structure: Partial<StructuralSpec>; foundation: Partial<FoundationSpec> }> | undefined): SeismicProperties | undefined {
  const base = defaultSeismic(type);
  if (!base) return undefined;
  const sys = s?.structure?.system && s.structure.system in STRUCTURAL_SYSTEMS ? s.structure.system : base.structure.system;
  const ft = s?.foundation?.type && s.foundation.type in FOUNDATION_TYPES ? s.foundation.type : base.foundation.type;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const st = defaultStructure(sys);
  const fd = defaultFoundation(ft);
  return {
    structure: {
      system: sys,
      dampingRatio: num(s?.structure?.dampingRatio, st.dampingRatio, 0.005, 0.3),
      stiffnessFactor: num(s?.structure?.stiffnessFactor, 1, 0.1, 10),
      strengthFactor: num(s?.structure?.strengthFactor, 1, 0.1, 10),
      periodOverride: num(s?.structure?.periodOverride, 0, 0, 10),
    },
    foundation: {
      type: ft,
      stiffness: num(s?.foundation?.stiffness, 1, 0.05, 20),
      damping: num(s?.foundation?.damping, 0, 0, 0.5),
      anchorage: num(s?.foundation?.anchorage, fd.anchorage, 0.05, 5),
      groundContact: num(s?.foundation?.groundContact, 1, 0.2, 1),
      failureThreshold: num(s?.foundation?.failureThreshold, 2, 0.1, 20),
    },
  };
}

/** Seismic properties of an object (stored or defaults). */
export function seismicOf(o: Pick<WorldObject, 'type' | 'seismic'>): SeismicProperties | undefined {
  return o.seismic ?? defaultSeismic(o.type);
}

/** Fundamental period (s) of a structure of total height H (m), before soil–structure interaction. */
export function naturalPeriod(s: StructuralSpec, height: number): number {
  if (s.periodOverride > 0) return s.periodOverride;
  const p = STRUCTURAL_SYSTEMS[s.system];
  return (p.ct * Math.pow(Math.max(2, height), p.x)) / Math.sqrt(Math.max(0.05, s.stiffnessFactor));
}

/**
 * Anchored infrastructure as single-degree-of-freedom cantilevers (approximate):
 * period, damping, yield coefficient along local x / z, and ultimate drift.
 */
export interface InfraProps {
  period: number;
  damping: number;
  cyX: number;
  cyZ: number;
  driftU: number;
  /** Peak top acceleration (g) an attachment (lamp head, panel) survives. */
  attachmentCapacity: number;
}

export function infraProps(type: ObjectType, dims: [number, number, number]): InfraProps | null {
  switch (type) {
    case 'streetLight':
      // Slender steel poles stay elastic over large drifts.
      return { period: 0.8, damping: 0.02, cyX: 0.8, cyZ: 0.8, driftU: 0.15, attachmentCapacity: 1.6 };
    case 'sign':
      return { period: 0.45, damping: 0.03, cyX: 0.45, cyZ: 0.45, driftU: 0.07, attachmentCapacity: 1.1 };
    case 'wall': {
      // Free-standing masonry: rigid-block overturning ≈ g·t/h, plus some mortar tension.
      const slender = dims[2] / Math.max(0.3, dims[1]);
      const out = Math.min(0.8, slender * 2.5);
      return { period: 0.1, damping: 0.05, cyX: out * 8, cyZ: out, driftU: 0.012, attachmentCapacity: Infinity };
    }
    default:
      return null;
  }
}
