/**
 * Crater size and ejecta scaling (Phase 23): point-source (coupling-parameter) scaling of
 * Holsapple & Schmidt (1987), Holsapple (1993), with the parameter sets of Housen & Holsapple
 * (2011, "Ejecta from impact craters", Icarus 211; Table 3, as reproduced in the Ryugu ejecta study
 * of Tatsumi et al. — values C1–C8).
 *
 * Crater radius R at the pre-impact surface, projectile radius a, mass m, density δ, speed U,
 * target density ρ, strength Ȳ, gravity g, π2 = g·a/U², π3 = Ȳ/(ρU²):
 *   gravity regime   R·(ρ/m)^(1/3) = H1·(ρ/δ)^((2+μ−6ν)/(3(2+μ)))·π2^(−μ/(2+μ))
 *   strength regime  R·(ρ/m)^(1/3) = H2·(ρ/δ)^((1−3ν)/3)·π3^(−μ/2)
 * (both follow from R depending on the impactor only through the coupling parameter a·U^μ·δ^ν; they
 * reproduce exactly the ejecta-velocity forms quoted from HH11). Crater growth stops when either
 * gravity or strength stops it: R = min(R_gravity, R_strength), and the governing regime is reported.
 * Oblique impacts: U is the vertical component U·sinθ (Chapman & McKinnon 1986; Gault & Wedekind
 * 1978 — crater size follows the normal velocity component above ~15°; below 15° craters become
 * elongated, which is not modelled: a warning is shown).
 *
 * Ejecta (HH11):
 *   launch speed     v(x) = C1·U·[(x/a)·(ρ/δ)^ν]^(−1/μ)·(1 − x/(n2R))^p,   n1·a ≤ x ≤ n2·R
 *                    (equivalently, in the gravity regime v = C1·(H1·k)^(−(2+μ)/(2μ))·√(gR)·(x/R)^(−1/μ)…)
 *   ejected mass     M(<x) = k·ρ·(x³ − (n1·a)³)
 *   launch time      the crater radius grows as x ∝ t^(μ/(1+μ)) (point-source), so material at x
 *                    leaves at t(x) = μ/(1+μ)·x / v₀(x), v₀ = the launch speed without the rim factor
 * The ejected volume is capped by the excavated volume (the rest of the cavity volume is
 * displaced into the structural rim).
 *
 * Target classes (Phase 22 mechanical profiles → HH11 sets):
 *   rock            C2 "rock" (strength, Ȳ = 30 MPa)          — competent rock
 *   dense / loose granular  C4 "sand" (gravity, no strength)
 *   cohesive soil   C7 "sand/fly-ash" (strength, Ȳ = 4 kPa) — weakly cohesive soil
 *   fill            C8 "perlite/sand" (strength, Ȳ = 2 kPa) — weak, porous artificial ground
 * Strength sets also get a gravity limit from C4 (C1, the μ = 0.55 set, for rock): weak soils
 * cross into the gravity regime already at metre scale (Ȳ/(ρg) ≈ 0.2–0.3 m).
 * The target density is the profile's own (not the table's).
 *
 * Shape on the heightfield: a paraboloid transient bowl of depth R/√2 (D_tc = 2√2·d_tc, Collins et al.
 * 2005 Fig. 3 / eq. 25). There is no prescribed "final" crater: the Phase 22 wall-stability check
 * lets weak walls slump to their repose angle (sand), strong walls stand (rock).
 */
import type { MechanicalProfile } from '@/ground/materials';

export interface ScalingSet {
  id: string;
  mu: number;
  nu: number;
  k: number;
  C1: number;
  H1?: number;
  H2?: number;
  n1: number;
  n2: number;
  p: number;
  /** Strength Ȳ (Pa) for strength sets. */
  Y?: number;
}

const NU = 0.4;
const N1 = 1.2;
export const HH11: Record<string, ScalingSet> = {
  C1_water: { id: 'C1', mu: 0.55, nu: NU, k: 0.2, C1: 1.5, H1: 0.68, n1: N1, n2: 1.5, p: 0.5 },
  C2_rock: { id: 'C2', mu: 0.55, nu: NU, k: 0.3, C1: 1.5, H2: 1.1, n1: N1, n2: 1.0, p: 0.5, Y: 30e6 },
  C4_sand: { id: 'C4', mu: 0.41, nu: NU, k: 0.3, C1: 0.55, H1: 0.59, n1: N1, n2: 1.3, p: 0.3 },
  C7_sandFlyAsh: { id: 'C7', mu: 0.40, nu: NU, k: 0.3, C1: 0.55, H2: 0.4, n1: N1, n2: 1.0, p: 0.3, Y: 4e3 },
  C8_perliteSand: { id: 'C8', mu: 0.35, nu: NU, k: 0.32, C1: 0.6, H2: 0.81, n1: N1, n2: 1.0, p: 0.2, Y: 2e3 },
};

export interface TargetClass {
  strength?: ScalingSet;
  gravity: ScalingSet;
  labelKey: string;
}

export function targetClassOf(p: MechanicalProfile): TargetClass {
  switch (p.id) {
    case 'rock': return { strength: HH11.C2_rock, gravity: HH11.C1_water, labelKey: 'impact.target.rock' };
    case 'cohesive': return { strength: HH11.C7_sandFlyAsh, gravity: HH11.C4_sand, labelKey: 'impact.target.cohesive' };
    case 'fill': return { strength: HH11.C8_perliteSand, gravity: HH11.C4_sand, labelKey: 'impact.target.fill' };
    default: return { gravity: HH11.C4_sand, labelKey: 'impact.target.sand' };
  }
}

export interface CraterInput {
  /** Projectile mass (kg), density (kg/m³), speed (m/s), angle above horizontal (deg). */
  mass: number;
  density: number;
  speed: number;
  angle: number;
  /** Target profile and gravity. */
  target: MechanicalProfile;
  g: number;
}

export interface CraterResult {
  regime: 'gravity' | 'strength';
  set: ScalingSet;
  /** Apparent radius at the pre-impact surface (m), transient depth (m), bowl volume (m³). */
  radius: number;
  depth: number;
  volume: number;
  /** Radii each regime would allow (m; Infinity = no limit). */
  radiusGravity: number;
  radiusStrength: number;
  /** Projectile radius (m) and the vertical speed used (m/s). */
  a: number;
  U: number;
  /** Ejected volume in place (m³) and its share of the bowl; displaced (rim) volume. */
  ejectedVolume: number;
  displacedVolume: number;
  ejectaCapped: boolean;
  /** Time for the crater to reach R (s): last ejecta launch near the rim. */
  formationTime: number;
  /** π2, π3 for the record. */
  pi2: number;
  pi3: number;
  oblique: boolean;
}

/** Crater radius in a regime (m). */
export function scaledRadius(set: ScalingSet, regime: 'gravity' | 'strength', m: number, a: number, delta: number, rho: number, U: number, g: number): number {
  const k = Math.cbrt(m / rho);
  const r = rho / delta;
  if (regime === 'gravity') {
    if (set.H1 === undefined) return Infinity;
    const pi2 = (g * a) / (U * U);
    return set.H1 * k * r ** ((2 + set.mu - 6 * set.nu) / (3 * (2 + set.mu))) * pi2 ** (-set.mu / (2 + set.mu));
  }
  if (set.H2 === undefined || set.Y === undefined) return Infinity;
  const pi3 = set.Y / (rho * U * U);
  return set.H2 * k * r ** ((1 - 3 * set.nu) / 3) * pi3 ** (-set.mu / 2);
}

/** Launch speed (m/s) at radius x (HH11); `rim = false` drops the (1 − x/n2R)^p factor. */
export function launchSpeed(set: ScalingSet, x: number, a: number, U: number, rho: number, delta: number, R: number, rim = true): number {
  const base = set.C1 * U * ((x / a) * (rho / delta) ** set.nu) ** (-1 / set.mu);
  if (!rim) return base;
  const f = 1 - x / (set.n2 * R);
  return f <= 0 ? 0 : base * f ** set.p;
}

/** Ejected mass from inside x (kg), HH11. */
export const ejectedMass = (set: ScalingSet, x: number, a: number, rho: number) => set.k * rho * Math.max(0, x * x * x - (set.n1 * a) ** 3);

export function computeCrater(i: CraterInput): CraterResult {
  const a = Math.cbrt((3 * i.mass) / (4 * Math.PI * i.density));
  const sin = Math.sin((i.angle * Math.PI) / 180);
  const U = i.speed * sin;
  const rho = i.target.density;
  const cls = targetClassOf(i.target);
  const Rg = scaledRadius(cls.gravity, 'gravity', i.mass, a, i.density, rho, U, i.g);
  const Rs = cls.strength ? scaledRadius(cls.strength, 'strength', i.mass, a, i.density, rho, U, i.g) : Infinity;
  const regime = Rs < Rg ? 'strength' : 'gravity';
  const set = regime === 'strength' ? cls.strength! : cls.gravity;
  const R = Math.min(Rg, Rs);
  const depth = R / Math.SQRT2;
  const volume = (Math.PI * R * R * depth) / 2;
  // Ejecta launched from inside min(n2, 1)·R (the excavated bowl).
  const xMax = Math.min(set.n2, 1) * R;
  let ejected = ejectedMass(set, xMax, a, rho) / rho;
  const capped = ejected > volume;
  if (capped) ejected = volume;
  const alpha = set.mu / (1 + set.mu);
  const formationTime = (alpha * R) / Math.max(1e-6, launchSpeed(set, R, a, U, rho, i.density, R, false));
  return {
    regime, set, radius: R, depth, volume, radiusGravity: Rg, radiusStrength: Rs, a, U,
    ejectedVolume: ejected, displacedVolume: volume - ejected, ejectaCapped: capped, formationTime,
    pi2: (i.g * a) / (U * U), pi3: set.Y ? set.Y / (rho * U * U) : 0,
    oblique: i.angle < 15,
  };
}
