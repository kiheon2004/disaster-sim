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
import { intersectionsOf, type Intersection } from './intersections';
import { CURB_COLOR, ROAD_MATERIAL_PROPS, SIDEWALK_COLOR } from './materials';
import { segmentLine } from './network';
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

/** Arc lengths of the cross-sections between the trims (the samples plus the exact ends). */
function sections(line: Centerline, s0: number, s1: number): number[] {
  const out = [s0];
  for (const p of line.samples) if (p.s > s0 + 0.05 && p.s < s1 - 0.05) out.push(p.s);
  out.push(s1);
  return out;
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
  const w = p.width / 2;
  const height = (x: number, z: number, cx: number, cz: number, s: number) => {
    if (prof) return profileAt(line, prof, s);
    // Follow: terrain, sampled a little inside so the curb ramp next to the edge is not picked up.
    const ix = x + (cx - x) * 0.35, iz = z + (cz - z) * 0.35;
    return sampler.sampleHeight(ix, iz);
  };
  const S = sections(line, s0, s1).map((s) => frame(line, s));
  const color = c3(ROAD_MATERIAL_PROPS[p.material].color);
  // Edge points with fold-over protection (inner side of tight curves).
  const edge = (o: number) => {
    const pts: { x: number; z: number }[] = [];
    for (const f of S) {
      let x = f.x + f.rx * o, z = f.z + f.rz * o;
      const prev = pts[pts.length - 1];
      if (prev && (x - prev.x) * f.tx + (z - prev.z) * f.tz < 0.02) { x = prev.x; z = prev.z; }
      pts.push({ x, z });
    }
    return pts;
  };
  const L = edge(-w), R = edge(w);
  const yC = S.map((f) => height(f.x, f.z, f.x, f.z, f.s) + SURFACE_LIFT);
  const yL = S.map((f, i) => height(L[i].x, L[i].z, f.x, f.z, f.s) + SURFACE_LIFT);
  const yR = S.map((f, i) => height(R[i].x, R[i].z, f.x, f.z, f.s) + SURFACE_LIFT);
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    const v = (q: { x: number; z: number }, y: number) => [q.x, y, q.z];
    const uvA = a.s / 4, uvB = b.s / 4;
    out.surface.tri(v(L[i], yL[i]), v(a, yC[i]), v(b, yC[i + 1]), color, [[0, uvA], [0.5, uvA], [0.5, uvB]]);
    out.surface.tri(v(L[i], yL[i]), v(b, yC[i + 1]), v(L[i + 1], yL[i + 1]), color, [[0, uvA], [0.5, uvB], [0, uvB]]);
    out.surface.tri(v(a, yC[i]), v(R[i], yR[i]), v(R[i + 1], yR[i + 1]), color, [[0.5, uvA], [1, uvA], [1, uvB]]);
    out.surface.tri(v(a, yC[i]), v(R[i + 1], yR[i + 1]), v(b, yC[i + 1]), color, [[0.5, uvA], [1, uvB], [0.5, uvB]]);
  }
  // Sidewalks + curb faces.
  for (const side of [-1, 1] as const) {
    const travelSide = side > 0 ? 'right' : 'left';
    if (!(p.sidewalk === 'both' || p.sidewalk === travelSide)) continue;
    const inner = side > 0 ? R : L;
    const yIn = side > 0 ? yR : yL;
    const outer = edge(side * (w + p.sidewalkWidth));
    for (let i = 0; i < S.length - 1; i++) {
      const top = (k: number, q: { x: number; z: number }) => [q.x, yIn[k] + p.curbHeight, q.z];
      out.walk.quad(top(i, inner[i]), top(i, outer[i]), top(i + 1, outer[i + 1]), top(i + 1, inner[i + 1]), WALK);
      // Curb face (vertical), from the carriageway up to the walk.
      out.walk.quad([inner[i].x, yIn[i], inner[i].z], [inner[i + 1].x, yIn[i + 1], inner[i + 1].z], top(i + 1, inner[i + 1]), top(i, inner[i]), CURB);
    }
  }
  if (p.markings && ROAD_MATERIAL_PROPS[p.material].marked) markings(out.marking, S, yC, yL, yR, p.lanes, w, p.oneWay);
  return out;
}

/** Lane / center / edge lines as thin strips following the cross-sections. */
function markings(m: MeshData, S: ReturnType<typeof frame>[], yC: number[], yL: number[], yR: number[], lanes: number, w: number, oneWay: boolean) {
  const yAt = (i: number, o: number) => {
    const f = Math.abs(o) / Math.max(1e-6, w);
    return (o < 0 ? yC[i] + (yL[i] - yC[i]) * f : yC[i] + (yR[i] - yC[i]) * f) + MARK_LIFT;
  };
  const strip = (o: number, width: number, color: THREE.Color, dashed: boolean) => {
    for (let i = 0; i < S.length - 1; i++) {
      const a = S[i], b = S[i + 1];
      if (dashed && Math.floor(((a.s + b.s) / 2) / 3) % 3 !== 0) continue; // 3 m dash, 6 m gap
      const p = (f: typeof a, k: number, d: number) => [f.x + f.rx * (o + d), yAt(k, o), f.z + f.rz * (o + d)];
      m.quad(p(a, i, -width / 2), p(a, i, width / 2), p(b, i + 1, width / 2), p(b, i + 1, -width / 2), color);
    }
  };
  const laneW = (2 * w) / lanes;
  if (oneWay) {
    for (let k = 1; k < lanes; k++) strip(-w + laneW * k, 0.12, WHITE, true);
  } else {
    if (lanes >= 2) {
      strip(-0.11, 0.1, YELLOW, false);
      strip(0.11, 0.1, YELLOW, false);
    }
    const perDir = Math.floor(lanes / 2);
    for (let k = 1; k < perDir; k++) {
      strip(laneW * k, 0.12, WHITE, true);
      strip(-laneW * k, 0.12, WHITE, true);
    }
  }
  if (w > 2) {
    strip(-w + 0.25, 0.12, WHITE, false);
    strip(w - 0.25, 0.12, WHITE, false);
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
