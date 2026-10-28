import { useMemo } from 'react';
import type { CarParams } from '@/objects/definitions/car';
import { carParts, PART_MATS } from '../parts/objectParts';
import { MergedBoxes } from './MergedBoxes';
import type { ViewProps } from './types';

/** Blocky vehicle baked into a single mesh (1 draw call). */
export function CarView({ obj }: ViewProps) {
  const p = obj.params as CarParams;
  const parts = useMemo(() => carParts(p).body, [p]);
  return <MergedBoxes parts={parts} mat={PART_MATS.car} />;
}
