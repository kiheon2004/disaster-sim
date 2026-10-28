/** Development-only render counter, used by the performance check to catch per-tick re-renders. */
export function countRender(name: string) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __renders?: Record<string, number> };
  const r = (w.__renders ??= {});
  r[name] = (r[name] ?? 0) + 1;
}
