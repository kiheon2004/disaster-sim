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
  sinkholePlug: m({
    id: 'sinkholePlug', labelKey: 'model.sinkholePlug', level: 'physics',
    assumptions: ['model.as.hiddenCavity', 'model.as.plugShear', 'model.as.bulkingChoke'], units: ['m', 'kPa', 's'],
    validRange: 'cavity radius 0.5–40 m, cover 1–60 m, soils (not rock roofs)',
    limitations: ['model.lim.noCavityChemistry', 'model.lim.heightfield', 'model.lim.notGeotechnical'], reference: 'docs/GROUND_FAILURE.md §5–8',
  }),
  cutStability: m({
    id: 'cutStability', labelKey: 'model.cutStability', level: 'physics',
    assumptions: ['model.as.culmann'], units: ['m', 'kPa', 'deg'], validRange: 'planar failure of steep walls (c–φ soils)',
    limitations: ['model.lim.notGeotechnical'], reference: 'docs/GROUND_FAILURE.md §8',
  }),
  infiniteSlope: m({
    id: 'infiniteSlope', labelKey: 'model.infiniteSlope', level: 'physics',
    assumptions: ['model.as.infiniteSlope', 'model.as.perchedWater'], units: ['m', 'kPa', 'deg'], validRange: 'shallow translational slides (depth ≪ length)',
    limitations: ['model.lim.noDeepSlides', 'model.lim.noSeepage', 'model.lim.notGeotechnical'], reference: 'docs/GROUND_FAILURE.md §11',
  }),
  newmark: m({
    id: 'newmark', labelKey: 'model.newmark', level: 'empirical',
    assumptions: ['model.as.rigidBlock', 'model.as.newmarkThreshold'], units: ['m', 'm/s²'], validRange: 'coherent shallow slides under strong shaking',
    limitations: ['model.lim.notGeotechnical'], reference: 'docs/GROUND_FAILURE.md §12',
  }),
  granularRunout: m({
    id: 'granularRunout', labelKey: 'model.granularRunout', level: 'empirical',
    assumptions: ['model.as.voellmy', 'model.as.massConservative', 'model.as.bulking'], units: ['m', 'm/s', 'kg'],
    validRange: '1 m grid, explicit; ξ and μ are calibration parameters',
    limitations: ['model.lim.noMultiphase', 'model.lim.noEntrainment', 'model.lim.heightfield'], reference: 'docs/GROUND_FAILURE.md §13–14',
  }),
  sedimentLoads: m({
    id: 'sedimentLoads', labelKey: 'model.sedimentLoads', level: 'empirical',
    assumptions: ['model.as.continuumLoad', 'model.as.earthPressure'], units: ['N', 'kPa'], validRange: 'one resultant per object',
    limitations: ['model.lim.noBoulders', 'model.lim.noSafety'], reference: 'docs/GROUND_FAILURE.md §16',
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
  impactEntry: m({
    id: 'impactEntry', labelKey: 'model.impactEntry', level: 'empirical',
    assumptions: ['model.as.exponentialAtmosphere', 'model.as.pancake', 'model.as.strengthDensity'], units: ['m/s', 'kg', 'km'],
    validRange: 'bodies ≲ 1 km, 1000–8000 kg/m³ (strength relation)', limitations: ['model.lim.noFragmentCascade', 'model.lim.noCraterField'], reference: 'docs/IMPACT.md §4 (Collins et al. 2005)',
  }),
  craterScaling: m({
    id: 'craterScaling', labelKey: 'model.craterScaling', level: 'empirical',
    assumptions: ['model.as.pointSource', 'model.as.verticalComponent', 'model.as.minRegime'], units: ['m', 'm³'],
    validRange: 'hypervelocity impacts; simple craters', limitations: ['model.lim.heightfield', 'model.lim.noElongation', 'model.lim.noMelt'], reference: 'docs/IMPACT.md §6 (Housen & Holsapple 2011)',
  }),
  ejectaBallistics: m({
    id: 'ejectaBallistics', labelKey: 'model.ejectaBallistics', level: 'empirical',
    assumptions: ['model.as.hh11Ejecta', 'model.as.parcels', 'model.as.fragmentDrag'], units: ['m/s', 'kg', 'm'],
    validRange: 'aggregated parcels (16 rings × 24 sectors)', limitations: ['model.lim.noCurtainShielding', 'model.lim.dustVisualOnly'], reference: 'docs/IMPACT.md §8',
  }),
  groundShock: m({
    id: 'groundShock', labelKey: 'model.groundShock', level: 'empirical',
    assumptions: ['model.as.seismicEfficiency', 'model.as.energyFlux', 'model.as.pulseBroadened'], units: ['m/s', 'g'],
    validRange: 'near field of the world (≤ 200 m)', limitations: ['model.lim.noWaveTypes', 'model.lim.noBlast'], reference: 'docs/IMPACT.md §10',
  }),
  blastWave: m({
    id: 'blastWave', labelKey: 'model.blastWave', level: 'physics',
    assumptions: ['model.as.pointRelease', 'model.as.sedov', 'model.as.weakShock', 'model.as.rankineHugoniot', 'model.as.groundImage'], units: ['Pa', 'Pa·s', 's', 'm'],
    validRange: 'weak shock Δp ≤ 0.3 p₀ (transition / strong zones approximate); energy 1 kJ – 1 TJ', limitations: ['model.lim.noCfd', 'model.lim.notExplosive', 'model.lim.noRefraction'], reference: 'docs/BLAST.md §5–8',
  }),
  blastLoading: m({
    id: 'blastLoading', labelKey: 'model.blastLoading', level: 'empirical',
    assumptions: ['model.as.boxFaces', 'model.as.reflectionClearing', 'model.as.blastDrag', 'model.as.partSdof'], units: ['Pa', 'N', 'N·s'],
    validRange: 'box-shaped objects; facade parts with a wind design', limitations: ['model.lim.boxShapes', 'model.lim.noPhysiology', 'model.lim.notEngineering'], reference: 'docs/BLAST.md §11–15',
  }),
  blastShielding: m({
    id: 'blastShielding', labelKey: 'model.blastShielding', level: 'empirical',
    assumptions: ['model.as.knifeEdge', 'model.as.maekawa'], units: ['dB', 's'],
    validRange: 'single dominant edge (terrain ridge / building), ≤ 20 dB', limitations: ['model.lim.noUrbanReflection'], reference: 'docs/BLAST.md §9',
  }),
  structureLoadPath: m({
    id: 'structureLoadPath', labelKey: 'model.structureLoadPath', level: 'empirical',
    assumptions: ['model.as.tributary', 'model.as.supportTiers', 'model.as.memberChecks', 'model.as.gsaDif', 'model.as.overstrength'], units: ['N', 'N·m', '—'],
    validRange: 'Phase 17 modular buildings (1–40 stories); gravity load paths; members as boxes', limitations: ['model.lim.noFea', 'model.lim.noCatenary', 'model.lim.noJointDetail', 'model.lim.notEngineering'], reference: 'docs/STRUCTURAL_DESTRUCTION.md §3–9',
  }),
  structureCollapse: m({
    id: 'structureCollapse', labelKey: 'model.structureCollapse', level: 'empirical',
    assumptions: ['model.as.freeFall', 'model.as.inelasticImpact', 'model.as.rigidPlastic', 'model.as.crushInPlace'], units: ['J', 'm/s', 'kg'],
    validRange: 'floors falling onto floors inside the plan; rigid blocks without rotation', limitations: ['model.lim.noRotation', 'model.lim.noCrushUp', 'model.lim.notEngineering'], reference: 'docs/STRUCTURAL_DESTRUCTION.md §9–13',
  }),
  rubblePile: m({
    id: 'rubblePile', labelKey: 'model.rubblePile', level: 'empirical',
    assumptions: ['model.as.bulking', 'model.as.repose'], units: ['kg', 'm³', 'm'],
    validRange: 'mass exact; mound shape approximate', limitations: ['model.lim.pileShape', 'model.lim.noWaterObstacle'], reference: 'docs/STRUCTURAL_DESTRUCTION.md §16–17',
  }),
  collapseDust: m({
    id: 'collapseDust', labelKey: 'model.collapseDust', level: 'visual',
    assumptions: [], units: [], validRange: '—', limitations: ['model.lim.visualOnly'], reference: 'docs/STRUCTURAL_DESTRUCTION.md §24',
  }),
  heatTransfer: m({
    id: 'heatTransfer', labelKey: 'model.heatTransfer', level: 'physics',
    assumptions: ['model.as.lumpedNodes', 'model.as.groundColumns', 'model.as.convectionCorrelations', 'model.as.grayRadiation', 'model.as.airLayer', 'model.as.waterTracer'],
    units: ['K', 'J', 'W', 'W/m²'], validRange: 'material data 20–1200 °C (codes) / near room temperature (handbook values); wind function ≤ 7 m/s',
    limitations: ['model.lim.noCfd', 'model.lim.noPhaseChange', 'model.lim.noViewFactors', 'model.lim.noCombustion'], reference: 'docs/THERMAL_PHYSICS.md §5–17',
  }),
  thermalStructure: m({
    id: 'thermalStructure', labelKey: 'model.thermalStructure', level: 'empirical',
    assumptions: ['model.as.enReduction', 'model.as.zoneAverage', 'model.as.restraintStiffness'],
    units: ['K', 'N', '—'], validRange: 'steel / concrete 20–1200 °C, timber 20–300 °C (EN 1993/1992/1995-1-2); masonry, glass: no reduction',
    limitations: ['model.lim.notFireDesign', 'model.lim.uniaxial', 'model.lim.notEngineering'], reference: 'docs/THERMAL_PHYSICS.md §19–22',
  }),
};

export function modelInfo(id: string): ModelInfo | undefined {
  return MODELS[id];
}
