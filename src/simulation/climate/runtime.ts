/**
 * Climate adapter of a run (Phase 30): connects the pure ClimateWorld to the thermal state (temperatures), the
 * flood (liquid water, soil bucket, ice arrays), the atmosphere (pressure, flow, removal), the fire model (crown
 * water), the volcano (ash on snow) and the objects (roof / crown / vehicle stores, structural snow loads, roads,
 * contact friction, people's exposure).
 *
 * Inside the ThermalSystem, every 0.1 s:
 *   prepare  background state → air-layer forcing (flux relaxation / prescribed), surface coupling of the ground step
 *   (volcano, fire, thermal step)
 *   after    surface step when the ground step ran (covers, phase changes, stores, shortwave); vapour transport and
 *            condensation every step; each second: stores ↔ objects, roof loads (5 s, quantized), trees, roads,
 *            crown water (transpiration / drying), statistics, milestones
 * One experiment per run (a second is rejected with a reason). Iteration orders are cell / column indices and the
 * runtime's insertion order — never object ids.
 */
import type { SystemContext } from '../systems/SimulationSystem';
import type { ThermalRuntime } from '../thermal/runtime';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { ClimateRecord } from './ClimateChannel';
import { ClimateWorld, STORE, type ClimateWaterLink, type StoreInit } from '@/climate/ClimateWorld';
import { climateIssues, climateWarnings, type ClimateSpec } from '@/climate/types';
import { C_WATER, FROZEN_ICE_FRACTION, L_V, RHO_WATER, T_MELT } from '@/climate/constants';
import { frictionFactor, surfaceState, SURFACE_STATES, SURF } from '@/climate/surfaceState';
import { dewPointChecked, qSat, vapourPressure } from '@/climate/psychro';
import { qRotate } from '@/core/math';
import { GRAVITY } from '@/core/units';
import { DamageState } from '../damage/DamageState';
import { activate, structureOf } from '../structure/state';
import { MT_ROOF } from '@/structure/graph';
import { MS } from '@/structure/types';
import { IK } from '@/fire/FireWorld';
import { WET_GRIP } from '../systems/GroundContactSystem';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import { TK, type Deposit, type SourceStep } from '@/thermal/ThermalWorld';
import { simProfiler as P } from '../profiling/SimProfiler';

/** Roof snow load (kPa) below which it is not passed to the structural model — EN 1991-1-1 roof category H q_k = 0.4 kPa. */
export const ROOF_SCREEN_KPA = 0.4;
/** Re-apply a roof load when it changed by this share of the member capacity or this load (kPa). */
const LOAD_QUANTUM = 0.02;
const LOAD_QUANTUM_KPA = 0.05;
/** Seconds between roof-load updates of a building. */
const LOAD_EVERY = 5;
/** Snow + ice on a crown (kg per m² of crown projection) from which stems / large branches break — indicative (Nykänen et al. 1997: ≈ 20–30 kg/m²). */
export const CROWN_BREAK = 20;
/** Snow depth (m) from which a road is impassable for ordinary vehicles — indicative. */
export const ROAD_SNOW_IMPASSABLE = 0.25;
/** Roof thermal resistance between a building's envelope node and its roof snow (m²K/W, U ≈ 0.4 W/(m²K)). */
const ROOF_R = 2.5;
/** Canopy conductance for transpiration (m/s; forests 5–20 mm/s, Kelliher et al. 1995 — 10 mm/s assumed) and the cuticular share left when the soil is dry. */
const CANOPY_G = 0.01;
const CUTICULAR = 0.2;
/** Live foliage moisture floor (kg/kg) — crowns do not dry below it while alive (assumed). */
export const LIVE_MOISTURE_FLOOR = 0.6;
/** Soil wilting point / field capacity (volumetric) for the transpiration supply. */
const THETA_WP = 0.08, THETA_FC = 0.3;
/** Shortwave albedo of bodies (buildings, vehicles, crowns) — representative. */
const BODY_ALBEDO = 0.3;
/** Snow depth (m) from which walking is reported as restricted — indicative. */
export const WALK_SNOW = 0.3;

export interface ClimateStats {
  meanAirT: number;
  minAirT: number;
  maxAirT: number;
  meanSurfaceT: number;
  minSurfaceT: number;
  maxSurfaceT: number;
  meanRH: number;
  vapour: number;
  condensate: number;
  snowMass: number;
  iceMass: number;
  storeMass: number;
  maxSnowDepth: number;
  meanSnowDepth: number;
  snowCells: number;
  iceCells: number;
  maxIce: number;
  frozenSoilCells: number;
  frostDepth: number;
  meltwater: number;
  evaporation: number;
  evaporationRate: number;
  precipRate: number;
  boilingCells: number;
  maxRoofLoad: number;
  roofsLoaded: number;
  roadsIcy: number;
  roadsSnow: number;
  roadsImpassable: number;
  treesBroken: number;
  waterResidual: number;
  energyResidual: number;
  thermalResidual: number;
  sunElevation: number;
  solar: number;
  Tsky: number;
  bgT: number;
  bgRH: number;
  freezeThaw: number;
  solidPrecip: number;
  /** Cover safety floor: times it acted and the energy it moved below (J, ≤ 0) — 0 when every node stays physical. */
  floorClamps: number;
  floorEnergy: number;
}

export interface ClimateSample { t: number; T: number; Ts: number; rh: number; snow: number; ice: number; melt: number; evap: number; P: number }
export const SERIES_MAX = 1800;

interface StoreRef { k: number; e: RuntimeEntity; nextLoad: number; applied: Float64Array | null; broken: boolean }
interface CrownRef { e: RuntimeEntity; store: number; u: number; dry: number; lai: number; cells: Int32Array }

export class ClimateRuntime {
  readonly cw: ClimateWorld;
  readonly rec: ClimateRecord;
  readonly spec: ClimateSpec;
  readonly trt: ThermalRuntime;
  readonly warnings: string[];
  readonly stores: StoreRef[] = [];
  readonly roofOf = new Map<RuntimeEntity, number>();
  readonly crowns: CrownRef[] = [];
  readonly crownOf = new Map<RuntimeEntity, CrownRef>();
  readonly series: ClimateSample[] = [];
  private seriesEvery = 1;
  private nextSample = 0;
  private nextSecond = 0;
  private nextMilestones = 0;
  private milestonesDone = new Set<string>();
  private readonly st: ClimateStats;
  private statsAt = -1;
  private readonly env: SystemContext['env'];
  ms = 0;
  msTotal = 0;
  /** Peak snowfall rate (kg/s over the world) and when. */
  private peakSnow = 0;
  private peakSnowT = 0;
  private peakMelt = 0;
  private peakMeltT = 0;
  private lastMelt = 0;
  private lastSnow = 0;
  private lastEvap = 0;
  private terrainRev = 0;

  constructor(ctx: SystemContext, rec: ClimateRecord, trt: ThermalRuntime) {
    this.rec = rec;
    this.spec = rec.spec;
    this.trt = trt;
    this.env = ctx.env;
    const w = trt.world;
    this.warnings = climateWarnings(rec.spec);
    if (Math.abs(w.Tref - rec.spec.temperature) > 1e-9) this.warnings.push('climate.warn.ambientKept');
    const t = ctx.env.terrain.data;
    const g = w.terrain;
    // Obstacle tops for the shading (buildings, walls).
    const top = new Float32Array(g.count).fill(-Infinity);
    for (const e of ctx.runtime.entities.values()) {
      const ty = e.source.type;
      if (ty !== 'building' && ty !== 'wall') continue;
      const yg = ctx.env.terrain.sampleHeight(e.pose.position[0], e.pose.position[2]);
      for (const c of this.footprint(e)) top[c] = Math.max(top[c], yg + e.dims[1]);
    }
    const atm = ctx.env.atmosphere.rt;
    this.cw = new ClimateWorld(w, t, rec.spec, {
      water: () => ctx.env.flood.field as ClimateWaterLink | null,
      ensureWater: () => {
        const f = ctx.env.flood.field ?? ctx.env.flood.activate(ctx.time);
        trt.attachWater(ctx);
        return f as ClimateWaterLink;
      },
    }, { p0: atm ? atm.p0 : 101325, obstacleTop: top });
    this.terrainRev = ctx.env.deformation.engine?.rev ?? 0;
    this.registerStores(ctx);
    this.cw.applyInitialState();
    this.cw.prof = (k, t0) => P.add(k, t0);
    this.cw.now = () => P.now();
    // Couplings into the thermal state (all null without a climate — the Phase 26–29 paths).
    const B = w.bodies, air = w.air;
    w.climate = this.cw.surf;
    w.coverSink = (c, J) => this.cw.coverSink(c, J);
    w.bodyTrad = (i) => this.cw.bodyTrad(B.Atop[i], B.Av[i], air.T(B.air[i]));
    trt.climateLOD = true;
    for (let k = 0; k < g.ntx * g.ntz; k++) g.activateTile(k);
    // Volcanic ash on the snow (albedo).
    this.cw.ashAt = (c) => {
      const vr = ctx.env.volcano.rt;
      if (!vr) return 0;
      const f = vr.world.field;
      const [x, z] = g.cellCenter(c);
      const v = f.index(x, z);
      return v >= 0 ? f.depA[v] / f.area : 0;
    };
    this.st = this.emptyStats();
  }

  static reject(rec: ClimateRecord, existing: ClimateRuntime | null): string | null {
    if (existing) return 'climate.reject.second';
    return climateIssues(rec.spec)[0] ?? null;
  }

  // ── Geometry ───────────────────────────────────────────

  /** Thermal / water cells whose centre lies in an object's oriented footprint (grown by margin). */
  footprint(e: RuntimeEntity, margin = 0): number[] {
    const g = this.trt.world.terrain;
    const p = e.pose.position, q = e.pose.quaternion;
    const hx = e.dims[0] / 2 + margin, hz = e.dims[2] / 2 + margin;
    const ax = qRotate(q, [1, 0, 0]), az = qRotate(q, [0, 0, 1]);
    const r = Math.hypot(hx, hz);
    const out: number[] = [];
    const ix0 = Math.max(0, Math.floor((p[0] - r - g.originX) / g.cell)), ix1 = Math.min(g.nx - 1, Math.floor((p[0] + r - g.originX) / g.cell));
    const iz0 = Math.max(0, Math.floor((p[2] - r - g.originZ) / g.cell)), iz1 = Math.min(g.nz - 1, Math.floor((p[2] + r - g.originZ) / g.cell));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = g.originX + (ix + 0.5) * g.cell - p[0], z = g.originZ + (iz + 0.5) * g.cell - p[2];
      const lx = x * ax[0] + z * ax[2], lz = x * az[0] + z * az[2];
      if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) out.push(iz * g.nx + ix);
    }
    if (!out.length) { const c = g.index(p[0], p[2]); if (c >= 0) out.push(c); }
    return out;
  }

  /** Disc of cells under a crown. */
  private disc(x: number, z: number, r: number): number[] {
    const g = this.trt.world.terrain, out: number[] = [];
    for (let iz = Math.max(0, Math.floor((z - r - g.originZ) / g.cell)); iz <= Math.min(g.nz - 1, Math.floor((z + r - g.originZ) / g.cell)); iz++)
      for (let ix = Math.max(0, Math.floor((x - r - g.originX) / g.cell)); ix <= Math.min(g.nx - 1, Math.floor((x + r - g.originX) / g.cell)); ix++) {
        const cx = g.originX + (ix + 0.5) * g.cell, cz = g.originZ + (iz + 0.5) * g.cell;
        if (Math.hypot(cx - x, cz - z) <= r) out.push(iz * g.nx + ix);
      }
    if (!out.length) { const c = g.index(x, z); if (c >= 0) out.push(c); }
    return out;
  }

  /** Roofs of buildings, crowns of trees, tops of vehicles. */
  private registerStores(ctx: SystemContext) {
    const trt = this.trt, cw = this.cw, w = trt.world;
    const leafy = this.spec.temperature >= T_MELT + 10;
    for (const te of trt.ents) {
      const e = te.e, ty = e.source.type;
      if (ty !== 'building' && ty !== 'tree' && ty !== 'car') continue;
      if (!te.active) trt.activate(ctx, te);
      const p = e.pose.position;
      const a = w.air.index(p[0], p[2], 0);
      if (ty === 'building') {
        const cells = Int32Array.from(this.footprint(e));
        const init: StoreInit = { kind: STORE.roof, area: Math.max(1, e.dims[0] * e.dims[2]), air: w.air.index(p[0], p[2], Math.min(w.air.H, e.dims[1])), body: te.body, path: ROOF_R, cells, ref: this.stores.length };
        const k = cw.addStoreSlot(init);
        this.stores.push({ k, e, nextLoad: 0, applied: null, broken: false });
        this.roofOf.set(e, k);
      } else if (ty === 'tree') {
        const pr = e.source.params as Record<string, number | string>;
        const r = Number(pr.canopyRadius ?? 2);
        const lai = pr.species === 'conifer' ? 3.5 : leafy ? 3 : 0.7;
        const cells = Int32Array.from(this.disc(p[0], p[2], r));
        const k = cw.addStoreSlot({ kind: STORE.crown, area: Math.PI * r * r, air: a, body: te.body, path: 0.05, cells, lai, ref: this.stores.length });
        this.stores.push({ k, e, nextLoad: 0, applied: null, broken: false });
        const B = w.bodies;
        const u0 = ctx.env.fire.settings.foliageMoisture;
        const dry = te.body >= 0 ? B.mS[te.body] / (1 + 1.5) : 0;
        const cr: CrownRef = { e, store: k, u: u0, dry, lai, cells };
        this.crowns.push(cr);
        this.crownOf.set(e, cr);
      } else {
        const cells = Int32Array.from(this.footprint(e));
        const k = cw.addStoreSlot({ kind: STORE.vehicle, area: Math.max(0.5, e.dims[0] * e.dims[2]), air: a, body: te.body, path: 0.01, cells, ref: this.stores.length });
        this.stores.push({ k, e, nextLoad: 0, applied: null, broken: false });
      }
    }
  }

  // ── Before the thermal step ────────────────────────────

  /** Shortwave on bodies: deposit weights rebuilt every 10 s (the sun moves ≈ 2.5° per 10 min). */
  private solarStep: SourceStep | null = null;
  private solarAt = -Infinity;
  private solarPower = 0;

  private bodySolar(ctx: SystemContext, dt: number): SourceStep[] {
    const cw = this.cw, sun = cw.sun;
    if (this.spec.solar === 'off' || !(sun.elevation > 0)) return [];
    if (!this.solarStep || ctx.time - this.solarAt >= 10) {
      this.solarAt = ctx.time;
      const B = this.trt.world.bodies, g = this.trt.world.terrain;
      const sinB = Math.sin(sun.elevation), cosB = Math.cos(sun.elevation);
      // The top of a body under a store (roof, vehicle top, crown) takes the shortwave its snow does not cover — the
      // store takes the rest (ClimateWorld.storeCover): one split, never both.
      const covered = new Map<number, number>();
      for (const s of this.stores) {
        const b = cw.stores[s.k].body;
        if (b < 0) continue;
        const f = cw.storeCover(s.k);
        if (f > (covered.get(b) ?? 0)) covered.set(b, f);
      }
      const deposits: Deposit[] = [];
      let P = 0;
      for (let i = 0; i < B.n; i++) {
        if (!B.alive[i] || !(B.fOut[i] > 0)) continue;
        const c = g.index(B.x[i], B.z[i]);
        const lit = c >= 0 && cw.shade[c] === 0 ? 1 : 0;
        const top = B.Atop[i] * (1 - (covered.get(i) ?? 0));
        const p = (1 - BODY_ALBEDO) * B.fOut[i] * (sun.direct * lit * (sinB * top + (cosB * B.Av[i]) / Math.PI) + sun.diffuse * (top + B.Av[i] / 2));
        if (p > 0) { deposits.push({ kind: TK.body, index: i, w: p, a: top + B.Av[i] / 2 }); P += p; }
      }
      for (const d of deposits) d.w /= P;
      this.solarPower = P;
      this.solarStep = { id: 'climate:solar', energy: 0, deposits, solar: true };
    }
    if (!(this.solarPower > 0)) return [];
    this.solarStep.energy = this.solarPower * dt;
    return [this.solarStep];
  }

  prepare(ctx: SystemContext, dt: number): SourceStep[] {
    const t0 = performance.now();
    const w = this.trt.world, cw = this.cw;
    const local = ctx.time - this.rec.start;
    cw.u2 = w.u10 * Math.pow(0.2, 0.14);
    const U = w.u10 * Math.pow(Math.max(0.5, w.air.H / 2) / 10, 0.14);
    cw.windU = U * w.flowX; cw.windW = U * w.flowZ;
    const atm = ctx.env.atmosphere.rt;
    if (atm) {
      const f = atm.field;
      cw.pressure = (a) => f.surfacePressure(a);
      cw.faces = atm.faces;
      cw.atmosShift = f.Tcol - atm.T0;
      if (atm.lastRemoved) for (const a of atm.lastRemoved.list) cw.removeWithAir(a, atm.lastRemoved.share[a]);
    }
    // Terrain changed (deformation): slopes, heights, shading again.
    const rev = ctx.env.deformation.engine?.rev ?? 0;
    if (rev !== this.terrainRev) { this.terrainRev = rev; cw.updateGeometry(); }
    // Store bodies of buildings refined to member detail: the roof member nearest the centre.
    for (const s of this.stores) {
      const st = cw.stores[s.k];
      const te = this.trt.byEntity.get(s.e.id);
      if (te && st.body >= 0 && !w.bodies.alive[st.body]) st.body = te.body >= 0 ? te.body : this.roofBody(te);
    }
    cw.prepare(dt, local);
    const steps = this.bodySolar(ctx, dt);
    this.ms = performance.now() - t0;
    return steps;
  }

  private roofBody(te: { b: { g: { n: number; type: Uint8Array }; body: Int32Array | number[] } | null }): number {
    const bt = te.b;
    if (!bt) return -1;
    const B = this.trt.world.bodies;
    for (let i = 0; i < bt.g.n; i++) if (bt.g.type[i] === MT_ROOF && bt.body[i] >= 0 && B.alive[bt.body[i]]) return bt.body[i];
    return -1;
  }

  // ── After the thermal step ─────────────────────────────

  after(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const w = this.trt.world;
    const local = ctx.time - this.rec.start;
    this.cw.after(dt, local, { surface: (dtg) => this.surface(ctx, dtg) });
    w.ledger.final = w.internalEnergy();
    if (ctx.time + 1e-9 >= this.nextSecond) {
      this.nextSecond = ctx.time + 1;
      const tp = P.now();
      this.objects(ctx);
      this.roads(ctx);
      P.add('climate.objects', tp);
      // Milestones read the full statistics (a sweep of every cell): every 5 s (precipitation arrives in 5 s steps).
      if (ctx.time + 1e-9 >= this.nextMilestones) {
        this.nextMilestones = ctx.time + 5;
        const tm = P.now();
        this.milestones(ctx);
        P.add('climate.stats', tm);
      }
    }
    if (ctx.time + 1e-9 >= this.nextSample) {
      this.nextSample = ctx.time + this.seriesEvery;
      const s = this.stats;
      this.series.push({ t: ctx.time, T: s.meanAirT, Ts: s.meanSurfaceT, rh: s.meanRH, snow: s.snowMass, ice: s.iceMass, melt: s.meltwater, evap: s.evaporation, P: s.precipRate });
      if (this.series.length > SERIES_MAX) {
        let k = 0;
        for (let i = 0; i < this.series.length; i += 2) this.series[k++] = this.series[i];
        this.series.length = k;
        this.seriesEvery *= 2;
      }
    }
    this.ms += performance.now() - t0;
    this.msTotal += this.ms;
  }

  /** Local 10 m wind per air column (Phase 15 field with building wakes), refreshed every 10 s while it blows. */
  private windCol: Float32Array | null = null;
  private windAt = -Infinity;

  /** After each surface step (1 s): blowing snow, crowns' water (transpiration, drying, fire model sync). */
  private surface(ctx: SystemContext, dtg: number) {
    const cw = this.cw, w = this.trt.world, B = w.bodies;
    if (this.spec.blowingSnow !== false && ctx.env.wind.baseSpeed > 4 && cw.stats0()) {
      const air = w.air;
      if (!this.windCol || ctx.time - this.windAt >= 10) {
        this.windAt = ctx.time;
        this.windCol ??= new Float32Array(air.count);
        for (let a = 0; a < air.count; a++) {
          const ix = a % air.nx, iz = (a - ix) / air.nx;
          const x = air.originX + (ix + 0.5) * 5, z = air.originZ + (iz + 0.5) * 5;
          const y = ctx.env.terrain.sampleHeight(x, z) + 2;
          // 2 m sample → 10 m by the project's power law (exponent 0.14).
          this.windCol[a] = ctx.env.windField.sample([x, y, z], ctx.time).speed * Math.pow(5, 0.14);
        }
      }
      const wc = this.windCol;
      const fl = ctx.env.wind.flow();
      const wf = ctx.env.flood.field;
      cw.blowSnow(dtg, fl[0], fl[2], (c) => { const a = cw.cellAir(c); return a >= 0 ? wc[a] : 0; }, wf ? wf.blocked : this.blocked());
    }
    const fire = ctx.env.fire.rt;
    const sunUp = cw.sun.elevation > 0;
    for (const cr of this.crowns) {
      const te = this.trt.byEntity.get(cr.e.id);
      const b = te ? te.body : -1;
      if (b < 0 || !B.alive[b] || cr.e.flags.toppled || cr.e.flags.snapped) continue;
      const a = B.air[b];
      const p = cw.p(a);
      const TL = B.TS[b];
      if (TL <= T_MELT) continue; // frozen foliage: no transpiration
      const rho = p / (287.05 * Math.max(200, w.air.T(a)));
      const proj = cw.stores[cr.store].area;
      const deficit = Math.max(0, qSat(TL, p) - cw.q(a));
      const demand = CANOPY_G * (sunUp ? 1 : 0.1) * rho * deficit * proj * dtg; // kg
      if (!(demand > 0)) continue;
      // Soil supply: root-zone water (antecedent, all layers) under the crown, by the wetness of the zone.
      let water = 0;
      const nl = cw.nl;
      for (const c of cr.cells) for (let l = 0; l < nl; l++) water += cw.sW[c * nl + l];
      const zone = cr.cells.length * cw.cellArea * w.terrain.depthOf(nl - 1) + cr.cells.length * cw.cellArea * w.terrain.layers[nl - 1];
      const theta = water / (RHO_WATER * zone);
      const beta = Math.max(0, Math.min(1, (theta - THETA_WP) / (THETA_FC - THETA_WP)));
      const fromSoil = Math.min(water, demand * beta);
      const crownWater = cr.u * cr.dry;
      const floorWater = LIVE_MOISTURE_FLOOR * cr.dry;
      const fromCrown = Math.min(Math.max(0, crownWater - floorWater), demand * (1 - beta) * CUTICULAR);
      if (fromSoil > 0) {
        const f = fromSoil / water;
        for (const c of cr.cells) for (let l = 0; l < nl; l++) cw.sW[c * nl + l] *= 1 - f;
      }
      if (fromCrown > 0) { cr.u -= fromCrown / Math.max(1e-9, cr.dry); cw.water.crownIn += fromCrown; }
      cw.transpire(a, b, fromSoil + fromCrown);
      // The fire model's crown water follows (same item water array — no second moisture state).
      if (fire && fromCrown > 0) for (const i of fire.bodyItems.get(b) ?? []) if (fire.fw.kind[i] === IK.foliage && !fire.fw.gone[i]) fire.fw.water[i] = Math.min(fire.fw.water[i], cr.u * fire.fw.m[i]);
    }
  }

  private blockedCells: Uint8Array | null = null;
  /** Building / wall footprints (blowing snow settles in front of them) when the flood grid does not exist. */
  private blocked(): Uint8Array {
    if (this.blockedCells) return this.blockedCells;
    const m = new Uint8Array(this.cw.n);
    for (const s of this.stores) if (s.e.source.type === 'building') for (const c of this.cw.stores[s.k].cells) m[c] = 1;
    return (this.blockedCells = m);
  }

  /** Crown moisture of a tree for the fire model (kg water / kg dry), null when not tracked. */
  crownMoisture(e: RuntimeEntity): number | null {
    const cr = this.crownOf.get(e);
    return cr ? cr.u : null;
  }

  // ── Objects (each second) ──────────────────────────────

  private objects(ctx: SystemContext) {
    const cw = this.cw;
    for (const s of this.stores) {
      const e = s.e, st = cw.stores[s.k];
      if (cw.sGone[s.k]) continue;
      if (st.kind === STORE.roof) {
        const gone = e.flags.collapsed || e.flags.toppled || (e.modular ? Number.isFinite(e.modular.collapsedFrom) : false);
        if (gone) { cw.dropStore(s.k); this.once(ctx, `roofDrop:${e.id}`, 'snowFromRoof', { kg: 0 }); continue; }
        if (ctx.time >= s.nextLoad) { s.nextLoad = ctx.time + LOAD_EVERY; this.roofLoad(ctx, s); }
      } else if (st.kind === STORE.crown) {
        if (e.flags.toppled || e.flags.snapped || e.flags.uprooted) { cw.dropStore(s.k); continue; }
        const load = cw.sM[s.k] / st.area;
        const cs = this.climateState(e);
        cs.load = load;
        if (load >= CROWN_BREAK && !s.broken && e.body !== null) {
          s.broken = true;
          ctx.physics.setBodyKind(e.body, 'dynamic');
          e.dynamic = true;
          e.flags.snapped = true;
          cs.damage = 1;
          e.state = DamageState.DESTROYED;
          e.lastHazard = 'climate';
          e.lastCause = cw.sIce[s.k] > 0.5 * cw.sM[s.k] ? 'iceLoad' : 'snowLoad';
          ctx.recordDamage(e, { eventType: 'SNAPPED', cause: e.lastCause, hazard: 'climate', response: load, force: cw.sM[s.k] * GRAVITY, source: 'climate' });
          ctx.log(e.id, 'danger', { key: 'log.climate.treeBroken', params: { kg: load.toFixed(0) } });
          this.once(ctx, 'treeBroken', 'snowLoadDamage', { what: 'tree', kg: load.toFixed(0) });
          cw.dropStore(s.k);
        }
      } else {
        const cs = this.climateState(e);
        cs.load = cw.sM[s.k] / st.area;
      }
    }
    // People: surface state under them (exposure; no physiology).
    const g = this.trt.world.terrain;
    for (const e of ctx.runtime.entities.values()) {
      if (e.source.type !== 'human') continue;
      const c = g.index(e.pose.position[0], e.pose.position[2]);
      if (c < 0) continue;
      const cs = this.climateState(e);
      cs.snow = cw.snowDepth(c);
      cs.ice = cw.iceThickness(c);
      cs.restricted = cs.snow >= WALK_SNOW || cs.ice > 0.001;
      cs.airT = this.trt.world.air.T(this.trt.world.air.index(e.pose.position[0], e.pose.position[2], 1));
      cs.minAirT = Math.min(cs.minAirT, cs.airT);
      cs.maxAirT = Math.max(cs.maxAirT, cs.airT);
    }
  }

  climateState(e: RuntimeEntity) {
    return (e.climate ??= { load: 0, loadKPa: 0, damage: 0, snow: 0, ice: 0, restricted: false, airT: 0, minAirT: Infinity, maxAirT: -Infinity, applied: false });
  }

  /** Snow / ice on a roof: weight on the roof members (modular buildings, static surcharge, hazard climate). */
  private roofLoad(ctx: SystemContext, s: StoreRef) {
    const e = s.e, cw = this.cw, st = cw.stores[s.k];
    const M = cw.sM[s.k];
    const kPa = (M * GRAVITY) / st.area / 1000;
    const cs = this.climateState(e);
    cs.load = M / st.area;
    cs.loadKPa = kPa;
    if (!e.modular) return; // other buildings: the load is reported only
    if (kPa < ROOF_SCREEN_KPA && !cs.applied) return;
    const g = structureOf(e, ctx).model.g;
    const model = e.modular.structure!.model;
    if (!s.applied) s.applied = new Float64Array(g.n);
    let A = 0;
    for (let i = 0; i < g.n; i++) if (g.type[i] === MT_ROOF && !g.absent[i]) A += (g.box[6 * i + 3] - g.box[6 * i]) * (g.box[6 * i + 5] - g.box[6 * i + 2]);
    if (A <= 0) return;
    let changed = false;
    for (let i = 0; i < g.n; i++) {
      if (g.type[i] !== MT_ROOF || g.absent[i] || model.state[i] >= MS.FAILED) continue;
      const a = (g.box[6 * i + 3] - g.box[6 * i]) * (g.box[6 * i + 5] - g.box[6 * i + 2]);
      const N = (M * GRAVITY * a) / A;
      const q = Math.max(LOAD_QUANTUM * Math.max(1, g.capN[i] || g.mass[i] * GRAVITY), LOAD_QUANTUM_KPA * 1000 * a);
      if (Math.abs(N - s.applied[i]) > q) {
        model.addLoad(i, N - s.applied[i], 'climate');
        s.applied[i] = N;
        changed = true;
      }
    }
    if (changed) { cs.applied = true; activate(e, ctx); }
  }

  // ── Roads (each second) ────────────────────────────────

  private roads(ctx: SystemContext) {
    const roads = ctx.runtime.roads;
    if (!roads) return;
    const cw = this.cw, g = this.trt.world.terrain, wf = ctx.env.flood.field;
    for (const st of roads.segments) {
      let snow = 0, ice = 0, film = 0, Ts = Infinity, fric = Infinity, state = SURF.dry as number;
      for (const p of st.samples) {
        const c = g.index(p.x, p.z);
        if (c < 0) continue;
        const d = cw.snowDepth(c), i = cw.iceThickness(c), hw = wf ? wf.h[c] : 0;
        snow = Math.max(snow, d); ice = Math.max(ice, i); film = Math.max(film, hw);
        Ts = Math.min(Ts, cw.cM[c] > 0 ? cw.coverT(c) : g.T(c, 0));
        const s = surfaceState(cw.swe(c) * cw.cellArea, cw.cIce[c] / cw.cellArea, cw.cLiq[c] / cw.cellArea, hw, cw.cRho[c]);
        const f = frictionFactor(1, cw.swe(c) * cw.cellArea, cw.cIce[c] / cw.cellArea, cw.cLiq[c] / cw.cellArea, cw.cRho[c], WET_GRIP, hw);
        if (f < fric) { fric = f; state = s; }
      }
      if (!Number.isFinite(Ts)) continue;
      const prev = st.climate;
      if (!prev && snow < 0.001 && ice < 1e-4 && state === SURF.dry) continue;
      const impassable = snow >= ROAD_SNOW_IMPASSABLE;
      st.climate = { snow, ice, film, surfaceT: Ts, friction: Number.isFinite(fric) ? fric * 0.55 : 0.55, state: SURFACE_STATES[state], impassable, peakSnow: Math.max(prev?.peakSnow ?? 0, snow), peakIce: Math.max(prev?.peakIce ?? 0, ice) };
      roads.rev++;
      if ((state === SURF.ice || state === SURF.wetIce) && !prev?.iced) {
        st.climate.iced = true;
        ctx.log(null, 'warn', { key: 'log.climate.roadIcing', params: { id: st.id } });
        this.once(ctx, 'roadIce', 'roadIcing', { id: st.id });
      } else if (prev?.iced) st.climate.iced = true;
      if (impassable && roads.mark(st, 'impassable', ctx.time, snow)) ctx.log(null, 'danger', { key: 'log.climate.roadSnow', params: { id: st.id, m: snow.toFixed(2) } });
    }
  }

  /** Contact friction factor at a point (multiplier of an object's own friction): ground factor × cover state. */
  frictionAt(x: number, z: number, groundFactor: number, waterDepth: number): number {
    // The contact patches (wheels, feet) ring the body: the mean of four points 1.2 m around its centre — the cell under
    // a parked car is sheltered by it, the road around is not.
    const cw = this.cw, g = this.trt.world.terrain;
    let s = 0, n = 0;
    for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
      const c = g.index(x + dx, z + dz);
      if (c < 0) continue;
      s += frictionFactor(groundFactor, cw.swe(c) * cw.cellArea, cw.cIce[c] / cw.cellArea, cw.cLiq[c] / cw.cellArea, cw.cRho[c], WET_GRIP, waterDepth);
      n++;
    }
    return n ? s / n : groundFactor;
  }

  // ── Probe (inspector) ──────────────────────────────────

  probe(x: number, z: number) {
    const cw = this.cw, w = this.trt.world, g = w.terrain;
    const c = g.index(x, z);
    if (c < 0) return null;
    const a = w.air.index(x, z);
    const p = cw.p(a), q = cw.q(a), T = w.air.T(a);
    const e = vapourPressure(q, p);
    const wf = this.env.flood.field;
    const nl = cw.nl;
    let soilW = 0, soilI = 0, frost = 0;
    for (let l = 0; l < nl; l++) { soilW += cw.sW[c * nl + l]; soilI += cw.sI[c * nl + l]; if (cw.sI[c * nl + l] > FROZEN_ICE_FRACTION * (cw.sI[c * nl + l] + cw.sW[c * nl + l])) frost = g.depthOf(l) + g.layers[l]; }
    const hw = wf ? wf.h[c] : 0;
    return {
      airT: T, rh: cw.rh(a), q, dew: dewPointChecked(e), p, surfaceT: cw.cM[c] > 0 ? cw.coverT(c) : hw > WATER_MERGE ? w.waterT(c) : g.T(c, 0),
      snowDepth: cw.snowDepth(c), swe: cw.swe(c), snowDensity: cw.cRho[c], iceThickness: cw.iceThickness(c), liquid: cw.cLiq[c] / cw.cellArea,
      albedo: cw.albedo(c), solar: cw.surf.solar[c], shade: cw.shade[c] === 1, water: hw, soilWater: soilW / cw.cellArea, soilIce: soilI / cw.cellArea, frostDepth: frost,
      freezeThaw: cw.ftCycles[c], state: SURFACE_STATES[surfaceState(cw.swe(c) * cw.cellArea, cw.cIce[c] / cw.cellArea, cw.cLiq[c] / cw.cellArea, hw, cw.cRho[c])],
      friction: this.frictionAt(x, z, 1, hw) * 0.55, condensate: cw.cond[a] ?? 0, Tsky: cw.surf.Tsky,
    };
  }

  // ── Stats & milestones ─────────────────────────────────

  get stats(): ClimateStats {
    if (this.statsAt !== this.cw.steps) { this.statsAt = this.cw.steps; this.statsTime = this.cw.time; this.refresh(); }
    return this.st;
  }

  /**
   * Statistics for displays at the publish rate: a full sweep of every cell (and the ledgers' finals) at most once per
   * `maxAge` simulated seconds — the HUD read the exact getter 10× a second (≈ 30 ms of main thread per second).
   */
  liveStats(maxAge = 1): ClimateStats {
    if (this.statsAt < 0 || this.cw.time - this.statsTime >= maxAge) return this.stats;
    return this.st;
  }
  private statsTime = -Infinity;

  private emptyStats(): ClimateStats {
    return {
      meanAirT: 0, minAirT: 0, maxAirT: 0, meanSurfaceT: 0, minSurfaceT: 0, maxSurfaceT: 0, meanRH: 0, vapour: 0, condensate: 0, snowMass: 0, iceMass: 0, storeMass: 0,
      maxSnowDepth: 0, meanSnowDepth: 0, snowCells: 0, iceCells: 0, maxIce: 0, frozenSoilCells: 0, frostDepth: 0, meltwater: 0, evaporation: 0, evaporationRate: 0, precipRate: 0,
      boilingCells: 0, maxRoofLoad: 0, roofsLoaded: 0, roadsIcy: 0, roadsSnow: 0, roadsImpassable: 0, treesBroken: 0, waterResidual: 0, energyResidual: 0, thermalResidual: 0,
      sunElevation: 0, solar: 0, Tsky: 0, bgT: 0, bgRH: 0, freezeThaw: 0, solidPrecip: 0, floorClamps: 0, floorEnergy: 0,
    };
  }

  private refresh() {
    const cw = this.cw, w = this.trt.world, g = w.terrain, air = w.air, s = this.st;
    let Ts = 0, rh = 0, Tmin = Infinity, Tmax = -Infinity, sTmin = Infinity, sTmax = -Infinity, sTs = 0, vap = 0, cond = 0;
    for (let a = 0; a < air.count; a++) { const T = air.T(a); Ts += T; if (T < Tmin) Tmin = T; if (T > Tmax) Tmax = T; rh += cw.rh(a); vap += cw.vap[a]; cond += cw.cond[a]; }
    s.meanAirT = Ts / air.count; s.minAirT = Tmin; s.maxAirT = Tmax; s.meanRH = rh / air.count; s.vapour = vap; s.condensate = cond;
    let snow = 0, ice = 0, maxD = 0, sumD = 0, nS = 0, nI = 0, maxI = 0, frozen = 0, frost = 0, ft = 0;
    const wf = this.env.flood.field, nl = cw.nl;
    for (let c = 0; c < cw.n; c++) {
      const T = cw.cM[c] > 0 ? cw.coverT(c) : wf && wf.h[c] > WATER_MERGE ? w.waterT(c) : g.T(c, 0);
      sTs += T; if (T < sTmin) sTmin = T; if (T > sTmax) sTmax = T;
      if (cw.cM[c] > 0) {
        snow += Math.max(0, cw.cM[c] - cw.cIce[c]); ice += cw.cIce[c];
        const d = cw.snowDepth(c);
        if (d > 0.001) { nS++; sumD += d; if (d > maxD) maxD = d; }
        const it = cw.iceThickness(c);
        if (it > 0.001) { nI++; if (it > maxI) maxI = it; }
      }
      if (cw.sI[c * nl] > FROZEN_ICE_FRACTION * (cw.sI[c * nl] + cw.sW[c * nl])) {
        frozen++;
        for (let l = 0; l < nl; l++) if (cw.sI[c * nl + l] > FROZEN_ICE_FRACTION * (cw.sI[c * nl + l] + cw.sW[c * nl + l])) frost = Math.max(frost, g.depthOf(l) + g.layers[l]);
      }
      ft = Math.max(ft, cw.ftCycles[c]);
    }
    s.meanSurfaceT = sTs / cw.n; s.minSurfaceT = sTmin; s.maxSurfaceT = sTmax;
    s.snowMass = snow; s.iceMass = ice; s.maxSnowDepth = maxD; s.meanSnowDepth = nS ? sumD / nS : 0; s.snowCells = nS; s.iceCells = nI; s.maxIce = maxI;
    s.frozenSoilCells = frozen; s.frostDepth = frost; s.freezeThaw = ft;
    let sm = 0, roofMax = 0, roofs = 0, broken = 0;
    for (const r of this.stores) {
      sm += cw.sM[r.k];
      const st = cw.stores[r.k];
      if (st.kind === STORE.roof) { const k = (cw.sM[r.k] * GRAVITY) / st.area / 1000; if (k > roofMax) roofMax = k; if (k >= ROOF_SCREEN_KPA) roofs++; }
      if (r.broken) broken++;
    }
    s.storeMass = sm; s.maxRoofLoad = roofMax; s.roofsLoaded = roofs; s.treesBroken = broken;
    s.meltwater = cw.totals.meltToFlood; s.evaporation = cw.totals.evaporated;
    s.evaporationRate = cw.rates.evaporation; s.precipRate = cw.forcing.precipRate(this.cw.time);
    s.solidPrecip = cw.totals.snowfall;
    s.boilingCells = cw.boilingCells;
    let icy = 0, sn = 0, imp = 0;
    for (const st of (this.trtRoads() ?? [])) { if (st.climate?.state === 'ice' || st.climate?.state === 'wetIce') icy++; if ((st.climate?.snow ?? 0) > 0.01) sn++; if (st.climate?.impassable) imp++; }
    s.roadsIcy = icy; s.roadsSnow = sn; s.roadsImpassable = imp;
    cw.closeLedgers();
    const wScale = Math.max(1, cw.water.initial + cw.water.precipitation + cw.water.vaporIn + cw.water.floodIn + cw.water.crownIn);
    s.waterResidual = Math.abs(cw.water.final - cw.waterExpected()) / wScale;
    const eScale = Math.max(1, Math.abs(cw.energy.initial) + Math.abs(cw.energy.vaporIn) + Math.abs(cw.energy.vaporOut) + Math.abs(cw.energy.toThermal) + cw.energy.solar + cw.energy.longwave + Math.abs(cw.energy.precip));
    s.energyResidual = Math.abs(cw.energy.final - cw.energyExpected()) / eScale;
    s.thermalResidual = w.ledger.relativeResidual();
    s.sunElevation = cw.sun.elevation;
    s.solar = cw.sun.elevation > 0 ? cw.sun.direct * Math.sin(cw.sun.elevation) + cw.sun.diffuse : 0;
    s.Tsky = cw.surf.Tsky; s.bgT = cw.bg.T; s.bgRH = cw.bg.RH;
    s.floorClamps = cw.floorClamps; s.floorEnergy = cw.floorEnergy;
  }

  private roadsRef: { segments: { climate?: { state: string; snow: number; impassable: boolean } }[] } | null = null;
  setRoads(r: { segments: { climate?: { state: string; snow: number; impassable: boolean } }[] } | null) { this.roadsRef = r; }
  private trtRoads() { return this.roadsRef?.segments ?? null; }

  private once(ctx: SystemContext, key: string, kind: import('../analysis/MilestoneRecorder').MilestoneKind, params: Record<string, string | number>, time = ctx.time) {
    if (this.milestonesDone.has(key)) return;
    this.milestonesDone.add(key);
    ctx.milestone?.({ time, kind, hazard: 'climate', subject: 'climate', label: { key: `milestone.${kind}` as import('@/i18n/i18n').MessageKey, params } }, `climate:${key}`);
  }

  private milestones(ctx: SystemContext) {
    this.setRoads(ctx.runtime.roads as never);
    const s = this.stats, sp = this.spec, cw = this.cw, name = this.rec.name;
    const start = this.rec.start;
    this.once(ctx, 'start', 'climateStart', { id: name, scenario: sp.scenario, T0: (sp.temperature - T_MELT).toFixed(1), T1: (sp.target - T_MELT).toFixed(1) }, start);
    if (sp.target > sp.temperature + 3 || sp.scenario === 'heatwave') this.once(ctx, 'heat', 'heatwaveStart', { T: (sp.target - T_MELT).toFixed(1) }, start);
    if (sp.target < sp.temperature - 3 || sp.scenario === 'coldWave') this.once(ctx, 'cold', 'coldWaveStart', { T: (sp.target - T_MELT).toFixed(1) }, start);
    const snowNow = cw.totals.snowfall;
    const dS = snowNow - this.lastSnow; this.lastSnow = snowNow;
    if (dS > 0) {
      this.once(ctx, 'firstSnow', 'firstSnow', { kg: dS.toFixed(0) });
      if (dS > this.peakSnow) { this.peakSnow = dS; this.peakSnowT = ctx.time; }
    }
    if (this.peakSnow > 0 && dS < 0.5 * this.peakSnow && ctx.time > this.peakSnowT + 5) this.once(ctx, 'peakSnow', 'peakSnowfall', { rate: ((this.peakSnow / (cw.n * cw.cellArea)) * 3600).toFixed(2) }, this.peakSnowT);
    if (cw.totals.frozenWater > 0 || s.frozenSoilCells > 0) this.once(ctx, 'firstFreeze', 'firstFreezing', { kg: cw.totals.frozenWater.toFixed(0) });
    // First measurable ice on water (1 mm): growth is limited by the heat the surface loses (≈ 2–3 mm per 25 min at −20 °C).
    if (s.maxIce > 0.001) this.once(ctx, 'lakeIce', 'lakeIce', { cm: (s.maxIce * 100).toFixed(1) });
    if (s.maxRoofLoad >= ROOF_SCREEN_KPA) this.once(ctx, 'roofLoad', 'snowLoadDamage', { what: 'roof', kPa: s.maxRoofLoad.toFixed(2) });
    const melt = cw.totals.melt;
    const dM = melt - this.lastMelt; this.lastMelt = melt;
    if (dM > 0.1) {
      this.once(ctx, 'thaw', 'thawStart', { kg: dM.toFixed(1) });
      if (dM > this.peakMelt) { this.peakMelt = dM; this.peakMeltT = ctx.time; }
    }
    if (this.peakMelt > 0 && dM < 0.5 * this.peakMelt && ctx.time > this.peakMeltT + 5) this.once(ctx, 'peakMelt', 'peakSnowmelt', { kgps: this.peakMelt.toFixed(1) }, this.peakMeltT);
    const wf = this.env.flood.field;
    if (wf && cw.totals.meltToFlood > 0 && wf.stats.floodedCells > 0) this.once(ctx, 'meltFlood', 'snowmeltFlood', { m3: (cw.totals.meltToFlood / RHO_WATER).toFixed(1) });
    if (ctx.time >= start + sp.duration) this.once(ctx, 'end', 'climateEnd', { id: name }, start + sp.duration);
    const dE = cw.totals.evaporated - this.lastEvap; this.lastEvap = cw.totals.evaporated;
    void dE;
    if (cw.belowTriple) this.warnOnce(ctx, 'triple', 'log.climate.belowTriple', {});
    if (s.boilingCells > 0) this.warnOnce(ctx, 'boiling', 'log.climate.boiling', { n: s.boilingCells });
  }

  private warnOnce(ctx: SystemContext, key: string, msg: string, params: Record<string, string | number>) {
    if (this.milestonesDone.has(`w:${key}`)) return;
    this.milestonesDone.add(`w:${key}`);
    ctx.log(null, 'warn', { key: msg as import('@/i18n/i18n').MessageKey, params });
  }

  /** Latent heat helper for tests / inspector. */
  static readonly LV = L_V;
  static readonly CW = C_WATER;
}
