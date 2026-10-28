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
- **새 오브젝트**: `objects/definitions/*.ts` 정의 + 레지스트리 등록 + 뷰 1개 (+ 필요 시 손상 behavior)
- **LLM 연결**: `commands/LlmParser.ts`가 동일한 `CommandParser` 인터페이스를 구현. 백엔드 호출 함수를 주입하고 `app/actions.ts`의 `commandParser`만 교체. 출력은 `commandJsonSchema()`(zod → JSON Schema)로 검증됩니다.

## 현재 제한사항

- 지형은 평면(높이맵 편집 미구현), 건물 차폐(바람 그림자) 효과 없음
- 바람 외 재난은 인식만 하고 시뮬레이션하지 않음
- 시뮬레이션 타임라인은 되감기(seek) 불가 — 초기화 후 재생
- 대규모 장면(수백 개 건물)에서는 인스턴싱 확대 필요
