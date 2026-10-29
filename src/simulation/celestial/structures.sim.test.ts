/**
 * Phase 32: celestial sources on structures — storey lateral loads equal Σ m_j·g_h(x_j) of the closed-form field at
 * the floors (static base shear after the transient), the uplift check detaches members only where the upward pull
 * beats g₀ and the connections, structural models are ready before the source starts (no creation delay), and the
 * attribution goes to the gravity hazard.
 */
import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import type { Vec3 } from '@/core/types';
import { celestialSpec, labSource } from './testSpecs';
import { G_N } from '@/celestial/constants';
import { gravity } from '../gravity/testSpecs';

const S = () => useWorldStore.getState();
function houses(pos: [number, number][], floors = 2) {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('p32'));
  const d = createDesign({ ...presetSpec('house')!, floors }, 'house');
  S().applyEdit({ add: pos.map(([x, z], k) => ({ type: 'building', building: d, seed: k + 1, transform: { position: [x, 0, z] as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] } })) as never });
  const w = structuredClone(S().doc);
  w.settings.simulation.seed = 3;
  return w;
}
async function load(doc: ReturnType<typeof houses>) {
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  return c;
}

describe('celestial sources on structures', { timeout: 600_000 }, () => {
  it('storey loads: static base shear = Σ m_j·g_h(x_j) of the closed-form field (source 40 m to the side)', async () => {
    const c = await load(houses([[0, 0]]));
    const mu = 3e3, eps = 2;
    c.addEvent(celestialSpec({ sources: [labSource({ center: [40, 6, 0], mass: mu / G_N, softening: eps, capture: 1, ramp: 1 })] }));
    c.advance(14);
    const sr = c.getRuntime()!.seismic!, m = sr.model;
    const ui = sr.units.findIndex((e) => e.source.type === 'building');
    expect(m.hasG[ui]).toBe(1);
    // Independent closed form at each floor: g_x = μ·Δx/(r² + ε²)^{3/2} towards the source.
    const e = sr.units[ui], o = m.off[ui], n = m.n[ui];
    let V = 0;
    for (let j = 1; j <= n; j++) {
      const dx = 40 - e.pose.position[0], dy = 6 - (e.pose.position[1] + m.z[o + j]);
      const gx = (mu * dx) / (dx * dx + dy * dy + eps * eps) ** 1.5;
      V += m.m[o + j] * gx;
    }
    // Damped transient after a 1 s ramp: within 3 % of the static value.
    expect(Math.abs(m.baseShear[ui] - Math.abs(V)) / Math.abs(V)).toBeLessThan(0.03);
    expect(e.seismic!.pgaGravity).toBeGreaterThan(0);
    // Too weak to damage a house: no failure.
    expect(e.modular!.structure?.model.records.filter((r) => r.hazard === 'gravity').length ?? 0).toBe(0);
  });

  it('uplift: a source above the roof pulls members off (cause uplift, hazard gravity, mass to bodies); a weak one does not', async () => {
    const strong = await load(houses([[0, 0]]));
    strong.addEvent(celestialSpec({ sources: [labSource({ center: [0, 14, 0], mass: 2e4 / G_N, softening: 2, capture: 1.5, ramp: 0.5 })] }));
    strong.advance(3);
    const b = [...strong.getRuntime()!.entities.values()].find((e) => e.modular)!;
    const recs = b.modular!.structure!.model.records;
    const up = recs.filter((r) => r.cause === 'uplift');
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((r) => r.hazard === 'gravity')).toBe(true);
    const L = b.modular!.structure!.model.ledger;
    expect(Math.abs(L.residual())).toBeLessThan(1e-6 * L.original);
    expect(L.mass.bodies + L.mass.captured + L.mass.rubble + L.mass.left).toBeGreaterThan(0);
    // The pull at the roof (≈ 10 m below the source): μ/r² = 2·10⁴/100 = 200 m/s² ≫ g₀ — but 60 m away it is 5.6:
    // below g₀, so nothing can be pulled up there.
    const weak = await load(houses([[0, 0]]));
    weak.addEvent(celestialSpec({ sources: [labSource({ center: [0, 66, 0], mass: 2e4 / G_N, softening: 2, capture: 1.5, ramp: 0.5 })] }));
    weak.advance(3);
    const w = [...weak.getRuntime()!.entities.values()].find((e) => e.modular)!;
    expect(w.modular!.structure!.model.records.filter((r) => r.cause === 'uplift').length).toBe(0);
  });

  it('models are prepared before the source starts (Phase 31 residual 2.2): 120 houses, no creation delay', async () => {
    const pos: [number, number][] = [];
    for (let x = -60; x <= 60 && pos.length < 120; x += 11) for (let z = -60; z <= 60 && pos.length < 120; z += 11) pos.push([x, z]);
    const c = await load(houses(pos));
    c.addEvent(celestialSpec({ startTime: 0.5, sources: [labSource({ center: [0, 40, 0], mass: 5e4 / G_N, softening: 2, capture: 1.5, ramp: 0 })] }));
    const ents = [...c.getRuntime()!.entities.values()].filter((e) => e.modular);
    expect(ents.length).toBe(120);
    // Before the clock: every house within reach already has its collapse model.
    expect(ents.every((e) => e.modular!.structure)).toBe(true);
    c.advance(0.55);
    expect(c.getEnvironment().gravity.rt!.structures.pending).toBe(0);
  });

  it('without a celestial source the storey model carries no field load (Phase 31 sideways gravity keeps its limit)', async () => {
    const c = await load(houses([[0, 0]]));
    c.addEvent(gravity({ magnitude: 9.81, direction: [1, -1, 0] }));
    c.advance(1);
    const sr = c.getRuntime()!.seismic;
    if (sr) expect([...sr.model.hasG].every((v) => v === 0)).toBe(true);
    expect(c.getEnvironment().gravity.lateral).toBe(false);
  });
});
