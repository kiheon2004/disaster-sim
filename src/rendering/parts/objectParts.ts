/**
 * Voxel part lists for every object type — pure functions shared by the editor views (React,
 * one merged mesh per part group) and the simulation render adapter (batched instancing), so
 * both modes draw exactly the same shapes.
 *
 * Each builder returns the part groups that move independently (e.g. a tree's stump vs. its
 * swaying upper part) plus simplified variants for distant rendering (rendering-only LOD).
 */
import type { Vec3 } from '@/core/types';
import type { ComponentKind, ComponentSpec } from '@/core/model';
import { seededRandom } from '@/core/math';
import { SNAP_FRACTION, trunkHeight, type TreeParams } from '@/objects/definitions/tree';
import type { HumanParams } from '@/objects/definitions/human';
import { CAR_CLEARANCE, type CarParams } from '@/objects/definitions/car';
import { POLE_HALF, type StreetLightParams } from '@/objects/definitions/streetLight';
import type { SignParams } from '@/objects/definitions/sign';
import type { WallParams } from '@/objects/definitions/wall';
import { ROAD_THICKNESS, type RoadParams } from '@/objects/definitions/road';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import { shade } from '../materials';

/** One box of a merged voxel model. */
export interface BoxPart {
  size: Vec3;
  position?: Vec3;
  rotation?: Vec3;
  color: string;
}

export interface MergedMatOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Material variants used by the voxel models (one batch per variant in simulation mode). */
export const PART_MATS = {
  standard: {} as MergedMatOptions,
  foliage: { roughness: 0.95 } as MergedMatOptions,
  car: { roughness: 0.55, metalness: 0.2 } as MergedMatOptions,
  pole: { metalness: 0.4, roughness: 0.5 } as MergedMatOptions,
  lamp: { emissive: '#2a2414', emissiveIntensity: 0.6 } as MergedMatOptions,
  signPost: { metalness: 0.5, roughness: 0.4 } as MergedMatOptions,
  shopSign: { emissive: '#3a1a10', emissiveIntensity: 0.5 } as MergedMatOptions,
};
export type PartMat = keyof typeof PART_MATS;

/** Axis-aligned bounds of a part list (local space). */
function bounds(parts: BoxPart[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const c = p.position ?? [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c[k] - p.size[k] / 2);
      max[k] = Math.max(max[k], c[k] + p.size[k] / 2);
    }
  }
  return { min, max };
}

// ── Trees ─────────────────────────────────────────────────────────────────

interface Voxel { pos: Vec3; size: Vec3; color: string }

/** Deterministic voxel canopy so the same tree always looks the same. */
export function buildCanopy(p: TreeParams, seed: number): Voxel[] {
  const rnd = seededRandom(seed);
  const th = trunkHeight(p);
  const r = p.canopyRadius;
  const base = p.species === 'conifer' ? '#2f6b3a' : '#4f8f3a';
  const out: Voxel[] = [];
  if (p.species === 'conifer') {
    const tiers = 4;
    const h = (p.height - th) / tiers;
    for (let i = 0; i < tiers; i++) {
      const s = 2 * r * (1 - (i / tiers) * 0.72);
      out.push({ pos: [0, th + h * (i + 0.5), 0], size: [s, h * 1.12, s], color: shade(base, i % 2 ? 0.03 : -0.02) });
    }
    out.push({ pos: [0, p.height - h * 0.15, 0], size: [r * 0.35, h * 0.6, r * 0.35], color: shade(base, 0.04) });
  } else {
    const cy = p.height - r * 0.95;
    out.push({ pos: [0, cy, 0], size: [r * 1.7, r * 1.5, r * 1.7], color: base });
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
      const d = r * (0.45 + rnd() * 0.25);
      const s = r * (0.75 + rnd() * 0.4);
      out.push({
        pos: [Math.cos(a) * d, cy + (rnd() - 0.4) * r * 0.7, Math.sin(a) * d],
        size: [s, s * (0.8 + rnd() * 0.3), s],
        color: shade(base, (rnd() - 0.5) * 0.1),
      });
    }
  }
  return out;
}

export const TREE_BARK = '#6b4a2f';

export function treeParts(p: TreeParams, seed: number) {
  const snapH = p.height * SNAP_FRACTION;
  const th = trunkHeight(p);
  const trunkW = p.trunkRadius * 2;
  // Canopy is centered on its own pivot so foliage loss shrinks it in place.
  const vox = buildCanopy(p, seed);
  const pivot = vox.reduce((a, v) => a + v.pos[1], 0) / Math.max(1, vox.length);
  const canopy = vox.map<BoxPart>((v) => ({ size: v.size, position: [v.pos[0], v.pos[1] - pivot, v.pos[2]], color: v.color }));
  const stump: BoxPart[] = [{ size: [trunkW, snapH, trunkW], position: [0, snapH / 2, 0], color: TREE_BARK }];
  const trunk: BoxPart[] = [
    { size: [trunkW * 0.92, th - snapH + 0.4, trunkW * 0.92], position: [0, snapH + (th - snapH + 0.4) / 2, 0], color: shade(TREE_BARK, 0.03) },
  ];
  // Far LOD: one block (deciduous) or a two-tier cone (conifer) with the main foliage color.
  const b = bounds(canopy);
  const w = (b.max[0] - b.min[0]) * 0.85;
  const d = (b.max[2] - b.min[2]) * 0.85;
  const hgt = b.max[1] - b.min[1];
  const cy = (b.max[1] + b.min[1]) / 2;
  const canopyLod: BoxPart[] =
    p.species === 'conifer'
      ? [
          { size: [w, hgt * 0.55, d], position: [0, b.min[1] + hgt * 0.275, 0], color: vox[0].color },
          { size: [w * 0.55, hgt * 0.5, d * 0.55], position: [0, b.min[1] + hgt * 0.72, 0], color: vox[1]?.color ?? vox[0].color },
        ]
      : [{ size: [w, hgt * 0.85, d], position: [0, cy, 0], color: vox[0].color }];
  return { stump, trunk, canopy, canopyLod, pivot };
}

// ── People ────────────────────────────────────────────────────────────────

const SKIN = '#e2b48c';
const HAIR = '#3b2a1d';

export function humanParts(p: HumanParams) {
  const h = p.height;
  const leg = h * 0.375;
  const torso = h * 0.375;
  const head = h * 0.25;
  const tw = h * 0.21;
  const td = h * 0.12;
  const lw = tw / 2;
  const aw = h * 0.09;
  const shoulderY = leg + torso;
  const body: BoxPart[] = [
    { size: [lw * 0.96, leg, td], position: [-lw / 2, leg / 2, 0], color: p.pantsColor },
    { size: [lw * 0.96, leg, td], position: [lw / 2, leg / 2, 0], color: p.pantsColor },
    { size: [lw * 0.98, leg * 0.12, td * 1.15], position: [-lw / 2, leg * 0.06, 0.01], color: '#26262a' },
    { size: [lw * 0.98, leg * 0.12, td * 1.15], position: [lw / 2, leg * 0.06, 0.01], color: '#26262a' },
    { size: [tw, torso, td * 1.05], position: [0, leg + torso / 2, 0], color: p.shirtColor },
    { size: [head * 0.92, head * 0.92, head * 0.92], position: [0, shoulderY + head * 0.48, 0], color: SKIN },
    { size: [head * 0.96, head * 0.3, head * 0.96], position: [0, shoulderY + head * 0.84, -0.005], color: HAIR },
    { size: [head * 0.14, head * 0.1, 0.02], position: [-head * 0.2, shoulderY + head * 0.52, head * 0.47], color: '#1d2433' },
    { size: [head * 0.14, head * 0.1, 0.02], position: [head * 0.2, shoulderY + head * 0.52, head * 0.47], color: '#1d2433' },
  ];
  const arm: BoxPart[] = [
    { size: [aw, torso, td], position: [0, -torso / 2, 0], color: p.shirtColor },
    { size: [aw * 0.98, torso * 0.22, td * 0.98], position: [0, -torso * 0.9, 0], color: SKIN },
  ];
  // Far LOD: legs, torso with arms at rest, head (arms are not animated far away).
  const bodyLod: BoxPart[] = [
    { size: [tw, leg, td], position: [0, leg / 2, 0], color: p.pantsColor },
    { size: [tw + 2 * aw, torso, td * 1.05], position: [0, leg + torso / 2, 0], color: p.shirtColor },
    { size: [head * 0.92, head * 0.92, head * 0.92], position: [0, shoulderY + head * 0.48, 0], color: SKIN },
  ];
  const shoulderL: Vec3 = [-(tw / 2 + aw / 2), shoulderY - 0.02, 0];
  const shoulderR: Vec3 = [tw / 2 + aw / 2, shoulderY - 0.02, 0];
  return { body, arm, bodyLod, shoulderL, shoulderR };
}

// ── Vehicles ──────────────────────────────────────────────────────────────

/** `wheels = false` (Phase 35): body without the four wheel boxes — a wheeled vehicle's wheels are drawn by the vehicle layer. */
export function carParts(p: CarParams, wheels = true) {
  const L = p.length;
  const W = p.width;
  const chassisH = (p.height - CAR_CLEARANCE) * 0.5;
  const cabinH = p.height - CAR_CLEARANCE - chassisH;
  const chassisY = CAR_CLEARANCE + chassisH / 2;
  const wheel = Math.min(0.8, CAR_CLEARANCE * 2.2);
  const wx = L / 2 - Math.max(0.6, L * 0.18);
  const wz = W / 2 - 0.12;
  const out: BoxPart[] = [{ size: [L, chassisH, W], position: [0, chassisY, 0], color: p.color }];
  if (p.variant === 'truck') {
    out.push(
      { size: [L * 0.22, cabinH, W * 0.96], position: [L * 0.38, CAR_CLEARANCE + chassisH + cabinH / 2, 0], color: shade(p.color, -0.08) },
      { size: [0.05, cabinH * 0.5, W * 0.8], position: [L * 0.49 + 0.01, CAR_CLEARANCE + chassisH + cabinH * 0.62, 0], color: '#22303c' },
      { size: [L * 0.74, cabinH + 0.25, W], position: [-L * 0.12, CAR_CLEARANCE + chassisH + (cabinH + 0.25) / 2, 0], color: '#e9e6df' },
    );
  } else {
    out.push(
      { size: [L * 0.55, cabinH, W * 0.9], position: [-L * 0.05, CAR_CLEARANCE + chassisH + cabinH / 2, 0], color: '#22303c' },
      { size: [L * 0.5, 0.08, W * 0.86], position: [-L * 0.05, CAR_CLEARANCE + chassisH + cabinH + 0.02, 0], color: p.color },
    );
  }
  const shell = out.length;
  if (wheels) for (const [x, z] of [[wx, wz], [wx, -wz], [-wx, wz], [-wx, -wz]]) {
    out.push({ size: [wheel, wheel, 0.28], position: [x, wheel / 2, z], color: '#1c1d20' });
  }
  for (const s of [1, -1]) {
    out.push({ size: [0.06, 0.18, 0.36], position: [L / 2 + 0.02, chassisY + chassisH * 0.15, s * W * 0.32], color: '#fff6c8' });
    out.push({ size: [0.06, 0.16, 0.3], position: [-L / 2 - 0.02, chassisY + chassisH * 0.15, s * W * 0.34], color: '#d63b3b' });
  }
  // Far LOD: body shell only, chassis lowered to the ground (no wheels/lights).
  const lod: BoxPart[] = out.slice(0, shell).map((b, i) =>
    i === 0 ? { ...b, size: [b.size[0], chassisH + CAR_CLEARANCE * 0.8, b.size[2]], position: [0, (chassisH + CAR_CLEARANCE * 0.8) / 2 + CAR_CLEARANCE * 0.2, 0] } : b,
  );
  return { body: out, lod };
}

// ── Infrastructure ────────────────────────────────────────────────────────

export function streetLightParts(p: StreetLightParams) {
  const pole: BoxPart[] = [
    { size: [0.36, 0.3, 0.36], position: [0, 0.15, 0], color: shade(p.color, -0.1) },
    { size: [POLE_HALF * 2, p.height, POLE_HALF * 2], position: [0, p.height / 2, 0], color: p.color },
    { size: [p.armLength, 0.1, 0.1], position: [p.armLength / 2, p.height - 0.05, 0], color: p.color },
  ];
  const head: BoxPart[] = [
    { size: [0.7, 0.18, 0.34], color: '#3d444c' },
    { size: [0.6, 0.06, 0.28], position: [0, -0.11, 0], color: '#fff3c4' },
  ];
  const headPos: Vec3 = [p.armLength, p.height - 0.2, 0];
  return { pole, head, headPos };
}

export function signParts(p: SignParams) {
  const xs = p.panelWidth > 3 ? [-p.panelWidth * 0.32, p.panelWidth * 0.32] : [0];
  const posts = xs.map<BoxPart>((x) => ({ size: [0.12, p.height, 0.12], position: [x, p.height / 2, 0], color: '#9aa3ad' }));
  const panel: BoxPart[] = [
    { size: [p.panelWidth, p.panelHeight, 0.06], color: p.color },
    // White border + text bars so it reads as a sign from afar
    { size: [p.panelWidth * 0.92, 0.05, 0.065], position: [0, p.panelHeight * 0.42, 0], color: '#f4f4f0' },
    { size: [p.panelWidth * 0.92, 0.05, 0.065], position: [0, -p.panelHeight * 0.42, 0], color: '#f4f4f0' },
    { size: [p.panelWidth * 0.55, p.panelHeight * 0.12, 0.07], position: [0, p.panelHeight * 0.1, 0], color: '#f4f4f0' },
    { size: [p.panelWidth * 0.35, p.panelHeight * 0.1, 0.07], position: [-p.panelWidth * 0.1, -p.panelHeight * 0.15, 0], color: '#f4f4f0' },
  ];
  const panelPos: Vec3 = [0, p.height - p.panelHeight / 2, 0.08];
  return { posts, panel, panelPos };
}

export function wallParts(p: WallParams): BoxPart[] {
  // Brick courses for a voxel look.
  const courses = Math.max(1, Math.round(p.height / 0.5));
  const out: BoxPart[] = [{ size: [p.length, p.height, p.thickness], position: [0, p.height / 2, 0], color: p.color }];
  for (let i = 1; i < courses; i++) {
    out.push({ size: [p.length + 0.01, 0.03, p.thickness + 0.01], position: [0, (i * p.height) / courses, 0], color: shade(p.color, -0.12) });
  }
  out.push({ size: [p.length + 0.06, 0.08, p.thickness + 0.06], position: [0, p.height + 0.04, 0], color: shade(p.color, -0.18) });
  return out;
}

export function roadLineParts(p: RoadParams): BoxPart[] {
  const lanes = Math.max(1, Math.round(p.lanes));
  const laneW = p.width / lanes;
  const dashes = Math.max(1, Math.floor(p.length / 6));
  const y = ROAD_THICKNESS + 0.006;
  const out: BoxPart[] = [-1, 1].map((s) => ({ size: [p.length, 0.01, 0.15] as Vec3, position: [0, y, s * (p.width / 2 - 0.25)] as Vec3, color: '#e9e9e2' }));
  // Lane dividers: yellow center line, dashed white elsewhere
  for (let i = 0; i < lanes - 1; i++) {
    const z = -p.width / 2 + laneW * (i + 1);
    if (lanes % 2 === 0 && i === lanes / 2 - 1) out.push({ size: [p.length, 0.01, 0.2], position: [0, y, z], color: '#e8c547' });
    else for (let d = 0; d < dashes; d++) out.push({ size: [3, 0.01, 0.14], position: [-p.length / 2 + 3 + d * 6, y, z], color: '#e9e9e2' });
  }
  return out;
}

// ── Buildings ─────────────────────────────────────────────────────────────

export function groupComponents(components: readonly ComponentSpec[]) {
  const groups: Partial<Record<ComponentKind, ComponentSpec[]>> = {};
  for (const c of components) (groups[c.kind] ??= []).push(c);
  return groups;
}

/** Facade component kinds drawn as instanced boxes (windows, roof panels, parapets, units). */
export type FacadeKind = 'window' | 'roof' | 'wall' | 'exterior';
export const FACADE_KINDS: FacadeKind[] = ['window', 'roof', 'wall', 'exterior'];

export const GLASS_MAT = { roughness: 0.15, metalness: 0.3, emissive: '#2a4258', emissiveIntensity: 0.35 };
/** Base color + material of each facade kind (`wall` uses the building color, see facadeColor). */
export const FACADE_STYLE: Record<FacadeKind, { color: string; mat?: MergedMatOptions; shadow: boolean }> = {
  window: { color: '#7fa8cc', mat: GLASS_MAT, shadow: false },
  roof: { color: '#76797e', shadow: true },
  wall: { color: '#ffffff', shadow: true },
  exterior: { color: '#d6d9dc', mat: { roughness: 0.5, metalness: 0.3 }, shadow: true },
};
export function facadeColor(kind: FacadeKind, p: BuildingParams): string {
  return kind === 'wall' ? shade(p.color, -0.06) : FACADE_STYLE[kind].color;
}

/** Core volume, plinth, floor bands and roof slab. */
export function buildingShellParts(p: BuildingParams): BoxPart[] {
  const H = buildingHeight(p);
  const bandColor = shade(p.color, -0.12);
  const out: BoxPart[] = [
    { size: [p.width, H, p.depth], position: [0, H / 2, 0], color: p.color },
    { size: [p.width + 0.16, 0.45, p.depth + 0.16], position: [0, 0.225, 0], color: shade(p.color, -0.22) },
    { size: [p.width + 0.06, 0.1, p.depth + 0.06], position: [0, H, 0], color: shade(p.color, -0.3) },
  ];
  for (let i = 1; i < p.floors; i++) out.push({ size: [p.width + 0.1, 0.16, p.depth + 0.1], position: [0, i * p.floorHeight, 0], color: bandColor });
  return out;
}

/**
 * Foundation plinth under a building on a slope (Phase 13): a concrete block from the floor
 * down to the lowest ground point of the footprint (+ a little embedment). `depth` is in the
 * building's local (unscaled) units; empty on flat ground.
 */
export function buildingPlinthParts(p: BuildingParams, depth: number): BoxPart[] {
  if (depth <= 0.02) return [];
  const d = depth + 0.3;
  return [{ size: [p.width + 0.2, d, p.depth + 0.2], position: [0, -d / 2, 0], color: '#8f8b84' }];
}

/** Shop sign with a lettering strip (positioned at the sign component's position). */
export function buildingSignParts(sign: ComponentSpec): BoxPart[] {
  const strip: Vec3 = sign.normal && sign.normal[2] !== 0
    ? [sign.size[0] * 0.8, sign.size[1] * 0.36, sign.size[2] + 0.02]
    : [sign.size[0] + 0.02, sign.size[1] * 0.36, sign.size[2] * 0.8];
  return [
    { size: sign.size, color: sign.color ?? '#e8483b' },
    // Lettering strip so the sign reads as a sign
    { size: strip, color: '#fff4d6' },
  ];
}
