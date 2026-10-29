/**
 * Thermal energy ledger (Phase 26). Energies in J, internal energy measured as sensible heat above
 * the ambient reference state (every node starts at the reference temperature → initial 0).
 *
 *   final internal = initial + added + boundary supply + impact deposit − Σ lost      (+ residual)
 *
 *  added            heat output of power / energy sources (their full output, incl. the radiation
 *                   that nothing absorbs — that part is booked as lost.unresolvedRadiation)
 *  boundarySupply   net heat given to the world by prescribed-temperature sources (negative when
 *                   a cold boundary absorbs heat)
 *  impactDeposit    impact energy share deposited as heat (Phase 23 partition, `thermalShare`)
 *  combustion       heat of combustion released by burning fuel (Phase 27: ΔH_c·Δm, equal to the fire
 *                   ledger's `released`) — never booked as source input
 *  volcanic         heat given up by lava and volcanic deposits (Phase 28, equal to the volcano ledger's
 *                   heat to ground / objects / water / air + radiation); what nothing absorbs is radiationSky
 *  airMass          Phase 29: change of the air's heat (above the reference) by the atmosphere's mass
 *                   changes — air removed / restored / carried by the column flow and the adiabatic
 *                   expansion / compression work of the air that stays (outdoor layer and rooms)
 *  lost.*           heat that LEFT the resolved world (it is not destroyed — it went to the
 *                   surroundings): surface radiation to the ambient surroundings, source radiation
 *                   not absorbed, air vented to the free atmosphere / advected out of the world,
 *                   convection of surfaces above the air layer, the deep ground below the columns,
 *                   water leaving through the edges / drains, fragments leaving the world.
 *  transfers.*      gross energy moved INSIDE the world by each mechanism (|Q| summed; informational)
 *  residual         final − expected: numerical round-off only (tested)
 */
export interface ThermalLosses {
  radiationSky: number;
  unresolvedRadiation: number;
  atmosphere: number;
  airAdvection: number;
  aboveLayer: number;
  deepGround: number;
  water: number;
  debris: number;
  /** Latent heat carried away by evaporated fuel moisture (Phase 27). */
  evaporation: number;
}

export interface ThermalTransfers {
  conduction: number;
  convection: number;
  radiation: number;
  waterAdvection: number;
  airAdvection: number;
}

export const LOSS_KEYS: readonly (keyof ThermalLosses)[] = ['radiationSky', 'unresolvedRadiation', 'atmosphere', 'airAdvection', 'aboveLayer', 'deepGround', 'water', 'debris', 'evaporation'];

export class ThermalLedger {
  initial = 0;
  added = 0;
  boundarySupply = 0;
  impactDeposit = 0;
  /** Heat of combustion (Phase 27). */
  combustion = 0;
  /** Of which no receiver absorbed (also inside lost.unresolvedRadiation / aboveLayer) — informational. */
  combustionUnresolved = 0;
  /** Heat from lava / volcanic deposits (Phase 28). */
  volcanic = 0;
  /** Phase 29: heat change of the air by atmospheric mass changes and pressure work (signed). */
  airMass = 0;
  readonly lost: ThermalLosses = { radiationSky: 0, unresolvedRadiation: 0, atmosphere: 0, airAdvection: 0, aboveLayer: 0, deepGround: 0, water: 0, debris: 0, evaporation: 0 };
  readonly transfers: ThermalTransfers = { conduction: 0, convection: 0, radiation: 0, waterAdvection: 0, airAdvection: 0 };
  /** Internal energy at the last update (J). */
  final = 0;
  /** Per heat source (by id): energy added (J). */
  readonly bySource = new Map<string, number>();

  totalLost(): number {
    let s = 0;
    for (const k of LOSS_KEYS) s += this.lost[k];
    return s;
  }

  expected(): number {
    return this.initial + this.added + this.boundarySupply + this.impactDeposit + this.combustion + this.volcanic + this.airMass - this.totalLost();
  }

  residual(): number {
    return this.final - this.expected();
  }

  /** Relative residual against the energy that ever entered (0 when nothing did). */
  relativeResidual(): number {
    const scale = Math.abs(this.added) + Math.abs(this.boundarySupply) + Math.abs(this.impactDeposit) + this.combustion + this.volcanic + Math.abs(this.airMass) + this.totalLost();
    return scale > 0 ? Math.abs(this.residual()) / scale : 0;
  }

  snapshot() {
    return {
      initial: this.initial, added: this.added, boundarySupply: this.boundarySupply, impactDeposit: this.impactDeposit, combustion: this.combustion,
      ...(this.volcanic ? { volcanic: this.volcanic } : {}),
      ...(this.airMass ? { airMass: this.airMass } : {}),
      lost: { ...this.lost }, totalLost: this.totalLost(), transfers: { ...this.transfers }, final: this.final, residual: this.residual(),
    };
  }
}
