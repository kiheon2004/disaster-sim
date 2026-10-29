/**
 * Fire ledgers (Phase 27): fuel mass, chemical energy, oxygen, smoke and water — every account is a
 * running total kept by FireWorld, and each has an identity that is checked (tests, results panel):
 *
 *   fuel      registered = remaining + consumed + left                              (kg)
 *   chemical  registered = remaining + released + left                              (J)
 *             released   = Σ ΔH_c,eff · Δm  =  ThermalLedger.combustion (the heat entered the
 *                          thermal nodes through the same steps; the share no receiver absorbed is
 *                          the thermal ledger's unresolved radiation — `unresolved` here)
 *   oxygen    consumed = released / E_O₂ (kg; rooms and outdoor air)
 *   smoke     produced = in rooms + in the air layer + vented above + advected out of the world
 *   water     evaporated (kg) × L_v = latent heat that left with the steam (thermal lost.evaporation)
 * Burned fuel is never restored: `consumed` only grows and an item's mass only falls.
 */
export class FireLedger {
  /** Fuel registered (kg) and its chemical energy (J): fuel joins when its object enters the thermal network. */
  fuelRegistered = 0;
  chemRegistered = 0;
  fuelConsumed = 0;
  /** Heat of combustion released (J): inside rooms, outdoors, as flames outside openings (vent-limited excess). */
  released = 0;
  releasedRooms = 0;
  releasedOutdoor = 0;
  releasedExternal = 0;
  /** Fuel / chemical energy carried out of the world (fragments leaving). */
  fuelLeft = 0;
  chemLeft = 0;
  /** Burnable mass moved between items (debris landing on a heap) — informational, both sides counted. */
  fuelMoved = 0;
  oxygenConsumed = 0;
  smokeProduced = 0;
  smokeVented = 0;
  smokeAdvected = 0;
  waterEvaporated = 0;
  latentHeat = 0;
  /** Thermal-ledger view of the combustion heat (filled by the adapter after each step). */
  unresolved = 0;

  /** Remaining fuel / chemical energy of the live items (filled by FireWorld). */
  fuelRemaining = 0;
  chemRemaining = 0;
  smokeRooms = 0;
  smokeAir = 0;

  fuelResidual(): number {
    return this.fuelRegistered - this.fuelRemaining - this.fuelConsumed - this.fuelLeft;
  }

  chemResidual(): number {
    return this.chemRegistered - this.chemRemaining - this.released - this.chemLeft;
  }

  smokeResidual(): number {
    return this.smokeProduced - this.smokeRooms - this.smokeAir - this.smokeVented - this.smokeAdvected;
  }

  snapshot() {
    return {
      fuelRegistered: this.fuelRegistered, fuelRemaining: this.fuelRemaining, fuelConsumed: this.fuelConsumed, fuelLeft: this.fuelLeft,
      chemRegistered: this.chemRegistered, chemRemaining: this.chemRemaining, released: this.released, chemLeft: this.chemLeft,
      releasedRooms: this.releasedRooms, releasedOutdoor: this.releasedOutdoor, releasedExternal: this.releasedExternal, unresolved: this.unresolved,
      oxygenConsumed: this.oxygenConsumed, smokeProduced: this.smokeProduced, smokeRooms: this.smokeRooms, smokeAir: this.smokeAir,
      smokeVented: this.smokeVented, smokeAdvected: this.smokeAdvected, waterEvaporated: this.waterEvaporated, latentHeat: this.latentHeat,
      fuelResidual: this.fuelResidual(), chemResidual: this.chemResidual(), smokeResidual: this.smokeResidual(),
    };
  }
}
