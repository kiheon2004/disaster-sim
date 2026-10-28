import type { TFunction, MessageKey } from '@/i18n/i18n';
import type { ParsedCommand } from '@/commands/CommandParser';
import type { UnsupportedRequest } from '@/commands/schema';
import { nearestCompass } from '@/core/compass';
import { resolveEarthquake } from '@/events/earthquake/resolveEarthquake';
import { rainAssumptions, resolveRisingWater, sourceAssumptions } from '@/events/flood/resolveFlood';
import type { EventSpec } from '@/events/specs';
import type { TerrainData, WaterSettings } from '@/core/model';
import type { I18nMessage } from '@/i18n/i18n';

/** One-line description of a water event (also used by the timeline and the flood form). */
export function describeWater(spec: EventSpec, t: TFunction, terrain: TerrainData | null = null, water?: WaterSettings): string | null {
  switch (spec.event) {
    case 'rain': {
      const a = spec.area;
      const area = a ? t('cmd.describe.rain.circle', { x: a.center[0], z: a.center[1], r: a.radius }) : t('cmd.describe.rain.whole');
      return t('cmd.describe.rain', { mm: spec.intensity, min: +(spec.duration / 60).toFixed(1), area });
    }
    case 'risingWater': {
      const r = resolveRisingWater(spec, terrain, water);
      return t('cmd.describe.risingWater', { side: t(`side.${spec.boundary}`), level: spec.level.toFixed(2), rate: r.riseRate, s: r.duration });
    }
    case 'waterSource':
      return t('cmd.describe.waterSource', { q: spec.rate, x: spec.position[0], z: spec.position[1], min: +(spec.duration / 60).toFixed(1) });
    default:
      return null;
  }
}

/** Resolved assumptions of a water event on the current terrain (shown under the preview line). */
export function waterAssumptions(spec: EventSpec, terrain: TerrainData | null, water?: WaterSettings): I18nMessage[] {
  switch (spec.event) {
    case 'rain':
      return rainAssumptions(spec);
    case 'risingWater':
      return resolveRisingWater(spec, terrain, water).assumptions;
    case 'waterSource':
      return sourceAssumptions(spec);
    default:
      return [];
  }
}

/** Human-readable, localized one-line description of a parsed command. */
export function describeParsed(pc: ParsedCommand, t: TFunction): string {
  const c = pc.command;
  let text: string;
  switch (c.kind) {
    case 'event': {
      if (c.spec.event === 'earthquake') {
        const q = resolveEarthquake(c.spec, 0);
        text = t('cmd.describe.earthquake', {
          m: q.magnitude.toFixed(1),
          pga: q.pga.toFixed(2),
          assumed: q.pgaAssumed ? t('cmd.describe.eq.assumed') : '',
          duration: c.spec.duration !== undefined ? `${c.spec.duration}s` : `${t('cmd.describe.eq.auto')} ${q.duration}s`,
        });
        break;
      }
      if (c.spec.event !== 'wind') {
        text = describeWater(c.spec, t) ?? '';
        break;
      }
      const s = c.spec;
      const dirId = typeof s.direction === 'number' ? nearestCompass(s.direction) : s.direction;
      const dir = typeof s.direction === 'number' ? `${t(`compass.${dirId}` as MessageKey)} (${s.direction}°)` : t(`compass.${dirId}` as MessageKey);
      if (s.speed === 0) text = t('cmd.describe.windStop', { ramp: s.rampDuration ?? 4 });
      else if (s.rampDuration !== undefined)
        text = t('cmd.describe.windRamp', {
          from: s.rampFrom ?? t('cmd.describe.current'),
          speed: s.speed,
          ramp: s.rampDuration,
          dir,
          duration: s.duration,
        });
      else
        text = t('cmd.describe.wind', { speed: s.speed, dir, duration: s.duration, gust: Math.round((s.gustStrength ?? 0.25) * 100) });
      break;
    }
    case 'control':
      text = t(`cmd.describe.${c.action}`);
      break;
    case 'speed':
      text = t('cmd.describe.speed', { value: c.value });
      break;
  }
  return pc.delay ? `${t('cmd.describe.delay', { s: pc.delay })} · ${text}` : text;
}

export function describeUnsupported(u: UnsupportedRequest, t: TFunction): string {
  const params = Object.entries(u.params).map(([k, v]) => `${k}=${v}`).join(', ');
  return `${t('cmd.describe.unsupported', { hazard: t(`hazard.${u.event}`) })}${params ? ` · ${params}` : ''}`;
}
