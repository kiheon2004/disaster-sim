/**
 * Phase 34: the 24 physiology presets run headless. Every preset builds its own world (extended human model + physiology,
 * fixed seed), runs, stays finite (temperatures, doses, ledgers at every sample), is deterministic (a second run of the
 * same document gives the same physiology at a check time), records physiology events once per transition (no duplicate
 * person / time / type) and shows its expected phenomenon with bounds argued from physics or from the model's documented
 * relations (src/physiology/gas.ts, thermal.ts, engine.ts) — not from the numbers of a previous run.
 *
 * Run time: presets whose environment is cheap run their full time. Presets driven by the thermal / climate world, the 2-D
 * flood solver or a collapsing building cost ≈ 0.05–0.2 s of wall time per simulated second on the reference machine;
 * they run a documented SHORTENED time (RUN below, factor stated) chosen so that the phenomenon is already established
 * (e.g. the skin-temperature drop in cold air has a time constant of a few minutes, the fire stand burns out in ≈ 2 min).
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import { PHYSIO_PRESETS, PHYSIO_PRESET_FIELDS, PHYSIO_SECONDS, physioPreset, type PhysioPresetId } from '@/physiology/presets';
import { deficitPercent, energy, type PhysioState } from '@/physiology/engine';
import { supplyIndex } from '@/physiology/gas';
import { P } from '@/physiology/params';
import { koPhysiologyPresets } from '@/i18n/locales/ko.physiologyPresets';
import { enPhysiologyPresets } from '@/i18n/locales/en.physiologyPresets';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';

const K = 273.15;
const PHYSIO_EVENTS = new Set(['THERMAL_STRESS', 'THERMAL_RECOVERED', 'AIRWAY_SUBMERGED', 'AIRWAY_CLEARED', 'RESPIRATORY_STRESS', 'GAS_EXPOSURE', 'HYDRATION_STRESS', 'FATIGUE_LIMIT', 'CAPACITY_CHANGED']);

/** Simulated test time (s) where it is shorter than the preset's time, with the factor. */
const RUN: Partial<Record<PhysioPresetId, number>> = {
  coldOutdoor: 240, coldWind: 240, hotHumid: 240, hotDry: 240, heatwave: 240, // climate world: 240 / 1800 s (× 0.13)
  coldWaterPartial: 300, // 2-D flood solver: 300 / 1800 s (× 0.17)
  fireRadiant: 150, smoke: 150, // the dry stand burns out in ≈ 2 min: 150 / 300 s (× 0.5)
  airwayContinuous: 120, // 120 / 240 s (× 0.5): the airway is under from ≈ 25 s
  buriedExposure: 120, quakeFireIncapacitated: 120, // collapsing building: 120 / 600 s (× 0.2)
};
const DET = 30;

interface Sample { t: number; Tc: number[]; Ts: number[]; fat: number[]; airway: string[]; act: string[]; causes: string[][]; cap: string[]; supply: (number | null)[] }
interface Run {
  c: SimulationController;
  people: RuntimeEntity[];
  samples: Sample[];
  snapAt: string;
  T: number;
}

const st = (e: RuntimeEntity) => e.physio!.s;
const snapOf = (people: RuntimeEntity[]) => JSON.stringify(people.map((e) => { const s = st(e); return [s.Tc, s.Ts, s.fatigue, s.dose, s.waterLost, s.airway.cumulative, s.combined]; }));

function finiteState(s: PhysioState) {
  const vals = [s.Tc, s.Ts, s.fatigue, s.waterLost, s.waterIntake, ...Object.values(s.dose), ...Object.values(s.fed), ...Object.values(s.ledger)];
  return vals.every(Number.isFinite);
}

async function load(doc: WorldDocument, events: EventSpec[]) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
const humans = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');

async function run(id: PhysioPresetId, T: number, step = 10): Promise<Run> {
  const { doc, events } = physioPreset(id)!.build();
  const c = await load(doc, events);
  const people = humans(c);
  const samples: Sample[] = [];
  let snapAt = '';
  for (let t = 0; t < T - 1e-9;) {
    const dt = Math.min(step, T - t, t < DET ? DET - t : Infinity);
    c.advance(dt);
    t += dt;
    if (Math.abs(t - DET) < 1e-9) snapAt = snapOf(people);
    for (const e of people) expect(finiteState(st(e)), `${id} ${e.id} finite at t=${t}`).toBe(true);
    samples.push({
      t, Tc: people.map((e) => st(e).Tc - K), Ts: people.map((e) => st(e).Ts - K), fat: people.map((e) => st(e).fatigue), airway: people.map((e) => st(e).airway.state),
      act: people.map((e) => st(e).activity), causes: people.map((e) => [...st(e).combinedCauses]), cap: people.map((e) => st(e).combined), supply: people.map((e) => st(e).resp.supply),
    });
  }
  return { c, people, samples, snapAt, T };
}

async function deterministic(id: PhysioPresetId, a: Run) {
  const { doc, events } = physioPreset(id)!.build();
  const c = await load(doc, events);
  c.advance(DET);
  expect(snapOf(humans(c))).toBe(a.snapAt);
  c.unload();
}

const evs = (r: Run, type: string, e?: RuntimeEntity) => r.c.getDamageEvents().filter((d) => d.eventType === type && (!e || d.objectId === e.id));
/** Heat-ledger closure: body energy change = Σ ledger terms (each flow counted once, shivering inside the metabolic term). */
function ledgerCloses(s: PhysioState) {
  const L = s.ledger;
  const net = L.metabolic - L.work - L.resSens - L.resLat - (L.conv + L.rad - L.absorbed) - L.water - L.contact - L.evap + L.cond;
  const dU = energy(s) - s.U0;
  expect(Math.abs(dU - net)).toBeLessThan(1e-6 * Math.max(1e5, Math.abs(L.metabolic)));
  // Evaporated mass × latent heat = evaporative heat (the mass and the heat are one quantity).
  expect(Math.abs(L.evapMass * P.latentHeat - L.evap)).toBeLessThan(1e-6 * Math.max(1, Math.abs(L.evap)));
}

const cache: Partial<Record<PhysioPresetId, Run>> = {};

const EXPECT: Record<PhysioPresetId, (r: Run) => void | Promise<void>> = {
  // 24 °C still air, resting, normal clothing (≈ thermoneutral): nothing happens.
  stableBaseline: (r) => {
    expect(r.c.getDamageEvents()).toHaveLength(0);
    for (const e of r.people) {
      const s = st(e);
      expect(Math.abs(s.Tc - K - P.coreSet)).toBeLessThan(0.2);
      expect(s.Ts - K).toBeGreaterThan(32);
      expect(s.Ts - K).toBeLessThan(35);
      expect(s.combined).toBe('normal');
      expect(e.human!.standing).toBe(true);
      expect(e.physio!.provenance.airT).toBe('scene.ambient');
      expect(deficitPercent(s, e.physio!.cfg.mass)).toBeLessThan(0.2);
    }
  },
  // 10 °C still room air: the lightly clothed person loses more heat and has the colder skin; the core is defended
  // (vasoconstriction): it moves < 0.5 K within the hour.
  coldIndoor: (r) => {
    const [light, warm] = r.people.map(st);
    expect(light.Ts).toBeLessThan(warm.Ts - 2);
    expect(light.Ts - K).toBeLessThan(30);
    expect(light.ledger.conv + light.ledger.rad).toBeGreaterThan(warm.ledger.conv + warm.ledger.rad);
    for (const s of [light, warm]) expect(Math.abs(s.Tc - K - P.coreSet)).toBeLessThan(0.5);
    expect(light.levels.thermal).not.toBe('normal');
    expect(r.people[0].physio!.provenance.airT).toBe('scene.ambient');
  },
  // Climate experiment −5 °C: air from the thermal air layer, humidity from the climate; the skin cools by several K.
  coldOutdoor: (r) => {
    for (const e of r.people) {
      expect(e.physio!.provenance.airT).toBe('thermal.air');
      expect(e.physio!.provenance.humidity).toBe('climate');
      expect(Math.abs(e.physio!.sample!.airT - K + 5)).toBeLessThan(1);
      expect(st(e).Ts - K).toBeLessThan(32);
      expect(Math.abs(st(e).Tc - K - P.coreSet)).toBeLessThan(0.5);
    }
    cache.coldOutdoor = r;
  },
  // Same climate + 10 m/s wind: forced convection h = 8.6 v^0.53 > still air → colder skin than in still air at the same time.
  coldWind: (r) => {
    for (const e of r.people) expect(e.physio!.provenance.wind).toBe('windField');
    const still = cache.coldOutdoor;
    if (still) expect(st(r.people[0]).Ts).toBeLessThan(st(still.people[0]).Ts - 0.5);
    expect(st(r.people[0]).Ts - K).toBeLessThan(31);
  },
  // Waist-deep 10 °C flood water at the shore: the immersed person's skin falls far below the dry reference and towards the
  // water temperature (water convection ≈ 230 W/(m² K) ≫ air); heat leaves through the water term.
  coldWaterPartial: (r) => {
    const [wet, dry] = r.people;
    const sw = st(wet);
    expect(wet.physio!.provenance.water).toBe('flood');
    expect(wet.physio!.provenance.waterT).toBe('reference');
    expect(wet.physio!.sample!.immersed).toBeGreaterThan(0.3);
    expect(wet.physio!.sample!.immersed).toBeLessThan(0.8);
    expect(wet.human!.standing).toBe(true);
    expect(sw.Ts).toBeLessThan(st(dry).Ts - 3);
    expect(sw.Ts - K - 10).toBeLessThan(0.8 * (34 - 10));
    expect(sw.ledger.water).toBeGreaterThan(0);
    expect(st(dry).ledger.water).toBe(0);
    expect(sw.airway.state).toBe('clear');
  },
  // Immersed to the neck in 10 °C water (zone): mean skin approaches the water temperature within 30 min.
  coldWaterFull: (r) => {
    const [wet, dry] = r.people;
    expect(wet.physio!.provenance.water).toBe('zone');
    expect(wet.physio!.sample!.immersed).toBeGreaterThan(0.8);
    expect(st(wet).Ts - K - 10).toBeLessThan(0.35 * (34 - 10));
    expect(st(wet).airway.state).toBe('clear');
    expect(st(wet).ledger.water).toBeGreaterThan(5 * (st(wet).ledger.conv + st(wet).ledger.rad));
    expect(st(dry).ledger.water).toBe(0);
  },
  // 34 °C, 60 % RH, light activity: the core rises modestly, sweat evaporates, water is lost.
  hotIndoor: (r) => {
    for (const e of r.people) {
      const s = st(e);
      expect(s.Tc - K - P.coreSet).toBeGreaterThan(0.1);
      expect(s.Tc - K - P.coreSet).toBeLessThan(1.5);
      expect(s.ledger.sweat).toBeGreaterThan(0);
      expect(s.ledger.evap).toBeGreaterThan(0);
      expect(deficitPercent(s, e.physio!.cfg.mass)).toBeGreaterThan(0.1);
    }
  },
  // 38 °C under a clear noon sun: solar radiation absorbed (provenance climate.sun), skin above 35 °C, core rising.
  heatwave: (r) => {
    for (const e of r.people) {
      expect(e.physio!.provenance.solar).toBe('climate.sun');
      expect(e.physio!.sample!.qSolar).toBeGreaterThan(100);
      expect(st(e).ledger.absorbed).toBeGreaterThan(0);
      expect(st(e).Ts - K).toBeGreaterThan(35);
      expect(st(e).Tc - K).toBeGreaterThan(P.coreSet);
    }
  },
  hotHumid: (r) => {
    for (const e of r.people) {
      expect(e.physio!.provenance.humidity).toBe('climate');
      expect(st(e).Tc - K).toBeGreaterThan(P.coreSet);
    }
    cache.hotHumid = r;
  },
  // Same air temperature at 15 % RH: higher evaporative capacity → more evaporation and less heat stored than at 85 % RH.
  hotDry: (r) => {
    const humid = cache.hotHumid;
    const d = st(r.people[0]);
    expect(d.Tc - K).toBeGreaterThan(P.coreSet);
    if (humid) {
      const h = st(humid.people[0]);
      expect(h.Tc).toBeGreaterThan(d.Tc);
      expect(d.ledger.evap).toBeGreaterThan(h.ledger.evap);
    }
  },
  // Strenuous (6.5 met) vs resting at 20 °C: the core rises ≥ 0.8 K, fatigue builds (relative intensity 6.5 / 12 > 0.4).
  highActivity: (r) => {
    const [hard, rest] = r.people.map(st);
    expect(hard.Tc - rest.Tc).toBeGreaterThan(0.8);
    expect(hard.fatigue).toBeGreaterThan(0.3);
    expect(rest.fatigue).toBe(0);
    expect(hard.ledger.metabolic).toBeGreaterThan(4 * rest.ledger.metabolic);
  },
  // Moderate activity for an hour at 25 °C: the core approaches a plateau (second half rises less than the first), the water
  // deficit grows steadily; no fatigue (3.5 / 12 < 0.4, sustainable).
  longActivity: (r) => {
    const half = r.samples.find((x) => x.t >= r.T / 2)!, last = r.samples[r.samples.length - 1];
    const first = half.Tc[0] - P.coreSet, second = last.Tc[0] - half.Tc[0];
    expect(first).toBeGreaterThan(0.3);
    expect(second).toBeLessThan(first);
    expect(deficitPercent(st(r.people[0]), r.people[0].physio!.cfg.mass)).toBeGreaterThan(0.2);
    expect(st(r.people[0]).fatigue).toBe(0);
  },
  // Strenuous work until the fatigue limit: the capacity limit reduces the activity (strenuous → moderate), fatigue then
  // falls and the core cools again (THERMAL_RECOVERED).
  recovery: (r) => {
    const fat = r.samples.map((x) => x.fat[0]);
    const peak = Math.max(...fat);
    const iPeak = fat.indexOf(peak);
    // The 'impaired' threshold is 0.8; samples every 10 s may miss the top of the excursion by a little.
    expect(peak).toBeGreaterThanOrEqual(0.75);
    expect(Math.min(...fat.slice(iPeak))).toBeLessThan(peak - 0.02);
    expect(r.samples.some((x) => x.act[0] === 'moderate')).toBe(true);
    expect(evs(r, 'THERMAL_RECOVERED').length).toBeGreaterThanOrEqual(1);
  },
  // 38 °C, moderate, 1 h: without intake the deficit grows; 0.4 L/h of intake lowers it by ≈ intake·t / m (the sweat losses
  // of both are nearly equal).
  dehydration: (r) => {
    const [dry, drink] = r.people;
    const m = dry.physio!.cfg.mass;
    const dd = deficitPercent(st(dry), m), dk = deficitPercent(st(drink), m);
    expect(dd).toBeGreaterThan(0.4);
    expect(dk).toBeLessThan(dd);
    const expected = (100 * 0.4 * (r.T / 3600)) / m;
    expect(Math.abs(dd - dk - expected) / expected).toBeLessThan(0.15);
    // Integrated over the physiology clock (the last sample, ≤ 5 physics steps before the simulation time — H5 correction).
    expect(st(drink).ledger.intake).toBeCloseTo(0.4 * (st(drink).time / 3600), 6);
  },
  // Flame radiation of a burning stand on people at 6, 12 and 24 m: the radiant dose falls with distance (point source ∝ 1/r²,
  // dose ∝ q^(4/3)), the farthest stays below the reference FED.
  fireRadiant: (r) => {
    const d = r.people.map((e) => st(e).dose.radiant);
    expect(d[0]).toBeGreaterThan(d[1]);
    expect(d[1]).toBeGreaterThan(d[2]);
    expect(st(r.people[0]).fed.heatRad).toBeGreaterThan(st(r.people[2]).fed.heatRad);
    expect(st(r.people[2]).fed.heatRad).toBeLessThan(0.5);
    // (The flames are out at the end of the run, so the radiant provenance is no longer present then.)
    expect(d[2]).toBeGreaterThan(0);
  },
  // 100 °C dry gas (zone): convective-heat FED accumulates (ISO 13571 form, applied above 60 °C), skin heats; reference none.
  fireHotAir: (r) => {
    const [hot, ref] = r.people;
    expect(hot.physio!.provenance.airT).toBe('zone');
    expect(st(hot).fed.heatConv).toBeGreaterThan(0.1);
    expect(st(ref).fed.heatConv).toBe(0);
    expect(st(hot).Ts).toBeGreaterThan(st(ref).Ts + 2);
    // FED rate at a constant 100 °C: 1 / (5·10⁷ · 100^−3.4 min) → over the full-strength part (after the 30 s ramp).
    const rate = 1 / (P.convHeatA * Math.pow(100, -3.4) * 60);
    expect(st(hot).fed.heatConv).toBeLessThan(rate * r.T * 1.01);
    expect(st(hot).fed.heatConv).toBeGreaterThan(rate * (r.T - 30) * 0.99);
  },
  // Smoke carried 30 m downwind: smoke and soot-derived CO doses > 0 (provenance fire.air), the deposited share is the
  // model's 0.3 of the inhaled mass; the upwind person inhales none.
  smoke: (r) => {
    const [down, up] = r.people.map(st);
    expect(r.people[0].physio!.provenance.gas).toBe('fire.air');
    expect(down.dose.smoke).toBeGreaterThan(0);
    expect(down.dose.smokeInhaled).toBeGreaterThan(0);
    expect(down.dose.co).toBeGreaterThan(0);
    expect(down.dose.smokeDeposited).toBeCloseTo(P.smokeDeposition * down.dose.smokeInhaled, 15);
    expect(up.dose.smoke).toBe(0);
  },
  // 1000 ppm CO (zone): FED_CO = ∫ppm dt / 35 000 ppm·min × exp(%CO₂ / 5) grows; the reference person has none.
  carbonMonoxide: (r) => {
    const [exp, ref] = r.people.map(st);
    expect(r.people[0].physio!.provenance.gas).toBe('zone');
    expect(exp.fed.co).toBeGreaterThan(0.5);
    const predicted = (exp.dose.co / 60 / P.coDose) * Math.exp((0.0004 * 100) / P.co2Hyperventilation);
    expect(Math.abs(exp.fed.co - predicted) / predicted).toBeLessThan(0.01);
    expect(ref.fed.co).toBe(0);
    expect(evs(r, 'GAS_EXPOSURE', r.people[0]).length).toBe(1);
    expect(exp.levels.gas).not.toBe('normal');
  },
  // 12 % O₂ at sea level (zone): the supply index is the alveolar O₂ ratio of the model → < 1, respiratory level raised.
  hypoxia: (r) => {
    const [low, ref] = r.people.map(st);
    expect(low.resp.supply!).toBeCloseTo(supplyIndex(0.12, 0.0004, 101325), 6);
    expect(low.resp.supply!).toBeLessThan(0.6);
    expect(ref.resp.supply!).toBeCloseTo(1, 6);
    expect(low.levels.respiratory).not.toBe('normal');
    expect(low.fed.o2).toBeGreaterThan(0);
  },
  // Atmosphere experiment, datum at 3500 m (ISA ≈ 65.8 kPa): the same O₂ fraction at a lower pressure lowers the supply.
  lowPressure: (r) => {
    const pIsa = 101325 * Math.pow(1 - 2.25577e-5 * 3500, 5.25588);
    for (const e of r.people) {
      expect(e.physio!.provenance.pressure).toBe('atmosphere');
      const sup = st(e).resp.supply!;
      expect(sup).toBeLessThan(0.8);
      expect(Math.abs(sup - supplyIndex(0.2095, 0.0004, pIsa))).toBeLessThan(0.1);
      expect(st(e).fed.o2).toBeGreaterThan(0);
    }
  },
  // Water washing over a lying person's face, 3 s period: many short submersions (each < 2 s), state 'intermittent', the
  // returns counted; clear after the zone ends (65 s); oxygen taken from body stores while under.
  airwayIntermittent: (r) => {
    const s = st(r.people[0]);
    expect(s.airway.submersions).toBeGreaterThanOrEqual(10);
    expect(s.airway.returns).toBeGreaterThanOrEqual(9);
    expect(s.airway.longest).toBeLessThan(2);
    expect(r.samples.some((x) => x.t > 10 && x.t < 60 && x.airway[0] === 'intermittent')).toBe(true);
    expect(r.samples.some((x) => x.airway[0] === 'submerged' && x.t > 10 && x.t < 60)).toBe(false);
    expect(s.airway.state).toBe('clear');
    expect(evs(r, 'AIRWAY_SUBMERGED').length).toBeGreaterThanOrEqual(1);
    expect(s.ledger.o2Debt).toBeGreaterThan(0);
  },
  // Flood water rising to 2.5 m at the shore: continuous submersion of the person at the water's edge; the inland person
  // stays dry.
  airwayContinuous: (r) => {
    const [sea, land] = r.people;
    const s = st(sea);
    expect(s.airway.state).toBe('submerged');
    expect(s.airway.longest).toBeGreaterThan(60);
    expect(sea.physio!.provenance.airway).toBe('flood');
    expect(evs(r, 'AIRWAY_SUBMERGED', sea)).toHaveLength(1);
    expect(st(land).airway.cumulative).toBe(0);
    expect(r.c.getDamageEvents().filter((d) => d.objectId === land.id && PHYSIO_EVENTS.has(d.eventType))).toHaveLength(0);
  },
  // Rubble burial: the airway of a buried person is 'unknown'; inside the confined pocket zone the gases come from the
  // compartment (mass balance), elsewhere they are unknown (checked without the zone below).
  buriedExposure: async (r) => {
    const buried = r.people.filter((e) => e.human!.buried);
    expect(buried.length).toBeGreaterThanOrEqual(1);
    const inPocket = buried.find((e) => e.physio!.provenance.gas === 'confined')!;
    expect(inPocket).toBeDefined();
    expect(st(inPocket).airway.state).toBe('unknown');
    const comp = r.c.getRuntime()!.physiology!.compartments.get(0)!;
    expect(comp.o2).toBeLessThan(comp.ref.o2);
    expect(comp.co2).toBeGreaterThan(comp.ref.co2);
    expect(comp.o2).toBeCloseTo(comp.ref.o2 - comp.ledger.o2Taken + comp.ledger.o2Exchange, 9);
    // Without the pocket zone: gases at the buried airway are unknown (no value invented), no supply index.
    const { doc, events } = physioPreset('buriedExposure')!.build();
    delete doc.settings.simulation.physiology!.zones;
    const c = await load(doc, events);
    c.advance(60);
    const b = humans(c).filter((e) => e.human!.buried);
    expect(b.length).toBeGreaterThanOrEqual(1);
    for (const e of b) {
      expect(e.physio!.provenance.gas).toBe('buriedUnknown');
      expect(st(e).resp.supply).toBeNull();
    }
    c.unload();
  },
  // Earthquake + fire: a person incapacitated by the collapse (physical) next to the burning stand also reaches the heat-dose
  // limit — the combined capacity lists both causes separately; the physiological capacity alone never lists 'physical'.
  quakeFireIncapacitated: (r) => {
    expect(r.samples.some((x) => x.causes.some((c) => c.includes('physical') && c.includes('heatDose')))).toBe(true);
    for (const e of r.people) {
      expect(st(e).limiting).not.toContain('physical');
      if (e.human!.incapacitated) expect(st(e).combined).toBe('unableToAct');
    }
    expect(r.people.some((e) => e.human!.incapacitated)).toBe(true);
  },
};

describe('physiology presets', () => {
  it('24 presets, documented in both languages, own worlds with the extended model + physiology', () => {
    expect(PHYSIO_PRESETS.map((p) => p.id)).toEqual([
      'stableBaseline', 'coldIndoor', 'coldOutdoor', 'coldWind', 'coldWaterPartial', 'coldWaterFull', 'hotIndoor', 'heatwave',
      'hotHumid', 'hotDry', 'highActivity', 'longActivity', 'recovery', 'dehydration', 'fireRadiant', 'fireHotAir', 'smoke',
      'carbonMonoxide', 'hypoxia', 'lowPressure', 'airwayIntermittent', 'airwayContinuous', 'buriedExposure', 'quakeFireIncapacitated',
    ]);
    expect(PHYSIO_PRESETS.map((p) => p.seed)).toEqual(PHYSIO_PRESETS.map((_, k) => 3401 + k));
    const ko = koPhysiologyPresets as Record<string, string>, en = enPhysiologyPresets as Record<string, string>;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const f of ['name', ...PHYSIO_PRESET_FIELDS]) {
      expect(ko[`physioPresets.field.${f}`]).toMatch(/\S/);
      expect(en[`physioPresets.field.${f}`]).toMatch(/\S/);
    }
    for (const p of PHYSIO_PRESETS) {
      expect(p.seconds).toBe(PHYSIO_SECONDS[p.id]);
      for (const f of ['name', ...PHYSIO_PRESET_FIELDS] as const) {
        expect(ko[p.keys[f]], `${p.id}.${f} ko`).toMatch(/\S/);
        expect(en[p.keys[f]], `${p.id}.${f} en`).toMatch(/\S/);
      }
      const { doc } = p.build();
      expect(doc.settings.simulation.humans).toEqual({ model: 'extended' });
      expect(doc.settings.simulation.physiology?.model).toBe('reduced');
      expect(doc.settings.simulation.seed).toBe(p.seed);
      // A preset that uses a zone says so in its conditions and limits.
      if (doc.settings.simulation.physiology?.zones?.length) {
        expect(en[p.keys.conditions] + en[p.keys.limits], p.id).toMatch(/boundary condition/i);
        expect(ko[p.keys.conditions] + ko[p.keys.limits], p.id).toMatch(/경계 조건/);
      }
    }
    // Educational wording (the disclaimer is the one place that names what the model does NOT do).
    for (const [k, s] of Object.entries(en)) if (k !== 'physioPresets.disclaimer') expect(s, k).not.toMatch(/diagnos|time of death|surviv|will die|fatal|lethal/i);
    for (const [k, s] of Object.entries(ko)) if (k !== 'physioPresets.disclaimer') expect(s, k).not.toMatch(/진단|사망|생존|치명/);
  });

  for (const p of PHYSIO_PRESETS) {
    it(`${p.id}: finite, deterministic, one event per transition, expected behaviour`, async () => {
      const T = RUN[p.id] ?? p.seconds;
      const a = await run(p.id, T);
      await deterministic(p.id, a);
      const keys = a.c.getDamageEvents().filter((d) => PHYSIO_EVENTS.has(d.eventType)).map((d) => `${d.objectId}|${d.time}|${d.eventType}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const e of a.people) {
        expect(Math.abs(st(e).ledger.residual)).toBeLessThan(1);
        ledgerCloses(st(e));
      }
      await EXPECT[p.id](a);
      a.c.unload();
    }, 300_000);
  }
});
