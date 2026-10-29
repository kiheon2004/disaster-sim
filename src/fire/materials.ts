/**
 * Fuel materials (Phase 27) — REPRESENTATIVE literature values for a reduced combustion model, not
 * the composition or certified fire performance of any product. Materials not listed are not fuels
 * (concrete, steel, glass, masonry, metal cladding, soil, rock, water; vehicles are not modelled as
 * fuel). Full table with ranges: docs/FIRE_COMBUSTION.md §4.
 *
 * Sources:
 *   [TEW]  Tewarson, "Generation of heat and gaseous, liquid and solid products in fires", SFPE
 *          Handbook — wood: effective heat of combustion ≈ 12–13 MJ/kg (12.4 used), heat of
 *          gasification ≈ 1.8 MJ/kg, smoke (soot) yield ≈ 0.015, radiative fraction 0.3–0.4
 *   [BAB]  Babrauskas, Ignition Handbook (2003) — wood: piloted ignition surface temperature
 *          300–400 °C (350 used), critical flux for piloted ignition 10–13 kW/m² (12 used),
 *          autoignition (no pilot) surface ≥ 500 °C at ≥ 25 kW/m² radiant; pyrolysis from ≈ 200 °C
 *   [QUI]  Quintiere, Fundamentals of Fire Phenomena (2006) ch. 7 — thermally thick ignition
 *          t_ig = (π/4)·kρc·((T_ig − T₀)/q″)², wood kρc ≈ 0.2–0.9 (kW/(m²K))²s (0.25 used)
 *   [FTP]  flux–time product FTP = ∫(q″ − q″_cr)ⁿ dt with n = 2 for thermally thick solids
 *          (Toal, Silcock & Shields 1989; Spearpoint & Quintiere 2001) — ignition when FTP reaches
 *          (π/4)·kρc·(T_ig − T₀)², the same constant as the closed-form t_ig
 *   [EN5]  EN 1995-1-2 §3.4: one-dimensional charring rate of softwood β₀ = 0.65 mm/min, zero-
 *          strength layer d₀ = 7 mm (reduced cross-section method, k₀ ramps over the first 20 min)
 *   [EN1]  EN 1991-1-2 Annex E: fire load densities (mean: dwelling 780, office 420, library
 *          1500 MJ/m²), net calorific value of cellulosic material 17.5 MJ/kg, combustion factor
 *          0.8, t² growth (dwelling / office medium t_α = 300 s, library fast 150 s), RHR_f 250 kW/m²
 *          (dwelling / office) and 500 kW/m² (library), decay once 70 % of the fire load is consumed
 *   [ROT]  Rothermel (1972): heat content of wildland fuels 18.6 MJ/kg (8000 Btu/lb)
 *   [AND]  Anderson (1969): flame residence time τ = 384/σ min (σ surface-to-volume ratio, 1/ft);
 *          broadleaf / needle foliage σ ≈ 1500–2500 /ft → 9–15 s (15 used)
 *   [RAS]  critical mass-loss rate for sustained flaming of wood 2–4 g/(m²·s) (Rasbash 1986;
 *          Emberley et al. 2017 for timber ≈ 3.5) — 3.5 used
 *   [MLR]  peak mass-loss rates of wood in heat-release calorimeters at 50–75 kW/m² ≈ 8–15 g/(m²·s)
 *          right after ignition, falling as the char layer forms (Babrauskas, SFPE Handbook "Heat
 *          release rates"; Tran & White 1992) — 12 used for the char-free surface; once charred the
 *          rate is capped by the charring front: (1 − char yield)·ρ·β with β = 1.5·β₀, the upper
 *          bound of the EN 1995-1-2 Annex A parametric charring rate (≈ 5.5 g/(m²·s))
 *   [HUG]  Huggett (1980): 13.1 MJ released per kg of O₂ consumed (oxygen-consumption principle)
 *   [QFL]  wall / pool flame heat flux to the burning surface 20–30 kW/m² for small flames
 *          (Quintiere 2006 ch. 9) — 25 used; a burning char surface (500–600 °C, 550 used) re-radiates
 *          εσT⁴ ≈ 23 kW/m², so a lone timber surface without outside heat cannot keep flaming
 *          (ṁ″ ≈ 1 g/(m²·s) < 3.5) — the known need of wood for mutual / external radiation
 */

export const FM = { timber: 0, greenWood: 1, foliage: 2, contents: 3 } as const;
export type FuelMaterialId = keyof typeof FM;
export const FUEL_IDS = Object.keys(FM) as FuelMaterialId[];

export interface FuelMaterial {
  id: FuelMaterialId;
  /** Effective heat of combustion (J per kg of fuel consumed). */
  dHc: number;
  /** Thin fuel (its node temperature is its surface temperature; burns in a residence time / design fire). */
  thin: boolean;
  /** Piloted ignition surface temperature (K) and critical incident flux (W/m²). */
  Tig: number;
  qcr: number;
  /** Autoignition (no pilot flame) surface temperature (K) and critical incident flux (W/m²). */
  Tauto: number;
  qcrAuto: number;
  /** Thermal inertia kρc of thick fuels (W²·s/(m⁴·K²)), for the flux–time product. */
  kpc: number;
  /** Onset of pyrolysis (K). */
  Tpyro: number;
  /** Heat of gasification (J/kg). */
  Lg: number;
  /** Flame heat flux back to its own burning surface (W/m²). */
  qFlame: number;
  /** Surface temperature of a burning (charring) surface — its re-radiation loss (K). */
  Tburn: number;
  /** Largest mass-loss rate per burning area (kg/(m²·s)) of a char-free surface, the cap once a char layer exists, and the extinction limit. */
  mMax: number;
  mChar: number;
  mCrit: number;
  /** Char left per kg of solid consumed by the charring front (thick fuels). */
  charYield: number;
  /** Dry density of the solid (kg/m³) — char depth. */
  density: number;
  /** Flame residence time of thin fuels (s). */
  residence: number;
  /** Radiative fraction of the heat release. */
  chiR: number;
  /** Smoke (soot) yield, kg per kg of fuel consumed. */
  ys: number;
  source: string;
}

const C2K = (c: number) => c + 273.15;
/** EN 1995-1-2 softwood design charring rate (m/s) and zero-strength layer (m). */
export const CHAR_RATE = 0.65e-3 / 60;
export const ZERO_STRENGTH_LAYER = 0.007;
/** Time over which the zero-strength layer builds up (EN 1995-1-2 Table 4.1, unprotected: 20 min). */
export const ZERO_STRENGTH_TIME = 1200;

const wood = {
  dHc: 12.4e6, thin: false, Tig: C2K(350), qcr: 12e3, Tauto: C2K(500), qcrAuto: 25e3, kpc: 2.5e5, Tpyro: C2K(200),
  Lg: 1.8e6, qFlame: 25e3, Tburn: C2K(550), mMax: 12e-3, mChar: 0.75 * 450 * 1.5 * CHAR_RATE, mCrit: 3.5e-3, charYield: 0.25, residence: 0, chiR: 0.35, ys: 0.015,
};

export const FUEL_MATERIALS: readonly FuelMaterial[] = [
  { id: 'timber', ...wood, density: 450, source: 'TEW (ΔHc, Lg, ys, χr), BAB (T_ig, q_cr), QUI (kρc), EN 1995-1-2 (β₀, d₀), RAS (extinction), MLR (cap), QFL' },
  { id: 'greenWood', ...wood, density: 450, source: 'tree trunks: the wood values; their moisture must be driven off first' },
  {
    id: 'foliage', dHc: 18.6e6, thin: true, Tig: C2K(300), qcr: 12e3, Tauto: C2K(450), qcrAuto: 25e3, kpc: 0, Tpyro: C2K(200), Lg: 0, qFlame: 0, Tburn: 0,
    mMax: 0, mChar: 0, mCrit: 0, charYield: 0, density: 0, residence: 15, chiR: 0.3, ys: 0.015,
    source: 'ROT (heat content, heat of pre-ignition), AND (residence time), BAB (ignition 300 °C piloted / 450 °C auto); critical fluxes as wood (stated); live moisture from the world setting',
  },
  {
    id: 'contents', dHc: 0.8 * 17.5e6, thin: true, Tig: C2K(300), qcr: 12e3, Tauto: C2K(500), qcrAuto: 20e3, kpc: 0, Tpyro: C2K(200), Lg: 0, qFlame: 0, Tburn: 0,
    mMax: 0, mChar: 0, mCrit: 0, charYield: 0, density: 0, residence: 0, chiR: 0.35, ys: 0.05,
    source: 'EN 1991-1-2 Annex E (17.5 MJ/kg × 0.8, fire load, growth, RHR_f, decay at 70 %); furnishings smoke yield 0.02–0.1 (0.05 used); 20 kW/m² flashover criterion',
  },
];

export const fuel = (i: number) => FUEL_MATERIALS[i];

/** Flux–time product a thick fuel needs to ignite: (π/4)·kρc·(T − T₀)² (W²·s/m⁴). */
export const ftpCritical = (m: FuelMaterial, T: number, T0: number) => (Math.PI / 4) * m.kpc * Math.max(0, T - T0) ** 2;

/** EN 1991-1-2 Annex E design-fire inputs per occupancy. */
export interface ContentsFire {
  /** Mean fire load density, J per m² of floor. */
  qf: number;
  /** Time for the t² growth to reach 1 MW (s). */
  tAlpha: number;
  /** Maximum heat release rate per m² of floor (W/m²). */
  rhrf: number;
  source: string;
}

export const CONTENTS_FIRE: Record<string, ContentsFire | null> = {
  residential: { qf: 780e6, tAlpha: 300, rhrf: 250e3, source: 'EN 1991-1-2 Tables E.4 / E.5: dwelling' },
  office: { qf: 420e6, tAlpha: 300, rhrf: 250e3, source: 'EN 1991-1-2 Tables E.4 / E.5: office' },
  // No storage row in Annex E: the library row (stacked paper) stands in (stated in the editor).
  storage: { qf: 1500e6, tAlpha: 150, rhrf: 500e3, source: 'EN 1991-1-2 Tables E.4 / E.5: library (stand-in for storage)' },
  // No adopted reference value for industrial occupancies: no contents fuel (structure fuels only).
  industrial: null,
};

/** Share of the fire load consumed when the design fire starts to decay (EN 1991-1-2 E.4). */
export const DECAY_AT = 0.7;

/** Oxygen. */
export const Y_O2_AIR = 0.232;
/** Energy released per kg of O₂ consumed (Huggett 1980). */
export const E_O2 = 13.1e6;
/** O₂ mass fraction below which flaming cannot be sustained (limiting O₂ ≈ 12–15 vol % → 0.13–0.16 by mass; 0.14 used). */
export const Y_O2_LIMIT = 0.14;
/** Latent heat of vaporization of water at 100 °C (J/kg). */
export const L_WATER = 2.257e6;
/** Mass-specific extinction coefficient of flaming soot, visible light (m²/kg; Mulholland & Croarkin 2000: 8.7 m²/g). */
export const SOOT_EXTINCTION = 8700;
/** Visibility of a light-reflecting sign S = 3 / K (Jin). */
export const VISIBILITY_C = 3;
/** Soot density (kg/m³) and the Tien relation κ = 1862·f_v·T (1/m) for the gray absorption coefficient of a sooty gas. */
export const SOOT_DENSITY = 1800;
export const SOOT_KAPPA = 1862;
/** Floor-level incident flux that ignites everything in a room — the 20 kW/m² flashover criterion. */
export const FLASHOVER_FLUX = 20e3;
/** Hot-gas temperature criterion of flashover (500–600 °C; 550 used). */
export const FLASHOVER_T = 273.15 + 550;
/** Window glass cracks when the pane is this much hotter than ambient (K; Keski-Rahkonen 1988: 58–80 K, 70 used). */
export const GLASS_BREAK_DT = 70;
/** Discharge coefficient of openings (0.6–0.7; 0.7 used) — Rockett (1976) vent flow. */
export const CD_OPENING = 0.7;
/** Upward / lateral flame spread over a burning solid — involvement grows at this speed along it (m/s; concurrent flow spread on wood 0.5–5 cm/s; 1 cm/s used). */
export const SPREAD_SPEED = 0.01;
/** Crown bulk density of fine fuel inside an individual crown (kg/m³) — stated assumption (stand values 0.05–0.3, Scott & Reinhardt 2001). */
export const CROWN_DENSITY = 0.5;
/** Live foliage moisture of the thermal model (Phase 26 foliage node, 150 %). */
export const FOLIAGE_MOISTURE = 1.5;
/**
 * Moisture of extinction of fine fuels (kg water / kg dry fuel): above it a fine fuel neither ignites
 * nor keeps flaming (Rothermel 1972 fuel models: 0.12–0.40; 0.30 used). Live foliage (≈ 1–1.5) must
 * first be dried by heating (its water evaporates at 100 °C) before it can ignite.
 */
export const MOISTURE_EXTINCTION = 0.3;
/** Water a crown can hold from rain, as moisture content (stated cap). */
export const MOISTURE_MAX = 2.5;
/** Char depth over which the char-free peak burning rate falls to the charring-front cap (m; stated: a few mm of char). */
export const CHAR_INSULATION = 0.003;

/**
 * Thermally thin fine fuel (foliage): exposed elements ignite when the flux–time product with n = 1,
 * ∫(q″ − q″_cr) dt, reaches the energy that brings their mass per surface area to ignition —
 * ρ_p/σ · Q_ig with Rothermel's heat of pre-ignition Q_ig = 581 + 2594·M kJ/kg (250 + 1116·M Btu/lb;
 * Rothermel 1972, M = moisture fraction), particle density ρ_p = 513 kg/m³ (32 lb/ft³) and the
 * foliage surface-to-volume ratio σ = 1500 /ft = 4921 /m (Anderson 1969 range).
 */
export const FOLIAGE_MASS_AREA = 513 / 4921;
export const preIgnitionHeat = (moisture: number) => 581e3 + 2594e3 * Math.max(0, moisture);
export const thinFtpCritical = (moisture: number) => FOLIAGE_MASS_AREA * preIgnitionHeat(moisture);
/** Speed at which flames climb through a dry crown (m/s; NIST Douglas-fir burns: a 5 m crown fully involved in ≈ 10 s — stated). */
export const CROWN_SPREAD = 0.5;
