/**
 * Fire scenario preview in the editor (Phase 27) — from the same outlook as the panel: the ignition
 * sphere, every object it reaches marked as fuel (orange) or not (grey), the room the point lies in
 * (its box), and the reference exposure circles (12.5 / 5 kW/m² of the fuel-controlled peak as a
 * point flame — labelled as a reference, not a prediction of the spread).
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { getDefinition } from '@/objects/registry';
import { fireOutlook } from '@/fire/outlook';
import { defaultFireSettings, type FireSpec } from '@/fire/types';
import type { PhenomenonInstance } from '@/phenomena/types';
import { AimMarker, GroundLine, circlePts } from '../ground/GroundTools';
import { yawOf } from '@/terrain/groundPlacement';

export function FirePreview({ inst }: { inst: PhenomenonInstance }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const objects = useWorldStore((s) => s.doc.objects);
  const settings = useWorldStore((s) => s.doc.settings.simulation.fire) ?? defaultFireSettings();
  const spec = inst.spec as FireSpec;
  const s = useMemo(() => samplerFor(terrain), [terrain]);
  const out = useMemo(() => fireOutlook(spec, objects, (x, z) => s.sampleHeight(x, z), settings), [spec, objects, s, settings]);
  const [x, z] = spec.position;
  const y = s.sampleHeight(x, z) + spec.height;
  const room = out.room ? objects[out.room.building] : null;
  let roomBox: { p: [number, number, number]; size: [number, number, number]; yaw: number } | null = null;
  if (room && room.building && out.room) {
    const d = getDefinition(room.type).getDimensions(room.params);
    const sp = room.building.spec, sy = room.transform.scale[1];
    let y0 = room.transform.position[1];
    for (let k = 0; k < out.room.story; k++) y0 += (k === 0 ? sp.groundFloorHeight ?? sp.floorHeight : sp.floorHeight) * sy;
    const h = (out.room.story === 0 ? sp.groundFloorHeight ?? sp.floorHeight : sp.floorHeight) * sy;
    roomBox = { p: [room.transform.position[0], y0 + h / 2, room.transform.position[2]], size: [d[0] * room.transform.scale[0] + 0.2, h, d[2] * room.transform.scale[2] + 0.2], yaw: yawOf(room.transform.rotation) };
  }
  return (
    <group name="fire-preview">
      <AimMarker x={x} z={z} color="#ff5a1f" r={0.6} />
      <mesh position={[x, y, z]} scale={spec.radius} raycast={() => null}>
        <sphereGeometry args={[1, 24, 12]} />
        <meshBasicMaterial color="#ff5a1f" wireframe transparent opacity={0.6} />
      </mesh>
      {roomBox && (
        <mesh position={roomBox.p} rotation={[0, roomBox.yaw, 0]} scale={roomBox.size} raycast={() => null}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color="#ff8a3d" transparent opacity={0.18} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {out.objects.filter((o) => o.distance <= spec.radius + 15).map((o) => {
        const obj = objects[o.id];
        if (!obj) return null;
        const d = getDefinition(obj.type).getDimensions(obj.params);
        const r = Math.max(0.8, Math.hypot(d[0] * obj.transform.scale[0], d[2] * obj.transform.scale[2]) / 2);
        const color = o.fuel.length === 0 ? '#9aa1a8' : o.tooMoist ? '#5f9ac8' : o.inSphere ? '#ff5a1f' : '#f2c230';
        return <GroundLine key={o.id} pts={circlePts(obj.transform.position[0], obj.transform.position[2], r, 40)} color={color} dashed={!o.inSphere} />;
      })}
      {out.r5 > spec.radius && <GroundLine pts={circlePts(x, z, out.r5, 96)} color="#f2c230" dashed />}
      {out.r12 > spec.radius && <GroundLine pts={circlePts(x, z, out.r12, 96)} color="#e0503a" dashed />}
    </group>
  );
}
