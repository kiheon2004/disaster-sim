/**
 * Sinkhole model (Phase 22): loss of underground support and surface collapse.
 *
 * The heightfield cannot hold a cavity, so the cavity is a HIDDEN STATE — a cylinder of radius a
 * and height h_c under a soil cover of thickness H — and the cause of the surface change:
 *
 *  1. Roof stability: plug factor of safety (stability.ts §3) from the cover's strength, its
 *     water table m (effective stress, loss of apparent cohesion), and the surcharge on the plug
 *     (structures' foundation pressure, standing water, deposits, an optional prescribed load).
 *     Inputs that drive it toward failure (one per initiation mode, all physical quantities):
 *       growth      cavity radius a(t) = a₀ + rate·t (dissolution / erosion of the cavity is NOT
 *                   computed — the rate is an input)
 *       supportLoss prescribed loss L(t) of the roof resistance (labelled prescribed)
 *       water       water table rising to m (rain infiltration also raises it, if it rains)
 *       load        extra surcharge q(t) on the ground above (e.g. a structure, fill)
 *  2. Initiation when FS < 1: the plug (radius a) drops by d = h_c − (B − 1)·H — the cavity minus
 *     the space the bulked plug occupies (bulking factor B). d ≤ 0: the void chokes before
 *     reaching the surface (no surface collapse, reported). The drop follows free fall
 *     d(t) = d·min(1, (t / t_f)²), t_f = √(2h_c/g) — kinematics, not a choice of animation speed.
 *  3. Progressive edge failure: the pit walls are checked with Culmann's cut-height criterion
 *     (stability.ts §4) every update; material beyond the stable inclination for the wall height
 *     falls in and runs out with the granular solver. Cohesive covers stand steep (dropout pit),
 *     cohesionless covers relax to the angle of repose (bowl) — the geometry is a RESULT of the
 *     material, not a chosen shape. Seeded strength variability makes it irregular.
 *
 * Mass: the plug goes into the cavity (budget.intoCavity), wall material becomes mobile and is
 * deposited in the pit (released / deposited). Not modelled: cavity dissolution chemistry,
 * groundwater flow into the cavity, roof bending / arching beyond the plug, 3-D cavity shapes.
 */
import type { GeoField } from './GeoField';
import type { GroundEnv } from './common';
import { applyVariability, wallFailure } from './common';
import { DEG, gNow, gammaW, MECHANICAL_IDS, MECHANICAL_PROFILES, unitWeight, type MechanicalProfile } from './materials';
import { fallTime, plugFS } from './stability';
import type { SinkholeSpec } from './types';

export type SinkholePhase = 'stable' | 'collapsing' | 'collapsed' | 'choked';

export interface SinkholeEvent {
  kind: 'initiation' | 'choked' | 'collapsed' | 'expansion';
  time: number;
  value: number;
}

export class SinkholeModel {
  phase: SinkholePhase = 'stable';
  readonly profile: MechanicalProfile;
  /** Current cavity radius, roof FS, surcharge (kPa), water table, resistance loss. */
  a: number;
  fs = Infinity;
  q = 0;
  m = 0;
  loss = 0;
  /** Plug drop (m): target and applied; time of initiation. */
  drop = 0;
  private applied = 0;
  tInit = NaN;
  /** Radius of the surface pit (m) — cells lowered more than 0.1 m. */
  pitRadius = 0;
  private reportedRadius = 0;
  /** Vertices of the plug (inside a at initiation) and of the evaluated neighbourhood. */
  private plug: number[] = [];
  readonly cells: number[] = [];
  readonly events: SinkholeEvent[] = [];
  readonly index: number;

  constructor(readonly id: string, readonly name: string, readonly spec: SinkholeSpec, readonly startTime: number, private readonly f: GeoField, index: number, seed: number) {
    this.index = index;
    const ci = f.index(spec.center[0], spec.center[1]);
    this.profile = spec.material ? MECHANICAL_PROFILES[spec.material] : f.profile(Math.max(0, ci));
    this.a = spec.cavityRadius;
    // Neighbourhood: the largest plug + a wall-retreat margin of 2·H (walls flatten to ≥ φ).
    const R = this.maxRadius() + 2 * spec.cover + 2;
    const [cx, cz] = spec.center;
    const mat = MECHANICAL_IDS.indexOf(this.profile.id);
    for (let iz = 0; iz < f.nz; iz++) {
      const z = f.originZ + iz * f.dx;
      if (Math.abs(z - cz) > R) continue;
      for (let ix = 0; ix < f.nx; ix++) {
        const x = f.originX + ix * f.dx;
        if (Math.hypot(x - cx, z - cz) > R) continue;
        const i = iz * f.nx + ix;
        this.cells.push(i);
        f.material[i] = mat;
        // The cover is the soil available above rock (the cavity lies in the rock below).
        if (f.thickness[i] < spec.cover) f.thickness[i] = spec.cover;
        f.owner[i] = index;
        f.evaluate[i] = 1;
      }
    }
    applyVariability(f, this.cells, spec.variability ?? 0, spec.seed ?? seed);
  }

  /** Largest cavity radius the inputs can reach. */
  maxRadius(): number {
    const s = this.spec;
    return s.initiation === 'growth' ? s.cavityRadius + (s.growthRate ?? 0) * s.duration : s.cavityRadius;
  }

  private ramp(tau: number) {
    const D = this.spec.duration;
    return D <= 0 ? 1 : Math.min(1, Math.max(0, tau / D));
  }

  /** Mean of a per-vertex quantity over the vertices within radius r of the centre. */
  private mean(r: number, fn: (i: number) => number): number {
    const f = this.f, [cx, cz] = this.spec.center;
    let s = 0, n = 0;
    for (const i of this.cells) {
      const ix = i % f.nx, iz = (i - ix) / f.nx;
      if (Math.hypot(f.originX + ix * f.dx - cx, f.originZ + iz * f.dx - cz) <= r) { s += fn(i); n++; }
    }
    return n ? s / n : fn(Math.max(0, f.index(cx, cz)));
  }

  /** Roof state at local time tau (no side effects): FS, a, m, q, L. */
  evaluate(tau: number, env: GroundEnv) {
    const s = this.spec, p = this.profile, f = this.f;
    const k = this.ramp(tau);
    const a = s.initiation === 'growth' ? s.cavityRadius + (s.growthRate ?? 0) * Math.min(Math.max(0, tau), s.duration) : s.cavityRadius;
    // Water table in the cover: prescribed ramp (water mode) or infiltration, whichever is higher.
    const infil = this.mean(a, (i) => env.infiltrated(i));
    const fromRain = infil > 0 ? infil / (p.porosity * p.drainable) / s.cover : 0;
    const m = Math.min(1, Math.max(s.initiation === 'water' ? (s.saturation ?? 1) * k : 0, f.water0[Math.max(0, f.index(s.center[0], s.center[1]))] + fromRain));
    const q = this.mean(a, (i) => env.surcharge(i)) + (s.initiation === 'load' ? (s.surcharge ?? 0) * k : 0);
    const strength = this.mean(a, (i) => f.strength[i]);
    const c = p.cohesion * strength + p.apparentCohesion * (1 - m);
    const loss = s.initiation === 'supportLoss' ? (s.supportLoss ?? 0) * k : 0;
    const fs = plugFS({ a, H: s.cover, c, phi: p.friction * DEG, gamma: unitWeight(p), m, q }) * (1 - loss);
    return { a, m, q, loss, fs };
  }

  /** Advance to local time tau (called at the deformation update rate). */
  update(tau: number, time: number, env: GroundEnv) {
    if (tau < 0) return;
    const f = this.f, s = this.spec;
    if (this.phase === 'stable') {
      const e = this.evaluate(tau, env);
      this.a = e.a; this.m = e.m; this.q = e.q; this.loss = e.loss; this.fs = e.fs;
      if (e.fs < 1) {
        this.tInit = time;
        this.drop = s.cavityHeight - (this.profile.bulking - 1) * s.cover;
        this.events.push({ kind: 'initiation', time, value: e.fs });
        if (this.drop <= 0) {
          this.phase = 'choked';
          this.events.push({ kind: 'choked', time, value: this.drop });
          return;
        }
        this.drop = Math.min(this.drop, s.cavityHeight);
        this.phase = 'collapsing';
        const [cx, cz] = s.center;
        this.plug = this.cells.filter((i) => {
          const ix = i % f.nx, iz = (i - ix) / f.nx;
          return Math.hypot(f.originX + ix * f.dx - cx, f.originZ + iz * f.dx - cz) <= this.a;
        });
        if (!this.plug.length) {
          const ci = f.index(cx, cz);
          if (ci >= 0) this.plug.push(ci);
        }
      }
      return;
    }
    if (this.phase === 'collapsing') {
      const tf = fallTime(this.drop);
      const k = tf > 0 ? Math.min(1, ((time - this.tInit) / tf) ** 2) : 1;
      const target = this.drop * k;
      const inc = target - this.applied;
      if (inc > 0) {
        for (const i of this.plug) f.dropIntoCavity(i, inc);
        this.applied = target;
      }
      if (k >= 1) {
        this.phase = 'collapsed';
        this.events.push({ kind: 'collapsed', time, value: this.drop });
      }
    }
    if (this.phase === 'collapsing' || this.phase === 'collapsed') {
      this.edgeFailure(env);
      this.trackPit(time);
    }
  }

  /** Culmann check of every wall vertex; the unstable part falls into the pit (mobile). */
  private edgeFailure(env: GroundEnv) {
    wallFailure(this.f, this.cells, env, () => this.profile);
  }

  private trackPit(time: number) {
    const f = this.f, [cx, cz] = this.spec.center;
    let r = 0;
    for (const i of this.cells) {
      if (f.bed[i] + f.h[i] > -0.1) continue;
      const ix = i % f.nx, iz = (i - ix) / f.nx;
      r = Math.max(r, Math.hypot(f.originX + ix * f.dx - cx, f.originZ + iz * f.dx - cz));
    }
    this.pitRadius = r;
    if (this.reportedRadius === 0) this.reportedRadius = Math.max(r, this.a);
    else if (r >= this.reportedRadius + 1) {
      this.events.push({ kind: 'expansion', time, value: r });
      this.reportedRadius = r;
    }
  }

  /** Prescribed support multiplier for foundations above the cavity (supportLoss mode). */
  support(x: number, z: number): number {
    if (this.spec.initiation !== 'supportLoss' || this.phase !== 'stable') return 1;
    return Math.hypot(x - this.spec.center[0], z - this.spec.center[1]) <= this.a ? 1 - this.loss : 1;
  }

  /** Predicted outcome without running (preview): critical radius, drop, choke, pit estimate. */
  static predict(spec: SinkholeSpec, profile: MechanicalProfile) {
    const gamma = unitWeight(profile), phi = profile.friction * DEG;
    const shear = (m: number) => profile.cohesion + profile.apparentCohesion * (1 - m) + (1 - Math.sin(phi)) * Math.max(0, gamma - m * gammaW()) * (spec.cover / 2) * Math.tan(phi);
    const m = spec.initiation === 'water' ? spec.saturation ?? 1 : 0;
    const q = spec.initiation === 'load' ? spec.surcharge ?? 0 : 0;
    const criticalRadius = (2 * spec.cover * shear(m)) / (gamma * spec.cover + q);
    const drop = spec.cavityHeight - (profile.bulking - 1) * spec.cover;
    const a = spec.initiation === 'growth' ? spec.cavityRadius + (spec.growthRate ?? 0) * spec.duration : spec.cavityRadius;
    const fs0 = plugFS({ a: spec.cavityRadius, H: spec.cover, c: profile.cohesion + profile.apparentCohesion, phi, gamma, m: 0, q: 0 });
    const fsEnd = plugFS({ a, H: spec.cover, c: profile.cohesion + profile.apparentCohesion * (1 - m), phi, gamma, m, q }) * (1 - (spec.initiation === 'supportLoss' ? spec.supportLoss ?? 0 : 0));
    // Pit estimate: plug radius widened by walls at the repose angle (cohesionless) over the drop.
    const pitRadius = drop > 0 ? a + (profile.cohesion > 0 ? 0 : drop / Math.tan(phi)) : 0;
    return { criticalRadius, drop, choked: drop <= 0, fs0, fsEnd, fails: fsEnd < 1, pitRadius, fallTime: fallTime(Math.max(0, drop)), g: gNow() };
  }
}
