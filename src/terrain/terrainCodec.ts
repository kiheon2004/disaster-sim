/**
 * Compact, exact save format for terrain layers.
 *
 *  elevation: int16 centimeters, delta-coded along rows, zigzag varints with run-length
 *             compression of repeated deltas → a flat or smoothly sloped area costs a few bytes;
 *             omitted entirely for a flat terrain.
 *  ground:    byte runs (value, run length) → large painted areas are tiny.
 *  soil:      same byte-run format as ground (schema v3); omitted when all default soil.
 *
 * Both are base64 strings inside the JSON document. Heights are stored at the same 1 cm
 * quantum the editor writes, so save → load reproduces the in-memory terrain bit for bit.
 */
import type { TerrainData, TerrainSettings } from '@/core/model';
import { createFlatTerrain, defaultTerrainSettings, isDefaultGround, isDefaultSoil, isFlat } from './TerrainData';
import { DEFAULT_SOIL } from './SoilProfiles';

export interface SerializedTerrain {
  kind: 'heightfield';
  nx: number;
  nz: number;
  cellSize: number;
  originX: number;
  originZ: number;
  /** null = all 0 m. */
  elevation: { encoding: 'cm-delta-rle'; data: string } | null;
  /** null = all default ground. */
  ground: { encoding: 'u8-rle'; data: string } | null;
  /** Soil profile layer (schema v3). null / absent = all default soil (dense soil). */
  soil?: { encoding: 'u8-rle'; data: string } | null;
  settings: TerrainSettings;
}

// ── byte buffer + base64 ────────────────────────────────────────────────────

class Bytes {
  buf = new Uint8Array(1024);
  n = 0;
  push(b: number) {
    if (this.n === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = b;
  }
  varint(v: number) {
    while (v >= 0x80) {
      this.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.push(v);
  }
  bytes() {
    return this.buf.subarray(0, this.n);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  varint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (this.i >= this.b.length) throw new Error('terrain data truncated');
      const c = this.b[this.i++];
      v += (c & 0x7f) * 2 ** shift;
      if (c < 0x80) return v;
      shift += 7;
    }
  }
}

const zig = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

// ── elevation ───────────────────────────────────────────────────────────────

export function encodeElevation(h: Float32Array, nx: number): string {
  const out = new Bytes();
  // Deltas of the centimeter values along each row (first value of a row vs. the previous row start).
  let runValue = NaN;
  let runLen = 0;
  const flush = () => {
    if (runLen === 0) return;
    out.varint(zig(runValue));
    out.varint(runLen - 1);
  };
  let prevRowStart = 0;
  for (let i = 0; i < h.length; i++) {
    const cm = Math.round(h[i] * 100);
    let delta: number;
    if (i % nx === 0) {
      delta = cm - prevRowStart;
      prevRowStart = cm;
    } else delta = cm - Math.round(h[i - 1] * 100);
    if (delta === runValue) runLen++;
    else {
      flush();
      runValue = delta;
      runLen = 1;
    }
  }
  flush();
  return toBase64(out.bytes());
}

export function decodeElevation(data: string, out: Float32Array, nx: number) {
  const r = new Reader(fromBase64(data));
  let i = 0;
  let prev = 0;
  let prevRowStart = 0;
  while (i < out.length) {
    const delta = unzig(r.varint());
    const len = r.varint() + 1;
    for (let k = 0; k < len && i < out.length; k++, i++) {
      const cm = i % nx === 0 ? prevRowStart + delta : prev + delta;
      if (i % nx === 0) prevRowStart = cm;
      prev = cm;
      out[i] = cm / 100;
    }
  }
}

// ── ground ──────────────────────────────────────────────────────────────────

export function encodeGround(g: Uint8Array): string {
  const out = new Bytes();
  let i = 0;
  while (i < g.length) {
    const v = g[i];
    let j = i + 1;
    while (j < g.length && g[j] === v) j++;
    out.push(v);
    out.varint(j - i - 1);
    i = j;
  }
  return toBase64(out.bytes());
}

export function decodeGround(data: string, out: Uint8Array) {
  const b = fromBase64(data);
  const r = new Reader(b);
  let i = 0;
  while (i < out.length && r.i < b.length) {
    const v = b[r.i++];
    const len = r.varint() + 1;
    out.fill(v, i, Math.min(out.length, i + len));
    i += len;
  }
}

// ── public API ──────────────────────────────────────────────────────────────

export function encodeTerrain(t: TerrainData): SerializedTerrain {
  return {
    kind: 'heightfield',
    nx: t.nx,
    nz: t.nz,
    cellSize: t.cellSize,
    originX: t.originX,
    originZ: t.originZ,
    elevation: isFlat(t) ? null : { encoding: 'cm-delta-rle', data: encodeElevation(t.heights, t.nx) },
    ground: isDefaultGround(t) ? null : { encoding: 'u8-rle', data: encodeGround(t.ground) },
    soil: isDefaultSoil(t) ? null : { encoding: 'u8-rle', data: encodeGround(t.soil) },
    settings: { ...t.settings },
  };
}

export function decodeTerrain(s: SerializedTerrain): TerrainData {
  const n = s.nx * s.nz;
  if (!(s.nx >= 2 && s.nz >= 2 && n <= 4_000_000)) throw new Error('terrain grid size out of range');
  const t = createFlatTerrain(2, 1);
  t.nx = s.nx;
  t.nz = s.nz;
  t.cellSize = s.cellSize;
  t.originX = s.originX;
  t.originZ = s.originZ;
  t.heights = new Float32Array(n);
  t.ground = new Uint8Array(n);
  t.soil = new Uint8Array(n).fill(DEFAULT_SOIL);
  if (s.elevation) decodeElevation(s.elevation.data, t.heights, s.nx);
  if (s.ground) decodeGround(s.ground.data, t.ground);
  if (s.soil) decodeGround(s.soil.data, t.soil);
  t.settings = { ...defaultTerrainSettings(), ...s.settings };
  return t;
}
