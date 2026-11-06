import type { ObjectType } from '@/core/types';
import type { ObjectParams } from '@/core/model';
import type { ObjectDefinition } from './ObjectDefinition';
import { buildingDefinition } from './definitions/building';
import { treeDefinition } from './definitions/tree';
import { carDefinition } from './definitions/car';
import { humanDefinition } from './definitions/human';
import { streetLightDefinition } from './definitions/streetLight';
import { signDefinition } from './definitions/sign';
import { wallDefinition } from './definitions/wall';
import { roadDefinition } from './definitions/road';
import { PASSIVE_DEFINITIONS } from './definitions/dynamicObjects';

/** Single source of truth for every placeable object type. Add new types here. */
const definitions = [
  buildingDefinition,
  treeDefinition,
  carDefinition,
  humanDefinition,
  streetLightDefinition,
  signDefinition,
  wallDefinition,
  roadDefinition,
  // Phase 35 Level 1 passive dynamic objects (appended: earlier types keep their order).
  ...PASSIVE_DEFINITIONS,
] as unknown as ObjectDefinition<ObjectParams>[];

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
