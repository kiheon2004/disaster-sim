/**
 * Structure of the runtime state of a run (Phase 22, residual 2.3 of Phase 21).
 *
 * Saving writes the DOCUMENT only — the original world and the experiment plan (v7). The
 * simulation never writes the document, so a saved project always restarts from t = 0 on the
 * original world. Mid-run saving (a snapshot to resume a run later) is NOT supported; this module
 * lists, per component, what such a snapshot would have to contain, so that it can be added
 * later without guessing where state lives:
 *
 *   kind        meaning for a future mid-run snapshot
 *   document    already in the saved file (re-created by a rebuild)
 *   derived     re-computable from the document + the state below (not saved)
 *   state       must be saved: evolves with the run and cannot be re-derived
 *   external    owned by an external engine (Rapier bodies): needs that engine's snapshot API
 *
 * `runtimeStateManifest()` measures the components of a live run (sizes in bytes of the typed
 * arrays); it is exercised by a test so new state added to a channel shows up here.
 */
import type { EnvironmentState } from './environment/EnvironmentState';
import type { SimulationRuntime } from './SimulationRuntime';

export type RuntimeStateKind = 'document' | 'derived' | 'state' | 'external';

export interface RuntimeStateComponent {
  id: string;
  owner: string;
  kind: RuntimeStateKind;
  /** What it holds (developer description). */
  holds: string;
  /** Present in this run. */
  present: boolean;
  /** Approximate size (bytes of typed arrays / entries), 0 when not measured. */
  bytes: number;
}

const bytesOf = (...a: (ArrayBufferView | null | undefined)[]) => a.reduce((s, x) => s + (x?.byteLength ?? 0), 0);

export function runtimeStateManifest(env: EnvironmentState, rt: SimulationRuntime | null, time: number): RuntimeStateComponent[] {
  const gf = env.groundFailure.field;
  const eng = env.deformation.engine;
  const flood = env.flood.field;
  const out: RuntimeStateComponent[] = [
    { id: 'clock', owner: 'SimulationController', kind: 'state', holds: `time ${time.toFixed(2)} s, step index, RNG states (simulation / fx)`, present: true, bytes: 32 },
    { id: 'document', owner: 'worldStore', kind: 'document', holds: 'original world + experiment plan (saved file, v7)', present: true, bytes: 0 },
    { id: 'events', owner: 'EventScheduler', kind: 'derived', holds: 'event instances re-created from the plan; their internal progress is a function of time', present: true, bytes: 0 },
    {
      id: 'entities', owner: 'SimulationRuntime', kind: 'state', holds: 'per-object pose, health, damage state and per-hazard sub-states (wind fatigue, seismic, flood, ground)',
      present: !!rt, bytes: rt ? rt.entities.size * 512 : 0,
    },
    { id: 'debris', owner: 'SimulationRuntime', kind: 'state', holds: 'debris pieces, particles, counters', present: !!rt, bytes: rt ? rt.debris.length * 128 : 0 },
    { id: 'bodies', owner: 'Rapier', kind: 'external', holds: 'rigid bodies, contacts, solver warm-start (needs a Rapier world snapshot)', present: !!rt, bytes: 0 },
    { id: 'roads', owner: 'RoadRuntime', kind: 'state', holds: 'surface damage, inundation, deformation / debris state of each segment', present: !!rt?.roads, bytes: rt?.roads ? rt.roads.segments.length * 64 : 0 },
    { id: 'water', owner: 'FloodEnvironment', kind: 'state', holds: 'water depth / face fluxes / infiltration / bed motion of the water grid', present: !!flood, bytes: flood ? bytesOf(flood.h, flood.qx, flood.qz) : 0 },
    {
      id: 'deformation', owner: 'DeformationEngine', kind: 'derived',
      holds: 'runtime terrain copy, W field, history; prescribed sources are a function of time, the ground-failure source is the field below',
      present: !!eng, bytes: eng ? bytesOf(eng.field, eng.original, eng.terrain.heights) : 0,
    },
    {
      id: 'groundFailure', owner: 'GroundFailureChannel', kind: 'state',
      holds: 'geotechnical field (thickness, water rise, bed, loose deposits, mobile layer, fluxes, FS, Newmark, failed / owner flags), sediment budget, model phases (sinkhole a / phase / drop applied; landslide failures)',
      present: !!gf,
      bytes: gf ? bytesOf(gf.material, gf.thickness, gf.water0, gf.waterRise, gf.strength, gf.bed, gf.loose, gf.looseMass, gf.h, gf.mass, gf.mu, gf.qx, gf.qz, gf.hfx, gf.hfz, gf.rest, gf.fs, gf.nmV, gf.nmD, gf.owner, gf.evaluate, gf.failed) : 0,
    },
    { id: 'metrics', owner: 'MetricsRecorder', kind: 'state', holds: 'damage records, time series, milestones (results)', present: true, bytes: 0 },
  ];
  return out;
}
