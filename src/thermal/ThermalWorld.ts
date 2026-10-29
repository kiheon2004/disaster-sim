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

export const TK = { ground: 0, water: 1, air: 2, comp: 3, body: 4 } as const;
export type TargetKind = (typeof TK)[keyof typeof TK];

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
  /** Per source: energy deposited on each receiver (for the inspector), keyed `${kind}:${index}`. */
  readonly contributions = new Map<string, Map<string, number>>();
  private readonly rates: ThermalRates = emptyRates();

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

  compT(c: number): number {
    return c < 0 ? this.Tref : this.Tref + this.comps[c].E / this.comps[c].C;
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
      case TK.comp: this.comps[i].E += J; break;
      default: this.bodies.ES[i] += J; this.bodies.Esrc[i] += J; this.bodies.refresh(i); break;
    }
  }

  /** Rate (W) into a target during an exchange evaluation, with its tangent conductance G (W/K). */
  private addRate(kind: TargetKind, i: number, W: number, G: number) {
    switch (kind) {
      case TK.ground:
      case TK.water:
        if (this.wet(i)) this.terrain.dW[i] += W;
        else this.terrain.dE[i * this.terrain.nl] += W;
        this.terrain.activateCell(i);
        this.terrain.extraRate(i, G, this.wet(i));
        break;
      case TK.air: this.air.dE[i] += W; this.air.gS[i] += G; break;
      case TK.comp: this.comps[i].dE += W; this.comps[i].gS += G; break;
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
        let per = this.contributions.get(s.id);
        if (!per) this.contributions.set(s.id, (per = new Map()));
        for (const d of s.deposits) {
          const J = s.energy * d.w;
          this.deposit(d.kind, d.index, J);
          used += J;
          if (d.kind === TK.body || d.kind === TK.ground) { const key = `${d.kind}:${d.index}`; per.set(key, (per.get(key) ?? 0) + J); }
        }
        L.added += s.energy;
        L.lost.unresolvedRadiation += s.energy - used;
        L.bySource.set(s.id, (L.bySource.get(s.id) ?? 0) + s.energy);
      }
    }
    // Exchange with stability-limited sub-steps.
    let maxRate = this.evaluate(sources);
    let n = 1;
    if (dt * maxRate > 0.9) n = Math.ceil((dt * maxRate) / 0.9);
    const h = dt / n;
    this.commit(h);
    for (let k = 1; k < n; k++) {
      const r = this.evaluate(sources);
      if (r > maxRate) maxRate = r;
      this.commit(h);
    }
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

  /** One evaluation of every exchange into the rate accumulators; returns max ΣG/C. */
  private evaluate(sources: readonly SourceStep[]): number {
    const air = this.air;
    const acc = this.rates;
    const closed = this.closed;
    const u2 = this.u10 * Math.pow(0.2, 0.14);
    const toAir = (a: number, W: number, G: number) => { air.dE[a] += W; air.gS[a] += G; };
    const ix2a = (ix: number, iz: number) => air.index(this.terrain.originX + (ix + 0.5) * this.terrain.cell, this.terrain.originZ + (iz + 0.5) * this.terrain.cell);
    let maxRate = this.terrain.fluxes({ closed, noSurface: this.insulated, u2, water: this.water, airIndex: ix2a, airT: (a) => air.T(a), toAir, acc });
    const r1 = this.bodies.fluxes({
      closed, acc, airT: (a) => air.T(a), toAir, compT: (c) => this.compT(c),
      toComp: (c, W, G) => { const cp = this.comps[c]; cp.dE += W; cp.gS += G; },
    });
    if (r1 > maxRate) maxRate = r1;
    this.bodies.contactFluxes(this.terrain, acc);
    // Rooms: ventilation with the outdoors.
    for (const cp of this.comps) {
      if (!cp.alive) continue;
      const Tc = this.Tref + cp.E / cp.C;
      const Ta = air.T(cp.air);
      const q = cp.Gv * (Tc - Ta);
      cp.dE -= q;
      if (cp.air >= 0) toAir(cp.air, q, cp.Gv); else if (!closed) acc.aboveLayer += q; else cp.dE += q;
      acc.convection += Math.abs(q);
      cp.gS += cp.Gv;
    }
    // Prescribed-temperature spheres.
    for (const s of sources) {
      if (s.temperature === undefined || !s.exchanges) continue;
      const Ts = s.temperature;
      const Ts4 = Ts * Ts * Ts * Ts;
      for (const x of s.exchanges) {
        const T = this.targetT(x.kind, x.index);
        let q = 0, G = 0;
        if (x.aRad > 0) {
          q += x.eps * SIGMA * x.aRad * (Ts4 - T * T * T * T);
          G += 4 * x.eps * SIGMA * x.aRad * Math.max(T, Ts) ** 3;
        }
        if (x.aConv > 0) {
          const gas = x.kind === TK.air || x.kind === TK.comp;
          const h = gas ? hSphere(Ts, T, x.kind === TK.air ? this.u10 : 0, 2 * x.L) : x.kind === TK.body ? hBox(T, Ts, 0, x.aConv, 0, 0, x.L, x.L, x.L) : hGround(T, Ts, 0);
          q += h * x.aConv * (Ts - T);
          G += (4 / 3) * h * x.aConv;
          acc.convection += Math.abs(h * x.aConv * (Ts - T));
        }
        acc.radiation += Math.abs(q);
        acc.boundarySupply += q;
        this.addRate(x.kind, x.index, q, G);
      }
    }
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

  /** Apply the evaluated rates over h and book the ledger. */
  private commit(h: number) {
    const L = this.ledger, acc = this.rates;
    this.terrain.apply(h, this.water);
    this.bodies.apply(h);
    this.air.apply(h);
    for (const cp of this.comps) { if (cp.alive) cp.E += cp.dE * h; cp.dE = 0; }
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
      g.activateCell(c);
      const hw = w.h[c];
      if (hw <= 0) { g.E[c * nl] += e; w.heat[c] = 0; continue; }
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
