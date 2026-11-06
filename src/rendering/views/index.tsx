import type { ComponentType } from 'react';
import type { ObjectType } from '@/core/types';
import type { ViewProps } from './types';
import { BuildingView } from './BuildingView';
import { TreeView } from './TreeView';
import { CarView } from './CarView';
import { HumanView } from './HumanView';
import { RoadView, SignView, StreetLightView, WallView } from './InfrastructureViews';
import { PassiveObjectView } from './PassiveObjectView';

/** Editor-time (static) view for each object type. */
export const STATIC_VIEWS: Partial<Record<ObjectType, ComponentType<ViewProps>>> = {
  building: BuildingView,
  tree: TreeView,
  car: CarView,
  human: HumanView,
  streetLight: StreetLightView,
  sign: SignView,
  wall: WallView,
  road: RoadView,
  // Phase 35 Level 1 passive dynamic objects.
  crate: PassiveObjectView,
  barrel: PassiveObjectView,
  container: PassiveObjectView,
  furniture: PassiveObjectView,
  roadBarrier: PassiveObjectView,
  ball: PassiveObjectView,
};

export function StaticObjectView({ obj }: ViewProps) {
  const View = STATIC_VIEWS[obj.type];
  return View ? <View obj={obj} /> : null;
}
