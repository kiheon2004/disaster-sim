import { create } from 'zustand';
import type { Vec3 } from '@/core/types';
import type { TerrainViewMode } from './terrain/TerrainSurface';

export interface QuakeViz {
  /** Ground-motion surface (displacement + acceleration colors). */
  ground: boolean;
  /** Horizontal ground-acceleration arrows. */
  arrows: boolean;
  /** Tint structures by their current drift demand. */
  stress: boolean;
  epicenter: boolean;
  /** Visual exaggeration of ground / structural displacement (1 = true scale). */
  exaggeration: number;
  /** Optional camera shake — a visual effect only, separate from the simulation. */
  cameraShake: boolean;
}

export const QUAKE_EXAGGERATIONS = [1, 5, 10, 25] as const;

/** Water display mode (Phase 14, render-only). */
export type FloodVizMode = 'normal' | 'depth' | 'flow' | 'speed';

export interface FloodViz {
  /** Draw the water layers at all (per-phenomenon visualization, Phase 15). */
  visible: boolean;
  mode: FloodVizMode;
  /** Instanced arrows along the flow (direction + speed); always shown in 'flow' mode. */
  arrows: boolean;
}

/** Terrain deformation overlay (Phase 21, render-only). */
export type DeformVizMode = 'off' | 'displacement' | 'original' | 'vectors';

/**
 * Ground-failure overlay (Phase 22, render-only): factor of safety of the evaluated areas, mobile
 * sediment thickness, deposits, total height change of the field; flow arrows; dust (a purely
 * visual effect, never part of the sediment budget).
 */
export type GroundVizMode = 'off' | 'stability' | 'sediment' | 'deposit' | 'change';

export interface GroundViz {
  mode: GroundVizMode;
  arrows: boolean;
  sources: boolean;
  dust: boolean;
}

/**
 * Impact visuals (Phase 23, render-only). Body, trajectory and ejecta positions are the computed
 * ones; `fragmentScale` only enlarges the drawn fragments (labelled exaggeration); flash and dust
 * are visual effects with no mass or force.
 */
export interface ImpactViz {
  trajectory: boolean;
  ejecta: boolean;
  trails: boolean;
  flash: boolean;
  dust: boolean;
  fragmentScale: number;
}
export const FRAGMENT_SCALES = [1, 3, 10] as const;

/**
 * Air-blast visuals (Phase 24, render-only). The pressure field modes show the COMPUTED field
 * (ground level, same contributions as the simulation); the wavefront shell is drawn at the computed
 * front radius — its glow (`frontGlow`) is a visual exaggeration only; the flash is a visual effect.
 */
export type BlastFieldMode = 'off' | 'current' | 'peak' | 'arrival' | 'impulse';
export interface BlastViz {
  field: BlastFieldMode;
  front: boolean;
  vectors: boolean;
  objects: boolean;
  flash: boolean;
  frontGlow: number;
}
export const FRONT_GLOWS = [1, 3] as const;

/** Ground tool in the 3D view: set a point (sinkhole / landslide circle) or draw a polygon. */
/**
 * Structural destruction views (Phase 25, render-only — never read by the simulation):
 *  - color: members colored by their computed demand / capacity, their state (failed / severe /
 *    damaged), or the collapse sequence (failure time); 'normal' = materials + damage tone;
 *  - overlays of the selected building: load paths (member → support, share / capacity), connections
 *    (failed ones), lost foundation support, falling blocks;
 *  - debris: fragments colored by state (moving / at rest), rubble piles;
 *  - dust: visual-only dust amount (0 hides it; never changes a result).
 */
export type StructureColorMode = 'normal' | 'demand' | 'failure' | 'sequence'
  // Phase 26: member temperature (fixed °C scale), restrained thermal-stress utilization, strength factor.
  | 'temperature' | 'thermalStress' | 'strength'
  // Phase 27: fire state of the members (burning / charred share / burned out / heated, non-fuel grey).
  | 'fire';
export interface StructureViz {
  color: StructureColorMode;
  loadPath: boolean;
  connections: boolean;
  support: boolean;
  debris: boolean;
  rubble: boolean;
  dust: number;
}

/**
 * Thermal views (Phase 26, render-only — never read by the simulation):
 *  - field: ground / water surface temperature, the air-layer temperature, the peak surface temperature
 *    so far, or the horizontal temperature gradient of the surface (K/m);
 *  - scale: the fixed °C range of the color legend (no automatic rescaling); unit shown °C or K;
 *  - vectors: conductive heat-flux arrows in the ground surface (−λ∇T), isotherms (50 / 100 / 300 /
 *    600 °C), objects: a ring above every object colored by its surface temperature;
 *  - glow: a visual-only incandescent tint of the source and of members above 500 °C (NOT the
 *    computed radiation, which is invisible infrared).
 */
export type ThermalFieldMode = 'off' | 'surface' | 'air' | 'peak' | 'gradient';
export interface ThermalViz {
  field: ThermalFieldMode;
  scale: number;
  unit: 'C' | 'K';
  vectors: boolean;
  isotherms: boolean;
  objects: boolean;
  glow: boolean;
}

/**
 * Fire views (Phase 27, render-only — never read by the simulation):
 *  - flames: drawn at the computed flame of every burning object / room opening (Heskestad height,
 *    tilt in the wind); their flicker is visual only; glow: a visual light pool under large flames;
 *  - smoke: drawn from the computed soot of the air-layer columns and the rooms (density from the
 *    extinction coefficient); embers: visual-only sparks (no firebrand ignition is computed);
 *  - overlay: fire state of the fuel objects, remaining fuel, heat release, smoke visibility, or the
 *    fire state of the building rooms.
 */
export type FireOverlay = 'off' | 'state' | 'fuel' | 'hrr' | 'smoke' | 'rooms';
export interface FireViz {
  flames: boolean;
  glow: boolean;
  smoke: boolean;
  embers: boolean;
  overlay: FireOverlay;
}

/**
 * Volcano views (Phase 28, render-only — never read by the simulation):
 *  - lava: the computed mobile lava surface (bed + depth), colored by its computed surface temperature
 *    (glow above the Draper point, dark crust below); deposits tinted (lava / bombs dark, ash grey);
 *  - ejecta: the computed bombs in flight; ash: the computed ash puffs (spread σ); steam: a visual-only
 *    plume where lava meets water (no steam is computed); fountain: visual spatter over active vents;
 *  - overlay: lava depth, lava temperature, flow speed, crystal (solid) fraction, ash thickness, or the
 *    ground surface temperature (thermal exposure), with legends.
 */
export type VolcanoOverlay = 'off' | 'depth' | 'temperature' | 'speed' | 'solid' | 'ash' | 'exposure';
export const VOLCANO_OVERLAYS: readonly VolcanoOverlay[] = ['off', 'depth', 'temperature', 'speed', 'solid', 'ash', 'exposure'];
export interface VolcanoViz {
  lava: boolean;
  ejecta: boolean;
  ash: boolean;
  steam: boolean;
  fountain: boolean;
  overlay: VolcanoOverlay;
}

/**
 * Atmosphere views (Phase 29, render-only — never read by the simulation):
 *  - overlay: one computed field over the 5 m air columns with a fixed SI legend — surface pressure,
 *    pressure change from the start, layer density, layer temperature, flow speed, air mass per area,
 *    O₂ in the layer, smoke, volcanic gas, ash in the air (puffs), updraft (buoyancy proxy). Blast
 *    overpressure never shares this legend (Phase 24 has its own).
 *  - arrows: the computed layer flow (column + layer) as instanced arrows; streamlines: lines traced
 *    through the same flow (visual integration of computed velocities); indicator: the remaining-air
 *    badge (no darkening of the scene is claimed as physics).
 */
export type AtmosOverlay = 'off' | 'pressure' | 'pressureChange' | 'density' | 'temperature' | 'speed' | 'mass' | 'oxygen' | 'smoke' | 'gas' | 'ash' | 'updraft';
export const ATMOS_OVERLAYS: readonly AtmosOverlay[] = ['off', 'pressure', 'pressureChange', 'density', 'temperature', 'speed', 'mass', 'oxygen', 'smoke', 'gas', 'ash', 'updraft'];
/**
 * Climate views (Phase 30, render-only — never read by the simulation):
 *  - overlay: one computed field with a fixed SI legend — air temperature, surface temperature, relative humidity,
 *    water vapour, snow depth, snow water equivalent, ice thickness, surface water, soil moisture, net surface heat
 *    flux proxy (shortwave absorbed), roof snow load
 *  - snow: the computed snow cover drawn at its depth (terrain, roofs, crowns, vehicles); ice: computed ice surfaces;
 *    particles: falling snow / rain (VISUAL density from the computed precipitation rate — particles carry no mass);
 *    shimmer: heat-haze tint over hot surfaces (visual only)
 */
export type ClimateOverlay = 'off' | 'airT' | 'surfaceT' | 'rh' | 'vapour' | 'snowDepth' | 'swe' | 'ice' | 'water' | 'soil' | 'solar' | 'roofLoad';
export const CLIMATE_OVERLAYS: readonly ClimateOverlay[] = ['off', 'airT', 'surfaceT', 'rh', 'vapour', 'snowDepth', 'swe', 'ice', 'water', 'soil', 'solar', 'roofLoad'];
export interface ClimateViz {
  overlay: ClimateOverlay;
  snow: boolean;
  ice: boolean;
  particles: boolean;
  shimmer: boolean;
}

/**
 * Celestial views (Phase 32): a field slice through the first source on fixed log legends (|g|, Φ, tidal stretch,
 * escape speed, model-limit zones), the sources (core, capture / softening / influence spheres), the visual disc and
 * lens (illustrative), test particles, probe trails, principal-stretch axes.
 */
export interface CelestialViz {
  overlay: import('./celestial/celestialColors').CelestialOverlay;
  cores: boolean;
  bounds: boolean;
  disc: boolean;
  lens: boolean;
  particles: boolean;
  trails: boolean;
  tidal: boolean;
}

/**
 * Human body overlay (Phase 33, extended model only; render-only — reads e.human, never writes): COM, support rectangle,
 * local gravity, velocity, last contact point + impulse, per-segment risk markers, fall trajectory.
 */
export interface HumanViz {
  enabled: boolean;
  com: boolean;
  support: boolean;
  gravity: boolean;
  velocity: boolean;
  contact: boolean;
  segments: boolean;
  trail: boolean;
}

/** Physiology overlay (Phase 34, physiology runs only; render-only — reads e.physio, never writes): one marker per person
 * coloured by the chosen metric, an airway-under-water ring. */
export const PHYSIO_METRICS = ['core', 'strain', 'supply', 'smoke', 'airway', 'deficit', 'fatigue', 'capacity'] as const;
export type PhysioMetric = (typeof PHYSIO_METRICS)[number];
export interface PhysioViz {
  enabled: boolean;
  metric: PhysioMetric;
  airway: boolean;
}

/** Gravity views (Phase 31): field arrows, a ground / building overlay on fixed SI legends, the local sources. */
export interface GravityViz {
  overlay: import('./gravity/gravityColors').GravityOverlay;
  arrows: boolean;
  sources: boolean;
}

export interface AtmosViz {
  overlay: AtmosOverlay;
  arrows: boolean;
  streamlines: boolean;
}

export interface GroundPick {
  id: string;
  mode: 'point' | 'polygon';
  /** Volcano (Phase 28): what the click places — the first vent, the fissure's second end, or an extra vent. */
  target?: 'vent' | 'end' | 'add' | 'sink' | 'area';
}

export interface DeformViz {
  mode: DeformVizMode;
  /** Foundation contact / tilt markers on buildings standing on moving ground. */
  foundations: boolean;
  /** Vertical exaggeration of the displacement arrows only (labelled; the ground is true scale). */
  exaggeration: number;
}

export const DEFORM_EXAGGERATIONS = [1, 3, 10] as const;

/**
 * Small bridge between the 3D view and DOM overlays (compass, focus requests).
 * Kept separate from world/editor state on purpose.
 */
interface ViewState {
  /** Camera azimuth in degrees, clockwise from North (0 = looking north). */
  azimuthDeg: number;
  focusRequest: { target: Vec3; distance: number; nonce: number } | null;
  /** Simulation overlays */
  showDamage: boolean;
  showWind: boolean;
  /** Which wind visualization layers are drawn when showWind is on. */
  windViz: 'arrows' | 'particles' | 'both';
  /** Height (m) of the arrow sampling plane. */
  arrowHeight: number;
  /** Entity the camera follows in simulation mode. */
  followId: string | null;
  /** Terrain coloring: ground types (shaded), elevation tint + contours, or flat ground-type map. */
  terrainView: TerrainViewMode;
  setTerrainView: (m: TerrainViewMode) => void;
  /** Earthquake visualization (render-only; never affects the simulation). */
  quakeViz: QuakeViz;
  setQuakeViz: (patch: Partial<QuakeViz>) => void;
  /** Water visualization (render-only; never affects the simulation). Phase 14. */
  floodViz: FloodViz;
  setFloodViz: (patch: Partial<FloodViz>) => void;
  /** Point picked on the ground in simulation mode (flood inspector), world x / z. */
  waterProbe: { x: number; z: number } | null;
  setWaterProbe: (p: { x: number; z: number } | null) => void;
  deformViz: DeformViz;
  setDeformViz: (patch: Partial<DeformViz>) => void;
  /** Experiment instance whose deformation centre the next ground click sets (null = off). */
  deformPick: string | null;
  setDeformPick: (id: string | null) => void;
  /** Experiment instance whose predicted final displacement is drawn on the ground. */
  deformPreview: string | null;
  setDeformPreview: (id: string | null) => void;
  groundViz: GroundViz;
  setGroundViz: (patch: Partial<GroundViz>) => void;
  impactViz: ImpactViz;
  setImpactViz: (patch: Partial<ImpactViz>) => void;
  blastViz: BlastViz;
  setBlastViz: (patch: Partial<BlastViz>) => void;
  structureViz: StructureViz;
  setStructureViz: (patch: Partial<StructureViz>) => void;
  thermalViz: ThermalViz;
  setThermalViz: (patch: Partial<ThermalViz>) => void;
  fireViz: FireViz;
  setFireViz: (patch: Partial<FireViz>) => void;
  volcanoViz: VolcanoViz;
  setVolcanoViz: (patch: Partial<VolcanoViz>) => void;
  atmosViz: AtmosViz;
  setAtmosViz: (patch: Partial<AtmosViz>) => void;
  climateViz: ClimateViz;
  setClimateViz: (patch: Partial<ClimateViz>) => void;
  gravityViz: GravityViz;
  setGravityViz: (patch: Partial<GravityViz>) => void;
  celestialViz: CelestialViz;
  setCelestialViz: (patch: Partial<CelestialViz>) => void;
  humanViz: HumanViz;
  setHumanViz: (patch: Partial<HumanViz>) => void;
  physioViz: PhysioViz;
  setPhysioViz: (patch: Partial<PhysioViz>) => void;
  /** Member picked in simulation mode (structural inspector, Phase 25). */
  simMember: { owner: string; member: number } | null;
  setSimMember: (m: { owner: string; member: number } | null) => void;
  groundPick: GroundPick | null;
  setGroundPick: (p: GroundPick | null) => void;
  /** Experiment instance (sinkhole / landslide) whose predicted outcome is drawn on the ground. */
  groundPreview: string | null;
  setGroundPreview: (id: string | null) => void;
  /** Developer performance HUD (off by default; `?perf` or Shift+P). */
  showPerfHud: boolean;
  togglePerfHud: () => void;
  setAzimuth: (deg: number) => void;
  toggleDamage: () => void;
  toggleWind: () => void;
  setWindViz: (v: 'arrows' | 'particles' | 'both') => void;
  setArrowHeight: (h: number) => void;
  setFollow: (id: string | null) => void;
  requestFocus: (target: Vec3, distance?: number) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  azimuthDeg: 0,
  focusRequest: null,
  showDamage: true,
  showWind: true,
  windViz: 'both',
  arrowHeight: 3,
  followId: null,
  terrainView: 'surface',
  setTerrainView: (terrainView) => set({ terrainView }),
  quakeViz: { ground: true, arrows: true, stress: true, epicenter: true, exaggeration: 10, cameraShake: false },
  setQuakeViz: (patch) => set((s) => ({ quakeViz: { ...s.quakeViz, ...patch } })),
  floodViz: { visible: true, mode: 'normal', arrows: false },
  setFloodViz: (patch) => set((s) => ({ floodViz: { ...s.floodViz, ...patch } })),
  waterProbe: null,
  setWaterProbe: (waterProbe) => set({ waterProbe }),
  deformViz: { mode: 'displacement', foundations: true, exaggeration: 1 },
  setDeformViz: (patch) => set((s) => ({ deformViz: { ...s.deformViz, ...patch } })),
  deformPick: null,
  setDeformPick: (deformPick) => set({ deformPick }),
  deformPreview: null,
  setDeformPreview: (deformPreview) => set({ deformPreview }),
  groundViz: { mode: 'change', arrows: true, sources: true, dust: true },
  setGroundViz: (patch) => set((s) => ({ groundViz: { ...s.groundViz, ...patch } })),
  impactViz: { trajectory: true, ejecta: true, trails: true, flash: true, dust: true, fragmentScale: 3 },
  setImpactViz: (patch) => set((s) => ({ impactViz: { ...s.impactViz, ...patch } })),
  blastViz: { field: 'current', front: true, vectors: false, objects: true, flash: true, frontGlow: 1 },
  setBlastViz: (patch) => set((s) => ({ blastViz: { ...s.blastViz, ...patch } })),
  structureViz: { color: 'normal', loadPath: false, connections: false, support: true, debris: false, rubble: true, dust: 1 },
  setStructureViz: (patch) => set((s) => ({ structureViz: { ...s.structureViz, ...patch } })),
  thermalViz: { field: 'surface', scale: 300, unit: 'C', vectors: false, isotherms: true, objects: true, glow: false },
  setThermalViz: (patch) => set((s) => ({ thermalViz: { ...s.thermalViz, ...patch } })),
  fireViz: { flames: true, glow: true, smoke: true, embers: true, overlay: 'off' },
  setFireViz: (patch) => set((s) => ({ fireViz: { ...s.fireViz, ...patch } })),
  volcanoViz: { lava: true, ejecta: true, ash: true, steam: true, fountain: true, overlay: 'off' },
  setVolcanoViz: (patch) => set((s) => ({ volcanoViz: { ...s.volcanoViz, ...patch } })),
  atmosViz: { overlay: 'off', arrows: true, streamlines: false },
  setAtmosViz: (patch) => set((s) => ({ atmosViz: { ...s.atmosViz, ...patch } })),
  climateViz: { overlay: 'off', snow: true, ice: true, particles: true, shimmer: true },
  setClimateViz: (patch) => set((s) => ({ climateViz: { ...s.climateViz, ...patch } })),
  gravityViz: { overlay: 'off', arrows: true, sources: true },
  setGravityViz: (patch) => set((s) => ({ gravityViz: { ...s.gravityViz, ...patch } })),
  celestialViz: { overlay: 'off', cores: true, bounds: true, disc: true, lens: true, particles: true, trails: true, tidal: false },
  setCelestialViz: (patch) => set((s) => ({ celestialViz: { ...s.celestialViz, ...patch } })),
  humanViz: { enabled: false, com: true, support: true, gravity: true, velocity: true, contact: true, segments: true, trail: true },
  setHumanViz: (patch) => set((s) => ({ humanViz: { ...s.humanViz, ...patch } })),
  physioViz: { enabled: false, metric: 'core', airway: true },
  setPhysioViz: (patch) => set((s) => ({ physioViz: { ...s.physioViz, ...patch } })),
  simMember: null,
  setSimMember: (simMember) => set({ simMember }),
  groundPick: null,
  setGroundPick: (groundPick) => set({ groundPick }),
  groundPreview: null,
  setGroundPreview: (groundPreview) => set({ groundPreview }),
  showPerfHud: typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'),
  togglePerfHud: () => set((s) => ({ showPerfHud: !s.showPerfHud })),
  setAzimuth: (azimuthDeg) => set({ azimuthDeg }),
  toggleDamage: () => set((s) => ({ showDamage: !s.showDamage })),
  toggleWind: () => set((s) => ({ showWind: !s.showWind })),
  setWindViz: (windViz) => set({ windViz }),
  setArrowHeight: (arrowHeight) => set({ arrowHeight }),
  setFollow: (followId) => set({ followId }),
  requestFocus: (target, distance = 30) =>
    set({ focusRequest: { target, distance, nonce: Math.random() } }),
}));
