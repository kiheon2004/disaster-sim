/**
 * Phase 37 — the command preview's own markings as three.js objects (ghost objects, disaster pins, the terrain heat
 * map and snap markers are drawn by the existing renderers; this file is what had no renderer for a LIST of things):
 *
 *   removed objects   red box, filled, solid edges, a cross on its top
 *   changed objects   teal plate under the object, dashed edges
 *   moved objects     the old footprint and an arrow to the new place
 *   rejected items    a red cross on the ground with a post
 *   roads             ribbon + centre / edge lines (new), crossed-out lines (removed)
 *   highlights        white boxes, lines, ground rings
 *
 * Every kind differs from the others by SHAPE or PATTERN as well as by colour (spec §14). One instanced mesh / one line
 * object per kind whatever the count — a delete preview of 2000 objects is two draw calls, not 2000 components.
 * Nothing here is picked (`raycast` is a no-op) and nothing reads or writes a store.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxMark, GroundMark, HighlightMarks, PinMark, RingMark, RoadMark } from './previewModel';

export type HeightAt = (x: number, z: number) => number;

export const MARK_COLORS = {
  removed: '#ff5a5a',
  changed: '#37d6c0',
  moved: '#a9c8ff',
  rejected: '#ff5a5a',
  roadAdded: '#8fb8ff',
  roadRemoved: '#ff5a5a',
  highlight: '#ffffff',
} as const;

/** A draft plan (while typing) is drawn at this share of the open plan's opacity. */
export const DRAFT_STRENGTH = 0.6;

const noPick = () => {};

/** The objects of one kind of marking, with what must be freed when they go. */
export class MarkSet {
  readonly objects: THREE.Object3D[] = [];
  private readonly materials: { m: THREE.Material; base: number }[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  add<T extends THREE.Mesh | THREE.LineSegments>(o: T): T {
    o.raycast = noPick;
    o.frustumCulled = false;
    this.objects.push(o);
    this.geometries.push(o.geometry);
    const m = o.material as THREE.Material;
    this.materials.push({ m, base: m.opacity });
    return o;
  }

  /** 1 = the open plan, DRAFT_STRENGTH = a draft: opacity only, nothing is rebuilt. */
  setStrength(k: number) {
    for (const x of this.materials) x.m.opacity = x.base * k;
  }

  get empty() {
    return this.objects.length === 0;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const x of this.materials) x.m.dispose();
    for (const o of this.objects) if (o instanceof THREE.InstancedMesh) o.dispose();
  }
}

// ── Box maths ────────────────────────────────────────────────────────────────────────

const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), E = new THREE.Euler(), M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), V = new THREE.Vector3();

/** The object's frame: translation · rotation (no scale — a BoxMark's size already has it). */
function frame(b: BoxMark, out: THREE.Matrix4): THREE.Matrix4 {
  Q.setFromEuler(E.set(b.rotation[0], b.rotation[1], b.rotation[2], 'XYZ'));
  return out.compose(P.set(b.position[0], b.position[1], b.position[2]), Q, S);
}

/** Unit cube (centred) → the object's bounding box, padded: the box stands on the object's origin. */
export function boxMatrix(b: BoxMark, pad: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  frame(b, out);
  out.multiply(M2.makeTranslation(0, b.size[1] / 2, 0));
  return out.multiply(M2.makeScale(b.size[0] + pad, b.size[1] + pad, b.size[2] + pad));
}

/** Unit cube → a thin plate under the object (its footprint, padded). */
export function plateMatrix(b: BoxMark, pad: number, thickness: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  frame(b, out);
  out.multiply(M2.makeTranslation(0, thickness / 2 + 0.03, 0));
  return out.multiply(M2.makeScale(b.size[0] + pad, thickness, b.size[2] + pad));
}

/** Corner k of the unit cube: bit 0 = +x, bit 1 = +z, bit 2 = +y. */
const corner = (k: number, m: THREE.Matrix4, out: number[]) => {
  V.set(k & 1 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5).applyMatrix4(m);
  out.push(V.x, V.y, V.z);
};
const BOTTOM = [0, 1, 1, 3, 3, 2, 2, 0], TOP = [4, 5, 5, 7, 7, 6, 6, 4], POSTS = [0, 4, 1, 5, 2, 6, 3, 7], CROSS = [4, 7, 5, 6];
export const BOX_EDGE_VERTICES = 24;
export const BOX_CROSS_VERTICES = 4;

/** Line-segment vertices (pairs) of the boxes' 12 edges; with `cross`, a cross over each top face as well. */
export function boxEdges(boxes: readonly BoxMark[], pad: number, cross = false): Float32Array {
  const out: number[] = [];
  const order = cross ? [...BOTTOM, ...TOP, ...POSTS, ...CROSS] : [...BOTTOM, ...TOP, ...POSTS];
  for (const b of boxes) {
    boxMatrix(b, pad, M);
    for (const k of order) corner(k, M, out);
  }
  return new Float32Array(out);
}

/** The four base corners of a box's footprint (a → b → c → d around it), lifted a little. */
function footprintCorners(b: BoxMark, pad: number, lift: number): THREE.Vector3[] {
  frame(b, M);
  const hx = (b.size[0] + pad) / 2, hz = (b.size[2] + pad) / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => new THREE.Vector3(x, lift, z).applyMatrix4(M));
}

const seg = (out: number[], a: THREE.Vector3, b: THREE.Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z);

/** Length of the arrow head at a moved object's new place (m). */
const ARROW = 0.9;

/**
 * Moved objects: the old footprint (where the object stands now) and a line from its middle to the middle of the new
 * place, ending in an arrow head. Vertices of line segments.
 */
export function moveLinks(moved: readonly { from: BoxMark; to: BoxMark }[]): Float32Array {
  const out: number[] = [];
  for (const m of moved) {
    const c = footprintCorners(m.from, 0.3, 0.08);
    for (let k = 0; k < 4; k++) seg(out, c[k], c[(k + 1) % 4]);
    const a = new THREE.Vector3(m.from.position[0], m.from.position[1] + 0.08, m.from.position[2]);
    const b = new THREE.Vector3(m.to.position[0], m.to.position[1] + 0.08, m.to.position[2]);
    seg(out, a, b);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    if (l > 1e-3) {
      // Two barbs in the ground plane, 28° either side of the line.
      const ux = dx / l, uz = dz / l, n = Math.min(ARROW, l / 2), cos = Math.cos(0.49), sin = Math.sin(0.49);
      for (const s of [1, -1]) seg(out, b, new THREE.Vector3(b.x - n * (ux * cos - s * uz * sin), b.y, b.z - n * (uz * cos + s * ux * sin)));
    }
  }
  return new Float32Array(out);
}

// ── Lines on the ground ──────────────────────────────────────────────────────────────

const LIFT = 0.16;
const RING_SEGMENTS = 40;

/** Ground rings (a road node / a point): a draped circle; a point also gets a small plus at its middle. */
export function ringLines(rings: readonly RingMark[], y: HeightAt): Float32Array {
  const out: number[] = [];
  for (const r of rings) {
    let px = r.x + r.r, pz = r.z;
    for (let k = 1; k <= RING_SEGMENTS; k++) {
      const a = (k / RING_SEGMENTS) * Math.PI * 2;
      const x = r.x + Math.cos(a) * r.r, z = r.z + Math.sin(a) * r.r;
      out.push(px, y(px, pz) + LIFT, pz, x, y(x, z) + LIFT, z);
      px = x; pz = z;
    }
    if (r.of === 'point') {
      const h = y(r.x, r.z) + LIFT, d = r.r * 0.45;
      out.push(r.x - d, h, r.z, r.x + d, h, r.z, r.x, h, r.z - d, r.x, h, r.z + d);
    }
  }
  return new Float32Array(out);
}

/** Left / right edge points of a road mark (half the carriageway either side of each centre point). */
function roadEdges(r: RoadMark): { left: [number, number][]; right: [number, number][] } {
  const left: [number, number][] = [], right: [number, number][] = [];
  const n = r.points.length;
  for (let k = 0; k < n; k++) {
    const a = r.points[Math.max(0, k - 1)], b = r.points[Math.min(n - 1, k + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l, h = r.width / 2;
    // (right of travel = (−tz, tx))
    left.push([r.points[k][0] + tz * h, r.points[k][1] - tx * h]);
    right.push([r.points[k][0] - tz * h, r.points[k][1] + tx * h]);
  }
  return { left, right };
}

/** Points between crosses along a removed road (about one cross per this many metres). */
const CROSS_EVERY = 6;

/**
 * Roads as lines on the ground: centre line, both edges and the two ends; `crossed` adds a cross over the carriageway
 * every few metres (a removed road). Vertices of line segments.
 */
export function roadLines(roads: readonly RoadMark[], y: HeightAt, crossed = false): Float32Array {
  const out: number[] = [];
  const put = (a: readonly [number, number], b: readonly [number, number]) => out.push(a[0], y(a[0], a[1]) + LIFT, a[1], b[0], y(b[0], b[1]) + LIFT, b[1]);
  for (const r of roads) {
    const n = r.points.length;
    if (n < 2) continue;
    const { left, right } = roadEdges(r);
    for (let k = 1; k < n; k++) {
      put(r.points[k - 1], r.points[k]);
      put(left[k - 1], left[k]);
      put(right[k - 1], right[k]);
    }
    put(left[0], right[0]);
    put(left[n - 1], right[n - 1]);
    if (crossed) {
      for (let k = 0; k + 2 < n; k += CROSS_EVERY) {
        const e = Math.min(n - 1, k + 2);
        put(left[k], right[e]);
        put(right[k], left[e]);
      }
    }
  }
  return new Float32Array(out);
}

/** The carriageways as one triangle sheet draped on the ground (non-indexed: 6 vertices per metre of road). */
export function roadRibbon(roads: readonly RoadMark[], y: HeightAt): Float32Array {
  const out: number[] = [];
  const v = (p: readonly [number, number]) => out.push(p[0], y(p[0], p[1]) + LIFT - 0.04, p[1]);
  for (const r of roads) {
    if (r.points.length < 2) continue;
    const { left, right } = roadEdges(r);
    for (let k = 1; k < r.points.length; k++) {
      v(left[k - 1]); v(left[k]); v(right[k - 1]);
      v(right[k - 1]); v(left[k]); v(right[k]);
    }
  }
  return new Float32Array(out);
}

/** A straight line on the ground from a to b in ~2 m pieces (a disaster pin's move), with an arrow head at b. */
export function groundArrow(a: readonly [number, number], b: readonly [number, number], y: HeightAt): Float32Array {
  const out: number[] = [];
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
  if (l < 1e-3) return new Float32Array(0);
  const n = Math.max(1, Math.ceil(l / 2));
  const at = (k: number): [number, number] => [a[0] + (dx * k) / n, a[1] + (dz * k) / n];
  for (let k = 1; k <= n; k++) {
    const p = at(k - 1), q = at(k);
    out.push(p[0], y(p[0], p[1]) + LIFT, p[1], q[0], y(q[0], q[1]) + LIFT, q[1]);
  }
  const ux = dx / l, uz = dz / l, len = Math.min(2.2, l / 2), cos = Math.cos(0.49), sin = Math.sin(0.49), by = y(b[0], b[1]) + LIFT;
  for (const s of [1, -1]) {
    const x = b[0] - len * (ux * cos - s * uz * sin), z = b[1] - len * (uz * cos + s * ux * sin);
    out.push(b[0], by, b[1], x, y(x, z) + LIFT, z);
  }
  return new Float32Array(out);
}

// ── Objects ──────────────────────────────────────────────────────────────────────────

interface LineStyle {
  color: string;
  opacity?: number;
  dashed?: boolean;
  order?: number;
}

/** One LineSegments object for any number of segments (drawn over everything, like the selection outline). */
export function lineObject(positions: Float32Array, style: LineStyle): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const common = { color: style.color, transparent: true, opacity: style.opacity ?? 0.95, depthTest: false };
  const m = style.dashed ? new THREE.LineDashedMaterial({ ...common, dashSize: 0.55, gapSize: 0.4 }) : new THREE.LineBasicMaterial(common);
  const l = new THREE.LineSegments(g, m);
  if (style.dashed) l.computeLineDistances();
  l.renderOrder = style.order ?? 11;
  return l;
}

/** One instanced unit cube per box, placed by `matrixOf`. */
function boxInstances(boxes: readonly BoxMark[], matrixOf: (b: BoxMark, out: THREE.Matrix4) => THREE.Matrix4, color: string, opacity: number, order: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    boxes.length,
  );
  const m = new THREE.Matrix4();
  boxes.forEach((b, k) => mesh.setMatrixAt(k, matrixOf(b, m)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = order;
  return mesh;
}

const BOX_PAD = 0.2;

/** Removed objects: a filled red box over each, its edges, a cross on its top. */
export function removedMarks(boxes: readonly BoxMark[]): MarkSet {
  const set = new MarkSet();
  if (!boxes.length) return set;
  set.add(boxInstances(boxes, (b, out) => boxMatrix(b, BOX_PAD, out), MARK_COLORS.removed, 0.3, 9));
  set.add(lineObject(boxEdges(boxes, BOX_PAD, true), { color: MARK_COLORS.removed }));
  return set;
}

/** Changed (not moved) objects: a teal plate under each and dashed edges around it. */
export function changedMarks(boxes: readonly BoxMark[]): MarkSet {
  const set = new MarkSet();
  if (!boxes.length) return set;
  set.add(boxInstances(boxes, (b, out) => plateMatrix(b, 0.9, 0.1, out), MARK_COLORS.changed, 0.5, 9));
  set.add(lineObject(boxEdges(boxes, BOX_PAD), { color: MARK_COLORS.changed, dashed: true }));
  return set;
}

/** Moved objects: old footprint + arrow to the new place (the object itself is a ghost at the new place). */
export function movedMarks(moved: readonly { from: BoxMark; to: BoxMark }[]): MarkSet {
  const set = new MarkSet();
  if (moved.length) set.add(lineObject(moveLinks(moved), { color: MARK_COLORS.moved, opacity: 0.9 }));
  return set;
}

/** A cross lying on the ground (two bars) with a post and a block on top: "nothing is placed here". */
function rejectGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const a of [Math.PI / 4, -Math.PI / 4]) parts.push(new THREE.BoxGeometry(2.6, 0.14, 0.34).rotateY(a).translate(0, 0.12, 0));
  parts.push(new THREE.BoxGeometry(0.12, 2.6, 0.12).translate(0, 1.3, 0));
  parts.push(new THREE.BoxGeometry(0.42, 0.42, 0.42).rotateY(Math.PI / 4).translate(0, 2.7, 0));
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

export function rejectedMarks(marks: readonly GroundMark[], y: HeightAt): MarkSet {
  const set = new MarkSet();
  if (!marks.length) return set;
  const mesh = new THREE.InstancedMesh(rejectGeometry(), new THREE.MeshBasicMaterial({ color: MARK_COLORS.rejected, transparent: true, opacity: 0.92, depthTest: false }), marks.length);
  marks.forEach((p, k) => mesh.setMatrixAt(k, M.makeTranslation(p.x, y(p.x, p.z), p.z)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 12;
  set.add(mesh);
  return set;
}

/** New roads (ribbon + lines) and removed roads (crossed-out lines), draped on the ground as it is now. */
export function roadMarks(added: readonly RoadMark[], removed: readonly RoadMark[], y: HeightAt): MarkSet {
  const set = new MarkSet();
  if (added.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(roadRibbon(added, y), 3));
    const ribbon = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: MARK_COLORS.roadAdded, transparent: true, opacity: 0.34, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    ribbon.renderOrder = 9;
    set.add(ribbon);
    set.add(lineObject(roadLines(added, y), { color: MARK_COLORS.roadAdded }));
  }
  if (removed.length) set.add(lineObject(roadLines(removed, y, true), { color: MARK_COLORS.roadRemoved }));
  return set;
}

/** What a plan / a question points at: white boxes (filled faintly), road lines, ground rings. Pins are the pin layer's. */
export function highlightSet(h: HighlightMarks, y: HeightAt): MarkSet {
  const set = new MarkSet();
  if (h.boxes.length) {
    set.add(boxInstances(h.boxes, (b, out) => boxMatrix(b, 0.34, out), MARK_COLORS.highlight, 0.16, 10));
    set.add(lineObject(boxEdges(h.boxes, 0.34), { color: MARK_COLORS.highlight, order: 13 }));
  }
  const lines: Float32Array[] = [];
  if (h.lines.length) lines.push(roadLines(h.lines, y));
  if (h.rings.length) lines.push(ringLines(h.rings, y));
  if (lines.length) {
    const all = new Float32Array(lines.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of lines) { all.set(a, at); at += a.length; }
    set.add(lineObject(all, { color: MARK_COLORS.highlight, order: 13 }));
  }
  return set;
}

/** Arrows on the ground from where moved disaster pins are to where the plan puts them. */
export function pinLinks(pins: readonly PinMark[], y: HeightAt): MarkSet {
  const set = new MarkSet();
  const parts = pins.filter((p) => p.state === 'changed' && p.from).map((p) => groundArrow(p.from!, p.at, y)).filter((a) => a.length > 0);
  if (!parts.length) return set;
  const all = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of parts) { all.set(a, at); at += a.length; }
  set.add(lineObject(all, { color: MARK_COLORS.moved, opacity: 0.9 }));
  return set;
}
