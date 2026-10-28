/**
 * Mid-simulation water state (Phase 14) — deliberately SEPARATE from the project file.
 *
 *   project file (*.world.json)      what to simulate: terrain, objects, water settings,
 *                                    boundary conditions, configured flood events
 *   water state (*.water.json)       a snapshot of the water at some simulation time:
 *                                    depth + soil saturation per cell and the mass budget
 *
 * A water state can be loaded as the INITIAL condition of a new run on the same terrain (the
 * terrain fingerprint is checked). Velocities are not stored — the water restarts from rest —
 * and rigid bodies / damage are not part of it (the physics world cannot be serialized
 * mid-run). Values are quantized to 0.01 mm and zero-run-length encoded, so a mostly dry map
 * is a few kilobytes.
 */
import type { TerrainData } from '@/core/model';
import { WET_DEPTH } from './waterParams';
import type { WaterBudget, WaterField } from './WaterField';

export const WATER_STATE_KIND = 'disaster-sim/water-state';
const Q = 1e5; // units per meter (0.01 mm)

export interface WaterStateSnapshot {
  kind: typeof WATER_STATE_KIND;
  version: 1;
  /** Simulation time the snapshot was taken at (s). */
  time: number;
  grid: { nx: number; nz: number; cell: number; originX: number; originZ: number };
  /** FNV-1a of the terrain heights: a state only fits the terrain it was computed on. */
  terrainHash: string;
  depth: string;
  infiltrated: string;
  budget: WaterBudget;
}

export function terrainFingerprint(t: TerrainData): string {
  const bytes = new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0') + `-${t.nx}x${t.nz}`;
}

/** Quantize + zero-run-length encode → base64 of an Int32 stream (run = −count). */
function encode(values: ArrayLike<number>): string {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < values.length; i++) {
    const q = Math.round(values[i] * Q);
    if (q === 0) {
      zeros++;
      continue;
    }
    if (zeros) {
      out.push(-zeros);
      zeros = 0;
    }
    out.push(q);
  }
  if (zeros) out.push(-zeros);
  const bytes = new Uint8Array(Int32Array.from(out).buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decode(data: string, n: number): Float64Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length % 4) throw new Error('corrupt water state');
  const stream = new Int32Array(bytes.buffer);
  const out = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < stream.length; i++) {
    const v = stream[i];
    if (v < 0) k += -v;
    else if (k < n) out[k++] = v / Q;
    if (k > n) throw new Error('corrupt water state');
  }
  if (k !== n) throw new Error('water state does not match the grid');
  return out;
}

export function captureWaterState(field: WaterField, time: number): WaterStateSnapshot {
  return {
    kind: WATER_STATE_KIND,
    version: 1,
    time,
    grid: { nx: field.nx, nz: field.nz, cell: field.cell, originX: field.originX, originZ: field.originZ },
    terrainHash: terrainFingerprint(field.terrain.data),
    depth: encode(field.h),
    infiltrated: encode(field.infiltrated),
    budget: { ...field.budget },
  };
}

export function serializeWaterState(s: WaterStateSnapshot): string {
  return JSON.stringify(s);
}

export type WaterStateLoad = { ok: true; state: WaterStateSnapshot } | { ok: false; error: string };

export function parseWaterState(json: string, terrain: TerrainData): WaterStateLoad {
  let raw: Partial<WaterStateSnapshot>;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (raw.kind !== WATER_STATE_KIND || raw.version !== 1 || !raw.grid || typeof raw.depth !== 'string') return { ok: false, error: 'not a water state file' };
  if (raw.terrainHash !== terrainFingerprint(terrain)) return { ok: false, error: 'terrain differs from the one the water state was computed on' };
  try {
    decode(raw.depth, raw.grid.nx * raw.grid.nz);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, state: raw as WaterStateSnapshot };
}

/** Write a snapshot into a freshly built field (blocked cells stay dry). */
export function applyWaterState(field: WaterField, s: WaterStateSnapshot) {
  const n = field.count;
  if (s.grid.nx !== field.nx || s.grid.nz !== field.nz) throw new Error('water state does not match the grid');
  const depth = decode(s.depth, n);
  const infil = decode(s.infiltrated, n);
  for (let i = 0; i < n; i++) {
    if (field.blocked[i]) continue;
    field.h[i] = depth[i];
    field.infiltrated[i] = infil[i];
    if (depth[i] > 0) {
      const ix = i % field.nx;
      field.touch(ix, (i - ix) / field.nx);
    }
    if (depth[i] >= WET_DEPTH && depth[i] > field.maxDepth[i]) field.maxDepth[i] = depth[i];
  }
}
