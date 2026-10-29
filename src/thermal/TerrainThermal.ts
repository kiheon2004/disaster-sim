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
import { SIGMA, C_WATER, RHO_WATER } from './units';

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
    const { nx, nl, E, C, k, dE, dW, area, gS, gW } = this;
    const L = this.layers;
    const Tref = this.Tref;
    const acc = env.acc;
    const water = env.water;
    const closed = env.closed;
    const lat = (a: number, b: number, l: number) => {
      const G = (2 * L[l] * k[a] * k[b]) / (k[a] + k[b]);
      const q = G * (E[a] / C[a] - E[b] / C[b]);
      gS[a] += G; gS[b] += G;
      if (q !== 0) { dE[a] -= q; dE[b] += q; acc.conduction += Math.abs(q); }
    };
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) {
        for (let ix = x0; ix < x1; ix++) {
          const c = iz * nx + ix;
          const j = c * nl;
          // Column conduction.
          for (let l = 0; l < nl - 1; l++) {
            const a = j + l, b = a + 1;
            const G = area / (L[l] / (2 * k[a]) + L[l + 1] / (2 * k[b]));
            const q = G * (E[a] / C[a] - E[b] / C[b]);
            gS[a] += G; gS[b] += G;
            dE[a] -= q; dE[b] += q;
            acc.conduction += Math.abs(q);
          }
          // Deep boundary below the last layer (adiabatic in a closed world).
          if (!closed) {
            const a = j + nl - 1;
            const G = area / (L[nl - 1] / (2 * k[a]));
            const q = G * (E[a] / C[a]);
            gS[a] += G;
            dE[a] -= q;
            acc.deepGround += q;
          }
          // Lateral conduction (east and south faces; the neighbour must be active).
          if (ix + 1 < nx && this.tileOn[tz * this.ntx + (((ix + 1) / TILE) | 0)]) for (let l = 0; l < nl; l++) lat(j + l, j + nl + l, l);
          if (iz + 1 < this.nz && this.tileOn[(((iz + 1) / TILE) | 0) * this.ntx + tx]) for (let l = 0; l < nl; l++) lat(j + l, j + nx * nl + l, l);
          // Surface.
          if (this.covered[c] || env.noSurface) continue;
          const T0 = Tref + E[j] / C[j];
          const air = env.airIndex(ix, iz);
          const Ta = env.airT(air);
          const R0 = L[0] / (2 * k[j]); // half-layer resistance (m²·K/W)
          const hw = water ? water.h[c] : 0;
          if (hw > WATER_MERGE) {
            // Water over the bed: bed ↔ water conduction, water ↔ air (convection + radiation).
            const Cw = RHO_WATER * C_WATER * hw * area;
            const Tw = Tref + water!.heat[c] / Cw;
            const hws = hWaterSide(Tw, T0);
            const Gwb = hws > 0 ? area / (1 / hws + R0) : 0;
            const qb = Gwb * (Tw - T0);
            dE[j] += qb; dW[c] -= qb;
            acc.conduction += Math.abs(qb);
            const hc = hGround(Tw, Ta, env.u2);
            const eps = 0.96;
            const qc = hc * area * (Tw - Ta);
            const qr = closed ? 0 : eps * SIGMA * area * (Tw * Tw * Tw * Tw - Tref * Tref * Tref * Tref);
            dW[c] -= qc + qr;
            env.toAir(air, qc, (4 / 3) * hc * area);
            acc.convection += Math.abs(qc);
            acc.radiationSky += qr;
            // Bed side uses the water-side tangent (4/3: natural convection grows with ΔT^(1/3)).
            gS[j] += Gwb * (4 / 3);
            gW[c] = (Gwb * (4 / 3) + (4 / 3) * hc * area + (closed ? 0 : 4 * eps * SIGMA * Tw * Tw * Tw * area)) / Cw;
          } else {
            const eps = this.emiss[c];
            const hc = hGround(T0, Ta, env.u2);
            const hr = closed ? 0 : eps * SIGMA * (T0 * T0 + Tref * Tref) * (T0 + Tref);
            // Surface temperature of the linearized balance through the half-layer resistance.
            const Ts = (T0 / R0 + hc * Ta + hr * Tref) / (1 / R0 + hc + hr);
            const qc = hc * area * (Ts - Ta);
            const qr = hr * area * (Ts - Tref);
            dE[j] -= qc + qr;
            env.toAir(air, qc, area / (R0 + 1 / Math.max(1e-12, (4 / 3) * hc)));
            acc.convection += Math.abs(qc);
            acc.radiationSky += qr;
            const hTan = (4 / 3) * hc + (closed ? 0 : 4 * eps * SIGMA * T0 * T0 * T0);
            gS[j] += hTan > 0 ? area / (R0 + 1 / hTan) : 0;
          }
        }
      }
    }
    // Stability: the largest ΣG/C of the visited nodes (cleared for the next evaluation).
    let maxRate = this.extra;
    this.extra = 0;
    for (const t of this.tiles) {
      const tx = t % this.ntx, tz = (t / this.ntx) | 0;
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(nx, x0 + TILE), z1 = Math.min(this.nz, z0 + TILE);
      for (let iz = z0; iz < z1; iz++) {
        for (let ix = x0; ix < x1; ix++) {
          const c = iz * nx + ix;
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
  apply(dt: number, water: WaterLink | null) {
    const { nl, E, dE, dW, nx } = this;
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

/** What the ground needs from its surroundings during a flux evaluation. */
export interface TerrainEnv {
  closed: boolean;
  /** Tests: the ground surface exchanges nothing (insulated). */
  noSurface?: boolean;
  /** Wind speed 2 m above the ground (m/s). */
  u2: number;
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
}

export const emptyRates = (): ThermalRates => ({ conduction: 0, convection: 0, radiation: 0, deepGround: 0, radiationSky: 0, atmosphere: 0, aboveLayer: 0, boundarySupply: 0 });
