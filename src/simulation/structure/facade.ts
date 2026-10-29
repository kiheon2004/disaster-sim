/**
 * Facade parts of modular buildings detached by their own hazard models (Phase 25): wind fatigue,
 * earthquake drift / floor acceleration, air-pressure SDOF, water pressure. Each hazard model still
 * decides WHEN a part fails and records its BROKEN / DETACHED event; this module makes the member
 * leave the structure consistently:
 *
 *  - the member leaves the collapse model (it no longer loads the beam / wall carrying it);
 *  - glass becomes visual shards (the caller spawns them) — its mass is booked as fines;
 *  - other parts become fragments with EXACTLY the member's mass and a physical velocity: the
 *    structure's own motion (earthquake), the momentum the wave gave it (air blast, the Phase 24
 *    impulse), or none (wind / water drag then act on the fragment) — no extra push is invented.
 *
 * Parts that are not members (rooftop units, signs) and legacy buildings keep the Phase 0–24 path.
 */
import type { Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import { CK, MS } from '@/structure/types';
import { DamageState } from '../damage/DamageState';
import { noteFacadeFailure } from '../damage/behaviors/building';
import type { RuntimeComponent, RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import { activate, structureOf } from './state';
import { spawnFragment } from './fragments';

/**
 * Detach the member behind a facade component. Returns false when the component is not a member
 * of a modular building (the caller keeps its legacy debris path).
 */
export function detachFacadeMember(ctx: SystemContext, e: RuntimeEntity, c: RuntimeComponent, hazard: string, velocityWorld: Vec3 | null, impulse = false): boolean {
  const mr = e.modular;
  if (!mr) return false;
  const ci = e.components.indexOf(c);
  const i = ci >= 0 ? mr.memberOfComp[ci] : -1;
  if (i < 0) return false;
  const st = structureOf(e, ctx);
  const m = st.model;
  if (m.state[i] > MS.SEVERE) return true;
  m.detachFacade(i, hazard, ctx.time);
  mr.failed[i] = 1;
  mr.failedSet.add(mr.design.members[i].id);
  mr.damage[i] = 1;
  // Windows / doors set in this panel go with it (one piece; glass as visual shards).
  const g = m.g;
  for (let q = g.rStart[i]; q < g.rStart[i + 1]; q++) {
    const ed = g.rEdge[q];
    const j = g.eFrom[ed];
    if (g.eKind[ed] !== CK.HOSTED || g.eTier[ed] !== 0 || m.state[j] > MS.SEVERE) continue;
    m.detachFacade(j, hazard, ctx.time);
    mr.failed[j] = 1;
    mr.failedSet.add(mr.design.members[j].id);
    mr.damage[j] = 1;
    const cj = mr.comp[j];
    const comp = cj >= 0 ? e.components[cj] : null;
    if (comp && comp.condition === 'intact') {
      comp.condition = comp.spec.kind === 'window' ? 'broken' : 'detached';
      comp.health = 0;
      comp.state = DamageState.DESTROYED;
      noteFacadeFailure(e);
    }
  }
  mr.rev++;
  activate(e, ctx);
  if (mr.design.members[i].type === 'window') return true;
  const q = e.pose.quaternion;
  const v = velocityWorld ? qRotate([-q[0], -q[1], -q[2], q[3]], velocityWorld) : ([0, 0, 0] as Vec3);
  const p = m.g.mass[i] * Math.hypot(v[0], v[2]);
  if (impulse) m.ledger.momentum.impulse += p;
  else m.ledger.momentum.inherited += p;
  spawnFragment(ctx, e, i, v, hazard);
  return true;
}
