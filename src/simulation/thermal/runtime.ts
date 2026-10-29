/**
 * Thermal adapter of a run (Phase 26): connects the pure ThermalWorld to the simulation runtime.
 *
 *  - Bodies: every object that can heat up gets thermal nodes when its surroundings first differ
 *    from the ambient by more than ACTIVATE (0.05 K) or a source reaches it:
 *      modular buildings   one body per member (shared design / graph read-only; the arrays are the
 *                          building's own), rooms = one compartment per story, foundations and slabs
 *                          on grade in contact with the ground cells under them
 *      legacy buildings    envelope + interior (2 nodes), footprint in contact with the ground
 *      vehicles            body shell (30 % of the mass) + interior, steel
 *      trees               foliage (canopy mass) + trunk (green wood)
 *      walls / poles / signs   masonry 2-node / steel lumped
 *    People get no body: their exposure records the air temperature and the radiant flux they see.
 *  - Debris: a member keeps its body when it falls, leaves as a fragment (the body follows the
 *    fragment) or comes to rest; when it settles into rubble its energy MOVES into the heap's body
 *    (one node, mass = heap mass, constant c); fragments leaving the world take their energy with them
 *    (ledger). Polled from the collapse model's member states — Phase 25 code is not modified.
 *  - Sources: receivers and weights are rebuilt from the geometry every GEOM_PERIOD seconds (and when
 *    bodies appear); the energy of each source is integrated exactly from where the last step ended.
 *  - Structure: temperature → material factor (EN reduction) and restrained thermal force → the
 *    collapse engine's own API (setMaterialFactor, addLoad, fail for thermal buckling of beams), only
 *    when they change by more than a quantum; the engine does the redistribution.
 * Iteration orders are the runtime's insertion order and member indices — never object ids.
 */
import type { EntityId, Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import { MATERIALS } from '@/buildings/materials';
import { MT_BEAM, MT_COLUMN, MT_DOOR, MT_FOUNDATION, MT_ROOF, MT_SLAB, MT_WALL, MT_WINDOW, graphOf, type StructuralGraph } from '@/structure/graph';
import { MS, OVERLOAD } from '@/structure/types';
import { STRUCTURAL_THERMAL, THERMAL_MATERIALS, TM } from '@/thermal/materials';
import { ThermalWorld, TK, type Deposit, type Exchange, type SourceStep } from '@/thermal/ThermalWorld';
import { BK, type BodyInit } from '@/thermal/ThermalBodies';
import { intervalEnergy, intervalTemperature, radiativeFraction, amplitude } from '@/thermal/sources';
import { pointFraction, projectedArea, sphereViewFactor } from '@/thermal/radiation';
import { IRRADIANCE_FLOOR } from '@/thermal/types';
import { groundReceivers, sourceReach, type GroundGrid } from '@/thermal/geometry';
import { beamAxialCapacity, columnFactor, meanTemp, restrainedForce, restraintDegree, sectionFactors, thermalStrain, bowingCurvature, type NodeTemps } from '@/thermal/structural';
import { SIGMA, BOILING, RHO_WATER, C_WATER, toC } from '@/thermal/units';
import { WATER_MERGE } from '@/thermal/TerrainThermal';
import type { SystemContext } from '../systems/SimulationSystem';
import type { DebrisPiece, RuntimeEntity } from '../SimulationRuntime';
import { activate, structureOf } from '../structure/state';
import type { SourceRecord } from './ThermalChannel';

/** Surroundings differing from the ambient by more than this (K) bring an object into the network. */
export const ACTIVATE = 0.05;
/** Receiver geometry of the sources is rebuilt this often (s of simulation time). */
export const GEOM_PERIOD = 1;
/** Air changes per hour of building rooms with the outdoors (ASHRAE infiltration range 0.2–1). */
export const ROOM_ACH = 0.5;
/** Skin thickness of two-node bodies (m) — the cover zone of RC members. */
export const SKIN = 0.05;
/** Quantum of applied changes: material factor / thermal force (share of the member capacity). */
const FACTOR_QUANTUM = 0.005;
const LOAD_QUANTUM = 0.01;
/** Constant specific heat of rubble heaps (J/(kg·K), concrete). */
const HEAP_C = 880;
const MATERIAL_KEYS = Object.keys(MATERIALS) as (keyof typeof MATERIALS)[];
const PERIM_EDGE = 0.45;

export interface BuildingThermal {
  e: RuntimeEntity;
  g: StructuralGraph;
  body: Int32Array;
  wS: Float32Array;
  tmat: Uint8Array;
  comp: Int32Array;
  perimeter: Uint8Array;
  lastState: Uint8Array;
  /** Applied material factor, applied thermal force (N), thermal utilization, free strain, restraint. */
  fApplied: Float64Array;
  nApplied: Float64Array;
  util: Float64Array;
  strain: Float32Array;
  restraint: Float32Array;
  bow: Float32Array;
  restraintRev: number;
  /** Column crushing / buckling capacities (N). */
  crush: Float64Array;
  buckle: Float64Array;
  /** Members that failed with a thermal cause / under a thermal factor (counts). */
  thermalFailures: number;
  minFactor: number;
  bounds: { x0: number; z0: number; x1: number; z1: number; top: number };
}

interface EntityThermal {
  e: RuntimeEntity;
  kind: 'modular' | 'building' | 'car' | 'tree' | 'wall' | 'pole';
  body: number;
  b: BuildingThermal | null;
  dynamic: boolean;
  active: boolean;
}

interface SourceGeom {
  deposits: Deposit[];
  exchanges: Exchange[];
  aboveLayer: number;
  builtAt: number;
  bodies: number;
}

export interface ThermalStats {
  maxT: number;
  maxWhere: 'ground' | 'water' | 'air' | 'object' | 'member' | 'none';
  meanHeatedT: number;
  heatedArea: number;
  maxAirT: number;
  maxWaterT: number;
  maxRoomT: number;
  maxFlux: number;
  bodies: number;
  buildings: number;
  activeTiles: number;
  damagedStructures: number;
  failedMembers: number;
  minFactor: number;
  maxUtil: number;
}

export class ThermalRuntime {
  readonly world: ThermalWorld;
  readonly ents: EntityThermal[] = [];
  readonly byEntity = new Map<EntityId, EntityThermal>();
  readonly buildings: BuildingThermal[] = [];
  readonly humans: RuntimeEntity[] = [];
  private readonly geom = new Map<string, SourceGeom>();
  private readonly upto = new Map<string, number>();
  readonly heapBody = new Map<number, number>();
  private heapMass = new Map<number, number>();
  /** Body → fragment it follows (structural fragments). */
  private fragOf = new Map<number, DebrisPiece>();
  private bodiesAtGeom = -1;
  readonly stats: ThermalStats = { maxT: 0, maxWhere: 'none', meanHeatedT: 0, heatedArea: 0, maxAirT: 0, maxWaterT: 0, maxRoomT: 0, maxFlux: 0, bodies: 0, buildings: 0, activeTiles: 0, damagedStructures: 0, failedMembers: 0, minFactor: 1, maxUtil: 0 };
  private thresholds = { T: 0, flux: 0, factor: 0, stress: false, failure: false, boil: false };
  /** Wall-clock cost of the last step (ms) and the run total. */
  ms = 0;
  msTotal = 0;
  /** Inspector: per-body source energy is in world.bodies.Esrc; per cell in world.contributions. */

  constructor(ctx: SystemContext) {
    const ch = ctx.env.thermal;
    this.world = new ThermalWorld(ctx.env.terrain.data, ch.settings, ch.airDensity);
    const g = this.world.terrain;
    for (const e of ctx.runtime.entities.values()) {
      if (e.def.inert) continue;
      const t = e.source.type;
      if (t === 'human') { this.humans.push(e); continue; }
      const kind: EntityThermal['kind'] | null = e.modular ? 'modular' : t === 'building' ? 'building' : t === 'car' ? 'car' : t === 'tree' ? 'tree' : t === 'wall' ? 'wall' : t === 'streetLight' || t === 'sign' ? 'pole' : null;
      if (!kind) continue;
      const te: EntityThermal = { e, kind, body: -1, b: null, dynamic: e.dynamic || t === 'car', active: false };
      this.ents.push(te);
      this.byEntity.set(e.id, te);
      // Ground covered by a building footprint: no exchange with the air (contacts only).
      if (t === 'building') this.rasterize(e, (c) => { g.covered[c] = 1; });
    }
  }

  // ── Geometry helpers ───────────────────────────────────

  /** Cells whose centre lies inside the footprint of an entity (oriented box). */
  private rasterize(e: RuntimeEntity, f: (c: number, ax: number, az: number) => void, margin = 0) {
    const g = this.world.terrain;
    const p = e.pose.position, q = e.pose.quaternion;
    const hx = e.dims[0] / 2 + margin, hz = e.dims[2] / 2 + margin;
    const ax = qRotate(q, [1, 0, 0]), az = qRotate(q, [0, 0, 1]);
    const r = Math.hypot(hx, hz);
    const i0 = Math.max(0, Math.floor((p[0] - r - g.originX) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((p[0] + r - g.originX) / g.cell));
    const k0 = Math.max(0, Math.floor((p[2] - r - g.originZ) / g.cell)), k1 = Math.min(g.nz - 1, Math.floor((p[2] + r - g.originZ) / g.cell));
    for (let iz = k0; iz <= k1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const x = g.originX + (ix + 0.5) * g.cell - p[0], z = g.originZ + (iz + 0.5) * g.cell - p[2];
        const lx = x * ax[0] + z * ax[2], lz = x * az[0] + z * az[2];
        if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) f(iz * g.nx + ix, lx, lz);
      }
    }
  }

  private groundY(ctx: SystemContext, x: number, z: number) {
    return ctx.env.terrain.sampleHeight(x, z);
  }

  /** Air-layer column (or −1 above) at a world point. */
  private airAt(ctx: SystemContext, x: number, y: number, z: number) {
    return this.world.air.index(x, z, y - this.groundY(ctx, x, z));
  }

  // ── Activation ─────────────────────────────────────────

  private envDeviation(ctx: SystemContext, te: EntityThermal): boolean {
    const p = te.e.pose.position;
    const a = this.airAt(ctx, p[0], p[1] + te.e.dims[1] / 2, p[2]);
    if (Math.abs(this.world.air.T(a) - this.world.Tref) > ACTIVATE) return true;
    const c = this.world.terrain.index(p[0], p[2]);
    return c >= 0 && Math.abs(this.world.terrain.T(c, 0) - this.world.Tref) > ACTIVATE;
  }

  activate(ctx: SystemContext, te: EntityThermal) {
    if (te.active) return;
    te.active = true;
    if (te.kind === 'modular') this.createBuilding(ctx, te);
    else this.createObject(ctx, te);
  }

  private createObject(ctx: SystemContext, te: EntityThermal) {
    const e = te.e, w = this.world;
    const [W, Hh, D] = e.dims;
    const mass = Math.max(1, e.source.physics.mass);
    const Av = 2 * (W + D) * Hh, Atop = W * D, Abot = te.kind === 'building' ? 0 : W * D;
    const base: Omit<BodyInit, 'mSkin' | 'mCore' | 'matSkin' | 'matCore' | 'tSkin' | 'Asc' | 'Lsc'> = {
      kind: BK.entity, Av, Atop, Abot, Lv: Hh, Lh: (W * D) / Math.max(0.1, 2 * (W + D)), Lf: Math.max(W, D), fOut: 1, fC1: 0, fC2: 0, comp1: -1, comp2: -1,
      sx: W, sy: Hh, sz: D, x: 0, y: 0, z: 0, yg: 0, ref: this.ents.indexOf(te), sub: -1,
    };
    let init: BodyInit;
    switch (te.kind) {
      case 'building': {
        // Envelope: a 0.1 m concrete / masonry shell over the facades and the roof; the rest is the interior.
        const A = Av + Atop;
        const mS = Math.min(0.5 * mass, A * 0.1 * 2300);
        init = { ...base, mSkin: mS, mCore: mass - mS, matSkin: TM.pavingConcrete, matCore: TM.pavingConcrete, tSkin: 0.1, Asc: A, Lsc: 0.2 + Math.min(W, D) / 4 };
        break;
      }
      case 'car':
        init = { ...base, mSkin: 0.3 * mass, mCore: 0.7 * mass, matSkin: TM.vehicle, matCore: TM.vehicle, tSkin: 0.002, Asc: 0.5 * (Av + Atop), Lsc: 0.1 };
        break;
      case 'tree': {
        const p = e.source.params as Record<string, number>;
        const cr = p.canopyRadius ?? 2, tr = p.trunkRadius ?? 0.3, h = p.height ?? Hh;
        const canopy = Math.min(0.6 * mass, cr ** 3 * 18);
        init = {
          ...base, Av: 4 * Math.PI * cr * cr * 0.75 + 2 * Math.PI * tr * h, Atop: Math.PI * cr * cr * 0.25, Abot: 0, Lv: 2 * cr, Lh: cr / 2, Lf: 2 * cr,
          mSkin: canopy, mCore: mass - canopy, matSkin: TM.foliage, matCore: TM.wood, tSkin: 0.002, Asc: 2 * Math.PI * tr * h * 0.5, Lsc: tr / 2,
        };
        break;
      }
      case 'wall': {
        const t = Math.min(W, D);
        const two = t > 2 * SKIN;
        init = { ...base, Atop: 0, Abot: 0, Av: 2 * Math.max(W, D) * Hh, mSkin: two ? mass * Math.min(0.8, (2 * SKIN) / t) : mass, mCore: two ? mass * (1 - Math.min(0.8, (2 * SKIN) / t)) : 0, matSkin: TM.masonry, matCore: TM.masonry, tSkin: two ? SKIN : t, Asc: 2 * Math.max(W, D) * Hh, Lsc: Math.max(0.01, t / 2 - SKIN / 2) };
        break;
      }
      default:
        init = { ...base, mSkin: mass, mCore: 0, matSkin: TM.steel, matCore: TM.steel, tSkin: 0.01, Asc: 0, Lsc: 1 };
    }
    const i = w.bodies.add(init);
    te.body = i;
    this.placeObject(ctx, te);
    if (te.kind === 'building') this.rasterize(e, (c) => w.bodies.addContact(i, c, w.terrain.area, 0.1));
  }

  private placeObject(ctx: SystemContext, te: EntityThermal) {
    const e = te.e, b = this.world.bodies, i = te.body;
    const p = e.pose.position;
    const up = qRotate(e.pose.quaternion, [0, e.dims[1] / 2, 0]);
    const x = p[0] + up[0], y = p[1] + up[1], z = p[2] + up[2];
    this.world.placeBody(i, x, y, z, this.groundY(ctx, x, z));
    b.wind[i] = e.localWind?.speed ?? 0;
  }

  // ── Modular buildings ──────────────────────────────────

  private createBuilding(ctx: SystemContext, te: EntityThermal) {
    const e = te.e, w = this.world, mr = e.modular!;
    const g = graphOf(mr.design, mr.scale);
    const n = g.n;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, top = 0;
    for (let i = 0; i < n; i++) {
      const o = 6 * i;
      if (g.level[i] < 0) continue;
      x0 = Math.min(x0, g.box[o]); z0 = Math.min(z0, g.box[o + 2]); x1 = Math.max(x1, g.box[o + 3]); z1 = Math.max(z1, g.box[o + 5]); top = Math.max(top, g.box[o + 4]);
    }
    const bt: BuildingThermal = {
      e, g, body: new Int32Array(n).fill(-1), wS: new Float32Array(n).fill(1), tmat: new Uint8Array(n), comp: new Int32Array(Math.max(1, mr.floors)).fill(-1),
      perimeter: new Uint8Array(n), lastState: new Uint8Array(n), fApplied: new Float64Array(n).fill(1), nApplied: new Float64Array(n), util: new Float64Array(n),
      strain: new Float32Array(n), restraint: new Float32Array(n), bow: new Float32Array(n), restraintRev: -1, crush: new Float64Array(n), buckle: new Float64Array(n),
      thermalFailures: 0, minFactor: 1, bounds: { x0, z0, x1, z1, top },
    };
    te.b = bt;
    this.buildings.push(bt);
    // Rooms: one compartment per story (plan area × story height), ventilated with the outdoors.
    const spec = mr.design.spec;
    const sy = mr.scale[1];
    let y = 0;
    const planA = Math.max(1, (x1 - x0) * (z1 - z0));
    for (let s = 0; s < mr.floors; s++) {
      const h = (s === 0 ? spec.groundFloorHeight ?? spec.floorHeight : spec.floorHeight) * sy;
      const c = this.toWorld(e, [(x0 + x1) / 2, y + h / 2, (z0 + z1) / 2]);
      bt.comp[s] = w.addCompartment(planA * h, this.airAt(ctx, c[0], c[1], c[2]), ROOM_ACH);
      y += h;
    }
    const state = mr.structure?.model.state;
    for (let i = 0; i < n; i++) {
      bt.tmat[i] = STRUCTURAL_THERMAL[MATERIAL_KEYS[g.mat[i]]] ?? TM.concrete;
      if (g.absent[i] || (state && state[i] >= MS.FAILED)) { bt.lastState[i] = state ? state[i] : MS.ABSENT; if (g.absent[i]) continue; }
      const o = 6 * i;
      bt.perimeter[i] = g.box[o] <= x0 + PERIM_EDGE || g.box[o + 3] >= x1 - PERIM_EDGE || g.box[o + 2] <= z0 + PERIM_EDGE || g.box[o + 5] >= z1 - PERIM_EDGE ? 1 : 0;
      this.memberBody(ctx, bt, i);
      this.capacities(bt, i);
    }
  }

  private toWorld(e: RuntimeEntity, local: Vec3): Vec3 {
    const p = qRotate(e.pose.quaternion, local);
    return [e.pose.position[0] + p[0], e.pose.position[1] + p[1], e.pose.position[2] + p[2]];
  }

  private memberBody(ctx: SystemContext, bt: BuildingThermal, i: number) {
    const g = bt.g, o = 6 * i, w = this.world;
    const bx = g.box[o + 3] - g.box[o], by = g.box[o + 4] - g.box[o + 1], bz = g.box[o + 5] - g.box[o + 2];
    const t = g.type[i], tm = bt.tmat[i];
    const props = MATERIALS[MATERIAL_KEYS[g.mat[i]]];
    const mass = Math.max(1e-3, g.mass[i]);
    const L = Math.max(bx, bz), Wd = Math.min(bx, bz);
    let Av = 0, Atop = 0, Abot = 0;
    if (t === MT_COLUMN) Av = 2 * (bx + bz) * by;
    else if (t === MT_WALL || t === MT_WINDOW || t === MT_DOOR) Av = 2 * L * by;
    else if (t === MT_BEAM) { Av = 2 * L * by; Abot = L * Wd; }
    else if (t === MT_SLAB || t === MT_ROOF) { Atop = bx * bz; Abot = g.ground[i] ? 0 : bx * bz; Av = 2 * (bx + bz) * by; }
    const A = Av + Atop + Abot;
    const V = mass / Math.max(1, props.density);
    const dEff = A > 0 ? (2 * V) / A : Math.min(bx, by, bz);
    const lumped = tm === TM.steel || tm === TM.cladding || tm === TM.glass || dEff <= 2 * SKIN || t === MT_FOUNDATION;
    const wS = lumped ? 1 : Math.min(0.8, (SKIN * A) / V);
    bt.wS[i] = wS;
    // Exposure of the faces: outdoors (perimeter / roof), rooms of its story (and the one above for slabs).
    const floors = bt.comp.length;
    const lv = g.level[i];
    const compOf = (s: number) => (s >= 0 && s < floors ? bt.comp[s] : -1);
    let fOut = 0, fC1 = 0, fC2 = 0, c1 = -1, c2 = -1;
    const per = bt.perimeter[i] === 1;
    if (t === MT_FOUNDATION) { /* buried: ground contact only */ }
    else if (t === MT_SLAB && g.ground[i]) { fC1 = 1; c1 = compOf(0); }
    else if (t === MT_SLAB) { c1 = compOf(lv); c2 = compOf(lv + 1); fC1 = c1 >= 0 ? 0.5 : 0; if (c2 >= 0) fC2 = 0.5; else fOut = 0.5; }
    else if (t === MT_ROOF) { c1 = compOf(floors - 1); fC1 = 0.5; fOut = 0.5; }
    else if (t === MT_WALL || t === MT_WINDOW || t === MT_DOOR) { c1 = compOf(lv); if (per) { fOut = 0.5; fC1 = 0.5; } else fC1 = 1; }
    else { c1 = compOf(lv); fOut = per ? 0.25 : 0; fC1 = 1 - fOut; }
    if (c1 < 0 && fC1 > 0) { fOut += fC1; fC1 = 0; }
    const init: BodyInit = {
      kind: BK.member, mSkin: mass * wS, mCore: mass * (1 - wS), matSkin: tm, matCore: tm, Av, Atop, Abot, Lv: Math.max(0.05, by),
      Lh: (bx * bz) / Math.max(0.1, 2 * (bx + bz)), Lf: Math.max(0.1, L), tSkin: lumped ? Math.min(0.01, dEff) : SKIN, Asc: A, Lsc: Math.max(0.01, dEff / 2 - SKIN / 2),
      fOut, fC1, fC2, comp1: c1, comp2: c2, sx: bx, sy: by, sz: bz, x: 0, y: 0, z: 0, yg: 0, ref: this.buildings.indexOf(bt), sub: i,
    };
    const b = w.bodies.add(init);
    bt.body[i] = b;
    this.placeMember(ctx, bt, i);
    // Ground contacts: foundations and slabs on grade over the cells under their footprint.
    if (t === MT_FOUNDATION || g.ground[i]) {
      const cells: number[] = [];
      const c0 = this.toWorld(bt.e, [g.box[o], 0, g.box[o + 2]]), c3 = this.toWorld(bt.e, [g.box[o + 3], 0, g.box[o + 5]]);
      const gx0 = Math.min(c0[0], c3[0]), gx1 = Math.max(c0[0], c3[0]), gz0 = Math.min(c0[2], c3[2]), gz1 = Math.max(c0[2], c3[2]);
      const tr = w.terrain;
      for (let z = gz0 + 0.5; z < gz1; z += tr.cell) for (let x = gx0 + 0.5; x < gx1; x += tr.cell) { const c = tr.index(x, z); if (c >= 0) cells.push(c); }
      if (!cells.length) { const c = tr.index((gx0 + gx1) / 2, (gz0 + gz1) / 2); if (c >= 0) cells.push(c); }
      const a = (bx * bz) / Math.max(1, cells.length);
      for (const c of cells) w.bodies.addContact(b, c, a, Math.max(0.01, by / 2));
    }
  }

  private placeMember(ctx: SystemContext, bt: BuildingThermal, i: number) {
    const g = bt.g, o = 6 * i, m = bt.e.modular!.structure?.model;
    const loc: Vec3 = [(g.box[o] + g.box[o + 3]) / 2 + (m ? m.dx[i] : 0), (g.box[o + 1] + g.box[o + 4]) / 2 + (m ? m.dy[i] : 0), (g.box[o + 2] + g.box[o + 5]) / 2 + (m ? m.dz[i] : 0)];
    const c = this.toWorld(bt.e, loc);
    const b = bt.body[i];
    this.world.placeBody(b, c[0], c[1], c[2], this.groundY(ctx, c[0], c[2]));
    this.world.bodies.wind[b] = bt.perimeter[i] ? bt.e.localWind?.speed ?? 0 : 0;
  }

  /** Crushing / buckling capacity of a vertical member (the Phase 17 / 25 column formulas, split). */
  private capacities(bt: BuildingThermal, i: number) {
    const g = bt.g, o = 6 * i, t = g.type[i];
    if (!g.structural[i] || (t !== MT_COLUMN && t !== MT_WALL)) return;
    const mat = MATERIALS[MATERIAL_KEYS[g.mat[i]]];
    const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
    if (t === MT_COLUMN) {
      const A = sx * sz * mat.fill.column;
      const I = ((Math.min(sx, sz) ** 3 * Math.max(sx, sz)) / 12) * mat.inertiaFill;
      bt.crush[i] = mat.compressive * A;
      bt.buckle[i] = (Math.PI ** 2 * mat.E * mat.stiffnessFactor * I) / (sy * sy);
    } else {
      bt.crush[i] = g.capN[i];
      bt.buckle[i] = Infinity;
    }
  }

  // ── Per step ───────────────────────────────────────────

  /** Everything before the world step; returns the sources' inputs for [t, t + dt). */
  prepare(ctx: SystemContext, dt: number): SourceStep[] {
    const w = this.world, env = ctx.env;
    // Wind of this step (10 m speed, flow direction).
    w.u10 = env.wind.baseSpeed;
    const fv = env.wind.flow();
    const fl = Math.hypot(fv[0], fv[2]) || 1;
    w.flowX = fv[0] / fl;
    w.flowZ = fv[2] / fl;
    this.attachWater(ctx);
    // Impact heat deposits that are due.
    for (const d of env.thermal.deposits) {
      if (d.done || ctx.time + dt <= d.time) continue;
      d.done = true;
      const cells: number[] = [];
      const g = w.terrain;
      for (let z = d.z - d.radius; z <= d.z + d.radius; z += g.cell) for (let x = d.x - d.radius; x <= d.x + d.radius; x += g.cell) {
        if (Math.hypot(x - d.x, z - d.z) > d.radius) continue;
        const c = g.index(x, z);
        if (c >= 0) cells.push(c);
      }
      if (!cells.length) { const c = g.index(d.x, d.z); if (c >= 0) cells.push(c); }
      for (const c of cells) w.deposit(TK.ground, c, d.energy / cells.length);
      w.ledger.impactDeposit += cells.length ? d.energy : 0;
      if (!cells.length) w.ledger.impactDeposit += 0;
    }
    // Activation by surroundings, placement of moving bodies, state of building members.
    for (const te of this.ents) {
      if (!te.active) { if (this.envDeviation(ctx, te)) this.activate(ctx, te); continue; }
      if (te.b) this.scanBuilding(ctx, te.b);
      else if (te.dynamic || te.e.dynamic) this.placeObject(ctx, te);
    }
    this.followFragments(ctx);
    this.updateHeaps(ctx);
    // Sources.
    const steps: SourceStep[] = [];
    const bodiesNow = w.bodies.n;
    // Canonical order (start time, then the spec itself) — not the order they were added in, so
    // several sources sum into shared receivers identically whatever the plan order or ids.
    const ordered = [...env.thermal.sources].sort((p, q) => p.start - q.start || canonical(p).localeCompare(canonical(q)));
    for (const s of ordered) {
      const a = this.upto.get(s.id) ?? 0;
      const b = ctx.time + dt - s.start;
      if (b <= a) continue;
      this.upto.set(s.id, b);
      if (s.spec.profile !== 'instant' && a >= s.spec.duration) continue;
      let g = this.geom.get(s.id);
      if (!g || ctx.time - g.builtAt >= GEOM_PERIOD || (g.bodies !== bodiesNow && this.bodiesAtGeom !== bodiesNow)) {
        g = this.buildGeometry(ctx, s);
        this.geom.set(s.id, g);
        this.bodiesAtGeom = w.bodies.n;
      }
      if (s.spec.kind === 'temperature') {
        steps.push({ id: s.id, energy: 0, deposits: [], temperature: intervalTemperature(s.spec, a, b, w.Tref), exchanges: g.exchanges });
      } else {
        const E = intervalEnergy(s.spec, a, b);
        steps.push({ id: s.id, energy: E, deposits: g.deposits, aboveLayer: g.aboveLayer });
        // Peak surface heat flux of the step (receivers: deposit per area).
        if (E > 0) for (const d of g.deposits) { const A = this.areaOf(d); if (A > 0) this.stats.maxFlux = Math.max(this.stats.maxFlux, (E * d.w) / (b - a) / A); }
      }
    }
    return steps;
  }

  private areaOf(d: Deposit): number {
    const w = this.world;
    if (d.kind === TK.ground || d.kind === TK.water) return w.terrain.area;
    if (d.kind === TK.body) return w.bodies.Av[d.index] + w.bodies.Atop[d.index] + w.bodies.Abot[d.index];
    return 0;
  }

  /** Give the water its heat array the first time the water model and the thermal state coexist. */
  private attachWater(ctx: SystemContext) {
    const f = ctx.env.flood.field;
    const w = this.world;
    if (!f) return;
    if (!f.heat) {
      f.heat = new Float64Array(f.count);
      f.infilHeat = new Float64Array(f.count);
    }
    if (!w.water) w.water = { h: f.h, heat: f.heat, infilHeat: f.infilHeat, cellArea: f.cellArea, out: 0, moved: 0 };
    w.water.out += f.heatOut;
    w.water.moved += f.heatMoved;
    f.heatOut = 0;
    f.heatMoved = 0;
  }

  /** Member state changes since the last step: debris follows, rubble merges, rooms open. */
  private scanBuilding(ctx: SystemContext, bt: BuildingThermal) {
    const m = bt.e.modular!.structure?.model;
    const w = this.world, B = w.bodies;
    const moved = !!m && m.rev !== (bt as unknown as { seenRev?: number }).seenRev;
    if (m) (bt as unknown as { seenRev?: number }).seenRev = m.rev;
    if (!m) return;
    const S = ctx.runtime.structures;
    for (let i = 0; i < bt.g.n; i++) {
      const b = bt.body[i];
      if (b < 0 || !B.alive[b]) continue;
      const st = m.state[i];
      const last = bt.lastState[i];
      if (st !== last) {
        bt.lastState[i] = st;
        if (st >= MS.FAILED && last < MS.FAILED) {
          // Out of the structure: its faces see the outdoors (rubble), no ground contact any more.
          B.fOut[b] = 1; B.fC1[b] = 0; B.fC2[b] = 0;
          B.dropContacts(b);
          B.wind[b] = bt.e.localWind?.speed ?? 0;
          if (m.hazardName(i) === 'thermal' || m.causeHazard[i] === m.hazards.indexOf('thermal')) bt.thermalFailures++;
        }
        if (st === MS.SETTLED) {
          if (!m.external[i] || !this.hasFragment(b)) this.intoRubble(ctx, b, B.x[b], B.z[b]);
          continue;
        }
      }
      if (m.external[i]) continue; // fragment bodies are placed by followFragments
      if (moved && st >= MS.FAILED) this.placeMember(ctx, bt, i);
    }
    // Stories that no longer stand: their room joins the outdoors.
    const mr = bt.e.modular!;
    for (let s = Math.max(0, mr.collapsedFrom); s < bt.comp.length; s++) if (Number.isFinite(mr.collapsedFrom) && bt.comp[s] >= 0) w.openCompartment(bt.comp[s]);
    void S;
  }

  private hasFragment(b: number) {
    return this.fragOf.has(b);
  }

  /** Bodies of structural fragments follow their rigid body; gone fragments leave or merge. */
  private followFragments(ctx: SystemContext) {
    const S = ctx.runtime.structures;
    if (!S) return;
    const w = this.world, B = w.bodies;
    const live = new Set<DebrisPiece>();
    for (const d of S.fragments) {
      const s = d.structural!;
      const te = this.byEntity.get(s.owner);
      const bt = te?.b;
      if (!bt) continue;
      const b = bt.body[s.member];
      if (b < 0 || !B.alive[b]) continue;
      live.add(d);
      this.fragOf.set(b, d);
      const p = d.pose.position;
      w.placeBody(b, p[0], p[1], p[2], this.groundY(ctx, p[0], p[2]));
      B.wind[b] = ctx.env.wind.baseSpeed;
    }
    for (const [b, d] of this.fragOf) {
      if (live.has(d)) continue;
      this.fragOf.delete(b);
      if (!B.alive[b]) continue;
      const p = d.pose.position;
      const inside = w.terrain.index(p[0], p[2]) >= 0;
      // Aggregated into rubble (still in the world) or gone beyond the edge.
      if (inside && (d.structural!.settled || ctx.runtime.debris.indexOf(d) < 0)) this.intoRubble(ctx, b, p[0], p[2]);
      else w.removeBody(b);
    }
  }

  /** Move a body's energy into the rubble heap at a point (or the ground cell when there is none). */
  private intoRubble(ctx: SystemContext, b: number, x: number, z: number) {
    const w = this.world;
    const S = ctx.runtime.structures;
    const hit = S?.rubble.heightAt(x, z);
    if (hit?.heap) {
      const hb = this.heapBodyOf(ctx, hit.heap);
      w.mergeBody(b, { kind: TK.body, index: hb });
      return;
    }
    const c = w.terrain.index(x, z);
    if (c >= 0) w.mergeBody(b, { kind: TK.ground, index: c });
    else w.removeBody(b);
  }

  private heapBodyOf(ctx: SystemContext, h: import('../structure/rubbleField').RubbleHeap): number {
    const w = this.world;
    let b = this.heapBody.get(h.id);
    if (b !== undefined) return b;
    b = w.bodies.add({
      kind: BK.heap, mSkin: Math.max(1, h.mass), mCore: 0, matSkin: TM.debris, matCore: TM.debris, cOverride: HEAP_C, Av: 0, Atop: 4 * h.hx * h.hz * 1.15, Abot: 0,
      Lv: Math.max(0.2, h.height), Lh: (h.hx * h.hz) / Math.max(0.1, h.hx + h.hz), Lf: 2 * Math.max(h.hx, h.hz), tSkin: 0.1, Asc: 0, Lsc: 1,
      fOut: 1, fC1: 0, fC2: 0, comp1: -1, comp2: -1, sx: 2 * h.hx, sy: Math.max(0.2, h.height), sz: 2 * h.hz, x: 0, y: 0, z: 0, yg: 0, ref: h.id, sub: -2,
    });
    this.heapBody.set(h.id, b);
    this.heapMass.set(h.id, h.mass);
    w.placeBody(b, h.cx, h.y + h.height / 2, h.cz, h.y);
    this.heapContacts(b, h);
    void ctx;
    return b;
  }

  private heapContacts(b: number, h: import('../structure/rubbleField').RubbleHeap) {
    const w = this.world, tr = w.terrain;
    w.bodies.dropContacts(b);
    const cells: number[] = [];
    for (let z = h.cz - h.hz + 0.5; z < h.cz + h.hz; z += tr.cell) for (let x = h.cx - h.hx + 0.5; x < h.cx + h.hx; x += tr.cell) { const c = tr.index(x, z); if (c >= 0) cells.push(c); }
    if (!cells.length) { const c = tr.index(h.cx, h.cz); if (c >= 0) cells.push(c); }
    const a = (4 * h.hx * h.hz) / Math.max(1, cells.length);
    for (const c of cells) w.bodies.addContact(b, c, a, Math.max(0.05, h.height / 2));
  }

  /** Heaps grow: their body's mass (capacity) and footprint follow; the energy stays. */
  private updateHeaps(ctx: SystemContext) {
    const S = ctx.runtime.structures;
    if (!S) return;
    const B = this.world.bodies;
    for (const [id, b] of this.heapBody) {
      const h = S.rubble.heaps[id];
      if (!h || this.heapMass.get(id) === h.mass) continue;
      this.heapMass.set(id, h.mass);
      B.mS[b] = Math.max(1, h.mass);
      B.Atop[b] = 4 * h.hx * h.hz * 1.15;
      B.sx[b] = 2 * h.hx; B.sz[b] = 2 * h.hz; B.sy[b] = Math.max(0.2, h.height);
      B.refresh(b);
      this.world.placeBody(b, h.cx, h.y + h.height / 2, h.cz, h.y);
      this.heapContacts(b, h);
    }
  }

  // ── Source geometry ────────────────────────────────────

  private buildGeometry(ctx: SystemContext, s: SourceRecord): SourceGeom {
    const w = this.world, spec = s.spec, B = w.bodies, tr = w.terrain;
    const [sx, sz] = spec.position;
    const yg = this.groundY(ctx, sx, sz);
    const P: Vec3 = [sx, yg + spec.height, sz];
    const deposits: Deposit[] = [];
    const exchanges: Exchange[] = [];
    let aboveLayer = 0;
    // Bring every object in reach into the network first (so it can receive).
    const reach = sourceReach(spec, w.Tref);
    for (const te of this.ents) {
      if (te.active) continue;
      const p = te.e.pose.position;
      if (Math.hypot(p[0] - P[0], p[2] - P[2]) <= reach + Math.hypot(te.e.dims[0], te.e.dims[2]) / 2) this.activate(ctx, te);
    }
    const inside = this.buildingContaining(P);
    const shield = this.shields(P, reach);
    const grid: GroundGrid = {
      nx: tr.nx, nz: tr.nz, cell: tr.cell, originX: tr.originX, originZ: tr.originZ, height: (x, z) => this.groundY(ctx, x, z), covered: (c) => tr.covered[c] === 1,
      emissivity: (c) => (w.water && w.water.h[c] > WATER_MERGE ? 0.96 : tr.emiss[c]),
    };
    switch (spec.kind) {
      case 'point': {
        const frac = radiativeFraction(spec);
        const P0 = Math.max(1e-9, spec.profile === 'instant' ? (spec.energy ?? 0) : amplitude(spec));
        const bodyW: Deposit[] = [];
        let down = 0;
        for (let i = 0; i < B.n; i++) {
          if (!B.alive[i]) continue;
          const dx = B.x[i] - P[0], dy = B.y[i] - P[1], dz = B.z[i] - P[2];
          const r = Math.hypot(dx, dy, dz);
          if (r > reach) continue;
          const vis = this.visible(i, P, inside, shield);
          if (vis <= 0) continue;
          const Ap = this.projected(i, -dx / Math.max(r, 1e-9), -dy / Math.max(r, 1e-9), -dz / Math.max(r, 1e-9)) * vis;
          const f = frac * pointFraction(Ap, Math.max(0.3, r));
          if ((f * P0) / Math.max(1e-6, Ap) < IRRADIANCE_FLOOR) continue;
          const wgt = f * THERMAL_MATERIALS[B.matS[i]].emissivity;
          bodyW.push({ kind: TK.body, index: i, w: wgt });
          if (dy < 0) down += f;
        }
        const ground: Deposit[] = [];
        let gsum = 0;
        // Inside a room the walls stand between the source and the ground outside.
        if (!inside) for (const r of groundReceivers(spec, grid, w.Tref)) { ground.push({ kind: TK.ground, index: r.cell, w: r.w }); gsum += r.w / r.eps; }
        // Objects below the source shade the ground they stand on (conservative uniform reduction).
        const shade = gsum > 0 ? Math.max(0, (gsum - down) / gsum) : 0;
        for (const d of ground) d.w *= shade;
        deposits.push(...bodyW, ...ground);
        // Convected share: the air around it (the room when inside a building).
        const conv = 1 - frac;
        if (conv > 0) {
          if (inside) deposits.push({ kind: TK.comp, index: inside.comp, w: conv });
          else { const a = w.air.index(P[0], P[2], P[1] - yg); if (a >= 0) deposits.push({ kind: TK.air, index: a, w: conv }); else aboveLayer = conv; }
        }
        break;
      }
      case 'area': {
        const rs = groundReceivers(spec, grid, w.Tref);
        if (!rs.length) { const c = tr.index(P[0], P[2]); if (c >= 0) rs.push({ cell: c, w: 1, aConv: 0, eps: 1 }); }
        for (const r of rs) deposits.push({ kind: TK.ground, index: r.cell, w: r.w });
        break;
      }
      case 'surface': {
        const items: Deposit[] = [];
        let total = 0;
        for (let i = 0; i < B.n; i++) {
          if (!B.alive[i]) continue;
          if (Math.hypot(B.x[i] - P[0], B.y[i] - P[1], B.z[i] - P[2]) > spec.radius) continue;
          const A = (B.Av[i] + B.Atop[i] + B.Abot[i]) * Math.min(1, B.fOut[i] + B.fC1[i] + B.fC2[i] || 1);
          if (A <= 0) continue;
          items.push({ kind: TK.body, index: i, w: A });
          total += A;
        }
        for (const r of groundReceivers(spec, grid, w.Tref)) { items.push({ kind: TK.ground, index: r.cell, w: r.w }); total += r.w; }
        if (total <= 0) { const c = tr.index(P[0], P[2]); if (c >= 0) { items.push({ kind: TK.ground, index: c, w: 1 }); total = 1; } }
        for (const d of items) deposits.push({ ...d, w: d.w / total });
        break;
      }
      case 'volume': {
        if (inside) deposits.push({ kind: TK.comp, index: inside.comp, w: 1 });
        else {
          const cells = this.airOverlap(P, spec.radius, yg);
          if (!cells.length) aboveLayer = 1;
          for (const [a, f] of cells) deposits.push({ kind: TK.air, index: a, w: f });
        }
        break;
      }
      case 'temperature': {
        const R = spec.radius;
        const Ts = spec.temperature ?? w.Tref;
        const E4 = SIGMA * Math.abs(Ts ** 4 - w.Tref ** 4);
        const far = Math.min(60, R * Math.sqrt(E4 / IRRADIANCE_FLOOR));
        for (let i = 0; i < B.n; i++) {
          if (!B.alive[i]) continue;
          const dx = B.x[i] - P[0], dy = B.y[i] - P[1], dz = B.z[i] - P[2];
          const r = Math.hypot(dx, dy, dz);
          const A = B.Av[i] + B.Atop[i] + B.Abot[i];
          const eps = THERMAL_MATERIALS[B.matS[i]].emissivity;
          if (r <= R) { exchanges.push({ kind: TK.body, index: i, aRad: A, aConv: A, eps, L: B.Lv[i] }); continue; }
          if (r > far + R) continue;
          const vis = this.visible(i, P, inside, shield);
          if (vis <= 0) continue;
          const Ap = this.projected(i, -dx / r, -dy / r, -dz / r) * vis;
          exchanges.push({ kind: TK.body, index: i, aRad: Ap * sphereViewFactor(R, r), aConv: 0, eps, L: B.Lv[i] });
        }
        if (!inside) for (const r of groundReceivers(spec, grid, w.Tref)) exchanges.push({ kind: TK.ground, index: r.cell, aRad: r.w, aConv: r.aConv, eps: r.eps, L: 1 });
        // The sphere's surface convects into the air (or the room) it occupies.
        const As = 4 * Math.PI * R * R;
        if (inside) exchanges.push({ kind: TK.comp, index: inside.comp, aRad: 0, aConv: As, eps: 1, L: R });
        else for (const [a, f] of this.airOverlap(P, R, yg)) exchanges.push({ kind: TK.air, index: a, aRad: 0, aConv: As * f, eps: 1, L: R });
        break;
      }
    }
    return { deposits, exchanges, aboveLayer, builtAt: ctx.time, bodies: B.n };
  }

  /** Air-layer columns overlapped by a disc (fractions of the disc area, summing to 1). */
  private airOverlap(P: Vec3, R: number, yg: number): [number, number][] {
    const air = this.world.air;
    const n = 12;
    const counts = new Map<number, number>();
    let total = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const x = P[0] - R + ((a + 0.5) / n) * 2 * R, z = P[2] - R + ((b + 0.5) / n) * 2 * R;
      if ((x - P[0]) ** 2 + (z - P[2]) ** 2 > R * R) continue;
      const k = air.index(x, z, P[1] - yg);
      total++;
      if (k >= 0) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((p, q) => p[0] - q[0]).map(([k, c]) => [k, c / Math.max(1, total)]);
  }

  /** The modular building room containing a point (local plan bounds, story by height). */
  private buildingContaining(P: Vec3): { bt: BuildingThermal; comp: number } | null {
    for (const bt of this.buildings) {
      const e = bt.e, q = e.pose.quaternion;
      const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
      const l = qRotate(inv, [P[0] - e.pose.position[0], P[1] - e.pose.position[1], P[2] - e.pose.position[2]]);
      const b = bt.bounds;
      if (l[0] < b.x0 || l[0] > b.x1 || l[2] < b.z0 || l[2] > b.z1 || l[1] < 0 || l[1] > b.top) continue;
      const mr = e.modular!;
      let y = 0;
      for (let s = 0; s < bt.comp.length; s++) {
        const h = (s === 0 ? mr.design.spec.groundFloorHeight ?? mr.design.spec.floorHeight : mr.design.spec.floorHeight) * mr.scale[1];
        if (l[1] < y + h || s === bt.comp.length - 1) {
          const c = bt.comp[s];
          return c >= 0 && this.world.comps[c].alive ? { bt, comp: c } : null;
        }
        y += h;
      }
    }
    return null;
  }

  /** Building footprints near a source that can shade objects from it. */
  private shields(P: Vec3, reach: number) {
    const out: { e: RuntimeEntity; top: number }[] = [];
    for (const te of this.ents) {
      if (te.kind !== 'building' && te.kind !== 'modular') continue;
      const p = te.e.pose.position;
      if (Math.hypot(p[0] - P[0], p[2] - P[2]) > reach + Math.hypot(te.e.dims[0], te.e.dims[2])) continue;
      out.push({ e: te.e, top: p[1] + te.e.dims[1] });
    }
    return out;
  }

  /** Visibility (0 / 1) of a body from a point source. */
  private visible(i: number, P: Vec3, inside: { bt: BuildingThermal; comp: number } | null, shields: { e: RuntimeEntity; top: number }[]): number {
    const B = this.world.bodies;
    if (B.kind[i] === BK.member && B.sub[i] >= 0) {
      const bt = this.buildings[B.ref[i]];
      const m = B.sub[i];
      const st = bt.e.modular!.structure?.model.state[m] ?? MS.INTACT;
      if (st >= MS.FAILED) return 1; // debris lies in the open
      if (inside && inside.bt === bt) {
        // Inside a room: the members of that story (and the slabs bounding it).
        const lv = bt.g.level[m];
        const story = bt.comp.indexOf(inside.comp);
        return lv === story || (bt.g.type[m] === MT_SLAB && (lv === story || lv === story - 1)) ? 1 : 0;
      }
      if (!bt.perimeter[m]) return 0;
      // Facing side only: the member lies on the source's side of the building centre.
      const c = bt.e.pose.position;
      return (B.x[i] - c[0]) * (P[0] - c[0]) + (B.z[i] - c[2]) * (P[2] - c[2]) >= 0 ? 1 : 0;
    }
    // Other objects: shaded when the straight path crosses another building below its roof.
    const own = B.kind[i] === BK.entity ? this.ents[B.ref[i]]?.e : null;
    for (const s of shields) {
      if (s.e === own) continue;
      if (segmentHitsBox(P, [B.x[i], B.y[i], B.z[i]], s.e, s.top)) return 0;
    }
    return 1;
  }

  /** Projected area of a body toward a direction (world). */
  private projected(i: number, dx: number, dy: number, dz: number): number {
    const B = this.world.bodies;
    let d: Vec3 = [dx, dy, dz];
    if (B.kind[i] === BK.member && B.sub[i] >= 0) {
      const q = this.buildings[B.ref[i]].e.pose.quaternion;
      d = qRotate([-q[0], -q[1], -q[2], q[3]], d);
    } else if (B.kind[i] === BK.entity) {
      const q = this.ents[B.ref[i]].e.pose.quaternion;
      d = qRotate([-q[0], -q[1], -q[2], q[3]], d);
    }
    return projectedArea(B.sx[i], B.sy[i], B.sz[i], d[0], d[1], d[2]);
  }

  // ── After the world step ───────────────────────────────

  after(ctx: SystemContext) {
    this.couple(ctx);
    this.exposure(ctx);
    this.statistics(ctx);
  }

  /** Temperature → material factor and restrained thermal force on the collapse engine. */
  private couple(ctx: SystemContext) {
    const B = this.world.bodies, Tref = this.world.Tref;
    const mode = this.world.settings.restraint;
    for (const bt of this.buildings) {
      const g = bt.g;
      let model = bt.e.modular!.structure?.model;
      // Restraint of the frame as it stands (−2: the original structure, no collapse model yet).
      if (mode === 'frame' && bt.restraintRev !== (model ? model.structRev : -2)) this.restraints(bt);
      for (let i = 0; i < g.n; i++) {
        const b = bt.body[i];
        if (b < 0 || !B.alive[b] || !g.structural[i]) continue;
        if (model && model.state[i] > MS.SEVERE) continue;
        const t = g.type[i];
        if (t === MT_FOUNDATION) continue;
        const temps: NodeTemps = { Ts: B.TS[b], Tc: B.TC[b], TmaxS: B.TmaxS[b], TmaxC: B.TmaxC[b], wS: bt.wS[i] };
        if (Math.max(temps.TmaxS, temps.TmaxC) - Tref < 1 && Math.abs(temps.Ts - Tref) < 1) continue;
        const tm = bt.tmat[i];
        const f = sectionFactors(tm, temps);
        const vertical = t === MT_COLUMN || t === MT_WALL;
        const factor = vertical ? columnFactor(f, bt.crush[i], bt.buckle[i]) : f.bending;
        if (factor < bt.minFactor) bt.minFactor = factor;
        if (Math.abs(factor - bt.fApplied[i]) > FACTOR_QUANTUM || (factor < 1e-3 && bt.fApplied[i] > 1e-3)) {
          model ??= structureOf(bt.e, ctx).model;
          model.setMaterialFactor(i, factor, 'thermal');
          bt.fApplied[i] = factor;
          activate(bt.e, ctx);
        }
        // Thermal strain of the section's mean temperature; restrained part → axial force.
        const Tm = meanTemp(temps);
        const eps = thermalStrain(tm, Tm, Tref);
        bt.strain[i] = eps;
        const o = 6 * i;
        bt.bow[i] = bowingCurvature(tm, temps, Math.min(g.box[o + 3] - g.box[o], g.box[o + 4] - g.box[o + 1], g.box[o + 5] - g.box[o + 2]), Tref);
        const r = mode === 'none' ? 0 : mode === 'full' ? 1 : bt.restraint[i];
        if (!(vertical || t === MT_BEAM) || r <= 0) { bt.util[i] = 0; continue; }
        const mat = MATERIALS[MATERIAL_KEYS[g.mat[i]]];
        const len = vertical ? g.box[o + 4] - g.box[o + 1] : g.length[i];
        const A = g.mass[i] / Math.max(1, mat.density * Math.max(0.05, len));
        const N = restrainedForce(r, mat.E * mat.stiffnessFactor * f.stiffness, A, eps);
        if (vertical) {
          const cap = Math.max(1, g.capN[i] * factor);
          bt.util[i] = Math.max(0, N) / cap;
          if (Math.abs(N - bt.nApplied[i]) > LOAD_QUANTUM * g.capN[i]) {
            model ??= structureOf(bt.e, ctx).model;
            model.addLoad(i, N - bt.nApplied[i], 'thermal');
            bt.nApplied[i] = N;
            activate(bt.e, ctx);
          }
        } else {
          const by = g.box[o + 4] - g.box[o + 1], bw = Math.min(g.box[o + 3] - g.box[o], g.box[o + 5] - g.box[o + 2]);
          const Iw = ((by * bw ** 3) / 12) * mat.inertiaFill;
          const cap = beamAxialCapacity(mat.compressive, A, mat.E * mat.stiffnessFactor, Iw, len, f);
          bt.util[i] = Math.max(0, N) / cap;
          if (bt.util[i] >= OVERLOAD) {
            model ??= structureOf(bt.e, ctx).model;
            model.fail([i], 'thermal', 'thermal', ctx.time, { u: bt.util[i] });
            activate(bt.e, ctx);
          }
        }
      }
    }
  }

  /**
   * Axial restraint degree of each member from the frame around it (elastic, room-temperature
   * stiffness of the restraining members, documented): a column / wall pushing up its floor is held by
   * the beams resting on it (3EI/L³ each, far end pinned); a beam pushing on its supports by their
   * lateral stiffness (3EI/h³, cantilever), in series for the two ends. Recomputed when the structure
   * changes (members / connections lost → less restraint).
   */
  private restraints(bt: BuildingThermal) {
    const g = bt.g, model = bt.e.modular!.structure?.model;
    const alive = (j: number) => (model ? model.state[j] <= MS.SEVERE : !g.absent[j]);
    const EI = (j: number, weak: boolean) => {
      const mat = MATERIALS[MATERIAL_KEYS[g.mat[j]]], o = 6 * j;
      const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
      const b = Math.min(sx, sz), d = g.type[j] === MT_BEAM ? sy : Math.max(sx, sz);
      const I = weak ? (Math.max(sx, sz) * b ** 3) / 12 : (b * d ** 3) / 12;
      return mat.E * mat.stiffnessFactor * I * mat.inertiaFill;
    };
    for (let i = 0; i < g.n; i++) {
      bt.restraint[i] = 0;
      if (!g.structural[i] || !alive(i)) continue;
      const t = g.type[i], o = 6 * i;
      const mat = MATERIALS[MATERIAL_KEYS[g.mat[i]]];
      if (t === MT_COLUMN || t === MT_WALL) {
        let Ks = 0;
        for (let k = g.rStart[i]; k < g.rStart[i + 1]; k++) {
          const e = g.rEdge[k], d = g.eFrom[e];
          if (g.type[d] !== MT_BEAM || !alive(d)) continue;
          const L = Math.max(0.5, g.length[d]);
          Ks += (3 * EI(d, false)) / (L * L * L);
        }
        const h = g.box[o + 4] - g.box[o + 1];
        const A = g.mass[i] / Math.max(1, mat.density * h);
        bt.restraint[i] = restraintDegree(Ks, (mat.E * mat.stiffnessFactor * A) / Math.max(0.1, h));
      } else if (t === MT_BEAM) {
        const ks: number[] = [];
        for (let e = g.eStart[i]; e < g.eStart[i + 1]; e++) {
          const s = g.eTo[e];
          if (!alive(s) || (g.type[s] !== MT_COLUMN && g.type[s] !== MT_WALL)) continue;
          const os = 6 * s, h = Math.max(0.5, g.box[os + 4] - g.box[os + 1]);
          ks.push((3 * EI(s, true)) / (h * h * h));
        }
        if (ks.length < 2) continue;
        const Ks = 1 / (1 / ks[0] + 1 / ks[ks.length - 1]);
        const L = Math.max(0.5, g.length[i]);
        const A = g.mass[i] / Math.max(1, mat.density * L);
        bt.restraint[i] = restraintDegree(Ks, (mat.E * mat.stiffnessFactor * A) / L);
      }
    }
    bt.restraintRev = model ? model.structRev : -2;
  }

  /** People: air temperature around them and the radiant flux of the sources they see (no physiology). */
  private exposure(ctx: SystemContext) {
    const w = this.world;
    for (const e of this.humans) {
      const p = e.pose.position;
      const a = w.air.index(p[0], p[2], 1);
      const Ta = w.air.T(a);
      let q = 0;
      for (const s of ctx.env.thermal.sources) {
        const spec = s.spec;
        const local = ctx.time - s.start;
        if (local < 0 || local > spec.duration) continue;
        const [sx, sz] = spec.position;
        const r = Math.max(0.3, Math.hypot(p[0] - sx, p[1] + 1 - (this.groundY(ctx, sx, sz) + spec.height), p[2] - sz));
        if (spec.kind === 'point') q += (radiativeFraction(spec) * amplitude(spec) * (spec.profile === 'instant' ? 0 : 1)) / (4 * Math.PI * r * r);
        if (spec.kind === 'temperature') q += SIGMA * Math.max(0, (spec.temperature ?? 0) ** 4 - w.Tref ** 4) * sphereViewFactor(spec.radius, r);
      }
      const x = (e.exposure ??= { wind: 0, waterDepth: 0, flowSpeed: 0, groundAccel: 0, atmosphere: { pressure: 101.325, oxygen: 0.2095, temperature: 15, density: 1.225 }, atmosphereMeasured: false, peak: { wind: 0, waterDepth: 0, flowSpeed: 0, groundAccel: 0 }, time: { water: 0, wind: 0, shaking: 0 } });
      const th = (x.thermal ??= { airT: w.Tref, radiant: 0, peakAirT: w.Tref, peakRadiant: 0 });
      th.airT = Ta;
      th.radiant = q;
      if (Ta > th.peakAirT) th.peakAirT = Ta;
      if (q > th.peakRadiant) th.peakRadiant = q;
    }
  }

  private statistics(ctx: SystemContext) {
    const w = this.world, s = this.stats, Tref = w.Tref, g = w.terrain;
    let maxT = Tref, where: ThermalStats['maxWhere'] = 'none';
    let heated = 0, sumT = 0;
    g.forActive((c) => {
      const T = g.T(c, 0);
      if (T - Tref > 1) { heated++; sumT += T; }
      if (T > maxT) { maxT = T; where = 'ground'; }
      if (!(g.Tpeak[c] >= T)) g.Tpeak[c] = T;
    });
    let maxW = Tref;
    if (w.water) {
      for (const t of g.tiles) {
        const tx = t % g.ntx, tz = (t / g.ntx) | 0;
        for (let iz = tz * 10; iz < Math.min(g.nz, tz * 10 + 10); iz++) for (let ix = tx * 10; ix < Math.min(g.nx, tx * 10 + 10); ix++) {
          const c = iz * g.nx + ix;
          if (w.water.h[c] <= WATER_MERGE) continue;
          const T = Tref + w.water.heat[c] / (RHO_WATER * C_WATER * w.water.h[c] * w.water.cellArea);
          if (T > maxW) maxW = T;
        }
      }
      if (maxW > maxT) { maxT = maxW; where = 'water'; }
    }
    let maxA = Tref;
    for (let a = 0; a < w.air.count; a++) { const T = w.air.T(a); if (T > maxA) maxA = T; if (T > w.air.Tpeak[a]) w.air.Tpeak[a] = T; }
    if (maxA > maxT) { maxT = maxA; where = 'air'; }
    let maxR = Tref;
    for (let c = 0; c < w.comps.length; c++) if (w.comps[c].alive) maxR = Math.max(maxR, w.compT(c));
    if (maxR > maxT) { maxT = maxR; where = 'air'; }
    const B = w.bodies;
    let nb = 0;
    for (let i = 0; i < B.n; i++) {
      if (!B.alive[i]) continue;
      nb++;
      const T = Math.max(B.TS[i], B.TC[i]);
      if (T > maxT) { maxT = T; where = B.kind[i] === BK.member ? 'member' : 'object'; }
    }
    let damaged = 0, failed = 0, minF = 1, maxU = 0;
    for (const bt of this.buildings) {
      if (bt.minFactor < 0.95 || bt.thermalFailures > 0) damaged++;
      failed += bt.thermalFailures;
      minF = Math.min(minF, bt.minFactor);
      for (let i = 0; i < bt.g.n; i++) if (bt.util[i] > maxU) maxU = bt.util[i];
    }
    Object.assign(s, { maxT, maxWhere: where, meanHeatedT: heated ? sumT / heated : Tref, heatedArea: heated * g.area, maxAirT: maxA, maxWaterT: maxW, maxRoomT: maxR, bodies: nb, buildings: this.buildings.length, activeTiles: g.tiles.length, damagedStructures: damaged, failedMembers: failed, minFactor: minF, maxUtil: maxU });
    // Timeline milestones (each threshold once).
    const th = this.thresholds;
    const levels = [100, 300, 600, 1000];
    while (th.T < levels.length && toC(maxT) >= levels[th.T]) {
      ctx.milestone?.({ time: ctx.time, kind: 'peakTemperature', hazard: 'thermal', label: { key: `milestone.peakT.${where}` as const, params: { T: levels[th.T] } } });
      th.T++;
    }
    const fluxes = [1e3, 1e4, 5e4];
    while (th.flux < fluxes.length && s.maxFlux >= fluxes[th.flux]) {
      ctx.milestone?.({ time: ctx.time, kind: 'heatFlux', hazard: 'thermal', label: { key: 'milestone.heatFlux', params: { q: fluxes[th.flux] / 1000 } } });
      th.flux++;
    }
    const factors = [0.9, 0.5];
    while (th.factor < factors.length && minF <= factors[th.factor]) {
      ctx.milestone?.({ time: ctx.time, kind: 'strengthReduction', hazard: 'thermal', label: { key: 'milestone.strengthReduction', params: { pct: Math.round(factors[th.factor] * 100), T: toC(maxT).toFixed(0) } } });
      th.factor++;
    }
    if (!th.stress && maxU >= 0.5) { th.stress = true; ctx.milestone?.({ time: ctx.time, kind: 'thermalStress', hazard: 'thermal', label: { key: 'milestone.thermalStress', params: { u: Math.round(maxU * 100) } } }); }
    if (!th.failure && failed > 0) { th.failure = true; ctx.milestone?.({ time: ctx.time, kind: 'thermalFailure', hazard: 'thermal', label: { key: 'milestone.thermalFailure' } }); }
    if (!th.boil && maxW >= BOILING) {
      th.boil = true;
      ctx.milestone?.({ time: ctx.time, kind: 'waterBoiling', hazard: 'thermal', label: { key: 'milestone.waterBoiling' } });
      ctx.log(null, 'warn', { key: 'log.thermal.boiling' });
    }
  }

  /** Thermal entity of an object (inspector). */
  entity(id: EntityId) {
    return this.byEntity.get(id) ?? null;
  }
}

const canonKeys = new WeakMap<SourceRecord, string>();
function canonical(s: SourceRecord): string {
  let k = canonKeys.get(s);
  if (k === undefined) {
    const { name: _n, startTime: _t, ...rest } = s.spec;
    k = JSON.stringify(rest, Object.keys(rest).sort());
    canonKeys.set(s, k);
  }
  return k;
}

/** Does the segment P→Q cross the box of a building (footprint) below its top? */
export function segmentHitsBox(P: Vec3, Q: Vec3, e: RuntimeEntity, top: number): boolean {
  const c = e.pose.position, q = e.pose.quaternion;
  const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  const a = qRotate(inv, [P[0] - c[0], 0, P[2] - c[2]]), b = qRotate(inv, [Q[0] - c[0], 0, Q[2] - c[2]]);
  const hx = e.dims[0] / 2, hz = e.dims[2] / 2;
  // Slab clipping of the 2-D segment against the rectangle.
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dz = b[2] - a[2];
  for (const [p, d, h] of [[a[0], dx, hx], [a[2], dz, hz]] as const) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(p) > h) return false; continue; }
    let u0 = (-h - p) / d, u1 = (h - p) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  // Ends of the segment are the source and the receiver themselves (tolerance).
  if (t1 < 1e-3 || t0 > 1 - 1e-3) return false;
  const y0 = P[1] + (Q[1] - P[1]) * t0, y1 = P[1] + (Q[1] - P[1]) * t1;
  return Math.min(y0, y1) < top;
}

