/**
 * Phase 36 (structure): identity of the cell colliders, the fragment nudge and the render-only changes.
 *
 * The expected hashes were recorded on the BASE code (commit 09009f5, before any Phase 36 structure change) with
 *   P36_RECORD=out.txt npx vitest run src/simulation/structure/colliders.identity.test.ts --maxWorkers=1
 * (P36_RECORD = an output file) which appends one SHA-256 per scene instead of comparing. Every scene below must keep its hash after the change:
 *  - v1 (no structure setting) modular buildings with partial collapse — earthquake and blast: v1 must stay bit-identical,
 *    the cell colliders and the new fragment nudge are v2-only;
 *  - v2 scenes in which no plan cell is removed (weak quake, a far blast that only breaks facade parts): the building keeps
 *    the body RuntimeBuilder made and the nudge keeps its original rule, so these runs are bit-identical too.
 * The hash covers damage events, every entity's state / pose / seismic response, the collapse records and member offsets,
 * rubble heaps, fragment poses and the physics body count. v2 runs WITH a partial collapse are expected to change
 * (the intended fix) and are covered by colliders.test.ts instead.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/core/types';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { createEmptyDocument, createWorldObject, nextSerial, type CreateObjectInput } from '@/world/WorldDocument';
import { createDesign } from '@/buildings/design';
import { defaultSpec, presetSpec } from '@/buildings/spec';
import type { BuildingSpec } from '@/buildings/types';
import { defaultTownObjects } from '@/world/defaultTown';
import { SimulationController } from '../SimulationController';

const T = (x = 0, z = 0, yaw = 0): CreateObjectInput['transform'] => ({ position: [x, 0, z] as Vec3, rotation: [0, yaw, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const B = (spec: BuildingSpec, preset: string | undefined, x: number, z: number, seed: number, yaw = 0): CreateObjectInput => ({ type: 'building', building: createDesign(spec, preset), seed, transform: T(x, z, yaw) });
const P = (id: string, x: number, z: number, seed: number, yaw = 0) => B(presetSpec(id)!, id, x, z, seed, yaw);
const car = (x: number, z: number, seed: number): CreateObjectInput => ({ type: 'car', seed, transform: T(x, z) });
// The default town's masonry and reinforced-concrete frames (world/defaultTown.ts).
const masonry = (p: Partial<BuildingSpec>): BuildingSpec => ({ ...defaultSpec(), system: 'masonry', structureMaterial: 'masonry', slabMaterial: 'reinforcedConcrete', claddingMaterial: 'masonry', foundation: 'spread', bay: 4, occupancy: 'residential', ...p });
const rc = (p: Partial<BuildingSpec>): BuildingSpec => ({ ...defaultSpec(), system: 'rcFrame', ...p });

function doc(inputs: CreateObjectInput[], v2: boolean): WorldDocument {
  const d = createEmptyDocument('p36-identity');
  for (const input of inputs) {
    const o = createWorldObject(input, nextSerial(d.objects, input.type));
    d.objects[o.id] = o;
  }
  d.settings.simulation.seed = 42;
  if (v2) d.settings.simulation.structure = { model: 'v2' };
  return d;
}

const quake = (pga: number, seed = 3): EventSpec => ({ event: 'earthquake', magnitude: 7.5, pga, duration: 20, seed } as EventSpec);
const blast = (x: number, z: number, energy: number): EventSpec => ({ event: 'blast', position: [x, z], height: 1, energy, model: 'weakShock', waveform: 'nWave', startTime: 0.3 } as EventSpec);

export interface IdentityScene { name: string; doc: () => WorldDocument; events: EventSpec[]; seconds: number; kind: 'v1' | 'v1-partial' | 'v2-intact' | 'v2-partial' }
export const SCENES: IdentityScene[] = [
  { name: 'v1 street quake 1.1 g', kind: 'v1-partial', doc: () => doc([P('apartment', 0, 0, 1), P('house', 18, 0, 2), car(-10, 10, 20), car(-4, 10, 21), car(2, 10, 22)], false), events: [quake(1.1)], seconds: 14 },
  {
    name: 'v1 town quake 0.9 g', kind: 'v1-partial',
    doc: () => doc([
      B(masonry({ width: 12, depth: 10, floors: 3 }), undefined, -22, -14, 11), B(rc({ width: 12, depth: 10, floors: 5, sign: true }), undefined, 0, -14, 12),
      P('house', 18, -13, 13), B(rc({ width: 12, depth: 9, floors: 2 }), undefined, 0, 14, 14, Math.PI),
      B({ ...presetSpec('warehouse')!, width: 14, depth: 10, floorHeight: 5, groundFloorHeight: 5 }, 'warehouse', -22, 16, 15, Math.PI), car(-10, -4, 30), car(10, 4, 31),
    ], false),
    events: [quake(0.9, 5)], seconds: 12,
  },
  { name: 'v1 blast 10 GJ (partial collapse)', kind: 'v1-partial', doc: () => doc([P('apartment', 0, 0, 1), P('house', 0, 16, 2), P('house', 16, 0, 3), car(-8, 9, 23)], false), events: [blast(0, 8, 1e10)], seconds: 6 },
  { name: 'v1 blast 2 GJ (walls, local)', kind: 'v1', doc: () => doc([P('apartment', 0, 0, 1), P('house', 0, 16, 2), P('house', 16, 0, 3), car(-8, 9, 23)], false), events: [blast(0, 9, 2e9)], seconds: 6 },
  { name: 'v1 blast 40 GJ (global)', kind: 'v1', doc: () => doc([P('apartment', 0, 0, 1), P('house', 0, 16, 2), P('house', 16, 0, 3), car(-8, 9, 23)], false), events: [blast(4, 7, 4e10)], seconds: 6 },
  { name: 'v1 default town quake 0.8 g', kind: 'v1-partial', doc: () => doc(defaultTownObjects(), false), events: [quake(0.8, 7)], seconds: 12 },
  { name: 'v2 default town weak quake', kind: 'v2-intact', doc: () => doc(defaultTownObjects(), true), events: [quake(0.1, 7)], seconds: 8 },
  { name: 'v2 weak quake', kind: 'v2-intact', doc: () => doc([P('apartment', 0, 0, 1), P('house', 18, 0, 2), car(-6, 10, 20)], true), events: [quake(0.12)], seconds: 10 },
  { name: 'v2 far blast (facade only)', kind: 'v2-intact', doc: () => doc([P('apartment', 0, 0, 1), P('house', 18, 0, 2), car(-6, 10, 20)], true), events: [blast(0, 45, 4e8)], seconds: 5 },
  // The v1 street scene under v2: cells are removed, so this one is EXPECTED to change (the fix) — its base hash is kept to show it.
  { name: 'v2 street quake 1.1 g', kind: 'v2-partial', doc: () => doc([P('apartment', 0, 0, 1), P('house', 18, 0, 2), car(-10, 10, 20), car(-4, 10, 21), car(2, 10, 22)], true), events: [quake(1.1)], seconds: 14 },
];

/** SHA-256 over the run's outcome, and a summary of what happened (to check the scene does what its kind says). */
export async function fingerprint(sc: IdentityScene) {
  const d = sc.doc();
  const index = new Map(Object.keys(d.objects).map((id, i) => [id, `#${i}`]));
  const c = new SimulationController({ headless: true });
  await c.load(d);
  for (const e of sc.events) c.addEvent(e);
  c.advance(sc.seconds);
  const rt = c.getRuntime()!;
  const lines: string[] = [];
  lines.push(...c.getDamageEvents().map((e) => [e.time, index.get(e.objectId ?? '') ?? '', e.eventType, e.componentId ?? '', e.hazard, e.cause, e.response, ...e.worldPosition].join('|')));
  let partial = 0, members = 0;
  for (const e of rt.entities.values()) {
    lines.push([e.source.type, e.state, e.health, e.dims.join(','), ...e.pose.position, ...e.pose.quaternion, e.flags.collapsed ?? '', e.flags.partialCollapse ?? '', e.seismic ? [...e.seismic.top, e.seismic.peakDrift].join(',') : ''].join('|'));
    const m = e.modular?.structure?.model;
    if (!m) continue;
    if (e.flags.partialCollapse !== undefined || m.collapseLevel() === 'partial') partial++;
    members += m.structuralFailures;
    lines.push(...m.records.map((r) => [r.i, r.time, r.cause, r.trigger, r.root, r.u, r.hazard].join('|')), Array.from(m.state).join(''), Array.from(m.dx).join(','), Array.from(m.dy).join(','), Array.from(m.dz).join(','));
  }
  const S = rt.structures;
  if (S) {
    lines.push(...S.rubble.heaps.map((h) => [h.mass, h.height, h.cx, h.cz].join('|')));
    lines.push(...S.fragments.map((f) => [f.id, f.mass, f.structural!.settled, ...f.pose.position, ...f.pose.quaternion].join('|')));
  }
  lines.push(...rt.debris.map((f) => [f.id, ...f.pose.position].join('|')));
  lines.push(String(c.getPhysics()!.bodyCount()));
  const hash = createHash('sha256').update(lines.join('\n')).digest('hex');
  // Visual particles (dust, glass, leaves): their count and state must not change with the render-only debris factors.
  const particles = createHash('sha256').update(rt.particles.map((q) => [q.kind, q.life, q.size, q.color, ...q.position].join('|')).join('\n')).digest('hex').slice(0, 16) + `:${rt.particles.length}`;
  const summary = { partial, structuralFailures: members, fragments: S?.fragments.length ?? 0, debris: rt.debris.length, cellRebuilds: S?.cellRebuilds ?? 0 };
  c.unload();
  return { hash, particles, summary };
}

/** Recorded on the base code (09009f5), see the header. */
const EXPECTED: Record<string, string> = {
  "v1 street quake 1.1 g": "aaf1ba119fe1370706bedeb795878a696930215e70f6f3809dc22a88ce3e24d0", // {"partial":2,"structuralFailures":263,"fragments":89,"debris":89}
  "v1 town quake 0.9 g": "e9accf666cc8a46ec2a4c9cd5db90236562fbdc596e192f966f9b6e225bc571e", // {"partial":1,"structuralFailures":244,"fragments":53,"debris":54}
  "v1 blast 10 GJ (partial collapse)": "b22ac653a63ce7e589d7d8514123c146f6f9e2dfb0aa027a4eceb4e0107973a1", // {"partial":1,"structuralFailures":269,"fragments":160,"debris":160}
  "v1 blast 2 GJ (walls, local)": "f843ce551927c0838729ffaafa72ba3c867de85a0700713a4cc6363b17e53506", // {"partial":0,"structuralFailures":57,"fragments":130,"debris":130}
  "v1 blast 40 GJ (global)": "31577a235741ba3e491fd0f3eec2cdfe0f96d3d9633a334eda4a8cec69bdf713", // {"partial":0,"structuralFailures":284,"fragments":160,"debris":160}
  "v1 default town quake 0.8 g": "66016b1eadd10bd2a7373ebdff87c56af0cca1f3f8127eb192679c7458ae998a", // {"partial":3,"structuralFailures":1005,"fragments":160,"debris":175}
  "v2 default town weak quake": "f105ef6bc2bc4778d33802d4414b4284558012a64b9d36ab9da0b2f0078d49f9", // {"partial":0,"structuralFailures":0,"fragments":11,"debris":11}
  "v2 weak quake": "19fdefcc7ce1436af9d34b082578fef829585001c208c92e2f777c801063ab55", // {"partial":0,"structuralFailures":0,"fragments":8,"debris":8}
  "v2 far blast (facade only)": "bdc1317038ece7cae6e7f6b3d09ba50baaea3847f358b0e1319e2399fe4de0e9", // {"partial":0,"structuralFailures":8,"fragments":94,"debris":94}
  "v2 street quake 1.1 g": "ecdef20988165164796e1e6bcdbce1286b8c6ef11406012e67dcc2cff43dbb57", // {"partial":2,"structuralFailures":276,"fragments":64,"debris":64}
};

/** Visual particles at the end of the run (count after the colon), recorded on the base code with the same command. */
const PARTICLES: Record<string, string> = {
  "v1 street quake 1.1 g": "3a421bedf188fcbb:47",
  "v1 town quake 0.9 g": "4efa2be33f165852:138",
  "v1 blast 10 GJ (partial collapse)": "ec78c720c645662a:107",
  "v1 blast 2 GJ (walls, local)": "aee5c5882fd123fb:72",
  "v1 blast 40 GJ (global)": "0f35b14124bb1e2f:75",
  "v1 default town quake 0.8 g": "63dc72710a6c1e6e:821",
  "v2 default town weak quake": "e3b0c44298fc1c14:0",
  "v2 weak quake": "e3b0c44298fc1c14:0",
  "v2 far blast (facade only)": "a46cc562e7ddb94c:379",
  "v2 street quake 1.1 g": "9383c7f980d3bd11:163",
};

describe('Phase 36 structure: v1 and intact-v2 runs are bit-identical to the base code', { timeout: 900_000 }, () => {
  it.each(SCENES)('$name', async (sc) => {
    const { hash, particles, summary } = await fingerprint(sc);
    if (process.env.P36_RECORD) {
      fs.appendFileSync(process.env.P36_RECORD, `  ${JSON.stringify(sc.name)}: ${JSON.stringify(hash)}, // ${JSON.stringify(summary)}\n`);
      fs.appendFileSync(`${process.env.P36_RECORD}.particles`, `  ${JSON.stringify(sc.name)}: ${JSON.stringify(particles)},\n`);
      return;
    }
    if (sc.kind === 'v1-partial' || sc.kind === 'v2-partial') expect(summary.partial).toBeGreaterThan(0);
    // v1 never rebuilds a cell body; the intact v2 scenes really are intact (no cell removed), the partial one is not.
    if (sc.kind === 'v2-partial') expect(summary.cellRebuilds).toBeGreaterThan(0);
    else expect(summary.cellRebuilds).toBe(0);
    if (sc.kind === 'v2-partial') expect(hash).not.toBe(EXPECTED[sc.name]);
    else {
      expect(hash).toBe(EXPECTED[sc.name]);
      // Render-only debris factors: the same particles (count, size, life, place) as on the base code.
      expect(particles).toBe(PARTICLES[sc.name]);
    }
  });
});
