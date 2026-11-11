/**
 * Fire scenario outlook (Phase 27) — ONE function for the editor panel and the 3D preview, from the
 * document (no simulation): which objects the ignition sphere reaches and whether they are fuel (with
 * the same fuel rules as the run: timber members, room contents by occupancy, tree crowns and their
 * moisture), the room the point lies in and its openings, and a REFERENCE exposure — the distances at
 * which the fuel-controlled peak of what would be lit gives 12.5 and 5 kW/m² as a point flame. It is
 * not a prediction of the spread (that depends on growth, ventilation, wind and time).
 */
import type { WorldObject } from '@/core/model';
import { getDefinition } from '@/objects/registry';
import { MATERIALS } from '@/buildings/materials';
import { graphOf, MT_WINDOW } from '@/structure/graph';
import { CONTENTS_FIRE, CROWN_DENSITY, E_O2, FUEL_MATERIALS, FM, MOISTURE_EXTINCTION, Y_O2_AIR, Y_O2_LIMIT } from './materials';
import { ventInflow } from './relations';
import type { FireSettings, FireSpec } from './types';
import { yawOf } from '@/terrain/groundPlacement';

const MATERIAL_KEYS = Object.keys(MATERIALS) as (keyof typeof MATERIALS)[];

export type OutlookFuel = 'timber' | 'contents' | 'tree' | 'none';

export interface OutlookObject {
  id: string;
  type: string;
  name: string;
  /** Horizontal distance from the ignition point to the object's footprint (m, 0 inside). */
  distance: number;
  inSphere: boolean;
  fuel: OutlookFuel[];
  /** Burnable mass (kg) and its heat of combustion (J). */
  fuelKg: number;
  energy: number;
  /** Tree crown wetter than the moisture of extinction. */
  tooMoist: boolean;
}

export interface OutlookRoom {
  building: string;
  story: number;
  floor: number;
  contentsKg: number;
  /** Window area of the story (m²) and whether the setting opens it at the start. */
  windows: number;
  open: boolean;
  /** Peak heat release: fuel-controlled (RHR_f·A) and what the start openings allow inside (W). */
  fuelPeak: number;
  ventPeak: number;
}

export interface FireOutlook {
  objects: OutlookObject[];
  room: OutlookRoom | null;
  /** Items the scenario would light (count), their fuel (kg) and energy (J). */
  lit: number;
  fuelKg: number;
  energy: number;
  /** Fuel-controlled reference peak (W) and its 12.5 / 5 kW/m² point-flame distances (m). */
  refPeak: number;
  r12: number;
  r5: number;
  issues: string[];
}

interface Box { x: number; z: number; hx: number; hz: number; c: number; s: number; top: number; base: number }

function boxOf(o: WorldObject): Box {
  const d = getDefinition(o.type).getDimensions(o.params);
  const [sx, sy, sz] = o.transform.scale;
  // Heading from the whole rotation (Phase 36): a turn past 90° is stored as (π, 180° − θ, π) in XYZ Euler angles.
  const yaw = yawOf(o.transform.rotation);
  return { x: o.transform.position[0], z: o.transform.position[2], hx: (d[0] * sx) / 2, hz: (d[2] * sz) / 2, c: Math.cos(yaw), s: Math.sin(yaw), top: o.transform.position[1] + d[1] * sy, base: o.transform.position[1] };
}

function local(b: Box, x: number, z: number): [number, number] {
  const dx = x - b.x, dz = z - b.z;
  return [dx * b.c - dz * b.s, dx * b.s + dz * b.c];
}

function distanceTo(b: Box, x: number, z: number): number {
  const [lx, lz] = local(b, x, z);
  return Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, Math.abs(lz) - b.hz));
}

const cache = new WeakMap<object, Map<string, FireOutlook>>();

export function fireOutlook(spec: FireSpec, objects: Record<string, WorldObject>, groundAt: (x: number, z: number) => number, settings: FireSettings, airDensity = 1.2): FireOutlook {
  const key = JSON.stringify([spec.position, spec.height, spec.radius, spec.target ?? '', settings.foliageMoisture, settings.openings]);
  const byObjs = cache.get(objects) ?? new Map<string, FireOutlook>();
  cache.set(objects, byObjs);
  const hit = byObjs.get(key);
  if (hit) return hit;
  const [px, pz] = spec.position;
  const py = groundAt(px, pz) + spec.height;
  const out: FireOutlook = { objects: [], room: null, lit: 0, fuelKg: 0, energy: 0, refPeak: 0, r12: 0, r5: 0, issues: [] };
  const timber = FUEL_MATERIALS[FM.timber], contentsDHc = FUEL_MATERIALS[FM.contents].dHc;
  for (const o of Object.values(objects)) {
    if (spec.target && o.id !== spec.target) continue;
    const b = boxOf(o);
    const dist = distanceTo(b, px, pz);
    if (dist > spec.radius + 30) continue;
    const ob: OutlookObject = { id: o.id, type: o.type, name: o.name ?? o.id, distance: dist, inSphere: dist <= spec.radius, fuel: [], fuelKg: 0, energy: 0, tooMoist: false };
    if (o.type === 'building' && o.building) {
      const g = graphOf(o.building, o.transform.scale);
      const sp = o.building.spec;
      let tMass = 0;
      for (let i = 0; i < g.n; i++) if (!g.absent[i] && MATERIAL_KEYS[g.mat[i]] === 'timber') tMass += g.mass[i];
      if (tMass > 0) { ob.fuel.push('timber'); ob.fuelKg += (1 - timber.charYield) * tMass; ob.energy += (1 - timber.charYield) * tMass * timber.dHc; }
      const design = CONTENTS_FIRE[sp.occupancy] ?? null;
      const planA = sp.width * sp.depth * o.transform.scale[0] * o.transform.scale[2];
      if (design) {
        const kg = (design.qf * planA * sp.floors) / 17.5e6;
        ob.fuel.push('contents'); ob.fuelKg += kg; ob.energy += kg * contentsDHc;
      }
      // The room the point lies in.
      const [lx, lz] = local(b, px, pz);
      if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz && py >= b.base && py < b.top) {
        const sy = o.transform.scale[1];
        let y = b.base, story = 0;
        for (let s = 0; s < sp.floors; s++) {
          const h = (s === 0 ? sp.groundFloorHeight ?? sp.floorHeight : sp.floorHeight) * sy;
          story = s;
          if (py < y + h) break;
          y += h;
        }
        let win = 0, H = 0;
        for (let i = 0; i < g.n; i++) {
          if (g.absent[i] || g.type[i] !== MT_WINDOW || g.level[i] !== story) continue;
          const o6 = 6 * i, A = Math.max(g.box[o6 + 3] - g.box[o6], g.box[o6 + 5] - g.box[o6 + 2]) * (g.box[o6 + 4] - g.box[o6 + 1]);
          win += A; H += A * (g.box[o6 + 4] - g.box[o6 + 1]);
        }
        const open = settings.openings === 'windowsOpen';
        const fuelPeak = design ? design.rhrf * planA : 0;
        // Fully developed vent flow through the open windows (or the leakage of a closed room).
        const vent = open && win > 0 ? ventInflow(win, H / win, 1100, 288, airDensity) : 0.5 * planA * 3 * airDensity / 3600;
        const ventPeak = E_O2 * vent * (Y_O2_AIR - Y_O2_LIMIT);
        out.room = { building: o.id, story, floor: planA, contentsKg: design ? (design.qf * planA) / 17.5e6 : 0, windows: win, open, fuelPeak, ventPeak };
        if (design) { out.lit++; out.fuelKg += out.room.contentsKg; out.energy += out.room.contentsKg * contentsDHc; out.refPeak = Math.max(out.refPeak, fuelPeak); }
        else out.issues.push('fire.outlook.noContents');
      }
      if (ob.inSphere && tMass > 0) { out.lit++; out.refPeak = Math.max(out.refPeak, timber.mChar * timber.dHc * Math.PI * spec.radius * spec.radius); }
    } else if (o.type === 'tree') {
      const p = o.params as Record<string, number>;
      const cr = (p.canopyRadius ?? 2) * Math.max(o.transform.scale[0], o.transform.scale[2]);
      const kg = CROWN_DENSITY * (4 / 3) * Math.PI * cr ** 3;
      ob.fuel.push('tree');
      ob.fuelKg = kg;
      ob.energy = kg * FUEL_MATERIALS[FM.foliage].dHc;
      ob.tooMoist = settings.foliageMoisture > MOISTURE_EXTINCTION;
      if (ob.inSphere) {
        if (ob.tooMoist) out.issues.push('fire.outlook.moist');
        else { out.lit++; out.fuelKg += kg; out.energy += ob.energy; out.refPeak = Math.max(out.refPeak, (kg * FUEL_MATERIALS[FM.foliage].dHc) / (2 * FUEL_MATERIALS[FM.foliage].residence)); }
      }
    }
    out.objects.push(ob);
  }
  out.objects.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  if (out.lit === 0 && !out.issues.includes('fire.outlook.moist')) out.issues.push('fire.outlook.noFuel');
  const chi = 0.35;
  out.r12 = Math.sqrt((chi * out.refPeak) / (4 * Math.PI * 12.5e3));
  out.r5 = Math.sqrt((chi * out.refPeak) / (4 * Math.PI * 5e3));
  byObjs.set(key, out);
  return out;
}
