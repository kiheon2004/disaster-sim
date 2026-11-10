/**
 * Disaster library catalog and placement policies (Phase 35.5) — UI metadata of the implemented phenomena, kept apart from
 * their physics definitions:
 *
 *  - category, short description key, the field keys shown as "basic" (the rest go under "advanced");
 *  - placement: HOW a map click sets where an instance happens. Not every phenomenon is a point on the ground:
 *      ground   a point on the ground surface (blast centre, fire, sinkhole, vent, water inflow …)
 *      space    a point in space above the clicked ground (black hole, gravity source: the height is kept)
 *      area     the centre of an area (rain cell, climate cell, landslide source, local air removal)
 *      edge     the nearest map edge (rising water comes in from a boundary)
 *      epicentre the earthquake epicentre (map coordinates; the depth is kept)
 *      global   no position (map-wide wind, global gravity, map-wide climate …): added without a click
 *  - footprint: the radius drawn while placing. `reference: true` = a guide size, NOT the physical boundary of the effect
 *    (the effect is computed by the model, often reaching further); the UI labels it "reference range".
 *
 * Purely UI: nothing here is read by the simulation.
 */
import type { MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { BlastSpec } from '@/blast/types';
import type { ImpactSpec } from '@/impact/types';
import type { SinkholeSpec, LandslideSpec, GroundArea } from '@/ground/types';
import type { HeatSourceSpec } from '@/thermal/types';
import type { FireSpec } from '@/fire/types';
import type { VolcanoSpec } from '@/volcano/types';
import type { AtmosphereSpec } from '@/atmosphere/types';
import type { ClimateSpec } from '@/climate/types';
import type { GravitySpec } from '@/gravity/types';
import type { CelestialSpec } from '@/celestial/types';
import type { TornadoSpec } from '@/vortex/types';
import type { TerrainDeformationSpec } from '@/deformation/types';
import type { EarthquakeEventSpec, RainEventSpec, RisingWaterEventSpec, WaterSourceEventSpec } from '@/events/specs';
import type { BoundarySide } from '@/core/model';
import { areaCentroid } from '@/ground/common';

export type Category = 'weather' | 'geology' | 'hydrology' | 'fireHeat' | 'impactBlast' | 'spaceGravity' | 'atmosphere';
export const CATEGORIES: readonly Category[] = ['weather', 'geology', 'hydrology', 'fireHeat', 'impactBlast', 'spaceGravity', 'atmosphere'];

export type PlacementKind = 'ground' | 'space' | 'area' | 'edge' | 'epicentre' | 'global';

export interface Footprint {
  radius: number;
  /** A guide size, not the physical boundary of the effect. */
  reference: boolean;
  /** Short label of what the ring is (i18n key). */
  labelKey: MessageKey;
}

export interface PlacementPolicy {
  kind: PlacementKind;
  /** Where an instance is now (map x, z), or null (global / not placed). */
  get(spec: EventSpec): [number, number] | null;
  /** The spec moved to the clicked map point (x, z) (edge: the side nearest to it). */
  set(spec: EventSpec, p: [number, number], half: number): EventSpec;
  footprint(spec: EventSpec): Footprint | null;
}

export interface CatalogEntry {
  type: string;
  category: Category;
  /** One-line description (library card). */
  shortKey: MessageKey;
  /** Field keys of the basic settings (the others are advanced). Position fields are left out — placement sets them. */
  basic: string[];
  placement: PlacementPolicy;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const pt = (p: [number, number]): [number, number] => [r1(p[0]), r1(p[1])];

function moveArea(a: GroundArea, to: [number, number]): GroundArea {
  if (a.kind === 'circle') return { ...a, center: to };
  const [cx, cz] = areaCentroid(a);
  return { kind: 'polygon', points: a.points.map(([x, z]) => [r1(x + to[0] - cx), r1(z + to[1] - cz)] as [number, number]) };
}

/** Nearest map edge to a point of a square map of half-size `half`. */
export function nearestEdge(p: [number, number], half: number): BoundarySide {
  const d = { W: p[0] + half, E: half - p[0], N: p[1] + half, S: half - p[1] } as const;
  return (Object.keys(d) as BoundarySide[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/** Scaled distance of ~7 kPa peak overpressure (window glass breakage; Kingery–Bulmash, Z ≈ 18 m/kg^⅓) — a GUIDE ring. */
const blastGuide = (energy: number) => 18 * Math.cbrt(Math.max(energy, 1) / 4.184e6);

const global = (): PlacementPolicy => ({ kind: 'global', get: () => null, set: (s) => s, footprint: () => null });

export const CATALOG: Record<string, CatalogEntry> = {
  wind: { type: 'wind', category: 'weather', shortKey: 'lib.short.wind', basic: ['speed', 'direction', 'duration'], placement: global() },
  tornado: {
    type: 'tornado', category: 'weather', shortKey: 'lib.short.tornado', basic: ['maxSpeed', 'coreRadius', 'duration', 'trackSpeed'],
    placement: {
      kind: 'ground', get: (s) => (s as TornadoSpec).position, set: (s, p) => ({ ...(s as TornadoSpec), position: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: (s as TornadoSpec).outerRadius, reference: false, labelKey: 'lib.fp.vortex' }),
    },
  },
  rain: {
    type: 'rain', category: 'weather', shortKey: 'lib.short.rain', basic: ['intensity', 'duration'],
    placement: {
      kind: 'area', get: (s) => (s as RainEventSpec).area?.center ?? null,
      set: (s, p) => ({ ...(s as RainEventSpec), area: { center: pt(p), radius: (s as RainEventSpec).area?.radius ?? 30 } }) as EventSpec,
      footprint: (s) => ({ radius: (s as RainEventSpec).area?.radius ?? 30, reference: false, labelKey: 'lib.fp.rainArea' }),
    },
  },
  climate: {
    type: 'climate', category: 'weather', shortKey: 'lib.short.climate', basic: ['scenario', 'temperature', 'duration'],
    placement: {
      kind: 'area', get: (s) => (s as ClimateSpec).area?.center ?? null,
      set: (s, p) => ({ ...(s as ClimateSpec), area: { center: pt(p), radius: (s as ClimateSpec).area?.radius ?? 40 } }) as EventSpec,
      footprint: (s) => ((s as ClimateSpec).area ? { radius: (s as ClimateSpec).area!.radius, reference: false, labelKey: 'lib.fp.area' } : null),
    },
  },
  earthquake: {
    type: 'earthquake', category: 'geology', shortKey: 'lib.short.earthquake', basic: ['magnitude', 'pga', 'duration'],
    placement: {
      kind: 'epicentre', get: (s) => (s as EarthquakeEventSpec).epicenter ?? null,
      set: (s, p) => ({ ...(s as EarthquakeEventSpec), epicenter: pt(p) }) as EventSpec,
      footprint: () => ({ radius: 12, reference: true, labelKey: 'lib.fp.epicentre' }),
    },
  },
  sinkhole: {
    type: 'sinkhole', category: 'geology', shortKey: 'lib.short.sinkhole', basic: ['cavityRadius', 'cover', 'initiation'],
    placement: {
      kind: 'ground', get: (s) => (s as SinkholeSpec).center, set: (s, p) => ({ ...(s as SinkholeSpec), center: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: (s as SinkholeSpec).cavityRadius + (s as SinkholeSpec).cover, reference: true, labelKey: 'lib.fp.sinkhole' }),
    },
  },
  landslide: {
    type: 'landslide', category: 'geology', shortKey: 'lib.short.landslide', basic: ['trigger', 'duration'],
    placement: {
      kind: 'area', get: (s) => areaCentroid((s as LandslideSpec).area) as [number, number],
      set: (s, p) => ({ ...(s as LandslideSpec), area: moveArea((s as LandslideSpec).area, pt(p)) }) as EventSpec,
      footprint: (s) => { const a = (s as LandslideSpec).area; return { radius: a.kind === 'circle' ? a.radius : Math.max(...a.points.map(([x, z]) => Math.hypot(x - areaCentroid(a)[0], z - areaCentroid(a)[1]))), reference: false, labelKey: 'lib.fp.area' }; },
    },
  },
  terrainDeformation: {
    type: 'terrainDeformation', category: 'geology', shortKey: 'lib.short.terrainDeformation', basic: ['kind', 'radius', 'amount'],
    placement: {
      kind: 'ground', get: (s) => (s as TerrainDeformationSpec).center, set: (s, p) => ({ ...(s as TerrainDeformationSpec), center: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: (s as TerrainDeformationSpec).radius, reference: false, labelKey: 'lib.fp.area' }),
    },
  },
  volcano: {
    type: 'volcano', category: 'geology', shortKey: 'lib.short.volcano', basic: ['layout', 'rate', 'duration'],
    placement: {
      kind: 'ground', get: (s) => (s as VolcanoSpec).vents[0]?.position ?? null,
      set: (s, p) => {
        const v = s as VolcanoSpec, v0 = v.vents[0];
        if (!v0) return s;
        const q = pt(p), end = v0.end ? [q[0] + v0.end[0] - v0.position[0], q[1] + v0.end[1] - v0.position[1]] as [number, number] : undefined;
        return { ...v, vents: [{ ...v0, position: q, ...(end ? { end } : {}) }, ...v.vents.slice(1)] } as EventSpec;
      },
      footprint: () => ({ radius: 25, reference: true, labelKey: 'lib.fp.vent' }),
    },
  },
  risingWater: {
    type: 'risingWater', category: 'hydrology', shortKey: 'lib.short.risingWater', basic: ['level', 'riseRate', 'duration'],
    placement: { kind: 'edge', get: () => null, set: (s, p, half) => ({ ...(s as RisingWaterEventSpec), boundary: nearestEdge(p, half) }) as EventSpec, footprint: () => null },
  },
  waterSource: {
    type: 'waterSource', category: 'hydrology', shortKey: 'lib.short.waterSource', basic: ['rate', 'duration'],
    placement: {
      kind: 'ground', get: (s) => (s as WaterSourceEventSpec).position, set: (s, p) => ({ ...(s as WaterSourceEventSpec), position: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: (s as WaterSourceEventSpec).radius ?? 2, reference: false, labelKey: 'lib.fp.inflow' }),
    },
  },
  fire: {
    type: 'fire', category: 'fireHeat', shortKey: 'lib.short.fire', basic: ['radius', 'duration'],
    placement: {
      kind: 'ground', get: (s) => (s as FireSpec).position, set: (s, p) => ({ ...(s as FireSpec), position: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: (s as FireSpec).radius, reference: false, labelKey: 'lib.fp.ignition' }),
    },
  },
  heatSource: {
    type: 'heatSource', category: 'fireHeat', shortKey: 'lib.short.heatSource', basic: ['kind', 'power', 'duration'],
    placement: {
      kind: 'ground', get: (s) => (s as HeatSourceSpec).position, set: (s, p) => ({ ...(s as HeatSourceSpec), position: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: Math.max((s as HeatSourceSpec).radius, 5), reference: true, labelKey: 'lib.fp.heat' }),
    },
  },
  blast: {
    type: 'blast', category: 'impactBlast', shortKey: 'lib.short.blast', basic: ['energy', 'height'],
    placement: {
      kind: 'ground', get: (s) => (s as BlastSpec).position, set: (s, p) => ({ ...(s as BlastSpec), position: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: blastGuide((s as BlastSpec).energy), reference: true, labelKey: 'lib.fp.blast' }),
    },
  },
  impact: {
    type: 'impact', category: 'impactBlast', shortKey: 'lib.short.impact', basic: ['diameter', 'speed', 'angle'],
    placement: {
      kind: 'ground', get: (s) => (s as ImpactSpec).target, set: (s, p) => ({ ...(s as ImpactSpec), target: pt(p) }) as EventSpec,
      footprint: (s) => ({ radius: Math.max(5, 12 * (s as ImpactSpec).diameter), reference: true, labelKey: 'lib.fp.impact' }),
    },
  },
  gravity: {
    type: 'gravity', category: 'spaceGravity', shortKey: 'lib.short.gravity', basic: ['scenario', 'magnitude', 'duration'],
    placement: {
      kind: 'space', get: (s) => { const g = s as GravitySpec; return g.global || !g.sources[0] ? null : [g.sources[0].center[0], g.sources[0].center[2]]; },
      set: (s, p) => { const g = s as GravitySpec; if (g.global || !g.sources[0]) return s; const c = g.sources[0].center; return { ...g, sources: [{ ...g.sources[0], center: [r1(p[0]), c[1], r1(p[1])] }, ...g.sources.slice(1)] } as EventSpec; },
      footprint: () => ({ radius: 20, reference: true, labelKey: 'lib.fp.gravity' }),
    },
  },
  celestial: {
    type: 'celestial', category: 'spaceGravity', shortKey: 'lib.short.celestial', basic: ['scenario', 'duration'],
    placement: {
      kind: 'space', get: (s) => { const c = (s as CelestialSpec).sources[0]; return c ? [c.center[0], c.center[2]] : null; },
      set: (s, p) => { const c = s as CelestialSpec; const s0 = c.sources[0]; if (!s0) return s; return { ...c, sources: [{ ...s0, center: [r1(p[0]), s0.center[1], r1(p[1])] }, ...c.sources.slice(1)] } as EventSpec; },
      footprint: (s) => { const c = (s as CelestialSpec).sources[0]; return { radius: c && c.influence > 0 ? c.influence : 25, reference: !(c && c.influence > 0), labelKey: 'lib.fp.gravity' }; },
    },
  },
  atmosphere: {
    type: 'atmosphere', category: 'atmosphere', shortKey: 'lib.short.atmosphere', basic: ['removal', 'extent', 'duration'],
    placement: {
      kind: 'area', get: (s) => ((s as AtmosphereSpec).extent === 'local' ? (s as AtmosphereSpec).position ?? null : null),
      set: (s, p) => ((s as AtmosphereSpec).extent === 'local' ? ({ ...(s as AtmosphereSpec), position: pt(p) } as EventSpec) : s),
      footprint: (s) => ((s as AtmosphereSpec).extent === 'local' ? { radius: (s as AtmosphereSpec).radius ?? 30, reference: false, labelKey: 'lib.fp.area' } : null),
    },
  },
};

export function catalogOf(type: string): CatalogEntry | undefined {
  return CATALOG[type];
}

/** Whether a spec can be placed with a click right now (global wind, map-wide climate … cannot). */
export function placeable(type: string, spec: EventSpec): boolean {
  const c = CATALOG[type];
  if (!c || c.placement.kind === 'global') return false;
  if (c.placement.kind === 'edge') return true;
  if (type === 'gravity') return !(spec as GravitySpec).global && (spec as GravitySpec).sources.length > 0;
  if (type === 'atmosphere') return (spec as AtmosphereSpec).extent === 'local';
  return true;
}
