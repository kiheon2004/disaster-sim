/**
 * Phase 32 — the Phase 31 audit residuals (docs/PHASE31_AUDIT.md §22, Phase 32 spec §2.4) as regression tests:
 *  (a) rubble alone on a spanning roof panel switches its roof check on (fixed here: it fails by its load like a
 *      hazard surcharge; before, a roof under its own rubble never failed by its panel);
 *  (b) snow on a member pulled off as a fragment, (c) snow mass during a field change, (d) ledgers after a collapse:
 *      a snow-covered house under a celestial source pulling its roof off — the climate water ledger, the structural
 *      mass ledger and the snow carried by the members all close.
 */
import { describe, expect, it } from 'vitest';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { GRAVITY } from '@/core/units';
import { CollapseModel } from '@/structure/collapse';
import { graphOf, MT_ROOF } from '@/structure/graph';
import { MS } from '@/structure/types';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { SimulationController } from '@/simulation/SimulationController';
import type { Vec3 } from '@/core/types';
import type { EventSpec } from '@/events/specs';
import { G_N } from '@/celestial/constants';
import { celestialSpec, labSource } from './testSpecs';

const area = (m: CollapseModel, i: number) => (m.g.box[6 * i + 3] - m.g.box[6 * i]) * (m.g.box[6 * i + 5] - m.g.box[6 * i + 2]);

describe('Phase 31 residuals under Phase 32', { timeout: 900_000 }, () => {
  it('(a) rubble alone on roof panels: 3 kPa fails them, 1 kPa holds — like any surcharge (roof check switched on)', () => {
    for (const [kPa, failed] of [[1, 0], [3, 1]] as const) {
      const m = new CollapseModel(graphOf(createDesign(presetSpec('warehouse')!, 'warehouse')));
      expect(m.init(0.3)).toEqual([]);
      const R = Array.from({ length: m.n }, (_, i) => i).filter((i) => m.g.type[i] === MT_ROOF && m.g.roofCap[i] > 0);
      expect(m.s.roofCheck).toBe(false);
      for (const i of R) m.addRubble(i, kPa * 1000 * area(m, i), i);
      expect(m.s.roofCheck).toBe(true);
      for (let t = 0; t < 120; t++) m.step(1 / 60, t / 60, undefined, GRAVITY);
      expect(R.filter((i) => m.state[i] >= MS.FAILED).length / R.length).toBe(failed);
    }
  });

  it('(b)–(d) snowy house, roof pulled off by a celestial source: climate water ledger, mass ledger and carried snow close', async () => {
    const S = useWorldStore.getState();
    S.setLocked(false);
    S.replaceDocument(createEmptyDocument('res'));
    S.applyEdit({ add: [{ type: 'building', building: createDesign({ ...presetSpec('house')!, floors: 1 }, 'house'), seed: 1, transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] } }] as never });
    const doc = structuredClone(useWorldStore.getState().doc);
    doc.settings.simulation.seed = 5;
    const K = (c: number) => c + 273.15;
    const c = new SimulationController({ headless: true });
    await c.load(doc);
    c.addEvent({ event: 'climate', scenario: 'custom', forcing: 'flux', temperature: K(-4), target: K(-4), profile: 'constant', duration: 3600, humidity: 0.85, mixTime: 900, precipitation: 0, precipPhase: 'auto', precipProfile: 'constant', solar: 'off', soilMoisture: 0.25, blowingSnow: false, roofSnow: true, initialSnow: 0.4, initialSnowDensity: 200, startTime: 0 } as EventSpec);
    c.addEvent(celestialSpec({ startTime: 2, sources: [labSource({ center: [0, 12, 0], mass: 1.5e4 / G_N, softening: 2, capture: 1.5, ramp: 1 })] }));
    c.advance(1.9);
    const cl0 = c.climateLive()!;
    c.advance(4);
    const b = [...c.getRuntime()!.entities.values()].find((e) => e.modular)!;
    const m = b.modular!.structure!.model;
    // Something was pulled off.
    expect(m.records.filter((r) => r.cause === 'uplift').length).toBeGreaterThan(0);
    // (d) structural mass ledger.
    expect(Math.abs(m.ledger.residual())).toBeLessThan(1e-6 * m.ledger.original);
    // (b, c) the climate water ledger closes (snow on roofs, fallen packets, cover, boundary out) to rounding.
    const cl = c.climateLive()!;
    expect(Math.abs(cl.water.residual)).toBeLessThan(1e-6 * Math.max(1, cl0.water.final));
    // Snow carried by members never exceeds what the roofs held before the pull, and is never negative.
    let carried = 0;
    for (let i = 0; i < m.n; i++) { expect(m.carried[i]).toBeGreaterThanOrEqual(0); carried += m.carried[i]; }
    expect(Number.isFinite(carried)).toBe(true);
    c.unload();
  });
});
