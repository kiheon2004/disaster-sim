/** Ordered damage states — numeric so "worse" comparisons are simple (max = worst). */
export const DamageState = {
  NORMAL: 0,
  STRESSED: 1,
  DAMAGED: 2,
  CRITICAL: 3,
  DESTROYED: 4,
} as const;
export type DamageState = (typeof DamageState)[keyof typeof DamageState];

export const DAMAGE_STATE_IDS = ['NORMAL', 'STRESSED', 'DAMAGED', 'CRITICAL', 'DESTROYED'] as const;
export type DamageStateId = (typeof DAMAGE_STATE_IDS)[number];

export const DAMAGE_STATE_COLORS: Record<DamageState, string> = {
  0: '#3fbf7f',
  1: '#e6d14a',
  2: '#f5973b',
  3: '#ef4d4d',
  4: '#8a8f98',
};

export const worst = (a: DamageState, b: DamageState): DamageState => (a > b ? a : b);
