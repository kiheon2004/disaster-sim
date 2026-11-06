/**
 * Phase 34: the physiology of extended-model people, every 0.1 s at the end of the post-physics phase (after the thermal,
 * fire, climate and exposure systems of the step — it reads their state, writes nothing back to them). Per person:
 * exposure sample → `stepPhysiology` → transitions as events (one per change, never per step) → the coupling the Phase 33
 * posture control reads next step (ankle-moment factor, whether stance may be kept). Confined compartments take the
 * occupants' O₂ uptake / CO₂ output (only of people breathing their air) and exchange with the reference air.
 * Captured people are frozen (state kept, no updates). Dormant without physiology settings.
 */
import type { DamageEventType, Hazard } from '../analysis/DamageEvent';
import type { SimulationSystem, SystemContext } from '../systems/SimulationSystem';
import type { RuntimeEntity } from '../SimulationRuntime';
import { simProfiler } from '../profiling/SimProfiler';
import { CAPACITY_LEVELS, deficitPercent, primePhysiology, stepPhysiology, thermalStrain, type Transition } from '@/physiology/engine';
import { MOL_PER_L_STPD } from '@/physiology/gas';
import { DEFAULT_REFERENCE } from '@/physiology/settings';
import { ZERO_C } from '@/thermal/units';
import { sample } from './sampler';
import { SERIES_KEYS, SERIES_MAX, type PhysioEntity } from './state';
import { createCompartment, stepCompartment } from './zones';

export const PHYSIO_INTERVAL = 6;
const BALANCE: Record<string, number> = { normal: 1, stressed: 1, impaired: 0.8, severelyImpaired: 0.5, unableToAct: 0 };

function eventOf(tr: Transition): { type: DamageEventType; hazard: Hazard } | null {
  switch (tr.kind) {
    case 'thermal': return { type: tr.to === 'normal' ? 'THERMAL_RECOVERED' : 'THERMAL_STRESS', hazard: 'thermal' };
    case 'airway':
      if ((tr.to === 'submerged' || tr.to === 'intermittent') && (tr.from === 'clear' || tr.from === 'unknown')) return { type: 'AIRWAY_SUBMERGED', hazard: 'flood' };
      if (tr.to === 'clear') return { type: 'AIRWAY_CLEARED', hazard: 'flood' };
      return null;
    case 'respiratory': return { type: 'RESPIRATORY_STRESS', hazard: 'thermal' };
    case 'gas': return { type: 'GAS_EXPOSURE', hazard: 'fire' };
    case 'hydration': return { type: 'HYDRATION_STRESS', hazard: 'thermal' };
    case 'fatigue': return { type: 'FATIGUE_LIMIT', hazard: 'thermal' };
    case 'capacity': return { type: 'CAPACITY_CHANGED', hazard: 'thermal' };
  }
}

export class PhysiologySystem implements SimulationSystem {
  readonly name = 'physiology';
  readonly phase = 'postPhysics' as const;
  readonly interval = PHYSIO_INTERVAL;
  readonly reads = ['poses', 'damage', 'temperature', 'water', 'exposure', 'airflow'] as const;
  readonly writes = ['physiology'] as const;

  isActive(ctx: SystemContext) {
    return !!ctx.runtime.physiology;
  }

  update(ctx: SystemContext, dt: number) {
    const t0 = simProfiler.now();
    const rt = ctx.runtime.physiology!;
    const cfg = rt.settings;
    const ref = { ...DEFAULT_REFERENCE, ...(cfg.reference ?? {}) };
    if (!rt.initialized) {
      rt.initialized = true;
      cfg.zones?.forEach((z, i) => {
        if (z.confined) rt.compartments.set(i, createCompartment(i, z, ref.o2, ref.co2, z.pressure ?? ref.pressure, z.airTemperature ?? ctx.env.thermal.rt?.world.Tref ?? 288.15));
      });
    }
    // Time at the end of the physics step that just ran.
    const t = ctx.time + dt / this.interval;
    const uptake = new Map<number, { o2: number; co2: number }>();
    for (const e of ctx.runtime.entities.values()) {
      const pe = e.physio;
      if (!pe || !e.human) continue;
      if (e.flags.captured || e.body === null) {
        pe.frozen = true;
        continue;
      }
      const ts = simProfiler.now();
      const smp = sample(ctx, e, cfg, rt.compartments);
      simProfiler.add('physio.sample', ts);
      pe.provenance = smp.provenance;
      pe.sample = { airT: smp.airT, qFire: smp.qFire, qSolar: smp.qSolar, immersed: smp.immersed, airway: smp.airway, buried: smp.buried };
      if (!pe.primed) {
        pe.primed = true;
        primePhysiology(pe.s, pe.cfg, smp.exposure);
      }
      const o2Before = pe.s.ledger.o2, debtBefore = pe.s.ledger.o2Debt, co2Before = pe.s.ledger.co2;
      const tp = simProfiler.now();
      const trs = stepPhysiology(pe.s, pe.cfg, smp.exposure, dt, t);
      simProfiler.add('physio.step', tp);
      const tr0 = simProfiler.now();
      if (smp.compartment >= 0) {
        const breathed = (pe.s.ledger.o2 - o2Before) - (pe.s.ledger.o2Debt - debtBefore);
        const u = uptake.get(smp.compartment) ?? { o2: 0, co2: 0 };
        u.o2 += breathed;
        // CO₂ leaves with the breath only while breathing (the share of the step breathed).
        const share = pe.s.ledger.o2 - o2Before > 0 ? breathed / (pe.s.ledger.o2 - o2Before) : 0;
        u.co2 += (pe.s.ledger.co2 - co2Before) * share;
        uptake.set(smp.compartment, u);
      }
      for (const tr of trs) this.record(ctx, e, pe, tr);
      const cap = pe.s.capacity;
      pe.couple.balance = BALANCE[cap];
      pe.couple.canStand = cap !== 'unableToAct';
      if (pe.series) this.seriesPush(pe, t);
      simProfiler.add('physio.record', tr0);
    }
    for (const [i, c] of rt.compartments) {
      const u = uptake.get(i) ?? { o2: 0, co2: 0 };
      stepCompartment(c, u.o2, u.co2, dt);
    }
    simProfiler.add('physiology', t0);
  }

  private record(ctx: SystemContext, e: RuntimeEntity, pe: PhysioEntity, tr: Transition) {
    const ev = eventOf(tr);
    if (!ev) return;
    const s = pe.s;
    const value = tr.kind === 'thermal' ? s.Tc - ZERO_C : tr.kind === 'airway' ? s.airway.cumulative : tr.kind === 'gas' ? s.fed.co + s.fed.o2 + s.fed.co2 : tr.kind === 'hydration' ? deficitPercent(s, pe.cfg.mass) : tr.kind === 'fatigue' ? s.fatigue : CAPACITY_LEVELS.indexOf(s.combined);
    ctx.recordDamage(e, {
      eventType: ev.type, cause: 'physiology', hazard: ev.hazard, response: value,
      physio: { kind: tr.kind, from: tr.from, to: tr.to, value, causes: tr.kind === 'capacity' ? s.combinedCauses.join('+') : undefined },
    });
  }

  private seriesPush(pe: PhysioEntity, t: number) {
    const ser = pe.series!;
    const last = ser.t.length ? ser.t[ser.t.length - 1] : -Infinity;
    if (t - last < ser.dt - 1e-9) return;
    const s = pe.s, f = s.last, mo = pe.cfg.modules;
    const heatIn = f ? f.M + f.absorbed + f.cond : NaN;
    const heatOut = f ? f.W + f.resSens + f.resLat + f.conv + f.rad + f.water + f.contact + f.evap : NaN;
    const vals: Record<(typeof SERIES_KEYS)[number], number> = {
      // A switched-off module is not computed: NaN (a gap), never 0.
      core: mo.thermal ? s.Tc - ZERO_C : NaN, skin: mo.thermal ? s.Ts - ZERO_C : NaN, air: pe.sample ? pe.sample.airT - ZERO_C : NaN, heatIn, heatOut,
      strain: mo.thermal ? thermalStrain(s.Tc - ZERO_C) : NaN, breathing: s.resp.breathing ? 1 : 0, supply: s.resp.supply ?? NaN,
      smoke: mo.gas ? s.dose.smoke * 1e6 / 60 : NaN, airway: mo.submersion ? s.airway.cumulative : NaN, deficit: mo.hydration ? deficitPercent(s, pe.cfg.mass) : NaN, fatigue: mo.fatigue ? s.fatigue : NaN,
      capacity: CAPACITY_LEVELS.indexOf(s.combined),
    };
    ser.t.push(t);
    for (const k of SERIES_KEYS) ser.v[k].push(vals[k]);
    if (ser.t.length >= SERIES_MAX) {
      const keep = (a: number[]) => a.filter((_, i) => i % 2 === 0);
      ser.t = keep(ser.t);
      for (const k of SERIES_KEYS) ser.v[k] = keep(ser.v[k]);
      ser.dt *= 2;
    }
  }
}

/** Oxygen amount (mol) per litre STPD — re-exported for the ledger views. */
export { MOL_PER_L_STPD };
