import type { Vec3 } from '@/core/types';
import { qRotate, vAdd, vDot, vScale } from '@/core/math';
import { buildingHeight, type BuildingParams } from '@/objects/definitions/building';
import type { SystemContext } from '../../systems/SimulationSystem';
import type { RuntimeComponent, RuntimeEntity } from '../../SimulationRuntime';
import { DamageState, worst } from '../DamageState';
import { applyFatigue, healthLevel, loadLevel } from '../fatigue';
import { componentWorldNormal, componentWorldPos, spawnDebris, spawnParticles } from '../spawn';
import { heightFactor } from '../windLoad';
import { createLocalWind, createSampleCache, type LocalWind } from '../../wind/SpatialWindField';
import type { DamageCause, DamageEventInput } from '../../analysis/DamageEvent';
import { seismicLevel, seismicHealth } from '../seismicLevels';
import { floodLevel } from '../floodLevels';

/** Reused sample result for facade parts (consumed immediately). */
const scratchWind = createLocalWind();

/** Brittle glass fails slightly earlier than ductile parts. */
const GLASS_BREAK = 1.5;
/**
 * Building codes design facade elements for the wind expected at their height, so upper
 * floors are stronger. We normalize most (not all) of the height effect: upper windows still
 * go first, but a tower does not lose every pane at once.
 */
const HEIGHT_DESIGN_EXPONENT = 0.8;

/**
 * Pressure factor relative to a windward wall (Cp ≈ 0.8).
 * Windward walls scale with incidence, side walls see edge suction, roofs see uplift.
 */
function pressureFactor(c: RuntimeComponent, normal: Vec3 | null, flow: Vec3): number {
  if (c.spec.kind === 'sign' || c.spec.kind === 'exterior' || !normal) return 1;
  if (c.spec.kind === 'roof') return 1.1;
  const facing = vDot(normal, [-flow[0], -flow[1], -flow[2]]); // >0 = faces into the wind (normal and flow are static per bearing → cached by the caller)
  let f = facing > 0.3 ? Math.max(0.5, facing) : facing < -0.3 ? 0.62 : 0.875;
  if (c.spec.kind === 'wall') f *= 1.2; // parapets catch accelerated flow over the roof edge
  return f;
}

/** Representative pressure factor for a part (used for the indicative force value). */
function pressureFactorFor(c: RuntimeComponent): number {
  return c.spec.kind === 'roof' ? 1.1 : 1;
}

/**
 * Facade parts are evaluated in staggered rounds (each part every N-th step with N×dt) — the
 * fatigue model is smooth enough that 20 Hz is plenty, and it keeps big scenes real-time.
 * The round is derived from the fixed-step counter, so the pattern is identical between runs.
 */
export const COMPONENT_ROUNDS = 3;

const LOG_MILESTONES = [1, 5, 10, 20, 40, 80, 160];

function countAndLog(e: RuntimeEntity, ctx: SystemContext, kind: string, key: 'log.building.window' | 'log.building.roof') {
  const n = (e.counters[kind] = (e.counters[kind] ?? 0) + 1);
  if (LOG_MILESTONES.includes(n)) ctx.log(e.id, 'info', { key, params: { n } });
}

interface FailInfo {
  lw: LocalWind;
  pos: Vec3;
  healthBefore: number;
  overload: boolean;
}

function failComponent(e: RuntimeEntity, c: RuntimeComponent, ctx: SystemContext, info: FailInfo) {
  const { lw, pos } = info;
  const speed = lw.speed;
  const flow: Vec3 = speed > 0.1 ? [lw.velocity[0] / speed, 0, lw.velocity[2] / speed] : ctx.env.wind.flow();
  const normal = componentWorldNormal(e, c.spec) ?? [0, 1, 0];
  const k = e.source.transform.scale;
  const size: Vec3 = [c.spec.size[0] * k[0], c.spec.size[1] * k[1], c.spec.size[2] * k[2]];
  c.health = 0;
  c.state = DamageState.DESTROYED;
  e.rev++;
  // Face area × dynamic pressure as an indicative load on the part.
  const face = Math.max(size[0] * size[1], size[1] * size[2], size[0] * size[2]);
  ctx.recordDamage(e, {
    eventType: c.spec.kind === 'window' ? 'BROKEN' : 'DETACHED',
    cause: info.overload ? 'overload' : 'fatigue',
    componentId: c.spec.id,
    componentKind: c.spec.kind,
    worldPosition: pos,
    localWindSpeed: speed,
    force: 0.5 * ctx.env.airDensity * speed * speed * face * pressureFactorFor(c),
    damageBefore: 1 - info.healthBefore,
    damageAfter: 1,
    shadowSource: lw.shadowSource,
  });

  if (c.spec.kind === 'window') {
    c.condition = 'broken';
    // Glass is pushed inward on the windward side and sucked outward elsewhere.
    const out = vDot(normal, flow) > 0 ? 1 : -0.6;
    spawnParticles(ctx, 'glass', pos, 10, vAdd(vScale(normal, 3 * out), vScale(flow, speed * 0.25)), 1.2, '#cfe6f7');
    countAndLog(e, ctx, 'window', 'log.building.window');
    return;
  }

  c.condition = 'detached';
  spawnDebris(ctx, e, {
    kind: c.spec.kind,
    position: pos,
    size,
    mass: c.spec.mass,
    color: c.spec.color ?? '#888',
    push: vAdd(vScale(flow, 0.8), vScale(normal, 0.6)),
  });
  switch (c.spec.kind) {
    case 'roof':
      countAndLog(e, ctx, 'roof', 'log.building.roof');
      break;
    case 'sign':
      ctx.log(e.id, 'warn', { key: 'log.building.sign' });
      break;
    case 'wall':
      ctx.log(e.id, 'warn', { key: 'log.building.wall' });
      break;
    case 'exterior':
      ctx.log(e.id, 'warn', { key: 'log.building.exterior' });
      break;
  }
}

/** Earthquake / flood collapse: debris falls along the building's response, not downwind. */
export interface QuakeCollapse {
  /** Horizontal unit direction the structure was swaying / leaning toward (flood: the flow). */
  dir: Vec3;
  /** Horizontal velocity of the top relative to the ground (m/s). */
  speed: number;
  cause: DamageCause;
  response: number;
  /** Default earthquake (Phase 13); 'flood' for lateral water load failures (Phase 14). */
  hazard?: 'earthquake' | 'flood';
  /** Extra fields for the damage record (flood: water depth, flow speed, load …). */
  extra?: Partial<DamageEventInput>;
}

/** Total structural failure: the building breaks into heavy chunks. */
export function collapse(e: RuntimeEntity, ctx: SystemContext, quake?: QuakeCollapse) {
  const { physics } = ctx;
  const p = e.source.params as BuildingParams;
  const k = e.source.transform.scale;
  e.flags.collapsed = true;
  if (e.body !== null) physics.removeBody(e.body);
  e.body = null;
  for (const c of e.components) if (c.condition === 'intact') c.condition = 'detached';
  const H = buildingHeight(p);
  const layers = Math.min(p.floors, 6);
  const structureMass = e.components.find((c) => c.spec.kind === 'structure')?.spec.mass ?? e.source.physics.mass;
  const flow = quake ? quake.dir : ctx.env.wind.flow();
  for (let ly = 0; ly < layers; ly++) {
    for (let ix = 0; ix < 2; ix++) {
      for (let iz = 0; iz < 2; iz++) {
        const local: Vec3 = [(-0.25 + ix * 0.5) * p.width * k[0], ((ly + 0.5) / layers) * H * k[1], (-0.25 + iz * 0.5) * p.depth * k[2]];
        spawnDebris(ctx, e, {
          kind: 'structure',
          position: vAdd(e.pose.position, qRotate(e.pose.quaternion, local)),
          size: [(p.width / 2) * k[0] * 0.97, (H / layers) * k[1] * 0.97, (p.depth / 2) * k[2] * 0.97],
          mass: Math.min(80000, structureMass / (layers * 4)),
          color: p.color,
          // Upper chunks topple farther; an earthquake also carries the sway velocity.
          push: quake ? vScale(flow, 0.3 + ly * 0.25 + (quake.speed * (ly + 1)) / layers) : vScale(flow, 0.4 + ly * 0.15),
          hazard: quake ? (quake.hazard ?? 'earthquake') : undefined,
        });
      }
    }
  }
  e.rev++;
  ctx.env.windField.removeObstacle(e.id);
  // The ruins no longer block the water (debris bodies still feel the flow).
  ctx.env.flood?.removeObstacle(e.id);
  if (quake) {
    const hazard = quake.hazard ?? 'earthquake';
    ctx.log(e.id, 'danger', { key: hazard === 'flood' ? 'log.flood.collapsed' : 'log.quake.collapsed' });
    ctx.recordDamage(e, { eventType: 'COLLAPSED', cause: quake.cause, hazard, response: quake.response, damageAfter: 1, ...quake.extra });
    return;
  }
  ctx.log(e.id, 'danger', { key: 'log.building.collapsed' });
  ctx.recordDamage(e, { eventType: 'COLLAPSED', cause: e.loadRatio >= e.source.physics.breakThreshold ? 'overload' : 'fatigue', damageAfter: 1 });
}

/** Count a facade part that failed outside updateBuilding (earthquake damage). */
export function noteFacadeFailure(e: RuntimeEntity) {
  facadeOf(e).failed++;
}

/** Per-building bookkeeping so a step only visits the facade parts that are due. */
interface FacadeIndex {
  structure: number;
  breakable: number;
  /** Parts no longer intact (kept up to date by updateBuilding). */
  failed: number;
  /** Per part: heightFactor(height above ground)^HEIGHT_DESIGN_EXPONENT (static: buildings never move). */
  design: Float64Array;
  /** Per part: pressure factor for `cpFlow` (only changes when the wind turns). */
  cp: Float64Array;
  cpFlow: Vec3 | null;
}
const facadeIndex = new WeakMap<RuntimeEntity, FacadeIndex>();

function facadeOf(e: RuntimeEntity): FacadeIndex {
  let f = facadeIndex.get(e);
  if (!f) {
    f = { structure: -1, breakable: 0, failed: 0, design: new Float64Array(e.components.length).fill(NaN), cp: new Float64Array(e.components.length), cpFlow: null };
    e.components.forEach((c, i) => {
      if (c.spec.kind === 'structure') f!.structure = i;
      else {
        f!.breakable++;
        if (c.condition !== 'intact') f!.failed++;
      }
    });
    facadeIndex.set(e, f);
  }
  return f;
}

export function updateBuilding(e: RuntimeEntity, ctx: SystemContext, dt: number) {
  if (e.flags.collapsed) {
    e.state = DamageState.DESTROYED;
    return;
  }
  const wind = ctx.env.wind;
  const field = ctx.env.windField;
  const flow = wind.flow();
  const calm = wind.baseSpeed <= 0.01;
  const index = facadeOf(e);
  const breakable = index.breakable;
  const structure: RuntimeComponent | undefined = e.components[index.structure];

  const comps = e.components;
  // flow() returns the same array until the bearing changes → recompute pressure factors then.
  const cpStale = index.cpFlow !== flow;
  if (cpStale) {
    index.cpFlow = flow;
    index.cp.fill(NaN);
  }
  if (calm) {
    for (let ci = 0; ci < comps.length; ci++) if (ci !== index.structure && comps[ci].condition === 'intact') comps[ci].loadRatio = 0;
  } else {
    // Only this round's parts (ascending order, as in a full pass).
    const cdt = dt * COMPONENT_ROUNDS;
    for (let ci = ctx.step % COMPONENT_ROUNDS; ci < comps.length; ci += COMPONENT_ROUNDS) {
      const c = comps[ci];
      if (ci === index.structure || c.condition !== 'intact') continue;
      // Buildings never move: cache each part's world position, normal and obstacle effect.
      const pos = (c.worldPos ??= componentWorldPos(e, c.spec));
      if (c.worldNormal === undefined) c.worldNormal = componentWorldNormal(e, c.spec);
      // Local wind at the part (neighbouring buildings' wakes / corners; never its own wake).
      const lw = field.sample(pos, ctx.time, e.id, (c.windCache ??= createSampleCache()), scratchWind);
      let design = index.design[ci];
      // Design wind of the part = profile at its height above the ground (same as the field).
      if (design !== design) design = index.design[ci] = Math.pow(heightFactor(pos[1] - ctx.env.terrain.sampleHeight(pos[0], pos[2])), HEIGHT_DESIGN_EXPONENT);
      const v = lw.speed / design;
      let cp = index.cp[ci];
      if (cp !== cp) cp = index.cp[ci] = pressureFactor(c, c.worldNormal, flow);
      c.loadRatio = (cp * v * v) / (c.spec.windResistance * c.spec.windResistance);
      const brk = c.spec.kind === 'window' ? GLASS_BREAK : e.source.physics.breakThreshold;
      const before = c.health;
      c.health = applyFatigue(c.health, c.loadRatio, c.spec.durability, brk, cdt);
      c.state = worst(loadLevel(c.loadRatio), healthLevel(c.health));
      if (c.health <= 0) {
        failComponent(e, c, ctx, { lw, pos, healthBefore: before, overload: c.loadRatio >= brk });
        index.failed++;
      }
    }
  }
  const failed = index.failed;

  // Main structure: uses the entity's own load ratio (sampled at its pressure center).
  if (structure) {
    structure.loadRatio = e.loadRatio;
    structure.health = applyFatigue(structure.health, e.loadRatio, e.source.physics.durability, e.source.physics.breakThreshold, dt);
    // Earthquake / flood damage (if any) and wind fatigue share one structural health.
    if (e.seismic) structure.health = Math.min(structure.health, seismicHealth(e.seismic));
    if (e.flood) structure.health = Math.min(structure.health, e.flood.health);
    e.health = structure.health;
    if (structure.health <= 0) {
      collapse(e, ctx);
      e.state = DamageState.DESTROYED;
      return;
    }
  }

  const frac = breakable ? failed / breakable : 0;
  let s = worst(loadLevel(e.loadRatio * 2.2), healthLevel(e.health)); // envelope "feels" stress earlier than the core
  if (failed > 0) s = worst(s, DamageState.DAMAGED);
  if (frac > 0.35) s = worst(s, DamageState.CRITICAL);
  if (e.seismic) s = worst(s, seismicLevel(e.seismic));
  if (e.flood) s = worst(s, floodLevel(e.flood));
  e.state = s;
}
