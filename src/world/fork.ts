/**
 * A copy of a document that can be edited without touching the original (Phase 37): the terrain and layer arrays —
 * edited in place by every terrain / road edit — are copied; objects, roads, features, settings and the scenario are
 * immutable values and stay shared. `scratchWorld(doc)` alone shares the arrays: running a plan on it would change the
 * app's terrain (the command preview runs plans on a fork, never on the document).
 */
import type { WorldDocument } from '@/core/model';

export function forkDocument(doc: WorldDocument): WorldDocument {
  const t = doc.terrain, l = doc.landscape;
  return {
    ...doc,
    terrain: { ...t, heights: t.heights.slice(), ground: t.ground.slice(), soil: t.soil.slice(), settings: { ...t.settings } },
    landscape: {
      ...l,
      base: { heights: l.base.heights.slice(), ground: l.base.ground.slice() },
      sculpt: l.sculpt.slice(),
      paint: l.paint.slice(),
      natural: { heights: l.natural.heights.slice(), ground: l.natural.ground.slice(), culvert: l.natural.culvert.slice(), roadBase: l.natural.roadBase.slice() },
    },
  };
}
