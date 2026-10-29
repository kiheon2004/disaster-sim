import { useEffect, useMemo } from 'react';

/**
 * A three.js resource (geometry, material, …) owned by a component: created like useMemo and
 * disposed when the dependencies change or the component unmounts. React Three Fiber disposes only
 * the objects it creates from JSX — a geometry / material made in useMemo and passed as a prop was
 * never released, so every simulation run left GPU geometries and materials behind (found by the
 * Phase 23 stress test, scripts/stress-runs.mjs).
 */
export function useDisposable<T extends { dispose(): void }>(factory: () => T, deps: readonly unknown[] = []): T {
  const value = useMemo(factory, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => value.dispose(), [value]);
  return value;
}
