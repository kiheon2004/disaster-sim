/** Dynamic objects & vehicles (Phase 35) Korean strings — simulation events, causes, logs. */
export const koVehicle = {
  "hazardName.vehicle": "차량 주행",
  "cause.collision": "충돌",
  "cause.rollover": "전복",
  "cause.stall": "흡기 침수로 엔진 정지",
  "evt.VEHICLE_COLLISION": "차량 충돌",
  "evt.VEHICLE_ROLLOVER": "차량 전복 상태 변화",
  "evt.VEHICLE_DAMAGED": "차량 손상 단계 변화",
  "evt.OCCUPANT_EJECTED": "탑승자 차 밖으로 튕겨 나감",
  "evt.VEHICLE_STALLED": "차량 엔진 정지(침수)",
  "log.vehicle.collision": "{name}: {partner}와(과) 충돌 — 속도 변화 {dv} m/s",
  "log.vehicle.rollover": "{name}: {state}",
  "log.vehicle.damage": "{name}: 차량 손상 단계 {level} (교육용 지표)",
  "log.vehicle.ejected": "{name}: 탑승자 {human}이(가) 차 밖으로 튕겨 나감",
  "log.vehicle.stalled": "{name}: 물이 흡기 높이를 넘어 엔진이 멈춤",
} as const;
