import type { WorldObject } from '@/core/model';
import type { TFunction } from '@/i18n/i18n';
import { getDefinition } from '@/objects/registry';

export function displayName(obj: WorldObject, t: TFunction): string {
  return obj.name.trim() || `${t(getDefinition(obj.type).labelKey)} ${obj.serial}`;
}

export function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString();
}

import type { Locale } from '@/i18n/i18n';
import { translate, isMessageKey } from '@/i18n/i18n';
import type { SimulationLogEntry } from '@/simulation/SimulationRuntime';

/**
 * Translate a log entry in the current language. Entity names and event labels are
 * resolved at display time so switching language re-translates the whole log.
 */
export function formatLogEntry(locale: Locale, entry: SimulationLogEntry, objects: Record<string, WorldObject>): string {
  const tl: TFunction = (k, p) => translate(locale, k, p);
  const params: Record<string, string | number> = { ...(entry.message.params ?? {}) };
  if (entry.entityId) {
    const o = objects[entry.entityId];
    params.name = o ? displayName(o, tl) : entry.entityId;
  }
  const eventKey = params.eventKey;
  if (typeof eventKey === 'string' && isMessageKey(eventKey)) params.label = tl(eventKey, params);
  return tl(entry.message.key, params);
}
