import { GRAVITY } from '@/core/units';
import type { SimulationSystem, SystemContext } from './SimulationSystem';
import type { SeismicEntityState } from '../seismic/SeismicState';
import type { StructuralModel } from '../seismic/StructuralModel';

/** Free vibration is integrated this long after the shaking ends (then everything is at rest). */
const FREE_VIBRATION = 12;
/** Residual tilt rate (rad/s) per unit of bearing-pressure excess (approximate). */
const TILT_RATE = 0.012;
const MAX_EXCESS = 3;

/**
 * Structural response (postPhysics, Phase 13): advances the reduced-order structural model of
 * every building / pole / sign / wall with the ground acceleration at its base, then copies
 * the response into each entity's SeismicEntityState for the damage and rendering layers.
 *
 * The calculation (here) and the animation (SimRenderAdapter reads top / base / tilt and
 * draws them with an optional exaggeration factor) are separate.
 *
 * Foundation bearing: the overturning moment of the floor inertia forces raises the edge
 * pressure q = W/A·(1 + 6e/B) (e = M/W; beyond the kern: 2W / (3L(B/2 − e))). Pressure above
 * the soil's bearing capacity accumulates a residual tilt toward the pressed edge.
 */
export class StructuralResponseSystem implements SimulationSystem {
  readonly name = 'structural';
  readonly phase = 'postPhysics' as const;

  update(ctx: SystemContext, dt: number) {
    const sr = ctx.runtime.seismic;
    if (!sr) return;
    const active = ctx.env.groundMotion.active;
    if (active) sr.freeVibration = FREE_VIBRATION;
    else if (sr.freeVibration > 0) sr.freeVibration -= dt;
    else return;
    sr.steps++;
    const model = sr.model;
    const units = sr.units;
    for (let ui = 0; ui < units.length; ui++) {
      const e = units[ui];
      if (e.flags.collapsed || e.flags.toppled) continue;
      const st = e.seismic!;
      model.agx[ui] = st.ground.a[0];
      model.agz[ui] = st.ground.a[2];
      model.stepUnit(ui, dt);

      st.top[0] = model.top[2 * ui];
      st.top[1] = model.top[2 * ui + 1];
      st.base[0] = model.base[2 * ui];
      st.base[1] = model.base[2 * ui + 1];
      st.drift = model.drift[ui];
      st.peakDrift = model.peakDrift[ui];
      st.damage = model.damage[ui];
      const top = Math.hypot(st.top[0], st.top[1]);
      if (top > st.peakTop) st.peakTop = top;
      const o = model.off[ui];
      for (let j = 1; j <= model.n[ui]; j++) if (model.peakAcc[o + j] > st.peakFloorAcc) st.peakFloorAcc = model.peakAcc[o + j];
      const slight = st.thresholds ? st.thresholds.slight : model.driftU[ui] * 0.2;
      st.stress = st.drift / slight;
      if (st.thresholds) this.foundation(e.source.physics.mass, st, model, ui, dt);
    }
  }

  private foundation(mass: number, st: SeismicEntityState, model: StructuralModel, ui: number, dt: number) {
    const W = mass * GRAVITY;
    // Overturning moments are in unit-local axes; footprint is along world axes — use the
    // world-rotated moments (rotation by the unit's yaw).
    const cs = model.cos[ui];
    const sn = model.sin[ui];
    const lx = model.otm[2 * ui];
    const lz = model.otm[2 * ui + 1];
    const mx = lx * cs + lz * sn; // moment from inertia along world x
    const mz = -lx * sn + lz * cs;
    const Bx = st.footprint[0];
    const Bz = st.footprint[1];
    const A = Bx * Bz;
    let worst = 0;
    for (let axis = 0; axis < 2; axis++) {
      const M = axis === 0 ? mx : mz;
      const B = axis === 0 ? Bx : Bz;
      const L = axis === 0 ? Bz : Bx;
      const ecc = Math.abs(M) / W;
      const q = ecc <= B / 6 ? (W / A) * (1 + (6 * ecc) / B) : ecc < B / 2 ? (2 * W) / (3 * L * (B / 2 - ecc)) : Infinity;
      const ratio = q / st.bearing;
      if (ratio > worst) worst = ratio;
      if (ratio > 1) {
        const excess = Math.min(MAX_EXCESS, ratio - 1);
        st.tilt[axis] += Math.sign(M) * TILT_RATE * excess * dt;
      }
    }
    st.bearingRatio = worst;
    st.tiltMag = Math.hypot(st.tilt[0], st.tilt[1]);
    // Foundation slip (plastic offset of the foundation spring), world axes.
    const fx = model.fP[2 * ui];
    const fz = model.fP[2 * ui + 1];
    st.slip[0] = fx * cs + fz * sn;
    st.slip[1] = -fx * sn + fz * cs;
  }
}
