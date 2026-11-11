/**
 * Phase 37 (§7): command kinds are generated from the object palette — every palette item has exactly one kind key,
 * the keys are stable, and objects placed from a preset are recognised as that kind.
 */
import { describe, expect, it } from 'vitest';
import { identityTransform } from '@/core/types';
import { PALETTE } from '@/objects/palette';
import { createWorldObject } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { presetSpec } from '@/buildings/spec';
import { canonicalType, findKind, isOfKind, kindOfObject, KINDS, presetIsExact } from './kinds';

describe('command kinds', () => {
  it('one kind per enabled palette item; the keys (written by hand here) do not drift', () => {
    expect(KINDS.length).toBe(PALETTE.filter((p) => !p.disabled).length);
    expect(KINDS.map((k) => `${k.item.id} → ${k.key}`)).toEqual([
      'building.lowrise → building:boxLowrise', 'building.office → building:boxOffice', 'building.house → building:boxHouse',
      'building.m.house → building:house', 'building.m.apartment → building:apartment', 'building.m.office → building:office',
      'building.m.warehouse → building:warehouse', 'building.m.industrial → building:industrial', 'building.m.tower → building:tower',
      'tree.broadleaf → tree:broadleaf', 'tree.conifer → tree:conifer',
      'car.sedan → car:sedan', 'car.suv → car:suv', 'car.truck → car:truck',
      'human.adult → human:adult',
      'infra.streetLight → streetLight', 'infra.sign → sign:road', 'infra.billboard → sign:billboard', 'infra.signal → sign:signal',
      'infra.guardrail → wall:guardrail', 'infra.wall → wall:masonry', 'infra.fence → wall:fence',
      'obj.crate.wood → crate:wood', 'obj.crate.steel → crate:steel', 'obj.crate.plastic → crate:plastic',
      'obj.barrel.empty → barrel:empty', 'obj.barrel.water → barrel:water', 'obj.barrel.oil → barrel:oil',
      'obj.container.20ft → container:20ft', 'obj.container.40ft → container:40ft',
      'obj.furniture.sofa → furniture:sofa', 'obj.furniture.table → furniture:table', 'obj.furniture.cabinet → furniture:cabinet',
      'obj.roadBarrier → roadBarrier', 'obj.ball → ball:solid', 'obj.ball.hollow → ball:hollow',
      'env.road → road:twoLane', 'env.road4 → road:fourLane',
    ]);
  });

  it('a bare type is its default preset (building = the modular house); case does not matter', () => {
    expect(findKind('building')?.key).toBe('building:house');
    expect(findKind('Building', 'OFFICE')?.key).toBe('building:office');
    expect(findKind('car')?.key).toBe('car:sedan');
    expect(findKind('tree')?.key).toBe('tree:broadleaf');
    expect(findKind('streetlight')?.key).toBe('streetLight');
    expect(findKind('sign')?.key).toBe('sign:road');
    expect(findKind('wall')?.key).toBe('wall:masonry');
    expect(findKind('crate')?.key).toBe('crate:wood');
    expect(findKind('container', '40ft')?.key).toBe('container:40ft');
    expect(findKind('spaceship')).toBeNull();
    expect(findKind('car', 'limo')).toBeNull();
    expect(canonicalType('STREETLIGHT')).toBe('streetLight');
    expect(canonicalType('nothing')).toBeNull();
  });

  it('objects placed from a preset are of that kind — and of no other exact kind of the type', () => {
    for (const kind of KINDS) {
      const building = kind.item.buildingPreset ? createDesign(presetSpec(kind.item.buildingPreset)!, kind.item.buildingPreset) : undefined;
      const o = createWorldObject({ type: kind.type, transform: identityTransform(), params: kind.item.params, building, seed: 1 }, 1);
      expect(isOfKind(o, kind), kind.key).toBe(true);
      for (const other of KINDS) {
        if (other === kind || other.type !== kind.type || !presetIsExact(other) || !presetIsExact(kind)) continue;
        expect(isOfKind(o, other), `${kind.key} is not ${other.key}`).toBe(false);
      }
      if (presetIsExact(kind)) expect(kindOfObject(o)).toBe(kind.key);
    }
    // Presets that differ only in size cannot be told apart, and say so.
    expect(presetIsExact(findKind('sign', 'billboard')!)).toBe(false);
    expect(presetIsExact(findKind('building', 'boxHouse')!)).toBe(false);
    expect(presetIsExact(findKind('building', 'house')!)).toBe(true);
    expect(presetIsExact(findKind('car', 'truck')!)).toBe(true);
  });
});
