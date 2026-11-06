/**
 * Phase 35 Level 1 passive dynamic objects: crate, barrel, shipping container, furniture, concrete road barrier, ball.
 *
 * Each is a free rigid body (`physicsProfile: 'dynamic'`) whose mass, COM and principal inertia come from an explicit part
 * model (objects/massProperties.ts) instead of the colliders' uniform density. They get no force path of their own: wind,
 * ground motion, water (buoyancy + drag), sediment, blast, gravity fields and contacts reach them through the existing
 * systems, which read `dims`, `copLocal`, `physics.dragCoefficient`, `areaFactor` (frontalArea) and — for water —
 * `passive.displacedVolume` / `passive.waterDrag`.
 *
 * Local frame as for cars: origin at the base centre, X = length, Y = height, Z = width.
 *
 * Data levels (docs: A standard / measured, B handbook range, C assumed for the model):
 *   steel 7850 kg/m³ (A, EN 1993-1-1 §3.2.6) · normal-weight concrete 2400 kg/m³ (A, EN 1991-1-1 Table A.1, 24 kN/m³)
 *   air-dry softwood 500 kg/m³ (B, USDA Wood Handbook FPL-GTR-190: spruce / pine 450–550) · HDPE 950 kg/m³ (B, 941–965)
 *   ISO 668 container sizes (A) and typical dry-van tare masses 2230 / 3750 kg (B, manufacturers 2200–2300 / 3700–3800)
 *   208 L (55 US gal) steel drum Ø 0.572 × 0.88 m, 1.2 mm sheet (B, ISO 15750-3 class) → ≈ 20 kg empty
 *   NJ-profile precast barrier 0.61 m base / 0.15 m top / 0.81 m high (B, AASHTO RDG) → ≈ 606 kg/m (≈ 400 lb/ft)
 *   furniture masses (C, typical catalogue values) · friction / restitution (B/C, see each type) · drag Cd (B, Hoerner)
 * Friction is the object side of the contact: Rapier averages the two colliders' coefficients (ground 0.9 × ground-type
 * factor), so the effective μ against the default ground is (μ_object·factor + 0.9) / 2.
 */
import type { Vec3 } from '@/core/types';
import type { ComponentSpec } from '@/core/model';
import type { ShapeSpec } from '@/core/shapes';
import { defineObject } from '../ObjectDefinition';
import { boxShell, combine, solidBox, solidCylinder, solidSphere, sphericalShell, thinDisc, thinTube, type MassModel } from '../massProperties';

export const STEEL_DENSITY = 7850;
export const CONCRETE_DENSITY = 2400;
/** Generic cargo inside an unsealed crate: water-saturated packed goods, neutral in water (C). */
export const CARGO_DENSITY = 1000;

/** Placement on slopes: the base follows the ground plane (like a car). */
const FIT = { align: 1, base: 'mean' } as const;
/** Wind design speed / fatigue fields are required by PhysicalProperties; the passive behaviour does not use them. */
const UNUSED_WIND = { windResistance: 40, durability: 60, breakThreshold: 1.5 } as const;

/** One non-detachable body component (inspector / results), as for cars. */
function bodyComponent(size: Vec3, mass: number, color: string): ComponentSpec[] {
  return [{ id: 'body', kind: 'structure', position: [0, size[1] / 2, 0], size, normal: null, mass: Math.round(mass), windResistance: 40, durability: 60, detachable: false, color }];
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const totalMass = (mm: MassModel) => round1(mm.mass);

// ── Crate ────────────────────────────────────────────────────────────────

/**
 * Crate wall material: density (kg/m³), wall thickness (m), object-side friction / restitution (B/C: wood–concrete
 * μ ≈ 0.6, steel–concrete ≈ 0.5, HDPE–concrete ≈ 0.4) and the breakage factor (higher = tougher).
 */
export const CRATE_MATERIALS = {
  wood: { density: 500, wall: 0.02, friction: 0.6, restitution: 0.2, impact: 15 },
  steel: { density: STEEL_DENSITY, wall: 0.002, friction: 0.5, restitution: 0.15, impact: 40 },
  plastic: { density: 950, wall: 0.005, friction: 0.4, restitution: 0.25, impact: 20 },
} as const;
export type CrateMaterial = keyof typeof CRATE_MATERIALS;

export interface CrateParams {
  [k: string]: number | string | boolean;
  material: CrateMaterial;
  length: number;
  width: number;
  height: number;
  /** Cargo mass (kg), spread uniformly over the interior. */
  cargo: number;
  /** Watertight (displaces its whole outer volume) or not (water fills it: shell + cargo volume only). */
  sealed: boolean;
  color: string;
}

const crateMat = (p: CrateParams) => CRATE_MATERIALS[p.material] ?? CRATE_MATERIALS.wood;
/** Shell mass: thin-wall approximation ρ · t · outer surface area. */
export function crateShellMass(p: CrateParams): number {
  const m = crateMat(p);
  return m.density * m.wall * 2 * (p.length * p.height + p.length * p.width + p.height * p.width);
}

export const crateDefinition = defineObject<CrateParams>({
  type: 'crate',
  category: 'objects',
  labelKey: 'object.crate',
  icon: 'crate',
  physicsProfile: 'dynamic',
  terrainFit: FIT,
  defaultParams: { material: 'wood', length: 1.2, width: 0.8, height: 0.8, cargo: 0, sealed: false, color: '#b08850' },
  paramSchema: [
    {
      key: 'material',
      labelKey: 'param.material',
      kind: 'select',
      options: [
        { value: 'wood', labelKey: 'param.material.wood' },
        { value: 'steel', labelKey: 'param.material.steel' },
        { value: 'plastic', labelKey: 'param.material.plastic' },
      ],
    },
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 0.3, max: 4, step: 0.05, unit: 'm' },
    { key: 'width', labelKey: 'param.width', kind: 'number', min: 0.3, max: 3, step: 0.05, unit: 'm' },
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 0.3, max: 3, step: 0.05, unit: 'm' },
    { key: 'cargo', labelKey: 'param.cargo', kind: 'number', min: 0, max: 3000, step: 10, unit: 'kg' },
    { key: 'sealed', labelKey: 'param.sealed', kind: 'boolean' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: totalMass(crateMassModel(p)),
    friction: crateMat(p).friction,
    restitution: crateMat(p).restitution,
    anchored: false,
    // Cube / short box broadside (B, Hoerner: 1.05).
    dragCoefficient: 1.05,
    ...UNUSED_WIND,
  }),
  getDimensions: (p) => [p.length, p.height, p.width],
  centerOfPressure: (p) => [0, p.height / 2, 0],
  colliders: (p) => [{ type: 'box', halfExtents: [p.length / 2, p.height / 2, p.width / 2], offset: [0, p.height / 2, 0] }],
  createComponents: (p) => bodyComponent([p.length, p.height, p.width], crateMassModel(p).mass, p.color),
  passive: {
    massModel: (p) => crateMassModel(p),
    displacedVolume: (p) => (p.sealed ? p.length * p.height * p.width : crateShellMass(p) / crateMat(p).density + Math.max(0, p.cargo) / CARGO_DENSITY),
    waterDrag: 1.05,
    impactFactor: (p) => crateMat(p).impact,
    toppleEvent: true,
  },
});

/** Closed thin-walled box (the six walls) + the cargo as a solid block filling the interior. */
export function crateMassModel(p: CrateParams): MassModel {
  const t = crateMat(p).wall;
  const parts = [boxShell(crateShellMass(p), [p.length, p.height, p.width], [0, p.height / 2, 0])];
  if (p.cargo > 0) parts.push(solidBox(p.cargo, [p.length - 2 * t, p.height - 2 * t, p.width - 2 * t], [0, p.height / 2, 0]));
  return combine(parts);
}

// ── Barrel (steel drum) ──────────────────────────────────────────────────

/** 208 L steel drum: outer radius / height (m), sheet thickness (m), nominal capacity (m³). */
export const DRUM = { radius: 0.286, height: 0.88, wall: 0.0012, capacity: 0.208 } as const;
/** Contents density (kg/m³): water 1000 (A), mineral oil / diesel 850 (B, 820–870). */
export const DRUM_FILL = { empty: 0, water: 1000, oil: 850 } as const;
export type DrumFill = keyof typeof DRUM_FILL;

export interface BarrelParams {
  [k: string]: number | string | boolean;
  fill: DrumFill;
  color: string;
}

export const barrelDefinition = defineObject<BarrelParams>({
  type: 'barrel',
  category: 'objects',
  labelKey: 'object.barrel',
  icon: 'barrel',
  physicsProfile: 'dynamic',
  terrainFit: FIT,
  defaultParams: { fill: 'empty', color: '#2f6fa8' },
  paramSchema: [
    {
      key: 'fill',
      labelKey: 'param.fill',
      kind: 'select',
      options: [
        { value: 'empty', labelKey: 'param.fill.empty' },
        { value: 'water', labelKey: 'param.fill.water' },
        { value: 'oil', labelKey: 'param.fill.oil' },
      ],
    },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: totalMass(barrelMassModel(p)),
    // Painted steel on concrete / asphalt (B/C).
    friction: 0.5,
    restitution: 0.2,
    anchored: false,
    // Upright finite cylinder, L/D ≈ 1.5, side-on (B, Hoerner ≈ 0.7–0.8).
    dragCoefficient: 0.75,
    ...UNUSED_WIND,
  }),
  getDimensions: () => [DRUM.radius * 2, DRUM.height, DRUM.radius * 2],
  centerOfPressure: () => [0, DRUM.height / 2, 0],
  colliders: () => [{ type: 'cylinder', halfHeight: DRUM.height / 2, radius: DRUM.radius, offset: [0, DRUM.height / 2, 0] }],
  createComponents: (p) => bodyComponent([DRUM.radius * 2, DRUM.height, DRUM.radius * 2], barrelMassModel(p).mass, p.color),
  passive: {
    massModel: (p) => barrelMassModel(p),
    // Closed bung: the whole outer cylinder displaces water.
    displacedVolume: () => Math.PI * DRUM.radius ** 2 * DRUM.height,
    waterDrag: 0.75,
    impactFactor: () => 30,
    toppleEvent: true,
  },
});

/** Drum shell mass: ρ_steel · t · (side + two ends). */
export const drumShellMass = () => STEEL_DENSITY * DRUM.wall * (2 * Math.PI * DRUM.radius * DRUM.height + 2 * Math.PI * DRUM.radius ** 2);

/**
 * Thin-walled steel shell (side tube + two end discs, mass ∝ area) + the contents as a rigid liquid column of the nominal
 * capacity resting on the bottom (no sloshing; a liquid does not spin with the drum about its axis — upper bound on I_yy).
 */
export function barrelMassModel(p: BarrelParams): MassModel {
  const { radius: r, height: h, wall: t } = DRUM;
  const side = STEEL_DENSITY * t * 2 * Math.PI * r * h;
  const end = STEEL_DENSITY * t * Math.PI * r * r;
  const parts = [thinTube(side, r, h, [0, h / 2, 0]), thinDisc(end, r, [0, 0, 0]), thinDisc(end, r, [0, h, 0])];
  const rho = DRUM_FILL[p.fill] ?? 0;
  if (rho > 0) {
    const hc = DRUM.capacity / (Math.PI * r * r);
    parts.push(solidCylinder(rho * DRUM.capacity, r, hc, [0, hc / 2, 0]));
  }
  return combine(parts);
}

// ── Shipping container ───────────────────────────────────────────────────

/** ISO 668 dry van: outer / inner size (m), tare and max payload (kg), floor height (m). */
export const CONTAINERS = {
  '20ft': { length: 6.058, width: 2.438, height: 2.591, inner: [5.898, 2.393, 2.352] as Vec3, tare: 2230, payload: 28250 },
  '40ft': { length: 12.192, width: 2.438, height: 2.591, inner: [12.032, 2.393, 2.352] as Vec3, tare: 3750, payload: 26730 },
} as const;
export type ContainerSize = keyof typeof CONTAINERS;
/** Bottom structure (side rails, cross members, 28 mm floor) — share of the tare and depth below the inner floor (C). */
export const CONTAINER_BASE = { fraction: 0.35, depth: 0.16 } as const;

export interface ContainerParams {
  [k: string]: number | string | boolean;
  size: ContainerSize;
  /** Cargo mass (kg), clamped to the max payload, spread uniformly over the interior. */
  cargo: number;
  color: string;
}

const cont = (p: ContainerParams) => CONTAINERS[p.size] ?? CONTAINERS['20ft'];

export const containerDefinition = defineObject<ContainerParams>({
  type: 'container',
  category: 'objects',
  labelKey: 'object.container',
  icon: 'container',
  physicsProfile: 'dynamic',
  terrainFit: FIT,
  defaultParams: { size: '20ft', cargo: 0, color: '#b5452f' },
  paramSchema: [
    {
      key: 'size',
      labelKey: 'param.containerSize',
      kind: 'select',
      options: [
        { value: '20ft', labelKey: 'param.containerSize.20ft' },
        { value: '40ft', labelKey: 'param.containerSize.40ft' },
      ],
    },
    { key: 'cargo', labelKey: 'param.cargo', kind: 'number', min: 0, max: 28250, step: 250, unit: 'kg' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: totalMass(containerMassModel(p)),
    // Steel corner castings on asphalt / concrete (B/C).
    friction: 0.5,
    restitution: 0.05,
    anchored: false,
    // Long box broadside (B, ≈ 1.2).
    dragCoefficient: 1.2,
    ...UNUSED_WIND,
  }),
  getDimensions: (p) => [cont(p).length, cont(p).height, cont(p).width],
  centerOfPressure: (p) => [0, cont(p).height / 2, 0],
  colliders: (p) => [{ type: 'box', halfExtents: [cont(p).length / 2, cont(p).height / 2, cont(p).width / 2], offset: [0, cont(p).height / 2, 0] }],
  createComponents: (p) => bodyComponent([cont(p).length, cont(p).height, cont(p).width], containerMassModel(p).mass, p.color),
  passive: {
    massModel: (p) => containerMassModel(p),
    // Doors closed: treated as watertight (no water ingress model — a documented limit).
    displacedVolume: (p) => cont(p).length * cont(p).height * cont(p).width,
    waterDrag: 1.2,
    impactFactor: () => 60,
    toppleEvent: true,
  },
});

/**
 * Tare = bottom structure (35 %, solid slab under the inner floor) + walls / roof / ends (65 %, closed thin shell of the
 * outer size); cargo = solid block of the inner size standing on the inner floor.
 */
export function containerMassModel(p: ContainerParams): MassModel {
  const c = cont(p);
  const { fraction, depth } = CONTAINER_BASE;
  const parts = [
    solidBox(c.tare * fraction, [c.length, depth, c.width], [0, depth / 2, 0]),
    boxShell(c.tare * (1 - fraction), [c.length, c.height, c.width], [0, c.height / 2, 0]),
  ];
  const cargo = Math.min(c.payload, Math.max(0, p.cargo));
  if (cargo > 0) parts.push(solidBox(cargo, [c.inner[0], c.inner[1], c.inner[2]], [0, depth + c.inner[1] / 2, 0]));
  return combine(parts);
}

// ── Furniture ────────────────────────────────────────────────────────────

/**
 * Reference pieces (C, typical catalogue values): size L × H × W (m), mass (kg), material density for the water
 * displacement (kg/m³: foam + wood frame 300, solid wood 650, particleboard 650 — EN 312: 600–750), drag Cd (B/C).
 * A resized piece keeps its bulk density (mass ∝ L·H·W).
 */
export const FURNITURE = {
  sofa: { length: 2.0, height: 0.85, width: 0.9, mass: 55, density: 300, cd: 1.1 },
  table: { length: 1.6, height: 0.75, width: 0.9, mass: 40, density: 650, cd: 1.2 },
  cabinet: { length: 1.0, height: 1.9, width: 0.55, mass: 70, density: 650, cd: 1.1 },
} as const;
export type FurnitureKind = keyof typeof FURNITURE;
/** Table top thickness and leg section (m). */
export const TABLE = { top: 0.05, leg: 0.07, inset: 0.1 } as const;

export interface FurnitureParams {
  [k: string]: number | string | boolean;
  kind: FurnitureKind;
  length: number;
  width: number;
  height: number;
  color: string;
}

const furn = (p: FurnitureParams) => FURNITURE[p.kind] ?? FURNITURE.sofa;
export const furnitureMass = (p: FurnitureParams) => {
  const f = furn(p);
  return (f.mass * (p.length * p.height * p.width)) / (f.length * f.height * f.width);
};

/** Sofa geometry from the overall size: seat block, back (rear 22 % of the depth), two arms (8 % of the length each). */
export function sofaBoxes(p: FurnitureParams) {
  const L = p.length, H = p.height, W = p.width;
  const seatH = 0.5 * H;
  const backD = 0.22 * W;
  const armL = 0.08 * L;
  const armH = 0.4 * (H - seatH);
  const armD = W - backD;
  return {
    seat: { size: [L, seatH, W] as Vec3, centre: [0, seatH / 2, 0] as Vec3, fraction: 0.6 },
    back: { size: [L, H - seatH, backD] as Vec3, centre: [0, seatH + (H - seatH) / 2, -W / 2 + backD / 2] as Vec3, fraction: 0.25 },
    arms: [-1, 1].map((s) => ({ size: [armL, armH, armD] as Vec3, centre: [s * (L / 2 - armL / 2), seatH + armH / 2, -W / 2 + backD + armD / 2] as Vec3, fraction: 0.075 })),
  };
}

/** Table geometry: top slab (70 % of the mass) and four legs (7.5 % each). */
export function tableBoxes(p: FurnitureParams) {
  const L = p.length, H = p.height, W = p.width;
  const legH = H - TABLE.top;
  const top = { size: [L, TABLE.top, W] as Vec3, centre: [0, H - TABLE.top / 2, 0] as Vec3, fraction: 0.7 };
  const legs = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({
    size: [TABLE.leg, legH, TABLE.leg] as Vec3, centre: [sx * (L / 2 - TABLE.inset), legH / 2, sz * (W / 2 - TABLE.inset)] as Vec3, fraction: 0.075,
  }));
  return { top, legs };
}

/** Furniture as boxes (colliders = the part model's boxes). */
function furnitureBoxes(p: FurnitureParams): { size: Vec3; centre: Vec3; fraction: number }[] {
  if (p.kind === 'table') { const t = tableBoxes(p); return [t.top, ...t.legs]; }
  if (p.kind === 'sofa') { const s = sofaBoxes(p); return [s.seat, s.back, ...s.arms]; }
  return [{ size: [p.length, p.height, p.width], centre: [0, p.height / 2, 0], fraction: 1 }];
}

export const furnitureDefinition = defineObject<FurnitureParams>({
  type: 'furniture',
  category: 'objects',
  labelKey: 'object.furniture',
  icon: 'sofa',
  physicsProfile: 'dynamic',
  terrainFit: FIT,
  defaultParams: { kind: 'sofa', length: 2.0, width: 0.9, height: 0.85, color: '#6d7f99' },
  paramSchema: [
    {
      key: 'kind',
      labelKey: 'param.furniture',
      kind: 'select',
      options: [
        { value: 'sofa', labelKey: 'param.furniture.sofa' },
        { value: 'table', labelKey: 'param.furniture.table' },
        { value: 'cabinet', labelKey: 'param.furniture.cabinet' },
      ],
    },
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 0.4, max: 4, step: 0.05, unit: 'm' },
    { key: 'width', labelKey: 'param.width', kind: 'number', min: 0.3, max: 2, step: 0.05, unit: 'm' },
    { key: 'height', labelKey: 'param.height', kind: 'number', min: 0.3, max: 2.6, step: 0.05, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: totalMass(furnitureMassModel(p)),
    // Wooden feet / fabric on a hard floor or pavement (C).
    friction: 0.5,
    restitution: 0.1,
    anchored: false,
    dragCoefficient: furn(p).cd,
    ...UNUSED_WIND,
  }),
  getDimensions: (p) => [p.length, p.height, p.width],
  centerOfPressure: (p) => [0, p.height / 2, 0],
  // A table is open underneath: top edge + two legs face the wind.
  frontalArea: (p) => (p.kind === 'table' ? p.length * TABLE.top + 2 * TABLE.leg * (p.height - TABLE.top) : p.length * p.height),
  colliders: (p) => furnitureBoxes(p).map<ShapeSpec>((b) => ({ type: 'box', halfExtents: [b.size[0] / 2, b.size[1] / 2, b.size[2] / 2], offset: b.centre })),
  createComponents: (p) => bodyComponent([p.length, p.height, p.width], furnitureMass(p), p.color),
  passive: {
    massModel: (p) => furnitureMassModel(p),
    // Material volume (unsealed): water fills the gaps.
    displacedVolume: (p) => furnitureMass(p) / furn(p).density,
    waterDrag: 1.1,
    impactFactor: () => 8,
    toppleEvent: true,
  },
});

/** Sofa / table: solid boxes with fixed mass shares (parallel axis); cabinet: closed thin-walled box (panels). */
export function furnitureMassModel(p: FurnitureParams): MassModel {
  const m = furnitureMass(p);
  if (p.kind === 'cabinet') return boxShell(m, [p.length, p.height, p.width], [0, p.height / 2, 0]);
  return combine(furnitureBoxes(p).map((b) => solidBox(m * b.fraction, b.size, b.centre)));
}

// ── Concrete road barrier (New Jersey profile) ───────────────────────────

/**
 * NJ profile (m): 0.61 base, 75 mm vertical toe, 55° face to the break point at 0.33 m (0.253 wide), 84° face to the
 * 0.15 m top at 0.81 m. Model: three bands, each a box of the band's mean width (same area) — A = 0.2525 m².
 */
export const NJ_BANDS: { y0: number; y1: number; width: number }[] = [
  { y0: 0, y1: 0.075, width: 0.61 },
  { y0: 0.075, y1: 0.33, width: (0.61 + 0.253) / 2 },
  { y0: 0.33, y1: 0.81, width: (0.253 + 0.15) / 2 },
];
export const NJ_HEIGHT = 0.81;
export const NJ_BASE = 0.61;
export const njArea = () => NJ_BANDS.reduce((a, b) => a + (b.y1 - b.y0) * b.width, 0);

export interface RoadBarrierParams {
  [k: string]: number | string | boolean;
  length: number;
  color: string;
}

export const roadBarrierDefinition = defineObject<RoadBarrierParams>({
  type: 'roadBarrier',
  category: 'objects',
  labelKey: 'object.roadBarrier',
  icon: 'barrier',
  physicsProfile: 'dynamic',
  terrainFit: FIT,
  defaultParams: { length: 3.0, color: '#c9c6bd' },
  paramSchema: [
    { key: 'length', labelKey: 'param.length', kind: 'number', min: 1, max: 6, step: 0.1, unit: 'm' },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: totalMass(roadBarrierMassModel(p)),
    // Concrete on asphalt / concrete (B/C: field tests 0.4–0.7).
    friction: 0.6,
    restitution: 0.05,
    anchored: false,
    // Ground-mounted wall-like section broadside (B/C).
    dragCoefficient: 1.2,
    ...UNUSED_WIND,
  }),
  getDimensions: (p) => [p.length, NJ_HEIGHT, NJ_BASE],
  centerOfPressure: () => [0, NJ_HEIGHT / 2, 0],
  colliders: (p) => NJ_BANDS.map<ShapeSpec>((b) => ({ type: 'box', halfExtents: [p.length / 2, (b.y1 - b.y0) / 2, b.width / 2], offset: [0, (b.y0 + b.y1) / 2, 0] })),
  createComponents: (p) => bodyComponent([p.length, NJ_HEIGHT, NJ_BASE], roadBarrierMassModel(p).mass, p.color),
  passive: {
    massModel: (p) => roadBarrierMassModel(p),
    // Solid concrete: sinks.
    displacedVolume: (p) => njArea() * p.length,
    waterDrag: 1.2,
    impactFactor: () => 50,
    toppleEvent: true,
  },
});

/** Three solid concrete bands (parallel axis). */
export function roadBarrierMassModel(p: RoadBarrierParams): MassModel {
  return combine(NJ_BANDS.map((b) => solidBox(CONCRETE_DENSITY * (b.y1 - b.y0) * b.width * p.length, [p.length, b.y1 - b.y0, b.width], [0, (b.y0 + b.y1) / 2, 0])));
}

// ── Ball ─────────────────────────────────────────────────────────────────

export interface BallParams {
  [k: string]: number | string | boolean;
  radius: number;
  mass: number;
  /** Solid sphere (I = 2/5 m r²) or thin spherical shell (I = 2/3 m r²). */
  construction: 'solid' | 'shell';
  color: string;
}

export const ballDefinition = defineObject<BallParams>({
  type: 'ball',
  category: 'objects',
  labelKey: 'object.ball',
  icon: 'ball',
  physicsProfile: 'dynamic',
  // Origin at the ground under the centre, kept level (a sphere has no "up").
  terrainFit: { align: 0, base: 'center' },
  defaultParams: { radius: 0.3, mass: 8, construction: 'solid', color: '#d9534f' },
  paramSchema: [
    { key: 'radius', labelKey: 'param.radius', kind: 'number', min: 0.05, max: 2, step: 0.05, unit: 'm' },
    { key: 'mass', labelKey: 'param.mass', kind: 'number', min: 0.1, max: 50000, step: 0.1, unit: 'kg' },
    {
      key: 'construction',
      labelKey: 'param.construction',
      kind: 'select',
      options: [
        { value: 'solid', labelKey: 'param.construction.solid' },
        { value: 'shell', labelKey: 'param.construction.shell' },
      ],
    },
    { key: 'color', labelKey: 'param.color', kind: 'color' },
  ],
  defaultPhysics: (p) => ({
    mass: p.mass,
    // Rubber-like surface (C).
    friction: 0.8,
    restitution: 0.5,
    anchored: false,
    // Smooth sphere, subcritical Reynolds number (B, 0.47).
    dragCoefficient: 0.47,
    ...UNUSED_WIND,
  }),
  getDimensions: (p) => [p.radius * 2, p.radius * 2, p.radius * 2],
  centerOfPressure: (p) => [0, p.radius, 0],
  // Disc silhouette π r² instead of the bounding square (2r)².
  frontalArea: (p) => Math.PI * p.radius * p.radius,
  colliders: (p) => [{ type: 'ball', radius: p.radius, offset: [0, p.radius, 0] }],
  createComponents: (p) => bodyComponent([p.radius * 2, p.radius * 2, p.radius * 2], p.mass, p.color),
  passive: {
    massModel: (p) => ballMassModel(p),
    displacedVolume: (p) => (4 / 3) * Math.PI * p.radius ** 3,
    waterDrag: 0.47,
    impactFactor: () => Infinity,
    toppleEvent: false,
  },
});

export function ballMassModel(p: BallParams): MassModel {
  return p.construction === 'shell' ? sphericalShell(p.mass, p.radius, [0, p.radius, 0]) : solidSphere(p.mass, p.radius, [0, p.radius, 0]);
}

/** The Phase 35 passive types (registry order). */
export const PASSIVE_DEFINITIONS = [crateDefinition, barrelDefinition, containerDefinition, furnitureDefinition, roadBarrierDefinition, ballDefinition];
