/**
 * Fire (Phase 27) for the phenomenon engine: an ignition at a point (scenario), with editor fields,
 * defaults, and the assumptions + model limitations listed in the editor and the command preview.
 * The user sets where / when / what is lit and the world's conditions — never fuel recipes, ignition
 * devices or anything that makes a fire bigger. Impossible input is rejected with a reason.
 */
import type { I18nMessage } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { FireEvent, describeFire } from '@/events/fire/FireEvent';
import { fireSchema } from '@/events/fire/fireSchema';
import { FIRE_LIMITS, type FireSpec } from '@/fire/types';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const F = (s: EventSpec) => s as unknown as FireSpec;
const put = (s: EventSpec, patch: Partial<FireSpec>) => ({ ...F(s), ...patch }) as unknown as EventSpec;

export const fire = implemented<FireSpec>({
  type: 'fire', labelKey: 'phen.fire', icon: 'flame', status: 'implemented',
  channels: ['temperature'],
  models: ['combustion', 'roomFire', 'fireSpread', 'smoke', 'heatTransfer', 'thermalStructure'],
  keywords: /화재|산불|불길|불이\s*나|점화|fire|blaze|wildfire|ignit/,
  schema: fireSchema,
  defaults: () => ({ event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 600 }),
  seeded: false,
  fields: [
    { key: 'x', labelKey: 'fire.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => F(s).position[0], set: (s, v) => put(s, { position: [Number(v), F(s).position[1]] }) },
    { key: 'z', labelKey: 'fire.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => F(s).position[1], set: (s, v) => put(s, { position: [F(s).position[0], Number(v)] }) },
    { key: 'height', labelKey: 'fire.f.height', unit: 'm', min: FIRE_LIMITS.height[0], max: FIRE_LIMITS.height[1], step: 0.5, precision: 1 },
    { key: 'radius', labelKey: 'fire.f.radius', unit: 'm', min: FIRE_LIMITS.radius[0], max: FIRE_LIMITS.radius[1], step: 0.5, precision: 1 },
    { key: 'duration', labelKey: 'fire.f.duration', unit: 'min', min: FIRE_LIMITS.duration[0] / 60, max: FIRE_LIMITS.duration[1] / 60, step: 1, precision: 1, scale: 1 / 60 },
  ] as ParamField[],
  createEvent: (spec, now) => new FireEvent(spec, now),
  duration: (spec) => new FireEvent(spec, 0).duration,
  assumptions: (spec) => fireAssumptions(spec),
  describe: (spec) => describeFire(spec),
});

/** Assumptions and model limitations of a fire scenario (editor, preview, command preview). */
export function fireAssumptions(s: FireSpec): I18nMessage[] {
  const out: I18nMessage[] = [{ key: 'fire.as.ignition', params: { r: s.radius.toFixed(1) } }];
  if (s.target) out.push({ key: 'fire.as.target' });
  out.push(
    { key: 'fire.as.fuels' }, { key: 'fire.as.contents' }, { key: 'fire.as.ventilation' }, { key: 'fire.as.spread' },
    { key: 'fire.as.smoke' }, { key: 'fire.as.structure' }, { key: 'fire.as.notSafety' },
  );
  return out;
}
