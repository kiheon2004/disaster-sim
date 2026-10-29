/**
 * Ground temperature (Phase 26): a reduced model of the shallow ground under every 1 m terrain cell
 * (the water model's cells — same indexing, so water and ground exchange cell by cell).
 *
 *   layer   thickness   material                       node at
 *     0       0.02 m    surface (ground type)          0.01 m
 *     1       0.06 m    surface (ground type)          0.05 m
 *     2       0.18 m    soil profile                   0.17 m
 *     3       0.54 m    soil profile                   0.53 m
 *   below 0.80 m: the ambient reference temperature (Dirichlet; the "deep ground" of the ledger)
 *
 * Conduction: between layers of a column and between the same layers of neighbouring cells
 * (series conductances, harmonic mean of the conductivities). The surface exchanges with the air
 * layer by convection and with the surroundings by radiation through the half-layer resistance of
 * layer 0 (surface temperature eliminated from the linearized balance); covered cells (under a
 * building) exchange only through the contacts the bodies declare; cells with water exchange with the
 * water instead (water ↔ air separately). Explicit (forward Euler) — the caller sub-steps it by the
 * stability limit reported in `maxRate`.
 *
 * Active region: 10 × 10-cell tiles. A tile is computed only once something changed in it; cells of
 * inactive tiles are exactly at the reference temperature, so skipping them never drops energy.
 * Neighbouring tiles join as soon as a border cell differs from the reference.
 */
import type { TerrainData } from '@/core/model';
import { GROUND_EMISSIVITY, GROUND_THERMAL, SOIL_THERMAL, THERMAL_MATERIALS } from './materials';
import { hGround, hWaterSide } from './convection';
import { SIGMA, C_WATER, RHO_WATER, CP_AIR } from './units';
import { dqSatdT, qSat } from '@/climate/psychro';
import { FROST_BAND, L_S, L_V, LEWIS, T_MELT } from '@/climate/constants';

export const LAYERS = [0.02, 0.06, 0.18, 0.54] as const;
export const NL = LAYERS.length;
export const TILE = 10;
/** Water thinner than this shares the temperature of the surface layer (m). */
export const WATER_MERGE = 1e-3;
/** A border cell differing by more than this from the reference activates the neighbouring tile (K). */
const TILE_EPS = 1e-6;

export interface WaterLink {
  h: Float64Array;
  heat: Float64Array;
  /** Heat infiltrated with water this step per cell (J) → ground surface. */
  infilHeat: Float64Array | null;
}

export class TerrainThermal {
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly originX: number;
  readonly originZ: number;
  readonly area: number;
  readonly count: number;
  readonly layers: readonly number[];
  readonly nl: number;
  /** Energy per cell-layer above the reference (J), index c·NL + l. */
  readonly E: Float64Array;
  /** Heat capacity (J/K) and conductivity (W/(m·K)) per cell-layer. */
  readonly C: Float64Array;
  readonly k: Float64Array;
  readonly emiss: Float32Array;
  readonly covered: Uint8Array;
  /** Rate accumulators (W). */
  readonly dE: Float64Array;
  readonly dW: Float64Array;
  /** Stability scratch: Σ conductance per cell-layer (W/K) and the water rate per cell (1/s). */
  private readonly gS: Float64Array;
  private readonly gW: Float64Array;
  /** Static conductances (W/K): column (l → l+1; the last one to the deep boundary), east / south faces; half-layer resistance of the surface (m²·K/W); node temperature scratch. */
  private readonly Gc: Float64Array;
  private readonly Gx: Float64Array;
  private readonly Gz: Float64Array;
  private readonly R0: Float64Array;
  private readonly Tn: Float64Array;
  readonly ntx: number;
  readonly ntz: number;
  readonly tileOn: Uint8Array;
  tiles: number[] = [];
  /** Peak surface temperature per cell (K) — NaN until the cell is first computed. */
  readonly Tpeak: Float32Array;

  constructor(t: TerrainData, readonly Tref: number, layers: readonly number[] = LAYERS) {
    this.nx = t.nx - 1;
    this.nz = t.nz - 1;
    this.cell = t.cellSize;
    this.originX = t.originX;
    this.originZ = t.originZ;
    this.area = this.cell * this.cell;
    this.layers = layers;
    this.nl = layers.length;
    const n = (this.count = this.nx * this.nz);
    this.E = new Float64Array(n * this.nl);
    this.C = new Float64Array(n * this.nl);
    this.k = new Float64Array(n * this.nl);
    this.dE = new Float64Array(n * this.nl);
    this.dW = new Float64Array(n);
    this.gS = new Float64Array(n * this.nl);
    this.gW = new Float64Array(n);
    this.emiss = new Float32Array(n);
    this.covered = new Uint8Array(n);
    this.Tpeak = new Float32Array(n).fill(NaN);
    const vx = t.nx;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const c = iz * this.nx + ix;
        // Nearest vertex to the cell centre (same rule as the water grid's ground type).
        const v = (iz + 1) * vx + ix + 1;
        const g = Math.min(GROUND_THERMAL.length - 1, t.ground[v]);
        const s = Math.min(SOIL_THERMAL.length - 1, t.soil[v]);
        this.emiss[c] = GROUND_EMISSIVITY[g];
        for (let l = 0; l < this.nl; l++) {
          // Top 8 cm: the surface material; below: the soil profile (scaled layer sets: by depth).
          const top = this.depthOf(l) < 0.08 - 1e-9;
          const m = THERMAL_MATERIALS[top ? GROUND_THERMAL[g] : SOIL_THERMAL[s]];
          this.C[c * this.nl + l] = m.density * (m.constantC ?? m.c(20)) * layers[l] * this.area;
          this.k[c * this.nl + l] = m.k(20);
        }
      }
    }
    // Conductances (constant properties of the ground layers): series of half-layers, harmonic means.
    this.Gc = new Float64Array(n * this.nl);
    this.Gx = new Float64Array(n * this.nl);
    this.Gz = new Float64Array(n * this.nl);
    this.R0 = new Float64Array(n);
    this.Tn = new Float64Array(n * this.nl);
    const L = layers, k = this.k, nl = this.nl;
    for (let c = 0; c < n; c++) {
      const j = c * nl;
      this.R0[c] = L[0] / (2 * k[j]);
      for (let l = 0; l < nl; l++) {
        const a = j + l;
        this.Gc[a] = l < nl - 1 ? this.area / (L[l] / (2 * k[a]) + L[l + 1] / (2 * k[a + 1])) : this.area / (L[l] / (2 * k[a]));
        if ((c % this.nx) + 1 < this.nx) this.Gx[a] = (2 * L[l] * k[a] * k[a + nl]) / (k[a] + k[a + nl]);
        if (c + this.nx < n) this.Gz[a] = (2 * L[l] * k[a] * k[a + this.nx * nl]) / (k[a] + k[a + this.nx * nl]);
      }
    }
    this.ntx = Math.ceil(this.nx / TILE);
    this.ntz = Math.ceil(this.nz / TILE);
    this.tileOn = new Uint8Array(this.ntx * this.ntz);
  }

  /**
   * Extra conductance coupled to a cell by an outside exchange (prescribed-temperature sphere) — it
   * enters the NEXT stability estimate (these exchanges are evaluated after the ground fluxes).
   */
  extraRate(c: number, G: number, wet: boolean) {
    if (wet) return;
    const j = c * this.nl;
    this.extra = Math.max(this.extra, G / this.C[j]);
  }
  private extra = 0;

  /** Depth of the top of layer l (m). */
  depthOf(l: number): number {
    let d = 0;
    for (let i = 0; i < l; i++) d += this.layers[i];
    return d;
  }

  index(x: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.cell);
    const iz = Math.floor((z - this.originZ) / this.cell);
    return ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz ? -1 : iz * this.nx + ix;
  }

  cellCenter(c: number): [number, number] {
    return [this.originX + ((c % this.nx) + 0.5) * this.cell, this.originZ + (((c / this.nx) | 0) + 0.5) * this.cell];
  }

  T(c: number, l = 0): number {
    const j = c * this.nl + l;
    return this.Tref + this.E[j] / this.C[j];
  }

  isActiveCell(c: number): boolean {
    return this.tileOn[((c / this.nx / TILE) | 0) * this.ntx + (((c % this.nx) / TILE) | 0)] === 1;
  }

  activateCell(c: number) {
    const t = ((c / this.nx / TILE) | 0) * this.ntx + (((c % this.nx) / TILE) | 0);
    this.activateTile(t);
  }

  activateTile(t: number) {
    if (this.tileOn[t]) return;
    this.tileOn[t] = 1;
    // Keep the list ascending (deterministic visiting order, independent of activation order).
    let lo = 0, hi = this.tiles.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.tiles[m] < t) lo = m + 1; else hi = m; }
    this.tiles.splice(lo, 0, t);
  }

  /** Tiles neighbouring an active tile join when a border cell left the reference state. */
  growTiles() {
    const add: number[] = [];
    const { nx, nz, nl } = this;
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE) - 1, z1 = Math.min(nz, z0 + TILE) - 1;
      const off = (ix: number, iz: number) => {
        const j = (iz * nx + ix) * nl;
        for (let l = 0; l < nl; l++) if (Math.abs(this.E[j + l] / this.C[j + l]) > TILE_EPS) return true;
        return false;
      };
      const check = (ntx2: number, ntz2: number, edge: () => boolean) => {
        if (ntx2 < 0 || ntz2 < 0 || ntx2 >= this.ntx || ntz2 >= this.ntz) return;
        const k = ntz2 * this.ntx + ntx2;
        if (!this.tileOn[k] && edge()) add.push(k);
      };
      check(tx - 1, tz, () => { for (let iz = z0; iz <= z1; iz++) if (off(x0, iz)) return true; return false; });
      check(tx + 1, tz, () => { for (let iz = z0; iz <= z1; iz++) if (off(x1, iz)) return true; return false; });
      check(tx, tz - 1, () => { for (let ix = x0; ix <= x1; ix++) if (off(ix, z0)) return true; return false; });
      check(tx, tz + 1, () => { for (let ix = x0; ix <= x1; ix++) if (off(ix, z1)) return true; return false; });
    }
    for (const k of add) this.activateTile(k);
  }

  /** Visit every cell of the active tiles (ascending tile order, row-major inside a tile). */
  forActive(f: (c: number, ix: number, iz: number) => void) {
    const { nx, nz } = this;
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) for (let ix = x0; ix < x1; ix++) f(iz * nx + ix, ix, iz);
    }
  }

  /**
   * Fluxes of the active cells into the rate accumulators (W): column / lateral conduction, deep
   * boundary, surface ↔ air / sky, water ↔ bed / air. Losses and gross transfers are accumulated as
   * RATES in `env.acc` (the caller books them with the step actually applied). Returns the largest
   * ΣG/C (1/s) over the active nodes — the explicit stability limit is dt·max < 1.
   */
  fluxes(env: TerrainEnv): number {
    if (env.climate) return this.fluxesClimate(env, env.climate);
    const { nx, nl, E, dE, dW, area, gS, gW, Tn, Gc, Gx, Gz, R0 } = this;
    const C = this.C;
    const Tref = this.Tref;
    const acc = env.acc;
    const water = env.water;
    const closed = env.closed;
    const ntx = this.ntx, tileOn = this.tileOn;
    let cond = 0, conv = 0, deep = 0, sky = 0;
    // Node temperatures of the active cells (once per evaluation).
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) for (let j = (iz * nx + x0) * nl, e = (iz * nx + x1) * nl; j < e; j++) Tn[j] = Tref + E[j] / C[j];
    }
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      const eastOn = tx + 1 < ntx && tileOn[t + 1] === 1;
      const southOn = tz + 1 < this.ntz && tileOn[t + ntx] === 1;
      for (let iz = z0; iz < z1; iz++) {
        const lastRow = iz + 1 === z1;
        for (let ix = x0; ix < x1; ix++) {
          const c = iz * nx + ix;
          const j = c * nl;
          // Column conduction and the deep boundary below the last layer.
          for (let l = 0; l < nl - 1; l++) {
            const a = j + l;
            const G = Gc[a];
            const q = G * (Tn[a] - Tn[a + 1]);
            gS[a] += G; gS[a + 1] += G;
            dE[a] -= q; dE[a + 1] += q;
            cond += q < 0 ? -q : q;
          }
          if (!closed) {
            const a = j + nl - 1;
            const G = Gc[a];
            const q = G * (Tn[a] - Tref);
            gS[a] += G;
            dE[a] -= q;
            deep += q;
          }
          // Lateral conduction (east and south faces; the neighbour must be active).
          if (ix + 1 < nx && (ix + 1 < x1 || eastOn)) {
            for (let l = 0; l < nl; l++) {
              const a = j + l, b = a + nl, G = Gx[a];
              const q = G * (Tn[a] - Tn[b]);
              gS[a] += G; gS[b] += G;
              if (q !== 0) { dE[a] -= q; dE[b] += q; cond += q < 0 ? -q : q; }
            }
          }
          if (iz + 1 < this.nz && (!lastRow || southOn)) {
            for (let l = 0; l < nl; l++) {
              const a = j + l, b = a + nx * nl, G = Gz[a];
              const q = G * (Tn[a] - Tn[b]);
              gS[a] += G; gS[b] += G;
              if (q !== 0) { dE[a] -= q; dE[b] += q; cond += q < 0 ? -q : q; }
            }
          }
          // Surface.
          if (this.covered[c] || env.noSurface) continue;
          const T0 = Tn[j];
          const air = env.airIndex(ix, iz);
          const Ta = env.airT(air);
          const r0 = R0[c]; // half-layer resistance (m²·K/W)
          const hw = water ? water.h[c] : 0;
          if (hw > WATER_MERGE) {
            // Water over the bed: bed ↔ water conduction, water ↔ air (convection + radiation).
            const Cw = RHO_WATER * C_WATER * hw * area;
            const Tw = Tref + water!.heat[c] / Cw;
            const hws = hWaterSide(Tw, T0);
            const Gwb = hws > 0 ? area / (1 / hws + r0) : 0;
            const qb = Gwb * (Tw - T0);
            dE[j] += qb; dW[c] -= qb;
            cond += Math.abs(qb);
            const hc = env.pr ? hGround(Tw, Ta, env.u2, 1, env.pr(air)) : hGround(Tw, Ta, env.u2);
            const eps = 0.96;
            const qc = hc * area * (Tw - Ta);
            const qr = closed ? 0 : eps * SIGMA * area * (Tw * Tw * Tw * Tw - Tref * Tref * Tref * Tref);
            dW[c] -= qc + qr;
            env.toAir(air, qc, (4 / 3) * hc * area);
            conv += Math.abs(qc);
            sky += qr;
            gS[j] += Gwb * (4 / 3);
            gW[c] = (Gwb * (4 / 3) + (4 / 3) * hc * area + (closed ? 0 : 4 * eps * SIGMA * Tw * Tw * Tw * area)) / Cw;
          } else {
            const hc = env.pr ? hGround(T0, Ta, env.u2, 1, env.pr(air)) : hGround(T0, Ta, env.u2);
            if (hc === 0 && T0 === Tref) continue;
            const eps = this.emiss[c];
            const hr = closed ? 0 : eps * SIGMA * (T0 * T0 + Tref * Tref) * (T0 + Tref);
            // Surface temperature of the linearized balance through the half-layer resistance.
            const Ts = (T0 / r0 + hc * Ta + hr * Tref) / (1 / r0 + hc + hr);
            const qc = hc * area * (Ts - Ta);
            const qr = hr * area * (Ts - Tref);
            dE[j] -= qc + qr;
            env.toAir(air, qc, area / (r0 + 1 / Math.max(1e-12, (4 / 3) * hc)));
            conv += qc < 0 ? -qc : qc;
            sky += qr;
            const hTan = (4 / 3) * hc + (closed ? 0 : 4 * eps * SIGMA * T0 * T0 * T0);
            gS[j] += hTan > 0 ? area / (r0 + 1 / hTan) : 0;
          }
        }
      }
    }
    acc.conduction += cond;
    acc.convection += conv;
    acc.deepGround += deep;
    acc.radiationSky += sky;
    // Stability: the largest ΣG/C of the visited nodes (cleared for the next evaluation).
    let maxRate = this.extra;
    this.extra = 0;
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) {
        for (let c = iz * nx + x0, ce = iz * nx + x1; c < ce; c++) {
          const j = c * nl;
          for (let l = 0; l < nl; l++) { const r = gS[j + l] / C[j + l]; if (r > maxRate) maxRate = r; gS[j + l] = 0; }
          if (gW[c] > maxRate) maxRate = gW[c];
          gW[c] = 0;
        }
      }
    }
    return maxRate;
  }

  /**
   * Phase 30: the same evaluation with the climate's surface balance (sky longwave, shortwave, latent heat) and
   * snow / ice covered cells left to the climate. Conduction terms are identical to fluxes().
   */
  private fluxesClimate(env: TerrainEnv, cl: SurfaceClimate): number {
    const { nx, nl, E, dE, dW, area, gS, gW, Tn, Gc, Gx, Gz, R0 } = this;
    const C = this.C;
    const Tref = this.Tref;
    const acc = env.acc;
    const water = env.water;
    const closed = env.closed;
    const ntx = this.ntx, tileOn = this.tileOn;
    const Tsky = cl.Tsky, Tsky4 = Tsky * Tsky * Tsky * Tsky;
    const kLe = 1 / (CP_AIR * Math.pow(LEWIS, 2 / 3));
    let cond = 0, conv = 0, deep = 0, sky = 0, sol = 0;
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) for (let j = (iz * nx + x0) * nl, e = (iz * nx + x1) * nl; j < e; j++) Tn[j] = Tref + E[j] / C[j];
    }
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      const eastOn = tx + 1 < ntx && tileOn[t + 1] === 1;
      const southOn = tz + 1 < this.ntz && tileOn[t + ntx] === 1;
      for (let iz = z0; iz < z1; iz++) {
        const lastRow = iz + 1 === z1;
        for (let ix = x0; ix < x1; ix++) {
          const c = iz * nx + ix;
          const j = c * nl;
          for (let l = 0; l < nl - 1; l++) {
            const a = j + l;
            const G = Gc[a];
            const q = G * (Tn[a] - Tn[a + 1]);
            gS[a] += G; gS[a + 1] += G;
            dE[a] -= q; dE[a + 1] += q;
            cond += q < 0 ? -q : q;
          }
          if (!closed) {
            const a = j + nl - 1;
            const G = Gc[a];
            const q = G * (Tn[a] - Tref);
            gS[a] += G;
            dE[a] -= q;
            deep += q;
          }
          if (ix + 1 < nx && (ix + 1 < x1 || eastOn)) {
            for (let l = 0; l < nl; l++) {
              const a = j + l, b = a + nl, G = Gx[a];
              const q = G * (Tn[a] - Tn[b]);
              gS[a] += G; gS[b] += G;
              if (q !== 0) { dE[a] -= q; dE[b] += q; cond += q < 0 ? -q : q; }
            }
          }
          if (iz + 1 < this.nz && (!lastRow || southOn)) {
            for (let l = 0; l < nl; l++) {
              const a = j + l, b = a + nx * nl, G = Gz[a];
              const q = G * (Tn[a] - Tn[b]);
              gS[a] += G; gS[b] += G;
              if (q !== 0) { dE[a] -= q; dE[b] += q; cond += q < 0 ? -q : q; }
            }
          }
          if (this.covered[c] || env.noSurface) continue;
          const T0 = Tn[j];
          const r0 = R0[c];
          const hw = water ? water.h[c] : 0;
          const wet = hw > WATER_MERGE;
          if (cl.covered[c]) {
            // Under the climate's snow / ice cover: the bed still conducts to the water above it.
            if (wet) {
              const Cw = RHO_WATER * C_WATER * hw * area;
              const Tw = Tref + water!.heat[c] / Cw;
              const hws = hWaterSide(Tw, T0);
              const Gwb = hws > 0 ? area / (1 / hws + r0) : 0;
              const qb = Gwb * (Tw - T0);
              dE[j] += qb; dW[c] -= qb;
              cond += Math.abs(qb);
              gS[j] += Gwb * (4 / 3);
              gW[c] = (Gwb * (4 / 3)) / Cw;
            }
            continue;
          }
          const air = env.airIndex(ix, iz);
          const Ta = env.airT(air);
          const qa = air >= 0 ? cl.qAir[air] : cl.qAir[0];
          const pa = air >= 0 ? cl.pAir[air] : cl.pAir[0];
          const S = cl.solar[c] * area;
          sol += S;
          if (wet) {
            const Cw = RHO_WATER * C_WATER * hw * area;
            const Tw = Tref + water!.heat[c] / Cw;
            const hws = hWaterSide(Tw, T0);
            const Gwb = hws > 0 ? area / (1 / hws + r0) : 0;
            const qb = Gwb * (Tw - T0);
            dE[j] += qb; dW[c] -= qb;
            cond += Math.abs(qb);
            const hc = env.pr ? hGround(Tw, Ta, env.u2, 1, env.pr(air)) : hGround(Tw, Ta, env.u2);
            const eps = 0.96;
            const qc = hc * area * (Tw - Ta);
            const qr = closed ? 0 : eps * SIGMA * area * (Tw * Tw * Tw * Tw - Tsky4);
            // Open water: no surface resistance; condensation (dew) when the air is moister than saturation at Tw.
            const km = hc * kLe * area;
            let Ev = km * (qSat(Tw, pa) - qa);
            if (Ev > cl.evapMax[c]) Ev = cl.evapMax[c];
            const ql = L_V * Ev;
            dW[c] += S - qc - qr - ql;
            cl.evapRate[c] += Ev;
            cl.latRate[c] += ql;
            env.toAir(air, qc, (4 / 3) * hc * area);
            conv += Math.abs(qc);
            sky += qr;
            gS[j] += Gwb * (4 / 3);
            gW[c] = (Gwb * (4 / 3) + (4 / 3) * hc * area + (closed ? 0 : 4 * eps * SIGMA * Tw * Tw * Tw * area) + L_V * km * dqSatdT(Tw, pa)) / Cw;
          } else {
            const hc = env.pr ? hGround(T0, Ta, env.u2, 1, env.pr(air)) : hGround(T0, Ta, env.u2);
            const eps = this.emiss[c];
            let hr = closed ? 0 : eps * SIGMA * (T0 * T0 + Tsky * Tsky) * (T0 + Tsky);
            // Latent: evaporation of soil water through the soil resistance (soilWet), condensation (dew / frost)
            // on the surface without it; L_s for frost below 0 °C.
            const ice = T0 < T_MELT - FROST_BAND;
            const qs0 = qSat(T0, pa, ice);
            const cond0 = qs0 < qa;
            const k = hc * kLe * (cond0 ? 1 : cl.soilWet[c]);
            const L = cond0 && ice ? L_S : L_V;
            const s = k > 0 ? dqSatdT(T0, pa, ice) : 0;
            // Surface temperature of the linearized balance (latent flux linear in Ts about T0).
            let Ts = (T0 / r0 + hc * Ta + hr * Tsky + cl.solar[c] - L * k * (qs0 - s * T0 - qa)) / (1 / r0 + hc + hr + L * k * s);
            // The longwave belongs to the SURFACE temperature: far from the layer's (lava under a cold sky, a sun-heated
            // crust) the quartic balance is solved by Newton (F concave, from the linearized Ts) and the secant is taken
            // at the converged Ts, so εσ(Ts⁴ − T_sky⁴) is booked exactly; within 2 K of T0 the layer value is within ≈ 2 %.
            if (!closed && Math.abs(Ts - T0) > 2) {
              const lin = T0 / r0 + hc * Ta + cl.solar[c] - L * k * (qs0 - s * T0 - qa), G = 1 / r0 + hc + L * k * s, es = eps * SIGMA, T4 = Tsky4;
              for (let it = 0; it < 8; it++) {
                const t3 = Ts * Ts * Ts;
                const F = lin - G * Ts - es * (t3 * Ts - T4);
                const d = F / (G + 4 * es * t3);
                Ts += d;
                if (Math.abs(d) < 1e-6) break;
              }
              hr = es * (Ts * Ts + Tsky * Tsky) * (Ts + Tsky);
            }
            let Ev = k * area * (qs0 + s * (Ts - T0) - qa);
            if (Ev > cl.evapMax[c]) {
              Ev = cl.evapMax[c];
              Ts = (T0 / r0 + hc * Ta + hr * Tsky + cl.solar[c] - (L * Ev) / area) / (1 / r0 + hc + hr);
            }
            const qc = hc * area * (Ts - Ta);
            const qr = hr * area * (Ts - Tsky);
            const ql = L * Ev;
            dE[j] += S - qc - qr - ql;
            cl.evapRate[c] += Ev;
            cl.latRate[c] += ql;
            env.toAir(air, qc, area / (r0 + 1 / Math.max(1e-12, (4 / 3) * hc)));
            conv += qc < 0 ? -qc : qc;
            sky += qr;
            const hTan = (4 / 3) * hc + (closed ? 0 : 4 * eps * SIGMA * T0 * T0 * T0) + L * k * s;
            gS[j] += hTan > 0 ? area / (r0 + 1 / hTan) : 0;
          }
        }
      }
    }
    acc.conduction += cond;
    acc.convection += conv;
    acc.deepGround += deep;
    acc.radiationSky += sky;
    acc.solar += sol;
    let maxRate = this.extra;
    this.extra = 0;
    for (const t of this.tiles) {
      const tx = t % ntx, tz = (t / ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) {
        for (let c = iz * nx + x0, ce = iz * nx + x1; c < ce; c++) {
          const j = c * nl;
          for (let l = 0; l < nl; l++) { const r = gS[j + l] / C[j + l]; if (r > maxRate) maxRate = r; gS[j + l] = 0; }
          if (gW[c] > maxRate) maxRate = gW[c];
          gW[c] = 0;
        }
      }
    }
    return maxRate;
  }

  /** Apply the accumulated rates over dt and clear them. Water heat applies to the link. */
  apply(dt: number, water: WaterLink | null, climate?: SurfaceClimate | null) {
    const { nl, E, dE, dW, nx } = this;
    if (climate) {
      const { evapRate, latRate, evap, latent } = climate;
      this.forActive((c) => {
        if (evapRate[c] !== 0) { evap[c] += evapRate[c] * dt; evapRate[c] = 0; }
        if (latRate[c] !== 0) { latent[c] += latRate[c] * dt; climate.latentSum += latRate[c] * dt; latRate[c] = 0; }
      });
    }
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) {
        for (let ix = x0; ix < x1; ix++) {
          const c = iz * nx + ix;
          const j = c * nl;
          for (let l = 0; l < nl; l++) { E[j + l] += dE[j + l] * dt; dE[j + l] = 0; }
          if (dW[c] !== 0) { if (water) water.heat[c] += dW[c] * dt; dW[c] = 0; }
        }
      }
    }
  }

  /** Total energy of the ground columns (J). */
  energy(): number {
    let s = 0;
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(this.nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) for (let ix = x0; ix < x1; ix++) { const j = (iz * this.nx + ix) * this.nl; for (let l = 0; l < this.nl; l++) s += this.E[j + l]; }
    }
    return s;
  }
}

/**
 * Phase 30: the climate's coupling of the bare surface in the ground step (absent without a climate experiment —
 * the Phase 26 path is then taken unchanged). The surface balance gains absorbed shortwave, longwave exchange with
 * the sky's effective temperature instead of the reference, and the latent heat of evaporation / condensation
 * with the mass-transfer coefficient of the same convection (Chilton–Colburn: h_m = h_c / (c_p·Le^(2/3))).
 * Cells under a snow / ice cover exchange nothing with air / sky here (the climate does it for the cover).
 */
export interface SurfaceClimate {
  covered: Uint8Array;
  /** Shortwave absorbed by the bare surface (W/m²) — the ground surface layer or the water node. */
  solar: Float32Array;
  /** Effective sky temperature (K). */
  Tsky: number;
  /** Specific humidity (kg/kg) and pressure (Pa) of the air columns. */
  qAir: Float64Array;
  pAir: Float64Array;
  /** Soil evaporation conductance share (0 dry … 1 free water) — the soil resistance. */
  soilWet: Float32Array;
  /** Largest evaporation the cell's water / soil water can supply over this ground step (kg/s). */
  evapMax: Float32Array;
  /** Rates of one evaluation (kg/s evaporation +, condensation −; W latent taken +) and the step totals (kg, J). */
  evapRate: Float64Array;
  latRate: Float64Array;
  evap: Float64Array;
  latent: Float64Array;
  /** Σ of the latent heat applied since the climate last booked it (J). */
  latentSum: number;
}

/** What the ground needs from its surroundings during a flux evaluation. */
export interface TerrainEnv {
  /** Phase 30: climate surface coupling (absent: Phase 26 surface). */
  climate?: SurfaceClimate | null;
  closed: boolean;
  /** Tests: the ground surface exchanges nothing (insulated). */
  noSurface?: boolean;
  /** Wind speed 2 m above the ground (m/s). */
  u2: number;
  /** Phase 29: pressure ratio to the standard pressure at an air column (absent: 1). */
  pr?: (a: number) => number;
  water: WaterLink | null;
  airIndex(ix: number, iz: number): number;
  airT(a: number): number;
  /** Convective heat into air cell `a` (W) and the conductance it couples with (W/K, stability of the air cell). */
  toAir(a: number, W: number, G: number): void;
  /** Rate accumulators (W) of this evaluation. */
  acc: ThermalRates;
}

/** Loss and transfer RATES (W) of one flux evaluation; booked × dt by the caller. */
export interface ThermalRates {
  conduction: number;
  convection: number;
  radiation: number;
  deepGround: number;
  radiationSky: number;
  atmosphere: number;
  aboveLayer: number;
  boundarySupply: number;
  /** Phase 30: shortwave absorbed by bare surfaces (climate only; booked `solar`). */
  solar: number;
}

export const emptyRates = (): ThermalRates => ({ conduction: 0, convection: 0, radiation: 0, deepGround: 0, radiationSky: 0, atmosphere: 0, aboveLayer: 0, boundarySupply: 0, solar: 0 });
