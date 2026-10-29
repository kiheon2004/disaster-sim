/**
 * Phase 27 — Phase 26 residual studies (docs/FIRE_COMBUSTION.md §2), written to RESIDUAL_OUT:
 *  2.2 one load-redistribution round per step under simultaneous FIRE weakening: a burning timber
 *      house (windows open, 1 h) with the engine's policy (1 round) and with rounds until stable (16);
 *  2.3 the two-node member model under a standard fire (ISO 834 gas, EN 1991-1-2 boundary: h = 25,
 *      ε_f = 1) against a fine 1-D finite-difference reference (1 mm, the same material functions):
 *      section-mean temperature, exposed 5 cm layer, and the section strength factor that the
 *      structural engine uses — concrete 200 mm, timber 100 mm wall slabs exposed on one face.
 */
import fs from 'node:fs';
import { describe, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { CollapseModel } from '@/structure/collapse';
import { SimulationController } from '@/simulation/SimulationController';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { ThermalWorld, defaultThermalSettings } from '@/thermal/ThermalWorld';
import { BK } from '@/thermal/ThermalBodies';
import { THERMAL_MATERIALS, TM } from '@/thermal/materials';
import { sectionFactors } from '@/thermal/structural';
import { SIGMA } from '@/thermal/units';

async function houseFire(rounds: number) {
  CollapseModel.roundsPerStep = rounds;
  const d = createEmptyDocument('r');
  d.settings.simulation.seed = 42;
  d.settings.simulation.fire = { foliageMoisture: 1.5, openings: 'windowsOpen', heatIgnition: false };
  const o = createWorldObject({ type: 'building', building: createDesign(presetSpec('house')!, 'house'), seed: 7, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } }, nextSerial(d.objects, 'building'));
  d.objects[o.id] = o;
  const c = new SimulationController({ headless: true });
  await c.load(d);
  c.addEvent({ event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 3600 } as EventSpec);
  const t0 = performance.now();
  c.advance(3600);
  const ms = performance.now() - t0;
  const m = [...c.getRuntime()!.entities.values()][0].modular!.structure!.model;
  const recs = m.records.map((r) => ({ i: r.i, t: +r.time.toFixed(2), cause: r.cause, hazard: r.hazard, round: r.round }));
  const fr = c.getEnvironment().fire.rt!;
  const out = { recs, released: fr.fw.ledger.released, peak: fr.fw.peakHrr, ms };
  c.unload();
  CollapseModel.roundsPerStep = 1;
  return out;
}

const iso834 = (t: number) => 273.15 + 20 + 345 * Math.log10((8 * t) / 60 + 1);

/** Fine 1-D explicit FD of a slab exposed to the ISO gas on face 0, ambient on the other face. */
function fdSlab(mat: number, L: number, sample: number[]) {
  const M = THERMAL_MATERIALS[mat];
  const dx = 0.001, n = Math.round(L / dx);
  const T = new Float64Array(n).fill(293.15);
  const E = new Float64Array(n);
  const rho = M.density;
  const out: { t: number; mean: number; exposed: number; factor: number }[] = [];
  let t = 0, si = 0;
  const eps = M.emissivity;
  while (si < sample.length) {
    let kmax = 0, cmin = Infinity;
    for (let i = 0; i < n; i++) { kmax = Math.max(kmax, M.k(T[i] - 273.15)); cmin = Math.min(cmin, M.c(T[i] - 273.15)); }
    const dt = Math.min(1, (0.4 * rho * cmin * dx * dx) / kmax);
    const Tg = iso834(t);
    const q = new Float64Array(n + 1);
    q[0] = 25 * (Tg - T[0]) + eps * SIGMA * (Tg ** 4 - T[0] ** 4);
    for (let i = 1; i < n; i++) { const k = 0.5 * (M.k(T[i - 1] - 273.15) + M.k(T[i] - 273.15)); q[i] = (k * (T[i - 1] - T[i])) / dx; }
    q[n] = -(4 * (T[n - 1] - 293.15) + eps * SIGMA * (T[n - 1] ** 4 - 293.15 ** 4));
    for (let i = 0; i < n; i++) { const c = M.c(T[i] - 273.15); E[i] = 0; T[i] += ((q[i] - q[i + 1]) * dt) / (rho * c * dx); }
    t += dt;
    if (t >= sample[si]) {
      let s = 0, se = 0, f = 0;
      const nSkin = Math.round(0.05 / dx);
      for (let i = 0; i < n; i++) { s += T[i]; if (i < nSkin) se += T[i]; f += M.strength!.axial(T[i] - 273.15); }
      out.push({ t: sample[si], mean: s / n - 273.15, exposed: se / nSkin - 273.15, factor: f / n });
      si++;
    }
  }
  return out;
}

/** The Phase 26 two-node member body under the same exposure (room gas at the ISO curve, ε_g = 1). */
function twoNode(mat: number, L: number, sample: number[]) {
  const M = THERMAL_MATERIALS[mat];
  const w = new ThermalWorld(createFlatTerrain(20), { ...defaultThermalSettings(), ambient: 293.15 }, 1.2, {});
  w.hasGasRadiation = true;
  const tc = w.addCompartment(50, -1, 0);
  w.comps[tc].eps = 1;
  const A = 2, V = L * 1, mass = M.density * V;
  const wS = Math.min(0.8, (0.05 * A) / V);
  const b = w.bodies.add({ kind: BK.member, mSkin: mass * wS, mCore: mass * (1 - wS), matSkin: mat, matCore: mat, Av: A, Atop: 0, Abot: 0, Lv: 3, Lh: 0.5, Lf: 1,
    tSkin: 0.05, Asc: A, Lsc: Math.max(0.01, L / 2 - 0.025), fOut: 0.5, fC1: 0.5, fC2: 0, comp1: tc, comp2: -1, sx: 1, sy: 1, sz: L, x: 0, y: 1, z: 0, yg: 0, ref: 0, sub: 0 });
  w.placeBody(b, 0, 1, 0, 0);
  const out: { t: number; mean: number; exposed: number; factor: number }[] = [];
  let t = 0, si = 0;
  while (si < sample.length) {
    const cp = w.comps[tc];
    cp.E = cp.C * (iso834(t + 0.05) - w.Tref);
    w.step(0.1);
    t += 0.1;
    if (t >= sample[si] - 1e-9) {
      const B = w.bodies;
      const f = sectionFactors(mat, { Ts: B.TS[b], Tc: B.TC[b], TmaxS: B.TmaxS[b], TmaxC: B.TmaxC[b], wS });
      out.push({ t: sample[si], mean: wS * B.TS[b] + (1 - wS) * B.TC[b] - 273.15, exposed: B.TS[b] - 273.15, factor: f.axial });
      si++;
    }
  }
  return out;
}

describe.skipIf(!process.env.RESIDUAL_OUT)('Phase 26 residuals under fire', () => {
  it('rounds per step and the two-node conduction error', { timeout: 3_600_000 }, async () => {
    const a = await houseFire(1);
    const b = await houseFire(16);
    const key = (r: { i: number; cause: string }) => `${r.i}:${r.cause}`;
    const setA = new Set(a.recs.map(key)), setB = new Set(b.recs.map(key));
    const firstFire = (x: typeof a.recs) => x.find((r) => r.hazard === 'fire' && r.cause !== 'facade')?.t ?? null;
    const timeDiff: number[] = [];
    for (const r of a.recs) { const q = b.recs.find((s) => s.i === r.i && s.cause === r.cause); if (q) timeDiff.push(Math.abs(q.t - r.t)); }
    const rounds = {
      oneRound: { records: a.recs.length, firstFireFailure: firstFire(a.recs), released: a.released, peak: a.peak, ms: a.ms },
      untilStable: { records: b.recs.length, firstFireFailure: firstFire(b.recs), released: b.released, peak: b.peak, ms: b.ms },
      sameMembersAndCauses: [...setA].filter((k) => setB.has(k)).length, onlyOne: [...setA].filter((k) => !setB.has(k)), onlyStable: [...setB].filter((k) => !setA.has(k)),
      maxTimeDiff: timeDiff.length ? Math.max(...timeDiff) : 0, medianTimeDiff: timeDiff.length ? timeDiff.sort((p, q) => p - q)[Math.floor(timeDiff.length / 2)] : 0,
    };
    const sample = [600, 1200, 1800, 2700, 3600];
    const conduction: Record<string, unknown> = {};
    for (const [name, mat, L] of [['concrete 200 mm', TM.concrete, 0.2], ['timber 100 mm', TM.timber, 0.1]] as const) {
      const fd = fdSlab(mat, L, sample);
      const tn = twoNode(mat, L, sample);
      conduction[name] = sample.map((s, k) => ({
        t_min: s / 60, fd_mean_C: +fd[k].mean.toFixed(1), twoNode_mean_C: +tn[k].mean.toFixed(1), fd_exposed5cm_C: +fd[k].exposed.toFixed(1), twoNode_skin_C: +tn[k].exposed.toFixed(1),
        fd_factor: +fd[k].factor.toFixed(3), twoNode_factor: +tn[k].factor.toFixed(3),
        meanRiseError: +((tn[k].mean - fd[k].mean) / Math.max(1, fd[k].mean - 20)).toFixed(3),
      }));
    }
    fs.writeFileSync(process.env.RESIDUAL_OUT!, JSON.stringify({ date: new Date().toISOString(), rounds, conduction }, null, 1));
    console.log(JSON.stringify({ rounds, conduction }, null, 1));
  });
});
