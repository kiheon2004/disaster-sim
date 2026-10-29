/**
 * Thermal nodes of solid bodies (Phase 26): structural members, objects (legacy buildings, vehicles,
 * trees, walls, poles, signs), debris fragments and rubble heaps — struct-of-arrays, grown on demand.
 *
 * Each body has a SKIN node (the surface layer that exchanges with its surroundings) and, when the
 * body is thick, a CORE node (the interior) — a two-node lumped model. Thin or highly conductive
 * bodies (steel sections: Biot = h·t/λ ≪ 0.1, the EN 1993-1-2 lumped method) have the skin only.
 * Energies are enthalpies above the reference state (J); temperatures follow from the material's
 * h(T) (temperature-dependent specific heat), or from a constant c for mixed rubble.
 *
 * Exchange of the skin (W):
 *   outdoor   convection with the air-layer column around it (or the ambient above the layer) and
 *             radiation with the ambient surroundings — through the half-skin resistance t/(2λ)
 *   rooms     natural convection with up to two building compartments (interior faces)
 *   core      conduction A_sc·λ/L_sc between skin and core
 *   ground    contacts with terrain cells (foundations, slabs on grade, rubble heaps) — `contacts`
 */
import { enthalpy, specificHeat, temperatureOf, THERMAL_MATERIALS } from './materials';
import { hBox } from './convection';
import { SIGMA } from './units';
import type { ThermalRates } from './TerrainThermal';

export const BK = { member: 0, entity: 1, heap: 2, debris: 3 } as const;

export interface BodyInit {
  kind: number;
  mSkin: number;
  mCore: number;
  matSkin: number;
  matCore: number;
  /** Constant specific heat for both nodes (mixed rubble), 0 = material tables. */
  cOverride?: number;
  Av: number;
  Atop: number;
  Abot: number;
  /** Characteristic lengths: vertical faces (height), horizontal faces (A/P), along the wind. */
  Lv: number;
  Lh: number;
  Lf: number;
  /** Thickness of the skin node (its half is the surface resistance), m. */
  tSkin: number;
  /** Skin ↔ core interface area (m²) and conduction path (m). */
  Asc: number;
  Lsc: number;
  /** Fractions of the area exchanging with the outdoors / compartment 1 / compartment 2. */
  fOut: number;
  fC1: number;
  fC2: number;
  comp1: number;
  comp2: number;
  /** Box sizes (world axes, for projected areas) and centre. */
  sx: number;
  sy: number;
  sz: number;
  x: number;
  y: number;
  z: number;
  /** Ground height under the centre. */
  yg: number;
  /** Owner reference of the adapter (entity / building index …). */
  ref: number;
  sub: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROW = <T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, n: number): T => {
  const b = new (a.constructor as { new (n: number): T })(n);
  b.set(a as never);
  return b;
};

export class ThermalBodies {
  n = 0;
  private cap = 0;
  kind = new Uint8Array(0);
  alive = new Uint8Array(0);
  mS = new Float64Array(0);
  mC = new Float64Array(0);
  matS = new Uint8Array(0);
  matC = new Uint8Array(0);
  cOv = new Float32Array(0);
  ES = new Float64Array(0);
  EC = new Float64Array(0);
  TS = new Float64Array(0);
  TC = new Float64Array(0);
  /** Highest temperature ever reached by the skin / core (irreversible material effects). */
  TmaxS = new Float64Array(0);
  TmaxC = new Float64Array(0);
  Av = new Float32Array(0);
  Atop = new Float32Array(0);
  Abot = new Float32Array(0);
  Lv = new Float32Array(0);
  Lh = new Float32Array(0);
  Lf = new Float32Array(0);
  tS = new Float32Array(0);
  Asc = new Float32Array(0);
  Lsc = new Float32Array(0);
  fOut = new Float32Array(0);
  fC1 = new Float32Array(0);
  fC2 = new Float32Array(0);
  comp1 = new Int32Array(0);
  comp2 = new Int32Array(0);
  sx = new Float32Array(0);
  sy = new Float32Array(0);
  sz = new Float32Array(0);
  x = new Float64Array(0);
  y = new Float64Array(0);
  z = new Float64Array(0);
  yg = new Float64Array(0);
  /** Air-layer column (−1: above the layer / outside → ambient). */
  air = new Int32Array(0);
  wind = new Float32Array(0);
  ref = new Int32Array(0);
  sub = new Int32Array(0);
  /** Rate accumulators (W) and stability scratch (W/K). */
  dS = new Float64Array(0);
  dC = new Float64Array(0);
  gS = new Float64Array(0);
  /** Last-step rates for the inspector (W, positive = into the body): convection, radiation, conduction (skin ↔ core / ground), sources. */
  qConv = new Float32Array(0);
  qRad = new Float32Array(0);
  qCond = new Float32Array(0);
  qGround = new Float32Array(0);
  /** Source energy received over the run (J). */
  Esrc = new Float64Array(0);
  /** Reference enthalpy per material (J/kg at Tref). */
  private readonly hRef: Float64Array;

  // Ground contacts (body skin ↔ terrain cell surface layer).
  cN = 0;
  cBody = new Int32Array(0);
  cCell = new Int32Array(0);
  cArea = new Float32Array(0);
  /** Body-side conduction path (m). */
  cPath = new Float32Array(0);

  constructor(readonly Tref: number) {
    this.hRef = Float64Array.from(THERMAL_MATERIALS, (_, i) => enthalpy(i, Tref));
  }

  private grow(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(64, this.cap * 2, n);
    for (const k of ['kind', 'alive', 'mS', 'mC', 'matS', 'matC', 'cOv', 'ES', 'EC', 'TS', 'TC', 'TmaxS', 'TmaxC', 'Av', 'Atop', 'Abot', 'Lv', 'Lh', 'Lf', 'tS', 'Asc', 'Lsc', 'fOut', 'fC1', 'fC2', 'comp1', 'comp2', 'sx', 'sy', 'sz', 'x', 'y', 'z', 'yg', 'air', 'wind', 'ref', 'sub', 'dS', 'dC', 'gS', 'qConv', 'qRad', 'qCond', 'qGround', 'Esrc'] as const) {
      (this as unknown as Record<string, Float64Array>)[k] = GROW((this as unknown as Record<string, Float64Array>)[k], cap);
    }
    this.cap = cap;
  }

  add(b: BodyInit): number {
    const i = this.n;
    this.grow(i + 1);
    this.n++;
    this.kind[i] = b.kind; this.alive[i] = 1;
    this.mS[i] = b.mSkin; this.mC[i] = b.mCore; this.matS[i] = b.matSkin; this.matC[i] = b.matCore; this.cOv[i] = b.cOverride ?? 0;
    this.ES[i] = 0; this.EC[i] = 0; this.TS[i] = this.Tref; this.TC[i] = this.Tref; this.TmaxS[i] = this.Tref; this.TmaxC[i] = this.Tref;
    this.Av[i] = b.Av; this.Atop[i] = b.Atop; this.Abot[i] = b.Abot; this.Lv[i] = b.Lv; this.Lh[i] = b.Lh; this.Lf[i] = b.Lf;
    this.tS[i] = b.tSkin; this.Asc[i] = b.Asc; this.Lsc[i] = b.Lsc;
    this.fOut[i] = b.fOut; this.fC1[i] = b.fC1; this.fC2[i] = b.fC2; this.comp1[i] = b.comp1; this.comp2[i] = b.comp2;
    this.sx[i] = b.sx; this.sy[i] = b.sy; this.sz[i] = b.sz; this.x[i] = b.x; this.y[i] = b.y; this.z[i] = b.z; this.yg[i] = b.yg;
    this.air[i] = -1; this.wind[i] = 0; this.ref[i] = b.ref; this.sub[i] = b.sub;
    this.Esrc[i] = 0;
    return i;
  }

  addContact(body: number, cell: number, area: number, path: number) {
    const k = this.cN++;
    if (k >= this.cBody.length) {
      const cap = Math.max(64, this.cBody.length * 2);
      this.cBody = GROW(this.cBody, cap);
      this.cCell = GROW(this.cCell, cap);
      this.cArea = GROW(this.cArea, cap);
      this.cPath = GROW(this.cPath, cap);
    }
    this.cBody[k] = body; this.cCell[k] = cell; this.cArea[k] = area; this.cPath[k] = path;
  }

  /** Remove the ground contacts of a body (it fell / moved). */
  dropContacts(body: number) {
    let w = 0;
    for (let k = 0; k < this.cN; k++) {
      if (this.cBody[k] === body) continue;
      this.cBody[w] = this.cBody[k]; this.cCell[w] = this.cCell[k]; this.cArea[w] = this.cArea[k]; this.cPath[w] = this.cPath[k];
      w++;
    }
    this.cN = w;
  }

  // ── Energy ↔ temperature ───────────────────────────────

  /** Temperature of a node from its energy (skin: core = false). */
  tempOf(i: number, core: boolean): number {
    const m = core ? this.mC[i] : this.mS[i];
    const E = core ? this.EC[i] : this.ES[i];
    if (m <= 0) return this.Tref;
    const c = this.cOv[i];
    if (c > 0) return this.Tref + E / (m * c);
    const mat = core ? this.matC[i] : this.matS[i];
    return temperatureOf(mat, E / m + this.hRef[mat]);
  }

  /** Energy of a node at temperature T (J above the reference). */
  energyAt(i: number, core: boolean, T: number): number {
    const m = core ? this.mC[i] : this.mS[i];
    if (m <= 0) return 0;
    const c = this.cOv[i];
    if (c > 0) return m * c * (T - this.Tref);
    const mat = core ? this.matC[i] : this.matS[i];
    return m * (enthalpy(mat, T) - this.hRef[mat]);
  }

  /** Apparent heat capacity of a node at its temperature (J/K). */
  capacity(i: number, core: boolean): number {
    const m = core ? this.mC[i] : this.mS[i];
    if (m <= 0) return 0;
    const c = this.cOv[i];
    if (c > 0) return m * c;
    return m * specificHeat(core ? this.matC[i] : this.matS[i], core ? this.TC[i] : this.TS[i]);
  }

  /** Total energy of a body (J). */
  energy(i: number): number {
    return this.ES[i] + this.EC[i];
  }

  /** Mass-weighted mean temperature (K). */
  meanT(i: number): number {
    const mS = this.mS[i], mC = this.mC[i];
    return mC > 0 ? (mS * this.TS[i] + mC * this.TC[i]) / (mS + mC) : this.TS[i];
  }

  refresh(i: number) {
    this.TS[i] = this.tempOf(i, false);
    this.TC[i] = this.mC[i] > 0 ? this.tempOf(i, true) : this.TS[i];
    if (this.TS[i] > this.TmaxS[i]) this.TmaxS[i] = this.TS[i];
    if (this.TC[i] > this.TmaxC[i]) this.TmaxC[i] = this.TC[i];
  }

  // ── Fluxes ─────────────────────────────────────────────

  /**
   * Skin exchange with the outdoors and rooms, and skin ↔ core conduction, into the rate
   * accumulators. `airT` / `toAir` give the air-layer column; `compT` / `toComp` the rooms.
   */
  fluxes(env: BodyEnv): number {
    const Tref = this.Tref;
    const acc = env.acc;
    let maxRate = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const Ts = this.TS[i];
      const A = this.Av[i] + this.Atop[i] + this.Abot[i];
      const matS = this.matS[i];
      const ks = THERMAL_MATERIALS[matS].k(Ts - 273.15);
      const R = Math.max(1e-6, this.tS[i] / (2 * ks));
      let gS = 0, conv = 0, rad = 0;
      const fo = this.fOut[i];
      if (fo > 0 && A > 0) {
        const a = this.air[i];
        const Ta = env.airT(a);
        const hc = hBox(Ts, Ta, this.wind[i], this.Av[i], this.Atop[i], this.Abot[i], this.Lv[i], this.Lh[i], this.Lf[i]);
        const eps = THERMAL_MATERIALS[matS].emissivity;
        const hr = env.closed ? 0 : eps * SIGMA * (Ts * Ts + Tref * Tref) * (Ts + Tref);
        // Surface temperature of the linearized balance through the half-skin resistance.
        const Tsf = (Ts / R + hc * Ta + hr * Tref) / (1 / R + hc + hr);
        const qc = hc * A * fo * (Tsf - Ta);
        const qr = hr * A * fo * (Tsf - Tref);
        this.dS[i] -= qc + qr;
        if (a >= 0) env.toAir(a, qc, (4 / 3) * hc * A * fo); else acc.aboveLayer += qc;
        acc.convection += Math.abs(qc);
        acc.radiationSky += qr;
        conv -= qc; rad -= qr;
        const hTan = (4 / 3) * hc + (env.closed ? 0 : 4 * eps * SIGMA * Ts * Ts * Ts);
        gS += hTan > 0 ? (A * fo) / (R + 1 / hTan) : 0;
      }
      for (let k = 0; k < 2; k++) {
        const f = k === 0 ? this.fC1[i] : this.fC2[i];
        const cmp = k === 0 ? this.comp1[i] : this.comp2[i];
        if (f <= 0 || cmp < 0 || A <= 0) continue;
        const Tc = env.compT(cmp);
        const hc = hBox(Ts, Tc, 0, this.Av[i], this.Atop[i], this.Abot[i], this.Lv[i], this.Lh[i], this.Lf[i]);
        if (hc <= 0) continue;
        const G = (A * f) / (R + 1 / hc);
        const q = G * (Ts - Tc);
        this.dS[i] -= q;
        env.toComp(cmp, q, (4 / 3) * G);
        acc.convection += Math.abs(q);
        conv -= q;
        gS += (4 / 3) * G;
      }
      let cond = 0;
      if (this.mC[i] > 0) {
        const Tc = this.TC[i];
        const kc = THERMAL_MATERIALS[this.matC[i]].k(Tc - 273.15);
        const G = this.Asc[i] / Math.max(1e-4, this.Lsc[i] / (0.5 * (ks + kc)));
        const q = G * (Ts - Tc);
        this.dS[i] -= q;
        this.dC[i] += q;
        acc.conduction += Math.abs(q);
        cond = q;
        gS += G;
        const rc = G / Math.max(1e-9, this.capacity(i, true));
        if (rc > maxRate) maxRate = rc;
      }
      this.qConv[i] = conv;
      this.qRad[i] = rad;
      this.qCond[i] = -cond;
      this.gS[i] += gS;
    }
    return maxRate;
  }

  /** Ground contacts: skin ↔ terrain surface layer. */
  contactFluxes(ground: { E: Float64Array; C: Float64Array; k: Float64Array; nl: number; layers: readonly number[]; Tref: number; dE: Float64Array; activateCell(c: number): void }, acc: ThermalRates) {
    for (let i = 0; i < this.n; i++) this.qGround[i] = 0;
    for (let k = 0; k < this.cN; k++) {
      const b = this.cBody[k];
      if (!this.alive[b]) continue;
      const c = this.cCell[k];
      const j = c * ground.nl;
      const Tg = ground.Tref + ground.E[j] / ground.C[j];
      const kb = THERMAL_MATERIALS[this.matS[b]].k(this.TS[b] - 273.15);
      const G = this.cArea[k] / (this.cPath[k] / kb + ground.layers[0] / (2 * ground.k[j]));
      const q = G * (this.TS[b] - Tg);
      if (q !== 0) ground.activateCell(c);
      this.dS[b] -= q;
      ground.dE[j] += q;
      acc.conduction += Math.abs(q);
      this.qGround[b] -= q;
      this.gS[b] += G;
    }
  }

  /** Largest ΣG/C of the skins (clears the scratch). */
  stability(): number {
    let maxRate = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) { this.gS[i] = 0; continue; }
      const r = this.gS[i] / Math.max(1e-9, this.capacity(i, false));
      if (r > maxRate) maxRate = r;
      this.gS[i] = 0;
    }
    return maxRate;
  }

  apply(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (this.dS[i] !== 0 || this.dC[i] !== 0) {
        this.ES[i] += this.dS[i] * dt;
        this.EC[i] += this.dC[i] * dt;
        this.dS[i] = 0;
        this.dC[i] = 0;
        this.refresh(i);
      }
    }
  }

  /** Total energy of the live bodies (J). */
  total(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) if (this.alive[i]) s += this.ES[i] + this.EC[i];
    return s;
  }
}

export interface BodyEnv {
  closed: boolean;
  acc: ThermalRates;
  airT(a: number): number;
  toAir(a: number, W: number, G: number): void;
  compT(c: number): number;
  toComp(c: number, W: number, G: number): void;
}
