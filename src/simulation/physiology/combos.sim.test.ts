/**
 * Phase 34 (spec §62): combined exposures. Each scene combines two effects and checks that each is counted ONCE — with an
 * expectation that does not come from the run itself:
 *   heat ledger: body energy change = Σ ledger terms (shivering only inside the metabolic term), evaporated mass × L_v =
 *   evaporative heat; water: lost = evaporated + dripped + respiratory; inhaled terms frozen while the airway is under;
 *   FEDs as the integrals of their own rates; the capacity is the worst component (never a sum) and its causes are
 *   listed separately; a confined compartment's O₂ / CO₂ change equals the occupants' exchange plus the air exchange.
 * Run times are shortened where the environment is costly (climate / flood / collapse — see presets.sim.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { SimulationController } from '@/simulation/SimulationController';
import type { RuntimeEntity } from '@/simulation/SimulationRuntime';
import type { WorldDocument } from '@/core/model';
import type { EventSpec } from '@/events/specs';
import { physioPreset, type PhysioPresetId } from '@/physiology/presets';
import { buildPhysioWorld, zoneBox } from '@/physiology/demos';
import { person } from '@/human/demos';
import { CAPACITY_LEVELS, COMPONENTS, deficitPercent, energy, type CapacityLevel, type PhysioState } from '@/physiology/engine';
import { P } from '@/physiology/params';
import type { PhysiologySettings } from '@/physiology/settings';

const K = 273.15;
const st = (e: RuntimeEntity) => e.physio!.s;
const humans = (c: SimulationController) => [...c.getRuntime()!.entities.values()].filter((e) => e.source.type === 'human');

async function load(doc: WorldDocument, events: EventSpec[] = []) {
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(doc));
  for (const e of events) c.addEvent(e);
  return c;
}
async function preset(id: PhysioPresetId) {
  const { doc, events } = physioPreset(id)!.build();
  return load(doc, events);
}
/** A flat scene with people and physiology settings only (no environment event). */
function scene(people: { x: number; z: number; physio?: Record<string, unknown> }[], physiology: Omit<PhysiologySettings, 'model'>, seed = 3499) {
  return buildPhysioWorld({ objects: people.map((p, k) => ({ ...person(p.x, p.z, k + 1), ...(p.physio ? { physio: p.physio } : {}) })), physiology: { model: 'reduced', ...physiology }, seed, name: 'combo' });
}

function ledgerCloses(s: PhysioState) {
  const L = s.ledger;
  const net = L.metabolic - L.work - L.resSens - L.resLat - (L.conv + L.rad - L.absorbed) - L.water - L.contact - L.evap + L.cond;
  expect(Math.abs(energy(s) - s.U0 - net)).toBeLessThan(1e-6 * Math.max(1e5, Math.abs(L.metabolic)));
  expect(Math.abs(L.evapMass * P.latentHeat - L.evap)).toBeLessThan(1e-6 * Math.max(1, Math.abs(L.evap)));
  // Shivering is part of the metabolic heat, never an extra input.
  expect(L.shiver).toBeLessThanOrEqual(L.metabolic + 1e-9);
}
function waterCloses(s: PhysioState) {
  const L = s.ledger;
  expect(s.waterLost).toBeCloseTo(L.evapMass + L.drip + L.resMass, 9);
  expect(s.waterIntake).toBeCloseTo(L.intake, 12);
}
/** Capacity = worst component level (not a sum); limiting = the components at that level. */
function capacityIsWorst(s: PhysioState) {
  const worst = COMPONENTS.reduce<CapacityLevel>((w, c) => (CAPACITY_LEVELS.indexOf(s.levels[c]) > CAPACITY_LEVELS.indexOf(w) ? s.levels[c] : w), 'normal');
  expect(s.capacity).toBe(worst);
  if (worst !== 'normal') expect(s.limiting).toEqual(COMPONENTS.filter((c) => s.levels[c] === worst));
  expect(new Set(s.combinedCauses).size).toBe(s.combinedCauses.length);
}

describe('combined exposures (spec §62)', () => {
  it('hot + humid: high humidity limits evaporation → more heat stored than in dry air at the same temperature; ledgers close', async () => {
    const out: PhysioState[] = [];
    for (const id of ['hotHumid', 'hotDry'] as const) {
      const c = await preset(id);
      c.advance(150); // climate world: 150 s of the 1800 s presets (cost)
      const s = st(humans(c)[0]);
      ledgerCloses(s);
      waterCloses(s);
      out.push({ Tc: s.Tc, ledger: { ...s.ledger } } as PhysioState);
      c.unload();
    }
    const [humid, dry] = out;
    expect(humid.Tc).toBeGreaterThan(dry.Tc);
    expect(dry.ledger.evap).toBeGreaterThan(humid.ledger.evap);
    // Unevaporated sweat drips: it leaves as water but carries no evaporative heat.
    expect(humid.ledger.drip).toBeGreaterThanOrEqual(dry.ledger.drip);
  }, 300_000);

  it('hot + dehydration: the deficit raises the core (set-point shift), intake is counted once, water losses close', async () => {
    const c = await preset('dehydration');
    c.advance(3600);
    const [dry, drink] = humans(c);
    const m = dry.physio!.cfg.mass;
    for (const e of [dry, drink]) { ledgerCloses(st(e)); waterCloses(st(e)); }
    expect(st(dry).ledger.intake).toBe(0);
    expect(st(drink).ledger.intake).toBeCloseTo(0.4, 6);
    expect(deficitPercent(st(dry), m)).toBeCloseTo((100 * (st(dry).waterLost - 0)) / m, 9);
    expect(deficitPercent(st(drink), m)).toBeCloseTo((100 * (st(drink).waterLost - st(drink).waterIntake)) / m, 9);
    // Dehydration shifts the core set point upward (≤ 0.15 K per %): the person without water ends warmer, by at most that shift.
    const shift = P.dehydrationCoreShift * deficitPercent(st(dry), m);
    expect(st(dry).Tc).toBeGreaterThan(st(drink).Tc);
    expect(st(dry).Tc - st(drink).Tc).toBeLessThan(shift + 0.05);
    c.unload();
  }, 300_000);

  it('cold + wind: forced convection cools the skin faster than still air; convection carries the extra loss, counted once', async () => {
    const out: PhysioState[] = [];
    for (const id of ['coldOutdoor', 'coldWind'] as const) {
      const c = await preset(id);
      c.advance(150); // climate world: 150 s of the 1800 s presets (cost)
      const s = st(humans(c)[0]);
      ledgerCloses(s);
      out.push({ Ts: s.Ts, ledger: { ...s.ledger } } as PhysioState);
      c.unload();
    }
    const [still, wind] = out;
    expect(wind.Ts).toBeLessThan(still.Ts);
    expect(wind.ledger.conv).toBeGreaterThan(still.ledger.conv);
  }, 300_000);

  it('cold + immersion: heat leaves through water only from the immersed area; air terms only from the rest — no surface counted twice', async () => {
    // Both people in 10 °C air (large zone); the second zone (last wins) adds water to the neck around the first person.
    const zones = [zoneBox('air', [10, 1, 0], [60, 6, 20], { airTemperature: 10 + K }), zoneBox('w', [0, 1, 0], [6, 6, 6], { water: { level: 1.45, temperature: 10 + K }, airTemperature: 10 + K })];
    const c = await load(scene([{ x: 0, z: 0 }, { x: 20, z: 0 }], { activity: 'resting', zones }));
    c.advance(900);
    const [wet, dry] = humans(c);
    const s = st(wet), r = st(dry);
    ledgerCloses(s);
    ledgerCloses(r);
    const f = wet.physio!.sample!.immersed;
    expect(f).toBeGreaterThan(0.8);
    expect(s.ledger.water).toBeGreaterThan(3 * (s.ledger.conv + s.ledger.rad));
    // Air terms only from the air-exposed share (1 − f) of the surface, from a colder skin (smaller gradient) than the dry
    // reference in the same air: at most (1 − f) of the reference's air loss (+ 5 % for the clothing-area factor).
    expect(s.ledger.conv + s.ledger.rad).toBeLessThan((1 - f + 0.05) * (r.ledger.conv + r.ledger.rad));
    expect(r.ledger.water).toBe(0);
    expect(s.wet).toBeGreaterThan(0.9);
    c.unload();
  }, 120_000);

  it('fire + smoke: radiant heat dose and inhaled smoke / CO are separate accounts; each FED is the integral of its own rate', async () => {
    const c = await preset('smoke');
    c.advance(150);
    const s = st(humans(c)[0]);
    ledgerCloses(s);
    expect(s.dose.radiant).toBeGreaterThan(0);
    expect(s.dose.smoke).toBeGreaterThan(0);
    // Radiant FED = ∫ q^(4/3) dt / (r · 60) (q in kW/m² above 1.7) = radiant dose / (r · 60).
    expect(s.fed.heatRad).toBeCloseTo(s.dose.radiant / (P.radHeatR * 60), 9);
    // CO FED from the CO dose alone, times the CO₂ hyperventilation factor exp(%CO₂ / 5) ≥ 1; 30 m downwind the CO₂ (reference
    // + the fire's O₂ deficit) stays well below 0.5 %, so the factor is < exp(0.1) ≈ 1.105 — no other term enters.
    const ratio = s.fed.co / (s.dose.co / 60 / P.coDose);
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(ratio).toBeLessThan(Math.exp(0.5 / P.co2Hyperventilation));
    expect(s.dose.smokeDeposited).toBeCloseTo(P.smokeDeposition * s.dose.smokeInhaled, 15);
    capacityIsWorst(s);
    c.unload();
  }, 300_000);

  it('smoke + low O₂: the smoke dose and the hypoxia dose / supply index are independent; smoke inhaled = concentration × ventilation', async () => {
    const zones = [zoneBox('z', [0, 1, 0], [6, 6, 6], { smoke: 0.002, o2: 0.15 })];
    const c = await load(scene([{ x: 0, z: 0 }], { activity: 'resting', zones }));
    c.advance(300);
    const s = st(humans(c)[0]);
    // Constant concentration from t = 0: smoke dose = c · t (trapezoid exact for constant exposure).
    expect(s.dose.smoke).toBeCloseTo(0.002 * 300, 6);
    expect(s.dose.o2Deficit).toBeCloseTo((0.2095 - 0.15) * 300, 6);
    expect(s.resp.supply!).toBeLessThan(1);
    expect(s.fed.o2).toBeGreaterThan(0);
    // Inhaled smoke ≤ concentration × the largest ventilation over the run (ventilation demand of the metabolic rate).
    expect(s.dose.smokeInhaled).toBeGreaterThan(0);
    expect(s.dose.smokeInhaled).toBeLessThan(0.002 * (P.ventilationMax / 60 / 1000) * 300);
    expect(s.fed.co).toBe(0);
    capacityIsWorst(s);
    c.unload();
  }, 120_000);

  it('flood + airway submersion: while the airway is under nothing is inhaled and O₂ comes from the body store (debt = uptake while under)', async () => {
    const c = await preset('airwayContinuous');
    const p = humans(c)[0];
    let before: { co2: number; inh: number; debt: number; o2: number } | null = null;
    for (let t = 0; t < 120; t += 5) {
      c.advance(5);
      const s = st(p);
      if (s.airway.continuous > 10 && !before) before = { co2: s.dose.co2, inh: s.dose.smokeInhaled, debt: s.ledger.o2Debt, o2: s.ledger.o2 };
    }
    const s = st(p);
    expect(before).not.toBeNull();
    expect(s.airway.continuous).toBeGreaterThan(30);
    expect(s.dose.co2).toBe(before!.co2);
    expect(s.dose.smokeInhaled).toBe(before!.inh);
    expect(s.ledger.o2Debt - before!.debt).toBeCloseTo(s.ledger.o2 - before!.o2, 12);
    expect(s.resp.actual).toBe(0);
    expect(c.getDamageEvents().filter((d) => d.eventType === 'AIRWAY_SUBMERGED' && d.objectId === p.id)).toHaveLength(1);
    ledgerCloses(s);
    c.unload();
  }, 300_000);

  it('buried + low ventilation: the confined pocket loses exactly the O₂ the occupant breathed (plus the small exchange); gases otherwise unknown', async () => {
    const c = await preset('buriedExposure');
    c.advance(120);
    const comp = c.getRuntime()!.physiology!.compartments.get(0)!;
    const inPocket = humans(c).filter((e) => e.physio!.provenance.gas === 'confined');
    expect(inPocket.length).toBe(1);
    expect(inPocket[0].human!.buried).toBe(true);
    expect(comp.o2).toBeCloseTo(comp.ref.o2 - comp.ledger.o2Taken + comp.ledger.o2Exchange, 9);
    expect(comp.co2).toBeCloseTo(comp.ref.co2 + comp.ledger.co2Given + comp.ledger.co2Exchange, 9);
    // Exchange is towards the reference air: O₂ in, CO₂ out — never more than what was taken / given.
    expect(comp.ledger.o2Exchange).toBeGreaterThanOrEqual(0);
    expect(comp.ledger.o2Exchange).toBeLessThan(comp.ledger.o2Taken);
    expect(comp.ledger.co2Given / comp.ledger.o2Taken).toBeCloseTo(P.respiratoryQuotient, 6);
    // Only the occupant's breathing (from the zone start at 20 s) — never more than the person's total uptake.
    const s = st(inPocket[0]);
    expect(comp.ledger.o2Taken).toBeLessThanOrEqual(s.ledger.o2 - s.ledger.o2Debt + 1e-12);
    for (const e of humans(c)) if (e.human!.buried && e.physio!.provenance.gas !== 'confined') expect(e.physio!.provenance.gas).toBe('buriedUnknown');
    c.unload();
  }, 300_000);

  it('collision injury + physiological capacity: the Phase 33 incapacitation and the heat-dose limit are listed as separate causes', async () => {
    const c = await preset('quakeFireIncapacitated');
    let both = false;
    for (let t = 0; t < 120; t += 5) {
      c.advance(5);
      for (const e of humans(c)) {
        const s = st(e);
        capacityIsWorst(s);
        expect(s.limiting).not.toContain('physical');
        if (s.combinedCauses.includes('physical') && s.combinedCauses.includes('heatDose')) {
          both = true;
          expect(e.human!.incapacitated || e.human!.mobility !== 'mobile').toBe(true);
          expect(s.levels.heatDose).toBe(s.combined);
        }
      }
    }
    expect(both).toBe(true);
    // The physiology never writes the Phase 33 health / injury state.
    for (const e of humans(c)) expect(e.health).toBeGreaterThanOrEqual(0);
    c.unload();
  }, 300_000);

  it('hot + high activity: metabolic heat and environmental heat add through one ledger; only the strenuous person fatigues', async () => {
    const zones = [zoneBox('z', [0, 1, 0], [40, 6, 10], { airTemperature: 38 + K, humidity: 0.5 })];
    const c = await load(scene([{ x: -2, z: 0, physio: { activity: 'strenuous' } }, { x: 2, z: 0, physio: { activity: 'resting' } }], { clothing: 'light', zones }));
    c.advance(900);
    const [hard, rest] = humans(c).map(st);
    for (const s of [hard, rest]) { ledgerCloses(s); waterCloses(s); }
    expect(hard.Tc - rest.Tc).toBeGreaterThan(0.5);
    expect(hard.fatigue).toBeGreaterThan(0);
    expect(rest.fatigue).toBe(0);
    // Metabolic heat ≈ M · A · t: strenuous 6.5 met vs resting 1.2 met (the heat reduces the capacity, not the rate below the limit).
    const ratio = hard.ledger.metabolic / rest.ledger.metabolic;
    expect(ratio).toBeGreaterThan(0.8 * (6.5 / 1.2));
    expect(ratio).toBeLessThan(1.2 * (6.5 / 1.2));
    c.unload();
  }, 120_000);
});
