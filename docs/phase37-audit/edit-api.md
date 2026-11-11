# Phase 37 사전 감사 부록 — 편집 API · 일괄 실행 취소 · 식별자 · Phase 36 잔여

기준 커밋 `d5b5896`(main). 저장소 소스는 **읽기만** 했습니다(시험·tsc·vite·Chrome 실행 없음, 다른 세션이 도는 8 GB 기기).
경로는 따로 쓰지 않으면 `src/` 기준입니다. 범위는 명세 §3의 **1 · 2 · 7 · 9번**입니다.

표기: **(C)** = 코드를 읽어 확인한 것, **(S)** = 읽어서 생긴 추측 — 실행으로 확인해야 하는 것. **표의 행과 줄 근거가 붙은 문장은 따로 (S)라고 쓰지 않았으면 모두 (C)입니다.**
결함·빈 곳은 §5 표에 E1…로 번호를 매겼습니다. 이 부록은 `docs/PHASE37_PREIMPLEMENTATION_AUDIT.md`(본문)가 인용하는 근거 자료입니다.

---

## 0. 먼저 결론

1. **(2)의 답 — "부분적으로만 됩니다."** `applyEdit` **한 번**에 담을 수 있는 것(객체 추가·수정·삭제 + 도로 + 지형 층(`landscape.layers / features / base`) + `settings` 통째 + `scenario` 통째)은
   지금도 기록 항목 하나입니다 (C, `world/worldStore.ts:592-609`). 그러나 다음은 **지금 구조로는 한 단계가 안 됩니다**(E1).
   - 그룹 이름(`groups`) — `WorldEdit`에 칸이 없고 `setGroupName`이 따로 한 단계 (C, `:138-164`, `:719-733`).
   - 새로 만든 객체의 id에 묶이는 차 설정 — `CreateObjectInput`에 id가 없어 `applyEdit`가 끝나야 id를 앎 → 두 번째 호출 = 두 번째 단계 (C, `world/WorldDocument.ts:43-59`, `:75`, `:87`).
   - 획 API(`beginTerrainStroke / terrainDab / endTerrainStroke`), `setExperiment`, `setWaterLevel`, `duplicate` 같은 **개별 액션의 조합**, 그리고 앞 줄의 결과를 뒷줄이 쓰는 **스크립트**.
   - `updateSimulationSettings` · `setEarthquakeScenario` · `setFloodScenario`는 기록이 없어서 묶을 대상조차 아님 — 게다가 뒤에 오는 실행 취소에 **휩쓸립니다**(E2).
   → 명세 §10의 `batch`가 필요합니다. 필요한 것과 지켜야 할 불변식은 §2.6–§2.8.
2. 명령 층은 `app/*Actions.ts`의 **액션을 부르면 안 됩니다.** 액션은 선택·도구·패널 저장소를 읽고, 토스트를 올리고, 실패를 삼켜 `void`를 돌려줍니다(§1). 대신
   이미 있는 **순수 코어**(`transformObjects`, `alignObjects`, `distributeGaps`, `matchObjects`, `copyProperties`, `checkStamp`, `checkPlacement`, `planPlacement`, `planForest`, `drawRoad` 등)
   + `applyEdit`를 써야 합니다. 순수 코어가 **없는** 곳은 단일 배치(PlaceTool 안에만 있음, E4), 그룹 만들기/풀기, 플래그, 공통 칸 편집, 지형 프로그램 획입니다(§1.10).
3. 새 객체 id는 `crypto.randomUUID`, 씨앗 미지정 시 `Math.random` (C, `core/id.ts:3-10`, `world/WorldDocument.ts:70`) → 같은 스크립트라도 **결과 문서 해시가 실행마다 다릅니다**(E3).
4. 사람이 부르는 이름은 **객체 `name`과 그룹 이름뿐**입니다. 도로 구간·노드·지형 요소·재난 인스턴스에는 이름 칸이 없습니다("큰길"은 저장된 이름이 아님, §3, E16).
5. Phase 36 §26 잔여 다섯 가지의 현재 코드 경로는 §4. 차 설정은 도장 경로 **네 곳 모두** 새 id를 알 수 있는데도 쓰지 않습니다(§4.1).

---

## 1. 편집 API별 부수 효과 (명세 §3-1)

### 1.0 공통 관찰

- "편집 가능" 검사가 **세 가지 모양**입니다 (C).
  | 어디 | 검사 | 막혔을 때 |
  |---|---|---|
  | `app/buildActions.ts:28` `editable()` | `mode === 'editor' && !locked` | **조용히** return |
  | `app/roadActions.ts:29-35`, `app/natureActions.ts:36-42` `locked()` | 같은 조건 | 토스트 `road.locked` / `nature.locked` 후 return |
  | `app/blueprintActions.ts:37-43` `editable()` | 같은 조건 | 토스트 `bp.locked` 후 `false` |
  | `world/worldStore.ts` 각 액션 | `locked`만(모드는 모름) | 조용히 return / `[]` / `null` |
- `worldStore`는 UI 저장소를 읽지 않고 토스트도 없습니다(C, `world/worldStore.ts:1-35` import 목록). 선택은 직접 바꾸지 않지만, `doc.objects`가 바뀔 때마다
  `app/inputPolicy.ts:103-109`가 없어진 id를 선택에서 뺍니다(C).
- `worldStore`의 실패 신호는 셋입니다: **throw**(도로망 무효·중복 id·지형 합성 오류), **빈 값**(`[]`/`null`/`false`), **아무 신호 없음**(void). 잠금으로 막힌 것과
  "추가한 것이 없음"은 둘 다 `[]`라서 구별되지 않습니다 (C, `:593`).

### 1.1 `worldStore` (`world/worldStore.ts`)

| API | 시그니처 → 반환 | `locked` | 기록(`past`) | 실패·무동작 | 비고 |
|---|---|---|---|---|---|
| `applyEdit` | `(edit: WorldEdit, opts?: {history?}) → EntityId[]`(추가 id, `add` 순서) `:186`, `:592-609`, `:531-544` | `[]`, 조용함 `:593`, `:515` | 1단계. `settings`/`scenario`가 있으면 **같은 항목**에 `config`를 붙임 `:604-605`. 도로·지형 분기는 `history:false`를 **무시**하고 항상 기록 `:560-562`, `:387` | **throw**: 도로망 무효 `:532`·`:486`, 중복 id `:541`, 지형 합성 오류(배열 복원 뒤 재-throw) `:496-510`. 모르는 id의 `update`/`remove`는 조용히 건너뜀 `:518-530` | 무변화 판정이 약함(E5): 같은 객체를 `update`해도 `changed = true` `:524-530` → 빈 단계. `roads`가 있으면 옮긴 객체의 도로 연결을 다시 재지 않음 `:528` |
| `addObject(s)` | `→ EntityId` / `EntityId[]` `:588-590` | 위와 같음 | 1단계 | 위와 같음 | `applyEdit({add})` |
| `beginTransaction` | `() → void` `:857-861` | 조용히 무시(`tx` 그대로 null) | 없음 | 이미 열려 있으면 **조용히 덮어씀**(E24) | 객체 맵 참조와 `docVersion`만 잡음 `:127-130` |
| `commitTransaction` | `() → boolean` `:863-872` | `false` | 객체가 바뀌었으면 1단계, 아니면 0 `:868` | 열린 것 없음·문서 교체됨 = `false` `:867` | **객체만** 되돌림 — 그 사이의 scenario·도로·그룹 이름 쓰기는 담지 않음 `:869-870` |
| `cancelTransaction` | `() → void` `:874-881` | 무시 | 없음 | — | 객체 맵만 복원 |
| `busy` | `() → boolean` `:883` | — | — | — | `stroke !== null ∨ tx !== null` |
| `setGroupName` | `(group, name) → void` `:719-733` | 조용히 return `:721` | 1단계(`groupNames`) `:728-732` | 같은 이름이면 무동작 `:724`. **그룹이 실제로 있는지 검사 안 함** | trim + 80자 `:722`. `''` = 이름 삭제 |
| `setExperiment` | `(patch, opts?) → void` `:735-745` | **적용하되 기록 안 함** `:739-742`(E15) | 1단계(`config` = settings + scenario 통째) `:743-744` | 같은 값이어도 기록(E5) | `placementActions`·실험 패널이 씀 |
| `duplicate` | `(id) → EntityId ∣ null` `:631-668` | `null` `:632` | 1단계. 차 설정이 있으면 `config` 포함 `:656-664` | 없는 id = `null` | +2 m, 그룹·잠금 뗌 `:641-651`. 탑승자는 복사 안 함 `:658`. **경계 검사 없음**(E12) |
| `rename` | `(id, name) → void` `:622` | 조용함(`commit`) | 1단계 | 같은 이름이어도 기록 | trim·길이 제한 없음 |
| `remove` | `(ids) → void` `:624-629` | 조용함 | 지운 것이 있을 때만 | — | 잠금 **객체**(`o.locked`)는 검사 안 함(액션 쪽 책임) |
| `updateTransform/Params/Physics/Seismic` | `(id, patch, opts?) → void` `:611-617`, `:706-712` | 조용함 `:335` | 1단계 / `history:false`면 0 | 없는 id 조용히 return `:574` | 움직이면 도로 연결 다시 잼 `:575` |
| `updateSimulationSettings` | `(patch) → void` `:675-704` | **검사 없음**(잠금 중에도 문서를 씀) | **없음** | — | `vehicles: null`이면 차 설정 전체가 사라지고 되돌릴 수 없음(`ui/Inspector/SimulationSettings.tsx:87-88`) |
| `setEarthquakeScenario`, `setFloodScenario`, `setProjectName` | `:714-717`, `:747-751`, `:670-673` | 검사 없음 | 없음 | — | "Not an undo step" `:209-212` |
| `beginTerrainStroke` | `() → void` `:770-773` | 조용히 무시 | 없음 | 열려 있으면 **덮어씀**(E24) | 지형 3층 전체 복사(`snapshotLayers`) |
| `terrainDab` | `(DabOptions) → GridRect ∣ null` `:775-784` | `null` | 없음 | 획이 없으면 **스스로 시작** `:777` | 배열을 제자리에서 고침, `set()` 안 부름 → 구독자는 모름 |
| `endTerrainStroke` | `() → void` `:804-808` | 검사 없음 | 사각형이 있으면 1단계(`finishLayered`) `:348-370` | 사각형 없음 = 무동작 | 변화량이 0이어도 기록될 수 있음 (S) |
| `cancelTerrainStroke` | `() → GridRect ∣ null` `:810-826` | — | 없음 | — | 돌려준 사각형을 호출자가 `markTerrainDirty`해야 화면이 돌아옴 |
| `setWaterLevel` | `(level) → void` `:835-849` | 조용히 return | 1단계(설정만이어도 **1꼭짓점 패치**) `:842-848` | — | E8 |
| `applyTerrainPreset`, `setFeatures` | `:828-833`, `:885-888` | 조용히 return | 1단계 | throw 가능(지형 합성) | 같은 feature 배열을 넘겨도 기록 `:471-495`(E5) |
| `replaceDocument`, `newDocument` | `:753-768` | **조용히 return**(E14) | 기록 초기화, `docVersion+1` | — | `stroke`·`tx` 폐기 `:755-756`. `newDocument`는 `terrainRect`를 안 지움 `:767`(E27) |
| `undo`, `redo` | `:890-908` | 조용히 return | — | 획·트랜잭션 열림 = 조용히 return `:893`, `:903` | 되돌릴 것이 없다는 신호 없음 |
| `checkpoint` | `:851-855` | 조용히 return | 현재 상태로 1단계 | — | 빈 단계를 만들 수 있음(옛 API) |

### 1.2 `app/buildActions.ts`

모두 `world()`·`editor()` 저장소를 직접 읽습니다(`:26-28`). "순수 코어" 열은 명령 계획기가 저장소 없이 부를 수 있는 함수입니다.

| 액션 | 시그니처 → 반환 | UI 저장소에서 읽는 것 | 토스트 | 선택 변경 | 조용한 무동작 | 순수 코어 |
|---|---|---|---|---|---|---|
| `setObjectFlags` `:64-82` | `(ids, {locked?, hidden?}) → void` | 모드 | 없음 | `hidden: true`면 넘긴 id를 **전부** 선택에서 뺌 `:81` | 편집 불가, 모르는 id | **없음** → 추출 필요(`withFlags(objs, flags)`). 바뀐 것만 `update`에 넣는 판정은 있음 `:77` |
| `selectSameType` `:105-115` | `() → number` | 주 선택 | 없음 | **선택 교체**(숨김·잠금 제외) | 주 선택 없음 = 0 | **없음** → `kind()` 규칙 `:110`을 `sameKind(objs, ref)`로 |
| `alignSelection` `:195-200` | `(axis, mode, ref='origin') → void` | 선택 | 잠긴 것이 섞이면 `ed36.lockedSkipped` `:155` (개수 검사보다 **먼저**) | 없음 | 2개 미만, 편집 불가 | `alignObjects(objs, axis, mode, terrain, ref)` `editor/build/groupTransform.ts:96-107` |
| `distributeGapsSelection` `:203-208` | `(axis) → void` | 선택 | 위와 같음 | 없음 | 3개 미만 | `distributeGaps` `groupTransform.ts:113-128` |
| `distributeSelection` `:234-239` | `(axis) → void` | 선택 | 위와 같음 | 없음 | 3개 미만 | `distributeObjects` `groupTransform.ts:156-168` |
| `matchSelection` `:226-232` | `(what) → void` | 선택·주 선택 | 위와 같음 | 없음 | 주 선택 없음 | `matchObjects(objs, ref, what, terrain)` `groupTransform.ts:137-153` |
| `copyPropertiesFromPrimary` `:214-223` | `(props) → {applied, skipped}` | 선택·주 선택 | **항상** `ed36.copy.done` `:221` | 없음 | 주 선택 없음 = `{0,0}` | `copyProperties(ref, targets, props, terrain)` `editor/build/propertyCopy.ts:39-64`(잠긴 대상은 코어가 건너뜀 `:43`) |
| `transformSelection` `:187-193` | `(RigidDelta, pivot?) → void` | 선택 | 잠금 알림 | 없음 | 선택 없음 | `transformObjects(objs, pivot, d, terrain)` `groupTransform.ts:53-75`, `selectionPivot` `:30-40` |
| `groupSelection` `:242-249` | `() → void` (**그룹 id를 돌려주지 않음**) | 선택 | `build.toast.grouped` | 없음 | 2개 미만 | **없음**. id는 `createId('grp')`(난수) `:246`. 잠긴·숨긴 것도 묶음 |
| `ungroupSelection` `:251-262` | `() → void` | 선택 | `build.toast.ungrouped` | 없음 | 그룹 없음 | **없음**. 그룹 **이름을 지우지 않음**(E10) |
| `duplicateSelection` `:169-184` | `() → void` | 선택 | 없음 | 사본으로 교체 `:176`, `:183` | 선택 없음 | `createBlueprint` + `instantiateBlueprint` `editor/build/blueprint.ts:74-166`. **`checkStamp` 없음**, 잠긴·숨긴 것도 복제(사본은 플래그 없음, E26) |
| `deleteSelection` `:159-166` | `() → void` | 선택 | 잠금 알림 | 지운 id 제거 | 남는 것이 없으면 무동작 | 없음(필터 한 줄) |
| `copySelection` `:266-274` | `() → boolean` | 선택, `tool`, `buildStore.clipboard` 씀 | `build.toast.copied` | 없음 | 선택 없음 = `false` | `createBlueprint` |
| `startPaste` `:289-296` | `() → void` | 클립보드 | 비었으면 `build.toast.clipboardEmpty` | 도구를 `paste`로(선택은 그대로 — `editor/editorStore.ts:142-145`, `:16`) | 편집 불가 | — (도구 무장) |
| `pasteAt` `:299-333` | `(x, z) → EntityId[]` | 클립보드, `pasteYaw`, `roadPaste`, `tool` | 월드 밖 `ed36.paste.outside`, 도로 오류 `road.error.invalid` | 사본으로 교체, `roadStore.select` | 클립보드 없음 = `[]` | `instantiateBlueprint` + `checkStamp` + `pasteRoads`(`roads/blueprintRoads.ts`) |
| `commitPlan` `:338-357` | `(plan, itemId) → EntityId[]` | `buildStore.setLastResult / pushRecent` 씀 | 성공·실패 토스트, `console.error` | 없음 | 받아들인 항목 없음 = `[]` | `planPlacement`(§1.4) + `acceptedInputs` |
| `selectAll` `:140-143` | `(category?) → void` | — | 없음 | 교체(**숨김·잠금 포함**) | — | 없음 |
| `clickSelect` / `boxSelect` / `selectFromHits` `:49-58`, `:88-99`, `:124-138` | — | 선택, 모듈 변수 `lastPick` `:117` | 없음 | 그룹 단위 | — | `expandGroups(ids)` `:36-43`도 `world()`를 읽음(순수 아님) |

### 1.3 카메라 (`app/actions.ts`)

| 함수 | 읽는 것 | 부수 효과 |
|---|---|---|
| `focusSelection()` `:59-76` | `editorStore.selectedIds / selectedId`, 문서 | `viewStore.setFollow(null)` + `requestFocus`. 문서·기록 불변. 모드 검사 없음(실행 중에도 됨). 선택 0–1개면 `focusObject`로 넘어감 |
| `focusObject(id)` `:44-53` | 문서, 런타임 자세 | **선택을 그 객체 하나로 바꿈** `:47` — "보여 줘" 명령이 선택을 바꾸는 부수 효과 |
| `focusPosition(pos, id?)` `:79-83` | — | id를 주면 선택 변경 `:80` |

순수 코어 없음: 경계 계산(`:66-73`)을 `selectionBounds(objs)`로 빼면 명령의 `focus <대상>`(선택이 아닌 대상)과 함께 쓸 수 있습니다.

### 1.4 스냅 · 배치 검사 (순수)

| 함수 | 시그니처 | 성질 | 명령에서 조심할 것 |
|---|---|---|---|
| `snapPoint` `editor/snap/snapEngine.ts:204-258` | `(q: SnapQuery, env: SnapEnv) → SnapTarget` | **순수**(저장소·시각·난수 없음, 동률은 `ref` 문자열로 정렬 `:234`) | ① `roadNode`가 종류와 무관하게 최우선(`:91-96`, `:35`) → 구간 끝 3 m 안의 건물 질의는 **교차로 한가운데**로 붙음: 도로 접면 배치 때 `disabled: {'roadNode'}` 필요 ② 접면은 **질의점이 놓인 쪽**(`h.side`)으로 정해짐 `:118` → "북쪽"은 질의점을 북쪽에 놓아야 함 ③ 허용 거리는 질의점 ↔ 스냅점 3 m `:33`, `:254` — 벗어나면 조용히 격자로 떨어짐 ④ `env.objects`는 `WorldObject[]`(id·hidden·building 읽음 `:128-176`) → 같은 명령에서 앞서 계획한 건물과 맞닿게 하려면 **임시 객체**를 넣어야 함 ⑤ `prev`(히스테리시스)는 넘기지 않음 ⑥ 교차로 트림을 모름 → 교차 도로 위에 놓일 수 있음(`roads/city.ts:48 footprintOnRoad`로 따로 검사) |
| `footprintHalves` `snapEngine.ts:261-264` | `(type, params, scale?) → [hx, hz]` | 순수 | `SnapQuery.half` |
| `checkPlacement` `editor/build/placementCheck.ts:67-121` | `(obj, terrain, slopeLimit=90) → {slope, gap, bury, warnings}` | 순수 | 명세가 부르는 `placementCheck`는 **파일 이름**이고 함수는 `checkPlacement`(E17). `'outside'`·`'overlap'`은 **내지 않음** — 호출자가 조립(`PlaceTool.tsx:100-106`, `placementPlan.ts:136-151`) |
| `checkStamp` `placementCheck.ts:30-48` | `(inputs, existing: FootprintIndex ∣ null) → {ok, items[]}` | 순수 | 월드 밖이 하나라도 있으면 `ok:false`(도장 전체 거부). 경사·물·바퀴 검사는 안 함 |
| `planPlacement` `editor/build/placementPlan.ts:104-156` | `(item, points, settings, ctx, startIndex=0, plannedIndex?) → PlannedObject[]` | **순수·결정론**(`Rng(subSeed(seed,'obj',i))` `:112`, 입력마다 `seed`를 채움 `:117`, `:131`) | "N개를 이 점들에" 의 코어. `randomRotation:false` + 점의 `yaw`로 스냅 방향을 줌 `:118-126`. 항목별 `ok / rejected / warnings` |
| `isInsideWorld` `editor/placement.ts:12-18` | `(pos, dims, yaw) → boolean` | 순수 | ±100 m (`core/units.ts:12-13`) |
| 단일 배치 | — | **순수 코어 없음**(E4) | 유령 객체·무작위 변형·스냅·자세·경고·`addObject`가 전부 `editor/tools/PlaceTool.tsx:73-151` 컴포넌트 안. `variant`는 `Math.random` `:63`, `:151`. `itemDesign('custom')`은 `buildStore`를 읽음(`editor/build/itemDesign.ts:18`) |

이름이 같은 다른 함수(혼동 주의, E17): `editor/placement.ts:5 snapPoint`(옛 격자), `app/blueprintActions.ts:260 snapPoint`(격자, `ED().snap`·`buildStore`를 읽음), `editor/tools/RoadTool.tsx:35 snapPoint`(모듈 비공개).

### 1.5 도로 (`app/roadActions.ts`, `editor/tools/RoadTool.tsx`, `roads/network.ts`)

- **확정 규칙은 이미 순수 함수에 있습니다** (C). `drawRoad(net, points, {curved, profile}) → {network, segments, splits}` `roads/network.ts:159-211`:
  끝점이 노드 3 m 안이면 그 노드(`SNAP_NODE` `:12`, `:165`), 아니면 **도로 가장자리 + 2 m 안이면 그 구간을 분할**(`findSegment`의 `tol = 2 + width/2` `:83`, `:13`, `:167-170`),
  기존 도로와 교차하면 양쪽을 분할해 십자(`crossings` `:216-237`, `:185-192`), 끝에서 2 m 안의 분할은 끝 노드를 씀(`splitAt` `:121-140`), 결과는 `assertValid` `:209`.
- RoadTool이 `drawRoad` **앞에서** 하는 일만 UI에 있습니다: 클릭 점을 노드 > 도로 > 격자 순으로 맞추고(`RoadTool.tsx:35-42`) cm로 반올림해(`:298`) `roadStore.draft`에 쌓고,
  끝낼 때 `finishDraft()`가 `roadStore`의 `draft / mode / profile`로 `drawRoad`를 부릅니다(`roadActions.ts:50-68`). 월드 경계 검사도 UI에만 있습니다(`RoadTool.tsx:267-270` `sampler.inside`).
  → 명세 §8의 "순수 함수 추출"은 **`RoadTool.tsx:35-42`를 `roads/network.ts`로 옮겨 공유**하고(예: `snapDraftPoint(net, x, z, grid, band)`), 경계 검사를 코어 옆에 두면 끝납니다.

| 액션 | 반환 | 읽는 UI 상태 | 토스트 | 조용한 무동작 / 삼킨 실패 | 순수 코어 |
|---|---|---|---|---|---|
| `finishDraft` `:50-68` | `boolean` | `roadStore.draft/mode/profile` | 잠금, 너무 짧음, 무효 | 점 2개 미만 = draft 비우고 `false` | `drawRoad` |
| `placeRoadPiece` `:76-87` | `string[] ∣ null` | 없음(인자만) | 위와 같음 | — | `drawRoad` + `PROFILE_PRESETS` |
| `deleteRoadSegments` `:89-92` | void | `roadStore.select` 씀 | 잠금·무효 | 빈 목록 | `deleteSegments` `network.ts:321-328` |
| `splitRoadAt` `:94-102` | void | 〃 | `road.error.split` | — | `splitSegment` `network.ts:247-257`(끝 2 m 안이면 throw) |
| `mergeRoadsAt` `:104-112` | void | 〃 | `road.error.merge` | — | `mergeAtNode` `network.ts:270-291`(`null` = 못 합침) |
| `updateRoadProfile` `:114-117` | void | — | 잠금·무효 | 빈 목록 | `setProfile` `network.ts:367-371`(모르는 id 무시, 값은 `sanitizeProfile`로 잘림 `:95-108`) |
| `moveRoadNode / moveRoadControl / addRoadControl / setRoadNodeElevation` `:119-137` | void | — | 〃 | — | `moveNode :330`, `moveControl :344`, `addControl :354`, `setNodeElevation :338` — 뒤 셋은 **모르는 id 검사 없음**(E28) |
| `addBuildingsAlong / addVehiclesAlong / addInfrastructure / fillBlocks / placeNeighborhood` `:179-247` | void | `roadStore.linkPolicy` | `road.city.placed` | — | `buildingsAlong / vehiclesAlong / infrastructureAlong / fillBlock / neighborhood` `roads/city.ts:250`, `:435`, `:323`, `:514`, `:591` — `CityContext`만 받는 **순수 계획기** |

- 도로 액션의 공통 `commit()`(`roadActions.ts:38-47`)이 `applyEdit`의 throw를 토스트로 바꾸고 `null`을 돌려주지만, 대부분의 액션은 그 값을 버립니다 → **명령은 성공 여부를 알 수 없음**(E11).
- 도로 옆 건물 배치 코어가 **두 개** 있습니다: `roads/city.ts:115 frontage()` / `:250 buildingsAlong()`(Phase 18 — `setback` 인자, 교차로 트림·끝 여유, `roadLink`를 붙임)과
  `snapEngine`의 `roadFront`(Phase 36 — 뒤로 1 m 고정 `:39`, 트림 없음, `PlaceTool`은 `roadLink`를 안 붙임 `PlaceTool.tsx:143-149`). 명세 §8·S4는 뒤쪽을 고릅니다 — 보고서에 차이를 적어야 합니다.
- 무변화 도로 편집도 한 단계가 됩니다: `deleteSegments(net, [없는 id])`·같은 값의 `setProfile`은 **새 객체**를 돌려주고(`network.ts:19 clone`), `applyEdit`는 참조가 다르면 패치가 없어도 기록합니다(`worldStore.ts:552-565`) (C, E5).

### 1.6 지형 (`terrain/TerrainEditor.ts`, `world/worldStore.ts`, `editor/tools/TerrainTool.tsx`)

- `applyDab(t, o) → GridRect | null` `TerrainEditor.ts:88-…` : **넘겨받은 `TerrainData`를 제자리에서 고치는** 함수(저장소·UI 없음). `revision++`. 스크래치 사본에 부르면 문서는 안 바뀝니다.
- `previewDab(t, o, seconds=1, step=1/20) → DabPreview | null` `:263-295` : 브러시 사각형(+1꼭짓점 테두리)을 복사해 **진짜 `applyDab`**를 `round(seconds/step)`번 돌립니다. 문서 불변. **찍기 하나(한 자리) 전용**입니다.
- UI 획: `onDown`에서 `beginTerrainStroke`, `flatten` 목표 높이는 **누른 점의 높이**(`TerrainTool.tsx:285 target: hit[1]`), `slope`는 획 시작 높이 사본(`strokeHeights()`); 매 프레임
  `dabPath`로 보간한 점마다 `terrainDab`(`:194-204`, `dt = min(프레임 dt, 1/20) / 점 수` `:198`) → `markTerrainDirty(rect)` `:206`; 놓으면 `endTerrainStroke`, Esc면 `cancelTerrainStroke` + `markTerrainDirty` `:287-300`.
- 브러시 설정은 `editorStore`에서 읽습니다(`dabOptions` `TerrainTool.tsx:131-139`, **모듈 비공개**): `brushRadius/Strength/Falloff/Shape/Seed/Min/Max`, `paintType`, `soilType`.

명령에 미치는 것 (E25):
1. **미리보기 ≠ 확정 결과.** 확정(`commitTerrain` `worldStore.ts:348-370`)은 Δh를 조각 층에 접어 넣은 뒤 자연 지형을 다시 합성하고 **도로를 다시 굽습니다**(`landscape/apply.ts:61-68`). 도로 밑·강 주변은
   브러시대로 남지 않고, 땅에 선 객체는 바뀐 사각형 ±40 m 안에서 다시 앉습니다(`worldStore.ts:258-285`, `:381-383`). `previewDab`의 열 지도에는 이것이 없습니다 (C).
2. 미리보기와 확정이 같으려면 명령이 **같은 찍기 수·같은 `dt`**(= `seconds / round(seconds/step)`)로 돌려야 합니다(`TerrainEditor.ts:279-280`).
3. 원 하나가 아닌 영역(사각형, 큰 원)은 찍기 여러 개 → `previewDab`로는 못 봅니다. 스크래치 격자에서 프로그램 획 전체를 돌리는 순수 함수가 필요합니다(추출 대상, §1.10).
4. 획 API로 직접 쓰면(`terrainDab`) 화면 갱신은 호출자가 `markTerrainDirty`를 불러야 합니다(`rendering/terrain/terrainDirty.ts:9-11`, `TerrainLayer.tsx:122-138`).
5. **획 없이도 됩니다**: 스크래치에서 계산한 Δh·지표·토양을 `applyEdit({ landscape: { layers: { rect, sculpt, paint, soil } } })`로 넣으면 객체·도로와 **같은 기록 항목**입니다
   (`worldStore.ts:113`, `:460-469` — 조각 층에 더하는 식이 `commitTerrain` `:362-363`과 같음). 두 경로의 결과가 비트 동일한지는 시험으로 확인해야 합니다 (S).
6. `noise` 브러시는 씨앗마다 `ValueNoise`를 모듈 Map에 **영구 보관**합니다(`TerrainEditor.ts:81-86`) — 명령 해시로 씨앗을 만들면 명령마다 하나씩 쌓입니다(§4.5 후보).

### 1.7 자연물 (`app/natureActions.ts`)

| 함수 | 성질 | 근거 |
|---|---|---|
| `planForest(points, f = N().forest, ctx?, stroke = 0)` `:265-299` | **`f`와 `ctx`를 둘 다 넘기면 순수·결정론.** 기본 인자가 `natureStore`·`worldStore`를 읽음 `:265-266`. 반환 `{inputs, rejected, reasons}` — 사유는 `elevation / water / ground / soil / road / placement` `:256` | 객체는 id 순으로 색인 `:269`, 나무마다 `Rng(subSeed(f.seed, 'forest'+stroke, i))` `:283` |
| `forestStrokeKey(x, z)` `:233-235` | 순수(시작점 cm 해시, 0 아님) | 명령은 정규 문자열 해시를 `stroke`로 |
| 점 만들기 | 브러시는 `BrushScatter`(`editor/build/distribution.ts:68`), 영역은 `areaFill(shape, opts)`(`distribution.ts:284`) — 둘 다 순수 | "forest <영역> density=…"는 `areaFill` → `planForest` |
| `commitForest(points)` `:301-307` | UI 전용: 모듈 변수 `scatter`·`strokeKey` `:224-226`, `N().forest`, 토스트, void | 명령은 쓰지 말 것 |
| `commitFeatures(features, next?)` `:50-61` | `boolean`. 잠금 토스트, 오류 토스트, 기초 경고 토스트 `:64-78` | 코어는 `applyEdit({landscape:{features, next}})` |
| `placePeak`, `finishNatureDraft`, `updateFeature`, `deleteFeature` `:80-153` | `natureStore.params / draft / select`를 읽고 씀 | 지형 요소 id는 `f<next>` `:44-47` |
| `applyEnvironment(kind, seed)` `:315-334` | 객체가 있으면 **`window.confirm`** `:317` | 코어 `buildEnvironment(kind, seed)` (`landscape/presets.ts:70`) |

### 1.8 새 월드 · 프리셋 · 템플릿 · Blueprint

| 함수 | 대화상자 | 하는 일 | 근거 |
|---|---|---|---|
| `newProject` | 객체가 있으면 `confirm('confirm.new')` | `newDocument` → `updateSimulationSettings({structure: v2})` → **기록 비움** | `app/actions.ts:157-164` |
| `loadStructureLab` | 〃 | `replaceDocument` → `applyEdit({roads})` → `addObjects` → v2 → 기록 비움 | `actions.ts:305-314`, 코어 `world/defaultTown.ts:112-132` |
| `loadSampleTown`, `loadClassicSampleTown`, `loadStressScene` | **없음 — 확인 없이 월드를 바꿈** | 위와 같은 순서 | `actions.ts:316-336`, `:167-173` |
| `loadFirePreset / VolcanoPreset / AtmosPreset / ClimatePreset / GravityDemo / CelestialDemo` | 객체가 있으면 confirm | 새 월드 | `actions.ts:177`, `:196`, `:218`, `:238`, `:264`, `:283` |
| `applyTerrainPreset(preset, seed)` | **항상** confirm(빈 월드에서도) | 잠금이면 저장소가 조용히 무시하는데도 **성공 토스트** | `actions.ts:150-155`, `worldStore.ts:829` |
| `applyTemplate(id, seed, mode, name?)` | 액션에는 없음 — **호출하는 UI가** confirm(`ui/Blueprints/BlueprintPanel.tsx:190`, `ui/TopBar/TopBar.tsx:107`) | `'new'` = `replaceDocument`, `'replace'` = `applyEdit` 한 번(객체·도로·지형·settings·scenario 한 단계). **async** | `app/blueprintActions.ts:414-446` |
| `confirmPlacement()` | 없음 | `blueprintStore.place`의 고정점·옵션으로 `planPlacement` → `applyEdit(plan.edit)`. 토스트, 모듈 변수 `lastPlacement` | `blueprintActions.ts:357-387`. 코어 `blueprints/place.ts:173 planPlacement(doc, bp, options, existing?)` — 문서만 읽지만 그룹 id는 `createId` `:406` |
| `deleteEntry` | `confirm('bp.confirmDelete')` | 라이브러리 항목 삭제 | `blueprintActions.ts:79-86` |
| `commitDesign(id, design, {confirm?})` | 지지 잃는 부재가 늘면 confirm — **주입 가능** | 이 패턴(`opts.confirm ?? window.confirm`)을 명령용으로 넓히면 됨 | `app/buildingActions.ts:37-61` |

`window.confirm` / `prompt` 전체 목록 (C, `grep`): `app/actions.ts:152, 158, 177, 196, 218, 238, 264, 283, 306`, `app/natureActions.ts:317`, `app/blueprintActions.ts:82`, `app/buildingActions.ts:50`,
`ui/TopBar/TopBar.tsx:107`, `ui/Blueprints/BlueprintPanel.tsx:185`(prompt)·`:190`, `ui/Building/BuildingPanel.tsx:120`.

### 1.9 명령에서 부를 때 막히거나(대화상자) 조용히 아무것도 안 하는 경로

| # | 경로 | 무슨 일이 생기나 | 근거 | 구분 |
|---|---|---|---|---|
| B1 | `newProject`, `loadStructureLab`, 프리셋 6종, `applyEnvironment` | 객체가 있으면 **동기 `window.confirm`** — 명령창·헤드리스 Chrome이 멈춤 | §1.8 | 대화상자 (C) |
| B2 | `applyTerrainPreset` | 항상 confirm | `actions.ts:152` | 대화상자 (C) |
| B3 | `commitDesign` | 조건부 confirm(주입으로 피할 수 있음) | `buildingActions.ts:50` | 대화상자 (C) |
| B4 | 잠금 중 `applyEdit` / `addObjects` | `[]` — "추가 0개"와 구별 안 됨 | `worldStore.ts:593` | 조용함 (C) |
| B5 | 잠금 중 `replaceDocument` / `newDocument` 뒤따르는 `updateSimulationSettings` + `setState({past: [], future: []})` | 문서는 그대로인데 **구조 모델 설정이 바뀌고 실행 취소 기록이 지워짐** | `actions.ts:160-163`, `:309-313`, `worldStore.ts:754`, `:764`, `:675` | 조용한 손상 (C; UI에서 닿는지는 S) |
| B6 | 잠금 중 `setExperiment` | 문서에 적용되지만 기록 없음 → 실행이 끝나도 남고 Ctrl+Z로 안 사라짐 | `worldStore.ts:739-742` | 조용함 (C) |
| B7 | `buildActions`의 모든 편집 액션 | 편집 불가면 아무 신호 없이 return | `buildActions.ts:65, 160, 170, 188, 196, 204, 216, 227, 235, 243, 252, 290, 301` | 조용함 (C) |
| B8 | `alignSelection`(2개 미만), `distribute*`(3개 미만), `groupSelection`(2개 미만), `matchSelection`(주 선택 없음) | return — 잠금 알림 토스트만 먼저 뜰 수 있음 | `buildActions.ts:197-198` 등 | 조용함 (C) |
| B9 | 도로 액션 전부 | 오류가 토스트로 바뀌고 반환값 없음 | `roadActions.ts:38-47` | 실패를 삼킴 (C) |
| B10 | `snapPoint` 허용 거리 밖 | 조용히 격자 점 — 종류(`kind`)를 읽어야 알 수 있음 | `snapEngine.ts:257` | 조용함 (C) |
| B11 | `undo` / `redo` | 획·트랜잭션·잠금·빈 기록이면 return, 신호 없음 | `worldStore.ts:893`, `:903` | 조용함 (C) |
| B12 | `beginTransaction` / `beginTerrainStroke` 겹쳐 시작 | 앞의 것을 조용히 덮어씀(앞 획의 찍기는 층에 접히지 않은 채 남음) | `worldStore.ts:860`, `:772` | 조용한 손상 (C; 결과는 S) |
| B13 | `setGroupName(없는 그룹, …)` | 이름이 저장되고 한 단계가 생김(불러올 때 버려짐) | `worldStore.ts:719-733`, `world/serialization.ts:432-436` | 조용함 (C) |
| B14 | `applyEdit({update: [모르는 id]})`, `remove` | 건너뜀 — 몇 개가 적용됐는지 모름 | `worldStore.ts:518-530` | 조용함 (C) |
| B15 | `terrainDab`(지도 밖 / 칠할 꼭짓점 없음) | `null` | `terrain/TerrainEditor.ts:95-96`, `:115-116` | 반환값으로 알 수 있음 (C) |
| B16 | `pasteAt`, `startPaste` | 클립보드가 없으면 `[]` / 경고 토스트 | `buildActions.ts:291-294`, `:301` | 조용함 (C) |
| B17 | 오른쪽 클릭 | 카메라 팬(OrbitControls) — 맥락 메뉴 자리가 이미 쓰임 | §4.3 | 입력 충돌 (C) |

### 1.10 순수 코어 — 있는 것 / 추출해야 하는 것

| 명령이 하려는 일 | 지금 부를 수 있는 순수 함수 | 추출·추가가 필요한 것 |
|---|---|---|
| 이동·회전·크기(강체) | `transformObjects`, `selectionPivot`, `yawRotate` (`groupTransform.ts`) | **월드 경계 검사**(코어에 없음, E12) |
| 정렬·간격·맞추기 | `alignObjects`, `distributeGaps`, `distributeObjects`, `matchObjects` | 무변화면 같은 참조를 돌려주는 보장(`matchObjects`의 `scale`은 항상 새 객체 `:143`) |
| 속성 복사 | `copyProperties`, `copyApplies` | — |
| 공통 칸 편집("모두 x=…") | `sanitizePosition`, `sanitizeScale`, `withHeightAboveGround`, `droppedTransform`, `storedRotation` (`editor/build/numericTransform.ts:35-94`) — 객체 **하나**용 | **`setCommonTransform(objs, patch, terrain)`** — §4.2 |
| N개 배치 | `planPlacement`, `acceptedInputs`, `checkStamp`, `FootprintIndex` | — |
| 한 개 배치(스냅 포함) | `snapPoint`, `footprintHalves`, `groundPose`, `checkPlacement`, `isInsideWorld`, `collisionFootprint` — 낱개 | **`planSinglePlacement(item, at, yaw, env)`**: `PlaceTool.tsx:73-151`의 조립을 옮김(E4) |
| 팔레트 항목 → 입력 | `itemParams`, `itemDesign`(프리셋은 캐시, `'custom'`만 저장소) | `'custom'` 설계를 인자로 받는 형태 |
| 도로 그리기·분할·삭제·단면 | `drawRoad`, `splitSegment`, `mergeAtNode`, `deleteSegments`, `setProfile`, `moveNode` … | 그리기 전 점 스냅(`RoadTool.tsx:35-42`)과 경계 검사 공유 |
| 도로 옆 줄 배치 | `frontage`, `buildingsAlong`, `vehiclesAlong`, `infrastructureAlong` | (명세는 `snapPoint` 쪽을 요구 — 차이 문서화) |
| 숲 | `planForest`(인자 둘 다 넘길 때), `areaFill`, `forestStrokeKey` | — |
| 지형 요소 | `applyEdit({landscape:{features,next}})` | id 발급(`f<next>`)이 액션 안(`natureActions.ts:44-47`) |
| 지형 브러시 | `applyDab`(스크래치에), `previewDab`(찍기 1개), `dabPath` | **프로그램 획**: 스크래치 격자에서 찍기 목록을 돌려 Δ조각·지표·토양 사각형(= `LandscapeEdit.layers`)과 미리보기를 함께 돌려주는 함수; `dabOptions`의 저장소 의존 제거 |
| 그룹 만들기·풀기 | — | `groupObjects(objs, gid)`, `ungroupObjects(objs)` + 이름 정리 |
| 숨김·잠금 | — | `withFlags(objs, flags)` |
| 같은 종류 선택, 선택 확장 | — | `sameKind(objs, ref)`, `expandGroups(objects, ids)`(지금은 저장소를 읽음) |
| 복제·붙여넣기 | `createBlueprint`, `instantiateBlueprint`, `checkStamp` | 원본 ↔ 사본 **id 대응표**(§4.1), 그룹 id를 인자로(지금은 `createId`) |
| Blueprint 배치 | `planPlacement(doc, bp, options)` (`blueprints/place.ts:173`) | `edit.add`와 나란한 항목 id 목록 |
| 새 월드·실험장 | `structureLabRoads/Objects`, `defaultTownRoads/Objects`, `buildEnvironment`, `templateDocument` | 확인 단계를 계획 미리보기로(대화상자 대신) |

---

## 2. 한 명령 = 실행 취소 한 단계가 지금 가능한가 (명세 §3-2)

### 2.1 기록의 모양 (C)

- `HistoryEntry` `world/worldStore.ts:52-66` = **바뀌기 전** 상태:
  `objects`(맵 참조) · `roads`(참조, underlay 포함) · `terrain: TerrainPatch | null` · `landscape: {features, next, patch: LayerPatch | null}` · `config?: {settings, scenario}` · `groupNames?: {value}`.
- `undo` `:890-898`: 지금 상태로 `current` 항목을 만들어(`terrain`·층 패치는 **같은 패치 객체**를 공유, `config`/`groupNames`는 `prev`에 있을 때만) `future` 앞에 넣고 `travel(prev, 'before')`.
  `redo` `:900-908`은 반대. 둘 다 `stroke ∨ tx ∨ locked`면 조용히 return.
- `travel` `:393-403`: 층 패치를 제자리 적용 → 객체·도로·features·(config)·(groups)를 참조 교체 → 지형 패치를 제자리 적용하고 `terrain: {...doc.terrain}`(새 객체, 같은 배열).
- 상한: 100개 **그리고** 64 MB(`HISTORY_LIMIT` `:37`, `HISTORY_BYTES` `:43`, `pushHistory` `:92-100`). 바이트는 지형·층 패치 배열만 셉니다(`historyEntryBytes` `:80-89`, 항목 객체별 WeakMap 메모).
  **가장 새 항목은 64 MB를 넘어도 남습니다**(`:97`의 `i < out.length - 1`).
- 모든 기록 호출은 `future: []`를 함께 씁니다(다시 하기 스택 비움).

### 2.2 패치 형식 (C)

| | `TerrainPatch` `terrain/TerrainData.ts:111-121` | `LayerPatch` `landscape/apply.ts:96-99` |
|---|---|---|
| 사각형 | `rect: GridRect`(꼭짓점 번호, 양끝 포함 `:76-81`) | `rect` 하나 — 모든 층이 같은 사각형 |
| 배열 | `heights`(f32) · `ground`(u8) · `soil`(u8)의 Before / After = 꼭짓점당 **12 B** | `layers: {name, before, after}[]`. 이름은 8개 중 일부: `sculpt` `paint` `naturalHeights` `naturalGround` `naturalCulvert` `naturalRoadBase`(브러시·요소 = 꼭짓점당 **30 B**) + `baseHeights` `baseGround`(프리셋 교체 때만, `worldStore.ts:447`) |
| **settings** | **패치 안에 있음**: `settingsBefore / settingsAfter`(preset · seed · waterLevel) `:119-120`, 적용 때 통째 교체 `:162` | 없음 |
| 만들기 | `makePatch(t, before, rect)` `:139-155` — `before`는 **지도 전체** 사본(`snapshotLayers` `:166-168`)에서 사각형만 오려 냄 | `makeLayerPatch(land, nx, before, rect)` `:108-113`(전체 사본에서) / `makeLayerPatchFromRect` `:131-133`(사각형 사본에서 — 브러시 확정용 `worldStore.ts:355-356`) |
| 적용 | `applyPatch(t, p, side)` `:158-164` — 제자리 쓰기 + `revision++` | `applyLayerPatch(land, nx, p, side)` `:135-142` — 제자리 쓰기 |
| 한 항목에 여럿? | 안 됨(항목당 하나) | 안 됨 |

지형 패치의 사각형과 층 패치의 사각형은 다를 수 있습니다: 브러시는 `finalRect`(도로 영향까지) vs `layerRect`(강 재합성까지) `worldStore.ts:355`, `:367-369`.
"설정만 바뀐" 지형 단계는 **더미 사각형 `{0,0,0,0}`**(꼭짓점 하나)로 패치를 만듭니다(`:848`, `:495`) — 합칠 때 함정(E8).

### 2.3 누가 기록을 남기나 (C)

`pushHistory` 호출처 9곳 — 전부 `world/worldStore.ts`:

| # | 줄 | 누가 지나가나 | 항목 내용 |
|---|---|---|---|
| H1 | `:339` `commit()` | `applyEdit`(객체만), `addObject(s)`, `updateTransform/Params/Physics/Seismic`, `resetPhysics`, `rename`, `remove`, `duplicate`(차 아님) | objects |
| H2 | `:387` `finishLayered()` | `endTerrainStroke`→`commitTerrain`, `applyEdit({landscape})`·`setFeatures`·`applyTerrainPreset`→`applyLandscapeEdit`, `setWaterLevel` | objects + 지형 패치 + 층 패치 + features (+ 도로) |
| H3 | `:562` `applyGeometry` 도로 분기 | `applyEdit({roads})`(지형 층 편집이 없을 때) | objects + roads + 지형 패치(없을 수 있음) |
| H4 | `:604-606` `applyEdit` config | `settings`/`scenario`가 있을 때: 방금 생긴 항목이 있으면 **거기에 덧붙이고**, 없으면 config 전용 항목 추가 | + config |
| H5 | `:663` `duplicate` 차 분기 | 차 설정이 있는 차 한 대 복제 | objects + config |
| H6 | `:732` `setGroupName` | 그룹 이름 | groupNames |
| H7 | `:744` `setExperiment` | 재난 배치·이동·삭제, 실험 패널 | config(settings + scenario 통째) |
| H8 | `:854` `checkpoint` | 옛 연속 편집 | objects(현재) |
| H9 | `:870` `commitTransaction` | 기즈모·필드 끌기 | objects(트랜잭션 시작 때) |

H4는 "방금 생긴 항목"을 `past`의 마지막 원소가 달라졌는지로 알아냅니다(`:597`, `:603-604`) — **기록을 다른 곳에 모으는 batch를 넣으면 이 판정이 깨집니다**(§2.6).

기록 **없이** 문서를 바꾸는 쓰기:

| 쓰기 | 줄 | 바뀌는 것 |
|---|---|---|
| `commit(next, {history:false})` | `:336-337` | objects — `editor/TransformGizmo.tsx:88`, 인스펙터 끌기(`ui/Inspector/ObjectInspector.tsx:75-76`)가 트랜잭션 안에서 씀 |
| `updateSimulationSettings` | `:675-704` | `settings.simulation.*` (잠금 검사도 없음) — 호출처: `ui/Inspector/SimulationSettings.tsx:20, 30, 83-88, 107`, `ui/Phenomena/RightPanel.tsx:153, 156`, `ui/BottomPanel/FloodForm.tsx:48`, `FireTools.tsx:44`, `ThermalTools.tsx:52`, `ExperimentPanel.tsx:75`, `ui/Terrain/NatureSections.tsx:296` |
| `setEarthquakeScenario` | `:714-717` | `scenario.earthquake` — `ui/BottomPanel/EarthquakeForm.tsx:36` |
| `setFloodScenario` | `:747-751` | `scenario.flood` — `ui/BottomPanel/FloodForm.tsx:41` |
| `setProjectName` | `:670-673` | `meta.name` — `ui/TopBar/TopBar.tsx:44` |
| `setExperiment`(잠금 또는 `history:false`) | `:739-742` | `scenario.experiment` |
| `terrainDab` | `:775-784` | 지형 배열 제자리(`set()` 없음) — 획이 끝날 때 H2 |
| `cancelTransaction`, `cancelTerrainStroke` | `:874-881`, `:810-826` | 복원 |
| `replaceDocument`, `newDocument`, 밖에서 `useWorldStore.setState({past: [], future: []})` | `:753-768`, `app/actions.ts:163, 172, 187, 212, 232, 258, 274, 300, 313, 326, 335`, `app/devtools.ts:277, 311, 349, 382` | 기록 초기화 |

**기록 없는 쓰기가 뒤의 실행 취소에 휩쓸립니다 (C, E2).** `config`는 settings와 scenario를 **항상 둘 다** 담습니다(`:63`). 순서: ① 재난 배치(H7: `config = {S0, C0}`) → ② 시뮬 설정을 바꿈(S1, 기록 없음)
→ ③ Ctrl+Z → `travel`이 `settings = S0`으로 되돌림(`:398`). 재난 하나를 취소했는데 그 뒤에 바꾼 시뮬 설정이 함께 사라집니다(다시 하기를 하면 돌아옴 — `:895`).
`setEarthquakeScenario`·`setFloodScenario`도 같은 식으로 앞선 H7/H5/H4 항목의 취소에 휩쓸립니다. 명령이 재난·차 설정을 자주 넣게 되면 더 자주 생깁니다.

### 2.4 오늘 조합하면 몇 단계인가 (C — 줄 근거는 §2.3)

| 한 명령이 내는 편집 | 오늘 가능한 가장 적은 호출 | 단계 수 |
|---|---|---|
| 객체 추가·수정·삭제 + 도로 + 지형 요소/층 + settings + scenario | `applyEdit` 한 번 | **1** |
| 위 + 객체가 새 지형에 앉기 | `applyEdit`의 `addSeat` `:157`, `:291-308` | 1 |
| 객체 + **그룹 이름** | `applyEdit` + `setGroupName` | **2** |
| 객체 + 재난(액션 경유: `addPhenomenon` → `setExperiment`) | `applyEdit` + `setExperiment` | 2 (scenario 전체를 계획기가 만들어 `applyEdit.scenario`로 넣으면 1) |
| 차 여러 대 복제 + **차 설정**(새 id가 열쇠) | `applyEdit({add})` → id를 받은 뒤 `applyEdit({settings})` | **2** |
| 차 한 대 복제 + 차 설정 | `duplicate` | 1 |
| 브러시 획(begin/dab/end) + 객체 | `endTerrainStroke` + `applyEdit` | 2 (Δ를 `landscape.layers`로 넣으면 1 — §1.6-5) |
| 해수면(`setWaterLevel`) + 다른 것 | — | +1 |
| 시뮬 설정(`updateSimulationSettings`) | — | **0** (기록 안 됨, 그리고 E2) |
| 스크립트 10줄(뒷줄이 앞줄 결과의 id·지형을 씀) | 줄마다 `applyEdit` | 줄 수만큼 |

### 2.5 답

- **한 번의 `applyEdit`로 표현되는 명령은 지금도 한 단계입니다.** 검증에서 걸리는 예외(도로망 무효 `:532`, 중복 id `:541`)는 아무것도 바꾸기 전에 나고, 객체 맵은 사본에서 만들며(`:516`),
  지형 층 분기는 배열을 복원합니다(`:496-510`). 도로만 있는 분기는 굽기 뒤의 예외를 복원하지 않습니다(E6).
- **한 번으로 표현되지 않는 명령은 불가능합니다**: 그룹 이름, 새 id에 묶인 설정, 획·`setExperiment`·`setGroupName`·`duplicate`·`setWaterLevel`의 조합, 스크립트.
  여러 `WorldEdit`를 하나로 합치는 일반적인 방법도 없습니다("추가한 객체를 다음 편집이 id로 고친다"는 id가 나와야 쓸 수 있음).
- 따라서 명세 §10의 **일괄 단계가 필요**합니다. 덧붙여 `WorldEdit`에 `groups`를 넣고 `CreateObjectInput`에 선택 칸 `id`를 두면 한 줄 명령 대부분은 batch 없이도 한 번의 `applyEdit`가 됩니다
  (batch는 스크립트와 액션 조합용으로 남음) — 둘 다 문서 스키마가 아니라 **편집 입력 형식**이라 SCHEMA_VERSION 7과 무관합니다.

### 2.6 항목 여럿을 하나로 합치려면

batch 안에서 생긴 항목을 e1…ek(기록 순)라 할 때, 합친 항목 M은:

| M의 칸 | 값 | 주의 |
|---|---|---|
| `objects`, `roads`, `landscape.features / next` | **batch 시작 때의 참조** | e1의 값과 같지만, e1보다 앞선 `history:false` 쓰기가 있으면 달라짐 → 시작 때 따로 잡는 편이 안전 |
| `config` | 시작 때의 `settings`·`scenario` 참조가 지금과 다르면 `{시작 값}` | 참조 비교면 batch 안의 `updateSimulationSettings`·`setFloodScenario`도 **같은 단계에 들어옴**(명세 §10이 요구) |
| `groupNames` | 시작 때의 `doc.groups` 참조(없음 = `undefined`)가 지금과 다르면 | |
| `terrain` | 사각형 U = 실제로 바뀐 꼭짓점을 덮는 사각형. `*After` = 지금 지형의 U. `*Before` = 시작 때 지형의 U. `settingsBefore` = 시작 때, `settingsAfter` = 지금 | 방법은 아래 A / B |
| `landscape.patch` | 층 이름의 **합집합**, 층마다 Before = 시작 때·After = 지금, 사각형 하나 | `base*` 층은 프리셋 교체 항목에만 있음 — "항목에 없는 층 = 그 항목이 안 건드림"(`worldStore.ts:452-453`만 base를 씀) |

**방법 A — 항목 접기.** U = 각 항목 `terrain.rect`의 `unionRect`(`TerrainData.ts:91-95`). After = 지금 지형에서 U를 복사. Before = After 사본에서 출발해 **ek → e1 역순**으로 각 항목의
`*Before`를 자기 사각형에 덮어씀(항목 밖은 그 항목이 안 바꿨으므로 맞음). 층도 층 이름별로 같은 식. 단점: ① 더미 사각형 `{0,0,0,0}`이 섞이면 U가 원점 꼭짓점까지 부풉니다(E8) — 설정 전용 패치를 따로 가려야 함
② 롤백(취소·예외)을 항목 역적용으로 하면 **항목을 남기지 못하고 죽은 내부 호출**은 되돌릴 수 없음: 도로 분기는 `bakeRegion`이 지형을 제자리에서 고친 뒤 `followRoads`·`followTerrain`·`seat`가 던지면
복원 코드가 없습니다(`:411-435`, `:552-566` — 지형 층 분기의 `try/catch` `:449-510`와 대조; `commitTerrain` `:348-370`도 없음) (C: 코드 없음, S: 실제로 던지는 입력) (E6).

**방법 B — 스냅숏(권장).** batch 시작(또는 첫 지형 쓰기 직전)에 `snapshotLayers(t)` + `snapshotLandscape(land, 8층 전부)`를 잡고, 끝에서 사본과 지금을 비교해 **달라진 꼭짓점의 최소 사각형**을 구한 뒤
`makePatch` / `makeLayerPatch`를 **한 번씩** 부릅니다. 롤백은 `applyLandscapeEdit`의 catch와 같은 `.set()`(`:497-508`). 이미 `applyLandscapeEdit`가 편집마다 하는 일과 같습니다(`:446-447`).
비용: 지형 6 B(f32 + u8 + u8) + 층 20 B(6층 15 B — `landscape/apply.ts:116-118`의 "606 KB at 200 m" — + base 2층 5 B) = 꼭짓점당 26 B → 기본 200 m 지도(201² = 40,401 꼭짓점, `core/units.ts:12`, `terrain/TerrainData.ts:10-11`)에서 **약 1.05 MB**(1 km 지도면 26 MB). 더미 사각형 문제가 없고(실제 차이로 사각형을 정함), 내부 호출이 원자적이지 않아도 됩니다.
달라진 것이 없고 `settings`도 같으면 지형 패치는 `null`.

어느 쪽이든 고쳐야 하는 것:
- `pushHistory` 9곳을 **한 깔때기**(`record(entry)`)로 모으고, batch가 열려 있으면 `past`에 넣지 않습니다. `past`에 넣은 채 접으면 batch가 100항목·64 MB를 넘는 순간 **batch 자신의 앞 항목이 잘려**
  되돌릴 "이전" 상태를 잃습니다(`:93`의 `.slice(-limit)`, `:95-98`) — 500줄 스크립트면 실제로 넘습니다.
- H4의 "마지막 항목이 달라졌나" 판정(`:597-606`)을 `record`의 반환값이나 계수기로 바꿉니다.
- 모든 기록 호출이 쓰는 `future: []`를 batch 중에는 미루고, **취소·롤백이면 `future`를 시작 때 값으로** 돌립니다(안 그러면 실패한 명령이 다시 하기 스택을 지움).
- 합친 항목에 `HISTORY_BYTES`가 적용되는지는 자동입니다(새 객체 → `historyEntryBytes`가 새로 계산). 다만 한 항목이 64 MB를 넘어도 남는 규칙(`:97`)이 있으니 명세 §19의 영역 상한으로 막아야 합니다.

### 2.7 `batch`가 지켜야 할 불변식

| # | 불변식 | 근거 |
|---|---|---|
| I1 | **지형·층 배열은 제자리 편집** — `doc.terrain`·`doc.landscape` 객체를 바꿔 끼워도 배열은 같은 것. 롤백은 참조 복원이 아니라 **값 복사** | `worldStore.ts:384-385`, `:401-402`, `TerrainData.ts:158-164` |
| I2 | 제자리 쓰기마다 `terrain.revision++`(샘플러·지형 메시가 이것으로 알아챔), 확정 때 `terrain: {...t}`(React effect가 참조로 알아챔). `revision`은 실행 취소로 **돌아가지 않음**(단조 증가) → 비트 비교에서 제외 | `terrain/TerrainData.ts:163`, `terrain/TerrainEditor.ts:115`, `rendering/terrain/TerrainLayer.tsx:102-138` |
| I3 | `terrainRect` = 마지막으로 확정한 지형 변화 사각형. 지형 메시는 `terrain` 참조가 바뀐 effect에서 **그 시점의 `terrainRect` 하나만** 다시 그립니다 → 한 틱에 지형 확정이 두 번이면 앞 사각형은 화면에 안 반영될 수 있음 (S). batch는 **합친 사각형**(또는 `null` = 전체)을 한 번 써야 함 | `TerrainLayer.tsx:112-119`, `worldStore.ts:386`, `:558`, `:897`, `:907` |
| I4 | `stroke`·`tx`는 **저장소별 클로저 변수**(임시 저장소가 앱의 획을 지우지 않게) — batch 상태도 같은 자리에, `replaceDocument`·`newDocument`에서 폐기 | `worldStore.ts:328-331`, `:755-756`, `:765-766`, 시험 `editor/input/input.test.ts:207-216` |
| I5 | batch 중 `busy()` = true → `undo`/`redo` 거부, 자동 저장 보류. 반대로 **시작할 때 `busy()`면 거부**(열린 사용자 획·끌기와 섞이지 않게). 지금 `applyEdit`는 `busy()`를 보지 않음 | `worldStore.ts:883`, `:893`, `:903`, `app/autosave.ts:77`, `:107`, E24 |
| I6 | `locked`면 시작 거부. 내부 호출은 각자 조용히 무동작이라 **중간에 잠기면 반쪽 적용** → batch는 동기로 끝내거나 확정 때 다시 검사 | `worldStore.ts:335`, `:515`, `:593` |
| I7 | `docVersion`이 시작 때와 다르면 폐기(트랜잭션과 같은 규칙) | `worldStore.ts:867`, `:878` |
| I8 | 변화 없음 → 항목 없음. 객체 맵은 `applyGeometry`가 늘 새로 만들므로(`:516`) **참조 비교로는 부족** — 키·값 참조의 얕은 비교가 필요. 내부 호출의 빈 단계(E5)는 batch가 흡수 | `worldStore.ts:524-530`, `:552-565`, `:604-606`, `:735-745` |
| I9 | 문서의 객체·도로·features·settings·scenario·groups는 **불변 값**(항목이 참조로 들고 있음). `createWorldObject`는 `input.transform`을 **복사하지 않고** 그대로 넣고, `update`도 넘긴 객체를 그대로 넣음 → 계획(Plan) 객체를 확정 뒤에 고치거나 재사용하면 문서·기록이 바뀜 | `world/WorldDocument.ts:75`, `:92`, `worldStore.ts:528`, E19 |
| I10 | 중간 상태가 구독자에게 보이면 안 되는 것: 선택 정리(§2.8), 자동 저장 예약. 실패 시 "아무것도 안 바뀜"에는 **선택도 포함** | `app/inputPolicy.ts:103-109`, `app/autosave.ts:112-114` |
| I11 | `meta.updatedAt`은 모든 쓰기·실행 취소에서 새 시각(`touch`) → 비트 비교에서 제외 | `worldStore.ts:248-252`, `world/fingerprint.ts:10` |
| I12 | 임시 저장소로 미리 돌려 보려면 **문서를 먼저 복제**: `scratchWorld(doc)`은 같은 배열을 공유하고 지형 편집은 제자리 → 앱 지형이 바뀜 | `worldStore.ts:915-919`, `:753-761`, E18 |

### 2.8 중간 상태에 반응하는 구독자 (C)

`subscribe` 호출은 저장소 전체에서 일곱 곳뿐입니다(`grep`): `app/autosave.ts:112`, `app/inputPolicy.ts:64, 73, 94, 98`, `app/actions.ts:340`, `i18n/i18n.ts:77`. `worldStore`를 듣는 것은 둘:

| 구독자 | 반응 | batch 중 문제 |
|---|---|---|
| `autosave.ts:112-114` | `doc` 참조가 바뀌면 800 ms 뒤 저장 예약. 저장 직전 `busy()`면 미룸 `:107`, `saveNow`도 `busy()`면 안 씀 `:77`. `pagehide`·탭 숨김에서 즉시 저장 `:116-123` | 동기 batch면 타이머가 끼어들 수 없음. 비동기(시간 예산으로 쪼갠 스크립트)라면 `busy()`에 batch를 넣어야 반쪽 문서가 저장되지 않음 |
| `inputPolicy.ts:98-110` | `docVersion` 변화 → 제스처·카메라 잠금 정리. `doc.objects` 참조 변화 → **없어진 id를 선택에서 제거** | 내부 `set()`마다 실행됨. "지우고 다시 만드는" 중간 상태나 **롤백**에서 선택이 이미 깎여 있음 → 문서는 돌아와도 선택은 안 돌아옴 |

React 쪽: `EditorBatches`는 마지막으로 그린 높이 배열과 지금을 **직접 비교**해 바뀐 상자를 찾으므로(`rendering/editor/EditorBatches.ts:71-84`, `:114-116`) 지형 확정이 여러 번이어도 안전합니다.
지형 메시는 I3의 문제가 있습니다. 구성 요소 렌더는 같은 틱의 `set()`들이 한 번으로 묶일 것으로 보이지만 (S), `subscribe` 콜백은 `set()`마다 돕니다 (C).

가장 간단한 해법: `worldStoreCreator`가 받는 `set`·`get`을 감싸 **batch가 열린 동안은 `set`을 모아 두고 `get`은 모은 것을 얹어 돌려주며**, 확정 때 진짜 `set`을 한 번만 부릅니다.
구독자는 최종 상태만 보고(I10), 롤백은 모은 것을 버리고 배열만 복원하면 됩니다. 모든 액션이 클로저의 `set`·`get`만 쓰므로(`:327`) 한 곳만 고치면 됩니다.

### 2.9 지금 있는 실행 취소 시험과 문서 비교 방법 (C)

| 시험 | 무엇을 | 비교 방법 |
|---|---|---|
| `app/editor36.test.ts:39-66` | 재난 배치·이동·삭제가 객체 편집과 **한 스택** | `instances()` 값, `past.length` |
| `app/editor36.test.ts:67-77` | 문서 교체 = 기록 초기화, 잠금 = 적용만 | `past.length` |
| `app/editor36.test.ts:247-264` | 그룹 이름 한 단계, 무변화 = 단계 없음 | `doc.groups` 값 |
| `app/editor36.test.ts:388-402` | 차 한 대 복제의 설정 복사(탑승자 제외) 한 단계 | `cars[copy]` |
| `app/editor36.test.ts:404-430` | 편집 ⇄ 시뮬 20회 뒤 문서·기록 불변 | **`serializeDocument(doc, false)` 문자열 동일** |
| `editor/input/input.test.ts:150-188` | 트랜잭션: 한 단계 / 무변화 0 / 취소 복원 / 중간 `undo` 거부 / 문서 교체 시 폐기 | 좌표 값, `past.length`, `busy()` |
| `editor/input/input.test.ts:190-217` | 획 취소 = 지형 복원·기록 없음, 임시 저장소가 앱 획을 안 지움 | `heights` 원소별 `===` |
| `editor/input/input.test.ts:284-291` | 추가를 되돌리면 선택에서 빠짐 | 선택 id |
| `terrain/terrainEdit36.test.ts:140-158` | 브러시 확정의 층 패치가 사각형만, 되돌리기·다시 하기에서 **모든 층 정확히** | `snapshotLandscape` 6층 + `heights`를 `Array.from … toEqual` |
| `landscape/landscape.test.ts:125-135` | 요소·도로·조각을 섞은 5단계를 끝까지 되돌리고 다시 함 | 손으로 만든 체크섬 문자열(높이 가중 합, 층 합, feature id, 구간 id) |
| `templates/templates.test.ts:94-117` | 템플릿 교체(지형 + 환경 + 실험)가 한 단계 | `serializeDocument`에서 **`meta`를 null로** 바꾼 문자열 |
| `blueprints/blueprints.test.ts:392-403` | Blueprint 지형 적용 뒤 되돌리기 | `serializeDocument`(meta를 원래 것으로 끼움) |

- **공용 "비트 동일" 도우미는 없습니다.** 있는 것은 `worldFingerprint(doc)`(`world/fingerprint.ts:9-20`): `updatedAt`을 비운 `serializeDocument` 문자열의 FNV-1a 두 줄 = 16진 16자.
  `window.__ds`에는 전용 해시 훅이 없고 `__ds.blueprintLib.worldFingerprint`(`app/devtools.ts:140`)로만 닿습니다 — 기존 Chrome 스크립트가 그렇게 씁니다(`scripts/verify-blueprints.mjs:112`, `scripts/verify-structure.mjs:89`).
  `verify-editor36.mjs`의 S15·S17은 객체만 `JSON.stringify`로 비교합니다(`:307`, `:331`).
- `serializeDocument`가 담는 것: 지형(높이 cm·지표·토양·settings), 객체(`components` 제외), 도로(underlay 포함), 지형 층(base·sculpt·paint·features·next), settings, scenario, groups, meta
  (`world/serialization.ts:239-264`, `terrain/terrainCodec.ts:179-192`, `landscape/schema.ts:22-33`, `roads/schema.ts:99-101`). **담지 않는 것**: 파생 층 `natural.*`(불러올 때 다시 합성), `revision`.
  → 명세 §10의 "지형·레이어 비트 동일"은 지문만으로는 `natural.*`를 못 봅니다. `terrainEdit36.test.ts:142-157` 방식(층 배열 직접 비교)을 함께 써야 합니다.
- 최상위 열쇠 순서는 문서 객체를 만든 순서를 따릅니다(`serialization.ts:257`의 `{...doc}`): 세션 중에 처음 생긴 `groups`는 맨 뒤에 붙고(`worldStore.ts:729-730`), 불러온 문서에서는 다른 자리일 수 있습니다 (S) —
  "세션 문서"와 "저장 → 불러온 문서"의 지문을 비교하는 시험을 쓴다면 확인이 필요합니다. 같은 세션 안의 되돌리기 비교에는 영향이 없습니다(`undefined` 값은 직렬화에서 빠짐).
- 지문에는 **객체 id가 들어갑니다** → E3 때문에 "같은 스크립트 → 같은 결과 문서 해시"는 지금 성립하지 않습니다.

권장: `world/` 아래에 공용 도우미 하나(예: `docBits(doc)` = `worldFingerprint` + `natural.*` 4층 + `sculpt`·`paint`·`soil` 원시 바이트 해시)를 두고 Node 시험과 `__ds`(새 훅)가 같은 것을 부르게 합니다.

---

## 3. 명령이 참조할 수 있는 이름·식별자 (명세 §3-7)

| 대상 | 식별자 형식 | 사는 곳 | 사람이 부르는 이름 | 안정성 · 함정 |
|---|---|---|---|---|
| 객체 id | `<type>_<16진 8자><36진 계수기>` (예: `building_3fa91c2b1`) | `core/id.ts:3-10`, `world/WorldDocument.ts:75`, `:87`, `worldStore.ts:638` | — | **난수**(`crypto.randomUUID`, 없으면 `Math.random`), 계수기는 페이지마다 0부터. 파일에서 온 id는 아무 문자열(`world/serialization.ts:41` `z.string().min(1)`). 손으로 치기 어려움 → Tab 완성 필수 |
| 객체 이름 | `WorldObject.name` — 기본값 **빈 문자열** | `core/model.ts:72-73`, `WorldDocument.ts:75`, `:89` | 사용자가 지은 이름. 비어 있으면 화면에 `<종류 라벨> <serial>` | 유일성·길이 제한·trim 없음(`worldStore.ts:622`, `serialization.ts:43`). 기본 이름은 **표시할 때** 만들어짐: `displayName(obj, t)` `ui/format.ts:5-7` → 한국어 "건물 3", 영어 "Building 3"(로케일 의존). 건물은 프리셋과 무관하게 모두 "건물 n" |
| 객체 serial | 종류별 `최대값 + 1` | `worldStore.ts:535-540`, `WorldDocument.ts:61-65` | (기본 이름의 숫자) | 가장 큰 번호를 지우고 새로 만들면 **같은 번호 재사용**. 복제·붙여넣기 사본은 `name`을 물려받음(`blueprint.ts:103`, `:151`) → 같은 이름이 여럿 |
| 그룹 id | `grp_<16진 8자><36진>` — 난수 | `app/buildActions.ts:246`, `editor/build/blueprint.ts:161`, `blueprints/place.ts:406` | — | 복제·붙여넣기·Blueprint마다 새 id. 파일에서는 1–80자 문자열(`serialization.ts:53`) |
| 그룹 이름 | `WorldDocument.groups[그룹 id].name` (trim, ≤ 80자) | `core/model.ts:398-401`, `worldStore.ts:719-733` | 사용자가 지은 이름 | **유일성 검사 없음**(같은 이름 여럿 가능 → §7 "고르게"). 구성원이 없어진 그룹의 이름이 세션 중에는 남음(불러올 때만 버림 `serialization.ts:432-436`). 무명 그룹의 "그룹 n"은 **지금 걸린 필터·검색 결과에서의 순번**(`ui/ObjectPalette/Outliner.tsx:63-66`)이라 참조로 못 씀 |
| 도로 노드 | `n<k>` | `roads/network.ts:21-25`, `:110-116`, `roads/types.ts:50-56`, `:85-86` | **없음** | 문서 안에서 결정론(`network.next`, 노드·구간이 **같은 계수기**를 씀). 쓰는 구간이 없어지면 노드도 삭제(`network.ts:321-328`) |
| 도로 구간 | `s<k>` | `roads/types.ts:58-67`, `roads/network.ts:203-205` | **없음** — 이름 칸이 없음 | **분할하면 옛 id가 사라지고 새 id 두 개**(`network.ts:134-138`): 끝점이 기존 도로에 닿거나 교차하는 `drawRoad`, `splitSegment`, 합치기(`:284-288`)에서. 스크립트의 뒷줄이 앞줄 전의 `s2`를 가리키면 실패 |
| "큰길" | — | — | 저장된 이름 아님 | 쓸 수 있는 단서: 프로필(`width`, `lanes`, `shoulderWidth`) → `presetOf(profile)`이 `narrow2 / normal2 / wide2 / avenue4` 또는 `null`(`roads/crossSection.ts:57-75`); 도구 프리셋 이름 `street narrow wide avenue lane gravel dirt`(`roads/types.ts:118-127`); 길이(`segmentLine(...).length`). 기본 월드: 큰길 = `wide`(10 m) 동서 `[-56,0]→[56,0]`, 옆길 = `street`(7 m) `[-23,0]→[-23,46]`, T 교차(`world/defaultTown.ts:48-53`) — 큰길은 T에서 **두 구간으로 나뉘어** 있음. "큰길"은 "가장 넓은(동률이면 가장 긴) 도로의 이어진 구간들"로 정의하고 후보가 갈리면 고르게 해야 함 |
| 구역(블록) | 둘러싼 구간 id를 정렬해 이은 열쇠 | `roads/types.ts:11`, `:83`, `roads/blocks.ts:62-125` | 구역 종류(`residential` …)만 | 구간 id가 바뀌면 열쇠도 바뀜 |
| 지형 요소(산·언덕·능선·계곡·협곡·강·호수·해안) | `f<k>` (`landscape.next`) | `app/natureActions.ts:44-47`, `landscape/types.ts:28-135`, `landscape/schema.ts:38` | **없음**(`name` 칸 없음 — `grep` 0건) | 종류(`kind`)와 위치로만 가리킬 수 있음: "언덕"이 둘이면 모호. 위치 찾기 `featureAt(x, z, reach)`(`natureActions.ts:198-216`, 저장소를 읽음) |
| 재난 인스턴스 | `p<k>` — **빈 가장 작은 번호** | `phenomena/schedule.ts:92-98`, `:101-108`, `phenomena/types.ts:154-165` | 없음(종류 라벨만) | 지운 번호를 **다시 씀**(`p2`를 지우고 새로 넣으면 또 `p2`). 실행 중 열쇠도 같은 id, 직접 `runSimulation`하면 `"<type>#<n>"`(`app/actions.ts:399-402`). "화재 #3"이 `p3`인지 "세 번째 화재"인지 정해야 함(재난 부록 소관) |
| 팔레트 항목 | `tree.broadleaf`, `car.sedan`, `infra.streetLight`, `human.adult`, `building.custom` … (38줄) | `objects/palette.ts:6-26` | `labelKey`(i18n) | 고정. 한·영 이름 표는 팔레트 부록 소관 |
| 건물 프리셋 | `house`, `office`, `apartment`, `warehouse` … | `PaletteItem.buildingPreset` → `buildings/spec.ts presetSpec`, 캐시 `editor/build/itemDesign.ts:13-26` | i18n | `'custom'`은 Building Creator의 현재 설계(저장소) |
| 월드 템플릿 | `emptyFlat smallTown denseCity coastalCity mountainVillage riverValley industrialDistrict forestLake` | `templates/builtin.ts:26-27` | i18n `tpl.builtin.<id>` / 사용자 템플릿은 `LibraryEntry.name` | 사용자 항목 id는 `tpl_…` 난수(`templates/template.ts:72`) |
| Blueprint | 내장 `house apartments shoppingStreet industrialPark crossroads forest mountain riverBasin lakeVillage mixedDistrict`(+ `builtin-` 접두) / 사용자 `bp_…` | `blueprints/builtin.ts:27-40`, `blueprints/library.ts:26-42`, `app/blueprintActions.ts:46-48 entryName` | 내장은 i18n, 사용자는 `name`(중복 가능) | 라이브러리는 IndexedDB(비동기 `loadBlueprint`) |
| 환경 프리셋 | `mountainValley riverBasin coastalPlain forestedHills lakeDistrict mixedUrbanNatural` | `landscape/presets.ts:27-28` | i18n `nature.env.<id>` | 고정 |
| 지표·토양 | 숫자 id(예: 아스팔트 3) | `terrain/GroundMaterials.ts`, `terrain/SoilProfiles.ts`, `editor/editorStore.ts:123-124`, `editor/build/placementCheck.ts:50` | i18n | 다른 부록 소관 |

정리: 문서에 **저장되는** 사람 이름은 객체 `name`과 그룹 이름 둘뿐입니다. 스크립트가 한·영에서 같은 결과를 내려면(S22) 기본 이름("건물 3")이 아니라 id·명시적 이름·`last`를 써야 합니다.

---

## 4. Phase 36 §26 잔여 중 Phase 37이 고칠 것 (명세 §3-9, §17)

### 4.1 차 설정이 여러 대 복제·붙여넣기·Blueprint·템플릿 교체를 따라가지 않음

저장 형태 (C): `doc.settings.simulation.vehicles.cars[차 객체 id] = VehicleCar`(`vehicle/settings.ts:29-45`). `VehicleCar` = `level` · `drive` · `abs` · `controls` · `program` · `autopilot` · `occupants`.
탑승자는 `occupants: {human: 사람 객체 id, seat, restrained}[]`(최대 4, `settings.ts:27`, `:68`) — 런타임이 `simulation/RuntimeBuilder.ts:238`에서 읽습니다. 편집기 UI에는 차별 설정을 쓰는 곳이 없고(`grep`:
`world/worldStore.ts:656-660`뿐), 데모(`vehicle/demos.ts:77-78`)·개발 훅(`app/devtools.ts:358-375`)·파일에서 옵니다. 재난 `EventSpec`에서는 객체 id를 가리키는 칸을 찾지 못했습니다(`events/specs.ts` `grep`, S).

| 경로 | 지금 하는 일 | 새 id를 알 수 있나 | 근거 |
|---|---|---|---|
| 한 대 복제 | 같은 항목(`config`)으로 설정 복사, 탑승자 제외 | 예(스스로 만듦) | `worldStore.ts:631-668`, 시험 `editor36.test.ts:388-402` |
| 여러 개 복제 | `createBlueprint` → `instantiateBlueprint` → `applyEdit({add})`. **설정 복사 없음** | **예.** Blueprint는 객체를 `type → serial → id`로 정렬하고(`blueprint.ts:89-90`) 같은 순서로 입력을 만들며(`:139`), `applyEdit`는 `add` 순서대로 id를 돌려줌(`worldStore.ts:537-544`) → `정렬한 원본[k] ↔ ids[k]` | `buildActions.ts:169-184` |
| 붙여넣기 | 클립보드 `Blueprint`(v1)는 **id도 차 설정도 없음**(`BlueprintObject` `blueprint.ts:30-56`). 복사 뒤 원본이 지워졌거나 설정이 바뀌었을 수 있음 | 새 id는 예, **원본 설정은 복사 시점에 클립보드에 담아야** 함 | `buildActions.ts:266-274`, `:299-333`. JSON 스키마는 모르는 칸을 버림(`blueprint.ts:171-193`) → 선택 칸 추가 필요 |
| Blueprint(v2) | 캡처가 객체를 정렬해 로컬 id `o<k>`/`v<k>`를 줌(`blueprints/capture.ts:267-278`). `BlueprintItem`에 차 설정 없음(`blueprints/types.ts:58-86`). 배치는 `edit.add`를 만들 때 **월드 밖 항목을 건너뜀**(`blueprints/place.ts:386`) → `add` 번호 ≠ 항목 번호 | 예, 단 `add`와 나란한 **로컬 id 목록**이 있어야 대응 가능 | `app/blueprintActions.ts:357-384`(`ids`를 받고도 안 씀) |
| 템플릿 교체(`'replace'`) | 객체는 `add`로 새 id, `settings: doc.settings`는 **템플릿의 옛 id가 열쇠인 `cars`**를 그대로 → 전부 고아 | 예(`Object.values(doc.objects)` 순서 = `add` 순서) | `blueprintActions.ts:426-437`. `'new'`는 `replaceDocument`라 id 유지 `:421` |

- `CreateObjectInput`에는 **id 칸이 없습니다**(`world/WorldDocument.ts:43-59`). `applyEdit`가 끝나야 id를 알기 때문에 지금 구조에서는 "추가"와 "그 id로 settings 쓰기"가 **두 단계**입니다(§2.4) → batch 또는 입력의 선택 칸 `id`(중복은 이미 throw `worldStore.ts:541`)가 있어야 "같은 단계에서 복사"가 됩니다.
- 탑승자 규칙("함께 복제된 사람만 새 id로")에는 같은 도장의 **사람 원본 id → 새 id** 대응표가 필요합니다 — 위의 정렬 대응으로 얻습니다.
- 같은 뿌리의 빈 곳(결정 필요): ① `autopilot.path`는 **절대 좌표**(`settings.ts:18-25`)인데 한 대 복제는 그대로 복사(`worldStore.ts:658`) → 2 m 옆의 사본이 원본의 경로로 감. 도장을 옮기거나 돌렸을 때 경로를 같이 옮길지
  ② 차를 지워도 `cars[id]`가 남음(정리 코드 없음 — 되돌리기에는 유리, 파일에는 고아) ③ **그룹 이름도 같은 식으로 안 따라감**: 복제·붙여넣기·Blueprint는 그룹 id를 새로 만들고 이름은 안 옮김,
  템플릿 교체는 그룹 id는 유지하지만 `groups`를 넣을 칸이 `WorldEdit`에 없음(`blueprintActions.ts:434`) (E10).
- 권장 자리: `editor/build/blueprint.ts`에 순수 함수 `stampSources(objs)`(정렬된 원본 id 목록) + `carSettingsForStamp(cars, sourceIds, newIds)`를 두고 `duplicateSelection`·`pasteAt`·`confirmPlacement`·`applyTemplate`·명령이 함께 씁니다.

### 4.2 다중 수치 편집 없음

- `ui/Inspector/MultiInspector.tsx:53-140`에는 수치 칸이 **하나도 없습니다**(정렬·간격·속성 복사·맞추기·±90° 회전 단추뿐).
- 단일 객체의 수치 경로: `ui/Inspector/ObjectInspector.tsx:75-105` — `sanitizePosition`으로 자르고 알림(`:79-81`), `updateTransform(id, patch, {history: !live})`(`:75-76`),
  끌기는 트랜잭션(`:23`). **X·Z를 바꿔도 다시 앉히지 않습니다**(y 그대로). 반면 그룹 변형(`transformObjects`)은 땅에 선 객체를 다시 앉힙니다(`groupTransform.ts:65-71`).
- `setCommonTransform`의 자리: **`editor/build/numericTransform.ts`**(이미 `sanitizePosition :35`, `sanitizeScale :52`, `withHeightAboveGround :67`, `droppedTransform :76`, `displayRotation/storedRotation :85-94`가 있음).
  형태 제안: `setCommonTransform(objs, patch: {x?, y?, z?, heightAboveGround?, headingDeg?, scale?}, terrain) → {objects, clamped, rejected, skippedLocked}` — 바뀐 객체만 돌려주고(`applyEdit({update})` 한 번 = 한 단계),
  `releasePlinth`·도로 연결 재측정은 기존 경로와 같게(`worldStore.ts:528`이 `update`에서 `relinkMoved`를 부름).
- 결정할 것: "모두 x=…"에서 땅에 선 객체를 **다시 앉힐지**(그룹 규칙) **y를 둘지**(단일 칸 규칙). S8("MultiInspector와 명령이 같은 결과")은 같은 함수를 쓰면 저절로 맞습니다.
- 이 파일은 `three`를 import합니다(`:12`, 오일러 변환용) — 명령 계획기가 순수 모듈로 남으려면 문제는 없지만(Node 시험에서 이미 씀, `editor36.test.ts:16`) 번들 경계를 볼 때 참고.

### 4.3 뷰포트 맥락 메뉴 없음

- 오른쪽 버튼은 **카메라 팬**입니다: `rendering/CameraRig.tsx:67-77`(`mouseButtons … RIGHT: THREE.MOUSE.PAN` `:76`).
- `src/`에 `contextmenu` 리스너는 **0건**입니다(`grep`). 브라우저 기본 메뉴는 OrbitControls 자신이 막습니다: `node_modules/three-stdlib/controls/OrbitControls.js:301`, `:816-820` —
  단 `scope.enabled === false`면 막지 **않습니다** → 카메라가 잠긴 제스처 중의 오른쪽 클릭은 브라우저 메뉴가 뜰 수 있음 (S).
- 도구들의 포인터 처리는 모두 왼쪽만 봅니다(`e.button !== 0` return): `TerrainTool.tsx:270`, `RoadTool.tsx:388`, `BulkTools.tsx:92, 284`, `NatureTool.tsx:134, 176`, `BlueprintTool.tsx:85`,
  `MarqueeSelect.tsx:63`, `rendering/placement/PlacementLayer.tsx:186`.
- 맥락 메뉴가 필요한 것: ① **오른쪽 클릭 vs 오른쪽 끌기(팬)** 구분 — R3F 클릭이 쓰는 `e.delta > 5` 규칙(`PlaceTool.tsx:129`, `EditorScene.tsx:162`)과 같은 문턱 ② 클릭한 **지면 점** —
  `groundHitOf(e)`(`editor/tools/shared.tsx:29-35`, 지형 광선)가 있지만 `GroundCatcher`에는 `onContextMenu`가 없음(`shared.tsx:55-75`) ③ 선택 도구에는 지면을 따라가는 것이 없음
  (`GroundDeselect`는 `onClick`뿐 `EditorScene.tsx:156-170`).
- 같은 이유로 명세 §4의 Context **"커서 지면 위치"를 담는 저장소가 없습니다**: `placementStore.hover`는 재난 배치를 무장했을 때만(`ui/placement/placementStore.ts:44`, `:85`), 도구들의 커서는 컴포넌트 지역 상태입니다.
  `viewStore`에 "마지막 지면 점"을 두는 추적기가 새로 필요합니다(E21).

### 4.4 아웃라이너: Shift = 토글, 키보드 이동 없음

- 보이는 순서(전부 컴포넌트 안, `ui/ObjectPalette/Outliner.tsx`): ① `all` = 객체를 `type.localeCompare` → `serial` 순으로 정렬 `:45` ② `shown` = 필터(종류·숨김만·잠금만) + 검색(표시 이름·종류 라벨·id) `:48-52`
  ③ `rows` = **그룹 먼저**(목록에서 처음 나온 순서, 접히지 않았으면 구성원이 뒤따름) → 그룹 없는 객체 `:55-71`.
- 가상화: 높이 `rows.length × 26 px`인 상자 안에 `rows.slice(first, last)`만 절대 위치로 그림(`ROW_H = 26`, `OVERSCAN = 8` `:26-27`, `:75-76`, `:114-116`). `scrollTop`·`height`는 지역 상태 `:40-41`, `:111-112`.
- 클릭: `pick` → `clickSelect(id, {shift, alt, toggle: ctrl ∨ meta})` `:77-80` — `clickSelect`에서 **Shift와 Ctrl/⌘이 같은 토글**(`app/buildActions.ts:52-56`). 그룹 행도 수정 키면 토글 `:124`.
- 키보드: 목록에 `role="tree"`만 있고 `tabIndex`·`onKeyDown`이 없습니다 `:111-113`. 전역 단축키는 화살표 키를 쓰지 않습니다(`app/hotkeys.ts`에 `Arrow` 0건) → ↑/↓ 충돌 없음 (C).
- 범위 선택에 필요한 것: ① **기준 행**(마지막으로 클릭한 행) 상태 — 지금 없음 ② `rows` 계산을 순수 함수로 빼기(예: `outlinerRows(objects, groupNames, filter, query, collapsed, t)`) — 범위 = 기준 ↔ 대상 사이의 행
  ③ 접힌 그룹을 지나는 범위가 구성원을 포함하는지, 그룹 행이 범위에 들면 그룹 전체인지 결정 ④ 화살표로 옮긴 행이 창 밖이면 `scrollTop`을 `index × 26`으로 맞추기 ⑤ 초점 표시(roving tabindex 또는 `aria-activedescendant`).
- 뷰포트 규칙과 달라지는 점(Shift = 범위)은 사용 설명서에 적어야 합니다(명세 §17).

### 4.5 편집기 반복 작업의 힙 증가(바퀴당 약 12 KB)

한 바퀴가 하는 일 (C, `scripts/bench-editor36.mjs:220-279`; `LEAK_OPS`로 일부만 고를 수 있음 `:29`):

| 작업 | 내용 | 기록 항목 |
|---|---|---|
| `objects` | 나무 10그루 `addObjects` → `remove` | 2 |
| `terrain` | 획 시작 → 찍기 5번 → 끝 → `undo` | 1 넣고 1 되돌림(`future`에 1) |
| `road` | `drawRoad` + `applyEdit` → `deleteSegments` + `applyEdit` | 2 |
| `disaster` | `armPlacement('fire')` → `placeAt`(토스트) → `deleteInstance` → `disarm` | 2 |
| `simSwitch` | `enterSimulation` → `exitSimulation` | 0 |
| `saveLoad` | `replaceDocument(parse(serialize(doc)))` | **기록 초기화** |

표본은 CDP `HeapProfiler.collectGarbage` 두 번 뒤 `Runtime.getHeapUsage.usedSize`입니다(`:202-216`). `saveLoad`가 켜져 있으면 바퀴마다 기록이 비워지므로 기록 탓이 아니라는 Phase 36의 판단은 코드와 맞습니다.

읽어서 본 후보 — 모두 **(S)**, 읽기만으로는 원인을 특정하지 못했습니다:

| 후보 | 왜 의심하나 | 근거 |
|---|---|---|
| `saveLoad`가 만드는 새 문서 세대 | 바퀴마다 객체·설계·도로망이 전부 새 객체 → WeakMap 캐시들은 풀리지만, **내용 열쇠 Map**에 문자열이 남을 수 있음: `byContent`(설계 내용 JSON이 열쇠, 48개 상한) | `buildings/design.ts:29-48` — 상한이 있어 평평해져야 함(확인 대상) |
| 씨앗 열쇠 Map(상한 없음) | `noises`(브러시), `noiseCache`(지형 요소·변형), `vsCache` — 씨앗이 매번 다르면 쌓임. 벤치의 `raise` 획은 해당 없음, **명령이 씨앗을 해시로 만들면 해당** | `terrain/TerrainEditor.ts:81-86`, `landscape/features.ts:28`, `deformation/field.ts:51`, `volcano/ash.ts:56` |
| 색·재질 Map(상한 없음) | 색 문자열이 열쇠 — 색이 무작위인 객체가 있으면 쌓임. 벤치의 나무는 고정색(`objects/definitions/tree.ts:85, 97`)이라 가능성 낮음 | `rendering/materials.ts:29-50`, `rendering/views/MergedBoxes.tsx:49-62`, `rendering/sim/ParticleLayer.tsx:13`, `DebrisLayer.tsx:30` |
| 토스트 타이머 | 토스트마다 `setTimeout` 클로저(3.2 s / 6 s) — 일시적, 목록은 4개 상한 | `ui/common/toast.ts:13-22` |
| 문서 세대를 붙잡는 단일 칸 캐시 | `existingIndex`(Blueprint 배치용 발자국 색인)는 마지막 `objects` 맵을 잡고 있음 — 한 세대뿐 | `app/blueprintActions.ts:251-257` |
| `EditorBatches` 재생성 | 지형·도로 확정마다 청크 어댑터를 새로 만듦(`dispose` 있음). 어댑터 안의 배열·리스너가 남는지 | `rendering/editor/EditorBatches.ts:147-207`, `:233-245` |
| 시뮬 왕복 | `unload`가 `simStore`를 비움 — 로그·시계열은 초기화됨. 이벤트 객체의 `createId('evt')`, 프로파일러·통계 계수기는 숫자뿐 | `simulation/SimulationController.ts:228-250`, `core/id.ts:1-9` |
| V8 자체 | 코드·피드백 벡터가 `usedSize`에 들어감 — 첫 10바퀴 뒤에도 조금씩 늘 수 있음 | `scripts/bench-editor36.mjs:208` |

모듈 수준의 다른 캐시는 WeakMap이거나 상한이 있습니다(`world/worldStore.ts:74`, `world/serialization.ts:211`, `terrain/TerrainSampler.ts:283`, `roads/network.ts:33`, `roads/intersections.ts:60, 81`,
`roads/crossSection.ts:117, 246`, `roads/blocks.ts:59`, `roads/bake.ts:43`, `structure/graph.ts:123, 363`, `editor/build/itemDesign.ts:13`(프리셋 수), `roads/city.ts:156`(프리셋 × 층수)).

좁히는 순서 제안: `LEAK_OPS`를 하나씩(이미 지원) → 늘어나는 작업 하나에서 10·100바퀴 힙 스냅숏 비교(명세 §17). 명령창 바퀴를 넣을 때는 계획·미리보기 객체가 I9(참조 공유)로 문서 세대를 붙잡지 않는지 함께 봅니다.

---

## 5. 결함 · 빈 곳

심각도는 "명령 기능에 미치는 영향" 기준입니다.

| # | 결함·빈 곳 | 근거 file:line | 명령에 미치는 영향 | 권장 처리 |
|---|---|---|---|---|
| E1 | (C) 일괄 단계 없음. 기록 호출이 9곳에 흩어져 있고 `applyEdit` 한 번으로 표현되지 않는 조합은 여러 단계 | `world/worldStore.ts:339, 387, 562, 604-606, 663, 732, 744, 854, 870` | **높음** — 그룹 이름·차 설정·획·스크립트가 한 단계가 안 됨(§10, S6, S16, S18) | `record(entry)` 깔때기 + 저장소별 `batch`(§2.6–2.8): `set`/`get` 감싸기, 스냅숏 기반 패치·롤백, `future` 복원. 먼저 시험으로 고정 |
| E2 | (C) `config`가 settings와 scenario를 항상 함께 되돌리고, 기록 없는 쓰기(`updateSimulationSettings`·`setEarthquakeScenario`·`setFloodScenario`)가 앞선 config 단계의 실행 취소에 휩쓸림 | `worldStore.ts:63, 398, 675-704, 714-717, 743-744, 747-751, 895` | **높음** — "재난 명령 취소"가 그 뒤에 바꾼 시뮬 설정·홍수/지진 시나리오를 함께 되돌림. 명령이 config 단계를 많이 만들수록 잦아짐 | batch에서는 참조 비교로 config를 붙임. 근본 처리(config를 바뀐 쪽만 담기, 또는 설정 쓰기도 기록)는 기존 동작이 바뀌므로 **결정 필요** — 최소한 문서화 + 시험 |
| E3 | (C) 새 객체 id = `crypto.randomUUID`, 씨앗 미지정 = `Math.random`, 그룹 id도 난수. `CreateObjectInput`에 id 없음. `worldFingerprint`는 id를 포함 | `core/id.ts:3-10`, `world/WorldDocument.ts:43-59, 70, 75, 87`, `app/buildActions.ts:246`, `editor/build/blueprint.ts:161`, `world/fingerprint.ts:9-20` | **높음** — "같은 스크립트 → 같은 결과 문서 해시"(§15, S22)가 성립 안 함. 계획 단계에서 새 id를 몰라 결과 집합·차 설정·그룹을 미리 못 엮음 | `CreateObjectInput.id?`(선택)와 그룹 id 인자화: 명령은 `subSeed(문서 씨앗, 명령 해시, 번호)`로 id·씨앗을 정함. 또는 해시 도우미가 id를 정규화. 마우스 경로는 그대로(난수) |
| E4 | (C) 단일 배치(스냅 → 자세 → 경고 → 입력)가 `PlaceTool` 컴포넌트 안에만 있음, 변형 씨앗은 `Math.random` | `editor/tools/PlaceTool.tsx:63, 73-151` | **높음** — "마우스 배치와 구별되지 않는" 한 개 배치를 명령이 재현할 코어가 없음(§1 목표, S4) | `planSinglePlacement(item, query, env)` 순수 함수로 추출해 PlaceTool과 명령이 함께 씀. 스냅 주의점(§1.4 ①–⑥)을 시험으로 고정 |
| E5 | (C) 무변화 판정이 없는 기록: 같은 객체 `update`, 내용이 같은 새 도로망, 같은 `settings`, 같은 features, 같은 `setExperiment`, `rename` 같은 이름 | `worldStore.ts:524-530, 552-565, 604-606, 471-495, 735-745, 622` | 중 — "변화 없음 → 단계 없음"(§10) 위반: 이미 정렬된 것을 정렬하면 빈 단계 | batch 확정에서 얕은 비교로 흡수(I8) + 순수 코어가 무변화면 같은 참조를 돌려주게(`matchObjects`의 scale 등) |
| E6 | (C: 복원 코드 없음 / S: 던지는 입력) 도로 분기와 브러시 확정은 지형을 제자리에서 고친 뒤 예외가 나면 복원하지 않음(지형 층 분기에만 `try/catch`) | `worldStore.ts:411-435, 552-566, 348-370` vs `449-510` | 중 — "도중 실패 → 시작 전 상태"(§10)를 내부 호출의 원자성에 기댈 수 없음 | batch 롤백을 스냅숏(방법 B)으로. 여유가 되면 도로 분기에 같은 `try/catch` |
| E7 | (S) 한 틱에 지형 확정이 두 번이면 지형 메시가 마지막 `terrainRect`만 다시 그림 | `rendering/terrain/TerrainLayer.tsx:102-119`, `worldStore.ts:386, 558` | 중 — 지형 편집이 둘 이상인 명령·스크립트에서 화면 일부가 옛 높이 | batch가 합친 사각형(또는 `null`)을 `terrainRect`로 한 번 씀(I3). Chrome S9·S16에서 확인 |
| E8 | (C) 설정 전용 지형 단계가 더미 사각형 `{0,0,0,0}` 패치를 씀 | `worldStore.ts:848, 495` | 중 — 항목을 접어 합치면 사각형이 원점 꼭짓점까지 부풀어 패치가 수십 배 | 방법 B(실제 차이로 사각형 결정) 또는 더미를 따로 표시 |
| E9 | (C) 차 설정이 여러 대 복제·붙여넣기·Blueprint·템플릿 교체를 안 따라감. 템플릿 교체는 옛 id 열쇠를 그대로 들여옴. 자율 주행 경로는 절대 좌표 그대로 | `app/buildActions.ts:169-184, 299-333`, `app/blueprintActions.ts:357-384, 426-437`, `blueprints/place.ts:386`, `worldStore.ts:656-664`, `vehicle/settings.ts:18-45` | 중 — 명령의 대량 복제에서 차가 주차 상태로 바뀜(§17, S18) | §4.1: 정렬 대응표 순수 함수 + 같은 단계 복사(E1 또는 E3 필요). 클립보드·Blueprint에는 선택 칸. 경로 이동 여부는 **결정 필요** |
| E10 | (C) 그룹 이름: 복제·붙여넣기·Blueprint·템플릿 교체에서 사라짐. 풀기·삭제 뒤 이름이 남음(불러올 때만 버림) → 저장→불러오기→저장이 달라질 수 있음 (S). `WorldEdit`에 `groups` 칸 없음. `groupSelection`은 그룹 id를 안 돌려줌 | `editor/build/blueprint.ts:160-163`, `blueprints/place.ts:405-408`, `blueprintActions.ts:434`, `buildActions.ts:242-262`, `world/serialization.ts:432-436`, `worldStore.ts:138-164` | 중 — "묶어서 '북쪽 블록'"(S6)을 한 단계로 못 함; `group:"이름"` 참조가 빈 그룹을 잡을 수 있음; 바이트 동일 관문 | `WorldEdit.groups` 추가(또는 batch), 순수 `groupObjects/ungroupObjects`가 이름 정리까지, 참조 해결은 구성원 있는 그룹만 |
| E11 | (C) 액션 계층이 UI 저장소를 읽고(선택·주 선택·`roadStore.profile`·`natureStore.forest/params`·`buildStore.clipboard`·`editorStore` 브러시), 토스트를 올리고, 실패를 삼켜 `void` 반환 | `app/buildActions.ts:26-33`, `app/roadActions.ts:38-47, 50-58`, `app/natureActions.ts:82, 99, 265, 304`, `editor/tools/TerrainTool.tsx:131-139` | 중 — 명령이 액션을 부르면 대상이 "선택"으로 고정되고 성공 여부·건수를 못 받음. 파서·계획기의 순수성(§2)도 깨짐 | 명령은 순수 코어 + `applyEdit`만(§1.10). 없는 코어는 추출해 UI 액션도 그 함수를 쓰게(사본 금지) |
| E12 | (C) 이동·정렬·간격·맞추기·복제에 월드 경계 검사 없음. 도로 코어(`drawRoad`·`moveNode`)에도 없음(UI의 `sampler.inside`뿐) | `editor/build/groupTransform.ts:53-178`, `buildActions.ts:169-239`, `worldStore.ts:631-668`, `roads/network.ts:394-408`, `editor/tools/RoadTool.tsx:267-270` | 중 — "500 m 옮겨", 지도 밖 좌표의 도로가 그대로 들어감(§19 "월드 밖 거부") | 계획 단계에서 `isInsideWorld`/`sanitizePosition`로 항목별 거부. 도로 점 검사를 코어 옆으로 |
| E13 | (C) `window.confirm` 15곳. `applyTerrainPreset`은 빈 월드에서도 항상, 잠금이어도 성공 토스트. `loadSampleTown`·`loadStressScene`은 확인 없이 교체 | `app/actions.ts:150-155, 158, 167-173, 177, 196, 218, 238, 264, 283, 306, 316-336`, `app/natureActions.ts:317`, `app/blueprintActions.ts:82`, `app/buildingActions.ts:50` | 중 — 명령에서 부르면 동기 대화상자로 멈춤(헤드리스 Chrome 포함) / 반대로 확인 없이 월드가 사라짐 | 명령은 코어(`structureLabObjects/Roads` 등)를 부르고 확인은 **계획 미리보기**로. `commitDesign`의 주입 패턴을 본보기로 |
| E14 | (C; UI 도달 여부 S) 잠금 중 새 월드 계열을 부르면 문서는 그대로인데 구조 모델 설정이 바뀌고 실행 취소 기록이 지워짐 | `actions.ts:160-163, 309-313, 322-326`, `worldStore.ts:675, 754, 764` | 중 — 실행 중 "새 월드" 명령이 조용히 기록을 날림 | 명령 층에서 잠금·모드를 먼저 검사해 거부. 액션에도 `locked` 조기 return |
| E15 | (C) 잠금 중 `setExperiment`는 기록 없이 문서에 적용 | `worldStore.ts:739-742`, `app/placementActions.ts:63-76` | 중 — 실행 중 재난 명령이 되돌릴 수 없는 문서 변경을 남김. 명세 §10(실행 중 편집 거부)과 35.5(실행 중 배치 허용)가 부딪침 | **결정 필요**: 실행 중 재난 명령을 "실행에만 추가(문서 불변)"로 할지, 지금처럼 둘지. 요약에 표시 |
| E16 | (C) 도로 구간·노드·지형 요소·재난 인스턴스에 이름 칸 없음. 구간 id는 분할 때 사라짐, `p<k>`·serial은 재사용, 무명 그룹 "그룹 n"은 필터 순번, 기본 객체 이름은 로케일 의존 | §3 표 | 중 — "큰길"·"그 언덕"·"화재 #3"·"건물 3"의 해석이 모호하거나 스크립트 도중 깨짐(§7, S14, S22) | "큰길" 규칙을 정의하고 후보가 갈리면 Clarify. 스크립트는 `last`·명시적 이름 권장. 이름 칸 추가는 스키마 변경이라 이번엔 안 함 |
| E17 | (C) 이름 충돌: `snapPoint`가 네 개, 명세의 `placementCheck`는 파일 이름(함수는 `checkPlacement`), 이미 `src/commands/`(시뮬레이션 자연어 파서·`LlmParser`)와 `ui/BottomPanel/CommandPanel.tsx`가 있음 — 그 경로는 재난을 `scenario`가 아니라 **런타임에 직접** 넣어 실행 취소가 안 됨 | `editor/snap/snapEngine.ts:204`, `editor/placement.ts:5`, `app/blueprintActions.ts:260`, `editor/tools/RoadTool.tsx:35`, `editor/build/placementCheck.ts:67`, `app/actions.ts:28-30, 556-596`, `commands/RuleBasedParser.ts` | 낮 — 제안 경로 `src/command/`와 한 글자 차이, 두 명령창·두 파서가 공존하게 됨 | 감사 본문에서 위치·이름을 정함(기존 것을 확장할지 대체할지). import는 항상 `snap/snapEngine` |
| E18 | (C) `scratchWorld(doc)`은 문서를 복제하지 않음 — 지형 배열 공유 | `worldStore.ts:915-919, 753-761` | 낮 — 임시 저장소로 계획을 미리 돌리면 앱 지형이 바뀜("미리보기는 편집 문서 불변" §9) | 미리 돌릴 때는 `cloneDocument` 후. 또는 지형은 사각형 사본 격자에서만 계산 |
| E19 | (C) `createWorldObject`가 `input.transform`을 복사하지 않음, `update`도 참조 그대로 | `world/WorldDocument.ts:75, 92`, `worldStore.ts:528` | 낮 — 확정한 Plan을 다시 쓰거나 고치면 문서·기록이 바뀜 | 확정 직전에 transform 복사(한 줄) 또는 Plan을 동결. 시험 추가 |
| E20 | (C) 다중 수치 편집 없음. 단일 칸은 다시 앉히지 않고 그룹 변형은 다시 앉힘 — 규칙이 둘 | `ui/Inspector/MultiInspector.tsx:53-140`, `ui/Inspector/ObjectInspector.tsx:75-105`, `groupTransform.ts:65-71` | 낮 — "모두 x=…"의 결과가 어느 규칙인지 미정(S8) | `numericTransform.ts`에 `setCommonTransform`. 다시 앉힘 여부 **결정 필요** |
| E21 | (C) 맥락 메뉴 없음: 오른쪽 = 팬, `contextmenu` 리스너 0건, 커서 지면 점을 담는 저장소 없음 | `rendering/CameraRig.tsx:76`, `editor/tools/shared.tsx:55-75`, `ui/placement/placementStore.ts:44` | 낮 — S17, 그리고 명령의 `cursor`/"여기" 위치(§7)를 채울 곳이 없음 | 오른쪽 클릭(끌기 아님) 판정 + 지면 점 추적기(`viewStore`) |
| E22 | (C) 아웃라이너: Shift = 토글, 키보드 없음, 기준 행 없음, 행 순서 계산이 컴포넌트 안 | `ui/ObjectPalette/Outliner.tsx:45-80, 111-124`, `buildActions.ts:52-56` | 낮 — S19 | 행 계산을 순수 함수로, 기준 행 + 범위·화살표(§4.4) |
| E23 | (S) 힙 증가 원인 미확인. 명령이 씨앗을 해시로 만들면 씨앗 열쇠 Map이 명령마다 자람 | `terrain/TerrainEditor.ts:81-86`, `landscape/features.ts:28`, §4.5 | 낮 — 누수 ×100 관문(§22) | `LEAK_OPS` 하나씩 → 스냅숏 비교. 씨앗 Map에 상한 |
| E24 | (C) 트랜잭션·획을 겹쳐 시작하면 조용히 덮어씀. `applyEdit`는 `busy()`를 보지 않음 | `worldStore.ts:770-773, 857-861, 592-609` | 낮 — 사용자의 열린 획·끌기 중에 명령이 확정되면 섞임 | batch 시작에서 `busy()` 거부(§8 명세와 같음). 겹쳐 시작은 거부하거나 앞 것을 확정 |
| E25 | (C) `previewDab`은 찍기 하나 전용이고 확정 결과(층 접기 → 재합성 → 도로 다시 굽기 → 객체 다시 앉힘)를 모름. `dabOptions`는 `editorStore`를 읽는 비공개 함수 | `terrain/TerrainEditor.ts:263-295`, `worldStore.ts:348-370`, `editor/tools/TerrainTool.tsx:131-139, 285` | 낮 — 지형 명령의 미리보기가 확정과 달라 보일 수 있음(도로·강 근처), 영역 명령은 미리보기 불가(S9) | 스크래치 격자 프로그램 획 함수(§1.6-3, -5). 요약에 "도로 밑은 도로 높이 유지" 경고 |
| E26 | (C) `duplicateSelection`은 `checkStamp`를 안 하고 잠긴·숨긴 객체도 복제(사본은 플래그 없음) | `buildActions.ts:169-184` vs `:305` | 낮 — "duplicate" 명령이 월드 밖 사본을 만들 수 있음 | 명령은 `instantiateBlueprint` + `checkStamp` 경로로. UI 복제도 같이 고칠지 결정 |
| E27 | (C: 초기화 없음 / S: 화면 영향) `newDocument`가 `terrainRect`를 지우지 않음 | `worldStore.ts:763-768` vs `:760` | 낮 — "새 월드" 뒤 지형 메시가 옛 사각형만 갱신할 수 있음 | `terrainRect: null` 한 줄(확인 뒤) |
| E28 | (C) `setNodeElevation`·`moveControl`·`addControl`은 모르는 id를 검사하지 않음(전자는 깨진 노드를 만들고 검증도 통과, 후자는 TypeError) | `roads/network.ts:338-342, 344-352, 354-365, 394-403` | 낮 — 명령이 오타 id를 넘기면 도로망 손상 또는 알 수 없는 예외 | 명령 해석 단계에서 id 존재 검사. 코어에도 `throw new Error('No node …')`(`moveNode :332`와 같게) |

### 결정이 필요한 것(이 부록에서 나온 것만)

| 항목 | 선택지 | 근거 |
|---|---|---|
| 실행 중 재난 명령 | 거부 / 실행에만 추가(문서 불변) / 지금처럼 문서에 기록 없이 적용 | E15 |
| 기록 없는 설정 쓰기와 config 실행 취소 | 그대로 두고 문서화 / config를 바뀐 쪽만 / 설정 쓰기도 기록 | E2 |
| 새 객체·그룹 id | 명령만 결정론 id / 해시에서 id 정규화 | E3 |
| "모두 x=…"에서 다시 앉힘 | 앉힘(그룹 규칙) / 높이 유지(단일 칸 규칙) | E20 |
| 복제·붙여넣기에서 자율 주행 경로 | 함께 옮김 / 그대로 | E9 |
| 그룹 이름을 도장이 따라가게 할지 | 따라감(같은 이름) / "…사본" / 안 따라감 | E10 |
| 기존 `src/commands/` · `CommandPanel` | 확장 / 대체 / 공존 | E17 |
