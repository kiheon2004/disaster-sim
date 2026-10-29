/**
 * Volcanic bombs and spatter (Phase 28) as AGGREGATED PARCELS — the Phase 23 ejecta flight (`fly`:
 * gravity + drag on the fragment size, landing on the terrain or leaving the world) reused unchanged.
 *
 * Every LAUNCH_PERIOD each vent throws the bomb share of the mass erupted since its last launch, split
 * into PARCELS parcels (seeded per vent and launch: the same plan gives the same bombs). Assumptions,
 * labelled: launch angle 55–85° from the horizontal and speed 8–25 m/s (Strombolian bursts throw most
 * bombs near-vertically at tens of m/s, e.g. Patrick et al. 2007 — the range is cut to what lands inside
 * a 200 m world), fragment size 0.06–0.4 m (bombs ≥ 64 mm), bulk density 2000 kg/m³. Bombs cool only
 * after landing (seconds of flight: their surface cooling is neglected). Visual spatter beyond these
 * parcels is a render effect only — every kilogram that lands is one of these parcels.
 */
import { Rng } from '@/core/random';
import { hashString } from '@/core/math';
import { fly, type Parcel, type WorldBox } from '@/impact/ejecta';

export const LAUNCH_PERIOD = 1;
export const PARCELS = 6;
export const BOMB_DENSITY = 2000;

export interface Bomb {
  id: number;
  vent: number;
  parcel: Parcel;
  /** Energy above the reference state carried (J). */
  energy: number;
  landed: boolean;
}

/** Parcels of one launch (flights integrated now; landing at parcel.t1, absolute time). */
export function launch(
  vent: number, launchIndex: number, mass: number, energy: number, P: [number, number, number], t0: number,
  ground: (x: number, z: number) => number, box: WorldBox, nextId: () => number, rhoAir?: number,
  /** Gravity vector of the world at the launch (Phase 31; undefined = Earth's vertical g, the Phase 28 flights). */
  gv?: readonly [number, number, number],
): Bomb[] {
  if (!(mass > 0)) return [];
  const rng = new Rng(hashString(`bomb:${vent}:${launchIndex}`));
  const out: Bomb[] = [];
  const m = mass / PARCELS, e = energy / PARCELS;
  for (let k = 0; k < PARCELS; k++) {
    const az = rng.range(0, 2 * Math.PI);
    const el = (rng.range(55, 85) * Math.PI) / 180;
    const v = rng.range(8, 25);
    const size = rng.range(0.06, 0.4);
    const ch = Math.cos(el) * v;
    const p: Parcel = {
      id: nextId(), ring: 0, t0, p0: [P[0], P[1] + 0.5, P[2]], v0: [ch * Math.cos(az), Math.sin(el) * v, ch * Math.sin(az)],
      mass: m, volume: m / BOMB_DENSITY, size, speed: v, spreadR: 0.5, spreadT: 0.5, t1: t0, p1: [P[0], P[1], P[2]], v1: 0, outflow: false, path: new Float32Array(0),
    };
    if (gv) fly(p, ground, box, BOMB_DENSITY, rhoAir, gv);
    else if (rhoAir === undefined) fly(p, ground, box, BOMB_DENSITY);
    else fly(p, ground, box, BOMB_DENSITY, rhoAir);
    out.push({ id: p.id, vent, parcel: p, energy: e, landed: false });
  }
  return out;
}

/** Position of a bomb in flight at absolute time t (path samples every 0.05 s). */
export function bombAt(b: Bomb, t: number): [number, number, number] {
  const p = b.parcel, path = p.path;
  const n = path.length / 3;
  if (n === 0) return p.p1;
  const u = Math.max(0, (t - p.t0) / 0.05);
  const k = Math.min(n - 2, Math.floor(u));
  if (k < 0) return [path[0], path[1], path[2]];
  const f = Math.min(1, u - k);
  return [path[3 * k] + (path[3 * k + 3] - path[3 * k]) * f, path[3 * k + 1] + (path[3 * k + 4] - path[3 * k + 1]) * f, path[3 * k + 2] + (path[3 * k + 5] - path[3 * k + 2]) * f];
}
