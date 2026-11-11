# Phase 37 사전 감사 — 명령·자연어 편집 구현 전 상태

기준 커밋 `d5b5896`(main, Phase 36 최종 — `src`·`scripts`는 `a9637ca`와 같음: `git diff a9637ca d5b5896 -- src scripts` 빈 출력).
작업 트리: 35.5에서 남은 추적되지 않는 시험 스크립트 `scripts/_*.mjs` 9개와 수정 상태의 빌드 부산물 `tsconfig.tsbuildinfo`(둘 다 건드리지 않음).
Node 24, TypeScript 7.0.2, Vite 8, Vitest 5. 기준 품질: 같은 소스의 Phase 36 최종 실행 — `tsc -b --noEmit` 0, 전체 시험 **1436 통과 / 0 실패 / 36 건너뜀**
(162개 파일, 11분). 이번에 다시 돌리지는 않았습니다(소스 동일). 감사 시각 2026-11-11 10:00–10:35, 부하 3.5–7(다른 세션이 같은 기기에서 작업 중).

이 문서는 요약과 구현 계획입니다. 근거(파일:줄)는 세 부록에 있습니다 — 코드를 읽어 확인한 것 (C)와 실행으로 확인해야 하는 추측 (S)를 구분했습니다.

| 부록 | 범위(명세 §3 항목) | 결함 번호 |
|---|---|---|
| [`phase37-audit/edit-api.md`](phase37-audit/edit-api.md) | 1 편집 API의 부수 효과 · 2 한 명령 = 한 단계 · 7 이름·식별자 · 9 Phase 36 잔여 | E1–E28 |
| [`phase37-audit/disasters-palette.md`](phase37-audit/disasters-palette.md) | 3 재난 라이브러리·칸·제어 · 4 객체 팔레트 · **기존 명령 시스템** | D1–D42 |
| [`phase37-audit/input-ui.md`](phase37-audit/input-ui.md) | 5 좌표·방향 · 6 단축키·IME · 8 i18n·`__ds`·Chrome 스크립트 · 명령창이 놓일 UI | U1–U28 |

## 0. 먼저 결론

1. **명령 시스템이 이미 하나 있습니다**(명세에 없던 사실). `src/commands/`(규칙 파서 639줄 + 지진·물 파서 + zod 스키마 + 디스패처, 시험 53건)와 하단 서랍
   `ui/BottomPanel/CommandPanel.tsx`. 이것은 "재난을 **지금 실행**"하는 경로입니다: 문서를 거치지 않고 `simulationController.addEvent`로 바로 넣습니다
   (`app/actions.ts:561-569`) — 핀도, 인스턴스도, 실행 취소도 없습니다(D1). 명세 §11("마우스와 같은 인스턴스, 같은 실행 취소")과 다릅니다. → §4-1.
2. **한 명령 = 한 실행 취소 단계는 지금 불가능합니다**(E1). `applyEdit` 한 번에 담기는 조합(객체 + 도로 + 지형 층 + settings/scenario 통째)만 한 단계이고,
   그룹 이름·새 객체 id에 묶인 차 설정·브러시 획·`setExperiment`·스크립트는 따로 단계가 생깁니다. 기록 호출이 9곳에 흩어져 있습니다. → `worldStore.batch`.
3. **편집 액션은 명령에서 부를 수 없습니다**(E4, E11, E13). `app/*Actions.ts`는 선택·도구 저장소를 읽고 토스트를 올리고 `void`를 돌려주며, 프리셋 계열 15곳은
   `window.confirm`으로 멈춥니다. 순수 코어는 대부분 이미 있습니다(`transformObjects`·`alignObjects`·`distributeGaps`·`matchObjects`·`copyProperties`·
   `checkStamp`·`checkPlacement`·`planPlacement`·`planForest`·`drawRoad`·`snapPoint`·`createInstance`·`placement.set`). 없는 것: 한 개 놓기(컴포넌트 안),
   그룹 만들기/풀기, 플래그, 공통 칸 편집, 지형 프로그램 획, 재난 칸 읽기·쓰기·잘림.
4. **방위 규약은 이미 고정**되어 있습니다: +x = 동, −z = 북(`core/units.ts:4`, `core/compass.ts:7-20`, 뷰포트 나침반 `Compass.tsx:6-19`). 각도는 둘입니다 —
   재난 칸은 방위각(북 0, 시계), 객체 방향은 yaw(로컬 +x가 동 = 0, 반시계; 인스펙터 "Y 방향"). "앞"은 건물·사람 +z, 차량 +x(U1, U2).
5. **"같은 스크립트 → 같은 결과 문서 해시"는 지금 성립하지 않습니다**(E3, D37): 새 객체 id·그룹 id는 `crypto.randomUUID`, 지정하지 않은 씨앗은 `Math.random`,
   `worldFingerprint`는 id를 포함합니다. 계획 해시는 가능하고(id 이전 단계), 문서 비교에는 id를 정규화한 지문이 필요합니다.
6. **한글 조합 중 Enter 검사가 저장소 어디에도 없습니다**(U7, D8): 옛 명령 입력란 `CommandPanel.tsx:64-68` 포함. 기존 Chrome 스크립트는 한글을
   `Input.insertText`로 넣어 조합을 만든 적이 없습니다(U8).
7. 명세 §11의 전제 하나가 코드와 다릅니다: `placement.set`에는 **범위 제한이 없습니다**(0.1 m 반올림만, `phenomena/catalog.ts:68-69`). 잘림은 UI 숫자 칸에만 있고
   zod는 거부만 합니다(D19). 명령이 "잘린 값을 요약에 표시"하려면 공유 잘림 함수가 새로 필요합니다.

## 1. 이미 있는 기능 (재사용 — 새 이름으로 다시 만들지 않음)

| 영역 | 있는 것 | 위치 |
|---|---|---|
| 한 단계 편집 | `applyEdit`(추가·교체·삭제 + 도로 + 지형 층 + settings/scenario), 트랜잭션, 지형 획, `setExperiment`·`setGroupName`(각 한 단계) | `world/worldStore.ts:592-609, 735-745, 719-733, 857-881` |
| 변형·정렬 코어 | `transformObjects`·`alignObjects`(원점/바닥면)·`distributeGaps`·`distributeObjects`·`matchObjects`·`selectionPivot` — 순수 | `editor/build/groupTransform.ts` |
| 속성 복사 | `copyProperties(ref, objs, props, terrain)` — 순수, 건너뛴 수 반환 | `editor/build/propertyCopy.ts` |
| 배치 계획 | `planPlacement(item, points, settings, ctx)` → `PlannedObject[]`(씨앗 흐름 `subSeed`, 앉힘, 검사) — 순수. 미리보기 `PlanPreview`가 이 모양을 배치 유령으로 그림 | `editor/build/placementPlan.ts:104-157`, `editor/tools/shared.tsx:78-137` |
| 스냅 | `snapPoint(query, env)`: 도로 노드 > 차선 > 접면 > 중심 > 가장자리 > 구조 격자 > 격자, 접면 뒤물림 1 m — 순수 | `editor/snap/snapEngine.ts:204-258` |
| 배치 검사 | `checkPlacement`(경사·떠 있음·묻힘·바퀴 접지·가파름·물속·도로 밖), `checkStamp`(월드 밖 거부·겹침 경고), `isInsideWorld` | `editor/build/placementCheck.ts`, `editor/placement.ts` |
| 복제·도장 | `createBlueprint` / `instantiateBlueprint` — 순수 | `editor/build/blueprint.ts:74, 135` |
| 도로 | `drawRoad`(노드 3 m 스냅, 가장자리 + 2 m = 분할, 교차 = 십자), `segmentLine`·`pointAt`·`nearest`·`sectionAt`(차선·끝난 차선 `null`), `measureLink` — 순수 | `roads/network.ts:159-211`, `roads/curve.ts`, `roads/crossSection.ts:340`, `roads/links.ts:38` |
| 지형 | `applyDab`(12종), `previewDab`(한 점 1초분), 획 = 한 단계, 획 취소 | `terrain/TerrainEditor.ts:88, 263`, `worldStore.ts:770-826` |
| 숲 | `planForest(points, settings, ctx, stroke)` → 입력 + 거부 사유 6종 — 인자를 다 넘기면 순수 | `app/natureActions.ts:265-299` |
| 재난 | 등록부 18종(`phenomena.listImplemented()`), 칸 메타 `ParamField`, `CATALOG`(범주·위치 정책 `placement.get/set`), `createInstance`, `resolveSchedule`, `controlEvent(key, op)`, `instances()` | `phenomena/registry.ts`, `types.ts:75-94`, `catalog.ts:88-233`, `schedule.ts:38-108`, `simulation/SimulationController.ts:293-341` |
| 객체 종류 | `PALETTE` 38항목(+ custom) × `labelKey`, 모듈식 건물 프리셋 6 + `presetSpec`·`createDesign`, 층수 지정 `presetDesign(preset, floors)` | `objects/palette.ts:38-104`, `buildings/spec.ts:55-75`, `roads/city.ts:158-167` |
| 옛 재난 문장 문법 | 바람·지진·비·수위·물 유입 문장을 **값까지** 읽는 한·영 파서(시험 53건) | `commands/RuleBasedParser.ts`, `earthquakeParser.ts`, `floodParser.ts` |
| 입력 규칙 | 물리 키 `keyOf`, `isTyping`, `isComposing`, `modalOpen()`, 제스처 수명, 입력 정책 구독 | `app/hotkeys.ts`, `editor/input/keys.ts`, `gesture.ts`, `app/inputPolicy.ts:60-117` |
| 검증 형식 | `verify-editor36.mjs`(실제 Chrome·실제 입력·`__ds` 읽기), `chrome-lanes.sh`, `bench-editor36.mjs`(규모·누수), `look-editor36.mjs` | `scripts/` |

## 2. 명세 §3 항목별 답

### 2.1 편집 API의 부수 효과 (§3-1) — 부록 edit-api §1

- 액션 계층(`app/buildActions.ts`, `roadActions.ts`, `natureActions.ts`, `placementActions.ts`)은 **선택·주 선택·도구 상태를 읽고**(`buildActions.ts:26-33`), 토스트를 올리고,
  `editable()`이 거짓이면 조용히 아무것도 하지 않고, 실패를 삼켜 `void`를 돌려줍니다. 명령이 부르면 대상이 "선택"으로 고정되고 성공 여부·건수를 알 수 없습니다(E11).
- **막히는 경로**(부록 표 B1–B17): `window.confirm` 15곳 — `newProject`·`loadStructureLab`·프리셋 6종·`applyEnvironment`·`applyTerrainPreset`(빈 월드에서도 항상)
  (`app/actions.ts:150-336`, `app/natureActions.ts:317`). `loadSampleTown`은 반대로 확인 없이 교체. 잠금 중 새 월드 계열은 문서는 그대로 두고 기록만 지웁니다(E14).
- **조용한 경로**: 잠금 중 `applyEdit`는 `[]`, `setExperiment`는 기록 없이 적용(E15), `placeAt`은 무장 상태가 아니면 `null`(D21), `snapPoint`는 허용 3 m 밖이면 말없이 격자,
  `placement.set`은 전역 중력·균일 대기에 위치를 주면 원본을 그대로 반환(D28).
- 이름 주의(E17): 명세의 `placementCheck`는 파일 이름이고 함수는 `checkPlacement`; `snapPoint`라는 이름이 네 곳에 있습니다(import는 `editor/snap/snapEngine`).
- **명령은 순수 코어 + `worldStore` 메서드만 부릅니다.** 없는 코어는 추출해 UI 액션도 그 함수를 쓰게 합니다(사본 금지) — §5 계획.

### 2.2 한 명령 = 한 단계 (§3-2) — 부록 edit-api §2

- 기록 한 항목 = `{objects, terrain 패치, roads, landscape{features, next, 층 패치}, config?, groupNames?}`(`worldStore.ts:52-66`). 지형·층 배열은 **제자리 편집**이고 패치(사각형
  before/after, `settings` 포함)로 되돌립니다(`terrain/TerrainData.ts:111-164`, `landscape/apply.ts:96-142`).
- 기록을 남기는 곳 9곳: `:339`(commit) `:387`(지형·층) `:562`(도로) `:604-606`(applyEdit의 config 덧붙이기) `:663`(duplicate) `:732`(그룹 이름) `:744`(setExperiment) `:854`(checkpoint)
  `:870`(트랜잭션). **기록 없이 문서를 바꾸는 곳**: `updateSimulationSettings :675`, `setEarthquakeScenario :714`, `setFloodScenario :747`, `setProjectName`, `history:false` 쓰기.
- 오늘 "주택 세 채 놓고 묶어 이름 붙이기"는 3단계, "차가 섞인 그룹 복제 + 설정 복사"는 2단계, 재난 3개는 3단계입니다(D22).
- **필요한 것 = 저장소의 일괄 단계.** 지켜야 할 불변식 12개(부록 §2.7) 가운데 설계를 정한 것:
  - 기록 호출을 한 깔때기(`record`)로 모으고, 일괄 중에는 `past`에 넣지 않습니다 — 넣은 채 접으면 100항목·64 MB 상한이 일괄 자신의 앞 항목을 잘라 냅니다(500줄 스크립트).
  - **롤백은 스냅숏(값 복사)** 으로: 도로 굽기와 브러시 확정은 지형을 제자리에서 고친 뒤 예외가 나면 복원 코드가 없습니다(`worldStore.ts:411-435, 552-566, 348-370`, E6) —
    항목 역적용에 기댈 수 없습니다. 시작 때 지형 3층 + 층 8개 사본(꼭짓점당 27 B, 200 m 지도 1.1 MB), 실패 시 통째 복사.
  - **합친 패치는 실제 차이의 최소 사각형**으로: 설정 전용 단계의 더미 사각형 `{0,0,0,0}`(`:848, :495`)이 섞이면 합집합이 부풉니다(E8).
  - 변화 없음 판정은 참조가 아니라 내용으로: `applyGeometry`는 객체 맵을 늘 새로 만들고(`:516`) `setExperiment`는 같은 내용도 새 객체로 기록합니다(E5).
  - `terrainRect`는 합친 사각형으로 한 번(지형 메시는 마지막 값만 읽음, `rendering/terrain/TerrainLayer.tsx:112-119`, E7).
  - 실패 시 `future`(다시 하기)도 그대로, 일괄 중 `busy()` = 참, 시작할 때 `busy()`·`locked`면 거부.
- **기존 결함 E2**(높음): `config`가 settings와 scenario를 **항상 함께** 되돌립니다(`:63, :398`). 재난 하나를 실행 취소하면 그 뒤에 바꾼 시뮬 설정(기록 없는 쓰기)이 같이
  옛 값으로 돌아갑니다. 명령이 config 단계를 많이 만들수록 잦아집니다. → config를 **바뀐 쪽만** 담도록 고칩니다(§6 결정 표).
- 구독자: `worldStore`를 듣는 것은 자동 저장(`app/autosave.ts:112`)과 선택 정리(`app/inputPolicy.ts:98-110`) 둘. 선택 정리는 내부 `set()`마다 돌아, 롤백해도 선택은 깎인 채
  남습니다(I10). 부록은 `set`/`get` 감싸기를 제안했으나, 일괄 안의 코드가 `getState()`로 중간 문서를 읽어야 하므로(스크립트의 뒷줄 계획) 채택하지 않고
  **명령 확정 층이 선택을 잡아 두었다가 실패 시 되돌립니다.**
- 비교 도구: 공용 "비트 동일" 도우미가 없습니다. `worldFingerprint`는 파생 층 `natural.*`를 보지 않고 id를 포함합니다(`world/fingerprint.ts:9-20`). → 층 바이트까지 보는
  도우미와 id 정규화 지문을 `world/`에 두고 Node 시험과 `__ds`가 함께 씁니다.

### 2.3 재난 (§3-3) — 부록 disasters-palette §2

- 18종의 type·한영 이름(`translate('ko'|'en', labelKey)`로 UI 언어와 무관하게 읽힘)·범주·위치 정책·칸(저장 단위·한계·기본값)·제어 지원을 부록 §2.2–§2.7 표로 정리했습니다.
- **단위 함정(D18)**: `ParamField.unit`은 **표시** 단위입니다. 저장은 SI — 폭발 `energy` J(표시 MJ, scale 1e-6), 운석 `speed` m/s(km/s), 열출력 W(kW), 기간 s(분), 기온 K(°C,
  `get/set` 변환). 명세 예문 "폭발 1.8e9 J"는 저장 단위 그대로이고 한계 [1e3, 1e12] 안입니다(`blast/types.ts:52`). **정규 명령의 칸 값은 저장 단위**로 합니다.
- **검증(D19, D20)**: 잘림은 UI 숫자 칸(`ui/common/fields.tsx:54`)뿐, `addPhenomenon`·`setExperiment`는 무검증, 잘못된 스펙은 실행 때 빠지고 **불러올 때 조용히 사라집니다**
  (`phenomena/experimentSchema.ts:26-35`). 월드 밖 검사는 마우스 층에만(`PlacementLayer.tsx:151-159`). → 계획 단계에서 `clampField`(공유) → `def.schema.safeParse` → 지도 안 검사.
- 칸 읽기·쓰기(`fieldValue`·`setField`, scale·중첩 처리)는 `ExperimentPanel.tsx:177-189`의 비공개 함수(D17) → `phenomena/`로 옮겨 UI와 명령이 공유.
- 위치 칸 이름이 종류마다 다릅니다(`position`·`center`·`target`·`epicenter`·`area.center`·`vents[0].position`·`sources[0].center`·`boundary`, D30) → 위치는 **`placement.set`으로만**.
- 마우스 배치의 순수 부분: `def.defaults()` → 템플릿 → `placement.set(template, [x, z], mapHalf())`(0.1 m 반올림) → `createInstance(type, cur, spec)` → `setExperiment({instances})`.
  `placeAt`은 그 위에 무장 상태·토스트·핀 선택·최근 목록·"지금 실행"을 얹습니다(D21). 명령은 순수 부분을 같이 씁니다("키 제외 동일" 시험이 그대로 성립).
- 제어(부록 §2.7 표, 코드에서 추출 — 정적 표는 코드에 없음): stop + pause = 지진·비·수위·물 유입·토네이도 / stop만 = 바람·열원 / 나머지 11종은 시작 전 취소만.
  편집 모드에서 미리 알리려면 이벤트 클래스의 메서드 유무를 읽는 순수 함수가 필요합니다.
- 단일 상태는 **셋**입니다(D26): 전역 바람, 지도 전체 비, 그리고 문서에 없던 **같은 변의 수위 상승**(`water.<변>`, `events/EventScheduler.ts:113-120`).
- 실행 중: 마우스 배치는 **허용**되고 잠긴 문서에 기록 없이 적용됩니다(`worldStore.ts:739-742`) → 편집 모드로 돌아와도 실행 취소로 지울 수 없습니다(D23, E15). 명세 §10과 부딪칩니다 → §6.
- 시작 시각의 기준이 경로마다 다릅니다(D24): 편집 모드에서 놓으면 실행 시작 후 `at`초, 실행 중 "실험 적용"은 지금 + `at`, `runInstance`는 실행 중이면 지연을 버립니다.
- 인스턴스 id `p<k>`는 빈 가장 작은 번호를 **다시 씁니다**(D25, `schedule.ts:93-98`).

### 2.4 객체 팔레트 (§3-4) — 부록 disasters-palette §3

- `PALETTE` 한 표에서 종류·프리셋·한영 이름을 생성할 수 있습니다(부록 §3.2 표). **없는 것**: 별칭("집"·"차"·"빌딩"), 단위 명사 표("채/동/대/그루/명/개" — UI 문구에 흩어짐, D42),
  괄호 붙은 라벨 정리("소형 주택 (목조)").
- 이름이 겹칩니다(D32): "주택"(Phase 5 상자 건물) ↔ "소형 주택 (목조)"(Phase 17 모듈식), "오피스 빌딩" 둘, "2차로 도로"(팔레트 ↔ 도로 프리셋).
- 놓인 객체에서 팔레트 프리셋을 되찾을 수 없습니다(모듈식 건물의 `building.preset`만 있음, D38) → `type:<종류>:<프리셋>` 선택은 매개변수 일치로, 크기·색만 다른 프리셋(표지판·담장)은
  종류까지만.
- 층수 지정: `presetDesign(preset, floors)`가 도시 생성기 파일에 있습니다(`roads/city.ts:158-167`, D34) → `buildings/`로 옮겨 공유. 한계는 모듈식 1–40층, 상자 1–30층(D35).
- 바닥면: `footprintHalves` → `getDimensions` → 모듈식은 `designExtent`(부재 범위: 주택 8 m 설계 → 8.4 m).
- 한 개 놓기의 조립(매개변수 합성·스냅·앉힘·검사·입력)은 `PlaceTool` 컴포넌트 안에만 있고 변형 씨앗은 `Math.random`입니다(`PlaceTool.tsx:63, 73-151`, D36/E4/U26).
- 도로 프리셋 표가 셋이고 "2차로"가 세 프리셋에 해당합니다(D40) → 정규 이름 = `PROFILE_PRESETS` 키(`street narrow wide avenue lane gravel dirt`), "2차로" = `street`.

### 2.5 좌표·방향 (§3-5) — 부록 input-ui §1

- 월드 ±100 m(`WORLD_SIZE = 200`, `core/units.ts:12`), 격자 1 m, 높이 −40…80 m. 경계 상수의 출처가 둘(상수 / 문서 지형 `mapHalf()`)이지만 지금 만들 수 있는 월드는 모두 200 m(U6).
- 방위: **+x 동 · −z 북 · +z 남 · −x 서**(이미 고정 — 나침반·미니맵·정렬 문구·홍수 변·지진/운석/소용돌이 칸이 모두 같음). 방위각 = 북 기준 시계 방향 °.
  바람만 "불어오는 쪽"(`compass.ts:22-29`).
- 객체 방향: 저장은 XYZ 오일러 라디안, 방향각 `yawOf` = `atan2(−v.z, v.x)`(`terrain/groundPlacement.ts:117-121`), 인스펙터는 YXZ로 바꿔 ° 표시(`numericTransform.ts:84-94`).
  yaw 0 = 로컬 +x가 동, 양 = 반시계. 로컬 +x의 방위각 = 90° − yaw°.
- "앞": 건물(모듈식)·사람 = 로컬 +z, 차량 = 로컬 +x. 도로 접면 스냅은 건물 +z가 도로를 보게 합니다(`snapEngine.ts:117-122`).
- 도로: 구간 a → b, lateral + = 진행 방향 **오른쪽**, 차선 0 = 가장 왼쪽, 끝난 차선 = `lanes[i] === null`, 우측통행(`snapEngine.ts:110-114`). 화면에 a→b 표시가 없으므로(U3)
  요약에는 방위를 함께 적어야 합니다. 남북 도로의 "북쪽"은 옆이 아니라 끝 → 되묻기.
- **"여기"·"저기"를 채울 값이 없습니다**(U4, U5): 커서 지면 점은 도구마다 지역 상태로만 있고 select 도구에서는 추적 자체가 없습니다. 카메라 주시점은 Canvas 안에서만 읽힙니다.
  → 포인터 추적기와 "화면 중심 광선 ∩ 지형" getter를 새로 둡니다.

### 2.6 단축키·IME (§3-6) — 부록 input-ui §2

- 전역 처리기 하나(`app/hotkeys.ts`), 키 표는 부록 §2.2. 가드 순서: 조합 중 → 입력란(`isTyping`) → 모달(`modalOpen()`, `:73-75`) → 드래그 중.
- 여는 키 후보 평가(부록 §2.6): **`/`(물리 키 `Slash`, 보조 키 없음)** 권고, 보조로 Ctrl/⌘+K. 기존 바인딩과 충돌 없음. 탈락: Enter(기존 6곳), Ctrl+Space(macOS 한/영 전환,
  Space 재생 토글에 보조 키 검사 없음 `:254`), Backquote(한글 입력기에서 ₩), `:`(Shift 필요).
- 붙일 자리: `:230` 가드 뒤, `placementKeys`(`:238`)와 시뮬레이션 분기(`:253-260`, 일찍 return) **앞** — 뒤에 두면 실행 중에 열리지 않습니다(U11). `keyOf`는 `/`를 `e.key`로
  읽습니다(`keys.ts:17-23`, U12) → `Slash` 매핑 추가.
- `isTyping`이 INPUT의 종류를 가리지 않습니다(`keys.ts:4-9`, U9): 슬라이더·체크박스에 초점이 남으면 여는 키를 포함한 모든 단축키가 죽습니다 → `VehicleControls.tsx:30-38`의 가는 판정을 공유.
- 명령창에 `aria-modal`을 쓰지 않습니다(쓰면 `modalOpen()`이 전부 막음). Esc 사슬(부록 §2.4)에 "열린 계획" 자리가 없습니다(U10) → 사슬 맨 앞에 추가(계획 → 창).
- IME: 입력란 Enter의 조합 검사 0건(U7). 새 입력란은 `nativeEvent.isComposing` · `keyCode === 229` · `compositionstart/end` 깃발 셋 다 봅니다. S2는 puppeteer 래퍼가 없어
  원시 CDP `Input.imeSetComposition`이 필요합니다(U8).

### 2.7 이름·식별자 (§3-7) — 부록 edit-api §3

| 대상 | 식별자 | 사람이 부르는 이름 | 함정 |
|---|---|---|---|
| 객체 | `<type>_<16진 8자><계수>` (난수) | `name`(기본 빈 문자열; "건물 3"은 표시할 때 로케일로 만듦, `ui/format.ts:5-7`) | 손으로 치기 어려움 → Tab 완성. 기본 이름은 로케일 의존·serial 재사용 |
| 그룹 | `grp_…`(난수) | `doc.groups[id].name`(중복 허용) | 구성원이 없어진 그룹의 이름이 세션에 남음(E10). 무명 "그룹 n"은 필터 순번 |
| 도로 노드 / 구간 | `n<k>` / `s<k>`(문서 안 결정적) | **없음** | 구간 id는 분할·합치기에서 사라짐 |
| "큰길" | — | 저장된 이름 아님 | 기본 월드의 큰길 = `wide`(10 m) 동서, T에서 두 구간 |
| 지형 요소 | `f<k>` | **없음**(종류 + 위치뿐) | "언덕"이 둘이면 모호 |
| 재난 인스턴스 | `p<k>`(재사용) | 없음(종류 라벨) | "화재 #3" = `p3`인가 세 번째 화재인가 |
| 팔레트·프리셋·템플릿·Blueprint·환경 | 고정 id | i18n | — |

문서에 **저장되는** 사람 이름은 객체 `name`과 그룹 이름 둘뿐입니다. 스크립트가 한·영에서 같은 결과를 내려면(S22) 기본 이름이 아니라 id·명시적 이름·`last`를 써야 합니다.

### 2.8 i18n·개발 훅·Chrome (§3-8) — 부록 input-ui §3–§5

- i18n: 조각 파일 `en|ko.<영역>.ts`를 `en.ts`·`ko.ts`가 펼쳐 합침, 키 타입은 `ko` 기준, 보간 `{name}`, 없는 키는 ko → 키 문자열. `cmd.*` 접두사는 옛 서랍이 씁니다(U23) → 새 키는 `cmd37.*`.
- `window.__ds`(`app/devtools.ts:114-423`): 명령 상태·지형 해시·id 정규화 해시가 없고 `tr(key)`는 매개변수를 받지 않습니다(U17) → `__ds.command`·`__ds.hash` 추가(검증 스크립트는 읽기만).
- Chrome 형식: `verify-editor36.mjs`의 묶음·check·실제 입력 도우미를 따릅니다. `puppeteer-core`는 `package.json`에 없습니다(`--no-save` 설치, U27 — 그대로 두고 실행 방법에 적음).
  벤치 JSON에 부하·커밋·메모리 여유가 없습니다(U24) → 새 벤치는 시작·끝에 기록.
- **옛 스크립트의 계약(D2, U16)**: 23개가 `ui.setCommandOpen`으로 서랍을 열고, `verify-flood.mjs:146-153`·`verify-ux355.mjs:186-192`는 "문장 + Enter 한 번 = 즉시 실행",
  `verify-phenomena.mjs:134-145`는 안내 문구, `verify-celestial.mjs:541-542`는 `__ds.celestialLib.parse`(옛 `parseCommands`)의 결과 모양을 기대합니다.
- S19(레이아웃)는 잘린 단추를 기록만 하고 합격 조건에 넣지 않습니다(U14) → S20에서는 조건에 넣습니다(S19는 손대지 않음).

### 2.9 명령 때문에 커지는 Phase 36 잔여 (§3-9) — 부록 edit-api §4

| 36 §26 | 현재 코드 경로 | 처리 방향 |
|---|---|---|
| 차 설정이 여러 대 복제·붙여넣기·Blueprint·템플릿 교체를 안 따라감 | `buildActions.ts:169-184, 299-333`, `blueprintActions.ts:357-384, 426-437`, `worldStore.ts:656-664`(한 대만) | 원본 ↔ 새 id는 정렬 순서로 대응 가능(`blueprint.ts:89-90`, `applyEdit`는 add 순서로 id 반환) → 순수 대응 함수 + 일괄 단계에서 같은 단계 복사. 탑승자는 함께 복제된 사람만 |
| 다중 수치 편집 없음 | `MultiInspector.tsx:53-140`. 단일 칸은 다시 앉히지 않고 그룹 변형은 앉힘 — 규칙이 둘(E20) | `numericTransform.ts`에 `setCommonTransform`, `MultiInspector`와 명령이 공유 |
| 맥락 메뉴 없음 | 오른쪽 = 카메라 이동(`CameraRig.tsx:76`), `contextmenu`는 막기만(`Viewport.tsx:15`) | 누름–뗌 이동 5 px 미만일 때만 메뉴, 명령창에 위치가 채워진 명령 |
| 아웃라이너 Shift = 토글, 키보드 없음 | `Outliner.tsx:45-80, 111-124` — 행 계산·가상화가 컴포넌트 안 | 행 계산을 순수 함수로, 기준 행 + 범위 + ↑/↓ |
| 힙 바퀴당 약 12 KB | 원인 미확인. 후보(전부 S): 씨앗 열쇠 Map 3곳(상한 없음 — **명령이 씨앗을 해시로 만들면 명령마다 자람**), 색 Map, 문서 세대를 잡는 단일 칸 캐시 | `LEAK_OPS` 하나씩 → 10·100바퀴 스냅숏 비교, 씨앗 Map 상한 |

## 3. 결함 표 (번호 = 처리 순서의 기준. 전체 98건은 부록의 E·D·U 표)

심각도는 명령 기능에 미치는 영향 기준입니다. "이번" = Phase 37에서 고침, "문서" = 한계로 기록, "결정" = §6.

| # | 결함·빈 곳 | 부록 | 심각도 | 처리 |
|---|---|---|---|---|
| 1 | 일괄 단계 없음 — 기록 호출 9곳, 조합마다 여러 단계 | E1 | 높음 | 이번: `worldStore.batch` (`record` 깔때기, 스냅숏 롤백, 차이 패치, `future` 보존) |
| 2 | `config`가 settings·scenario를 함께 되돌려 기록 없는 설정 쓰기가 휩쓸림 | E2 | 높음 | 이번: 바뀐 쪽만 기록(임시안, 결정) |
| 3 | 새 id·그룹 id·기본 씨앗이 난수, 지문이 id 포함 → 결과 문서 해시 불가 | E3 D37 U17 | 높음 | 이번: 계획의 모든 입력에 씨앗 명시 + id 정규화 지문(저장 형식·id 생성 불변) |
| 4 | 한 개 놓기 조립이 `PlaceTool` 안, 씨앗 `Math.random` | E4 D36 U26 | 높음 | 이번: `planPlacement` + `snapPoint` 조합을 순수 함수로, 명령은 그것만 |
| 5 | 옛 명령 경로는 인스턴스·실행 취소 없이 `addEvent` 직접 | D1 E17 | 높음 | 이번: 확정 경로를 `setExperiment` 하나로(§4-1) |
| 6 | 옛 파서를 뒷받침으로 붙이면 "지진 멈춰" → M6.5 지진 시작, "n4에 폭발 1.8e9 J" → 중앙 1e8 J | D3 D4 | 높음 | 이번: 새 문법이 먼저, 옛 문법은 값을 읽는 5종만 어댑터로. 말뭉치에 반례 고정 |
| 7 | 수 표기: `1.8e9`·`×10⁹`(NFKC로 "109")·`18억`·한글 수사 미지원 | D5 | 높음 | 이번: 새 `normalize`가 NFKC **전에** 지수·억·수사 처리 |
| 8 | 한글 조합 중 Enter 검사 0건 | U7 D8 | 높음 | 이번: 새 입력란 가드 + 아웃라이너 이름 칸, S2는 CDP 조합 |
| 9 | 재난 칸: 표시 단위 ≠ 저장 단위, 잘림은 UI 칸에만, 스키마 실패는 불러올 때 조용히 사라짐 | D17 D18 D19 | 높음 | 이번: 칸 접근·`clampField`를 `phenomena/`로 공유, 계획에서 스키마 확인 |
| 10 | 액션이 UI 저장소·토스트·`confirm`에 묶임 | E11 E13 D21 D41 | 중 | 이번: 명령은 순수 코어만. 그룹·플래그 등 없는 코어 추출 |
| 11 | 도로 굽기·브러시 확정이 예외 시 지형을 복원하지 않음 | E6 | 중 | 이번: 일괄 롤백을 스냅숏으로(내부 원자성에 기대지 않음) |
| 12 | 무변화도 기록(같은 객체 update, 같은 도로망, 같은 `setExperiment`) | E5 | 중 | 이번: 일괄 확정에서 내용 비교로 흡수(일괄 밖 동작은 그대로) |
| 13 | 한 틱에 지형 확정이 여럿이면 지형 메시가 마지막 사각형만 갱신 | E7 | 중 | 이번: 일괄이 합친 사각형을 한 번 씀. Chrome S9·S16에서 확인 |
| 14 | 차 설정이 도장 경로를 안 따라감 | E9 | 중 | 이번(§17) |
| 15 | 그룹 이름이 도장을 안 따라가고, 풀기·삭제 뒤 이름이 남음 | E10 | 중 | 이번: 참조 해결은 구성원 있는 그룹만. 도장의 이름 따라가기는 결정 |
| 16 | 이동·정렬·복제·도로에 월드 경계 검사 없음 | E12 D20 | 중 | 이번: 계획 단계에서 항목별 거부(기존 `isInsideWorld`), 재난은 지도 안 검사(진앙 예외) |
| 17 | 실행 중 재난 배치가 기록 없이 문서를 바꿈 | E15 D23 | 중 | 결정(임시안: 마우스와 같이 허용 + "실행 취소 기록 없음" 표시) |
| 18 | 시작 시각 기준이 경로마다 다름 | D24 | 중 | 이번: 편집 모드 = 실행 시작 후, 실행 중 = 지금부터, 요약에 표시 |
| 19 | 단일 상태 셋(바람·전체 비·같은 변 수위) — 문서에 둘 넣는 것을 안 막음 | D26 | 중 | 이번: 계획에서 같은 채널을 찾아 "앞의 것을 대신함" 경고 |
| 20 | 별칭이 정규식뿐(열거 불가·겹침), 객체 별칭·단위 명사 표 없음 | D15 D33 D42 | 중 | 이번: 표(`CATALOG`·`PALETTE`)에서 생성하는 어휘 + 별칭·단위 명사 표 하나, 겹침은 시험에 나열 |
| 21 | 같은 이름의 종류("주택" 상자 ↔ 모듈식) | D32 | 중 | 결정(임시안: 모듈식 우선, 요약에 프리셋 표시) |
| 22 | 커서 지면 점·카메라 주시점을 읽을 곳 없음 | U4 U5 E21 | 중 | 이번: 포인터 추적기 + 화면 중심 getter(UI 상태) |
| 23 | 각도 규약 둘, "앞" 축이 종류마다 다름, 도로 좌우는 a→b 기준인데 화면 표시 없음 | U1 U2 U3 | 중 | 이번: `heading` = 인스펙터 "Y 방향", 요약에 방위 병기, 남북 도로의 "북쪽"은 되묻기 |
| 24 | `isTyping`이 슬라이더·체크박스도 타이핑으로 봄 | U9 | 중 | 이번: 가는 판정 공유 + 시험 |
| 25 | Esc 사슬에 열린 계획 자리 없음, 시뮬 분기가 일찍 return, `/`가 `e.key` | U10 U11 U12 | 중 | 이번 |
| 26 | 옛 서랍 210 px: 1280×720에서 3D 32.6 %(기준 35 % 미달, S19는 닫힌 상태만 잼) | U13 U14 U15 | 중 | 이번: 한 줄 입력 32 + 요약 22 px, 결과 영역 최대 min(160 px, 100vh − 640 px), 팝업은 portal |
| 27 | 옛 Chrome 스크립트가 서랍의 testid·placeholder·"Enter = 즉시 실행"에 의존 | D2 U16 | 중 | 식별자 유지. 즉시 실행은 결정(임시안: 유지 — 옛 재난 문장 = 배치 + 지금 실행) |
| 28 | 미리보기 부품: N개 유령은 있으나 매번 재생성, 강조·스냅 표지·유령 핀·획 전체 열 지도가 없음(파일 전용) | U18–U21 E25 | 중 | 이번: 공용으로 옮기고 목록을 받게, `previewStroke`, 계획 해시가 같으면 유지 |
| 29 | 입력 정책에 열린 계획이 없음(옛 미리보기는 컴포넌트 지역 상태) | U22 | 중 | 이번: 계획을 저장소에, 부록 §6.4 표대로 구독 |
| 30 | `scratchWorld(doc)`은 지형 배열을 공유 | E18 | 낮 | 이번: 미리 돌릴 때는 배열을 복제한 문서로 |
| 31 | `createWorldObject`·`update`가 넘긴 객체를 복사하지 않음 | E19 | 낮 | 이번: 계획 객체를 확정 뒤 고치지 않음(시험) |
| 32 | `duplicateSelection`은 `checkStamp`를 안 함 | E26 | 낮 | 이번: 명령은 도장 + `checkStamp`. UI 복제는 그대로(문서) |
| 33 | `newDocument`가 `terrainRect`를 지우지 않음 | E27 | 낮 | 이번(한 줄) |
| 34 | `setNodeElevation`·`moveControl`·`addControl`이 모르는 id를 검사 안 함 | E28 | 낮 | 이번: 명령 해석에서 id 검사(코어는 명령이 부르지 않음) |
| 35 | 구현된 현상을 "미구현 현상"으로 안내, 쓰이지 않는 i18n 키 | D6 D13 | 낮 | 문서(옛 문구는 그대로 — Chrome 기록용) |
| 36 | `LlmParser`는 호출부·시험이 없고 옛 실행 명령 JSON 계약 | D11 D7 | 낮 | 이번: 새 `IntentProvider` + 가짜 공급자. 옛 파일은 그대로 두고 주석 |
| 37 | `src/command` ↔ `src/commands` 한 글자 차이 → 의존 방향 grep 거짓 양성 | D12 E17 | 낮 | 이번: grep 시험은 `@/command/`(끝 빗금까지)로 |
| 38 | 힙 증가 원인 미확인 | E23 | 낮 | 이번: 좁히기(§17), 씨앗 Map 상한 |

## 4. 설계 결정 (감사에서 나온 것)

1. **옛 명령 시스템과의 관계 = 새 `src/command/` + 옛 문법 재사용 + 패널 하나**(부록 disasters-palette §1.12의 (b)).
   - `src/commands/*`와 시험 53건은 동작을 바꾸지 않습니다(한·영 재난 문법의 회귀 기준, `parseCommands`·`__ds.celestialLib.parse` 유지).
   - 새 문법이 **먼저** 봅니다(제어·삭제·배치·선택…). 새 문법이 읽지 못한 문장만 어댑터(`ParsedCommand` → `Intent`)로 넘기고, 어댑터는 값을 실제로 읽는 5종
     (바람·지진·비·수위·물 유입)과 실행 제어만 받습니다. 숫자·위치를 버리는 6종 분기(폭발·운석·싱크홀·산사태·소용돌이·지형 변형)는 넘기지 않습니다.
   - 확정 경로는 하나: `setExperiment`(일괄 단계) → "지금 실행"이면 **이번 명령이 만든 인스턴스만** `runSimulation(specs, keys)`. `commandTarget.runEvents`의 직접 `addEvent`는
     UI 경로에서 뺍니다(`dispatchCommands`는 시험이 쓰므로 파일은 둠).
   - 서랍의 `CommandPanel`을 새 명령창으로 바꾸되 `data-testid="command-input"`·`"command-toggle"`, placeholder의 "Enter", `uiStore.commandOpen/setCommandOpen`을 유지합니다.
   - 위치는 명세 제안대로 `src/command/`(단수)·`src/ui/Command/`. 옛 `src/commands/`(복수)와 이름이 가깝지만 옛 파일을 옮기면 시험·탐침 import를 건드려야 하므로 두고,
     의존 방향 시험의 패턴을 끝 빗금까지 맞춥니다.
2. **일괄 단계 = `worldStore.batch(fn)`**(동기 함수, 중첩은 바깥에 합류, 예외 = 롤백). §2.2의 설계.
3. **미리보기 = 같은 실행을 임시 저장소에서**: 문서를 배열까지 복제한 임시 저장소(E18)에 같은 계획·같은 실행기를 돌리고, 원본과의 **차이**(생긴 것·바뀐 것·지워진 것·지형·도로·재난)를
   그립니다. 한 줄 명령과 스크립트가 같은 경로이고, 미리보기와 확정이 같은 코드를 탑니다. 확정 때 문서가 바뀌었으면 다시 계획해 해시를 비교합니다.
4. **결정론**: 계획의 모든 `CreateObjectInput`에 `subSeed(문서 씨앗, 명령 정규 문자열 해시, 번호)` 씨앗. 객체 순회는 (종류, 일련번호, id) 순 — id만으로 정렬하지 않습니다
   (id는 난수라 스크립트를 다시 돌리면 달라짐; 일련번호는 같음). 문서 비교는 id를 정규화한 지문.
5. **어휘의 단일 출처**: 종류는 `PALETTE`, 재난은 등록부 + `CATALOG`에서 생성하고, 별칭·단위 명사만 표 하나에 새로 둡니다(종류 이름을 문법 파일에 손으로 쓰지 않음). 별칭이 옛 정규식
   `keywords`와 어긋나지 않는지 시험으로 묶습니다.
6. **정규 명령의 수치는 저장 단위**(J, m/s, W, s, K, m, °). 자연어의 "MJ·kW·분·°C·km/s"는 파서가 환산하고 요약에 보여 줍니다.
7. `heading=<°>` = 인스펙터 "Y 방향" 값(마우스 편집과 같은 수). 방위 낱말("북쪽을 보게")은 종류별 앞 축으로 환산하고 요약에 둘 다 표시합니다.
8. 여는 키 `/`(물리 키), 보조 Ctrl/⌘+K. 명령창은 하단 "명령어" 줄 자리, `aria-modal` 없음.

## 5. 구현 계획

커밋 순서(명세 §25: 일괄 실행 취소와 Intent 스키마를 먼저 시험으로 고정):

1. `worldStore.batch` + 시험(비트 동일 되돌리기·다시 하기, 무변화, 롤백, 거부).
2. Intent 스키마(zod) + 정규 명령 파서·포매터(왕복 시험) + 종류 표(팔레트에서 생성).
3. 공유 코어 추출: 한 개 놓기, 그룹·플래그, 재난 칸 접근·잘림·배치, 층수 설계, 프로그램 획 + `previewStroke`, id 정규화 지문.
4. 해석(`resolve`) · 계획(`plan`) · 실행(`apply`) · 미리보기 차이 · 결과 집합 + 시험.
5. 자연어: `normalize` · 어휘 · 규칙 파서(한·영) · 옛 문법 어댑터 · 후보 제시. **말뭉치는 파서를 쓰지 않는 쪽이 정규 문법만 보고 작성**(기대값을 구현 출력에서 복사하지 않기 위해).
6. UI: 명령창(IME·키·Esc 사슬·기록·Tab 완성), 미리보기 층, 모호성 선택, 도움말, 스크립트(`.dscmd.txt`), 맥락 메뉴, 입력 정책 연결, `__ds.command`·`__ds.hash`.
7. Phase 36 잔여(§17): 차 설정 도장, 공통 칸, 아웃라이너, 누수 좁히기.
8. `IntentProvider` 인터페이스 + 가짜 공급자 시험(§16 — 구현 여부는 결정 필요).
9. Chrome `verify-command37.mjs`(S1–S22 한·영) + `look-command37.mjs`, 벤치(파서·계획·유령·누수), 기존 Chrome 전부 다시, v1 동일성, 문서·점검 꾸러미.

갈래(격리 작업 트리 도우미, 병합 전 검토): 자연어 파서 / 말뭉치 / 36 잔여 / UI / Chrome·벤치. 핵심(일괄·스키마·해석·계획·실행)은 주 세션.

## 6. 결정이 필요한 것 (임시안으로 진행하고 문서화)

| 항목 | 선택지 | 임시안 | 근거 |
|---|---|---|---|
| 방위 규약 | — | **기존 그대로**(−z = 북), 나침반은 이미 있음 — 결정 불필요 | §2.5 |
| `heading=<°>`의 뜻 | 인스펙터 Y 방향 / 방위각 | 인스펙터 Y 방향(반시계, 0 = 로컬 +x가 동) | U1 |
| 명령창 여는 키 | `/`, Ctrl/⌘+K, `:` … | `/` + Ctrl/⌘+K | §2.6 |
| 옛 재난 문장의 Enter | 즉시 실행 유지 / 미리보기 → 확정으로 바꾸고 옛 Chrome 기대값 변경 | 유지: 옛 문법 문장 = "배치 + 지금 실행" 한 단계(정규 명령 `disaster … now`) | D2 U16 |
| 실행 중 재난 명령 | 거부 / 마우스처럼 허용(기록 없음) / 실행에만 추가 | 마우스와 같이 허용, 요약에 "실행 취소 기록 없음" 표시. 그 밖의 편집 명령은 거부 | D23 E15 |
| 기록 없는 설정 쓰기와 config 실행 취소 | 그대로 + 문서화 / 바뀐 쪽만 / 설정 쓰기도 기록 | 바뀐 쪽만(settings ↔ scenario가 서로 휩쓸지 않음). scenario 안의 기록 없는 쓰기(홍수·지진 시나리오)는 남음 | E2 |
| 새 객체·그룹 id | 명령만 결정론 id / 해시에서 id 정규화 | 정규화 지문(저장 형식·id 생성 불변) | E3 D37 |
| 같은 이름의 종류("주택") | 모듈식 우선 / 묻기 | 모듈식 우선, 요약에 프리셋 표시. 상자 건물은 `building:boxHouse` 등으로만 | D32 |
| "모두 x=…"에서 다시 앉힘 | 앉힘(그룹 규칙) / 높이 유지(단일 칸 규칙) | 땅에 서 있던 객체는 앉힘(그룹 이동과 같게), 뜬 객체는 높이 유지 | E20 |
| 복제·붙여넣기에서 자율 주행 경로 | 함께 옮김 / 그대로 | 그대로(절대 좌표) — 요약·문서에 표시 | E9 |
| 그룹 이름을 도장이 따라가게 할지 | 같은 이름 / "…사본" / 안 따라감 | 안 따라감(기존 동작) — 명령은 `name=`으로 지정 | E10 |
| LLM 어댑터(§16) | 안 함 / 인터페이스만 / 구현 | 인터페이스 + 가짜 공급자 시험만 | 명세 §26 |
| 작은 편집 바로 적용 기본값 | 켬 / 끔 | 끔 | 명세 §26 |
| 교차로 마감 높이 계단(36 §26) | 고침 / 유지 | 유지 — 손대지 않음 | 명세 §26 |
| 명령 스크립트를 문서에 저장 | 안 함 / 선택 칸 | 안 함 | 명세 §26 |

## 7. 위험

- **옛 Chrome 24개 × 한·영**: 서랍을 바꾸므로 전부 다시 돌려야 합니다. 식별자·"Enter = 실행"을 지켜도 서랍 높이·초점 순서가 바뀌면 깨질 수 있습니다.
- **규칙 파서의 범위**: 한국어 띄어쓰기 없음·조사 변이·수사를 사전 기반 최장 일치로 다룹니다. 말뭉치 밖의 문장은 "모름 + 후보"가 정상 동작입니다(추측 실행 0건이 기준).
- **미리보기 비용**: 임시 저장소 실행은 글자마다 문서 배열 복제(1.1 MB) + 계획 + 실행입니다. 디바운스와 시간 예산(§22), 계획 해시가 같으면 유령을 다시 만들지 않는 것이 전제입니다.
- **8 GB 기기**: Chrome 검증은 `chrome-lanes.sh`로 한 번에 2개 이하, 전체 시험과 동시에 돌리지 않습니다. 다른 세션이 돌고 있어 성능 수치는 부하와 함께 적습니다.
