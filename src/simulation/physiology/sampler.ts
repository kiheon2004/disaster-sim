/**
 * Phase 34: the exposure sampler — what one person's body meets at time t, read (never written) from the environment
 * systems, with the provenance of every value. Points: the airway (mouth / nose: head axis at 0.90 H, 0.85 head radius
 * forward — an anthropometric approximation), the torso centre (representative point), the eight Phase 33 segments
 * (immersion). Resolution limits: the air layer is one well-mixed 5 m column 0–10 m high, rooms one node, the water
 * 1 m cells — a body part is never finer than that.
 *
 * Sources (HUMAN_PHYSIOLOGY.md §3, audit): air temperature — Phase 26 air column / room (only while the thermal model
 * runs), else the scene ambient setting (assumed); humidity — climate experiment, else the reference (assumed); pressure —
 * atmosphere experiment, else the reference (assumed); wind — local wind field minus the body velocity; mean radiant
 * temperature — climate sky / ground (else = air, assumed); directed radiation — thermal point / temperature sources with
 * their time profile, fire flames (point-source model, radiative fraction 0.35), sun (climate, unshaded); water — flood
 * field (surface, velocity) and the thermal water temperature, else the reference water temperature (assumed); contact —
 * ground thermal node / lava surface when lying; gases — fire O₂ (outdoor column / room), CO₂ from the fire's O₂ deficit
 * (1 mol CO₂ per mol O₂, cellulose stoichiometry), CO from the transported soot with a well-ventilated CO/soot yield
 * ratio, smoke = soot concentration; clean reference air (assumed) without a fire; zones override (boundary conditions).
 * Buried people: thermal sample at the location, airway unknown, gases unknown unless a confined zone holds them.
 */
import type { Vec3 } from '@/core/types';
import { esWater } from '@/climate/psychro';
import { sphereViewFactor } from '@/thermal/radiation';
import { shapeAt } from '@/thermal/profiles';
import { amplitude, radiativeFraction } from '@/thermal/sources';
import { SIGMA } from '@/thermal/units';
import type { Exposure } from '@/physiology/engine';
import { M_CO, R_GAS } from '@/physiology/gas';
import { P } from '@/physiology/params';
import { DEFAULT_REFERENCE, type PhysiologySettings } from '@/physiology/settings';
import { SURFACE_SHARE } from '@/physiology/thermal';
import { Y_O2_AIR } from '@/fire/materials';
import { SEGMENT_IDS } from '@/human/anthropometry';
import type { SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { blend, compartmentFractions, zoneAt, zoneWaterLevel, type Compartment } from './zones';

/** Well-ventilated CO / soot mass-yield ratio (wood: y_CO 0.004, y_s 0.015 — Tewarson, SFPE handbook) — Level B/C. */
export const CO_SOOT_RATIO = 0.004 / 0.015;
/** Radiative fraction assumed for fire flames (the flame view carries only the total heat-release rate). */
export const FLAME_CHI = 0.35;
const M_AIR = 0.028966, M_O2 = 0.031999;
const LYING = new Set(['prone', 'supine', 'sideLying', 'resting', 'incapacitated', 'landing']);

export type Provenance = Record<string, string>;

export interface Sample {
  exposure: Exposure;
  provenance: Provenance;
  /** Display values: air temperature at the torso (K), directed fire / source flux (W/m²), solar (W/m²), immersed share, airway point. */
  airT: number;
  qFire: number;
  qSolar: number;
  immersed: number;
  airway: Vec3;
  /** Confined compartment holding the person (index into the compartments) or −1. */
  compartment: number;
  buried: boolean;
}

function rot(q: readonly number[], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Air temperature (K) at a world point and its source. */
function airAt(ctx: SystemContext, p: Readonly<Vec3>, ambient: number): { T: number; src: string; column: number } {
  const trt = ctx.env.thermal.rt;
  if (!trt) return { T: ambient, src: 'scene.ambient', column: -1 };
  const room = trt.buildingContaining(p as Vec3);
  const w = trt.world;
  if (room) return { T: w.compT(room.comp), src: 'thermal.room', column: -1 };
  const h = p[1] - ctx.env.terrain.sampleHeight(p[0], p[2]);
  const a = w.air.index(p[0], p[2], Math.max(0, h));
  return { T: w.air.T(a), src: a >= 0 ? 'thermal.air' : 'thermal.above', column: a };
}

/** Directed radiant flux (W/m²) at a point from thermal sources (time profile) and fire flames. */
function directedFlux(ctx: SystemContext, p: Readonly<Vec3>, Tref: number): { q: number; n: number } {
  let q = 0, n = 0;
  for (const s of ctx.env.thermal.sources) {
    const spec = s.spec;
    const local = ctx.time - s.start;
    if (local < 0 || local > spec.duration || spec.profile === 'instant') continue;
    const [sx, sz] = spec.position;
    const sy = ctx.env.terrain.sampleHeight(sx, sz) + spec.height;
    const r = Math.max(0.3, Math.hypot(p[0] - sx, p[1] - sy, p[2] - sz));
    const shape = shapeAt(spec, local);
    if (spec.kind === 'point') {
      const add = (radiativeFraction(spec) * amplitude(spec) * shape) / (4 * Math.PI * r * r);
      if (add > 0) { q += add; n++; }
    } else if (spec.kind === 'temperature') {
      const T = Tref + ((spec.temperature ?? Tref) - Tref) * shape;
      const add = SIGMA * Math.max(0, T ** 4 - Tref ** 4) * sphereViewFactor(spec.radius, r);
      if (add > 0) { q += add; n++; }
    }
  }
  const frt = ctx.env.fire.rt;
  if (frt) for (const f of frt.flames) {
    if (!(f.Q > 0)) continue;
    const r = Math.max(0.5, Math.hypot(p[0] - f.x, p[1] - (f.y + f.L / 3), p[2] - f.z));
    q += (FLAME_CHI * f.Q) / (4 * Math.PI * r * r);
    n++;
  }
  return { q, n };
}

/** O₂ mass fraction → mole fraction; the rest is N₂ + Ar of air (M ≈ 28.16 g/mol), normalised so the fire model's clean air
 * (Y_O2_AIR) maps exactly to the reference O₂ fraction. */
const M_REST = (M_AIR - 0.2095 * M_O2) / 0.7905;
const moleRaw = (Y: number) => (Y / M_O2) / (Y / M_O2 + (1 - Y) / M_REST);
const o2Mole = (Y: number, ref: number) => (ref * moleRaw(Y)) / moleRaw(Y_O2_AIR);

export function sample(ctx: SystemContext, e: RuntimeEntity, cfg: PhysiologySettings, compartments: Map<number, Compartment>): Sample {
  const st = e.human!;
  const prov: Provenance = {};
  const t = ctx.time;
  const ref = { ...DEFAULT_REFERENCE, ...(cfg.reference ?? {}) };
  const q = e.pose.quaternion, pos = e.pose.position;
  const H = st.model.height;
  const head = st.model.segments[0];
  const airwayLocal: Vec3 = [0, 0.9 * H, 0.85 * head.radius];
  const ar = rot(q, airwayLocal);
  const airway: Vec3 = [ar[0] + pos[0], ar[1] + pos[1], ar[2] + pos[2]];
  const tl = rot(q, st.model.segments[2].centre);
  const torso: Vec3 = [tl[0] + pos[0], tl[1] + pos[1], tl[2] + pos[2]];
  const lying = !st.standing && LYING.has(st.posture);
  const buried = st.buried;
  // ── air temperature / humidity / pressure ──
  const ambient = ctx.env.thermal.rt?.world.Tref ?? (ctx.env.thermal.settings?.ambient ?? 288.15);
  const aT = airAt(ctx, torso, ambient);
  const wT = airAt(ctx, airway, ambient);
  prov.airT = aT.src;
  let Ta = aT.T, Tair = wT.T;
  const cw = ctx.env.climate.rt?.cw;
  let RH: number | undefined;
  if (cw && aT.column >= 0) { RH = Math.min(1, cw.rh(aT.column)); prov.humidity = 'climate'; } else { RH = ref.humidity; prov.humidity = 'reference'; }
  const art = ctx.env.atmosphere.rt;
  let p: number;
  if (art) { p = art.pressureAt(torso[0], torso[1], torso[2]); prov.pressure = 'atmosphere'; } else { p = ref.pressure; prov.pressure = 'reference'; }
  // ── wind relative to the body ──
  const vb = e.body ? ctx.physics.getLinearVelocity(e.body) : [0, 0, 0];
  const wv = e.localWind?.velocity ?? [0, 0, 0];
  let vAir = Math.hypot(wv[0] - vb[0], wv[1] - vb[1], wv[2] - vb[2]);
  prov.wind = (e.localWind?.speed ?? 0) > 0 ? 'windField' : 'stillAir';
  // ── radiation ──
  let Tr = Ta;
  prov.mrt = 'assumedAir';
  let qSolar = 0;
  if (cw) {
    Tr = cw.bodyTrad(lying ? 0.8 : 0.1, lying ? 0.2 : 0.9, Ta);
    prov.mrt = 'climate';
    const tw = ctx.env.thermal.rt?.world;
    const c = tw ? tw.terrain.index(torso[0], torso[2]) : -1;
    if (cw.sun.elevation > 0) {
      const shaded = c >= 0 && cw.shade[c] > 0;
      qSolar = (shaded ? 0 : cw.sun.direct) + 0.5 * cw.sun.diffuse;
      prov.solar = shaded ? 'climate.shaded' : 'climate.sun';
    }
  }
  const df = directedFlux(ctx, torso, ctx.env.thermal.rt?.world.Tref ?? ambient);
  const qFire = df.q;
  if (df.n) prov.radiant = 'sourcesAndFlames';
  // ── water ──
  const field = ctx.env.flood.field;
  let surface = field ? field.sampleSurface(pos[0], pos[2]) : -Infinity;
  let surfaceAirway = field ? field.sampleSurface(airway[0], airway[2]) : -Infinity;
  let Tw: number | undefined;
  let vWater = 0;
  if (field && surface > -Infinity) {
    prov.water = 'flood';
    const v = field.sampleVelocity(pos[0], pos[2], [0, 0]);
    vWater = Math.hypot(v[0] - vb[0], v[1] - vb[2]);
    const tw = ctx.env.thermal.rt?.world;
    if (tw && tw.water) { Tw = tw.waterT(tw.terrain.index(pos[0], pos[2])); prov.waterT = 'thermal.water'; }
  }
  // ── contact (lying) ──
  let Tsurf = NaN;
  if (lying) {
    const lava = ctx.env.volcano.rt?.vw?.field;
    const li = lava ? lava.index(torso[0], torso[2]) : -1;
    const tw = ctx.env.thermal.rt?.world;
    if (lava && li >= 0 && lava.depth(li) > 0) { Tsurf = lava.Ts[li]; prov.contact = 'lava'; }
    else if (tw) { Tsurf = tw.terrain.T(tw.terrain.index(torso[0], torso[2]), 0); prov.contact = 'thermal.ground'; }
    else prov.contact = 'unknown';
  }
  // ── gases ──
  let xO2: number | undefined = ref.o2, xCO2: number | undefined = ref.co2, xCO: number | undefined = 0, smoke: number | undefined = 0;
  prov.gas = 'reference';
  // CO / CO₂ separately: a fire run estimates them (CO from the soot, CO₂ from the O₂ deficit) — estimates, not transported species.
  prov.co = 'reference';
  prov.co2 = 'reference';
  const frt = ctx.env.fire.rt;
  if (frt) {
    const trt = ctx.env.thermal.rt;
    const room = trt?.buildingContaining(airway);
    const fw = frt.fw;
    let Y: number | undefined, soot: number | undefined;
    if (room) {
      const fr = fw.rooms.find((r) => r.tc === room.comp);
      if (fr && fr.gas > 0) { Y = fr.o2 / fr.gas; soot = fr.soot / fr.V; prov.gas = 'fire.room'; }
    } else if (trt) {
      const a = trt.world.air.index(airway[0], airway[2], Math.max(0, airway[1] - ctx.env.terrain.sampleHeight(airway[0], airway[2])));
      if (a >= 0) { Y = fw.outdoorY(a); soot = fw.soot[a] / (trt.world.air.H * trt.world.air.cellArea); prov.gas = 'fire.air'; }
    }
    if (Y !== undefined && soot !== undefined) {
      xO2 = o2Mole(Y, ref.o2);
      xCO2 = ref.co2 + Math.max(0, ref.o2 - xO2);
      smoke = soot;
      // CO mass concentration = soot × ratio → mole fraction x = c R T / (p M).
      xCO = (soot * CO_SOOT_RATIO * R_GAS * Tair) / (p * M_CO);
      prov.co = 'fire.sootRatio';
      prov.co2 = 'fire.o2Deficit';
    }
  }
  const vg = ctx.env.atmosphere.rt?.field.gas;
  if (vg && aT.column >= 0 && vg[aT.column] > 0) prov.volcanicGas = 'unspeciated';
  // ── zones (boundary conditions) and confined compartments ──
  let compartment = -1;
  const z = zoneAt(cfg.zones, torso, t);
  if (z) {
    const Z = z.zone, w = z.w;
    prov.zone = Z.id;
    if (Z.airTemperature !== undefined) { Ta = blend(Ta, Z.airTemperature, w)!; Tair = blend(Tair, Z.airTemperature, w)!; prov.airT = 'zone'; }
    if (Z.meanRadiantTemperature !== undefined) { Tr = blend(Tr, Z.meanRadiantTemperature, w)!; prov.mrt = 'zone'; } else if (Z.airTemperature !== undefined && prov.mrt === 'assumedAir') Tr = Ta;
    if (Z.humidity !== undefined) { RH = blend(RH, Z.humidity, w); prov.humidity = 'zone'; }
    if (Z.pressure !== undefined) { p = blend(p, Z.pressure, w)!; prov.pressure = 'zone'; }
    if (Z.wind !== undefined) { vAir = blend(vAir, Z.wind, w)!; prov.wind = 'zone'; }
    if (Z.o2 !== undefined) { xO2 = blend(xO2, Z.o2, w); prov.gas = 'zone'; }
    if (Z.co2 !== undefined) { xCO2 = blend(xCO2, Z.co2, w); prov.gas = 'zone'; prov.co2 = 'zone'; }
    if (Z.co !== undefined) { xCO = blend(xCO, Z.co, w); prov.gas = 'zone'; prov.co = 'zone'; }
    if (Z.smoke !== undefined) { smoke = blend(smoke, Z.smoke, w); prov.gas = 'zone'; }
    if (Z.surfaceTemperature !== undefined && lying) { Tsurf = Z.surfaceTemperature; prov.contact = 'zone'; }
    if (Z.water) {
      const lvl = zoneWaterLevel(Z, t)!;
      surface = Math.max(surface, lvl);
      surfaceAirway = Math.max(surfaceAirway, lvl);
      if (Z.water.temperature !== undefined) { Tw = Z.water.temperature; prov.waterT = 'zone'; }
      vWater = Z.water.speed ?? vWater;
      prov.water = 'zone';
    }
    if (Z.confined) {
      const c = compartments.get(z.index);
      if (c) { const f = compartmentFractions(c); xO2 = f.o2; xCO2 = f.co2; compartment = z.index; prov.gas = 'confined'; prov.co2 = 'confined'; }
    }
  }
  const qDirZone = z?.zone.radiantFlux !== undefined ? z.zone.radiantFlux * z.w : 0;
  if (qDirZone > 0) prov.radiant = prov.radiant ? `${prov.radiant}+zone` : 'zone';
  if (Tw === undefined) { Tw = ref.waterTemperature; if (surface > -Infinity) prov.waterT = 'reference'; }
  // ── immersed share from the segments (vertical extent of each segment against the surface) ──
  let fWater = 0;
  if (surface > -Infinity) {
    const ax = rot(q, [0, 1, 0]);
    const uy = Math.min(1, Math.abs(ax[1]));
    for (let k = 0; k < SEGMENT_IDS.length; k++) {
      const s = st.model.segments[k];
      const c = s.centre, x = q[0], y = q[1], zq = q[2], w = q[3];
      // y component of the rotated centre (quaternion rotation, y row only).
      const cy = pos[1] + 2 * (x * y + w * zq) * c[0] + (1 - 2 * (x * x + zq * zq)) * c[1] + 2 * (y * zq - w * x) * c[2];
      const hv = 0.5 * (s.y1 - s.y0) * uy + s.radius * Math.sqrt(Math.max(0, 1 - uy * uy)) + 1e-6;
      const frac = Math.min(1, Math.max(0, (surface - (cy - hv)) / (2 * hv)));
      fWater += SURFACE_SHARE[SEGMENT_IDS[k]] * frac;
    }
  }
  // ── buried: thermal at the location, airway and gases unknown (unless a confined zone) ──
  let airwaySubmerged: boolean | undefined = airway[1] < surfaceAirway;
  if (buried) {
    airwaySubmerged = undefined;
    prov.airway = 'buried';
    if (compartment < 0) { xO2 = xCO2 = xCO = smoke = undefined; prov.gas = prov.co = prov.co2 = 'buriedUnknown'; }
  } else prov.airway = surfaceAirway > -Infinity ? prov.water ?? 'flood' : 'noWater';
  const pa = RH !== undefined ? RH * esWater(Ta) : undefined;
  if (pa === undefined) prov.humidity = 'unknown';
  const exposure: Exposure = {
    thermal: {
      Ta, Tr, pa: pa ?? 0, vAir, qDir: qFire + qDirZone + qSolar,
      fWater, Tw, vWater, fContact: lying ? P.contactShareLying : 0, Tsurf, breathing: true,
    },
    qFire: qFire + qDirZone, p, xO2, xCO2, xCO, smoke, airwayT: Tair, airwaySubmerged, waterT: airwaySubmerged ? Tw : undefined,
    lying, physical: { incapacitated: st.incapacitated, mobility: st.mobility },
  };
  return { exposure, provenance: prov, airT: Ta, qFire: qFire + qDirZone, qSolar, immersed: fWater, airway, compartment, buried };
}
