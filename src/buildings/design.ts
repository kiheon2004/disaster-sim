/**
 * Design ↔ world object (Phase 17): create a design from a spec, and derive the fields every
 * existing system reads (params, physics, seismic, components) from it — the explicit adapter
 * between the component-based building and the Phase 0–16 building model.
 *
 *  params      bounding box (width / depth from the members, floors, mean floor height so that
 *              floors × floorHeight = structure height), color, sign, rooftop units, roofHeight
 *  physics     mass = analysis total mass; windResistance from the weakest story's lateral
 *              capacity (see windResistanceFor); durability from the dominant material's failure
 *  seismic     structural system of the dominant lateral material + spec foundation type
 *  components  facade parts (windows, doors, cladding, roof covering, parapets, rooftop units,
 *              sign) for the existing wind / earthquake / flood facade logic, ids = member ids
 */
import type { Vec3 } from '@/core/types';
import type { ComponentKind, ComponentSpec, ObjectParams, PhysicalProperties, SeismicProperties, WorldObject } from '@/core/model';
import { AIR_DENSITY, GRAVITY, WIND_FORCE_SCALE } from '@/core/units';
import { seededRandom, hashString } from '@/core/math';
import { defaultFoundation, defaultStructure } from '@/simulation/seismic/structuralProps';
import { analyzeBuilding, type BuildingAnalysis } from './analysis';
import { facadeNormal, generateMembers, PARAPET, totalHeight } from './generate';
import { memberBounds, rotateEuler } from './geometry';
import { material, MATERIALS } from './materials';
import { defaultOptions, DESIGN_VERSION, type BuildingDesign, type BuildingMember, type BuildingSpec } from './types';

/**
 * Analysis of an (unscaled, undamaged) design, cached per design object — designs are immutable
 * values inside the world document (every edit makes a new one).
 */
const cache = new WeakMap<BuildingDesign, BuildingAnalysis>();
export function analysisOf(design: BuildingDesign): BuildingAnalysis {
  let a = cache.get(design);
  if (!a) cache.set(design, (a = analyzeBuilding(design)));
  return a;
}

/** New design from a (validated) spec. */
export function createDesign(spec: BuildingSpec, preset?: string): BuildingDesign {
  const { members } = generateMembers(spec);
  const d: BuildingDesign = { version: DESIGN_VERSION, spec: structuredClone(spec), members, options: defaultOptions(), edits: 0 };
  if (preset) d.preset = preset;
  return d;
}

/** Regenerate members from a new spec (manual member edits are replaced — callers warn first). */
export function regenerate(design: BuildingDesign, spec: BuildingSpec): BuildingDesign {
  const next = createDesign(spec, design.preset);
  next.options = { ...design.options };
  if (design.convertedFrom) next.convertedFrom = design.convertedFrom;
  return next;
}

const DRAG = 1.3;
const BREAK = 1.5;

/** Above-ground bounding box of the members (symmetric about the origin like legacy buildings). */
export function designExtent(design: BuildingDesign): { width: number; depth: number; height: number; roofHeight: number } {
  let hx = 0, hz = 0, top = 0, struct = 0;
  for (const m of design.members) {
    if (m.level < 0) continue;
    const b = memberBounds(m);
    hx = Math.max(hx, Math.abs(b.min[0]), Math.abs(b.max[0]));
    hz = Math.max(hz, Math.abs(b.min[2]), Math.abs(b.max[2]));
    top = Math.max(top, b.max[1]);
    if (m.type !== 'roof' && m.level < design.spec.floors) struct = Math.max(struct, b.max[1]);
  }
  const height = struct > 0 ? struct : totalHeight(design.spec);
  return { width: Math.max(1, 2 * hx), depth: Math.max(1, 2 * hz), height, roofHeight: Math.max(0, top - height) };
}

/** Legacy-compatible params (BuildingParams + roofHeight). */
export function designParams(design: BuildingDesign): ObjectParams {
  const e = designExtent(design);
  const floors = Math.max(1, design.spec.floors);
  return {
    floors,
    width: round(e.width),
    depth: round(e.depth),
    floorHeight: round(e.height / floors, 4),
    color: design.spec.color,
    sign: design.spec.sign,
    rooftopUnits: design.spec.rooftopUnits,
    roofHeight: round(Math.max(design.spec.roof === 'flat' ? 0 : 0.1, e.roofHeight), 3),
  };
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Wind design speed (m/s) consistent with the lateral capacity: the speed at the center of
 * pressure at which ½ρ·Cd·A·v² (× the global wind force scale) equals the weakest-story base
 * shear capacity, divided by √breakThreshold (load ratio 1 = design, failure at 1.5).
 */
export function windResistanceFor(a: BuildingAnalysis, faceX: number, faceZ: number): number {
  const W = a.totalMass * GRAVITY;
  // Wind along x loads the face across x (depth × height), resisted by the x-direction members.
  const v = (cy: number, face: number) => Math.sqrt((2 * cy * W) / (AIR_DENSITY * DRAG * Math.max(1, face) * WIND_FORCE_SCALE));
  const vMin = Math.min(v(a.cyX, faceX), v(a.cyZ, faceZ));
  return Math.round(Math.min(150, Math.max(12, vMin / Math.sqrt(BREAK))));
}

export function designPhysics(design: BuildingDesign, a: BuildingAnalysis = analysisOf(design)): PhysicalProperties {
  const e = designExtent(design);
  const H = e.height + e.roofHeight * 0.5;
  const fail = MATERIALS[a.material].failure;
  return {
    mass: Math.max(100, Math.round(a.totalMass)),
    friction: 0.8,
    restitution: 0.05,
    anchored: true,
    dragCoefficient: DRAG,
    windResistance: windResistanceFor(a, e.depth * H, e.width * H),
    durability: fail === 'ductile' ? 100 : fail === 'semiDuctile' ? 80 : 55,
    breakThreshold: BREAK,
  };
}

export function designSeismic(design: BuildingDesign, a: BuildingAnalysis, current?: SeismicProperties): SeismicProperties {
  const structure = { ...defaultStructure(a.system), dampingRatio: round(a.damping, 4) };
  const foundation = defaultFoundation(design.spec.foundation);
  // User factors on top of the member-based model are kept (inspector "advanced" fields).
  if (current) {
    structure.stiffnessFactor = current.structure.stiffnessFactor;
    structure.strengthFactor = current.structure.strengthFactor;
    structure.periodOverride = current.structure.periodOverride;
    if (current.foundation.type === foundation.type) Object.assign(foundation, current.foundation);
  }
  return { structure, foundation };
}

/** Facade component kind of a member (null = drawn / analyzed as a structural member only). */
export function componentKindOf(m: BuildingMember, floors: number): ComponentKind | null {
  switch (m.type) {
    case 'window': return 'window';
    case 'door': return 'door';
    case 'roof': return 'roof';
    case 'wall':
      if (m.role === 'cladding') return m.level >= floors && m.id.startsWith('pp-') ? 'wall' : 'cladding';
      return null;
    default: return null;
  }
}

/**
 * Design wind speed (m/s) of a facade panel: pressure at load ratio 1 ↔ ½ρ·v²·Cp(0.8).
 * Panels are designed for their pressure whatever their size (thicker glass for bigger panes),
 * so the area does not enter.
 */
function panelWind(pressure: number): number {
  return Math.sqrt((2 * pressure) / (AIR_DENSITY * 0.8));
}

/** Facade components derived from the members (+ rooftop units / sign like legacy buildings). */
export function designComponents(design: BuildingDesign, seed: number, a: BuildingAnalysis = analysisOf(design)): ComponentSpec[] {
  const rnd = seededRandom((seed ^ 0x2c1b3c6d) >>> 0);
  const vary = (base: number, pct: number, id: string) => base * (1 + (seededRandom((seed ^ hashString(`wind:${id}`)) >>> 0)() * 2 - 1) * pct);
  const e = designExtent(design);
  const floors = design.spec.floors;
  const out: ComponentSpec[] = [
    {
      id: 'structure', kind: 'structure', position: [0, e.height / 2, 0], size: [e.width, e.height, e.depth], normal: null,
      mass: Math.round(a.totalMass), windResistance: 80, durability: 100, detachable: false, color: design.spec.color,
    },
  ];
  for (const m of design.members) {
    const kind = componentKindOf(m, floors);
    if (!kind) continue;
    const mat = material(m.material);
    const b = memberBounds(m);
    const tilted = m.rotation[0] !== 0 || m.rotation[2] !== 0;
    const normal: Vec3 | null = m.type === 'roof' ? rotateEuler([0, 1, 0], m.rotation) : m.facade ? facadeNormal(m.facade) : null;
    let wind: number;
    let durability: number;
    if (kind === 'window') {
      wind = vary(panelWind(mat.facadePressure), 0.12, m.id);
      durability = 40;
    } else if (kind === 'roof') {
      const edge = isEdge(m, design);
      wind = vary(panelWind(m.material === 'timber' ? 1900 : 1300) * (edge ? 0.88 : 1), 0.1, m.id);
      durability = 60;
    } else if (kind === 'wall') {
      wind = vary(64, 0.08, m.id); // parapet (as legacy)
      durability = 70;
    } else {
      wind = vary(panelWind(mat.facadePressure), 0.08, m.id);
      durability = mat.failure === 'brittle' ? 45 : 65;
    }
    const size: Vec3 = tilted ? [...m.size] : [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const c: ComponentSpec = {
      id: m.id, kind, position: [...m.position], size, normal,
      mass: Math.max(1, Math.round(m.size[0] * m.size[1] * m.size[2] * mat.density * mat.fill[m.type === 'window' || m.type === 'door' ? 'opening' : m.type === 'roof' ? 'roof' : 'wall'])),
      windResistance: Math.round(wind * 10) / 10, durability,
      // Windows break in place (glass shards); everything else tears off as debris.
      detachable: kind !== 'window',
      color: kind === 'cladding' || kind === 'wall' ? tint(mat.color, design.spec.color) : mat.color,
      material: m.material,
    };
    if (tilted) c.rotation = [...m.rotation];
    out.push(c);
  }
  // Rooftop units and shop sign (legacy extras), on the roof / front facade.
  const units = Math.max(0, Math.min(6, Math.round(design.spec.rooftopUnits)));
  const H = e.height;
  for (let i = 0; i < units; i++) {
    const x = (rnd() - 0.5) * Math.max(0, e.width - 3);
    const z = (rnd() - 0.5) * Math.max(0, e.depth - 3);
    out.push({ id: `ext-${i}`, kind: 'exterior', position: [x, H + 0.12 + 0.5, z], size: [1.4, 1, 1], normal: null, mass: 110, windResistance: vary(40, 0.12, `ext-${i}`), durability: 50, detachable: true, color: '#d9dcdf' });
  }
  if (design.spec.sign) {
    const w = Math.min(e.width * 0.6, 6);
    out.push({ id: 'sign', kind: 'sign', position: [0, Math.min(H - 0.8, 3.0), e.depth / 2 + 0.25], size: [w, 1.1, 0.25], normal: [0, 0, 1], mass: Math.round(w * 14), windResistance: vary(30, 0.08, 'sign'), durability: 35, detachable: true, color: '#e8483b' });
  }
  return out;
}

/** Roof panel on the outer ring (higher suction at edges and corners). */
function isEdge(m: BuildingMember, d: BuildingDesign): boolean {
  const b = memberBounds(m);
  const ex = designExtent(d);
  return b.min[0] <= -ex.width / 2 + 0.5 || b.max[0] >= ex.width / 2 - 0.5 || b.min[2] <= -ex.depth / 2 + 0.5 || b.max[2] >= ex.depth / 2 - 0.5;
}

/** Blend a material color with the facade tint (cladding / parapets follow the building color). */
export function tint(base: string, color: string, k = 0.55): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(base), b = p(color);
  const c = a.map((v, i) => Math.round(v * (1 - k) + b[i] * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export interface DerivedFields {
  params: ObjectParams;
  physics: PhysicalProperties;
  seismic: SeismicProperties;
  components: ComponentSpec[];
  analysis: BuildingAnalysis;
}

/** Everything a modular building's WorldObject derives from its design. */
export function deriveFields(design: BuildingDesign, seed: number, current?: SeismicProperties): DerivedFields {
  const analysis = analysisOf(design);
  return {
    params: designParams(design),
    physics: designPhysics(design, analysis),
    seismic: designSeismic(design, analysis, current),
    components: designComponents(design, seed, analysis),
    analysis,
  };
}

/**
 * Replace an object's design and re-derive its fields. Physical properties the user changed by
 * hand (≠ the previously derived value) are kept, like legacy params edits (WorldDocument.applyParams).
 */
export function withDesign(obj: WorldObject, design: BuildingDesign): WorldObject {
  const prev = obj.building ? designPhysics(obj.building) : null;
  const next = deriveFields(design, obj.seed, obj.seismic);
  const physics = { ...next.physics };
  if (prev) {
    for (const key of Object.keys(physics) as (keyof PhysicalProperties)[]) {
      if (obj.physics[key] !== undefined && obj.physics[key] !== prev[key]) (physics as Record<string, unknown>)[key] = obj.physics[key];
    }
    if (obj.physics.frontalAreaOverride !== undefined) physics.frontalAreaOverride = obj.physics.frontalAreaOverride;
  }
  return { ...obj, building: design, params: next.params, physics, seismic: next.seismic, components: next.components };
}

export { PARAPET };
