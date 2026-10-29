# Phase 28 — Volcano, Lava Flow, Cooling & Volcanic Deposition

화산 분출원에서 공급된 용암이 지형 경사·항복강도·점성(온도·결정 함량)에 따라 흐르고, **Phase 26 열 상태로 열을 내보내며** 식고 결정화되어
멈추고, 고화된 용암·화산탄·화산재가 **Phase 21 지형 변형 경로로 지형이 되는** 단계입니다. 새 온도 엔진·구조 파괴 엔진·화재 엔진은 없습니다.

> §1은 구현 전에 쓴 분석과 설계입니다. 나머지 절은 구현·측정·검증 후에 채웁니다.
> **축약된 국소 분출 모델입니다. 화산 분화 예측·재난 대응·구조물 안전 판단에 쓸 수 없습니다.**

## 1. 기존 시스템 분석과 설계 (구현 전)

### 1.1 재사용하는 시스템

| 시스템 | 위치 | 화산이 쓰는 방식 |
|---|---|---|
| 지형 높이장 (12) | `TerrainData` 정점 격자(1 m), 물·열 셀 = 정점 사이 칸 | 용암·퇴적물 상태장은 **정점 격자**(Phase 22 `GeoField`와 같은 쌍대 칸 1 m²) — 정점 값 × 면적 = 렌더·충돌 지형의 부피와 정확히 같음 |
| 물 솔버 (14) | `WaterField` 셀, `applyBedChange`(수심 보존) | 고화 용암·퇴적물은 지형 경로로 물 바닥이 됨(물 질량 정확). 용암 ↔ 물 열교환은 Phase 26 물 열 추적자로 |
| 현상 엔진 (15) | `phenomena/*`, `PLANNED.volcano` | `volcano`를 구현 현상으로. 이벤트는 채널(`env.volcano`)에만 씀 |
| 모듈형 건물 (17)·구조 (25) | `CollapseModel.setMaterialFactor/addLoad/fail` | 열 강도 저하는 Phase 26 결합 그대로(해저드 이름 훅 = `volcano`), 화산재 지붕 하중 = `addLoad`(잔해 하중과 같은 경로), 붕괴·잔해는 Phase 25 |
| 도로 (18) | `RoadSegmentState` | 표본점에서 용암·고화·화산재 두께·온도 → 통행 판정(도로망 불변) |
| 식생 (19)·화재 (27) | `FireRuntime`, 나무 연료 | 용암 복사·접촉 열이 열 노드로 들어가 **보통 착화 규칙**으로 판정. 매몰은 화재와 별도 원인 |
| Blueprint (20) | 공유 불변 설계 | 읽기만 |
| 지형 변형 (21) | `DeformationEngine` + `DeformationSource` | **화산 원천 하나**(`src:volcano`, 비분리형) — 고화 용암 + 화산탄 + 화산재 두께. `overburdenAt` = 전부(기초는 따라 오르지 않고 매몰·하중으로만 작용) |
| 지반 붕괴 (22) | `GeoField`(토사 장부), `granular.ts` | **장부를 공유하지 않음**(용암은 토사와 다른 재료). 면 플럭스·양수성 제한·공여 셀 운반·활성 창·"자기 면으로 정지 판정"·"공여 측 깊이로 속도" 기법만 재사용 |
| 운석 (23) | `impact/ejecta.ts` `fly()` | 화산탄 비행 적분(중력 + 항력)을 **같은 함수**로. 착지 = 화산 퇴적물(화산 장부) |
| 폭발 (24) | — | 화산 폭발 압력파는 범위 밖 |
| 열물리 (26) | `ThermalWorld`·`SourceStep`·엔탈피 표·공기층·물 열 | **재사용**: 용암 엔탈피는 Phase 26 엔탈피 표(새 재료 `basaltLava`, `andesiteLava`, 잠열 포함)로 E ↔ T. 용암이 잃은 열은 `SourceStep`(새 플래그 `volcanic`)으로 지면·물·공기·물체 노드에 들어가 장부 계정 `volcanic`으로 기록 |
| 화재 (27) | `incidentProviders`, `contact`, 착화 FTP | 용암 열은 물체 수열체에 면적(`a`)과 함께 들어가므로 **입사 열유속에 자동 반영(한 번)**. `incidentProviders`는 파일럿(빛나는 용암 표면 ≥ 연료 자연착화 온도) 표시에만. `contact()`는 착화 판정을 건너뛰므로 용암에 쓰지 않음(§23 "닿으면 즉시 연소" 금지) |
| ForceLedger | — | 용암은 힘을 만들지 않음(매몰 차량은 고정, 건물 측압은 구조 모델로) |
| SimRenderAdapter | — | 화산 레이어(용암 면·표면 온도 색·크러스트·분출물·화산재 플룸) 별도 |
| 저장 v7 | 실험 인스턴스 스키마 | 화산 스펙만 저장(런타임 상태 없음) |

### 1.2 데이터 소유권

| 상태 | 소유 | 비고 |
|---|---|---|
| 분출원·공급 이력·분출 단계 | `VolcanoWorld.vents`(순수) | 스펙 + 구간 적분 |
| 이동 용암 두께·질량·엔탈피·크러스트 나이 | `LavaField`(정점 격자, SoA) | **지형이 아님**(충돌체·물 바닥에 넣지 않음, 매 0.1 s 갱신) |
| 고화 퇴적층(용암·화산탄·화산재)의 두께·질량·엔탈피 | `LavaField` 퇴적층 | 지형 기여 = 퇴적 두께 → `VolcanoSource` → Phase 21 엔진(1 mm 동기화 허용치, Phase 22와 같음) |
| 공중 화산재(입자 덩어리)·화산탄(비행 중) | `VolcanoWorld.puffs`, `.bombs` | 질량 장부 계정 `airborne*` |
| 화산 가스 | 질량 장부 계정만(`gasEmitted`) | 농도·독성·화학 없음(Phase 29 인터페이스) |
| 지면·물·공기·물체·구획 온도 | **Phase 26 `ThermalWorld`** | 화산은 `SourceStep`으로만 열을 넣음(직접 엔탈피를 바꾸지 않음) |
| 연료·연소 | **Phase 27 `FireWorld`** | 용암은 연료를 만들지 않음 |
| 부재 강도·붕괴·잔해 | **Phase 25 `CollapseModel`** | 열 계수(26 경로), 화산재 하중(`addLoad`), 매몰·접촉 기록 |
| 피해 기록 | `recordDamage`, 붕괴 기록 | 해저드 `volcano`(HAZARDS 끝에 추가), 원인 `lava`·`thermal`·`ashLoad`·`burial`·`ejecta`; 2차 화재는 해저드 `fire` + `source: 'volcano'` |

### 1.3 갱신 순서 (계획)

```
prePhysics  DeformationSystem      화산 원천의 version이 바뀌었으면 지형·충돌체·물 바닥·대상물 반응(한 스텝 지연, Phase 22와 같음)
            … WaterSolverSystem
postPhysics … DamageSystem
            ThermalSystem (0.1 s)
              0  ThermalRuntime.prepare            열원, 활성화, LOD
              1  VolcanoRuntime.prepare            분출 단계·공급(구간 정적분) → 용암 유동(안정 하위 스텝) → 냉각·결정화·정지·고화
                                                   → 열교환량 계산(현재 용암 표면/바닥 온도 vs 열 노드 온도, 명시적)
                                                   → SourceStep(volcanic) 목록, 화산탄·화산재 이동·착지, 퇴적
              2  FireRuntime.prepare               (용암 SourceStep이 입사 열유속에 들어감; provider = 파일럿)
              3  ThermalWorld.step                 지면·물·공기·물체로 열 전달
              4  FireRuntime.after / VolcanoRuntime.after  물체 반응(매몰·접촉·화산재 하중·도로), 통계·마일스톤
              5  ThermalRuntime.after              부재 온도 → 재료 계수(해저드 훅: fire > volcano > thermal)
            StructuralCollapseSystem              재분배·붕괴(한 스텝 1회, 변경 없음)
```

- 용암 열이 열 노드에 들어가는 경로는 `SourceStep` 하나뿐 → 화재의 입사 열유속 계산(`incident()`)이 그대로 한 번 읽음(중복 없음).
- 교환량은 단계 시작의 온도로 계산(명시적, 0.1 s): 안정 조건 = 열 노드 쪽 G·Δt/C ≪ 1(지면 표면층 C ≈ 4·10⁴ J/K, 용암–지면 G ≈ 수 W/K) — 측정해 문서화.

### 1.4 용암 유동 모델 (Phase 14·22를 복사하지 않음)

- 물(얕은 물 local-inertial)·토사(Voellmy)와 달리 용암은 **점성 지배·항복강도 유체**: 관성 무시, 정상 Bingham 판 흐름의 단위 폭 유량
  q = (τ_y·h_cr²/(3η))·(a³ − 1.5a² + 0.5), a = h/h_cr > 1, h_cr = τ_y/(ρ g sin θ) (Dragoni 1986; MAGFLOW 계열 셀 오토마타의 천이 규칙). τ_y → 0이면 뉴턴 판 흐름 ρ g sin θ h³/(3η).
- 공유 기법(재사용): 면 플럭스를 한 셀에서 빼 이웃에 더함, 유출을 보유량으로 제한(양수성), 공여 셀 값 운반(엔탈피·나이), 활성 영역, 정지 판정은 자기 면으로.
- 용암 전용: η(T, φ) = η_melt(T)·(1 − φ/φ_m)^−2.5 (Einstein–Roscoe), η_melt = GRD 모델(Giordano et al. 2008, 조성 → VFT B·C), τ_y(φ) (FLOWGO/Pinkerton & Stevenson), φ(T) 액상선–고상선 선형, 결정 φ ≥ φ_lock이면 이동 불가 → 고화 퇴적층.
- 안정: 확산형 명시 한계 Δt ≤ 0.2·Δx²/D, D = ρ g h³/(3η)(최대값); 하위 스텝 상한과 그때의 면 제한(자유 수면 역전 금지)으로 무조건 단조. 얇은 막은 h < h_cr에서 유량 0(항복) → 정착 후 갱신 멈춤.

### 1.5 장부

- **질량**: 공급 = 이동 + 고화 + 경계 유출 + (분출물: 비행 중 + 퇴적 + 유출) + (화산재: 공중 + 퇴적 + 지붕 + 유출) + 잔차.
- **에너지**(기준 = 대기 기준 온도 Tref의 현열, Phase 26과 같음): 공급 열에너지 = 용암·퇴적층 내부 에너지 + 지면·물체·물·공기로 간 열 + 하늘 복사 + 경계 유출(용암이 가져감) + 미해결(플룸·화산재·가스 열) + 잔차. 잠열은 엔탈피 표에 포함(고화 에너지 항 = 방출 잠열, 정보용).
- 열 세계 쪽: `ThermalLedger.volcanic` = 화산 장부의 "열 세계로 간 열" 합 — 두 장부가 각각 닫히고 서로 같음(테스트).

### 1.6 LOD

용암이 닿거나 강한 복사(≥ 1 kW/m²)를 받는 건물만 부재 노드로 세분(Phase 26/27 규칙). 1000동 장면에서 용암 경로 밖 건물은 세분되지 않아야 함(측정).

### 1.7 원본 월드 복원

모든 화산 상태는 런타임(`env.volcano`, 실행 지형 사본, 열 상태)에만 — 초기화 시 버림. 원본 지형·건물·도로·식생·Blueprint는 쓰지 않음. 같은 조건이면 같은 결과(시드 무관한 결정론적 계산, 반복 순서 = 정점 번호·삽입 순서).
