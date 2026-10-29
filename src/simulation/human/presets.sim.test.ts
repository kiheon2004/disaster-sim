/**
 * Phase 33: the 20 human-response presets run headless for their full time. Every preset: finite poses / velocities at
 * every simulated second, deterministic (two runs of the same document → identical people), one IMPACT event per contact
 * episode (no two for the same person, time and partner), no duplicate force paths in the ForceLedger, and the
 * preset's qualitative expectation. The expectations come from physics (free fall √(2 g h) and t = √(2 h / g), Coulomb
 * friction, the standing-balance limit, a tidal load ∝ 1 / r³, a pull ≫ g lifting a body) and from the model's documented
 * reference scenarios (src/human/injury.ts: a 3 m feet-first drop → legs "moderate", 10 m → "severe") — not from the
 * numbers of a previous run.
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { HUMAN_PRESETS, HUMAN_PRESET_FIELDS, humanPreset, type HumanPresetId } from '@/human/presets';
import { levelRank, type InjuryLevel } from '@/human/injury';
import { koHumanPresets } from '@/i18n/locales/ko.humanPresets';
import { enHumanPresets } from '@/i18n/locales/en.humanPresets';

const G = 9.80665;

interface Run {
  c: SimulationController;
  people: RuntimeEntity[];
  start: [number, number, number][];
  /** People state as a canonical string (determinism). */
  snap: string;
  others: RuntimeEntity[];
}

const finite = (v: readonly number[]) => v.every(Number.isFinite);

async function run(id: HumanPresetId): Promise<Run> {
  const p = humanPreset(id)!;
  const { doc, events } = p.build();
  const c = new SimulationController({ headless: true });
  await c.load(doc);
  for (const e of events) c.addEvent(e);
  const all = [...c.getRuntime()!.entities.values()];
  const people = all.filter((e) => e.source.type === 'human');
  const start = people.map((e) => [...e.pose.position] as [number, number, number]);
  const ph = c.getPhysics()!;
  for (let t = 0; t < p.seconds; t++) {
    c.advance(Math.min(1, p.seconds - t));
    for (const e of all) {
      expect(finite(e.pose.position) && finite(e.pose.quaternion), `${id} ${e.source.type} pose at t=${t + 1}`).toBe(true);
      if (e.body !== null && e.dynamic) {
        expect(finite(ph.getLinearVelocity(e.body)) && finite(ph.getAngularVelocity(e.body)), `${id} ${e.source.type} velocity at t=${t + 1}`).toBe(true);
      }
    }
  }
  const snap = JSON.stringify(people.map((e) => {
    const s = e.human!;
    return [e.source.seed, e.pose.position, e.pose.quaternion, e.health, s.posture, s.standing, s.impacts, s.falls, s.fallCause, s.maxClosing, s.risk, !!e.flags.captured];
  }));
  return { c, people, start, snap, others: all.filter((e) => e.source.type !== 'human') };
}

const legs = (e: RuntimeEntity) => Math.max(e.human!.risk.leftLeg.peak, e.human!.risk.rightLeg.peak);
const legLevel = (e: RuntimeEntity): InjuryLevel => (levelRank(e.human!.risk.leftLeg.level) >= levelRank(e.human!.risk.rightLeg.level) ? e.human!.risk.leftLeg.level : e.human!.risk.rightLeg.level);
const impactsOf = (r: Run, e: RuntimeEntity) => r.c.getDamageEvents().filter((d) => d.objectId === e.id && d.eventType === 'IMPACT');
const struckSegments = (r: Run, e: RuntimeEntity) => new Set(impactsOf(r, e).flatMap((d) => d.human!.segment!.split('+')));
const moved = (r: Run, k: number) => Math.hypot(r.people[k].pose.position[0] - r.start[k][0], r.people[k].pose.position[2] - r.start[k][2]);
const allStanding = (r: Run) => r.people.every((e) => e.human!.standing && e.human!.falls === 0);

/** Drop experiments: person 0 is released `h` m above the ground (feet first), person 1 stands beside as a reference. */
function dropChecks(r: Run, h: number, g: number) {
  const [p, ref] = r.people;
  const v = Math.sqrt(2 * g * h);
  // Linear damping 0.05 1/s over the fall slows the body by ≈ 0.025·t (≤ 5 % for t ≤ 2 s).
  expect(Math.abs(p.human!.maxClosing - v) / v).toBeLessThan(0.06);
  expect(Math.abs(p.human!.maxDrop - h)).toBeLessThan(0.06);
  // Feet first: the legs carry the landing, the head is not struck.
  expect(struckSegments(r, p)).toEqual(new Set(['leftLeg', 'rightLeg']));
  expect(p.human!.risk.head.hits).toBe(0);
  // The first landing at t ≈ √(2 h / g) after the start (within 10 % + one step).
  const first = impactsOf(r, p)[0];
  const tf = Math.sqrt((2 * h) / g);
  expect(Math.abs(first.time - tf)).toBeLessThan(0.1 * tf + 1 / 30);
  expect(ref.human!.standing && ref.human!.impacts === 0).toBe(true);
}

const EXPECT: Record<HumanPresetId, (r: Run) => void> = {
  standStill: (r) => {
    expect(allStanding(r)).toBe(true);
    for (const e of r.people) { expect(e.human!.impacts).toBe(0); expect(e.health).toBe(1); }
    expect(r.c.getDamageEvents()).toHaveLength(0);
  },
  // 12 m/s: drag ≈ ½ ρ C_d A v² ≈ 60 N at ~1 m — far below m g e / h_c ≈ 90 N·m / 1 m of the support.
  weakWind: (r) => expect(allStanding(r)).toBe(true),
  // 35 m/s (+30 % gusts): ≈ 8× the drag of 12 m/s — beyond the balance limit; the fall is the wind's.
  strongGust: (r) => {
    for (const e of r.people) { expect(e.human!.standing).toBe(false); expect(e.human!.fallCause).toBe('wind'); }
    expect(r.c.getDamageEvents().some((d) => d.eventType === 'FALLEN' && d.hazard === 'wind')).toBe(true);
  },
  // 45°: tan 45° = 1 exceeds any shoe / grass friction coefficient in the model — the person on the slope slides down
  // (towards +x) and ends lower; the person in the yard is not affected.
  slopeSlide: (r) => {
    const [s, y] = r.people;
    expect(s.pose.position[0] - r.start[0][0]).toBeGreaterThan(1);
    expect(r.start[0][1] - s.pose.position[1]).toBeGreaterThan(1);
    expect(y.human!.standing && y.human!.falls === 0).toBe(true);
    expect(moved(r, 1)).toBeLessThan(0.05);
  },
  // Same slope, lower ground friction (mud vs grass): the person on mud ends farther downhill.
  lowFriction: (r) => {
    const [grass, mud] = r.people;
    expect(mud.pose.position[0] - r.start[1][0]).toBeGreaterThan(grass.pose.position[0] - r.start[0][0] + 0.5);
  },
  drop1m: (r) => {
    dropChecks(r, 1, G);
    // Below the 3 m reference ("moderate").
    expect(levelRank(legLevel(r.people[0]))).toBeLessThan(levelRank('moderate'));
  },
  drop3m: (r) => {
    dropChecks(r, 3, G);
    expect(legLevel(r.people[0])).toBe('moderate');
  },
  drop10m: (r) => {
    dropChecks(r, 10, G);
    expect(levelRank(legLevel(r.people[0]))).toBeGreaterThanOrEqual(levelRank('severe'));
  },
  // Tilted 69° and dropped from 3 m: it does not land on its feet — the body's side / upper body strike the ground;
  // the upright reference beside it lands on its legs only.
  rotatingFall: (r) => {
    const [tilt, ref] = r.people;
    const v = Math.sqrt(2 * G * 3);
    expect(Math.abs(tilt.human!.maxClosing - v) / v).toBeLessThan(0.1);
    const segs = struckSegments(r, tilt);
    expect(['head', 'torso', 'pelvis', 'leftArm', 'rightArm'].some((s) => segs.has(s))).toBe(true);
    expect(tilt.human!.standing).toBe(false);
    expect(struckSegments(r, ref)).toEqual(new Set(['leftLeg', 'rightLeg']));
  },
  // A ~115 kg block from 4 m (≈ 8.9 m/s) onto a standing person: an episode with the block as partner, upper body struck.
  debrisHit: (r) => {
    const [p, ref] = r.people;
    const block = r.others.find((e) => e.source.type === 'car')!;
    const ev = impactsOf(r, p).filter((d) => d.human!.partner === block.id);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    const segs = new Set(ev.flatMap((d) => d.human!.segment!.split('+')));
    expect(segs.has('head') || segs.has('torso')).toBe(true);
    expect(ref.human!.standing && ref.human!.impacts === 0).toBe(true);
  },
  // 0.8 g peak horizontal ground acceleration: well beyond the static balance limit (≈ 0.2 g lean) — people fall, by the
  // ground motion.
  quakeBalance: (r) => {
    expect(r.people.some((e) => !e.human!.standing && e.human!.fallCause === 'groundMotion')).toBe(true);
    expect(r.c.getDamageEvents().some((d) => d.eventType === 'FALLEN' && d.hazard === 'earthquake')).toBe(true);
  },
  // A ~1 m deep flood front (√(g h) ≈ 3 m/s): depth × speed ≫ 1 m²/s — people lose footing and are carried inland (−z).
  floodPush: (r) => {
    for (const [k, e] of r.people.entries()) {
      expect(e.human!.standing).toBe(false);
      expect(e.human!.fallCause).toBe('water');
      expect(r.start[k][2] - e.pose.position[2]).toBeGreaterThan(2);
    }
  },
  // Overpressure and blast wind fall off with distance: the nearest falls by the blast, the farthest stands; the
  // displacement does not grow with distance.
  blastWave: (r) => {
    const [a, , , d] = r.people;
    expect(a.human!.standing).toBe(false);
    expect(a.human!.fallCause).toBe('blast');
    expect(d.human!.standing).toBe(true);
    const m = r.people.map((_, k) => moved(r, k));
    for (let k = 1; k < m.length; k++) expect(m[k]).toBeLessThanOrEqual(m[k - 1] + 0.01);
  },
  // A strong quake (1.2 g) next to a 6-storey frame: the people beside it are struck by something other than the ground
  // (building parts / debris); the person 40 m away is not.
  buildingCollapse: (r) => {
    const near = r.people.slice(0, 3), far = r.people[3];
    const partners = (e: RuntimeEntity) => impactsOf(r, e).map((d) => d.human!.partner).filter((p) => p !== 'ground' && !r.people.some((q) => q.id === p));
    expect(near.some((e) => partners(e).length > 0)).toBe(true);
    expect(partners(far)).toHaveLength(0);
  },
  // 1.62 m/s² (Moon-like magnitude): the same 3 m lands at √(2·1.62·3) ≈ 3.1 m/s after ≈ 1.9 s — below "moderate".
  lowGravityFall: (r) => {
    dropChecks(r, 3, 1.62);
    expect(levelRank(legLevel(r.people[0]))).toBeLessThan(levelRank('moderate'));
  },
  // 2 g: the same 3 m lands at √(2·2g·3) ≈ 10.8 m/s — more than the 1 g 3 m reference (moderate); the standing
  // reference still stands (support normal 2 g, no tangential load).
  highGravityFall: (r) => {
    dropChecks(r, 3, 2 * G);
    expect(levelRank(legLevel(r.people[0]))).toBeGreaterThanOrEqual(levelRank('moderate'));
    expect(legs(r.people[0])).toBeGreaterThan(Math.sqrt(2 * G * 3) / 10);
  },
  // Gravity reversed (smooth 2 s from t = 1 s): the support is lost, everyone rises.
  reversedGravity: (r) => {
    for (const [k, e] of r.people.entries()) {
      expect(e.human!.posture).toBe('airborne');
      expect(e.human!.fallCause).toBe('noSupport');
      expect(e.pose.position[1] - r.start[k][1]).toBeGreaterThan(5);
    }
    expect(r.others[0].pose.position[1]).toBeGreaterThan(5);
  },
  // Gravity turned to +x (6 s rotation): the tangential gravity exceeds the balance limit — people fall towards +x.
  horizontalGravity: (r) => {
    for (const [k, e] of r.people.entries()) {
      expect(e.human!.standing).toBe(false);
      expect(e.human!.fallCause).toBe('gravity');
      expect(e.pose.position[0] - r.start[k][0]).toBeGreaterThan(5);
    }
  },
  // Tidal load ∝ 1 / r³: largest straight above the mass, smaller 4 m aside, negligible 40 m away; nobody captured,
  // the person above it stands (the pull adds to the weight, it does not tip).
  celestialTides: (r) => {
    const [a, b, c] = r.people.map((e) => e.human!.tidalPeak);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeLessThan(0.1 * a);
    expect(r.people[0].human!.standing).toBe(true);
    expect(r.people.some((e) => e.flags.captured)).toBe(false);
  },
  // A pull of ≈ 780 m/s² upward at the person under the source: lifted off the ground and captured.
  celestialCapture: (r) => {
    const p = r.people[0];
    expect(p.flags.captured).toBe(true);
    expect(p.body).toBeNull();
    expect(p.human!.fallCause).toBe('noSupport');
  },
};

describe('human-response presets', () => {
  it('20 presets in the documented order, each with a fixed seed, a run time and complete ko / en strings', () => {
    expect(HUMAN_PRESETS.map((p) => p.id)).toEqual([
      'standStill', 'weakWind', 'strongGust', 'slopeSlide', 'lowFriction', 'drop1m', 'drop3m', 'drop10m', 'rotatingFall', 'debrisHit',
      'quakeBalance', 'floodPush', 'blastWave', 'buildingCollapse', 'lowGravityFall', 'highGravityFall', 'reversedGravity',
      'horizontalGravity', 'celestialTides', 'celestialCapture',
    ]);
    expect(new Set(HUMAN_PRESETS.map((p) => p.seed)).size).toBe(20);
    const ko = koHumanPresets as Record<string, string>, en = enHumanPresets as Record<string, string>;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const p of HUMAN_PRESETS) {
      expect(p.seconds).toBeGreaterThan(0);
      expect(p.seconds).toBeLessThanOrEqual(30);
      for (const f of ['name', ...HUMAN_PRESET_FIELDS] as const) {
        expect(ko[p.keys[f]], `${p.id}.${f} ko`).toMatch(/\S/);
        expect(en[p.keys[f]], `${p.id}.${f} en`).toMatch(/\S/);
      }
      const { doc } = p.build();
      expect(doc.settings.simulation.humans).toEqual({ model: 'extended' });
      expect(doc.settings.simulation.seed).toBe(p.seed);
      expect(Object.values(doc.objects).some((o) => o.type === 'human')).toBe(true);
    }
    // Educational wording: no percentages (nothing reads like a probability).
    for (const s of [...Object.values(ko), ...Object.values(en)]) expect(s).not.toMatch(/%/);
  });

  for (const p of HUMAN_PRESETS) {
    it(`${p.id}: finite, deterministic, one event per episode, no duplicate forces, expected behaviour`, async () => {
      const a = await run(p.id);
      const b = await run(p.id);
      expect(b.snap).toBe(a.snap);
      const keys = a.c.getDamageEvents().filter((d) => d.eventType === 'IMPACT' && d.human).map((d) => `${d.objectId}|${d.time}|${d.human!.partner}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(a.c.duplicateForces()).toBe(0);
      EXPECT[p.id](a);
    }, 60000);
  }
});
