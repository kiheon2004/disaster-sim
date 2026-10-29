/**
 * One pressure-wave source in the world (Phase 24): its tables, the ground reflection and the
 * shielding of a receiver by terrain and buildings. Used identically by the experiment preview, the
 * simulation (objects, facade parts, water), the inspector and the renderer.
 *
 * Ground reflection (approximate, rigid ground):
 *  - a release ON the ground expands into a hemisphere: the wave of a free-air release of 2E
 *    (perfect reflection; real ground absorbs a little — not modelled);
 *  - a release well above the ground: the direct wave of E plus its mirror image below the ground
 *    plane at the source (image-source method, regular reflection, linear superposition — the Mach
 *    stem of strong grazing reflections is not modelled). Near the ground both arrive together and
 *    the overpressure doubles;
 *  - in between (height h < 2·r_t) the two descriptions are blended with w = h/(2·r_t) so the field is
 *    continuous in h.
 *  The ground plane is taken flat at the height of the ground under the source.
 *
 * Shielding (approximate): the straight path from the source to the receiver is checked against the
 * terrain and the building boxes; the most obstructing edge gives a path difference δ (over the
 * ridge or roof, or around a building's side), the Fresnel number N = 2δ/λ with λ = 2·c·T₊ (the
 * pulse length), and an insertion loss from the Kurze–Anderson form of Maekawa's barrier chart:
 *     IL = 5 + 20·log₁₀(√(2πN) / tanh √(2πN)) dB  (N > 0),  capped at 20 dB,
 * applied to the amplitude (and impulse), with the arrival delayed by δ/c. A ridge never blocks the
 * wave completely. Multiple edges, reflections from buildings, street channelling and diffraction
 * of the pulse shape are not modelled.
 */
import type { Vec3 } from '@/core/types';
import { K_SEDOV, WEAK_LIMIT, RadialTable, ambientAt, newSample, type Ambient, type RadialSample, type Zone } from './source';
import type { Arrival } from './pulse';
import type { BlastModel, BlastWaveform } from './types';

/** Oriented building box (footprint + height), compatible with the wind obstacles. */
export interface ShieldBox {
  id: string;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  ax: [number, number];
  az: [number, number];
  height: number;
  baseY: number;
  active?: boolean;
}

/** Heights of the run's (or document's) ground. */
export interface GroundHeight {
  sampleHeight(x: number, z: number): number;
  /** Highest ground anywhere (m), if known: a path entirely above it cannot be blocked. */
  readonly maxHeight?: number;
  readonly data: { originX: number; originZ: number; nx: number; nz: number; cellSize: number };
}

export interface WaveInit {
  id: string;
  /** Phenomenon it belongs to ('blast:p1', 'impact:p2') — damage attribution. */
  source: string;
  name: string;
  kind: 'release' | 'airburst' | 'surface';
  /** Release point (world x, absolute y, z) and activation time (s). */
  position: Vec3;
  time: number;
  energy: number;
  model: BlastModel;
  waveform: BlastWaveform;
  /** Ambient at the ground datum (y = 0). */
  ambient: Ambient;
  /** Height of the ground under the release (m). */
  groundY: number;
  /** World box (x0, z0, x1, z1) and the highest point that matters (m). */
  world: { x0: number; z0: number; x1: number; z1: number; top: number; bottom: number };
}

export type Exposure = 'direct' | 'terrain' | 'building';

export interface Shielding {
  /** Amplitude factor (≤ 1), extra delay (s), path difference (m), insertion loss (dB). */
  factor: number;
  delay: number;
  delta: number;
  il: number;
  kind: Exposure;
  /** Id of the shielding building, if any. */
  by: string | null;
}

export const NO_SHIELD: Readonly<Shielding> = { factor: 1, delay: 0, delta: 0, il: 0, kind: 'direct', by: null };

/** A wave contribution at a receiver: arrival + where it comes from. */
export interface Contribution extends Arrival {
  /** Unit propagation direction at the receiver. */
  k: Vec3;
  path: 'hemisphere' | 'direct' | 'image';
  zone: Zone;
  /** Ambient pressure at the receiver (Pa). */
  p: number;
}

const MAX_IL = 20;

/** Insertion loss (dB) of a single edge with Fresnel number N (Kurze & Anderson 1971). */
export function insertionLoss(N: number): number {
  if (N <= 0) return 0;
  const x = Math.sqrt(2 * Math.PI * N);
  return Math.min(MAX_IL, 5 + 20 * Math.log10(x / Math.tanh(x)));
}

export class BlastWave {
  readonly init: WaveInit;
  /** Free-air table (energy E) and hemispherical table (2E); null when the blend weight excludes it. */
  readonly free: RadialTable | null;
  readonly hemi: RadialTable | null;
  /** Blend weight of the free-air + image description (0 = surface release, 1 = elevated). */
  readonly w: number;
  readonly image: Vec3;
  readonly height: number;
  readonly sourceAmbient: Ambient;
  private readonly s = newSample();

  constructor(i: WaveInit) {
    this.init = i;
    const [x, y, z] = i.position;
    this.height = Math.max(0, y - i.groundY);
    this.image = [x, 2 * i.groundY - y, z];
    this.sourceAmbient = ambientAt(i.ambient, y);
    const W = i.world;
    let reach = 0;
    for (const cx of [W.x0, W.x1]) for (const cz of [W.z0, W.z1]) for (const cy of [W.bottom, W.top]) {
      reach = Math.max(reach, Math.hypot(cx - x, cy - y, cz - z), Math.hypot(cx - x, cy - this.image[1], cz - z));
    }
    const target: Vec3 = [(W.x0 + W.x1) / 2, Math.max(W.bottom, i.groundY), (W.z0 + W.z1) / 2];
    const base = { source: this.sourceAmbient, ground: i.ambient, height: y, targetHeight: target[1], targetDistance: Math.hypot(target[0] - x, target[1] - y, target[2] - z), model: i.model, reach };
    // Transition radius of the free-air wave decides the blend (it does not depend on the table).
    const rtFree = Math.cbrt((K_SEDOV * i.energy) / this.sourceAmbient.p);
    this.w = Math.max(0, Math.min(1, this.height / (2 * rtFree)));
    this.free = this.w > 0 ? new RadialTable({ ...base, energy: i.energy }) : null;
    this.hemi = this.w < 1 ? new RadialTable({ ...base, energy: 2 * i.energy }) : null;
  }

  /** The table that describes the wave's front (the hemisphere for surface releases). */
  get main(): RadialTable {
    return (this.hemi ?? this.free)!;
  }

  /** Energy actually released into the air (J) and the share carried by the pulse (J). */
  get pulseEnergy(): number {
    // Hemisphere: the 2E table's full-sphere pulse energy covers the upper half-space only → ×½.
    return this.w * (this.free ? this.free.pulseEnergy : 0) + (1 - this.w) * (this.hemi ? this.hemi.pulseEnergy / 2 : 0);
  }

  /** Front radius around the source at absolute time t (m). */
  frontRadius(time: number): number {
    return this.main.radiusAt(time - this.init.time);
  }

  /**
   * Wave contributions at receiver p (absolute times), after shielding `sh`. Appended to `out`.
   */
  contributions(p: Readonly<Vec3>, sh: Readonly<Shielding>, out: Contribution[]): Contribution[] {
    const [sx, sy, sz] = this.init.position;
    const t0 = this.init.time + sh.delay;
    const add = (tab: RadialTable, from: Vec3 | null, weight: number, path: Contribution['path']) => {
      const fx = from ? from[0] : sx, fy = from ? from[1] : sy, fz = from ? from[2] : sz;
      const dx = p[0] - fx, dy = p[1] - fy, dz = p[2] - fz;
      const r = Math.hypot(dx, dy, dz) || 1e-6;
      const s: RadialSample = tab.at(r, this.s);
      const dp = s.dp * weight * sh.factor;
      // Negative phase limited near the source (pulse.ts): ≤ 0.3·p, same impulse.
      const dn = Math.min(dp, WEAK_LIMIT * s.p);
      out.push({ t: t0 + s.t, dp, T: s.T, waveform: this.init.waveform, dn: dn < dp ? dn : undefined, k: [dx / r, dy / r, dz / r], path, zone: s.zone, p: s.p });
    };
    if (this.hemi && this.w < 1) add(this.hemi, null, 1 - this.w, 'hemisphere');
    if (this.free && this.w > 0) {
      add(this.free, null, this.w, 'direct');
      // The image wave only reaches points above the ground plane at the source.
      if (p[1] >= this.init.groundY - 1e-6) add(this.free, this.image, this.w, 'image');
    }
    return out;
  }

  /** Overpressure / duration / arrival of the main wave at distance r (no shielding) — preview helpers. */
  sample(r: number, out = newSample()): RadialSample {
    return this.main.at(r, out);
  }
}

/** Uniform grid over building boxes for segment queries. */
export class ShieldIndex {
  private readonly cell = 8;
  private readonly grid = new Map<number, number[]>();
  readonly boxes: ShieldBox[];
  private readonly stamp: Int32Array;
  private query = 0;

  constructor(boxes: ShieldBox[]) {
    this.boxes = boxes;
    this.stamp = new Int32Array(boxes.length);
    boxes.forEach((b, i) => {
      const r = Math.hypot(b.hx, b.hz);
      for (let gx = Math.floor((b.cx - r) / this.cell); gx <= Math.floor((b.cx + r) / this.cell); gx++) {
        for (let gz = Math.floor((b.cz - r) / this.cell); gz <= Math.floor((b.cz + r) / this.cell); gz++) {
          const k = gx * 8192 + gz;
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(i);
        }
      }
    });
  }

  /**
   * Boxes registered in the cells the plan segment (x0, z0) → (x1, z1) passes through (exact grid
   * traversal, Amanatides & Woo 1987; boxes are registered in every cell their bounding circle
   * touches, so a box crossing the segment is always found), deduplicated, in traversal order.
   */
  along(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    const q = ++this.query;
    const c = this.cell;
    let gx = Math.floor(x0 / c), gz = Math.floor(z0 / c);
    const ex = Math.floor(x1 / c), ez = Math.floor(z1 / c);
    const dx = x1 - x0, dz = z1 - z0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity, tdz = dz !== 0 ? Math.abs(c / dz) : Infinity;
    let tx = dx !== 0 ? ((dx > 0 ? (gx + 1) * c - x0 : x0 - gx * c) / Math.abs(dx)) : Infinity;
    let tz = dz !== 0 ? ((dz > 0 ? (gz + 1) * c - z0 : z0 - gz * c) / Math.abs(dz)) : Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      const l = this.grid.get(gx * 8192 + gz);
      if (l) for (const i of l) if (this.stamp[i] !== q) { this.stamp[i] = q; out.push(i); }
      if (gx === ex && gz === ez) break;
      if (tx < tz) { tx += tdx; gx += sx; } else { tz += tdz; gz += sz; }
      if (tx > 1 && tz > 1 && (gx !== ex || gz !== ez)) {
        // Past the end point (numerical edge): visit the end cell and stop.
        const le = this.grid.get(ex * 8192 + ez);
        if (le) for (const i of le) if (this.stamp[i] !== q) { this.stamp[i] = q; out.push(i); }
        break;
      }
    }
    return out;
  }
}

const scratch: number[] = [];

/**
 * Shielding of receiver p (exclude: the receiver's own building id) from source s, for a pulse of
 * positive duration T and sound speed c.
 */
export function shielding(s: Readonly<Vec3>, p: Readonly<Vec3>, T: number, c: number, ground: GroundHeight, index: ShieldIndex | null, exclude: string | null = null): Shielding {
  const L = Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]);
  if (L < 1e-3) return NO_SHIELD;
  let best = 0, kind: Exposure = 'direct', by: string | null = null;
  // Terrain: highest obstruction along the line (only where the ground actually rises above it;
  // the ground under a receiver is the reflecting plane, handled by the image wave). Ends excluded.
  const d = ground.data;
  const step = Math.max(0.5, d.cellSize * 0.7);
  const n = ground.maxHeight !== undefined && Math.min(s[1], p[1]) >= ground.maxHeight ? 0 : Math.ceil(L / step);
  const margin = Math.min(0.2, 3 / L);
  for (let k = 1; k < n; k++) {
    const f = k / n;
    if (f < margin || f > 1 - margin) continue;
    const x = s[0] + (p[0] - s[0]) * f, y = s[1] + (p[1] - s[1]) * f, z = s[2] + (p[2] - s[2]) * f;
    const h = ground.sampleHeight(x, z);
    if (h <= y) continue;
    const delta = Math.hypot(x - s[0], h - s[1], z - s[2]) + Math.hypot(p[0] - x, p[1] - h, p[2] - z) - L;
    if (delta > best) { best = delta; kind = 'terrain'; by = null; }
  }
  // Buildings: over the roof or around the nearer side of each box crossed in plan.
  if (index) {
    const list = index.along(s[0], s[2], p[0], p[2], scratch);
    for (const i of list) {
      const b = index.boxes[i];
      if (b.active === false || b.id === exclude) continue;
      const delta = boxDetour(s, p, L, b);
      if (delta > best) { best = delta; kind = 'building'; by = b.id; }
    }
  }
  if (best <= 0) return NO_SHIELD;
  const lambda = 2 * c * Math.max(1e-4, T);
  const il = insertionLoss((2 * best) / lambda);
  return { factor: 10 ** (-il / 20), delay: best / c, delta: best, il, kind, by };
}

/** Path difference around one box (0 if the straight path misses it or clears its roof). */
function boxDetour(s: Readonly<Vec3>, p: Readonly<Vec3>, L: number, b: ShieldBox): number {
  // Segment in the box frame (plan).
  const lx = (x: number, z: number) => (x - b.cx) * b.ax[0] + (z - b.cz) * b.ax[1];
  const lz = (x: number, z: number) => (x - b.cx) * b.az[0] + (z - b.cz) * b.az[1];
  const ax = lx(s[0], s[2]), az = lz(s[0], s[2]), bx = lx(p[0], p[2]), bz = lz(p[0], p[2]);
  // A source or receiver inside the box: not a barrier between them.
  if ((Math.abs(ax) < b.hx && Math.abs(az) < b.hz) || (Math.abs(bx) < b.hx && Math.abs(bz) < b.hz)) return 0;
  // Slab clipping.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [o, dd, h] of [[ax, dx, b.hx], [az, dz, b.hz]] as const) {
    if (Math.abs(dd) < 1e-12) { if (Math.abs(o) > h) return 0; continue; }
    let u = (-h - o) / dd, v = (h - o) / dd;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return 0;
  }
  const top = b.baseY + b.height;
  // Ray height where it is inside the box; below the roof somewhere → obstructed.
  const yIn = Math.min(s[1] + (p[1] - s[1]) * t0, s[1] + (p[1] - s[1]) * t1);
  if (yIn >= top) return 0;
  // Over the roof: path via the roof edge at the middle of the crossing.
  const tm = 0.5 * (t0 + t1);
  const ex = s[0] + (p[0] - s[0]) * tm, ez = s[2] + (p[2] - s[2]) * tm;
  const over = Math.hypot(ex - s[0], top - s[1], ez - s[2]) + Math.hypot(p[0] - ex, p[1] - top, p[2] - ez) - L;
  // Around a side: shortest detour via the corners on each side of the line (plan, heights linear).
  const corners: [number, number][] = [[-b.hx, -b.hz], [b.hx, -b.hz], [b.hx, b.hz], [-b.hx, b.hz]];
  let left = 0, right = 0, cl: [number, number] | null = null, cr: [number, number] | null = null;
  const len = Math.hypot(dx, dz) || 1;
  for (const c of corners) {
    const side = ((c[0] - ax) * dz - (c[1] - az) * dx) / len;
    if (side > left) { left = side; cl = c; }
    if (side < right) { right = side; cr = c; }
  }
  const around = (c: [number, number] | null) => {
    if (!c) return Infinity;
    const wx = b.cx + c[0] * b.ax[0] + c[1] * b.az[0], wz = b.cz + c[0] * b.ax[1] + c[1] * b.az[1];
    const f = Math.max(0, Math.min(1, Math.hypot(wx - s[0], wz - s[2]) / Math.max(1e-6, Math.hypot(p[0] - s[0], p[2] - s[2]))));
    const wy = s[1] + (p[1] - s[1]) * f;
    return Math.hypot(wx - s[0], wy - s[1], wz - s[2]) + Math.hypot(p[0] - wx, p[1] - wy, p[2] - wz) - L;
  };
  return Math.max(0, Math.min(over, around(cl), around(cr)));
}
