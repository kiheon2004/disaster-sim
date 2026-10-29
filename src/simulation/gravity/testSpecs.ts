/** Gravity experiment specs for tests and benchmarks (Phase 31). */
import type { EventSpec } from '@/events/specs';
import { defaultGravitySpec, type GravitySpec } from '@/gravity/types';

/** A constant global gravity experiment from t = 0 for 60 s unless overridden. */
export const gravity = (p: Partial<GravitySpec> = {}): EventSpec => ({ ...defaultGravitySpec(), scenario: 'custom', profile: 'constant', duration: 60, startTime: 0, ...p } as EventSpec);
