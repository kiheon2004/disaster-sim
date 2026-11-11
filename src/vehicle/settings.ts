/**
 * Phase 35 settings: `settings.simulation.vehicles`. Absent = the legacy cars (Phase 0–34, bit-identical): a rigid body whose
 * chassis box rests on the ground, wheels drawn only. Present (`model: 'dynamics'`) = every car of the world is a wheeled
 * vehicle (Level 2: ray-cast suspension, tyres, wheel spin, powertrain, brakes, steering, aerodynamics) unless its entry says
 * `level: 'rigid'` (Level 1: the legacy chassis collider with the exact composite mass / inertia, no wheels).
 *
 * Controls per car come from (later wins): the car's constant `controls`, its timed `program` (piece-wise constant inputs from
 * time t), its `autopilot` (path following that writes the same inputs), and live input (keyboard / UI) through the runtime.
 * A car without controls is parked (gear P, handbrake on). Occupants link an existing person (extended human model) to a seat.
 */
import { z } from 'zod';
import type { Drive } from './params';
import type { Gear } from './powertrain';
import type { TireModel } from './tire';

export interface ControlInput { throttle?: number; brake?: number; steer?: number; handbrake?: boolean; gear?: Gear }
export interface ControlKey extends ControlInput { t: number }
export interface Autopilot {
  /** Path points (x, z) in metres; target speed (m/s); loop the path; stop at its end; brake for an obstacle ahead. */
  path: [number, number][];
  speed: number;
  loop?: boolean;
  stopAtEnd?: boolean;
  avoid?: boolean;
}
export type Seat = 'driver' | 'front' | 'rearLeft' | 'rearRight';
export interface Occupant { human: string; seat: Seat; restrained: boolean }

export interface VehicleCar {
  level?: 'vehicle' | 'rigid';
  drive?: Drive;
  abs?: boolean;
  controls?: ControlInput;
  program?: ControlKey[];
  autopilot?: Autopilot;
  occupants?: Occupant[];
}

export interface VehicleSettings {
  model: 'dynamics';
  tire?: TireModel;
  substeps?: number;
  abs?: boolean;
  cars?: Record<string, VehicleCar>;
}

const unit = z.number().min(0).max(1);
const controlSchema = z.object({
  throttle: unit.optional(),
  brake: unit.optional(),
  steer: z.number().min(-1).max(1).optional(),
  handbrake: z.boolean().optional(),
  gear: z.enum(['P', 'R', 'N', 'D']).optional(),
});
/** One car's entry (also the car entries a clipboard / Blueprint carries, Phase 37 — src/vehicle/carCopies.ts). */
export const carSchema = z.object({
  level: z.enum(['vehicle', 'rigid']).optional(),
  drive: z.enum(['fwd', 'rwd', 'awd']).optional(),
  abs: z.boolean().optional(),
  controls: controlSchema.optional(),
  program: z.array(controlSchema.extend({ t: z.number().min(0) })).max(1000).optional(),
  autopilot: z.object({
    path: z.array(z.tuple([z.number(), z.number()])).min(2).max(500),
    speed: z.number().min(0).max(60),
    loop: z.boolean().optional(),
    stopAtEnd: z.boolean().optional(),
    avoid: z.boolean().optional(),
  }).optional(),
  occupants: z.array(z.object({ human: z.string().min(1), seat: z.enum(['driver', 'front', 'rearLeft', 'rearRight']), restrained: z.boolean() })).max(4).optional(),
});

export const vehicleSchema = z.object({
  model: z.literal('dynamics'),
  tire: z.enum(['saturating', 'linear']).optional(),
  substeps: z.number().int().min(1).max(32).optional(),
  abs: z.boolean().optional(),
  // An invalid car entry is dropped on its own (the others stay).
  cars: z.record(z.string(), carSchema.nullable().catch(null)).optional(),
});

/** Parsed value → normalized settings (invalid car entries removed, program sorted by time). */
export function normalizeVehicles(v: z.infer<typeof vehicleSchema>): VehicleSettings {
  const cars: Record<string, VehicleCar> = {};
  for (const [id, c] of Object.entries(v.cars ?? {})) {
    if (!c) continue;
    const out: VehicleCar = structuredClone(c) as VehicleCar;
    if (out.program) out.program.sort((a, b) => a.t - b.t);
    cars[id] = out;
  }
  return {
    model: 'dynamics',
    ...(v.tire ? { tire: v.tire } : {}),
    ...(v.substeps !== undefined ? { substeps: v.substeps } : {}),
    ...(v.abs !== undefined ? { abs: v.abs } : {}),
    ...(Object.keys(cars).length ? { cars } : {}),
  };
}

export const DEFAULT_SUBSTEPS = 8;
