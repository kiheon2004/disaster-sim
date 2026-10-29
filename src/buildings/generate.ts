/**
 * Parametric generator: BuildingSpec → members (deterministic, pure).
 *
 * Layout conventions (building-local, meters):
 *  - origin = footprint center at ground-floor level (y = 0); +x east, +z south (front facade 's')
 *  - story s (0-based) spans [storyBase(s), storyBase(s) + storyHeight(s)] and owns its columns,
 *    walls, windows and doors plus the beams and slab that form its CEILING (level s)
 *  - foundation and slab-on-grade: level −1; roof covering, parapets, gables: level `floors`
 *  - frame systems (rcFrame, steelFrame): column grid of whole bays, beams on every grid line,
 *    one slab panel per bay, non-structural cladding between perimeter columns (+ optional RC
 *    shear-wall core); bearing-wall systems (masonry, wood): perimeter + interior bearing walls,
 *    no columns
 * Member sizes follow simple rules of thumb (column area from the axial load of the floors above,
 * beam depth from span/depth ratios) — plausible proportions, not a design.
 */
import type { Vec3 } from '@/core/types';
import { MATERIALS, type MaterialId } from './materials';
import { OCCUPANCY_MASS, type BuildingMember, type BuildingSpec, type Facade, type StructuralRole } from './types';

export const PARAPET = 0.7;

const round05 = (v: number) => Math.ceil(v * 20 - 1e-9) / 20;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function storyHeight(spec: Pick<BuildingSpec, 'floorHeight' | 'groundFloorHeight'>, s: number): number {
  return s === 0 ? spec.groundFloorHeight : spec.floorHeight;
}
export function storyBase(spec: Pick<BuildingSpec, 'floorHeight' | 'groundFloorHeight'>, s: number): number {
  return s <= 0 ? 0 : spec.groundFloorHeight + (s - 1) * spec.floorHeight;
}
export function totalHeight(spec: Pick<BuildingSpec, 'floorHeight' | 'groundFloorHeight' | 'floors'>): number {
  return storyBase(spec, spec.floors);
}

export const isFrameSystem = (s: BuildingSpec['system']) => s === 'rcFrame' || s === 'steelFrame';

/** Slab / floor thickness by material (m). */
export function slabThickness(m: MaterialId): number {
  switch (m) {
    case 'timber': return 0.25; // joists + deck
    case 'structuralSteel': return 0.16; // composite deck
    case 'masonry': return 0.25;
    default: return 0.2;
  }
}

/** Exterior wall thickness by material (m). */
export function wallThickness(m: MaterialId, bearing: boolean): number {
  switch (m) {
    case 'masonry': return bearing ? 0.3 : 0.22;
    case 'reinforcedConcrete': return bearing ? 0.25 : 0.18;
    case 'timber': return 0.16;
    case 'glass': return 0.1;
    case 'structuralSteel': return 0.1;
    default: return 0.14;
  }
}

/** Grid of the plan: whole bays along x / z. */
export function planGrid(spec: Pick<BuildingSpec, 'width' | 'depth' | 'bay'>) {
  const nx = Math.max(1, Math.round(spec.width / spec.bay));
  const nz = Math.max(1, Math.round(spec.depth / spec.bay));
  const bx = spec.width / nx;
  const bz = spec.depth / nz;
  const xs = Array.from({ length: nx + 1 }, (_, i) => -spec.width / 2 + i * bx);
  const zs = Array.from({ length: nz + 1 }, (_, i) => -spec.depth / 2 + i * bz);
  return { nx, nz, bx, bz, xs, zs };
}

/** Gravity load per m² of floor used to size columns (self weight + superimposed, Pa). */
function floorPressure(spec: BuildingSpec): number {
  const t = slabThickness(spec.slabMaterial);
  const slab = MATERIALS[spec.slabMaterial];
  return (t * slab.density * slab.fill.slab + OCCUPANCY_MASS[spec.occupancy] + 150) * 9.81;
}

/**
 * Column box size (m): axial load of `floorsAbove` floors over a tributary area, and at least a
 * slenderness limit for the story's clear height (rules of thumb, not a design).
 */
export function columnSize(spec: BuildingSpec, floorsAbove: number, trib: number, clear = 3): number {
  const N = floorsAbove * trib * floorPressure(spec) * 1.3; // + walls / beams
  const m = MATERIALS[spec.structureMaterial];
  if (!m.structural) return 0.3;
  switch (spec.structureMaterial) {
    case 'structuralSteel': return clamp(round05(Math.max(clear / 16, Math.sqrt(N / (0.45 * m.compressive) / m.fill.column))), 0.25, 1);
    case 'timber': return clamp(round05(Math.max(clear / 15, Math.sqrt(N / (0.35 * m.compressive)))), 0.2, 0.8);
    case 'masonry': return clamp(round05(Math.max(clear / 10, Math.sqrt(N / (0.3 * m.compressive)))), 0.4, 1.2);
    default: return clamp(round05(Math.max(clear / 12, Math.sqrt(N / (0.35 * m.compressive)))), 0.3, 1.6);
  }
}

/** Beam [width, depth] for a span (m). */
export function beamSection(m: MaterialId, span: number): [number, number] {
  switch (m) {
    case 'structuralSteel': return [0.2, clamp(round05(span / 20), 0.25, 1)];
    case 'timber': return [0.2, clamp(round05(span / 15), 0.25, 1)];
    default: return [0.35, clamp(round05(span / 12), 0.35, 1.4)];
  }
}

/** Outward normal of a facade (local). */
export function facadeNormal(f: Facade): Vec3 {
  return f === 's' ? [0, 0, 1] : f === 'n' ? [0, 0, -1] : f === 'e' ? [1, 0, 0] : [-1, 0, 0];
}
/** Yaw (rad) that turns a member's local +x along the facade (its +z then points outward). */
export function facadeYaw(f: Facade): number {
  return f === 's' ? 0 : f === 'n' ? Math.PI : f === 'e' ? Math.PI / 2 : -Math.PI / 2;
}

interface WallLine {
  facade: Facade;
  /** Endpoints along the facade (world-local x or z values) per bay. */
  bays: [number, number][];
  /** Coordinate of the facade line. */
  at: number;
  axis: 'x' | 'z';
}

function perimeter(spec: BuildingSpec): WallLine[] {
  const g = planGrid(spec);
  const pairs = (v: number[]) => v.slice(0, -1).map((a, i) => [a, v[i + 1]] as [number, number]);
  return [
    { facade: 's', bays: pairs(g.xs), at: spec.depth / 2, axis: 'x' },
    { facade: 'n', bays: pairs(g.xs), at: -spec.depth / 2, axis: 'x' },
    { facade: 'e', bays: pairs(g.zs), at: spec.width / 2, axis: 'z' },
    { facade: 'w', bays: pairs(g.zs), at: -spec.width / 2, axis: 'z' },
  ];
}

const YAW_X = 0;
const YAW_Z = Math.PI / 2;

export interface Generated {
  members: BuildingMember[];
  /** Roof rise above the top slab (m) — for the bounding box. */
  roofHeight: number;
}

/** Generate the full member list from a (validated) spec. */
export function generateMembers(spec: BuildingSpec): Generated {
  const out: BuildingMember[] = [];
  const push = (m: Omit<BuildingMember, 'rotation'> & { rotation?: Vec3 }) => out.push({ rotation: [0, 0, 0], ...m });
  const g = planGrid(spec);
  const frame = isFrameSystem(spec.system);
  const H = totalHeight(spec);
  const tSlab = slabThickness(spec.slabMaterial);
  const sMat = spec.structureMaterial;
  const bearingT = wallThickness(sMat, true);
  const claddingT = wallThickness(spec.claddingMaterial, false);
  // Core walls (frame systems only).
  const core = frame && spec.core ? { cx: Math.min(g.bx, 8, spec.width / 3), cz: Math.min(g.bz, 8, spec.depth / 3) } : null;
  const insideCore = (x: number, z: number) => !!core && Math.abs(x) < core.cx / 2 - 0.05 && Math.abs(z) < core.cz / 2 - 0.05;

  // Column sizes per story (interior tributary area, conservative for edge columns).
  const colB = (s: number) => (frame ? columnSize(spec, spec.floors - s, g.bx * g.bz, storyHeight(spec, s) - tSlab) : 0);
  const [bwX, bdX] = beamSection(sMat, g.bx);
  const [bwZ, bdZ] = beamSection(sMat, g.bz);

  // ── Foundation (level −1) ────────────────────────────────
  const footprint = { w: spec.width + (frame ? colB(0) : bearingT), d: spec.depth + (frame ? colB(0) : bearingT) };
  if (spec.foundation === 'mat' || spec.foundation === 'pile') {
    const t = spec.foundation === 'pile' ? 0.8 : clamp(round05(0.4 + 0.04 * spec.floors), 0.5, 2);
    push({ id: 'fd-mat', type: 'foundation', role: 'foundation', level: -1, position: [0, -t / 2, 0], size: [footprint.w + 0.6, t, footprint.d + 0.6], material: 'reinforcedConcrete' });
    if (spec.foundation === 'pile') {
      const L = clamp(8 + spec.floors * 0.5, 8, 30);
      for (let ix = 0; ix <= g.nx; ix++) {
        for (let iz = 0; iz <= g.nz; iz++) {
          push({ id: `pile-${ix}-${iz}`, type: 'foundation', role: 'foundation', level: -1, position: [g.xs[ix], -0.8 - L / 2, g.zs[iz]], size: [0.6, L, 0.6], material: 'reinforcedConcrete' });
        }
      }
    }
  } else {
    // Spread: pads under columns, strips under bearing walls, slab-on-grade per bay.
    if (frame) {
      for (let ix = 0; ix <= g.nx; ix++) {
        for (let iz = 0; iz <= g.nz; iz++) {
          if (insideCore(g.xs[ix], g.zs[iz])) continue;
          const b = clamp(round05(2.2 * colB(0) + 0.4), 1, 4);
          push({ id: `fd-pad-${ix}-${iz}`, type: 'foundation', role: 'foundation', level: -1, position: [g.xs[ix], -0.15 - 0.3, g.zs[iz]], size: [b, 0.6, b], material: 'reinforcedConcrete' });
        }
      }
    }
    const strip = (id: string, x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      push({ id, type: 'foundation', role: 'foundation', level: -1, position: [(x0 + x1) / 2, -0.15 - 0.25, (z0 + z1) / 2], size: [len + 0.6, 0.5, 0.8], material: 'reinforcedConcrete', rotation: [0, Math.abs(x1 - x0) >= Math.abs(z1 - z0) ? YAW_X : YAW_Z, 0] });
    };
    if (!frame) {
      strip('fd-strip-s', -spec.width / 2, spec.depth / 2, spec.width / 2, spec.depth / 2);
      strip('fd-strip-n', -spec.width / 2, -spec.depth / 2, spec.width / 2, -spec.depth / 2);
      strip('fd-strip-e', spec.width / 2, -spec.depth / 2, spec.width / 2, spec.depth / 2);
      strip('fd-strip-w', -spec.width / 2, -spec.depth / 2, -spec.width / 2, spec.depth / 2);
      for (const line of interiorLines(spec)) strip(`fd-strip-${line.id}`, line.x0, line.z0, line.x1, line.z1);
    }
    if (core) {
      strip('fd-core-n', -core.cx / 2, -core.cz / 2, core.cx / 2, -core.cz / 2);
      strip('fd-core-s', -core.cx / 2, core.cz / 2, core.cx / 2, core.cz / 2);
      strip('fd-core-e', core.cx / 2, -core.cz / 2, core.cx / 2, core.cz / 2);
      strip('fd-core-w', -core.cx / 2, -core.cz / 2, -core.cx / 2, core.cz / 2);
    }
    for (let ix = 0; ix < g.nx; ix++) {
      for (let iz = 0; iz < g.nz; iz++) {
        push({ id: `sog-${ix}-${iz}`, type: 'slab', role: 'secondary', level: -1, position: [g.xs[ix] + g.bx / 2, -0.075, g.zs[iz] + g.bz / 2], size: [g.bx, 0.15, g.bz], material: 'reinforcedConcrete' });
      }
    }
  }

  // ── Stories ──────────────────────────────────────────────
  for (let s = 0; s < spec.floors; s++) {
    const y0 = storyBase(spec, s);
    const h = storyHeight(spec, s);
    const yTop = y0 + h; // top of this story's ceiling slab
    const clear = h - tSlab;
    if (frame) {
      const b = colB(s);
      for (let ix = 0; ix <= g.nx; ix++) {
        for (let iz = 0; iz <= g.nz; iz++) {
          if (insideCore(g.xs[ix], g.zs[iz])) continue;
          push({ id: `c${s}-${ix}-${iz}`, type: 'column', role: 'primary', level: s, position: [g.xs[ix], y0 + clear / 2, g.zs[iz]], size: [b, clear, b], material: sMat });
        }
      }
      // Beams under the ceiling slab on every grid line.
      for (let iz = 0; iz <= g.nz; iz++) {
        for (let ix = 0; ix < g.nx; ix++) {
          const x = g.xs[ix] + g.bx / 2;
          // Beams span between columns: none from a grid point inside the core.
          if (insideCore(x, g.zs[iz]) || insideCore(g.xs[ix], g.zs[iz]) || insideCore(g.xs[ix + 1], g.zs[iz])) continue;
          push({ id: `bx${s}-${ix}-${iz}`, type: 'beam', role: 'primary', level: s, position: [x, yTop - tSlab - bdX / 2, g.zs[iz]], size: [g.bx, bdX, bwX], material: sMat });
        }
      }
      for (let ix = 0; ix <= g.nx; ix++) {
        for (let iz = 0; iz < g.nz; iz++) {
          const z = g.zs[iz] + g.bz / 2;
          if (insideCore(g.xs[ix], z) || insideCore(g.xs[ix], g.zs[iz]) || insideCore(g.xs[ix], g.zs[iz + 1])) continue;
          push({ id: `bz${s}-${ix}-${iz}`, type: 'beam', role: 'primary', level: s, position: [g.xs[ix], yTop - tSlab - bdZ / 2, z], size: [g.bz, bdZ, bwZ], material: sMat, rotation: [0, YAW_Z, 0] });
        }
      }
      if (core) {
        const t = H > 40 ? 0.4 : 0.3;
        push({ id: `wc${s}-n`, type: 'wall', role: 'bearing', level: s, position: [0, y0 + clear / 2, -core.cz / 2], size: [core.cx + t, clear, t], material: 'reinforcedConcrete' });
        push({ id: `wc${s}-s`, type: 'wall', role: 'bearing', level: s, position: [0, y0 + clear / 2, core.cz / 2], size: [core.cx + t, clear, t], material: 'reinforcedConcrete' });
        push({ id: `wc${s}-e`, type: 'wall', role: 'bearing', level: s, position: [core.cx / 2, y0 + clear / 2, 0], size: [core.cz - t, clear, t], material: 'reinforcedConcrete', rotation: [0, YAW_Z, 0] });
        push({ id: `wc${s}-w`, type: 'wall', role: 'bearing', level: s, position: [-core.cx / 2, y0 + clear / 2, 0], size: [core.cz - t, clear, t], material: 'reinforcedConcrete', rotation: [0, YAW_Z, 0] });
      }
    } else {
      // Interior bearing walls (floors span between them).
      for (const line of interiorLines(spec)) {
        const len = Math.hypot(line.x1 - line.x0, line.z1 - line.z0) - bearingT;
        push({ id: `wi${s}-${line.id}`, type: 'wall', role: 'bearing', level: s, position: [(line.x0 + line.x1) / 2, y0 + clear / 2, (line.z0 + line.z1) / 2], size: [len, clear, bearingT], material: sMat, rotation: [0, line.axis === 'x' ? YAW_X : YAW_Z, 0] });
      }
    }

    // Exterior walls: cladding between columns (frames) or bearing walls (wall systems).
    for (const line of perimeter(spec)) {
      line.bays.forEach(([a, b], i) => {
        const role: StructuralRole = frame ? 'cladding' : 'bearing';
        const mat = frame ? spec.claddingMaterial : sMat;
        const t = frame ? claddingT : bearingT;
        const len = frame ? b - a - colB(s) : b - a;
        const mid = (a + b) / 2;
        const pos: Vec3 = line.axis === 'x' ? [mid, y0 + clear / 2, line.at] : [line.at, y0 + clear / 2, mid];
        const id = `w${s}-${line.facade}-${i}`;
        push({ id, type: 'wall', role, level: s, position: pos, size: [Math.max(0.2, len), clear, t], material: mat, rotation: [0, facadeYaw(line.facade), 0], facade: line.facade });
        openings(out, spec, id, line.facade, pos, Math.max(0.2, len), t, y0, clear, s, i, line.bays.length);
      });
    }

    // Ceiling slab panels (the roof slab for the top story; halls under a pitched roof have none).
    const noCeiling = s === spec.floors - 1 && spec.roof !== 'flat' && !spec.ceiling;
    for (let ix = 0; ix < g.nx && !noCeiling; ix++) {
      for (let iz = 0; iz < g.nz; iz++) {
        push({ id: `sl${s}-${ix}-${iz}`, type: 'slab', role: 'secondary', level: s, position: [g.xs[ix] + g.bx / 2, yTop - tSlab / 2, g.zs[iz] + g.bz / 2], size: [g.bx, tSlab, g.bz], material: spec.slabMaterial });
      }
    }
  }

  // ── Roof (level = floors) ────────────────────────────────
  const roofHeight = roof(out, spec, g, H);
  return { members: out, roofHeight };
}

interface Line { id: string; axis: 'x' | 'z'; x0: number; z0: number; x1: number; z1: number }

/**
 * Interior bearing-wall lines of wall systems: every interior grid line along the long
 * direction (floors span between them) and the middle line across it (cross walls brace the
 * short direction).
 */
export function interiorLines(spec: BuildingSpec): Line[] {
  const g = planGrid(spec);
  const out: Line[] = [];
  const alongX = spec.width >= spec.depth;
  if (alongX) {
    for (let iz = 1; iz < g.nz; iz++) out.push({ id: `x${iz}`, axis: 'x', x0: -spec.width / 2, z0: g.zs[iz], x1: spec.width / 2, z1: g.zs[iz] });
    if (g.nx >= 2) {
      const ix = Math.floor(g.nx / 2);
      out.push({ id: `z${ix}`, axis: 'z', x0: g.xs[ix], z0: -spec.depth / 2, x1: g.xs[ix], z1: spec.depth / 2 });
    }
  } else {
    for (let ix = 1; ix < g.nx; ix++) out.push({ id: `z${ix}`, axis: 'z', x0: g.xs[ix], z0: -spec.depth / 2, x1: g.xs[ix], z1: spec.depth / 2 });
    if (g.nz >= 2) {
      const iz = Math.floor(g.nz / 2);
      out.push({ id: `x${iz}`, axis: 'x', x0: -spec.width / 2, z0: g.zs[iz], x1: spec.width / 2, z1: g.zs[iz] });
    }
  }
  return out;
}

/** Door width × height by occupancy (m). */
function doorSize(spec: BuildingSpec, clear: number): [number, number] {
  switch (spec.occupancy) {
    case 'storage':
    case 'industrial':
      return [4, Math.min(4.5, clear - 0.4)];
    case 'office':
      return [2, Math.min(2.4, clear - 0.3)];
    default:
      return [1, Math.min(2.1, clear - 0.3)];
  }
}

/** Windows (and the front door) hosted by an exterior wall panel. */
function openings(out: BuildingMember[], spec: BuildingSpec, host: string, facade: Facade, wallPos: Vec3, len: number, t: number, y0: number, clear: number, s: number, bay: number, bays: number) {
  const n = facadeNormal(facade);
  const yaw = facadeYaw(facade);
  const off = t / 2 + 0.03;
  /** Point `along` m from the wall center along the facade, at height y. */
  const at = (along: number, y: number): Vec3 => {
    // Facade +x direction after yaw: s → +x, n → −x, e → −z, w → +z.
    const dx = Math.cos(yaw);
    const dz = -Math.sin(yaw);
    return [wallPos[0] + dx * along + n[0] * off, y, wallPos[2] + dz * along + n[2] * off];
  };
  let free = len;
  let doorAlong: number | null = null;
  if (s === 0 && facade === 's' && bay === Math.floor((bays - 1) / 2)) {
    const [dw, dh] = doorSize(spec, clear);
    const w = Math.min(dw, len - 0.4);
    if (w > 0.6) {
      doorAlong = 0;
      out.push({ id: 'door-0', type: 'door', role: 'opening', level: 0, position: at(0, y0 + dh / 2), rotation: [0, yaw, 0], size: [w, dh, 0.08], material: spec.occupancy === 'residential' ? 'timber' : 'lightCladding', host, facade });
      free = (len - w) / 2 - 0.3;
    }
  }
  const density = Math.max(0, Math.min(0.9, spec.windowDensity));
  if (density <= 0.01 || clear < 1.6) return;
  const area = density * len * clear;
  const glass: MaterialId = 'glass';
  const style = spec.facade;
  const wh = style === 'curtain' ? clear - 0.3 : style === 'ribbon' ? Math.min(1.3, clear * 0.45) : Math.min(1.5, clear * 0.5);
  const sill = style === 'curtain' ? 0.15 : Math.min(0.9, (clear - wh) / 2);
  const y = y0 + sill + wh / 2;
  const place = (center: number, width: number, k: number) =>
    out.push({ id: `win${s}-${facade}-${bay}-${k}`, type: 'window', role: 'opening', level: s, position: at(center, y), rotation: [0, yaw, 0], size: [width, wh, 0.06], material: glass, host, facade });
  if (doorAlong !== null) {
    // Shopfront / house: one window on each side of the door if there is room.
    if (free > 0.8) {
      const w = Math.min(free, Math.max(0.8, area / wh / 2));
      const c = len / 2 - 0.15 - free / 2;
      place(-c, w, 0);
      place(c, w, 1);
    }
    return;
  }
  if (style === 'punched') {
    const unit = 1.2;
    const count = Math.max(1, Math.min(Math.floor((len - 0.3) / (unit + 0.4)), Math.round(area / (unit * wh))));
    const spacing = len / count;
    for (let k = 0; k < count; k++) place(-len / 2 + spacing * (k + 0.5), unit, k);
  } else {
    const w = Math.min(len - 0.2, area / wh);
    if (w > 0.4) place(0, w, 0);
  }
}

/** Roof covering, parapets and gable ends. Returns the rise above the top slab (m). */
function roof(out: BuildingMember[], spec: BuildingSpec, g: ReturnType<typeof planGrid>, H: number): number {
  const L = spec.floors;
  const covering: MaterialId = spec.system === 'wood' ? 'timber' : 'lightCladding';
  if (spec.roof === 'flat') {
    for (let ix = 0; ix < g.nx; ix++) {
      for (let iz = 0; iz < g.nz; iz++) {
        out.push({ id: `rf-${ix}-${iz}`, type: 'roof', role: 'roofing', level: L, position: [g.xs[ix] + g.bx / 2, H + 0.05, g.zs[iz] + g.bz / 2], rotation: [0, 0, 0], size: [g.bx - 0.06, 0.1, g.bz - 0.06], material: 'lightCladding' });
      }
    }
    if (spec.occupancy !== 'residential' || spec.floors > 2) {
      for (const line of perimeter(spec)) {
        line.bays.forEach(([a, b], i) => {
          const mid = (a + b) / 2;
          const pos: Vec3 = line.axis === 'x' ? [mid, H + PARAPET / 2, line.at] : [line.at, H + PARAPET / 2, mid];
          out.push({ id: `pp-${line.facade}-${i}`, type: 'wall', role: 'cladding', level: L, position: pos, rotation: [0, facadeYaw(line.facade), 0], size: [b - a, PARAPET, 0.2], material: spec.system === 'wood' ? 'timber' : spec.claddingMaterial === 'glass' ? 'lightCladding' : spec.claddingMaterial, facade: line.facade });
        });
      }
      return PARAPET;
    }
    return 0.1;
  }
  const pitch = (Math.max(3, Math.min(60, spec.roofPitch)) * Math.PI) / 180;
  const alongX = spec.width >= spec.depth; // ridge direction
  const span = alongX ? spec.depth : spec.width;
  const overhang = 0.4;
  const t = 0.2;
  const bays = alongX ? g.nx : g.nz;
  const bayLen = alongX ? g.bx : g.bz;
  const start = alongX ? g.xs[0] : g.zs[0];
  if (spec.roof === 'gable') {
    const half = span / 2 + overhang;
    const rise = (span / 2) * Math.tan(pitch);
    const slope = half / Math.cos(pitch);
    for (let i = 0; i < bays; i++) {
      const c = start + bayLen * (i + 0.5);
      for (const side of [1, -1]) {
        const off = side * (half / 2);
        const y = H + rise - (half / 2) * Math.tan(pitch) + t / 2;
        const pos: Vec3 = alongX ? [c, y, off] : [off, y, c];
        const rot: Vec3 = alongX ? [side * pitch, 0, 0] : [0, 0, -side * pitch];
        const size: Vec3 = alongX ? [bayLen + (i === 0 || i === bays - 1 ? overhang : 0), t, slope] : [slope, t, bayLen + (i === 0 || i === bays - 1 ? overhang : 0)];
        out.push({ id: `rg-${i}-${side > 0 ? 'a' : 'b'}`, type: 'roof', role: 'roofing', level: L, position: pos, rotation: rot, size, material: covering });
      }
    }
    // Stepped gable ends (voxel style) on the two end facades.
    const ends: Facade[] = alongX ? ['e', 'w'] : ['s', 'n'];
    const steps = 3;
    for (const f of ends) {
      const at = f === 'e' ? spec.width / 2 : f === 'w' ? -spec.width / 2 : f === 's' ? spec.depth / 2 : -spec.depth / 2;
      for (let k = 0; k < steps; k++) {
        const w = span * (1 - (k + 0.5) / steps);
        const hh = rise / steps;
        const y = H + hh * (k + 0.5);
        const pos: Vec3 = f === 'e' || f === 'w' ? [at, y, 0] : [0, y, at];
        out.push({ id: `gb-${f}-${k}`, type: 'wall', role: 'cladding', level: L, position: pos, rotation: [0, facadeYaw(f), 0], size: [Math.max(0.3, w), hh, wallThickness(spec.claddingMaterial === 'glass' ? 'lightCladding' : spec.claddingMaterial, false)], material: spec.claddingMaterial === 'glass' ? 'lightCladding' : spec.claddingMaterial, facade: f });
      }
    }
    return rise + t;
  }
  // Shed: one slope across the short span, high side at −z (or −x).
  const full = span + overhang;
  const rise = span * Math.tan(pitch);
  const slope = full / Math.cos(pitch);
  for (let i = 0; i < bays; i++) {
    const c = start + bayLen * (i + 0.5);
    const y = H + rise / 2 + t / 2;
    const pos: Vec3 = alongX ? [c, y, overhang / 2] : [overhang / 2, y, c];
    const rot: Vec3 = alongX ? [pitch, 0, 0] : [0, 0, -pitch];
    const size: Vec3 = alongX ? [bayLen, t, slope] : [slope, t, bayLen];
    out.push({ id: `rs-${i}`, type: 'roof', role: 'roofing', level: L, position: pos, rotation: rot, size, material: covering });
  }
  return rise + t;
}
