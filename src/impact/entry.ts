/**
 * Atmospheric entry (Phase 23) — a separate calculation stage: the 200 m world cannot hold the
 * 100 km of atmosphere, so the descent from the top of the atmosphere to the ground is integrated
 * here along the straight entry path and only its END STATE (speed, mass, dispersion, time)
 * reaches the world.
 *
 * Model (Collins, Melosh & Marcus 2005, "Earth Impact Effects Program", §Atmospheric entry), with
 * the analytic approximations replaced by direct numerical integration (RK4):
 *   atmosphere      ρ(z) = ρ0·exp(−z/H), H = 8 km (eq. 5), ρ0 = 1.225 kg/m³ (the simulation's
 *                   sea-level air; Collins et al. use 1 kg/m³)
 *   drag            dv/dt = −C_D·ρ·A·v² / (2m) + g·sinθ,  C_D = 2 (eq. 6 form; gravity along the path
 *                   is included so small bodies tend to their terminal speed, which eq. 8 omits)
 *   ablation        dm/dt = −σ·C_D·ρ·A·v³ / 2 (single-body ablation equation, σ from the projectile
 *                   class; Collins et al. neglect ablation — included here, labelled approximate)
 *   break-up        when the stagnation pressure ρ·v² exceeds the bulk strength Y (eq. 10)
 *   pancake         after break-up the swarm diameter L grows as d²L/dt² = C_D·ρ·v² / (ρ_i·L) (eq. 13)
 *                   and the drag area becomes π·L²/4
 *   airburst        when L reaches f_p·L0 above the ground, f_p = 7 (Collins et al.'s choice in the
 *                   2–10 range): the energy is deposited in the air, no crater forms (the blast is
 *                   not simulated in Phase 23 — reported for Phase 24)
 * The path is integrated in 2-D over a flat Earth: the flight-path angle γ below the horizontal
 * turns toward vertical under gravity, dγ/dt = g·cosγ / v — negligible for fast bodies (Collins
 * et al. keep a straight line), essential for small ones slowed to their terminal speed (they then
 * fall almost vertically). Curvature of the Earth is ignored. Not modelled: progressive fragmentation cascades, a mass / size
 * distribution of fragments (crater fields), lift, thermal radiation.
 */
import { GRAVITY } from '@/core/units';
import type { ResolvedProjectile } from './projectile';

export const ENTRY_ALTITUDE = 100_000;
export const SCALE_HEIGHT = 8000;
export const RHO0 = 1.225;
export const CD = 2;
export const PANCAKE_FACTOR = 7;
/** Altitude where the entry stage hands over to the world (m above the aim point). */
export const HANDOVER_ALTITUDE = 1500;

export const airDensity = (z: number) => RHO0 * Math.exp(-Math.max(0, z) / SCALE_HEIGHT);

export interface EntrySample {
  t: number;
  z: number;
  v: number;
  m: number;
  L: number;
}

export interface EntryResult {
  /** Time from the top of the atmosphere to the hand-over altitude (s). */
  time: number;
  /** State at the hand-over altitude: speed (m/s), mass (kg), swarm diameter (m), path angle below horizontal (deg). */
  speed: number;
  mass: number;
  diameter: number;
  angle: number;
  /** Horizontal distance travelled from the top of the atmosphere (m). */
  range: number;
  breakup: { altitude: number; time: number; pressure: number } | null;
  airburst: { altitude: number; time: number; energy: number } | null;
  /** The body ablated away before reaching the ground (no impact). */
  ablated: boolean;
  /** Fraction of the entry kinetic energy left at hand-over. */
  energyRetained: number;
  mass0: number;
  /** Time history (≈ every 0.1 s) for the timeline / HUD. */
  samples: EntrySample[];
}

interface State { x: number; z: number; v: number; g: number; m: number; L: number; dL: number }

/**
 * Integrate the entry of a projectile at speed v0 (m/s) and angle θ (deg above horizontal) from
 * ENTRY_ALTITUDE down to `stopAltitude` (m).
 */
export function integrateEntry(p: ResolvedProjectile, v0: number, angleDeg: number, stopAltitude = HANDOVER_ALTITUDE): EntryResult {
  const L0 = p.diameter, rhoI = p.density;
  let st: State = { x: 0, z: ENTRY_ALTITUDE, v: v0, g: (angleDeg * Math.PI) / 180, m: p.mass, L: L0, dL: 0 };
  let t = 0;
  let broken = false;
  let breakup: EntryResult['breakup'] = null;
  let airburst: EntryResult['airburst'] = null;
  let ablated = false;
  const samples: EntrySample[] = [];
  const deriv = (s: State): State => {
    const rho = airDensity(s.z);
    const A = (Math.PI / 4) * s.L * s.L;
    const v = Math.max(1e-3, s.v);
    const drag = (CD * rho * A * v * v) / (2 * Math.max(1e-12, s.m));
    return {
      x: v * Math.cos(s.g),
      z: -v * Math.sin(s.g),
      v: -drag + GRAVITY * Math.sin(s.g),
      g: (GRAVITY * Math.cos(s.g)) / v,
      m: -(p.ablation * CD * rho * A * v * v * v) / 2,
      L: broken ? s.dL : 0,
      dL: broken ? (CD * rho * v * v) / (rhoI * s.L) : 0,
    };
  };
  const add = (a: State, b: State, k: number): State => ({ x: a.x + b.x * k, z: a.z + b.z * k, v: Math.max(1e-3, a.v + b.v * k), g: Math.min(Math.PI / 2, a.g + b.g * k), m: Math.max(0, a.m + b.m * k), L: a.L + b.L * k, dL: a.dL + b.dL * k });
  const E0 = 0.5 * p.mass * v0 * v0;
  let lastSample = -Infinity;
  for (let guard = 0; guard < 5_000_000 && st.z > stopAltitude; guard++) {
    const d0 = deriv(st);
    // Step: resolve the scale height, the drag and ablation time scales (stiff for small / broken
    // bodies) and the pancake growth; land exactly on the stop altitude.
    let dt = Math.min(0.05, (0.002 * SCALE_HEIGHT) / Math.max(1, -d0.z));
    if (d0.v < 0) dt = Math.min(dt, (0.02 * st.v) / -d0.v);
    if (d0.m < 0) dt = Math.min(dt, (0.02 * st.m) / -d0.m);
    if (broken && st.dL > 0) dt = Math.min(dt, (0.01 * st.L) / st.dL);
    if (-d0.z > 0) dt = Math.min(dt, (st.z - stopAltitude) / -d0.z + 1e-9);
    dt = Math.max(dt, 1e-7);
    const k1 = d0, k2 = deriv(add(st, k1, dt / 2)), k3 = deriv(add(st, k2, dt / 2)), k4 = deriv(add(st, k3, dt));
    const comb = (f: keyof State) => (k1[f] + 2 * k2[f] + 2 * k3[f] + k4[f]) / 6;
    st = add(st, { x: comb('x'), z: comb('z'), v: comb('v'), g: comb('g'), m: comb('m'), L: comb('L'), dL: comb('dL') }, dt);
    t += dt;
    const pressure = airDensity(st.z) * st.v * st.v;
    if (!broken && pressure > p.strength) {
      broken = true;
      breakup = { altitude: st.z, time: t, pressure };
    }
    if (broken && st.L >= PANCAKE_FACTOR * L0) {
      airburst = { altitude: st.z, time: t, energy: 0.5 * st.m * st.v * st.v };
      break;
    }
    if (st.m <= 1e-6 * p.mass) { ablated = true; break; }
    if (t - lastSample >= 0.1 || st.z <= stopAltitude) {
      samples.push({ t, z: st.z, v: st.v, m: st.m, L: st.L });
      lastSample = t;
    }
  }
  const retained = E0 > 0 ? (0.5 * st.m * st.v * st.v) / E0 : 0;
  return {
    time: t, speed: st.v, mass: st.m, diameter: st.L, angle: (st.g * 180) / Math.PI, range: st.x,
    breakup, airburst, ablated, energyRetained: retained, mass0: p.mass, samples,
  };
}
