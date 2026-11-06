import { useMemo } from 'react';
import { passiveParts } from '../parts/dynamicObjectParts';
import { PART_MATS } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';
import type { ViewProps } from './types';

/** Phase 35 passive objects (crate, barrel, container, furniture, road barrier, ball) baked into one mesh. */
export function PassiveObjectView({ obj }: ViewProps) {
  const pp = useMemo(() => passiveParts(obj.type, obj.params), [obj.type, obj.params]);
  return pp ? <MergedBoxes parts={pp.body} mat={PART_MATS[pp.mat]} /> : null;
}
