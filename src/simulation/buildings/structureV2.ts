/**
 * Structure model v2 hazard routing for modular buildings (Phase 35.5) — member-level instead of whole-building outcomes.
 * Only called when the run's structure model is v2 (settings.simulation.structure); v1 keeps every Phase 25 path.
 *
 *  - Torsion (earthquake): the lumped storey model has no rotational degree of freedom, so the drift of a member is
 *    amplified by its distance from the storey's stiffness centre, δ = 1 + 0.6·d / L (Eurocode 8 §4.3.3.2.4 form for
 *    accidental torsion; d perpendicular to the shaking component, L the plan dimension). Perimeter and corner members
 *    reach their drift capacity first — partial collapses start at corners, not in the core.
 *    When the lumped model's damage index of a storey reaches 1 the storey mechanism of Phase 25 is kept (a soft-storey
 *    collapse is a real mechanism); a "member-first" variant that removed the most demanded third of the storey's members
 *    was tried and collapsed MORE (it cut the perimeter load path) — see the audit in docs §21.
 *  - Exposed face (flood, meteor ejecta): the load acts on the ground-storey members facing it. Stage 1 fails the
 *    face's walls and openings (water / ejecta break in — for water this equalizes the pressure inside); stage 2 the
 *    face's frame columns; only a third overload collapses the building (Phase 25 path).
 *
 * Reduced educational models — documented in docs/PHASE35_5_USER_EXPERIENCE.md §16–21.
 */
import type { Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import type { RuntimeEntity } from '../SimulationRuntime';
import type { ModularRuntime } from './modular';

/** Ablation switches for the audit probes only (every one on in the product). */
export const V2_PARTS = { torsion: true };

const torsionCache = new WeakMap<ModularRuntime, Float32Array>();

/** Per member [δx, δz]: drift amplification for shaking along x / along z (1 for members of no storey). */
export function torsionFactors(mr: ModularRuntime): Float32Array {
  let t = torsionCache.get(mr);
  if (t) return t;
  const ms = mr.design.members;
  t = new Float32Array(2 * ms.length).fill(1);
  for (let s = 0; s < mr.floors; s++) {
    const list = mr.storyMembers[s];
    if (!list.length) continue;
    let cx = 0, cz = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of list) {
      const p = ms[i].position;
      cx += p[0]; cz += p[2];
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]);
    }
    cx /= list.length; cz /= list.length;
    const Lx = Math.max(1, x1 - x0), Lz = Math.max(1, z1 - z0);
    for (const i of list) {
      const p = ms[i].position;
      t[2 * i] = 1 + (0.6 * Math.abs(p[2] - cz)) / Lz;
      t[2 * i + 1] = 1 + (0.6 * Math.abs(p[0] - cx)) / Lx;
    }
  }
  torsionCache.set(mr, t);
  return t;
}

/** Torsion-amplified drift demand of a lateral member (v2): per-axis peak drifts of its storey × δ. */
export function torsionDemand(mr: ModularRuntime, i: number): number {
  const m = mr.design.members[i];
  const s = m.level;
  // Walls and (Phase 36) braces work in their own plane.
  const inPlane = m.type === 'wall' || m.type === 'brace';
  if (!V2_PARTS.torsion) return inPlane ? Math.abs(Math.cos(m.rotation[1])) * mr.storyPeakAxis[2 * s] + Math.abs(Math.sin(m.rotation[1])) * mr.storyPeakAxis[2 * s + 1] : mr.storyPeak[s];
  const t = torsionFactors(mr);
  const ax = mr.storyPeakAxis[2 * s] * t[2 * i], az = mr.storyPeakAxis[2 * s + 1] * t[2 * i + 1];
  if (inPlane) {
    const y = m.rotation[1];
    return Math.abs(Math.cos(y)) * ax + Math.abs(Math.sin(y)) * az;
  }
  return Math.max(ax, az);
}

/**
 * Ground-storey members on the face a horizontal load comes from (`dir` = direction the load acts in, world frame):
 * walls / doors / windows whose plane faces it and frame columns, all within 1.5 m of the upstream edge of the plan.
 */
export function exposedFace(e: RuntimeEntity, dir: Vec3, kinds: 'envelope' | 'frame'): number[] {
  const mr = e.modular!;
  const ms = mr.design.members;
  const q = e.pose.quaternion;
  const local = qRotate([-q[0], -q[1], -q[2], q[3]], [dir[0], 0, dir[2]]);
  const l = Math.hypot(local[0], local[2]);
  if (l < 1e-9) return [];
  const fx = local[0] / l, fz = local[2] / l;
  let lo = Infinity;
  for (let i = 0; i < ms.length; i++) if (ms[i].level === 0 && !mr.failed[i]) lo = Math.min(lo, ms[i].position[0] * fx + ms[i].position[2] * fz);
  const out: number[] = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.level !== 0 || mr.failed[i]) continue;
    if (m.position[0] * fx + m.position[2] * fz > lo + 1.5) continue;
    if (kinds === 'envelope') {
      if (m.type !== 'wall' && m.type !== 'door' && m.type !== 'window') continue;
      // Plane normal of a wall (local x axis after its yaw) facing the load.
      const y = m.rotation[1];
      const nx = Math.cos(y), nz = -Math.sin(y);
      if (Math.abs(nx * fz - nz * fx) < 0.7) continue;
    } else if (m.type !== 'column') continue;
    out.push(i);
  }
  return out;
}

/** Stage of a building's v2 face failure per hazard (0 = none yet). */
export function faceStage(mr: ModularRuntime, hazard: string): number {
  return mr.v2Stage?.[hazard] ?? 0;
}

export function setFaceStage(mr: ModularRuntime, hazard: string, stage: number) {
  (mr.v2Stage ??= {})[hazard] = stage;
}
