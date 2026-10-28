import type { TFunction, MessageKey } from '@/i18n/i18n';
import type { ParsedCommand } from '@/commands/CommandParser';
import type { UnsupportedRequest } from '@/commands/schema';
import { nearestCompass } from '@/core/compass';
import { resolveEarthquake } from '@/events/earthquake/resolveEarthquake';

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
