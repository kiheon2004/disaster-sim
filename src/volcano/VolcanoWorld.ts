/**
 * VolcanoWorld (Phase 28): the volcano state of a run — eruptions and their vents, the lava field,
 * bombs in flight, ash puffs, and the mass / energy ledgers. Pure (no Rapier, no React, no Phase 26
 * objects): the adapter (simulation/volcano) hands in the surroundings and catchers (roofs, objects) and
 * turns the heat that leaves the lava into Phase 26 source steps.
 *
 * One step (every 0.1 s, inside the ThermalSystem):
 *  1. supply — each eruption's bulk volume over [a, b) of its local time (exact profile integral) is split
 *     into lava (to the vent vertices), bombs and ash (accumulated per vent until their launch / release);
 *  2. flow — LavaField.flow;
 *  3. bombs that land in this step: caught by an object, deposited in the field, or out of the world;
 *  4. ash puffs: advection, settling, rain removal, landing (roofs first, then the ground), outflow;
 *  5. cooling, lock-up, deposits (LavaField.cool).
 * Ash heat stays in the plume (booked `plumeHeat`, released above the resolved air layer); magmatic gas
 * is a ledger quantity only (no transport, concentration, chemistry or toxicity — Phase 29 interface).
 */
import { gravityDown } from '@/thermal/gravityScope';
import { LavaField, type LavaSurroundings } from './LavaField';
import { specificEnergy, latentHeld, type LavaMaterial } from './materials';
import { suppliedVolume, eruptionPhase, eruptionShape, type EruptionPhase } from './eruption';
import { GAS_FRACTION, DEFAULT_PLUME_HEIGHT, type VolcanoSpec, type VentSpec } from './types';
import { launch, LAUNCH_PERIOD, type Bomb } from './bombs';
import { ASH_CLASSES, settlingAt, RELEASE_PERIOD, EDDY_K, CEILING, footprint, scavenging, windAt, type Puff } from './ash';
import type { WorldBox } from '@/impact/ejecta';
import { GRAVITY } from '@/core/units';

export interface VentRuntime {
  spec: VentSpec;
  /** Vertices it supplies and their weights (sum 1). */
  verts: number[];
  w: number[];
  share: number;
  /** World position of its centre (ground height at creation) — launches and releases start here. */
  P: [number, number, number];
  bombMass: number;
  bombEnergy: number;
  ashMass: number;
}

export interface Eruption {
  id: string;
  name: string;
  spec: VolcanoSpec;
  /** Absolute start time (s). */
  start: number;
  vents: VentRuntime[];
  /** Local time integrated up to. */
  upto: number;
  launches: number;
  releases: number;
  T: number;
  /** Totals of this eruption (kg). */
  lava: number;
  bombs: number;
  ash: number;
  phase: EruptionPhase;
}

export interface VolcanoEnv {
  surroundings: LavaSurroundings;
  /** Gravity vector at the vents (Phase 31; absent without a gravity experiment — bombs fly under Earth's vertical g). */
  gravity?: readonly [number, number, number];
  /** 10 m wind speed (m/s) and its flow direction (unit). */
  u10: number;
  flowX: number;
  flowZ: number;
  /** Rain intensity at a point (mm/h). */
  rain(x: number, z: number): number;
  /** Ground height of the runtime terrain (m). */
  ground(x: number, z: number): number;
  /**
   * Phase 29 (atmosphere experiments only): the local air for ash and bombs — computed flow added to the
   * wind profile, settling in the local density / viscosity with slip, bombs' drag in the local density.
   */
  atmos?: {
    velocity(x: number, z: number, h: number, out: [number, number]): [number, number];
    /** Terminal velocity of an ash size class at a point (m/s), age-limited by free fall. */
    settling(cls: number, x: number, z: number, h: number): number;
    density(x: number, z: number, h: number): number;
  };
}

/** Things that can intercept falling material before it reaches the ground (adapter: roofs, objects). */
export interface Catchers {
  /** Ash mass arriving at a vertex: returns the part caught (roof) — the rest lands on the ground. */
  ash?(i: number, mass: number): number;
  /** A landing bomb: true when an object took it (its mass / heat / impact are the adapter's). */
  bomb?(b: Bomb): boolean;
}

export interface VolcanoLedger {
  mass: {
    supplied: number; lavaSupplied: number; bombsLaunched: number; ashReleased: number;
    mobile: number; solidified: number; bombsInFlight: number; bombsDeposited: number; bombsCaught: number;
    ashAirborne: number; ashDeposited: number; ashCaught: number;
    outLava: number; outBombs: number; outAsh: number; gas: number; residual: number;
  };
  energy: {
    supplied: number; internal: number; inFlight: number; toGround: number; toObjects: number; toWater: number; toAir: number;
    radiated: number; outflow: number; plumeHeat: number; latentReleased: number; potentialReleased: number; residual: number;
  };
}

export class VolcanoWorld {
  readonly field: LavaField;
  readonly eruptions: Eruption[] = [];
  readonly bombs: Bomb[] = [];
  readonly puffs: Puff[] = [];
  readonly box: WorldBox;
  /** Mass / energy totals not held by the field. */
  private tot = { bombsLaunched: 0, bombEnergyLaunched: 0, ashReleased: 0, plumeHeat: 0, bombsCaught: 0, bombCaughtEnergy: 0, ashCaught: 0, outBombs: 0, outBombEnergy: 0, outAsh: 0, gas: 0, latentSupplied: 0, potentialSupplied: 0 };
  catchers: Catchers = {};
  private nextBomb = 1;
  private readonly uv: [number, number] = [0, 0];
  time = 0;
  /** Cost of the last step (ms) by part. */
  readonly cost = { flow: 0, cool: 0, ash: 0, bombs: 0 };

  constructor(nx: number, nz: number, dx: number, originX: number, originZ: number, heights: Float32Array, readonly mat: LavaMaterial, readonly Tref: number) {
    this.field = new LavaField(nx, nz, dx, originX, originZ, heights, mat, Tref);
    this.box = { x0: originX, z0: originZ, x1: originX + (nx - 1) * dx, z1: originZ + (nz - 1) * dx };
  }

  /** Vertices of a vent (≥ 1, the nearest when its footprint holds none). */
  ventVertices(v: VentSpec): { verts: number[]; w: number[] } {
    const f = this.field;
    const verts: number[] = [];
    const [ax, az] = v.position;
    const [bx, bz] = v.kind === 'fissure' && v.end ? v.end : v.position;
    const r = v.radius;
    const x0 = Math.min(ax, bx) - r, x1 = Math.max(ax, bx) + r, z0 = Math.min(az, bz) - r, z1 = Math.max(az, bz) + r;
    const ix0 = Math.max(0, Math.ceil((x0 - f.originX) / f.dx)), ix1 = Math.min(f.nx - 1, Math.floor((x1 - f.originX) / f.dx));
    const iz0 = Math.max(0, Math.ceil((z0 - f.originZ) / f.dx)), iz1 = Math.min(f.nz - 1, Math.floor((z1 - f.originZ) / f.dx));
    const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const x = f.originX + ix * f.dx, z = f.originZ + iz * f.dx;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2)) : 0;
      const d = Math.hypot(x - (ax + t * (bx - ax)), z - (az + t * (bz - az)));
      if (d <= r + 1e-9) verts.push(iz * f.nx + ix);
    }
    if (!verts.length) { const i = f.index((ax + bx) / 2, (az + bz) / 2); if (i >= 0) verts.push(i); }
    return { verts, w: verts.map(() => 1 / Math.max(1, verts.length)) };
  }

  add(id: string, name: string, spec: VolcanoSpec, start: number, ground: (x: number, z: number) => number): Eruption {
    const shares = spec.vents.map((v) => v.share ?? 1);
    const S = shares.reduce((a, b) => a + b, 0) || 1;
    const vents = spec.vents.map((v, k): VentRuntime => {
      const { verts, w } = this.ventVertices(v);
      const [cx, cz] = v.kind === 'fissure' && v.end ? [(v.position[0] + v.end[0]) / 2, (v.position[1] + v.end[1]) / 2] : v.position;
      return { spec: v, verts, w, share: shares[k] / S, P: [cx, ground(cx, cz), cz], bombMass: 0, bombEnergy: 0, ashMass: 0 };
    });
    const e: Eruption = { id, name, spec, start, vents, upto: 0, launches: 0, releases: 0, T: spec.temperature + 273.15, lava: 0, bombs: 0, ash: 0, phase: 'dormant' };
    this.eruptions.push(e);
    return e;
  }

  get active(): boolean {
    return this.eruptions.length > 0;
  }

  /** Supply rate now of all eruptions (m³/s bulk). */
  supplyRate(t: number): number {
    let s = 0;
    for (const e of this.eruptions) s += e.spec.rate * eruptionShape(e.spec, t - e.start);
    return s;
  }

  step(t: number, dt: number, env: VolcanoEnv) {
    const f = this.field, rho = f.rho;
    // 1. Supply.
    for (const e of this.eruptions) {
      const a = e.upto, b = t + dt - e.start;
      e.phase = eruptionPhase(e.spec, b - dt / 2);
      if (b <= a) continue;
      e.upto = b;
      const V = suppliedVolume(e.spec, a, b);
      const fb = e.spec.bombFraction ?? 0, fa = e.spec.ashFraction ?? 0;
      const se = specificEnergy(this.mat, e.T, this.Tref);
      if (V > 0) {
        const M = rho * V;
        this.tot.gas += GAS_FRACTION * M;
        this.tot.latentSupplied += M * (1 - fa) * latentHeld(this.mat, e.T);
        for (const v of e.vents) {
          const mv = M * v.share;
          const ml = mv * (1 - fb - fa);
          for (let k = 0; k < v.verts.length; k++) {
            f.supply(v.verts[k], ml * v.w[k], e.T);
            this.tot.potentialSupplied += ml * v.w[k] * GRAVITY * gravityDown() * f.bed(v.verts[k]);
          }
          e.lava += ml;
          v.bombMass += mv * fb; v.bombEnergy += mv * fb * se;
          this.tot.potentialSupplied += mv * fb * GRAVITY * gravityDown() * v.P[1];
          v.ashMass += mv * fa;
        }
      }
      // Bomb launches and ash releases at their fixed periods (the step length does not matter).
      while ((e.launches + 1) * LAUNCH_PERIOD <= b + 1e-9 || (b >= e.spec.duration && e.vents.some((v) => v.bombMass > 0))) {
        e.launches++;
        const tl = e.start + Math.min(e.launches * LAUNCH_PERIOD, Math.max(b, 0));
        e.vents.forEach((v, k) => {
          if (v.bombMass <= 0) return;
          const list = launch(k + 97 * this.eruptions.indexOf(e), e.launches, v.bombMass, v.bombEnergy, v.P, tl, env.ground, this.box, () => this.nextBomb++, env.atmos?.density(v.P[0], v.P[2], 10), env.gravity);
          for (const bmb of list) this.bombs.push(bmb);
          this.tot.bombsLaunched += v.bombMass;
          this.tot.bombEnergyLaunched += v.bombEnergy;
          e.bombs += v.bombMass;
          v.bombMass = 0; v.bombEnergy = 0;
        });
        if (b >= e.spec.duration) break;
      }
      while ((e.releases + 1) * RELEASE_PERIOD <= b + 1e-9 || (b >= e.spec.duration && e.vents.some((v) => v.ashMass > 0))) {
        e.releases++;
        const H = e.spec.plumeHeight ?? DEFAULT_PLUME_HEIGHT;
        for (const [k, v] of e.vents.entries()) {
          if (v.ashMass <= 0) continue;
          this.tot.ashReleased += v.ashMass;
          this.tot.plumeHeat += v.ashMass * se;
          e.ash += v.ashMass;
          ASH_CLASSES.forEach((c, cls) => this.puffs.push({ vent: k, cls, x: v.P[0], y: v.P[1] + H, z: v.P[2], mass: v.ashMass * c.share, sigma: 0.15 * H, born: t }));
          v.ashMass = 0;
        }
        if (b >= e.spec.duration) break;
      }
    }
    // 2. Flow.
    let c0 = performance.now();
    f.flow(dt);
    this.cost.flow = performance.now() - c0;
    // 3. Bombs landing in this step.
    c0 = performance.now();
    for (const b of this.bombs) {
      if (b.landed || b.parcel.t1 > t + dt) continue;
      b.landed = true;
      const p = b.parcel;
      if (p.outflow) { this.tot.outBombs += p.mass; this.tot.outBombEnergy += b.energy; continue; }
      if (this.catchers.bomb?.(b)) { this.tot.bombsCaught += p.mass; this.tot.bombCaughtEnergy += b.energy; continue; }
      const i = f.index(p.p1[0], p.p1[2]);
      if (i < 0) { this.tot.outBombs += p.mass; this.tot.outBombEnergy += b.energy; continue; }
      f.addBomb(i, p.mass, b.energy);
    }
    // Landed bombs leave the list once they are a few seconds old (renderers fade them).
    if (this.bombs.length > 256) {
      let w = 0;
      for (const b of this.bombs) if (!b.landed || b.parcel.t1 > t - 5) this.bombs[w++] = b;
      this.bombs.length = w;
    }
    this.cost.bombs = performance.now() - c0;
    // 4. Ash.
    c0 = performance.now();
    this.stepAsh(t, dt, env);
    this.cost.ash = performance.now() - c0;
    // 5. Cooling.
    c0 = performance.now();
    f.cool(dt, env.surroundings);
    this.cost.cool = performance.now() - c0;
    this.time = t + dt;
  }

  private stepAsh(t: number, dt: number, env: VolcanoEnv) {
    const f = this.field;
    let w = 0;
    const at = env.atmos;
    for (const p of this.puffs) {
      const yg = env.ground(p.x, p.z);
      const U = windAt(env.u10, p.y - yg);
      p.x += U * env.flowX * dt;
      p.z += U * env.flowZ * dt;
      if (at) {
        const h = p.y - yg;
        at.velocity(p.x, p.z, h, this.uv);
        p.x += this.uv[0] * dt;
        p.z += this.uv[1] * dt;
        // Free fall bounds the fall speed shortly after release (thin air: terminal speed is large).
        p.y -= Math.min(at.settling(p.cls, p.x, p.z, h), GRAVITY * gravityDown() * Math.max(dt, t - p.born)) * dt;
      } else p.y -= settlingAt(p.cls, gravityDown()) * dt;
      p.sigma = Math.sqrt(p.sigma * p.sigma + 2 * EDDY_K * dt);
      const outside = p.x < this.box.x0 || p.x > this.box.x1 || p.z < this.box.z0 || p.z > this.box.z1 || p.y > CEILING;
      if (outside) { this.tot.outAsh += p.mass; continue; }
      // Rain: a share washed out onto the ground under the puff.
      const lam = scavenging(env.rain(p.x, p.z));
      if (lam > 0) {
        const m = p.mass * (1 - Math.exp(-lam * dt));
        this.landAsh(p.x, p.z, p.sigma, m);
        p.mass -= m;
      }
      if (p.y <= env.ground(p.x, p.z)) { this.landAsh(p.x, p.z, p.sigma, p.mass); continue; }
      this.puffs[w++] = p;
    }
    this.puffs.length = w;
    void f; void t;
  }

  private landAsh(x: number, z: number, sigma: number, mass: number) {
    if (!(mass > 0)) return;
    const f = this.field;
    const fp = footprint(f, x, z, sigma);
    this.tot.outAsh += mass * fp.outside;
    for (let k = 0; k < fp.cells.length; k++) {
      const m = mass * fp.w[k];
      const caught = this.catchers.ash ? Math.min(m, Math.max(0, this.catchers.ash(fp.cells[k], m))) : 0;
      this.tot.ashCaught += caught;
      f.addAsh(fp.cells[k], m - caught);
    }
  }

  airborneAsh(): number {
    let s = 0;
    for (const p of this.puffs) s += p.mass;
    return s;
  }

  /** Bombs launched and not landed yet, plus the bomb share erupted since the last launch (still at the vents). */
  bombsInFlight(): { mass: number; energy: number; pendingMass: number; pendingEnergy: number } {
    let m = 0, e = 0, pm = 0, pe = 0;
    for (const b of this.bombs) if (!b.landed) { m += b.parcel.mass; e += b.energy; }
    for (const er of this.eruptions) for (const v of er.vents) { pm += v.bombMass; pe += v.bombEnergy; }
    return { mass: m + pm, energy: e + pe, pendingMass: pm, pendingEnergy: pe };
  }

  /** Ash erupted but not yet released (between releases). */
  private pendingAsh(): number {
    let s = 0;
    for (const er of this.eruptions) for (const v of er.vents) s += v.ashMass;
    return s;
  }

  ledger(): VolcanoLedger {
    const f = this.field, L = f.ledger, T = this.tot;
    const fl = this.bombsInFlight();
    const mobile = f.mobileMass(), solid = f.depositMass(), bombsDep = f.bombDeposit(), ashDep = f.ashDeposit();
    const ashAir = this.airborneAsh() + this.pendingAsh();
    const supplied = L.suppliedMass + T.bombsLaunched + fl.pendingMass + T.ashReleased + this.pendingAsh();
    const massHeld = mobile + solid + fl.mass + bombsDep + T.bombsCaught + ashAir + ashDep + T.ashCaught + L.outMass + T.outBombs + T.outAsh;
    const eSup = L.suppliedEnergy + T.bombEnergyLaunched + fl.pendingEnergy + T.plumeHeat;
    const internal = f.mobileEnergy() + f.depositEnergy();
    const eOut = internal + fl.energy + L.toGround + L.toObjects + T.bombCaughtEnergy + L.toWater + L.toAir + L.radiated + L.outEnergy + T.outBombEnergy + T.plumeHeat;
    // Latent heat released so far: what came in as melt minus what the lava still holds.
    let latentHeldNow = 0;
    for (const i of f.mobile) latentHeldNow += f.M[i] * latentHeld(this.mat, f.T[i]);
    for (const i of f.hot) latentHeldNow += (f.depM[i] + f.depB[i]) * latentHeld(this.mat, f.depT[i]);
    let pe = 0;
    for (const i of f.mobile) pe += f.M[i] * GRAVITY * gravityDown() * (f.bed(i) + 0.5 * f.depth(i));
    return {
      mass: {
        supplied, lavaSupplied: L.suppliedMass, bombsLaunched: T.bombsLaunched + fl.pendingMass, ashReleased: T.ashReleased + this.pendingAsh(),
        mobile, solidified: solid, bombsInFlight: fl.mass, bombsDeposited: bombsDep, bombsCaught: T.bombsCaught,
        ashAirborne: ashAir, ashDeposited: ashDep, ashCaught: T.ashCaught, outLava: L.outMass, outBombs: T.outBombs, outAsh: T.outAsh, gas: T.gas,
        residual: supplied - massHeld,
      },
      energy: {
        supplied: eSup, internal, inFlight: fl.energy, toGround: L.toGround, toObjects: L.toObjects + T.bombCaughtEnergy, toWater: L.toWater, toAir: L.toAir,
        radiated: L.radiated, outflow: L.outEnergy + T.outBombEnergy, plumeHeat: T.plumeHeat,
        latentReleased: Math.max(0, T.latentSupplied - latentHeldNow - (fl.mass + T.bombsCaught + T.outBombs) * this.latentErupted() - L.outMass * this.latentErupted()),
        potentialReleased: pe > 0 || mobile > 0 ? Math.max(0, T.potentialSupplied - pe) : 0,
        residual: eSup - eOut,
      },
    };
  }

  /** Latent heat per kg still held at the eruption temperature (informational terms only). */
  private latentErupted(): number {
    const e = this.eruptions[0];
    return e ? latentHeld(this.mat, e.T) : 0;
  }

  /** Phase 29 interface: what the volcano releases into the atmosphere now (rates, kg/s and W). */
  atmosphericSources(t: number): { kind: 'ash' | 'gas' | 'heat'; x: number; y: number; z: number; rate: number }[] {
    const out: { kind: 'ash' | 'gas' | 'heat'; x: number; y: number; z: number; rate: number }[] = [];
    for (const e of this.eruptions) {
      const q = e.spec.rate * eruptionShape(e.spec, t - e.start) * this.field.rho;
      if (q <= 0) continue;
      const H = e.spec.plumeHeight ?? DEFAULT_PLUME_HEIGHT;
      const se = specificEnergy(this.mat, e.T, this.Tref);
      for (const v of e.vents) {
        const m = q * v.share;
        out.push({ kind: 'gas', x: v.P[0], y: v.P[1], z: v.P[2], rate: m * GAS_FRACTION });
        if (e.spec.ashFraction) {
          out.push({ kind: 'ash', x: v.P[0], y: v.P[1] + H, z: v.P[2], rate: m * e.spec.ashFraction });
          out.push({ kind: 'heat', x: v.P[0], y: v.P[1] + H, z: v.P[2], rate: m * e.spec.ashFraction * se });
        }
      }
    }
    return out;
  }
}
