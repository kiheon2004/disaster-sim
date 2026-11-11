/**
 * Phase 37 (§14): the viewport's right-click menu — a right click is not a right drag (the camera pan), the entries
 * come from what was placed recently, and each writes a canonical command with the position filled in.
 */
import { describe, expect, it } from 'vitest';
import { formatCanonical, parseCanonical } from '@/command/canonical';
import { findKind, KINDS } from '@/command/kinds';
import { phenomena } from '@/phenomena/registry';
import { CLICK_SLOP, disasterCommand, disasterTypes, formatPoint, isRightClick, MENU_ENTRIES, placeCommand, placeKinds } from './menuEntries';

describe('right click or right drag', () => {
  it('press and release less than 5 px apart with the right button is a click', () => {
    expect(CLICK_SLOP).toBe(5);
    expect(isRightClick({ x: 100, y: 100, button: 2 }, { x: 100, y: 100, button: 2 })).toBe(true);
    expect(isRightClick({ x: 100, y: 100, button: 2 }, { x: 103, y: 103, button: 2 })).toBe(true);
    // 3-4-5: exactly 5 px is a drag already.
    expect(isRightClick({ x: 100, y: 100, button: 2 }, { x: 103, y: 104, button: 2 })).toBe(false);
    expect(isRightClick({ x: 100, y: 100, button: 2 }, { x: 160, y: 100, button: 2 })).toBe(false);
  });

  it('the left and middle buttons, and a release without a press on the canvas, are not', () => {
    expect(isRightClick({ x: 1, y: 1, button: 0 }, { x: 1, y: 1, button: 0 })).toBe(false);
    expect(isRightClick({ x: 1, y: 1, button: 1 }, { x: 1, y: 1, button: 1 })).toBe(false);
    expect(isRightClick({ x: 1, y: 1, button: 2 }, { x: 1, y: 1, button: 0 })).toBe(false);
    expect(isRightClick(null, { x: 1, y: 1, button: 2 })).toBe(false);
  });
});

describe('entries', () => {
  // (a bare type names its default preset: the entries write the preset out)
  const DEFAULTS = ['building:house', findKind('tree')!.key, findKind('car')!.key];

  it('nothing placed yet: a house, a tree, a car', () => {
    expect(placeKinds([]).map((k) => k.key)).toEqual(DEFAULTS);
    expect(placeKinds([]).map((k) => k.type)).toEqual(['building', 'tree', 'car']);
  });

  it('the kinds most recently placed with the palette, newest first, at most four, never a road piece', () => {
    const items = KINDS.filter((k) => k.type !== 'road').slice(0, 6);
    const road = KINDS.find((k) => k.type === 'road');
    expect(road).toBeDefined();
    const recent = [road!.item.id, ...items.map((k) => k.item.id), 'no.such.item', items[0].item.id];
    expect(placeKinds(recent).map((k) => k.key)).toEqual(items.slice(0, MENU_ENTRIES).map((k) => k.key));
    // Only a road piece was placed: the defaults again.
    expect(placeKinds([road!.item.id]).map((k) => k.key)).toEqual(DEFAULTS);
  });

  it('disasters: favourites, then recent ones — only types that exist; three known ones when there are none', () => {
    expect(disasterTypes(['fire', 'nope'], ['blast', 'fire', 'tornado'])).toEqual(['fire', 'blast', 'tornado']);
    expect(disasterTypes([], [])).toEqual(['blast', 'fire', 'earthquake']);
    expect(disasterTypes(phenomena.listImplemented().map((d) => d.type), []).length).toBe(MENU_ENTRIES);
  });
});

describe('the command an entry writes', () => {
  it('has the position filled in, rounded to 0.1 m like a mouse placement', () => {
    const house = KINDS.find((k) => k.key === 'building:house')!;
    expect(placeCommand(house, [12.34, -4.46])).toBe('place building:house at=12.3,-4.5');
    expect(disasterCommand('blast', [12.34, -4.46])).toBe('disaster blast at=12.3,-4.5');
    expect(formatPoint([0, -0.04])).toBe('0,0');
    expect(formatPoint([99.96, 100])).toBe('100,100');
  });

  it('is a canonical command, written the way the formatter writes it — for every kind and every disaster type', () => {
    for (const k of KINDS.filter((x) => x.type !== 'road')) {
      const line = placeCommand(k, [12.34, -4.46]);
      const r = parseCanonical(line);
      expect(r.ok, line).toBe(true);
      if (r.ok) expect(formatCanonical(r.intent)).toBe(line);
    }
    for (const d of phenomena.listImplemented()) {
      const line = disasterCommand(d.type, [-7.25, 30]);
      const r = parseCanonical(line);
      expect(r.ok, line).toBe(true);
      if (r.ok) expect(formatCanonical(r.intent)).toBe(line);
    }
  });
});
