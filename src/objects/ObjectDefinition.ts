import type { ObjectCategory, ObjectType, Vec3 } from '@/core/types';
import type { ComponentSpec, ObjectParams, PhysicalProperties } from '@/core/model';
import type { ShapeSpec } from '@/core/shapes';
import type { MessageKey } from '@/i18n/i18n';
import type { MassModel } from './massProperties';

/**
 * How the simulation treats an object's rigid body.
 * - static: never moves (building core)
 * - anchoredUntilFailure: fixed until DESTROYED, then becomes dynamic (trees)
 * - dynamic: always simulated (cars, debris)
 * - upright: dynamic with rotations locked until it falls over (people)
 */
export type PhysicsProfile = 'static' | 'anchoredUntilFailure' | 'dynamic' | 'upright';

/**
 * How an object sits on sloped terrain (see terrain/groundPlacement).
 * - align: 0 = stays level (buildings, people), 1 = follows the ground plane (vehicles)
 * - base:  which ground height the origin goes to — 'center' point, lowest footprint corner
 *          ('min': nothing floats, the uphill side is embedded), the mean of the footprint
 *          corners ('mean': wheels on a plane fit), or the HIGHEST footprint point
 *          ('foundation', buildings since Phase 13: nothing is buried; the downhill side
 *          stands on a visible foundation plinth that reaches down to the ground)
 */
export interface TerrainFit {
  align: number;
  base: 'center' | 'min' | 'mean' | 'foundation';
}

export interface ParamSchema {
  key: string;
  labelKey: MessageKey;
  kind: 'number' | 'color' | 'select' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; labelKey: MessageKey }[];
}

/**
 * Phase 35 Level 1: a passive free rigid body (crate, barrel, container, furniture, road barrier, ball). Only the body's
 * mass properties, its water displacement and its breakage differ from the generic dynamic path — every force reaches it
 * through the existing hazard systems (wind, ground motion, water, sediment, blast, gravity, contacts).
 */
export interface PassiveDynamics<P extends ObjectParams = ObjectParams> {
  /** Part model (unscaled params; mass = the type's default mass) → explicit COM + principal inertia of the body. */
  massModel(params: P): MassModel;
  /** Water displaced when fully submerged (m³, unscaled) — the flood buoyancy volume V_eff (WaterForceSystem). */
  displacedVolume(params: P): number;
  /** Drag coefficient in water (WaterForceSystem; air uses physics.dragCoefficient). */
  waterDrag: number;
  /** Breakage: a contact force F costs F / (m·g·factor) of health (Infinity = unbreakable). */
  impactFactor(params: P): number;
  /** Lying on its side is reported (TOPPLED) — not for a ball. */
  toppleEvent: boolean;
}

export interface ObjectDefinition<P extends ObjectParams = ObjectParams> {
  type: ObjectType;
  category: ObjectCategory;
  labelKey: MessageKey;
  /** Icon name understood by the UI icon set. */
  icon: string;
  physicsProfile: PhysicsProfile;
  /** Decorative ground cover (roads): no physics body, no wind load, no damage. */
  inert?: boolean;
  /** Place slightly below other objects and never block selection of things on top. */
  groundLayer?: boolean;
  /** Placement on sloped terrain (default: level, centered). */
  terrainFit?: TerrainFit;
  defaultParams: P;
  paramSchema: ParamSchema[];
  /** Physical defaults may depend on params (e.g. mass from size). */
  defaultPhysics(params: P): PhysicalProperties;
  /** Local bounding box size [x, y, z] with the origin at the base center. */
  getDimensions(params: P): Vec3;
  /** Breakable sub-parts (windows, signs, roof panels …). */
  createComponents(params: P, seed: number): ComponentSpec[];
  /** Point where the resultant wind load acts (local space). */
  centerOfPressure(params: P): Vec3;
  /** Wind-exposed frontal area (m²); if omitted the projected bounding box is used. */
  frontalArea?(params: P): number;
  /** Collision shapes in local space. */
  colliders(params: P): ShapeSpec[];
  /** Phase 35: passive free rigid body (explicit mass properties); absent on every older type. */
  passive?: PassiveDynamics<P>;
  /** Params that change from placement to placement for natural variety. */
  randomizeParams?(params: P, rnd: () => number): Partial<P>;
}

/** Narrow helper to keep definitions strongly typed while storing them in a generic registry. */
export function defineObject<P extends ObjectParams>(def: ObjectDefinition<P>): ObjectDefinition<P> {
  return def;
}

export function num(params: ObjectParams, key: string, fallback = 0): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export function str(params: ObjectParams, key: string, fallback = ''): string {
  const v = params[key];
  return typeof v === 'string' ? v : fallback;
}
export function bool(params: ObjectParams, key: string, fallback = false): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}
