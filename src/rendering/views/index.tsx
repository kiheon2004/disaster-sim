import type { ComponentType } from 'react';
import type { ObjectType } from '@/core/types';
import type { ViewProps } from './types';
import { BuildingView } from './BuildingView';
import { TreeView } from './TreeView';
import { CarView } from './CarView';
import { HumanView } from './HumanView';

/** Editor-time (static) view for each object type. */
export const STATIC_VIEWS: Partial<Record<ObjectType, ComponentType<ViewProps>>> = {
  building: BuildingView,
  tree: TreeView,
  car: CarView,
  human: HumanView,
};

export function StaticObjectView({ obj }: ViewProps) {
  const View = STATIC_VIEWS[obj.type];
  return View ? <View obj={obj} /> : null;
}
