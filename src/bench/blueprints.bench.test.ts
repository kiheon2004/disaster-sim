/**
 * Phase 20: cost of blueprints without a rendering context — capture, file size / serialize /
 * parse, placement plan (terrain merge, road paste, validation), commit (one atomic edit: layer
 * recomposition, road bake, seating), undo / redo, world save / load, for
 *   buildings 100 / 500 / 1000, roads + buildings, nature (mountain + river + forest),
 *   city + nature, repeated placement of one blueprint.
 *
 *   BENCH=1 npx vitest run src/bench/blueprints --silent=false      (BENCH_OUT=file.json to save)
 */
import fs from 'node:fs';
import os from 'node:os';
import { describe, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { createEmptyDocument } from '@/world/WorldDocument';
import { parseDocument, serializeDocument } from '@/world/serialization';
import { generateTerrain } from '@/terrain/TerrainPresets';
import { presetDesign } from '@/roads/city';
import { drawRoad } from '@/roads/network';
import { defaultProfile } from '@/roads/types';
import { roadStats } from '@/roads/stats';
import { buildTemplate } from '@/templates/builtin';
import { captureBlueprint } from '@/blueprints/capture';
import { defaultPlacement, planPlacement, type PlacementOptions } from '@/blueprints/place';
import { parseBlueprintText, serializeBlueprint } from '@/blueprints/schema';
import { buildBuiltinBlueprint } from '@/blueprints/builtin';
import type { UnifiedBlueprint } from '@/blueprints/types';
import type { WorldDocument } from '@/core/model';
import type { BuildingDesign } from '@/buildings/types';

const S = () => useWorldStore.getState();
const time = <T>(fn: () => T): [T, number] => { const t0 = performance.now(); const r = fn(); return [r, +(performance.now() - t0).toFixed(1)]; };
const heapMB = () => { (globalThis as { gc?: () => void }).gc?.(); return +(process.memoryUsage().heapUsed / 1048576).toFixed(1); };

/** N modular buildings (3 shared designs) on a grid around two crossing streets. */
function buildingsWorld(n: number, roads = false): WorldDocument {
  S().setLocked(false);
  S().replaceDocument(createEmptyDocument('src'));
  if (roads) {
    let net = drawRoad(S().doc.roads, [[-96, 0], [96, 0]], { curved: false, profile: defaultProfile() }).network;
    net = drawRoad(net, [[0, -96], [0, 96]], { curved: false, profile: defaultProfile() }).network;
    S().applyEdit({ roads: net });
  }
  const designs = [presetDesign('house', 2)!, presetDesign('house', 1)!, presetDesign('apartment', 4)!];
  const inputs = [];
  const step = n <= 100 ? 16 : n <= 500 ? 8.5 : 6;
  for (let z = -94; z <= 94 && inputs.length < n; z += step) {
    for (let x = -94; x <= 94 && inputs.length < n; x += step) {
      if (roads && (Math.abs(x) < 8 || Math.abs(z) < 8)) continue;
      // Three shared designs for small scenes; one compact house design for the dense grids.
      const design: BuildingDesign = n > 100 ? designs[1] : designs[inputs.length % 3];
      inputs.push({ type: 'building' as const, building: design, seed: inputs.length + 1, transform: { position: [x, 0, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } });
    }
  }
  S().applyEdit({ add: inputs });
  return S().doc;
}

/** Destination: gentle hills (terrain merge has work to do). */
function destination() {
  const doc = createEmptyDocument('dst');
  doc.terrain = generateTerrain('gentleHills', 4);
  S().replaceDocument(doc);
}

function measure(name: string, bp: UnifiedBlueprint, captureMs: number, opts: Partial<PlacementOptions>) {
  const [text, serializeMs] = time(() => serializeBlueprint(bp));
  const [parsed, parseMs] = time(() => parseBlueprintText(text));
  if (!parsed.ok) throw new Error(parsed.detail);
  destination();
  const o = { ...defaultPlacement(), ...opts };
  const [plan, planMs] = time(() => planPlacement(S().doc, parsed.blueprint, o));
  const heap0 = heapMB();
  roadStats.lastBakeMs = 0;
  const [, commitMs] = time(() => S().applyEdit(plan.edit));
  const roadBakeMs = +roadStats.lastBakeMs.toFixed(1);
  const [, undoMs] = time(() => S().undo());
  const [, redoMs] = time(() => S().redo());
  const [json, saveMs] = time(() => serializeDocument(S().doc, false));
  const [loaded, loadMs] = time(() => parseDocument(json));
  // Terrain merge alone: the same placement with only the terrain layers (+ landforms / water).
  S().undo();
  const terrainOnly = { ...o, include: { buildings: false, objects: false, vegetation: false, roads: false, landforms: true, water: true, waterState: true, terrain: true } };
  const [tplan, terrainPlanMs] = time(() => planPlacement(S().doc, parsed.blueprint, terrainOnly));
  // (No terrain layers to merge — e.g. a flat source with the offset policy — gives null.)
  const terrainCommitMs = tplan.edit.landscape ? time(() => S().applyEdit(tplan.edit))[1] : null;
  const row = {
    scene: name,
    objects: bp.preview.counts.objects, trees: bp.preview.counts.vegetation, roads: bp.preview.counts.roads, features: bp.preview.counts.features,
    captureMs, blueprintKB: Math.round(text.length / 1024), serializeMs, parseMs,
    planMs, commitMs, undoMs, redoMs, roadBakeMs, terrainPlanMs, terrainCommitMs,
    worldSaveMs: saveMs, worldLoadMs: loadMs, worldKB: Math.round(json.length / 1024), recomposed: loaded.ok ? loaded.landscape.recomposedVertices : -1,
    heapBeforeCommitMB: heap0, heapAfterMB: heapMB(),
    warnings: plan.report.warnings.map((w) => w.code).join(','),
  };
  console.log(JSON.stringify(row));
  return row;
}

describe.skipIf(!process.env.BENCH)('blueprint cost', () => {
  it('capture / plan / commit / undo / redo / files', { timeout: 1_800_000 }, () => {
    const rows: Record<string, unknown>[] = [];
    const cap = (doc: WorldDocument, r: [number, number, number, number], opts = {}) => time(() => captureBlueprint(doc, { shape: { kind: 'rect', x0: r[0], z0: r[1], x1: r[2], z1: r[3] } }, opts).blueprint);
    for (const n of [100, 500, 1000]) {
      const src = buildingsWorld(n);
      const [bp, ms] = cap(src, [-99, -99, 99, 99]);
      rows.push(measure(`buildings${n}`, bp, ms, { x: 0, z: 0, terrain: 'offset' }));
    }
    {
      const src = buildingsWorld(300, true);
      const [bp, ms] = cap(src, [-99, -99, 99, 99], { roads: 'clip' });
      rows.push(measure('roadsBuildings', bp, ms, { x: 0, z: 0, terrain: 'offset', roads: 'connect' }));
    }
    {
      const src = buildTemplate('mountainVillage', 2);
      const [bp, ms] = cap(src, [-99, -99, 99, 40], { nature: 'clip' });
      rows.push(measure('natureMountainRiverForest', bp, ms, { x: 0, z: -20, terrain: 'apply' }));
    }
    {
      const src = buildTemplate('riverValley', 3);
      const [bp, ms] = cap(src, [-99, -99, 99, 99], { roads: 'clip', nature: 'clip' });
      rows.push(measure('cityNature', bp, ms, { x: 0, z: 0, terrain: 'blend', roads: 'snap' }));
    }
    // Repeated placement of one blueprint (20 houses at different spots), then undo all.
    const house = buildBuiltinBlueprint('house');
    destination();
    const heap0 = heapMB();
    const times: number[] = [];
    for (let k = 0; k < 20; k++) {
      const plan = planPlacement(S().doc, house, { ...defaultPlacement(), x: -80 + (k % 5) * 40, z: -80 + Math.floor(k / 5) * 40, yaw: (k * Math.PI) / 7 });
      times.push(time(() => S().applyEdit(plan.edit))[1]);
    }
    const [, undoAll] = time(() => { for (let k = 0; k < 20; k++) S().undo(); });
    const med = [...times].sort((a, b) => a - b)[10];
    const repeat = { scene: 'repeatHouse20', medianCommitMs: med, maxCommitMs: Math.max(...times), undo20Ms: +undoAll.toFixed(1), heapGrowthMB: +(heapMB() - heap0).toFixed(1), objectsAfterUndo: Object.keys(S().doc.objects).length };
    console.log(JSON.stringify(repeat));
    rows.push(repeat);
    const out = { date: new Date().toISOString(), node: process.version, cpus: os.cpus()[0]?.model, load: os.loadavg().map((v) => +v.toFixed(1)), rows };
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2));
  });
});
