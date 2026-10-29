/**
 * The complete, deterministic plan of one impact (Phase 23): projectile → atmospheric entry (or
 * none) → arc through the world to the TERRAIN → energy and momentum → crater (target material at
 * the actual impact point) → ejecta parcels and their flights → ground shock. The experiment
 * preview and the simulation call the same function on the same terrain, so the preview shows the
 * model's own numbers.
 */
import { GRAVITY } from '@/core/units';
import type { TerrainData } from '@/core/model';
import { samplerFor } from '@/terrain/TerrainSampler';
import { soilProfile } from '@/terrain/SoilProfiles';
import { mechanicalOf, MECHANICAL_PROFILES, type MechanicalProfile } from '@/ground/materials';
import { DEFAULT_AIR_COUPLING, type ImpactSpec } from './types';
import { resolveProjectile, type ResolvedProjectile } from './projectile';
import { HANDOVER_ALTITUDE, integrateEntry, type EntryResult } from './entry';
import { flyArc, type ArcResult } from './trajectory';
import { computeCrater, type CraterResult } from './crater';
import { assignFootprints, fly, generateParcels, type Parcel } from './ejecta';
import { createShock, peakAcceleration, peakVelocity, type GroundShock } from './shock';
import { partition, type EnergyPartition } from './energy';

export interface ImpactPlan {
  spec: ImpactSpec;
  projectile: ResolvedProjectile;
  entry: EntryResult | null;
  /** Seconds from the event start to the impact. */
  timeToImpact: number;
  arc: ArcResult;
  /** Airburst: no ground impact (energy released in the air). */
  airburst: boolean;
  /** Projectile state at the ground. */
  mass: number;
  speed: number;
  angle: number;
  energy: number;
  momentum: [number, number, number];
  /** Swarm diameter at the ground (> body diameter after break-up) — crater field if it exceeds the crater. */
  swarm: number;
  target: MechanicalProfile;
  crater: CraterResult | null;
  parcels: Parcel[];
  shock: GroundShock | null;
  partition: EnergyPartition;
  /** Ejecta: launched mass, mass landing inside / outside the world (kg). */
  ejectaMass: number;
  ejectaOut: number;
  warnings: { key: string; params?: Record<string, string | number> }[];
}

const box = (t: TerrainData) => ({ x0: t.originX, z0: t.originZ, x1: t.originX + (t.nx - 1) * t.cellSize, z1: t.originZ + (t.nz - 1) * t.cellSize });

/** Mechanical profile of the ground at a point (the soil map's default). */
export function profileAtPoint(t: TerrainData, x: number, z: number): MechanicalProfile {
  const ix = Math.round((x - t.originX) / t.cellSize), iz = Math.round((z - t.originZ) / t.cellSize);
  if (ix < 0 || iz < 0 || ix >= t.nx || iz >= t.nz) return MECHANICAL_PROFILES.denseGranular;
  return mechanicalOf(t.soil[iz * t.nx + ix]);
}

/**
 * Phase 29 (opt-in coupling of an atmosphere experiment): `air.rho0` scales the entry atmosphere (its
 * sea-level density), `air.rhoGround` is the density the ejecta fly through. Absent: Phase 23 exactly.
 */
export interface PlanAir { rho0: number; rhoGround: number }

export function planImpact(spec: ImpactSpec, terrain: TerrainData, seed: number, withEjecta = true, air?: PlanAir): ImpactPlan {
  const s = samplerFor(terrain);
  const ground = (x: number, z: number) => s.sampleHeight(x, z);
  const projectile = resolveProjectile(spec);
  const warnings: ImpactPlan['warnings'] = projectile.issues.map((i) => ({ key: i.key, params: i.params }));
  const E0 = 0.5 * projectile.mass * spec.speed * spec.speed;
  let entry: EntryResult | null = null;
  let speed = spec.speed, mass = projectile.mass, swarm = projectile.diameter, entryTime = 0, angle = spec.angle;
  if (spec.entry === 'atmosphere') {
    entry = air ? integrateEntry(projectile, spec.speed, spec.angle, HANDOVER_ALTITUDE, air.rho0) : integrateEntry(projectile, spec.speed, spec.angle, HANDOVER_ALTITUDE);
    speed = entry.speed; mass = entry.mass; swarm = entry.diameter; entryTime = entry.time; angle = entry.angle;
    if (entry.ablated) warnings.push({ key: 'impact.warn.ablated' });
    if (entry.breakup) warnings.push({ key: 'impact.warn.breakup', params: { z: (entry.breakup.altitude / 1000).toFixed(1) } });
  } else warnings.push({ key: 'impact.warn.direct' });
  const aimHeight = ground(spec.target[0], spec.target[1]);
  const arc = flyArc({ aim: spec.target, aimHeight, speed, angle, azimuth: spec.azimuth, handover: HANDOVER_ALTITUDE }, ground);
  const airburst = !!entry?.airburst || !!entry?.ablated || mass <= 0;
  const impactSpeed = airburst ? 0 : arc.speed;
  const energy = 0.5 * mass * impactSpeed * impactSpeed;
  const vel = arc.velocity;
  const momentum: [number, number, number] = airburst ? [0, 0, 0] : [mass * vel[0], mass * vel[1], mass * vel[2]];
  const [px, py, pz] = arc.point;
  const target = profileAtPoint(terrain, px, pz);
  const b = box(terrain);
  if (px < b.x0 || px > b.x1 || pz < b.z0 || pz > b.z1) warnings.push({ key: 'impact.warn.outside' });
  if (arc.miss > 0.5) warnings.push({ key: 'impact.warn.miss', params: { d: arc.miss.toFixed(1) } });
  let crater: CraterResult | null = null;
  let parcels: Parcel[] = [];
  let shock: GroundShock | null = null;
  let ejectaKE = 0, ejectaMass = 0, ejectaOut = 0;
  if (!airburst && energy > 0) {
    crater = computeCrater({ mass, density: projectile.density, speed: impactSpeed, angle: arc.angle, target, g: GRAVITY });
    if (crater.oblique) warnings.push({ key: 'impact.warn.oblique' });
    // Point-source scaling is built on hypervelocity data (impact speed ≫ the target's sound speed);
    // slower impacts (bodies at terminal speed) are an extrapolation toward penetration.
    if (impactSpeed < 1000) warnings.push({ key: 'impact.warn.lowSpeed', params: { v: impactSpeed.toFixed(0) } });
    if (swarm > 2 * crater.radius) warnings.push({ key: 'impact.warn.swarm', params: { L: swarm.toFixed(1) } });
    if (crater.radius * 2 > (b.x1 - b.x0) * 0.5) warnings.push({ key: 'impact.warn.large', params: { D: (2 * crater.radius).toFixed(0) } });
    if (!target.failureModel && crater.regime === 'strength') warnings.push({ key: 'impact.warn.rock' });
    if (withEjecta) {
      parcels = generateParcels({ crater, center: [px, py, pz], delta: projectile.density, rho: target.density, rock: target.id === 'rock', angle: arc.angle, azimuth: spec.azimuth, seed: spec.seed ?? seed });
      for (const p of parcels) {
        if (air) fly(p, ground, b, target.density, air.rhoGround);
        else fly(p, ground, b, target.density);
        ejectaKE += 0.5 * p.mass * p.speed * p.speed;
        ejectaMass += p.mass;
        if (p.outflow) ejectaOut += p.mass;
      }
      assignFootprints(parcels, [px, py, pz]);
    }
    const soil = soilProfile(s.sampleSoil(px, pz).id);
    shock = createShock({ energy, rho: soil.density, c: soil.vs30, damping: soil.damping, radius: crater.radius }, [px, pz], entryTime + arc.time);
    if (shock.tau < shock.tauApplied) warnings.push({ key: 'impact.warn.pulse', params: { tau: (shock.tau * 1000).toFixed(0), app: (shock.tauApplied * 1000).toFixed(0) } });
  }
  if (airburst) warnings.push({ key: 'impact.warn.airburst', params: { z: ((entry?.airburst?.altitude ?? 0) / 1000).toFixed(1) } });
  // Phase 24: the air blast's share (only when the spec asks for it — older plans are unchanged).
  const coupling = spec.airBlast ? spec.airCoupling ?? DEFAULT_AIR_COUPLING : 0;
  const part = partition(E0, energy, shock?.seismicEnergy ?? 0, ejectaKE, coupling, spec.airBlast && entry?.airburst ? entry.airburst.energy : 0, airburst ? 0 : spec.thermalShare ?? 0);
  if (spec.airBlast && part.blast < coupling * energy - 1e-6) warnings.push({ key: 'impact.warn.airCap', params: { pct: ((100 * part.blast) / Math.max(1e-9, energy)).toFixed(1) } });
  return {
    spec, projectile, entry, timeToImpact: entryTime + arc.time, arc, airburst, mass, speed: impactSpeed, angle: arc.angle, energy, momentum,
    swarm, target, crater, parcels, shock, partition: part, ejectaMass, ejectaOut, warnings,
  };
}

/** Peak ground velocity / acceleration of a plan at distance r (m/s, m/s²; physical pulse). */
export function shockAt(plan: ImpactPlan, r: number) {
  if (!plan.shock) return { pgv: 0, pga: 0, pgaApplied: 0 };
  return { pgv: peakVelocity(plan.shock, r), pga: peakAcceleration(plan.shock, r), pgaApplied: peakAcceleration(plan.shock, r, true) };
}
