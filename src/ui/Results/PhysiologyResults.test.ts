import { describe, expect, it } from 'vitest';
import { useWorldStore } from '@/world/worldStore';
import { SimulationController } from '@/simulation/SimulationController';
import type { Vec3 } from '@/core/types';
import type { PhysiologySettings } from '@/physiology/settings';
import {
  aggregatePhysio, physioCsv, physioEntities, physioJson, physioRow, PHYSIO_CSV_COLUMNS, PHYSIO_EXPORT_SCHEMA, PROVENANCE_FIELDS,
} from '@/simulation/physiology/summary';
import { koPhysiologyUi } from '@/i18n/locales/ko.physiologyUi';
import { enPhysiologyUi } from '@/i18n/locales/en.physiologyUi';
import { isMessageKey } from '@/i18n/i18n';
import { PHYSIO_METRICS } from '@/rendering/viewStore';
import { seriesRange } from './PhysiologyResults';

const K = 273.15;
const S = () => useWorldStore.getState();
const person = (x: number, seed: number) => ({ type: 'human', seed, params: { height: 1.75, shirtColor: '#ffffff', pantsColor: '#000000' }, transform: { position: [x, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 } });

async function run(physiology: PhysiologySettings, seconds: number) {
  S().setLocked(false);
  S().newDocument();
  S().doc.settings.simulation.seed = 5;
  S().doc.settings.simulation.humans = { model: 'extended' };
  S().doc.settings.simulation.physiology = physiology;
  S().applyEdit({ add: [person(0, 1), person(3, 2)] as never });
  const c = new SimulationController({ headless: true });
  await c.load(structuredClone(S().doc));
  c.advance(seconds);
  return c;
}

describe('physiology results (Phase 34 UI)', () => {
  it('series range ignores NaN gaps; an all-gap series has no range', () => {
    expect(seriesRange([[1, NaN, 3], [NaN, -2]])).toEqual([-2, 3]);
    expect(seriesRange([[NaN, NaN]])).toBeNull();
    expect(seriesRange([[2, 2]])).toEqual([1.5, 2.5]);
  });

  it('cold zone: rows, aggregate, CSV and JSON carry the schema, units, provenance; uncomputed = empty / null, never 0', async () => {
    const c = await run({ model: 'reduced', modules: { gas: false }, zones: [{ id: 'cold', shape: 'box', center: [0, 1, 0], size: [20, 6, 20], airTemperature: 0 + K, wind: 5 }] }, 30);
    const rt = c.getRuntime()!;
    const ps = physioEntities(rt.entities.values());
    expect(ps).toHaveLength(2);
    const r = physioRow(ps[0]);
    expect(r.provenance.airT).toBe('zone');
    expect(r.provenance.humidity).toBe('reference');
    expect(r.air).toBeCloseTo(0, 6);
    expect(r.core).not.toBeNull();
    expect(r.skin!).toBeLessThan(34);
    // Gas module off → doses not computed (null, not 0).
    expect(r.fedCo).toBeNull();
    expect(r.smokeDose).toBeNull();
    expect(r.supply).not.toBeNull();
    const a = aggregatePhysio(rt.entities.values());
    expect(a.people).toBe(2);
    expect(a.maxFedAsphyxiant).toBeNull();
    expect(a.combined.normal + a.combined.stressed + a.combined.impaired + a.combined.severelyImpaired + a.combined.unableToAct).toBe(2);
    const csv = physioCsv(rt.entities.values(), c.getDamageEvents(), c.getTime()).split('\n');
    expect(csv[0]).toBe(`# schema: disaster-sim.physiology v${PHYSIO_EXPORT_SCHEMA}`);
    expect(csv[1]).toContain('not a medical prediction');
    expect(csv.some((l) => l.startsWith('# units:'))).toBe(true);
    const hi = csv.indexOf(PHYSIO_CSV_COLUMNS.join(','));
    expect(hi).toBeGreaterThan(0);
    const cols = PHYSIO_CSV_COLUMNS as readonly string[];
    const row = csv[hi + 1].split(',');
    expect(row).toHaveLength(cols.length);
    expect(row[cols.indexOf('src_airT')]).toBe('zone');
    expect(row[cols.indexOf('fed_co')]).toBe('');
    expect(row[cols.indexOf('smoke_dose_mg_min_m3')]).toBe('');
    expect(row[cols.indexOf('model_version')]).toBe('reduced-1');
    expect(csv.some((l) => l.startsWith('# series'))).toBe(true);
    const j = JSON.parse(JSON.stringify(physioJson(rt.entities.values(), c.getDamageEvents(), rt.physiology)));
    expect(j.schemaVersion).toBe(PHYSIO_EXPORT_SCHEMA);
    expect(j.units.coDose).toBe('ppm·min');
    expect(j.people[0].fedCo).toBeNull();
    // The smoke series is NaN while the gas module is off → null in JSON (a gap).
    expect(j.people[0].series.smoke.every((v: number | null) => v === null)).toBe(true);
    expect(j.people[0].provenance.airT).toBe('zone');
    expect(physioJson([], [], undefined)).toBeUndefined();
    c.unload();
  });

  it('CO zone: FED / dose and the capacity change are exported with the event rows', async () => {
    const c = await run({ model: 'reduced', zones: [{ id: 'co', shape: 'box', center: [0, 1, 0], size: [20, 6, 20], co: 0.05 }] }, 90);
    const rt = c.getRuntime()!;
    const r = physioRow(physioEntities(rt.entities.values())[0]);
    expect(r.fedCo!).toBeGreaterThan(1);
    expect(r.coDose!).toBeGreaterThan(35000);
    expect(r.combined).toBe('unableToAct');
    expect(r.combinedCauses).toContain('gas');
    const csv = physioCsv(rt.entities.values(), c.getDamageEvents(), c.getTime());
    expect(csv).toContain('# events');
    expect(csv).toMatch(/,CAPACITY_CHANGED,capacity,/);
    c.unload();
  });

  it('i18n: every UI key in both languages, non-empty; every sampler source code, metric and level has a label', () => {
    const ko = Object.keys(koPhysiologyUi), en = Object.keys(enPhysiologyUi);
    expect(en.sort()).toEqual([...ko].sort());
    expect(ko.every((k) => k.startsWith('physioUi.'))).toBe(true);
    for (const v of [...Object.values(koPhysiologyUi), ...Object.values(enPhysiologyUi)]) expect((v as string).length).toBeGreaterThan(0);
    const codes = ['scene.ambient', 'thermal.room', 'thermal.air', 'thermal.above', 'zone', 'climate', 'reference', 'unknown', 'atmosphere', 'windField', 'stillAir', 'assumedAir',
      'climate.shaded', 'climate.sun', 'sourcesAndFlames', 'sourcesAndFlames+zone', 'flood', 'thermal.water', 'lava', 'thermal.ground', 'fire.room', 'fire.air', 'confined', 'buriedUnknown', 'unspeciated', 'buried', 'noWater'];
    for (const c of codes) expect(isMessageKey(`physioUi.src.${c.replace(/[.+]/g, '_')}`), c).toBe(true);
    for (const f of PROVENANCE_FIELDS) expect(isMessageKey(`physioUi.field.${f}`), f).toBe(true);
    for (const m of PHYSIO_METRICS) expect(isMessageKey(`physioUi.metric.${m}`) && isMessageKey(`physioUi.metric.${m}.meaning`), m).toBe(true);
  });
});
