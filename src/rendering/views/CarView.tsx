import { CAR_CLEARANCE, type CarParams } from '@/objects/definitions/car';
import { shade } from '../materials';
import { Box } from './Box';
import type { ViewProps } from './types';

const GLASS = { roughness: 0.2, metalness: 0.4 };

export function CarView({ obj }: ViewProps) {
  const p = obj.params as CarParams;
  const L = p.length;
  const W = p.width;
  const chassisH = (p.height - CAR_CLEARANCE) * 0.5;
  const cabinH = p.height - CAR_CLEARANCE - chassisH;
  const chassisY = CAR_CLEARANCE + chassisH / 2;
  const wheel = Math.min(0.8, CAR_CLEARANCE * 2.2);
  const wx = L / 2 - Math.max(0.6, L * 0.18);
  const wz = W / 2 - 0.12;
  const isTruck = p.variant === 'truck';

  return (
    <group>
      <Box size={[L, chassisH, W]} position={[0, chassisY, 0]} color={p.color} mat={{ roughness: 0.45, metalness: 0.35 }} />
      {isTruck ? (
        <>
          {/* Cab at the front (+X) */}
          <Box size={[L * 0.22, cabinH, W * 0.96]} position={[L * 0.38, CAR_CLEARANCE + chassisH + cabinH / 2, 0]} color={shade(p.color, -0.08)} />
          <Box size={[0.05, cabinH * 0.5, W * 0.8]} position={[L * 0.49 + 0.01, CAR_CLEARANCE + chassisH + cabinH * 0.62, 0]} color="#22303c" mat={GLASS} />
          {/* Cargo box */}
          <Box size={[L * 0.74, cabinH + 0.25, W]} position={[-L * 0.12, CAR_CLEARANCE + chassisH + (cabinH + 0.25) / 2, 0]} color="#e9e6df" />
        </>
      ) : (
        <>
          <Box size={[L * 0.55, cabinH, W * 0.9]} position={[-L * 0.05, CAR_CLEARANCE + chassisH + cabinH / 2, 0]} color="#22303c" mat={GLASS} />
          <Box size={[L * 0.5, 0.08, W * 0.86]} position={[-L * 0.05, CAR_CLEARANCE + chassisH + cabinH + 0.02, 0]} color={p.color} mat={{ roughness: 0.45, metalness: 0.35 }} />
        </>
      )}
      {/* Wheels */}
      {[
        [wx, wz], [wx, -wz], [-wx, wz], [-wx, -wz],
      ].map(([x, z], i) => (
        <Box key={i} size={[wheel, wheel, 0.28]} position={[x, wheel / 2, z]} color="#1c1d20" />
      ))}
      {/* Lights */}
      <Box size={[0.06, 0.18, 0.36]} position={[L / 2 + 0.02, chassisY + chassisH * 0.15, W * 0.32]} color="#fff6c8" mat={{ emissive: '#fff1a8', emissiveIntensity: 0.6 }} shadow={false} />
      <Box size={[0.06, 0.18, 0.36]} position={[L / 2 + 0.02, chassisY + chassisH * 0.15, -W * 0.32]} color="#fff6c8" mat={{ emissive: '#fff1a8', emissiveIntensity: 0.6 }} shadow={false} />
      <Box size={[0.06, 0.16, 0.3]} position={[-L / 2 - 0.02, chassisY + chassisH * 0.15, W * 0.34]} color="#d63b3b" mat={{ emissive: '#8a1010', emissiveIntensity: 0.6 }} shadow={false} />
      <Box size={[0.06, 0.16, 0.3]} position={[-L / 2 - 0.02, chassisY + chassisH * 0.15, -W * 0.34]} color="#d63b3b" mat={{ emissive: '#8a1010', emissiveIntensity: 0.6 }} shadow={false} />
    </group>
  );
}
