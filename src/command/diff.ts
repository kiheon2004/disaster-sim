/**
 * Phase 37 — what a plan would change (§9): the edited document compared with the fork the plan ran on. The preview
 * draws exactly this — new objects as ghosts, moved ones at their new place, removed ones marked, the terrain's height
 * change as a heat map, new roads, disaster pins — so what is shown is what confirming does, including what follows
 * from an edit (objects re-seated on changed ground, objects moved with a road).
 */
import type { EntityId } from '@/core/types';
import type { WorldDocument, WorldObject } from '@/core/model';
import type { PhenomenonInstance } from '@/phenomena/types';
import { changedRect, type GridRect } from '@/terrain/TerrainData';
import { sameObjectState, samePose } from '@/world/sameObject';

export { samePose };

export interface TerrainDiff {
  rect: GridRect;
  /** Height change per vertex of the rectangle (row-major), m. */
  dh: Float32Array;
  /** 1 where the ground type changed. */
  painted: Uint8Array;
  /** Largest raise / lowering (m, both ≥ 0) and changed area (m²). */
  up: number;
  down: number;
  area: number;
}

export interface DocDiff {
  added: WorldObject[];
  removed: WorldObject[];
  /** Objects whose pose changed (place, orientation or size — not merely the numbers it is written with, see samePose). */
  moved: { before: WorldObject; after: WorldObject }[];
  /** Objects that changed in another way (name, group, flags, parameters …). */
  changed: { before: WorldObject; after: WorldObject }[];
  /** Objects written again with the same pose and content (not shown, not counted as a change). */
  rewritten: number;
  terrain: TerrainDiff | null;
  roads: { added: string[]; removed: string[]; network: WorldDocument['roads'] } | null;
  instances: { added: PhenomenonInstance[]; removed: PhenomenonInstance[]; changed: PhenomenonInstance[] };
  groupNames: boolean;
  settings: boolean;
  /** Anything at all. */
  any: boolean;
}

const byOrder = (a: WorldObject, b: WorldObject) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || a.serial - b.serial || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function diffDocuments(before: WorldDocument, after: WorldDocument): DocDiff {
  const added: WorldObject[] = [], removed: WorldObject[] = [];
  const moved: DocDiff['moved'] = [], changed: DocDiff['changed'] = [];
  let rewritten = 0;
  if (before.objects !== after.objects) {
    for (const id of Object.keys(after.objects) as EntityId[]) {
      const a = before.objects[id], b = after.objects[id];
      if (!a) added.push(b);
      else if (a === b) continue;
      else if (!samePose(a, b)) moved.push({ before: a, after: b });
      // The same pose: changed only if something else differs (an object written again with equal content is not).
      else if (sameObjectState(a, b)) rewritten++;
      else changed.push({ before: a, after: b });
    }
    for (const id of Object.keys(before.objects) as EntityId[]) if (!after.objects[id]) removed.push(before.objects[id]);
    added.sort(byOrder);
    removed.sort(byOrder);
    moved.sort((x, y) => byOrder(x.after, y.after));
    changed.sort((x, y) => byOrder(x.after, y.after));
  }

  let terrain: TerrainDiff | null = null;
  const rect: GridRect | null = changedRect(after.terrain, before.terrain);
  if (rect) {
    const t = after.terrain;
    const x0: number = rect.x0, z0: number = rect.z0, x1: number = rect.x1, z1: number = rect.z1;
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    const dh = new Float32Array(w * h), painted = new Uint8Array(w * h);
    let up = 0, down = 0, n = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i: number = z * t.nx + x, k: number = (z - z0) * w + (x - x0);
        const d = t.heights[i] - before.terrain.heights[i];
        dh[k] = d;
        if (d > up) up = d;
        if (-d > down) down = -d;
        if (t.ground[i] !== before.terrain.ground[i]) painted[k] = 1;
        if (d !== 0 || painted[k]) n++;
      }
    }
    terrain = { rect, dh, painted, up, down, area: n * t.cellSize * t.cellSize };
  }

  let roads: DocDiff['roads'] = null;
  if (before.roads !== after.roads) {
    const a = before.roads.segments, b = after.roads.segments;
    const addedSeg = Object.keys(b).filter((id) => !a[id] || JSON.stringify(a[id]) !== JSON.stringify(b[id]));
    const removedSeg = Object.keys(a).filter((id) => !b[id]);
    if (addedSeg.length || removedSeg.length) roads = { added: addedSeg, removed: removedSeg, network: after.roads };
  }

  const ia = before.scenario.experiment?.instances ?? [], ib = after.scenario.experiment?.instances ?? [];
  const instances: DocDiff['instances'] = { added: [], removed: [], changed: [] };
  if (ia !== ib) {
    const am = new Map(ia.map((x) => [x.id, x]));
    for (const x of ib) {
      const old = am.get(x.id);
      if (!old) instances.added.push(x);
      else if (old !== x && JSON.stringify(old) !== JSON.stringify(x)) instances.changed.push(x);
      am.delete(x.id);
    }
    instances.removed.push(...am.values());
  }
  const groupNames = JSON.stringify(before.groups ?? null) !== JSON.stringify(after.groups ?? null);
  const settings = before.settings !== after.settings && JSON.stringify(before.settings) !== JSON.stringify(after.settings);
  const any = added.length + removed.length + moved.length + changed.length + instances.added.length + instances.removed.length + instances.changed.length > 0 || !!terrain || !!roads || groupNames || settings;
  return { added, removed, moved, changed, rewritten, terrain, roads, instances, groupNames, settings, any };
}
