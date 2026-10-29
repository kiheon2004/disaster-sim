import type { koStructure } from './ko.structure';

/** English strings of structural destruction (Phase 25). */
export const enStructure: Record<keyof typeof koStructure, string> = {
  'log.impact.collapsed': 'Building collapsed under the impact loads',
  'log.struct.progressive': 'Progressive collapse: a falling block broke through the floor below ({n} members)',
  'log.struct.arrested': 'Falling block arrested by the floor below (floor damage {pct}%)',
  'log.struct.partial': 'Partial collapse: {pct}% of the superstructure fell',
  'log.struct.global': 'Global collapse ({pct}% of the superstructure still standing)',
  'log.struct.connection': 'Connection failure: load redistributed',
  'log.struct.redistribution': 'Load redistribution failed further members ({n})',
  'log.struct.foundation': 'Foundation support lost ({n} foundation members)',
  'log.struct.debrisHit': 'Member damaged by falling debris',
  'log.struct.debrisFail': 'Member failed under falling debris',
  'log.struct.buried': 'Buried under rubble ({m} m)',
  'log.struct.roadBlocked': 'Road {id}: blocked by collapse rubble ({m} m)',
  'milestone.p25.member': 'First structural member failure ({hazard})',
  'milestone.p25.connection': 'First connection failure ({hazard})',
  'milestone.p25.redistribution': 'Load redistribution failed further members ({hazard})',
  'milestone.p25.progressive': 'Progressive collapse begins ({hazard})',
  'milestone.p25.partial': 'Partial collapse ({hazard})',
  'milestone.p25.global': 'Global collapse ({hazard})',
  'milestone.p25.debris': 'First damage by falling debris ({hazard})',
  'milestone.p25.secondary': 'First secondary damage ({hazard})',
  'milestone.p25.roadBlocked': 'Road {id} blocked by collapse rubble',
};
