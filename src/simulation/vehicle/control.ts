/**
 * Phase 35: live control of a vehicle from the UI, the keyboard and the devtools — one interface for every input device.
 *
 * Writes `e.vehicle.live` (a ControlInput, null = no live override). The vehicle system reads it at the start of every fixed
 * step (constant → program → autopilot; a live input wins and suspends the autopilot), so an input written while
 * the simulation is paused is stored and acts from the next step on — nothing here moves a body or touches the physics.
 * Values are clamped to the input ranges (throttle / brake 0…1, steer −1 right … 1 left). Only wheeled ('vehicle') cars of a
 * vehicle-dynamics run accept input; the functions return false otherwise.
 *
 * Autopilot: `stopAutopilot` removes the car's path follower for the rest of the run (the car falls back to its constant /
 * program / live inputs); `startAutopilot` restarts the configured one (settings) from its first point or, with a target point,
 * drives a straight path from where the car is to that point and stops there. Not part of the document: a reset rebuilds it.
 */
import type { SimulationRuntime } from '../SimulationRuntime';
import type { ControlInput } from '@/vehicle/settings';
import type { Gear } from '@/vehicle/powertrain';
import type { VehicleEntity } from './state';

/** What the functions need of the controller (the app's simulationController, a test's headless one). */
export interface RuntimeSource { getRuntime(): SimulationRuntime | null }

export const GEARS: readonly Gear[] = ['P', 'R', 'N', 'D'];
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0);

/** The drivable vehicle state of an entity (wheeled car of a vehicle-dynamics run), or null. */
export function drivable(c: RuntimeSource, id: string): VehicleEntity | null {
  const v = c.getRuntime()?.entities.get(id)?.vehicle;
  return v && v.level === 'vehicle' ? v : null;
}

/** Merge a partial input into the car's live input (creating it). */
export function setLiveInput(c: RuntimeSource, id: string, input: ControlInput): boolean {
  const v = drivable(c, id);
  if (!v) return false;
  const l: ControlInput = { ...(v.live ?? {}) };
  if (input.throttle !== undefined) l.throttle = clamp(input.throttle, 0, 1);
  if (input.brake !== undefined) l.brake = clamp(input.brake, 0, 1);
  if (input.steer !== undefined) l.steer = clamp(input.steer, -1, 1);
  if (input.handbrake !== undefined) l.handbrake = !!input.handbrake;
  if (input.gear !== undefined && GEARS.includes(input.gear)) l.gear = input.gear;
  v.live = l;
  return true;
}

/**
 * Switch live control on: pedals and steering neutral; a parked car (gear P / parking brake from its settings) is put in D
 * with the parking brake released, so the throttle moves it.
 */
export function enableLiveInput(c: RuntimeSource, id: string): boolean {
  const v = drivable(c, id);
  if (!v) return false;
  // The configured inputs (constant / latest program key) — the effective controls are only resolved at the first step.
  const parked = (v.live?.gear ?? v.base.gear) === 'P';
  return setLiveInput(c, id, { throttle: 0, brake: 0, steer: 0, ...(parked ? { gear: 'D' as Gear, handbrake: false } : {}) });
}

/** Remove the live override (the car returns to its constant / program / autopilot inputs from the next step). */
export function clearLiveInput(c: RuntimeSource, id: string): boolean {
  const v = drivable(c, id);
  if (!v) return false;
  v.live = null;
  return true;
}

/** Stop the car's autopilot for the rest of the run. */
export function stopAutopilot(c: RuntimeSource, id: string): boolean {
  const v = drivable(c, id);
  if (!v || !v.autopilot) return false;
  v.autopilot = null;
  return true;
}

/**
 * Start an autopilot: to a target point (x, z in m; straight path from the car's position, stop at the end; speed m/s, default
 * 8) or, without a target, the car's configured autopilot from its first point. Returns false when there is nothing to start.
 */
export function startAutopilot(c: RuntimeSource, id: string, target?: { x: number; z: number; speed?: number }): boolean {
  const rt = c.getRuntime();
  const e = rt?.entities.get(id);
  const v = drivable(c, id);
  if (!rt || !e || !v) return false;
  if (target) {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return false;
    const p = e.pose.position;
    const speed = clamp(target.speed ?? 8, 0, 60);
    v.autopilot = { path: [[p[0], p[2]], [target.x, target.z]], speed, loop: false, stopAtEnd: true, avoid: true, target: 1, done: false, obstacle: null };
    return true;
  }
  const cfg = rt.vehicles?.settings.cars?.[id]?.autopilot;
  if (!cfg) return false;
  v.autopilot = { ...structuredClone(cfg), target: 0, done: false, obstacle: null };
  return true;
}
