import type { MessageKey } from '@/i18n/i18n';

/** Wind strength categories (Beaufort / KMA typhoon classes) for labels. */
export const WIND_CLASSES: { max: number; key: MessageKey; color: string }[] = [
  { max: 0.3, key: 'windClass.calm', color: '#7d8b99' },
  { max: 8, key: 'windClass.breeze', color: '#5fb6d9' },
  { max: 13.9, key: 'windClass.strong', color: '#4fc28a' },
  { max: 24.5, key: 'windClass.gale', color: '#e6d14a' },
  { max: 32.7, key: 'windClass.storm', color: '#f5a13b' },
  { max: 44, key: 'windClass.typhoon', color: '#f07a3a' },
  { max: 54, key: 'windClass.veryStrong', color: '#ef4d4d' },
  { max: Infinity, key: 'windClass.super', color: '#c43bd6' },
];

export function windClass(speed: number) {
  return WIND_CLASSES.find((c) => speed < c.max) ?? WIND_CLASSES[WIND_CLASSES.length - 1];
}
