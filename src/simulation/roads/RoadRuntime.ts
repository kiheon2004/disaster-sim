/**
 * Roads in the simulation (Phase 18).
 *
 * The road SURFACE is part of the frozen terrain (baked heights + ground types): the terrain
 * collider, contact friction (GroundContactSystem, Phase 14), the water bed, infiltration and
 * Manning roughness all see it without any road-specific code — roads never fly or move.
 *
 * What roads add at runtime is their own state, one record per segment, sampled every
 * SAMPLE_SPACING m along the centerline:
 *  - earthquake: surface cracking when the local peak ground velocity exceeds the material's
 *    threshold (ROAD_MATERIAL_PROPS.quakeCrackPgv) — an empirical-style indicator, not a
 *    pavement model; ground failure (liquefaction, lateral spreading, fault offset) is the main
 *    real cause of severe road damage and plugs in through `groundFailure` (Phase 21 hook);
 *  - flood: water depth at the gutters and at the crown. Graded roads shed rain to the curbs
 *    (crown cross-fall), so street flooding starts in the gutters: ≥ 0.15 m anywhere on the
 *    carriageway (a full curb) = inundated; ≥ 0.3 m over the CROWN = impassable for cars (the
 *    same thresholds as the legacy road objects); scour in fast flow above the material's
 *    scourSpeed;
 *  - drainage: storm-drain inlets along the curbs, handed to the water model as sub-grid sinks
 *    (capacity per inlet INLET_CAPACITY, spread over the 1 m cell that contains the inlet).
 *
 * State is deterministic (no randomness) and lives only in the simulation — the original road
 * network is never modified.
 */
import type { RoadNetwork, RoadMaterial } from '@/roads/types';
import { segmentLine } from '@/roads/network';
import { pointAt } from '@/roads/curve';
import { DRAIN_SPACING, INLET_CAPACITY, ROAD_MATERIAL_PROPS } from '@/roads/materials';

export const SAMPLE_SPACING = 5;
/** Flood depth thresholds (m): inundated / impassable (same as legacy road objects). */
export const ROAD_INUNDATED = 0.15;
export const ROAD_IMPASSABLE = 0.3;
/** Crack index at which a road counts as severely damaged (impassable). */
export const ROAD_SEVERE = 0.6;

export type RoadStatus = 'intact' | 'cracked' | 'steep' | 'severe' | 'inundated' | 'impassable' | 'scoured' | 'blocked';

export interface RoadSegmentState {
  id: string;
  material: RoadMaterial;
  samples: { x: number; z: number }[];
  /** Gutter points (both curbs, 0.3 m inside the carriageway edge) at the same stations. */
  gutters: { x: number; z: number }[];
  /** Pre-existing damage (original world, 0–1). */
  condition: number;
  /** Crack index 0–1 (earthquake). */
  crack: number;
  /** Peak horizontal ground velocity seen (m/s). */
  peakPgv: number;
  /** Current / peak flood depth over the carriageway (m, max of crown and gutters). */
  depth: number;
  maxDepth: number;
  /** Current / peak depth over the crown (centerline) — passability. */
  crownDepth: number;
  maxCrownDepth: number;
  speed: number;
  /** Time with depth ≥ ROAD_INUNDATED (s). */
  floodTime: number;
  /** Scour 0–1. */
  scour: number;
  /** Worst status reached. */
  status: RoadStatus;
  /** Ground deformation state (Phase 21; absent until the ground moves under it). */
  deform?: import('../deformation/response').RoadDeformState;
  /** Collapse rubble on the carriageway (Phase 25): thickest point (m), blocked, building it came from. */
  rubble?: { height: number; blocked: boolean; source: string | null };
}

export interface Inlet {
  x: number;
  z: number;
  /** m³/s */
  capacity: number;
  segment: string;
}

export interface RoadEvent {
  time: number;
  segment: string;
  kind: 'cracked' | 'steep' | 'severe' | 'inundated' | 'impassable' | 'scoured' | 'blocked';
  value: number;
}

/**
 * Phase 21 hook: ground failure under a road sample (settlement / lateral offset in m). The
 * crack index grows with offset / 0.1 m (10 cm of differential movement breaks a pavement).
 */
export interface RoadGroundFailure {
  readonly id: string;
  offset(x: number, z: number, time: number): number;
}

const RANK: Record<RoadStatus, number> = { intact: 0, cracked: 1, steep: 2, inundated: 2, scoured: 3, severe: 4, impassable: 4, blocked: 4 };

export class RoadRuntime {
  readonly segments: RoadSegmentState[] = [];
  readonly inlets: Inlet[] = [];
  readonly events: RoadEvent[] = [];
  /** Bumped when any state changes visibly (overlay / inspector). */
  rev = 0;
  groundFailure: RoadGroundFailure | null = null;

  constructor(readonly network: RoadNetwork) {
    for (const s of Object.values(network.segments).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const line = segmentLine(network, s);
      const n = Math.max(1, Math.round(line.length / SAMPLE_SPACING));
      const samples: { x: number; z: number }[] = [];
      const gutters: { x: number; z: number }[] = [];
      const g = Math.max(0.3, s.profile.width / 2 - 0.3);
      for (let k = 0; k <= n; k++) {
        const p = pointAt(line, (line.length * k) / n);
        samples.push({ x: p.x, z: p.z });
        gutters.push({ x: p.x - p.tz * g, z: p.z + p.tx * g }, { x: p.x + p.tz * g, z: p.z - p.tx * g });
      }
      this.segments.push({
        id: s.id, material: s.profile.material, samples, gutters, condition: s.condition ?? 0,
        crack: 0, peakPgv: 0, depth: 0, maxDepth: 0, crownDepth: 0, maxCrownDepth: 0, speed: 0, floodTime: 0, scour: 0, status: 'intact',
      });
      // Inlets: both curbs, evenly along the segment (spacing by drainage level).
      const spacing = DRAIN_SPACING[s.profile.drainage];
      if (spacing > 0) {
        const count = Math.max(1, Math.floor(line.length / spacing));
        const lateral = Math.max(0.3, s.profile.width / 2 - 0.3);
        for (let k = 0; k < count; k++) {
          const p = pointAt(line, ((k + 0.5) * line.length) / count);
          for (const side of [1, -1]) this.inlets.push({ x: p.x - p.tz * lateral * side, z: p.z + p.tx * lateral * side, capacity: INLET_CAPACITY, segment: s.id });
        }
      }
    }
  }

  get empty() {
    return this.segments.length === 0;
  }

  /** Raise a segment's status (worst wins); the first occurrence of each kind is an event. */
  mark(st: RoadSegmentState, kind: RoadEvent['kind'], time: number, value: number): boolean {
    if (RANK[kind] > RANK[st.status]) st.status = kind;
    if (this.events.some((e) => e.segment === st.id && e.kind === kind)) return false;
    this.events.push({ time, segment: st.id, kind, value });
    this.rev++;
    return true;
  }

  /** Counts per status for results / HUD. */
  summary() {
    const out = { total: this.segments.length, cracked: 0, severe: 0, inundated: 0, impassable: 0, scoured: 0, steep: 0, cut: 0, rubble: 0 };
    for (const s of this.segments) {
      if (s.crack >= 0.05) out.cracked++;
      if (s.crack >= ROAD_SEVERE) out.severe++;
      if (s.maxDepth >= ROAD_INUNDATED) out.inundated++;
      if (s.maxCrownDepth >= ROAD_IMPASSABLE) out.impassable++;
      if (s.scour >= 1) out.scoured++;
      if (s.deform && s.deform.grade >= 0.15 && s.deform.grade > s.deform.grade0 + 0.01) out.steep++;
      if (s.deform && !s.deform.passable) out.cut++;
      if (s.rubble?.blocked) out.rubble++;
    }
    return out;
  }
}

/** Material factor (crack threshold) for a segment state. */
export const crackThreshold = (st: RoadSegmentState) => ROAD_MATERIAL_PROPS[st.material].quakeCrackPgv * (1 - 0.5 * st.condition);
export const scourThreshold = (st: RoadSegmentState) => ROAD_MATERIAL_PROPS[st.material].scourSpeed * (1 - 0.3 * st.condition);
