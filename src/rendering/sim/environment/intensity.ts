import { smoothstep } from '@/core/math';
import { simulationController } from '@/simulation/SimulationController';

/**
 * Visual storm intensity 0–1 derived from the global wind. Read-only access to simulation state:
 * nothing in the environment layer ever writes back into the simulation.
 */
export function stormIntensity(): number {
  return smoothstep(6, 55, simulationController.getEnvironment().wind.baseSpeed);
}

export function globalFlow() {
  const w = simulationController.getEnvironment().wind;
  return { flow: w.flow(), speed: w.baseSpeed };
}
