/**
 * Runtime state of the earthquake systems (Phase 13) and its lazy construction.
 *
 * Nothing here exists until the first earthquake actually starts: wind-only runs build no
 * structural model, allocate nothing and stay bit-identical to Phase 12.
 */
import type { EntityId, Vec3 } from '@/core/types';
import { qRotate } from '@/core/math';
import type { BuildingParams } from '@/objects/definitions/building';
import { buildingHeight } from '@/objects/definitions/building';
import { SOIL_COUNT, shearModulus, soilProfile } from '@/terrain/SoilProfiles';
import type { TerrainSampler } from '@/terrain/TerrainSampler';
import { foundationPlinth } from '@/terrain/groundPlacement';
import type { RuntimeEntity, SimulationRuntime } from '../SimulationRuntime';
import { createGroundMotionSample, type GroundMotionSample } from './GroundMotionField';
import { StructuralModel } from './StructuralModel';
import { residualStrength } from '../interactions/integrity';
import { FOUNDATION_TYPES, STRUCTURAL_SYSTEMS, collapseDrift, infraProps, naturalPeriod, seismicOf, type DriftThresholds } from './structuralProps';
import type { WorldObject } from '@/core/model';
import { modularUnit } from '@/buildings/structuralAdapter';
import { foundationContact } from '@/buildings/foundation';
import { attachUnit } from '../buildings/modular';

export interface SeismicEntityState {
  /** Unit in the structural model (−1: not a structure). */
  unit: number;
  /** Ground motion at the object's base (world axes). */
  ground: GroundMotionSample;
  /** Peak horizontal ground acceleration seen at the base (m/s²). */
  pga: number;
  /**
   * Peak horizontal acceleration of the earthquake part and of impact ground shocks at the base
   * (Phase 23): shaking damage is attributed to the impact where its peak governs.
   */
  pgaQuake: number;
  pgaImpact: number;
  /**
   * Peak lateral load of air-pressure waves on the structure divided by its mass (m/s², Phase 24) —
   * the blast's equivalent of a ground acceleration: structural damage is attributed to the blast
   * where it governs (see blastGovernsStructure).
   */
  pgaBlast: number;
  /** Top / foundation displacement relative to the ground (world x, z; m). */
  top: [number, number];
  base: [number, number];
  /** Current / peak story drift ratio, structural damage index (≥ 1 = collapse capacity). */
  drift: number;
  peakDrift: number;
  damage: number;
  /** Peak |top displacement| (m) and peak absolute floor acceleration (m/s²). */
  peakTop: number;
  peakFloorAcc: number;
  /** Residual foundation tilt (rad) toward world +x / +z, and its magnitude. */
  tilt: [number, number];
  tiltMag: number;
  /** Foundation slip (m, world x, z). */
  slip: [number, number];
  foundationFailed: boolean;
  /** Current bearing pressure / capacity (foundation). */
  bearingRatio: number;
  /** Visual demand 0–1+ (current drift / slight-damage drift) for the stress overlay. */
  stress: number;
  /** Wall cracking severity 0–1 and the highest crack level already recorded. */
  crack: number;
  crackRecorded: number;
  /** People: balance reserve (1 → 0 = falls). */
  balance: number;
  /** Visual shaking intensity at the base (0–1, people brace, cars rock). */
  shake: number;
  /** Unit vector (x, z) of the current horizontal ground acceleration. */
  shakeDir: [number, number];
  /** Per-component capacity (drift for glass, g for anchored parts), deterministic per seed. */
  capacity: Float64Array | null;
  /** Per-component accumulated seismic damage 0–1. */
  partDamage: Float64Array | null;
  /** Drift damage thresholds of the structural system (buildings). */
  thresholds: DriftThresholds | null;
  /** Foundation: bearing capacity (Pa) and footprint (m) along world x / z. */
  bearing: number;
  footprint: [number, number];
  failureTilt: number;
  /** Plinth depth below the floor (m) — terrain foundation on slopes. */
  plinth: number;
  /** Fixed-base fundamental period (s) and the soil profile under the object. */
  period: number;
  soil: number;
}

export interface SeismicRuntime {
  model: StructuralModel;
  /** Entities with a structural unit, in unit order. */
  units: RuntimeEntity[];
  /** Every entity that reacts to shaking (has a SeismicEntityState). */
  entities: RuntimeEntity[];
  /** Earthquake was active on the previous step (to reset visuals once it ends). */
  wasActive: boolean;
  /** Seconds of free vibration still integrated after the shaking ended. */
  freeVibration: number;
  /** Fixed-base periods are only informative; this is the run's structural step counter. */
  steps: number;
  byId: Map<EntityId, RuntimeEntity>;
  /**
   * Whether the first ground motion / external load has reached the model (Phase 24): the model may
   * be built ahead of time (before the clock), but the residual strength of objects damaged by other
   * hazards is applied only at that moment — exactly when the lazy build used to happen.
   */
  activated: boolean;
}

function createState(): SeismicEntityState {
  return {
    unit: -1, ground: createGroundMotionSample(), pga: 0, pgaQuake: 0, pgaImpact: 0, pgaBlast: 0, top: [0, 0], base: [0, 0], drift: 0, peakDrift: 0, damage: 0,
    peakTop: 0, peakFloorAcc: 0, tilt: [0, 0], tiltMag: 0, slip: [0, 0], foundationFailed: false, bearingRatio: 0, stress: 0,
    crack: 0, crackRecorded: 0, balance: 1, shake: 0, shakeDir: [1, 0], capacity: null, partDamage: null, thresholds: null,
    bearing: 0, footprint: [1, 1], failureTilt: Infinity, plinth: 0, period: 0, soil: 1,
  };
}

/** Heading (rad about +Y) of a pose quaternion. */
function yaw(q: [number, number, number, number]): number {
  const v = qRotate(q, [1, 0, 0]);
  return Math.atan2(-v[2], v[0]);
}

const weights = new Float64Array(SOIL_COUNT);

/** Soil properties under a point, blended with the bilinear soil weights. */
function blendedSoil(terrain: TerrainSampler, x: number, z: number) {
  terrain.sampleSoilWeights(x, z, weights);
  let G = 0, bearing = 0, damping = 0, best = 1, bestW = -1;
  for (let s = 0; s < SOIL_COUNT; s++) {
    const w = weights[s];
    if (w <= 0) continue;
    const p = soilProfile(s);
    G += w * shearModulus(p);
    bearing += w * p.bearingCapacity * 1000;
    damping += w * p.damping;
    if (w > bestW) { bestW = w; best = s; }
  }
  return { G, bearing, damping, id: best };
}

/**
 * Modular building (Phase 17): the structural unit comes from the member-based analysis through
 * the explicit adapter (per-story stiffness / strength / masses, lumped to ≤ 5 dofs); the
 * foundation spring uses the same soil formulas as legacy buildings, with the ground contact of
 * the sampled foundation model (gaps under a 'preserve' foundation bear nothing).
 */
function buildModularUnit(e: RuntimeEntity, st: SeismicEntityState, model: StructuralModel, terrain: TerrainSampler, soil: ReturnType<typeof blendedSoil>, gravity: number) {
  const o = e.source;
  const mr = e.modular!;
  const props = seismicOf(o)!;
  const a = mr.current;
  const unit = modularUnit(a, props);
  const ft = FOUNDATION_TYPES[props.foundation.type];
  const M = a.totalMass;
  const k = o.transform.scale;
  const width = Number(o.params.width) * k[0];
  const depth = Number(o.params.depth) * k[2];
  const area = width * depth;
  const fc = foundationContact(o as WorldObject, terrain);
  st.plinth = fc.plinth;
  const contact = props.foundation.groundContact * Math.max(0.05, fc.contact) * (1 - 0.3 * Math.min(1, st.plinth / 3));
  const R = Math.sqrt(area / Math.PI);
  const kf = ((8 * soil.G * R) / (2 - 0.33)) * ft.stiffnessFactor * props.foundation.stiffness * contact;
  const mf = Math.max(a.foundationMass, ft.massFraction * M * 0.5);
  const W = (M + mf) * gravity;
  const slip = props.foundation.anchorage * W * contact;
  st.period = Math.max(unit.period[0], unit.period[1]);
  st.thresholds = unit.thresholds;
  st.bearing = soil.bearing * ft.bearingFactor;
  const yw = yaw(e.initialPose.quaternion);
  st.footprint = [Math.abs(width * Math.cos(yw)) + Math.abs(depth * Math.sin(yw)), Math.abs(width * Math.sin(yw)) + Math.abs(depth * Math.cos(yw))];
  st.failureTilt = (props.foundation.failureThreshold * Math.PI) / 180;
  const L = unit.lumps;
  st.unit = model.add({
    ndof: L.mass.length,
    mass: M,
    height: L.height.reduce((t, h) => t + h, 0),
    period: st.period,
    dampingRatio: unit.dampingRatio,
    cyX: 0,
    cyZ: 0,
    hardening: unit.hardening,
    driftU: unit.driftU,
    yaw: yw,
    gravity,
    foundation: {
      mass: mf,
      stiffness: kf,
      dampingRatio: props.foundation.damping > 0 ? props.foundation.damping : 0.05 + 1.5 * soil.damping,
      slipX: slip,
      slipZ: slip,
    },
    stories: { mass: L.mass, height: L.height, kx: L.kx, kz: L.kz, fyX: L.fyX, fyZ: L.fyZ },
  });
  attachUnit(mr, unit, st.unit);
  st.footprint[0] *= Math.sqrt(contact);
  st.footprint[1] *= Math.sqrt(contact);
}

/** Build the structural model and per-entity states (once, when the first earthquake starts). */
export function buildSeismicRuntime(runtime: SimulationRuntime, terrain: TerrainSampler, gravity: number): SeismicRuntime {
  const model = new StructuralModel();
  const units: RuntimeEntity[] = [];
  const entities: RuntimeEntity[] = [];
  const byId = new Map<EntityId, RuntimeEntity>();
  for (const e of runtime.entities.values()) {
    if (e.def.inert) continue;
    const st = createState();
    e.seismic = st;
    entities.push(e);
    byId.set(e.id, e);
    const [px, , pz] = e.initialPose.position;
    const soil = blendedSoil(terrain, px, pz);
    st.soil = soil.id;
    const o = e.source;
    const k = o.transform.scale;
    if (o.type === 'building' && e.modular) {
      buildModularUnit(e, st, model, terrain, soil, gravity);
      units.push(e);
    } else if (o.type === 'building') {
      const props = seismicOf(o)!;
      const p = o.params as BuildingParams;
      const H = buildingHeight(p) * k[1];
      const sys = STRUCTURAL_SYSTEMS[props.structure.system];
      const ft = FOUNDATION_TYPES[props.foundation.type];
      const M = o.physics.mass;
      const width = p.width * k[0];
      const depth = p.depth * k[2];
      const area = width * depth;
      st.plinth = foundationPlinth(o, terrain);
      // A tall stepped plinth on a slope bears less uniformly on the ground.
      const contact = props.foundation.groundContact * (1 - 0.3 * Math.min(1, st.plinth / 3));
      const R = Math.sqrt(area / Math.PI);
      // Horizontal stiffness of a rigid disk on an elastic half-space: 8GR/(2−ν).
      const kf = ((8 * soil.G * R) / (2 - 0.33)) * ft.stiffnessFactor * props.foundation.stiffness * contact;
      const mf = ft.massFraction * M;
      const W = (M + mf) * gravity;
      const slip = props.foundation.anchorage * W * contact;
      st.period = naturalPeriod(props.structure, H);
      st.thresholds = sys.drift;
      st.bearing = soil.bearing * ft.bearingFactor;
      const yw = yaw(e.initialPose.quaternion);
      // Footprint extent along world x / z (for bearing pressure under overturning).
      st.footprint = [Math.abs(width * Math.cos(yw)) + Math.abs(depth * Math.sin(yw)), Math.abs(width * Math.sin(yw)) + Math.abs(depth * Math.cos(yw))];
      st.failureTilt = (props.foundation.failureThreshold * Math.PI) / 180;
      const cy = sys.cy * props.structure.strengthFactor;
      st.unit = model.add({
        ndof: Math.min(5, p.floors),
        mass: M,
        height: H,
        period: st.period,
        dampingRatio: props.structure.dampingRatio,
        cyX: cy,
        cyZ: cy,
        hardening: sys.hardening,
        driftU: collapseDrift(props.structure.system),
        yaw: yw,
        gravity,
        foundation: {
          mass: mf,
          stiffness: kf,
          dampingRatio: props.foundation.damping > 0 ? props.foundation.damping : 0.05 + 1.5 * soil.damping,
          slipX: slip,
          slipZ: slip,
        },
      });
      // Contact area actually bearing (for the pressure check).
      st.footprint[0] *= Math.sqrt(contact);
      st.footprint[1] *= Math.sqrt(contact);
      units.push(e);
    } else {
      const inf = infraProps(o.type, e.dims as Vec3);
      if (inf && e.body !== null) {
        st.period = inf.period;
        st.unit = model.add({
          ndof: 1,
          mass: o.physics.mass,
          height: e.dims[1],
          period: inf.period,
          dampingRatio: inf.damping,
          cyX: inf.cyX,
          cyZ: inf.cyZ,
          hardening: 0.02,
          driftU: inf.driftU,
          yaw: yaw(e.initialPose.quaternion),
          gravity,
          foundation: null,
        });
        units.push(e);
      }
    }
  }
  model.finalize();
  return { model, units, entities, wasActive: false, freeVibration: 0, steps: 0, byId, activated: false };
}

/**
 * Get (or lazily build) the seismic runtime. With multi-hazard interactions, structures that
 * the wind or the water already damaged start the earthquake with reduced yield strength
 * (residual strength, Phase 15).
 */
export function ensureSeismicRuntime(runtime: SimulationRuntime, terrain: TerrainSampler, gravity: number, interactions = false): SeismicRuntime {
  const sr = (runtime.seismic ??= buildSeismicRuntime(runtime, terrain, gravity));
  if (!sr.activated) {
    sr.activated = true;
    if (interactions) sr.units.forEach((e, ui) => sr.model.scaleStrength(ui, residualStrength(e, 'earthquake')));
  }
  return sr;
}

/**
 * Build the structural model before the clock starts (Phase 24 residual 2.1: the lazy build at the
 * first ground shock was part of the long simulation step at an impact). Nothing is activated —
 * see SeismicRuntime.activated — so the run is unchanged.
 */
export function prepareSeismicRuntime(runtime: SimulationRuntime, terrain: TerrainSampler, gravity: number): SeismicRuntime {
  return (runtime.seismic ??= buildSeismicRuntime(runtime, terrain, gravity));
}

/** Whether impact ground shocks, rather than an earthquake, govern an object's shaking (Phase 23). */
export const impactGovernsShaking = (st: SeismicEntityState | undefined) => !!st && st.pgaImpact > 0 && st.pgaImpact >= st.pgaQuake && !blastGovernsStructure(st);

/** Whether air-pressure waves, rather than ground motion, govern a structure's response (Phase 24). */
export const blastGovernsStructure = (st: SeismicEntityState | undefined) => !!st && st.pgaBlast > 0 && st.pgaBlast >= st.pgaQuake && st.pgaBlast >= st.pgaImpact;
