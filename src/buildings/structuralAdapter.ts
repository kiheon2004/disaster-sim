/**
 * Adapter: member-based analysis → the existing lumped structural model (Phase 13 StructuralModel).
 *
 * Stories are lumped into ≤ MAX_DOF dofs: one dof per story up to 5 stories; taller buildings
 * keep the ground story on its own (soft ground stories stay visible) and split the rest into 4
 * contiguous groups. A group's stiffness is its stories in series (1/k = Σ 1/kᵢ), its yield shear
 * the weakest story's, its mass the sum. Story drifts are reconstructed from the group drift by
 * each story's share of the group flexibility.
 */
import type { SeismicProperties, StructuralSystem } from '@/core/model';
import { MAX_DOF, chainOmega } from '@/simulation/seismic/StructuralModel';
import { STRUCTURAL_SYSTEMS, COLLAPSE_FACTOR, type DriftThresholds } from '@/simulation/seismic/structuralProps';
import type { BuildingAnalysis } from './analysis';

export interface StoryLumps {
  /** Dof (1-based) of each story. */
  dof: Int32Array;
  /** First story of each dof (index dof−1). */
  first: number[];
  /** Flexibility share of each story inside its group, per axis: [x0, z0, x1, z1, …]. */
  share: Float64Array;
  mass: number[];
  height: number[];
  kx: number[];
  kz: number[];
  fyX: number[];
  fyZ: number[];
}

/** Group sizes: ≤ 5 stories one each; else ground story alone + 4 even groups. */
export function groupSizes(floors: number): number[] {
  if (floors <= MAX_DOF) return Array.from({ length: floors }, () => 1);
  const rest = floors - 1;
  const g = MAX_DOF - 1;
  const base = Math.floor(rest / g);
  const extra = rest % g;
  return [1, ...Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0))];
}

/**
 * Lump story properties (current stiffness / strength per story, e.g. after failures) into dofs.
 * `kx` / `kz` / `vx` / `vz` are per story.
 */
export function lumpStories(mass: readonly number[], height: readonly number[], kx: readonly number[], kz: readonly number[], vx: readonly number[], vz: readonly number[]): StoryLumps {
  const floors = mass.length;
  const sizes = groupSizes(floors);
  const out: StoryLumps = { dof: new Int32Array(floors), first: [], share: new Float64Array(2 * floors), mass: [], height: [], kx: [], kz: [], fyX: [], fyZ: [] };
  let s = 0;
  sizes.forEach((size, gi) => {
    out.first.push(s);
    let m = 0, h = 0, fx = 0, fz = 0, vX = Infinity, vZ = Infinity;
    for (let i = s; i < s + size; i++) {
      out.dof[i] = gi + 1;
      m += mass[i];
      h += height[i];
      fx += 1 / Math.max(1, kx[i]);
      fz += 1 / Math.max(1, kz[i]);
      vX = Math.min(vX, vx[i]);
      vZ = Math.min(vZ, vz[i]);
    }
    for (let i = s; i < s + size; i++) {
      out.share[2 * i] = 1 / Math.max(1, kx[i]) / fx;
      out.share[2 * i + 1] = 1 / Math.max(1, kz[i]) / fz;
    }
    out.mass.push(m);
    out.height.push(h);
    out.kx.push(1 / fx);
    out.kz.push(1 / fz);
    out.fyX.push(Math.max(1, vX));
    out.fyZ.push(Math.max(1, vZ));
    s += size;
  });
  return out;
}

export interface ModularUnit {
  lumps: StoryLumps;
  /** Stiffness multipliers applied per axis (code-band calibration × user factor × period override). */
  kScale: [number, number];
  fyScale: number;
  dampingRatio: number;
  hardening: number;
  driftU: number;
  thresholds: DriftThresholds;
  /** Fixed-base periods of the lumped model (s). */
  period: [number, number];
  system: StructuralSystem;
}

/** Drift thresholds of the dominant system, scaled to the member-based collapse drift. */
export function modularThresholds(system: StructuralSystem, driftU: number): DriftThresholds {
  const d = STRUCTURAL_SYSTEMS[system].drift;
  const f = driftU / (d.complete * COLLAPSE_FACTOR);
  return { slight: d.slight * f, moderate: d.moderate * f, extensive: d.extensive * f, complete: d.complete * f };
}

/** Structural unit of a modular building from its analysis + the (inspector) seismic factors. */
export function modularUnit(a: BuildingAnalysis, seismic: SeismicProperties | undefined): ModularUnit {
  const st = a.stories;
  const lumps = lumpStories(st.map((s) => s.mass), st.map((s) => s.height), st.map((s) => s.kx), st.map((s) => s.kz), st.map((s) => s.vx), st.map((s) => s.vz));
  const sf = seismic?.structure.stiffnessFactor ?? 1;
  const kScale: [number, number] = [a.calibration[0] * sf, a.calibration[1] * sf];
  let kx = lumps.kx.map((v) => v * kScale[0]);
  let kz = lumps.kz.map((v) => v * kScale[1]);
  let period: [number, number] = [2 * Math.PI / chainOmega(lumps.mass, kx), 2 * Math.PI / chainOmega(lumps.mass, kz)];
  const override = seismic?.structure.periodOverride ?? 0;
  if (override > 0) {
    // User period override: scale each direction's stiffness to that period.
    const fx = (period[0] / override) ** 2;
    const fz = (period[1] / override) ** 2;
    kScale[0] *= fx;
    kScale[1] *= fz;
    kx = kx.map((v) => v * fx);
    kz = kz.map((v) => v * fz);
    period = [override, override];
  }
  const fyScale = seismic?.structure.strengthFactor ?? 1;
  lumps.kx = kx;
  lumps.kz = kz;
  lumps.fyX = lumps.fyX.map((v) => v * fyScale);
  lumps.fyZ = lumps.fyZ.map((v) => v * fyScale);
  const driftU = Math.max(0.004, Math.min(...st.map((s) => s.driftU || 0.02)));
  return {
    lumps, kScale, fyScale, dampingRatio: seismic?.structure.dampingRatio ?? a.damping, hardening: a.hardening, driftU,
    thresholds: modularThresholds(a.system, driftU), period, system: a.system,
  };
}
