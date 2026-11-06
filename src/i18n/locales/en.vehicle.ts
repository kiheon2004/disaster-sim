/** Dynamic objects & vehicles (Phase 35) English strings — simulation events, causes, logs. */
export const enVehicle = {
  "hazardName.vehicle": "Vehicle motion",
  "cause.collision": "Collision",
  "cause.rollover": "Rollover",
  "cause.stall": "Engine stopped by water in the intake",
  "evt.VEHICLE_COLLISION": "Vehicle collision",
  "evt.VEHICLE_ROLLOVER": "Vehicle rollover state changed",
  "evt.VEHICLE_DAMAGED": "Vehicle damage level changed",
  "evt.OCCUPANT_EJECTED": "Occupant thrown out of the vehicle",
  "evt.VEHICLE_STALLED": "Vehicle engine stopped (water)",
  "log.vehicle.collision": "{name}: collision with {partner} — velocity change {dv} m/s",
  "log.vehicle.rollover": "{name}: {state}",
  "log.vehicle.damage": "{name}: vehicle damage level {level} (educational index)",
  "log.vehicle.ejected": "{name}: occupant {human} thrown out of the vehicle",
  "log.vehicle.stalled": "{name}: water above the intake height stopped the engine",
} as const;
