/**
 * Phase 27 combustion library (pure): fuel data, ignition relations (thick / thin flux–time
 * products), vent flow, flame height / tilt, smoke optics, state transitions, and the conservation
 * of fuel mass, chemical energy, oxygen and smoke on a ThermalWorld (closed and open).
 */
import { describe, expect, it } from 'vitest';
import { createFlatTerrain } from '@/terrain/TerrainData';
import { ThermalWorld, defaultThermalSettings, TK, type SourceStep } from '@/thermal/ThermalWorld';
import { BK, type BodyInit } from '@/thermal/ThermalBodies';
import { TM } from '@/thermal/materials';
import { SIGMA } from '@/thermal/units';
import {
  CONTENTS_FIRE, E_O2, FM, FUEL_MATERIALS, MOISTURE_EXTINCTION, Y_O2_AIR, Y_O2_LIMIT, ftpCritical, preIgnitionHeat, thinFtpCritical, CHAR_RATE,
} from './materials';
import { flameHeight, flameTilt, gasEmissivity, ventInflow, visibility } from './relations';
import { FireWorld, FS, IK, canTransition, isBurning } from './FireWorld';
import { fireIssues, fireSettingsIssues, defaultFireSettings, type FireSpec } from './types';

const Tref = 288.15;
const world = (closed = false) => new ThermalWorld(createFlatTerrain(40), { ...defaultThermalSettings(), ambient: Tref }, 1.225, { closed });

const timberBody = (over: Partial<BodyInit> = {}): BodyInit => ({
  kind: BK.member, mSkin: 30, mCore: 70, matSkin: TM.timber, matCore: TM.timber, Av: 6, Atop: 0, Abot: 0, Lv: 2.5, Lh: 0.1, Lf: 1.2,
  tSkin: 0.05, Asc: 6, Lsc: 0.05, fOut: 1, fC1: 0, fC2: 0, comp1: -1, comp2: -1, sx: 1.2, sy: 2.5, sz: 0.2, x: 0, y: 1.25, z: 0, yg: 0, ref: 0, sub: 0, ...over,
});

/** Steps a world with its fire: the combustion energies go in as `combustion` source steps (room → its gas, outdoors → the item's own node / air). */
function burn(tw: ThermalWorld, fw: FireWorld, seconds: number, extra?: (fw: FireWorld) => void) {
  const dt = 0.1;
  for (let k = 0; k < Math.round(seconds / dt); k++) {
    extra?.(fw);
    fw.step(dt);
    const steps: SourceStep[] = [];
    for (let i = 0; i < fw.n; i++) {
      const E = fw.Estep[i];
      if (E <= 0) continue;
      const r = fw.room[i];
      if (r >= 0) steps.push({ id: `r${i}`, energy: E, deposits: [{ kind: TK.comp, index: fw.rooms[r].tc, w: 1 }], combustion: true });
      else steps.push({ id: `o${i}`, energy: E, deposits: [{ kind: TK.air, index: Math.max(0, fw.airOf(i)), w: 1 }], combustion: true });
    }
    tw.step(dt, steps);
    fw.roomRadiation();
    fw.transportOutdoor(dt, 0, 0);
  }
}

describe('fuel data and ignition relations', () => {
  it('uses the stated literature values and only lists fuels', () => {
    const t = FUEL_MATERIALS[FM.timber];
    expect(t.dHc).toBe(12.4e6);
    expect(t.Tig - 273.15).toBeCloseTo(350, 9);
    expect(t.qcr).toBe(12e3);
    expect(CHAR_RATE * 60 * 1000).toBeCloseTo(0.65, 12); // EN 1995-1-2 β₀ (mm/min)
    expect(t.mChar).toBeCloseTo(0.75 * 450 * 1.5 * CHAR_RATE, 12);
    expect(CONTENTS_FIRE.residential!.qf).toBe(780e6);
    expect(CONTENTS_FIRE.office!.qf).toBe(420e6);
    expect(CONTENTS_FIRE.industrial).toBeNull(); // no adopted reference value → no contents fuel
    expect(FUEL_MATERIALS[FM.contents].dHc).toBeCloseTo(0.8 * 17.5e6, 6);
    expect(E_O2).toBe(13.1e6);
    expect(FUEL_MATERIALS.map((m) => m.id)).toEqual(['timber', 'greenWood', 'foliage', 'contents']);
  });

  it('thick ignition: the flux–time product gives cone-like ignition times and rejects fluxes below critical', () => {
    const t = FUEL_MATERIALS[FM.timber];
    const tig = (q: number) => ftpCritical(t, t.Tig, Tref) / (q - t.qcr) ** 2;
    expect(tig(25e3)).toBeGreaterThan(60);
    expect(tig(25e3)).toBeLessThan(300);
    expect(tig(50e3)).toBeGreaterThan(5);
    expect(tig(50e3)).toBeLessThan(40);
    // Same constant as the closed-form t_ig = (π/4)kρc((T_ig − T₀)/q)².
    expect(ftpCritical(t, t.Tig, Tref)).toBeCloseTo((Math.PI / 4) * t.kpc * (t.Tig - Tref) ** 2, 3);
  });

  it('thin ignition needs more heat the wetter the foliage (Rothermel heat of pre-ignition)', () => {
    expect(preIgnitionHeat(0)).toBe(581e3);
    expect(thinFtpCritical(1.5)).toBeGreaterThan(5 * thinFtpCritical(0));
    expect(thinFtpCritical(0.2)).toBeLessThan(thinFtpCritical(0.3));
  });

  it('vent flow: zero at ambient, ≈ 0.5·A·√H for a fully developed fire (Kawagoe)', () => {
    expect(ventInflow(2, 1.5, Tref, Tref, 1.2)).toBe(0);
    const k = ventInflow(2, 1.5, 1100, Tref, 1.2) / (2 * Math.sqrt(1.5));
    expect(k).toBeGreaterThan(0.45);
    expect(k).toBeLessThan(0.56);
    expect(ventInflow(2, 1.5, 400, Tref, 1.2)).toBeLessThan(ventInflow(2, 1.5, 800, Tref, 1.2));
  });

  it('flame height (Heskestad), tilt (Thomas) and smoke optics', () => {
    expect(flameHeight(1e6, 1)).toBeCloseTo(0.235 * Math.pow(1000, 0.4) - 1.02, 9);
    expect(flameHeight(1e5, 3)).toBe(0);
    expect(flameTilt(0, 1e6, 1, 12e6)).toBe(0);
    expect(flameTilt(10, 1e6, 1, 12e6)).toBeGreaterThan(flameTilt(3, 1e6, 1, 12e6));
    expect(visibility(0)).toBe(Infinity);
    expect(visibility(3 / 8700)).toBeCloseTo(1, 9);
    expect(gasEmissivity(0, 1000, 100, 150)).toBe(0);
    expect(gasEmissivity(5e-3, 1000, 100, 150)).toBeGreaterThan(0.95);
  });

  it('validates specs and settings with reasons', () => {
    const ok: FireSpec = { event: 'fire', position: [0, 0], height: 1, radius: 1, duration: 600 };
    expect(fireIssues(ok)).toEqual([]);
    expect(fireIssues({ ...ok, radius: 0 })).toContain('fire.invalid.radius');
    expect(fireIssues({ ...ok, height: -1 })).toContain('fire.invalid.height');
    expect(fireIssues({ ...ok, duration: 1 })).toContain('fire.invalid.duration');
    expect(fireSettingsIssues(defaultFireSettings())).toEqual([]);
    expect(fireSettingsIssues({ ...defaultFireSettings(), foliageMoisture: 9 })).toContain('fire.invalid.moisture');
  });
});

describe('fire states', () => {
  it('allows only the listed transitions; burned out is final', () => {
    expect(canTransition(FS.unheated, FS.heating)).toBe(true);
    expect(canTransition(FS.pyrolysis, FS.unheated)).toBe(false);
    expect(canTransition(FS.burning, FS.unheated)).toBe(false);
    expect(canTransition(FS.extinguished, FS.ignited)).toBe(true);
    for (let s = 0; s < 8; s++) if (s !== FS.burnedOut) expect(canTransition(FS.burnedOut, s)).toBe(false);
    expect(isBurning(FS.decaying)).toBe(true);
    expect(isBurning(FS.extinguished)).toBe(false);
  });
});

describe('FireWorld on a thermal world', () => {
  it('room contents follow the EN 1991-1-2 t² growth until the oxygen runs short; O₂ never goes below what the limit allows', () => {
    const tw = world();
    const tc = tw.addCompartment(150, -1, 0.5);
    const fw = new FireWorld(tw);
    const r = fw.addRoom(tc, 150, 50, 2 * 50 + 30 * 3, -1, 0.02, tw.air.rho);
    const d = CONTENTS_FIRE.residential!;
    const i = fw.add({ kind: IK.contents, mat: FM.contents, body: -1, core: false, home: r, fuel: (d.qf * 50) / 17.5e6, water: 0, area: 50, size: 7, solid: 0, volume: 0, design: d, x: 0, y: 0.5, z: 0, ref: 0, sub: 0 });
    expect(fw.ignite(i, true)).toBe(true);
    burn(tw, fw, 120);
    // t² growth: Q(120 s) = 1 MW·(120/300)² = 160 kW (sealed room still has enough O₂ at 2 min).
    expect(fw.hrr[i]).toBeCloseTo(1e6 * (120 / 300) ** 2, -3);
    burn(tw, fw, 900);
    const R = fw.rooms[r];
    expect(R.o2).toBeGreaterThanOrEqual(Y_O2_LIMIT * R.gas * 0.999);
    // Starved: the burning inside is what the leak brings in above the limit.
    expect(fw.hrr[i]).toBeLessThan(E_O2 * 0.02 * (Y_O2_AIR - Y_O2_LIMIT) * 1.05);
    const L = fw.ledger;
    expect(Math.abs(L.chemResidual()) / L.chemRegistered).toBeLessThan(1e-9);
    expect(Math.abs(L.fuelResidual()) / L.fuelRegistered).toBeLessThan(1e-9);
    expect(Math.abs(L.smokeResidual())).toBeLessThan(1e-9 * Math.max(1, L.smokeProduced));
    expect(tw.ledger.combustion).toBeCloseTo(L.released, -1);
    expect(L.oxygenConsumed).toBeCloseTo(L.released / E_O2, 6);
    expect(Math.abs(tw.ledger.residual()) / tw.ledger.combustion).toBeLessThan(1e-9);
  });

  it('a burning solid loses mass (never regained), carries its sensible heat to the gas, and a lone surface without outside heat goes out', () => {
    const tw = world();
    const b = tw.bodies.add(timberBody());
    tw.placeBody(b, 0, 1.25, 0, 0);
    const fw = new FireWorld(tw);
    const i = fw.add({ kind: IK.member, mat: FM.timber, body: b, core: false, home: -1, fuel: 75, water: 0, area: 3, size: 2.5, solid: 100, volume: 0.6, x: 0, y: 0, z: 0, ref: 0, sub: 0 });
    expect(fw.ignite(i, false)).toBe(true);
    const m0 = tw.bodies.mS[b] + tw.bodies.mC[b];
    burn(tw, fw, 10);
    expect(fw.state[i]).toBe(FS.extinguished); // q_fl 25 − re-radiation 23 kW/m² → ṁ″ ≈ 1 g/(m²s) < 3.5
    expect(tw.bodies.mS[b] + tw.bodies.mC[b]).toBeLessThanOrEqual(m0);
    // With an outside flux it keeps burning (mutual / external radiation).
    fw.qInc[i] = 30e3;
    expect(fw.ignite(i, false)).toBe(true);
    let last = fw.m[i];
    burn(tw, fw, 30, (f) => { f.qInc[i] = 30e3; expect(f.m[i]).toBeLessThanOrEqual(last); last = f.m[i]; });
    expect(isBurning(fw.state[i])).toBe(true);
    expect(fw.char[i]).toBeGreaterThan(0);
    expect(Math.abs(fw.ledger.chemResidual()) / fw.ledger.chemRegistered).toBeLessThan(1e-9);
    expect(Math.abs(tw.ledger.residual()) / (tw.ledger.combustion + tw.ledger.totalLost())).toBeLessThan(1e-9);
  });

  it('thick fuels ignite from the flux history (piloted earlier than not); thin wet fuel is refused', () => {
    const tw = world();
    const fw = new FireWorld(tw);
    const mk = () => {
      const b = tw.bodies.add(timberBody());
      tw.placeBody(b, 0, 1.25, 0, 0);
      return fw.add({ kind: IK.member, mat: FM.timber, body: b, core: false, home: -1, fuel: 75, water: 0, area: 3, size: 2.5, solid: 100, volume: 0.6, x: 0, y: 0, z: 0, ref: 0, sub: 0 });
    };
    const p = mk(), a = mk();
    let tp = NaN, ta = NaN;
    for (let k = 0; k < 3000 && (Number.isNaN(tp) || Number.isNaN(ta)); k++) {
      fw.qInc[p] = 40e3; fw.qInc[a] = 40e3; fw.pilot[p] = 1; fw.pilot[a] = 0;
      fw.step(0.1);
      if (Number.isNaN(tp) && fw.state[p] === FS.ignited) tp = fw.time;
      if (Number.isNaN(ta) && fw.state[a] === FS.ignited) ta = fw.time;
    }
    expect(tp).toBeGreaterThan(20);
    expect(tp).toBeLessThan(ta);
    // Thin foliage wetter than the moisture of extinction cannot be lit by the scenario.
    const b = tw.bodies.add({ ...timberBody(), matSkin: TM.foliage, matCore: TM.wood });
    const f = fw.add({ kind: IK.foliage, mat: FM.foliage, body: b, core: false, home: -1, fuel: 10, water: 15, area: 30, size: 4, solid: 10, volume: 30, x: 0, y: 0, z: 0, ref: -1, sub: 0 });
    expect(fw.tooMoist(f)).toBe(true);
    expect(fw.ignite(f, false)).toBe(false);
    fw.water[f] = MOISTURE_EXTINCTION * 10 * 0.9;
    expect(fw.ignite(f, false)).toBe(true);
  });

  it('illegal transitions throw instead of passing silently', () => {
    const tw = world();
    const fw = new FireWorld(tw);
    const i = fw.add({ kind: IK.heap, mat: FM.timber, body: -1, core: false, home: -1, fuel: 1, water: 0, area: 1, size: 1, solid: 1, volume: 0.1, x: 0, y: 0, z: 0, ref: 0, sub: 0 });
    fw.state[i] = FS.burnedOut;
    expect(() => (fw as unknown as { set(i: number, s: number): void }).set(i, FS.burning)).toThrow(/illegal fire state/);
  });

  it('gas radiation only acts when a room has smoke (Phase 26 rooms unchanged otherwise)', () => {
    const tw = world();
    const tc = tw.addCompartment(100, -1, 0.5);
    expect(tw.comps[tc].eps).toBe(0);
    expect(tw.comps[tc].Gx).toBe(0);
    const fw = new FireWorld(tw);
    fw.addRoom(tc, 100, 33, 150, -1, 0.01, tw.air.rho);
    fw.roomRadiation();
    expect(tw.comps[tc].eps).toBe(0);
    fw.rooms[0].soot = 0.3;
    tw.comps[tc].E = tw.comps[tc].C * 500;
    fw.roomRadiation();
    expect(tw.comps[tc].eps).toBeGreaterThan(0.9);
    expect(SIGMA).toBeGreaterThan(0);
  });
});
