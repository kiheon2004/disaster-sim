/**
 * The deterministic plan of one air-blast release (Phase 24): ambient state, the wave and its tables,
 * model-validity numbers and warnings, and the ground-level field (arrival time, peak overpressure,
 * positive impulse, exposure) on a grid. The experiment preview and the simulation build the SAME
 * plan from the same inputs, so the preview shows the model's own numbers.
 */
import type { Vec3 } from '@/core/types';
import type { TerrainData, WorldObject } from '@/core/model';
import { quatFromEuler, qRotate } from '@/core/math';
import { getDefinition } from '@/objects/registry';
import { samplerFor } from '@/terrain/TerrainSampler';
import { AIR_DENSITY } from '@/core/units';
import { BLAST_LIMITS, STANDARD_PRESSURE, type BlastSpec } from './types';
import { makeAmbient, WEAK_LIMIT, type Ambient, type Zone } from './source';
import { BlastWave, ShieldIndex, shielding, type Contribution, type Exposure, type GroundHeight, type ShieldBox, type WaveInit } from './wave';
import { peakOf, positiveImpulseOf, pressure } from './pulse';

/** Height above the ground of the field points (m): a standing person / ground-floor windows. */
export const FIELD_HEIGHT = 1.5;
/** Specific gas constant of dry air (J/(kg·K)). */
export const R_AIR = 287.05;
/** Pressure levels drawn as model-estimate contours (Pa). */
export const PRESSURE_LEVELS = [1000, 3000, 10000, 30000] as const;

export interface BlastWarning { key: string; params?: Record<string, string | number> }

export interface BlastPlan {
  spec: BlastSpec;
  ambient: Ambient;
  /** Implied air temperature (K). */
  temperature: number;
  wave: BlastWave;
  /** Sachs length R₀, transition radius r_t, positive duration and arrival at r_t. */
  R0: number;
  rt: number;
  /** Pulse energy and its share of the released energy. */
  pulseEnergy: number;
  efficiency: number;
  /** Distance beyond which the weak-shock theory is valid (Δp ≤ 0.3 p₀), m. */
  validRadius: number;
  /** Distances at which the (unshielded, ground-level) overpressure falls to PRESSURE_LEVELS. */
  levelRadii: number[];
  /** Time for the front to cross the farthest world corner (s after the release). */
  worldExit: number;
  warnings: BlastWarning[];
}

export function worldBox(t: TerrainData) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < t.heights.length; i++) { const h = t.heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  return { x0: t.originX, z0: t.originZ, x1: t.originX + (t.nx - 1) * t.cellSize, z1: t.originZ + (t.nz - 1) * t.cellSize, top: hi + 150, bottom: lo };
}

export function blastAmbient(spec: BlastSpec, airDensity = AIR_DENSITY): Ambient {
  return makeAmbient(spec.ambientPressure ?? STANDARD_PRESSURE, spec.ambientDensity ?? airDensity);
}

/** Wave of a user release (spec) on a terrain; `source` = phenomenon id ('blast:p1'). */
export function waveOf(spec: BlastSpec, terrain: TerrainData, opts: { id: string; source: string; name: string; time: number; airDensity?: number }): BlastWave {
  const s = samplerFor(terrain);
  const [x, z] = spec.position;
  const g = s.sampleHeight(x, z);
  const init: WaveInit = {
    id: opts.id, source: opts.source, name: opts.name, kind: 'release', position: [x, g + spec.height, z], time: opts.time,
    energy: spec.energy, model: spec.model, waveform: spec.waveform, ambient: blastAmbient(spec, opts.airDensity), groundY: g, world: worldBox(terrain),
  };
  return new BlastWave(init);
}

export function planBlast(spec: BlastSpec, terrain: TerrainData, airDensity = AIR_DENSITY, opts?: { id?: string; source?: string; name?: string; time?: number }): BlastPlan {
  const wave = waveOf(spec, terrain, { id: opts?.id ?? 'preview', source: opts?.source ?? 'blast', name: opts?.name ?? 'preview', time: opts?.time ?? 0, airDensity });
  return planOfWave(spec, wave, terrain);
}

export function planOfWave(spec: BlastSpec, wave: BlastWave, _terrain?: TerrainData): BlastPlan {
  const amb = wave.init.ambient;
  const main = wave.main;
  const warnings: BlastWarning[] = [];
  const W = wave.init.world;
  const [x, , z] = wave.init.position;
  const T = amb.p / (amb.rho * R_AIR);
  const validRadius = main.validRadius();
  if (x < W.x0 || x > W.x1 || z < W.z0 || z > W.z1) warnings.push({ key: 'blast.warn.outside' });
  if (validRadius > 1) warnings.push({ key: 'blast.warn.near', params: { r: validRadius.toFixed(1), core: main.rt.toFixed(1) } });
  const half = Math.min(W.x1 - W.x0, W.z1 - W.z0) / 2;
  if (validRadius > half) warnings.push({ key: 'blast.warn.worldNear', params: { r: validRadius.toFixed(0) } });
  if (T < 200 || T > 330) warnings.push({ key: 'blast.warn.ambient', params: { T: (T - 273.15).toFixed(0) } });
  if (spec.model === 'acoustic') warnings.push({ key: 'blast.warn.acoustic' });
  if (spec.waveform === 'positive') warnings.push({ key: 'blast.warn.positive' });
  if (wave.w > 0) warnings.push({ key: 'blast.warn.elevated', params: { w: (wave.w * 100).toFixed(0) } });
  const at10 = wave.sample(10).dp;
  if (at10 < 200) warnings.push({ key: 'blast.warn.weak', params: { p: at10.toFixed(0) } });
  if (spec.energy < BLAST_LIMITS.energy[0] || spec.energy > BLAST_LIMITS.energy[1]) warnings.push({ key: 'blast.warn.energyRange' });
  // Corner farthest from the release (ground level) → when the front leaves the world.
  let far = 0;
  for (const cx of [W.x0, W.x1]) for (const cz of [W.z0, W.z1]) far = Math.max(far, Math.hypot(cx - x, cz - z, wave.height));
  return {
    spec, ambient: amb, temperature: T, wave, R0: main.R0, rt: main.rt, pulseEnergy: wave.pulseEnergy, efficiency: wave.pulseEnergy / spec.energy,
    validRadius, levelRadii: PRESSURE_LEVELS.map((p) => main.radiusOfPressure(p)), worldExit: wave.sample(far).t, warnings,
  };
}

// ── Shielding boxes from the world document (identical to the runtime's) ─────────

const MIN_HEIGHT = 1.5;

/** Building / wall box that can shield (same rules as the wind obstacles: buildings and walls ≥ 1.5 m). */
export function shieldBoxOf(o: Readonly<WorldObject>): ShieldBox | null {
  if (o.type !== 'building' && o.type !== 'wall') return null;
  const def = getDefinition(o.type);
  const d = def.getDimensions(o.params), k = o.transform.scale;
  const [w, h, dd] = [d[0] * k[0], d[1] * k[1], d[2] * k[2]];
  if (h < MIN_HEIGHT) return null;
  const q = quatFromEuler(o.transform.rotation);
  const xa = qRotate(q, [1, 0, 0]), za = qRotate(q, [0, 0, 1]);
  const nx = Math.hypot(xa[0], xa[2]) || 1, nz = Math.hypot(za[0], za[2]) || 1;
  const p = o.params;
  const height = o.type !== 'building' ? h
    : o.building ? (Number(p.floors) * Number(p.floorHeight) + 0.5 * Math.max(0, Number(p.roofHeight ?? 0) - 0.2)) * k[1]
    : h - 0.7 * k[1];
  return { id: o.id, cx: o.transform.position[0], cz: o.transform.position[2], hx: w / 2, hz: dd / 2, ax: [xa[0] / nx, xa[2] / nx], az: [za[0] / nz, za[2] / nz], height, baseY: o.transform.position[1], active: true };
}

export function shieldIndexOf(objects: Iterable<Readonly<WorldObject>>): ShieldIndex {
  const boxes: ShieldBox[] = [];
  for (const o of objects) { const b = shieldBoxOf(o); if (b) boxes.push(b); }
  return new ShieldIndex(boxes);
}

// ── Ground-level field ──────────────────────────────────────────────

export interface FieldPoint { x: number; z: number; y: number }

/**
 * The field of one or more waves at points FIELD_HEIGHT above the ground on a regular grid: the
 * contributions (arrival, Δp, T per path) are computed once, so the current overpressure at any time
 * is a cheap sum (renderer, inspector), and the arrival / peak / impulse maps follow directly.
 */
export class BlastField {
  readonly nx: number;
  readonly nz: number;
  readonly x0: number;
  readonly z0: number;
  readonly step: number;
  readonly y: Float32Array;
  readonly arrival: Float32Array;
  readonly peak: Float32Array;
  readonly impulse: Float32Array;
  readonly zone: Uint8Array;
  readonly exposure: Uint8Array;
  /** Contributions per point (flattened): start index into `waves`. */
  private readonly start: Int32Array;
  private readonly waves: Contribution[] = [];

  constructor(waves: readonly BlastWave[], ground: GroundHeight, index: ShieldIndex | null, step: number, rect?: { x0: number; z0: number; x1: number; z1: number }) {
    const d = ground.data;
    const X0 = rect?.x0 ?? d.originX, Z0 = rect?.z0 ?? d.originZ;
    const X1 = rect?.x1 ?? d.originX + (d.nx - 1) * d.cellSize, Z1 = rect?.z1 ?? d.originZ + (d.nz - 1) * d.cellSize;
    this.step = step;
    this.x0 = X0; this.z0 = Z0;
    this.nx = Math.floor((X1 - X0) / step) + 1;
    this.nz = Math.floor((Z1 - Z0) / step) + 1;
    const n = this.nx * this.nz;
    this.y = new Float32Array(n);
    this.arrival = new Float32Array(n).fill(Infinity);
    this.peak = new Float32Array(n);
    this.impulse = new Float32Array(n);
    this.zone = new Uint8Array(n);
    this.exposure = new Uint8Array(n);
    this.start = new Int32Array(n + 1);
    const tmp: Contribution[] = [];
    for (let iz = 0; iz < this.nz; iz++) for (let ix = 0; ix < this.nx; ix++) {
      const i = iz * this.nx + ix;
      const x = X0 + ix * step, z = Z0 + iz * step;
      const y = ground.sampleHeight(x, z) + FIELD_HEIGHT;
      this.y[i] = y;
      this.start[i] = this.waves.length;
      tmp.length = 0;
      let exp: Exposure = 'direct';
      for (const w of waves) {
        const p: Vec3 = [x, y, z];
        const s = w.sample(Math.hypot(x - w.init.position[0], y - w.init.position[1], z - w.init.position[2]));
        const sh = shielding(w.init.position, p, s.T, w.sourceAmbient.c, ground, index);
        if (sh.kind !== 'direct' && exp === 'direct') exp = sh.kind;
        w.contributions(p, sh, tmp);
      }
      let worst = 0, first = Infinity;
      for (const c of tmp) {
        this.waves.push(c);
        first = Math.min(first, c.t);
        worst = Math.max(worst, ZONE_CODE[c.zone]);
      }
      this.arrival[i] = first;
      this.peak[i] = peakOf(tmp);
      this.impulse[i] = positiveImpulseOf(tmp);
      this.zone[i] = worst;
      this.exposure[i] = exp === 'direct' ? 0 : exp === 'terrain' ? 1 : 2;
    }
    this.start[n] = this.waves.length;
  }

  /** Superposed overpressure at grid point i and absolute time t (Pa). */
  pressureAt(i: number, t: number): number {
    let p = 0;
    for (let k = this.start[i]; k < this.start[i + 1]; k++) p += pressure(this.waves[k], t);
    return p;
  }

  /** Contributions at grid point i. */
  contributionsAt(i: number): Contribution[] {
    return this.waves.slice(this.start[i], this.start[i + 1]);
  }

  indexAt(x: number, z: number): number {
    const ix = Math.round((x - this.x0) / this.step), iz = Math.round((z - this.z0) / this.step);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }
}

export const ZONE_CODE: Record<Zone, number> = { weak: 0, transition: 1, strong: 2, core: 3 };
export const ZONES: Zone[] = ['weak', 'transition', 'strong', 'core'];

/** Ground of a terrain for the wave functions. */
export const groundOf = (t: TerrainData): GroundHeight => samplerFor(t);

/** Points-of-interest helper for the validity check in the preview (Δp/p₀ ≤ 0.3). */
export const WEAK = WEAK_LIMIT;
