import { useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { DeformationEngine } from '@/deformation/engine';
import { simulationController } from '@/simulation/SimulationController';
import { useEditorStore } from '@/editor/editorStore';

/**
 * The deformation engine of the running simulation (Phase 21), or null — in the editor, before
 * the first deformation starts and after a reset. Renderers switch from the document terrain to
 * the engine's runtime terrain while it exists; a reset drops the engine, so the original
 * ground is shown again exactly (the document was never written).
 */
export function currentDeformation(): DeformationEngine | null {
  if (useEditorStore.getState().mode === 'editor') return null;
  return simulationController.getEnvironment().deformation.engine;
}

/** React view of currentDeformation() (polled per frame: the engine appears mid-run). */
export function useDeformationEngine(): DeformationEngine | null {
  const [engine, setEngine] = useState<DeformationEngine | null>(currentDeformation);
  useFrame(() => {
    const e = currentDeformation();
    if (e !== engine) setEngine(e);
  });
  return engine;
}
