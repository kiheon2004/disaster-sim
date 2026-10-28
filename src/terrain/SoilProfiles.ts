/**
 * SoilProfileRegistry: what lies BENEATH a terrain vertex (Phase 13). Kept separate from the
 * surface material (GroundMaterials: grass, asphalt …) — an asphalt road can sit on rock or on
 * reclaimed fill.
 *
 * Every number is an APPROXIMATE SIMULATION PARAMETER chosen for plausible relative behavior
 * (soft soil amplifies and lengthens shaking, rock does not), loosely inspired by site classes
 * (Vs30 ranges) — not site-specific geotechnical data. The UI labels them that way.
 *
 *  - amplification:     site factor on the ground-motion amplitude relative to the reference
 *                       site (dense soil = 1.0, so a user PGA means "PGA on dense soil")
 *  - vs30:              shear-wave velocity (m/s) → soil stiffness G = ρ·Vs² (foundation springs)
 *  - siteFrequency:     fundamental frequency of the soil column (Hz) → resonance band
 *  - resonance:         extra amplification at the site frequency (0 = none)
 *  - damping:           soil damping ratio (width of the resonance, foundation radiation damping)
 *  - bearingCapacity:   allowable bearing pressure (kPa) → foundation rocking / tilt
 *  - liquefactionSusceptibility: 0–1, RESERVED. No liquefaction model is implemented (an
 *                       unvalidated one would be misleading); see LiquefactionModel.ts.
 */
import type { SoilProfileId } from '@/core/model';
import type { MessageKey } from '@/i18n/i18n';

export interface SoilProfile {
  id: SoilProfileId;
  key: 'rock' | 'denseSoil' | 'softSoil' | 'reclaimed';
  labelKey: MessageKey;
  color: string;
  amplification: number;
  vs30: number;
  siteFrequency: number;
  resonance: number;
  damping: number;
  bearingCapacity: number;
  /** Soil density (kg/m³). */
  density: number;
  liquefactionSusceptibility: number;
}

export const SOIL_PROFILES: readonly SoilProfile[] = [
  { id: 0, key: 'rock', labelKey: 'soil.rock', color: '#8d8a86', amplification: 0.8, vs30: 900, siteFrequency: 8, resonance: 0.05, damping: 0.02, bearingCapacity: 3000, density: 2300, liquefactionSusceptibility: 0 },
  { id: 1, key: 'denseSoil', labelKey: 'soil.denseSoil', color: '#a8865a', amplification: 1.0, vs30: 450, siteFrequency: 4, resonance: 0.3, damping: 0.05, bearingCapacity: 400, density: 2000, liquefactionSusceptibility: 0.1 },
  { id: 2, key: 'softSoil', labelKey: 'soil.softSoil', color: '#c9b067', amplification: 1.35, vs30: 200, siteFrequency: 1.6, resonance: 0.45, damping: 0.08, bearingCapacity: 120, density: 1800, liquefactionSusceptibility: 0.45 },
  { id: 3, key: 'reclaimed', labelKey: 'soil.reclaimed', color: '#6a9bb3', amplification: 1.6, vs30: 150, siteFrequency: 1.1, resonance: 0.5, damping: 0.1, bearingCapacity: 80, density: 1750, liquefactionSusceptibility: 0.8 },
];

/** Reference site of the ground-motion intensity input. */
export const DEFAULT_SOIL: SoilProfileId = 1;
export const SOIL_COUNT = SOIL_PROFILES.length;

export function soilProfile(id: number): SoilProfile {
  return SOIL_PROFILES[id] ?? SOIL_PROFILES[DEFAULT_SOIL];
}

/** Shear modulus G = ρ·Vs² (Pa). */
export function shearModulus(s: SoilProfile): number {
  return s.density * s.vs30 * s.vs30;
}

/**
 * Frequency-dependent site transfer |H(f)|: base amplification times a log-normal resonance
 * bump around the soil column frequency (width grows with soil damping). Approximate.
 */
export function siteTransfer(s: SoilProfile, f: number): number {
  const sigma = 0.3 + 2 * s.damping;
  const x = Math.log(f / s.siteFrequency) / sigma;
  return s.amplification * (1 + s.resonance * Math.exp(-0.5 * x * x));
}
