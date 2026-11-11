/**
 * Road meshes (Phase 18) generated from the network: per segment (carriageway, sidewalks,
 * curbs, lane / edge markings) and per intersection (surface, sidewalk corners, crosswalks).
 * Pure data (positions, vertex colors, flat normals, uv) — the renderer merges pieces per chunk.
 *
 * Width stays exact on straights and curves: each cross-section is offset along the local
 * normal; where the inner edge of a tight curve would run backwards (radius < half width) the
 * edge vertex is held at its previous position, so the mesh never folds over or self-
 * intersects. Heights: graded / fixed roads use their elevation profile, follow roads the baked
 * terrain (sampled slightly inside the curb so the curb ramp of the 1 m grid is not picked up).
 */
import * as THREE from 'three';
import type { TerrainData } from '@/core/model';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { pointAt, type Centerline } from './curve';
import { naturalOf, profileAt, segmentProfile } from './bake';
import { sectionAt, taperStations, type MarkLine, type RoadSection } from './crossSection';
import { intersectionsOf, type Intersection } from './intersections';
import { CURB_COLOR, ROAD_MATERIAL_PROPS, SIDEWALK_COLOR } from './materials';
import { degree, segmentLine } from './network';
import type { RoadNetwork, RoadSegment } from './types';

/** Lift of the road surface above the terrain (no z-fighting) and of markings above it (m). */
export const SURFACE_LIFT = 0.03;
export const MARK_LIFT = 0.012;

export class MeshData {
  pos: number[] = [];
  col: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];

  /** Triangle (a, b, c) with one color and a flat normal; uv optional. */
  tri(a: number[], b: number[], c: number[], color: THREE.Color, uv?: [number[], number[], number[]]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-10) return; // degenerate (collapsed fold-over vertex)
    nx /= l; ny /= l; nz /= l;
    // Road surfaces face up: flip a downward triangle (winding fixed, never a back face).
    if (ny < 0 && Math.abs(ny) > 0.2) {
      this.tri(a, c, b, color, uv ? [uv[0], uv[2], uv[1]] : undefined);
      return;
    }
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color.r, color.g, color.b);
      this.nrm.push(nx, ny, nz);
    }
    if (uv) for (const t of uv) this.uv.push(t[0], t[1]);
    else this.uv.push(0, 0, 0, 0, 0, 0);
  }

  quad(a: number[], b: number[], c: number[], d: number[], color: THREE.Color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  get triangles() {
    return this.pos.length / 9;
  }
}

export interface RoadPiece {
  surface: MeshData;
  marking: MeshData;
  walk: MeshData;
}

const piece = (): RoadPiece => ({ surface: new MeshData(), marking: new MeshData(), walk: new MeshData() });
const c3 = (hex: string) => new THREE.Color(hex);
const WHITE = c3('#ecebe4');
const YELLOW = c3('#e5c046');
const CURB = c3(CURB_COLOR);
const WALK = c3(SIDEWALK_COLOR);

export interface MeshContext {
  network: RoadNetwork;
  terrain: TerrainData;
  sampler: TerrainSampler;
}

/** Cross-section frame at arc length s: center, right normal. */
function frame(line: Centerline, s: number) {
  const p = pointAt(line, s);
  return { x: p.x, z: p.z, rx: -p.tz, rz: p.tx, tx: p.tx, tz: p.tz, s };
}

/** Arc lengths of the cross-sections between the trims (the samples plus the exact ends and the taper starts). */
function sections(line: Centerline, s0: number, s1: number, extra: readonly number[] = []): number[] {
  const out = [s0];
  for (const p of line.samples) if (p.s > s0 + 0.05 && p.s < s1 - 0.05) out.push(p.s);
  out.push(s1);
  if (!extra.length) return out;
  // Phase 36: a cross-section exactly where a taper starts keeps its edges straight lines (a sample replaced if close).
  for (const e of extra) {
    if (e <= s0 + 0.05 || e >= s1 - 0.05) continue;
    const near = out.findIndex((s, i) => i > 0 && i < out.length - 1 && Math.abs(s - e) < 0.05);
    if (near >= 0) out[near] = e;
    else out.push(e);
  }
  return out.sort((a, b) => a - b);
}

export function segmentPiece(ctx: MeshContext, seg: RoadSegment): RoadPiece {
  const { network: n, terrain, sampler } = ctx;
  const out = piece();
  const line = segmentLine(n, seg);
  const ints = intersectionsOf(n);
  const s0 = ints.get(seg.a)?.trim.get(seg.id) ?? 0;
  const s1 = line.length - (ints.get(seg.b)?.trim.get(seg.id) ?? 0);
  if (s1 - s0 < 0.2) return out;
  const p = seg.profile;
  const prof = segmentProfile(terrain, naturalOf(terrain, n), n, seg, line);
  const S = sections(line, s0, s1, taperStations(n, seg)).map((s) => frame(line, s));
  // Phase 36: the cross-section of every station (the profile's own, except inside a width taper).
  const X = S.map((f) => sectionAt(n, seg, f.s));
  const height = (x: number, z: number, cx: number, cz: number, s: number, k: number) => {
    // Graded / fixed: the profile at the centerline, minus the crown fall at the curbs.
    if (prof) return profileAt(line, prof, s) - (x === cx && z === cz ? 0 : X[k].fall * X[k].w);
    // Follow: terrain, sampled a little inside so the curb ramp next to the edge is not picked up.
    const ix = x + (cx - x) * 0.35, iz = z + (cz - z) * 0.35;
    return sampler.sampleHeight(ix, iz);
  };
  const color = c3(ROAD_MATERIAL_PROPS[p.material].color);
  // Edge points (offset per station) with fold-over protection (inner side of tight curves).
  const edge = (o: (k: number) => number) => {
    const pts: { x: number; z: number }[] = [];
    S.forEach((f, k) => {
      let x = f.x + f.rx * o(k), z = f.z + f.rz * o(k);
      const prev = pts[pts.length - 1];
      if (prev && (x - prev.x) * f.tx + (z - prev.z) * f.tz < 0.02) { x = prev.x; z = prev.z; }
      pts.push({ x, z });
    });
    return pts;
  };
  const L = edge((k) => -X[k].w), R = edge((k) => X[k].w);
  const yC = S.map((f, k) => height(f.x, f.z, f.x, f.z, f.s, k) + SURFACE_LIFT);
  const yL = S.map((f, i) => height(L[i].x, L[i].z, f.x, f.z, f.s, i) + SURFACE_LIFT);
  const yR = S.map((f, i) => height(R[i].x, R[i].z, f.x, f.z, f.s, i) + SURFACE_LIFT);
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    const v = (q: { x: number; z: number }, y: number) => [q.x, y, q.z];
    const uvA = a.s / 4, uvB = b.s / 4;
    out.surface.tri(v(L[i], yL[i]), v(a, yC[i]), v(b, yC[i + 1]), color, [[0, uvA], [0.5, uvA], [0.5, uvB]]);
    out.surface.tri(v(L[i], yL[i]), v(b, yC[i + 1]), v(L[i + 1], yL[i + 1]), color, [[0, uvA], [0.5, uvB], [0, uvB]]);
    out.surface.tri(v(a, yC[i]), v(R[i], yR[i]), v(R[i + 1], yR[i + 1]), color, [[0.5, uvA], [1, uvA], [1, uvB]]);
    out.surface.tri(v(a, yC[i]), v(R[i + 1], yR[i + 1]), v(b, yC[i + 1]), color, [[0.5, uvA], [1, uvB], [0.5, uvB]]);
  }
  // What each end meets (Phase 36 end faces): nothing (a free end), a junction / bend whose corners may continue a
  // sidewalk, or the next road of a straight joint, which continues everything (the taper makes the sections equal).
  const ends = [true, false].map((atStart) => {
    const node = atStart ? seg.a : seg.b;
    const ix = ints.get(node);
    return { road: ix?.roads.find((r) => r.segment.id === seg.id && r.atStart === atStart), free: !ix && degree(n, node) === 1 };
  });
  const freeEnd = (atStart: boolean) => ends[atStart ? 0 : 1].free;
  const continued = (atStart: boolean, side: 1 | -1) => {
    const e = ends[atStart ? 0 : 1];
    if (e.free) return false;
    if (!e.road) return true;
    // +r of an intersection road is the travel-right side when the road starts at the node.
    return (e.road.atStart ? side > 0 : side < 0) ? e.road.cornerPlus : e.road.cornerMinus;
  };
  // Sidewalks + curb faces (a sidewalk may start or end inside a taper: drawn where it has a width at either station).
  for (const side of [-1, 1] as const) {
    const sw = (k: number) => (side > 0 ? X[k].swR : X[k].swL);
    const curb = (k: number) => (side > 0 ? X[k].curbR : X[k].curbL);
    if (!X.some((_, k) => sw(k) > 0)) continue;
    const inner = side > 0 ? R : L;
    const yIn = side > 0 ? yR : yL;
    const outer = edge((k) => side * (X[k].w + sw(k)));
    const top = (k: number, q: { x: number; z: number }) => [q.x, yIn[k] + curb(k), q.z];
    for (let i = 0; i < S.length - 1; i++) {
      if (!(sw(i) > 0 || sw(i + 1) > 0)) continue;
      out.walk.quad(top(i, inner[i]), top(i, outer[i]), top(i + 1, outer[i + 1]), top(i + 1, inner[i + 1]), WALK);
      // Curb face (vertical), from the carriageway up to the walk, facing the carriageway on both sides (Phase 36: the
      // right-hand faces used to face away from the road and were culled).
      wall(out.walk, inner[i], inner[i + 1], yIn[i], yIn[i + 1], curb(i), curb(i + 1), -side * S[i].rx, -side * S[i].rz, CURB);
    }
    // Phase 36: the end of a sidewalk that nothing continues (free road end, or a junction side without a corner) gets
    // an end face instead of an open edge in the air.
    for (const k of [0, S.length - 1]) {
      if (!(sw(k) > 0) || continued(k === 0, side)) continue;
      const dir = k === 0 ? -1 : 1;
      wall(out.walk, inner[k], outer[k], yIn[k] - SURFACE_LIFT, yIn[k] - SURFACE_LIFT, curb(k) + SURFACE_LIFT, curb(k) + SURFACE_LIFT, dir * S[k].tx, dir * S[k].tz, CURB);
    }
  }
  // Phase 36: a free road end shows the edge of the (lifted) carriageway slab instead of a gap above the terrain. It
  // goes with the curb faces (walk layer): the surface layer holds only upward faces.
  for (const k of [0, S.length - 1]) {
    if (!freeEnd(k === 0)) continue;
    const dir = k === 0 ? -1 : 1, f = S[k];
    wall(out.walk, L[k], f, yL[k] - SURFACE_LIFT, yC[k] - SURFACE_LIFT, SURFACE_LIFT, SURFACE_LIFT, dir * f.tx, dir * f.tz, color);
    wall(out.walk, f, R[k], yC[k] - SURFACE_LIFT, yR[k] - SURFACE_LIFT, SURFACE_LIFT, SURFACE_LIFT, dir * f.tx, dir * f.tz, color);
  }
  markings(out.marking, S, X, yC, yL, yR);
  return out;
}

/**
 * Vertical face p → q rising from the bottom heights (yp, yq) by (hp, hq), wound so that it faces the horizontal
 * direction (tx, tz): the road materials are one-sided, a face wound the other way is culled.
 */
function wall(m: MeshData, p: { x: number; z: number }, q: { x: number; z: number }, yp: number, yq: number, hp: number, hq: number, tx: number, tz: number, color: THREE.Color) {
  // The quad's normal is (−dz, 0, dx) for p → q = (dx, dz).
  if (-(q.z - p.z) * tx + (q.x - p.x) * tz < 0) [p, q, yp, yq, hp, hq] = [q, p, yq, yp, hq, hp];
  if (!(hp > 1e-4 || hq > 1e-4)) return;
  m.quad([p.x, yp, p.z], [q.x, yq, q.z], [q.x, yq + hq, q.z], [p.x, yp + hp, p.z], color);
}

/**
 * Lane / center / edge lines as thin strips following the cross-sections. The lines of each station come from its
 * section (roads/crossSection.ts, the Phase 18 / 35.5 rules); a line keeps its identity (key) along the segment, so a
 * taper bends it from one offset to the other, and a line missing at one end of a span (a dropped lane) ends there.
 */
function markings(m: MeshData, S: ReturnType<typeof frame>[], X: readonly RoadSection[], yC: number[], yL: number[], yR: number[]) {
  const yAt = (i: number, o: number) => {
    const f = Math.abs(o) / Math.max(1e-6, X[i].w);
    return (o < 0 ? yC[i] + (yL[i] - yC[i]) * f : yC[i] + (yR[i] - yC[i]) * f) + MARK_LIFT;
  };
  // Every line once, in first-seen order (= the profile's drawing order on a segment without a taper).
  const keys: string[] = [];
  for (const sec of X) for (const l of sec.lines) if (!keys.includes(l.key)) keys.push(l.key);
  const at = X.map((sec) => new Map(sec.lines.map((l) => [l.key, l])));
  for (const key of keys) {
    for (let i = 0; i < S.length - 1; i++) {
      const la = at[i].get(key), lb = at[i + 1].get(key);
      if (!la || !lb) continue;
      const a = S[i], b = S[i + 1];
      if (la.dashed && Math.floor(((a.s + b.s) / 2) / 3) % 3 !== 0) continue; // 3 m dash, 6 m gap
      const p = (f: typeof a, k: number, l: MarkLine, d: number) => [f.x + f.rx * (l.o + d), yAt(k, l.o), f.z + f.rz * (l.o + d)];
      m.quad(p(a, i, la, -la.width / 2), p(a, i, la, la.width / 2), p(b, i + 1, lb, lb.width / 2), p(b, i + 1, lb, -lb.width / 2), la.yellow ? YELLOW : WHITE);
    }
  }
}

export function intersectionPiece(ctx: MeshContext, ix: Intersection): RoadPiece {
  const { network: n, terrain, sampler } = ctx;
  const out = piece();
  const node = n.nodes[ix.node];
  const graded = ix.roads.some((r) => r.segment.profile.elevation !== 'follow') || node.y !== null;
  // Graded junctions sit at the node elevation (what the bake wrote); follow ones on the terrain.
  const nodeH = graded ? sampler.sampleHeight(node.x, node.z) : NaN;
  const yAt = (x: number, z: number) => (graded ? nodeH : sampler.sampleHeight(x + (node.x - x) * 0.3, z + (node.z - z) * 0.3)) + SURFACE_LIFT;
  void terrain;
  const color = c3(ROAD_MATERIAL_PROPS[ix.material].color);
  const center = [node.x, yAt(node.x, node.z), node.z];
  const poly = ix.surface;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    out.surface.tri(center, [a[0], yAt(a[0], a[1]), a[1]], [b[0], yAt(b[0], b[1]), b[1]], color);
  }
  for (const c of ix.corners) {
    const cx = c.poly.reduce((t, p) => t + p[0], 0) / c.poly.length;
    const cz = c.poly.reduce((t, p) => t + p[1], 0) / c.poly.length;
    const top = (x: number, z: number) => [x, yAt(x, z) + c.curb, z];
    for (let i = 0; i < c.poly.length; i++) {
      const a = c.poly[i], b = c.poly[(i + 1) % c.poly.length];
      out.walk.tri(top(cx, cz), top(a[0], a[1]), top(b[0], b[1]), WALK);
    }
    // Phase 36: the curb face along the corner (it used to be an open slit), facing the junction surface.
    for (let i = 0; i < c.curbLine.length - 1; i++) {
      const [ax, az] = c.curbLine[i], [bx, bz] = c.curbLine[i + 1];
      wall(out.walk, { x: ax, z: az }, { x: bx, z: bz }, yAt(ax, az), yAt(bx, bz), c.curb, c.curb, node.x - (ax + bx) / 2, node.z - (az + bz) / 2, CURB);
    }
  }
  for (const cw of ix.crosswalks) {
    const rx = -cw.dz, rz = cw.dx;
    const stripes = Math.max(1, Math.floor(cw.width / 1));
    for (let k = 0; k < stripes; k++) {
      const o = -cw.width / 2 + (k + 0.25) * (cw.width / stripes);
      const sw = (cw.width / stripes) * 0.5;
      const p = (oo: number, d: number) => {
        const x = cw.x + rx * oo + cw.dx * d, z = cw.z + rz * oo + cw.dz * d;
        return [x, yAt(x, z) + MARK_LIFT, z];
      };
      out.marking.quad(p(o, -cw.depth / 2), p(o + sw, -cw.depth / 2), p(o + sw, cw.depth / 2), p(o, cw.depth / 2), WHITE);
    }
  }
  return out;
}

/** Every piece of a network (keyed: 's:<id>' segments, 'i:<node>' intersections). */
export function networkPieces(ctx: MeshContext): Map<string, RoadPiece> {
  const out = new Map<string, RoadPiece>();
  for (const s of Object.values(ctx.network.segments)) out.set(`s:${s.id}`, segmentPiece(ctx, s));
  for (const ix of intersectionsOf(ctx.network).values()) out.set(`i:${ix.node}`, intersectionPiece(ctx, ix));
  return out;
}
