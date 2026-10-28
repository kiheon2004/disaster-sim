import { useMemo } from 'react';
import { CAR_CLEARANCE, type CarParams } from '@/objects/definitions/car';
import { shade } from '../materials';
import { MergedBoxes, type BoxPart } from './MergedBoxes';
import type { ViewProps } from './types';

/** Blocky vehicle baked into a single mesh (1 draw call). */
export function CarView({ obj }: ViewProps) {
  const p = obj.params as CarParams;
  const parts = useMemo<BoxPart[]>(() => {
    const L = p.length;
    const W = p.width;
    const chassisH = (p.height - CAR_CLEARANCE) * 0.5;
    const cabinH = p.height - CAR_CLEARANCE - chassisH;
    const chassisY = CAR_CLEARANCE + chassisH / 2;
    const wheel = Math.min(0.8, CAR_CLEARANCE * 2.2);
    const wx = L / 2 - Math.max(0.6, L * 0.18);
    const wz = W / 2 - 0.12;
    const out: BoxPart[] = [{ size: [L, chassisH, W], position: [0, chassisY, 0], color: p.color }];
    if (p.variant === 'truck') {
      out.push(
        { size: [L * 0.22, cabinH, W * 0.96], position: [L * 0.38, CAR_CLEARANCE + chassisH + cabinH / 2, 0], color: shade(p.color, -0.08) },
        { size: [0.05, cabinH * 0.5, W * 0.8], position: [L * 0.49 + 0.01, CAR_CLEARANCE + chassisH + cabinH * 0.62, 0], color: '#22303c' },
        { size: [L * 0.74, cabinH + 0.25, W], position: [-L * 0.12, CAR_CLEARANCE + chassisH + (cabinH + 0.25) / 2, 0], color: '#e9e6df' },
      );
    } else {
      out.push(
        { size: [L * 0.55, cabinH, W * 0.9], position: [-L * 0.05, CAR_CLEARANCE + chassisH + cabinH / 2, 0], color: '#22303c' },
        { size: [L * 0.5, 0.08, W * 0.86], position: [-L * 0.05, CAR_CLEARANCE + chassisH + cabinH + 0.02, 0], color: p.color },
      );
    }
    for (const [x, z] of [[wx, wz], [wx, -wz], [-wx, wz], [-wx, -wz]]) {
      out.push({ size: [wheel, wheel, 0.28], position: [x, wheel / 2, z], color: '#1c1d20' });
    }
    for (const s of [1, -1]) {
      out.push({ size: [0.06, 0.18, 0.36], position: [L / 2 + 0.02, chassisY + chassisH * 0.15, s * W * 0.32], color: '#fff6c8' });
      out.push({ size: [0.06, 0.16, 0.3], position: [-L / 2 - 0.02, chassisY + chassisH * 0.15, s * W * 0.34], color: '#d63b3b' });
    }
    return out;
  }, [p.length, p.width, p.height, p.variant, p.color]);
  return <MergedBoxes parts={parts} mat={{ roughness: 0.55, metalness: 0.2 }} />;
}
