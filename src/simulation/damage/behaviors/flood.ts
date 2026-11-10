/**
 * Flood damage criteria (Phase 14). Every effect is DEMAND vs. CAPACITY, accumulated over time —
 * there is no "depth ≥ X → destroyed" rule. All numbers are approximate model parameters.
 *
 * Buildings
 *   - inundation: water around the footprint; the interior fills (and drains) with a lag
 *     (doors / gaps; faster once windows are broken)
 *   - finishes & contents: depth–damage curve √(d_in / 6 m) approached over ~20 min of exposure
 *     (non-structural: at most DAMAGED)
 *   - envelope parts (windows, exterior units) under water: hydrostatic head difference + flow
 *     pressure vs. a capacity derived from the part's wind design (±35 % per part)
 *   - structure: lateral water load F = ½ρg(d_out² − d_in²)·B + ½ρ·C_d·v²·d_out·B against the
 *     lateral strength c_y·W of its structural system (the same c_y as the earthquake model);
 *     above 50 % of capacity damage accumulates, ≥ 1 → collapse. Heavy RC frames practically
 *     never reach it; a light house in deep, fast water can.
 * Vehicles  water above the floor floods the cabin (interior / electrics damage over minutes);
 *           floating and being carried come from the buoyancy / drag forces (WaterForceSystem)
 * People    stability: drag vs. friction (sliding) and vs. weight × foot lever (toppling), both
 *           with the weight reduced by buoyancy — comparable in spirit to published h·v
 *           stability thresholds (~0.6–1.2 m²/s for adults); NOT a safety prediction
 * Poles, signs  overturning moment of the flow on the submerged part vs. the base moment the
 *               object was designed to carry under its design wind
 * Walls     hydrostatic moment of the depth difference across the wall (ρg·Δ(d³)/6 per m) +
 *           flow vs. the wall's design wind moment — free-standing walls fail early
 * Roads     inundation (≥ 0.15 m / ≥ 0.3 m impassable) and surface scour in fast flow
 */
import type { Vec3 } from '@/core/types';
import { GRAVITY } from '@/core/units';
import { applyFatigue } from '../fatigue';
import { exposedFace, faceStage, setFaceStage } from '../../buildings/structureV2';
import { failMembers } from '../../buildings/modular';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeEntity } from '../../SimulationRuntime';
import type { WaterField } from '../../water/WaterField';
import { FLOOD_DEPTH, WATER_DENSITY } from '../../water/waterParams';
import type { FloodEntityState } from '../../flood/FloodState';
import { knockDown } from './human';
import { collapse, noteFacadeFailure } from './building';
import { failByFlood } from './structure';
import { componentWorldPos, spawnDebris } from '../spawn';
import { DamageState } from '../DamageState';
import { seismicOf, STRUCTURAL_SYSTEMS } from '../../seismic/structuralProps';
import { CAR_FLOOR } from '../../systems/WaterForceSystem';
import type { DamageCause } from '../../analysis/DamageEvent';
import { residualStrength } from '../../interactions/integrity';
import { modularFloodCapacity, openDoors } from '../../buildings/modular';
import { detachFacadeMember } from '../../structure/facade';

const RHO = WATER_DENSITY;
/** Scratch velocity (the per-object loops are synchronous). */
const vScratch: [number, number] = [0, 0];
const AIR = 1.225;

/** Interior fill time constant (s): closed envelope / with broken openings. */
const FILL_TAU = 600;
const FILL_TAU_OPEN = 90;
/** Finishes approach the depth–damage curve with this time constant (s). */
const FINISH_TAU = 1200;
/** Building drag coefficient (bluff body). */
const BUILDING_CD = 2;
/** Structural flood damage: onset (fraction of capacity) and rate (per s per unit over onset). */
const STRUCT_ONSET = 0.5;
const STRUCT_RATE = 0.02;
/** Ultimate / design pressure ratio of envelope parts. */
const ENVELOPE_SAFETY = 3;

/** Inundation levels (m): shallow, deep, very deep — per object type. */
const LEVELS: Record<string, [number, number, number]> = {
  building: [FLOOD_DEPTH, 0.5, 1.5],
  car: [FLOOD_DEPTH, CAR_FLOOR, 0.7],
  road: [0.15, 0.3, 1],
};

function flowDir(st: FloodEntityState): Vec3 {
  return st.speed > 0.05 ? [st.flow[0] / st.speed, 0, st.flow[1] / st.speed] : [1, 0, 0];
}

function trackPeaks(st: FloodEntityState, dt: number) {
  if (st.depth >= FLOOD_DEPTH) st.exposure += dt;
  if (st.depth > st.peakDepth) st.peakDepth = st.depth;
  if (st.speed > st.peakSpeed) st.peakSpeed = st.speed;
  if (st.loadRatio > st.peakLoadRatio) st.peakLoadRatio = st.loadRatio;
}

/** Record INUNDATED once per level crossed (shallow / deep / very deep). */
function recordLevels(e: RuntimeEntity, ctx: SystemContext, st: FloodEntityState, levels: [number, number, number], minLevel = 1) {
  let lv = 0;
  for (let k = 0; k < 3; k++) if (st.depth >= levels[k]) lv = k + 1;
  if (lv <= st.level) return;
  st.level = lv;
  if (lv < minLevel) return;
  ctx.recordDamage(e, { eventType: 'INUNDATED', cause: 'inundation', hazard: 'flood', localWindSpeed: e.localWind.speed, force: st.load, response: lv });
  if (lv >= 2) ctx.log(e.id, 'warn', { key: 'log.flood.inundated', params: { m: st.depth.toFixed(2) } });
}

/** Sample the water at a static point (base of an anchored object, a person who does not move). */
function samplePoint(field: WaterField, st: FloodEntityState, x: number, z: number) {
  st.surface = field.sampleSurface(x, z);
  st.depth = st.surface === -Infinity ? 0 : Math.max(0, st.surface - field.terrain.sampleHeight(x, z));
  field.sampleVelocity(x, z, st.flow);
  st.speed = Math.hypot(st.flow[0], st.flow[1]);
}

/** Max / mean water around (or along) an object from its sample points. */
function samplePoints(field: WaterField, st: FloodEntityState, pts: Float64Array, from = 0, to = pts.length) {
  let max = 0;
  let sum = 0;
  let n = 0;
  let eta = -Infinity;
  let speed = 0;
  let fx = 0;
  let fz = 0;
  const v = vScratch;
  for (let i = from; i < to; i += 2) {
    const x = pts[i];
    const z = pts[i + 1];
    const s = field.sampleSurface(x, z);
    n++;
    if (s === -Infinity) continue;
    const d = Math.max(0, s - field.terrain.sampleHeight(x, z));
    sum += d;
    if (d > max) {
      max = d;
      eta = s;
    }
    if (d > 0.02) {
      field.sampleVelocity(x, z, v);
      const sp = Math.hypot(v[0], v[1]);
      if (sp > speed) {
        speed = sp;
        fx = v[0];
        fz = v[1];
      }
    }
  }
  st.depth = max;
  st.meanDepth = n ? sum / n : 0;
  st.surface = eta;
  st.speed = speed;
  st.flow[0] = fx;
  st.flow[1] = fz;
}

// ── Buildings ─────────────────────────────────────────────

export function updateBuildingFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  if (e.flags.collapsed) return;
  const st = e.flood!;
  samplePoints(field, st, st.points!);
  const floor = e.initialPose.position[1];
  // Interior water above the floor follows the outside surface with a lag.
  const outside = st.surface === -Infinity ? 0 : Math.max(0, st.surface - floor);
  let openings = 0;
  for (const c of e.components) if (c.spec.kind === 'window' && c.condition !== 'intact' && c.worldPos && c.worldPos[1] < floor + 3) openings++;
  // Modular buildings (Phase 17): a door forced open by the water is an opening too.
  const modular = e.modular !== undefined ? modularFloodCapacity(e, st.exposure, st.speed) : null;
  if (modular) openings += openDoors(e);
  const tau = openings > 0 ? FILL_TAU_OPEN : FILL_TAU;
  st.inside += (outside - st.inside) * Math.min(1, dt / tau);
  if (st.inside < 1e-4) st.inside = 0;

  // Finishes / contents: depth–damage curve approached over the exposure time (never recovers).
  if (st.inside > 0.02) {
    // Modular buildings: timber / light walls suffer more than concrete (material water sensitivity).
    const target = Math.min(1, Math.sqrt(st.inside / 6) * (modular ? modular.finish : 1));
    if (target > st.finish) st.finish += (target - st.finish) * Math.min(1, dt / FINISH_TAU);
  }

  // Lateral load on the structure vs. its lateral strength.
  const k = e.source.transform.scale;
  const B = Math.max(e.dims[0], e.dims[2]);
  const d = st.depth;
  const di = Math.min(d, st.inside);
  // Phase 31: hydrostatic thrust under the local downward gravity; the lateral CAPACITY below stays at Earth gravity (design).
  const gd = ctx.env.gravity.down(e.pose.position[0], e.pose.position[1], e.pose.position[2], GRAVITY);
  const fh = 0.5 * RHO * gd * (d * d - di * di) * B;
  const fd = 0.5 * RHO * BUILDING_CD * st.speed * st.speed * d * B;
  st.load = fh + fd;
  const seismic = seismicOf(e.source);
  const cy = seismic ? STRUCTURAL_SYSTEMS[seismic.structure.system].cy * seismic.structure.strengthFactor : 0.25;
  // Residual strength (Phase 15): earthquake / wind damage lowers the lateral capacity.
  // Modular buildings: the ground story's member-based lateral capacity (wet materials, scour).
  const base = modular ? modular.capacity : cy * e.source.physics.mass * GRAVITY * Math.max(0.2, k[1]);
  const capacity = base * (ctx.interactions ? residualStrength(e, 'flood') : 1);
  st.loadRatio = capacity > 0 ? st.load / capacity : 0;
  if (st.loadRatio > STRUCT_ONSET) st.damage += STRUCT_RATE * ((st.loadRatio - STRUCT_ONSET) / STRUCT_ONSET) * dt * (st.loadRatio >= 1.5 ? 10 : 1);
  trackPeaks(st, dt);
  recordLevels(e, ctx, st, LEVELS.building);

  const cause: DamageCause = fh >= fd ? 'hydrostatic' : 'hydrodynamic';
  // Phase 35.5 (structure v2): the water load acts on the members facing the flow — first the face's walls and openings
  // fail (water breaks in: the pressure inside equalizes), then its frame columns; the collapse engine does the rest.
  // Only a third overload collapses the whole building (the Phase 25 path below).
  if (st.damage >= 1 && e.modular && ctx.runtime.structureV2 && faceStage(e.modular, 'flood') < 2) {
    const stage = faceStage(e.modular, 'flood') + 1;
    setFaceStage(e.modular, 'flood', stage);
    const dir = flowDir(st);
    const list = exposedFace(e, dir, stage === 1 ? 'envelope' : 'frame');
    if (list.length) failMembers(e, ctx, list, { hazard: 'flood', cause, response: st.loadRatio, dir });
    if (stage === 1) st.inside = Math.max(st.inside, 0.9 * d);
    st.damage = 0.5;
  }
  if (st.damage >= 1) {
    st.health = 0.001;
    const dir = flowDir(st);
    collapse(e, ctx, {
      dir, speed: Math.min(1.5, st.speed * 0.4), cause, response: st.loadRatio, hazard: 'flood',
      extra: { waterDepth: d, flowSpeed: st.speed, exposure: st.exposure, force: st.load },
    });
    e.state = DamageState.DESTROYED;
    return;
  }
  st.health = Math.max(0.001, Math.min(1 - 0.5 * st.finish, 1 - st.damage));

  if (st.surface !== -Infinity && st.depth > 0.05) envelopeParts(e, ctx, st, floor);
}

/** Windows / exterior units below the water surface (hydrostatic head difference + flow). */
function envelopeParts(e: RuntimeEntity, ctx: SystemContext, st: FloodEntityState, floor: number) {
  const insideSurface = floor + st.inside;
  const dyn = 0.5 * RHO * st.speed * st.speed;
  for (let i = 0; i < e.components.length; i++) {
    const c = e.components[i];
    // (Doors and cladding panels exist on modular buildings only, Phase 17.)
    if (c.condition !== 'intact' || (c.spec.kind !== 'window' && c.spec.kind !== 'exterior' && c.spec.kind !== 'door' && c.spec.kind !== 'cladding')) continue;
    const pos = (c.worldPos ??= componentWorldPos(e, c.spec));
    const head = st.surface - pos[1];
    if (head <= 0) continue;
    const back = Math.max(0, insideSurface - pos[1]);
    const p = RHO * ctx.env.gravity.down(pos[0], pos[1], pos[2], GRAVITY) * Math.max(0, head - back) + dyn;
    const cap = 0.5 * AIR * c.spec.windResistance * c.spec.windResistance * ENVELOPE_SAFETY * (st.scatter ? st.scatter[i] : 1);
    if (p < cap) continue;
    c.health = 0;
    c.state = DamageState.DESTROYED;
    e.rev++;
    noteFacadeFailure(e);
    const k = e.source.transform.scale;
    const size: Vec3 = [c.spec.size[0] * k[0], c.spec.size[1] * k[1], c.spec.size[2] * k[2]];
    const face = Math.max(size[0] * size[1], size[1] * size[2], size[0] * size[2]);
    ctx.recordDamage(e, {
      eventType: c.spec.kind === 'window' ? 'BROKEN' : 'DETACHED', cause: dyn > p - dyn ? 'hydrodynamic' : 'hydrostatic', hazard: 'flood',
      componentId: c.spec.id, componentKind: c.spec.kind, worldPosition: pos, localWindSpeed: 0, force: p * face,
      damageBefore: 0, damageAfter: 1, response: p / cap,
    });
    if (c.spec.kind === 'window') {
      c.condition = 'broken';
      detachFacadeMember(ctx, e, c, 'flood', null);
      if (!e.counters.floodWindowLogged) {
        e.counters.floodWindowLogged = 1;
        ctx.log(e.id, 'warn', { key: 'log.flood.windows' });
      }
    } else {
      c.condition = 'detached';
      // Modular buildings (Phase 25): the member's own mass, no push (the water drag acts on it).
      if (!detachFacadeMember(ctx, e, c, 'flood', null)) spawnDebris(ctx, e, { kind: c.spec.kind, position: pos, size, mass: c.spec.mass, color: c.spec.color ?? '#999', push: [st.flow[0] * 0.3, 0.1, st.flow[1] * 0.3], hazard: 'flood' });
    }
  }
}

// ── Vehicles ──────────────────────────────────────────────

export function updateCarFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  const st = e.flood!;
  if (!e.dynamic) samplePoint(field, st, e.pose.position[0], e.pose.position[2]);
  // Interior / electrics: water above the floor damages over minutes, faster when deeper.
  const above = st.depth - CAR_FLOOR;
  if (above > 0) st.health = Math.max(0.001, st.health - (dt / 400) * Math.min(3, 0.5 + above / 0.25));
  st.loadRatio = st.buoyancyRatio;
  trackPeaks(st, dt);
  recordLevels(e, ctx, st, LEVELS.car, 2);
  // Lifted off the ground by the water (not just "the depth reached X").
  if (!st.floated && st.buoyancyRatio >= 1 && e.pose.position[1] - field.terrain.sampleHeight(e.pose.position[0], e.pose.position[2]) > 0.08) {
    st.floated = true;
    e.rev++;
    ctx.log(e.id, 'danger', { key: 'log.flood.floated' });
    ctx.recordDamage(e, { eventType: 'FLOATED', cause: 'buoyancy', hazard: 'flood', localWindSpeed: e.localWind.speed, force: st.buoyancy, response: st.buoyancyRatio });
  }
}

// ── People ────────────────────────────────────────────────

/** Foot lever (m) and friction of a person on wet ground. */
const FOOT_LEVER = 0.15;
const PERSON_MU = 0.5;
const PERSON_CD = 1.1;

/** Stability ratio of a standing person in flowing water (≥ 1 = falls). Exported for tests. */
export function personStability(mass: number, height: number, width: number, depth: number, speed: number, buoyancy: number, gripFactor = 1, g = GRAVITY): number {
  if (depth <= 0.02) return 0;
  const d = Math.min(depth, height);
  const fd = 0.5 * RHO * PERSON_CD * width * d * speed * speed;
  // Weight under the local gravity (Phase 31): a lighter person in Moon-like gravity is swept away by weaker flow.
  const net = Math.max(1, mass * g - buoyancy);
  const slide = fd / (PERSON_MU * gripFactor * net);
  const tip = (fd * d * 0.5) / (net * FOOT_LEVER);
  return Math.max(slide, tip);
}

export function updatePersonFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  const st = e.flood!;
  if (!e.dynamic) samplePoint(field, st, e.pose.position[0], e.pose.position[2]);
  trackPeaks(st, dt);
  if (e.flags.fallen) {
    st.loadRatio = 0;
    return;
  }
  const r = personStability(e.source.physics.mass, e.dims[1], e.dims[0] * e.areaFactor, st.depth, st.speed, st.buoyancy, e.groundFriction, ctx.env.gravity.down(e.pose.position[0], e.pose.position[1], e.pose.position[2], GRAVITY));
  st.loadRatio = r;
  if (r >= 1) st.balance = 0;
  else if (r > 0.6) st.balance -= ((r - 0.6) / 0.4) * (dt / 6);
  else st.balance = Math.min(1, st.balance + dt * 0.05);
  if (st.balance <= 0 && e.dynamic) {
    const dir = flowDir(st);
    knockDown(e, ctx, 'flood', undefined, [dir[0], 0, dir[2]]);
  }
}

// ── Poles, signs, walls ───────────────────────────────────

export function updateInfraFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  if (e.flags.toppled || e.flags.collapsed || e.body === null) return;
  const st = e.flood!;
  const p = e.initialPose.position;
  const H = e.dims[1];
  const windDesign = e.source.physics.windResistance * e.strength;
  let moment: number;
  let design: number;
  let cause: DamageCause = 'hydrodynamic';
  if (e.source.type === 'wall') {
    // Depth on each side of the wall (two rows of sample points).
    const pts = st.points!;
    const half = pts.length / 2;
    samplePoints(field, st, pts, 0, half);
    const d1 = st.depth;
    const s1 = st.speed;
    const f1: [number, number] = [st.flow[0], st.flow[1]];
    const eta1 = st.surface;
    samplePoints(field, st, pts, half);
    const d2 = st.depth;
    const L = e.dims[0];
    const dHi = Math.min(H, Math.max(d1, d2));
    const dLo = Math.min(H, Math.min(d1, d2));
    const hydro = (RHO * ctx.env.gravity.down(e.pose.position[0], e.pose.position[1], e.pose.position[2], GRAVITY) * (dHi ** 3 - dLo ** 3) * L) / 6;
    // Flow component across the wall.
    const fx = d1 >= d2 ? f1[0] : st.flow[0];
    const fz = d1 >= d2 ? f1[1] : st.flow[1];
    const vn = Math.abs(fx * st.normal[0] + fz * st.normal[1]);
    const drag = 0.5 * RHO * 1.2 * vn * vn * dHi * L * (dHi / 2);
    moment = hydro + drag;
    cause = hydro >= drag ? 'hydrostatic' : 'hydrodynamic';
    design = 0.5 * AIR * e.source.physics.dragCoefficient * L * H * windDesign * windDesign * (H / 2);
    st.depth = Math.max(d1, d2);
    st.speed = Math.max(s1, st.speed);
    if (d1 > d2) {
      st.surface = eta1;
      st.flow[0] = f1[0];
      st.flow[1] = f1[1];
    }
    // Push direction: from the deep side toward the shallow side.
    st.flow[0] = st.normal[0] * (d1 >= d2 ? -1 : 1) * Math.max(0.1, st.speed);
    st.flow[1] = st.normal[1] * (d1 >= d2 ? -1 : 1) * Math.max(0.1, st.speed);
  } else {
    samplePoint(field, st, p[0], p[2]);
    const d = Math.min(H, st.depth);
    const width = Math.min(e.dims[0], e.dims[2]);
    const fd = 0.5 * RHO * 1.2 * width * d * st.speed * st.speed;
    moment = fd * d * 0.5;
    design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * windDesign * windDesign * Math.max(0.5, e.copLocal[1]);
  }
  if (ctx.interactions) design *= residualStrength(e, 'flood');
  st.load = moment / Math.max(0.1, H / 2);
  st.loadRatio = design > 0 ? moment / design : 0;
  trackPeaks(st, dt);
  const before = st.health;
  st.health = Math.max(0.001, applyFatigue(st.health, st.loadRatio, e.source.physics.durability, e.source.physics.breakThreshold, dt));
  if (st.health <= 0.001 || st.loadRatio >= e.source.physics.breakThreshold) {
    st.health = 0.001;
    const dir = flowDir(st);
    failByFlood(e, ctx, dir, st.loadRatio, cause, { waterDepth: st.depth, flowSpeed: st.speed, exposure: st.exposure, force: st.load, damageBefore: 1 - before });
    ctx.log(e.id, 'danger', { key: 'log.flood.structureFailed' });
  }
}

// ── Roads ─────────────────────────────────────────────────

export function updateRoadFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  const st = e.flood!;
  samplePoints(field, st, st.points!);
  trackPeaks(st, dt);
  recordLevels(e, ctx, st, LEVELS.road);
  // Scour: sustained flow above ~2 m/s erodes the surface (approximate).
  if (st.speed > 2 && st.depth > 0.05 && st.scour < 1) {
    st.scour += ((st.speed / 2) ** 2 - 1) * (dt / 300);
    if (st.scour >= 1) {
      st.health = 0.6;
      ctx.recordDamage(e, { eventType: 'SCOURED', cause: 'scour', hazard: 'flood', localWindSpeed: 0, damageAfter: 0.4, response: st.speed });
      ctx.log(e.id, 'warn', { key: 'log.flood.scoured' });
    }
  }
}

export function updateExposureOnly(e: RuntimeEntity, field: WaterField, dt: number) {
  const st = e.flood!;
  const p = e.dynamic ? e.pose.position : e.initialPose.position;
  if (!e.dynamic || st.surface === -Infinity) samplePoint(field, st, p[0], p[2]);
  trackPeaks(st, dt);
}
