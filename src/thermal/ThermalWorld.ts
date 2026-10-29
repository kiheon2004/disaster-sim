/**
 * ThermalWorld (Phase 26): the shared thermal state of a run and its explicit solver — pure (no
 * Rapier, no React). The simulation adapter (simulation/thermal) builds bodies from the runtime,
 * places them, and hands over each step's source inputs; this class keeps every joule accounted.
 *
 * One step of length dt (the ThermalSystem calls it every 0.1 s):
 *  1. water bookkeeping — heat that came with infiltration goes into the ground surface, heat that
 *     left with water (edges, drains) is booked lost, water films thinner than 1 mm share the
 *     temperature of the bed surface (stiff coupling replaced by its exact equilibrium);
 *  2. source inputs — the energy of each power source over [t, t+dt) (exact profile integral) is
 *     deposited on its receivers (weights from the adapter; whatever no receiver absorbs is booked as
 *     unresolved radiation, not created or dropped);
 *  3. exchange — every link (conduction, convection, radiation, contacts, rooms, prescribed-temperature
 *     spheres, buoyant venting) evaluated from the current state into rate accumulators (W), each flux
 *     added to one node and subtracted from the other (Jacobi: no dependence on visiting order), then
 *     forward Euler. The stability limit max ΣG/C (tangent conductances) is measured on the same
 *     evaluation; when dt exceeds 0.9 of it the step is split into equal sub-steps that are each
 *     re-evaluated — an unstable step is never taken silently (`substeps`, `maxRate` reported);
 *  4. advection of the air layer by the mean wind (its own CFL sub-steps);
 *  5. ledger: internal energy and residual.
 */
import type { TerrainData } from '@/core/model';
import { TerrainThermal, WATER_MERGE, emptyRates, type ThermalRates, type WaterLink } from './TerrainThermal';
import { AirLayer, DEFAULT_LAYER_HEIGHT } from './AirLayer';
import { ThermalBodies } from './ThermalBodies';
import { ThermalLedger } from './ledger';
import { hBox, hGround, hSphere } from './convection';
import { SIGMA, CP_AIR, C_WATER, RHO_WATER } from './units';

/** Water warmer / colder than the reference by this much (K) brings its tile into the ground computation. */
export const WATER_ACTIVATE = 1e-3;

export const TK = { ground: 0, water: 1, air: 2, comp: 3, body: 4 } as const;
export type TargetKind = (typeof TK)[keyof typeof TK];

/** Key of a receiver in the per-source contribution maps. */
export const contributionKey = (kind: number, index: number) => kind * 1e8 + index;

export type RestraintMode = 'frame' | 'full' | 'none';
export interface ThermalSettings {
  /** Ambient (reference) air temperature, K. */
  ambient: number;
  /** Height of the resolved near-surface air layer, m. */
  airLayerHeight: number;
  /** Axial restraint of heated members: computed from the frame, fully restrained, or free (bounds). */
  restraint: RestraintMode;
}

export const defaultThermalSettings = (): ThermalSettings => ({ ambient: 288.15, airLayerHeight: DEFAULT_LAYER_HEIGHT, restraint: 'frame' });

/** A target of a source: where its energy goes, with a weight (fraction of the source's output). */
export interface Deposit {
  kind: TargetKind;
  index: number;
  w: number;
}

/** A receiver of a prescribed-temperature sphere. */
export interface Exchange {
  kind: TargetKind;
  index: number;
  /** Radiative coupling area A_proj·F (m²) — includes immersed area (F = 1). */
  aRad: number;
  /** Area in contact with gas at the sphere temperature (immersed), or the sphere area convecting into a gas target (m²). */
  aConv: number;
  eps: number;
  /** Characteristic length of the convection (m). */
  L: number;
}

export interface SourceStep {
  id: string;
  /** Energy output over this step (J) — power sources. */
  energy: number;
  deposits: readonly Deposit[];
  /** Prescribed temperature over this step (K) — temperature sources. */
  temperature?: number;
  exchanges?: readonly Exchange[];
  /** Share of the output released above the resolved air layer (convected plume of a high source) — booked lost. */
  aboveLayer?: number;
}

/** Building room (one story of a modular building). */
export interface Compartment {
  E: number;
  C: number;
  /** Outdoor air-layer column (−1: above the layer → ambient). */
  air: number;
  /** Ventilation conductance to the outdoors (W/K). */
  Gv: number;
  alive: boolean;
  dE: number;
  gS: number;
}

export interface StepInfo {
  substeps: number;
  maxRate: number;
  airSubsteps: number;
}

export class ThermalWorld {
  readonly Tref: number;
  readonly terrain: TerrainThermal;
  readonly air: AirLayer;
  readonly bodies: ThermalBodies;
  readonly comps: Compartment[] = [];
  readonly ledger = new ThermalLedger();
  water: (WaterLink & { cellArea: number; out: number; moved: number }) | null = null;
  /** Wind at 10 m (m/s) and its flow direction (unit, +x east / +z south). */
  u10 = 0;
  flowX = 1;
  flowZ = 0;
  /** Adiabatic world (tests): no boundary exchange of any kind. */
  readonly closed: boolean;
  private readonly insulated: boolean;
  time = 0;
  steps = 0;
  /** Largest sub-step count needed so far and the last stability numbers. */
  maxSubsteps = 1;
  last: StepInfo = { substeps: 0, maxRate: 0, airSubsteps: 0 };
  /**
   * Per source: energy deposited on each body / ground receiver (inspector). Accumulated per geometry
   * epoch (the receiver weights are fixed between rebuilds): the epoch's energy × each weight is
   * flushed into the totals when the geometry changes — exact, without per-step map updates.
   */
  private readonly contrib = new Map<string, { deposits: readonly Deposit[]; energy: number; totals: Map<number, number>; index: Map<number, number> | null }>();

  /** Energy a source has put into a receiver so far (J). */
  contribution(id: string, key: number): number {
    const c = this.contrib.get(id);
    if (!c) return 0;
    if (!c.index) {
      c.index = new Map();
      for (const d of c.deposits) if (d.kind === TK.body || d.kind === TK.ground) { const k = contributionKey(d.kind, d.index); c.index.set(k, (c.index.get(k) ?? 0) + d.w); }
    }
    return (c.totals.get(key) ?? 0) + c.energy * (c.index.get(key) ?? 0);
  }

  private flushContributions(id: string, deposits: readonly Deposit[], energy: number) {
    let c = this.contrib.get(id);
    if (!c) this.contrib.set(id, (c = { deposits, energy: 0, totals: new Map(), index: null }));
    if (c.deposits !== deposits) {
      if (c.energy !== 0) for (const d of c.deposits) if (d.kind === TK.body || d.kind === TK.ground) { const k = contributionKey(d.kind, d.index); c.totals.set(k, (c.totals.get(k) ?? 0) + c.energy * d.w); }
      c.deposits = deposits;
      c.energy = 0;
      c.index = null;
    }
    c.energy += energy;
  }
  private readonly rates: ThermalRates = emptyRates();
  /** The ground advances on its own step (its time constants are ≥ minutes); energy is exact either way. */
  groundDt = 1;
  private groundAcc = 0;

  constructor(t: TerrainData, readonly settings: ThermalSettings, airDensity = 1.225, opts: { closed?: boolean; layers?: readonly number[]; insulatedGround?: boolean } = {}) {
    this.insulated = !!opts.insulatedGround;
    this.Tref = settings.ambient;
    this.closed = !!opts.closed;
    this.terrain = new TerrainThermal(t, this.Tref, opts.layers);
    const W = (t.nx - 1) * t.cellSize, D = (t.nz - 1) * t.cellSize;
    this.air = new AirLayer(t.originX, t.originZ, W, D, settings.airLayerHeight, this.Tref, airDensity);
    this.bodies = new ThermalBodies(this.Tref);
  }

  // ── Targets ────────────────────────────────────────────

  addCompartment(volume: number, air: number, ach: number, airDensity = this.air.rho): number {
    const C = airDensity * CP_AIR * volume;
    this.comps.push({ E: 0, C, air, Gv: (C * ach) / 3600, alive: true, dE: 0, gS: 0 });
    return this.comps.length - 1;
  }

  /** Room temperature; a room that no longer exists (its story collapsed) is the outdoors. */
  compT(c: number): number {
    if (c < 0) return this.Tref;
    const cp = this.comps[c];
    return cp.alive ? this.Tref + cp.E / cp.C : this.air.T(cp.air);
  }

  /** Heat into a room (or, once it is gone, into the outdoor air it opened to). */
  private toComp(c: number, W: number, G: number) {
    const cp = this.comps[c];
    if (cp.alive) { cp.dE += W; cp.gS += G; }
    else if (cp.air >= 0) { this.air.dE[cp.air] += W; this.air.gS[cp.air] += G; }
    else this.rates.aboveLayer += W;
  }

  /** Water deep enough to be its own node at a cell. */
  private wet(c: number): boolean {
    return !!this.water && this.water.h[c] > WATER_MERGE;
  }

  waterT(c: number): number {
    const w = this.water;
    if (!w || w.h[c] <= 0) return this.Tref;
    return this.Tref + w.heat[c] / (RHO_WATER * C_WATER * w.h[c] * w.cellArea);
  }

  targetT(kind: TargetKind, i: number): number {
    switch (kind) {
      case TK.ground: return this.wet(i) ? this.waterT(i) : this.terrain.T(i, 0);
      case TK.water: return this.waterT(i);
      case TK.air: return this.air.T(i);
      case TK.comp: return this.compT(i);
      default: return this.bodies.TS[i];
    }
  }

  /** Add energy (J) to a target now. */
  deposit(kind: TargetKind, i: number, J: number) {
    if (J === 0) return;
    switch (kind) {
      case TK.ground:
      case TK.water:
        if (this.wet(i)) { this.water!.heat[i] += J; this.terrain.activateCell(i); }
        else { this.terrain.E[i * this.terrain.nl] += J; this.terrain.activateCell(i); }
        break;
      case TK.air: this.air.E[i] += J; break;
      case TK.comp: { const cp = this.comps[i]; if (cp.alive) cp.E += J; else if (cp.air >= 0) this.air.E[cp.air] += J; else this.ledger.lost.aboveLayer += J; break; }
      default: this.bodies.ES[i] += J; this.bodies.Esrc[i] += J; this.bodies.refresh(i); break;
    }
  }

  /** Rate (W) into a target during an exchange evaluation, with its tangent conductance G (W/K). */
  private addRate(kind: TargetKind, i: number, W: number, G: number) {
    switch (kind) {
      case TK.ground:
      case TK.water:
        // Only evaluated in the ground step (its rates are applied with the ground's dt).
        if (this.wet(i)) this.terrain.dW[i] += W;
        else this.terrain.dE[i * this.terrain.nl] += W;
        this.terrain.activateCell(i);
        this.terrain.extraRate(i, G, this.wet(i));
        break;
      case TK.air: this.air.dE[i] += W; this.air.gS[i] += G; break;
      case TK.comp: this.toComp(i, W, G); break;
      default: this.bodies.dS[i] += W; this.bodies.gS[i] += G; break;
    }
  }

  /** Move a body (world centre, ground height under it): its air-layer column follows. */
  placeBody(i: number, x: number, y: number, z: number, yg: number) {
    const b = this.bodies;
    b.x[i] = x; b.y[i] = y; b.z[i] = z; b.yg[i] = yg;
    b.air[i] = this.air.index(x, z, y - yg);
  }

  // ── Step ───────────────────────────────────────────────

  step(dt: number, sources: readonly SourceStep[] = []): StepInfo {
    const L = this.ledger;
    this.waterBookkeeping();
    // Sources: exact energy of the step on the receivers.
    for (const s of sources) {
      if (s.energy !== 0) {
        let used = 0;
        this.flushContributions(s.id, s.deposits, s.energy);
        for (const d of s.deposits) {
          // A receiver that merged / left since the geometry was built: its share stays unresolved.
          if (d.kind === TK.body && !this.bodies.alive[d.index]) continue;
          const J = s.energy * d.w;
          this.deposit(d.kind, d.index, J);
          used += J;
        }
        const above = s.energy * (s.aboveLayer ?? 0);
        L.added += s.energy;
        L.lost.aboveLayer += above;
        L.lost.unresolvedRadiation += s.energy - used - above;
        L.bySource.set(s.id, (L.bySource.get(s.id) ?? 0) + s.energy);
      }
    }
    // Slow operator: the ground (and water on it) on its own step.
    this.groundAcc += dt;
    let maxRate = 0, n = 1;
    if (this.groundAcc >= this.groundDt - 1e-9) {
      const g = this.groundOp(this.groundAcc, sources);
      this.groundAcc = 0;
      maxRate = g.maxRate;
      n = g.substeps;
    }
    // Fast operator: bodies, rooms, air, prescribed-temperature exchanges with them.
    let rate = this.evaluateFast(sources);
    let m = 1;
    if (dt * rate > 0.9) m = Math.ceil((dt * rate) / 0.9);
    const h = dt / m;
    this.commitFast(h);
    for (let k = 1; k < m; k++) {
      const r = this.evaluateFast(sources);
      if (r > rate) rate = r;
      this.commitFast(h);
    }
    if (rate > maxRate) maxRate = rate;
    n = Math.max(n, m);
    if (n > this.maxSubsteps) this.maxSubsteps = n;
    // Air advection by the mean wind at mid-layer.
    const U = this.u10 * Math.pow(Math.max(0.5, this.air.H / 2) / 10, 0.14);
    const adv = this.closed ? { out: 0, moved: 0, substeps: 0 } : this.air.advect(U * this.flowX, U * this.flowZ, dt);
    L.lost.airAdvection += adv.out;
    L.transfers.airAdvection += adv.moved;
    this.time += dt;
    this.steps++;
    this.terrain.growTiles();
    L.final = this.internalEnergy();
    this.last = { substeps: n, maxRate, airSubsteps: adv.substeps };
    return this.last;
  }

  /** Ground step: column / lateral conduction, surface ↔ air / sky, water ↔ bed / air, spheres ↔ ground. */
  private groundOp(dt: number, sources: readonly SourceStep[]): { maxRate: number; substeps: number } {
    const air = this.air;
    const acc = this.rates;
    const u2 = this.u10 * Math.pow(0.2, 0.14);
    const toAir = (a: number, W: number, G: number) => { if (a >= 0) { air.dE[a] += W; air.gS[a] += G; } else acc.aboveLayer += W; };
    const tr = this.terrain;
    const cx = tr.originX + 0.5 * tr.cell, cz = tr.originZ + 0.5 * tr.cell;
    const ix2a = (ix: number, iz: number) => air.index(cx + ix * tr.cell, cz + iz * tr.cell);
    const env = { closed: this.closed, noSurface: this.insulated, u2, water: this.water, airIndex: ix2a, airT: (a: number) => air.T(a), toAir, acc };
    const evaluate = () => {
      let r = tr.fluxes(env);
      // Ground contacts (foundations, slabs on grade, rubble heaps, whole-building nodes): slow
      // conduction, evaluated with the ground (the body side is applied with the same step).
      this.bodies.contactFluxes(tr, acc);
      const rb = this.bodies.stability();
      if (rb > r) r = rb;
      this.sphereExchanges(sources, true);
      for (let a = 0; a < air.count; a++) { const q = air.gS[a] / air.C; if (q > r) r = q; air.gS[a] = 0; }
      return r;
    };
    let maxRate = evaluate();
    const n = dt * maxRate > 0.9 ? Math.ceil((dt * maxRate) / 0.9) : 1;
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      if (k > 0) { const r = evaluate(); if (r > maxRate) maxRate = r; }
      tr.apply(h, this.water);
      this.bodies.apply(h);
      air.apply(h);
      this.book(h);
    }
    return { maxRate, substeps: n };
  }

  /** Prescribed-temperature spheres with their receivers: ground / water ones (slow) or the rest (fast). */
  private sphereExchanges(sources: readonly SourceStep[], ground: boolean) {
    const acc = this.rates;
    for (const s of sources) {
      if (s.temperature === undefined || !s.exchanges) continue;
      const Ts = s.temperature;
      const Ts4 = Ts * Ts * Ts * Ts;
      for (const x of s.exchanges) {
        if ((x.kind === TK.ground || x.kind === TK.water) !== ground) continue;
        if (x.kind === TK.body && !this.bodies.alive[x.index]) continue;
        const T = this.targetT(x.kind, x.index);
        let q = 0, G = 0;
        if (x.aRad > 0) {
          q += x.eps * SIGMA * x.aRad * (Ts4 - T * T * T * T);
          const Tm = T > Ts ? T : Ts;
          G += 4 * x.eps * SIGMA * x.aRad * Tm * Tm * Tm;
        }
        if (x.aConv > 0) {
          const gas = x.kind === TK.air || x.kind === TK.comp;
          const h = gas ? hSphere(Ts, T, x.kind === TK.air ? this.u10 : 0, 2 * x.L) : x.kind === TK.body ? hBox(T, Ts, 0, x.aConv, 0, 0, x.L, x.L, x.L) : hGround(T, Ts, 0);
          const qc = h * x.aConv * (Ts - T);
          q += qc;
          G += (4 / 3) * h * x.aConv;
          acc.convection += Math.abs(qc);
        }
        acc.radiation += Math.abs(q);
        acc.boundarySupply += q;
        this.addRate(x.kind, x.index, q, G);
      }
    }
  }

  /** One evaluation of the fast exchanges into the rate accumulators; returns max ΣG/C. */
  private evaluateFast(sources: readonly SourceStep[]): number {
    const air = this.air;
    const acc = this.rates;
    const closed = this.closed;
    const toAir = (a: number, W: number, G: number) => { air.dE[a] += W; air.gS[a] += G; };
    let maxRate = this.bodies.fluxes({
      closed, acc, airT: (a) => air.T(a), toAir, compT: (c) => this.compT(c),
      toComp: (c, W, G) => this.toComp(c, W, G),
    });
    // Rooms: ventilation with the outdoors.
    for (const cp of this.comps) {
      if (!cp.alive) continue;
      const Tc = this.Tref + cp.E / cp.C;
      const Ta = air.T(cp.air);
      const q = cp.Gv * (Tc - Ta);
      if (cp.air >= 0) { cp.dE -= q; toAir(cp.air, q, cp.Gv); }
      else if (!closed) { cp.dE -= q; acc.aboveLayer += q; }
      acc.convection += Math.abs(q);
      cp.gS += cp.Gv;
    }
    this.sphereExchanges(sources, false);
    // Buoyant venting of the air layer (also collects the air stability).
    const v = air.vent(closed);
    acc.atmosphere += v.lost;
    if (v.maxRate > maxRate) maxRate = v.maxRate;
    for (const cp of this.comps) {
      if (!cp.alive) continue;
      const r = cp.gS / cp.C;
      if (r > maxRate) maxRate = r;
      cp.gS = 0;
    }
    const rb = this.bodies.stability();
    if (rb > maxRate) maxRate = rb;
    return maxRate;
  }

  /** Apply the fast rates over h and book the ledger. */
  private commitFast(h: number) {
    this.bodies.apply(h);
    this.air.apply(h);
    for (const cp of this.comps) { if (cp.alive) cp.E += cp.dE * h; cp.dE = 0; }
    this.book(h);
  }

  /** Book the accumulated loss / transfer rates over h. */
  private book(h: number) {
    const L = this.ledger, acc = this.rates;
    L.lost.deepGround += acc.deepGround * h;
    L.lost.radiationSky += acc.radiationSky * h;
    L.lost.atmosphere += acc.atmosphere * h;
    L.lost.aboveLayer += acc.aboveLayer * h;
    L.boundarySupply += acc.boundarySupply * h;
    L.transfers.conduction += acc.conduction * h;
    L.transfers.convection += acc.convection * h;
    L.transfers.radiation += acc.radiation * h;
    acc.deepGround = acc.radiationSky = acc.atmosphere = acc.aboveLayer = acc.boundarySupply = acc.conduction = acc.convection = acc.radiation = 0;
  }

  /** Heat that arrived / left with water since the last step; thin films merged with the bed. */
  private waterBookkeeping() {
    const w = this.water;
    if (!w) return;
    const L = this.ledger;
    L.lost.water += w.out;
    L.transfers.waterAdvection += w.moved;
    w.out = 0;
    w.moved = 0;
    const g = this.terrain;
    const nl = g.nl;
    const Cw1 = RHO_WATER * C_WATER * w.cellArea;
    for (let c = 0; c < g.count; c++) {
      const inf = w.infilHeat ? w.infilHeat[c] : 0;
      if (inf !== 0) { g.E[c * nl] += inf; w.infilHeat![c] = 0; g.activateCell(c); }
      const e = w.heat[c];
      if (e === 0) continue;
      const hw = w.h[c];
      if (hw <= 0) { g.E[c * nl] += e; w.heat[c] = 0; g.activateCell(c); continue; }
      // Water carries heat into a tile: the tile joins once that water differs from the reference by
      // more than WATER_ACTIVATE (until then its heat simply stays in the water — nothing is lost).
      if (!g.isActiveCell(c) && Math.abs(e) < WATER_ACTIVATE * Cw1 * hw) continue;
      g.activateCell(c);
      if (hw <= WATER_MERGE) {
        // Equilibrium of the film and the surface layer (constant capacities over the merge).
        const j = c * nl;
        const Cw = Cw1 * hw, Cg = g.C[j];
        const total = e + g.E[j];
        const dT = total / (Cw + Cg);
        w.heat[c] = Cw * dT;
        g.E[j] = total - w.heat[c];
      }
    }
  }

  // ── Bookkeeping ────────────────────────────────────────

  waterEnergy(): number {
    const w = this.water;
    if (!w) return 0;
    let s = 0;
    for (let c = 0; c < w.heat.length; c++) s += w.heat[c];
    return s;
  }

  internalEnergy(): number {
    let s = this.terrain.energy() + this.air.energy() + this.bodies.total() + this.waterEnergy();
    for (const cp of this.comps) if (cp.alive) s += cp.E;
    return s;
  }

  /** Move a compartment's heat into the outdoor air (the story it belonged to collapsed). */
  openCompartment(c: number) {
    const cp = this.comps[c];
    if (!cp.alive) return;
    if (cp.air >= 0) this.air.E[cp.air] += cp.E;
    else this.ledger.lost.aboveLayer += cp.E;
    cp.E = 0;
    cp.alive = false;
  }

  /** Book energy leaving the world with an object (fragment beyond the edge). */
  removeBody(i: number) {
    const b = this.bodies;
    if (!b.alive[i]) return;
    this.ledger.lost.debris += b.ES[i] + b.EC[i];
    b.ES[i] = b.EC[i] = 0;
    b.alive[i] = 0;
    b.dropContacts(i);
  }

  /** Move a body's whole energy into another body (merge into a rubble heap) or a ground cell. */
  mergeBody(i: number, into: { kind: TargetKind; index: number }) {
    const b = this.bodies;
    if (!b.alive[i]) return;
    const E = b.ES[i] + b.EC[i];
    b.ES[i] = b.EC[i] = 0;
    b.alive[i] = 0;
    b.dropContacts(i);
    this.deposit(into.kind, into.index, E);
    if (into.kind === TK.body) b.Esrc[into.index] -= E; // not a source contribution
  }
}
