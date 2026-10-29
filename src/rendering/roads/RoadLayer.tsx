import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useWorldStore } from '@/world/worldStore';
import { RoadBatches } from './RoadBatches';

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
  useEffect(() => {
    batches?.sync(roads, terrain);
  }, [batches, roads, terrain]);
  useFrame(({ camera }) => batches?.updateLod(camera));
  if (!batches) return null;
  return <primitive object={batches.root} />;
}
