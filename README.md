# 재난 시뮬레이션 샌드박스 (Disaster Simulation Sandbox)

웹에서 실행되는 블록(voxel) 스타일 3D 가상환경 시뮬레이터입니다. 건물·나무·자동차·사람·도로·가로등·표지판·담장을 배치한 뒤
강풍/태풍 조건을 입력하면, 물리 엔진(Rapier)과 손상 모델이 환경 변화를 계산해 시각화합니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 파서·풍하중·피로·이벤트 단위 테스트
npm run build      # 프로덕션 빌드 (dist/)
```

UI 언어: 기본 한국어, 상단 오른쪽 `KO / EN` 토글로 영어 전환 (브라우저에 저장됨).

## 사용 흐름

1. 왼쪽 패널에서 오브젝트 선택 → 뷰포트 클릭으로 배치 (`R` 회전, `Esc` 취소, `G` 스냅)
2. 오브젝트 클릭 → 오른쪽 인스펙터에서 위치/회전/크기, 파라미터, 물리 속성 편집 (`W/E/R` 기즈모, `Ctrl+D` 복제, `Delete`, `Ctrl+Z`)
3. 하단 **바람 설정**(풍속 0–100 m/s, 8방위, 돌풍, 지속/상승 시간) 또는 **명령** 입력
   - `동쪽에서 서쪽 방향으로 풍속 45m/s의 태풍 발생`
   - `풍속을 50m/s까지 20초 동안 증가시켜`
   - `Wind 45m/s from East for 90 seconds`
4. **시뮬레이션 실행** → 타임라인에서 재생/일시정지/속도(0.25–4x), **초기화**로 시뮬레이션 이전 상태 복구
5. 편집 모드로 돌아가면 원본 환경 그대로 (시뮬레이션은 문서를 절대 수정하지 않음)

## 아키텍처

```
UI (React)  ──actions──▶  app/actions.ts (오케스트레이션)
  │                          │
  ├─ Editor System ──▶ World System (WorldDocument, zustand, undo/redo, save/load)
  │                          │ snapshot (structuredClone)
  ├─ Command System ──▶ SimulationController ──▶ RuntimeBuilder ──▶ PhysicsEngine(Rapier)
  │   (parser → zod → dispatcher)   │
  │                                 ├─ EventScheduler ─ Events ─▶ EnvironmentState(WindField)
  │                                 └─ Systems: WindForce → physics.step → PoseSync → Sway → Damage → Debris → Particles
  └─ Rendering (R3F) : 편집 모드 = WorldDocument, 시뮬레이션 모드 = SimulationRuntime(ref 기반, 리렌더 없음)
```

| 폴더 | 책임 |
|---|---|
| `core/` | 공용 타입·수학·방위·데이터 모델 (의존성 없음) |
| `i18n/` | 한/영 사전 (키 누락은 타입 에러) |
| `objects/` | 오브젝트 정의 레지스트리 (기본 물성, 치수, 구성요소, 충돌체, 팔레트 프리셋) |
| `world/` | 문서 스토어, 직렬화(zod 검증), 샘플 도시 |
| `editor/` | 배치·선택·기즈모·편집 상태 |
| `physics/` | `PhysicsEngine` 인터페이스 + `RapierEngine` |
| `events/` | `SimulationEvent`, `EventScheduler`, `WindEvent`, 이벤트 레지스트리 |
| `simulation/` | 컨트롤러, 런타임, 환경 필드, 시스템, 손상 모델 |
| `commands/` | zod 스키마, 규칙 기반 파서(한/영), 디스패처, LLM 파서 스텁 |
| `rendering/` | R3F 뷰 (절차적 voxel 지오메트리, 외부 에셋 없음) |
| `ui/` | 패널·인스펙터·타임라인·명령 콘솔 |
| `app/` | 레이아웃, 단축키, 시스템 간 연결 |

### 물리·손상 모델 (semi-realistic)

- 풍하중 `F = ½ρ·Cd·A·|v_rel|²` 를 압력 중심에 가해 미끄러짐·전복이 강체 해석으로 나타남 (A = 현재 자세의 실루엣 면적)
- 풍속 높이 보정 `v(z) = v₁₀(z/10)^0.14`, 돌풍은 바람 방향으로 이동하는 변동장
- 하중비 `(v_eff / windResistance)²`: 0.3↑ 응력, 0.7↑ 피로 누적(내구도에 반비례), `breakThreshold`↑ 즉시 파괴
- 건물은 창문·간판·지붕 패널·파라펫·옥상 설비를 요소별로 판정 (면 방향별 풍압계수, 높이 설계 보정), 탈락 요소는 파편 강체
- 나무: 수관 잎 손실 → 줄기 부러짐/뿌리 뽑힘 / 사람: 넘어짐 / 차량: 미끄러짐·전복·파편 충돌 / 담장: 구간별 붕괴
- 개체별 강도 편차(나무 ±15%, 사람 ±10%)로 연쇄적 피해 진행

### 확장 방법

- **새 재난**: `events/specs.ts`에 스펙 추가 → `SimulationEvent` 구현 → `eventRegistry` 등록 → `EnvironmentState`에 필드 추가 → 반응하는 `SimulationSystem` 추가 (예: `GroundShakeSystem`, `BuoyancySystem`). 파서는 이미 폭우·지진·홍수·쓰나미·화재·폭발을 인식해 "향후 지원"으로 안내합니다.
- **새 오브젝트**: `objects/definitions/*.ts` 정의 + 레지스트리 등록 + `rendering/parts/objectParts.ts`에 파츠 빌더(편집 뷰와 시뮬레이션 배치가 공유) + 편집 뷰 1개 + `SimRenderAdapter`의 타입별 분기 (+ 필요 시 손상 behavior)
- **새 시스템**: `SimulationSystem`을 구현하고 `systems/index.ts`에 추가. 60 Hz가 필요 없는 시각 전용 시스템은 `interval`(N 스텝마다 실행, dt×N)을 지정합니다. 물리·피해에 영향을 주는 시스템은 결정론을 위해 매 스텝 실행하고, 내부 분산 처리는 `ctx.step`(고정 스텝 카운터)을 사용합니다.
- **LLM 연결**: `commands/LlmParser.ts`가 동일한 `CommandParser` 인터페이스를 구현. 백엔드 호출 함수를 주입하고 `app/actions.ts`의 `commandParser`만 교체. 출력은 `commandJsonSchema()`(zod → JSON Schema)로 검증됩니다.

## Phase 8–10: 공간 바람장 · 시각화 · 분석

- **Spatial Wind Field** (`simulation/wind/SpatialWindField.ts`): 전역 바람(이벤트) → 높이·돌풍 자유류 → 건물 wake(바로 뒤 감속, 거리에 따라 지수 회복, 측면 확산) + 모서리 가속 → 시드 기반 난류(풍향·순간 풍속 변동). 모든 물리·피해·시각화가 같은 `sample()`을 사용합니다. 모델 파라미터는 인스펙터의 *시뮬레이션 설정*에서 조절하며 문서에 저장됩니다.
- **재현성**: `core/random.ts`의 `Rng`(시드 PRNG)만 사용하며, 시뮬레이션 코어에서는 `Math.random`을 쓰지 않습니다. 같은 월드 + 같은 이벤트 + 같은 시드이면 같은 피해 순서가 나옵니다(`determinism.test.ts`가 Rapier까지 포함해 검증).
- **Wind Visualization**: 화살표 격자(InstancedMesh, 높이 3/10/25 m 선택) + 국소 바람을 따라가는 입자. 색은 국소 풍속을 나타내며 건물 뒤에서는 짧고 느려집니다.
- **Analysis**: `MetricsRecorder`가 피해 이벤트(시각, 오브젝트·부품, 위치, 국소/전역 풍속, 하중, 손상 전·후, 원인, 바람 그림자 출처)와 요약 지표를 기록합니다. 일시정지나 완료 상태에서 타임라인의 **결과**를 누르면 결과 패널(요약 카드, 시간별 히스토그램, 이벤트 표, CSV/JSON 내보내기)이 열리고, 표의 행을 클릭하면 카메라가 해당 위치로 이동합니다.
- **Inspector**: 전역/국소/자유류 풍속, 풍하중(kN), 손상도, 한계 풍속, 원인, 국소 풍속이 다른 이유(바람 그림자: 건물 N / 모서리 가속 / 난류). **포커스**·**따라가기** 카메라 지원.
- **Typhoon Environment**: 구름·비·안개·밝기·수관 흔들림. 전역 풍속을 읽기만 하는 렌더링 레이어입니다.
- **근사 모델 표시**: 뷰포트 배지, 결과 패널, 설정 패널에 "공학적 예측값이 아님"을 명시합니다.
- 성능 측정 결과는 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)에 있습니다.

## Phase 11: 엔진 성능 · 확장성

- **렌더링 어댑터** (`rendering/sim/SimRenderAdapter.ts`): 시뮬레이션 상태 → 어댑터 → 인스턴스 렌더링. 모든 오브젝트 파츠를 재질별 `BatchedMesh`(7개)에, 건물 외피 요소를 종류별 `InstancedMesh`에, 파편을 하나의 `InstancedMesh`에 그립니다. 프레임당 `useFrame` 하나가 포즈·흔들림·가시성을 복사합니다. 클릭한 인스턴스는 `batchId` → 원래 엔티티 ID로 매핑되어 선택·인스펙터·포커스·피해 이벤트 이동이 그대로 동작합니다. 시뮬레이션 코어는 React/Three.js에 의존하지 않습니다.
- **렌더링 LOD** (시뮬레이션 계산은 그대로): 먼 나무·사람·차량은 단순 지오메트리, 먼 사람은 팔을 따로 그리지 않음, 먼 오브젝트의 시각 애니메이션은 3프레임마다 갱신.
- **바람장 공간 인덱스** (`simulation/wind/ObstacleIndex.ts`): 장애물의 실제 영향 영역(외곽·모서리 띠·넓어지는 wake)을 바람 방향 좌표계 격자에 래스터화. 셀별 버전으로 정적 지점 캐시를 무효화(붕괴 시 그 wake 아래만 재계산). 장애물 추가·이동·삭제 지원. 결과는 전수 검사와 비트 단위로 동일합니다.
- **스케줄러**: 시스템별 `interval`(고정 스텝 카운터 기반, 결정론 유지). 입자(시각 전용)는 30 Hz, 건물 외피 판정은 20 Hz 3라운드 분산, UI 발행은 10 Hz.
- **개발용 성능 HUD**: `Shift+P`, `⋯` 메뉴 또는 `?perf` — FPS, 프레임 시간, 시뮬레이션/물리/바람장/피해 ms, draw call, 삼각형, 오브젝트 수. 기본 OFF.
- **골든 테스트** (`simulation/golden.test.ts`): 최적화 전 엔진으로 생성한 피해 이벤트 시퀀스와 최종 엔티티 상태(전체 정밀도)를 해시로 비교합니다.
- CPU 프로파일: `BENCH=1 npx vitest run src/bench`

## 현재 제한사항

- 지형은 평면(높이맵 편집 미구현). 바람 그림자는 박스 형태의 경험적 wake 근사(CFD 아님)이며, 나무·차량은 바람을 막지 않음
- 바람 외 재난은 인식만 하고 시뮬레이션하지 않음
- 시뮬레이션 타임라인은 되감기(seek) 불가 — 초기화 후 재생
- 편집 모드는 아직 오브젝트별 메시로 그립니다(시뮬레이션 모드만 배치 렌더링). 1000개 장면의 편집 모드 draw call은 최적화 전 수준입니다.
