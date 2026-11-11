# Phase 37 사전 감사 — 좌표·방향, 단축키·IME, i18n·개발 훅, 명령창이 놓일 UI

기준 `d5b5896`(main). 읽기만 했습니다: 시험·tsc·vite·Chrome은 돌리지 않았습니다. 경로는 저장소 루트 기준입니다.
표기: **(C)** = 코드를 읽어 확인, **(S)** = 추측(실행·실제 입력기로 확인 필요). 범위 = 명세 §3의 5·6·8번 + 명령창이 들어갈 화면(§9·§14·§21·§22).
결함·빈 곳은 끝의 표(§8)에 U1…로 번호를 매겼습니다.

핵심 네 줄:

1. **방위 규약은 이미 정해져 있습니다: +x = 동, −z = 북, +z = 남, −x = 서.** 코드 주석·UI 문구·나침반·미니맵·재난 칸이 모두 같습니다(§1.2). 새로 정할 것은 방위가 아니라 **각도**(방위각 ↔ 객체 yaw)와 **"앞" 축**입니다.
2. **여는 키 권장: `/`(물리 키 `Slash`, 보조 키 없음).** 기존 바인딩·한글 자판과 충돌이 없습니다. 보조로 Ctrl/⌘+K(§2.6).
3. **옛 명령 입력란은 조합 중 Enter를 막지 않습니다**(`isComposing`·229 검사 없음). 기존 Chrome 스크립트는 한글을 `Input.insertText`로 넣어 조합 상태를 한 번도 만들지 않았습니다(§2.5, §5.5).
4. **명령창 자리 권장: 뷰포트 아래, 지금의 26 px "명령어" 줄(BottomPanel)을 한 줄 입력으로 바꾸고 결과 영역은 위로 접고 폅니다.** 옛 210 px 서랍은 1280×720에서 3D 면적이 32.6 %로 떨어집니다(§6.2).

---

## 1. 좌표·방향 규약 (§3-5)

### 1.1 월드 크기·격자·수치 범위

| 항목 | 값 | 근거 |
|---|---|---|
| 단위·위 방향 | 1 = 1 m, Y가 위 | `src/core/units.ts:1-6` (C) |
| 월드 크기 | 200 m 정사각, 중심 (0, 0), x·z ∈ [−100, 100] | `src/core/units.ts:12-13` `WORLD_SIZE = 200`, `WORLD_HALF` (C) |
| 지형 격자 | 201 × 201 꼭짓점, 칸 1 m, 원점 (−100, −100) | `src/terrain/TerrainData.ts:11`(`TERRAIN_CELL_SIZE = 1`), `:22-30`(`originX = -size/2`) (C) |
| 표고 범위 | −40 … 80 m | `src/terrain/TerrainData.ts:13-14` (C) |
| 수치 입력 위치 범위 | x·z: ±100 밖은 잘라서 보고, y: −40 … 480(`MAX_ELEVATION + 400`), NaN·Inf는 그 축만 거부 | `src/editor/build/numericTransform.ts:22,35-49` (C) |
| 수치 입력 크기 범위 | 축마다 0.1 … 10 | `src/editor/build/numericTransform.ts:52-54` (C) |
| 배치 경계 검사 | 바닥면(회전 포함)이 ±100 안 | `src/editor/placement.ts:12-18` `isInsideWorld` (C) |
| 재난 배치 경계 | 문서 지형에서 읽은 반폭 `mapHalf()` | `src/app/placementActions.ts:27-30`, `src/rendering/placement/PlacementLayer.tsx:157-158` (C) |
| 재난 위치 정밀도 | 마우스 배치는 0.1 m로 반올림 | `PlacementLayer.tsx:32,158` (C) |

경계의 출처가 둘입니다(상수 `WORLD_HALF` / 문서 지형 `mapHalf()`), 그리고 저장 스키마는 다른 격자 크기도 받습니다(`src/world/serialization.ts:70-72`: `nx` 2…2001, `cellSize` 양수) (C) → U6.

### 1.2 방위 — 이미 고정된 규약

**+x = 동, −z = 북, +z = 남, −x = 서.** 방위각은 **북에서 시계 방향 도(°)**: 0 = 북, 90 = 동. 방위각 → 벡터는 `(sin θ, 0, −cos θ)`.

| 어디 | 내용 | 근거 |
|---|---|---|
| 전역 주석 | "+X = East, -Z = North (so +Z = South, -X = West)" | `src/core/units.ts:4` (C) |
| 방위 유틸 | `COMPASS_BEARING`(N 0 … NW 315), `bearingToVector` = `[sin, 0, −cos]`, `nearestCompass` | `src/core/compass.ts:7-10,16-20,31-34` (C) |
| 나침반(뷰포트 오른쪽 위, 편집·시뮬 모두) | 글자 N·E·S·W, 판 위쪽 = 카메라가 보는 방향 | `src/ui/Viewport/Compass.tsx:6-19`, `src/ui/Viewport/ViewportContainer.tsx:74` (C) |
| 카메라 방위각 | `atan2(dir.x, −dir.z)`, 북(−Z)에서 시계 방향 | `src/rendering/CameraRig.tsx:57-63`, `src/rendering/viewStore.ts:289-290` (C) |
| 미니맵(월드·Blueprint 그림) | 픽셀 = `((x − x0)·k, (z − z0)·k)` → 위쪽 = −z = 북, 오른쪽 = +x = 동. 북 표시는 없음 | `src/ui/Blueprints/minimap.ts:62,161` (C) |
| 정렬 단추 문구 | "서쪽 끝 맞춤 (X 최소)", "동쪽 끝 (X 최대)", "북쪽 끝 (Z 최소)", "남쪽 끝 (Z 최대)" | `src/i18n/locales/ko.build.ts:92-97`, `en.build.ts:94-99` (C) |
| 중력 방향 선택 | "동쪽 (+x)·서쪽 (−x)·남쪽 (+z)·북쪽 (−z)", 벡터 north = `[0,0,−1]` | `src/i18n/locales/ko.gravity.ts:105-108`, `src/phenomena/gravityDefinitions.ts:24` (C) |
| 물 경계(N/E/S/W) | N = `iz = 0`(z = −100), S = `iz = nz−1` | `src/simulation/water/FloodEnvironment.ts:129-132`, `PlacementLayer.tsx:97-100`, `src/phenomena/catalog.ts:78-81`(`nearestEdge`) (C) |
| 지진 진동 주축 | 방위각(0 = N, 90 = E), 기본 = 진앙 방향 | `src/events/specs.ts:78-79`, `src/simulation/seismic/GroundMotionField.ts:127`, `src/events/earthquake/resolveEarthquake.ts:72-78` (C) |
| 운석 진행 방위 | "진행 방위(0 = 북)" | `src/impact/types.ts:36-37`, `ko.impact.ts:34` (C) |
| 토네이도 이동 방위 | 향하는 쪽, 0 = N = −z, 90 = E = +x | `src/vortex/types.ts:26-27`, `src/vortex/model.ts:50` (C) |
| 능선 방위 | 0 = 북, 90 = 동 | `src/deformation/types.ts:65-67` (C) |
| 옛 명령 파서의 방위 낱말 | `KO_DIR`(북·남·동·서·북동…) / `EN_DIR` → `CompassDir` | `src/commands/RuleBasedParser.ts:233-245` (C) |
| Chrome 스크립트 주석 | "`back` m south" = `z + back` | `scripts/verify-editor36.mjs:48-50` (C) |

**바람만 뜻이 반대입니다**: 풍향 = 불어**오는** 쪽(기상 관례). `WindEventSpec.direction`(나침반 낱말 또는 방위각)은 "from", 공기가 가는 방향은 `windFlowVector` = 반대(`src/core/units.ts:5`, `src/core/compass.ts:22-29`, `src/events/specs.ts:43-44`, `src/simulation/environment/WindField.ts:49`, UI `ko.ts:282-283` "풍향 = 불어오는 방향") (C). 토네이도 `trackBearing`과 운석 `azimuth`는 "향하는 쪽"입니다. 명령 요약에 from/toward를 낱말로 적어야 합니다.

해: UI 없음. 방향광 위치 고정 `[60, 90, 40]`(동남쪽 하늘)(`src/rendering/SceneEnvironment.tsx:13-15`) (C). 명령 대상 아님.

→ 명세 §26 "방위 규약": **기존 규약 채택(−z = 북), 나침반은 이미 있음.** 임시안이 필요 없습니다.

### 1.3 각도 — 규약이 둘 (U1)

| | 재난·환경 칸 | 객체 방향(yaw) |
|---|---|---|
| 0의 뜻 | 북(−z) | 로컬 +x가 동(+x)을 봄 |
| 양의 방향 | 시계(위에서 볼 때) | 반시계(three.js Y 회전): +90° = 로컬 +x가 북(−z) |
| 저장 | 도(°) | 라디안, `transform.rotation` = XYZ 오일러 |
| 화면 | 도(°) | 인스펙터는 도(°), "X 기울기 · Y 방향 · Z 기울기"(YXZ로 바꿔 보여 줌) |
| 근거 | §1.2 표 | `src/terrain/groundPlacement.ts:50-51,67,117-121`(`yawOf` = `atan2(−v.z, v.x)`), `numericTransform.ts:84-94`, `ko.p36editor.ts:6` (C) |

- `yawOf(rotation)`은 경사 기울기를 무시한 방향각(rad)입니다. `rotation[1]`을 직접 읽으면 기울어진 객체에서 틀립니다 — 명령도 `yawOf` / `displayRotation`을 써야 합니다 (C).
- 그 밖의 각도 단위: 유령 회전 `ghostYaw` rad(`src/editor/editorStore.ts:34-35`), 회전 스냅 `rotationStep` 도(`src/editor/buildStore.ts:61,131`, 기본 15), R = ±90°·T = 회전 스냅 한 칸(`src/app/hotkeys.ts:359-370`) (C).
- 변환: 로컬 +x의 방위각 = 90° − yaw°. 로컬 +z의 방위각 = 180° − yaw°.

### 1.4 객체의 "앞" 축 — 종류마다 다름 (U2)

| 종류 | 앞 | 근거 |
|---|---|---|
| 건물(모듈식) | 로컬 **+z**(정면 `'s'`, 1층 문이 그 면 가운데 칸) | `src/buildings/generate.ts:5,103-105,336` (C) |
| 도로 접면 스냅 | 건물 +z가 도로를 봄: `yaw = atan2(side·tz, −side·tx)`. 동서 도로의 북쪽에 놓인 집 = yaw 0 | `src/editor/snap/snapEngine.ts:117-122`, 검증 `scripts/verify-editor36.mjs:254` (C) |
| 차량 | 로컬 **+x**(yaw 0 = +X로 전진) | `src/vehicle/demos.ts:44`, `src/roads/links.ts:26-27`(`roadYaw`), `snapEngine.ts:113-114` (C) |
| 사람 | 로컬 **+z**가 얼굴, +x가 왼쪽 | `src/human/anthropometry.ts:17-18` (C) |
| 미니맵 | 바닥면을 `rotate(−yaw)`로 그림(반시계와 일치) | `src/ui/Blueprints/minimap.ts:101-103` (C) |

"북쪽을 보게", "도로를 향하게", "앞쪽 맞춰"는 이 표로 풀어야 합니다. 한 곳(순수 함수 `frontAxisOf(type)`)에 두고 스냅·명령이 함께 쓰는 것을 권합니다.

### 1.5 도로 방향·좌우·차선 (U3)

| 항목 | 규약 | 근거 |
|---|---|---|
| 구간 방향 | 노드 `a` → `b`. id는 `n<k>`·`s<k>`(문서 안에서 결정적) | `src/roads/types.ts:58-64,85` (C) |
| 중심선 | `segmentLine(network, seg)` → `{samples[{x,z,tx,tz,s}], length}`, 약 1 m 간격, 구간 객체별 캐시 | `src/roads/network.ts:33-43`, `src/roads/curve.ts:18-24,94-109` (C) |
| 옆 거리(lateral) | **+ = a→b로 볼 때 오른쪽**. 점 = `(p.x − tz·lat, p.z + tx·lat)` | `src/roads/types.ts:102`, `snapEngine.ts:108`, `src/roads/links.ts:34` (C) |
| `nearest().side` | +1 = 진행 방향의 오른쪽 | `src/roads/curve.ts:114-136` (C) |
| 보도 `left`/`right` | a→b 기준 | `src/roads/types.ts:23`, `src/roads/crossSection.ts:123-124` (C) |
| 차선 번호 | 0 = 가장 왼쪽(a→b 기준), `sectionAt(...).lanes[i]` = 차선 중심의 lateral | `src/roads/crossSection.ts:48-55,109-110,340` (C) |
| 끝난 차선 | 폭 전환 구간 안에서 없어진 차선은 `lanes[i] = null` → 스냅 후보에서 빠짐 | `src/roads/crossSection.ts:109`, `snapEngine.ts:110-111` (C) |
| 차선 진행 방향 | 일방통행이면 전부 a→b, 아니면 lateral ≥ 0 → a→b, < 0 → b→a(**우측통행**) | `snapEngine.ts:113` (C) |
| 접면 뒤물림 | 보도 바깥 끝에서 1 m(`FRONTAGE_SETBACK`) + 건물 깊이 절반 | `snapEngine.ts:39,118-121` (C) |

- 예: a(서) → b(동)인 도로에서 오른쪽 = 남(+z), 왼쪽 = 북(−z).
- 화면에는 a→b 방향 표시가 없습니다(도로 패널에는 일방통행 스위치뿐, `src/ui/Roads/RoadPanel.tsx:96`) (C). 그래서 `side=left|right`만 보여 주면 사용자가 확인할 수 없습니다. 요약에는 **"구간 s2의 북쪽(a→b 왼쪽)"**처럼 방위를 함께 적어야 합니다.
- "도로 북쪽"의 계산: 구간 중심선의 점에서 −z 쪽으로 조금 옮긴 점의 `nearest().side`. 남북으로 달리는 도로에서 "북쪽"은 옆이 아니라 끝입니다 → 모호함으로 처리(되묻기).

### 1.6 "여기(커서)"와 "저기(카메라 주시점)"

**커서 지면 점 — 보관하는 곳이 없습니다 (U4).** 포인터 광선 → 지형 교차는 도구마다 따로 하고 값은 그 도구 안에만 있습니다.

| 어디 | 함수·상태 | 언제 살아 있나 |
|---|---|---|
| 공용 헬퍼 | `groundHitOf(e)`: R3F 이벤트 광선 → `samplerFor(doc.terrain).raycast(o, d, 3000, out)` | 호출한 순간만 — `src/editor/tools/shared.tsx:28-35`, `src/terrain/TerrainSampler.ts:231` (C) |
| 배치 도구 | 로컬 `pos`·`snapped` | `tool === 'place'`일 때 — `src/editor/tools/PlaceTool.tsx:55-57,109-127` (C) |
| 지형 도구 | `cursor` ref | `tool === 'terrain'` — `src/editor/tools/TerrainTool.tsx:152,162-169,266-268` (C) |
| 재난 배치 | `placementStore.hover`([x, z], 0.1 m 반올림) | 재난이 무장됐고 포인터가 캔버스 위일 때만 — `PlacementLayer.tsx:151-159,178-183`, `src/ui/placement/placementStore.ts:43-44` (C) |
| 지형 살펴보기 | `editorStore.terrainProbe`(클릭한 점) | inspect 도구 — `src/editor/editorStore.ts:57-58` (C) |
| 스냅 표지 | `snapHint.point()` | 스냅 중일 때만 — `src/editor/snap/snapHint.ts:8-18` (C) |

기본 도구(select)에서는 포인터 이동을 지면 점으로 바꾸는 코드가 아예 없습니다(`src/editor/EditorScene.tsx:211-246`) (C). 사용자가 명령을 칠 때는 대개 select 도구입니다.
→ 새로 필요: 캔버스 `pointermove`에서 지면 점을 한 곳에 적는 추적기(DOM 좌표 → NDC → `Raycaster.setFromCamera` → `sampler.raycast`, `PlacementLayer.tsx:151-159`와 같은 방법). 포인터가 캔버스를 떠나면(명령창을 클릭하면 반드시 떠남) 마지막 점을 "떠난 시각"과 함께 남길지 정해야 합니다.

**카메라 주시점 — Canvas 밖에서 읽을 길이 없습니다 (U5).**

| 항목 | 내용 | 근거 |
|---|---|---|
| 컨트롤 | drei `OrbitControls makeDefault` 하나. 왼쪽 = 회전, 가운데 = 줌, 오른쪽 = 이동 | `src/rendering/CameraRig.tsx:66-77` (C) |
| 주시점 | `controls.target`(THREE.Vector3). Canvas 안에서만 `useThree((s) => s.controls)`로 읽음 | `CameraRig.tsx:18,23,58` (C) |
| 밖으로 나가는 값 | `viewStore.azimuthDeg`(0.5° 넘게 바뀔 때만), `focusRequest`, `followId`뿐 | `CameraRig.tsx:57-63`, `viewStore.ts:288-300,366-376,427-434` (C) |
| `window.__r3f` | 개발 빌드나 `?devtools`일 때만 생김 — 제품 코드가 쓸 수 없음 | `src/rendering/Viewport.tsx:16-18` (C) |
| target의 높이 | 지면이 아닐 수 있음: `focusObject`는 객체 높이의 40 % 지점 | `src/app/actions.ts:52,75` (C) |

→ 새로 필요: CameraRig가 "화면 중심 광선이 지면과 만나는 점"을 요청 때 돌려주는 다리(예: `viewStore`에 getter 등록). 정의는 **화면 중심 광선 ∩ 지형, 없으면 (target.x, target.z)**를 권합니다.

카메라 이동 함수(명세 §12)의 부수 효과 (C):

| 함수 | 하는 일 | 부수 효과 | 근거 |
|---|---|---|---|
| `focusObject(id)` | 객체로 이동(실행 중이면 런타임 위치), 거리 = max(8, 크기 × 2.6) | **선택을 그 객체 하나로 바꿈**. 따라가기는 안 끔 | `src/app/actions.ts:44-53` |
| `focusSelection()` | 선택 전체가 보이게. 1개 이하면 `focusObject` | 따라가기 끔. 선택 유지 | `actions.ts:59-76` |
| `focusPosition(pos, id?)` | 좌표로 이동, 거리 18 | 따라가기 끔. id를 주면 선택 | `actions.ts:79-83` |
| `requestFocus` | 약 0.4 초 애니메이션, `nonce: Math.random()` | UI 상태만 | `viewStore.ts:433-434`, `CameraRig.tsx:27-45` |

"가장 높은 건물 보여 줘"를 `focusObject`로 하면 선택이 바뀝니다. 질의는 선택을 바꾸지 않아야 하므로 `focusPosition`을 쓰거나 선택 변경을 요약에 적어야 합니다.

### 1.7 결정 필요(명세 §26에 올릴 것)와 임시안

| 항목 | 임시안 | 이유 |
|---|---|---|
| 방위 | −z = 북(기존 그대로), 나침반 추가 없음 | §1.2 |
| `heading=<°>`의 뜻 | 인스펙터 "Y 방향" 값과 같은 수(반시계, 0 = 로컬 +x가 동) | 마우스 편집과 같은 값(명세 §1). 방위 낱말("북쪽을 보게")은 §1.4 표로 변환 |
| 재난 칸의 방위각 | 기존 칸 그대로(북 기준 시계). 요약에 "방위각"이라고 표시 | 명세 §5 "새 단위 체계 금지" |
| 왼쪽·오른쪽 | 도로가 대상이면 a→b 기준 + 요약에 방위 병기. 그 밖(이동 등)은 지원하지 않거나 카메라 기준임을 표시 | §1.5 |
| "앞쪽" | 종류별 앞 축(§1.4). 정렬의 "앞쪽 맞춰"는 축을 되묻기 | 건물 +z, 차 +x |
| "여기" | 마지막 커서 지면 점(캔버스를 떠난 뒤에도 유지, 없으면 되묻기) | U4 |
| "저기" | 화면 중심 광선 ∩ 지형 | U5 |

---

## 2. 단축키 지도 (§3-6)

### 2.1 전역 처리기와 가드

전역 처리기는 하나: `useEditorHotkeys`(`src/app/hotkeys.ts:224-379`), `window`의 `keydown` **버블 단계**(`:376`), `App`에서 한 번 장착(`src/app/App.tsx:13`) (C).

가드 순서(`hotkeys.ts:227-230`) (C):

| 순서 | 조건 | 정확한 논리 | 근거 |
|---|---|---|---|
| 1 | `isTyping(e)` | `e.target`의 태그가 `INPUT`·`TEXTAREA`·`SELECT`이거나 `isContentEditable` → 모든 단축키 무시. **INPUT의 종류(range·checkbox·color)를 가리지 않음** | `src/editor/input/keys.ts:4-9` |
| 2 | `e.isComposing` | 조합 중 keydown 무시 | `hotkeys.ts:227` |
| 3 | `modalOpen()` | `document.querySelector('[role="dialog"][aria-modal="true"]') !== null` → **모든** 단축키 무시(Esc 포함) | `hotkeys.ts:73-75,230` |
| 4 | `activeGesture()` | 끌기 중 → 모든 단축키 무시(Esc는 제스처가 캡처 단계에서 처리) | `hotkeys.ts:230`, `src/editor/input/gesture.ts:51-53,78-84` |

`keyOf(e)`(`keys.ts:17-23`) (C): `e.code`가 `Key?`면 그 글자(소문자), `BracketLeft`/`BracketRight`면 `[`/`]`, **그 밖은 `e.key.toLowerCase()`**(Escape·Enter·Delete·`/`·`;`·`` ` `` 등은 물리 키가 아님). 시험: `src/editor/input/input.test.ts:135-142`(한글 자모·`Process`·`{`).
`mod = e.metaKey || e.ctrlKey`(`hotkeys.ts:234`). `aria-modal="true"`를 쓰는 곳: 도움말(`src/ui/TopBar/HelpDialog.tsx:48`), 결과(`src/ui/Results/ResultsPanel.tsx:149`), 비교(`src/ui/Results/ComparisonDialog.tsx:85`), Blueprint 대화상자(`src/ui/Blueprints/BlueprintDialogs.tsx:44`). `ModelBadge`의 팝업은 `role="dialog"`만 있어 차단하지 않음(`src/ui/common/ModelBadge.tsx:25`) (C).

### 2.2 키 표 (처리 순서대로, 전부 `hotkeys.ts`) (C)

| # | 키 | 보조 | 적용 조건 | 동작 | 줄 |
|---|---|---|---|---|---|
| 1 | Esc | — | 모든 모드, 재난 무장 중 / 핀 선택 중 | 무장 해제 / 핀 선택 해제 | 199-205, 238 |
| 1 | Delete·Backspace | 없음 | 모든 모드, 핀 선택 + 무장 아님 | 재난 인스턴스 삭제 | 206-210 |
| 2 | P | Shift | 모든 모드 | 성능 HUD | 241-244 |
| 3 | F | 없음 | 모든 모드, 선택 있음 | 카메라를 선택으로(여러 개면 전체) | 247-251 |
| 4 | Space(`e.code`) | **검사 안 함** | 시뮬레이션 | 재생/일시정지 | 254-256 |
| 4 | Esc | — | 시뮬레이션 | 선택 해제 | 257 |
| 4 | C | Ctrl/⌘ | 시뮬레이션, 글자 선택 없음 | 복사 | 258 |
| — | (시뮬레이션에서는 여기서 `return`: 아래는 전부 편집 모드) | | | | 259 |
| 5 | Z | Ctrl/⌘ (+Shift) | 편집 | 실행 취소 / 다시 실행 | 262-267 |
| 5 | Y | Ctrl/⌘ | 편집 | 다시 실행 | 268-272 |
| 6 | D, A, Delete·Backspace, Esc, W, E, R, X, H | D·A는 Ctrl/⌘ | 건물 편집 도구 | 부재 복제·전체 선택·삭제·(추가 취소 → 부재 선택 해제 → 나가기)·이동·회전·추가 부재 회전·투시·하중 경로 | 28-70, 274 |
| 7 | D / C / V / A / G | Ctrl/⌘ (G는 +Shift = 해제) | 편집 | 복제 / 복사 / 붙여넣기 / 전체 선택(+select 도구) / 그룹·그룹 해제 | 275-302 |
| — | 다른 Ctrl/⌘ 조합은 `return`(브라우저 몫): **K·S·F·P·O…는 비어 있음** | | | | 303 |
| 8 | `[` `]` | Shift = ×5 | 지형·브러시·영역(브러시 모양) 도구 | 브러시 반경 | 305-311 |
| 9 | Enter·Backspace·Esc·Delete | — | 지형 도구(지형 요소) | 초안 확정·점 지우기·초안/선택 해제·요소 삭제 | 123-152, 314 |
| 10 | Enter·Esc·Backspace·Delete | — | 도로 도구 | 초안 확정 / (동네 → 초안 → 선택 → 블록 → 나가기) / 점 지우기·구간 삭제 | 84-120, 316 |
| 11 | Enter·Backspace·Esc, R·T(Shift = 반대) | — | Blueprint 도구 | 캡처 다각형 닫기·점 지우기·취소 / 배치 회전·고정 해제 | 155-191, 318 |
| 12 | V / P / B / L / A | Alt 아님 | 편집, 지형·도로·Blueprint 도구가 아닐 때 | 선택·배치·브러시·선·영역 도구 | 216, 319-322 |
| 13 | Esc | — | 편집(나머지) | 지형 나가기 / 선 점 비움 / 영역 도형 비움 / 배치류 해제 / 붙여넣기 → 선택 / 선택 해제 | 325-332 |
| 13 | Enter | — | 영역 도구, 도형 있음 | 영역 적용 | 333-338 |
| 13 | Delete·Backspace | — | select 도구 | 선택 삭제 | 339-343 |
| 13 | W / E | — | 편집 | 이동 / 회전 모드 | 344-346, 356-358 |
| 13 | Q | — | select 도구 | 월드 축 ↔ 객체 축 | 348-350 |
| 13 | X / Y / Z | — | select 도구 + 선택 있음 | 축 잠금(다시 누르면 해제) | 351-355 |
| 13 | R | Shift = 반대 | 붙여넣기 / 배치·선 / select | 90° 회전 / 유령 90° / 크기 모드 | 359-363 |
| 13 | T | Shift = 반대 | 붙여넣기·배치·선 | 회전 스냅 한 칸 | 364-370 |
| 13 | G | — | 편집 | 스냅 켬/끔 | 371-373 |

비어 있는 키(보조 키 없이): 글자 C D I J K M N O S U(H는 건물 편집에서만 씀), 숫자, 기호 키(Slash, Semicolon, Quote, Comma, Period, Backquote, Minus, Equal, Backslash), F1–F12, Tab, 화살표 (C).

### 2.3 다른 keydown 리스너 (C)

| 어디 | 단계 | 키 | 가드 | 전파 | 근거 |
|---|---|---|---|---|---|
| 제스처(끌기 중에만 등록) | window **캡처** | Esc = 끌기 취소 | 없음(타이핑도 안 가림) | `preventDefault` + `stopImmediatePropagation` | `src/editor/input/gesture.ts:78-84,110` |
| Blueprint 대화상자 | window **캡처** | Esc = 닫기 | 없음 | `stopPropagation`(버블 단계 차단) | `src/ui/Blueprints/BlueprintDialogs.tsx:37-41` |
| 지면 피커(싱크홀·산사태) | window **캡처** | Esc 취소, 다각형: Enter·Backspace | `isTyping` | 처리한 키만 `stopImmediatePropagation` | `src/rendering/ground/GroundTools.tsx:190-204` |
| 변형 피커 | window **캡처** | Esc 취소 | `isTyping` | `stopImmediatePropagation` | `src/rendering/deformation/DeformationTools.tsx:92-102` |
| 선 도구 | window **캡처** | Enter 확정(전파 계속), Backspace(멈춤) | `isTyping`·`isComposing` | Backspace만 멈춤 | `src/editor/tools/BulkTools.tsx:134-146` |
| Blueprint 배치 Enter | window 버블 | Enter 확정 | `isTyping`·`isComposing` | — | `src/editor/tools/BlueprintTool.tsx:284-294` |
| 도움말 | window 버블(열렸을 때만) | Esc 닫기 | 없음 | — | `src/ui/TopBar/HelpDialog.tsx:35-40` |
| 결과 창 | window 버블(열렸을 때만) | Esc 닫기 | 없음 | — | `src/ui/Results/ResultsPanel.tsx:82-86` |
| 차량 직접 운전(시뮬, live 켬) | window 버블 keydown/keyup | W S A D·화살표·X·Digit1–4(`e.code`) | 자체 `typing`(range·checkbox는 타이핑 아님), Ctrl/⌘/Alt면 무시 | `preventDefault` | `src/ui/Inspector/VehicleControls.tsx:19-38,63-84` |
| 비교 창 | (리스너 없음) | Esc로 닫히지 않음 | — | — | `src/ui/Results/ComparisonDialog.tsx:84-85` |
| ⋯ 메뉴 등 `role="menu"` | (keydown 없음, 바깥 mousedown으로 닫힘) | Esc로 닫히지 않음, 전역 단축키는 그대로 동작 | — | — | `src/ui/TopBar/TopBar.tsx:78-98` |

`pointerdown` 캡처: 재난 배치층이 왼쪽 버튼만 가로챔(`PlacementLayer.tsx:186`), 피커도 왼쪽만(`GroundTools.tsx:156`, `DeformationTools.tsx:78`). 오른쪽 버튼을 쓰는 코드는 OrbitControls의 이동뿐이고 캔버스의 `contextmenu`는 `preventDefault`만 합니다(`src/rendering/Viewport.tsx:15`) (C).

### 2.4 Esc 한 번이 소비되는 순서 (지금) (C)

1. **캡처**(window, 등록 순): 끌기 중이면 제스처가 취소하고 끝. Blueprint 대화상자가 열려 있으면 닫고 버블 차단. 피커가 켜져 있으면(입력란이 아닐 때) 취소하고 끝.
2. **입력란 자신**(React `onKeyDown`): 숫자 칸 = 값 되돌리고 blur, 검색란 = 비움, 이름 바꾸기 = 취소(§2.5 표). 이벤트는 계속 버블하지만 3에서 `isTyping`으로 걸러짐.
3. **전역 처리기**(가드 통과 시 **첫 번째로 맞는 하나만**):
   재난 무장 해제 → 핀 선택 해제 → (시뮬) 선택 해제 → (건물 편집) 추가 취소 → 부재 선택 해제 → 나가기 → (지형 요소) 초안 → 선택 → (도로) 동네 → 초안 → 선택 → 블록 → 나가기 → (Blueprint) 초안/고정 → 라이브러리로 → 지형 나가기 → 선 점 비움 → 영역 비움 → 배치류 해제 → 붙여넣기 끝 → **객체 선택 해제**.
4. **버블, 나중에 등록된 것**: 도움말·결과 창 닫기(모달이 열려 있으면 3은 `modalOpen()`으로 이미 빠짐).

명령창이 끼어들 자리:
- 초점이 명령 입력란: 2단계(입력란 자신의 처리기)에서 **계획 취소 → 창 닫기** 순서. 전역 처리기는 `isTyping`으로 빠지므로 한 번에 하나만 일어납니다.
- 초점이 뷰포트인데 계획이 열려 있음: 지금은 자리가 없어 Esc가 3단계의 "선택 해제" 등으로 갑니다 → **3단계 맨 앞에 "열린 계획 취소"**를 넣어야 합니다(U10).
- 캡처 단계 리스너 가운데 타이핑을 안 가리는 것은 제스처 Esc와 Blueprint 대화상자뿐입니다. 입력란에 초점이 있는 동안 끌기는 사실상 없고, 대화상자는 위에 덮이므로 문제없습니다.

### 2.5 입력란이 단축키를 쉬게 하는 방식, Enter·Esc, IME

쉬게 하는 방식은 §2.1의 `isTyping` 하나입니다. 입력란 쪽에서 전파를 막는 코드는 없습니다 (C).

| 입력란 | Enter | Esc | 그 밖 | IME 검사 | 근거 |
|---|---|---|---|---|---|
| 숫자 칸 `NumberText` | blur → 값 확정(범위로 자름) | 값 되돌리고 blur | ↑/↓ = 한 칸(Shift ×10), 초점 시 전체 선택 | 없음 | `src/ui/common/fields.tsx:93-113` |
| 색 칸 | blur(유효한 #rrggbb만 확정) | — | | 없음 | `fields.tsx:194-201` |
| 스위치(`role="switch"` span) | 토글(Space도) | — | INPUT이 아님 → 단축키 안 쉼 | — | `fields.tsx:210-217` |
| 객체 이름 | blur | — | | 없음 | `src/ui/Inspector/ObjectInspector.tsx:43` |
| 아웃라이너 이름 바꾸기 | blur(확정) | 취소 | | 없음 | `src/ui/ObjectPalette/Outliner.tsx:132,151` |
| 팔레트·Blueprint 검색 | — | 검색어 비움 | | 없음 | `src/ui/ObjectPalette/ObjectPalette.tsx:108`, `src/ui/Blueprints/BlueprintPanel.tsx:103` |
| 재난 검색 | 첫 결과 무장 | 검색어 비움 | | 없음 | `src/ui/Phenomena/DisasterLibrary.tsx:51` |
| 월드 마법사 이름 | 다음 단계 | (대화상자 닫힘) | | 없음 | `BlueprintDialogs.tsx:201` |
| 프로젝트 이름(상단) | — | — | | — | `src/ui/TopBar/TopBar.tsx:39-45` |
| **옛 명령 입력란** | `preventDefault` + `submit()` | 처리 없음 | ↑/↓ = 입력 기록(메모리 50개) | **없음** | `src/ui/BottomPanel/CommandPanel.tsx:64-81`, `commandStore.ts:20-29` |

`isComposing`을 보는 곳은 window 리스너 셋뿐(`hotkeys.ts:227`, `BulkTools.tsx:135`, `BlueprintTool.tsx:287`)이고 `keyCode`(229)를 보는 곳은 저장소에 없습니다(`grep` 0건) (C).

**옛 명령 입력란에서 한글 조합 중 Enter (U7):**
- (C) `onKeyDown`은 `e.key === 'Enter'`만 봅니다(`CommandPanel.tsx:66-68`). 조합 중인지 묻지 않습니다.
- (S) macOS Chrome에서는 조합 중 Enter의 keydown이 `key: 'Enter'`, `isComposing: true`, `keyCode: 229`로 옵니다. 그러면 **그 keydown에서 바로 `submit()`이 돕니다.** 한글 문장은 마지막 글자가 항상 조합 중인 채로 끝나므로, 한글로 끝나는 문장은 매번 이 경로입니다. 제출되는 글은 조합 중인 글자까지 포함합니다(React가 조합 중에도 `onChange`를 올려 `input` 상태에 들어 있음).
- (S) 그 뒤 입력기가 조합을 확정하면서 `await executeCommand` 뒤의 `setInput('')`(`:55-57`)과 엇갈려 마지막 글자가 빈 칸에 다시 들어가거나 Enter가 한 번 더 처리될 수 있습니다(중복 실행은 `busy`가 await 동안만 막음, `:52-53`).
- (S) Windows Chrome은 조합 중 keydown이 `key: 'Process'`라 첫 Enter는 제출되지 않을 것입니다. 플랫폼마다 다르게 동작한다는 뜻입니다.
- 명세 §6·S2("조합 중 Enter는 제출 안 함, 조합 끝난 뒤 Enter 제출")와 다릅니다. 새 입력란은 `e.nativeEvent.isComposing || e.keyCode === 229`면 Enter·Tab·↑/↓를 무시하고, `compositionstart`/`compositionend`로 직접 센 깃발도 함께 봐야 합니다(Safari는 `compositionend`가 keydown보다 먼저 옴).

### 2.6 여는 키 후보 평가

두벌식 자판에서 자모가 나오는 물리 키는 **글자 키 26개 전부**입니다(Q–P = ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ, A–L = ㅁㄴㅇㄹㅎㅗㅓㅏㅣ, Z–M = ㅋㅌㅊㅍㅠㅜㅡ, Shift+Q W E R T O P = ㅃㅉㄸㄲㅆㅒㅖ). 숫자·기호 키는 한글 상태에서도 같은 글자를 냅니다. 예외: macOS 한글 입력에서 `` ` `` 키는 ₩를 냅니다 (S — 운영체제 동작, 여기서 실행해 보지 않음).

| 후보 | 기존 바인딩 | 브라우저 기본 | 한글 입력기 | 그 밖 | 판정 |
|---|---|---|---|---|---|
| **`/`** (`Slash`) | 없음 (C, §2.2) | Firefox 빠른 찾기 → keydown `preventDefault`로 막힘 (S). Chrome·Safari 없음 | 자모 키 아님. 한글 상태에서도 `/` (S) | GitHub·YouTube 등의 검색 관례. "슬래시 명령"과 뜻이 맞음. 입력란 안에서는 그냥 글자(`5 m/s`) | **권장(주 키)** |
| Ctrl/⌘+K | 없음(`hotkeys.ts:303`에서 브라우저로 넘어감) (C) | Windows·Linux의 Chrome·Firefox: 주소창/검색창 초점 → `preventDefault` 필요, 페이지에 초점이 없으면 브라우저가 가져감 (S). macOS 텍스트 칸의 Ctrl+K = 줄 끝까지 지우기 (S) | K = ㅏ지만 Ctrl/⌘와 함께면 조합 없음, `keyOf` → `k` | 두 키. 다른 입력란 안에서도 열 수 있게 만들 수 있음(`isTyping` 앞에서 처리) | **보조 키로 권장** |
| `:` (Shift+`Semicolon`) | 없음 (C) | 없음 | 자모 키 아님 | Shift 필요, `keyOf`가 `e.key`를 읽어 자판 배열에 따라 달라짐, 발견하기 어려움 | 쓰지 않음 |
| `` ` `` (`Backquote`) | 없음 (C) | ⌘+`는 macOS 창 전환(보조 키 있을 때만) | macOS 한글 상태에서 `e.key`가 ₩ (S) → `e.code`로 읽어야 함 | ISO 자판에서 물리 위치·코드가 어긋나는 문제 (S) | 쓰지 않음 |
| Ctrl+Space | Space = 재생/일시정지인데 **보조 키 검사가 없음**(`hotkeys.ts:254`) → 시뮬에서 Ctrl+Space도 재생 토글 (C) | — | **macOS 기본 "입력 소스 전환"(한/영)** (S), Windows 일부 입력기 켬/끔 (S) | | **탈락** |
| Enter | 영역 적용·도로 초안·지형 요소·Blueprint·선 도구·지면 피커 6곳(`hotkeys.ts:87,126,161,186,333`, `BulkTools.tsx:137`, `GroundTools.tsx:193`) (C) | 초점 있는 단추를 누름 | — | | **탈락** |

**권장: `/`를 주 키로, Ctrl/⌘+K를 보조 키로.** 구현할 때:

1. 물리 키로 읽기: `keyOf`에 `Slash → '/'`를 더하거나(`keys.ts:17-23`) `e.code === 'Slash'`를 직접 봅니다. 지금 `keyOf`는 `/`를 `e.key`로 읽습니다 (C). 시험은 `input.test.ts:135-142`에 추가.
2. 자리: `hotkeys.ts:230` 가드 바로 뒤, **`placementKeys`(238)와 시뮬레이션 분기(253)보다 앞**. 시뮬레이션 분기는 `return`으로 끝나므로(259) 그 뒤에 두면 실행 중에 열리지 않습니다 — 명세 §12는 실행 중에도 질의·실행 제어를 요구합니다 (C).
3. `e.preventDefault()` 필수: 없으면 방금 초점을 받은 입력란에 `/`가 찍힙니다 (S — Chrome S1에서 "열린 직후 값이 빈 문자열"로 확인).
4. Shift·Alt·Ctrl·⌘가 눌려 있으면 무시(`?`는 도움말용으로 남겨 둘 수 있음).
5. `isTyping`이 range·checkbox·color INPUT도 타이핑으로 봅니다(`keys.ts:8`) → 슬라이더를 만진 직후에는 `/`가 듣지 않습니다(U9). 여는 키에는 `VehicleControls.tsx:30-38`의 더 가는 판정을 `keys.ts`로 옮겨 함께 쓰는 것을 권합니다.
6. `modalOpen()`·`activeGesture()` 중에는 열리지 않습니다(지금 가드 그대로) — 의도와 맞습니다.

### 2.7 명령창이 지켜야 할 키 규칙(위에서 나온 것 정리)

| 상황 | 규칙 | 근거 |
|---|---|---|
| 입력란에 초점 | 편집 단축키는 저절로 쉼(`INPUT`). 따로 막을 것 없음 | `keys.ts:4-9` (C) |
| `aria-modal` | **쓰지 않음**. 쓰면 창이 열린 동안 Ctrl+Z·F·Esc 사슬까지 전부 죽음. `role="search"`/`combobox` + `aria-expanded` 권장 | `hotkeys.ts:73-75,230` (C) |
| Enter | 조합 중이면 무시. 아니면 계획 → (계획 열림) 확정 | §2.5 |
| Esc | 조합 중이면 무시(입력기가 조합을 취소). 계획 열림 → 계획 취소. 아니면 창 닫고 blur(초점이 body로 가야 단축키가 다시 들음) | §2.4 |
| Tab | `preventDefault` 뒤 자동 완성(안 하면 초점이 옆 단추로 감) | — |
| ↑/↓ | 기록. 옛 저장소는 메모리뿐 → `ds.commands.history`로 | `commandStore.ts:20-29` (C) |
| 뷰포트에 초점 + 계획 열림 | Esc = 계획 취소를 전역 사슬 맨 앞에. Enter 확정은 입력란과 "확정" 단추에서만(뷰포트에서 실수로 확정 방지) | U10 |

---

## 3. i18n 구조 (§3-8)

| 항목 | 내용 | 근거 |
|---|---|---|
| 사전 | `ko`가 기준: `MessageKey = keyof typeof ko`. `en: Record<MessageKey, string>` | `src/i18n/locales/ko.ts:41,650-652`, `en.ts:38` (C) |
| 합치기 | 영역별 조각 파일을 `ko.ts`/`en.ts` 끝에서 `...spread`. import 한 줄 + spread 한 줄씩 추가 | `ko.ts:5-39,615-649`, `en.ts:2-36` (C) |
| Phase 36 조각 | `en.p36editor.ts`가 `as const`로 키를 정하고 `ko.p36editor.ts`는 `Record<keyof typeof enP36Editor, string>`. `p36roads`·`p36struct`·`p36terrain`은 양쪽 다 타입 없는 객체 | `en.p36editor.ts:2`, `ko.p36editor.ts:2-4`, `ko.p36roads.ts:2` (C) |
| 키 이름 | 점으로 나눈 소문자 접두사: `ed36.pos`, `snap.kind.roadLane`, `warn.steep`, `viewport.hint.place` | `en.p36editor.ts:3-10` (C) |
| 채우기 | `{name}`. 값이 없으면 `{name}` 그대로 남음. 값이 `@키`면 그 키를 번역해 넣음. 복수형 처리 없음 | `src/i18n/i18n.ts:41-50` (C) |
| 없는 키 | 실행 시: 현재 언어 → 한국어 → **키 문자열 그대로**. 컴파일 시: `t('없는키')`는 타입 오류, `en`에 빠진 키도 타입 오류. 동적 키는 `as MessageKey`로 우회 | `i18n.ts:42,69-71`, 예 `src/ui/BottomPanel/WindForm.tsx:47` (C) |
| 데이터 속 문구 | `I18nMessage {key, params}`로 저장하고 그릴 때 `translateMessage` | `i18n.ts:11-15,65-67` (C) |
| 언어 상태 | zustand `persist`, 저장 키 `ds.locale`, **기본 한국어**(브라우저 언어 무시), `<html lang>` 동기화 | `i18n.ts:30-39,73-78` (C) |
| 화면에서 바꾸기 | 상단 KO/EN 단추 → `setLocale` | `src/ui/TopBar/LanguageToggle.tsx:6-21` (C) |
| React 밖 | `t(key, params)`(반응 없음), 컴포넌트는 `useT()` | `i18n.ts:52-59` (C) |

Phase 37에서:
- 파일: `en.p37command.ts`(+ 필요하면 `p37help`) / `ko.p37*.ts`, `p36editor` 방식(영어가 키 정의, 한국어가 `Record<keyof …>`)을 권합니다. 한쪽에만 있는 키를 조각 단위에서 잡습니다.
- 접두사: **`cmd.*`는 옛 콘솔이 쓰고 있습니다**(`ko.ts:394-427`, `ko.ux355.ts:143-144`, `ko.phenomena.ts:144-147`, `ko.flood.ts:62-66`, `ko.earthquake.ts:39-43`) (C). 새 키는 `cmd37.*`처럼 겹치지 않게.
- 방위 낱말은 `compass.N…NW`(`ko.ts:263-270`, 한국어 "북·북동…"), `compass.short.*`가 이미 있습니다 (C). 다시 만들지 않습니다.
- 도움말의 키 표는 왼쪽 칸이 하드코딩된 영어이고(`'LMB drag'`, `'R (placing)'`) Phase 36 키(Q, X/Y/Z, `[ ]`, Ctrl+Y)가 빠져 있습니다(`HelpDialog.tsx:6-28`) (C) → 명령창 키를 넣을 때 함께 정리(U23).

---

## 4. 개발 훅 `window.__ds` (§3-8)

장착: 개발 빌드이거나 주소에 `?devtools`가 있을 때만(`src/app/main.tsx:7`). 같은 조건에서 R3F 상태가 `window.__r3f`로 나옵니다(`src/rendering/Viewport.tsx:16-18`) (C).
전체 정의는 `src/app/devtools.ts:114-423`. 모든 구성원 (C):

| 이름 | 무엇 | 읽기/쓰기 | 줄 |
|---|---|---|---|
| `world` | `useWorldStore`. `getState()` → `doc`(objects·roads·terrain·landscape·groups·settings·scenario·meta), `past`·`future`(기록 배열), `docVersion`, `locked`, `busy()` + 모든 편집 액션 | 읽기 + **쓰기** | 116 |
| `editor` | `useEditorStore`: `mode`·`tool`·`placeItemId`·`selectedId(s)`·`hoveredId`·`transformMode/Space`·`axisLock`·`snap`·`dragging`·`brushPreview`·`terrainProbe` + setter | 읽기 + 쓰기 | 117 |
| `build` | `useBuildStore`(스냅·배치·브러시 설정, 클립보드, 세션) | 읽기 + 쓰기 | 118 |
| `buildActions` | `src/app/buildActions.ts` 전체(선택·삭제·복제·정렬·그룹·붙여넣기·`commitPlan`…) | 쓰기 | 119 |
| `buildingActions` | 건물 편집 액션 | 쓰기 | 120 |
| `editorBatches()` | 편집 배치 렌더러(청크 수 등) | 읽기 | 121 |
| `buildLib` | `areaFill`, `planPlacement`, `acceptedInputs`, `DEFAULT_PLACEMENT`, `FootprintIndex`, `parseDocument`, `serializeDocument`, `stressScene`, `createEmptyDocument`, `samplerFor` | 순수 함수 | 123 |
| `buildingLib` | `createDesign`, `presetSpec`, `BUILDING_PRESETS`, `analyzeBuilding`, `foundationContact`, `deriveFields`, `withDesign` | 순수 | 125 |
| `roadActions` · `natureActions` · `blueprintActions` | 각 액션 모듈 전체 | 쓰기 | 127, 129, 137 |
| `nature` · `roads` · `blueprints` · `library` · `members` | 도구별 UI 저장소 | 읽기 + 쓰기 | 130, 132, 138-139, 182 |
| `landscapeLib` | compose 전체 + `buildEnvironment`, `initialWater` | 순수 | 131 |
| `roadBatches()` · `roadStats` | 도로 렌더 통계 | 읽기 | 133-134 |
| `roadLib` | `roads/network`·`roads/city` 전체(`segmentLine`, `drawRoad`, `deleteSegments`…) + `blocksOf`, `intersectionsOf`, `emptyNetwork`, `defaultProfile`, `PROFILE_PRESETS` | 순수 | 135 |
| `blueprintLib` | `captureBlueprint`, `planPlacement`, `defaultPlacement`, `parseBlueprintText`, `serializeBlueprint`, `buildBuiltinBlueprint`, `buildTemplate`, `createTemplate`, `serializeTemplate`, `parseTemplate`, **`worldFingerprint(doc)`** | 순수 | 140 |
| `locale` | `useLocaleStore`(`locale`, `setLocale`) | 읽기 + 쓰기 | 141 |
| `tr(key)` | 현재 언어로 번역. **매개변수를 받지 않음** | 읽기 | 143 |
| `actions` | `src/app/actions.ts` 전체(`focus*`, 저장·불러오기, 프리셋, `loadStressScene(n)`, `enterSimulation`, `exitSimulation`, `runSimulation`, `resetSimulation`, `togglePlay`, `addPhenomenon`…, 옛 `parseCommand`·`executeCommand`) | 쓰기 | 144 |
| `placement` | `src/app/placementActions.ts` 전체(`armPlacement`, `placeAt`, `moveInstance`, `deleteInstance`, `mapHalf`, `runningKeys`…) | 쓰기 | 146 |
| `input` | `cameraLockOwners()`, `cameraLocked()`, `cameraLockIgnoredWrites()`, `activeGesture()` | 읽기 | 148 |
| `snapLib` | `snapPoint(query, env)`, `footprintHalves(type, params, scale?)` | 순수 | 150 |
| `placementStore` | 재난 배치 UI 상태(`type`·`template`·`selected`·`hover`·`drag`…) | 읽기 + 쓰기 | 151 |
| `view` | `useViewStore`(`azimuthDeg`, `focusRequest`, `followId`, 표시 옵션) | 읽기 + 쓰기 | 152 |
| `sim` | `simulationController`: `isLoaded()`, `getTime()`, `getStatus()`, `instances()`(`{key, spec, status, stop, pause, start, end}`), `getRuntime()`, `getMetrics()`, `getDamageEvents()`, `advance(s)`, `controlEvent`, `addEvent`, `setSpeed`… | 읽기 + 쓰기 | 153 |
| `simStore` | `status`·`speed`·`time`·`events`·`wind`·`baseline{hash, objects}`·`damageEvents`… | 읽기 | 154 |
| `ui` | `useUiStore`: `rightOpen`·`rightTab`·`commandOpen`·`hudOpen`·`overlayOpen`·`resultsOpen`·`compareOpen` + setter | 읽기 + 쓰기 | 155 |
| `waterRenderStats` · `profiler` | 물 렌더 통계, 시뮬 프로파일러 | 읽기 | 156-157 |
| `deformLib` | `terrainStats`(브러시·메시 갱신 횟수/ms — 해시 아님), `getRoadBatches`, `validateDeformation`, `currentDeformation`, `phenomena`(레지스트리), `rapierWarmUpMs()`, `rapierWorlds` | 읽기 | 159 |
| `trackGeometries()` | 살아 있는 geometry와 생성 스택 추적기 | 읽기 | 164-180 |
| `structureLib` | `removalPreview`, `graphOf`, `storeyTops(id)`, `memberWorld(id, i)` | 읽기 | 183-207 |
| `groundLib` | `sinkholeOutlook`, `landslideOutlook`, `impactPlan(spec)`, `blastPlan(spec)`, `blastField(spec)` | 읽기 | 209-215 |
| `thermalLib` · `fireLib` · `atmosLib` · `climateLib` · `gravityLib` · `celestialLib` · `volcanoLib` | 각 재난의 런타임 `rt()`·프리셋·`outlook(spec)`. `celestialLib.parse(text)` = **옛 규칙 파서** 결과 | 읽기 | 217-259, 410-414 |
| `humanLib` · `physioLib` · `vehicleLib` | 실행 중 행·집계·CSV·JSON, `loadPreset(id)`/`loadScene(sc)`(문서 교체, 기록 비움), 차량 live 입력 | 읽기 + **쓰기** | 261-409 |
| `floodStart(depth)` | 다음 실행의 초기 수심 | 쓰기 | 416-421 |

Phase 37 Chrome 스크립트가 **읽을 값과 지금 읽는 법** (C):

| 값 | 읽는 법 | 빈 곳 |
|---|---|---|
| 문서 해시 | `__ds.blueprintLib.worldFingerprint(__ds.world.getState().doc)` — 직렬화 전체(저장 시각만 제외)의 FNV 16자리(`src/world/fingerprint.ts:9-20`) | 객체 id가 무작위(`src/core/id.ts:3-10`, `crypto.randomUUID`)라 **같은 명령을 두 번 돌리면 해시가 다릅니다** → S10·S16·S22의 "같은 결과 해시"에는 id를 정규화한 해시가 필요(U17) |
| 지형 해시 | 직접 없음. `doc.terrain.heights`(Float32Array)·`ground`·`soil`을 페이지 안에서 해시해야 함 | S9 "되돌리기 비트 동일(`__ds` 해시)"용 함수 없음(U17) |
| 기록 길이 | `__ds.world.getState().past.length` / `.future.length` (`scripts/verify-editor36.mjs:88`) | — |
| 선택 | `__ds.editor.getState().selectedIds` / `selectedId` | — |
| 객체 목록 | `Object.values(__ds.world.getState().doc.objects)`(`id·type·name·transform·group·hidden·locked·building`) | — |
| 그룹 이름 | `doc.groups`(`verify-editor36.mjs:294`) | — |
| 도로 | `doc.roads.nodes/segments`, `__ds.roadLib.segmentLine/intersectionsOf` | — |
| 재난 인스턴스 | 문서: `doc.scenario.experiment?.instances`(`verify-editor36.mjs:89`). 실행: `__ds.sim.instances()`, `__ds.simStore.getState().events/status` | — |
| 카메라 | `__r3f.get().camera.position`, `__r3f.get().controls.target`, `__ds.view.getState().azimuthDeg/focusRequest` | `__ds` 안에는 주시점 없음(§1.6) |
| 입력 소유 | `__ds.input.*`, `editor.dragging`, `editor.tool` | — |
| 스냅 기대값 | `__ds.snapLib.snapPoint(...)` | `checkPlacement`·`planForest`·`previewDab`·`yawOf`는 노출 안 됨 |
| **명령창 상태** | 없음 | 열림 여부·입력 글·열린 계획(정규 명령·개수·경고·계획 해시)·유령 수·결과 집합·기록을 읽을 곳이 없음 → `__ds.command` 추가(U17) |
| 토스트 | 없음(`useToastStore` 미노출) → DOM `[role="status"]`의 글 | — |
| 번역 문구 | `__ds.tr(key)` | 매개변수 없는 키만. "3채 중 2채" 같은 문구는 비교 불가 → `tr(key, params)`(U17) |

`worldFingerprint`는 직렬화 전체를 문자열로 만든 뒤 해시합니다(5000개 장면에서 파일 2.3 MB — `docs/ADVANCED_WORLD_EDITOR.md` §23 표). 검사마다 부르는 것은 괜찮지만 누수 바퀴 안에서 매번 부르면 측정에 섞입니다 (S).

---

## 5. Chrome 스크립트 구조 — `verify-command37.mjs` / `look-command37.mjs`가 따를 형식

### 5.1 `scripts/verify-editor36.mjs` (567줄) (C)

| 항목 | 내용 | 줄 |
|---|---|---|
| 의존 | `import puppeteer from 'puppeteer-core'`. **`package.json`·`package-lock.json`에 없음**(`puppeteer` 0건). `node_modules/puppeteer-core` 25.12.0은 `npm i --no-save puppeteer-core`로 넣은 것(`docs/PERFORMANCE.md:139`) | 7 |
| 인자 | `node scripts/verify-editor36.mjs <url> <출력 폴더>`. 기본 `http://localhost:4196/`, `./docs/verify/editor36` | 11 |
| 환경 변수 | `LANG_UI`(ko 기본), `ONLY`(묶음 id 쉼표 목록), `CHROME`(실행 파일), `VW`·`VH`(기본 1600×1000), `S10_E` | 13-16, 447 |
| 서버 | 스크립트가 띄우지 않음. 먼저 `npx vite build && npx vite preview --port 4196 --strictPort &` | 5-6 |
| 실행 | 시스템 Chrome 헤드리스, `--use-angle=metal --enable-gpu --ignore-gpu-blocklist --enable-precise-memory-info`, `protocolTimeout` 30분 | 17-21 |
| 오류 수집 | `pageerror`와 콘솔 `error`를 `errors[]`에. `dialog`는 자동 수락(`window.confirm`이 전부 "예") | 26-28 |
| 새 상태 `fresh()` | `url + '?devtools'` → `__ds && __r3f` 대기 → `localStorage.clear()` → 새로고침 → **`__ds.locale.getState().setLocale(lang)`** → 1.2 초. IndexedDB(Blueprint 라이브러리)는 안 지움 | 39-47 |
| 언어 전환 | 위의 `setLocale` 호출(준비 단계의 쓰기). `ds.locale`을 직접 쓰지 않음 | 45 |
| 카메라 | `view(x, z, h, back)`: 카메라 `(x, h, z + back)`, 주시점 `(x, 0, z)`. `above` = 거의 수직 | 49-54 |
| 실제 입력 | `screen(x, z, dy)`(월드 → 화면), `clickWorld`(이동 2번 + 클릭, 보조 키), `dragScreen`(누름·단계 이동·놓기 선택), `click(sel)`, `keyCombo(mods, code)`, `typeInto(handle, value)`(3번 클릭 + `keyboard.type` + Enter), `armItem(id)` | 56-84, 191-205 |
| 상태 읽기 | `objects()`, `sel()`, `inputState()`, `undoDepth()`, `insts()`, `glInfo()`, `near(a, b, tol)` | 85-91 |
| 검사 | `check(name, ok, detail)` → `results[]` + `PASS/FAIL 이름 상세 [초]` 한 줄 | 33-36 |
| 묶음 | `if (want('input' / 'build' / 'terrain' / 'structure' / 'disaster' / 'layout'))`, 묶음마다 `fresh()` | 37, 94, 208, 336, 388, 490, 541 |
| 끝 | `N/M passed; E page errors; geometries G; textures T` 한 줄, `results-<lang>.json`(`{lang, results, errors, gl}`), 화면 `<이름>-<lang>.png`. 종료 코드 0 = 전부 통과 **그리고** 오류 0 | 561-567 |

준비 단계에서 API로 **쓰는** 곳(시험 대상이 아닌 것): `setRoadEdit`(166, 171), `setTerrainTool`(368), `enterBuildingEdit`·`members.select`·`setSelectedType`(403-408), `runSimulation`·`sim.advance`(452-454), `setSelection`·Blueprint 액션(495-506) (C). Phase 37도 같은 원칙: 명령 입력·확정·취소는 실제 키보드로, 준비(장면 만들기)만 API로 하고 주석으로 표시.

### 5.2 `scripts/chrome-lanes.sh` (C)

`scripts/chrome-lanes.sh <url> <출력 폴더> <큐 파일> [차선 수=1]`(`:7`). 큐 파일은 한 줄에 `"<스크립트 이름(.mjs 없이)> <언어>"`. 차선마다 여유 메모리가 `MIN_FREE`(기본 15 %) 아래면 20 초씩 기다립니다(`:12,16-24`). 실행은 `LANG_UI=<언어> node scripts/<이름>.mjs <url> <출력>/<이름>`(`:30`), 기록은 `<출력>/lanes.log`: 시각·차선·작업·rc·초·`N/M passed` 줄·`^FAIL` 개수(`:31`). 새 스크립트도 **`N/M passed` 줄과 줄 머리 `FAIL`** 형식을 지켜야 이 기록이 맞습니다.

### 5.3 `scripts/bench-editor36.mjs` (303줄) (C)

- 인자: `<포트 또는 URL> <개수 목록> <출력 JSON>`. 환경: `MODE`(scale | leak), `LEAK_N`(100), `SAMPLE_EVERY`(10), `LEAK_OPS`(작업 부분 집합), `IDLE_MS`·`ORBIT_MS`(3000), `SELECT_N`(5), `CHROME`(`:23-33`). Chrome은 1600×900 + `--js-flags=--expose-gc`(`:34-38`).
- 페이지 준비 `openPage()`: `__frames(n)`, rAF를 감싸 프레임당 CPU ms를 재는 `__cpu`, `__stat`(mean/p50/p95/max), `__measure(ms, orbit)`(FPS·CPU 프레임·그리기 호출·삼각형), `__view`(`:41-97`).
- **scale 행**(개수마다 새 페이지): `loadStressScene(n)` 시간, 힙, 정지/궤도 측정, 건물 `SELECT_N`개 실제 클릭 선택 지연(첫 클릭 따로, 나머지 중앙값), 끌기 쓰기 경로 90프레임(`beginTransaction` → `updateTransform(history:false)` → `commitTransaction`), 그 되돌리기 시간, 저장(`serializeDocument`)·불러오기(`parseDocument` + `replaceDocument`)·파일 KB, 끝 힙(`:101-185`).
- **leak 바퀴**(`:220-279`): ① 나무 10그루 `addObjects` → `remove` ② 지형 획(`beginTerrainStroke` → `terrainDab` 5번 → `endTerrainStroke`) → `undo` ③ 도로 `drawRoad` + `applyEdit` → `deleteSegments` ④ 재난 `armPlacement('fire')` → `placeAt` → `deleteInstance` → `disarmPlacement` ⑤ `enterSimulation` → `exitSimulation` ⑥ 저장 → 불러오기. 작업마다 ms를 잽니다. 전부 **`__ds`로 직접 쓰는 호출**입니다(벤치는 읽기 전용 원칙의 대상이 아님).
- 표본(`SAMPLE_EVERY`바퀴마다, `:202-217`): CDP `HeapProfiler.collectGarbage` 두 번 → `Runtime.getHeapUsage`(heapMB), `renderer.info.memory.geometries/textures`, `programs`, 장면 객체 수(`scene.traverse`), `performance.memory`(pageHeapMB), `DOMDebugger.getEventListeners`로 window·document 리스너 수(`:189-198`). 결과 `growth`(처음 → 끝)와 `iterMs`(`:287-292`).
- 기준값(Phase 36, 1000개 장면): 리스너 window 9 / document 2, geometries 34 → 36, 힙 31 → 46 MB(`docs/bench-phase36-leak.json`) (C).
- 출력 JSON은 `{date, url, mode, rows}`뿐입니다(`:295`). **부하(1/5/15분)·커밋·메모리 여유는 스크립트가 적지 않고** Phase 36 보고서에 손으로 적었습니다(`docs/ADVANCED_WORLD_EDITOR.md` §23) (C) → U24.

Phase 37 바퀴에 더할 것(명세 §17·§22): 명령창 열기/닫기, 계획/취소, 확정/되돌리기. 바퀴는 `page.evaluate` 한 번 안에서 돌므로 실제 키보드를 쓸 수 없습니다 → 페이지 안에서 부를 `__ds.command.open()/close()/plan(text)/cancel()/confirm()`이 필요합니다(U17). 리스너 수가 늘지 않는지(명령창이 window에 리스너를 달았다 떼는지)를 같은 표본이 잡아 줍니다.

### 5.4 `scripts/look-editor36.mjs` (166줄) (C)

합격·불합격이 아닌 화면 모음. 머리(실행·`fresh`·`view`·`screen`·`clickWorld`·`shot`)는 verify와 같은 코드(`:7-91`). 빈 땅을 찾아(`:99-110`) 브러시 미리보기 5장, 핀이 새 지면 위에 다시 놓이는 전/후, 도로 폭 전환 → `docs/verify/editor36/look/<이름>-<lang>.png`. 환경 `PIN_ONLY`. 끝에 페이지 오류만 출력(`:165`). `look-command37.mjs`는 같은 머리 + 미리보기 유령·요약·모호성 선택·도움말 화면.

### 5.5 한글 입력: 지금까지의 방식과 S2에 필요한 것

- (C) 기존 스크립트의 한글 입력은 `page.keyboard.type('폭발을 일으켜')`·`input.type(...)`(`scripts/verify-ux355.mjs:188`, `verify-phenomena.mjs:138,142`, `verify-flood.mjs:149`). puppeteer는 자판에 없는 글자를 `Input.insertText`로 보냅니다(`node_modules/puppeteer-core/lib/puppeteer/cdp/Input.js:119-131`) → **`compositionstart`가 한 번도 나지 않았습니다.**
- (C) `Input.imeSetComposition`은 scripts 어디에서도 쓰지 않고(`grep` 0건), puppeteer-core 타입에도 래퍼가 없습니다 → `const cdp = await page.createCDPSession()`(다른 벤치의 방식, `scripts/bench-blast.mjs:31`) 뒤 `cdp.send('Input.imeSetComposition', { text, selectionStart, selectionEnd })`를 직접 보내야 합니다. 조합 확정은 `Input.insertText`.
- (S) CDP로 만든 조합 중에 `page.keyboard.press('Enter')`를 보내면 keydown의 `isComposing`은 true지만 `keyCode`는 13일 것입니다(229가 아님). 가드를 229만으로 짜면 실제 입력기는 통과하고 이 시험은 실패합니다 → §2.5처럼 둘 다 봅니다.
- 물리 키 이름: `page.keyboard.press('Slash')` → `code: 'Slash'`, `key: '/'`(`node_modules/puppeteer-core/lib/puppeteer/common/USKeyboardLayout.js:271`) (C). 한글 상태의 `e.key`(자모)는 CDP `Input.dispatchKeyEvent`에 `key`·`code`를 따로 줘서 흉내 낼 수 있습니다 (S).

### 5.6 옛 명령 서랍에 기대는 기존 스크립트 (U16)

명세는 기존 Chrome 스크립트가 전부 다시 통과해야 한다고 합니다(§21 끝).

| 스크립트 | 기대는 것 | 줄 |
|---|---|---|
| `verify-ux355.mjs` | `[data-testid="command-toggle"]` 클릭 → `[data-testid="command-input"]`에 "폭발을 일으켜" + **Enter 한 번 → 시뮬레이션이 돌고 blast가 실행 중** | 186-193 |
| `verify-flood.mjs` | `input[placeholder*="Enter"]`에 비 + 수위 명령 + Enter → 홍수 실행 | 146-153 |
| `verify-phenomena.mjs` | 같은 입력란에 글을 넣고(Enter 없음) 화면에서 "미구현 현상 / Not implemented" 미리보기 글 | 134-145 |
| 그 밖 23개 | 선택자에 `command-input`·`cmd-`·`placeholder*="Enter"`가 있으면 `__ds.ui.getState().setCommandOpen(true)`로 서랍을 여는 공통 보정 코드 | 예 `verify-blast.mjs:28,32` |

즉 ① `ui.commandOpen`/`setCommandOpen` ② 두 testid ③ placeholder에 "Enter" ④ **재난 문장 + Enter 한 번 = 즉시 실행**이 계약입니다 (C). Phase 37의 "편집은 미리보기 → Enter 확정"(§9)과 ④가 부딪칩니다. 옛 문장 부류(바람·비·지진·폭발 "일으켜")를 "실행 제어 = 바로 적용"으로 둘지, 스크립트 기대값을 바꿀지는 A2(옛 명령 체계) 감사와 함께 정해야 하고, 바꾸면 명세 §25대로 목록을 남겨야 합니다.

---

## 6. 명령창이 놓일 UI

### 6.1 지금의 배치 (C)

```
┌────────────────────────── TopBar 46 px ─────────────────────────────┐
│ 왼쪽 팔레트   │ 뷰포트(canvas, 남는 높이 전부)          │ 오른쪽 패널 │
│ 236 px        │  ┌좌상: 모드 배지 + 세로 도구 막대      │ 320 px      │
│ (≤1380: 216)  │  │우상: (패널 열기) + 나침반 64 px      │ (≤1380: 300,│
│               │  │좌하: 힌트 줄(스냅·축 잠금·경고)      │  닫으면 0)  │
│               │  └하단 중앙: 영역 적용 막대             │             │
│               ├─────────────────────────────────────────┤             │
│               │ 타임라인 44 px (+ 지진 실행 중 54 px)   │             │
│               │ "명령어 ▸" 줄 26 px (+ 서랍 210 px)     │             │
└─────────────────────────────────────────────────────────────────────┘
```

| 부분 | 치수·성질 | 근거 |
|---|---|---|
| 격자 | 행 `46px minmax(0,1fr)`, 열 `236px minmax(0,1fr) 320px`. 오른쪽 닫힘 = 0. 창 폭 ≤ 1380: 216 / 300 | `src/app/AppLayout.module.css:1-14` |
| 가운데 열 | 행 `minmax(0,1fr) auto`: 뷰포트가 남는 높이, 아래 띠는 내용 높이 | `AppLayout.module.css:18-26` |
| 뷰포트 | `position: relative; overflow: hidden` | `AppLayout.module.css:27` |
| 아래 띠 | `border-top 1px; overflow: hidden; min-width: 0` | `AppLayout.module.css:28` |
| 아래 띠 내용 | `Timeline`(min-height 44) + `Seismogram`(54, 시뮬 + 지진일 때만) + 명령 줄(26) + 서랍(210, `ui.commandOpen`) | `src/ui/BottomPanel/BottomPanel.tsx:14-33`, `BottomPanel.module.css:30-32`, `src/ui/Timeline/Timeline.module.css:1`, `Seismogram.module.css:1`, `Seismogram.tsx:31` |
| 옛 명령 패널 | 서랍 안: 머리 32 + 기록(늘어남) + 예문 칩 줄 + 해석 한 줄(min-height 21) + 입력 줄. **아래 띠에 탭은 없음**(35.5에서 재난 폼은 오른쪽 패널로 감) | `src/ui/BottomPanel/CommandPanel.tsx:83-123`, `CommandPanel.module.css:1-24`, `BottomPanel.tsx:9-13` |
| 서랍 여닫기 | `setCommandOpen` → `relayout()`(다음 프레임에 window `resize`) → 캔버스가 새 높이를 따름. `ds.commandOpen` 저장, 기본 닫힘 | `src/ui/uiStore.ts:16-19,90-95` |
| 뷰포트 오버레이 | 좌상(10, 10) 배지 + 세로 도구 막대(단추 30 px), 우상 나침반·HUD(높이 50 % 이내), 좌하(10, 10) 힌트, 하단 중앙 영역 적용 막대, 우하(시뮬) 표시 옵션, 상단 중앙(건물 편집) 편집 막대 | `src/ui/Viewport/ViewportContainer.tsx:57-116`, `ViewportContainer.module.css:1-11,26`, `ViewportToolbar.module.css:1-2` |
| 힌트 줄 | `data-testid="viewport-hint"`. 그 안에 `gizmo-state`(객체 축·축 잠금), `snap-hint`(`data-kind`), `ghost-warning` 꼬리표 | `ViewportContainer.tsx:83-97`, `src/ui/Viewport/BuildOverlays.tsx:32-51` |
| 토스트 | `position: fixed; top: 56px; left: 50%`(창 기준 가운데), z-index 100, 최대 4개, 3.2 초(오류 6 초) | `src/ui/common/Toaster.module.css:1-2`, `src/ui/common/toast.ts:16-20` |
| 도움말 | 상단 `?` 단추 → 모달(`aria-modal`) | `src/ui/TopBar/HelpDialog.tsx:32-83` |
| 모달 | `ResultsPanel`·`ComparisonDialog`·`BlueprintDialogs`는 격자 밖/끝에 장착 | `src/app/App.tsx:16-19`, `src/app/AppLayout.tsx:33` |

### 6.2 레이아웃 기준과 높이 예산

S19가 재는 것(`scripts/verify-editor36.mjs:541-559`) (C): 네 크기마다 `fresh()` 뒤 `share = 캔버스 넓이 / 창 넓이`, 오른쪽 패널과 캔버스의 겹침, `documentElement.scrollWidth > innerWidth`. 합격 = `share ≥ 0.35 && overlap < 1 && !hscroll`(`:554`). 잘린 단추 목록 `clipped`(`button, [role="tab"]` 가운데 `scrollWidth > clientWidth + 2`이고 overflow가 visible이 아닌 것)는 **계산해서 기록만 하고 합격 조건에는 없습니다**(`:551,554`) → U14. 측정은 항상 `localStorage.clear()` 뒤라 **서랍이 닫힌 상태뿐**입니다(`:42`, `uiStore.ts:90`).

캔버스 = (창 폭 − 왼쪽 − 오른쪽) × (창 높이 − 46 − 71). 71 = 아래 띠 테두리 1 + 타임라인 44 + 명령 줄 26. 이 식의 값이 기록된 측정값과 소수 넷째 자리까지 같습니다(`docs/verify/editor36/results-ko.json`의 S19: 0.6335 / 0.5341 / 0.5275 / 0.4999) (C).

| 창 | 캔버스(px) | 지금 3D 면적 | 35 %가 되는 캔버스 높이 | 남는 높이(편집) | 남는 높이(시뮬 + 지진 54) | 옛 서랍(+210) 열면 |
|---|---|---|---|---|---|---|
| 1920×1080 | 1364 × 963 | 63.3 % | 533 | 430 | 376 | 49.5 % |
| 1440×900 | 884 × 783 | 53.4 % | 514 | 269 | 215 | 39.1 % |
| 1366×768 | 850 × 651 | 52.7 % | 432 | 219 | 165 | 35.7 %(지진 중 31.4 %) |
| 1280×720 | 764 × 603 | 50.0 % | 423 | **180** | **126** | **32.6 % — 기준 미달**(지진 중 28.1 %) |

(오른쪽 패널이 열린 경우. 닫으면 캔버스가 넓어져 전부 더 여유롭습니다. "옛 서랍" 열은 CSS로 계산한 값입니다 — (C) 치수, (S) 실제 화면.) → U13.

**놓을 자리 후보** (C: 치수와 겹침 / 권장은 판단):

| 자리 | 겹치는 것 | 3D 면적 | 판정 |
|---|---|---|---|
| 뷰포트 위쪽 오버레이 | 건물 편집 막대(상단 중앙), 나침반·HUD(우상), 도구 막대(좌상), **토스트(상단 56 px)** | 안 줄지만 화면을 가림 | 쓰지 않음 |
| 뷰포트 아래쪽 오버레이 | 힌트 줄(좌하), 영역 적용 막대(하단 중앙), 표시 옵션(우하) | 안 줄지만 가림. S19 식으로는 통과해도 "3D 면적" 기준의 뜻과 어긋남 | 쓰지 않음 |
| 가운데 열에 새 행(뷰포트 바로 위) | 없음 | 행 높이만큼 줆 | 가능하나 아래에 이미 줄이 있음 |
| **아래 띠의 26 px 명령 줄을 입력 줄로 교체** | 없음. 편집·시뮬 두 모드 모두에 이미 있음 | 닫힘 상태는 지금과 같음 | **권장** |

권장 구성과 계산(오른쪽 패널 열림 기준):

| 상태 | 높이 | 1920×1080 | 1440×900 | 1366×768 | 1280×720 |
|---|---|---|---|---|---|
| A 닫힘(지금의 26 px 줄 그대로: 단추 + "`/`" 안내) | +0 | 63.3 % | 53.4 % | 52.7 % | 50.0 % |
| B 열림: 입력 줄 32 + 요약 한 줄 22 = 54(26을 대신함) | +28 | 61.5 % | 51.5 % | 50.5 % | 47.7 % |
| C 결과 펼침: B + R, **R = min(160px, 100vh − 640px)** → 160 / 160 / 128 / 80 | +28 + R | 51.0 % | 40.6 % | 40.1 % | 41.0 % |
| C + 지진 실행 중(지진 기록 54) | | 47.4 % | 36.9 % | 35.7 % | 36.6 % |

전부 35 % 이상입니다(가장 빠듯한 칸 1366×768 지진 중 35.7 %). CSS 계산이므로 S20에서 실제로 재야 합니다 (S). S20은 **B·C 상태로 만든 뒤** 재고, `clipped.length === 0`도 합격 조건에 넣어야 합니다.

지켜야 할 제약 (C):
- **입력 중에 높이가 바뀌면 안 됩니다.** 아래 띠 높이가 바뀌면 뷰포트 높이가 바뀌고 캔버스가 다시 크기를 잡습니다(`uiStore.ts:16-19`의 주석). 글자마다 실시간 해석이 줄 수를 바꾸면 타이핑 중 캔버스가 계속 리사이즈됩니다. 요약은 **고정 높이 한 줄**(옛 `.preview`처럼 `min-height` + 말줄임, `CommandPanel.module.css:18`)로 두고, 결과 영역(C)은 Enter·단추 같은 명시적 동작에서만 여닫습니다.
- **팝업은 잘립니다.** 아래 띠와 뷰포트 모두 `overflow: hidden`(`AppLayout.module.css:27-28`)이라 입력 줄 위로 뜨는 자동 완성·후보 목록을 그 안에 그리면 잘립니다. `document.body`로 portal 하거나 결과 영역 안(흐름 안)에 그립니다(U15).
- 가로: 가운데 열은 `minmax(0, 1fr)` + `overflow: hidden`이라 긴 요약은 스크롤이 아니라 잘립니다 → 말줄임. 단추에는 말줄임을 쓰지 않습니다(S19의 `clipped`에 걸림).
- 명령 결과는 토스트로 다시 띄우지 않습니다(최대 4개·3.2 초, 상단 가운데). 명령창 안에 남깁니다.

### 6.3 미리보기에 다시 쓸 수 있는 것

**객체 유령**

| 있는 것 | 방식 | N개에 쓸 수 있나 | 근거 |
|---|---|---|---|
| 배치 도구 유령 | `StaticObjectView` React 뷰 1개 + `MaterialModeContext`(ghost / ghostWarn / ghostInvalid) | 아니요(1개용) | `src/editor/tools/PlaceTool.tsx:157-163`, `src/rendering/materials.ts:9,54-69` (C) |
| **`PlanPreview`** | `PlannedObject[]`를 재질별(파랑·주황·빨강)로 묶어 `GhostBatch` = `new SimRenderAdapter(staticRuntime(objects), terrain)`(시뮬과 같은 BatchedMesh 배치) + 재질 덮어쓰기, 레이캐스트 끔, 언마운트 시 `dispose()` | **예** — 브러시·선·영역·붙여넣기가 이미 씀 | `src/editor/tools/shared.tsx:78-137`, `BulkTools.tsx:106,179,309`, `PasteTool.tsx:74` (C) |
| `PlannedObject` | `{input: CreateObjectInput, ok, rejected?, warnings[]}` — `rejected`는 `outside`·`slope`·`collision` 중 하나 | 명령 계획의 "생기는 것"을 이 모양으로 내면 그대로 그려짐 | `src/editor/build/placementPlan.ts:68-75` (C) |

- 비용: `objects` 배열이 바뀔 때마다 어댑터를 새로 만듭니다(`shared.tsx:83-95`의 effect 의존). 뒤에 덧붙는 경우만 꼬리 구간(96개 단위)을 따로 만듭니다(`:104-127,141`) (C). 명령의 실시간 미리보기는 글자마다 계획이 통째로 바뀌므로 **매번 전체 재생성**입니다 — 1000개 유령의 재생성 시간·그리기 호출은 측정해야 합니다(명세 §22) (S). 디바운스 + "계획 해시가 같으면 다시 만들지 않음"이 필요합니다.
- 유령마다 `createWorldObject(p.input, 0)`을 부릅니다(`shared.tsx:121`). `input.seed`가 없으면 `Math.random()`으로 시드를 뽑습니다(`src/world/WorldDocument.ts:70`) (C) → 명령 계획은 시드를 반드시 넣어야 미리보기와 확정 결과가 같습니다. 배치 도구 자신도 `Math.random()` 변형 시드를 씁니다(`PlaceTool.tsx:63,67,151`) — 명령 경로에서 재사용 금지(U26).
- **바뀌는 것·지워지는 것의 강조**(이동·삭제·모호성 후보): 일괄 윤곽 컴포넌트가 없습니다. 있는 것은 객체 하나용 `HoverBox`(`src/editor/EditorScene.tsx:143-153`)와 `SelectionBox`(선 + 바닥 판, geometry를 직접 dispose — `src/rendering/SelectionBox.tsx:14-31`) (C). 후보 수십 개면 이것을 반복해도 되지만 삭제 미리보기 2000개에는 InstancedMesh 윤곽이 필요합니다(U18).
- 장착 위치: 편집 장면에만(`EditorScene.tsx:211-246`). 도구별 조건부 장착 옆에 `<CommandPreviewLayer />`를 한 줄 더하면 됩니다. 시뮬 장면에는 재난 핀 층만 공통입니다(`EditorScene.tsx:219`).

**스냅 표지**: `SnapMarker`는 `snapHint`의 점 **하나**에 고리 + 기둥을 그립니다(`src/editor/snap/SnapMarker.tsx:12-31`, `snapHint.ts:4-18`) (C). "주택 세 채"의 스냅 세 곳을 보여 주려면 목록을 받는 표지가 필요합니다(U19). 색·모양(`#ffd166` 도로 계열, `#9fd0ff` 객체, `#c3a6ff` 구조 격자)과 힌트 문구 `snap.kind.*`(`ko.p36editor.ts`)는 그대로 씁니다.

**재난 핀**: `PlacementLayer`가 그립니다 — 기둥(7 m) + 머리 공, 영향 범위 고리(`GroundLine`, 참고 범위는 점선), 글 라벨(캔버스 텍스처 sprite, dispose 함)(`PlacementLayer.tsx:41-94`) (C).
- `Pin`·`Ring`·`Label`은 파일 안 전용(export 없음)이고, 무장 중 커서 미리보기(`:253-272`)가 사실상 "유령 핀"입니다 → 명령 계획의 유령 핀은 이 층에 목록으로 넘겨 그리는 것이 가장 작습니다(U20).
- **핀은 조건부로만 보입니다**: 무장 중 / 핀 선택 중 / 끌기 중 / 오른쪽 패널이 열려 있고 탭이 "재난"일 때(`:125`) (C). 명령으로 재난을 넣어도 다른 탭이면 핀이 안 보입니다(S11 "핀 + 인스턴스"). 마우스 배치는 `placeAt`이 새 인스턴스를 선택해서 보이게 하는데(`src/app/placementActions.ts:70`), 핀을 선택하면 입력 정책이 편집 도구를 나가고 **객체 선택을 비웁니다**(`src/app/inputPolicy.ts:64-71`) → 명령에서 어떻게 할지 정해야 합니다.
- 마우스 배치는 좌표를 0.1 m로 반올림하고(`PlacementLayer.tsx:158`) `placeAt`은 토스트를 띄우며 "지금 실행" 모드면 바로 실행합니다(`placementActions.ts:63-74`) (C) — S11의 "마우스 배치와 같은 값"은 같은 반올림을 거쳐야 맞습니다.
- 핀 높이는 그릴 때의 지면(`:78-81`) — Phase 36 §20 정책 그대로입니다.

**지형 열 지도**: Phase 36 §12의 미리보기 (C).
- 계산: `previewDab(terrain, dabOptions, seconds = 1, step = 1/20)` — 브러시 사각형(+1칸)을 임시 격자에 복사해 **실제 `applyDab`**을 돌리고 `{rect, dh: Float64Array, painted: Uint8Array, up, down, area}`를 돌려줌. 문서는 안 건드림(`src/terrain/TerrainEditor.ts:245-293`).
- 그리기: `PreviewMesh` — 사각형의 꼭짓점마다 정점 하나, 높이 변화로 색(올림 = 주황, 내림 = 파랑, 진할수록 큼, 변화 없음 = 투명), 칠하기는 칠 색. `depthTest` 끔, `renderOrder 9`(`src/editor/tools/TerrainTool.tsx:76-128`). 100 ms 간격 + 키가 같으면 건너뜀(`:250-253`).
- 빈 곳(U21): ① `PreviewMesh`는 `TerrainTool.tsx` 안 전용 클래스이고 지형 도구가 켜져 있을 때만 장착됩니다. ② `previewDab`은 **한 점에 1초**용입니다. "반경 10 m 평탄화"처럼 여러 점을 찍는 프로그램 획 전체의 변화량을 내는 함수가 없습니다 → 같은 방식(임시 격자 + 실제 `applyDab`)으로 `previewStroke(terrain, dabs[])`를 `TerrainEditor.ts`에 두고, 결과를 같은 `{rect, dh, painted, up, down, area}` 모양으로 내면 `PreviewMesh.show`가 그대로 그립니다. 지도의 50 %(약 2만 꼭짓점)도 정점 배열 하나입니다.
- 패널 문구는 `editorStore.brushPreview {up, down, area}`를 읽습니다(`src/editor/editorStore.ts:68-69`, `TerrainTool.tsx:263`) — 명령 요약도 같은 세 값을 쓰면 됩니다.

### 6.4 입력 정책 표 — 열린 명령 계획이 들어갈 자리 (명세 §9)

`installInputPolicy()`는 저장소 구독만으로 된 규칙 모음입니다(React·DOM 없음, `src/app/App.tsx:10`에서 한 번) (C).

| 일어난 일 | 감지 | 지금 하는 일 | 근거(`src/app/inputPolicy.ts`) |
|---|---|---|---|
| 재난 배치 무장(`type` null → 값) 또는 핀 선택 | `usePlacementStore.subscribe` | 편집 모드면 편집 도구 나가기(`exitEditorTool`) + 객체 선택 비움 | 64-71, 29-56 |
| 모드 전환(편집 ⇄ 시뮬) | `useEditorStore.subscribe` | 제스처 취소, 카메라 잠금 전부 해제, `dragging` 끔 | 73-79 |
| 도구 변경 | 같음 | 제스처 취소. 새 도구가 select가 아니면 재난 무장 해제 + 핀 선택 해제 | 80-87 |
| 객체 선택이 생김 | 같음 | 핀 선택 해제 | 88-91 |
| 오른쪽 패널 닫힘 | `useUiStore.subscribe` | 재난 무장 해제 | 94-96 |
| 문서 교체(`docVersion` 변경) | `useWorldStore.subscribe` | 제스처 취소, 카메라 잠금 해제 | 98-102 |
| `doc.objects` 참조 변경 | 같음 | 없어진 id를 선택에서 뺌(편집 모드) | 103-109 |

시험: `src/editor/input/input.test.ts:238-290`.

명령 계획이 합류할 규칙(U22):

| 일어난 일 | 계획에 할 일 | 붙일 자리 |
|---|---|---|
| 모드 전환 | 취소(유령 제거) | 74-79 분기 |
| 문서 교체 | 취소 + 결과 집합 비움(명세 §7) | 99-102 분기 |
| 편집 도구 무장(도구가 select 아닌 것으로) | 취소 | 80-87 분기 |
| 재난 배치 무장 | 취소 | 64-71 분기(`armed`일 때만. 핀 선택은 제외할지 결정) |
| `doc.objects`·도로·지형 참조 변경(실행 취소, 다른 편집) | 취소가 아니라 **다시 계획**, 달라졌으면 알림(명세 §9) | 103-109 분기 옆 |
| 선택 변경(계획이 `selection`을 가리킬 때) | 다시 계획 | 88-91 분기 옆 |
| (반대 방향) 계획이 만들어짐 | 편집 도구 나가기 + 재난 무장 해제 — 배치 도구 유령과 명령 유령이 함께 보이지 않게. **결정 필요** | 새 구독 |
| 끌기 중(`activeGesture()`)·획 중(`busy()`) | 확정 거부 | 확정 함수 |

그러려면 열린 계획은 React 지역 상태가 아니라 **저장소**(zustand)에 있어야 정책이 `cancelPlan()`을 부를 수 있습니다. 옛 `CommandPanel`의 미리보기는 컴포넌트 지역 상태입니다(`CommandPanel.tsx:30-32`) (C).

### 6.5 오른쪽 클릭 맥락 메뉴(명세 §14)의 바탕 (U25)

- 오른쪽 버튼 = 카메라 이동(`CameraRig.tsx:76`), 캔버스 `contextmenu`는 `preventDefault`만(`Viewport.tsx:15`). 맥락 메뉴는 어디에도 없습니다 (C).
- 오른쪽 **끌기**(이동)와 오른쪽 **클릭**(메뉴)을 갈라야 합니다. `contextmenu` 이벤트는 macOS에서 버튼을 누를 때, Windows에서는 뗄 때 납니다 (S) → `pointerdown(button 2)`부터 `pointerup`까지 이동이 5 px 미만일 때만 메뉴를 여는 방식을 권합니다(배치 도구의 "카메라 끌기 무시"와 같은 임계, `PlaceTool.tsx:129`).
- 클릭 위치 → 지면 점은 `PlacementLayer.tsx:151-159`와 같은 계산. §1.6의 커서 추적기를 만들면 그것을 씁니다.
- 닫기: `role="menu"` 팝업의 기존 방식은 바깥 `mousedown`(`TopBar.tsx:81-87`)뿐이고 Esc는 없습니다 (C). 메뉴에 Esc를 넣으려면 §2.4의 사슬과 순서를 정해야 합니다(메뉴 → 계획 → 창).

---

## 7. 범위 밖에서 본 것(다른 감사와 겹침 — 참고)

- 객체 id는 무작위입니다(`src/core/id.ts:3-10`). "같은 스크립트 + 같은 시작 문서 → 같은 결과 문서 해시"(명세 §15·§18)는 id를 결정적으로 만들거나 해시에서 정규화해야 성립합니다 (C). 이름·식별자 감사(A1) 소관이지만 Chrome S22의 해시 훅(§4)과 직접 묶여 있습니다.
- 옛 명령 체계(`src/commands/`, `executeCommand` — `src/app/actions.ts:557-598`)와 새 `src/command/`의 관계는 A2 소관입니다. 이 문서에서는 화면·스크립트 계약(§5.6)만 적었습니다.

---

## 8. 결함·빈 곳

| # | 결함·빈 곳 | 근거 file:line | 명령에 미치는 영향 | 권장 처리 |
|---|---|---|---|---|
| U1 | (C) 각도 규약이 둘: 재난 칸은 방위각(북 0, 시계, °), 객체는 yaw(로컬 +x가 동 = 0, 반시계, rad 저장·° 표시). `heading=<°>`의 뜻이 정해져 있지 않음 | `src/core/compass.ts:16-20`, `src/terrain/groundPlacement.ts:117-121`, `src/editor/build/numericTransform.ts:84-94` | "30도 회전", "북쪽을 보게", `heading=90`이 종류·문맥마다 다른 값이 될 수 있음 | `heading` = 인스펙터 "Y 방향" 값으로 고정, 방위 낱말은 변환 함수 하나로. 요약에 "방향 90°(북쪽을 봄)"처럼 둘 다 표시. §26 결정 항목에 추가 |
| U2 | (C) "앞" 축이 종류마다 다름: 건물·사람 +z, 차량 +x | `src/buildings/generate.ts:5,336`, `src/vehicle/demos.ts:44`, `src/human/anthropometry.ts:17-18`, `src/editor/snap/snapEngine.ts:113-122` | "도로를 향하게", "앞쪽 맞춰"를 한 식으로 풀면 차와 건물 중 하나가 90° 틀어짐 | `frontAxisOf(type)` 순수 함수를 스냅과 함께 쓰는 곳에 두고 시험. 정렬의 "앞쪽"은 되묻기 |
| U3 | (C) 도로의 왼쪽/오른쪽은 a→b 기준인데 화면에 a→b 표시가 없음 | `src/roads/types.ts:58-64,102`, `src/roads/curve.ts:131-132`, `src/ui/Roads/RoadPanel.tsx:96` | `side=left`를 사용자가 확인할 수 없음. "도로 북쪽"은 남북 도로에서 뜻이 없음 | 요약에 방위 병기("s2의 북쪽 = a→b 왼쪽"). 방위와 도로가 나란하면 모호함으로 되묻기 |
| U4 | (C) 커서 지면 점을 보관하는 곳이 없음. select 도구에서는 추적 자체가 없음 | `src/editor/tools/shared.tsx:28-35`, `src/editor/tools/PlaceTool.tsx:55,121-127`, `src/ui/placement/placementStore.ts:43-44`, `src/editor/EditorScene.tsx:211-246` | "여기"(명세 §4 Context·§7)를 채울 값이 없음 | 캔버스 `pointermove` 추적기(지면 점 + 떠난 시각)를 UI 상태로. 포인터가 떠난 뒤의 유효 시간 규칙을 문서화 |
| U5 | (C) 카메라 주시점을 Canvas 밖에서 읽을 수 없음(`__r3f`는 개발 전용). `controls.target`의 높이는 지면이 아닐 수 있음 | `src/rendering/CameraRig.tsx:18,23,57-63`, `src/rendering/Viewport.tsx:16-18`, `src/app/actions.ts:52` | "저기"·`view` 위치를 채울 수 없음 | CameraRig에 "화면 중심 광선 ∩ 지형" getter를 `viewStore`로 노출. 정의를 요약에 표시 |
| U6 | (C) 월드 경계의 출처가 둘(상수 ±100 / 문서 지형 `mapHalf()`), 스키마는 다른 격자 크기 허용 | `src/editor/placement.ts:17`, `src/editor/build/numericTransform.ts:36-37`, `src/app/placementActions.ts:27-30`, `src/world/serialization.ts:70-72` | 객체 명령과 재난 명령이 "월드 밖"을 다르게 판정할 수 있음(지금 만들 수 있는 월드는 모두 200 m라 실제 차이는 없음) | 명령의 경계 검사는 기존 함수(`isInsideWorld`·`placement.set`)를 그대로 부르고 새 상수를 만들지 않음 |
| U7 | (C) 옛 명령 입력란의 Enter에 조합 검사가 없음. 저장소 전체에 입력란 Enter의 `isComposing`/229 검사 0건. (S) macOS Chrome에서 조합 중 Enter가 바로 제출되고 마지막 글자가 빈 칸에 남거나 두 번 처리될 수 있음 | `src/ui/BottomPanel/CommandPanel.tsx:50-68`, `src/ui/common/fields.tsx:102-103`, `src/ui/ObjectPalette/Outliner.tsx:132,151` | 명세 §6·S2 위반. 한글로 끝나는 모든 문장이 해당 | 새 입력란: `nativeEvent.isComposing`이 참이거나 `keyCode === 229`이거나 `compositionstart/end`로 센 깃발이 서 있으면 Enter·Tab·↑/↓·Esc 무시. 아웃라이너 이름 바꾸기(그룹 이름을 한글로 침)에도 같은 가드 |
| U8 | (C) 기존 Chrome 스크립트는 한글을 `Input.insertText`로 넣어 조합을 만들지 않음. `Input.imeSetComposition` 사용 0건, puppeteer 래퍼 없음 | `scripts/verify-ux355.mjs:188`, `node_modules/puppeteer-core/lib/puppeteer/cdp/Input.js:119-131` | S2를 기존 도우미로는 쓸 수 없음. (S) CDP 조합 중 Enter는 `keyCode` 13일 수 있음 | `verify-command37.mjs`에 `compose(text)`/`commit(text)` 도우미(CDP 세션). 가드는 `isComposing`과 229 둘 다 |
| U9 | (C) `isTyping`이 INPUT의 종류를 가리지 않음: range 슬라이더·checkbox·color에 초점이 남으면 모든 단축키가 죽음 | `src/editor/input/keys.ts:4-9`(대조: `src/ui/Inspector/VehicleControls.tsx:30-38`) | 오른쪽 패널의 슬라이더를 만진 직후 `/`로 명령창이 열리지 않음 | `VehicleControls`의 판정을 `keys.ts`로 옮겨 `isTyping`을 가늘게(기존 단축키에도 이득). 시험 추가 |
| U10 | (C) Esc 사슬에 "열린 계획" 자리가 없음. 초점이 뷰포트면 Esc가 재난 해제·선택 해제 등으로 감 | `src/app/hotkeys.ts:199-205,238,325-332` | 명세 §14 "Esc: 계획 먼저 → 창"이 초점 위치에 따라 깨짐. 계획이 가리키던 선택이 Esc로 풀림 | 전역 사슬 맨 앞(238 앞)에 "계획 열림 → 취소"를 추가. 입력란 안에서는 입력란 처리기가 같은 순서로 |
| U11 | (C) 시뮬레이션 분기가 일찍 `return`하고, Space에 보조 키 검사가 없음 | `src/app/hotkeys.ts:253-260` | 여는 키를 그 뒤에 두면 실행 중에 안 열림(명세 §12). Ctrl+Space 후보는 재생 토글과 겹침 | 여는 키를 230 뒤·238 앞에. Space에 `!mod` 추가는 선택(기존 동작 변경이므로 기록) |
| U12 | (C) `keyOf`가 `/`·`;`·`` ` ``를 `e.key`로 읽음(물리 키 아님) | `src/editor/input/keys.ts:17-23` | 명세 §14 "물리 키 기준"과 다름. 다른 자판 배열에서 `/` 위치가 달라짐 | `Slash → '/'` 매핑 추가 + `input.test.ts:135-142`에 시험 |
| U13 | (C 치수 / S 화면) 옛 명령 서랍 210 px: 1280×720에서 3D 면적 32.6 %(지진 중 28.1 %), 1366×768 지진 중 31.4 %. S19는 서랍이 닫힌 상태만 잼 | `src/ui/BottomPanel/BottomPanel.module.css:30-32`, `src/app/AppLayout.module.css:1-28`, `scripts/verify-editor36.mjs:42,541-559`, `src/ui/uiStore.ts:90` | 서랍을 그대로 키워 쓰면 §14 기준 미달 | §6.2 구성(입력 32 + 요약 22, 결과 R = min(160px, 100vh − 640px)). S20은 열림·펼침 상태에서 측정 |
| U14 | (C) S19가 잘린 단추 `clipped`를 기록만 하고 합격 조건에 넣지 않음. 겹침은 오른쪽 패널만 봄 | `scripts/verify-editor36.mjs:551,554` | "잘린 단추 없음"(§14)을 어겨도 통과함 | S20에서 `clipped.length === 0`과 명령창 ↔ 캔버스 겹침 0을 조건에 추가. 기존 S19는 손대지 않음(기대값 변경 목록 불필요) |
| U15 | (C) 아래 띠·뷰포트가 `overflow: hidden`. 아래 띠 높이가 바뀌면 캔버스가 리사이즈됨 | `src/app/AppLayout.module.css:27-28`, `src/ui/uiStore.ts:16-19,91-95` | 자동 완성·후보 팝업이 잘림. 실시간 해석이 줄 수를 바꾸면 타이핑 중 캔버스가 계속 리사이즈 | 팝업은 body portal 또는 결과 영역 안. 요약은 고정 높이 한 줄. 결과 영역은 명시적 동작에서만 여닫음 |
| U16 | (C) 기존 Chrome 스크립트 3개가 옛 명령 서랍의 testid·placeholder("Enter")·"Enter 한 번 = 즉시 실행"에 기대고, 23개의 공통 보정 코드가 `ui.commandOpen`/`setCommandOpen`을 부름 | `scripts/verify-ux355.mjs:186-193`, `scripts/verify-flood.mjs:146-153`, `scripts/verify-phenomena.mjs:134-145`, `scripts/verify-blast.mjs:28,32` | 명령창을 바꾸면 "기존 스크립트 전부 통과"(§21)가 깨짐. "미리보기 → 확정"과 "즉시 실행"이 충돌 | `data-testid="command-input"`·`command-toggle`·`ui.commandOpen`·placeholder의 "Enter"를 유지. 옛 재난 실행 문장을 "바로 적용" 부류로 둘지 A2와 결정, 기대값을 바꾸면 목록으로 기록 |
| U17 | (C) `__ds`에 명령 상태가 없음. 문서 해시는 무작위 id를 포함, 지형 해시 함수 없음, `tr`은 매개변수 미지원, 토스트 미노출 | `src/app/devtools.ts:114-423`(특히 140, 143), `src/world/fingerprint.ts:9-20`, `src/core/id.ts:3-10` | S9(지형 비트 동일)·S10·S16·S22(같은 결과 해시)·S13(기록 불변)·누수 바퀴를 쓸 수 없음 | `__ds.command = { state(), open(), close(), plan(text), cancel(), confirm(), resultSets(), history() }`, `__ds.hash = { doc(정규화), terrain(), objects(), roads(), scenario() }`, `tr(key, params)`. 검증 스크립트는 읽는 것만, 바퀴 벤치만 쓰는 것을 사용 |
| U18 | (C) N개 유령은 `PlanPreview`가 있으나 배열이 바뀔 때마다 배치 어댑터를 새로 만듦. 변경·삭제 대상의 일괄 강조 컴포넌트는 없음(`HoverBox`는 1개용) | `src/editor/tools/shared.tsx:78-137`, `src/editor/EditorScene.tsx:143-153`, `src/rendering/SelectionBox.tsx:14-31` | 입력 중 실시간 미리보기가 글자마다 전체 재생성 → 프레임 저하 가능(S, §22에서 측정). 삭제 2000개 강조 수단 없음 | 계획을 `PlannedObject[]`로 내고 `PlanPreview` 재사용, 디바운스 + 계획 해시가 같으면 유지. 강조는 InstancedMesh 윤곽 하나 |
| U19 | (C) 스냅 표지와 힌트는 한 점만(`snapHint` 단일 값) | `src/editor/snap/snapHint.ts:4-18`, `src/editor/snap/SnapMarker.tsx:12-31` | "주택 세 채"의 스냅 세 곳·스냅 종류(S4 "도로 접면 스냅")를 화면에 보일 수 없음 | 목록을 받는 표지 컴포넌트(같은 색·모양). 항목별 스냅 종류는 계획 데이터에도 넣어 Chrome이 읽게 |
| U20 | (C) 핀 부품(`Pin`·`Ring`·`Label`)이 파일 전용. 핀은 재난 탭/선택/무장일 때만 보임. 핀 선택은 객체 선택을 비움. 마우스 배치는 0.1 m 반올림 + 토스트 + "지금 실행" | `src/rendering/placement/PlacementLayer.tsx:41-94,125,158,253-272`, `src/app/placementActions.ts:63-74`, `src/app/inputPolicy.ts:64-71` | 유령 핀을 그릴 길이 없음. 명령으로 넣은 재난의 핀이 안 보일 수 있음(S11). "마우스와 같은 값" 비교가 반올림에서 어긋남 | 유령 핀 목록을 `PlacementLayer`가 받아 그리게(무장 미리보기 코드 재사용). `showPlaced`에 "명령 계획/직전 결과에 재난 있음" 조건 추가. 좌표는 같은 `round1`. 선택·탭 전환 여부는 결정 |
| U21 | (C) 지형 열 지도 `PreviewMesh`가 `TerrainTool.tsx` 전용이고 `previewDab`은 한 점 1초용. 획 전체 미리보기 함수 없음 | `src/editor/tools/TerrainTool.tsx:76-128,244-263`, `src/terrain/TerrainEditor.ts:245-293` | "반경 10 m 평탄화"의 미리보기(S9)를 그릴 수 없음 | `PreviewMesh`를 공용 파일로 옮기고, `previewStroke(terrain, dabs[])`(임시 격자 + 실제 `applyDab`)를 추가해 같은 `DabPreview` 모양으로 |
| U22 | (C) 입력 정책에 명령 계획이 없음. 옛 미리보기는 컴포넌트 지역 상태 | `src/app/inputPolicy.ts:60-117`, `src/ui/BottomPanel/CommandPanel.tsx:30-32` | 모드 전환·문서 교체·도구 무장 뒤 유령이 남음(S21) | 계획을 저장소에 두고 §6.4 표대로 구독 추가. `input.test.ts:238-290`에 시험. "계획 생성 → 도구·재난 무장 해제"는 결정 |
| U23 | (C) i18n: `cmd.*` 접두사를 옛 콘솔이 씀. 조각 파일의 한·영 대응 방식이 셋(타입 강제 / 무타입). 도움말 키 표는 하드코딩 영어 + Phase 36 키 누락 | `src/i18n/locales/ko.ts:394-427`, `ko.p36editor.ts:2-4`, `ko.p36roads.ts:2`, `src/ui/TopBar/HelpDialog.tsx:6-28` | 키 충돌, 한쪽 언어에만 있는 문구, 도움말에 명령창 키가 안 보임 | `cmd37.*` + `p36editor` 방식. 도움말에 `/`·Ctrl/⌘+K 행과 빠진 키 추가 |
| U24 | (C) 벤치 JSON에 부하·커밋·메모리 여유가 없음(Phase 36은 보고서에 손으로 적음) | `scripts/bench-editor36.mjs:295`, `docs/ADVANCED_WORLD_EDITOR.md` §23 | 명세 §22·§25 "부하·시각·커밋을 표마다 기록"을 스크립트가 보장하지 못함 | 새 벤치(또는 확장)에서 `os.loadavg()`·`git rev-parse --short HEAD`·여유 메모리를 시작·끝에 기록 |
| U25 | (C) 오른쪽 버튼은 카메라 이동, 캔버스 `contextmenu`는 막기만 함. 메뉴·오른쪽 클릭 처리 없음. (S) `contextmenu` 시점이 운영체제마다 다름 | `src/rendering/CameraRig.tsx:76`, `src/rendering/Viewport.tsx:15`, `src/ui/TopBar/TopBar.tsx:81-87` | 맥락 메뉴(§14·S17)를 그냥 달면 이동 끌기마다 메뉴가 뜸 | 누름–뗌 이동 5 px 미만일 때만 메뉴. 닫기 Esc의 사슬 순서(메뉴 → 계획 → 창)를 정함 |
| U26 | (C) 배치 도구의 변형 시드와 `createWorldObject`의 기본 시드가 `Math.random()` | `src/editor/tools/PlaceTool.tsx:63,67,151`, `src/world/WorldDocument.ts:70` | 명령이 이 경로를 그대로 쓰면 같은 문장이 다른 나무·다른 변형을 냄(명세 §4·§18 위반). 미리보기와 확정 결과가 달라짐 | 명령 계획의 모든 `CreateObjectInput`에 `subSeed`로 만든 `seed`를 명시. 시험: 같은 문장 두 번 → 같은 params |
| U27 | (C) `puppeteer-core`가 `package.json`·lock에 없음(`--no-save` 설치) | `package.json`, `scripts/verify-editor36.mjs:7`, `docs/PERFORMANCE.md:139` | 새 스크립트도 같은 전제. 깨끗한 설치에서는 Chrome 검증이 안 돎 | 그대로 두되(의존성 추가는 명세 밖) `COMMAND_EDITOR.md`의 실행 방법에 한 줄 |
| U28 | (C) 비교 창은 Esc로 닫히지 않고(리스너 없음, 모달이라 전역 단축키도 막힘), `role="menu"` 팝업도 Esc가 없음 | `src/ui/Results/ComparisonDialog.tsx:84-85`, `src/ui/TopBar/TopBar.tsx:78-98` | 명령창과 직접 충돌은 없음. 새 맥락 메뉴·후보 목록이 같은 빈 곳을 물려받지 않게 | 새 팝업에는 Esc를 넣고 순서를 §2.4에 맞춤. 기존 것은 이번 범위 밖(기록만) |
