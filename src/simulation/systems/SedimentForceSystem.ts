/**
 * Drag of moving sediment on free bodies (Phase 22, prePhysics, every step): vehicles, fallen
 * people and other dynamic objects standing in the moving layer feel ½·ρ_d·C_d·A·|u_rel|·u_rel
 * (horizontal), A = width × the flow depth up to the body height, through the ForceLedger
 * ('sediment'). The same quadratic law as water drag (Phase 14), with the debris density.
 */
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import { flowAt, type FlowSample } from '../ground/objects';

const CD = 1.2;
const sample: FlowSample = { h: 0, ux: 0, uz: 0, rho: 0, deposit: 0, phi: 0 };
const force: [number, number, number] = [0, 0, 0];

export class SedimentForceSystem implements SimulationSystem {
  readonly name = 'sedimentForce';
  readonly phase = 'prePhysics' as const;
  readonly reads = ['terrain', 'poses'] as const;
  readonly writes = ['forces'] as const;
  readonly lagged = ['poses'] as const;

  isActive(ctx: SystemContext) {
    const f = ctx.env.groundFailure.field;
    return !!f && f.active.x1 >= f.active.x0;
  }

  update(ctx: SystemContext) {
    const f = ctx.env.groundFailure.field!;
    const a = f.active;
    const x0 = f.originX + (a.x0 - 1) * f.dx, x1 = f.originX + (a.x1 + 1) * f.dx, z0 = f.originZ + (a.z0 - 1) * f.dx, z1 = f.originZ + (a.z1 + 1) * f.dx;
    for (const e of ctx.runtime.entities.values()) {
      if (!e.dynamic || e.body === null) continue;
      const p = e.pose.position;
      if (p[0] < x0 || p[0] > x1 || p[2] < z0 || p[2] > z1) continue;
      const s = flowAt(f, p[0], p[2], sample);
      if (s.h <= 0.05) continue;
      const v = ctx.physics.getLinearVelocity(e.body);
      const rx = s.ux - v[0], rz = s.uz - v[2];
      const rel = Math.hypot(rx, rz);
      if (rel < 1e-3) continue;
      const width = Math.min(e.dims[0], e.dims[2]);
      const area = width * Math.min(s.h, e.dims[1]);
      const k = 0.5 * s.rho * CD * area * rel;
      force[0] = k * rx;
      force[1] = 0;
      force[2] = k * rz;
      ctx.forces.force('sediment', e.body, force, e);
    }
  }
}
