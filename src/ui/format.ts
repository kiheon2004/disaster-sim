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
