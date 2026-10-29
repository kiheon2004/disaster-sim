import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useWorldStore } from '@/world/worldStore';
import { RoadBatches } from './RoadBatches';
import { useDeformationEngine } from '../terrain/runtimeGround';

/** The mounted road batches (perf HUD, benchmarks, browser verification). */
let active: RoadBatches | null = null;
export const getRoadBatches = () => active;

/**
 * Road network meshes (Phase 18), drawn over the baked terrain in both editor and simulation
 * views (the simulation never edits the document's roads; road damage is an overlay).
 */
export function RoadLayer() {
  const roads = useWorldStore((s) => s.doc.roads);
  const terrain = useWorldStore((s) => s.doc.terrain);
  // Created in an effect (StrictMode-safe, like the other batch layers).
  const [batches, setBatches] = useState<RoadBatches | null>(null);
  useEffect(() => {
    const b = new RoadBatches();
    setBatches(b);
    active = b;
    return () => {
      if (active === b) active = null;
      b.dispose();
    };
  }, []);
  // Simulation with a terrain deformation (Phase 21): the roads drape over the run's deformed
  // ground (only chunks over changed heights are rebuilt, at most 5 times a second). The road
  // network itself is never edited — damage and passability are overlays.
  const engine = useDeformationEngine();
  const synced = useRef({ rev: -1, at: 0 });
  useEffect(() => {
    if (!batches) return;
    batches.sync(roads, engine ? engine.terrain : terrain);
    synced.current = { rev: engine?.rev ?? -1, at: performance.now() };
  }, [batches, roads, terrain, engine]);
  useFrame(({ camera }) => {
    if (batches && engine && engine.rev !== synced.current.rev && performance.now() - synced.current.at > 200 && Object.keys(roads.segments).length > 0) {
      batches.sync(roads, engine.terrain);
      synced.current = { rev: engine.rev, at: performance.now() };
    }
    batches?.updateLod(camera);
  });
  if (!batches) return null;
  return <primitive object={batches.root} />;
}
