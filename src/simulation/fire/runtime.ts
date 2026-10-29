/**
 * Fire adapter of a run (Phase 27): connects the pure FireWorld to the run and to the Phase 26
 * thermal adapter. Nothing here computes temperatures — the thermal nodes do.
 *
 *  - Fuel items join with their thermal bodies (thermal LOD: a building's members exist once it is
 *    refined; the ignition target and anything in a flame's strong-heating reach is refined first):
 *      timber members of modular buildings    thick fuel, the volatile share of the member mass
 *      trees                                  crown fine fuel (foliage, with its moisture) + trunk
 *      rubble heaps                           burning debris that landed on them (fuel moves in)
 *      building rooms                         contents fuel of the occupancy (EN 1991-1-2 Annex E)
 *    Not fuel: concrete, steel, masonry, glass, metal cladding, legacy single-box buildings,
 *    vehicles, ground cover (no fuel data in the world) — listed in the editor.
 *  - Each step: due ignitions are applied (or rejected with a reason); openings of every room are
 *    read from the structural state (failed windows / doors / walls / roof) plus the opening setting;
 *    incident fluxes come from what the thermal sources and flames actually deposited on the bodies
 *    (energy / projected area) and from the room gas; FireWorld burns; the heat of combustion goes
 *    back as thermal source steps booked `combustion`:
 *      room fires     convective share → room gas, radiative share → the room's surfaces by area,
 *                     the share that sees the openings → outside, through the openings
 *      vent-limited   excess burns as external flames at the openings (EN 1991-1-2 Annex B)
 *      outdoor fires  a flame per object (per story side for facades) at the flame centre
 *                     (Heskestad height, Thomas tilt in the wind): radiative share by the Phase 26
 *                     point-source geometry (projected areas, inverse square, shading), convective
 *                     share into the air layer column, own-flame feedback to the burning surfaces
 *  - After the thermal step: smoke / O₂ transport outdoors, room gas emissivity, flashover, window
 *    glass breaking, burned-through facade parts, charred timber sections (EN 1995-1-2 reduced cross-
 *    section replaces the temperature factor), trees losing their crown, statistics and milestones.
 * Iteration orders are item / body / room insertion order — never object ids.
 */
import type { EntityId, Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import { MATERIALS } from '@/buildings/materials';
import { MT_BEAM, MT_COLUMN, MT_DOOR, MT_ROOF, MT_SLAB, MT_WALL, MT_WINDOW } from '@/structure/graph';
import { MS } from '@/structure/types';
import { TK, type Deposit, type SourceStep } from '@/thermal/ThermalWorld';
import { BK } from '@/thermal/ThermalBodies';
import { THERMAL_MATERIALS, TM, moistWoodC } from '@/thermal/materials';
import { pointFraction } from '@/thermal/radiation';
import { CP_AIR, SIGMA, toC, ZERO_C } from '@/thermal/units';
import { sectionFactors, type StrengthState } from '@/thermal/structural';
import { FireWorld, FS, IK, isBurning } from '@/fire/FireWorld';
import {
  CONTENTS_FIRE, CROWN_DENSITY, FLASHOVER_FLUX, FLASHOVER_T, FM, FUEL_MATERIALS, GLASS_BREAK_DT, ZERO_STRENGTH_LAYER, ZERO_STRENGTH_TIME,
} from '@/fire/materials';
import { flameHeight, flameTilt, visibility, buoyantVelocity } from '@/fire/relations';
import type { FireSettings } from '@/fire/types';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { DamageState } from '../damage/DamageState';
import { activate, structureOf } from '../structure/state';
import { GEOM_PERIOD, type BuildingThermal, type ThermalRuntime } from '../thermal/runtime';
import type { IgnitionRecord } from './FireChannel';

/** Char depth from which a timber member is designed by its charred section (m; a formed char layer, not a scorch). */
export const CHAR_SWITCH = 0.001;
/** Irradiance below which a flame's radiation is not resolved on a receiver (W/m²) — booked unresolved. */
export const FLAME_FLOOR = 100;
/** Convective heat transfer of hot room gas to surfaces, for the incident flux of ignition (W/(m²·K)). */
const H_ROOM = 10;
const BODY_CELL = 8;
const MATERIAL_KEYS = Object.keys(MATERIALS) as (keyof typeof MATERIALS)[];
const SIDES = 5;

interface Geom {
  rad: Deposit[];
  conv: Deposit[];
  aboveConv: number;
  builtAt: number;
  Q: number;
  P: Vec3;
}

interface Group {
  key: string;
  items: number[];
  Q: number;
  E: number;
  P: Vec3;
  base: Vec3;
  D: number;
  L: number;
  tilt: number;
  geom: Geom | null;
}

interface Opening {
  i: number;
  A: number;
  H: number;
  side: number;
  /** Local centre. */
  c: Vec3;
  top: number;
}

interface RoomInfo {
  r: number;
  bt: BuildingThermal;
  story: number;
  y0: number;
  h: number;
  openings: Opening[];
  /** Slabs over this story (failed → link to the story above). */
  slabs: number[];
  windows: number[];
  surfaces: Deposit[];
  surfArea: number;
  surfAt: number;
  sideA: Float64Array;
  sideGeom: (Geom | null)[];
}

export interface FireStats {
  items: number;
  ignitedObjects: number;
  burningObjects: number;
  burnedOutObjects: number;
  extinguishedItems: number;
  burningItems: number;
  hrr: number;
  peakHrr: number;
  peakHrrTime: number;
  consumed: number;
  released: number;
  rooms: number;
  roomsBurning: number;
  flashovers: number;
  ventLimited: number;
  maxRoomT: number;
  smokeAir: number;
  smokeRooms: number;
  minVisibility: number;
  charredMembers: number;
  fireFailures: number;
  windowsBroken: number;
  treesBurned: number;
  ignitions: number;
  rejected: number;
  maxFlame: number;
}

const emptyStats = (): FireStats => ({
  items: 0, ignitedObjects: 0, burningObjects: 0, burnedOutObjects: 0, extinguishedItems: 0, burningItems: 0, hrr: 0, peakHrr: 0, peakHrrTime: 0, consumed: 0, released: 0,
  rooms: 0, roomsBurning: 0, flashovers: 0, ventLimited: 0, maxRoomT: 0, smokeAir: 0, smokeRooms: 0, minVisibility: Infinity, charredMembers: 0, fireFailures: 0,
  windowsBroken: 0, treesBurned: 0, ignitions: 0, rejected: 0, maxFlame: 0,
});

/** A drawn flame (renderer): base, height, tilt direction, heat release. */
export interface FlameView {
  x: number;
  y: number;
  z: number;
  L: number;
  D: number;
  Q: number;
  tx: number;
  tz: number;
  /** Soot produced by this flame (kg/s) — the renderer's plume density. */
  soot: number;
}

export class FireRuntime {
  readonly fw: FireWorld;
  readonly trt: ThermalRuntime;
  readonly settings: FireSettings;
  /** Item → owning object (id), its building (−1) and member (−1). */
  readonly owner: EntityId[] = [];
  readonly itemBuilding: number[] = [];
  private readonly bodyItems = new Map<number, number[]>();
  private readonly roomOfComp = new Map<number, number>();
  readonly rooms: RoomInfo[] = [];
  private readonly heapItem = new Map<number, number>();
  private readonly groups = new Map<string, Group>();
  private bodiesSeen = 0;
  private buildingsSeen = 0;
  private grid = new Map<number, number[]>();
  private gridAt = -Infinity;
  private gridN = -1;
  /** Combustion steps of the last step (incident flux of the next one). */
  private last: SourceStep[] = [];
  /** Buildings with fire involvement (hazard 'fire' for their heat effects). */
  private readonly involved = new Set<BuildingThermal>();
  private readonly treeBase = new Map<RuntimeEntity, number>();
  /** Switch of a timber member to the charred section: time (k₀ counts from it) and the temperature-based section then. */
  private readonly charStart = new Map<number, { t: number; f: StrengthState }>();
  private readonly treeLevel = new Map<RuntimeEntity, number>();
  private readonly ignitedOwners = new Set<EntityId>();
  private readonly windowsBroken = new Set<string>();
  readonly stats: FireStats = emptyStats();
  readonly flames: FlameView[] = [];
  /** Per-item ignition cause for the inspector: 'scenario' / 'flux' / 'debris'. */
  readonly cause: string[] = [];
  private th = { first: false, spread: false, peak: 0, ventLimited: false, flashover: false, decay: false, out: false, secondary: false, glass: false, failure: false };
  ms = 0;
  msTotal = 0;
  private hrrHist: number[] = [];

  constructor(ctx: SystemContext, trt: ThermalRuntime) {
    this.trt = trt;
    this.settings = ctx.env.fire.settings;
    this.fw = new FireWorld(trt.world);
    trt.world.hasGasRadiation = true;
    trt.hooks.merged = (b, kind, index) => this.onMerged(b, kind, index);
    trt.hooks.removed = (b) => this.onRemoved(b);
    trt.hooks.section = (bt, i) => this.charSection(bt, i);
    trt.hooks.hazard = (bt) => (this.involved.has(bt) ? 'fire' : 'thermal');
  }

  // ── Registration ───────────────────────────────────────

  /** New thermal bodies / refined buildings → fuel items and rooms. */
  sync(ctx: SystemContext) {
    const trt = this.trt, B = trt.world.bodies;
    while (this.buildingsSeen < trt.buildings.length) this.addRooms(ctx, trt.buildings[this.buildingsSeen++]);
    for (; this.bodiesSeen < B.n; this.bodiesSeen++) {
      const b = this.bodiesSeen;
      if (!B.alive[b]) continue;
      if (B.kind[b] === BK.member && B.sub[b] >= 0) this.addMember(trt.buildings[B.ref[b]], B.sub[b], b);
      else if (B.kind[b] === BK.entity) {
        const te = trt.ents[B.ref[b]];
        if (te?.kind === 'tree') this.addTree(te.e, b);
      }
    }
  }

  private link(b: number, i: number) {
    const l = this.bodyItems.get(b);
    if (l) l.push(i); else this.bodyItems.set(b, [i]);
  }

  private push(it: Parameters<FireWorld['add']>[0], owner: EntityId, building: number): number {
    const i = this.fw.add(it);
    this.owner[i] = owner;
    this.itemBuilding[i] = building;
    this.cause[i] = '';
    if (it.body >= 0) this.link(it.body, i);
    return i;
  }

  private addRooms(ctx: SystemContext, bt: BuildingThermal) {
    const w = this.trt.world, g = bt.g, mr = bt.e.modular!;
    const spec = mr.design.spec;
    const bi = this.trt.buildings.indexOf(bt);
    const b = bt.bounds;
    const planA = Math.max(1, (b.x1 - b.x0) * (b.z1 - b.z0));
    const per = 2 * (b.x1 - b.x0 + b.z1 - b.z0);
    const design = CONTENTS_FIRE[spec.occupancy] ?? null;
    let y = 0;
    const storyRoom: number[] = [];
    for (let s = 0; s < bt.comp.length; s++) {
      const tc = bt.comp[s];
      const h = (s === 0 ? spec.groundFloorHeight ?? spec.floorHeight : spec.floorHeight) * mr.scale[1];
      if (tc < 0) { storyRoom.push(-1); y += h; continue; }
      const cp = w.comps[tc];
      const V = cp.C / (w.air.rho * CP_AIR);
      const leak = this.settings.openings === 'closed' ? 0 : cp.Gv / CP_AIR;
      const r = this.fw.addRoom(tc, V, planA, 2 * planA + per * h, cp.air, leak, w.air.rho);
      this.roomOfComp.set(tc, r);
      storyRoom.push(r);
      this.rooms.push({ r, bt, story: s, y0: y, h, openings: [], slabs: [], windows: [], surfaces: [], surfArea: 0, surfAt: -Infinity, sideA: new Float64Array(SIDES), sideGeom: new Array(SIDES).fill(null) });
      if (design) {
        const c = this.trt.toWorld(bt.e, [(b.x0 + b.x1) / 2, y + 0.5, (b.z0 + b.z1) / 2]);
        this.push({
          kind: IK.contents, mat: FM.contents, body: -1, core: false, home: r, fuel: (design.qf * planA) / 17.5e6, water: 0, area: planA, size: Math.sqrt(planA),
          solid: 0, volume: 0, design, x: c[0], y: c[1], z: c[2], ref: bi, sub: s,
        }, bt.e.id, bi);
      }
      y += h;
    }
    // Openings, windows and slabs of each story (from the design — their state is read every step).
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    for (let i = 0; i < g.n; i++) {
      if (g.absent[i]) continue;
      const t = g.type[i], lv = g.level[i], o = 6 * i;
      const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
      const c: Vec3 = [(g.box[o] + g.box[o + 3]) / 2, (g.box[o + 1] + g.box[o + 4]) / 2, (g.box[o + 2] + g.box[o + 5]) / 2];
      if (t === MT_SLAB && !g.ground[i] && lv >= 0 && lv < storyRoom.length - 1) {
        const R = this.roomByStory(bt, lv);
        if (R) R.slabs.push(i);
        continue;
      }
      if (t === MT_ROOF) {
        const R = this.roomByStory(bt, storyRoom.length - 1);
        if (R) R.openings.push({ i, A: sx * sz, H: Math.sqrt(sx * sz), side: 4, c, top: g.box[o + 4] });
        continue;
      }
      if (lv < 0 || lv >= storyRoom.length) continue;
      const R = this.roomByStory(bt, lv);
      if (!R) continue;
      if (t === MT_WINDOW) R.windows.push(i);
      const perim = bt.perimeter[i] === 1;
      if (!(t === MT_WINDOW || t === MT_DOOR || (t === MT_WALL && perim))) continue;
      if (!perim) continue;
      // Side of the plan the opening faces (0: −x, 1: +x, 2: −z, 3: +z).
      const dx = c[0] - cx, dz = c[2] - cz;
      const side = Math.abs(dx) / Math.max(0.1, b.x1 - b.x0) >= Math.abs(dz) / Math.max(0.1, b.z1 - b.z0) ? (dx < 0 ? 0 : 1) : dz < 0 ? 2 : 3;
      R.openings.push({ i, A: Math.max(sx, sz) * sy, H: sy, side, c, top: g.box[o + 4] });
    }
    void ctx;
  }

  private roomByStory(bt: BuildingThermal, s: number): RoomInfo | null {
    const tc = bt.comp[s];
    const r = tc >= 0 ? this.roomOfComp.get(tc) : undefined;
    return r === undefined ? null : this.rooms[r];
  }

  private addMember(bt: BuildingThermal, i: number, b: number) {
    const g = bt.g;
    this.memberItems.delete(bt.e.id);
    if (MATERIAL_KEYS[g.mat[i]] !== 'timber' || bt.tmat[i] !== TM.timber) return;
    const B = this.trt.world.bodies, o = 6 * i, t = g.type[i];
    const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
    const mass = Math.max(1e-3, g.mass[i]);
    const mt = FUEL_MATERIALS[FM.timber];
    // Burning surface when fully involved: columns 4 faces, beams 3, walls / doors / slabs / roofs one face.
    const Av = B.Av[b], Atop = B.Atop[b], Abot = B.Abot[b];
    const area = t === MT_COLUMN ? Av : t === MT_BEAM ? Av / 2 + Abot : t === MT_SLAB ? Math.max(Abot, Atop) : t === MT_ROOF ? (Atop + Abot) / 2 : Av / 2;
    if (area <= 0) return;
    const home = B.comp1[b] >= 0 && B.fC1[b] > 0 ? this.roomOfComp.get(B.comp1[b]) ?? -1 : -1;
    const bi = this.trt.buildings.indexOf(bt);
    // Solid volume of the member (its mass over the timber density: stud walls and joist floors are not solid boxes).
    const V = mass / Math.max(1, MATERIALS[MATERIAL_KEYS[g.mat[i]]].density);
    this.push({
      kind: IK.member, mat: FM.timber, body: b, core: false, home, fuel: (1 - mt.charYield) * mass, water: 0, area, size: Math.max(sx, sy, sz),
      solid: mass, volume: V, x: 0, y: 0, z: 0, ref: bi, sub: i,
    }, bt.e.id, bi);
  }

  private addTree(e: RuntimeEntity, b: number) {
    const B = this.trt.world.bodies;
    const p = e.source.params as Record<string, number>;
    const cr = p.canopyRadius ?? 2, tr = p.trunkRadius ?? 0.3, h = p.height ?? e.dims[1];
    const u = this.settings.foliageMoisture;
    // The thermal foliage node was built for 150 % moisture: a drier crown has less water to heat.
    if (Math.abs(u - 1.5) > 1e-9 && B.ES[b] === 0) { B.cOv[b] = moistWoodC(u, ZERO_C + 15); B.refresh(b); }
    const crownV = (4 / 3) * Math.PI * cr ** 3;
    const dry = Math.min(CROWN_DENSITY * crownV, B.mS[b] / (1 + u));
    this.push({
      kind: IK.foliage, mat: FM.foliage, body: b, core: false, home: -1, fuel: dry, water: u * dry, area: 4 * Math.PI * cr * cr, size: 2 * cr,
      solid: dry, volume: crownV, x: 0, y: 0, z: 0, ref: -1, sub: 0,
    }, e.id, -1);
    // Trunk: green wood; its dry mass (50 % moisture in the thermal node), char front over the bark.
    const trunkDry = B.mC[b] / 1.5;
    if (trunkDry > 0) {
      const mt = FUEL_MATERIALS[FM.greenWood];
      this.push({
        kind: IK.trunk, mat: FM.greenWood, body: b, core: true, home: -1, fuel: (1 - mt.charYield) * trunkDry, water: 0, area: 2 * Math.PI * tr * h * 0.5, size: h,
        solid: trunkDry, volume: Math.PI * tr * tr * h * 0.5, x: 0, y: 0, z: 0, ref: -1, sub: 1,
      }, e.id, -1);
    }
    this.treeBase.set(e, e.areaFactor);
  }

  private heapItemOf(hb: number): number {
    let i = this.heapItem.get(hb);
    if (i !== undefined) return i;
    const B = this.trt.world.bodies;
    const A = Math.max(0.5, B.Atop[hb]);
    i = this.push({ kind: IK.heap, mat: FM.timber, body: hb, core: false, home: -1, fuel: 0, water: 0, area: A, size: Math.sqrt(A), solid: 0, volume: A * 0.1, x: 0, y: 0, z: 0, ref: -1, sub: -2 }, `heap:${B.ref[hb]}` as EntityId, -1);
    this.heapItem.set(hb, i);
    return i;
  }

  private onMerged(b: number, kind: number, index: number) {
    const items = this.bodyItems.get(b);
    if (!items) return;
    for (const i of items) {
      if (this.fw.gone[i]) continue;
      if (kind === TK.body && this.trt.world.bodies.kind[index] === BK.heap) {
        const h = this.heapItemOf(index);
        const burning = isBurning(this.fw.state[i]);
        this.fw.transfer(i, h);
        if (burning && this.cause[h] === '') this.cause[h] = 'debris';
      } else if (isBurning(this.fw.state[i])) this.fw.quench(i);
    }
  }

  private onRemoved(b: number) {
    for (const i of this.bodyItems.get(b) ?? []) if (!this.fw.gone[i]) this.fw.leave(i);
  }

  // ── Per step: before the thermal step ──────────────────

  /** Ignitions, openings, incident fluxes, combustion; returns the combustion source steps. */
  prepare(ctx: SystemContext, dt: number, heat: readonly SourceStep[]): SourceStep[] {
    const t0 = performance.now();
    const fw = this.fw, w = this.trt.world, B = w.bodies;
    this.sync(ctx);
    for (const ig of ctx.env.fire.ignitions) if (!ig.done && ig.start < ctx.time + dt) this.applyIgnition(ctx, ig);
    // Items whose member left the structure burn in the open from now on.
    for (let i = 0; i < fw.n; i++) {
      if (fw.kind[i] !== IK.member || fw.home[i] < 0) continue;
      const bt = this.trt.buildings[fw.ref[i]];
      const st = bt.e.modular!.structure?.model.state[fw.sub[i]] ?? MS.INTACT;
      if (st >= MS.FAILED) { fw.home[i] = -1; fw.room[i] = -1; }
    }
    this.openings(ctx);
    this.incident(ctx, dt, heat);
    fw.step(dt);
    for (const [i, from, to] of fw.changes) this.onChange(ctx, i, from, to);
    for (const [r, kind] of fw.roomEvents) this.onRoomEvent(ctx, r, kind);
    const steps = this.combustionSteps(ctx, dt);
    this.last = steps;
    void B;
    this.ms = performance.now() - t0;
    return steps;
  }

  /** Scenario ignition: light the fuel in the sphere, or reject it with a reason. */
  private applyIgnition(ctx: SystemContext, ig: IgnitionRecord) {
    ig.done = true;
    const trt = this.trt, fw = this.fw, s = ig.spec;
    const yg = trt.groundY(ctx, s.position[0], s.position[1]);
    const P: Vec3 = [s.position[0], yg + s.height, s.position[1]];
    // Objects near the point join the thermal network with member detail first.
    for (const te of trt.ents) {
      if (s.target && te.e.id !== s.target) continue;
      const p = te.e.pose.position;
      const d = Math.hypot(p[0] - P[0], p[2] - P[2]) - Math.hypot(te.e.dims[0], te.e.dims[2]) / 2;
      if (d > s.radius + 1) continue;
      trt.activate(ctx, te);
      if (te.coarse) trt.refine(ctx, te);
    }
    this.sync(ctx);
    const inside = trt.buildingContaining(P);
    let lit = 0, moist = 0, wet = 0, candidates = 0;
    const tryIgnite = (i: number, roomSide: boolean) => {
      candidates++;
      if (fw.tooMoist(i)) { moist++; return; }
      if (fw.wet[i] >= 0.9) { wet++; return; }
      if (fw.ignite(i, roomSide)) { lit++; this.cause[i] = 'scenario'; this.ignitedOwners.add(this.owner[i]); this.markInvolved(i); }
    };
    if (inside) {
      const r = this.roomOfComp.get(inside.comp);
      if (r !== undefined && (!s.target || inside.bt.e.id === s.target)) {
        const ci = fw.rooms[r].contents;
        if (ci >= 0 && fw.m[ci] > 0) tryIgnite(ci, true);
      }
    }
    for (let i = 0; i < fw.n; i++) {
      if (fw.kind[i] === IK.contents || fw.gone[i] || fw.m[i] <= 0) continue;
      if (s.target && this.owner[i] !== s.target) continue;
      const p = fw.pos(i);
      if (Math.hypot(p[0] - P[0], p[1] - P[1], p[2] - P[2]) > s.radius + fw.size[i] / 2) continue;
      // Fuel facing the room the point is in burns on the room side.
      tryIgnite(i, !!inside && fw.home[i] >= 0 && fw.rooms[fw.home[i]].tc === inside.comp);
    }
    ig.lit = lit;
    this.stats.ignitions++;
    if (lit === 0) {
      ig.reason = candidates === 0 ? 'fire.reject.noFuel' : moist > 0 ? 'fire.reject.moist' : wet > 0 ? 'fire.reject.wet' : 'fire.reject.noFuel';
      this.stats.rejected++;
      ctx.log(null, 'warn', { key: 'log.fire.rejected', params: { id: ig.name, reason: ig.reason } });
      ctx.milestone?.({ time: ctx.time, kind: 'ignitionRejected', hazard: 'fire', subject: 'fire', label: { key: 'milestone.ignitionRejected', params: { id: ig.name } } }, `fire:reject:${ig.id}`);
      return;
    }
    ctx.log(null, 'info', { key: 'log.fire.ignited', params: { id: ig.name, n: lit } });
    if (!this.th.first) {
      this.th.first = true;
      ctx.milestone?.({ time: ctx.time, kind: 'ignition', hazard: 'fire', subject: 'fire', label: { key: 'milestone.ignition', params: { id: ig.name, n: lit } } }, `fire:ignition`);
    }
  }

  private markInvolved(i: number) {
    const bi = this.itemBuilding[i];
    if (bi >= 0) this.involved.add(this.trt.buildings[bi]);
  }

  /** Openings of every room from the structural state + the opening setting; room links through failed slabs. */
  private openings(ctx: SystemContext) {
    const fw = this.fw, w = this.trt.world;
    w.compLinks.length = 0;
    for (const R of this.rooms) {
      const FR = fw.rooms[R.r];
      const m = R.bt.e.modular!.structure?.model;
      const st = (i: number) => (m ? m.state[i] : MS.INTACT);
      R.sideA.fill(0);
      let A = 0, AH = 0;
      for (const o of R.openings) {
        const open = st(o.i) >= MS.FAILED || (this.settings.openings === 'windowsOpen' && R.bt.g.type[o.i] === MT_WINDOW);
        if (!open) continue;
        R.sideA[o.side] += o.A;
        A += o.A;
        AH += o.A * o.H;
      }
      FR.Ao = A;
      FR.Ho = A > 0 ? AH / A : 0;
      FR.links.length = 0;
      let slabA = 0;
      for (const sl of R.slabs) if (st(sl) >= MS.FAILED) { const o = 6 * sl, g = R.bt.g; slabA += (g.box[o + 3] - g.box[o]) * (g.box[o + 5] - g.box[o + 2]); }
      if (slabA > 0) {
        const up = this.roomByStory(R.bt, R.story + 1);
        if (up) {
          FR.links.push([up.r, slabA]);
          const dT = Math.abs(w.compT(FR.tc) - w.compT(fw.rooms[up.r].tc));
          const mx = 0.5 * w.air.rho * slabA * buoyantVelocity(R.h, dT, w.Tref);
          if (mx > 0) w.compLinks.push({ a: FR.tc, b: fw.rooms[up.r].tc, G: mx * CP_AIR });
        }
      }
    }
    void ctx;
  }

  /** Incident fluxes (W/m²) of the fuel items, pilot flames, water and rain. */
  private incident(ctx: SystemContext, dt: number, heat: readonly SourceStep[]) {
    const fw = this.fw, w = this.trt.world, B = w.bodies, Tinf = w.Tref;
    fw.qInc.fill(0, 0, fw.n);
    fw.qRoom.fill(0, 0, fw.n);
    fw.pilot.fill(0, 0, fw.n);
    const add = (s: SourceStep, room: boolean, P?: Vec3) => {
      if (s.energy <= 0 || s.id.startsWith('gf:')) return;
      for (const d of s.deposits) {
        if (d.kind !== TK.body || !d.a) continue;
        const items = this.bodyItems.get(d.index);
        if (!items) continue;
        let q = (s.energy * d.w) / (dt * THERMAL_MATERIALS[B.matS[d.index]].emissivity * d.a);
        // Heat-source deposits are by the receiver's centre distance; ignition is judged on its near face.
        if (P) {
          const j = d.index, crown = this.crownOf(j);
          const dx = B.x[j] - P[0], dz = B.z[j] - P[2], r = Math.max(0.3, Math.hypot(dx, B.y[j] - P[1], dz));
          const rc = crown >= 0 ? Math.max(0.3, Math.hypot(dx, B.y[j] + B.sy[j] / 2 - 0.5 * fw.size[crown] - P[1], dz)) : r;
          const half = crown >= 0 ? 0.5 * fw.size[crown] : (0.5 * (B.sx[j] * Math.abs(dx) + B.sz[j] * Math.abs(dz))) / r;
          q *= (r / Math.max(0.3, rc - half)) ** 2;
        }
        for (const i of items) { fw.qInc[i] += q; if (room) fw.qRoom[i] += q; }
      }
    };
    const srcPoint = new Map<string, Vec3>();
    for (const rec of ctx.env.thermal.sources) if (rec.spec.kind === 'point') srcPoint.set(rec.id, [rec.spec.position[0], this.trt.groundY(ctx, rec.spec.position[0], rec.spec.position[1]) + rec.spec.height, rec.spec.position[1]]);
    for (const s of heat) {
      add(s, false, srcPoint.get(s.id));
      if (s.temperature !== undefined && s.exchanges) {
        for (const x of s.exchanges) {
          if (x.kind !== TK.body || !x.a) continue;
          const items = this.bodyItems.get(x.index);
          if (!items) continue;
          const q = (SIGMA * s.temperature ** 4 * x.aRad) / x.a + (x.aConv > 0 ? H_ROOM * Math.max(0, s.temperature - B.TS[x.index]) : 0);
          for (const i of items) fw.qInc[i] += q;
        }
      }
    }
    for (const s of this.last) add(s, s.id.startsWith('room:'));
    // Room gas: radiation of the smoky gas and convection of the hot gas onto the faces.
    for (const R of fw.rooms) {
      R.burning = 0;
      const cp = w.comps[R.tc];
      R.qFloor = cp.alive ? R.eps * SIGMA * (w.compT(R.tc) ** 4 - Tinf ** 4) : 0;
    }
    for (let i = 0; i < fw.n; i++) {
      if (isBurning(fw.state[i]) && fw.room[i] >= 0) fw.rooms[fw.room[i]].burning++;
    }
    for (let i = 0; i < fw.n; i++) {
      const h = fw.home[i];
      if (h < 0) continue;
      const R = fw.rooms[h];
      if (!w.comps[R.tc].alive) continue;
      const Tg = w.compT(R.tc);
      const q = R.eps * SIGMA * (Tg ** 4 - Tinf ** 4) + H_ROOM * Math.max(0, Tg - fw.fuelT(i));
      if (fw.kind[i] !== IK.contents) { fw.qInc[i] += q; fw.qRoom[i] += q; }
      if (R.burning > 0) fw.pilot[i] = 1;
    }
    // Contents see the room's flames by their share of the enclosure + the gas.
    for (const R of this.rooms) {
      const FR = fw.rooms[R.r];
      const st = this.last.find((s) => s.id === `room:${R.r}`);
      if (st && R.surfArea > 0) FR.qFloor += (st.energy * (1 - (st.deposits[0]?.w ?? 0))) / (dt * R.surfArea);
    }
    // Pilot flames outdoors: inside the flame zone of a burning object.
    for (const gr of this.groups.values()) {
      if (gr.Q <= 0) continue;
      const rz = 0.5 * gr.L + 0.5 * gr.D + 0.5;
      this.forBodiesNear(ctx, gr.P, rz + 4, (b) => {
        const items = this.bodyItems.get(b);
        if (!items) return;
        const d = Math.hypot(B.x[b] - gr.P[0], B.y[b] - gr.P[1], B.z[b] - gr.P[2]) - 0.5 * Math.max(B.sx[b], B.sy[b], B.sz[b]);
        if (d <= rz) for (const i of items) fw.pilot[i] = 1;
      });
    }
    // Water: submerged share of the body, rain on its exposed faces.
    const f = ctx.env.flood.field;
    const rains = ctx.env.flood.forcing?.rains ?? [];
    for (let i = 0; i < fw.n; i++) {
      const b = fw.body[i];
      fw.wet[i] = 0;
      fw.rain[i] = 0;
      if (b < 0 || !B.alive[b]) continue;
      if (f) {
        const c = f.indexAt(B.x[b], B.z[b]);
        if (c >= 0 && f.h[c] > 0.01) {
          const bottom = B.y[b] - B.sy[b] / 2;
          fw.wet[i] = Math.max(0, Math.min(1, (B.yg[b] + f.h[c] - bottom) / Math.max(0.05, B.sy[b])));
        }
      }
      if (rains.length && B.fOut[b] > 0 && fw.home[i] < 0) {
        let r = 0;
        for (const rf of rains) if (!rf.area || Math.hypot(B.x[b] - rf.area.center[0], B.z[b] - rf.area.center[1]) <= rf.area.radius) r += rf.rate;
        fw.rain[i] = r * 1000 * B.fOut[b];
      }
    }
    // Water cools what it covers: convection to the water of the cell (natural convection in water,
    // h = 500 W/(m²·K), Incropera Table 1.1 range 100–1000; limited to a stable explicit step).
    if (f && w.water) {
      for (const [b, items] of this.bodyItems) {
        const wet = fw.wet[items[0]];
        if (wet <= 0 || !B.alive[b]) continue;
        const c = w.terrain.index(B.x[b], B.z[b]);
        if (c < 0) continue;
        const A = (B.Av[b] + B.Atop[b] + B.Abot[b]) * wet;
        const Tw = w.waterT(c);
        const C = B.capacity(b, false);
        const G = Math.min(500 * A, (0.5 * C) / dt);
        const J = G * (B.TS[b] - Tw) * dt;
        if (J !== 0) { w.moveEnergy(b, false, TK.water, c, J); w.ledger.transfers.convection += Math.abs(J); }
      }
    }
  }

  // ── Combustion heat → thermal source steps ─────────────

  private combustionSteps(ctx: SystemContext, dt: number): SourceStep[] {
    const fw = this.fw, w = this.trt.world, B = w.bodies;
    const steps: SourceStep[] = [];
    this.flames.length = 0;
    // Rooms: energy of the items burning in each room.
    const Ein = new Float64Array(fw.rooms.length);
    const chiE = new Float64Array(fw.rooms.length);
    for (let i = 0; i < fw.n; i++) {
      const r = fw.room[i];
      if (r < 0 || fw.Estep[i] <= 0) continue;
      Ein[r] += fw.Estep[i];
      chiE[r] += fw.Estep[i] * FUEL_MATERIALS[fw.mat[i]].chiR;
    }
    for (const R of this.rooms) {
      const FR = fw.rooms[R.r];
      const cp = w.comps[FR.tc];
      const E = Ein[R.r];
      const Tg = w.compT(FR.tc);
      // Gas radiation leaving through the openings (moved heat, not new heat).
      const gasOut = cp.alive && FR.eps > 0 && FR.Ao > 0 ? FR.eps * SIGMA * (Tg ** 4 - w.Tref ** 4) : 0;
      if (E <= 0 && gasOut <= 0) continue;
      this.markRoomInvolved(R);
      const chi = E > 0 ? chiE[R.r] / E : 0.35;
      const tot = FR.hrr + FR.hrrExt;
      const share = tot > 0 ? FR.hrrExt / tot : 0;
      const Eext = E * share, Ein_ = E - Eext;
      const fo = FR.Ao > 0 ? Math.min(0.9, FR.Ao / FR.Aenc) : 0;
      if (Ein_ > 0) {
        const surf = this.roomSurfaces(ctx, R);
        const wc = (1 - chi) / (1 - chi * fo);
        const deps: Deposit[] = [{ kind: TK.comp, index: FR.tc, w: wc }];
        for (const d of surf) deps.push({ ...d, w: ((chi * (1 - fo)) / (1 - chi * fo)) * d.w });
        steps.push({ id: `room:${R.r}`, energy: Ein_ * (1 - chi * fo), deposits: deps, combustion: true });
      }
      // Each side with openings: external flame (convective + radiative) and the radiation that sees the openings.
      for (let side = 0; side < SIDES; side++) {
        const As = R.sideA[side];
        if (As <= 0) continue;
        const sh = As / FR.Ao;
        const g = this.sideGeom(ctx, R, side, (chi * fo * Ein_ + Eext) * sh / dt + gasOut * As);
        const rad = (chi * fo * Ein_ + chi * Eext) * sh;
        const conv = (1 - chi) * Eext * sh;
        if (conv > 0) steps.push({ id: `oc:${R.r}:${side}`, energy: conv, deposits: g.conv, aboveLayer: g.aboveConv, combustion: true });
        if (rad > 0) steps.push({ id: `or:${R.r}:${side}`, energy: rad, deposits: g.rad, combustion: true });
        if (gasOut > 0) {
          // Never more than the room holds above the ambient.
          const J = Math.min(gasOut * As * dt, Math.max(0, cp.E) * 0.5);
          if (J > 0) steps.push({ id: `og:${R.r}:${side}`, energy: J, deposits: g.rad, from: { kind: TK.comp, index: FR.tc } });
        }
        if (Eext > 0) {
          const Q = (Eext * sh) / dt;
          const o = R.openings.find((x) => x.side === side);
          if (o) this.flames.push({ x: g.P[0], y: g.P[1] - 0.5 * flameHeight(Q, Math.sqrt(As)), z: g.P[2], L: Math.max(0.5, flameHeight(Q, Math.sqrt(As))), D: Math.sqrt(As), Q, tx: 0, tz: 0, soot: (0.05 * Q) / 14e6 });
        }
      }
    }
    // Outdoor fires: one flame per object / story side.
    for (const gr of this.groups.values()) { gr.items.length = 0; gr.Q = 0; gr.E = 0; }
    for (let i = 0; i < fw.n; i++) {
      if (fw.room[i] >= 0 || fw.Estep[i] <= 0) continue;
      const key = this.groupKey(i);
      let gr = this.groups.get(key);
      if (!gr) this.groups.set(key, (gr = { key, items: [], Q: 0, E: 0, P: [0, 0, 0], base: [0, 0, 0], D: 0, L: 0, tilt: 0, geom: null }));
      gr.items.push(i);
      gr.Q += fw.hrr[i];
      gr.E += fw.Estep[i];
    }
    const u10 = w.u10;
    for (const gr of this.groups.values()) {
      if (gr.E <= 0) { if (gr.items.length === 0) this.groups.delete(gr.key); continue; }
      let x = 0, y = 0, z = 0, Ab = 0, chiE2 = 0, dHcE = 0, soot = 0;
      for (const i of gr.items) {
        const p = this.flamePoint(i);
        const e = fw.Estep[i];
        x += p[0] * e; y += p[1] * e; z += p[2] * e;
        soot += FUEL_MATERIALS[fw.mat[i]].ys * fw.mdot[i];
        // Fire base area: the projected crown disk of a burning crown, the burning surface otherwise.
        Ab += fw.kind[i] === IK.contents ? fw.area[i] : fw.kind[i] === IK.foliage ? (Math.PI * fw.size[i] * fw.size[i] * fw.inv[i]) / 4 : fw.area[i] * fw.inv[i];
        chiE2 += e * FUEL_MATERIALS[fw.mat[i]].chiR;
        dHcE += e * FUEL_MATERIALS[fw.mat[i]].dHc;
      }
      const base: Vec3 = [x / gr.E, y / gr.E, z / gr.E];
      const chi = chiE2 / gr.E;
      const D = Math.max(0.3, Math.sqrt(Ab));
      const L = flameHeight(gr.Q, D);
      const tilt = flameTilt(u10, gr.Q, D, dHcE / gr.E, w.air.rho);
      const half = 0.5 * Math.max(L, 0.3);
      const P: Vec3 = [base[0] + Math.sin(tilt) * w.flowX * half, base[1] + Math.cos(tilt) * half, base[2] + Math.sin(tilt) * w.flowZ * half];
      gr.base = base; gr.P = P; gr.D = D; gr.L = L; gr.tilt = tilt;
      this.stats.maxFlame = Math.max(this.stats.maxFlame, L);
      this.flames.push({ x: base[0], y: base[1], z: base[2], L: Math.max(0.3, L), D, Q: gr.Q, tx: Math.sin(tilt) * w.flowX, tz: Math.sin(tilt) * w.flowZ, soot });
      // Own-flame feedback to the burning surfaces of thick fuels (≤ half of their heat).
      const fb: Deposit[] = [];
      let Efb = 0;
      for (const i of gr.items) {
        const mt = FUEL_MATERIALS[fw.mat[i]];
        const b = fw.body[i];
        if (mt.thin || b < 0 || !B.alive[b]) continue;
        const J = Math.min(mt.qFlame * fw.area[i] * fw.inv[i] * dt, 0.5 * fw.Estep[i]);
        if (J <= 0) continue;
        fb.push({ kind: TK.body, index: b, w: J });
        Efb += J;
      }
      if (Efb > 0) { for (const d of fb) d.w /= Efb; steps.push({ id: `gf:${gr.key}`, energy: Efb, deposits: fb, combustion: true }); }
      const rest = gr.E - Efb;
      const g = this.groupGeom(ctx, gr, chi);
      if (rest * (1 - chi) > 0) steps.push({ id: `gc:${gr.key}`, energy: rest * (1 - chi), deposits: g.conv, aboveLayer: g.aboveConv, combustion: true });
      if (rest * chi > 0) steps.push({ id: `gr:${gr.key}`, energy: rest * chi, deposits: g.rad, combustion: true });
    }
    return steps;
  }

  private markRoomInvolved(R: RoomInfo) {
    this.involved.add(R.bt);
  }

  /** Key of the flame an outdoor item belongs to. */
  private groupKey(i: number): string {
    const fw = this.fw;
    switch (fw.kind[i]) {
      case IK.member: {
        const bt = this.trt.buildings[fw.ref[i]];
        const st = bt.e.modular!.structure?.model.state[fw.sub[i]] ?? MS.INTACT;
        if (st >= MS.FAILED) return `d:${fw.body[i]}`;
        const g = bt.g, o = 6 * fw.sub[i], b = bt.bounds;
        const dx = (g.box[o] + g.box[o + 3]) / 2 - (b.x0 + b.x1) / 2, dz = (g.box[o + 2] + g.box[o + 5]) / 2 - (b.z0 + b.z1) / 2;
        const side = g.type[fw.sub[i]] === MT_ROOF ? 4 : Math.abs(dx) / Math.max(0.1, b.x1 - b.x0) >= Math.abs(dz) / Math.max(0.1, b.z1 - b.z0) ? (dx < 0 ? 0 : 1) : dz < 0 ? 2 : 3;
        return `b:${fw.ref[i]}:${g.level[fw.sub[i]]}:${side}`;
      }
      case IK.contents: return `c:${i}`;
      default: return `o:${fw.body[i]}`;
    }
  }

  /** Base of an item's flame (outside its building's facade / above a roof / the crown centre). */
  private flamePoint(i: number): Vec3 {
    const fw = this.fw, B = this.trt.world.bodies;
    const p = fw.pos(i);
    // A crown burns from its bottom up: the flame stands on the crown base (top of the tree − crown diameter).
    if (fw.kind[i] === IK.foliage && fw.body[i] >= 0) return [p[0], p[1] + B.sy[fw.body[i]] / 2 - fw.size[i], p[2]];
    if (fw.kind[i] !== IK.member) return p;
    const bt = this.trt.buildings[fw.ref[i]];
    const st = bt.e.modular!.structure?.model.state[fw.sub[i]] ?? MS.INTACT;
    if (st >= MS.FAILED) return p;
    const b = fw.body[i];
    if (bt.g.type[fw.sub[i]] === MT_ROOF) return [p[0], p[1] + B.sy[b] / 2 + 0.2, p[2]];
    // Out from the building centre by half the member thickness + 0.3 m (the flame stands outside).
    const c = bt.e.pose.position;
    const dx = p[0] - c[0], dz = p[2] - c[2], d = Math.hypot(dx, dz) || 1;
    const off = 0.5 * Math.min(B.sx[b], B.sz[b]) + 0.3;
    return [p[0] + (dx / d) * off, p[1], p[2] + (dz / d) * off];
  }

  /** Surfaces of a room (bodies facing it), weights by area × emissivity, with face area for the incident flux. */
  private roomSurfaces(ctx: SystemContext, R: RoomInfo): Deposit[] {
    if (ctx.time - R.surfAt < GEOM_PERIOD && R.surfaces.length) return R.surfaces;
    const B = this.trt.world.bodies, tc = this.fw.rooms[R.r].tc;
    const out: Deposit[] = [];
    let sum = 0, area = 0;
    for (let s = 0; s < 2; s++) void s;
    for (let i = 0; i < R.bt.g.n; i++) {
      const b = R.bt.body[i];
      if (b < 0 || !B.alive[b]) continue;
      const f = (B.comp1[b] === tc ? B.fC1[b] : 0) + (B.comp2[b] === tc ? B.fC2[b] : 0);
      if (f <= 0) continue;
      const A = (B.Av[b] + B.Atop[b] + B.Abot[b]) * f;
      const e = THERMAL_MATERIALS[B.matS[b]].emissivity;
      out.push({ kind: TK.body, index: b, w: A * e, a: A });
      sum += A * e;
      area += A;
    }
    for (const d of out) d.w /= Math.max(1e-9, sum);
    R.surfaces = out;
    R.surfArea = area;
    R.surfAt = ctx.time;
    return out;
  }

  /** Geometry of an opening side: point at the opening centroid, out of the facade, at the external flame centre. */
  private sideGeom(ctx: SystemContext, R: RoomInfo, side: number, Q: number): Geom {
    const old = R.sideGeom[side];
    if (old && ctx.time - old.builtAt < GEOM_PERIOD && Math.abs(Math.log(Math.max(1, Q) / Math.max(1, old.Q))) < Math.LN2) return old;
    const bt = R.bt, b = bt.bounds;
    let ax = 0, ay = 0, az = 0, A = 0;
    for (const o of R.openings) if (o.side === side) { ax += o.c[0] * o.A; ay += o.c[1] * o.A; az += o.c[2] * o.A; A += o.A; }
    const lc: Vec3 = A > 0 ? [ax / A, ay / A, az / A] : [(b.x0 + b.x1) / 2, R.y0 + R.h / 2, (b.z0 + b.z1) / 2];
    const out = 0.6;
    if (side === 0) lc[0] = b.x0 - out; else if (side === 1) lc[0] = b.x1 + out; else if (side === 2) lc[2] = b.z0 - out; else if (side === 3) lc[2] = b.z1 + out;
    else lc[1] = b.top + 0.5;
    const P = this.trt.toWorld(bt.e, lc);
    const g = this.pointGeom(ctx, P, Q, new Set(), 0.5 * Math.sqrt(Math.max(0.1, R.sideA[side])));
    R.sideGeom[side] = g;
    return g;
  }

  private groupGeom(ctx: SystemContext, gr: Group, chi: number): Geom {
    const old = gr.geom;
    const moved = old ? Math.hypot(old.P[0] - gr.P[0], old.P[1] - gr.P[1], old.P[2] - gr.P[2]) : Infinity;
    if (old && ctx.time - old.builtAt < GEOM_PERIOD && moved < 1 && Math.abs(Math.log(Math.max(1, gr.Q) / Math.max(1, old.Q))) < Math.LN2) return old;
    const own = new Set<number>();
    for (const i of gr.items) if (this.fw.body[i] >= 0) own.add(this.fw.body[i]);
    gr.geom = this.pointGeom(ctx, gr.P, gr.Q * chi, own, gr.D / 2);
    gr.geom.Q = gr.Q;
    return gr.geom;
  }

  /**
   * Receivers of an isotropic flame at P radiating Prad (W): the Phase 26 point-source geometry
   * (projected area toward the flame, inverse square, building shading / facing sides, ground cells
   * with the shade of the objects above them) with a 0.1 kW/m² floor; weights are absorbed shares of
   * the radiated energy (normalized when receivers next to the flame would take more than all of it).
   * Its own burning bodies are receivers at least D/2 away (mutual heating of a burning group).
   * The energy goes by the receiver's centre distance; the incident flux that decides ignition is
   * the one on its NEAR face (centre distance − half its extent toward the flame, never closer than
   * the flame surface) — carried in the deposit's area `a` = A_p·(r_near/r)².
   */
  private pointGeom(ctx: SystemContext, P: Vec3, Prad: number, own: Set<number>, rOwn: number): Geom {
    const trt = this.trt, w = trt.world, B = w.bodies, tr = w.terrain;
    const reach = Math.min(150, Math.sqrt(Math.max(1, Prad) / (4 * Math.PI * FLAME_FLOOR)));
    const strong = Math.sqrt(Math.max(1, Prad) / (4 * Math.PI * 1000));
    // Objects in reach join the thermal network; buildings in the strong zone get member detail.
    for (const te of trt.ents) {
      const p = te.e.pose.position;
      const d = Math.hypot(p[0] - P[0], p[2] - P[2]) - Math.hypot(te.e.dims[0], te.e.dims[2]) / 2;
      if (d > reach) continue;
      if (!te.active) trt.activate(ctx, te);
      if (te.coarse && d <= strong) trt.refine(ctx, te);
    }
    this.sync(ctx);
    const inside = trt.buildingContaining(P);
    const shield = trt.shields(P, reach);
    const rad: Deposit[] = [];
    let down = 0, sum = 0;
    this.forBodiesNear(ctx, P, reach, (i) => {
      if (!B.alive[i]) return;
      const dx = B.x[i] - P[0], dy = B.y[i] - P[1], dz = B.z[i] - P[2];
      let r = Math.hypot(dx, dy, dz);
      if (r > reach) return;
      if (own.has(i)) r = Math.max(r, rOwn);
      const vis = own.has(i) ? 1 : trt.visible(i, P, inside, shield);
      if (vis <= 0) return;
      const rr = Math.max(r, 1e-6);
      const Ap = trt.projected(i, -dx / rr, -dy / rr, -dz / rr) * vis;
      if (Ap <= 0) return;
      const f = pointFraction(Ap, Math.max(0.3, r));
      if ((f * Prad) / Ap < FLAME_FLOOR) return;
      const wgt = f * THERMAL_MATERIALS[B.matS[i]].emissivity;
      // Near face toward the flame: a tree is measured from its crown (its box centre is mostly trunk),
      // anything else by its horizontal half-extent.
      const crown = this.crownOf(i);
      let rc = r, half = (0.5 * (B.sx[i] * Math.abs(dx) + B.sz[i] * Math.abs(dz))) / rr;
      if (crown >= 0) {
        const cy = B.y[i] + B.sy[i] / 2 - 0.5 * this.fw.size[crown];
        rc = Math.hypot(dx, cy - P[1], dz);
        half = 0.5 * this.fw.size[crown];
      }
      const rNear = Math.max(0.3, rOwn, rc - half);
      rad.push({ kind: TK.body, index: i, w: wgt, a: Ap * (rNear / Math.max(0.3, r)) ** 2 });
      sum += wgt;
      if (dy < 0) down += f;
    });
    // Ground under the flame (not inside a room).
    if (!inside) {
      const yg = trt.groundY(ctx, P[0], P[2]);
      const A = tr.cell * tr.cell;
      const ground: Deposit[] = [];
      let gsum = 0;
      const i0 = Math.max(0, Math.floor((P[0] - reach - tr.originX) / tr.cell)), i1 = Math.min(tr.nx - 1, Math.floor((P[0] + reach - tr.originX) / tr.cell));
      const k0 = Math.max(0, Math.floor((P[2] - reach - tr.originZ) / tr.cell)), k1 = Math.min(tr.nz - 1, Math.floor((P[2] + reach - tr.originZ) / tr.cell));
      if (P[1] - yg > 0.01) {
        for (let iz = k0; iz <= k1; iz++) for (let ix = i0; ix <= i1; ix++) {
          const c = iz * tr.nx + ix;
          if (tr.covered[c] === 1) continue;
          const x = tr.originX + (ix + 0.5) * tr.cell, z = tr.originZ + (iz + 0.5) * tr.cell;
          const y = trt.groundY(ctx, x, z);
          const dy = P[1] - y;
          if (dy <= 0) continue;
          const r = Math.hypot(x - P[0], dy, z - P[2]);
          if (r > reach) continue;
          const f = (A * (dy / r)) / (4 * Math.PI * r * r);
          if ((f * Prad) / A < FLAME_FLOOR) continue;
          const eps = w.water && w.water.h[c] > 0.001 ? 0.96 : tr.emiss[c];
          ground.push({ kind: TK.ground, index: c, w: f * eps });
          gsum += f;
        }
      }
      const shade = gsum > 0 ? Math.max(0, (gsum - down) / gsum) : 0;
      for (const d of ground) { d.w *= shade; sum += d.w; rad.push(d); }
    }
    // Radiation can never deliver more than it emits.
    if (sum > 1) for (const d of rad) d.w /= sum;
    const conv: Deposit[] = [];
    let aboveConv = 0;
    if (inside) conv.push({ kind: TK.comp, index: inside.comp, w: 1 });
    else {
      const a = w.air.index(P[0], P[2], P[1] - trt.groundY(ctx, P[0], P[2]));
      if (a >= 0) conv.push({ kind: TK.air, index: a, w: 1 }); else aboveConv = 1;
    }
    return { rad, conv, aboveConv, builtAt: ctx.time, Q: Prad, P };
  }

  /** Crown (foliage) item of a tree body, −1 otherwise. */
  private crownOf(b: number): number {
    const items = this.bodyItems.get(b);
    if (!items) return -1;
    for (const i of items) if (this.fw.kind[i] === IK.foliage) return i;
    return -1;
  }

  /** Bodies whose centre lies within r of P (8 m buckets, rebuilt every geometry period). */
  private forBodiesNear(ctx: SystemContext, P: Vec3, r: number, f: (b: number) => void) {
    const B = this.trt.world.bodies;
    if (ctx.time - this.gridAt >= GEOM_PERIOD || this.gridN !== B.n) {
      this.grid.clear();
      for (let i = 0; i < B.n; i++) {
        if (!B.alive[i]) continue;
        const k = Math.floor(B.x[i] / BODY_CELL) * 100003 + Math.floor(B.z[i] / BODY_CELL);
        const l = this.grid.get(k);
        if (l) l.push(i); else this.grid.set(k, [i]);
      }
      this.gridAt = ctx.time;
      this.gridN = B.n;
    }
    const x0 = Math.floor((P[0] - r) / BODY_CELL), x1 = Math.floor((P[0] + r) / BODY_CELL);
    const z0 = Math.floor((P[2] - r) / BODY_CELL), z1 = Math.floor((P[2] + r) / BODY_CELL);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > this.grid.size * 2) {
      for (let i = 0; i < B.n; i++) if (B.alive[i]) f(i);
      return;
    }
    for (let bx = x0; bx <= x1; bx++) for (let bz = z0; bz <= z1; bz++) {
      const l = this.grid.get(bx * 100003 + bz);
      if (l) for (const i of l) f(i);
    }
  }

  // ── After the thermal step ─────────────────────────────

  after(ctx: SystemContext, dt: number) {
    const t0 = performance.now();
    const fw = this.fw, w = this.trt.world;
    fw.roomRadiation();
    const U = w.u10 * Math.pow(Math.max(0.5, w.air.H / 2) / 10, 0.14);
    fw.transportOutdoor(dt, U * w.flowX, U * w.flowZ);
    fw.ledger.unresolved = w.ledger.combustionUnresolved;
    // Flashover: a burning room whose gas or floor flux reaches the criterion.
    for (let r = 0; r < fw.rooms.length; r++) {
      const R = fw.rooms[r];
      if (!Number.isNaN(R.flashover) || R.burning <= 0 || !w.comps[R.tc].alive) continue;
      if (w.compT(R.tc) >= FLASHOVER_T || R.qFloor >= FLASHOVER_FLUX) fw.flashover(r);
    }
    for (const [r, kind] of fw.roomEvents) if (kind === 'flashover') this.onRoomEvent(ctx, r, kind);
    fw.roomEvents.length = 0;
    this.structure(ctx);
    this.trees(ctx);
    this.exposure(ctx);
    this.statistics(ctx);
    this.ms += performance.now() - t0;
    this.msTotal += this.ms;
  }

  /** Glass breaking, burned-through facade parts, involvement of buildings. */
  private structure(ctx: SystemContext) {
    const fw = this.fw, B = this.trt.world.bodies, Tinf = this.trt.world.Tref;
    for (const R of this.rooms) {
      const bt = R.bt;
      for (const i of R.windows) {
        const b = bt.body[i];
        if (b < 0 || !B.alive[b]) continue;
        if (B.TS[b] - Tinf < GLASS_BREAK_DT) continue;
        const model = structureOf(bt.e, ctx).model;
        if (!model.alive(i)) continue;
        model.detachFacade(i, this.involved.has(bt) ? 'fire' : 'thermal', ctx.time, 1);
        activate(bt.e, ctx);
        this.windowsBroken.add(`${bt.e.id}:${i}`);
        if (!this.th.glass) { this.th.glass = true; ctx.milestone?.({ time: ctx.time, kind: 'windowBreak', hazard: 'fire', subject: 'building', label: { key: 'milestone.windowBreak', params: { T: toC(B.TS[b]).toFixed(0) } } }, 'fire:glass'); }
      }
    }
    // Facade parts (non-structural timber walls, doors) burned through leave as openings.
    for (let i = 0; i < fw.n; i++) {
      if (fw.kind[i] !== IK.member || fw.state[i] !== FS.burnedOut || fw.gone[i]) continue;
      const bt = this.trt.buildings[fw.ref[i]], m = fw.sub[i];
      if (bt.g.structural[m]) continue;
      const t = bt.g.type[m];
      if (t !== MT_WALL && t !== MT_DOOR && t !== MT_ROOF) continue;
      const model = structureOf(bt.e, ctx).model;
      if (!model.alive(m)) continue;
      model.detachFacade(m, 'fire', ctx.time, 1);
      activate(bt.e, ctx);
    }
  }

  /**
   * Charred timber (EN 1995-1-2 reduced cross-section): d_ef = d_char + k₀·d₀ removed from the
   * exposed faces (columns 4, beams 3, walls / slabs / roofs 1); the residual section keeps its
   * full properties. Until a char layer exists (≥ CHAR_SWITCH) the Phase 26 temperature-based
   * factor applies; from then on the EN method REPLACES it (the two are never multiplied), capped by
   * the section at the switch so the strength is continuous and never restored (the char front and
   * k₀ — counted from the switch — only grow).
   */
  charSection(bt: BuildingThermal, m: number): StrengthState | null {
    const b = bt.body[m];
    const items = b >= 0 ? this.bodyItems.get(b) : undefined;
    if (!items) return null;
    const i = items[0];
    const fw = this.fw;
    let sw = this.charStart.get(i);
    if (!sw) {
      if (fw.char[i] < CHAR_SWITCH) return null;
      const B = this.trt.world.bodies;
      sw = { t: fw.time, f: sectionFactors(bt.tmat[m], { Ts: B.TS[b], Tc: B.TC[b], TmaxS: B.TmaxS[b], TmaxC: B.TmaxC[b], wS: bt.wS[m] }) };
      this.charStart.set(i, sw);
    }
    const f0 = sw.f;
    const c = this.charOnly(bt, m, i);
    return { axial: Math.min(f0.axial, c.axial), bending: Math.min(f0.bending, c.bending), stiffness: Math.min(f0.stiffness, c.stiffness) };
  }

  /** Reduced cross-section factors of a charring member alone. */
  private charOnly(bt: BuildingThermal, m: number, i: number): StrengthState {
    const fw = this.fw;
    const k0 = Math.min(1, (fw.time - (this.charStart.get(i)?.t ?? fw.time)) / ZERO_STRENGTH_TIME);
    const d = fw.char[i] + k0 * ZERO_STRENGTH_LAYER;
    const g = bt.g, o = 6 * m, t = g.type[m];
    const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
    const pos = (v: number) => Math.max(0, v);
    if (t === MT_COLUMN) {
      const bb = Math.min(sx, sz), hh = Math.max(sx, sz);
      const r = (pos(bb - 2 * d) * pos(hh - 2 * d)) / (bb * hh);
      const ri = (pos(bb - 2 * d) ** 3 * pos(hh - 2 * d)) / (bb ** 3 * hh);
      return { axial: r, bending: r, stiffness: ri };
    }
    if (t === MT_BEAM) {
      const bb = Math.min(sx, sz), hh = sy;
      const b2 = pos(bb - 2 * d), h2 = pos(hh - d);
      return { axial: (b2 * h2) / (bb * hh), bending: (b2 * h2 * h2) / (bb * hh * hh), stiffness: (b2 * h2 ** 3) / (bb * hh ** 3) };
    }
    // Plates (walls, slabs, roofs): the solid thickness behind the burning face (= the depth the char front can reach).
    const th = Math.max(1e-3, fw.volume[i] / Math.max(1e-6, fw.area[i]));
    const r = pos(th - d) / th;
    return { axial: r, bending: r * r, stiffness: r * r * r };
  }

  /** Trees: the crown burned → less canopy (visual + wind catch), damage records. */
  private trees(ctx: SystemContext) {
    const fw = this.fw;
    for (let i = 0; i < fw.n; i++) {
      if (fw.kind[i] !== IK.foliage) continue;
      const b = fw.body[i];
      const te = b >= 0 ? this.trt.ents[this.trt.world.bodies.ref[b]] : undefined;
      if (!te) continue;
      const e = te.e;
      const burned = fw.m0[i] > 0 ? 1 - fw.m[i] / fw.m0[i] : 0;
      if (burned <= 0.001) continue;
      e.visual.burned = burned;
      const base = this.treeBase.get(e) ?? e.areaFactor;
      // A burned crown catches less wind (the canopy share of the frontal area goes with its leaves).
      e.areaFactor = base * (1 - 0.7 * burned);
      const level = burned >= 0.9 ? 2 : burned >= 0.3 ? 1 : 0;
      const prev = this.treeLevel.get(e) ?? 0;
      if (level > prev) {
        this.treeLevel.set(e, level);
        const before = 1 - e.health;
        e.health = Math.min(e.health, 1 - burned);
        const st = level === 2 ? DamageState.DESTROYED : DamageState.DAMAGED;
        if (st > e.state) e.state = st;
        if (st > e.peakState) e.peakState = st;
        e.lastCause = 'fire';
        e.lastHazard = 'fire';
        e.rev++;
        ctx.recordDamage(e, { eventType: level === 2 ? 'DESTROYED' : 'DAMAGED', cause: 'fire', hazard: 'fire', damageBefore: before, damageAfter: 1 - e.health, worldPosition: [...e.pose.position] });
        if (level === 2) this.stats.treesBurned++;
      }
    }
  }

  /** People: smoke (visibility) and O₂ of the air column around them — recorded, no physiology. */
  private exposure(ctx: SystemContext) {
    void ctx;
    const fw = this.fw, air = this.trt.world.air;
    for (const e of this.trt.humans) {
      const p = e.pose.position;
      const a = air.index(p[0], p[2], 1);
      const Cs = a >= 0 ? fw.soot[a] / (air.H * air.cellArea) : 0;
      const x = e.exposure;
      if (!x) continue;
      const f = (x.fire ??= { visibility: Infinity, smoke: 0, oxygen: 0.232, minVisibility: Infinity, peakSmoke: 0 });
      f.smoke = Cs;
      f.visibility = visibility(Cs);
      f.oxygen = fw.outdoorY(a);
      if (f.visibility < f.minVisibility) f.minVisibility = f.visibility;
      if (Cs > f.peakSmoke) f.peakSmoke = Cs;
    }
  }

  private onChange(ctx: SystemContext, i: number, from: number, to: number) {
    const fw = this.fw;
    if (to === FS.ignited) {
      if (this.cause[i] === '') this.cause[i] = 'flux';
      const first = !this.ignitedOwners.has(this.owner[i]);
      this.ignitedOwners.add(this.owner[i]);
      this.markInvolved(i);
      if (first && this.cause[i] !== 'scenario' && !this.th.spread) {
        this.th.spread = true;
        ctx.milestone?.({ time: ctx.time, kind: 'fireSpread', hazard: 'fire', subject: 'fire', label: { key: 'milestone.fireSpread', params: { what: fw.kind[i] } } }, 'fire:spread');
      }
      if (this.cause[i] === 'debris' && !this.th.secondary) {
        this.th.secondary = true;
        ctx.milestone?.({ time: ctx.time, kind: 'secondaryIgnition', hazard: 'fire', subject: 'fire', label: { key: 'milestone.secondaryIgnition' } }, 'fire:secondary');
      }
      if (!this.th.first) {
        this.th.first = true;
        ctx.milestone?.({ time: ctx.time, kind: 'ignition', hazard: 'fire', subject: 'fire', label: { key: 'milestone.ignition', params: { id: '', n: 1 } } }, 'fire:ignition');
      }
    }
    void from;
  }

  private onRoomEvent(ctx: SystemContext, r: number, kind: 'ventLimited' | 'flashover' | 'o2out') {
    if (kind === 'ventLimited' && !this.th.ventLimited) {
      this.th.ventLimited = true;
      ctx.milestone?.({ time: ctx.time, kind: 'oxygenLimited', hazard: 'fire', subject: 'building', label: { key: 'milestone.oxygenLimited' } }, 'fire:o2');
      ctx.log(this.rooms[r]?.bt.e.id ?? null, 'warn', { key: 'log.fire.ventLimited' });
    }
    if (kind === 'flashover' && !this.th.flashover) {
      this.th.flashover = true;
      ctx.milestone?.({ time: ctx.time, kind: 'flashover', hazard: 'fire', subject: 'building', label: { key: 'milestone.flashover', params: { T: toC(this.trt.world.compT(this.fw.rooms[r].tc)).toFixed(0) } } }, 'fire:flashover');
      ctx.log(this.rooms[r]?.bt.e.id ?? null, 'danger', { key: 'log.fire.flashover' });
    }
  }

  private statistics(ctx: SystemContext) {
    const fw = this.fw, s = this.stats, w = this.trt.world;
    let burningItems = 0, ext = 0;
    const burning = new Set<EntityId>();
    const live = new Map<EntityId, boolean>();
    for (let i = 0; i < fw.n; i++) {
      if (fw.gone[i]) continue;
      const st = fw.state[i];
      if (isBurning(st)) { burningItems++; burning.add(this.owner[i]); }
      if (st === FS.extinguished) ext++;
      if (this.ignitedOwners.has(this.owner[i])) live.set(this.owner[i], (live.get(this.owner[i]) ?? false) || (fw.m[i] > 1e-3 * fw.m0[i] && st !== FS.burnedOut));
    }
    let out = 0;
    for (const v of live.values()) if (!v) out++;
    let roomsBurning = 0, flash = 0, vl = 0, maxRoomT = w.Tref, smokeRooms = 0;
    for (const R of fw.rooms) {
      if (R.burning > 0) roomsBurning++;
      if (!Number.isNaN(R.flashover)) flash++;
      if (R.ventLimited && R.burning > 0) vl++;
      if (w.comps[R.tc].alive) maxRoomT = Math.max(maxRoomT, w.compT(R.tc));
      smokeRooms += R.soot;
    }
    let minVis = Infinity;
    const air = w.air;
    for (let a = 0; a < air.count; a++) if (fw.soot[a] > 0) minVis = Math.min(minVis, visibility(fw.soot[a] / (air.H * air.cellArea)));
    let charred = 0;
    for (let i = 0; i < fw.n; i++) if (fw.kind[i] === IK.member && fw.char[i] > 0) charred++;
    let failures = 0;
    for (const bt of this.involved) {
      const m = bt.e.modular!.structure?.model;
      if (!m) continue;
      const k = m.hazards.indexOf('fire');
      if (k < 0) continue;
      for (const r of m.records) if (r.hazard === 'fire' && r.cause !== 'facade') failures++;
    }
    Object.assign(s, {
      items: fw.n, ignitedObjects: this.ignitedOwners.size, burningObjects: burning.size, burnedOutObjects: out, extinguishedItems: ext, burningItems,
      hrr: fw.hrrNow, peakHrr: fw.peakHrr, peakHrrTime: fw.peakHrrTime, consumed: fw.ledger.fuelConsumed, released: fw.ledger.released,
      rooms: fw.rooms.length, roomsBurning, flashovers: flash, ventLimited: vl, maxRoomT, smokeAir: fw.ledger.smokeAir, smokeRooms, minVisibility: Math.min(s.minVisibility, minVis),
      charredMembers: charred, fireFailures: failures, windowsBroken: this.windowsBroken.size,
    });
    // Milestones: peak heat release levels, decay after the peak, the fire out, first fire failure.
    const th = this.th;
    const levels = [1e6, 1e7, 1e8];
    while (th.peak < levels.length && fw.peakHrr >= levels[th.peak]) {
      ctx.milestone?.({ time: ctx.time, kind: 'heatRelease', hazard: 'fire', subject: 'fire', label: { key: 'milestone.heatRelease', params: { Q: levels[th.peak] / 1e6 } } });
      th.peak++;
    }
    if (!th.decay && fw.peakHrr > 1e5 && fw.hrrNow < 0.5 * fw.peakHrr && ctx.time - fw.peakHrrTime > 10) {
      th.decay = true;
      ctx.milestone?.({ time: ctx.time, kind: 'fireDecay', hazard: 'fire', subject: 'fire', label: { key: 'milestone.fireDecay', params: { Q: (fw.peakHrr / 1e6).toFixed(2) } } }, 'fire:decay');
    }
    if (!th.out && th.first && burningItems === 0 && fw.ledger.released > 0) {
      th.out = true;
      ctx.milestone?.({ time: ctx.time, kind: 'fireOut', hazard: 'fire', subject: 'fire', label: { key: 'milestone.fireOut' } }, 'fire:out');
    }
    if (!th.failure && failures > 0) {
      th.failure = true;
      ctx.milestone?.({ time: ctx.time, kind: 'fireFailure', hazard: 'fire', subject: 'building', label: { key: 'milestone.fireFailure' } }, 'fire:failure');
    }
    this.hrrHist.push(fw.hrrNow);
    if (this.hrrHist.length > 600) this.hrrHist.shift();
  }

  /** Heat release history of the last minute (W, 0.1 s steps) — HUD sparkline. */
  history(): readonly number[] {
    return this.hrrHist;
  }

  /** Member index → fuel item of a modular building (renderer), null when it has none. */
  itemsByMember(id: EntityId): Map<number, number> | null {
    let m = this.memberItems.get(id);
    if (m === undefined) {
      m = null;
      for (let i = 0; i < this.fw.n; i++) if (this.fw.kind[i] === IK.member && this.owner[i] === id) (m ??= new Map()).set(this.fw.sub[i], i);
      if (m) this.memberItems.set(id, m);
    }
    return m;
  }
  private readonly memberItems = new Map<EntityId, Map<number, number> | null>();

  /** Items of an object (inspector). */
  itemsOf(id: EntityId): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.fw.n; i++) if (this.owner[i] === id) out.push(i);
    return out;
  }

  /** The fire room of a member body's story / of a point (inspector). */
  roomAt(P: Vec3): number {
    const inside = this.trt.buildingContaining(P);
    if (!inside) return -1;
    return this.roomOfComp.get(inside.comp) ?? -1;
  }

  roomInfo(r: number) {
    return this.rooms[r];
  }
}

/** World point of a local building point (exported for tests). */
export function localToWorld(e: RuntimeEntity, l: Vec3): Vec3 {
  const p = qRotate(e.pose.quaternion, l);
  return [e.pose.position[0] + p[0], e.pose.position[1] + p[1], e.pose.position[2] + p[2]];
}
