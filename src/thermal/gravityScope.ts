/**
 * Gravity of a system's step (Phase 31). The heat-transfer, fire, volcano, climate and atmosphere models run inside the
 * ThermalSystem's synchronous update, the slope-stability / sinkhole / runout models inside the GroundFailureSystem's;
 * their gravity terms (often Earth-calibrated) read the gravity of that step from here:
 *
 *   magnitude  |g| / g₀    natural convection (Ra ∝ g: Nu correlations are dimensionless and hold inside their Ra range)
 *   down       g_down / g₀ (≥ 0)  buoyant RISE along +y: air-layer venting / updraft, smoke and room exchange, flame
 *                          height, ash fall, lava drive, snow overburden, soil unit weights and the runout's drive /
 *                          Coulomb friction — a tilted or reversed field cannot be represented by these vertical models
 *                          (documented limit; the outlook flags them)
 *
 * Both are 1 outside a gravity experiment (every product with them is then bitwise the Phase 26–30 value). The scope is
 * set by the SimulationController for one fixed step (scheduler and every system), a synchronous call and reset afterwards (no other code runs in
 * between — JavaScript is single-threaded and the update awaits nothing).
 */
const scope = { magnitude: 1, down: 1 };

export function gravityMagnitude(): number {
  return scope.magnitude;
}

export function gravityDown(): number {
  return scope.down;
}

/** Run `fn` under the given ratios (restored afterwards, also on throw). */
export function withGravity<T>(magnitude: number, down: number, fn: () => T): T {
  const m = scope.magnitude, d = scope.down;
  scope.magnitude = magnitude;
  scope.down = Math.max(0, down);
  try {
    return fn();
  } finally {
    scope.magnitude = m;
    scope.down = d;
  }
}
