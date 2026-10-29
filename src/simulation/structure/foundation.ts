/**
 * Ground under foundation members (Phase 25, called by the Phase 21 deformation response).
 *
 * Phase 21 moves a building with the plane fitted to the ground displacement under its footprint
 * (rigid settlement + tilt) and evaluates the angular distortion. What the rigid motion cannot follow
 * is LOCAL: where the ground dropped below the fitted base by more than the contact gap (5 cm), or
 * where a source states an explicit support loss (sinkhole roof, crater), the foundation member
 * above has lost bearing. Each ground-bearing member (footings, mat, slab-on-grade, members bearing
 * directly on the soil) samples its own footprint (centre + 4 corners at 90 %):
 *
 *     support factor = (points still in contact / 5) × mean explicit support multiplier
 *
 * which the structural engine takes as the member's ground support: < 5 % = lost (the member and
 * what only it carried lose their load path), otherwise its bearing pressure rises as 1 / factor
 * (ultimate bearing check). Nothing happens — no model is even created — while every member keeps
 * full support.
 */
import type { DeformationEngine } from '@/deformation/engine';
import { graphOf } from '@/structure/graph';
import { MS } from '@/structure/types';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { CONTACT_GAP } from '../deformation/response';
import { activate, structureOf } from './state';
import { governingHazard } from '../buildings/modular';

interface Fit { a: number; b: number; cz: number; c: number; s: number; x0: number; z0: number }

const SAMPLE = [[0, 0], [-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]];

export function foundationSupport(e: RuntimeEntity, ctx: SystemContext, engine: DeformationEngine, f: Fit) {
  const mr = e.modular!;
  const g = mr.structure?.model.g ?? graphOf(mr.design, mr.scale);
  const n = g.n;
  let factors: Float32Array | null = null;
  for (let i = 0; i < n; i++) {
    if (!(g.ground[i] || g.soilFallback[i]) || g.absent[i]) continue;
    const o = 6 * i;
    const cx = (g.box[o] + g.box[o + 3]) / 2, cz = (g.box[o + 2] + g.box[o + 5]) / 2;
    const wx = g.box[o + 3] - g.box[o], wz = g.box[o + 5] - g.box[o + 2];
    let bearing = 0, support = 0;
    for (const [u, v] of SAMPLE) {
      const lx = cx + u * wx, lz = cz + v * wz;
      const x = f.x0 + lx * f.c + lz * f.s, z = f.z0 - lx * f.s + lz * f.c;
      const residual = engine.supportDisplacementAt(x, z) - (f.a + f.b * lx + f.cz * lz);
      if (residual > -CONTACT_GAP) bearing++;
      support += engine.supportAt(x, z, ctx.time);
    }
    const factor = (bearing / SAMPLE.length) * (support / SAMPLE.length);
    if (factor < 0.999 || mr.structure) {
      factors ??= new Float32Array(n).fill(1);
      factors[i] = factor;
    }
  }
  if (!factors) return;
  const st = structureOf(e, ctx);
  const m = st.model;
  const hazard = governingHazard(e, 'ground', ctx);
  let lost = 0;
  for (let i = 0; i < n; i++) {
    if (!(g.ground[i] || g.soilFallback[i]) || m.state[i] > MS.SEVERE) continue;
    const prev = m.s.groundFactor[i];
    const next = Math.min(prev, factors[i]); // ground support never comes back in a run
    if (prev - next < 0.02 && !(next < 0.05 && prev >= 0.05)) continue;
    m.setGround(i, next, hazard);
    if (next < 0.05) lost++;
  }
  if (lost) {
    activate(e, ctx);
    if (!st.noted.has('foundation')) {
      st.noted.add('foundation');
      ctx.log(e.id, 'danger', { key: 'log.struct.foundation', params: { n: lost } });
    }
  } else if (m.s.pending) activate(e, ctx);
}
