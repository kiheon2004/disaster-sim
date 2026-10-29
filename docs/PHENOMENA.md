# Phase 15 — Universal Phenomenon Engine · 복합재난 통합

> 이 샌드박스는 **과학적 인과관계를 바탕으로 한 근사 시뮬레이션 + 시각적 관찰 도구**입니다. 모든 계산 모델은 "물리 기반 근사 / 경험적 근사 / 실험적·가상 / 시각 효과 전용" 중 하나로 표시되며, **어떤 모델도 측정값으로 검증되지 않았습니다**(`validated: false`). 실제 피해 예측·안전 판단에 사용할 수 없습니다.

## 1. 기존 아키텍처 분석 (Phase 0–14)

| 항목 | 분석 결과 | Phase 15 조치 |
|---|---|---|
| 이벤트 공통점·차이 | 바람·지진·홍수 모두 `SimulationEvent`(start/duration/channel, `onStart/update/onEnd`, 환경에만 쓰기). 파라미터·시드·지속시간 해석은 이벤트마다 다르고, 생성은 하드코딩된 팩토리 맵 | 이벤트는 그대로 두고 `PhenomenonDefinition`이 감싸서 등록. 팩토리는 레지스트리에 위임 |
| 스케줄러 실행 순서 | `EventScheduler.update` → prePhysics 시스템 → Rapier step → postPhysics 시스템. 순서는 배열 순서에 암묵적, 각 시스템이 스스로 유휴 여부 판단 | 시스템마다 reads/writes/lagged 상태 키 선언 + `validatePipeline()` 순서 검증 + `isActive()`로 비활성 현상 건너뛰기 |
| 물리 상태 소유권 | 바람장=`env.wind/windField`, 지반=`env.groundMotion`, 물=`WaterField`(솔버만 기록), 포즈=Rapier → PoseSync, 구조=StructuralModel | 소유권 표(§5)로 명시, 힘은 ForceLedger 단일 경로 |
| Rapier 힘 경로 | 시스템마다 `physics.addForce*` 직접 호출, 출처 기록·중복 방지 없음 | `ForceLedger`(출처별 1회, 오브젝트별 힘 분해 기록) |
| 피해 누적 | 재난별 health를 `min()`으로 합치지만, 바람 피로가 이미 min된 값에서 계속 감소 → 사실상 **합산** | 재난별 자기 채널 누적 + 다른 재난 손상은 잔여 강도(포락선)로만 반영(§7) |
| 지형·물 의존성 | 지형은 실행 중 고정(TerrainSampler 읽기 전용), 물은 지형 바닥고를 1회 복사 | 변경 없음. 지형 변형은 인터페이스만(§3) |
| 분석·타임라인 | 피해 이벤트 + 재난별 기록기(지진·홍수), 타임라인은 한 줄 | 현상별 레인 + 마일스톤 기록기 + 사용 모델 목록 |
| 저장 | v4: 지진·홍수 시나리오, 물 설정. 물 상태는 별도 파일 | v5: 실험 계획(인스턴스·타이밍·시드), 상호작용 설정. 물 상태 분리 유지 |
| 결정론·골든 | 바람 골든 3종(Phase 11), 지진·지형 픽스처 3종(Phase 13 커밋 생성) | 모두 유지 + Phase 14 커밋에서 생성한 홍수·복합 픽스처 5종 추가 |
| 렌더링 최적화 | SimRenderAdapter 배칭·인스턴싱, 레이어별 토글 | 변경 없음. 숨긴 물 레이어는 마운트하지 않음 |

**설계 원칙**: 전체를 다시 쓰지 않습니다. 기존 이벤트·시스템·피해 함수는 그대로 두고, 그 위에 (1) 레지스트리, (2) 선언된 파이프라인, (3) 힘 장부, (4) 응답 레지스트리, (5) 상호작용 모델을 얹었습니다. 상호작용은 프로젝트 설정으로 끌 수 있고, 끄면 Phase 13–14와 비트 단위로 같습니다.

## 2. Phenomenon Engine 구조

| 개념 | 위치 | 역할 |
|---|---|---|
| `PhenomenonDefinition` | `src/phenomena/types.ts`, `definitions.ts` | 현상 유형별 **고유 타입의 파라미터**(zod 스키마), 편집 필드(단위·범위·배율), 기본값, 가정, 효과 채널, 사용 모델, 이벤트 생성, 지속시간, 설명 |
| `PhenomenonInstance` | `types.ts` | 실험 속 한 번의 발생: id, type, spec, enabled, start(절대 시각 또는 다른 현상의 시작/종료 + 간격), seed, visualize |
| `PhenomenonRegistry` | `registry.ts` | 구현 5종(바람·지진·폭우·수위 상승·물 공급원) + 계획 13종(토네이도, 싱크홀, 산사태, 운석, 폭발, 화산, 화재, 극한 온도, 대기 소멸, 중력 변화, 블랙홀, 쓰나미, 폭설) — Phase 24 현재: 구현 10종(+ 지형 변형·싱크홀·산사태·운석·대기 압력파) + 계획 9종; Phase 27 현재: 구현 12종(+ 열원·화재) + 계획 8종; Phase 28 현재: 구현 13종(+ 화산) + 계획 7종; Phase 29 현재: 구현 14종(+ 대기) + 계획 7종(대기 소멸은 산소 분율 변경·저산소로 좁혀 계획 유지); Phase 30 현재: 구현 15종(+ 기후) + 계획 6종(극한 온도는 기후로 대체); Phase 31 현재: 구현 16종(+ 가변 중력) + 계획 5종(중력 변화는 가변 중력으로 대체); Phase 32 현재: 구현 17종(+ 블랙홀·극한 중력원 `celestial`) + 계획 4종(블랙홀은 `celestial`로 대체) |
| Lifecycle | 기존 `SimulationEvent` | onStart → update(고정 스텝) → onEnd(finished / superseded), 채널별 대체 규칙 유지 |
| `PhenomenonContext` | `types.ts` | 시드, 고정 지형, 물 설정(기본값 해석용) |
| Output | 효과 채널(§3) | 현상은 채널만 쓰고, 시스템이 힘·피해·노출로 바꿈 |
| 스케줄 해석 | `schedule.ts` | 상대 시작 해석(깊이 우선), 순환·참조 누락·비활성 참조·잘못된 파라미터·음수 시작을 **실행하지 않고 보고**, 시작 시각·계획 순서로 안정 정렬 |
| 실험 비교 | `experiment.ts` | 같은 초기 월드에서 시나리오별 헤드리스 실행 |

모든 현상에 같은 파라미터 구조를 강요하지 않습니다: 지진은 규모·PGA·주파수·깊이, 폭우는 mm/h·시간, 블랙홀은 질량·연화 길이·포획 반경(Phase 32). 레지스트리 경계에서만 타입을 지웁니다(`AnyPhenomenonDefinition`).

**새 현상 추가 절차**: ① 스펙 타입 + zod 스키마 ② `SimulationEvent`(채널만 쓰기) ③ `PhenomenonDefinition` 등록 ④ 새 채널이면 필드 + 시스템 + 응답 핸들러 ⑤ 모델 카탈로그 항목 ⑥ i18n. UI(실험 탭 편집기)·저장·명령 인식·비교는 정의만으로 자동 지원됩니다.

## 3. Shared Physical Effect Channels

| 채널 | 상태 | 물리량 | 소유 | 쓰는 쪽 → 읽는 쪽 |
|---|---|---|---|---|
| Mechanical Force / Impulse | **작동** | N, N·s | Rapier (ForceLedger 경유) | windForce·groundMotion·waterForce → Rapier |
| Airflow | **작동** | 풍속 m/s | `env.wind`, `env.windField` | WindEvent → 바람 힘·피해·물 표면 응력·렌더 |
| Ground Motion | **작동** | 변위·속도·가속도 | `env.groundMotion` | EarthquakeEvent → 관성력·구조 응답·물 관성·렌더 |
| Water Depth / Flow | **작동** | 수심·수면·유속 | `env.flood.field` (솔버만 기록) | 물 이벤트(강제) → 솔버 → 부력·마찰·피해·노출·렌더 |
| Gravity Field | **작동(Phase 31)** | g(x, t) m/s² (벡터), 퍼텐셜 J/kg | `env.gravity` (GravityChannel → GravityField; 실험 없으면 휴면 = 프로젝트 상수) | GravityEvent·CelestialEvent(Phase 32: 점질량원을 같은 장에 더함) → Rapier 균일 중력·국소장 힘(ForceLedger `gravityField`)·KDK 자유 비행 교체·포획·구조 하중 비율·층 수평 하중·들림·물·대기·열·화재·기후·화산·운석·지반·입자 — [VARIABLE_GRAVITY.md](VARIABLE_GRAVITY.md), [EXTREME_CELESTIAL.md](EXTREME_CELESTIAL.md) |
| Pressure | 인터페이스만 | 과압 Pa | — | 구현 시스템 없음 |
| Temperature / Heat Flux | **작동(Phase 26)** | K(표시 °C), W, W/m², J | `env.thermal` (ThermalWorld: 지면 기둥·물 열·공기층·구획·노드·장부) | HeatSourceEvent·운석 열 몫 → 열 시스템 → 구조 계수·열하중·노출·렌더 — [THERMAL_PHYSICS.md](THERMAL_PHYSICS.md) |
| Terrain Deformation | 인터페이스만 | 표고 변화 m | TerrainData(실행 중 고정) | `TerrainDeformationRequest` 계약만 |
| Atmospheric State | **구현(Phase 29)** — 대기 실험 중 `env.atmosphere`(기둥 질량·기압·밀도·기류·O₂) | Pa, kg/m³, m/s, kg | AtmosphereEvent, 화산(가스) | 열·화재·바람 힘·물·화산·폭발/운석(옵트인)·인스펙터; 실험이 없으면 `BASELINE_ATMOSPHERE` 상수 |

산소 농도·온도처럼 힘으로 환원할 수 없는 효과가 있으므로 하나의 힘 벡터로 합치지 않았습니다. 인터페이스만 있는 채널은 UI에 "인터페이스만 (미구현)"으로 표시되며, 실행되는 기능처럼 보이지 않습니다.

## 4. Scheduler 변경

- **시간축**: 모든 현상이 같은 고정 스텝(60 Hz) 시계를 공유. 시작·종료는 스케줄러가 시뮬레이션 시간으로 판정 → 재생 속도·일시정지와 무관하게 순서 동일.
- **명시적 실행 순서** (pre: `windForce → groundMotion → waterSolver(10 Hz) → waterForce → groundContact` · Rapier · post: `poseSync → structural → seismicDamage → floodDamage → sway → damage → debris → particles → exposure(10 Hz) → metrics`). 각 시스템은 읽고/쓰는 상태 키를 선언하고 `validatePipeline()`이 "뒤에서 쓰는 값을 앞에서 읽으면 `lagged`로 선언해야 함"을 검사합니다(개발 모드 경고 + 테스트).
- **의존성**: 인스턴스 간(시작/종료 + 간격) 해석은 결정론적. 순환·누락은 실행하지 않음.
- **비활성 현상 비용 0**: `isActive()`가 거짓이면 시스템을 호출하지 않음. 무풍일 때 바람장 샘플링(이전에는 지진·홍수 단독 실행에서도 매 스텝 모든 오브젝트를 샘플링)도 건너뜀 — 결과는 동일(무풍 샘플은 정확히 0).
- **중복 물리 방지**: ForceLedger가 (물체, 출처, 스텝)당 1회만 적용하고 나머지는 거부·계수. 테스트: 바람+지진+홍수 동시 실행에서 거부 0건, 같은 출처 2회 호출 시 1회만 적용.
- **10 Hz 물 ↔ 60 Hz 바람·지진 정책**:
  - 물 → 오브젝트: 솔버 결과를 다음 호출까지 **유지(zero-order hold)**, 오브젝트는 매 스텝 그 상태를 읽음.
  - 바람 → 물: 솔버 호출 시점의 바람으로 표면 응력 계산(바람은 수 초 단위로 변해 10 Hz로 충분).
  - 지진 → 물: 지반 가속도(1–10 Hz)를 10 Hz로 샘플링하면 에일리어싱이 생기므로 **호출 구간의 지반 속도 변화량 Δv_g(충격량)** 으로 적분 — 순운동량은 정확, 5 Hz 이상의 빠른 출렁임은 걸러짐(근사로 명시).
  - 솔버 내부는 CFL 적응 서브스텝(Phase 14).

## 5. Shared World State · 소유권

| 상태 | 소유자(쓰기) | 다른 시스템의 접근 |
|---|---|---|
| Terrain | 없음(실행 중 고정) | TerrainSampler 읽기 전용 |
| Water | WaterSolver | 읽기 전용; 장애물 제거는 `FloodEnvironment.removeObstacle()` API |
| Object Transform / Velocity | Rapier → PoseSync가 `e.pose`로 복사 | 읽기; 힘은 ForceLedger로만 |
| Structural State | StructuralResponseSystem(StructuralModel SoA) | 외력은 `fwx/fwz`, 강도 축소는 `scaleStrength()` API |
| Member / Collapse State (Phase 25) | StructuralCollapseSystem(건물별 `CollapseModel`, 설계당 공유 구조 그래프) | 해저드는 부재 손상·파괴·지반 지지·추가 하중을 API(`fail`·`setDamage`·`setGround`·`addLoad`)로만 넣음, 잔해 질량은 `StructuralModel.addMass` — [STRUCTURAL_DESTRUCTION.md](STRUCTURAL_DESTRUCTION.md) |
| Rubble / Fragments (Phase 25) | StructuresRuntime(잔해장·파편) | 도로 차단·매몰·2차 피해는 읽기, 질량은 건물별 장부 |
| Surface Contact | GroundContactSystem(`setFriction`) | — |
| Damage | 재난별 채널: 바람(`integrity.windHealth`), 지진(`seismic`), 홍수(`flood`) → DamageSystem이 `min()`/`worst()`로 공통 상태 | 다른 재난 채널은 읽기만(잔여 강도) |
| Exposure | ExposureSystem | 읽기 전용 |
| Environmental Fields | 각 현상의 이벤트 | 읽기 전용 |

Rapier·지형 데이터는 복제하지 않습니다(힘 기록은 오브젝트당 Float64Array 8칸).

## 6. 복합재난 상호작용 (물리적 근거가 있는 것만)

설정 **"재난 상호작용"**: 새 프로젝트 기본 ON, v5 이전 파일은 OFF(이전 결과 재현). OFF = Phase 13–14와 비트 단위 동일(테스트).

| 조합 | 구현 | 모델 수준 / 근거 |
|---|---|---|
| 바람 + 홍수 | 수면 바람 응력 τ = ρ_air·C_d·U², C_d = (0.8 + 0.065·U)·10⁻³ (Wu 1982), 5 cm 이상 물에만 → 풍하측 수위 상승(wind setup) | 경험적 · 파랑·국부 차폐 없음 |
| 바람 + 홍수 | 물에 잠긴 물체: 바람은 **수면 위 부분 면적**에만, 잠긴 부분은 수항력 → 이중 적용 없음 | 물리 기반 근사 |
| 바람 + 홍수 | 침수 시 접지력: 부력에 의한 수직력 감소 + 젖은 지면(Phase 14) | 물리 기반 근사 |
| 지진 + 홍수 | 지반 좌표계에서 물에 −a_g 관성력(Δv_g 충격량) → 정지한 물이 출렁임 | 물리 기반 근사 · 10 Hz 저역 통과 |
| 지진 + 홍수 | 지진 손상 건물의 홍수 횡하중 용량 × 잔여 강도, 깨진 창으로 빠른 실내 침수(Phase 14 경로) | 경험적 |
| 지진 + 홍수 | 포화·침수 지반의 지지력 최대 50 % 감소(지하수위 보정, Terzaghi/Meyerhof) → 기초 기울어짐 | 경험적 · **액상화 아님** |
| 바람 + 지진 | 지진 중 평균 풍하중을 구조 모델 최상층에 준정적 외력(모멘트 등가, 시작 2초 램프) → 바람 + 지진 복합 층간변위 | 물리 기반 근사 |
| 바람 + 지진 | 지진 손상 → 바람 용량 감소, 바람 피로 손상 → 지진 시작 시 항복강도 축소 | 경험적(§7) |

검증 결과(테스트): 서풍 40 m/s, 닫힌 1 m 호수 → 60초 후 동·서 수위차 0.5–50 cm 범위(ON) / 0(OFF). M7 · 0.5 g → 정지 수면 최대 유속 > 1 cm/s(ON) / 0(OFF). 바람 38 m/s + 지진 0.45 g → 모든 건물 최대 층간변위 증가(예: 1.14 → 1.22 %, 1.25 → 1.61 %).

**구현하지 않은 것**: 액상화, 지진에 의한 물 공급(관 파열), 파랑·해일, 파편에 의한 물길 막힘 — 근사 모델이 준비되지 않아 후속 Phase로 남겼습니다. (화재·온도 결합은 Phase 26–27에서 구현: 비·물의 소화·냉각, 붕괴에 따른 개구부·잔해 연소, 바람에 의한 화염 기울기·연기 이류.)

## 7. 통합 피해 상태

- **재난별 자기 측정 단위 유지**: 바람 = 설계 하중 대비 피로(1 − 잔여 수명), 지진 = Park–Ang식 손상 지수, 홍수 = 횡하중 손상 지수.
- **잔여 강도**: 한 재난이 하중과 비교하는 용량에 다른 재난들의 손상을 반영 — 구조 모델 자신의 강도 저하식과 같은 `F_y·(1 − 0.3·D)`, D = **다른 재난 손상의 최댓값**(포락선, 합산 아님).
- **중복 계산 방지**: 상호작용 ON이면 바람 피로가 자기 채널(`windHealth`)에서만 누적 — 이전에는 지진 손상이 들어간 공통 health에서 계속 깎여 숨은 합산이 됐습니다. 부품(창·외장재)은 상태가 바뀌면 다른 재난이 다시 파손 기록하지 않음(테스트), 붕괴는 1회.
- **원인별 기록·순서 보존**: 모든 피해 이벤트에 hazard, 오브젝트별 상태 변화 이력(시각·재난·상태, 시간순), 실험 마일스톤.
- 공통 상태는 여전히 `min(채널 health)`와 `worst(채널 state)`.
- **Phase 25 부재 단위**: 모듈형 건물은 해저드별 손상이 부재 손상 지수(포락선)로 들어가고, 부재의 중력 용량은 같은 법칙 `F·(1 − 0.3·D)`(`structure/policy.ts` 공유). 파괴는 붕괴 엔진(재분배·낙하·잔해)을 거치며 직접 원인 + 주 해저드(연쇄 뿌리) + 2차 피해(타격 파편·출처)로 귀속 — [STRUCTURAL_DESTRUCTION.md](STRUCTURAL_DESTRUCTION.md) §23.

## 8. Object Response Framework

`채널 × 오브젝트 범주(human · vehicle · building · tree · infrastructure · debris) → 응답 핸들러(motion · stability · structural · exposure · transition)` 레지스트리(`src/simulation/response/`). 타입별 핸들러가 범주보다 우선(예: 도로 ≠ 가로등).

- 지진·홍수 피해는 레지스트리로 디스패치(이전 switch와 같은 순서·같은 호출 → 결과 동일).
- 힘 기반 응답(바람·지반·물 → 움직임·안정성)은 ForceLedger 경로로 매트릭스에 등록.
- 바람 피해(DamageSystem)는 Phase 3–11 코드 그대로 — 이전 경로로 명시(향후 동일 방식으로 이관).
- **환경 노출 상태(사람)**: 측정값(바람, 수심·유속, 지반 가속도, 최댓값, 노출 시간) + 대기(기압 101.325 kPa · O₂ 20.95 % · 15 °C)는 **표준 대기 기준 상수**로 표시. 생리 반응·부상·생존은 계산하지 않음. 기압·산소·온도 채널이 생기면 같은 상태에 실측값이 들어갑니다.

## 9. Scientific Model Classification

`src/phenomena/models.ts`의 16개 모델마다: 수준(물리 기반 근사 / 경험적 근사 / 실험적·가상 / 시각 효과 전용), 가정, 단위, 유효 범위, 한계, 문서 위치, 검증 여부(모두 미검증). UI: 실험 탭 현상 편집기의 모델 배지(클릭 시 상세), 결과 패널 "이번 실행에 사용된 모델"(상호작용 ON이면 상호작용 모델 포함), JSON 내보내기에 모델 메타데이터 포함.

## 10. UI · 자연어 명령

**실험 탭**(KO/EN): 현상 목록(활성화, 시작–종료 시각, 시각화 켜기/끄기, 삭제), 편집기(정의에서 생성된 파라미터 필드·단위·자동값, 시드, 시작 기준: 절대 시각 / 다른 현상 시작 후 / 종료 후 + 간격, 가정, 효과 채널, 모델 배지), 추가 메뉴(계획 현상은 "준비 중" + 필요한 시스템), 재난 상호작용 스위치, 실험 실행 / 지금 적용, 스케줄 문제 표시. 기존 바람·지진·홍수 탭의 상세 설정은 그대로이며 **"실험에 추가"** 버튼으로 현재 설정을 넣을 수 있습니다. 실행 중인 현상 목록은 타임라인 레인과 HUD에 표시됩니다.

**명령어**: "태풍을 발생시키고 10초 후 지진을 발생시켜", "시간당 100mm의 비와 초속 30m의 바람을 동시에 발생시켜", "Start an earthquake 10 seconds after the typhoon begins"(같은 명령 안 → 예약된 이벤트 순으로 기준을 찾고, 없으면 지금 + 10초로 실행하고 경고), "Run heavy rainfall and strong wind simultaneously". 실행 전 검증: 현상 유형(레지스트리), 파라미터·단위(각 스키마), 시작·지속시간, 지원 여부. 싱크홀·운석·블랙홀·토네이도·중력·산소 등은 "미구현 현상 · 필요한 시스템: …"으로 표시만 하고 **실행하지 않습니다**(Phase 32 현재 블랙홀은 구현됨 — 텍스트는 실험 편집기로 안내).

## 11. Experiment Timeline · Comparison

- **타임라인**: 현상 유형별 레인, 마일스톤 표시(재난별 첫 피해, 건물 붕괴, 첫 넘어짐, 첫 차량 부유, 침수 면적 0.1/1/5 ha 돌파). 결과 패널 "실험 경과"에 시간순 목록. 모두 시뮬레이션 시간 기준.
- **비교**: 각 현상 단독 + 모두 함께, 같은 문서·시드·초기 물 상태, 헤드리스 컨트롤러(UI 상태 불변), 1초 단위로 양보·취소 가능. 지표: 피해 오브젝트, 붕괴 건물, 이동한 오브젝트(1 m 이상), 최대 침수 면적, 피해 이벤트(재난별), 시뮬레이션 시간, 계산 비용(ms/시뮬레이션 초). CSV/JSON. 같은 입력이면 같은 결과(테스트·브라우저 KO/EN에서 동일 수치).

## 12. 저장 형식 v5

- `scenario.experiment`: 인스턴스(파라미터, 타이밍, 시드, 활성화, 시각화), 메모, 비교 시간. 인스턴스마다 정의의 스키마로 검증 — 계획 현상·잘못된 값은 제외(파일은 로드됨).
- `settings.simulation.interactions.enabled`.
- 자동 마이그레이션 v1–v4 → 빈 실험, 상호작용 OFF. 물 상태(`*.water.json`)는 계속 별도 파일 — 프로젝트 설정 저장과 실행 중 스냅샷을 구분.

## 13. 기존 기능 회귀

| 검증 | 결과 |
|---|---|
| 바람 골든 3종 (Phase 11, 상호작용 ON 기본값) | 비트 일치 |
| 지진·지형 픽스처 3종 (Phase 13 커밋 생성) | 단독 2종 ON에서 비트 일치, 해안 바람+지진은 OFF에서 비트 일치 — ON에서는 **의도적으로 다름**(바람 하중이 구조 모델에 들어가고 잔여 강도 반영: 114 → 125 이벤트), 원인 검증 테스트 포함 |
| 홍수 단독·바람+지진·바람+홍수·지진+홍수·셋 모두 (Phase 14 커밋 생성) | OFF에서 5종 모두 비트 일치, 홍수 단독은 ON에서도 일치 |
| 결정론 | 같은 조건 2회 실행 동일(바람·지진·홍수 단독, 복합, 비교 실행) |

골든 데이터는 갱신하지 않았습니다.

## 14. 테스트

`npx vitest run`: **220 통과, 2 건너뜀**(`BENCH=1` 전용). Phase 14 대비 +29개:

- Phenomenon Registration(구현·계획, 중복 등록 거부, 모델 미검증 표시), Parameter / Unit Validation(스키마 범위, 분 ↔ 초 배율), Event Scheduling(절대·상대 시작, 시작/종료 기준, 순환·누락·비활성 참조·잘못된 파라미터·음수 시작 보고, 인스턴스 시드), Deterministic Execution Order(파이프라인 순서·검증기가 잘못된 순서 검출), Multiple Active Phenomena + Lifecycle(지진·바람·폭우 동시 활성, 시작/종료 마일스톤 순서), Shared World State(비활성 시스템 0회 호출, 10 Hz 물 솔버), No Duplicate Force Application(장부 단위 테스트 + 세 재난 동시 실행 거부 0건, 채널별 힘 기록), Combined Damage(잔여 강도 포락선, 바람+지진 층간변위 증가와 별도 바람 피로 채널, 부품 중복 파손 없음, 피해 이력 순서), 바람 + 홍수 수면 응력, 지진 + 홍수 출렁임, 응답 레지스트리, 실험 비교(결정론, UI 상태 불변), Save / Load v5 + v1/v3/v4 마이그레이션 — `src/phenomena/phenomena.test.ts`
- Natural Language Commands(요구 예문 4개, 같은 명령 안의 종료 기준, 미구현 현상 6종 미실행) — `src/commands/multiParser.test.ts`
- Existing Wind / Earthquake / Flood Regression, Combined Hazard Determinism — `golden.test.ts`, `regression.test.ts`, `regressionMulti.test.ts`

기존 테스트는 모두 유지했습니다(스키마 버전·시나리오 필드 기대값 2건만 v5로 갱신).

## 15. TypeScript · Build

`tsc -b --noEmit` 통과, `npm run build` 통과(청크 크기 경고는 기존과 동일).

## 16. 브라우저 검증

`node scripts/verify-phenomena.mjs http://localhost:4173/ ./shots` (KO, `LANG_UI=en`으로 EN), 실제 Chrome(Metal), 샘플 도시:

- 실험 탭: p1 태풍 42 m/s(0초), p2 지진 M6.8 · 0.4 g(p1 시작 10초 후), p3 폭우 120 mm/h(실제 "현상 추가" 메뉴 클릭, p1 시작 20초 후) → 편집기(파라미터·시작 기준·가정·채널·모델 배지) → "실험 실행".
- t = 12 s: 바람·지진 활성, t = 31 s: 바람·폭우 활성(지진 종료) — 타임라인 레인·마일스톤, 중복 힘 0건.
- 인스펙터: 건물(지진 응답 + 채널별 힘·재난별 손상·이력), 사람(환경 노출, 대기 = 기준 상수).
- 결과 패널: 실험 경과(0초 태풍 시작 → 2초 첫 피해(바람) → 10초 지진 시작 → 10.8초 첫 피해(지진) → 20초 폭우 시작 → 25초 지진 종료), 사용 모델 배지·상세.
- 비교(시나리오당 25초): 태풍 단독 피해 54 · 이벤트 257, 지진 단독 23 · 56, 폭우 단독 0 · 0, 모두 함께 54 · 383(바람 261 / 지진 122) — KO·EN 실행에서 같은 수치.
- 명령: "태풍을 발생시키고 10초 후 지진을 발생시켜" 미리보기 "… — 10초 후 · 지진 …", "블랙홀을 지도 중앙에 만들어줘" → "미구현 현상: 블랙홀 · 필요한 시스템: 공간 중력장, 조석력 계산"(실행 안 됨).
- 콘솔 오류 0건(KO·EN).

## 17. 성능

### 시뮬레이션 CPU (Node, `BENCH=1 BENCH_HAZARD=… npx vitest run src/bench`, ms/스텝)

Phase 14 커밋(3656f79)과 교대 4회, 최솟값(측정 중 load average 4–6):

| | 100 | 500 | 1000 |
|---|---|---|---|
| 바람 Phase 14 / 15 | 1.35 / 1.26 | 4.08 / 4.00 | 6.83 / 7.36 |
| 지진 Phase 14 / 15 | 0.39 / 0.39 | 1.56 / 1.52 | 3.22 / 3.16 |
| 홍수 Phase 14 / 15 | 1.47 / 1.49 | 2.32 / 2.24 | 3.69 / 3.43 |
| Dispatch 오버헤드(스텝 − 물리 − 시스템 합) Phase 15 | 0.02 | 0.03 | 0.06 |

- 지진·홍수 단독: 같거나 빠름(무풍 바람 샘플링 생략).
- 바람 단독 1000개: 시스템별로 보면 Rapier(코드 변경 없음)를 포함해 모든 시스템이 4–5 %씩 고르게 늘어(예: 물리 2.15 → 2.25, 바람 1.74 → 1.81, 피해 1.95 → 2.11 ms) 새 계산이 아니라 엔티티 객체가 커진 데 따른 메모리·캐시 효과로 판단됩니다. 장부가 원인이던 12 % 증가는 객체 형태 고정으로 제거했습니다(장부 유무 A/B: 1.84 / 1.84 ms).
- 세 재난 동시(상호작용 ON): 3.14 / 7.14 / 13.53 ms — 바람 2.46, 지반 0.91, 구조 0.41, 지진 피해 0.97, 물 1.16, 물 힘 0.80, 홍수 피해 0.43, 피해 2.42, Rapier 2.77, 노출 0.02, dispatch 0.12 ms (1000개), GC 0.054 ms/스텝.

### 브라우저 (production build, 1600×900, `HAZARD=… node scripts/bench-browser.mjs …`)

| 장면 | FPS | 시뮬레이션 속도 | draw call | 삼각형 | GPU ms | JS 힙 MB | GC ms/s |
|---|---|---|---|---|---|---|---|
| 바람 100 / 500 / 1000 | 59.5 / 58.7 / 60 | 1.0 | 23 / 22 / 22 | 110k / 232k / 367k | 2.3 / 3.6 / 5.1 | 49 / 86 / 54 | 9 / 50 / 26 |
| 세 재난 100 / 500 / 1000 | 60 / 60 / 36.4 | 1.0 / 1.0 / 0.61 | 34 | 214k / 340k / 480k | 3.1 / 3.6 / 4.3 | 49 / 85 / 99 | 20 / 65 / 67 |
| 세 재난, Phase 14 빌드 500 / 1000 | 60 / 32.3 | 1.0 / 0.54 | 33 | | | | |

- 바람 단독 draw call·삼각형은 Phase 12–14와 같음(23/22) — SimRenderAdapter 배칭·인스턴싱 유지.
- 세 재난 동시 1000개는 Phase 14와 같은 수준(물리·바람 부하로 프레임 예산 초과 → 시뮬레이션이 느려짐). 수면 메시 갱신 1.6–2.6 ms × 6–10회/s. 시각화를 끈 물 레이어는 마운트하지 않아 비용 0.
- 측정 중 load average 4–6: FPS·ms는 잡음이 큼. draw call·삼각형은 결정적.

## 18. 알려진 제한사항

- 상호작용 모델은 근사이며 미검증. 바람 응력은 평균 응력만(파랑 없음), 지진 → 물은 지도 중앙 기준 균일 가속도·10 Hz 저역 통과, 지지력 감소는 액상화가 아님.
- 바람 + 지진 결합 하중은 지진 중에만 구조 모델에 들어감(평시 바람 처짐은 피로 모델로만), 시작 시 2초 램프.
- 잔여 강도는 지진 시작 시점의 손상으로 항복강도를 한 번 축소(지진 중 생긴 바람 손상은 health `min()`으로만 반영).
- 바람 피해 응답은 아직 응답 레지스트리가 아닌 기존 DamageSystem 경로.
- 비교 실행은 메인 스레드에서 양보하며 실행(Web Worker 아님) — 큰 장면은 시나리오당 수 초~수십 초.
- 구조 파괴(Phase 25)는 축약된 부재·하중 경로 모델(FEA 아님) — 레거시 건물은 부재 모델이 없어 파편 타격 미평가, 잔해 더미는 물 격자 장애물이 아님 — STRUCTURAL_DESTRUCTION.md §37.
- 인터페이스만 있던 채널(온도·대기·공간 중력)은 이후 Phase에서 구현됨: 온도(26), 대기(29), 중력장(31 — [VARIABLE_GRAVITY.md](VARIABLE_GRAVITY.md)). 압력 채널은 Phase 24에서 구현(BLAST.md). 지형 변형(Phase 21)과 지반 지지·토사(Phase 22) 채널은 구현됨 — TERRAIN_DEFORMATION.md, GROUND_FAILURE.md.

## 19. Phase 16 이후 확장 (필요 시스템 vs 재사용)

| 현상 | 새로 필요한 시스템 | 재사용 가능한 시스템 |
|---|---|---|
| Sinkhole | **구현됨(Phase 22)** — 실행 중 지형 변형은 Phase 21 엔진, 공동·플러그 파괴·벽 붕괴 모델, 산사태(무한사면·Newmark·Voellmy 흐름)와 함께 [GROUND_FAILURE.md](GROUND_FAILURE.md) | — |
| Meteor Impact | **구현됨(Phase 23)** — 대기 진입·크레이터 스케일링·분출물·지반 충격(지반 운동장 중첩)·`impact` 해저드, [IMPACT.md](IMPACT.md). 대기 압력파는 Phase 24(공중 폭발·대기 결합 몫 → 압력 채널). 남은 것: 열 | — |
| Explosion | **대기 압력파 구현됨(Phase 24)** — 가상 에너지 방출, Sedov–Taylor + 약충격 N파, 지면 반사·차폐, 압력 채널(`pressure` active), ForceLedger `blast`, 구조 외부 횡하중·외장 SDOF·외벽 면외·사람 전도 기준, `blast` 해저드, [BLAST.md](BLAST.md). 남은 것: 열·연소(Phase 26–27) | — |
| Structural Destruction (교차 해저드) | **구현됨(Phase 25)** — 구조 그래프·증분 하중 재분배·접합부·연쇄/부분 붕괴·낙하 블록 충돌·잔해(질량 장부)·2차 피해·기초 지지 상실, 모든 해저드 공통, [STRUCTURAL_DESTRUCTION.md](STRUCTURAL_DESTRUCTION.md). 남은 것: 부재 온도·열팽창·온도 의존 강도(Phase 26 — `setMaterialFactor` 확장 지점) | 해저드별 손상 모델, Phase 17 해석·층 모델, Rapier, ForceLedger |
| Heat / Thermal (교차) | **구현됨(Phase 26)** — 열원 5종(점·원판·표면·체적·지정 온도), 전도·대류·복사, 물 열 운반, 공기층, 부재 온도 → EN 강도·열팽창 → 구조 엔진, 잔해 열, 운석 열 몫, `thermal` 해저드, [THERMAL_PHYSICS.md](THERMAL_PHYSICS.md). 연소·화재 확산은 Phase 27(구현됨). 극한 기후·결빙은 Phase 30에서 구현 | 구조 파괴 엔진(`setMaterialFactor`·`addLoad`), 물 솔버 유량, 바람장, 실험·장부 패턴 |
| Fire | **구현됨(Phase 27)** — 연료 항목(목조 부재·수관·줄기·실내 가연물·잔해), 열유속-시간 착화, 연소율·화학에너지 장부(= 열 장부 연소 계정), 방 화재(개구부·Rockett 환기·산소 한계·외부 화염·플래시오버), 연기·가시거리, 화염 복사·기울기 확산, 탄화 단면 → 구조 엔진, `fire` 해저드·원인, [FIRE_COMBUSTION.md](FIRE_COMBUSTION.md). 남은 것: 불티 착화·지표 연료·2구역·화학종 | **열물리 엔진(Phase 26)**: 노드 온도·질량·재료, 구획 노드, 점원 복사 기하, 물 열 추적자, 구조 계수 경로 |
| Volcano | **구현됨(Phase 28)** — 분출원(중앙·균열·여러 분출구, 시간 프로파일), Bingham 용암 흐름(GRD 점성·결정·항복강도), Phase 26 엔탈피(잠열)로 냉각·고화, 축약 크러스트, 고화 퇴적 → Phase 21 지형 경로, 화산탄(Phase 23 비행), 화산재(별도 물질·바람·침강·지붕 하중), 물·화재·식생·건물·도로·차량 연동, `volcano` 해저드·원인 `lava`/`ashLoad`, [VOLCANO.md](VOLCANO.md). 남은 것: 저장소·폭발 역학, 끓음·증기, 가스 화학, 플룸 역학(Phase 29) | **열물리(26)**: 엔탈피 표·원천 단계·공기층·물 열, **화재(27)**: `incidentProviders`(파일럿)·착화 규칙, **지형 변형(21)**: 원천 계약, **운석(23)**: `fly()`, **구조(25)**: `addLoad`·재료 계수 |
| Atmosphere | **구현됨(Phase 29)** — 기둥 질량·정수압·상태방정식, 반암시적 기류·근지면 수렴, 대기 제거(일정·누출·예약·처방 기압, 균일·국소)·복원(저장소·경계), 단열/등온, 국소 밀도의 공기역학·대류·연소 산소·연기/가스/화산재 수송, 물·지형, 폭발·운석 옵트인, [ATMOSPHERE.md](ATMOSPHERE.md). 남은 것: 산소 분율 변경·생리(계획 `atmosphereLoss`, Phase 34), 습도·상변화는 Phase 30에서 구현 | **열물리(26)**: 공기층(온도 소유)·대류·장부, **화재(27)**: O₂·그을음, **화산(28)**: 가스·화산재, **바람(15)**: 처방 배경, **폭발(24)**·**운석(23)**: 기준 상태 입력 |
| Climate / Snow / Ice | **구현됨(Phase 30)** — 배경 공기 강제(폭염·한파, 경계층 교환 또는 처방), 습도(수증기 질량)·포화·응결·증발·끓음, 강설·적설·압밀·융설, 결빙·해빙(물·토양), 도로·호수 얼음, 태양·하늘 장파, 지붕 하중·수관 파손·마찰·화재 함수율·용암/화산재 연동, `climate` 해저드, [EXTREME_CLIMATE.md](EXTREME_CLIMATE.md). 남은 것: 구름·강수 미세물리, 다층 적설, 빙하·얼음 파괴, 생리(Phase 34) | **열물리(26)**: 온도·엔탈피·지면 스텝·장부, **홍수(14)**: 액체·침투, **화재(27)**: 수관 물, **대기(29)**: 기압·기류·제거, **화산(28)**: 열·화산재, **구조(25)**: `addLoad` |
| Gravity (가변 중력) | **구현됨(Phase 31)** — 전역 중력 대체(크기·방향·전이·시간 프로파일·종료 방식) + 국소 영역·방사형 중력원(정규 순서 합성), Rapier 균일 중력 + 국소장 차이 힘, 깨우기·접촉 임계값, 구조 부재 중력 비율(자중·적설·잔해 × g/g₀), 지붕 패널 용량(R1)·지붕 눈 묶음(R2), 물(하향 성분·기울어진 기준면·Froude 상사)·대기(σ 보존)·대류·화재·기후·화산·운석·지반 스케일링, 지원 범위 판정, 에너지·운동량 장부, `gravity` 해저드·원인 `gravityLoad`, [VARIABLE_GRAVITY.md](VARIABLE_GRAVITY.md). 남은 것: 일반상대론·조석 파괴(Phase 32), 무중력 3D 유체, 구조의 수평·상향 하중 경로 | **Rapier**, **ForceLedger**(`gravityField`), **구조(25)**: 하중 경로·파괴 엔진, **홍수(14)**: 관성 하중 항, **대기(29)**: 기둥 질량, **열(26)·화재(27)·화산(28)·기후(30)**: 단계 범위 비율 |
| Black Hole (`celestial`) | **구현됨(Phase 32)** — 연화 점질량(실제 G·질량) ≤ 4개, 해석적 구배 텐서·조석, KDK 궤도 적분(결정적 하위 스텝)으로 Rapier 1차 중력 증분 교체, 궤도 시험체, 포획(질량·운동량·에너지 장부, 고정/누적/성장), 지정 운동, 시험 입자, 층별 수평 하중·들림 파괴, 프리셋 20종, [EXTREME_CELESTIAL.md](EXTREME_CELESTIAL.md). 남은 것: 일반상대론(지평선·시간 지연·광선 휘어짐·Kerr), N-body, 실제 강착 원반 | **Phase 31 중력장**(합성·퍼텐셜·장부), ForceLedger, Rapier, 구조(25)·층 모델(13), 파편, 홍수(14) 공간장 경로 |
| Human physical response (교차) | **구현됨(Phase 33, 설정 `humans.model = 'extended'`)** — 8구획 질량·관성(Rapier 질량 특성), 국소 중력·외력(ForceLedger 출처별) 기반 역진자 균형·XcoM 넘어짐, 지지 상실(무중력·반전·부력·투척), 강체 상태 기반 자세, 접촉 에피소드(힘 벡터·솔버 접촉점·충격량, 지면 착지 기하 판정), 구획별 교육용 위험 지표·누적·능력, 착지 후 다시 서기/주저앉기, 조석 체축 내력, 에너지 장부, 기존 넘어짐 규칙 대체(`knockDown` 우회), [HUMAN_PHYSICS.md](HUMAN_PHYSICS.md). 남은 것: 다물체 래그돌, 스텝 전략·보행, 생리 반응(Phase 34) | **Rapier**(접촉 이벤트·질량 특성·CCD), **ForceLedger**(모든 재난 힘), **Phase 31/32 중력장**(국소 g·구배), DamageSystem(접촉 경로), 홍수·매몰 상태 |

## 20. 커밋

`git log --oneline 3656f79..`
