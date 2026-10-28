import { smoothstep } from '@/core/math';
import { simulationController } from '@/simulation/SimulationController';

/**
 * Visual storm intensity 0–1 derived from the global wind. Read-only access to simulation state:
 * nothing in the environment layer ever writes back into the simulation.
 */
export function stormIntensity(): number {
  return smoothstep(6, 55, simulationController.getEnvironment().wind.baseSpeed);
}

/**
 * Visual weather intensity 0–1 for sky, clouds and falling rain: the stronger of the storm (wind)
 * and the rain falling in the water model (Phase 14; 80 mm/h ≈ full rain). Read-only.
 */
export function weatherIntensity(): number {
  const mm = simulationController.getEnvironment().flood.rainIntensity();
  const rain = mm > 0 ? 0.25 + 0.65 * Math.min(1, mm / 80) : 0;
  return Math.max(stormIntensity(), rain);
}

export function globalFlow() {
  const w = simulationController.getEnvironment().wind;
  return { flow: w.flow(), speed: w.baseSpeed };
}
