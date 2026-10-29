/**
 * Scientific model catalog (Phase 15): every calculation that produces a number shown to the
 * user is listed here with its level, assumptions, units, valid range, limitations and where it
 * is documented. None is validated against measurements (`validated: false`), and the UI says
 * so next to the results.
 */
import type { ModelInfo } from './types';

const m = (x: Omit<ModelInfo, 'validated'>): ModelInfo => ({ ...x, validated: false });

export const MODELS: Record<string, ModelInfo> = {
  windLoad: m({
    id: 'windLoad', labelKey: 'model.windLoad', level: 'physics',
    assumptions: ['model.as.quasiSteadyDrag', 'model.as.powerLawProfile'],
    units: ['m/s', 'N'], validRange: '0–150 m/s', limitations: ['model.lim.noCfd', 'model.lim.boxShapes'], reference: 'README.md §Phase 3–5',
  }),
  spatialWind: m({
    id: 'spatialWind', labelKey: 'model.spatialWind', level: 'empirical',
    assumptions: ['model.as.wakeBoxes', 'model.as.seededTurbulence'],
    units: ['m/s'], validRange: '0–150 m/s', limitations: ['model.lim.noCfd'], reference: 'README.md §Phase 8–10',
  }),
  windDamage: m({
    id: 'windDamage', labelKey: 'model.windDamage', level: 'empirical',
    assumptions: ['model.as.fatigue', 'model.as.designWind'],
    units: ['load ratio'], validRange: 'load ratio 0–3', limitations: ['model.lim.notEngineering'], reference: 'src/simulation/damage/fatigue.ts',
  }),
  groundMotion: m({
    id: 'groundMotion', labelKey: 'model.groundMotion', level: 'empirical',
    assumptions: ['model.as.syntheticWaveform', 'model.as.siteTransfer'],
    units: ['g', 'Hz', 's'], validRange: 'M 3–9.5, PGA 0.01–2 g', limitations: ['model.lim.notRecorded'], reference: 'docs/EARTHQUAKE.md §2–3',
  }),
  structural: m({
    id: 'structural', labelKey: 'model.structural', level: 'physics',
    assumptions: ['model.as.shearChain', 'model.as.bilinear'],
    units: ['drift %', 'g', 'N'], validRange: '1–5 lumped stories', limitations: ['model.lim.noTorsion', 'model.lim.notEngineering'], reference: 'docs/EARTHQUAKE.md §5–6',
  }),
  water: m({
    id: 'water', labelKey: 'model.water', level: 'physics',
    assumptions: ['model.as.localInertial', 'model.as.manning'],
    units: ['m', 'm/s', 'm³'], validRange: 'subcritical flow, 1 m grid', limitations: ['model.lim.noSupercritical', 'model.lim.noSewer'], reference: 'docs/FLOOD.md §3–5',
  }),
  infiltration: m({
    id: 'infiltration', labelKey: 'model.infiltration', level: 'empirical',
    assumptions: ['model.as.bucket'], units: ['mm/h', 'mm'], validRange: '0–500 mm/h', limitations: ['model.lim.noGroundwater'], reference: 'docs/FLOOD.md §7',
  }),
  buoyancy: m({
    id: 'buoyancy', labelKey: 'model.buoyancy', level: 'physics',
    assumptions: ['model.as.boxVolume', 'model.as.quasiSteadyDrag'],
    units: ['N', 'm³'], validRange: 'depth 0–10 m, flow 0–5 m/s', limitations: ['model.lim.noDisplacement'], reference: 'docs/FLOOD.md §9',
  }),
  floodDamage: m({
    id: 'floodDamage', labelKey: 'model.floodDamage', level: 'empirical',
    assumptions: ['model.as.depthDamage', 'model.as.capacityRatio'],
    units: ['m', 's', 'N'], validRange: 'depth 0–10 m', limitations: ['model.lim.notEngineering', 'model.lim.noSafety'], reference: 'docs/FLOOD.md §9',
  }),
  // ── Terrain deformation (Phase 21) ──
  terrainDeformation: m({
    id: 'terrainDeformation', labelKey: 'model.terrainDeformation', level: 'hypothetical',
    assumptions: ['model.as.prescribedField', 'model.as.superposition'],
    units: ['m', 's'], validRange: '|w| ≤ 30 m, radius 2–150 m', limitations: ['model.lim.noFailureMechanism', 'model.lim.heightfield'], reference: 'docs/TERRAIN_DEFORMATION.md §3–6',
  }),
  bedDisplacement: m({
    id: 'bedDisplacement', labelKey: 'model.bedDisplacement', level: 'physics',
    assumptions: ['model.as.depthPreserving'], units: ['m', 'm³'], validRange: 'bed motion slow vs. gravity waves',
    limitations: ['model.lim.noVerticalMomentum'], reference: 'docs/TERRAIN_DEFORMATION.md §12',
  }),
  foundationSettlement: m({
    id: 'foundationSettlement', labelKey: 'model.foundationSettlement', level: 'empirical',
    assumptions: ['model.as.rigidFoundation', 'model.as.angularDistortion'], units: ['m', 'rad'], validRange: 'β 0–1/50',
    limitations: ['model.lim.notGeotechnical', 'model.lim.noSafety'], reference: 'docs/TERRAIN_DEFORMATION.md §10',
  }),
  roadDeformation: m({
    id: 'roadDeformation', labelKey: 'model.roadDeformation', level: 'empirical',
    assumptions: ['model.as.roadOffset'], units: ['m', '%'], validRange: 'samples every 5 m',
    limitations: ['model.lim.notEngineering'], reference: 'docs/TERRAIN_DEFORMATION.md §11',
  }),
  // ── Multi-hazard interactions (Phase 15) ──
  windStress: m({
    id: 'windStress', labelKey: 'model.windStress', level: 'empirical',
    assumptions: ['model.as.dragCoefficientSea'], units: ['Pa', 'm/s'], validRange: 'U10 0–60 m/s',
    limitations: ['model.lim.noWaves'], reference: 'docs/PHENOMENA.md §6',
  }),
  waterInertia: m({
    id: 'waterInertia', labelKey: 'model.waterInertia', level: 'physics',
    assumptions: ['model.as.groundFrame', 'model.as.impulsePerCall'], units: ['m/s'], validRange: 'any PGA',
    limitations: ['model.lim.lowPass10Hz'], reference: 'docs/PHENOMENA.md §6',
  }),
  residualStrength: m({
    id: 'residualStrength', labelKey: 'model.residualStrength', level: 'empirical',
    assumptions: ['model.as.sameDegradationLaw', 'model.as.envelopeNotSum'], units: ['× capacity'], validRange: 'damage index 0–1',
    limitations: ['model.lim.notEngineering'], reference: 'docs/PHENOMENA.md §7',
  }),
  saturatedBearing: m({
    id: 'saturatedBearing', labelKey: 'model.saturatedBearing', level: 'empirical',
    assumptions: ['model.as.waterTableCorrection'], units: ['kPa'], validRange: 'saturation 0–1',
    limitations: ['model.lim.noLiquefaction'], reference: 'docs/PHENOMENA.md §6',
  }),
  combinedStructuralLoad: m({
    id: 'combinedStructuralLoad', labelKey: 'model.combinedStructuralLoad', level: 'physics',
    assumptions: ['model.as.windOnTopDof'], units: ['N'], validRange: 'during shaking',
    limitations: ['model.lim.rampAtStart'], reference: 'docs/PHENOMENA.md §6',
  }),
  // ── Visual only ──
  weatherVisuals: m({
    id: 'weatherVisuals', labelKey: 'model.weatherVisuals', level: 'visual',
    assumptions: [], units: [], validRange: '—', limitations: ['model.lim.visualOnly'], reference: 'src/rendering/sim/environment',
  }),
  exposure: m({
    id: 'exposure', labelKey: 'model.exposure', level: 'empirical',
    assumptions: ['model.as.baselineAtmosphere'], units: ['m', 'm/s', 'g', 'kPa', '°C'], validRange: '—',
    limitations: ['model.lim.noPhysiology', 'model.lim.noSafety'], reference: 'docs/PHENOMENA.md §8',
  }),
};

export function modelInfo(id: string): ModelInfo | undefined {
  return MODELS[id];
}
