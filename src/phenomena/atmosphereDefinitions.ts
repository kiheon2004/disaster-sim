/**
 * Atmosphere (Phase 29) for the phenomenon engine: the reference state at the world datum (altitude,
 * pressure, temperature — the density is derived, never entered), the lateral boundary, an optional
 * removal of the air MASS (profile, extent, target share, duration), an optional restoration and the
 * opt-in couplings to the blast and meteor-entry models. Impossible input is rejected by the schema with a
 * reason. A local reduced atmosphere model — not a climate model, CFD or a weather forecast.
 */
import type { I18nMessage, MessageKey } from '@/i18n/i18n';
import type { EventSpec } from '@/events/specs';
import type { ImplementedPhenomenon, ParamField } from './types';
import { AtmosphereEvent, datumState, describeAtmosphere } from '@/events/atmosphere/AtmosphereEvent';
import { atmosphereSchema } from '@/events/atmosphere/atmosphereSchema';
import { ATMOS_LIMITS, BOUNDARY_MODES, FIRE_VALID_PRESSURE, REMOVAL_EXTENTS, REMOVAL_PROFILES, RESTORE_MODES, THERMO_MODES, defaultAtmosphereSpec, type AtmosphereSpec } from '@/atmosphere/types';
import { density, isa } from '@/atmosphere/reference';
import { ZERO_C } from '@/thermal/units';

function implemented<S extends EventSpec>(d: ImplementedPhenomenon<S>): ImplementedPhenomenon<EventSpec> {
  return d as unknown as ImplementedPhenomenon<EventSpec>;
}

const A = (s: EventSpec) => s as unknown as AtmosphereSpec;
const put = (s: EventSpec, patch: Partial<AtmosphereSpec>) => ({ ...A(s), ...patch }) as unknown as EventSpec;
const opt = <T extends string>(prefix: string, values: readonly T[]) => values.map((v) => ({ value: v, labelKey: `${prefix}.${v}` as MessageKey }));
const removing = (s: EventSpec) => A(s).removal !== 'none';
const restoring = (s: EventSpec) => (A(s).restore ?? 'none') !== 'none';
const local = (s: EventSpec) => A(s).extent === 'local' && (removing(s) || A(s).restore === 'reservoir');
const ON_OFF = ['off', 'on'] as const;

export const atmosphere = implemented<AtmosphereSpec>({
  type: 'atmosphere', labelKey: 'phen.atmosphere', icon: 'atmosphere', status: 'implemented',
  channels: ['atmosphere', 'airflow', 'pressure', 'temperature'],
  models: ['atmosphereColumn', 'atmosphereRemoval', 'aerodynamicDensity', 'heatTransfer', 'combustion'],
  keywords: /대기|기압|공기\s*밀도|대기\s*제거|진공|atmospher|air\s*pressure|vacuum|air\s*density/,
  schema: atmosphereSchema,
  defaults: () => defaultAtmosphereSpec(),
  seeded: false,
  fields: [
    { key: 'altitude', labelKey: 'atmos.f.altitude', unit: 'm', min: ATMOS_LIMITS.altitude[0], max: ATMOS_LIMITS.altitude[1], step: 100, precision: 0 },
    { key: 'pressure', labelKey: 'atmos.f.pressure', unit: 'kPa', min: ATMOS_LIMITS.pressure[0] / 1000, max: ATMOS_LIMITS.pressure[1] / 1000, step: 1, precision: 2, scale: 1 / 1000, optional: true, autoValue: (s) => isa(A(s).altitude).p },
    {
      key: 'temperature', labelKey: 'atmos.f.temperature', unit: '°C', min: ATMOS_LIMITS.temperature[0] - ZERO_C, max: ATMOS_LIMITS.temperature[1] - ZERO_C, step: 1, precision: 1, optional: true,
      autoValue: (s) => isa(A(s).altitude).T - ZERO_C,
      get: (s) => (A(s).temperature === undefined ? undefined : A(s).temperature! - ZERO_C),
      set: (s, v) => put(s, { temperature: v === undefined || v === '' ? undefined : Number(v) + ZERO_C }),
    },
    { key: 'boundary', labelKey: 'atmos.f.boundary', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.boundary', BOUNDARY_MODES) },
    {
      key: 'removal', labelKey: 'atmos.f.removal', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.removal', REMOVAL_PROFILES),
      set: (s, v) => {
        const sp = A(s), p = v as AtmosphereSpec['removal'], D = sp.duration ?? 600;
        const patch: Partial<AtmosphereSpec> = { removal: p };
        if (p === 'scheduled' && !sp.schedule?.length) patch.schedule = [[0, Math.round(D / 4)], [Math.round(D / 2), Math.round((3 * D) / 4)]];
        if (p !== 'none' && (sp.target === undefined || sp.target >= 1)) patch.target = 0.5;
        if (p !== 'none' && sp.duration === undefined) patch.duration = 600;
        return put(s, patch);
      },
    },
    { visible: (s) => removing(s) || A(s).restore === 'reservoir', key: 'extent', labelKey: 'atmos.f.extent', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.extent', REMOVAL_EXTENTS) },
    { visible: removing, key: 'target', labelKey: 'atmos.f.target', unit: '%', min: 0, max: 99, step: 5, precision: 1, scale: 100 },
    { visible: removing, key: 'duration', labelKey: 'atmos.f.duration', unit: 's', min: ATMOS_LIMITS.duration[0], max: ATMOS_LIMITS.duration[1], step: 30, precision: 0 },
    { visible: local, key: 'x', labelKey: 'atmos.f.x', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => A(s).position?.[0] ?? 0, set: (s, v) => put(s, { position: [Number(v), A(s).position?.[1] ?? 0] }) },
    { visible: local, key: 'z', labelKey: 'atmos.f.z', unit: 'm', min: -100, max: 100, step: 1, precision: 1, get: (s) => A(s).position?.[1] ?? 0, set: (s, v) => put(s, { position: [A(s).position?.[0] ?? 0, Number(v)] }) },
    { visible: local, key: 'radius', labelKey: 'atmos.f.radius', unit: 'm', min: ATMOS_LIMITS.radius[0], max: ATMOS_LIMITS.radius[1], step: 1, precision: 0 },
    { key: 'thermo', labelKey: 'atmos.f.thermo', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.thermo', THERMO_MODES), get: (s) => A(s).thermo ?? 'adiabatic' },
    {
      key: 'restore', labelKey: 'atmos.f.restore', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.restore', RESTORE_MODES),
      get: (s) => A(s).restore ?? 'none',
      set: (s, v) => {
        const sp = A(s);
        const patch: Partial<AtmosphereSpec> = { restore: v as AtmosphereSpec['restore'] };
        if (v !== 'none') {
          const end = sp.removal !== 'none' ? sp.duration ?? 600 : 0;
          if (sp.restoreAt === undefined || sp.restoreAt < end) patch.restoreAt = end + 60;
          if (sp.restoreDuration === undefined) patch.restoreDuration = 600;
          if (sp.restoreTarget === undefined) patch.restoreTarget = 1;
        }
        return put(s, patch);
      },
    },
    { visible: restoring, key: 'restoreAt', labelKey: 'atmos.f.restoreAt', unit: 's', min: 0, max: ATMOS_LIMITS.restoreAt[1], step: 30, precision: 0 },
    { visible: restoring, key: 'restoreDuration', labelKey: 'atmos.f.restoreDuration', unit: 's', min: ATMOS_LIMITS.restoreDuration[0], max: ATMOS_LIMITS.restoreDuration[1], step: 30, precision: 0 },
    { visible: restoring, key: 'restoreTarget', labelKey: 'atmos.f.restoreTarget', unit: '%', min: 1, max: 100, step: 5, precision: 0, scale: 100 },
    {
      key: 'coupleBlast', labelKey: 'atmos.f.coupleBlast', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.onoff', ON_OFF),
      get: (s) => (A(s).coupleBlast ? 'on' : 'off'), set: (s, v) => put(s, { coupleBlast: v === 'on' }),
    },
    {
      key: 'coupleMeteor', labelKey: 'atmos.f.coupleMeteor', unit: '', min: 0, max: 0, step: 0, precision: 0, options: opt('atmos.onoff', ON_OFF),
      get: (s) => (A(s).coupleMeteor ? 'on' : 'off'), set: (s, v) => put(s, { coupleMeteor: v === 'on' }),
    },
  ] as ParamField[],
  createEvent: (spec, now) => new AtmosphereEvent(spec, now),
  duration: (spec) => new AtmosphereEvent(spec, 0).duration,
  assumptions: (spec) => atmosphereAssumptions(spec),
  describe: (spec) => describeAtmosphere(spec),
});

/** Assumptions and model limitations of an atmosphere experiment (editor, preview, command preview). */
export function atmosphereAssumptions(s: AtmosphereSpec): I18nMessage[] {
  const { p, T } = datumState(s);
  const out: I18nMessage[] = [
    { key: 'atmos.as.state', params: { p: (p / 1000).toFixed(2), T: (T - ZERO_C).toFixed(1), rho: density(p, T).toFixed(3), h: s.altitude.toFixed(0) } },
    { key: 'atmos.as.model' }, { key: 'atmos.as.hydrostatic' }, { key: 'atmos.as.noAcoustic' },
    { key: s.boundary === 'open' ? 'atmos.as.open' : 'atmos.as.closed' },
  ];
  if (s.removal !== 'none') {
    out.push({ key: s.extent === 'local' ? 'atmos.as.removalLocal' : 'atmos.as.removalUniform', params: { tg: ((s.target ?? 1) * 100).toFixed(0), d: (s.duration ?? 0).toFixed(0) } });
    out.push({ key: (s.thermo ?? 'adiabatic') === 'adiabatic' ? 'atmos.as.adiabatic' : 'atmos.as.isothermal' });
  }
  if (s.restore && s.restore !== 'none') out.push({ key: s.restore === 'boundary' ? 'atmos.as.restoreBoundary' : 'atmos.as.restoreReservoir' });
  const pEnd = p * (s.removal !== 'none' ? s.target ?? 1 : 1);
  if (pEnd < FIRE_VALID_PRESSURE) out.push({ key: 'atmos.as.fireRange' });
  out.push({ key: 'atmos.as.aero' }, { key: 'atmos.as.tracers' }, { key: 'atmos.as.water' });
  out.push({ key: s.coupleBlast ? 'atmos.as.blastOn' : 'atmos.as.blastOff' }, { key: s.coupleMeteor ? 'atmos.as.meteorOn' : 'atmos.as.meteorOff' });
  out.push({ key: 'atmos.as.limits' });
  return out;
}
