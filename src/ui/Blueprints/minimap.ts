/**
 * Top-down map pictures (Phase 20) of blueprints and worlds for library cards and the world
 * creation wizard: a 2D canvas (no WebGL context, a few milliseconds) — hill-shaded ground in
 * its surface colours, water, roads, building footprints and trees.
 */
import type { WorldDocument } from '@/core/model';
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';
import { getDefinition } from '@/objects/registry';
import { designParams } from '@/buildings/design';
import { centerlineOf, type P2 } from '@/roads/curve';
import { segmentLine } from '@/roads/network';
import { featureLine } from '@/landscape/features';
import type { Feature, LakeFeature, RiverFeature } from '@/landscape/types';
import { yawOf } from '@/terrain/groundPlacement';
import { decodeLayers } from '@/blueprints/place';
import type { UnifiedBlueprint } from '@/blueprints/types';

const GROUND = GROUND_MATERIALS.map((m) => hex(m.color));
function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const WATER = 'rgba(56,128,200,0.85)';
const ROAD = '#3d4248';
const BUILDING = '#e6e2d8';
const BUILDING_EDGE = '#1d2329';
const TREE = '#2f6b2a';

interface View { x0: number; z0: number; scale: number; size: number }

function canvas(size: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c.getContext('2d');
}

/** Hill-shaded raster of a height grid (local or world coordinates). */
function shade(ctx: CanvasRenderingContext2D, v: View, at: (x: number, z: number) => { h: number; g: number } | null) {
  const img = ctx.createImageData(v.size, v.size);
  const step = 1 / v.scale;
  for (let py = 0; py < v.size; py++) {
    for (let px = 0; px < v.size; px++) {
      const x = v.x0 + (px + 0.5) * step, z = v.z0 + (py + 0.5) * step;
      const s = at(x, z);
      const k = (py * v.size + px) * 4;
      if (!s) { img.data[k + 3] = 0; continue; }
      const e = at(x + step, z), n = at(x, z - step);
      const dx = e ? e.h - s.h : 0, dz = n ? s.h - n.h : 0;
      const light = Math.max(0.55, Math.min(1.25, 1 + (-dx * 0.9 + dz * 0.9) / step * 0.35));
      const c = GROUND[s.g] ?? GROUND[0];
      img.data[k] = Math.min(255, c[0] * light);
      img.data[k + 1] = Math.min(255, c[1] * light);
      img.data[k + 2] = Math.min(255, c[2] * light);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const toPx = (v: View, x: number, z: number): P2 => [(x - v.x0) * v.scale, (z - v.z0) * v.scale];

function features(ctx: CanvasRenderingContext2D, v: View, list: readonly Feature[]) {
  for (const f of list) {
    if (f.kind === 'lake') {
      ctx.fillStyle = WATER;
      ctx.beginPath();
      (f as LakeFeature).points.forEach(([x, z], i) => { const [a, b] = toPx(v, x, z); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      ctx.closePath();
      ctx.fill();
    } else if (f.kind === 'river') {
      ctx.strokeStyle = WATER;
      ctx.lineWidth = Math.max(1.5, (f as RiverFeature).width * v.scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      featureLine(f as RiverFeature).samples.forEach((p, i) => { const [a, b] = toPx(v, p.x, p.z); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      ctx.stroke();
    }
  }
}

function roadLine(ctx: CanvasRenderingContext2D, v: View, pts: readonly { x: number; z: number }[], width: number) {
  ctx.strokeStyle = ROAD;
  ctx.lineWidth = Math.max(1.5, width * v.scale);
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => { const [a, b] = toPx(v, p.x, p.z); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
  ctx.stroke();
}

function footprint(ctx: CanvasRenderingContext2D, v: View, x: number, z: number, w: number, d: number, yaw: number, tree: boolean) {
  const [px, pz] = toPx(v, x, z);
  if (tree) {
    ctx.fillStyle = TREE;
    ctx.beginPath();
    ctx.arc(px, pz, Math.max(1.2, 2.2 * v.scale), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.translate(px, pz);
  ctx.rotate(-yaw);
  ctx.fillStyle = BUILDING;
  ctx.strokeStyle = BUILDING_EDGE;
  ctx.lineWidth = 0.8;
  const W = Math.max(1.5, w * v.scale), D = Math.max(1.5, d * v.scale);
  ctx.fillRect(-W / 2, -D / 2, W, D);
  ctx.strokeRect(-W / 2, -D / 2, W, D);
  ctx.restore();
}

/** Picture of a blueprint in its local frame. */
export function blueprintThumbnail(bp: UnifiedBlueprint, size = 160): string | null {
  const ctx = canvas(size);
  if (!ctx) return null;
  const [bx0, bz0, bx1, bz1] = bp.preview.bounds;
  const span = Math.max(8, bx1 - bx0, bz1 - bz0) * 1.08;
  const v: View = { x0: (bx0 + bx1) / 2 - span / 2, z0: (bz0 + bz1) / 2 - span / 2, scale: size / span, size };
  ctx.fillStyle = '#1b2026';
  ctx.fillRect(0, 0, size, size);
  const layers = decodeLayers(bp);
  if (layers?.surface) {
    const g = layers.grid;
    shade(ctx, v, (x, z) => {
      const ix = Math.round((x - g.x0) / g.cell), iz = Math.round((z - g.z0) / g.cell);
      if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return null;
      const i = iz * g.nx + ix;
      if (layers.mask && !layers.mask[i]) return null;
      const p = layers.paint?.[i];
      return { h: layers.surface![i], g: p !== undefined && p !== 255 ? p : layers.ground?.[i] ?? 0 };
    });
  } else {
    ctx.fillStyle = 'rgb(95,143,67)';
    ctx.beginPath();
    bp.area.forEach(([x, z], i) => { const [a, b] = toPx(v, x, z); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
    ctx.closePath();
    ctx.fill();
  }
  features(ctx, v, bp.features);
  const nodes = new Map(bp.roads.nodes.map((n) => [n.id, n]));
  for (const s of bp.roads.segments) {
    const a = nodes.get(s.a)!, b = nodes.get(s.b)!;
    roadLine(ctx, v, centerlineOf([[a.x, a.z], ...s.control, [b.x, b.z]]).samples, s.profile.width);
  }
  for (const o of [...bp.vegetation, ...bp.objects]) {
    const p = o.design ? designParams(bp.designs[o.design]) : o.params!;
    const d = getDefinition(o.type).getDimensions(p);
    if (getDefinition(o.type).groundLayer) continue;
    footprint(ctx, v, o.offset[0], o.offset[2], d[0] * o.scale[0], d[2] * o.scale[2], yawOf(o.rotation), o.type === 'tree');
  }
  return ctx.canvas.toDataURL('image/png');
}

/** Picture of a whole world. */
export function worldThumbnail(doc: WorldDocument, size = 160): string | null {
  const ctx = canvas(size);
  if (!ctx) return null;
  const t = doc.terrain;
  const span = (t.nx - 1) * t.cellSize;
  const v: View = { x0: t.originX, z0: t.originZ, scale: size / span, size };
  const sea = t.settings.waterLevel;
  shade(ctx, v, (x, z) => {
    const ix = Math.round((x - t.originX) / t.cellSize), iz = Math.round((z - t.originZ) / t.cellSize);
    if (ix < 0 || iz < 0 || ix >= t.nx || iz >= t.nz) return null;
    const i = iz * t.nx + ix;
    return { h: t.heights[i], g: t.ground[i] };
  });
  if (sea !== null) {
    // Sea: ground below the reference level, drawn over the shading.
    ctx.fillStyle = WATER;
    const step = Math.max(1, Math.round(span / size));
    for (let iz = 0; iz < t.nz; iz += step) for (let ix = 0; ix < t.nx; ix += step) {
      if (t.heights[iz * t.nx + ix] >= sea) continue;
      const [a, b] = toPx(v, t.originX + ix * t.cellSize, t.originZ + iz * t.cellSize);
      ctx.fillRect(a, b, Math.ceil(step * v.scale), Math.ceil(step * v.scale));
    }
  }
  features(ctx, v, doc.landscape.features);
  for (const s of Object.values(doc.roads.segments)) roadLine(ctx, v, segmentLine(doc.roads, s).samples, s.profile.width);
  for (const o of Object.values(doc.objects)) {
    const def = getDefinition(o.type);
    if (def.groundLayer) continue;
    const d = def.getDimensions(o.params);
    footprint(ctx, v, o.transform.position[0], o.transform.position[2], d[0] * o.transform.scale[0], d[2] * o.transform.scale[2], yawOf(o.transform.rotation), o.type === 'tree');
  }
  return ctx.canvas.toDataURL('image/png');
}
