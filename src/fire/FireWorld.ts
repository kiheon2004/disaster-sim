/**
 * FireWorld (Phase 27): combustion on top of the Phase 26 thermal state — pure (no Rapier, no React).
 * It owns the fuel items, the fire state of building rooms, the outdoor O₂ / smoke tracers and the
 * fire ledgers; temperatures and heat stay in the ThermalWorld. Heat only enters the thermal world as
 *  - combustion energy ΔH_c·Δm handed back as per-item energies (the adapter turns them into thermal
 *    source steps booked as `combustion` — never as heat-source input), and
 *  - transfers that move existing enthalpy (burned mass leaves its node with its sensible heat,
 *    the heat of gasification goes with the volatiles, evaporation leaves with the steam).
 *
 * One step (dt, the thermal step):
 *  1. moisture: thin fuels above 100 °C drive off their water first (latent heat → lost.evaporation)
 *  2. states: ignition from the incident flux history (flux–time product, thick fuels) or the node
 *     temperature (thin fuels), with a pilot flame or without (autoignition), fuel and O₂ present
 *  3. fuel-controlled burning rates (thick: surface energy balance; thin: residence time; room
 *     contents: EN 1991-1-2 design fire t² / RHR_f / decay), involvement growth
 *  4. rooms: O₂ supply (openings by the Rockett relation + leakage) limits the burning inside;
 *     the vent-limited excess burns as an external flame at the openings (EN 1991-1-2 Annex B) —
 *     or, without openings, the burning slows down; smoke and O₂ are carried with the flows
 *  5. fuel, chemical energy, O₂ and smoke ledgers
 * Iteration is in item / room index order (insertion order of the adapter) — never object ids.
 */
import { ThermalWorld } from '@/thermal/ThermalWorld';
import { CP_AIR, SIGMA, BOILING } from '@/thermal/units';
import { FireLedger } from './ledger';
import {
  CROWN_SPREAD, thinFtpCritical, CHAR_INSULATION, CONTENTS_FIRE, DECAY_AT, E_O2, FLASHOVER_FLUX, FLASHOVER_T, FM, FUEL_MATERIALS, L_WATER, MOISTURE_EXTINCTION, MOISTURE_MAX, SPREAD_SPEED, Y_O2_AIR, Y_O2_LIMIT,
  ftpCritical, type ContentsFire,
} from './materials';
import { buoyantVelocity, gasEmissivity, ventInflow } from './relations';

/** Combustion state of a fuel item. */
export const FS = { unheated: 0, heating: 1, pyrolysis: 2, ignited: 3, burning: 4, decaying: 5, extinguished: 6, burnedOut: 7 } as const;
export type FireState = (typeof FS)[keyof typeof FS];
export const FIRE_STATES = ['unheated', 'heating', 'pyrolysis', 'ignited', 'burning', 'decaying', 'extinguished', 'burnedOut'] as const;

/** Allowed transitions (from → to); anything else is a programming error and throws. Burned out is final. */
const ALLOWED: readonly (readonly number[])[] = [
  /* unheated */ [FS.heating, FS.pyrolysis, FS.ignited],
  /* heating */ [FS.unheated, FS.pyrolysis, FS.ignited],
  /* pyrolysis */ [FS.heating, FS.ignited],
  /* ignited */ [FS.burning, FS.extinguished, FS.burnedOut],
  /* burning */ [FS.decaying, FS.extinguished, FS.burnedOut],
  /* decaying */ [FS.burning, FS.extinguished, FS.burnedOut],
  /* extinguished */ [FS.heating, FS.pyrolysis, FS.ignited, FS.burnedOut],
  /* burnedOut */ [],
];
export const canTransition = (from: number, to: number) => from === to || ALLOWED[from].includes(to);
export const isBurning = (s: number) => s === FS.ignited || s === FS.burning || s === FS.decaying;

/** Item kinds. */
export const IK = { member: 0, foliage: 1, trunk: 2, contents: 3, heap: 4 } as const;

export interface ItemInit {
  kind: number;
  mat: number;
  /** Thermal body (−1: room contents — no node of their own). */
  body: number;
  /** The fuel is the body's core node (tree trunks), else its skin. */
  core: boolean;
  /** Fire room the item faces (−1: outdoors only). */
  home: number;
  /** Burnable mass (kg) and its water (kg). */
  fuel: number;
  water: number;
  /** Surface that burns when fully involved (m²) — contents: the floor area. */
  area: number;
  /** Item size along which flames spread (m). */
  size: number;
  /** Solid mass (kg) and volume (m³) of the item — char depth of thick fuels. */
  solid: number;
  volume: number;
  /** Room contents: the design fire of the occupancy. */
  design?: ContentsFire | null;
  /** Position (contents; bodies use their node's). */
  x: number;
  y: number;
  z: number;
  ref: number;
  sub: number;
}

/** Fire state of a building room (one Phase 26 compartment). */
export interface FireRoom {
  /** Phase 26 compartment index. */
  tc: number;
  V: number;
  floor: number;
  /** Enclosure surface (m²) — mean beam length. */
  Aenc: number;
  /** Openings now (m², mean height m) — set by the adapter from the structural state. */
  Ao: number;
  Ho: number;
  /** Leakage air flow when closed (kg/s; Phase 26 air changes). */
  leak: number;
  /** O₂ and soot in the room (kg); gas mass (kg, constant volume at the ambient density — Boussinesq like Phase 26). */
  o2: number;
  soot: number;
  gas: number;
  /** Flows of the last step (kg/s), gas emissivity, vent-limited share of the fuel-controlled HRR. */
  inflow: number;
  eps: number;
  ventLimited: boolean;
  /** Heat release inside / at the openings (W), last step. */
  hrr: number;
  hrrExt: number;
  /** Flashover reached (time) / contents item. */
  flashover: number;
  contents: number;
  burning: number;
  /** Outdoor air-layer column outside it (−1 above the layer). */
  air: number;
  /** Rooms connected through failed slabs: [other room, opening area]. */
  links: [number, number][];
  /** Incident flux at the floor (gas + flames, W/m²). */
  qFloor: number;
}

const GROW = <T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, n: number): T => {
  const b = new (a.constructor as { new (n: number): T })(n);
  b.set(a as never);
  return b;
};

export interface FireStepInput {
  /** Wind speed at 10 m (m/s) — outdoor items only use it through the adapter's geometry. */
  time: number;
}

export class FireWorld {
  readonly tw: ThermalWorld;
  readonly ledger = new FireLedger();
  readonly rooms: FireRoom[] = [];
  n = 0;
  private cap = 0;
  kind = new Uint8Array(0);
  mat = new Uint8Array(0);
  body = new Int32Array(0);
  core = new Uint8Array(0);
  home = new Int32Array(0);
  /** Room the item burns in (−1 outdoors) — fixed at ignition by where the heat came from. */
  room = new Int32Array(0);
  state = new Uint8Array(0);
  /** 1 = the item no longer exists on its own (its fuel moved into a heap / left the world). */
  gone = new Uint8Array(0);
  m0 = new Float64Array(0);
  m = new Float64Array(0);
  water = new Float64Array(0);
  area = new Float32Array(0);
  size = new Float32Array(0);
  solid = new Float64Array(0);
  volume = new Float32Array(0);
  consumedSolid = new Float64Array(0);
  /** Involvement (0–1): share of the burnable surface / crown that is alight. */
  inv = new Float32Array(0);
  /** Thin fuels: mass of the part that is alight (kg) — only it burns. */
  pool = new Float64Array(0);
  /** Flux–time products (piloted / auto), incident flux now (W/m², from outside the item), pilot flame present. */
  ftpP = new Float64Array(0);
  ftpA = new Float64Array(0);
  qInc = new Float32Array(0);
  qRoom = new Float32Array(0);
  pilot = new Uint8Array(0);
  /** Submerged share (0–1) and rain arriving (kg/(m²·s)). */
  wet = new Float32Array(0);
  rain = new Float32Array(0);
  /** Burning: mass-loss rate (kg/s), heat release (W), released energy (J), ignition / state times. */
  mdot = new Float64Array(0);
  hrr = new Float64Array(0);
  E = new Float64Array(0);
  tIgn = new Float64Array(0);
  tState = new Float64Array(0);
  tLow = new Float32Array(0);
  /** Char depth (m, thick fuels). */
  char = new Float32Array(0);
  /** Heat of this step (J): released in the item's own place, and the external-flame share of room items. */
  Estep = new Float64Array(0);
  /** Contents: design-fire state (decay start heat release, time). */
  qd = new Float64Array(0);
  td = new Float64Array(0);
  x = new Float64Array(0);
  y = new Float64Array(0);
  z = new Float64Array(0);
  ref = new Int32Array(0);
  sub = new Int32Array(0);
  design: (ContentsFire | null)[] = [];
  /** Peak heat release of an item (W). */
  peak = new Float64Array(0);

  /** Outdoor air-layer tracers (per column): O₂ deficit and soot (kg). */
  readonly o2def: Float64Array;
  readonly soot: Float64Array;
  private readonly tmp: Float64Array;

  /** Run totals for results. */
  peakHrr = 0;
  peakHrrTime = 0;
  hrrNow = 0;
  /** Transitions of this step: [item, from, to] (adapter: events, milestones). */
  readonly changes: [number, number, number][] = [];
  /** Rooms that became oxygen-limited / reached flashover this step. */
  readonly roomEvents: [number, 'ventLimited' | 'flashover' | 'o2out'][] = [];
  time = 0;

  constructor(tw: ThermalWorld) {
    this.tw = tw;
    this.o2def = new Float64Array(tw.air.count);
    this.soot = new Float64Array(tw.air.count);
    this.tmp = new Float64Array(tw.air.count);
  }

  private grow(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(64, this.cap * 2, n);
    for (const k of ['kind', 'mat', 'body', 'core', 'home', 'room', 'state', 'gone', 'm0', 'm', 'water', 'area', 'size', 'solid', 'volume', 'consumedSolid', 'inv', 'pool', 'ftpP', 'ftpA', 'qInc', 'qRoom', 'pilot', 'wet', 'rain', 'mdot', 'hrr', 'E', 'tIgn', 'tState', 'tLow', 'char', 'Estep', 'qd', 'td', 'x', 'y', 'z', 'ref', 'sub', 'peak'] as const) {
      (this as unknown as Record<string, Float64Array>)[k] = GROW((this as unknown as Record<string, Float64Array>)[k], cap);
    }
    this.cap = cap;
  }

  /** Register a fuel item (its fuel and chemical energy join the ledgers). */
  add(it: ItemInit): number {
    const i = this.n;
    this.grow(i + 1);
    this.n++;
    this.kind[i] = it.kind; this.mat[i] = it.mat; this.body[i] = it.body; this.core[i] = it.core ? 1 : 0; this.home[i] = it.home; this.room[i] = -1;
    this.state[i] = FS.unheated; this.gone[i] = 0; this.m0[i] = it.fuel; this.m[i] = it.fuel; this.water[i] = it.water; this.area[i] = it.area; this.size[i] = Math.max(0.1, it.size);
    this.solid[i] = it.solid; this.volume[i] = it.volume; this.consumedSolid[i] = 0; this.inv[i] = 0; this.pool[i] = 0; this.ftpP[i] = 0; this.ftpA[i] = 0; this.qInc[i] = 0; this.qRoom[i] = 0; this.pilot[i] = 0;
    this.wet[i] = 0; this.rain[i] = 0; this.mdot[i] = 0; this.hrr[i] = 0; this.E[i] = 0; this.tIgn[i] = NaN; this.tState[i] = this.time; this.tLow[i] = 0; this.char[i] = 0; this.Estep[i] = 0;
    this.qd[i] = 0; this.td[i] = 0; this.x[i] = it.x; this.y[i] = it.y; this.z[i] = it.z; this.ref[i] = it.ref; this.sub[i] = it.sub; this.design[i] = it.design ?? null; this.peak[i] = 0;
    const L = this.ledger;
    L.fuelRegistered += it.fuel;
    L.chemRegistered += it.fuel * FUEL_MATERIALS[it.mat].dHc;
    if (it.kind === IK.contents && it.home >= 0) this.rooms[it.home].contents = i;
    return i;
  }

  addRoom(tc: number, V: number, floor: number, Aenc: number, air: number, leak: number, rho: number): number {
    const gas = rho * V;
    this.rooms.push({ tc, V, floor, Aenc, Ao: 0, Ho: 0, leak, o2: Y_O2_AIR * gas, soot: 0, gas, inflow: 0, eps: 0, ventLimited: false, hrr: 0, hrrExt: 0, flashover: NaN, contents: -1, burning: 0, air, links: [], qFloor: 0 });
    return this.rooms.length - 1;
  }

  /** Item position (node or own). */
  pos(i: number): [number, number, number] {
    const b = this.body[i];
    if (b >= 0) { const B = this.tw.bodies; return [B.x[b], B.y[b], B.z[b]]; }
    return [this.x[i], this.y[i], this.z[i]];
  }

  /** Node temperature of the fuel (contents: the room gas). */
  fuelT(i: number): number {
    const b = this.body[i];
    if (b < 0) return this.home[i] >= 0 ? this.tw.compT(this.rooms[this.home[i]].tc) : this.tw.Tref;
    return this.core[i] ? this.tw.bodies.TC[b] : this.tw.bodies.TS[b];
  }

  /** Estimated surface temperature (K): thick fuels from the flux–time product, thin fuels their node. */
  surfaceT(i: number): number {
    const mt = FUEL_MATERIALS[this.mat[i]];
    if (isBurning(this.state[i])) return mt.thin ? Math.max(this.fuelT(i), mt.Tig) : mt.Tburn;
    if (mt.thin) return this.fuelT(i);
    const T0 = this.fuelT(i);
    const c = ftpCritical(mt, mt.Tig, this.tw.Tref);
    return T0 + (mt.Tig - this.tw.Tref) * Math.sqrt(Math.min(4, this.ftpP[i] / Math.max(1, c)));
  }

  private set(i: number, to: number) {
    const from = this.state[i];
    if (from === to) return;
    if (!canTransition(from, to)) throw new Error(`fuel item ${i}: illegal fire state transition ${FIRE_STATES[from]} → ${FIRE_STATES[to]}`);
    this.state[i] = to;
    this.tState[i] = this.time;
    this.changes.push([i, from, to]);
  }

  /** Forced (scenario) ignition of an item now — a pilot flame at the given point. False when it cannot burn. */
  ignite(i: number, roomSide: boolean): boolean {
    const s = this.state[i];
    if (this.m[i] <= 0 || s === FS.burnedOut || isBurning(s)) return false;
    if (this.gone[i] || this.wet[i] >= 0.9) return false;
    // A fine fuel wetter than its moisture of extinction cannot be lit (it must be dried by heating first).
    if (this.tooMoist(i)) return false;
    this.room[i] = roomSide && this.home[i] >= 0 ? this.home[i] : -1;
    this.light(i);
    return true;
  }

  /** Ignition: state, time and the part that is alight (thin fuels dry it with the heat they took in). */
  private light(i: number) {
    this.set(i, FS.ignited);
    this.tIgn[i] = this.time;
    this.inv[i] = this.initialInvolvement(i);
    this.ftpP[i] = 0;
    this.ftpA[i] = 0;
    const mt = FUEL_MATERIALS[this.mat[i]];
    if (mt.thin && this.kind[i] !== IK.contents) {
      const part = this.inv[i] * this.m[i];
      this.pool[i] += part;
      // The water of the lit part was driven off by the exposure that lit it (latent heat out of the node).
      const b = this.body[i];
      if (b >= 0 && this.m[i] > 0 && this.water[i] > 0) {
        const B = this.tw.bodies, core = this.core[i] === 1;
        const avail = Math.max(0, (core ? B.EC[b] : B.ES[b]) * 0.5);
        const dmw = Math.min((part * this.water[i]) / this.m[i], avail / L_WATER);
        if (dmw > 0) {
          this.water[i] -= dmw;
          this.tw.sink(b, core, dmw * L_WATER);
          this.ledger.waterEvaporated += dmw;
          this.ledger.latentHeat += dmw * L_WATER;
        }
      }
    }
  }

  /** Fine fuel above its moisture of extinction. */
  tooMoist(i: number): boolean {
    return FUEL_MATERIALS[this.mat[i]].thin && this.kind[i] !== IK.contents && this.water[i] > MOISTURE_EXTINCTION * Math.max(1e-9, this.m[i]);
  }

  private initialInvolvement(i: number): number {
    if (this.kind[i] === IK.contents) return 1;
    const mt = FUEL_MATERIALS[this.mat[i]];
    // A spot of ≈ 0.1 m² (thick) or ≈ 5 % of a crown (thin) is alight at ignition.
    return mt.thin ? 0.05 : Math.min(1, 0.1 / Math.max(0.1, this.area[i]));
  }

  // ── Step ───────────────────────────────────────────────

  step(dt: number) {
    const tw = this.tw, B = tw.bodies, Tinf = tw.Tref;
    this.changes.length = 0;
    this.roomEvents.length = 0;
    this.time += dt;
    // 1. Moisture of thin fuels (and wetted surfaces): energy above 100 °C evaporates the water.
    for (let i = 0; i < this.n; i++) {
      const b = this.body[i];
      if (b < 0 || this.gone[i] || !B.alive[b]) continue;
      // Rain wets outdoor fine fuels (up to a saturation cap).
      if (this.rain[i] > 0 && FUEL_MATERIALS[this.mat[i]].thin) this.water[i] = Math.min(MOISTURE_MAX * this.m[i], this.water[i] + this.rain[i] * 0.25 * this.area[i] * dt);
      if (this.water[i] <= 0) continue;
      const core = this.core[i] === 1;
      const T = core ? B.TC[b] : B.TS[b];
      if (T <= BOILING) continue;
      const excess = Math.max(0, (core ? B.EC[b] : B.ES[b]) - B.energyAt(b, core, BOILING));
      const dmw = Math.min(this.water[i], excess / L_WATER);
      if (dmw <= 0) continue;
      const J = dmw * L_WATER;
      this.water[i] -= dmw;
      tw.sink(b, core, J);
      // The water leaves the node: its mass (and its sensible heat at 100 °C, with the steam) goes too.
      tw.removeMass(b, core, Math.min(dmw, (core ? B.mC[b] : B.mS[b]) * 0.5), -1, -1);
      this.ledger.waterEvaporated += dmw;
      this.ledger.latentHeat += J;
    }
    // 2–3. States and fuel-controlled burning.
    for (let i = 0; i < this.n; i++) {
      this.Estep[i] = 0;
      this.mdot[i] = 0;
      const s = this.state[i];
      if (s === FS.burnedOut || this.gone[i]) { this.hrr[i] = 0; continue; }
      const b = this.body[i];
      if (b >= 0 && !B.alive[b]) { this.hrr[i] = 0; continue; }
      if (isBurning(s)) this.burnRate(i, dt);
      else this.heatUp(i, dt, Tinf);
    }
    // 4. Rooms: the O₂ supply limits the burning inside; flows carry O₂ and smoke.
    const roomQ = new Float64Array(this.rooms.length);
    for (let i = 0; i < this.n; i++) if (this.mdot[i] > 0 && this.room[i] >= 0) roomQ[this.room[i]] += this.mdot[i] * FUEL_MATERIALS[this.mat[i]].dHc;
    const ext = new Float64Array(this.rooms.length);
    const scale = new Float64Array(this.rooms.length).fill(1);
    for (let r = 0; r < this.rooms.length; r++) {
      const R = this.rooms[r];
      const cp = tw.comps[R.tc];
      if (!cp.alive) { R.inflow = 0; R.eps = 0; continue; }
      const Tg = tw.compT(R.tc);
      const rho = tw.air.rho;
      const vent = ventInflow(R.Ao, R.Ho, Tg, Tinf, rho);
      const inflow = vent + R.leak;
      R.inflow = inflow;
      const Yinf = this.outdoorY(R.air);
      // Exchange with the outside first (exact exponential mixing of a well-stirred room), then the
      // O₂ that can burn: what is above the limiting fraction (the exhaust cannot be leaner).
      const f = R.gas > 0 ? 1 - Math.exp((-inflow * dt) / R.gas) : 0;
      const o2Out = (R.o2 - Yinf * R.gas) * f;
      R.o2 -= o2Out;
      this.outdoorO2(R.air, o2Out);
      const sOut = R.soot * f;
      R.soot -= sOut;
      this.toOutdoorSoot(R.air, sOut);
      const avail = Math.max(0, R.o2 - Y_O2_LIMIT * R.gas);
      const Qmax = (E_O2 * avail) / dt;
      const Qf = roomQ[r];
      const limited = Qf > Qmax;
      if (limited !== R.ventLimited) { R.ventLimited = limited; if (limited && Qf > 0) this.roomEvents.push([r, 'ventLimited']); }
      let Qin = Qf;
      if (limited) {
        Qin = Qmax;
        // The excess pyrolysate burns outside the openings when there are any (EN 1991-1-2 Annex B),
        // otherwise the burning itself slows down to what the O₂ supply allows.
        if (R.Ao > 0) ext[r] = Qf - Qmax;
        else scale[r] = Qf > 0 ? Qmax / Qf : 0;
      }
      R.hrr = Qin;
      R.hrrExt = ext[r];
      const cons = (Qin * dt) / E_O2;
      R.o2 = Math.max(0, R.o2 - cons);
      this.ledger.oxygenConsumed += cons;
      // Ventilation heat leaves with the outflow: the Phase 26 room vent gets the flow's conductance.
      cp.Gx = vent * CP_AIR;
      if (R.o2 <= Y_O2_LIMIT * R.gas * 1.0001 && Qf > 0) this.roomEvents.push([r, 'o2out']);
    }
    // Room-to-room exchange through failed slabs (buoyant mixing, both ways).
    for (let r = 0; r < this.rooms.length; r++) {
      const R = this.rooms[r];
      for (const [o, A] of R.links) {
        if (o <= r) continue;
        const S = this.rooms[o];
        if (!tw.comps[R.tc].alive || !tw.comps[S.tc].alive) continue;
        const dT = Math.abs(tw.compT(R.tc) - tw.compT(S.tc));
        const mx = 0.5 * tw.air.rho * A * buoyantVelocity(Math.cbrt(R.V), dT, Tinf);
        const f = Math.min(0.5, (mx * dt) / Math.min(R.gas, S.gas));
        const dO = (R.o2 / R.gas - S.o2 / S.gas) * f * Math.min(R.gas, S.gas);
        R.o2 -= dO; S.o2 += dO;
        const dS = (R.soot / R.gas - S.soot / S.gas) * f * Math.min(R.gas, S.gas);
        R.soot -= dS; S.soot += dS;
      }
    }
    // 5. Apply: mass loss, energies, O₂ / smoke, ledgers.
    const L = this.ledger;
    let total = 0;
    for (let i = 0; i < this.n; i++) {
      let md = this.mdot[i];
      if (md <= 0) { this.hrr[i] = 0; continue; }
      const r = this.room[i];
      if (r >= 0) md *= scale[r];
      const mt = FUEL_MATERIALS[this.mat[i]];
      md = Math.min(md, this.m[i] / dt);
      const dm = md * dt;
      const J = dm * mt.dHc;
      // The water of the burning part leaves with it: its latent heat comes out of the flame's heat
      // (booked as evaporation; the heat of combustion stays the dry-fuel value).
      const dmw = this.m[i] > 0 && this.water[i] > 0 ? Math.min(this.water[i], (dm * this.water[i]) / this.m[i]) : 0;
      const Jw = Math.min(J, dmw * L_WATER);
      if (dmw > 0) {
        this.water[i] -= dmw;
        L.waterEvaporated += dmw;
        L.latentHeat += Jw;
        this.tw.ledger.combustion += Jw;
        this.tw.ledger.lost.evaporation += Jw;
      }
      this.mdot[i] = md;
      this.hrr[i] = md * mt.dHc;
      if (this.hrr[i] > this.peak[i]) this.peak[i] = this.hrr[i];
      this.m[i] -= dm;
      if (mt.thin) this.pool[i] = Math.max(0, this.pool[i] - dm);
      this.E[i] += J;
      this.Estep[i] = J - Jw;
      total += this.hrr[i];
      L.fuelConsumed += dm;
      L.released += J;
      if (r >= 0) {
        const R = this.rooms[r];
        const Qf = roomQ[r] * scale[r];
        const share = Qf > 0 ? ext[r] / Qf : 0;
        L.releasedRooms += J * (1 - share);
        L.releasedExternal += J * share;
        R.soot += mt.ys * dm * (1 - share);
        this.toOutdoorSoot(R.air, mt.ys * dm * share);
        this.outdoorO2(R.air, -(J * share) / E_O2);
        L.oxygenConsumed += (J * share) / E_O2;
      } else {
        L.releasedOutdoor += J;
        const a = this.airOf(i);
        this.toOutdoorSoot(a, mt.ys * dm);
        this.outdoorO2(a, -J / E_O2);
        L.oxygenConsumed += J / E_O2;
      }
      L.smokeProduced += mt.ys * dm;
      // The node loses the burned mass with its sensible heat (to the gas the volatiles burn in) and
      // the heat of gasification (it went into the volatiles).
      const b = this.body[i];
      if (b >= 0) {
        const BB = this.tw.bodies;
        // The charring front eats the skin first, then the core.
        const core = this.core[i] === 1 || (BB.mC[b] > 0 && BB.mS[b] < 2 * dm + 1e-6);
        const gas = r >= 0 ? { kind: 3, index: this.rooms[r].tc } : this.gasTarget(i);
        this.tw.removeMass(b, core, dm, gas.kind, gas.index);
        if (mt.Lg > 0) this.tw.moveEnergy(b, core, gas.kind, gas.index, Math.min(mt.Lg * dm, Math.max(0, core ? this.tw.bodies.EC[b] : this.tw.bodies.ES[b])));
        if (!mt.thin) {
          const dv = dm / (1 - mt.charYield);
          this.consumedSolid[i] += dv;
          this.char[i] = (Math.min(this.solid[i], this.consumedSolid[i]) / Math.max(1e-9, this.solid[i])) * (this.volume[i] / Math.max(1e-6, this.area[i]));
        }
      }
      // Burned out below 0.1 % of the fuel it had (the rest stays booked as remaining residue).
      if (this.m[i] <= 1e-3 * this.m0[i]) this.set(i, FS.burnedOut);
    }
    this.hrrNow = total;
    if (total > this.peakHrr) { this.peakHrr = total; this.peakHrrTime = this.time; }
    this.tally();
  }

  /** Outdoor O₂ mass fraction at an air column (−1: ambient). */
  outdoorY(a: number): number {
    if (a < 0) return Y_O2_AIR;
    const air = this.tw.air;
    const m = air.rho * air.H * air.cellArea;
    return Math.max(0, Y_O2_AIR - this.o2def[a] / m);
  }

  /** Add O₂ (kg, negative = consumed) to an outdoor column. */
  private outdoorO2(a: number, kg: number) {
    if (a >= 0) this.o2def[a] = Math.max(0, this.o2def[a] - kg);
  }

  private toOutdoorSoot(a: number, kg: number) {
    if (kg === 0) return;
    if (a >= 0) this.soot[a] += kg;
    else this.ledger.smokeVented += kg;
  }

  airOf(i: number): number {
    const b = this.body[i];
    if (b >= 0) return this.tw.bodies.air[b];
    const h = this.home[i];
    return h >= 0 ? this.rooms[h].air : -1;
  }

  /** Gas node outdoor items burn in: their air column, or ambient above the layer (kind −1). */
  private gasTarget(i: number): { kind: number; index: number } {
    const a = this.airOf(i);
    return a >= 0 ? { kind: 2, index: a } : { kind: -1, index: -1 };
  }

  /** Not burning: heating, pyrolysis, ignition. */
  private heatUp(i: number, dt: number, Tinf: number) {
    const mt = FUEL_MATERIALS[this.mat[i]];
    const s = this.state[i];
    const q = this.qInc[i];
    const T = this.fuelT(i);
    this.hrr[i] = 0;
    if (this.m[i] <= 0) return;
    const R = this.home[i] >= 0 ? this.rooms[this.home[i]] : null;
    // O₂ where it would burn.
    const yO2 = R && this.tw.comps[R.tc].alive ? R.o2 / R.gas : this.outdoorY(this.airOf(i));
    let ignite = false;
    if (this.kind[i] === IK.contents) {
      // Room contents: piloted by flames in the room, otherwise by the 20 kW/m² floor flux (flashover)
      // or the hot gas reaching their autoignition temperature.
      const qf = R ? R.qFloor : 0;
      ignite = (this.pilot[i] === 1 && qf >= mt.qcr) || qf >= FLASHOVER_FLUX || T >= mt.Tauto;
    } else if (mt.thin) {
      // Exposed fine elements: thermally thin flux–time product (n = 1) against the heat of
      // pre-ignition at the crown's moisture; or the whole node hot and dry enough.
      const wq = this.wet[i] >= 0.5 ? 0 : q;
      this.ftpP[i] = Math.max(0, this.ftpP[i] + (wq - mt.qcr) * dt);
      this.ftpA[i] = Math.max(0, this.ftpA[i] + (wq - mt.qcrAuto) * dt);
      const need = thinFtpCritical(this.water[i] / Math.max(1e-9, this.m[i]));
      ignite = (this.pilot[i] === 1 && this.ftpP[i] >= need) || this.ftpA[i] >= need || (!this.tooMoist(i) && (T >= mt.Tauto || (this.pilot[i] === 1 && T >= mt.Tig)));
    } else {
      // Thick: flux–time product above the critical flux, piloted or not; and the node itself.
      const wq = this.wet[i] >= 0.5 ? 0 : q;
      this.ftpP[i] = Math.max(0, this.ftpP[i] + Math.sign(wq - mt.qcr) * (wq - mt.qcr) ** 2 * dt);
      this.ftpA[i] = Math.max(0, this.ftpA[i] + Math.sign(wq - mt.qcrAuto) * (wq - mt.qcrAuto) ** 2 * dt);
      const piloted = this.pilot[i] === 1 && this.ftpP[i] >= ftpCritical(mt, mt.Tig, Tinf);
      const auto = this.ftpA[i] >= ftpCritical(mt, mt.Tauto, Tinf) || T >= mt.Tauto;
      ignite = piloted || auto;
    }
    if (yO2 < Y_O2_LIMIT || this.wet[i] >= 0.9) ignite = false;
    if (ignite) {
      // Burns where its heat came from: the room it faces when the room dominates, else outdoors.
      this.room[i] = this.kind[i] === IK.contents ? this.home[i] : R && this.tw.comps[R.tc].alive && this.qRoom[i] >= 0.5 * q ? this.home[i] : -1;
      this.light(i);
      return;
    }
    const Ts = this.surfaceT(i);
    const want = Ts >= mt.Tpyro ? FS.pyrolysis : q >= 1000 || T - Tinf >= 5 ? FS.heating : FS.unheated;
    if (want === s) return;
    if (s === FS.extinguished) { if (want !== FS.unheated) this.set(i, want); return; }
    this.set(i, s === FS.pyrolysis && want === FS.unheated ? FS.heating : want);
  }

  /** Burning: fuel-controlled mass-loss rate (O₂ limits applied by the caller), extinction. */
  private burnRate(i: number, dt: number) {
    const mt = FUEL_MATERIALS[this.mat[i]];
    const s = this.state[i];
    if (s === FS.ignited) this.set(i, FS.burning);
    const t = this.time - this.tIgn[i];
    const wetCut = Math.max(0, 1 - this.wet[i]);
    if (this.wet[i] >= 0.9) { this.set(i, FS.extinguished); this.hrr[i] = 0; return; }
    let md = 0;
    if (this.kind[i] === IK.contents) {
      const d = this.design[i];
      const R = this.home[i] >= 0 ? this.rooms[this.home[i]] : null;
      if (!d || !R) return;
      const Qmax = d.rhrf * R.floor;
      const Qgrow = 1e6 * (t / d.tAlpha) ** 2;
      let Q = Math.min(Qmax, Qgrow);
      // Flashover: the whole floor is involved.
      if (!Number.isNaN(R.flashover)) Q = Qmax;
      const consumed = 1 - this.m[i] / Math.max(1e-9, this.m0[i]);
      if (consumed >= DECAY_AT && this.state[i] !== FS.decaying) {
        // Linear decay that consumes exactly the remaining load (EN 1991-1-2 E.4).
        this.qd[i] = Math.max(1e3, this.hrr[i] || Q);
        this.td[i] = (2 * this.m[i] * mt.dHc) / this.qd[i];
        this.set(i, FS.decaying);
      }
      if (this.state[i] === FS.decaying) Q = this.qd[i] * Math.max(0, 1 - (this.time - this.tState[i]) / Math.max(1e-6, this.td[i]));
      // End of the decay: what is left stays as unburned residue.
      if (Q <= 0) { this.set(i, FS.burnedOut); return; }
      md = (Q * wetCut) / mt.dHc;
    } else if (mt.thin) {
      // Foliage: the lit part burns out within the flame residence time. In a crown drier than the
      // moisture of extinction the flames climb through it (CROWN_SPREAD); a wetter (live) crown burns
      // only the parts its exposure lights. Rain wetting a burning crown above that limit puts it out.
      const dry = !this.tooMoist(i);
      if (dry) this.pool[i] = Math.min(this.m[i], this.pool[i] + this.m[i] * (CROWN_SPREAD / Math.max(0.5, this.size[i])) * dt);
      else if (this.rain[i] > 0) { this.set(i, FS.extinguished); this.pool[i] = 0; return; }
      md = (this.pool[i] * wetCut) / mt.residence;
      this.inv[i] = this.m[i] > 0 ? Math.min(1, this.pool[i] / this.m[i]) : 0;
      if (this.pool[i] <= 1e-4 * this.m0[i]) {
        this.pool[i] = 0;
        this.set(i, this.m[i] <= 1e-3 * this.m0[i] ? FS.burnedOut : FS.extinguished);
        return;
      }
      if (this.m[i] < (1 - DECAY_AT) * this.m0[i] && this.state[i] === FS.burning) this.set(i, FS.decaying);
    } else {
      // Thick solid: surface energy balance ṁ″ = (q_fl + α·q_ext − ε·σ(T_b⁴ − T∞⁴) − q_water)/L_g, capped.
      this.inv[i] = Math.min(1, this.inv[i] + (SPREAD_SPEED / Math.max(0.1, Math.sqrt(this.area[i]))) * dt);
      const qrr = 0.9 * SIGMA * (mt.Tburn ** 4 - this.tw.Tref ** 4);
      const qw = this.rain[i] * L_WATER;
      // The char layer insulates the virgin wood: the char-free peak falls to the charring-front rate.
      const cap = mt.mChar + (mt.mMax - mt.mChar) * Math.exp(-this.char[i] / CHAR_INSULATION);
      const mpp = Math.min(cap, Math.max(0, (mt.qFlame + 0.9 * this.qInc[i] - qrr - qw) / mt.Lg));
      const fade = this.m[i] < (1 - DECAY_AT) * this.m0[i] ? Math.max(0.05, this.m[i] / ((1 - DECAY_AT) * this.m0[i])) : 1;
      if (fade < 1 && this.state[i] === FS.burning) this.set(i, FS.decaying);
      if (mpp < mt.mCrit) {
        this.tLow[i] += dt;
        // Below the critical mass-loss rate the flame cannot be sustained (held 2 s against flicker).
        if (this.tLow[i] >= 2) { this.set(i, FS.extinguished); this.tLow[i] = 0; this.inv[i] = 0; return; }
      } else this.tLow[i] = 0;
      md = mpp * this.area[i] * this.inv[i] * wetCut * fade;
    }
    // O₂ outdoors: a column below the limiting fraction cannot sustain flaming.
    if (this.room[i] < 0 && this.outdoorY(this.airOf(i)) < Y_O2_LIMIT) { this.set(i, FS.extinguished); return; }
    if (this.room[i] >= 0 && !this.tw.comps[this.rooms[this.room[i]].tc].alive) this.room[i] = -1;
    this.mdot[i] = md;
  }

  /** Remaining fuel / smoke totals for the ledgers; room gas emissivity. */
  tally() {
    const L = this.ledger;
    let fuel = 0, chem = 0;
    for (let i = 0; i < this.n; i++) { fuel += this.m[i]; chem += this.m[i] * FUEL_MATERIALS[this.mat[i]].dHc; }
    L.fuelRemaining = fuel;
    L.chemRemaining = chem;
    let sr = 0;
    for (const R of this.rooms) sr += R.soot;
    let sa = 0;
    for (let a = 0; a < this.soot.length; a++) sa += this.soot[a];
    L.smokeRooms = sr;
    L.smokeAir = sa;
  }

  /** Room gas emissivity from its soot (sets the Phase 26 room ↔ surface radiation). */
  roomRadiation() {
    const tw = this.tw;
    for (const R of this.rooms) {
      const cp = tw.comps[R.tc];
      if (!cp.alive) { cp.eps = 0; R.eps = 0; continue; }
      const Tg = tw.compT(R.tc);
      R.eps = gasEmissivity(R.soot / R.V, Tg, R.V, R.Aenc);
      cp.eps = R.eps;
    }
  }

  /**
   * Outdoor smoke and O₂ deficit after the thermal step: buoyant venting of warm columns (the same
   * velocity scale as the air layer's heat) and transport by the mean wind (donor cell, CFL steps).
   */
  transportOutdoor(dt: number, u: number, w: number) {
    const air = this.tw.air, L = this.ledger;
    for (let a = 0; a < air.count; a++) {
      if (this.soot[a] === 0 && this.o2def[a] === 0) continue;
      const v = buoyantVelocity(air.H, air.T(a) - air.Tref, air.Tref);
      const f = 1 - Math.exp((-v * dt) / air.H);
      if (f <= 0) continue;
      const s = this.soot[a] * f;
      this.soot[a] -= s;
      L.smokeVented += s;
      this.o2def[a] -= this.o2def[a] * f;
    }
    L.smokeAdvected += this.advect(this.soot, u, w, dt);
    this.advect(this.o2def, u, w, dt);
    this.tally();
  }

  private advect(q: Float64Array, u: number, w: number, dt: number): number {
    const air = this.tw.air;
    const cx = Math.abs(u) / 5, cz = Math.abs(w) / 5;
    const rate = cx + cz;
    if (rate <= 0) return 0;
    const n = Math.max(1, Math.ceil((rate * dt) / 0.9));
    const fx = (cx * dt) / n, fz = (cz * dt) / n;
    const { nx, nz } = air;
    const tmp = this.tmp;
    let out = 0;
    for (let s = 0; s < n; s++) {
      tmp.set(q);
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const a = iz * nx + ix;
        const e = tmp[a];
        if (e === 0) continue;
        const ox = e * fx, oz = e * fz;
        q[a] -= ox + oz;
        const tx = ix + (u > 0 ? 1 : -1), tz = iz + (w > 0 ? 1 : -1);
        if (ox !== 0) { if (tx >= 0 && tx < nx) q[iz * nx + tx] += ox; else out += ox; }
        if (oz !== 0) { if (tz >= 0 && tz < nz) q[tz * nx + ix] += oz; else out += oz; }
      }
    }
    return out;
  }

  /**
   * Move an item's remaining fuel into another item (burning debris landing on a rubble heap): the
   * fuel keeps its material; the receiver catches fire if the debris was burning. The item is gone.
   */
  transfer(from: number, to: number) {
    const dm = this.m[from];
    this.gone[from] = 1;
    this.hrr[from] = 0;
    if (dm <= 0) return;
    this.m[from] = 0;
    // The heap keeps one material (timber debris): a different source material is converted at its heat content.
    const conv = FUEL_MATERIALS[this.mat[from]].dHc / FUEL_MATERIALS[this.mat[to]].dHc;
    this.m[to] += dm * conv;
    this.m0[to] += dm * conv;
    this.solid[to] += dm * conv;
    this.ledger.fuelMoved += dm;
    // Booked as consumed at the source and registered at the receiver (identical chemical energy).
    this.ledger.fuelRegistered += dm * conv - dm;
    if (isBurning(this.state[from]) && !isBurning(this.state[to]) && this.state[to] !== FS.burnedOut) {
      this.room[to] = -1;
      this.light(to);
    }
  }

  /** Flames put out from outside (burning debris buried in the ground / water): the fuel left stays. */
  quench(i: number) {
    if (isBurning(this.state[i])) { this.set(i, FS.extinguished); this.hrr[i] = 0; this.inv[i] = 0; }
  }

  /** The item's fuel leaves the world (fragment beyond the edge). */
  leave(i: number) {
    const L = this.ledger;
    L.fuelLeft += this.m[i];
    L.chemLeft += this.m[i] * FUEL_MATERIALS[this.mat[i]].dHc;
    this.m[i] = 0;
    this.gone[i] = 1;
    this.hrr[i] = 0;
  }

  /** Flashover of a room (adapter decides from its gas / floor flux). */
  flashover(r: number) {
    const R = this.rooms[r];
    if (!Number.isNaN(R.flashover)) return;
    R.flashover = this.time;
    this.roomEvents.push([r, 'flashover']);
  }

  static readonly flashoverT = FLASHOVER_T;
  static readonly contentsFire = CONTENTS_FIRE;
  static readonly FM = FM;
}
