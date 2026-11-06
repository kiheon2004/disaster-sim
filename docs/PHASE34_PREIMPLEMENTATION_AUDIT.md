# Phase 34 사전 감사 — 인체 생리 반응을 위한 기존 상태 (기준 `816f48e`)

구현 전에 기존 코드에서 확인한 사실과 그에 따른 설계 경계입니다. 줄 번호는 `816f48e` 기준입니다. "없음" = 코드에 존재하지 않음,
"가정" = 상수/기준값(계산값 아님). 사실 조사는 읽기 전용 감사(도우미)와 직접 확인을 함께 썼습니다.

## 1. 기존 인체 상태 (Phase 33)

- 확장 모델(`settings.simulation.humans = { model: 'extended' }`)의 사람만 `e.human`(`HumanState`)을 가집니다: 8구획(`model.segments`,
  국소 좌표 y0/y1/radius/centre), 자세 12종, 서 있음, 균형 상태, 부상 지표·단계, 이동 능력(`mobility`), 행동 불가(`incapacitated`),
  매몰(`buried`, BURIED 이벤트에서), 포획(`flags.captured`). `e.health`/`e.state`는 `HumanSystem`이 매 스텝 단일 소유자로 덮어씁니다.
- `humanSnapshot(e)`(`src/simulation/human/interface.ts`)는 구획 세계 위치·단계, 이동 능력, 매몰·포획, 물 깊이, 머리 중심 침수
  (`headSubmerged` = 머리 중심 < 수면 — 기도 침수와 같지 않음), 노출 위치(머리 중심), 활동 상태를 줍니다. Phase 34의 기본 연결점으로 씁니다.
- 기도 위치는 없습니다 → 머리 축 0.90 H, 머리 반지름 0.85만큼 앞(얼굴 방향 국소 +z)으로 근사합니다(자세·머리 방향 반영).

## 2–8. 환경 상태와 데이터 (온도·습도·압력·기체·연기·수위·수온)

아래 표는 변수별 판정이고, 시스템별 사실(경로·단위·해상도·주기·보간·성격·범위 밖 처리)은 문서 끝 부록에 있습니다(부록의 절 번호는 원문 그대로).

### 환경 변수 요약 표 (사람 위치 (x,y,z), 시간 t에서)

| 변수 | 존재? | 출처 (file:function) | 단위 | 공간 해상도 | 시간 해상도 | 보간 | 측정/계산/가정 | 없을 때 |
|---|---|---|---|---|---|---|---|---|
| 공기 온도 (실외) | 조건부 | `thermal/AirLayer.ts:T(index(x,z,h))` via `env.thermal.rt.world.air`; 대기 시 `atmosphere/runtime.ts:temperatureAt` | K | 5 m 기둥, 층 0–10 m 단일값 | 0.1 s | 없음(최근접) | 계산 (열/기후/대기/화재/화산 런만) | 열 런타임 없음 → `settings.thermal.ambient` 288.15 K 가정 |
| 공기 온도 (실내 방) | 조건부 | `ThermalWorld.compT(c)` + `ThermalRuntime.buildingContaining(P)` | K | 방(층) 1노드 | 0.1 s | 없음 | 계산 (모듈러 건물만) | 없음 |
| 평균복사온도 / 입사 복사 플럭스 | 부분적 | `ThermalRuntime.exposure`(private) → `e.exposure.thermal.radiant` | W/m² | 사람별 점 | 0.1 s | — | 근사 계산: thermal source만, P₀ 고정(시간형상 무시), 차폐·화염·용암·태양 제외 | MRT **없음**; 플럭스 0 |
| 표면 접촉 온도 | 부분적 | `TerrainThermal.T(c,0)`, `ThermalBodies.TS/TC`, `ClimateWorld.coverT(c)`, `LavaField.Ts[i]` | K | 지형 1 m 셀 / 바디 / 정점 | 0.1 s (지면은 groundDt 서브스텝) | 없음 | 계산 (0.01 m 노드, 표면 그 자체 아님) | 인체 접촉 API 없음; `Tref` |
| RH / 수증기압 | 조건부 | `ClimateWorld.rh(a)`, `q(a)`, `psychro.vapourPressure(q,p)`, `probe(x,z)` | –, kg/kg, Pa | 5 m 기둥 | 0.1 s | 없음 | 계산 (기후 실험만) | **없음** (기본 습도 상수도 없음) |
| 기압 | 조건부 | `AtmosphereRuntime.pressureAt(x,y,z)`; `ClimateWorld.p(a)` | Pa | 5 m 기둥 + 수직 지수 | 0.1 s (바로 0.5 s) | 수직만 해석적 | 계산 (대기 실험만) | 101325 Pa 가정 (`BASELINE_ATMOSPHERE`, `ClimateWorld.p0`) |
| 바람 벡터 | 있음 | `e.localWind.velocity` (WindForceSystem → `SpatialWindField.sample`), 대기 시 `+ flowAt` | m/s | 연속(장애물 후류·돌풍) | 60 Hz (WindForceSystem 활성 시) | 해석적 | 계산(처방 바람장 + 대기흐름) | `baseSpeed=0` → 0 (대기 없으면 미갱신) |
| O₂ 분율 | 조건부 | `FireWorld.outdoorY(a)` (실외), `rooms[r].o2/gas` (방) | 질량분율 | 5 m 기둥 / 방 | 0.1 s | 없음 | 계산 (화재 런만) | `Y_O2_AIR=0.232` 질량 / `0.2095` 부피 가정; 분압 = 압력×분율(직접 필드 없음) |
| CO | **없음** | — | — | — | — | — | — | 없음 |
| CO₂ | **없음** | — | — | — | — | — | — | 없음 (화산가스는 종 없는 `AtmosphereField.gas` kg) |
| 연기/매연 농도 | 조건부 | `FireWorld.soot[a]/(H·cellArea)`; 방 `rooms[r].soot/V`; `e.exposure.fire.smoke` | kg/m³ | 5 m 기둥(층 균일) / 방 | 0.1 s | 없음 | 계산 (매연 질량만) | 0 |
| 화산재 공기농도 | **없음** (점 질의) | `VolcanoWorld.puffs` (Gaussian 퍼프) | kg | 퍼프 | 0.1 s | — | 계산되나 점 농도 함수 없음 | 없음 |
| 수심 | 조건부 | `WaterField.sampleDepth(x,z)`; `e.flood.depth` | m | 1 m 셀 | 솔버 10 Hz, 샘플 60 Hz | 쌍선형(젖은 셀) | 계산 | 0 (`FloodEnvironment.depthAt`) |
| 수면 고도 | 조건부 | `WaterField.sampleSurface(x,z)`; `e.flood.surface`; `humanSnapshot().headSubmerged` | m | 1 m 셀 | 10 Hz / 60 Hz | 쌍선형 | 계산 | `-Infinity` |
| 유속 | 조건부 | `WaterField.sampleVelocity(x,z,out)`; `e.flood.flow/speed` | m/s ([x,z]) | 1 m 셀 | 10 Hz / 60 Hz | 쌍선형 | 계산 (수심평균) | 0 |
| 수온 | 조건부 | `ThermalWorld.waterT(c)` | K | 1 m 셀 | 0.1 s | 없음 | 계산 (물 + 열 런타임 둘 다 있을 때만) | **없음** (암묵적 `Tref`) |
| 일사 | 조건부 | `ClimateWorld.sun {direct, diffuse, elevation, dir}`, `shade[c]`, `surf.solar[c]` | W/m² | 전역 + 1 m 셀 그림자 | 0.1 s (표면 5 s) | 없음 | 계산 (기후 실험만); 사람 흡수량 미계산 | **없음** (0) |
| 강수/젖음 | 부분적 | `ClimateForcing.precipRate(t)` (mm/h, 균일); `env.flood.rainIntensity()` (mm/h) | mm/h | 전역 | 이벤트/0.1 s | — | 처방 입력 | 0; 사람 젖음 모델 **없음** |
| 적설 | 조건부 | `ClimateWorld.snowDepth(c)`, `swe(c)`, `iceThickness(c)`; `e.climate.snow/ice/restricted` | m | 1 m 셀 | 표면 5 s, 사람 기록 1 s | 없음 | 계산 (기후 실험만) | 0 |
| 중력 | 있음 | `env.gravity.at(x,y,z,out)`, `ratio()`, `magnitude()` | m/s² | 연속(해석적) | 스텝마다 `prepare` | 해석적 | 설정/계산 | `[0, −g0, 0]`, g0 = 9.81 |


## 9. 기존 손상·노출 시스템

열·화재·기후·대기·용암·물로 사람의 `health`를 깎는 코드는 **없습니다**(부록 §8). 기존 노출 기록(`e.exposure.thermal/fire`, `e.climate`,
`e.flood`, `e.volcano`)은 1 m 고정 높이 등 한계가 있는 표시용 값이며 손상에 쓰이지 않습니다. → Phase 34가 처음으로 생리 부담을
다루며, 이중 계산할 기존 경로가 없습니다. Phase 34는 `e.health`를 쓰지 않고(물리 손상의 단일 소유자 유지) 별도 기능 상태를 둡니다.

## 10. 기존 장부 구조

열(`ThermalLedger`), 화재(`FireLedger`: 산소 소비·매연 생산), 기후(물·에너지), 물(`WaterBudget`), 대기(질량·산소·에너지·운동량)는
각자 장부를 가집니다. 사람 몫의 계정은 없습니다 → Phase 34는 **환경 → 인체 일방향 결합**: 환경 장부를 바꾸지 않고, 사람의 열·물·기체
교환은 사람별 장부에만 기록합니다(환경에 반영했다고 주장하지 않음). 예외: 경계 조건 구역의 밀폐 공간(`confined`)은 생리 쪽의
독립 구획 모델이며 O₂/CO₂ 질량 보존을 시험합니다.

## 11. 시간 스텝

고정 1/60 s, 열·화재·기후·대기는 0.1 s(6스텝)마다, 물 솔버 10 Hz. 생리 시스템은 0.1 s마다 postPhysics **맨 끝**(같은 스텝의 열·노출
상태를 읽음)에 실행하고, Phase 33 자세 제어는 그 결과를 다음 스텝에 읽습니다.

## 12. 저장 스키마

`schemaVersion` 1–7, `settings.simulation.humans`는 zod `.catch(undefined)`. 새 `physiology`도 같은 정책(잘못된 값은 버림, 고치지 않음),
스키마 버전은 그대로(선택 필드).

## 13. 렌더링 구조

UI는 런타임 객체를 직접 읽고(`simulationController.getRuntime()`), `useSimStore` 시간으로 다시 그립니다. 렌더러는 읽기 전용입니다.

## 14. 결정론

시스템 순서 고정, 엔티티 Map 순회는 문서 객체 순서(Phase 33에서 객체 순서 바꾸기 시험). 생리 시스템은 사람마다 독립이고, 밀폐 구획의
흡입량 합산만 순서에 기대므로(덧셈 순서) 구획별 합을 사람 순회 후 한 번에 적용합니다.

## 15. 성능 병목

Phase 33 측정: 1000명 지진에서 Rapier 스텝이 가장 큼. 생리 시스템은 강체를 추가하지 않고 0.1 s마다 사람당 샘플 1회 + 2노드 Heun 2회
평가입니다. 샘플러의 직접 복사(열원·화염 수만큼)와 방 찾기(`buildingContaining`)가 사람 수에 비례하는 비용입니다.

## 16. 누락된 환경 데이터 → 정책

| 변수 | 정책 |
|---|---|
| 습도(기후 실험 밖) | 기준값(가정, 사용자 변경 가능, 출처 'reference') |
| 기압(대기 실험 밖) | 기준값 101 325 Pa(가정) |
| O₂/CO₂ 조성 | 기준 건조 공기 0.2095 / 0.0004 mol/mol(가정). 화재 중: 화재 O₂ 결손(질량분율 → 몰분율), CO₂ = 기준 + O₂ 결손(1:1, 셀룰로스 화학량론) |
| CO | 화재 없음: 0(깨끗한 기준 공기 가정). 화재 중: 운반된 매연 × CO/매연 수율비 0.27(환기 양호 목재, Tewarson) — 환기 부족 화재는 과소 추정 |
| 연기 | 화재 매연 농도(kg/m³). 렌더링 입자는 쓰지 않음 |
| 평균 복사 온도 | 기후 실험의 하늘·지면(`bodyTrad`), 아니면 공기 온도와 같다고 가정(출처 'assumedAir') |
| 직접 복사 | 열원(시간 형상 반영)·화염(점원, 복사분율 0.35)·태양(기후, 그늘 반영) — 기존 노출 값(피크 P₀, 화염 제외)은 쓰지 않음 |
| 수온 | 열 모델의 물 온도, 아니면 기준 수온 15 °C(가정, 출처 'reference') |
| 접촉 온도 | 누운 사람: 지면 열 노드(0.01 m)·용암 표면, 아니면 미지원(그 면적은 공기와 교환, 출처 'unknown') |
| 화산가스·화산재 | 종·점 농도 없음 → 계산하지 않음(출처 플래그만) |
| 매몰 공간 기체 | 정보 없음 → 기체 노출 미지원('buriedUnknown'), 밀폐 구역이 주어질 때만 계산 |

실험용 경계 조건 구역(`physiology.zones`)은 환경 시뮬레이션의 결과가 아니며, 힘·열·질량을 세계에 더하지 않습니다.

## 17. 새 모델의 책임 경계

| 상태 | 소유 |
|---|---|
| 낙상·충돌·구획 충격 위험·물리적 이동 능력·`health` | Phase 33 `HumanSystem` |
| 체온(중심·피부)·열 부담·호흡·산소 공급 지표·가스/연기/열 선량·기도 침수 이력·체수분·피로 | Phase 34 생리 엔진 |
| 최종 행동 능력(물리 ⊕ 생리, 제한 원인 기록) | Phase 34 능력 해석기(`combined`, `combinedCauses`) |
| 자세 유지에 미치는 생리 영향 | Phase 34가 계수(발목 모멘트 비율, 서기 가능)를 주고 Phase 33이 읽음 — 강체 속도를 직접 바꾸지 않음 |

---

# 부록: 시스템별 사실 (감사 원문)

## 0. 공통 골격 — 생리 시스템이 환경에 접근하는 경로

- `SystemContext` (`src/simulation/systems/SimulationSystem.ts:10-30`): `env: Readonly<EnvironmentState>`, `runtime`, `physics`, `time`, `step`, `rng`, `fxRng`, `log`, `recordDamage`, `forces`, `interactions`, `milestone?`.
- `EnvironmentState` (`src/simulation/environment/EnvironmentState.ts:34-62`): `time, airDensity, wind, windField, terrain, groundMotion, flood, deformation, groundFailure, impact, blast, thermal, fire, volcano, atmosphere, climate, gravity`.
- 온도/화재/화산/대기/기후 상태는 모두 **`ThermalSystem` 안에서** 생성·갱신됨 (`src/simulation/systems/ThermalSystem.ts:45-150`). 각 채널의 `rt`(runtime)는 첫 활동 시 생성되고 그 전엔 `null`:
  - `ctx.env.thermal.rt : ThermalRuntime | null` → `.world : ThermalWorld` (AirLayer, TerrainThermal, ThermalBodies, comps)
  - `ctx.env.fire.rt : FireRuntime | null` → `.fw : FireWorld`
  - `ctx.env.volcano.rt : VolcanoRuntime | null` → `.vw : VolcanoWorld`
  - `ctx.env.atmosphere.rt : AtmosphereRuntime | null` → `.field : AtmosphereField`
  - `ctx.env.climate.rt : ClimateRuntime | null` → `.cw : ClimateWorld`
- `ThermalSystem.isActive` = `thermal.active || fire.active || volcano.active || atmosphere.active || climate.active` (`ThermalSystem.ts:41-43`). 이 중 아무것도 없으면 **공기 온도 필드 자체가 존재하지 않음**.
- 실행 순서 (ThermalSystem.update): thermal.prepare → atmosphere 생성/`prepare` → climate 생성/`prepare` → volcano `prepare` → fire `prepare` → `rt.world.step(dt, steps)` → fire.`after` → atmosphere.`after` → climate.`after` → volcano.`after` → thermal `rt.after` (couple, exposure, statistics) (`ThermalSystem.ts:66-146`).
- 주기: `THERMAL_INTERVAL = 6` (6×1/60 s = 0.1 s, `ThermalSystem.ts:30`), `update(ctx, dt*6)`; `stepIndex % 6 === 0`인 스텝에서만 실행 (`SimulationController.ts:543-555`). 해당 스텝에서 상태는 `[t, t+0.1)` 구간을 적분한 **끝값**(물리 시간보다 최대 0.1 s 앞섬).

---

## 1. Atmosphere (Phase 29) — `src/atmosphere/*`, `src/simulation/atmosphere/runtime.ts`

**휴면 조건**: `AtmosphereChannel.active = rt !== null || experiments.length > 0` (`AtmosphereChannel.ts:27-29`). 실험 1개/런(두 번째는 reject). 실험이 없으면 `ctx.env.atmosphere.rt === null` → 압력/밀도 필드 없음.

**필드** (`AtmosphereField`, `src/atmosphere/AtmosphereField.ts:176-245`):
- 격자: Phase 26 AirLayer와 동일한 5 m 기둥 (`AIR_CELL = 5`, `src/thermal/AirLayer.ts:32`), `nx×nz`, `dx`.
- `sigma: Float64Array` 기둥 공기질량 (kg/m²), `surfacePressure(a) = sigma[a]*g` (Pa) (`:320`).
- `pressureAt(a, h, Tl)` (Pa): 층(0..H) 안은 `ps·exp(−h/H_s(Tl))`, H 위는 `Tcol`로 정역학 (`:335-341`).
- `densityAt(a, h, Tl)` (kg/m³) = p/(R·T) (`:343-347`); `layerDensity(a)` (Boussinesq).
- `velocity(x, z, h, out)` (m/s, [x,z]): 기둥 평균 흐름 + 층 수렴흐름, `velocityAt`로 면→점 보간 (`:372-382`).
- `gas: Float64Array` 기둥당 화산가스 (kg) — 종 구분 없음 (`:213`).
- `Tcol` 층 위 자유대기 온도 (K) (`:215`).
- 층 내부 온도는 소유하지 않음 → `ThermalWorld.air.T(a)`가 소유.

**런타임 점 질의** (`src/simulation/atmosphere/runtime.ts:474-503`), `ctx.env.atmosphere.rt`:
- `column(x, z): number` — 격자 밖이면 **가장자리 기둥으로 clamp** (`:474-479`).
- `temperatureAt(a, h): number` (K) — `h ≤ H`이면 `trt.world.air.T(a)`, 위는 `field.Tcol`.
- `pressureAt(x, y, z): number` (Pa), `densityAt(x, y, z): number` (kg/m³) — `h = y − field.ground[a]`.
- `flowAt(x, z, h, out): [number, number]` (m/s).
- 보간: 압력·밀도는 기둥 내 상수(최근접 기둥, 수직은 지수 프로파일), 속도는 면 보간.

**조성**: O₂ 분율 필드 **없음** (대기 쪽). O₂ 질량분율은 상수 `Y_O2_AIR = 0.232` (`src/fire/materials.ts:141`, `reference.ts:28` 재수출). 제거(removal)는 동일 조성의 공기를 빼므로 분율은 유지되고 **분압만** 압력과 함께 감소. 화재가 있으면 기둥별 O₂ 결손 `fire.fw.o2def[a]`가 실제 분율을 낮춤(§4). CO / CO₂ / 독성가스 필드 **없음** (grep 결과 0건; i18n `model.lim.noSpecies`, `model.lim.noGasChemistry`가 한계로 명시).

**저압/제거 시나리오**: 존재. `AtmosphereSpec.removal: 'none'|'linear'|'exponential'|'scheduled'|'pressure'`, `extent: 'uniform'|'local'`, `restore`, `thermo: 'adiabatic'|'isothermal'`, `altitude` (−400…8000 m, ISA 기준), `pressure` 100 Pa–120 kPa (`src/atmosphere/types.ts:35-81`). `MASS_FLOOR = 1e-6` (거의 진공).

**주기**: AtmosphereField 바로트로픽 단계 `BARO_DT = 0.5 s`(다중속도), 결합은 0.1 s (`AtmosphereField.ts:57`). `TAU = 30 s` 감쇠, 음향/충격은 해석 안 함.

**원장**: `field.mass: MassLedger`, `field.oxygen: OxygenLedger`, `field.energy`, `field.momentum`, `field.gasLedger` (`AtmosphereField.ts:67-141, 216-220`); 런타임 `rt.o2` (`runtime.ts:129`), `rt.stats` (`AtmosphereStats`, `o2Layer`, `o2Fraction` 포함).

**사람에게 기록되는 것**: `ExposureState.atmosphere`는 **항상** `BASELINE_ATMOSPHERE` 상수이고 `atmosphereMeasured: false` (`src/simulation/response/exposure.ts:24-25, 44`). 대기 실험이 있어도 사람 노출값을 갱신하는 코드 **없음** (writer grep 0건).

---

## 2. 실험이 없을 때의 기본 환경 (가정값)

| 양 | 값 | 출처 | 성격 |
|---|---|---|---|
| 공기 온도 | 288.15 K (15 °C) | `defaultThermalSettings().ambient` (`src/thermal/ThermalWorld.ts:49`); `settings.simulation.thermal?.ambient` (K, `AMBIENT_LIMITS = [213.15, 333.15]`, `src/thermal/units.ts:37`) | 가정 (열 시스템이 돌 때만 기준값 `Tref`로 쓰임) |
| 기압 | 101.325 kPa | `BASELINE_ATMOSPHERE` (`src/phenomena/channels.ts:115`); 기후는 `ClimateWorld.p0 = opts.p0 ?? 101325` Pa (`ClimateWorld.ts:248`) | 가정 |
| O₂ | 0.2095 (부피분율) / 0.232 (질량분율) | `BASELINE_ATMOSPHERE.oxygen`, `Y_O2_AIR` | 가정. **단위 혼재 주의** |
| 공기 밀도 | 1.225 kg/m³ | `AIR_DENSITY` (`src/core/units.ts:8`), `settings.airDensity` → `ctx.env.airDensity` | 설정값(가정) |
| 습도 | **없음** | 기후 실험 없으면 RH/수증기 필드·상수 모두 없음 | — |
| 바람 | 0 m/s | `WindField.baseSpeed = 0`, `fromBearing = 90`, `gustStrength = 0` (`src/simulation/environment/WindField.ts:22-28`); WindEvent가 씀 | 이벤트 입력 |
| 중력 | 9.81 m/s² | `GRAVITY` (`units.ts:9`), `settings.gravity` → `GravityChannel.g0` | 설정값 |
| 고도 | 개념 없음 | 대기 실험의 `altitude`에서만 | — |

- 실험 시작 시 `ThermalSystem.update`가 `ch.settings.ambient`를 대기 datum 온도 또는 기후 `spec.temperature`로 **덮어씀** (`ThermalSystem.ts:51-59`).
- 결론: 위험 이벤트가 없는 런에서는 공기 온도·기압·O₂가 전부 상수 가정이며 공간 필드가 없음. 생리 모델은 이를 "가정"으로 표시해야 함 (기존 UI 관례: `atmosphereMeasured: false`).

---

## 3. Thermal (Phase 26) — `src/thermal/*`, `src/simulation/thermal/runtime.ts`

**휴면**: `ThermalChannel.active = rt !== null || sources.length > 0 || deposits.length > 0` (`ThermalChannel.ts:39-41`). 단 ThermalSystem은 fire/volcano/atmosphere/climate 중 하나만 있어도 `ThermalRuntime`을 생성함 (`ThermalSystem.ts:60-63`).

**공기 온도 필드** `ThermalWorld.air : AirLayer` (`src/thermal/AirLayer.ts`):
- 5 m × 5 m 기둥, 높이 `H = settings.airLayerHeight` (기본 10 m, `DEFAULT_LAYER_HEIGHT`); 기둥 하나 = 잘 섞인 노드 1개 (수직 구조 없음) (`:1-26`).
- `index(x, z, heightAboveGround = 0): number` — 세계 밖 또는 `heightAboveGround > H`이면 −1 (`:77-82`).
- `T(a): number` (K) — `a < 0`이면 `aboveT ?? Tref` (`:84-86`). `aboveT`는 기후 강제 시 배경 온도.
- `rhoAt(a)` (kg/m³), `prAt(a)` (대기 실험 시 압력비, 아니면 1), `updraft(a)` (m/s), `Tpeak` (K).
- 보간 없음 (최근접 기둥). 이류: 균일 평균풍(u10·(H/2/10)^0.14) 상류차분 또는 대기 면속도.
- 점 질의 예: `const tw = ctx.env.thermal.rt?.world; tw.air.T(tw.air.index(x, z, y − ctx.env.terrain.sampleHeight(x, z)))`. 런타임 헬퍼 `ThermalRuntime.airAt(ctx, x, y, z)` (`runtime.ts:200-202`).

**실내(방) 공기**: `ThermalWorld.comps[c]`, `compT(c)` (K) (`ThermalWorld.ts:223-227`); 점→방: `ThermalRuntime.buildingContaining(P: Vec3): { bt, comp } | null` (모듈러 건물만, `runtime.ts:847-870`). 레거시 단일박스 건물은 방 없음.

**지표/접촉 온도**:
- `TerrainThermal` (지형 셀 `cellSize`, 기본 1 m, 4층 0.02/0.06/0.18/0.54 m): `index(x, z)`, `T(c, l = 0)` (K) — l=0은 0.01 m 깊이 노드 (표면 온도 자체는 선형화로 소거됨) (`TerrainThermal.ts:1-22, 160-173`). 10×10 타일 단위 활성; 비활성 셀 = 정확히 `Tref`.
- 물체: `ThermalBodies` `TS[b]`(skin), `TC[b]`(core) (K); 엔티티→바디 `ThermalRuntime.entity(id)?.body` (`runtime.ts:1177`). 인체용 접촉 온도 API **없음**.
- 수온: `ThermalWorld.waterT(c)` (K) (`ThermalWorld.ts:242-246`) — 홍수 필드 + 열 런타임이 둘 다 있을 때만 (`attachWater`, `runtime.ts:547-561`).

**복사**:
- 점에서의 입사 복사 플럭스 필드 **없음**. 표면은 `Tref` 주변환경과 교환 (태양·야간천공 없음, 기후 제외; `radiation.ts:4-6`).
- 기존 사람 노출 계산 `ThermalRuntime.exposure(ctx)` (`runtime.ts:1080-1102`, private): `ctx.env.thermal.sources`만 대상
  - `point`: `radiativeFraction × amplitude(spec) / (4πr²)` — **`amplitude`는 P₀(피크)이며 프로파일 시간형상 미반영**, instant는 0, 차폐 없음.
  - `temperature`: `σ(T_s⁴ − Tref⁴)·sphereViewFactor(R, r)` — 프로파일 미반영.
  - 화염(fire), 용암, 태양, 고온 표면 복사는 **포함 안 됨**.
  - `r`은 `max(0.3, …)`, 사람 높이는 `p[1] + 1`.
- 화염 목록: `FireRuntime.flames : FlameView[]` (`x,y,z,L,D,Q,tx,tz,soot`, `fire/runtime.ts:156-197`) — 렌더러용, 점 복사 질의 없음.

**사람은 열 바디인가?** 아니오. `ThermalRuntime` 생성자에서 `type === 'human'`은 `this.humans`에만 넣고 바디를 만들지 않음 (`runtime.ts:164`; 헤더 주석 `:13` "People get no body"). `humans` 배열은 **ThermalRuntime 생성 시점에 한 번** 채워짐.

**사람 노출 기록** (`ExposureState.thermal`, `exposure.ts:32`): `{ airT (K), radiant (W/m²), peakAirT, peakRadiant }`; 공기 기둥은 `w.air.index(p[0], p[2], 1)` — **높이 1 m 고정**(실제 높이·실내 여부 무시). 0.1 s 주기. 생리/피해 **없음**.

**열이 사람을 해치는가?** 아니오 (health/state/damage 기록 없음).

**원장**: `ThermalWorld.ledger : ThermalLedger` (added, boundarySupply, impactDeposit, combustion, volcanic, airMass, climate, solar, latent, cover, waterMass, lost.*, transfers.*, residual) (`src/thermal/ledger.ts:1-40`). 사람 몫 계정 없음.

단위 헬퍼 (`src/thermal/units.ts`): `SIGMA, ZERO_C=273.15, STANDARD_AMBIENT=288.15, STANDARD_PRESSURE=101325, R_AIR=287.05, CP_AIR=1005, RHO_WATER, C_WATER=4186, BOILING=373.15, toC, toK`.

---

## 4. Fire (Phase 27) — `src/fire/*`, `src/simulation/fire/runtime.ts`

**휴면**: `FireChannel.active = rt !== null || ignitions.length > 0`; `wanted() = ignitions.length > 0 || settings.heatIgnition` (`FireChannel.ts:30-38`). 화산이 있으면 FireRuntime도 생성 (`ThermalSystem.ts:113`).

**연소/열**: 연료 아이템별 상태(`FS`), 질량손실 → `ΔH_c·Δm`을 열 source step으로 반환 (`FireWorld.ts:1-20`). 실외 화염 = 객체별 점원(Heskestad 높이, Thomas 기울기), 복사분 점원 기하, 대류분 공기층 기둥 (`fire/runtime.ts:1-27`).

**연기**: 정량 필드 **있음** (매연 질량만).
- 실외: `FireWorld.soot : Float64Array` 공기층 기둥당 매연 (kg) (`FireWorld.ts:185-187`). 농도 = `soot[a] / (air.H · air.cellArea)` (kg/m³), 5 m 기둥, 층 높이 전체 균일. 이류는 0.1 s마다 `transportOutdoor` (`runtime.ts:1009`).
- 실내: `FireWorld.rooms[r].soot` (kg), `.o2` (kg), `.gas` (kg), `.V` (m³), `.tc` (열 compartment) (`FireWorld.ts:96-98, 248`). `FireRuntime.rooms[i]: RoomInfo { r, bt, story, y0, h, … }`.
- 가시거리 `visibility(Cs)` (m, `src/fire/relations.ts:58-61`).

**O₂ 소모**: 있음. 실외 기둥 결손 `FireWorld.o2def[a]` (kg); `outdoorY(a): number` = O₂ **질량분율**, `a<0`이면 `Y_O2_AIR` (`FireWorld.ts:571-577`). `Y_O2_LIMIT = 0.14`, `E_O2 = 13.1e6 J/kg` (`materials.ts:141-145`). 방은 `R.o2/R.gas`.

**연소 생성물**: CO, CO₂, H₂O, HCN 등 **없음** ("No toxic gas species (soot mass only)", `i18n/locales/en.fire.ts:74`).

**사람 노출 기록** `FireRuntime.exposure` (`runtime.ts:1144-1161`, private): `ExposureState.fire = { smoke (kg/m³), visibility (m), oxygen (질량분율), minVisibility, peakSmoke }`; 실외 기둥 `air.index(p[0], p[2], 1)`만 사용 — **실내에 있는 사람도 실외 기둥 값**을 받음. `e.exposure`가 없으면 건너뜀 (첫 열 스텝에는 thermal exposure가 fire.after 뒤에 생성하므로 1스텝 누락 가능). 피해 **없음**.

**화재가 사람을 해치는가?** 아니오. `e.health` 쓰기는 나무(`trees()`, `runtime.ts:1128-1138`, cause `'fire'`)뿐.

**원장**: `FireWorld.ledger : FireLedger` (fuel, chemical energy, released, `oxygenConsumed`, `smokeProduced`, `smokeAir`, `smokeRooms`, `smokeVented`, unresolved …) (`src/fire/ledger.ts`).

---

## 5. Climate (Phase 30) — `src/climate/*`, `src/simulation/climate/runtime.ts`

**휴면**: `ClimateChannel.active = rt !== null || experiments.length > 0` (`ClimateChannel.ts:25-27`). 1개/런.

**상태** (`ClimateWorld`, `ClimateWorld.ts:132-215`):
- 공기 기둥(AirLayer 5 m와 동일 인덱스): `vap` (kg 수증기), `cond` (kg 응결수). `q(a)` 비습 kg/kg, `p(a)` Pa (대기 실험이 `pressure` 콜백 제공, 아니면 `p0`), `rh(a)` (0–∞, WMO 액체수 기준) (`:316-324, 1794-1796`).
- 기온 자체는 `ThermalWorld.air.T(a)` (기후 강제는 AirLayer를 relaxation/prescribed로 몰아감; 층 위/밖은 `air.aboveT`).
- 셀(지형 셀): 적설/얼음 `cM, cU, cIce, cRho, cAlb, cAsh, cT, cLiq`; `snowDepth(c)` (m), `swe(c)`, `iceThickness(c)`, `coverT(c)` (K), `albedo(c)`; 토양 `sW, sI`.
- 일사: `sun: SunState { elevation, dir, direct, diffuse }` (W/m², 전역 균일), `shade: Uint8Array` 셀별 그림자, `surf.solar[c]` = **맨땅/수면이 흡수한** 단파 (W/m², 알베도 반영), `surf.Tsky` (K) 유효 천공온도. `bodyTrad(top, side, Ta)` 물체 외면의 유효 복사 주변온도 (`:1808-1814`). 사람이 받는 일사는 계산 **안 함**.
- 배경: `ClimateForcing.background(t, p): { T, RH, q, e, Tw, Tsky }` (`forcing.ts:10-19, 45-51`), `precipRate(t)` mm/h (공간 균일), `precipitation(a, b)` kg/m².
- 탐침: `ClimateRuntime.probe(x, z)` → `{ airT, rh, q, dew, p, surfaceT, snowDepth, swe, snowDensity, iceThickness, liquid, albedo, solar, shade, water, soilWater, soilIce, frostDepth, freezeThaw, state, friction, condensate, Tsky }` (`climate/runtime.ts:697-715`, public) — 인스펙터용이며 호출마다 객체 할당.
- 바람체감/열지수/WBGT: **없음** (grep 0건).

**psychro 헬퍼** (`src/climate/psychro.ts`, SI: K, Pa, kg/kg; 범위 밖은 끝값 사용):
- `esWater(T: number): number` (Pa) `:70`; `esIce(T): number` `:83`; `esSurface(T, ice: boolean)` `:96`; `desdT(T, ice)` `:99`
- `specificHumidity(e: number, p: number): number` `:105`; `vapourPressure(q: number, p: number): number` `:111`
- `qSat(T, p, ice = false)` `:117`; `dqSatdT(T, p, ice = false)` `:123`
- `relativeHumidity(q, T, p)` `:131`; `humidityFromRH(RH, T, p)` `:134`
- `dewPoint(e)` `:157`; `dewPointChecked(e)` `:162`; `frostPoint(e)` `:167`; `boilingPointWater(p)` `:174`
- `wetBulb(T: number, q: number, p: number): number` (K) `:185`; `saturationAdjust(T, mv, m, p, C, L = L_V)` `:209`
- 상수 (`constants.ts`): `T_MELT=273.15, L_V=2.501e6, L_F, L_S, EPSILON=0.622, R_VAPOR=461.5, LEWIS=0.85, SOLAR_CONSTANT=1361`.
- 태양 (`solar.ts`): `sunPosition(latDeg, day, hour)`, `irradiance(elevation, cloud)`, `globalHorizontal(s)`, `skyEmissivity(T, e, cloud)`, `skyTemperature(T, e, cloud)`.

**주기**: prepare/after 0.1 s; 표면 단계 `SURFACE_DT = 5 s` (5그룹 분산, `ClimateWorld.ts:123-127`); 객체 패스(사람 포함) 1 s (`climate/runtime.ts:368-372`).

**사람 기록** (`climate/runtime.ts:518-531`, 1 s): `e.climate = { snow (m), ice (m), restricted, airT (K, 1 m 고정 기둥), minAirT, maxAirT, … }`. 피해 **없음**. 강수가 사람을 적시는 모델 **없음** (저장소는 roof/crown/vehicle만, `STORE`).

**원장**: `cw.water : WaterLedger`, `cw.energy : EnergyLedger` (solar, longwave, precip, vaporIn/Out, removed, boundaryOut, toThermal, transfers) (`ClimateWorld.ts:100-121, 199-200`).

---

## 6. Flood / water (Phase 14) — `src/simulation/water/*`

**휴면**: `FloodEnvironment.field === null`까지 (`FloodEnvironment.ts:46-48`); 첫 물 이벤트에서 `activate()`.

**격자** `WaterField` (`WaterField.ts:1-17, 194-215`): 지형 셀당 1 셀 (`cell = terrain.cellSize`, 기본 1 m → 200×200), 셀 중심에 `h` (m 깊이), `bed` (m), `u, v` (m/s, Float32), 면에 `qx, qz` (m²/s). +X 동, +Z 남.

**점 질의** (`ctx.env.flood.field`):
- `sampleSurface(x, z): number` (m 고도) — 젖은 셀만 가중한 쌍선형; 물 없음/밖이면 `-Infinity` (`:477-493`).
- `sampleDepth(x, z): number` (m) = surface − `terrain.sampleHeight`, 음수면 0 (`:495-500`). `FloodEnvironment.depthAt(x, z)` (활성 전 0).
- `sampleVelocity(x, z, out: [number, number])` (m/s, 쌍선형; 밖이면 0) (`:503-515`).
- `sampleCell(x, z): CellSample | null` (`:518-527`).
- 강우: `ctx.env.flood.rainIntensity()` mm/h (전역) (`FloodEnvironment.ts:104-106`).

**엔티티별** `e.flood : FloodEntityState` (`src/simulation/flood/FloodState.ts:13-60`): `depth, surface, flow, speed, submerged (몸 높이 대비 분율), buoyancy, buoyancyRatio, balance, exposure (s), peakDepth, peakSpeed, health, level …`. 동적 바디(사람)는 `WaterForceSystem`(prePhysics, 매 스텝)이 몸 박스 중심 (cx, cz)에서 샘플 (`WaterForceSystem.ts:100-125`).
- Phase 33 `humanSnapshot(e).headSubmerged = head[1] < e.flood.surface` (`src/simulation/human/interface.ts:56-58`) — 기도 침수 판정에 바로 쓸 수 있는 유일한 기존 구현 (호출자 없음).

**주기**: `WATER_SOLVER_INTERVAL = 6` (10 Hz, 자체 CFL 서브스텝) (`WaterSolverSystem.ts:17`); 물체는 매 60 Hz 스텝 읽음.

**수온**: `ThermalWorld.waterT(c)` (K) — 열 런타임이 있을 때만 (`field.heat`는 `attachWater`가 할당). 열 런타임 없으면 수온 **없음**(암묵적으로 `Tref`). 유입수는 `Tref`(기준 0 °C 미만이면 융점)로 들어옴 (`WaterField.ts:143-162`).

**원장**: `field.budget : WaterBudget` (initial, rain, sources, boundaryIn/Out, infiltration, drainage, melt, frozen, evaporated, condensed, current, error) (`WaterField.ts:43-59`).

**물이 사람을 해치는가?** `updatePersonFlood` (`damage/behaviors/flood.ts:285-302`): 안정성 비율 → `balance` 감소 → `knockDown(…, 'flood')`. **health 변경 없음, 익사 모델 없음** (grep `drown` 0건). 레거시 사람: `updateHuman`이 `e.state`에 `floodLevel(e.flood)` 반영; 확장 사람: `HumanSystem`이 `e.state = worst(s, floodLevel(e.flood))` (`HumanSystem.ts:449-450`). 확장 사람에게 `knockDown`은 early return.

---

## 7. Volcano (Phase 28) — `src/volcano/*`, `src/simulation/volcano/*`

**휴면**: `VolcanoChannel.active = rt !== null || eruptions.length > 0`.
- 용암: `VolcanoWorld.field : LavaField`, 지형 **정점** 격자 (`dx = terrain.cellSize`), `index(x, z)`는 `Math.round` 최근접 정점, 밖이면 −1 (`LavaField.ts:196-199`). `depth(i)` (m), `T[i]` 내부/`Ts[i]` 표면 온도 (K), `speed[i]`, `dep[i]` 퇴적 (m), `depT` (`:99-133`). 접근: `ctx.env.volcano.rt.vw.field`.
- 용암 열은 열 source step으로 공기층/지면/물/물체에 들어감 → 공기 온도에는 간접 반영. 점 복사 질의 **없음**.
- 화산재: Lagrangian 퍼프 `VolcanoWorld.puffs: Puff[] { x, y, z, mass, sigma, cls }` (`ash.ts:64-73`), 3개 입경. 점 농도 질의 함수 **없음** (`airborneAsh()`는 총량 kg).
- 화산가스: "ledger quantity only — no transport, concentration, chemistry or toxicity" (`VolcanoWorld.ts:14-15`). 대기 실험이 함께 있을 때만 `AtmosphereField.gas[a]` (kg/기둥, 종 없음)로 주입·이류 (`atmosphere/runtime.ts:387-400`). SO₂/CO₂/H₂S 구분 **없음**.
- 화쇄류/고온 가스류 **없음** (grep `pyroclast` 0건).
- 사람: `VolcanoObjects.respond` (`simulation/volcano/objects.ts:302-330`) — `e.volcano = { lava, deposit, peakLava, contact (s), bombs, … }`; `LAVA_CONTACT` 이벤트(1회, health 변경 없음), 매몰 시 `BURIED` + `e.state = CRITICAL`; 화산탄 충돌은 `humanStruck` (Phase 33 부상 모델, 기계적 충격).

---

## 8. 기존 노출/반응 시스템과 사람 health 쓰기 (이중 계산 방지)

**`ExposureSystem`** (`src/simulation/response/exposure.ts:50-83`): postPhysics, `interval = 6`, 파이프라인 **마지막**. `isActive = wind.baseSpeed > 0.01 || flood.field !== null || groundMotion.active` — 화재/열만 있는 런에선 실행 안 됨. 기록: `wind = e.localWind.speed`, `waterDepth`, `flowSpeed`, `groundAccel` (g), peaks, `time.water/wind/shaking` (s). 주석: "There is no physiology".

`ExposureState` 확장 슬롯: `thermal?` (ThermalRuntime), `fire?` (FireRuntime). 사람의 다른 환경 기록: `e.climate`, `e.volcano`, `e.flood`, `e.seismic`, `e.blast`.

**ResponseRegistry** (`responses.ts`): human 대상 = groundMotion(`updatePersonQuake`), water(`updatePersonFlood`), pressure(`respondBody`) — 모두 넘어짐/안정성. 열·연기·O₂ 반응 **없음**.

**사람의 `e.health` 쓰기 전수**:
- `HumanSystem.ts:447` — 확장 사람: `e.health = max(0, 1 − maxCum/2)` (부상 지수만, 단일 소유자).
- `damage/behaviors/human.ts:66` — 레거시 사람: 바람 피로 `applyFatigue` (확장이면 return).
- `systems/DamageSystem.ts:117-126` — 레거시 사람 충격 `force/20000` (확장은 `humanContact`로 라우팅).
- 열/화재/연기/O₂/용암/물로 사람 health를 깎는 코드 **없음**. `DamageCause`에 `'thermal'`, `'fire'`, `'lava'`는 있으나 구조물/나무용; `DamageEventType`에 BURNED/DROWNED **없음** (`analysis/DamageEvent.ts:5-31`).
- `recordDamage` 훅이 `BURIED` 이벤트 시 `e.human.buried = true` 설정 (`SimulationController.ts:518-522`) — Phase 34용 플래그.

결론: 생리 모델이 열·연기·저산소·익사·저체온으로 health를 처음 다루게 됨. 단 확장 사람의 `e.health`/`e.state`는 `HumanSystem`이 **매 스텝 덮어쓰므로**, 생리 결과를 health에 합치려면 HumanSystem 쪽 합성 규칙이 필요 (현재 단일 소유자 원칙).

---

## 9. Gravity / celestial (Phase 31–32)

- `ctx.env.gravity.at(x, y, z, out: Vec3): Vec3` (m/s²) — 필드가 없으면 `[0, −g0, 0]` (`GravityChannel.ts:66-70`).
- `down(x, y, z, fallback)`, `ratio(x, y, z)` (휴면 시 1), `magnitude(x, y, z, fallback)`, `G` (균일 부분) (`:85-106`).
- 필드는 해석적(격자 없음), `GravitySystem`이 스텝 시작에 `prepare(t)` (`field.ts:13`, `systems/index.ts:38`). HumanSystem은 COM에서 `ctx.env.gravity.at` 사용 (`HumanSystem.ts:255, 306`).

---

## 10. 스텝/타이밍, 파이프라인, 저장 스키마

- `FIXED_DT = 1/60 s` (`src/core/units.ts:10`). 스텝: 스케줄러(이벤트 시작) → `runPhase('prePhysics')` → `physics.step` → `runPhase('postPhysics')` → `time += dt` (`SimulationController.ts:478-539`).
- **phase 이름은 `'prePhysics' | 'postPhysics'` 두 개뿐**. `'post:humans'` 같은 phase 이름 **없음**; 순서 = `createDefaultSystems()` 배열 순서 (`systems/index.ts:35-76`). `interval > 1` 시스템은 `stepIndex % interval === 0`일 때 `dt*interval`.
- postPhysics 순서: GravityLedger → PoseSync → StructuralResponse → SeismicDamage → FloodDamage → Road → Sway → Damage → **HumanSystem** → **ThermalSystem**(6) → StructuralCollapse → Debris → Particle → **ExposureSystem**(6).
- `HumanSystem` (`HumanSystem.ts:260-282`): `name 'humans'`, postPhysics, interval 없음(60 Hz), `reads ['damage','poses','forces']`, `writes ['damage']`, `lagged ['damage']`. `isActive` 없음; `e.human` 있는 엔티티만 처리.
- `StateKey` 유니온 (`SimulationSystem.ts:37-42`): `'airflow'|'groundMotion'|'water'|'forces'|'poses'|'structure'|'damage'|'exposure'|'debris'|'particles'|'metrics'|'terrain'|'temperature'`. 생리 전용 키 **없음** — 추가하려면 유니온 확장 필요. `validatePipeline` (`pipeline.ts:20-35`)이 reads-before-write를 검사하므로 새 시스템은 reads/writes/lagged 선언 필수.
- 새 생리 시스템 위치 후보 (사실관계만): (a) HumanSystem 바로 뒤 = ThermalSystem 앞 → `'temperature'`, `'exposure'`를 `lagged`로 선언해야 함 (이전 0.1 s 열 상태); (b) ThermalSystem 뒤(또는 ExposureSystem 뒤) → 같은 스텝의 열/화재/기후 상태를 읽음, 대신 HumanSystem이 그 결과를 다음 스텝에 봄.
- 저장: `SimulationSettings.humans?: HumanSettings { model: 'extended'; riskScale?: number }` (`src/core/model.ts:201-211`). zod: `humans: z.object({ model: z.literal('extended'), riskScale: z.number().min(0.5).max(2).optional() }).optional().catch(undefined)` (`src/world/serialization.ts:158`), 파싱 후 재구성 `:362`. `schemaVersion` 리터럴 1–7 (`:120`). `thermal`/`fire` 설정도 같은 패턴 (`:146-157`).
- HumanState 생성: `RuntimeBuilder.ts:141` `createHumanState(e.dims[1], o.physics.mass, humans, withSeries)`; 시리즈는 `SERIES_PEOPLE = 32`명, `SERIES_DT = 0.25 s`, `SERIES_MAX = 4000` (`human/state.ts:152-155`).

---

## 11. Phase 33 UI/렌더링 데이터 접근 패턴

- `src/ui/Inspector/HumanInspector.tsx`: `useSimStore((s) => s.time)`로 재렌더 트리거 → `simulationController.getRuntime()?.entities.get(id)` → `e.human` 직접 읽음; `riskIndex(st)` (summary.ts).
- `src/ui/Results/HumanResults.tsx`: `useSimStore((s) => Math.floor(s.time))`, `useSimStore((s) => s.damageEvents.length)`; `simulationController.getRuntime()`; `aggregateHumans`, `humanEntities`, `humanRow`, `humanCsv`, `humanJson` (summary.ts); 시리즈는 `e.human.series`.
- `src/rendering/human/HumanLayer.tsx`: `useSimStore((s) => s.runtimeVersion)`, `useFrame` 안에서 `simulationController.getEnvironment()` / `getTime()` / `getRuntime()`; `humanEntities(...)`; 읽기 전용.
- `src/simulation/human/summary.ts`: 순수 함수 (`hasHumanModel`, `humanEntities`, `riskIndex`, `aggregateHumans`, `humanRow`, `seriesAt`, `humanEvents`, `humanCsv`, `humanJson`), `HUMAN_EXPORT_SCHEMA = 1` (`:13`).
- 기존 노출 표시 예: `FireInspector.tsx:45` `e.exposure?.fire`; Thermal/Climate/Flood 인스펙터도 엔티티 필드를 직접 읽음. 별도 simStore 슬라이스 없이 런타임 객체를 직접 읽는 것이 공통 패턴.

---

