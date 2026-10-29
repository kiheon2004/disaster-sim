/**
 * Thermal effects on structural members (Phase 26) — pure relations used by the simulation adapter.
 *
 *  Strength / stiffness   the code reduction factors of the member's material (materials.ts) at the
 *                         temperature of each node, averaged over the section by the nodes' mass
 *                         shares (a two-zone version of the EN 1992-1-2 Annex B zone method):
 *                           columns / bearing walls  axial: min(k_axial·N_crush, k_E·N_buckle)/min(N_crush, N_buckle)
 *                           beams / slabs / roofs    bending: k_bending (RC: reinforcement at the skin temperature,
 *                                                     the skin node standing for the cover zone)
 *                         Concrete and timber keep the loss of the hottest state reached (no recovery
 *                         on cooling); steel follows its current temperature.
 *  Thermal strain         ε_th(T_mean) − ε_th(T_ref) of the material relation (free expansion ΔL = ε·L)
 *  Restrained expansion   N_th = r·E(T)·A·ε_th, r = K_s/(K_s + K_m): the member's axial stiffness
 *                         K_m = E(T)·A/L in series with the stiffness K_s of what restrains it — linear
 *                         elastic, uniaxial; free members (r = 0) get no stress. Compression positive.
 *  Thermal bowing         κ = α_eff·(T_skin − T_core)/(d/2) — a curvature of the free member (shown, not
 *                         a load: restrained bending moments are not computed)
 * No multi-axial stress state, creep, transient strain or spalling is computed.
 */
import { THERMAL_MATERIALS } from './materials';

export interface NodeTemps {
  /** Skin / core temperature (K) and the hottest each reached. */
  Ts: number;
  Tc: number;
  TmaxS: number;
  TmaxC: number;
  /** Mass share of the skin node (0–1; 1 = lumped). */
  wS: number;
}

export interface StrengthState {
  axial: number;
  bending: number;
  stiffness: number;
}

/** Section-averaged reduction factors of a member (1 = room temperature). */
export function sectionFactors(mat: number, t: NodeTemps): StrengthState {
  const m = THERMAL_MATERIALS[mat];
  const s = m.strength;
  if (!s) return { axial: 1, bending: 1, stiffness: 1 };
  const TS = (s.reversible ? t.Ts : t.TmaxS) - 273.15;
  const TC = (s.reversible ? t.Tc : t.TmaxC) - 273.15;
  const w = t.wS, v = 1 - w;
  // Stiffness follows the current temperature (it recovers elastically).
  const tsE = t.Ts - 273.15, tcE = t.Tc - 273.15;
  return {
    axial: w * s.axial(TS) + v * s.axial(TC),
    // The tension zone of a bent member is at the surface: its strength governs (RC: reinforcement at cover).
    bending: s.bending(TS),
    stiffness: w * s.stiffness(tsE) + v * s.stiffness(tcE),
  };
}

/** Capacity factor of a vertical member from its crushing and buckling capacities (N). */
export function columnFactor(f: StrengthState, crush: number, buckle: number): number {
  const base = Math.min(crush, buckle);
  return base > 0 ? Math.min(f.axial * crush, f.stiffness * buckle) / base : 1;
}

/** Mean temperature of a two-node member (K). */
export const meanTemp = (t: NodeTemps) => t.wS * t.Ts + (1 - t.wS) * t.Tc;

/** Free thermal strain of a material from Tref to T (positive = expansion). */
export function thermalStrain(mat: number, T: number, Tref: number): number {
  const m = THERMAL_MATERIALS[mat];
  return m.strain(T - 273.15) - m.strain(Tref - 273.15);
}

/** Degree of axial restraint r = K_s/(K_s + K_m). */
export function restraintDegree(Ks: number, Km: number): number {
  if (!(Ks > 0)) return 0;
  if (!Number.isFinite(Ks)) return 1;
  return Ks / (Ks + Km);
}

/** Axial force of restrained thermal expansion (N, compression positive). */
export function restrainedForce(r: number, E: number, A: number, strain: number): number {
  return r * E * A * strain;
}

/** Axial capacity of a beam under compression (N): squash vs Euler buckling (pinned, weak axis). */
export function beamAxialCapacity(fc: number, A: number, E: number, Iweak: number, L: number, f: StrengthState): number {
  const squash = fc * A * f.axial;
  const euler = (Math.PI * Math.PI * E * f.stiffness * Iweak) / Math.max(0.1, L * L);
  return Math.max(1, Math.min(squash, euler));
}

/** Free bowing curvature (1/m) of a member with a skin–core temperature difference over depth d. */
export function bowingCurvature(mat: number, t: NodeTemps, d: number, Tref: number): number {
  if (d <= 0) return 0;
  return (thermalStrain(mat, t.Ts, Tref) - thermalStrain(mat, t.Tc, Tref)) / (d / 2);
}
