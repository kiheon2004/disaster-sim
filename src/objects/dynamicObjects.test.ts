/**
 * Phase 35 Level 1 passive dynamic objects: mass properties against hand calculations (formulas written here
 * independently of objects/massProperties.ts), colliders against the dimensions, and short headless runs — the inertia
 * Rapier actually uses (ω = I⁻¹·L after a torque impulse), rolling down a slope (a = g sinθ / (1 + I/(m r²))), sliding
 * or sticking per friction (μ vs tan θ), floating per density in still flood water, breakage from a strike.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import { defaultWaterSettings, type BoundarySide } from '@/core/model';
import type { ShapeSpec } from '@/core/shapes';
import { GRAVITY } from '@/core/units';
import { getDefinition } from '@/objects/registry';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { buildWorld, slope } from '@/human/demos';
import { SimulationController } from '@/simulation/SimulationController';
import { TerrainSampler } from '@/terrain/TerrainSampler';
import { WaterField } from '@/simulation/water/WaterField';
import { captureWaterState } from '@/simulation/water/waterStateCodec';
import { objectCategory } from '@/simulation/response/ObjectResponse';
import { bodyMassProps, principal } from './massProperties';
import type { EventSpec } from '@/events/specs';
import { DamageState } from '@/simulation/damage/DamageState';

const DEG = Math.PI / 180;
const close = (a: number, b: number, rel = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));
const tf = (x: number, z: number, rot: Vec3 = [0, 0, 0], y = 0) => ({ position: [x, y, z] as Vec3, rotation: rot, scale: [1, 1, 1] as Vec3 });

/** Mass properties of a type for the given params, as the body gets them (default mass, unit scale). */
function props(type: Parameters<typeof getDefinition>[0], params: Record<string, unknown> = {}) {
  const def = getDefinition(type);
  const p = { ...def.defaultParams, ...params } as never;
  const mass = def.defaultPhysics(p).mass;
  const mm = def.passive!.massModel(p);
  return { def, p, mass, mm, body: bodyMassProps(mm, mass, [1, 1, 1]) };
}

// ── hand formulas (independent of the part-model code) ──

/** Closed thin-walled box of uniform areal density, sizes a (x) × b (y) × c (z): per-face plate inertias about the centre. */
function shellBoxI(m: number, a: number, b: number, c: number): Vec3 {
  const sigma = m / (2 * (b * c + a * c + a * b));
  // About x: x-faces (b×c plates through the axis), y-faces (a×c at y = ±b/2), z-faces (a×b at z = ±c/2).
  const ix = 2 * sigma * (b * c * (b * b + c * c) / 12 + a * c * (c * c / 12 + b * b / 4) + a * b * (b * b / 12 + c * c / 4));
  const iy = 2 * sigma * (a * c * (a * a + c * c) / 12 + b * c * (c * c / 12 + a * a / 4) + a * b * (a * a / 12 + c * c / 4));
  const iz = 2 * sigma * (a * b * (a * a + b * b) / 12 + b * c * (b * b / 12 + a * a / 4) + a * c * (a * a / 12 + b * b / 4));
  return [ix, iy, iz];
}
/** Solid box about its own centre: Ixx = m(b² + c²)/12 … */
const boxI = (m: number, a: number, b: number, c: number): Vec3 => [(m * (b * b + c * c)) / 12, (m * (a * a + c * c)) / 12, (m * (a * a + b * b)) / 12];

interface HandPart { m: number; I: Vec3; c: Vec3 }
/** Full inertia tensor [xx, yy, zz, xy, xz, yz] of parts about their common COM (parallel axis incl. products). */
function tensor(parts: HandPart[]) {
  const M = parts.reduce((s, p) => s + p.m, 0);
  const C = [0, 1, 2].map((k) => parts.reduce((s, p) => s + p.m * p.c[k], 0) / M) as Vec3;
  const T = [0, 0, 0, 0, 0, 0];
  for (const p of parts) {
    const d = [p.c[0] - C[0], p.c[1] - C[1], p.c[2] - C[2]];
    T[0] += p.I[0] + p.m * (d[1] ** 2 + d[2] ** 2);
    T[1] += p.I[1] + p.m * (d[0] ** 2 + d[2] ** 2);
    T[2] += p.I[2] + p.m * (d[0] ** 2 + d[1] ** 2);
    T[3] -= p.m * d[0] * d[1];
    T[4] -= p.m * d[0] * d[2];
    T[5] -= p.m * d[1] * d[2];
  }
  return { M, C, T };
}

/** Body-frame tensor R·diag(I)·Rᵀ of principal moments I in the frame quaternion q. */
function fromPrincipal(I: Vec3, q: [number, number, number, number]) {
  const [x, y, z, w] = q;
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const t = (i: number, j: number) => R[i][0] * I[0] * R[j][0] + R[i][1] * I[1] * R[j][1] + R[i][2] * I[2] * R[j][2];
  return [t(0, 0), t(1, 1), t(2, 2), t(0, 1), t(0, 2), t(1, 2)];
}

function expectDiagonal(body: { com: Vec3; inertia: Vec3; frame: number[] }, com: Vec3, I: Vec3, rel = 1e-9) {
  for (let k = 0; k < 3; k++) close(body.com[k], com[k], rel);
  for (let k = 0; k < 3; k++) close(body.inertia[k], I[k], rel);
  expect(body.frame).toEqual([0, 0, 0, 1]);
}

/** Axis-aligned bounds of the colliders (local). */
function colliderBounds(shapes: ShapeSpec[]) {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes) {
    const o = s.offset ?? [0, 0, 0];
    const h: Vec3 = s.type === 'box' ? s.halfExtents : s.type === 'ball' ? [s.radius, s.radius, s.radius] : [s.radius, s.halfHeight + (s.type === 'capsule' ? s.radius : 0), s.radius];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], o[k] - h[k]); hi[k] = Math.max(hi[k], o[k] + h[k]); }
  }
  return { lo, hi };
}

describe('passive objects: mass properties (hand calculation)', () => {
  it('crate (wood, steel, plastic; empty and loaded): thin closed shell ρ·t·A + cargo block', () => {
    for (const [material, rho, t] of [['wood', 500, 0.02], ['steel', 7850, 0.002], ['plastic', 950, 0.005]] as const) {
      const L = 1.2, H = 0.8, W = 0.8;
      const shell = rho * t * 2 * (L * H + L * W + H * W);
      const { mass, body } = props('crate', { material, length: L, height: H, width: W, cargo: 0 });
      close(mass, Math.round(shell * 10) / 10);
      // Inertia scales with the stored (rounded) mass: same distribution.
      expectDiagonal(body, [0, H / 2, 0], shellBoxI(mass, L, H, W));
      const cargo = 150;
      const loaded = props('crate', { material, length: L, height: H, width: W, cargo });
      const ci = boxI(cargo, L - 2 * t, H - 2 * t, W - 2 * t);
      const si = shellBoxI(shell, L, H, W);
      const k = loaded.mass / (shell + cargo);
      expectDiagonal(loaded.body, [0, H / 2, 0], [k * (si[0] + ci[0]), k * (si[1] + ci[1]), k * (si[2] + ci[2])]);
    }
    expect(props('crate').mass).toBe(51.2);
  });

  it('barrel: 1.2 mm steel shell (tube + two discs) ≈ 20 kg, + 208 L contents as a liquid column on the bottom', () => {
    const r = 0.286, h = 0.88, t = 0.0012;
    const ms = 7850 * t * 2 * Math.PI * r * h;
    const me = 7850 * t * Math.PI * r * r;
    const empty = props('barrel', { fill: 'empty' });
    expect(empty.mass).toBeCloseTo(19.7, 1);
    const kE = empty.mass / (ms + 2 * me);
    const Iyy = ms * r * r + 2 * (me * r * r) / 2;
    const Ixx = ms * (r * r / 2 + h * h / 12) + 2 * me * (r * r / 4 + (h / 2) ** 2);
    expectDiagonal(empty.body, [0, h / 2, 0], [kE * Ixx, kE * Iyy, kE * Ixx]);
    for (const [fill, rho] of [['water', 1000], ['oil', 850]] as const) {
      const mc = rho * 0.208;
      const hc = 0.208 / (Math.PI * r * r);
      const M = ms + 2 * me + mc;
      const Y = ((ms + 2 * me) * (h / 2) + mc * (hc / 2)) / M;
      const iyy = Iyy + (mc * r * r) / 2;
      const ixx = Ixx + (ms + 2 * me) * (h / 2 - Y) ** 2 + (mc * (3 * r * r + hc * hc)) / 12 + mc * (hc / 2 - Y) ** 2;
      const b = props('barrel', { fill });
      const k = b.mass / M;
      expectDiagonal(b.body, [0, Y, 0], [k * ixx, k * iyy, k * ixx]);
    }
    expect(props('barrel', { fill: 'water' }).mass).toBeCloseTo(19.7 + 208, 0);
  });

  it('container 20 ft / 40 ft: ISO 668 size, tare (35 % base slab + 65 % shell) and cargo on the inner floor', () => {
    for (const [size, L, tare, inner] of [['20ft', 6.058, 2230, [5.898, 2.393, 2.352]], ['40ft', 12.192, 3750, [12.032, 2.393, 2.352]]] as const) {
      const H = 2.591, W = 2.438;
      for (const cargo of [0, 12000]) {
        const parts: HandPart[] = [
          { m: 0.35 * tare, I: boxI(0.35 * tare, L, 0.16, W), c: [0, 0.08, 0] },
          { m: 0.65 * tare, I: shellBoxI(0.65 * tare, L, H, W), c: [0, H / 2, 0] },
        ];
        if (cargo) parts.push({ m: cargo, I: boxI(cargo, inner[0], inner[1], inner[2]), c: [0, 0.16 + inner[1] / 2, 0] });
        const { M, C, T } = tensor(parts);
        const b = props('container', { size, cargo });
        expect(b.mass).toBeCloseTo(M, 6);
        expectDiagonal(b.body, C, [T[0], T[1], T[2]]);
        expect(b.def.getDimensions(b.p)).toEqual([L, H, W]);
      }
    }
    // Cargo above the max payload is clamped.
    expect(props('container', { size: '20ft', cargo: 1e6 }).mass).toBe(2230 + 28250);
  });

  it('furniture: sofa (asymmetric: principal frame), table (top + four legs, parallel axis), cabinet (panel shell)', () => {
    const L = 2.0, H = 0.85, W = 0.9, m = 55;
    const sofaParts: HandPart[] = [
      { m: 0.6 * m, I: boxI(0.6 * m, L, H / 2, W), c: [0, H / 4, 0] },
      { m: 0.25 * m, I: boxI(0.25 * m, L, H / 2, 0.22 * W), c: [0, 0.75 * H, -W / 2 + 0.11 * W] },
      ...[-1, 1].map((s) => ({ m: 0.075 * m, I: boxI(0.075 * m, 0.08 * L, 0.2 * H, 0.78 * W), c: [s * (L / 2 - 0.04 * L), 0.6 * H, -W / 2 + 0.22 * W + 0.39 * W] as Vec3 })),
    ];
    const sofa = tensor(sofaParts);
    const s = props('furniture', { kind: 'sofa' });
    expect(s.mass).toBe(55);
    for (let k = 0; k < 3; k++) close(s.body.com[k], sofa.C[k]);
    // The back makes I_yz ≠ 0: the principal moments and frame reproduce the full hand tensor.
    expect(Math.abs(sofa.T[5])).toBeGreaterThan(0.1);
    const back = fromPrincipal(s.body.inertia, s.body.frame);
    for (let k = 0; k < 6; k++) close(back[k], sofa.T[k], 1e-9);

    const tL = 1.6, tH = 0.75, tW = 0.9, tm = 40;
    const legs = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => ({ m: 0.075 * tm, I: boxI(0.075 * tm, 0.07, tH - 0.05, 0.07), c: [x * (tL / 2 - 0.1), (tH - 0.05) / 2, z * (tW / 2 - 0.1)] as Vec3 }));
    const table = tensor([{ m: 0.7 * tm, I: boxI(0.7 * tm, tL, 0.05, tW), c: [0, tH - 0.025, 0] }, ...legs]);
    const tb = props('furniture', { kind: 'table', length: tL, height: tH, width: tW });
    expect(tb.mass).toBe(40);
    expectDiagonal(tb.body, table.C, [table.T[0], table.T[1], table.T[2]]);

    const cb = props('furniture', { kind: 'cabinet', length: 1.0, height: 1.9, width: 0.55 });
    expect(cb.mass).toBe(70);
    expectDiagonal(cb.body, [0, 0.95, 0], shellBoxI(70, 1.0, 1.9, 0.55));
    // A resized piece keeps its bulk density.
    expect(props('furniture', { kind: 'cabinet', length: 2.0, height: 1.9, width: 0.55 }).mass).toBe(140);
  });

  it('road barrier: NJ profile as three concrete bands, 2400 kg/m³ → ≈ 606 kg/m', () => {
    const Lb = 3.0;
    const bands = [[0, 0.075, 0.61], [0.075, 0.33, 0.4315], [0.33, 0.81, 0.2015]];
    const parts = bands.map(([y0, y1, w]) => { const mb = 2400 * (y1 - y0) * w * Lb; return { m: mb, I: boxI(mb, Lb, y1 - y0, w), c: [0, (y0 + y1) / 2, 0] as Vec3 }; });
    const { M, C, T } = tensor(parts);
    const b = props('roadBarrier', { length: Lb });
    expect(M / Lb).toBeCloseTo(606, 0);
    expect(b.mass).toBe(Math.round(M * 10) / 10);
    const k = b.mass / M;
    expectDiagonal(b.body, C, [k * T[0], k * T[1], k * T[2]]);
  });

  it('ball: solid 2/5 m r², thin shell 2/3 m r², COM at the centre', () => {
    const solid = props('ball', { radius: 0.3, mass: 8, construction: 'solid' });
    expectDiagonal(solid.body, [0, 0.3, 0], [0.4 * 8 * 0.09, 0.4 * 8 * 0.09, 0.4 * 8 * 0.09]);
    const shell = props('ball', { radius: 0.35, mass: 1.5, construction: 'shell' });
    expectDiagonal(shell.body, [0, 0.35, 0], [(2 / 3) * 1.5 * 0.1225, (2 / 3) * 1.5 * 0.1225, (2 / 3) * 1.5 * 0.1225]);
  });

  it('object scale and user mass: COM·k, second moments ∝ k_i·k_j, inertia ∝ mass', () => {
    // A barrier stretched ×2 along its length is exactly the 6 m barrier (full-length bands).
    const short = props('roadBarrier', { length: 3 });
    const long = props('roadBarrier', { length: 6 });
    const b = bodyMassProps(short.mm, long.mass, [2, 1, 1]);
    for (let k = 0; k < 3; k++) { close(b.com[k], long.body.com[k]); close(b.inertia[k], long.body.inertia[k]); }
    // Same distribution, twice the mass: twice the inertia.
    const twice = bodyMassProps(short.mm, 2 * short.mass, [1, 1, 1]);
    for (let k = 0; k < 3; k++) close(twice.inertia[k], 2 * short.body.inertia[k]);
    // Second moments → principal moments: I = (S_yy + S_zz, S_xx + S_zz, S_xx + S_yy).
    expect(principal({ mass: 10, com: [0, 1, 0], S: [4, 1, 1, 0, 0, 0] }).inertia).toEqual([2, 5, 5]);
  });
});

describe('passive objects: definitions', () => {
  const cases: [Parameters<typeof getDefinition>[0], Record<string, unknown>][] = [
    ['crate', {}], ['crate', { material: 'steel', length: 2, width: 1, height: 1.5 }], ['barrel', {}], ['container', {}], ['container', { size: '40ft' }],
    ['furniture', { kind: 'sofa' }], ['furniture', { kind: 'table', length: 1.6, width: 0.9, height: 0.75 }], ['furniture', { kind: 'cabinet', length: 1, width: 0.55, height: 1.9 }],
    ['roadBarrier', {}], ['ball', {}],
  ];
  it('colliders fill exactly the dimensions (origin at the base centre), dynamic profile, drag / friction set, objects category', () => {
    for (const [type, params] of cases) {
      const def = getDefinition(type);
      const p = { ...def.defaultParams, ...params } as never;
      const d = def.getDimensions(p);
      const { lo, hi } = colliderBounds(def.colliders(p));
      for (const k of [0, 2]) { close(lo[k], -d[k] / 2, 1e-12); close(hi[k], d[k] / 2, 1e-12); }
      close(lo[1], 0, 1e-12);
      close(hi[1], d[1], 1e-12);
      expect(def.physicsProfile).toBe('dynamic');
      expect(def.category).toBe('objects');
      expect(objectCategory(type)).toBe('object');
      const ph = def.defaultPhysics(p);
      expect(ph.dragCoefficient).toBeGreaterThan(0.4);
      expect(ph.friction).toBeGreaterThan(0.3);
      expect(def.passive!.displacedVolume(p)).toBeGreaterThan(0);
    }
    expect(getDefinition('barrel').colliders(getDefinition('barrel').defaultParams)[0]).toMatchObject({ type: 'cylinder', radius: 0.286, halfHeight: 0.44 });
    expect(getDefinition('ball').colliders(getDefinition('ball').defaultParams)[0]).toMatchObject({ type: 'ball', radius: 0.3, offset: [0, 0.3, 0] });
    // Older types: unchanged response category, no passive model.
    expect(objectCategory('car')).toBe('vehicle');
    expect(getDefinition('car').passive).toBeUndefined();
  });

  it('water: displaced volume vs mass → float or sink as the density says', () => {
    const rho = (type: Parameters<typeof getDefinition>[0], params: Record<string, unknown> = {}) => {
      const def = getDefinition(type);
      const p = { ...def.defaultParams, ...params } as never;
      return def.defaultPhysics(p).mass / def.passive!.displacedVolume(p);
    };
    const V = Math.PI * 0.286 ** 2 * 0.88;
    const near = (a: number, b: number, rel: number) => expect(Math.abs(a - b) / b).toBeLessThan(rel);
    // (The stored mass is rounded to 0.1 kg: ≤ 2.5e-3 relative for the 19.7 kg drum.)
    near(rho('barrel', { fill: 'empty' }), 19.738 / V, 2.5e-3);
    expect(rho('barrel', { fill: 'oil' })).toBeLessThan(1000);
    expect(rho('barrel', { fill: 'water' })).toBeGreaterThan(1000);
    near(rho('crate', { material: 'wood' }), 500, 1e-3);
    near(rho('crate', { material: 'steel' }), 7850, 1e-3);
    expect(rho('crate', { material: 'steel', sealed: true })).toBeLessThan(1000);
    near(rho('roadBarrier'), 2400, 1e-3);
    expect(rho('container', { cargo: 0 })).toBeLessThan(100);
    near(rho('furniture', { kind: 'sofa' }), 300, 1e-3);
  });
});

// ── headless simulation ──

async function controller(doc: WorldDocument) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  return c;
}
const entity = (c: SimulationController, type: string, k = 0) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === type)[k];

/** A world without people settings (buildWorld turns the extended human model on). */
function slopeWorld(deg: number, objects: Parameters<typeof buildWorld>[0]['objects']) {
  const doc = buildWorld({ seed: 3501, height: slope(deg, 0, 40), objects, name: 'passive objects' });
  delete doc.settings.simulation.humans;
  return doc;
}

describe('passive objects in the simulation', { timeout: 240_000 }, () => {
  it('Rapier uses the explicit inertia: a torque impulse L gives ω = I⁻¹·L (incl. the sofa\'s full tensor) and the total mass', async () => {
    const doc = slopeWorld(0, [
      { type: 'container', seed: 1, lift: 30, params: { size: '20ft', cargo: 12000 }, transform: tf(-20, 0) },
      { type: 'furniture', seed: 2, lift: 30, params: { kind: 'sofa', length: 2, width: 0.9, height: 0.85 }, transform: tf(0, 0) },
      { type: 'barrel', seed: 3, lift: 30, params: { fill: 'oil' }, transform: tf(20, 0) },
    ]);
    const c = await controller(doc);
    c.advance(1 / 60);
    const ph = c.getPhysics()!;
    for (const type of ['container', 'furniture', 'barrel']) {
      const e = entity(c, type);
      const { mm, mass } = props(type as never, e.source.params);
      // (Rapier stores single precision.)
      expect(Math.abs(ph.getMass(e.body!) - mass) / mass).toBeLessThan(1e-6);
      const b = bodyMassProps(mm, mass, [1, 1, 1]);
      const T = fromPrincipal(b.inertia, b.frame);
      const I = [[T[0], T[3], T[4]], [T[3], T[1], T[5]], [T[4], T[5], T[2]]];
      for (const axis of [0, 1, 2]) {
        const w0 = ph.getAngularVelocity(e.body!);
        const L: Vec3 = [0, 0, 0];
        L[axis] = 10;
        ph.applyTorqueImpulse(e.body!, L);
        const w1 = ph.getAngularVelocity(e.body!);
        const dw = [w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]];
        // I·Δω = L (Rapier stores single-precision inertia: 1e-4 relative).
        for (let i = 0; i < 3; i++) {
          const li = I[i][0] * dw[0] + I[i][1] * dw[1] + I[i][2] * dw[2];
          expect(Math.abs(li - L[i])).toBeLessThan(1e-3 * 10);
        }
      }
    }
    c.unload();
  });

  it('a ball rolls down a 10° slope without slipping: a = (5/7) g sinθ solid, (3/5) g sinθ hollow shell', async () => {
    const th = 10 * DEG;
    const doc = slopeWorld(10, [
      { type: 'ball', seed: 1, lift: 0.01, params: { radius: 0.3, mass: 8, construction: 'solid' }, transform: tf(-25, -3) },
      { type: 'ball', seed: 2, lift: 0.01, params: { radius: 0.3, mass: 8, construction: 'shell' }, transform: tf(-25, 3) },
    ]);
    const c = await controller(doc);
    const ph = c.getPhysics()!;
    c.advance(0.5);
    const along = (v: Vec3) => v[0] * Math.cos(th) - v[1] * Math.sin(th);
    const v0 = [entity(c, 'ball', 0), entity(c, 'ball', 1)].map((e) => along(ph.getLinearVelocity(e.body!)));
    c.advance(2);
    const v1 = [entity(c, 'ball', 0), entity(c, 'ball', 1)].map((e) => along(ph.getLinearVelocity(e.body!)));
    const a = [(v1[0] - v0[0]) / 2, (v1[1] - v0[1]) / 2];
    // Rolling needs μ ≥ (2/7) tanθ = 0.05 (solid), (2/5) tanθ = 0.07 (shell); μ_eff = (0.8 + 0.9)/2 = 0.85.
    const solid = (5 / 7) * GRAVITY * Math.sin(th);
    const shell = (3 / 5) * GRAVITY * Math.sin(th);
    expect(Math.abs(a[0] - solid) / solid).toBeLessThan(0.05);
    expect(Math.abs(a[1] - shell) / shell).toBeLessThan(0.05);
    // Rolling, not sliding: v = ω r.
    const e0 = entity(c, 'ball', 0);
    const w = ph.getAngularVelocity(e0.body!);
    expect(Math.abs(Math.hypot(...w) * 0.3 - Math.hypot(...ph.getLinearVelocity(e0.body!))) / Math.hypot(...ph.getLinearVelocity(e0.body!))).toBeLessThan(0.05);
    c.unload();
  });

  it('a wooden crate holds on 30° (tanθ 0.58 < μ 0.75) and slides on 42° with a = g(sinθ − μ cosθ)', async () => {
    // Effective Coulomb μ = Rapier's average of the crate (0.6 × grass 1.0) and the terrain collider (0.9) = 0.75.
    const mu = (0.6 + 0.9) / 2;
    const run = async (deg: number) => {
      const th = deg * DEG;
      const doc = slopeWorld(deg, [{ type: 'crate', seed: 1, lift: 0.005, params: { material: 'wood' }, transform: tf(-8, 0, [0, 0, -th]) }]);
      const c = await controller(doc);
      const ph = c.getPhysics()!;
      c.advance(0.5);
      const e = entity(c, 'crate');
      const p0 = [...e.pose.position];
      const along = (v: Vec3) => v[0] * Math.cos(th) - v[1] * Math.sin(th);
      const v0 = along(ph.getLinearVelocity(e.body!));
      c.advance(1);
      const v1 = along(ph.getLinearVelocity(e.body!));
      const moved = Math.hypot(e.pose.position[0] - p0[0], e.pose.position[1] - p0[1]);
      // Pitch about z (the only way it could tip on this slope), relative to the slope.
      const tilt = 2 * Math.atan2(e.pose.quaternion[2], e.pose.quaternion[3]) + th;
      c.unload();
      return { a: v1 - v0, moved, tilt };
    };
    const hold = await run(30);
    expect(Math.tan(30 * DEG)).toBeLessThan(mu);
    expect(hold.moved).toBeLessThan(0.02);
    const slide = await run(42);
    const expected = GRAVITY * (Math.sin(42 * DEG) - mu * Math.cos(42 * DEG));
    expect(Math.abs(slide.a - expected) / expected).toBeLessThan(0.1);
    // It slides, not tumbles: tipping needs tanθ > L/H = 1.5 (56°).
    expect(Math.abs(slide.tilt)).toBeLessThan(0.02);
  });

  it('breakage: a 100 kg ball dropped 4 m onto a wooden crate breaks it (IMPACT, one BROKEN); the ball never breaks', async () => {
    const doc = slopeWorld(0, [
      { type: 'crate', seed: 1, params: { material: 'wood' }, transform: tf(0, 0) },
      { type: 'ball', seed: 2, lift: 4, params: { radius: 0.3, mass: 100, construction: 'solid' }, transform: tf(0, 0) },
    ]);
    const c = await controller(doc);
    c.advance(3);
    const crate = entity(c, 'crate');
    const ball = entity(c, 'ball');
    const ev = c.getDamageEvents();
    // Hand check of the first strike: v = √(2 g h) ≈ 8.3 m/s → J ≈ m v over one step → F ≈ 50 kN ≫ m_crate g × 15 = 7.5 kN.
    expect(ev.filter((x) => x.objectId === crate.id && x.eventType === 'BROKEN')).toHaveLength(1);
    expect(ev.some((x) => x.objectId === crate.id && x.eventType === 'IMPACT')).toBe(true);
    expect(crate.health).toBe(0);
    expect(crate.state).toBe(DamageState.DESTROYED);
    expect(ball.health).toBe(1);
    expect(ev.some((x) => x.objectId === ball.id && (x.eventType === 'BROKEN' || x.eventType === 'IMPACT'))).toBe(false);
    c.unload();
  });
});

// ── flood: still water, 1.5 m deep (same set-up as simulation/flood.test.ts) ──

function floodDoc(inputs: CreateObjectInput[]): WorldDocument {
  const d = createEmptyDocument('flood objects');
  for (const input of inputs) {
    const o = createWorldObject({ seed: 7, ...input }, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  const w = defaultWaterSettings();
  for (const s of ['N', 'E', 'S', 'W'] as BoundarySide[]) w.boundaries[s] = { type: 'closed' };
  w.infiltration = false;
  w.drainageCapacity = 0;
  w.initialFromReference = false;
  d.settings.simulation.water = w;
  return d;
}
function stillWater(d: WorldDocument, depth: number) {
  const f = new WaterField(new TerrainSampler(d.terrain), d.settings.simulation.water);
  for (let i = 0; i < f.h.length; i++) f.h[i] = depth;
  return captureWaterState(f, 0);
}
const nudge: EventSpec = { event: 'rain', intensity: 0.1, duration: 600 };

describe('passive objects in a flood', { timeout: 240_000 }, () => {
  it('208 L drums in 1.5 m of still water: empty floats high (draft = m/(ρ_w π r²)), oil-filled floats deep, water-filled sinks', async () => {
    const d = floodDoc([
      { type: 'barrel', params: { fill: 'empty' }, transform: tf(-10, 0) },
      { type: 'barrel', params: { fill: 'oil' }, transform: tf(0, 0) },
      { type: 'barrel', params: { fill: 'water' }, transform: tf(10, 0) },
    ]);
    const c = new SimulationController({ headless: true });
    c.setInitialWaterState(stillWater(d, 1.5));
    await c.load(d);
    c.addEvent(nudge);
    // The barrels start on the ground under 1.5 m of water and pop up. The water model has no wave-radiation damping (only
    // drag ∝ submerged fraction), so a floating body keeps bobbing: compare 10-s time averages (t = 4 … 14 s) with the
    // hand equilibrium — mean buoyancy = weight, base one draft below the surface.
    c.advance(4);
    const [empty, oil, water] = [0, 1, 2].map((k) => entity(c, 'barrel', k));
    const mean = [empty, oil].map(() => ({ y: 0, br: 0, tilt: 0 }));
    const N = 600;
    for (let k = 0; k < N; k++) {
      c.advance(1 / 60);
      [empty, oil].forEach((e, i) => {
        mean[i].y += e.pose.position[1] / N;
        mean[i].br += e.flood!.buoyancyRatio / N;
        mean[i].tilt = Math.max(mean[i].tilt, Math.abs(e.pose.quaternion[0]) + Math.abs(e.pose.quaternion[2]));
      });
    }
    const area = Math.PI * 0.286 ** 2;
    const surface = empty.flood!.surface;
    expect(Math.abs(surface - 1.5)).toBeLessThan(0.02);
    [empty, oil].forEach((e, i) => {
      const draft = e.source.physics.mass / (1000 * area);
      expect(Math.abs(mean[i].br - 1)).toBeLessThan(0.05);
      expect(Math.abs(mean[i].y - (surface - draft))).toBeLessThan(0.04);
      // Upright: buoyancy acts at the box centre column, no capsizing moment in this model.
      expect(mean[i].tilt).toBeLessThan(0.01);
    });
    expect(mean[0].y).toBeGreaterThan(1.35);
    // Water-filled: 227.7 kg > ρ_w·V = 226.1 kg → stays on the ground, fully submerged, ratio ≈ 0.99.
    expect(water.pose.position[1]).toBeLessThan(0.05);
    expect(water.flood!.submerged).toBeCloseTo(1, 6);
    expect(water.flood!.buoyancyRatio).toBeCloseTo((1000 * area * 0.88) / water.source.physics.mass, 2);
    c.unload();
  });
});
