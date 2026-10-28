/**
 * Approximate parameters of the flood model (Phase 14).
 *
 * Every number here is an APPROXIMATE SIMULATION PARAMETER chosen for plausible relative
 * behavior (sand soaks up more rain than asphalt; a deep, fast flow pushes harder than a shallow
 * one) — not calibrated hydrological or engineering data. The UI labels them that way.
 */
import { GROUND_MATERIALS } from '@/terrain/GroundMaterials';

export const WATER_DENSITY = 1000; // kg/m³

/** Below this flow depth a cell face carries no flow (wet/dry front), m. */
export const H_FLOW_MIN = 1e-4;
/** Depth from which a cell counts as wet (rendering, statistics), m. */
export const WET_DEPTH = 0.01;
/** Depth from which a cell counts as flooded (flooded area, exposure), m. */
export const FLOOD_DEPTH = 0.1;

/** CFL safety factor of the explicit local-inertial scheme (Bates et al. 2010 use 0.7). */
export const CFL = 0.7;
/** de Almeida et al. (2012) θ weighting of the momentum term (1 = no numerical diffusion). */
export const THETA = 0.9;
/** Froude limiter: the local-inertial approximation is not meant for supercritical flow. */
export const FROUDE_MAX = 1;
/** Upper bound on substeps per solver call (a safety net; the CFL normally needs 1–3). */
export const MAX_SUBSTEPS = 400;
/** Minimum bed slope assumed beyond an open edge (free outflow), m/m. */
export const OPEN_EDGE_SLOPE = 0.002;

/**
 * Infiltration: capacity rate = permeability × INFIL_RATE_FULL (mm/h) × scale, decreasing
 * linearly to 0 as the cumulative infiltrated depth reaches permeability × SOIL_STORAGE_FULL
 * (the soil column saturates). A simple bucket model, not Green–Ampt / Horton.
 *   grass 0.6 → 36 mm/h, storage 90 mm · sand 0.85 → 51 mm/h · asphalt 0.05 → 3 mm/h
 */
export const INFIL_RATE_FULL = 60; // mm/h at permeability 1
export const SOIL_STORAGE_FULL = 0.15; // m at permeability 1

/** Permeability of road objects (treated as asphalt for infiltration and drainage). */
export const ROAD_PERMEABILITY = GROUND_MATERIALS[3].permeability;
export const ROAD_MANNING = GROUND_MATERIALS[3].manning;

/** mm/h → m/s */
export const mmPerHour = (v: number) => v / 3.6e6;

/** Manning n per ground type id (with the roughness scale applied later). */
export const MANNING_BY_GROUND = GROUND_MATERIALS.map((g) => g.manning);
