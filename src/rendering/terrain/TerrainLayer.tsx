import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { WORLD_SIZE } from '@/core/units';
import { useWorldStore } from '@/world/worldStore';
import { samplerFor } from '@/terrain/TerrainSampler';
import { useViewStore } from '../viewStore';
import { grassTexture } from '../textures';
import { createTerrainMaterial, TerrainSurface } from './TerrainSurface';
import { takeTerrainDirty } from './terrainDirty';

const OUTER = 3000;

/** The original flat ground (unchanged rendering path for flat, unpainted terrain). */
function FlatGround({ showGrid }: { showGrid: boolean }) {
  const grass = useMemo(() => {
    const t = grassTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(WORLD_SIZE / 2, WORLD_SIZE / 2);
    return t;
  }, []);
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} receiveShadow name="ground">
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
        <meshStandardMaterial map={grass} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[OUTER, OUTER]} />
        <meshStandardMaterial color="#56703f" roughness={1} />
      </mesh>
      <lineSegments position-y={0.03}>
        <edgesGeometry args={[new THREE.BoxGeometry(WORLD_SIZE, 0, WORLD_SIZE)]} />
        <lineBasicMaterial color="#f5f8ff" transparent opacity={0.35} />
      </lineSegments>
      {showGrid && (
        <Grid
          position={[0, 0.02, 0]}
          args={[WORLD_SIZE, WORLD_SIZE]}
          cellSize={1}
          cellThickness={0.5}
          cellColor="#2f4a26"
          sectionSize={10}
          sectionThickness={1}
          sectionColor="#24391d"
          fadeDistance={160}
          fadeStrength={1.5}
          infiniteGrid={false}
        />
      )}
    </>
  );
}

/** Surroundings with a hole for the terrain block (so valleys below 0 m are not covered). */
function OuterRing() {
  const half = WORLD_SIZE / 2;
  const w = (OUTER - WORLD_SIZE) / 2;
  const strips: [number, number, number, number][] = [
    [0, -half - w / 2, OUTER, w],
    [0, half + w / 2, OUTER, w],
    [-half - w / 2, 0, w, WORLD_SIZE],
    [half + w / 2, 0, w, WORLD_SIZE],
  ];
  return (
    <>
      {strips.map(([x, z, sx, sz], i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[x, -0.05, z]} receiveShadow>
          <planeGeometry args={[sx, sz]} />
          <meshStandardMaterial color="#56703f" roughness={1} />
        </mesh>
      ))}
    </>
  );
}

function TerrainMesh({ showGrid }: { showGrid: boolean }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const mode = useViewStore((s) => s.terrainView);
  // One surface per grid (commits share the arrays and only bump the object identity).
  const surface = useMemo(() => new TerrainSurface(terrain, mode), [terrain.heights, terrain.ground, terrain.soil]); // eslint-disable-line react-hooks/exhaustive-deps
  const { material, uniforms } = useMemo(createTerrainMaterial, []);
  const skirtMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#7a6249', roughness: 1, side: THREE.DoubleSide }), []);
  const lastRev = useRef(terrain.revision);
  const [water, setWater] = useState<number | null>(null);

  useEffect(() => () => surface.dispose(), [surface]);
  useEffect(() => surface.setMode(mode), [surface, mode]);
  uniforms.uContours.value = mode === 'elevation' ? 1 : 0;
  uniforms.uGrid.value = showGrid ? 1 : 0;

  // A committed change (stroke end, undo/redo, preset, layer edit): the changed rectangle only
  // (whole mesh when unknown), then bounds / skirt.
  useEffect(() => {
    takeTerrainDirty();
    const r = useWorldStore.getState().terrainRect;
    surface.update(r);
    if (r) surface.finish();
    lastRev.current = terrain.revision;
    const s = samplerFor(terrain);
    const wl = terrain.settings.waterLevel;
    setWater(wl !== null && s.minHeight < wl ? wl : null);
  }, [terrain, surface]);

  // Live sculpting: only the dabbed rectangle.
  useFrame(() => {
    if (terrain.revision === lastRev.current) return;
    lastRev.current = terrain.revision;
    surface.update(takeTerrainDirty());
  });

  return (
    <group>
      <mesh name="ground" geometry={surface.geometry} material={material} receiveShadow castShadow />
      <mesh geometry={surface.skirt} material={skirtMat} receiveShadow />
      <lineSegments geometry={surface.outline}>
        <lineBasicMaterial color="#f5f8ff" transparent opacity={0.35} />
      </lineSegments>
      <OuterRing />
      {/* (2 cm below the level: ground lying exactly at the level does not z-fight with a coplanar water plane.) */}
      {water !== null && (
        <mesh rotation-x={-Math.PI / 2} position-y={water - 0.02} renderOrder={2} raycast={() => null}>
          <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
          <meshStandardMaterial color="#3f86b8" transparent opacity={0.55} roughness={0.15} metalness={0.1} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

/**
 * Ground of the scene. Flat, unpainted terrain keeps the original two-triangle plane + grid
 * (zero cost); as soon as the terrain has relief or painted ground the heightfield mesh is used.
 */
export function TerrainLayer({ showGrid }: { showGrid: boolean }) {
  const terrain = useWorldStore((s) => s.doc.terrain);
  const view = useViewStore((s) => s.terrainView);
  // A painted soil layer only needs the mesh while the soil map is shown.
  const plainNow = () => {
    const s = samplerFor(terrain);
    return s.flat && s.uniformGround && (s.uniformSoil || useViewStore.getState().terrainView !== 'soil');
  };
  const [plain, setPlain] = useState(plainNow);
  useEffect(() => setPlain(plainNow()), [terrain, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // The first dab on a flat terrain changes the data without a new document: switch then.
  useFrame(() => {
    const now = plainNow();
    if (now !== plain) setPlain(now);
  });
  return plain ? <FlatGround showGrid={showGrid} /> : <TerrainMesh showGrid={showGrid} />;
}
