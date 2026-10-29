/**
 * Atmosphere adapter of a run (Phase 29): connects the pure AtmosphereField to the thermal state (the
 * owner of the air temperature), the fire model (O₂, room gas, smoke transport), the volcano (gas, ash,
 * bombs) and the systems that read the air (wind forces, water, blast, impact).
 *
 * Inside the ThermalSystem, every 0.1 s:
 *   prepare  plan → forcing (removal / restoration / local sink, background state) + volcanic gas →
 *            field step (mass, column flow, pressure work, layer flow) → the layer columns' new heat
 *            capacity and temperature (thermal ledger `airMass`), density and pressure ratio; the removed
 *            air's O₂ deficit; rooms follow the outdoor pressure; the layer face velocities for the
 *            thermal / smoke transport; the free atmosphere as the venting reference
 *   (volcano, fire, thermal step — they read the air from here)
 *   after    volcanic gas transport and venting, ledgers (the layer heat from the thermal state), stats,
 *            milestones
 * One experiment per run (a second is rejected with a reason). Iteration orders are column indices and
 * the runtime's insertion order — never object ids.
 */
import type { SystemContext } from '../systems/SimulationSystem';
import type { ThermalRuntime } from '../thermal/runtime';
import type { AtmosphereRecord } from './AtmosphereChannel';
import { AtmosphereField } from '@/atmosphere/AtmosphereField';
import { initPlan, planForcing, type PlanState } from '@/atmosphere/plan';
import { BLAST_MIN_PRESSURE, FIRE_VALID_PRESSURE, atmosphereIssues, atmosphereWarnings, type AtmosphereSpec } from '@/atmosphere/types';
import { CP_AIR, KAPPA, Y_O2_AIR, boilingPoint, cunningham, density, soundSpeed, viscosity } from '@/atmosphere/reference';
import { datumState } from '@/events/atmosphere/AtmosphereEvent';
import { AIR_CELL } from '@/thermal/AirLayer';
import { AIR_DENSITY } from '@/core/units';
import { ASH_CLASSES, ASH_PARTICLE_DENSITY, settlingVelocity } from '@/volcano/ash';

/** Pressure shares of the initial datum pressure recorded as timeline milestones. */
export const PRESSURE_MILESTONES = [0.9, 0.75, 0.5, 0.25, 0.1, 0.01];
/** Layer density below this share of the initial one: low-density milestone. */
export const LOW_DENSITY = 0.5;
/** Updraft (m/s) that marks a developed thermal plume. */
export const PLUME_W = 1;

export interface AtmosphereStats {
  /** Area-mean surface pressure, its minimum and the mean reduced to the datum (Pa). */
  meanPressure: number;
  minPressure: number;
  datumPressure: number;
  /** Smallest / mean layer density (kg/m³). */
  minDensity: number;
  meanDensity: number;
  /** Remaining / removed / restored air mass (kg) and the share of the initial. */
  mass: number;
  removed: number;
  restored: number;
  share: number;
  /** Fastest column flow, layer flow and their peak (m/s). */
  maxColumnSpeed: number;
  maxLayerSpeed: number;
  peakSpeed: number;
  peakSpeedTime: number;
  /** Strongest updraft (m/s). */
  maxUpdraft: number;
  /** Free-atmosphere temperature (K), mean layer temperature (K). */
  Tcol: number;
  meanLayerT: number;
  /** O₂ mass in the resolved layer (kg) and its mean mass fraction. */
  o2Layer: number;
  o2Fraction: number;
  /** Fire items O₂-limited now / ever. */
  o2Limited: number;
  o2LimitedEver: number;
  /** Volcanic gas in the layer (kg). */
  gas: number;
  /** Ledger residuals (relative). */
  massResidual: number;
  energyResidual: number;
  /** Water boiling point at the mean surface pressure (K) — reported only. */
  boiling: number;
  /** Water cells warmer than the boiling point at their pressure (no phase change modelled — reported). */
  waterAboveBoiling: number;
  /** Solver: PCG iterations, idle steps. */
  iterations: number;
  idleSteps: number;
  steps: number;
  /** Mach number of the fastest flow (low-Mach model: flagged above 0.3). */
  mach: number;
}

/** One sample of the run's history (every second): datum / min pressure, min density, mass share, fastest flow, mean layer T, layer O₂. */
export interface AtmosSample { t: number; p: number; pMin: number; rho: number; share: number; v: number; T: number; o2: number }
export const SERIES_MAX = 1800;

export class AtmosphereRuntime {
  readonly field: AtmosphereField;
  readonly rec: AtmosphereRecord;
  readonly spec: AtmosphereSpec;
  readonly trt: ThermalRuntime;
  readonly p0: number;
  readonly T0: number;
  /** Datum density at the start (kg/m³). */
  readonly rho0: number;
  readonly warnings: string[];
  /** Layer face velocities (thermal / smoke / gas transport). */
  readonly faces: { fx: Float64Array; fz: Float64Array };
  private readonly plan: PlanState;
  private readonly layerT: Float64Array;
  private readonly updraft: Float64Array;
  private readonly vent: Float64Array;
  private readonly tmp: Float64Array;
  private readonly rho0col: Float64Array;
  /** Layer energy before the thermal step and the thermal ledger's venting / edge losses then (J). */
  private eBefore = 0;
  private ventBefore = 0;
  private advBefore = 0;
  private aboveBefore = 0;
  private o2Consumed0 = 0;
  private milestonesDone = new Set<string>();
  readonly stats: AtmosphereStats;
  /** Wall-clock cost (ms): last step and run total. */
  ms = 0;
  msTotal = 0;
  /** Oxygen ledger extras (kg): removed with air, restored, deficit carried out, burned, derived rest. */
  readonly o2 = { removed: 0, restored: 0, deficitOut: 0, consumed: 0, roomsAndMixing: 0, final: 0, layer: 0 };
  /** Couplings in force (opt-in, set by the spec). */
  readonly coupleBlast: boolean;
  readonly coupleMeteor: boolean;
  private settleCache = new Map<number, number>();
  /** History for the HUD chart and the results (every 1 s, halved when full). */
  readonly series: AtmosSample[] = [];
  private seriesEvery = 1;
  private nextSample = 0;
  private gasSeen = 0;
  private tileAwake = new Uint8Array(0);
  private terrainRev = 0;
  private terrainAt = -Infinity;
  terrainUpdates = 0;

  /** Mean ground height of every air column (four samples). */
  private groundHeights(ctx: SystemContext): Float64Array {
    const air = this.trt.world.air, t = ctx.env.terrain;
    const ground = new Float64Array(air.count);
    for (let iz = 0; iz < air.nz; iz++) for (let ix = 0; ix < air.nx; ix++) {
      const x0 = air.originX + ix * AIR_CELL, z0 = air.originZ + iz * AIR_CELL;
      let s = 0;
      for (const [u, v] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) s += t.sampleHeight(x0 + u * AIR_CELL, z0 + v * AIR_CELL);
      ground[iz * air.nx + ix] = s / 4;
    }
    return ground;
  }

  constructor(ctx: SystemContext, rec: AtmosphereRecord, trt: ThermalRuntime) {
    this.rec = rec;
    this.spec = rec.spec;
    this.trt = trt;
    const w = trt.world, air = w.air;
    const { p } = datumState(rec.spec);
    this.p0 = p;
    // The thermal reference IS the atmosphere's datum temperature (single owner of the air temperature):
    // when the thermal state existed before the experiment its reference is kept (noted).
    this.T0 = w.Tref;
    this.rho0 = density(p, this.T0);
    this.warnings = atmosphereWarnings(rec.spec, p);
    if (Math.abs(this.T0 - datumState(rec.spec).T) > 1e-9) this.warnings.push('atmos.warn.ambientKept');
    const ground = this.groundHeights(ctx);
    this.terrainRev = ctx.env.deformation.engine?.rev ?? 0;
    this.field = new AtmosphereField({ originX: air.originX, originZ: air.originZ, nx: air.nx, nz: air.nz, dx: AIR_CELL, H: air.H, ground, p0: p, T0: this.T0, boundary: rec.spec.boundary, thermo: rec.spec.thermo ?? 'adiabatic' }, Y_O2_AIR);
    this.plan = initPlan(rec.spec, this.field);
    const n = air.count;
    this.layerT = new Float64Array(n);
    this.updraft = new Float64Array(n);
    this.vent = new Float64Array(n);
    this.tmp = new Float64Array(n);
    this.rho0col = new Float64Array(n);
    this.faces = { fx: new Float64Array(this.field.Ux.length), fz: new Float64Array(this.field.Uz.length) };
    this.tileAwake = new Uint8Array(n);
    this.coupleBlast = !!rec.spec.coupleBlast;
    this.coupleMeteor = !!rec.spec.coupleMeteor;
    this.attach();
    this.stats = this.emptyStats();
    this.refreshStats(ctx);
  }

  /** Static check of a record before a runtime is built (null = acceptable). */
  static reject(rec: AtmosphereRecord, existing: AtmosphereRuntime | null): string | null {
    if (existing) return 'atmos.reject.second';
    return atmosphereIssues(rec.spec)[0] ?? null;
  }

  // ── Coupling to the thermal state ──────────────────────

  /** The layer columns take the atmosphere's mass (capacity), density and pressure ratio. */
  private attach() {
    const w = this.trt.world, air = w.air, f = this.field;
    const n = air.count;
    const Ca = new Float64Array(n), rho = new Float64Array(n), pr = new Float64Array(n);
    let prS = 0;
    for (let a = 0; a < n; a++) {
      Ca[a] = CP_AIR * f.layerMass(a);
      rho[a] = f.layerDensity(a);
      pr[a] = f.pressureRatio(a);
      prS += pr[a];
      this.rho0col[a] = rho[a];
    }
    // Heat already in the layer keeps its temperature on the new capacity (booked airMass).
    for (let a = 0; a < n; a++) {
      if (air.E[a] === 0) continue;
      const E2 = (air.E[a] * Ca[a]) / air.C;
      w.ledger.airMass += E2 - air.E[a];
      air.E[a] = E2;
    }
    air.Ca = Ca;
    air.rhoA = rho;
    air.prA = pr;
    air.prMean = prS / n;
    air.ventRef = f.Tcol;
    w.flow = this.faces;
    // Rooms built before the experiment: their air at the local density (no pressure change).
    for (let c = 0; c < w.comps.length; c++) {
      const cp = w.comps[c];
      if (!cp.alive) continue;
      const a = cp.air;
      const ratio = (a >= 0 ? rho[a] : this.meanOf(rho)) / air.rho;
      w.rescaleCompartment(c, cp.C * ratio, 1, KAPPA);
    }
  }

  private meanOf(v: Float64Array): number {
    let s = 0;
    for (let a = 0; a < v.length; a++) s += v[a];
    return s / Math.max(1, v.length);
  }

  // ── Before the thermal step ────────────────────────────

  prepare(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const w = this.trt.world, air = w.air, f = this.field;
    const n = air.count;
    const local0 = ctx.time - this.rec.start, local1 = local0 + dt;
    // Layer state from the thermal owner.
    let anyUp = false;
    for (let a = 0; a < n; a++) {
      this.layerT[a] = air.T(a);
      const u = air.updraft(a);
      this.updraft[a] = u;
      if (u > 0) anyUp = true;
    }
    // Terrain changed (Phase 21–22 deformation): the columns' ground heights are re-read at most once a
    // second — the column masses stay, the hydrostatic adjustment follows by the solved flow.
    const rev = ctx.env.deformation.engine?.rev ?? 0;
    if (rev !== this.terrainRev && ctx.time - this.terrainAt >= 1) {
      this.terrainRev = rev;
      this.terrainAt = ctx.time;
      f.setGround(this.groundHeights(ctx));
      this.terrainUpdates++;
    }
    // Plume heat of the volcano released above the layer (Phase 28 interface; informational here).
    const vrt = ctx.env.volcano.rt;
    if (vrt) for (const s of vrt.world.atmosphericSources(ctx.time)) if (s.kind === 'heat') f.energy.aboveLayerInfo += s.rate * dt;
    const F = planForcing(this.spec, f, this.plan, local0, local1);
    const res = f.step(dt, { ...F, layerT: this.layerT, updraft: anyUp ? this.updraft : null, Tin: this.T0 });
    // Removed air takes its O₂ deficit (the fire's tracer) with it.
    const fire = ctx.env.fire.rt;
    for (const a of res.removedList) {
      let def = 0;
      if (fire) def = fire.fw.removeAirShare(a, res.removedShare[a]);
      this.o2.removed += Y_O2_AIR * res.removedKg[a] - def;
    }
    if (F.addMass || (F.local && F.local.kg > 0)) this.o2.restored = Y_O2_AIR * f.mass.restored;
    // New layer capacity / temperature / density / pressure ratio of the changed columns.
    const rho = air.rhoA!, pr = air.prA!;
    let prS = 0;
    for (const a of res.changed) {
      w.setAirColumn(a, CP_AIR * f.layerMass(a), res.T2[a]);
      rho[a] = f.layerDensity(a);
      pr[a] = f.pressureRatio(a, res.T2[a]);
    }
    for (let a = 0; a < n; a++) prS += pr[a];
    air.prMean = prS / n;
    air.ventRef = f.Tcol;
    // Background air entering through the edges: a uniform change is the surroundings' too (their air
    // expanded the same way), otherwise the surroundings keep the reference state.
    air.inflowExcess = this.spec.extent !== 'local' && (this.spec.removal !== 'none' || this.spec.restore === 'reservoir') ? f.Tcol - air.Tref : null;
    // The ground under air that left the reference temperature joins the thermal computation (its
    // surface then exchanges heat with that air; Phase 26 wakes ground tiles only on heating).
    this.wakeGround();
    // Rooms follow the outdoor pressure through their leaks.
    if (res.changed.length) {
      let mr = 0;
      for (let a = 0; a < n; a++) mr += res.massRatio[a];
      mr /= n;
      for (let c = 0; c < w.comps.length; c++) {
        const cp = w.comps[c];
        if (!cp.alive) continue;
        const q = cp.air >= 0 ? res.massRatio[cp.air] : mr;
        if (q !== 1) w.rescaleCompartment(c, cp.C * q, q, KAPPA);
      }
      if (fire) for (let r = 0; r < fire.fw.rooms.length; r++) fire.fw.rescaleRoom(r, air.rhoAt(fire.fw.rooms[r].air));
    }
    if (fire) fire.fw.o2Limit = true;
    // Layer face velocities: the Phase 26 mid-layer mean wind + the computed flows.
    const U = w.u10 * Math.pow(Math.max(0.5, air.H / 2) / 10, 0.14);
    f.layerFaces(U * w.flowX, U * w.flowZ, this.faces.fx, this.faces.fz);
    // Layer energy before the thermal step (its heat exchange = the difference minus booked flows).
    this.eBefore = this.layerEnergy();
    this.ventBefore = w.ledger.lost.atmosphere;
    this.advBefore = w.ledger.lost.airAdvection;
    this.aboveBefore = w.ledger.lost.aboveLayer;
    if (fire && this.o2Consumed0 === 0) this.o2Consumed0 = fire.fw.ledger.oxygenConsumed;
    this.ms = performance.now() - t0;
  }

  /** Ground tiles under columns whose air differs from the reference by more than 0.05 K become active. */
  private wakeGround() {
    const w = this.trt.world, air = w.air, tr = w.terrain;
    for (let a = 0; a < air.count; a++) {
      if (this.tileAwake[a] || Math.abs(air.T(a) - air.Tref) <= 0.05) continue;
      this.tileAwake[a] = 1;
      const ix = a % air.nx, iz = (a - ix) / air.nx;
      const x = air.originX + (ix + 0.5) * AIR_CELL, z = air.originZ + (iz + 0.5) * AIR_CELL;
      const cx = Math.floor((x - tr.originX) / tr.cell), cz = Math.floor((z - tr.originZ) / tr.cell);
      if (cx < 0 || cz < 0 || cx >= tr.nx || cz >= tr.nz) continue;
      tr.activateCell(cz * tr.nx + cx);
    }
  }

  /** Water cells above the boiling point at the local surface pressure (reported, never acted on). */
  private boilingCells(): number {
    const w = this.trt.world, wt = w.water;
    if (!wt) return 0;
    const tr = w.terrain;
    let n = 0;
    for (let c = 0; c < wt.h.length; c++) {
      if (wt.h[c] <= 0 || wt.heat[c] <= 0) continue;
      const ix = c % tr.nx, iz = (c - ix) / tr.nx;
      const a = this.column(tr.originX + (ix + 0.5) * tr.cell, tr.originZ + (iz + 0.5) * tr.cell);
      if (w.waterT(c) > boilingPoint(this.field.surfacePressure(a))) n++;
    }
    return n;
  }

  /** Absolute heat content of the layer c_p·Σ m·T (J). */
  layerEnergy(): number {
    const air = this.trt.world.air, Ca = air.Ca!;
    let s = 0;
    for (let a = 0; a < air.count; a++) s += Ca[a] * air.Tref + air.E[a];
    return s;
  }

  // ── After the thermal step ─────────────────────────────

  after(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const w = this.trt.world, air = w.air, f = this.field;
    const n = air.count;
    // Volcanic gas: exactly what the volcano booked this step (its ledger's increase), split over the
    // vents by their current rates — one source, no second emission model.
    const vrt = ctx.env.volcano.rt;
    if (vrt) {
      const total = vrt.world.ledger().mass.gas;
      const dg = total - this.gasSeen;
      this.gasSeen = total;
      if (dg > 0) {
        const src = vrt.world.atmosphericSources(ctx.time).filter((s) => s.kind === 'gas');
        let R = 0;
        for (const s of src) R += s.rate;
        const list = src.length && R > 0 ? src.map((s) => ({ a: this.column(s.x, s.z), kg: (dg * s.rate) / R })) : vrt.world.eruptions.length ? [{ a: this.column(vrt.world.eruptions[0].vents[0].P[0], vrt.world.eruptions[0].vents[0].P[2]), kg: dg }] : [];
        const e0 = this.layerEnergy();
        for (const a of f.injectGas(list, (c) => air.T(c))) {
          w.setAirColumn(a, CP_AIR * f.layerMass(a), air.T(a));
          air.rhoA![a] = f.layerDensity(a);
        }
        // The gas's energy is booked as `source`, not as heat exchanged in the layer.
        this.eBefore += this.layerEnergy() - e0;
        w.ledger.final = w.internalEnergy();
      }
    }
    // Volcanic gas: vented with warm air (the same share as heat / smoke), carried by the layer flow.
    let anyGas = false;
    for (let a = 0; a < n; a++) if (f.gas[a] !== 0) { anyGas = true; break; }
    if (anyGas) {
      for (let a = 0; a < n; a++) { const u = air.updraft(a); this.vent[a] = u > 0 ? 1 - Math.exp((-u * dt) / air.H) : 0; }
      const r = f.transportLayer(f.gas, dt, this.vent, this.faces.fx, this.faces.fz, this.tmp);
      f.gasLedger.aloft += r.vented;
      f.gasLedger.out += r.out;
    }
    let g = 0;
    for (let a = 0; a < n; a++) g += f.gas[a];
    f.gasLedger.airborne = g;
    // Energy ledger: the layer's heat exchange from the thermal state.
    const e = f.energy, L = w.ledger;
    const eAfter = this.layerEnergy();
    const vent = L.lost.atmosphere - this.ventBefore, adv = L.lost.airAdvection - this.advBefore;
    e.heatIn += eAfter - this.eBefore + vent + adv;
    e.ventedAloft += vent;
    e.advectedOut += adv;
    e.aboveLayerInfo += L.lost.aboveLayer - this.aboveBefore;
    f.closeEnergy(eAfter);
    // Oxygen.
    const fire = ctx.env.fire.rt;
    let def = 0;
    if (fire) {
      for (let a = 0; a < n; a++) def += fire.fw.o2def[a];
      f.oxygen.aloft = fire.fw.o2DeficitVented;
      this.o2.deficitOut = fire.fw.o2DeficitOut;
      this.o2.consumed = fire.fw.ledger.oxygenConsumed - this.o2Consumed0;
    }
    const total = f.oxygenTotal(def);
    f.oxygen.final = total;
    f.oxygen.removed = this.o2.removed;
    f.oxygen.restored = Y_O2_AIR * f.mass.restored;
    f.oxygen.consumed = this.o2.consumed;
    this.o2.final = total;
    this.o2.roomsAndMixing = total - (f.oxygen.initial - this.o2.removed + f.oxygen.restored + f.oxygen.boundaryIn - f.oxygen.boundaryOut - f.oxygen.aloft - f.o2Offset + this.o2.deficitOut - this.o2.consumed);
    let o2l = 0;
    for (let a = 0; a < n; a++) o2l += Y_O2_AIR * f.layerMass(a) - (fire ? fire.fw.o2def[a] : 0);
    this.o2.layer = o2l;
    this.refreshStats(ctx);
    if (ctx.time + 1e-9 >= this.nextSample) {
      this.nextSample = ctx.time + this.seriesEvery;
      const s = this.stats;
      this.series.push({ t: ctx.time, p: s.datumPressure, pMin: s.minPressure, rho: s.minDensity, share: s.share, v: Math.max(s.maxColumnSpeed, s.maxLayerSpeed), T: s.meanLayerT, o2: s.o2Layer });
      if (this.series.length > SERIES_MAX) {
        // Keep every other sample and sample half as often (bounded memory over hours).
        let k = 0;
        for (let i = 0; i < this.series.length; i += 2) this.series[k++] = this.series[i];
        this.series.length = k;
        this.seriesEvery *= 2;
      }
      s.waterAboveBoiling = this.boilingCells();
    }
    this.milestones(ctx);
    this.ms += performance.now() - t0;
    this.msTotal += this.ms;
  }

  // ── Queries (wind forces, water, ash, blast, impact, inspector) ───

  /** Column of a world point, clamped to the grid. */
  column(x: number, z: number): number {
    const f = this.field;
    const ix = Math.max(0, Math.min(f.nx - 1, Math.floor((x - f.originX) / f.dx)));
    const iz = Math.max(0, Math.min(f.nz - 1, Math.floor((z - f.originZ) / f.dx)));
    return iz * f.nx + ix;
  }

  /** Air temperature at a height above the ground of a column (K): the layer's, above it the free atmosphere. */
  temperatureAt(a: number, h: number): number {
    return h <= this.field.H ? this.trt.world.air.T(a) : this.field.Tcol;
  }

  /** Air density at a world point (kg/m³) from p(z) and T(z). */
  densityAt(x: number, y: number, z: number): number {
    const a = this.column(x, z);
    const h = y - this.field.ground[a];
    return this.field.densityAt(a, h, this.trt.world.air.T(a));
  }

  pressureAt(x: number, y: number, z: number): number {
    const a = this.column(x, z);
    const h = y - this.field.ground[a];
    return this.field.pressureAt(a, h, this.trt.world.air.T(a));
  }

  /** Computed flow (column + layer, m/s) at a world point and height above its ground. */
  flowAt(x: number, z: number, h: number, out: [number, number]): [number, number] {
    return this.field.velocity(x, z, h, out);
  }

  /** Mean layer density relative to the standard sea-level density (water wind stress). */
  densityRatio(): number {
    return this.stats.meanDensity / AIR_DENSITY;
  }

  /** Terminal settling velocity of an ash class at a point (local density, viscosity, slip) — cached by state. */
  settling(cls: number, x: number, z: number, h: number): number {
    const a = this.column(x, z);
    const T = this.temperatureAt(a, h);
    const p = this.field.pressureAt(a, h, this.trt.world.air.T(a));
    const rho = density(p, T);
    const key = cls * 1e6 + Math.round(Math.log(Math.max(1e-9, rho)) * 400) * 10 + Math.round(T / 10);
    let v = this.settleCache.get(key);
    if (v === undefined) {
      const d = ASH_CLASSES[cls].d;
      v = settlingVelocity(d, ASH_PARTICLE_DENSITY, rho, viscosity(T), cunningham(p, T, d));
      this.settleCache.set(key, v);
    }
    return v;
  }

  /**
   * Background state for an opt-in blast at (x, z), at the world datum y = 0 (where the Phase 24 wave
   * takes its ambient — it carries it to the source height itself): the terrain-reduced column
   * pressure and ρ = p/(R·T). Null when outside the blast model's range.
   */
  blastAmbient(x: number, z: number): { p: number; rho: number } | null {
    const a = this.column(x, z), f = this.field;
    const p = f.sigma[a] * f.red[a] * 9.81, rho = density(p, this.trt.world.air.T(a));
    if (p < BLAST_MIN_PRESSURE || rho < 0.4 || rho > 1.5) return null;
    return { p, rho };
  }

  /** Sea-level density of the entry atmosphere scaled by the column mass now (opt-in meteor coupling). */
  entryDensity(): number {
    return entryRho0(this.spec, this.field.share());
  }

  // ── Stats & milestones ─────────────────────────────────

  private emptyStats(): AtmosphereStats {
    return {
      meanPressure: 0, minPressure: 0, datumPressure: 0, minDensity: 0, meanDensity: 0, mass: 0, removed: 0, restored: 0, share: 1,
      maxColumnSpeed: 0, maxLayerSpeed: 0, peakSpeed: 0, peakSpeedTime: 0, maxUpdraft: 0, Tcol: 0, meanLayerT: 0, o2Layer: 0, o2Fraction: Y_O2_AIR,
      o2Limited: 0, o2LimitedEver: 0, gas: 0, massResidual: 0, energyResidual: 0, boiling: 373.15, waterAboveBoiling: 0, iterations: 0, idleSteps: 0, steps: 0, mach: 0,
    };
  }

  private refreshStats(ctx: SystemContext) {
    const f = this.field, air = this.trt.world.air, s = this.stats;
    const n = f.count;
    let ps = 0, pmin = Infinity, rmin = Infinity, rs = 0, Ts = 0, up = 0, vmax = 0;
    for (let a = 0; a < n; a++) {
      const p = f.surfacePressure(a);
      ps += p;
      if (p < pmin) pmin = p;
      const T = air.T(a);
      const r = density(f.pressureAt(a, 0.5 * f.H, T), T);
      rs += r;
      if (r < rmin) rmin = r;
      Ts += T;
      if (this.updraft[a] > up) up = this.updraft[a];
      const v = f.speedAt(a);
      if (v > vmax) vmax = v;
    }
    s.meanPressure = ps / n;
    s.minPressure = pmin;
    s.datumPressure = f.meanReducedPressure();
    s.minDensity = rmin;
    s.meanDensity = rs / n;
    s.mass = f.totalMass();
    s.removed = f.mass.removed;
    s.restored = f.mass.restored;
    s.share = f.share();
    s.maxColumnSpeed = f.maxSpeed;
    s.maxLayerSpeed = f.maxLayerSpeed;
    if (vmax > s.peakSpeed) { s.peakSpeed = vmax; s.peakSpeedTime = ctx.time; }
    s.maxUpdraft = up;
    s.Tcol = f.Tcol;
    s.meanLayerT = Ts / n;
    s.o2Layer = this.o2.layer;
    let ml = 0;
    for (let a = 0; a < n; a++) ml += f.layerMass(a);
    s.o2Fraction = ml > 0 ? this.o2.layer / ml : 0;
    const fire = ctx.env.fire.rt;
    s.o2Limited = fire ? fire.fw.o2LimitedNow : 0;
    s.o2LimitedEver = fire ? fire.fw.o2LimitedEver : 0;
    s.gas = f.gasLedger.airborne;
    s.massResidual = Math.abs(f.massResidual()) / f.mass.initial;
    s.energyResidual = Math.abs(f.energy.final - f.energyExpected()) / f.energy.initial;
    s.boiling = boilingPoint(s.meanPressure);
    s.iterations = Math.max(0, f.lastIterations);
    s.steps = f.steps;
    s.mach = vmax / soundSpeed(Math.max(100, f.Tcol));
  }

  private once(ctx: SystemContext, key: string, kind: import('../analysis/MilestoneRecorder').MilestoneKind, params: Record<string, string | number>, time = ctx.time) {
    if (this.milestonesDone.has(key)) return;
    this.milestonesDone.add(key);
    ctx.milestone?.({ time, kind, subject: 'atmosphere', label: { key: `milestone.${kind}` as import('@/i18n/i18n').MessageKey, params } }, `atmos:${key}`);
  }

  private milestones(ctx: SystemContext) {
    const s = this.stats, sp = this.spec, name = this.rec.name;
    this.once(ctx, 'start', 'atmosStart', { id: name, p: (this.p0 / 1000).toFixed(1), T: (this.T0 - 273.15).toFixed(1) }, this.rec.start);
    if (sp.removal !== 'none') this.once(ctx, 'removal', 'removalStart', { id: name }, this.rec.start);
    for (const m of PRESSURE_MILESTONES) if (s.share <= m) this.once(ctx, `p${m}`, 'pressureMilestone', { share: (m * 100).toFixed(0), p: (s.datumPressure / 1000).toFixed(2) });
    if (s.minDensity < LOW_DENSITY * this.rho0) this.once(ctx, 'lowDensity', 'lowDensity', { rho: s.minDensity.toFixed(3) });
    if (s.peakSpeed > 0.5 && s.maxColumnSpeed + s.maxLayerSpeed < 0.8 * s.peakSpeed) this.once(ctx, 'airflowPeak', 'airflowPeak', { v: s.peakSpeed.toFixed(2) }, s.peakSpeedTime);
    if (s.o2Limited > 0) this.once(ctx, 'o2', 'oxygenLimitation', { n: s.o2Limited });
    if (s.maxUpdraft > PLUME_W) this.once(ctx, 'plume', 'plumeDevelopment', { w: s.maxUpdraft.toFixed(1) });
    if (sp.restore && sp.restore !== 'none') {
      const ra = this.rec.start + (sp.restoreAt ?? 0);
      if (ctx.time >= ra) this.once(ctx, 'restoreStart', 'restorationStart', { id: name }, ra);
      if (ctx.time >= ra + (sp.restoreDuration ?? 0) && Math.abs(s.share - (sp.restoreTarget ?? 1)) < 0.01) this.once(ctx, 'restoreEnd', 'restorationComplete', { share: (s.share * 100).toFixed(1) });
    }
    // Outside the model's range: said once in the log (never silently).
    if (s.mach > 0.3) this.warnOnce(ctx, 'mach', 'log.atmos.mach', { v: s.peakSpeed.toFixed(0), M: s.mach.toFixed(2) });
    if (s.minPressure < FIRE_VALID_PRESSURE && ctx.env.fire.rt) this.warnOnce(ctx, 'fireRange', 'log.atmos.fireRange', { p: (s.minPressure / 1000).toFixed(1) });
    if (s.minPressure < 1) this.warnOnce(ctx, 'rarefied', 'log.atmos.rarefied', { p: s.minPressure.toExponential(1) });
  }

  private warnOnce(ctx: SystemContext, key: string, msg: string, params: Record<string, string | number>) {
    if (this.milestonesDone.has(`w:${key}`)) return;
    this.milestonesDone.add(`w:${key}`);
    ctx.log(null, 'warn', { key: msg as import('@/i18n/i18n').MessageKey, params });
  }
}

/**
 * Air density the Phase 24 blast loads use at a point: the atmosphere's local density when the
 * experiment opted in to the blast coupling, the run's constant density otherwise (unchanged).
 */
export function blastAirDensity(env: { airDensity: number; atmosphere: { rt: AtmosphereRuntime | null } }, p: readonly number[]): number {
  const atm = env.atmosphere.rt;
  return atm && atm.coupleBlast ? atm.densityAt(p[0], p[1], p[2]) : env.airDensity;
}

/**
 * Background state for an opt-in blast / impact-airburst wave at (x, z): from the running atmosphere,
 * or — before its first step — the pending experiment's datum state carried to the ground hydrostatically.
 * null: no coupling (or the state is outside the blast model's range; the caller keeps its ambient).
 */
export function blastBackground(env: { atmosphere: { rt: AtmosphereRuntime | null; experiments: readonly AtmosphereRecord[] }; terrain: { sampleHeight(x: number, z: number): number } }, x: number, z: number, which: 'blast' | 'meteor'): { p: number; rho: number } | 'range' | null {
  const atm = env.atmosphere.rt;
  const g = env.terrain.sampleHeight(x, z);
  if (atm) {
    if (which === 'blast' ? !atm.coupleBlast : !atm.coupleMeteor) return null;
    return atm.blastAmbient(x, z) ?? 'range';
  }
  const rec = env.atmosphere.experiments.find((r) => !r.reason && (which === 'blast' ? r.spec.coupleBlast : r.spec.coupleMeteor));
  if (!rec) return null;
  void g;
  const { p, T } = datumState(rec.spec);
  const rho = density(p, T);
  if (p < BLAST_MIN_PRESSURE || rho < 0.4 || rho > 1.5) return 'range';
  return { p, rho };
}

/**
 * Phase 23 entry atmosphere under an atmosphere experiment: its exponential profile (ρ₀ = 1.225 kg/m³ at
 * sea level, H = 8 km) scaled by the mass of the air column now relative to the standard column — the
 * datum pressure × share carried down to sea level, over 101 325 Pa. The whole column above the world is
 * thinned the same way (the experiment removes the column, not a layer).
 */
export function entryRho0(spec: AtmosphereSpec, share: number): number {
  const { p, T } = datumState(spec);
  const pSea = p * share * Math.exp(spec.altitude / ((287.05 * T) / 9.81));
  return (AIR_DENSITY * pSea) / 101325;
}

/** Entry / ejecta air of an opt-in meteor (null: no coupling). */
export function meteorAir(env: { atmosphere: { rt: AtmosphereRuntime | null; experiments: readonly AtmosphereRecord[] }; terrain: { sampleHeight(x: number, z: number): number } }, x: number, z: number): { rho0: number; rhoGround: number } | null {
  const atm = env.atmosphere.rt;
  if (atm) return atm.coupleMeteor ? { rho0: atm.entryDensity(), rhoGround: atm.densityAt(x, env.terrain.sampleHeight(x, z) + 1, z) } : null;
  const rec = env.atmosphere.experiments.find((r) => !r.reason && r.spec.coupleMeteor);
  if (!rec) return null;
  const { p, T } = datumState(rec.spec);
  const g = env.terrain.sampleHeight(x, z);
  return { rho0: entryRho0(rec.spec, 1), rhoGround: density(p * Math.exp(-g / ((287.05 * T) / 9.81)), T) };
}
