/**
 * Shared physical effect channels (Phase 15).
 *
 * A channel is a physical quantity in the world that phenomena WRITE and systems READ. Systems
 * react to channels, not to disaster names, so a new phenomenon that writes an existing channel
 * (e.g. a tornado writing `airflow`) is handled by the existing systems.
 *
 * Status:
 *  - active:    implemented and connected (field + writer + readers)
 *  - uniform:   exists only as a constant (gravity: one global vector in Rapier)
 *  - interface: the data contract below is defined, but NO system computes it yet — nothing in
 *               the UI presents it as simulated (the "baseline" values are fixed constants)
 *
 * Not everything reduces to a force: oxygen fraction or temperature change exposure states,
 * not Rapier forces — hence separate channels instead of one force vector.
 */
import type { MessageKey } from '@/i18n/i18n';
import type { Vec3 } from '@/core/types';
import type { ChannelId } from './types';

export type ChannelStatus = 'active' | 'uniform' | 'interface';

export interface ChannelInfo {
  id: ChannelId;
  labelKey: MessageKey;
  status: ChannelStatus;
  /** Quantity and unit of a sample. */
  quantity: string;
  /** Field that holds the state (owner) and the systems that write / read it. */
  owner: string;
  writers: string[];
  readers: string[];
}

export const CHANNELS: Record<ChannelId, ChannelInfo> = {
  mechanicalForce: {
    id: 'mechanicalForce', labelKey: 'channel.mechanicalForce', status: 'active', quantity: 'N, N·s on rigid bodies',
    owner: 'Rapier world (PhysicsEngine) via ForceLedger', writers: ['windForce', 'groundMotion', 'waterForce', 'blast', 'damage (impulses)'], readers: ['poseSync', 'damage'],
  },
  airflow: {
    id: 'airflow', labelKey: 'channel.airflow', status: 'active', quantity: 'wind velocity m/s',
    owner: 'env.wind (global) + env.windField (spatial)', writers: ['WindEvent'], readers: ['windForce', 'damage', 'waterSolver (surface stress)', 'particles', 'renderer'],
  },
  groundMotion: {
    id: 'groundMotion', labelKey: 'channel.groundMotion', status: 'active', quantity: 'ground displacement m, velocity m/s, acceleration m/s²',
    owner: 'env.groundMotion', writers: ['EarthquakeEvent', 'ImpactEvent (ground shock, Phase 23)'], readers: ['groundMotion', 'structural', 'seismicDamage', 'waterSolver (inertial load)', 'renderer'],
  },
  water: {
    id: 'water', labelKey: 'channel.water', status: 'active', quantity: 'depth m, surface m, velocity m/s',
    owner: 'env.flood.field (WaterField) — written only by the WaterSolver', writers: ['RainEvent', 'RisingWaterEvent', 'WaterSourceEvent (forcing)', 'waterSolver'],
    readers: ['waterForce', 'groundContact', 'floodDamage', 'exposure', 'renderer'],
  },
  pressure: {
    id: 'pressure', labelKey: 'channel.pressure', status: 'active', quantity: 'overpressure Pa, positive impulse Pa·s (air-pressure waves)',
    owner: 'env.blast (BlastChannel: waves with their propagation tables, Phase 24)', writers: ['BlastEvent', 'ImpactEvent (airburst / air-coupled share)'],
    readers: ['blast (structures, facade parts, bodies, trees, debris)', 'structural (lateral load)', 'waterSolver (pressure gradient)', 'renderer', 'inspector'],
  },
  temperature: {
    id: 'temperature', labelKey: 'channel.temperature', status: 'interface', quantity: 'air / surface temperature °C, heat flux W/m²',
    owner: '— (future ThermalField)', writers: [], readers: ['exposure (baseline constant)'],
  },
  gravity: {
    id: 'gravity', labelKey: 'channel.gravity', status: 'uniform', quantity: 'gravitational acceleration m/s²',
    owner: 'Rapier world gravity (project setting, constant)', writers: [], readers: ['Rapier', 'structural', 'buoyancy'],
  },
  terrainDeformation: {
    id: 'terrainDeformation', labelKey: 'channel.terrainDeformation', status: 'active', quantity: 'vertical ground displacement m (+ up)',
    owner: 'env.deformation (DeformationEngine over the run\'s terrain copy)', writers: ['TerrainDeformationEvent', 'groundFailure field (sinkholes, landslides)', '(Phase 23 craters)'],
    readers: ['deformation (terrain, collider, water bed, foundations, roads)', 'renderer'],
  },
  groundSupport: {
    id: 'groundSupport', labelKey: 'channel.groundSupport', status: 'active', quantity: 'factor of safety, support multiplier, water-table ratio',
    owner: 'env.groundFailure (GeoField: soil thickness, strength, water table, failure state)', writers: ['SinkholeEvent', 'LandslideEvent', 'rain infiltration (water solver)'],
    readers: ['groundFailure (stability, Newmark, cavity roof)', 'foundations (support)', 'inspector'],
  },
  sediment: {
    id: 'sediment', labelKey: 'channel.sediment', status: 'active', quantity: 'mobile layer thickness m, velocity m/s, deposits m, mass kg',
    owner: 'env.groundFailure (granular runout solver)', writers: ['groundFailure (failures → mobile layer → deposits)'],
    readers: ['deformation (terrain)', 'sedimentForce (drag)', 'objects (loads, burial)', 'roads (blockage)', 'renderer'],
  },
  atmosphere: {
    id: 'atmosphere', labelKey: 'channel.atmosphere', status: 'interface', quantity: 'pressure kPa, O₂ fraction, density kg/m³',
    owner: '— (future AtmosphereField)', writers: [], readers: ['exposure (baseline constant)'],
  },
};

export const CHANNEL_IDS = Object.keys(CHANNELS) as ChannelId[];

// ── Field contracts (implemented channels already have their own fields) ─────────────

/** Atmospheric state at a point. Only the baseline below exists (no atmospheric model). */
export interface AtmosphereSample {
  /** kPa */
  pressure: number;
  /** Volume fraction of O₂. */
  oxygen: number;
  /** °C */
  temperature: number;
  /** kg/m³ */
  density: number;
}

/** Standard atmosphere at sea level — a constant, NOT a simulation result. */
export const BASELINE_ATMOSPHERE: Readonly<AtmosphereSample> = { pressure: 101.325, oxygen: 0.2095, temperature: 15, density: 1.225 };

/**
 * Future contract of a spatial gravity field (gravity change, black hole). Today gravity is the
 * uniform project setting inside Rapier; a non-uniform field would be applied as per-body forces
 * through the ForceLedger with source 'gravityField' while Rapier's own gravity stays the baseline.
 */
export interface GravityField {
  /** Gravitational acceleration at a point (m/s², written into `out`). */
  sample(p: Readonly<Vec3>, t: number, out: Vec3): Vec3;
  readonly uniform: boolean;
}

export class UniformGravity implements GravityField {
  readonly uniform = true;
  constructor(private readonly g: number) {}
  sample(_p: Readonly<Vec3>, _t: number, out: Vec3): Vec3 {
    out[0] = 0;
    out[1] = -this.g;
    out[2] = 0;
    return out;
  }
}

/** Future contract of terrain deformation (sinkhole, crater, landslide). */
export interface TerrainDeformationRequest {
  /** Vertex rectangle and the new heights in it (row-major). */
  rect: { x0: number; z0: number; x1: number; z1: number };
  heights: Float32Array;
  /** Rebuild the physics collider (PhysicsEngine.setTerrain) and the water bed after applying. */
  rebuild: true;
}
