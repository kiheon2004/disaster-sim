/**
 * Phase 36 (structure v2): a part rotating about a hinge touches the ground with the lowest corner of its TURNED box —
 * before, the upright box let a long tilted member sink up to L/2·sin θ into the ground before the rotation stopped.
 */
import { describe, expect, it } from 'vitest';
import { presetSpec } from '@/buildings/spec';
import { defaultOptions, type BuildingDesign, type BuildingMember } from '@/buildings/types';
import { buildGraph } from './graph';
import { CollapseModel } from './collapse';

/**
 * Two RC bays along x, two storeys, the ground storey LOW (1.5 m) and no edge beam across the far (−x) end of the ground
 * storey: the −x bay, losing its outer ground columns, swings about the middle column line, and the far corners of its
 * long beams reach the ground well before their upright boxes would (and before the RC tear rotation, 0.25 rad).
 */
function lowTwoBay(): BuildingDesign {
  const M: Omit<BuildingMember, 'rotation'>[] = [];
  const hs = [1.5, 3], base = [0, 1.5];
  for (const x of [-6, 0, 6]) for (const z of [-3, 3]) {
    M.push({ id: `p${x}${z}`, type: 'foundation', role: 'foundation', level: -1, position: [x, -0.3, z], size: [1.2, 0.6, 1.2], material: 'reinforcedConcrete' });
    for (const lv of [0, 1]) M.push({ id: `c${lv}${x}${z}`, type: 'column', role: 'primary', level: lv, position: [x, base[lv] + hs[lv] / 2, z], size: [0.4, hs[lv], 0.4], material: 'reinforcedConcrete' });
  }
  for (const lv of [0, 1]) {
    const y = base[lv] + hs[lv];
    for (const z of [-3, 3]) for (const xc of [-3, 3]) M.push({ id: `b${lv}${xc}${z}`, type: 'beam', role: 'primary', level: lv, position: [xc, y - 0.25, z], size: [6, 0.5, 0.3], material: 'reinforcedConcrete' });
    for (const x of lv === 0 ? [0, 6] : [-6, 0, 6]) M.push({ id: `bz${lv}${x}`, type: 'beam', role: 'primary', level: lv, position: [x, y - 0.25, 0], size: [0.3, 0.5, 6], material: 'reinforcedConcrete' });
    for (const xc of [-3, 3]) M.push({ id: `s${lv}${xc}`, type: 'slab', role: 'primary', level: lv, position: [xc, y + 0.1, 0], size: [6, 0.2, 6], material: 'reinforcedConcrete' });
  }
  const spec = { ...presetSpec('warehouse')!, floors: 2 };
  return { version: 1, spec, members: M.map((m) => ({ rotation: [0, 0, 0] as [number, number, number], ...m })), options: { ...defaultOptions(), allowUnsupported: true }, edits: 1 };
}

describe('hinge ground contact (v2)', () => {
  it('the rotation stops when a turned corner reaches the ground — not later, when the upright box would', () => {
    const d = lowTwoBay();
    const g = buildGraph(d);
    const m = new CollapseModel(g);
    m.enableV2();
    m.init();
    m.fail(d.members.map((x, i) => (x.type === 'column' && x.level === 0 && x.position[0] === -6 ? i : -1)).filter((i) => i >= 0), 'drift', 'earthquake', 0);
    let t = 0, release: Extract<CollapseModel['events'][number], { kind: 'release' }> | undefined, hinge: Extract<CollapseModel['events'][number], { kind: 'hinge' }> | undefined;
    for (let k = 0; k < 600 && m.active && !release; k++) {
      m.step(1 / 60, t);
      t += 1 / 60;
      hinge ??= m.events.find((e) => e.kind === 'hinge') as typeof hinge;
      release = m.events.find((e) => e.kind === 'release') as typeof release;
    }
    expect(hinge).toBeDefined();
    expect(release).toBeDefined();
    // It reached the ground before its connections' tear rotation (RC 0.25 rad).
    expect(release!.ground).toBe(true);
    expect(release!.theta).toBeLessThan(hinge!.release);
    // At that moment: the lowest turned corner is at the ground (within one sub-step), while the upright boxes are all
    // still clear of it — the old contact would have let the block keep turning into the ground.
    const [ax, , az] = hinge!.axis;
    const sn = Math.sin(release!.theta), c = Math.cos(release!.theta);
    let lowTurned = Infinity, lowUpright = Infinity;
    for (let i = 0; i < g.n; i++) {
      if (m.blockOf[i] !== release!.group) continue;
      const o = 6 * i, hx = (g.box[o + 3] - g.box[o]) / 2, hy = ((g.box[o + 4] - g.box[o + 1]) / 2) * m.sy[i], hz = (g.box[o + 5] - g.box[o + 2]) / 2;
      const cy = (g.box[o + 1] + g.box[o + 4]) / 2 + m.dy[i];
      lowTurned = Math.min(lowTurned, cy - (Math.abs(az * sn) * hx + c * hy + Math.abs(ax * sn) * hz));
      lowUpright = Math.min(lowUpright, cy - hy);
    }
    expect(lowTurned).toBeLessThanOrEqual(0.02);
    expect(lowTurned).toBeGreaterThan(-0.15);
    expect(lowUpright).toBeGreaterThan(0.02);
    // Mass ledger closed through the rotation.
    expect(Math.abs(m.ledger.residual()) / m.ledger.original).toBeLessThan(1e-9);
  });
});
