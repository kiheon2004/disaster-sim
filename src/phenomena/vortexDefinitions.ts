/**
 * Placed vortex wind (Phase 35.5) for the phenomenon engine — replaces the planned 'tornado' entry. Editor fields,
 * defaults, assumptions and limitations (listed in the editor and the command preview).
 */
import type { I18nMessage } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { VortexEvent, describeVortex } from '@/events/vortex/VortexEvent';
import { vortexSchema } from '@/events/vortex/vortexSchema';
import { TORNADO_DEFAULTS, TORNADO_LIMITS, type TornadoSpec } from '@/vortex/types';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const T = (s: EventSpec) => s as unknown as TornadoSpec;
const put = (s: EventSpec, patch: Partial<TornadoSpec>) => ({ ...T(s), ...patch }) as unknown as EventSpec;
const L = TORNADO_LIMITS;

export const tornado = implemented<TornadoSpec>({
  type: 'tornado', labelKey: 'phen.tornado', icon: 'tornado', status: 'implemented',
  channels: ['airflow', 'mechanicalForce'],
  models: ['vortexWind', 'windLoad'],
  keywords: /토네이도|회오리|소용돌이\s*바람|tornado|twister|whirlwind|vortex/,
  schema: vortexSchema,
  defaults: () => ({ event: 'tornado', position: [0, 0], maxSpeed: 45, coreRadius: 15, outerRadius: 80, duration: 60 }),
  seeded: false,
  fields: [
    { key: 'x', labelKey: 'vortex.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => T(s).position[0], set: (s, v) => put(s, { position: [Number(v), T(s).position[1]] }) },
    { key: 'z', labelKey: 'vortex.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => T(s).position[1], set: (s, v) => put(s, { position: [T(s).position[0], Number(v)] }) },
    { key: 'maxSpeed', labelKey: 'vortex.f.maxSpeed', unit: 'm/s', min: L.maxSpeed[0], max: L.maxSpeed[1], step: 1, precision: 0 },
    { key: 'coreRadius', labelKey: 'vortex.f.coreRadius', unit: 'm', min: L.coreRadius[0], max: L.coreRadius[1], step: 1, precision: 0 },
    { key: 'outerRadius', labelKey: 'vortex.f.outerRadius', unit: 'm', min: L.outerRadius[0], max: L.outerRadius[1], step: 5, precision: 0 },
    { key: 'duration', labelKey: 'vortex.f.duration', unit: 's', min: L.duration[0], max: L.duration[1], step: 5, precision: 0 },
    { key: 'trackSpeed', labelKey: 'vortex.f.trackSpeed', unit: 'm/s', min: L.trackSpeed[0], max: L.trackSpeed[1], step: 0.5, precision: 1, optional: true, autoValue: () => TORNADO_DEFAULTS.trackSpeed },
    { key: 'trackBearing', labelKey: 'vortex.f.trackBearing', unit: '°', min: 0, max: 359, step: 5, precision: 0, optional: true, autoValue: () => TORNADO_DEFAULTS.trackBearing },
    { key: 'rotation', labelKey: 'vortex.f.rotation', unit: '', min: 0, max: 0, step: 0, precision: 0, options: [{ value: 'ccw', labelKey: 'vortex.rot.ccw' }, { value: 'cw', labelKey: 'vortex.rot.cw' }], get: (s) => T(s).rotation ?? 'ccw', set: (s, v) => put(s, { rotation: v === 'cw' ? 'cw' : 'ccw' }) },
    { key: 'shape', labelKey: 'vortex.f.shape', unit: '', min: L.shape[0], max: L.shape[1], step: 0.1, precision: 1, optional: true, autoValue: () => TORNADO_DEFAULTS.shape },
    { key: 'inflowAngle', labelKey: 'vortex.f.inflowAngle', unit: '°', min: L.inflowAngle[0], max: L.inflowAngle[1], step: 1, precision: 0, optional: true, autoValue: () => TORNADO_DEFAULTS.inflowAngle },
    { key: 'rampDuration', labelKey: 'vortex.f.rampDuration', unit: 's', min: L.rampDuration[0], max: L.rampDuration[1], step: 0.5, precision: 1, optional: true, autoValue: () => TORNADO_DEFAULTS.rampDuration },
  ] as ParamField[],
  createEvent: (spec, now) => new VortexEvent(spec, now),
  duration: (spec) => Math.max(1, spec.duration),
  assumptions: () => vortexAssumptions(),
  describe: (spec) => describeVortex(spec),
});

export function vortexAssumptions(): I18nMessage[] {
  return [{ key: 'vortex.as.profile' }, { key: 'vortex.as.scale' }, { key: 'vortex.as.noPressure' }, { key: 'vortex.as.shelter' }, { key: 'vortex.as.globalOnly' }];
}
