/**
 * ClimateWorld (Phase 30): the water-substance stores of a climate experiment on top of the Phase 26 thermal state
 * and the Phase 14 water — pure (no Rapier, no React). Ownership (docs/EXTREME_CLIMATE.md §1.2–1.3):
 *
 *   liquid surface water, event soil water   Phase 14 WaterField (h, infiltrated) — read and changed through
 *                                            budgeted transfers (melt, frozen, evaporated, condensed, rain)
 *   sensible heat                            Phase 26 ThermalWorld — changed only through ledger accounts
 *   here                                     snow / ice covers (cells), object stores (roofs, crowns, vehicles),
 *                                            antecedent soil water and soil ice (cell × layer), water vapour and
 *                                            condensate (air columns), their latent energy, the climate ledgers
 *
 * Energy reference of water substance: liquid at the thermal reference temperature T_ref = 0 J/kg. A cover's
 * energy is U + M·c_w·(T_m − T_ref) (U relative to liquid at 0 °C); vapour carries L_v per kg (its sensible heat
 * is part of the air node); condensate carries 0 (liquid, sensible in the air node); soil ice −L_f per kg.
 * Every transfer moves (mass, mass × the source's specific enthalpy); the air node takes the remainder of a
 * vapour exchange, so that the sum thermal + climate stores is changed only by external terms (tested).
 *
 * Steps (called by the adapter inside the ThermalSystem):
 *   prepare(dt, t)     background state, forcing of the air layer (flux relaxation / prescribed), the surface
 *                      coupling handed to the thermal ground step (sky, humidity, pressure, soil wetness, caps)
 *   after(dt, t)       if the thermal ground step ran: surface step (evaporation reconciliation, precipitation,
 *                      covers, water freezing / boiling, soil freezing, stores, shortwave for the next step);
 *                      every step: vapour transport, boundary mixing, saturation adjustment, Kessler precipitation
 */
import type { TerrainData } from '@/core/model';
import type { ThermalWorld } from '@/thermal/ThermalWorld';
import type { SurfaceClimate } from '@/thermal/TerrainThermal';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import { hWaterSide, hGround } from '@/thermal/convection';
import { C_ICE, C_WATER, CP_AIR, EPS_SNOW, GROUND_ALBEDO, ICE_ALBEDO, L_F, L_S, L_V, RHO_ICE, RHO_WATER, SNOW_ALBEDO_MAX, SNOW_HOLDING, T_MELT, WATER_ALBEDO, P_TRIPLE } from './constants';
import { ClimateForcing, type BackgroundState } from './forcing';
import type { ClimateSpec } from './types';
import { boilingPointWater, humidityFromRH, qSat, saturationAdjust, wetBulb } from './psychro';
import { ashyAlbedo, compact, freshSnowDensity, intercept, interceptionMax, phaseState, snowAlbedo } from './snow';
import { autoconversion, snowFraction } from './surfaceState';
import { emptyResult, stepNode, type NodeInput } from './cover';
import type { SunState } from './solar';
import { advectFaces, courant, substepsFor } from '@/atmosphere/grid';

/** Water of the flood model the climate exchanges with (WaterField satisfies it). */
export interface ClimateWaterLink {
  readonly nx: number;
  readonly nz: number;
  readonly count: number;
  readonly cellArea: number;
  readonly h: Float64Array;
  heat: Float64Array | null;
  readonly infiltrated: Float32Array;
  readonly infilStore: Float32Array;
  readonly blocked: Uint8Array;
  readonly redirect: Int32Array;
  readonly owner: Int32Array;
  readonly budget: { rain: number; sources: number; boundaryIn: number; boundaryOut: number; drainage: number; infiltration: number; initial: number; melt: number; frozen: number; evaporated: number; condensed: number };
  touch(ix: number, iz: number): void;
  infilFactor: Float32Array | null;
  iceLoad: Float64Array | null;
  iceFric: Float32Array | null;
  frozen: Uint8Array | null;
  totalVolume(): number;
}

export const STORE = { roof: 0, crown: 1, vehicle: 2 } as const;

export interface StoreInit {
  kind: number;
  /** Horizontal area catching precipitation (m²). */
  area: number;
  /** Air column (−1: above the layer). */
  air: number;
  /** Thermal body under the store (−1: none — adiabatic bottom) and the conductance path to its skin (m²K/W per area). */
  body: number;
  path: number;
  /** Ground cells the store drains / drops to. */
  cells: Int32Array;
  /** Crowns: leaf (+ branch) area index for the interception capacity. */
  lai?: number;
  ref: number;
}

export interface WaterLedger {
  initial: number;
  precipitation: number;
  vaporIn: number;
  vaporOut: number;
  removed: number;
  floodIn: number;
  floodOut: number;
  crownIn: number;
  final: number;
  transfers: Record<'evaporation' | 'condensation' | 'airCondensation' | 'airEvaporation' | 'freezing' | 'melting' | 'sublimation' | 'deposition' | 'drainage' | 'internalPrecip' | 'transpiration' | 'blowing' | 'soilFreezing' | 'soilThaw' | 'boiling', number>;
}

export interface EnergyLedger {
  initial: number;
  /** Shortwave absorbed by covers and stores (J) — bare surfaces / bodies: thermal ledger `solar`. */
  solar: number;
  /** Net longwave from covers and stores to the sky (J, loss). */
  longwave: number;
  /** Enthalpy of external precipitation entering the world (J). */
  precip: number;
  /** Latent energy of vapour entering / leaving with the background air (J). */
  vaporIn: number;
  vaporOut: number;
  removed: number;
  /** Energy the climate put into thermal nodes (the thermal accounts latent + cover + waterMass), J. */
  toThermal: number;
  /** Heat deposited on covered surfaces that the covers took (J; the thermal ledger booked it as cover −). */
  final: number;
  transfers: { vaporization: number; fusion: number };
}

const KLE_AREA = 1 / (CP_AIR * Math.pow(0.85, 2 / 3));

export class ClimateWorld {
  readonly tw: ThermalWorld;
  readonly spec: ClimateSpec;
  readonly forcing: ClimateForcing;
  readonly n: number;
  readonly nx: number;
  readonly nz: number;
  readonly cellArea: number;
  readonly na: number;
  readonly Tref: number;
  /** Reference pressure (Pa) without an atmosphere experiment. */
  readonly p0: number;
  // ── Covers (cells) ──
  readonly cM: Float64Array;
  readonly cU: Float64Array;
  readonly cIce: Float64Array;
  readonly cRho: Float32Array;
  readonly cAlb: Float32Array;
  readonly cAsh: Float32Array;
  /** Cell temperature / liquid of the cover after the last update (display, friction). */
  readonly cT: Float32Array;
  readonly cLiq: Float32Array;
  readonly coverTile: Uint8Array;
  // ── Soil (cell × layer, kg) ──
  readonly nl: number;
  readonly sW: Float64Array;
  readonly sI: Float64Array;
  /** Freeze–thaw cycles of the surface layer (with water present). */
  readonly ftCycles: Uint16Array;
  private readonly ftFrozen: Uint8Array;
  // ── Air columns ──
  readonly vap: Float64Array;
  readonly cond: Float64Array;
  /** Internal precipitation waiting for the surface step (kg per column). */
  private readonly ipRain: Float64Array;
  private readonly ipSnow: Float64Array;
  /** Enthalpy of that precipitation in transit (J, water reference) — paid by the air when it formed. */
  private readonly ipErain: Float64Array;
  private readonly ipEsnow: Float64Array;
  /** Surface coupling of the ground step. */
  readonly surf: SurfaceClimate;
  // ── Geometry, shortwave ──
  readonly baseAlbedo: Float32Array;
  readonly cosN: Float32Array;
  private readonly nX: Float32Array;
  private readonly nY: Float32Array;
  private readonly nZ: Float32Array;
  readonly shade: Uint8Array;
  /** Top of obstacles per cell (ground + building height, −Infinity none) — shading. */
  readonly obstacleTop: Float32Array;
  readonly groundH: Float32Array;
  private sunDirAt: [number, number, number] = [0, 0, 0];
  sun: SunState = { elevation: -1, dir: [0, -1, 0], direct: 0, diffuse: 0 };
  bg!: BackgroundState;
  /** Air pressure per column (Pa) — an atmosphere experiment writes it, otherwise the reference. */
  pressure: ((a: number) => number) | null = null;
  // ── Object stores ──
  readonly stores: StoreInit[] = [];
  sM = new Float64Array(0);
  sU = new Float64Array(0);
  sIce = new Float64Array(0);
  sRho = new Float32Array(0);
  sAlb = new Float32Array(0);
  sT = new Float32Array(0);
  sGone = new Uint8Array(0);
  // ── Ledgers ──
  readonly water: WaterLedger;
  readonly energy: EnergyLedger;
  /** Climate rain booked in the flood budget's `rain` (m³) and the flood terms at link time. */
  private climateRain = 0;
  private floodBase: { rain: number; sources: number; boundaryIn: number; boundaryOut: number; drainage: number } | null = null;
  private floodSeen = false;
  /** Statistics of the last surface step. */
  readonly last = { evaporation: 0, condensation: 0, melt: 0, freeze: 0, sublimation: 0, precipitation: 0, snowfall: 0, rain: 0, drained: 0, boiled: 0 };
  /** Run totals (kg). */
  readonly totals = { snowfall: 0, rain: 0, melt: 0, meltToFlood: 0, evaporated: 0, condensed: 0, frozenWater: 0 };
  time = 0;
  steps = 0;
  surfaceSteps = 0;
  /** Water whose temperature exceeded the local boiling point (cells, last surface step) and the boiled mass (kg). */
  boilingCells = 0;
  /** Triple-point warning (pressure below 611.657 Pa somewhere). */
  belowTriple = false;
  private readonly node: NodeInput = { M: 0, U: 0, snow: 0, ice: 0, rho: 100, A: 1, Ta: 0, qa: 0, p: 0, u2: 0, pr: 1, Tsky: 0, S: 0, Tb: 0, Gb: 0, dt: 1, open: true };
  private readonly res = emptyResult();
  private readonly tmpA: Float64Array;
  /** Wind at 2 m (m/s) for the covers (set by the adapter each step). */
  u2 = 0;
  /** Layer face velocities of the atmosphere (null: the Phase 26 uniform mean wind). */
  faces: { fx: Float64Array; fz: Float64Array } | null = null;
  /** Uniform mean-wind advection velocity of the layer (m/s, +x / +z). */
  windU = 0;
  windW = 0;
  /** Volcanic ash on the ground per cell (kg/m²) — read for the snow albedo (null: none). */
  ashAt: ((c: number) => number) | null = null;

  constructor(
    tw: ThermalWorld,
    readonly terrain: TerrainData,
    spec: ClimateSpec,
    readonly link: { water: () => ClimateWaterLink | null; ensureWater: () => ClimateWaterLink },
    opts: { p0?: number; obstacleTop?: Float32Array } = {},
  ) {
    this.tw = tw;
    this.spec = spec;
    this.Tref = tw.Tref;
    this.p0 = opts.p0 ?? 101325;
    this.forcing = new ClimateForcing(spec, this.p0);
    const g = tw.terrain;
    this.n = g.count; this.nx = g.nx; this.nz = g.nz; this.cellArea = g.area; this.nl = g.nl;
    this.na = tw.air.count;
    const n = this.n;
    this.cM = new Float64Array(n); this.cU = new Float64Array(n); this.cIce = new Float64Array(n);
    this.cRho = new Float32Array(n).fill(100); this.cAlb = new Float32Array(n).fill(SNOW_ALBEDO_MAX); this.cAsh = new Float32Array(n);
    this.cT = new Float32Array(n).fill(T_MELT); this.cLiq = new Float32Array(n);
    this.coverTile = new Uint8Array(g.ntx * g.ntz);
    this.sW = new Float64Array(n * this.nl); this.sI = new Float64Array(n * this.nl);
    this.ftCycles = new Uint16Array(n); this.ftFrozen = new Uint8Array(n);
    this.vap = new Float64Array(this.na); this.cond = new Float64Array(this.na);
    this.ipRain = new Float64Array(this.na); this.ipSnow = new Float64Array(this.na);
    this.ipErain = new Float64Array(this.na); this.ipEsnow = new Float64Array(this.na);
    this.ipTw = new Float64Array(this.na);
    this.tmpA = new Float64Array(this.na);
    this.surf = {
      covered: new Uint8Array(n), solar: new Float32Array(n), Tsky: this.Tref, qAir: new Float64Array(this.na), pAir: new Float64Array(this.na).fill(this.p0),
      soilWet: new Float32Array(n), evapMax: new Float32Array(n), evapRate: new Float64Array(n), latRate: new Float64Array(n), evap: new Float64Array(n), latent: new Float64Array(n),
    };
    // Geometry: albedo, normals (two-triangle mean slope), ground heights.
    this.baseAlbedo = new Float32Array(n); this.cosN = new Float32Array(n); this.shade = new Uint8Array(n);
    this.nX = new Float32Array(n); this.nY = new Float32Array(n); this.nZ = new Float32Array(n);
    this.groundH = new Float32Array(n);
    this.obstacleTop = opts.obstacleTop ?? new Float32Array(n).fill(-Infinity);
    this.updateGeometry();
    // Antecedent soil water (volumetric θ₀ × layer thickness).
    for (let c = 0; c < n; c++) for (let l = 0; l < this.nl; l++) this.sW[c * this.nl + l] = spec.soilMoisture * g.layers[l] * this.cellArea * RHO_WATER;
    this.bg = this.forcing.background(0);
    // Initial vapour: the background humidity in every column.
    for (let a = 0; a < this.na; a++) this.vap[a] = this.bg.q * this.layerMass(a) / (1 - this.bg.q);
    this.water = { initial: 0, precipitation: 0, vaporIn: 0, vaporOut: 0, removed: 0, floodIn: 0, floodOut: 0, crownIn: 0, final: 0, transfers: { evaporation: 0, condensation: 0, airCondensation: 0, airEvaporation: 0, freezing: 0, melting: 0, sublimation: 0, deposition: 0, drainage: 0, internalPrecip: 0, transpiration: 0, blowing: 0, soilFreezing: 0, soilThaw: 0, boiling: 0 } };
    this.energy = { initial: 0, solar: 0, longwave: 0, precip: 0, vaporIn: 0, vaporOut: 0, removed: 0, toThermal: 0, final: 0, transfers: { vaporization: 0, fusion: 0 } };
    tw.ledger.hasClimate = true;
  }

  // ── Geometry ───────────────────────────────────────────

  /** Normals, ground heights, albedo from the terrain (again after deformation). */
  updateGeometry() {
    const t = this.terrain, vx = t.nx, hs = t.heights, cs = t.cellSize;
    for (let iz = 0; iz < this.nz; iz++) for (let ix = 0; ix < this.nx; ix++) {
      const c = iz * this.nx + ix, v = iz * vx + ix;
      const h00 = hs[v], h10 = hs[v + 1], h01 = hs[v + vx], h11 = hs[v + vx + 1];
      const dx = (h10 + h11 - h00 - h01) / (2 * cs), dz = (h01 + h11 - h00 - h10) / (2 * cs);
      const k = 1 / Math.hypot(dx, 1, dz);
      this.nX[c] = -dx * k; this.nY[c] = k; this.nZ[c] = -dz * k;
      this.groundH[c] = (h00 + 2 * h10 + 2 * h01 + h11) / 6;
      const gt = Math.min(GROUND_ALBEDO.length - 1, t.ground[(iz + 1) * vx + ix + 1]);
      this.baseAlbedo[c] = GROUND_ALBEDO[gt];
    }
    this.sunDirAt = [0, 0, 0];
  }

  /** Incidence and shadows of the cells for the sun direction (terrain + obstacles, ray marching). */
  private updateShade(dir: [number, number, number]) {
    const [sx, sy, sz] = dir;
    const n = this.n, nx = this.nx, nz = this.nz, cs = this.tw.terrain.cell;
    let top = -Infinity;
    for (let c = 0; c < n; c++) { const v = Math.max(this.groundH[c], this.obstacleTop[c]); if (v > top) top = v; }
    const horiz = Math.hypot(sx, sz);
    for (let c = 0; c < n; c++) {
      const cosI = this.nX[c] * sx + this.nY[c] * sy + this.nZ[c] * sz;
      this.cosN[c] = cosI > 0 ? cosI : 0;
      if (sy <= 0 || cosI <= 0) { this.shade[c] = 1; continue; }
      if (horiz < 1e-6) { this.shade[c] = 0; continue; }
      const ix0 = c % nx, iz0 = (c - ix0) / nx;
      const stepX = sx / horiz, stepZ = sz / horiz, rise = (sy / horiz) * cs;
      let x = ix0 + 0.5, z = iz0 + 0.5, y = this.groundH[c] + 0.05;
      let sh = 0;
      for (let k = 0; k < 400; k++) {
        x += stepX; z += stepZ; y += rise;
        if (y > top) break;
        const ix = Math.floor(x), iz = Math.floor(z);
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) break;
        const d = iz * nx + ix;
        if (this.groundH[d] > y || this.obstacleTop[d] > y) { sh = 1; break; }
      }
      this.shade[c] = sh;
    }
    this.sunDirAt = [sx, sy, sz];
  }

  // ── Helpers ────────────────────────────────────────────

  /** Dry-air mass of an air column (kg). */
  layerMass(a: number): number {
    const air = this.tw.air;
    return (air.Ca ? air.Ca[a] : air.C) / CP_AIR;
  }

  /** Specific humidity of a column (kg/kg). */
  q(a: number): number {
    return a < 0 ? this.bg.q : this.vap[a] / (this.layerMass(a) + this.vap[a]);
  }

  /** Pressure of a column (Pa). */
  p(a: number): number {
    return this.pressure && a >= 0 ? this.pressure(a) : this.p0;
  }

  /** Air column above a cell. */
  cellAir(c: number): number {
    const g = this.tw.terrain;
    const [x, z] = g.cellCenter(c);
    return this.tw.air.index(x, z);
  }

  /** Global energy of a cover (J, water reference). */
  private coverEnergy(M: number, U: number) {
    return U + M * C_WATER * (T_MELT - this.Tref);
  }

  private markCover(c: number) {
    const g = this.tw.terrain;
    this.surf.covered[c] = 1;
    const ix = c % g.nx, iz = (c - ix) / g.nx;
    this.coverTile[((iz / 10) | 0) * g.ntx + ((ix / 10) | 0)] = 1;
    g.activateCell(c);
  }

  /** Add frozen mass m (kg) at temperature T (≤ T_m) as snow (density rho) or ice to a cell's cover. */
  private addFrozen(c: number, m: number, T: number, asIce: boolean, rho: number) {
    if (!(m > 0)) return;
    const snowBefore = this.cM[c] - this.cIce[c] - Math.max(0, this.cLiqOf(c));
    if (!asIce) {
      const s = Math.max(0, snowBefore);
      this.cRho[c] = s > 0 ? (s + m) / (s / this.cRho[c] + m / rho) : rho;
    } else this.cIce[c] += m;
    this.cM[c] += m;
    this.cU[c] += m * (C_ICE * (Math.min(T, T_MELT) - T_MELT) - L_F);
    this.markCover(c);
  }

  private cLiqOf(c: number): number {
    const M = this.cM[c];
    if (!(M > 0)) return 0;
    const U = this.cU[c];
    return U >= -L_F * M ? Math.min(M, M + U / L_F) : 0;
  }

  /** Book energy put into thermal nodes by the climate (account of the thermal ledger + toThermal). */
  private toThermal(J: number, account: 'latent' | 'cover' | 'waterMass') {
    this.tw.ledger[account] += J;
    this.energy.toThermal += J;
  }

  private depositAir(a: number, J: number, account: 'latent' | 'cover' | 'waterMass') {
    if (J === 0) return;
    if (a >= 0) this.tw.air.E[a] += J;
    else this.tw.ledger.lost.aboveLayer += J;
    this.toThermal(J, account);
  }

  private depositGround(c: number, J: number, account: 'latent' | 'cover' | 'waterMass') {
    if (J === 0) return;
    this.tw.terrain.E[c * this.nl] += J;
    this.tw.terrain.activateCell(c);
    this.toThermal(J, account);
  }

  private depositWater(w: ClimateWaterLink, c: number, J: number, account: 'latent' | 'cover' | 'waterMass') {
    if (J === 0) return;
    if (w.heat) w.heat[c] += J;
    else this.depositGround(c, J, account);
    if (w.heat) this.toThermal(J, account);
  }

  /** Liquid water into the flood at a cell (kg) carrying enthalpy J (water reference). */
  private toFlood(c: number, kg: number, J: number, kind: 'melt' | 'condensed' | 'rain') {
    if (!(kg > 0)) return;
    const w = this.link.ensureWater();
    this.linkFlood(w);
    const j = w.blocked[c] ? w.redirect[c] : c;
    const dh = kg / (RHO_WATER * w.cellArea);
    w.h[j] += dh;
    const ix = j % w.nx;
    w.touch(ix, (j - ix) / w.nx);
    const vol = kg / RHO_WATER;
    if (kind === 'rain') { w.budget.rain += vol; this.climateRain += vol; }
    else w.budget[kind] += vol;
    this.depositWater(w, j, J, 'waterMass');
  }

  /** First sight of the flood: its booked terms so far are the baseline of the ledger. */
  private linkFlood(w: ClimateWaterLink) {
    if (this.floodSeen) return;
    this.floodSeen = true;
    const b = w.budget;
    this.floodBase = { rain: b.rain, sources: b.sources, boundaryIn: b.boundaryIn, boundaryOut: b.boundaryOut, drainage: b.drainage };
    let inf = 0;
    for (let i = 0; i < w.count; i++) inf += w.infiltrated[i];
    this.infil0 = inf * w.cellArea * RHO_WATER;
    this.infilBudget0 = b.infiltration;
    // Water the flood held when the climate first met it after the start (it activated later): an inflow.
    if (this.steps > 0) this.floodInAct = this.floodStorage(w);
  }

  /**
   * Water held by the flood: surface water plus the event soil water — the latter from the budget's float64
   * infiltration total (the bucket itself is float32) minus what the climate evaporated from it.
   */
  private floodStorage(w: ClimateWaterLink): number {
    return w.totalVolume() * RHO_WATER + this.infil0 + (w.budget.infiltration - this.infilBudget0) * RHO_WATER - this.infilEvap;
  }
  private infil0 = 0;
  private infilBudget0 = 0;
  private infilEvap = 0;

  /**
   * Vapour exchange with a store: dm kg leaves the store (+, evaporation) or enters it (−, condensation) with the
   * store's specific enthalpy hs (J/kg, water reference); latentJ is the latent heat the thermal / cover step
   * already took from (+) or gave to (−) the store. The air node takes the remainder.
   */
  private vaporExchange(a: number, dm: number, hs: number, latentJ: number, latentInThermal: boolean) {
    if (dm === 0 && latentJ === 0) return;
    if (a >= 0) this.vap[a] += dm;
    // Vapour store: L_v per kg (latent).
    const airJ = latentJ - L_V * dm + hs * dm;
    // Thermal side: the latent removed from a thermal node (in-step) was booked by the caller via `latentInThermal`.
    if (latentInThermal) this.toThermal(-latentJ, 'latent');
    this.depositAir(a, airJ, 'latent');
    this.energy.transfers.vaporization += Math.abs(L_V * dm);
  }

  // ── Initial state ──────────────────────────────────────

  /** Starting snow, ice, frozen ground (booked as initial storage). Call once after the stores are registered. */
  applyInitialState() {
    const s = this.spec;
    const g = this.tw.terrain;
    const d = s.initialSnow ?? 0, rho = s.initialSnowDensity ?? 250;
    const Ts = Math.min(this.Tref, T_MELT);
    const w0 = this.link.water();
    if (d > 0) {
      const m = d * rho * this.cellArea;
      for (let c = 0; c < this.n; c++) {
        if (w0 && w0.blocked[c]) continue;
        if (g.covered[c]) continue;
        if (w0 && w0.h[c] > 0.05) continue; // open water: no snow pack on it (ice may carry snow below)
        this.addFrozen(c, m, Ts, false, rho);
      }
      for (let k = 0; k < this.stores.length; k++) {
        const st = this.stores[k];
        if (s.roofSnow === false) continue;
        const per = st.kind === STORE.crown ? Math.min(d * rho, interceptionMax(rho, st.lai ?? 2)) : st.kind === STORE.vehicle ? Math.min(d, 0.3) * rho : d * rho;
        this.addStore(k, per * st.area, Ts, false, rho);
      }
    }
    const ice = s.initialIce ?? 0;
    if (ice > 0 && w0) {
      for (let c = 0; c < this.n; c++) {
        if (w0.blocked[c] || w0.h[c] <= WATER_MERGE) continue;
        const m = Math.min(ice * RHO_ICE * this.cellArea, 0.95 * w0.h[c] * RHO_WATER * w0.cellArea);
        // The ice is the lake's own water frozen: it leaves h (and the water's sensible heat at its temperature).
        const Tw = this.tw.waterT(c);
        const dh = m / (RHO_WATER * w0.cellArea);
        if (w0.heat) w0.heat[c] -= w0.heat[c] * (dh / w0.h[c]);
        w0.h[c] -= dh;
        w0.budget.frozen += m / RHO_WATER;
        this.addFrozen(c, m, Math.min(Tw, T_MELT), true, RHO_ICE);
        if ((d > 0)) this.addFrozen(c, Math.min(d, 0.3) * rho * this.cellArea, Ts, false, rho);
      }
    }
    const frost = s.initialFrost ?? 0;
    if (frost > 0) {
      for (let c = 0; c < this.n; c++) for (let l = 0; l < this.nl; l++) {
        if (g.depthOf(l) >= frost) break;
        const j = c * this.nl + l;
        this.sI[j] += this.sW[j];
        this.sW[j] = 0;
      }
    }
    this.syncIce();
    this.water.initial = this.waterStorage();
    this.energy.initial = this.storeEnergy();
  }

  // ── Stores ─────────────────────────────────────────────

  addStoreSlot(init: StoreInit): number {
    const k = this.stores.length;
    this.stores.push(init);
    const grow = <T extends Float64Array | Float32Array | Uint8Array>(a: T, fill = 0): T => { const b = new (a.constructor as { new (n: number): T })(k + 1); b.set(a as never); (b as unknown as number[])[k] = fill; return b; };
    this.sM = grow(this.sM); this.sU = grow(this.sU); this.sIce = grow(this.sIce); this.sRho = grow(this.sRho, 100); this.sAlb = grow(this.sAlb, SNOW_ALBEDO_MAX); this.sT = grow(this.sT, T_MELT); this.sGone = grow(this.sGone);
    return k;
  }

  private addStore(k: number, m: number, T: number, asIce: boolean, rho: number) {
    if (!(m > 0) || this.sGone[k]) return;
    if (!asIce) {
      const sn = Math.max(0, this.sM[k] - this.sIce[k]);
      this.sRho[k] = sn > 0 ? (sn + m) / (sn / this.sRho[k] + m / rho) : rho;
    } else this.sIce[k] += m;
    this.sM[k] += m;
    this.sU[k] += m * (C_ICE * (Math.min(T, T_MELT) - T_MELT) - L_F);
  }

  /** Move a store's whole content onto its ground cells (collapse, topple). Mass and energy kept. */
  dropStore(k: number) {
    if (this.sGone[k]) return;
    this.sGone[k] = 1;
    const M = this.sM[k], U = this.sU[k], ice = this.sIce[k], rho = this.sRho[k];
    const cells = this.stores[k].cells;
    if (!(M > 0) || !cells.length) { this.sM[k] = 0; this.sU[k] = 0; this.sIce[k] = 0; return; }
    const share = 1 / cells.length;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const sn = Math.max(0, this.cM[c] - this.cIce[c]);
      const add = (M - ice) * share;
      if (add > 0) this.cRho[c] = sn > 0 ? (sn + add) / (sn / this.cRho[c] + add / rho) : rho;
      this.cM[c] += M * share;
      this.cU[c] += U * share;
      this.cIce[c] += ice * share;
      this.markCover(c);
    }
    this.sM[k] = 0; this.sU[k] = 0; this.sIce[k] = 0;
  }

  /** Load of a store (N) — mass × g. */
  storeLoad(k: number, g = 9.81) {
    return this.sM[k] * g;
  }

  // ── Storage sums ───────────────────────────────────────

  waterStorage(): number {
    let s = 0;
    for (let a = 0; a < this.na; a++) s += this.vap[a] + this.cond[a] + this.ipRain[a] + this.ipSnow[a];
    for (let c = 0; c < this.n; c++) s += this.cM[c];
    for (let j = 0; j < this.sW.length; j++) s += this.sW[j] + this.sI[j];
    for (let k = 0; k < this.stores.length; k++) s += this.sM[k];
    const w = this.link.water();
    if (w && this.floodSeen) s += this.floodStorage(w);
    else if (w && !this.floodSeen) { this.linkFlood(w); s += this.floodStorage(w); }
    return s;
  }

  storeEnergy(): number {
    let e = 0;
    for (let a = 0; a < this.na; a++) e += L_V * this.vap[a];
    for (let c = 0; c < this.n; c++) if (this.cM[c] > 0) e += this.coverEnergy(this.cM[c], this.cU[c]);
    for (let j = 0; j < this.sI.length; j++) e -= L_F * this.sI[j];
    for (let k = 0; k < this.stores.length; k++) if (this.sM[k] > 0) e += this.coverEnergy(this.sM[k], this.sU[k]);
    for (let a = 0; a < this.na; a++) e += this.ipErain[a] + this.ipEsnow[a];
    return e;
  }

  waterExpected(): number {
    const L = this.water;
    return L.initial + L.precipitation + L.vaporIn - L.vaporOut - L.removed + L.floodIn - L.floodOut + L.crownIn;
  }

  energyExpected(): number {
    const E = this.energy;
    return E.initial + E.solar - E.longwave + E.precip + E.vaporIn - E.vaporOut - E.removed - E.toThermal;
  }

  /** Refresh the flood-side external terms of the water ledger and the finals. */
  closeLedgers() {
    const w = this.link.water();
    if (w) {
      this.linkFlood(w);
      const b = w.budget, f = this.floodBase!;
      this.water.floodIn = this.floodInAct + ((b.rain - f.rain - this.climateRain) + (b.sources - f.sources) + (b.boundaryIn - f.boundaryIn)) * RHO_WATER;
      this.water.floodOut = ((b.boundaryOut - f.boundaryOut) + (b.drainage - f.drainage)) * RHO_WATER;
    }
    this.water.final = this.waterStorage();
    this.energy.final = this.storeEnergy();
  }
  private floodInAct = 0;

  // ── Before the thermal step ────────────────────────────

  prepare(dt: number, t: number) {
    const tw = this.tw, air = tw.air, s = this.spec;
    const t1 = t + dt;
    this.bg = this.forcing.background(t1, this.p0);
    const bg = this.bg;
    // Air pressure and humidity of the columns (the ground step reads them).
    for (let a = 0; a < this.na; a++) { this.surf.pAir[a] = this.p(a); this.surf.qAir[a] = this.q(a); }
    if (this.surf.pAir.some((p) => p < P_TRIPLE)) this.belowTriple = true;
    this.surf.Tsky = bg.Tsky;
    // Forcing of the air layer.
    if (s.forcing === 'prescribed') {
      for (let a = 0; a < this.na; a++) {
        const C = air.cap(a);
        const E2 = C * (bg.T - this.Tref);
        tw.ledger.climate += E2 - air.E[a];
        air.E[a] = E2;
      }
    } else {
      const f = 1 - Math.exp(-dt / Math.max(1, s.mixTime ?? 900));
      for (let a = 0; a < this.na; a++) {
        const C = air.cap(a);
        const d = (C * (bg.T - this.Tref) - air.E[a]) * f;
        air.E[a] += d;
        tw.ledger.climate += d;
      }
    }
    air.aboveT = bg.T;
    // Venting and edge inflow relative to the background (an atmosphere experiment adds its adiabatic change).
    const atmosShift = this.atmosShift;
    air.ventRef = bg.T + atmosShift;
    air.inflowExcess = bg.T - this.Tref + atmosShift;
    this.steps++;
    this.time = t1;
  }

  /** Free-atmosphere temperature change from an atmosphere experiment (K) — set by the adapter. */
  atmosShift = 0;

  // ── After the thermal step ─────────────────────────────

  after(dt: number, t: number, extra?: { surface?: () => void }) {
    const tw = this.tw;
    if (tw.groundStepped) {
      this.surfaceStep(tw.groundStepDt, t + dt);
      extra?.surface?.();
    }
    this.airStep(dt);
  }

  // ── Surface step ───────────────────────────────────────

  private surfaceStep(dtg: number, tEnd: number) {
    const L = this.last;
    L.evaporation = L.condensation = L.melt = L.freeze = L.sublimation = L.precipitation = L.snowfall = L.rain = L.drained = L.boiled = 0;
    this.surfaceSteps++;
    this.reconcileEvaporation();
    this.precipitate(tEnd - dtg, tEnd);
    this.updateCovers(dtg);
    this.freezeWater();
    this.boilWater();
    this.soilPhase();
    this.updateStoresStep(dtg);
    this.syncIce();
    this.prepareSurface(dtg, tEnd);
  }

  /** Mass of the ground step's evaporation / condensation into / out of the stores and the vapour. */
  private reconcileEvaporation() {
    const sf = this.surf, w = this.link.water(), nl = this.nl, g = this.tw.terrain;
    for (let c = 0; c < this.n; c++) {
      const dm = sf.evap[c], lat = sf.latent[c];
      if (dm === 0 && lat === 0) continue;
      sf.evap[c] = 0; sf.latent[c] = 0;
      const a = this.cellAir(c);
      const wet = !!w && w.h[c] > WATER_MERGE;
      if (wet) {
        // Open water: the latent heat came out of the water node.
        const Tw = this.tw.waterT(c);
        let m = dm;
        const avail = w!.h[c] * RHO_WATER * w!.cellArea;
        if (m > avail) m = avail;
        const hs = C_WATER * (Tw - this.Tref);
        const dh = m / (RHO_WATER * w!.cellArea);
        if (w!.heat) w!.heat[c] -= hs * m;
        this.toThermal(-hs * m, 'waterMass');
        w!.h[c] = Math.max(0, w!.h[c] - dh);
        if (m > 0) { w!.budget.evaporated += m / RHO_WATER; this.water.transfers.evaporation += m; this.totals.evaporated += m; this.last.evaporation += m; }
        else { w!.budget.condensed += -m / RHO_WATER; this.water.transfers.condensation += -m; this.totals.condensed += -m; this.last.condensation += -m; if (w!.h[c] > 0) w!.touch(c % w!.nx, (c / w!.nx) | 0); }
        this.vaporExchange(a, m, hs, lat, true);
        continue;
      }
      const T0 = g.T(c, 0);
      if (dm > 0) {
        // Soil water: the flood's infiltrated water first, then the antecedent water of the top 8 cm.
        let m = dm, from = 0;
        if (w) {
          const inf = w.infiltrated[c] * RHO_WATER * w.cellArea;
          const take = Math.min(inf, m);
          if (take > 0) { w.infiltrated[c] -= take / (RHO_WATER * w.cellArea); this.infilEvap += take; m -= take; from += take; }
        }
        for (let l = 0; l < Math.min(2, nl) && m > 0; l++) {
          const j = c * nl + l;
          const take = Math.min(this.sW[j], m);
          this.sW[j] -= take; m -= take; from += take;
        }
        // The evaporated soil water's sensible heat leaves the surface layer with it.
        const hs = C_WATER * (T0 - this.Tref);
        this.depositGround(c, -hs * from, 'waterMass');
        this.water.transfers.evaporation += from; this.totals.evaporated += from; this.last.evaporation += from;
        this.vaporExchange(a, from, hs, lat * (dm > 0 ? from / dm : 1), true);
        // Latent of the part that found no water stays with the air (a tiny mismatch only when water ran out).
        if (from < dm) this.vaporExchange(a, 0, 0, lat * (1 - from / dm), true);
      } else {
        const m = -dm;
        const vapAvail = a >= 0 ? this.vap[a] : Infinity;
        const got = Math.min(m, Math.max(0, vapAvail));
        if (T0 < T_MELT) {
          // Frost: deposition onto the bare surface (a thin ice cover).
          const hs = C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (T0 - T_MELT);
          this.addFrozen(c, got, T0, true, RHO_ICE);
          this.water.transfers.deposition += got;
          this.vaporExchange(a, -got, hs, lat * (got / m), true);
          if (got < m) this.vaporExchange(a, 0, 0, lat * (1 - got / m), true);
        } else {
          // Dew: into the antecedent water of the surface layer.
          const hs = C_WATER * (T0 - this.Tref);
          this.sW[c * nl] += got;
          this.depositGround(c, hs * got, 'waterMass');
          this.water.transfers.condensation += got; this.totals.condensed += got; this.last.condensation += got;
          this.vaporExchange(a, -got, hs, lat * (got / m), true);
          if (got < m) this.vaporExchange(a, 0, 0, lat * (1 - got / m), true);
        }
      }
    }
  }

  /** External + internal precipitation over [t0, t1): split once into rain / snow, delivered to stores, covers, water. */
  private precipitate(t0: number, t1: number) {
    const P = this.forcing.precipitation(Math.max(0, t0), Math.min(this.spec.duration, t1)); // kg/m²
    if (P > 0) this.externalPrecip(P);
    this.internalPrecip();
  }

  /** External precipitation P (kg/m²): split by the column wet bulb (or the forced phase), caught by stores, then cells. */
  private externalPrecip(P: number) {
    const area = this.spec.area;
    const g = this.tw.terrain, A = this.cellArea, air = this.tw.air;
    const phase = this.spec.precipPhase ?? 'auto';
    const Tw = new Float64Array(this.na), share = new Float64Array(this.na);
    for (let a = 0; a < this.na; a++) {
      Tw[a] = wetBulb(air.T(a), this.q(a), this.p(a));
      share[a] = phase === 'snow' ? 1 : phase === 'rain' ? 0 : snowFraction(Tw[a]);
    }
    const pSnow = new Float64Array(this.n), pRain = new Float64Array(this.n), colOf = new Int32Array(this.n);
    let total = 0;
    for (let c = 0; c < this.n; c++) {
      const a = this.cellAir(c);
      colOf[c] = a;
      if (area) { const [x, z] = g.cellCenter(c); if (Math.hypot(x - area.center[0], z - area.center[1]) > area.radius) continue; }
      const m = P * A;
      pSnow[c] = m * share[a]; pRain[c] = m - pSnow[c];
      total += m;
    }
    this.water.precipitation += total;
    this.last.precipitation += total;
    const snowJ = (m: number, T: number) => m * (C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (Math.min(T, T_MELT) - T_MELT));
    // Stores first (roofs: their blocked cells; crowns: interception; vehicles: their footprint).
    for (let k = 0; k < this.stores.length; k++) {
      if (this.sGone[k]) continue;
      const st = this.stores[k];
      if (!st.cells.length) continue;
      let sn = 0, rn = 0;
      for (let i = 0; i < st.cells.length; i++) { sn += pSnow[st.cells[i]]; rn += pRain[st.cells[i]]; }
      if (!(sn > 0) && !(rn > 0)) continue;
      const a = st.air >= 0 ? st.air : colOf[st.cells[0]];
      const Twa = a >= 0 ? Tw[a] : this.bg.Tw;
      const rhoNew = freshSnowDensity(air.T(a));
      const cellA = st.cells.length * A;
      let catchSnow: number, catchRain = 0;
      const bodyT = st.body >= 0 && this.tw.bodies.alive[st.body] ? this.tw.bodies.TS[st.body] : this.sT[k];
      if (st.kind === STORE.crown) {
        const Imax = interceptionMax(rhoNew, st.lai ?? 2) * st.area;
        catchSnow = intercept(Math.max(0, this.sM[k] - this.sIce[k]), (sn / cellA) * st.area, Imax);
        if (bodyT < T_MELT) catchRain = (rn / cellA) * st.area;
      } else {
        catchSnow = (sn / cellA) * st.area;
        if (this.sM[k] > 0 || bodyT < T_MELT) catchRain = (rn / cellA) * st.area;
      }
      const fs = sn > 0 ? Math.min(1, catchSnow / sn) : 0, fr = rn > 0 ? Math.min(1, catchRain / rn) : 0;
      catchSnow = sn * fs; catchRain = rn * fr;
      for (let i = 0; i < st.cells.length; i++) { const c = st.cells[i]; pSnow[c] *= 1 - fs; pRain[c] *= 1 - fr; }
      if (catchSnow > 0) {
        this.addStore(k, catchSnow, Math.min(Twa, T_MELT), false, rhoNew);
        this.energy.precip += snowJ(catchSnow, Twa);
        this.sAlb[k] = snowAlbedo(this.sAlb[k], 0, false, catchSnow / st.area);
        this.last.snowfall += catchSnow; this.totals.snowfall += catchSnow;
      }
      if (catchRain > 0) {
        this.sM[k] += catchRain;
        this.sU[k] += catchRain * C_WATER * (Twa - T_MELT);
        this.energy.precip += catchRain * C_WATER * (Twa - this.Tref);
        this.last.rain += catchRain; this.totals.rain += catchRain;
      }
    }
    for (let c = 0; c < this.n; c++) {
      const a = colOf[c];
      const Twc = a >= 0 ? Tw[a] : this.bg.Tw;
      if (pSnow[c] > 0) {
        const J = snowJ(pSnow[c], Twc);
        this.energy.precip += J;
        this.deliverSnow(c, pSnow[c], Math.min(Twc, T_MELT), J, freshSnowDensity(air.T(a)));
      }
      if (pRain[c] > 0) {
        const J = pRain[c] * C_WATER * (Twc - this.Tref);
        this.energy.precip += J;
        this.deliverRain(c, pRain[c], Twc, J);
      }
    }
  }

  /** Precipitation formed from the layer condensate (Kessler): its enthalpy is in transit since it formed. */
  private internalPrecip() {
    let any = false;
    for (let a = 0; a < this.na; a++) if (this.ipRain[a] > 0 || this.ipSnow[a] > 0) { any = true; break; }
    if (!any) return;
    const per = new Float64Array(this.na);
    for (let c = 0; c < this.n; c++) { const a = this.cellAir(c); if (a >= 0) per[a]++; }
    for (let c = 0; c < this.n; c++) {
      const a = this.cellAir(c);
      if (a < 0 || !per[a]) continue;
      const f = 1 / per[a];
      if (this.ipSnow[a] > 0) this.deliverSnow(c, this.ipSnow[a] * f, Math.min(this.ipTw[a], T_MELT), this.ipEsnow[a] * f, freshSnowDensity(this.tw.air.T(a)));
      if (this.ipRain[a] > 0) this.deliverRain(c, this.ipRain[a] * f, this.ipTw[a], this.ipErain[a] * f);
    }
    this.ipRain.fill(0); this.ipSnow.fill(0); this.ipErain.fill(0); this.ipEsnow.fill(0);
  }

  /** Snow (kg at T, carrying J) onto a cell: roof cells → their redirect cell; open water melts it; else the cover. */
  private deliverSnow(c: number, m: number, _T: number, J: number, rho: number) {
    const w = this.link.water();
    const j = w && w.blocked[c] ? w.redirect[c] : c;
    if (w && w.h[j] > 0.05 && !(this.cM[j] > 0)) {
      this.toFlood(j, m, J, 'rain');
    } else {
      this.addFrozenJ(j, m, J, rho);
      this.cAlb[j] = snowAlbedo(this.cAlb[j], 0, false, m / this.cellArea);
    }
    this.last.snowfall += m; this.totals.snowfall += m;
  }

  /** Rain (kg at Tw, carrying J) onto a cell: into a cover, else the water (roof cells: Phase 14 redirect). */
  private deliverRain(c: number, m: number, Tw: number, J: number) {
    const w = this.link.water();
    const j = w && w.blocked[c] ? w.redirect[c] : c;
    if (this.cM[j] > 0 && !(w && w.blocked[c])) {
      this.cM[j] += m;
      this.cU[j] += J - m * C_WATER * (T_MELT - this.Tref);
    } else this.toFlood(c, m, J, 'rain');
    void Tw;
    this.last.rain += m; this.totals.rain += m;
  }

  /** Frozen mass with a given global enthalpy J into a cell's cover as snow of density rho. */
  private addFrozenJ(c: number, m: number, J: number, rho: number) {
    if (!(m > 0)) return;
    const s = Math.max(0, this.cM[c] - this.cIce[c] - this.cLiqOf(c));
    this.cRho[c] = s > 0 ? (s + m) / (s / this.cRho[c] + m / rho) : rho;
    this.cM[c] += m;
    this.cU[c] += J - m * C_WATER * (T_MELT - this.Tref);
    this.markCover(c);
  }

  /** Implicit update of every cover; drainage of liquid beyond the holding capacity into the water. */
  private updateCovers(dtg: number) {
    const g = this.tw.terrain, air = this.tw.air, w = this.link.water(), nd = this.node, r = this.res, nl = this.nl;
    const ntx = g.ntx;
    const sun = this.sun;
    const sinB = Math.max(0, Math.sin(sun.elevation));
    for (let t = 0; t < this.coverTile.length; t++) {
      if (!this.coverTile[t]) continue;
      const tx = t % ntx, tz = (t / ntx) | 0;
      let any = false;
      for (let iz = tz * 10; iz < Math.min(this.nz, tz * 10 + 10); iz++) for (let ix = tx * 10; ix < Math.min(this.nx, tx * 10 + 10); ix++) {
        const c = iz * this.nx + ix;
        const M = this.cM[c];
        if (!(M > 0)) continue;
        any = true;
        const a = this.cellAir(c);
        const ice = Math.min(this.cIce[c], M);
        const liq0 = this.cLiqOf(c);
        const snow = Math.max(0, M - ice - liq0);
        const F0 = M - liq0;
        // Albedo of the top: snow (aged, ashy) or ice.
        const ash = this.ashAt ? this.ashAt(c) : 0;
        const alb = snow > 0.5 ? ashyAlbedo(this.cAlb[c], ash) : ashyAlbedo(ICE_ALBEDO, ash);
        const Sin = sun.direct * (this.shade[c] ? 0 : this.cosN[c]) + sun.diffuse;
        nd.M = M; nd.U = this.cU[c]; nd.snow = snow; nd.ice = ice; nd.rho = this.cRho[c]; nd.A = this.cellArea;
        nd.Ta = air.T(a); nd.qa = this.q(a); nd.p = this.p(a); nd.u2 = this.u2; nd.pr = air.prAt(a); nd.Tsky = this.surf.Tsky;
        nd.S = (1 - alb) * Sin; nd.dt = dtg; nd.open = true;
        const wet = !!w && w.h[c] > WATER_MERGE;
        if (wet) {
          const Tw = this.tw.waterT(c);
          const hws = Math.max(5, hWaterSide(Tw, T_MELT));
          nd.Tb = Tw; nd.Gb = hws * this.cellArea;
        } else if (g.covered[c]) {
          nd.Tb = g.T(c, 0); nd.Gb = 0;
        } else {
          const k0 = g.k[c * nl];
          nd.Tb = g.T(c, 0); nd.Gb = this.cellArea / (g.layers[0] / (2 * k0));
        }
        stepNode(nd, r);
        this.cU[c] += r.dU;
        // Below: water or ground surface layer takes the bottom flux.
        const Jb = r.qBottom * dtg;
        if (Jb !== 0) {
          if (wet) this.depositWater(w!, c, Jb, 'cover');
          else if (nd.Gb > 0) this.depositGround(c, Jb, 'cover');
        }
        this.depositAir(a, r.qConv * dtg, 'cover');
        this.energy.solar += r.qSolar * dtg;
        this.energy.longwave += r.qRad * dtg;
        // Sublimation / evaporation (+) or deposition (−) from the cover: mass reconciled now.
        const em = r.evap * dtg;
        if (em !== 0) this.coverVapor(c, a, em, r.qLatent * dtg, r.T);
        // Phase state, drainage, compaction, albedo.
        this.settleCover(c, dtg, wet, F0);
      }
      if (!any) this.coverTile[t] = 0;
    }
    void sinB;
  }

  /** Vapour exchange of a cover (the latent heat was taken in the node update). */
  private coverVapor(c: number, a: number, dm: number, latentJ: number, T: number) {
    const M = this.cM[c];
    let m = dm;
    if (m > 0) {
      if (m > 0.999 * M) m = 0.999 * M;
      // Liquid first (at 0 °C), then snow, then ice.
      const liq = this.cLiqOf(c);
      const fromLiq = Math.min(liq, m), fromIce = m - fromLiq;
      const hsL = C_WATER * (T_MELT - this.Tref);
      const hsI = C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (Math.min(T, T_MELT) - T_MELT);
      this.cM[c] -= m;
      this.cU[c] -= fromIce * (hsI - C_WATER * (T_MELT - this.Tref));
      const hs = m > 0 ? (fromLiq * hsL + fromIce * hsI) / m : hsL;
      this.vaporExchangeStore(a, m, hs, latentJ * (m / dm));
      if (m < dm) this.vaporExchangeStore(a, 0, 0, latentJ * (1 - m / dm));
      this.water.transfers.sublimation += m; this.last.sublimation += m;
    } else {
      const got = Math.min(-m, a >= 0 ? Math.max(0, this.vap[a]) : Infinity);
      const hs = C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (Math.min(T, T_MELT) - T_MELT);
      this.cM[c] += got;
      this.cU[c] += got * (hs - C_WATER * (T_MELT - this.Tref));
      this.vaporExchangeStore(a, -got, hs, latentJ * (got / -m));
      if (got < -m) this.vaporExchangeStore(a, 0, 0, latentJ * (1 + got / m));
      this.water.transfers.deposition += got;
    }
  }

  /** Vapour exchange where the latent heat was taken from a climate store (not a thermal node). */
  private vaporExchangeStore(a: number, dm: number, hs: number, latentJ: number) {
    if (a >= 0) this.vap[a] += dm;
    const airJ = latentJ - L_V * dm + hs * dm;
    this.depositAir(a, airJ, 'latent');
    this.energy.transfers.vaporization += Math.abs(L_V * dm);
  }

  /**
   * After a cover update: the frozen mass changed from F0 — a loss (melt, sublimation) takes snow first, then ice;
   * a gain (refreezing, deposition) is snow where there is snow, ice otherwise. Liquid beyond the holding capacity
   * (5 % of the frozen snow; ice holds none) drains into the water at 0 °C; snow compacts; albedo ages.
   */
  private settleCover(c: number, dt: number, wet: boolean, F0: number) {
    const M = this.cM[c], U = this.cU[c];
    if (!(M > 1e-9)) { this.clearCover(c, wet); return; }
    if (U > 0) {
      // Everything melted and warmed: all of it drains with its enthalpy.
      this.water.transfers.melting += Math.max(0, F0); this.last.melt += Math.max(0, F0); this.totals.melt += Math.max(0, F0);
      this.clearCover(c, wet);
      return;
    }
    const liq = phaseState(U, M).liquid;
    const F = M - liq;
    const ice0 = Math.min(this.cIce[c], F0);
    const snow0 = Math.max(0, F0 - ice0);
    if (F < F0) {
      const lost = F0 - F;
      const fromSnow = Math.min(snow0, lost);
      this.cIce[c] = Math.max(0, ice0 - (lost - fromSnow));
      this.water.transfers.melting += lost; this.last.melt += lost; this.totals.melt += lost;
    } else if (F > F0) {
      if (snow0 < 0.5) this.cIce[c] = ice0 + (F - F0);
      this.water.transfers.freezing += F - F0;
    }
    this.cIce[c] = Math.min(this.cIce[c], F);
    const snowF = Math.max(0, F - this.cIce[c]);
    const drain = Math.max(0, liq - SNOW_HOLDING * snowF);
    if (drain > 1e-12) {
      // Liquid at 0 °C carries 0 relative to 0 °C: U unchanged, M decreases.
      this.cM[c] = M - drain;
      this.drainToWater(c, drain, drain * C_WATER * (T_MELT - this.Tref), wet);
      this.water.transfers.drainage += drain; this.last.drained += drain;
    }
    if (!(this.cM[c] > 1e-9)) { this.clearCover(c, wet); return; }
    const ph = phaseState(this.cU[c], this.cM[c]);
    this.cT[c] = ph.T; this.cLiq[c] = ph.liquid;
    if (snowF > 0) this.cRho[c] = compact(this.cRho[c], ph.T, snowF / this.cellArea, ph.liquid > 0, dt);
    this.cAlb[c] = snowAlbedo(this.cAlb[c], dt, ph.liquid > 0, 0);
  }

  /** Meltwater into the flood (on water: the lake gains it; on ground: runoff / infiltration by Phase 14). */
  private drainToWater(c: number, kg: number, J: number, wet: boolean) {
    void wet;
    this.toFlood(c, kg, J, 'melt');
    this.totals.meltToFlood += kg;
  }

  private clearCover(c: number, wet: boolean) {
    const M = this.cM[c], U = this.cU[c];
    if (M > 0 || U !== 0) {
      // Residual liquid / energy goes to the water or ground below (exactly).
      const J = this.coverEnergy(M, U);
      if (M > 0) this.toFlood(c, M, J, 'melt');
      else { const w = this.link.water(); if (wet && w) this.depositWater(w, c, J, 'cover'); else this.depositGround(c, J, 'cover'); }
    }
    this.cM[c] = 0; this.cU[c] = 0; this.cIce[c] = 0; this.cRho[c] = 100; this.cAlb[c] = SNOW_ALBEDO_MAX; this.cLiq[c] = 0; this.cT[c] = T_MELT;
    this.surf.covered[c] = 0;
  }

  /** Water colder than 0 °C freezes by the deficit (projected enthalpy): dm = (E(0 °C) − E)/L_f. */
  private freezeWater() {
    const w = this.link.water();
    if (!w || !w.heat) return;
    const A = w.cellArea;
    for (let c = 0; c < this.n; c++) {
      const h = w.h[c];
      if (!(h > 0) || w.blocked[c]) continue;
      const M = h * RHO_WATER * A;
      const Em = M * C_WATER * (T_MELT - this.Tref);
      const D = Em - w.heat[c];
      if (!(D > 1e-6)) continue;
      let dm = D / L_F;
      let extraCold = 0;
      if (dm >= M) { extraCold = D - L_F * M; dm = M; }
      // Water left at 0 °C; the frozen mass leaves with its sensible heat at 0 °C and gives L_f to the water.
      w.heat[c] += L_F * dm;
      this.toThermal(L_F * dm, 'latent');
      w.heat[c] -= dm * C_WATER * (T_MELT - this.Tref);
      this.toThermal(-dm * C_WATER * (T_MELT - this.Tref), 'waterMass');
      w.h[c] = dm >= M ? 0 : h - dm / (RHO_WATER * A);
      w.budget.frozen += dm / RHO_WATER;
      this.addFrozen(c, dm, T_MELT, true, RHO_ICE);
      if (extraCold > 0) {
        // Fully frozen: the remaining cold goes into the new ice (it cools below 0 °C).
        w.heat[c] += extraCold;
        this.toThermal(extraCold, 'cover');
        this.cU[c] -= extraCold;
      }
      if (w.h[c] === 0) { this.tw.terrain.E[c * this.nl] += w.heat[c]; w.heat[c] = 0; }
      this.water.transfers.freezing += dm; this.last.freeze += dm; this.totals.frozenWater += dm;
    }
  }

  /** Water hotter than its local boiling point turns the excess enthalpy into vapour (limited phase change). */
  private boilWater() {
    const w = this.link.water();
    this.boilingCells = 0;
    if (!w || !w.heat) return;
    const A = w.cellArea;
    for (let c = 0; c < this.n; c++) {
      const h = w.h[c];
      if (!(h > 0) || w.heat[c] <= 0) continue;
      const a = this.cellAir(c);
      const p = this.p(a);
      // Below the triple point there is no liquid equilibrium: the water boils down to 0 °C (and then freezes).
      const Tb = p > P_TRIPLE ? boilingPointWater(p) : T_MELT;
      const M = h * RHO_WATER * A;
      const Eb = M * C_WATER * (Tb - this.Tref);
      const X = w.heat[c] - Eb;
      if (!(X > 1e-6)) continue;
      this.boilingCells++;
      let dm = X / L_V;
      if (dm > 0.999 * M) dm = 0.999 * M;
      // The excess becomes latent heat of the vapour; the vapour's sensible heat (at Tb) joins the air.
      w.heat[c] -= L_V * dm;
      const hs = C_WATER * (Tb - this.Tref);
      w.heat[c] -= hs * dm;
      this.toThermal(-hs * dm, 'waterMass');
      w.h[c] = h - dm / (RHO_WATER * A);
      w.budget.evaporated += dm / RHO_WATER;
      this.vaporExchange(a, dm, hs, L_V * dm, true);
      this.water.transfers.boiling += dm; this.last.boiled += dm; this.totals.evaporated += dm;
    }
  }

  /** Soil water of the thermal ground layers freezes / thaws by the projected enthalpy at 0 °C. */
  private soilPhase() {
    const g = this.tw.terrain, nl = this.nl;
    g.forActive((c) => {
      for (let l = 0; l < nl; l++) {
        const j = c * nl + l;
        const T = this.Tref + g.E[j] / g.C[j];
        if (T < T_MELT && this.sW[j] > 0) {
          const dm = Math.min(this.sW[j], (g.C[j] * (T_MELT - T)) / L_F);
          g.E[j] += L_F * dm;
          this.toThermal(L_F * dm, 'latent');
          this.sW[j] -= dm; this.sI[j] += dm;
          this.water.transfers.soilFreezing += dm;
          this.energy.transfers.fusion += L_F * dm;
        } else if (T > T_MELT && this.sI[j] > 0) {
          const dm = Math.min(this.sI[j], (g.C[j] * (T - T_MELT)) / L_F);
          g.E[j] -= L_F * dm;
          this.toThermal(-L_F * dm, 'latent');
          this.sI[j] -= dm; this.sW[j] += dm;
          this.water.transfers.soilThaw += dm;
          this.energy.transfers.fusion += L_F * dm;
        }
      }
      // Freeze–thaw cycles of the surface layer.
      const j0 = c * nl;
      const tot = this.sW[j0] + this.sI[j0];
      if (tot > 0) {
        const frozen = this.sI[j0] > 0.5 * tot ? 1 : 0;
        if (this.ftFrozen[c] === 1 && frozen === 0) this.ftCycles[c]++;
        this.ftFrozen[c] = frozen;
      }
    });
  }

  /** Implicit update of the object stores (roofs, crowns, vehicles). */
  private updateStoresStep(dtg: number) {
    const air = this.tw.air, nd = this.node, r = this.res, B = this.tw.bodies;
    for (let k = 0; k < this.stores.length; k++) {
      const M = this.sM[k];
      if (!(M > 0) || this.sGone[k]) continue;
      const st = this.stores[k];
      const a = st.air;
      const ice = Math.min(this.sIce[k], M);
      const liq0 = this.sU[k] >= -L_F * M ? Math.min(M, M + this.sU[k] / L_F) : 0;
      const snow = Math.max(0, M - ice - liq0);
      const alb = snow > 0.1 * st.area ? this.sAlb[k] : ICE_ALBEDO;
      const sun = this.sun;
      const c0 = st.cells[0] ?? 0;
      const Sin = sun.direct * (this.shade[c0] ? 0 : Math.max(0, Math.sin(sun.elevation))) + sun.diffuse;
      nd.M = M; nd.U = this.sU[k]; nd.snow = snow; nd.ice = ice; nd.rho = this.sRho[k]; nd.A = st.area;
      nd.Ta = air.T(a); nd.qa = this.q(a); nd.p = this.p(a); nd.u2 = this.u2; nd.pr = air.prAt(a); nd.Tsky = this.surf.Tsky;
      nd.S = (1 - alb) * Sin; nd.dt = dtg; nd.open = true;
      const body = st.body >= 0 && B.alive[st.body] ? st.body : -1;
      nd.Tb = body >= 0 ? B.TS[body] : nd.Ta;
      nd.Gb = body >= 0 ? st.area / Math.max(1e-3, st.path) : 0;
      stepNode(nd, r);
      this.sU[k] += r.dU;
      if (body >= 0 && r.qBottom !== 0) { B.ES[body] += r.qBottom * dtg; B.refresh(body); this.toThermal(r.qBottom * dtg, 'cover'); }
      this.depositAir(a, r.qConv * dtg, 'cover');
      this.energy.solar += r.qSolar * dtg;
      this.energy.longwave += r.qRad * dtg;
      const em = r.evap * dtg;
      if (em !== 0) {
        if (em > 0) {
          const m = Math.min(em, 0.999 * this.sM[k]);
          const hs = C_WATER * (T_MELT - this.Tref) - (liq0 > 0 ? 0 : L_F - C_ICE * (Math.min(r.T, T_MELT) - T_MELT));
          this.sM[k] -= m;
          this.sU[k] -= m * (hs - C_WATER * (T_MELT - this.Tref));
          this.vaporExchangeStore(a, m, hs, r.qLatent * dtg * (m / em));
          if (m < em) this.vaporExchangeStore(a, 0, 0, r.qLatent * dtg * (1 - m / em));
          this.water.transfers.sublimation += m;
        } else {
          const got = Math.min(-em, a >= 0 ? Math.max(0, this.vap[a]) : Infinity);
          const hs = C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (Math.min(r.T, T_MELT) - T_MELT);
          this.sM[k] += got;
          this.sU[k] += got * (hs - C_WATER * (T_MELT - this.Tref));
          this.vaporExchangeStore(a, -got, hs, r.qLatent * dtg * (got / -em));
          if (got < -em) this.vaporExchangeStore(a, 0, 0, r.qLatent * dtg * (1 + got / em));
          this.water.transfers.deposition += got;
        }
      }
      // Drainage of the store's liquid (drips to its cells); snow holds 5 %, ice / crowns nothing beyond that.
      const Mn = this.sM[k], Un = this.sU[k];
      const ph = phaseState(Un, Mn);
      const liq = Un > 0 ? Mn : ph.liquid;
      const frozen = Mn - liq;
      if (frozen < Math.min(this.sIce[k], Mn)) this.sIce[k] = frozen;
      const hold = SNOW_HOLDING * Math.max(0, frozen - this.sIce[k]);
      const drain = Un > 0 ? Mn : Math.max(0, liq - hold);
      if (drain > 0) {
        const J = Un > 0 ? Mn * C_WATER * (T_MELT - this.Tref) + Un : drain * C_WATER * (T_MELT - this.Tref);
        this.sM[k] = Mn - drain;
        if (Un > 0) this.sU[k] = 0;
        const per = drain / st.cells.length, Jper = J / st.cells.length;
        for (let i = 0; i < st.cells.length; i++) this.toFlood(st.cells[i], per, Jper, 'melt');
        this.water.transfers.drainage += drain;
        this.water.transfers.melting += drain;
      }
      if (!(this.sM[k] > 1e-9)) {
        if (this.sM[k] !== 0 || this.sU[k] !== 0) {
          // A residual: to the first cell's ground.
          const J = this.coverEnergy(this.sM[k], this.sU[k]);
          if (this.sM[k] > 0) this.toFlood(st.cells[0], this.sM[k], J, 'melt'); else this.depositGround(st.cells[0], J, 'cover');
        }
        this.sM[k] = 0; this.sU[k] = 0; this.sIce[k] = 0; this.sAlb[k] = SNOW_ALBEDO_MAX;
        continue;
      }
      const st2 = phaseState(this.sU[k], this.sM[k]);
      this.sT[k] = st2.T;
      const sf = Math.max(0, this.sM[k] - this.sIce[k] - st2.liquid);
      if (sf > 0) this.sRho[k] = compact(this.sRho[k], st2.T, sf / st.area, st2.liquid > 0, dtg);
      this.sAlb[k] = snowAlbedo(this.sAlb[k], dtg, st2.liquid > 0, 0);
    }
  }

  /** Ice arrays of the flood (floating ice weight, friction, frozen-to-bed) and the frozen-soil infiltration factor. */
  syncIce() {
    const w = this.link.water();
    if (!w) return;
    let anyIce = false, anyFrozenSoil = false;
    for (let c = 0; c < this.n; c++) if (this.cIce[c] > 0 && w.h[c] > 0) { anyIce = true; break; }
    for (let c = 0; c < this.n && !anyFrozenSoil; c++) if (this.sI[c * this.nl] > 0) anyFrozenSoil = true;
    if (anyIce || w.iceLoad) {
      const L = (w.iceLoad ??= new Float64Array(w.count));
      const F = (w.iceFric ??= new Float32Array(w.count).fill(1));
      const Z = (w.frozen ??= new Uint8Array(w.count));
      for (let c = 0; c < this.n; c++) {
        const ice = this.cM[c] > 0 ? this.cM[c] : 0;
        L[c] = ice / (RHO_WATER * w.cellArea);
        const iceThick = this.cIce[c] / (RHO_ICE * this.cellArea);
        // Sabaneev composite roughness with ice n_i = 0.02 and half the hydraulic radius under a cover: n² × ≈ 2.5.
        F[c] = this.cIce[c] > 0 && iceThick > 0.005 ? 2.5 : 1;
        Z[c] = this.cIce[c] > 0 && iceThick > 0.002 && w.h[c] < 0.005 ? 1 : 0;
      }
    }
    if (anyFrozenSoil || w.infilFactor) {
      const f = (w.infilFactor ??= new Float32Array(w.count).fill(1));
      for (let c = 0; c < this.n; c++) {
        const i0 = this.sI[c * this.nl] + this.sI[c * this.nl + 1], w0 = this.sW[c * this.nl] + this.sW[c * this.nl + 1];
        const Q = i0 + w0 > 0 ? i0 / (i0 + w0) : 0;
        f[c] = Math.pow(10, -7 * Q);
      }
    }
  }

  /** Shortwave of the bare surfaces, soil wetness and evaporation caps for the next ground step. */
  private prepareSurface(dtg: number, t: number) {
    const sun = (this.sun = this.forcing.sun(t));
    const d = sun.dir, o = this.sunDirAt;
    if (sun.elevation > 0 && (o[1] === 0 || d[0] * o[0] + d[1] * o[1] + d[2] * o[2] < Math.cos((1 * Math.PI) / 180))) this.updateShade(d);
    const w = this.link.water(), sf = this.surf, nl = this.nl;
    const up = sun.elevation > 0;
    for (let c = 0; c < this.n; c++) {
      const wet = !!w && w.h[c] > WATER_MERGE;
      const alb = wet ? WATER_ALBEDO : this.baseAlbedo[c];
      sf.solar[c] = up ? (1 - alb) * (sun.direct * (this.shade[c] ? 0 : this.cosN[c]) + sun.diffuse) : 0;
      if (wet) { sf.evapMax[c] = (w!.h[c] * RHO_WATER * w!.cellArea) / dtg; sf.soilWet[c] = 0; continue; }
      // Soil: water of the top 8 cm (antecedent + the flood's infiltrated water), Sellers et al. (1992) resistance.
      const top = this.sW[c * nl] + (nl > 1 ? this.sW[c * nl + 1] : 0) + (w ? w.infiltrated[c] * RHO_WATER * w.cellArea : 0);
      const cap = 0.45 * 0.08 * RHO_WATER * this.cellArea;
      const W = Math.min(1, top / cap);
      sf.evapMax[c] = top / dtg;
      if (!(top > 0)) { sf.soilWet[c] = 0; continue; }
      const rs = Math.exp(8.206 - 4.255 * W);
      // Share of the free-water transfer: 1/(1 + r_s·h_m/ρ) with h_m/ρ ≈ (5 W/(m²K)) / (c_p·Le^(2/3)) / 1.2.
      const hm = 5 * KLE_AREA / 1.2;
      sf.soilWet[c] = 1 / (1 + rs * hm);
    }
  }

  // ── Air step (every thermal step) ──────────────────────

  private airStep(dt: number) {
    const air = this.tw.air, s = this.spec, bg = this.bg;
    const na = this.na;
    // Background vapour per column at the background humidity.
    const vbg = (a: number) => (bg.q * this.layerMass(a)) / (1 - bg.q);
    // Transport (edges bring background air).
    const g = { nx: air.nx, nz: air.nz, dx: 5 };
    let fx: Float64Array, fz: Float64Array;
    if (this.faces) { fx = this.faces.fx; fz = this.faces.fz; }
    else {
      fx = (this.ufx ??= new Float64Array((air.nx + 1) * air.nz)); fz = (this.ufz ??= new Float64Array(air.nx * (air.nz + 1)));
      fx.fill(this.windU); fz.fill(this.windW);
    }
    const c = courant(g, fx, fz, dt);
    if (c > 0) {
      const nsub = substepsFor(c);
      const v0 = this.sumVap();
      const r = advectFaces(g, this.vap, fx, fz, dt, nsub, this.tmpA, vbg);
      void r;
      const dv = this.sumVap() - v0;
      this.bookVaporBoundary(dv);
      if (this.cond.some((x) => x > 0)) { const c0 = this.sumCond(); advectFaces(g, this.cond, fx, fz, dt, nsub, this.tmpA); this.bookCondensateBoundary(this.sumCond() - c0); }
    }
    // Buoyant venting and boundary-layer mixing with the background (flux), or the prescribed humidity.
    let dmix = 0;
    if (s.forcing === 'prescribed') {
      for (let a = 0; a < na; a++) { const t = vbg(a); dmix += t - this.vap[a]; this.vap[a] = t; }
    } else {
      const f = 1 - Math.exp(-dt / Math.max(1, s.mixTime ?? 900));
      for (let a = 0; a < na; a++) {
        const u = air.updraft(a);
        const v = u > 0 ? 1 - Math.exp((-u * dt) / air.H) : 0;
        const share = 1 - (1 - f) * (1 - v);
        const d = (vbg(a) - this.vap[a]) * share;
        this.vap[a] += d;
        dmix += d;
      }
    }
    this.bookVaporBoundary(dmix);
    // Saturation adjustment (condensation at liquid saturation) and re-evaporation of condensate.
    for (let a = 0; a < na; a++) {
      const m = this.layerMass(a), p = this.p(a), C = air.cap(a), T = air.T(a);
      const ad = saturationAdjust(T, this.vap[a], m, p, C);
      if (ad.dm > 0) {
        this.vap[a] -= ad.dm;
        this.cond[a] += ad.dm;
        air.E[a] += L_V * ad.dm;
        this.toThermal(L_V * ad.dm, 'latent');
        this.water.transfers.airCondensation += ad.dm;
        this.energy.transfers.vaporization += L_V * ad.dm;
      } else if (this.cond[a] > 0) {
        const qs = qSat(T, p);
        const q = this.vap[a] / (m + this.vap[a]);
        if (q < qs) {
          // Evaporate toward saturation with the cooling it causes (linear estimate, bounded by the condensate).
          const deficit = (qs - q) * m / (1 + (L_V * L_V * qs) / (CP_AIR * 461.5 * T * T));
          const e = Math.min(this.cond[a], Math.max(0, deficit));
          if (e > 0) {
            this.cond[a] -= e; this.vap[a] += e;
            air.E[a] -= L_V * e;
            this.toThermal(-L_V * e, 'latent');
            this.water.transfers.airEvaporation += e;
          }
        }
      }
      // Kessler autoconversion → internal precipitation (rain, or snow — the freezing heats the air).
      if (this.cond[a] > 0) {
        const pr = autoconversion(this.cond[a], m, dt);
        if (pr > 0) {
          this.cond[a] -= pr;
          const Tw = wetBulb(T, this.vap[a] / (m + this.vap[a]), p);
          const sf = snowFraction(Tw);
          const sn = pr * sf, rn = pr - sn;
          // The precipitation leaves the air with the enthalpy it will carry (rain at Tw; snow frozen at min(Tw, 0 °C)).
          const Ts = Math.min(Tw, T_MELT);
          const J = rn * C_WATER * (Tw - this.Tref) + sn * (C_WATER * (T_MELT - this.Tref) - L_F + C_ICE * (Ts - T_MELT));
          air.E[a] -= J;
          this.toThermal(-J, 'latent');
          this.ipRain[a] += rn; this.ipSnow[a] += sn;
          this.ipErain[a] += rn * C_WATER * (Tw - this.Tref);
          this.ipEsnow[a] += J - rn * C_WATER * (Tw - this.Tref);
          this.ipTw[a] = Tw;
          this.water.transfers.internalPrecip += pr;
          if (sn > 0) this.energy.transfers.fusion += L_F * sn;
        }
      }
    }
    // Humidity read by the ground step.
    for (let a = 0; a < na; a++) this.surf.qAir[a] = this.q(a);
  }
  private ipTw: Float64Array;
  private ufx: Float64Array | null = null;
  private ufz: Float64Array | null = null;

  private sumVap() { let s = 0; for (let a = 0; a < this.na; a++) s += this.vap[a]; return s; }
  private sumCond() { let s = 0; for (let a = 0; a < this.na; a++) s += this.cond[a]; return s; }

  /** Vapour change by exchange with the background air (kg, + in): mass and latent energy. */
  private bookVaporBoundary(dv: number) {
    if (dv > 0) { this.water.vaporIn += dv; this.energy.vaporIn += L_V * dv; }
    else if (dv < 0) { this.water.vaporOut -= dv; this.energy.vaporOut -= L_V * dv; }
  }

  private bookCondensateBoundary(dc: number) {
    if (dc < 0) this.water.vaporOut -= dc; else this.water.vaporIn += dc;
  }

  /** Vapour / condensate removed with air by an atmosphere experiment (share per column). */
  removeWithAir(a: number, share: number) {
    if (!(share > 0)) return;
    const v = this.vap[a] * share, cd = this.cond[a] * share;
    this.vap[a] -= v; this.cond[a] -= cd;
    this.water.removed += v + cd;
    this.energy.removed += L_V * v;
  }

  // ── Queries ────────────────────────────────────────────

  /** Snow depth (m), SWE (kg/m²), ice thickness (m) of a cell. */
  snowDepth(c: number): number {
    const sn = Math.max(0, this.cM[c] - this.cIce[c] - this.cLiq[c]);
    return sn > 0 ? sn / (this.cRho[c] * this.cellArea) : 0;
  }
  swe(c: number): number {
    return Math.max(0, this.cM[c] - this.cIce[c]) / this.cellArea;
  }
  iceThickness(c: number): number {
    return this.cIce[c] / (RHO_ICE * this.cellArea);
  }

  /** Relative humidity of a column (over water). */
  rh(a: number): number {
    const p = this.p(a), T = this.tw.air.T(a);
    const qs = qSat(T, p);
    const q = this.q(a);
    return qs > 0 ? (q / (1 - q)) / (qs / (1 - qs)) : 0;
  }

  /** Background specific humidity for a relative humidity at T (kg/kg). */
  static humidity(RH: number, T: number, p: number) {
    return humidityFromRH(RH, T, p);
  }

  /** Cover temperature of a cell (K, T_m without cover). */
  coverT(c: number): number {
    return this.cM[c] > 0 ? Math.min(T_MELT, phaseState(this.cU[c], this.cM[c]).T) : T_MELT;
  }

  /** Effective radiative surroundings of a body's outdoor faces: sky for its top, half sky / half ground for walls (K). */
  bodyTrad(top: number, side: number, Ta: number): number {
    const A = top + side;
    if (!(A > 0)) return Ta;
    const f = (top + 0.5 * side) / A;
    const T4 = f * this.surf.Tsky ** 4 + (1 - f) * Ta ** 4;
    return Math.pow(T4, 0.25);
  }

  /** Heat deposited on a covered cell goes into its cover (melting it) — ThermalWorld.coverSink. */
  coverSink(c: number, J: number): boolean {
    if (!(this.cM[c] > 0)) return false;
    this.cU[c] += J;
    this.energy.toThermal -= J;
    return true;
  }

  /** Mean emissivity-weighted, used by visuals. */
  static readonly EPS = EPS_SNOW;
  /** Albedo of the ground of a cell now (cover / water / ground). */
  albedo(c: number): number {
    if (this.cM[c] > 0) return this.swe(c) > 0.5 ? this.cAlb[c] : ICE_ALBEDO;
    const w = this.link.water();
    return w && w.h[c] > WATER_MERGE ? WATER_ALBEDO : this.baseAlbedo[c];
  }

  /** Convection coefficient of a horizontal surface (for previews). */
  static hc(Ts: number, Ta: number, u2: number) {
    return hGround(Ts, Ta, u2);
  }

  /** Evaporation rate estimate of open water at Tw (kg/(m²·s)). */
  static openWaterEvaporation(Tw: number, Ta: number, qa: number, p: number, u2: number) {
    return hGround(Tw, Ta, u2) * KLE_AREA * (qSat(Tw, p) - qa);
  }

  /** Kept for API symmetry. */
  static readonly L = { V: L_V, F: L_F, S: L_S };
}
