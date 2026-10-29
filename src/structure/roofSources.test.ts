/**
 * Phase 31 audit (M1 / §13): a spanning roof panel fails by its load against its roof-system capacity whatever the load
 * is — snow (climate), ash (volcano), any other hazard surcharge, or the same loads under a gravity ratio. Before the
 * audit only snow and gravity switched the roof-panel check on, so 3 kPa of ash never failed a roof that 3 kPa of snow
 * failed. Capacities never change; each load is scaled by the gravity ratio exactly once.
 */
import { describe, expect, it } from 'vitest';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { GRAVITY } from '@/core/units';
import { CollapseModel } from './collapse';
import { graphOf, MT_ROOF } from './graph';
import { MS } from './types';

const area = (m: CollapseModel, i: number) => (m.g.box[6 * i + 3] - m.g.box[6 * i]) * (m.g.box[6 * i + 5] - m.g.box[6 * i + 2]);
const roofs = (m: CollapseModel) => Array.from({ length: m.n }, (_, i) => i).filter((i) => m.g.type[i] === MT_ROOF && m.g.roofCap[i] > 0);

/** kPa of each source on every spanning roof panel, gravity ratio k; the adapters' calls (climate also enables the check). */
function run(id: string, loads: { snow?: number; ash?: number; other?: number }, k = 1) {
  const m = new CollapseModel(graphOf(createDesign(presetSpec(id)!, id)));
  expect(m.init(0.3)).toEqual([]);
  const R = roofs(m);
  const cap0 = Float64Array.from(m.g.roofCap), capN0 = Float64Array.from(m.g.capN);
  if (loads.snow) { m.s.enableRoofCheck(); for (const i of R) m.addLoad(i, loads.snow * 1000 * area(m, i), 'climate'); }
  if (loads.ash) for (const i of R) m.addLoad(i, loads.ash * 1000 * area(m, i), 'volcano');
  if (loads.other) for (const i of R) m.addLoad(i, loads.other * 1000 * area(m, i), 'test');
  if (k !== 1) { m.s.enableRoofCheck(); for (let i = 0; i < m.n; i++) m.setGravityRatio(i, k); }
  for (let t = 0; t < 180; t++) m.step(1 / 60, t / 60, undefined, GRAVITY);
  expect(m.g.roofCap).toEqual(cap0);
  expect(m.g.capN).toEqual(capN0);
  for (const i of R) if (m.state[i] < MS.FAILED) expect(m.s.load[i]).toBeCloseTo((m.g.weight[i] + m.s.extra[i]) * m.s.kM[i], 6);
  return R.filter((i) => m.state[i] >= MS.FAILED).length / R.length;
}

describe('roof-panel failure is decided by load, not by its source (M1)', () => {
  for (const id of ['warehouse', 'house']) {
    it(`${id}: 1 kPa holds and 3 kPa fails for snow, ash, a mix and any surcharge; dead load alone holds`, () => {
      expect(run(id, {})).toBe(0);
      for (const l of [{ snow: 1 }, { ash: 1 }, { snow: 0.5, ash: 0.5 }]) expect(run(id, l)).toBe(0);
      for (const l of [{ snow: 3 }, { ash: 3 }, { snow: 1.5, ash: 1.5 }, { ash: 2.9, snow: 0.1 }, { other: 3 }]) expect(run(id, l)).toBe(1);
    });

    it(`${id}: 1 kPa of snow or of ash under 3 g fails alike; the same mass at 1 g holds`, () => {
      expect(run(id, { snow: 1 }, 3)).toBe(1);
      expect(run(id, { ash: 1 }, 3)).toBe(1);
      expect(run(id, { ash: 1 }, 1)).toBe(0);
    });
  }
});
