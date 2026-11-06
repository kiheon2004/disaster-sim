/**
 * Phase 34 → Phase 35 interface: what dynamic objects / vehicles may read about a person's capacity to act. Read-only;
 * null for people without the physiology (the Phase 33 `humanSnapshot` stays the physical interface). Educational model
 * states — not a medical assessment.
 */
import { CAPACITY_LEVELS, type AirwayState, type CapacityLevel, type ThermalStateName } from '@/physiology/engine';
import { thermalStrain } from '@/physiology/engine';
import { ZERO_C } from '@/thermal/units';
import type { Posture } from '@/human/posture';
import type { Mobility } from '@/human/injury';
import type { RuntimeEntity } from '../SimulationRuntime';

export interface PhysiologySnapshot {
  id: string;
  posture: Posture;
  /** Phase 33 physical mobility and incapacitation. */
  physicalMobility: Mobility;
  physicallyIncapacitated: boolean;
  /** Physiological capacity (worst component) and the combined action capacity (with the physical one). */
  physiological: CapacityLevel;
  combined: CapacityLevel;
  /** 0 (normal) … 4 (unable to act). */
  combinedIndex: number;
  /** Why: 'physical' and / or the physiological components at the combined level. */
  causes: string[];
  breathing: boolean;
  airway: AirwayState;
  thermalState: ThermalStateName;
  /** Thermal strain on the core scale (1.2 = heat 38 °C / cold 36 °C bound, 4.2 = 41 / 30 °C). */
  thermalStrain: number;
  fatigue: number;
  /** Captured by a celestial source (state frozen). */
  frozen: boolean;
}

export function physiologySnapshot(e: RuntimeEntity): PhysiologySnapshot | null {
  const pe = e.physio, st = e.human;
  if (!pe || !st) return null;
  const s = pe.s;
  return {
    id: e.id,
    posture: st.posture,
    physicalMobility: st.mobility,
    physicallyIncapacitated: st.incapacitated,
    physiological: s.capacity,
    combined: s.combined,
    combinedIndex: CAPACITY_LEVELS.indexOf(s.combined),
    causes: [...s.combinedCauses],
    breathing: s.resp.breathing,
    airway: s.airway.state,
    thermalState: s.thermalState,
    thermalStrain: thermalStrain(s.Tc - ZERO_C),
    fatigue: s.fatigue,
    frozen: pe.frozen,
  };
}
