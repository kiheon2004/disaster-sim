/**
 * Pure wind-load formulas (no engine / React dependencies — unit-testable).
 *
 * Model (semi-realistic):
 *   q        = ½ ρ v²                      dynamic pressure (Pa)
 *   F        = q · Cd · A                  drag force (N)
 *   v(z)     = v₁₀ · (z / 10)^α            boundary-layer height profile
 *   loadRatio= (v_eff / v_design)²         1.0 = design load; damage accrues above ~0.7
 */
import type { Vec3 } from '@/core/types';
import type { WorldObject } from '@/core/model';
import { AIR_DENSITY, GRAVITY, WIND_FORCE_SCALE, WIND_REFERENCE_HEIGHT, WIND_SHEAR_EXPONENT } from '@/core/units';
import { getDefinition } from '@/objects/registry';

export function heightFactor(y: number): number {
  return Math.pow(Math.max(y, 2) / WIND_REFERENCE_HEIGHT, WIND_SHEAR_EXPONENT);
}

export function dynamicPressure(v: number, rho = AIR_DENSITY): number {
  return 0.5 * rho * v * v;
}

export function dragForce(v: number, cd: number, area: number, rho = AIR_DENSITY): number {
  return dynamicPressure(v, rho) * cd * area * WIND_FORCE_SCALE;
}

export function loadRatio(vEff: number, designSpeed: number): number {
  if (designSpeed <= 0) return Infinity;
  const r = vEff / designSpeed;
  return r * r;
}

/** Silhouette area of an oriented box seen along a (unit) direction expressed in its local frame. */
export function boxProjectedArea(size: Vec3, dirLocal: Vec3): number {
  const [x, y, z] = size;
  return Math.abs(dirLocal[0]) * y * z + Math.abs(dirLocal[1]) * x * z + Math.abs(dirLocal[2]) * x * y;
}

/** Broadside (worst-case) frontal area of an object including its scale. */
export function broadsideArea(obj: WorldObject): number {
  if (obj.physics.frontalAreaOverride) return obj.physics.frontalAreaOverride;
  const def = getDefinition(obj.type);
  const [sx, sy, sz] = obj.transform.scale;
  if (def.frontalArea) return def.frontalArea(obj.params) * sy * Math.max(sx, sz);
  const d = def.getDimensions(obj.params);
  return Math.max(d[0] * sx, d[2] * sz) * d[1] * sy;
}

export interface CriticalSpeeds {
  /** Reference (10 m) wind speed at which the load ratio reaches 1.0 at the center of pressure. */
  structural: number;
  /** Speed at which drag exceeds static friction (free-standing objects only). */
  sliding?: number;
  /** Speed at which the overturning moment exceeds the restoring moment. */
  tipping?: number;
}

export function estimateCriticalSpeeds(obj: WorldObject): CriticalSpeeds {
  const def = getDefinition(obj.type);
  const cop = def.centerOfPressure(obj.params);
  const copY = cop[1] * obj.transform.scale[1];
  const hf = heightFactor(copY);
  const out: CriticalSpeeds = { structural: obj.physics.windResistance / hf };

  if (!obj.physics.anchored && def.physicsProfile !== 'static') {
    const A = broadsideArea(obj);
    const m = obj.physics.mass;
    const k = 0.5 * AIR_DENSITY * obj.physics.dragCoefficient * A * WIND_FORCE_SCALE;
    out.sliding = Math.sqrt((obj.physics.friction * m * GRAVITY) / k) / hf;
    const d = def.getDimensions(obj.params);
    const halfBase = (Math.min(d[0] * obj.transform.scale[0], d[2] * obj.transform.scale[2]) / 2);
    if (copY > 0) out.tipping = Math.sqrt((m * GRAVITY * halfBase) / (copY * k)) / hf;
  }
  return out;
}
