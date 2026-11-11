/**
 * Phase 37 (§14, Phase 36 §26) — the viewport's right-click menu, the pure part: when a right press-and-release is a
 * click (a right DRAG stays the camera pan), which entries the menu offers, and the command each one writes. An entry
 * never runs anything: its command, with the position filled in, goes into the command bar.
 */
import { formatNumber } from '@/command/canonical';
import { findKind, KINDS, type Kind } from '@/command/kinds';
import { phenomena } from '@/phenomena/registry';

/** A right press and release closer than this (px) is a click; farther apart it was a camera pan. */
export const CLICK_SLOP = 5;

export interface PointerAt {
  x: number;
  y: number;
  button: number;
}

/** Whether a pointer press and its release are a right CLICK. */
export function isRightClick(down: PointerAt | null, up: PointerAt): boolean {
  return !!down && down.button === 2 && up.button === 2 && Math.hypot(up.x - down.x, up.y - down.y) < CLICK_SLOP;
}

/** Entries per group. */
export const MENU_ENTRIES = 4;
/** Offered when nothing was placed yet: a house, a tree, a car (each type's default preset). */
const DEFAULT_KINDS: readonly (readonly [string, string?])[] = [['building', 'house'], ['tree'], ['car']];
/** Offered when no disaster is a favourite or was placed recently. */
const DEFAULT_DISASTERS = ['blast', 'fire', 'earthquake'];

/**
 * The kinds most recently placed with the palette (its item ids), or a house, a tree and a car. Road pieces are left
 * out: a command draws roads from place to place (`road <from> -> <to>`), it does not place them at a point.
 */
export function placeKinds(recentItemIds: readonly string[]): Kind[] {
  const out: Kind[] = [];
  for (const id of recentItemIds) {
    const k = KINDS.find((x) => x.item.id === id);
    if (k && k.type !== 'road' && !out.includes(k)) out.push(k);
  }
  if (!out.length) for (const [type, preset] of DEFAULT_KINDS) {
    const k = findKind(type, preset);
    if (k) out.push(k);
  }
  return out.slice(0, MENU_ENTRIES);
}

/** Favourite disaster types first, then the recently placed ones — only types that can be placed. */
export function disasterTypes(favorites: readonly string[], recent: readonly string[]): string[] {
  const ok = (t: string) => !!phenomena.implemented(t);
  const out = [...new Set([...favorites, ...recent])].filter(ok);
  if (!out.length) {
    out.push(...DEFAULT_DISASTERS.filter(ok));
    if (!out.length) out.push(...phenomena.listImplemented().map((d) => d.type));
  }
  return out.slice(0, MENU_ENTRIES);
}

/** A ground point as a command writes it: 0.1 m, like a disaster placed with the mouse. */
export function formatPoint(p: readonly [number, number]): string {
  const r = (v: number) => formatNumber(Math.round(v * 10) / 10);
  return `${r(p[0])},${r(p[1])}`;
}

export const placeCommand = (kind: Kind, p: readonly [number, number]): string => `place ${kind.key} at=${formatPoint(p)}`;
export const disasterCommand = (type: string, p: readonly [number, number]): string => `disaster ${type} at=${formatPoint(p)}`;
