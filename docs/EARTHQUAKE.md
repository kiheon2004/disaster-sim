# Phase 13 — 지진 · 구조물 응답 시스템

> **이 프로그램은 검증된 구조안전 진단·지진 피해 예측 소프트웨어가 아닙니다.** 지반 운동은 실제 지진 기록이 아닌 **합성 파형**이고, 구조 응답과 피해는 모두 근사 모델입니다. 실제 건물의 안전성 판정에 사용할 수 없습니다. (설정 패널·결과 패널·HUD에 같은 문구가 표시됩니다.)

흐름: **EarthquakeEvent → GroundMotionField(지반 운동) → Foundation(기초) → StructuralModel(축약 다자유도) → Seismic Damage → NORMAL…DESTROYED / Rapier 자유 물체**

## 1. 구조와 통합

| 단계 | 모듈 | 비고 |
|---|---|---|
| 이벤트 | `src/events/earthquake/` (`EarthquakeEvent`, `earthquakeSchema`, `resolveEarthquake`) | 기존 `SimulationEvent` 유니온·레지스트리에 추가. 규모와 PGA는 **별개 입력** |
| 지반 운동 | `src/simulation/seismic/SyntheticWaveform.ts`, `GroundMotionField.ts` | 바람의 `SpatialWindField`와 같은 역할: 모든 시스템·렌더러가 `sample(x, z, t)`로 조회 |
| 지반 | `src/terrain/SoilProfiles.ts`, `LiquefactionModel.ts`(인터페이스만) | 표면 재질(GroundMaterials)과 분리된 별도 레이어 |
| 기초·구조 | `src/simulation/seismic/StructuralModel.ts`, `structuralProps.ts`, `SeismicState.ts` | SoA(Float64Array), 첫 지진 이벤트 때 지연 생성 |
| 피해 | `src/simulation/damage/behaviors/seismic.ts`, `seismicLevels.ts` | 기존 상태 머신에 `worst()`로 합성 |
| 기록 | `src/simulation/analysis/SeismicRecorder.ts`, `DamageEvent.hazard` | 지표·시계열, 이벤트별 원인(wind / earthquake) |
| 렌더링 | `src/rendering/sim/SimRenderAdapter.ts`, `src/rendering/sim/seismic/` | 계산과 분리. 과장 배율은 렌더 전용 |
| UI | `EarthquakeForm`, `Seismogram`, `QuakeHud`, `SeismicInspector`, `ResultsPanel` | KO/EN (`*.earthquake.ts` 로케일) |

## 2. 지반 운동 (GroundMotionField)

- **파형**: 축(H1 주방향, H2 직교, V 수직)마다 `d(τ) = E(τ)·Σ Dₖ sin(ωₖτ + φₖ)`. 주파수는 주요 주파수 주변에 로그정규 분포(Kanai–Tajimi 유사 대역), 위상·산포는 시드 PRNG.
- **포락선** E: 감마(Saragoni–Hart) 형태 — 0에서 시작해 증가, 최대, 감쇠, 끝에서 정확히 0. 처음부터 최대 강도로 흔들리지 않습니다.
- **속도·가속도는 해석적 미분**(곱의 법칙)이라 변위 드리프트가 없고 세 값이 서로 일관됩니다.
- **P/S 도달**: 수직 성분은 P파 도달(τ=0), 수평은 S−P 시간 뒤부터. Vp 6.0, Vs 3.5 km/s.
- **경로**: 진원 거리 R에 대해 진폭 ∝ R_ref/R, 도달 지연 (R − R_ref)/Vs. 200 m 지도에서는 얕고 가까운 진원이 아니면 차이가 작습니다(현실과 같음).
- **정규화**: 기준 지반(Dense Soil)에서 수평 합성 최대 가속도 = 사용자가 지정한 PGA. 다른 지반은 같은 배율에 지반 전달함수만 달라 최대값이 증폭/감쇠됩니다.
- **PGA 미지정 시**: 규모·거리로 근사 PGA를 계산하되 "가정"으로 명시합니다. 다른 기본값(지속시간, 주파수, 깊이, 진앙, 방향, 시드)도 모두 가정 목록에 표시됩니다.
- 지반별 파형 표를 지연 생성(RATE Hz) 후 선형 보간 — 결정론적이고 할당 없는 hot path.

## 3. 지반 속성 (Soil Profile)

| Soil | 증폭 | Vs30 m/s | 지반 주파수 Hz | 공진 | 감쇠 | 지지력 kPa |
|---|---|---|---|---|---|---|
| Rock | 0.8 | 900 | 8 | 0.05 | 0.02 | 3000 |
| Dense Soil (기준) | 1.0 | 450 | 4 | 0.3 | 0.05 | 400 |
| Soft Soil | 1.35 | 200 | 1.6 | 0.45 | 0.08 | 120 |
| Reclaimed Ground | 1.6 | 150 | 1.1 | 0.5 | 0.1 | 80 |

- 전달함수 |H(f)| = 증폭 × (1 + 공진 × 로그정규 혹(지반 주파수, 폭은 감쇠에 비례)).
- 강성 G = ρ·Vs² → 기초 스프링. 지지력 → 기초 회전(기울어짐).
- 지형 정점별 soil id(RLE 저장), 경계에서는 이중선형 가중치로 부드럽게 섞입니다. 지형 편집 모드에 Soil 브러시, Soil 보기 모드, 프로브의 지반 정보.
- **액상화는 구현하지 않음.** `LiquefactionModel` 인터페이스(지하수위, 누적 사이클, 간극수압비 → 지지력 손실·침하)와 `liquefactionSusceptibility` 값만 준비했습니다.

## 4. 기초 시스템

- 속성: Foundation Type(spread / mat / pile 등), Stiffness, Damping, Anchorage Strength, Ground Contact, Failure Threshold(기울기).
- 기초 질량 m_f가 탄성 반무한체 스프링–대시포트로 지반에 연결되고, 수평 저항이 anchorage(× 중량)를 넘으면 **미끄러짐**(잔류 변위).
- 접지압이 지지력을 넘으면 기울어짐이 누적되고, 실패 기준의 3배를 넘으면 붕괴.
- **경사면 배치 개선**: 바닥을 발자국 최고점에 맞추고 아래쪽은 기초 plinth로 채움(이전에는 오르막 쪽이 땅에 묻힘). Phase 12 파일의 기존 위치는 유지됩니다.

## 5. 구조물 응답 (축약 다자유도)

- 건물마다 1–5개 집중질량 전단 체인(층을 묶음) + 선택적 기초 자유도. 변위는 **지반에 대한 상대 좌표**라서 지반 운동은 관성력 −m·a_g로 들어갑니다. 지반 운동을 건물에 그대로 복사하지 않습니다.
- 층 스프링: 이선형 이력(kinematic), 항복 후 강성비 α, P-Δ(−P/h), 강성 비례 감쇠 c = 2ζk/ω₁, 손상에 따른 강성·강도 저하.
- 고유주기 T = Ct·Hˣ (구조 형식별), 목표 주기에 맞게 강성 분배. 손상 지수(Park–Ang 유사) D = θ_max/θ_u + β·Σ|Δθ_p|/θ_u.
- 구조 형식: RC Frame, Steel Frame, Masonry, Wood (항복 전단계수, 감쇠, 드리프트 한계).
- 적분: 반암시적 Euler, 유닛별 최고 주파수로 정한 고정 서브스텝 → 60 Hz에서 안정, 결정론적.
- 가로등·표지판·담장은 단자유도 유닛.

## 6. 피해 및 붕괴

모든 피해는 **응답 대 용량**으로 발생합니다. "규모 ≥ X → 파괴" 규칙은 없습니다(테스트: M9 + 약한 지반 운동은 무해, M5 + 강한 지반 운동은 피해).

| 피해 | 수요 | 용량 |
|---|---|---|
| 창문 파손 | 해당 층 층간변위 | 유리 래킹 용량 |
| 외장재 탈락·간판 낙하·지붕 부품·옥상 설비 | 부품 위치의 층 가속도 | 정착 강도 |
| 외벽 균열 | 최대 층간변위 (slight~extensive) | 구조 형식 한계 |
| 구조적 손상·붕괴 | 손상 지수 D ≥ 1, 또는 기초 기울기 ≥ 3 × 한계 | — |
| 가로등·표지판·담장 | SDOF 손상 지수 ≥ 1 | — |

- 부품별 용량 ±35 % 산포(오브젝트 시드 + 부품 id 기반 → 재현 가능, 시뮬레이션 RNG와 독립).
- 수요비 0.75–1.3은 사이클마다 누적(저주기 피로), 1.3 이상은 즉시 파손.
- 상태 통합: 강한 흔들림 → STRESSED, 균열 → DAMAGED, 기초 실패 → CRITICAL, 붕괴 → DESTROYED. 바람 피해와 `worst()`로 합성. 붕괴한 건물은 강체 파편이 되고 풍장에서 빠집니다.

## 7. 사람 · 차량 · 인프라

- Rapier 자유 물체(차량, 파편, 넘어진 사람 등)에는 **지반 좌표계 관성력**을 가해 기존 마찰·접촉으로 미끄러짐이 결정됩니다(가속도가 마찰을 넘을 때만 차량이 밀림).
- 사람: 지반 가속도·속도가 균형 여유를 소진하면 넘어짐. 부상·사망 같은 의료적 결과는 계산하지 않습니다.
- 가로등·표지판은 흔들리다 쓰러지고, 조적 담장은 전도.

## 8. 시각화

- 건물 흔들림: 구조 모델의 층별 변위로 층 단위 전단 변형(과장 1×/5×/10×/25×, 렌더 전용).
- 구조 응력 색(층간변위비), 균열 데칼, 유리·외장재 탈락, 기초 기울기, 붕괴 포즈.
- Ground Motion: 변위·PGA 색 지면 격자 + 가속도 화살표. 진앙 마커(거리·규모·깊이).
- 카메라 흔들림: 선택형 시각 효과(기본 꺼짐), 계산과 무관.
- 실시간 HUD(현재 지반가속도, 최대값, 단계: P파 / 주요동 / 감쇠), 타임라인 지진파 그래프.

## 9. 명령어

- 한국어: "규모 6.5의 지진을 발생시켜", "중앙에서 30초 동안 지진을 발생시켜", "최대 지반가속도 0.3g의 지진을 발생시켜"
- 영어: "Generate a magnitude 6.5 earthquake", "Apply 0.3g peak ground acceleration for 30 seconds" ("earthquake" 단어 없이도 인식)
- 추가: gal / m/s² 단위, 진원 깊이, 진앙 방향+거리, 진동 축, 주파수, 시드, 지연.
- 결과는 JSON으로 표시. 범위를 벗어난 값은 오류(조용히 클램프하지 않음), 지정하지 않은 값은 "가정"으로 표시.

## 10. 결과 분석

Results Panel 지진 섹션: 지속시간, PGA(설정값 대비), 최대 건물 변위, 최대 층간변위비, 최대 층 가속도, 손상 건물, 붕괴 건물, 쓰러진 인프라, 넘어진 사람, 지진 피해 이벤트(바람 이벤트 수 병기), 지반가속도·층간변위·피해 시간 그래프. 이벤트 표에 재난(바람/지진) 열·필터, 지반 g, 응답(drift % / 가속도 g / 기울기 °). CSV/JSON 내보내기에 같은 필드와 `groundMotion: "synthetic"` 표시.

## 11. 저장 형식 (schema v3)

- 추가: 지형 soil 레이어(RLE; 전부 기본값이면 저장 안 함), 오브젝트 seismic 속성(구조 형식, 기초 형식·강성·감쇠·정착 강도·실패 기준), 저장된 지진 시나리오.
- v1/v2 파일 자동 마이그레이션: 기본 soil, 기본 seismic 속성, 빈 시나리오. 잘못된 값은 기본값/클램프(파일 로드 실패 없음).
- **기존 프로젝트의 바람 결과는 비트 단위로 동일**(골든 테스트 3종 + 마이그레이션 테스트).

## 12. 성능

### 시뮬레이션 CPU (Node, `BENCH=1 [BENCH_HAZARD=earthquake] npx vitest run src/bench`, ms/스텝, 60 Hz)

지진 M6.8, PGA 0.3 g, 90 s (측정 구간 전체가 강진동):

| 오브젝트 | 스텝 합계 | Ground Motion | Structural | Seismic Damage | Damage | Rapier | GC |
|---|---|---|---|---|---|---|---|
| 100 | 0.45 | 0.08 | 0.04 | 0.04 | 0.04 | 0.18 | 0.003 |
| 500 | 1.62 | 0.31 | 0.16 | 0.15 | 0.13 | 0.63 | 0.006 |
| 1000 | 3.23 | 0.61 | 0.35 | 0.29 | 0.26 | 1.26 | 0.013 |

바람 회귀 (동풍 42 m/s, Phase 12 `5edf534`과 현재를 교대 3회, 최솟값):

| | 100 | 500 | 1000 |
|---|---|---|---|
| Phase 12 | 1.24 | 3.91 | 7.17 |
| Phase 13 | 1.19 | 3.98 | 7.15 |

바람만 있는 실행에서는 지진 모델을 만들지 않으므로 ground motion/structural/seismic damage는 0 ms입니다. (측정 중 load average 4–10)

### 브라우저 (production build, 1600×900, `HAZARD=earthquake node scripts/bench-browser.mjs …`)

| 지표 | 지진 100 | 지진 500 | 지진 1000 | 바람 100 | 바람 1000 |
|---|---|---|---|---|---|
| FPS | 60 | 60 | 60 | 60 | 60 |
| 시뮬레이션 속도 × | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| draw call | 29 | 28 | 28 | 23 | 22 |
| 삼각형 (k) | 57 | 182 | 322 | 110 | 367 |
| GPU ms | 2.4 | 7.6 | 5.1 | 2.2 | 4.8 |
| render+shadow ms | 1.6 | 3.7 | 2.2 | 0.9 | 2.3 |
| GC ms/s (trace) | 8 | 53 | 11 | 7 | 73 |
| JS 힙 MB | 44 | 39 | 88 | 34 | 74 |

- 지진 오버레이(지면 격자, 화살표, 균열, 진앙)는 draw call +5–6. 균열 인스턴스 메시는 첫 균열 전까지 그리지 않으므로 바람 전용 장면의 draw call·삼각형은 Phase 12와 같습니다(23/22, 110k/367k).
- 지진 장면은 바람 입자를 쓰지 않아 삼각형이 더 적습니다.
- 측정 중 load average가 최대 18이었습니다. FPS·ms는 잡음이 크니 draw call·삼각형(결정적 값)을 우선 비교하세요.

## 13. 결정론

- 같은 이벤트 + 지형 + 월드 + 시드 → 비트 단위로 같은 파형, 피해 순서, 최종 포즈(Rapier 포함 테스트).
- 이벤트 시드를 지정하지 않으면 시뮬레이션 시드를 사용. 부품 용량 산포는 오브젝트 시드 기반이라 다른 시스템의 RNG 소비와 무관.
- Phase 11 골든 시나리오(바람) 비트 단위 일치. soil 레이어는 바람 결과를 바꾸지 않음(테스트).

## 14. 테스트

`npx vitest run`: **146 통과, 2 건너뜀**(`BENCH=1` 전용 벤치). Phase 13 추가 46개:

- Ground Motion Determinism / Acceleration (PGA 정규화, 포락선 증가·감소, 속도·변위 일관성, P파 선행, 주방향) — `groundMotion.test.ts`
- Soil Amplification, 경계 블렌딩, 기본값·가정 — `groundMotion.test.ts`
- Foundation Response (주기 연장, 미끄러짐), Structural Response (공진 증폭, 고유주기, 준정적 입력 무응답, 높이별 차이, 항복·손상 임계, SoA 독립성) — `structural.test.ts`
- Damage Threshold, Building Collapse, Object Motion(차량 미끄러짐, 사람 넘어짐, 담장 전도), 결정론, 바람 전용 격리, Terrain Regression — `earthquake.test.ts`
- Earthquake Command Parsing (KO/EN 예문, 단위, 범위 오류, 바람 명령 무영향, LLM JSON 스키마) — `earthquakeParser.test.ts`
- Save / Load, Legacy Migration, Wind Regression(마이그레이션 후 비트 일치), 경사면 건물 위치 유지 — `seismicSave.test.ts`

타입 검사 `tsc -b --noEmit` 통과, `npm run build` 통과(청크 크기 경고는 기존과 동일).

### 브라우저 검증

`node scripts/verify-earthquake.mjs http://localhost:4173/ ./shots` (KO, `LANG_UI=en`으로 EN): 샘플 도시, M7.0 / PGA 0.7 g / 25 s. 콘솔 오류 0건. 확인 항목: 편집기 지진 폼·가정 표시, t=4/9/14/22 s 흔들림(층 전단 변형, 응력 색, 지면 격자·화살표, 진앙), 균열·유리 파손·외장재 낙하·붕괴·넘어진 사람·쓰러진 표지판, 건물 인스펙터 실시간 응답, 결과 패널(지진 카드·그래프·이벤트 표). 결과 예: PGA 0.70 g, 최대 층간변위비 3.2 %, 손상 건물 8, 붕괴 6, 쓰러진 인프라 3, 넘어진 사람 12, 지진 피해 이벤트 199, 바람 0.

## 15. 알려진 제한사항

- 합성 파형이며 실제 지진 기록·감쇠식·지진원 모델이 아닙니다. 규모 → PGA 근사는 참고용 가정입니다.
- 두 수평 방향을 독립 적분합니다(2축 상호작용, 비틀림, 비정형 평면 없음). 층을 최대 5개 자유도로 묶습니다.
- 기초–지반 상호작용은 집중 스프링·대시포트 근사입니다. 액상화·침하·측방유동·사면 붕괴는 없습니다.
- 수직 운동은 지반 운동·자유 물체에만 반영되고 구조 손상에는 직접 쓰이지 않습니다.
- 인접 건물 충돌(pounding), 붕괴 잔해의 연쇄 피해, 화재는 모델링하지 않습니다.
- 파편·쓰러진 물체는 Rapier 강체 근사이며 부서지는 과정은 단순화되어 있습니다.
- 사람에 대한 결과는 "넘어짐"까지만이며 의료적 결과는 없습니다.

## 16. Phase 14 (Flood) 준비사항

- `SoilProfile`에 지하수위·투수성 필드를 추가할 자리가 있고, `LiquefactionModel`의 `waterTableDepth` 입력을 홍수 수위와 공유할 수 있습니다.
- `GroundMotionField`/`SpatialWindField`와 같은 패턴으로 `WaterField.sample(x, z, t)`(수심·유속)를 만들면 기존 시스템·렌더러 구조를 그대로 쓸 수 있습니다.
- `DamageEvent.hazard`가 문자열 유니온이라 `'flood'` 추가만으로 결과 패널 필터·CSV/JSON이 확장됩니다.
- 하자드 탭(BottomPanel)과 저장 형식의 `scenario`가 하자드별 키를 쓰므로 홍수 시나리오를 같은 방식으로 추가할 수 있습니다(schema v4 + 마이그레이션).
- 지형 heightfield·지면 재질은 이미 시뮬레이션에 연결되어 있어 침수 범위 계산의 입력이 됩니다.
