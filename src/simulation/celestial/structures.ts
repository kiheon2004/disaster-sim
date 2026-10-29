/**
 * Celestial sources on structures (Phase 32) — what the Phase 31 vertical ratios (gravity/structures.ts, per member
 * k = g_down/g₀, now clamped at 0 for members pulled upward) do not cover:
 *
 *  lateral   the HORIZONTAL part of the point sources' field at each floor of each structure's storey model
 *            (seismic/StructuralModel: a lumped shear chain on a held foundation): floor j takes the body force
 *            m_j·g_h(x_j) relative to the ground it stands on — the floors of one building sit at different heights,
 *            so the loads differ floor to floor (the differential / tidal part included). Drift → the storey model's
 *            damage → the existing member failure paths (attributed to 'gravity' where this field governs:
 *            pgaGravity). Only the celestial part: a Phase 31 sideways gravity keeps its documented limit.
 *  uplift    a member whose field points UP (g_y > 0 at its centre, e.g. under a source above the roof) pulls on its
 *            supports. The pull is accumulated down the load path in rank order (top first, shared equally over the
 *            supports, as the gravity solver shares compression): N_i = m_i·g_y,i + Σ (pull of the members it
 *            carries). A connection fails when its share exceeds its tension (hold-down) capacity T:
 *              vertical continuity (splice / base / transfer): T = f_t·A of the member's section
 *                (f_t: steel f_y; reinforced concrete ρ·f_y = 0.015 × 500 MPa = 7.5 MPa (bars only, concrete
 *                tension neglected); timber 0.6·f_c,0 (EN 338: f_t,0,k ≈ 0.6–0.7 f_c,0,k); masonry 0.1 MPa (bond,
 *                EN 1996 f_xk1); glass / cladding 0),
 *              seats (beam, slab): T = φ·(gravity capacity of the seat), φ = 0.5 monolithic concrete / bolted steel,
 *                0.3 timber, 0.1 masonry pockets (assumed hold-down shares of the seat's capacity — no uplift
 *                detailing is designed),
 *              coverings, openings, hosted and non-structural parts: their facade capacity (Pa) × plan area — the
 *                pressure their fixings hold against wind / blast;
 *            the member is then detached and handed to the physics engine as a fragment (with everything hanging
 *            from it that is also pulled up), its mass moved to the 'bodies' account. A reduced model (no member
 *            stiffness or bending under uplift); documented as such.
 */
import type { Vec3 } from '@/core/types';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { GravityField } from '@/gravity/field';
import { ensureSeismicRuntime } from '../seismic/SeismicState';
import { structureOf, activate } from '../structure/state';
import { memberGy } from '../gravity/memberField';
import { spawnFragment } from '../structure/fragments';
import { memberMaterial, MT_BEAM, MT_COLUMN, MT_DOOR, MT_ROOF, MT_WALL, MT_WINDOW, type StructuralGraph } from '@/structure/graph';
import { CK } from '@/structure/types';
import { GRAVITY } from '@/core/units';

/** Tension stress of a member section by material (Pa) — see the header. */
const TENSION: Record<string, (fc: number) => number> = {
  structuralSteel: (fc) => fc,
  reinforcedConcrete: () => 7.5e6,
  timber: (fc) => 0.6 * fc,
  masonry: () => 0.1e6,
};
/** Hold-down share of a seat's gravity capacity by material. */
const SEAT: Record<string, number> = { structuralSteel: 0.5, reinforcedConcrete: 0.5, timber: 0.3, masonry: 0.1 };

const tmp: Vec3 = [0, 0, 0];

export class CelestialStructures {
  /** Members detached by uplift, storeys loaded laterally (units with a field), peak lateral field (m/s²). */
  uplifted = 0;
  loadedUnits = 0;
  peakLateral = 0;
  private sig = '';
  private N = new Float64Array(0);

  update(ctx: SystemContext, f: GravityField) {
    const ch = ctx.env.gravity;
    const pts = f.points;
    const tidal = f.celestial.some((e) => e.spec.tidal);
    // The field changes only when a source moves, ramps or grows: everything here is re-evaluated then.
    let sig = '';
    for (const l of pts.live) sig += `${l.x},${l.y},${l.z},${l.mu};`;
    if (sig === this.sig) return;
    this.sig = sig;
    if (!tidal) { ch.lateral = false; return; }
    this.lateral(ctx, f);
    this.uplift(ctx, f);
  }

  /** Floors of every storey-model unit: the celestial horizontal field at their height. */
  private lateral(ctx: SystemContext, f: GravityField) {
    const ch = ctx.env.gravity;
    const live = f.points.live.length > 0;
    if (!live && !ctx.runtime.seismic) { ch.lateral = false; return; }
    const sr = ensureSeismicRuntime(ctx.runtime, ctx.env.terrain, GRAVITY, ctx.interactions);
    const m = sr.model;
    let loaded = 0;
    for (let ui = 0; ui < sr.units.length; ui++) {
      const e = sr.units[ui];
      const o = m.off[ui], n = m.n[ui];
      if (!live || e.flags.collapsed || e.flags.toppled) {
        if (m.hasG[ui]) { for (let j = 0; j <= n; j++) { m.gfx[2 * (o + j)] = 0; m.gfx[2 * (o + j) + 1] = 0; } m.hasG[ui] = 0; }
        continue;
      }
      const p = e.pose.position;
      let peak = 0;
      for (let j = 0; j <= n; j++) {
        tmp[0] = 0; tmp[1] = 0; tmp[2] = 0;
        f.points.addSample(p[0], p[1] + m.z[o + j], p[2], tmp);
        m.gfx[2 * (o + j)] = tmp[0];
        m.gfx[2 * (o + j) + 1] = tmp[2];
        peak = Math.max(peak, Math.hypot(tmp[0], tmp[2]));
      }
      // Below 10⁻⁴ g₀ the load is nothing the storey model resolves (and keeps distant units idle).
      m.hasG[ui] = peak > 1e-4 * GRAVITY ? 1 : 0;
      if (!m.hasG[ui]) continue;
      loaded++;
      const st = e.seismic!;
      if (peak > (st.pgaGravity ?? 0)) st.pgaGravity = peak;
      if (peak > this.peakLateral) this.peakLateral = peak;
    }
    this.loadedUnits = loaded;
    ch.lateral = loaded > 0;
  }

  /** Uplift check of the modular buildings within reach of a source pulling upward harder than g₀ can hold. */
  private uplift(ctx: SystemContext, f: GravityField) {
    if (!f.points.live.length) return;
    const g0 = ctx.env.gravity.g0;
    for (const e of ctx.runtime.entities.values()) {
      if (!e.modular || e.flags.collapsed) continue;
      // Upward net field needs a source pull above g₀: within √(μ/g₀) of a source (plus the building's size).
      const p = e.pose.position, R = 0.5 * Math.hypot(e.dims[0], e.dims[1], e.dims[2]);
      let near = false;
      for (const l of f.points.live) if (Math.hypot(p[0] - l.x, p[1] + e.dims[1] / 2 - l.y, p[2] - l.z) < Math.sqrt(l.mu / g0) + R) near = true;
      if (!near) continue;
      this.building(ctx, f, e);
    }
  }

  private building(ctx: SystemContext, f: GravityField, e: RuntimeEntity) {
    const st = structureOf(e, ctx);
    const m = st.model, g = m.g, n = g.n;
    if (this.N.length < n) this.N = new Float64Array(n);
    const N = this.N;
    let any = false;
    const gyM = memberGy(e, st, f);
    for (let i = 0; i < n; i++) {
      N[i] = 0;
      if (!m.alive(i)) continue;
      const gy = gyM[i];
      if (gy > 0) { N[i] = g.mass[i] * gy; any = true; } else N[i] = g.mass[i] * gy;
    }
    if (!any) return;
    const failed: number[] = [];
    // Top first (supports rank lower): a member's pull, plus what it carries, goes to its supports.
    for (let r = n - 1; r >= 0; r--) {
      const i = g.byRank[r];
      if (!m.alive(i) || !(N[i] > 0)) continue;
      let count = 0;
      for (let k = g.eStart[i]; k < g.eStart[i + 1]; k++) if (m.alive(g.eTo[k])) count++;
      if (count === 0) continue;
      const share = N[i] / count;
      let broken = false;
      for (let k = g.eStart[i]; k < g.eStart[i + 1]; k++) {
        const j = g.eTo[k];
        if (!m.alive(j)) continue;
        if (share > this.capacity(g, i, k)) broken = true;
        else N[j] += share;
      }
      if (broken) failed.push(i);
    }
    if (!failed.length) return;
    // Detach the failed members and everything above them that is pulled up through them.
    const out = new Set<number>();
    const stack = [...failed];
    while (stack.length) {
      const i = stack.pop()!;
      if (out.has(i) || !m.alive(i)) continue;
      out.add(i);
      for (let k = g.rStart[i]; k < g.rStart[i + 1]; k++) {
        const d = g.eFrom[g.rEdge[k]];
        if (m.alive(d) && N[d] > 0) stack.push(d);
      }
    }
    for (const i of [...out].sort((a, b) => a - b)) {
      const share = N[i];
      if (!m.detachMember(i, 'uplift', 'gravity', ctx.time, share / Math.max(1, this.ownCapacity(g, i)))) continue;
      spawnFragment(ctx, e, i, [0, 0, 0], 'gravity');
      this.uplifted++;
    }
    activate(e, ctx);
    ctx.milestone?.({ time: ctx.time, kind: 'tidalFailure', subject: 'celestial', label: { key: 'ms.celestial.uplift' as never, params: { id: e.id } } }, 'celestial:uplift');
  }

  /** Tension capacity of connection k (dependent i → its support), N. */
  private capacity(g: StructuralGraph, i: number, k: number): number {
    const kind = g.eKind[k], t = g.type[i];
    const mat = memberMaterial(g, i);
    // Coverings, openings and anything hosted: their fixings hold what the facade model says they hold against
    // pressure (Pa × plan area — the same capacity wind / blast use).
    if (kind === CK.ROOF || kind === CK.HOSTED || t === MT_ROOF || t === MT_WINDOW || t === MT_DOOR || !mat.structural) return mat.facadePressure * this.plan(g, i);
    if (kind === CK.SPLICE || kind === CK.BASE || kind === CK.TRANSFER || !(g.eCap[k] < Infinity)) return this.ownCapacity(g, i);
    return (SEAT[mat.id] ?? 0) * g.eCap[k];
  }

  private plan(g: StructuralGraph, i: number) {
    const o = 6 * i;
    return (g.box[o + 3] - g.box[o]) * (g.box[o + 5] - g.box[o + 2]);
  }

  /** Tension capacity of a member's own section f_t·A (N): plan section of columns / walls, width × depth of beams. */
  private ownCapacity(g: StructuralGraph, i: number): number {
    const mat = memberMaterial(g, i);
    const o = 6 * i;
    const sx = g.box[o + 3] - g.box[o], sy = g.box[o + 4] - g.box[o + 1], sz = g.box[o + 5] - g.box[o + 2];
    const t = g.type[i];
    const A = t === MT_COLUMN ? sx * sz * mat.fill.column : t === MT_WALL ? sx * sz * mat.fill.wall : t === MT_BEAM ? Math.min(sx, sz) * sy * mat.fill.beam : sx * sz * mat.fill.slab;
    return (TENSION[mat.id]?.(mat.compressive) ?? 0) * A;
  }
}
