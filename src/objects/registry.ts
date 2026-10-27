import type { ObjectType } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import type { ObjectDefinition } from './ObjectDefinition';
import { buildingDefinition } from './definitions/building';
import { treeDefinition } from './definitions/tree';
import { carDefinition } from './definitions/car';
import { humanDefinition } from './definitions/human';

/** Single source of truth for every placeable object type. Add new types here. */
const definitions = [buildingDefinition, treeDefinition, carDefinition, humanDefinition] as unknown as ObjectDefinition<ObjectParams>[];

const byType = new Map<ObjectType, ObjectDefinition<ObjectParams>>(definitions.map((d) => [d.type, d]));

export function getDefinition(type: ObjectType): ObjectDefinition<ObjectParams> {
  const def = byType.get(type);
  if (!def) throw new Error(`Unknown object type: ${type}`);
  return def;
}

export function hasDefinition(type: string): type is ObjectType {
  return byType.has(type as ObjectType);
}

export function allDefinitions(): readonly ObjectDefinition<ObjectParams>[] {
  return definitions;
}
