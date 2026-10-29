/**
 * Projectile materials and the mass / density / diameter relation (Phase 23).
 *
 * Representative bulk densities (kg/m³) — class values, not measurements of a particular body:
 *   stony (ordinary chondrite)  3300, typical 3000–3500   (Britt & Consolmagno 2003, meteorite bulk densities)
 *   iron                        7800, typical 7300–7900   (iron meteorites, same compilation)
 *   icy / comet-like            1000, typical 500–1000    (ice-rich body; observed cometary nuclei are
 *                                                          porous, ~300–600, e.g. 67P ≈ 530 — below the
 *                                                          range the strength relation was fitted on)
 * Ablation coefficient σ (s²/m²) of the single-body entry model: fireball classes of Ceplecha et al.
 * (1998): type I (ordinary-chondrite-like) 0.014 s²/km², type IIIA (cometary) 0.10 s²/km². Irons have
 * no fireball class there; the type I value is used for them (labelled approximate).
 *
 * Bulk strength for atmospheric break-up: the empirical density–strength relation of Collins et al.
 * (2005, eq. 9): log10 Y = 2.107 + 0.0624·√ρ (Pa), established for 1000–8000 kg/m³.
 *
 * Thermodynamics of ice (sublimation, melting) is not modelled — an icy body is treated as a weak,
 * light solid with a larger ablation coefficient.
 */
import type { MessageKey } from '@/i18n/i18n';
import type { ImpactSpec, ProjectileMaterial } from './types';

export interface ProjectileClass {
  id: ProjectileMaterial;
  labelKey: MessageKey;
  density: number;
  densityRange: [number, number];
  /** Ablation coefficient σ (s²/m²). */
  ablation: number;
}

export const PROJECTILES: Record<ProjectileMaterial, ProjectileClass> = {
  stony: { id: 'stony', labelKey: 'impact.mat.stony', density: 3300, densityRange: [3000, 3500], ablation: 0.014e-6 },
  iron: { id: 'iron', labelKey: 'impact.mat.iron', density: 7800, densityRange: [7300, 7900], ablation: 0.014e-6 },
  icy: { id: 'icy', labelKey: 'impact.mat.icy', density: 1000, densityRange: [500, 1000], ablation: 0.1e-6 },
};

/** Collins et al. (2005) eq. 9: yield strength (Pa) from bulk density (kg/m³). */
export function yieldStrength(density: number): number {
  return 10 ** (2.107 + 0.0624 * Math.sqrt(density));
}

/** Mass of a sphere of diameter L and density ρ. */
export const sphereMass = (L: number, rho: number) => (Math.PI / 6) * L * L * L * rho;
/** Diameter of a sphere of mass m and density ρ. */
export const sphereDiameter = (m: number, rho: number) => Math.cbrt((6 * m) / (Math.PI * rho));

export interface ResolvedProjectile {
  material: ProjectileMaterial;
  density: number;
  diameter: number;
  mass: number;
  strength: number;
  ablation: number;
  /** Problems found (never corrected silently). */
  issues: { key: MessageKey; params?: Record<string, string | number> }[];
}

/** Density, mass and strength of a spec; a mass that contradicts diameter × density is an issue. */
export function resolveProjectile(spec: ImpactSpec): ResolvedProjectile {
  const cls = PROJECTILES[spec.material];
  const density = spec.density ?? cls.density;
  const sphere = sphereMass(spec.diameter, density);
  const issues: ResolvedProjectile['issues'] = [];
  if (spec.mass !== undefined && Math.abs(spec.mass - sphere) > 0.01 * sphere) {
    issues.push({ key: 'impact.issue.mass', params: { m: spec.mass.toExponential(2), sphere: sphere.toExponential(2) } });
  }
  if (density < cls.densityRange[0] || density > cls.densityRange[1]) issues.push({ key: 'impact.issue.density', params: { rho: density, lo: cls.densityRange[0], hi: cls.densityRange[1] } });
  if (density < 1000 || density > 8000) issues.push({ key: 'impact.issue.strengthRange', params: { rho: density } });
  return { material: spec.material, density, diameter: spec.diameter, mass: sphere, strength: yieldStrength(density), ablation: cls.ablation, issues };
}
