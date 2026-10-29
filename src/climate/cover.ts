/**
 * One snow / ice cover node (Phase 30): the frozen water of a ground cell (snow over ice over water / ground) or
 * of an object store (roof, crown, vehicle) as ONE enthalpy node — implicit in its own temperature, so a thin
 * fresh cover is never a stiff explicit node.
 *
 *  state       mass M (kg, frozen + liquid), enthalpy U (J, relative to liquid water at 0 °C) → T, liquid
 *              (snow.ts phaseState); snow part / ice part of the frozen mass (insulation), snow density
 *  resistance  R = d_snow/k_snow(ρ) + d_ice/k_ice per area, the node at mid-depth (R/2 to each face)
 *  top face    shortwave absorbed S, convection h_c·(T_s − T_a) (the Phase 26 ground correlation), longwave to the
 *              sky h_r·(T_s − T_sky), sublimation / evaporation L·k·(q_s(T_s) − q_a) with k = h_c/(c_p·Le^(2/3));
 *              T_s from the balance linearized about the node temperature, T_s ≤ 0 °C (a melting surface stays
 *              at 0 °C and its surplus melts snow — it enters the node)
 *  bottom      conductance to the water / ground / body below (its temperature held over the step)
 *  update      backward Euler in T with the apparent capacity c_i·M (frozen) — or at 0 °C while melting or
 *              refreezing (infinite capacity); every flux is evaluated at the end-of-step temperature
 *              T* = min(T_new, 0 °C) and booked once on both sides (exact energy).
 */
import { CP_AIR, EPS_SNOW, K_ICE, L_S, L_V, LEWIS, RHO_ICE, SIGMA, T_MELT } from './constants';
import { dqSatdT, qSat } from './psychro';
import { phaseState, snowConductivity } from './snow';
import { hGround } from '@/thermal/convection';

const KLE = 1 / (CP_AIR * Math.pow(LEWIS, 2 / 3));

export interface NodeInput {
  M: number;
  U: number;
  /** Frozen snow and ice masses (kg) and the snow density (kg/m³). */
  snow: number;
  ice: number;
  rho: number;
  /** Horizontal area (m²). */
  A: number;
  /** Air temperature (K), specific humidity (kg/kg), pressure (Pa), 2 m wind (m/s), pressure ratio (convection). */
  Ta: number;
  qa: number;
  p: number;
  u2: number;
  pr: number;
  Tsky: number;
  /** Shortwave absorbed at the top (W/m², albedo applied). */
  S: number;
  /** Temperature below and the conductance to it outside the cover's own half resistance (W/K; 0 = adiabatic). */
  Tb: number;
  Gb: number;
  dt: number;
  /** Top exposed to air / sky (false: e.g. the store has no open top). */
  open: boolean;
}

export interface NodeResult {
  dU: number;
  /** Rates over the step (W, kg/s): bottom (node → below), convection (surface → air), longwave (surface → sky),
   * shortwave absorbed, evaporation / sublimation (+, kg/s) or deposition (−), latent heat taken from the node (W). */
  qBottom: number;
  qConv: number;
  qRad: number;
  qSolar: number;
  evap: number;
  qLatent: number;
  /** Surface and end-of-step node temperature (K). */
  Ts: number;
  T: number;
  /** Latent heat used (L_v with liquid at the surface, L_s otherwise). */
  L: number;
}

/** Thermal resistance of the cover per area (m²·K/W). */
export function coverResistance(snow: number, ice: number, rho: number, A: number): number {
  const ds = snow > 0 ? snow / (Math.max(50, rho) * A) : 0;
  const di = ice > 0 ? ice / (RHO_ICE * A) : 0;
  return ds / snowConductivity(rho) + di / K_ICE + 1e-4;
}

export function stepNode(n: NodeInput, out: NodeResult): NodeResult {
  const { M, U, A, dt } = n;
  const ph = phaseState(U, M);
  const T = Math.min(ph.T, T_MELT);
  const melting = U >= -3.337e5 * M; // at 0 °C with liquid (or exactly frozen at 0 °C)
  const C = melting ? Infinity : 2108 * M;
  const Rh = 0.5 * coverResistance(n.snow, n.ice, n.rho, A);
  const Gbot = n.Gb > 0 ? 1 / (1 / n.Gb + Rh / A) : 0;
  // Top face linearization (per area) about the node temperature.
  let a = 0, b = 0, hc = 0, hr = 0, k = 0, L = L_V, q0 = 0, s = 0, Tl = T;
  const wetTop = ph.liquid > 0 && T >= T_MELT - 1e-9;
  if (n.open) {
    hc = hGround(T, n.Ta, n.u2, 1, n.pr);
    hr = EPS_SNOW * SIGMA * (T * T + n.Tsky * n.Tsky) * (T + n.Tsky);
    k = hc * KLE;
    L = wetTop ? L_V : L_S;
    q0 = qSat(T, n.p, !wetTop);
    s = dqSatdT(T, n.p, !wetTop);
    Tl = T;
    const den = 1 / Rh + hc + hr + L * k * s;
    a = (n.S + hc * n.Ta + hr * n.Tsky - L * k * (q0 - s * Tl - n.qa)) / den;
    b = 1 / Rh / den;
  }
  const Gt = n.open ? ((1 - b) / Rh) * A : 0;
  const Tt = n.open && b < 1 ? a / (1 - b) : T;
  let Tstar: number;
  if (C === Infinity) Tstar = T_MELT;
  else {
    const Tn = (C * T / dt + Gt * Tt + Gbot * n.Tb) / (C / dt + Gt + Gbot);
    Tstar = Math.min(Tn, T_MELT);
  }
  let Ts = Tstar, qConv = 0, qRad = 0, evap = 0, qLat = 0, qSolar = 0;
  if (n.open) {
    Ts = a + b * Tstar;
    if (Ts > T_MELT) Ts = T_MELT;
    qSolar = n.S * A;
    qConv = hc * A * (Ts - n.Ta);
    qRad = hr * A * (Ts - n.Tsky);
    evap = Ts >= T_MELT ? k * A * (qSat(T_MELT, n.p) - n.qa) : k * A * (q0 + s * (Ts - Tl) - n.qa);
    // Never more than the cover holds over the step.
    const cap = (0.5 * M) / dt;
    if (evap > cap) evap = cap;
    qLat = L * evap;
  }
  const qBottom = Gbot * (Tstar - n.Tb);
  const top = qSolar - qConv - qRad - qLat;
  out.dU = dt * (top - qBottom);
  out.qBottom = qBottom;
  out.qConv = qConv;
  out.qRad = qRad;
  out.qSolar = qSolar;
  out.evap = evap;
  out.qLatent = qLat;
  out.Ts = Ts;
  out.T = Tstar;
  out.L = L;
  return out;
}

export const emptyResult = (): NodeResult => ({ dU: 0, qBottom: 0, qConv: 0, qRad: 0, qSolar: 0, evap: 0, qLatent: 0, Ts: T_MELT, T: T_MELT, L: L_S });
