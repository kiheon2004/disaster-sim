/**
 * One impact applied to the shared geotechnical field over time (Phase 23).
 *
 * At the impact time (event start + entry time + arc time) the crater GROWS: the excavation front
 * follows the point-source growth law, so the bowl vertex at radius r is cut when the front
 * reaches it (t(r) = μ/(1+μ)·r / v₀(r), the same law that times the ejecta launches). The bowl is
 * the transient paraboloid d(r) = d₀·(1 − r²/R²). Of the cut volume, the ejected part leaves as
 * parcels (launched at their own times → airborne → landed as loose deposit at their landing time,
 * or out of the world); the rest is displaced into the structural rim — an uplift
 * h(r) ∝ (R/r)³ for R < r ≤ 2R (beyond two radii the material above the surface is ejecta —
 * Collins et al. 2005), scaled on the grid so that cut − uplift = ejected EXACTLY (the
 * ledgers then match the terrain change to round-off). After the crater has formed, the walls are
 * checked every update with the Phase 22 Culmann criterion (sand slumps to repose, rock stands).
 *
 * The target is assumed to be the same material to well below the crater floor (soil thickness
 * 2·d + 1 m for the wall check). The model owns the bowl / rim / landing vertices (owner index) so objects there are attributed
 * to it ('impact:<name>').
 */
import type { GeoField } from '@/ground/GeoField';
import type { GroundEnv } from '@/ground/common';
import { wallFailure } from '@/ground/common';
import type { ImpactPlan } from './plan';
import type { Parcel } from './ejecta';

export type ImpactEventKind = 'entry' | 'breakup' | 'airburst' | 'impact' | 'craterFormed' | 'ejectaLanding' | 'ejectaDone';

export interface ImpactModelEvent {
  kind: ImpactEventKind;
  time: number;
  value: number;
}

/** A parcel that landed in the current update (objects respond to it). */
export interface Landing {
  parcel: Parcel;
  /** Landing point and footprint (world m), bulked volume (m³), mass (kg), horizontal speed (m/s). */
  x: number;
  z: number;
  volume: number;
  mass: number;
  speed: number;
  vh: number;
  dirX: number;
  dirZ: number;
}

/**
 * Structural uplift reaches two transient radii from the centre: beyond that the material above the
 * pre-impact surface is almost all ejecta (Collins et al. 2005, §Ejecta deposit).
 */
const UPLIFT_REACH = 2;

export class ImpactModel {
  readonly kind = 'impact' as const;
  readonly index: number;
  readonly impactTime: number;
  readonly events: ImpactModelEvent[] = [];
  /** Bowl vertices with their cut depth and cut time (after impact); rim vertices with their uplift weight. */
  private bowl: { i: number; depth: number; t: number }[] = [];
  private rim: { i: number; w: number }[] = [];
  private cutDone = 0;
  private cutVolume = 0;
  private upliftTotal = 0;
  private upliftApplied = 0;
  private launched = 0;
  private landed = 0;
  readonly cells: number[] = [];
  readonly bulking: number;
  formed = false;
  /** Crater radius on the grid and depth actually cut (m). */
  gridVolume = 0;
  /** Landed parcels (index into plan.parcels after sorting by launch time). */
  private done: Uint8Array = new Uint8Array(0);

  constructor(readonly id: string, readonly name: string, readonly plan: ImpactPlan, readonly startTime: number, private readonly f: GeoField, index: number) {
    this.index = index;
    this.impactTime = startTime + plan.timeToImpact;
    this.bulking = plan.target.bulking;
    const c = plan.crater;
    this.events.push({ kind: 'entry', time: startTime, value: plan.spec.speed });
    if (plan.entry?.breakup) this.events.push({ kind: 'breakup', time: startTime + plan.entry.breakup.time, value: plan.entry.breakup.altitude });
    if (plan.entry?.airburst) this.events.push({ kind: 'airburst', time: startTime + plan.entry.airburst.time, value: plan.entry.airburst.altitude });
    if (!c || plan.airburst) return;
    const [cx, , cz] = plan.arc.point;
    const R = c.radius, d0 = c.depth, A = f.dx * f.dx;
    const reach = R * UPLIFT_REACH + f.dx;
    const set = c.set;
    const x0 = Math.max(set.n1 * c.a, 0.05 * R);
    const alpha = set.mu / (1 + set.mu);
    const tAt = (r: number) => {
      const x = Math.max(r, x0);
      const v0 = set.C1 * c.U * ((x / c.a) * (plan.target.density / plan.projectile.density) ** set.nu) ** (-1 / set.mu);
      return (alpha * x) / v0;
    };
    let wSum = 0;
    for (let iz = Math.max(0, Math.floor((cz - reach - f.originZ) / f.dx)); iz <= Math.min(f.nz - 1, Math.ceil((cz + reach - f.originZ) / f.dx)); iz++) {
      for (let ix = Math.max(0, Math.floor((cx - reach - f.originX) / f.dx)); ix <= Math.min(f.nx - 1, Math.ceil((cx + reach - f.originX) / f.dx)); ix++) {
        const i = iz * f.nx + ix;
        const r = Math.hypot(f.originX + ix * f.dx - cx, f.originZ + iz * f.dx - cz);
        if (r > reach) continue;
        this.cells.push(i);
        f.owner[i] = index;
        // The target is assumed to be the same material well below the crater floor: soil
        // available to the wall-stability check (rock: 0 — not checked).
        if (f.profile(i).failureModel) f.thickness[i] = Math.max(f.thickness[i], 2 * d0 + 1);
        if (r < R) {
          const depth = d0 * (1 - (r * r) / (R * R));
          this.bowl.push({ i, depth, t: tAt(r) });
          this.gridVolume += depth * A;
        } else if (r <= R * UPLIFT_REACH) {
          const w = (R / Math.max(r, 1e-6)) ** 3;
          this.rim.push({ i, w });
          wSum += w;
        }
      }
    }
    // A crater smaller than one cell: cut the nearest vertex (the grid cannot show less).
    if (!this.bowl.length) {
      const i = f.index(cx, cz);
      if (i >= 0) { this.bowl.push({ i, depth: Math.min(d0, c.volume / A), t: 0 }); this.gridVolume = this.bowl[0].depth * A; }
    }
    this.bowl.sort((a, b) => a.t - b.t);
    for (const r of this.rim) r.w /= wSum || 1;
    // Exact balance: ejected (in place) ≤ cut on the grid; the parcels are scaled if needed.
    const ejected = plan.parcels.reduce((s, p) => s + p.volume, 0);
    if (ejected > this.gridVolume && ejected > 0) {
      const k = this.gridVolume / ejected;
      for (const p of plan.parcels) { p.volume *= k; p.mass *= k; }
    }
    const ej = plan.parcels.reduce((s, p) => s + p.volume, 0);
    this.upliftTotal = this.rim.length ? this.gridVolume - ej : 0;
    // No rim vertex (crater at the world edge): keep the balance by leaving the displaced part in the bowl.
    if (!this.rim.length && this.gridVolume > ej) {
      const keep = (this.gridVolume - ej) / this.gridVolume;
      for (const b of this.bowl) b.depth *= 1 - keep;
      this.gridVolume = ej;
    }
    plan.parcels.sort((a, b) => a.t0 - b.t0);
    this.done = new Uint8Array(plan.parcels.length);
  }

  /** Advance to absolute time `time` (every step). Returns parcels that landed in this call. */
  update(time: number): Landing[] {
    const plan = this.plan, f = this.f, A = f.dx * f.dx;
    const landings: Landing[] = [];
    if (plan.airburst || !plan.crater || time < this.impactTime) return landings;
    const tau = time - this.impactTime;
    if (!this.events.some((e) => e.kind === 'impact')) this.events.push({ kind: 'impact', time: this.impactTime, value: plan.energy });
    // Excavation front.
    while (this.cutDone < this.bowl.length && this.bowl[this.cutDone].t <= tau) {
      const b = this.bowl[this.cutDone++];
      f.excavate(b.i, b.depth);
      this.cutVolume += b.depth * A;
    }
    // Rim uplift in proportion to the cut so far (exact at the end).
    if (this.upliftTotal > 0) {
      const target = this.gridVolume > 0 ? this.upliftTotal * (this.cutVolume / this.gridVolume) : 0;
      const inc = target - this.upliftApplied;
      if (inc > 0) {
        for (const r of this.rim) f.uplift(r.i, (inc * r.w) / A);
        this.upliftApplied = target;
      }
    }
    // Launches and landings.
    const parcels = plan.parcels;
    while (this.launched < parcels.length && parcels[this.launched].t0 <= tau) {
      const p = parcels[this.launched++];
      f.launch(p.volume, p.mass, this.bulking);
    }
    for (let k = 0; k < parcels.length; k++) {
      const p = parcels[k];
      if (this.done[k] || p.t1 > tau || p.t0 > tau) continue;
      landings.push(this.deposit(p));
      this.done[k] = 1;
      this.landed++;
      if (this.landed === 1) this.events.push({ kind: 'ejectaLanding', time, value: p.mass });
    }
    if (this.landed === parcels.length && parcels.length && !this.events.some((e) => e.kind === 'ejectaDone')) this.events.push({ kind: 'ejectaDone', time, value: plan.ejectaMass });
    if (!this.formed && this.cutDone === this.bowl.length) {
      this.formed = true;
      this.events.push({ kind: 'craterFormed', time, value: 2 * plan.crater.radius });
    }
    return landings;
  }

  /** Crater walls (after formation; at the deformation update rate). */
  walls(env: GroundEnv) {
    if (!this.formed) return;
    wallFailure(this.f, this.cells, env, (i) => this.f.profile(i), true);
  }

  /** Spread a landed parcel over its footprint (Gaussian ellipse, normalized: exact volume and mass). */
  private deposit(p: Parcel): Landing {
    const f = this.f, [cx, , cz] = this.plan.arc.point;
    const [x, , z] = p.p1;
    let rx = x - cx, rz = z - cz;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const vol = p.volume * this.bulking, mass = p.mass;
    // Horizontal landing speed from the last path segment's direction (drag steepens the descent).
    const n = p.path.length;
    const hx = n >= 6 ? p.path[n - 3] - p.path[n - 6] : p.v0[0], hy = n >= 6 ? p.path[n - 2] - p.path[n - 5] : -p.v0[1], hz = n >= 6 ? p.path[n - 1] - p.path[n - 4] : p.v0[2];
    const seg = Math.hypot(hx, hy, hz) || 1;
    const vh = p.v1 * (Math.hypot(hx, hz) / seg);
    const landing: Landing = { parcel: p, x, z, volume: vol, mass, speed: p.v1, vh, dirX: rx, dirZ: rz };
    if (p.outflow) {
      f.landOutside(vol, mass);
      return landing;
    }
    const sr = p.spreadR, st = p.spreadT, reach = 2 * Math.max(sr, st);
    const cells: { i: number; w: number }[] = [];
    let wSum = 0;
    for (let iz = Math.max(0, Math.floor((z - reach - f.originZ) / f.dx)); iz <= Math.min(f.nz - 1, Math.ceil((z + reach - f.originZ) / f.dx)); iz++) {
      for (let ix = Math.max(0, Math.floor((x - reach - f.originX) / f.dx)); ix <= Math.min(f.nx - 1, Math.ceil((x + reach - f.originX) / f.dx)); ix++) {
        const dx = f.originX + ix * f.dx - x, dz = f.originZ + iz * f.dx - z;
        const a = dx * rx + dz * rz, b = -dx * rz + dz * rx;
        const w = Math.exp(-0.5 * ((a * a) / (sr * sr) + (b * b) / (st * st)));
        if (w < 1e-3) continue;
        cells.push({ i: iz * f.nx + ix, w });
        wSum += w;
      }
    }
    if (!cells.length) {
      // Landed outside the grid (beyond its edge but not yet below y = 0 when it left): outflow.
      f.landOutside(vol, mass);
      return landing;
    }
    for (const c of cells) {
      f.land(c.i, (vol * c.w) / wSum, (mass * c.w) / wSum);
      if (f.owner[c.i] < 0) f.owner[c.i] = this.index;
    }
    return landing;
  }

  /** Progress for HUD / inspector. */
  status() {
    return {
      cut: this.cutVolume, gridVolume: this.gridVolume, uplift: this.upliftApplied, upliftTotal: this.upliftTotal,
      launched: this.launched, landed: this.landed, parcels: this.plan.parcels.length, formed: this.formed,
    };
  }
}
