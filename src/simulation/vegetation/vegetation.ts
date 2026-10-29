/**
 * Vegetation responses (Phase 19) — both OPT-IN per project (Simulation settings), off by
 * default so every earlier project and the golden scenarios reproduce bit-identically.
 *
 * Canopy shelter (wind)
 *   Inside a forest the mean wind at crown height is lower than over open ground: the canopy
 *   absorbs momentum, and the flow adjusts over a few tree heights from the windward edge
 *   (wind-tunnel / LES studies of forest edges: adjustment over ~5–10 h; crown-top speeds deep
 *   in a forest ~40–60 % of an open site at the same height). Model: for each tree and each of
 *   16 wind directions, the canopy FETCH upwind (distance through crown cover to the forest
 *   edge, ≤ 60 m) gives the factor  1 − (1 − S) · (1 − e^(−fetch / 3h)),  S = 0.5, applied to
 *   the tree's local wind. Edge trees and solitary trees keep the full wind. Not applied to
 *   buildings or other objects (no "fewer trees = less wind" rule elsewhere).
 * Flood (trees)
 *   Overturning moment of the flow drag on the submerged trunk (and crown, if reached) against
 *   the root-plate capacity, taken as the base moment the tree carries at its design wind (the
 *   same capacity basis as poles / signs). Saturated ground (standing water ≥ 10 min) lowers it
 *   by 40 % — a LIMITED approximation: root reinforcement of soil is not modelled.
 */
import type { SimulationRuntime, RuntimeEntity } from '../SimulationRuntime';
import type { SystemContext } from '../systems/SimulationSystem';
import type { WaterField } from '../water/WaterField';
import { failByFlood } from '../damage/behaviors/structure';
import { applyFatigue } from '../damage/fatigue';
import { WATER_DENSITY } from '../water/waterParams';

export const CANOPY_DIRECTIONS = 16;
/** Deep-forest crown wind / open-ground wind at the same height. */
export const CANOPY_MIN = 0.5;
const CELL = 2;
const MAX_FETCH = 60;

/** Per-tree canopy factors for 16 wind (velocity) directions; written to e.canopy. */
export function computeCanopy(runtime: SimulationRuntime): number {
  const trees = [...runtime.entities.values()].filter((e) => e.source.type === 'tree');
  if (!trees.length) return 0;
  // Crown cover on a 2 m grid.
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const e of trees) {
    const p = e.initialPose.position;
    x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[2]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[2]);
  }
  x0 -= 10; z0 -= 10; x1 += 10; z1 += 10;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1;
  const cover = new Uint8Array(nx * nz);
  for (const e of trees) {
    const p = e.initialPose.position;
    const r = Math.max(1, Number(e.source.params.canopyRadius ?? 2) * e.source.transform.scale[0]);
    for (let iz = Math.floor((p[2] - r - z0) / CELL); iz <= Math.ceil((p[2] + r - z0) / CELL); iz++) {
      for (let ix = Math.floor((p[0] - r - x0) / CELL); ix <= Math.ceil((p[0] + r - x0) / CELL); ix++) {
        if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) continue;
        if (Math.hypot(x0 + ix * CELL - p[0], z0 + iz * CELL - p[2]) <= r + CELL * 0.5) cover[iz * nx + ix] = 1;
      }
    }
  }
  const covered = (x: number, z: number) => {
    const ix = Math.round((x - x0) / CELL), iz = Math.round((z - z0) / CELL);
    return ix >= 0 && iz >= 0 && ix < nx && iz < nz && cover[iz * nx + ix] === 1;
  };
  for (const e of trees) {
    const p = e.initialPose.position;
    const h = Math.max(2, e.dims[1]);
    const f = new Float32Array(CANOPY_DIRECTIONS);
    for (let k = 0; k < CANOPY_DIRECTIONS; k++) {
      const a = (k / CANOPY_DIRECTIONS) * Math.PI * 2;
      // Wind blowing along (cos a, sin a): walk UPWIND until the canopy ends.
      const ux = -Math.cos(a), uz = -Math.sin(a);
      // Start outside the tree's own crown (and its rasterization margin).
      const r0 = Math.max(1, Number(e.source.params.canopyRadius ?? 2) * e.source.transform.scale[0]) + 1.5 * CELL;
      let fetch = 0;
      for (let d = r0; d <= MAX_FETCH; d += CELL) {
        if (!covered(p[0] + ux * d, p[2] + uz * d)) break;
        fetch = d;
      }
      f[k] = 1 - (1 - CANOPY_MIN) * (1 - Math.exp(-fetch / (3 * h)));
    }
    e.canopy = f;
  }
  return trees.length;
}

/** Canopy factor for a horizontal wind velocity (1 without canopy data). */
export function canopyFactor(e: RuntimeEntity, vx: number, vz: number): number {
  const c = e.canopy;
  if (!c) return 1;
  const a = Math.atan2(vz, vx);
  const k = ((Math.round((a / (Math.PI * 2)) * CANOPY_DIRECTIONS) % CANOPY_DIRECTIONS) + CANOPY_DIRECTIONS) % CANOPY_DIRECTIONS;
  return c[k];
}

const AIR = 1.225;
/** Standing water this long saturates the root plate (s). */
const SATURATION_TIME = 600;

/** Flood response of a tree (opt-in; the default is exposure tracking only). */
export function updateTreeFlood(e: RuntimeEntity, ctx: SystemContext, field: WaterField, dt: number) {
  const st = e.flood!;
  if (e.flags.toppled || e.body === null) return;
  const p = e.initialPose.position;
  st.surface = field.sampleSurface(p[0], p[2]);
  st.depth = st.surface === -Infinity ? 0 : Math.max(0, st.surface - field.terrain.sampleHeight(p[0], p[2]));
  field.sampleVelocity(p[0], p[2], st.flow);
  st.speed = Math.hypot(st.flow[0], st.flow[1]);
  if (st.depth >= 0.05) st.exposure += dt;
  if (st.depth > st.peakDepth) st.peakDepth = st.depth;
  if (st.speed > st.peakSpeed) st.peakSpeed = st.speed;
  const H = e.dims[1];
  const trunk = Number(e.source.params.trunkRadius ?? 0.3) * 2 * e.source.transform.scale[0];
  const crownR = Number(e.source.params.canopyRadius ?? 2) * e.source.transform.scale[0];
  const crownBase = H - 2 * crownR;
  const d = Math.min(H, st.depth);
  // Drag on the submerged trunk (+ the crown part under water), lever arm d/2.
  const width = d > crownBase ? trunk + (2 * crownR) * Math.min(1, (d - crownBase) / (2 * crownR)) * 0.5 : trunk;
  const fd = 0.5 * WATER_DENSITY * 1.0 * width * d * st.speed * st.speed;
  const moment = fd * d * 0.5;
  // Root-plate capacity: the base moment at the tree's design wind (crown drag at the centre of pressure).
  const vDesign = e.source.physics.windResistance * e.strength;
  const saturated = st.exposure >= SATURATION_TIME ? 0.6 : 1;
  const design = 0.5 * AIR * e.source.physics.dragCoefficient * e.area * e.areaFactor * vDesign * vDesign * Math.max(0.5, e.copLocal[1]) * saturated;
  st.load = moment / Math.max(0.1, H / 2);
  st.loadRatio = design > 0 ? moment / design : 0;
  if (st.loadRatio > st.peakLoadRatio) st.peakLoadRatio = st.loadRatio;
  const before = st.health;
  st.health = Math.max(0.001, applyFatigue(st.health, st.loadRatio, e.source.physics.durability, e.source.physics.breakThreshold, dt));
  if (st.health <= 0.001 || st.loadRatio >= e.source.physics.breakThreshold) {
    st.health = 0.001;
    const dir: [number, number, number] = st.speed > 0.05 ? [st.flow[0] / st.speed, 0, st.flow[1] / st.speed] : [1, 0, 0];
    failByFlood(e, ctx, dir, st.loadRatio, 'hydrodynamic', { waterDepth: st.depth, flowSpeed: st.speed, exposure: st.exposure, force: st.load, damageBefore: 1 - before });
    ctx.log(e.id, 'danger', { key: saturated < 1 ? 'log.flood.treeUprooted' : 'log.flood.treeToppled' });
  }
}
