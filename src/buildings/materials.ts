/**
 * Building materials (Phase 17) — APPROXIMATE model parameters, not certified design data.
 *
 * Values are rounded typical/characteristic values from public references (see docs/BUILDING.md
 * §Materials for the table and sources): Eurocode 2 (C30/37 concrete, B500 reinforcement),
 * Eurocode 3 / AISC (S355 steel sections), Eurocode 5 / EN 338 / EN 14080 (C24, GL24h timber),
 * Eurocode 6 (unreinforced clay masonry), glass handbooks (annealed soda-lime glass), and
 * manufacturer ranges for sandwich / metal cladding panels. They give plausible RELATIVE behavior
 * between materials; no member, connection or code check is performed.
 *
 * Member geometry is stored as the member's bounding box. `fill` converts the box into the real
 * section for each member type (an H-section steel column fills ~12 % of its box, a light timber
 * stud wall ~25 %), so mass, stiffness and strength are not those of solid blocks.
 */

export type MaterialId = 'reinforcedConcrete' | 'structuralSteel' | 'timber' | 'masonry' | 'glass' | 'lightCladding';

export const MATERIAL_IDS: readonly MaterialId[] = ['reinforcedConcrete', 'structuralSteel', 'timber', 'masonry', 'glass', 'lightCladding'];

/** How a member of the material fails once its capacity is reached. */
export type FailureBehavior = 'ductile' | 'semiDuctile' | 'brittle';

/** Member types that have a section fill factor. */
export type FillKind = 'column' | 'beam' | 'slab' | 'wall' | 'foundation' | 'roof' | 'opening';

export interface MaterialProps {
  id: MaterialId;
  /** Load-bearing material (false: contributes mass only — glass, cladding panels). */
  structural: boolean;
  /** Density of the solid material (kg/m³). */
  density: number;
  /** Young's modulus (Pa). */
  E: number;
  /**
   * Effective shear modulus for wall racking on the GROSS box area t·L (Pa) — sheathed timber
   * frames are far below wood's G; hollow masonry is reduced by its void ratio.
   */
  wallG: number;
  /** Effective-stiffness factor (cracked concrete / masonry, timber connection slip). */
  stiffnessFactor: number;
  /** Compressive strength used for axial capacity (Pa). */
  compressive: number;
  /** Equivalent bending strength on the effective elastic section modulus (Pa). */
  flexural: number;
  /** In-plane shear strength of walls (Pa, on the effective area). */
  shear: number;
  /** Drift ratio at member failure (columns / walls), before scatter. */
  driftCapacity: { column: number; wall: number };
  /** Post-yield stiffness ratio (bilinear model). */
  hardening: number;
  /** Viscous damping ratio typical of structures of this material. */
  damping: number;
  failure: FailureBehavior;
  /** Section fill of the bounding box per member type (area ≈ inertia fill for solids). */
  fill: Record<FillKind, number>;
  /** Moment-of-inertia fill (I of the section / I of its box) for frame members. */
  inertiaFill: number;
  /** Facade use: pressure (Pa) a panel / pane takes at load ratio 1 (wind design level). */
  facadePressure: number;
  /** Facade use: in-plane drift a panel / pane accommodates before it breaks. */
  facadeDrift: number;
  /** Flood: multiplier on finishes / contents damage of walls in water (1 = masonry). */
  waterSensitivity: number;
  /** Rendering. */
  color: string;
  roughness: number;
  metalness: number;
}

/** Steel H-sections: area ≈ 12 % of the box, I ≈ 35 % (e.g. HEB / W-shapes); deep beams less. */
const STEEL_FILL: Record<FillKind, number> = { column: 0.12, beam: 0.08, slab: 0.06, wall: 0.03, foundation: 0.12, roof: 0.05, opening: 0.3 };

export const MATERIALS: Record<MaterialId, MaterialProps> = {
  reinforcedConcrete: {
    id: 'reinforcedConcrete', structural: true,
    density: 2450, // concrete 2400 + ~1–2 % reinforcement
    E: 33e9, // EC2 C30/37: Ecm = 33 GPa
    wallG: 13.7e9, // G = E / (2(1+ν)), ν = 0.2
    stiffnessFactor: 0.5, // cracked sections (ACI 318: 0.35–0.7 Ig)
    compressive: 30e6, // fck = 30 MPa
    // M ≈ 0.9·ρ·fy·b·d² with ρ ≈ 1.5 %, fy = 500 MPa, d ≈ 0.8 h → ≈ 4.3 MPa·b·h² = 26 MPa on b·h²/6
    flexural: 26e6,
    shear: 1.5e6, // walls with distributed reinforcement, on gross area
    driftCapacity: { column: 0.04, wall: 0.015 },
    hardening: 0.05, damping: 0.05, failure: 'ductile',
    fill: { column: 1, beam: 1, slab: 1, wall: 1, foundation: 1, roof: 1, opening: 1 },
    inertiaFill: 1,
    facadePressure: 6000, facadeDrift: 0.01, waterSensitivity: 0.7,
    color: '#b9b6ae', roughness: 0.9, metalness: 0,
  },
  structuralSteel: {
    id: 'structuralSteel', structural: true,
    density: 7850,
    E: 210e9,
    wallG: 81e9,
    stiffnessFactor: 1,
    compressive: 355e6, // S355
    flexural: 355e6 * 1.12, // plastic shape factor of I-sections
    shear: 205e6, // fy/√3
    driftCapacity: { column: 0.05, wall: 0.03 },
    hardening: 0.06, damping: 0.03, failure: 'ductile',
    fill: STEEL_FILL,
    inertiaFill: 0.35,
    facadePressure: 2000, facadeDrift: 0.02, waterSensitivity: 0.8,
    color: '#7d8791', roughness: 0.45, metalness: 0.55,
  },
  timber: {
    id: 'timber', structural: true,
    density: 450, // C24 / GL24h ≈ 420–450 kg/m³ (12 % moisture)
    E: 11e9, // E0,mean 11–11.5 GPa
    wallG: 25e6, // racking of sheathed light-frame walls ≈ 1.5 kN/mm per m (2.5 m high, 0.15 m box)
    stiffnessFactor: 0.7, // connection slip
    compressive: 21e6, // fc,0,k
    flexural: 24e6, // fm,k
    shear: 0.05e6, // sheathed light-frame shear walls ≈ 5–10 kN/m → ≈ 0.05 MPa on a 0.16 m box
    driftCapacity: { column: 0.06, wall: 0.05 },
    hardening: 0.06, damping: 0.07, failure: 'semiDuctile',
    // Joist floors and stud walls are mostly voids.
    fill: { column: 1, beam: 1, slab: 0.35, wall: 0.25, foundation: 1, roof: 0.3, opening: 0.5 },
    inertiaFill: 1,
    facadePressure: 1700, facadeDrift: 0.02, waterSensitivity: 1.3,
    color: '#b88a5a', roughness: 0.85, metalness: 0,
  },
  masonry: {
    id: 'masonry', structural: true,
    density: 1900, // clay brick + mortar
    E: 5e9, // EC6: E ≈ 1000·fk
    wallG: 1.7e9, // ≈ 0.4 E × 0.85 solid fraction
    stiffnessFactor: 0.6,
    compressive: 5e6, // fk of a common clay brick wall
    flexural: 0.3e6, // unreinforced: governed by mortar tension (rocking is checked separately)
    shear: 0.3e6, // fvk0 0.2 MPa + friction
    driftCapacity: { column: 0.008, wall: 0.01 },
    hardening: 0.02, damping: 0.06, failure: 'brittle',
    fill: { column: 1, beam: 1, slab: 1, wall: 0.85, foundation: 1, roof: 1, opening: 1 },
    inertiaFill: 1,
    facadePressure: 2600, facadeDrift: 0.004, waterSensitivity: 1,
    color: '#b5674d', roughness: 0.95, metalness: 0,
  },
  glass: {
    id: 'glass', structural: false,
    density: 2500,
    E: 70e9, wallG: 28e9, stiffnessFactor: 1,
    compressive: 0, flexural: 0, shear: 0, // not load-bearing in this model
    driftCapacity: { column: 0, wall: 0 },
    hardening: 0, damping: 0.03, failure: 'brittle',
    // Curtain-wall units ≈ 50 kg/m² on a 0.1 m box; double-glazed panes ≈ 35 kg/m² on 0.06 m.
    fill: { column: 1, beam: 1, slab: 1, wall: 0.2, foundation: 1, roof: 0.2, opening: 0.23 },
    inertiaFill: 1,
    // Same design level as the Phase 0–16 windows (46 m/s ↔ ≈ 1.04 kPa at Cp 0.8).
    facadePressure: 1040, facadeDrift: 0.011, waterSensitivity: 0.6,
    color: '#7fa8cc', roughness: 0.15, metalness: 0.3,
  },
  lightCladding: {
    id: 'lightCladding', structural: false,
    density: 120, // sandwich / metal panels ≈ 10–15 kg/m² at ~0.1 m
    E: 5e9, wallG: 1e9, stiffnessFactor: 1,
    compressive: 0, flexural: 0, shear: 0,
    driftCapacity: { column: 0, wall: 0 },
    hardening: 0, damping: 0.03, failure: 'ductile',
    fill: { column: 1, beam: 1, slab: 1, wall: 1, foundation: 1, roof: 1, opening: 1 },
    inertiaFill: 1,
    facadePressure: 1500, facadeDrift: 0.02, waterSensitivity: 1.2,
    color: '#cfd6dc', roughness: 0.55, metalness: 0.35,
  },
};

export function material(id: MaterialId): MaterialProps {
  return MATERIALS[id] ?? MATERIALS.reinforcedConcrete;
}

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === 'string' && v in MATERIALS;
}

/** Rendering classes: one instanced layer per class (material look), shared by all buildings. */
export type MaterialLook = 'concrete' | 'steel' | 'timber' | 'masonry' | 'glass' | 'cladding';
export const MATERIAL_LOOK: Record<MaterialId, MaterialLook> = {
  reinforcedConcrete: 'concrete', structuralSteel: 'steel', timber: 'timber', masonry: 'masonry', glass: 'glass', lightCladding: 'cladding',
};
export const MATERIAL_LOOKS: readonly MaterialLook[] = ['concrete', 'steel', 'timber', 'masonry', 'glass', 'cladding'];
