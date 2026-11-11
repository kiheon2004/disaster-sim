# Phase 37 사전 감사 부록 — 기존 명령 시스템 · 재난 라이브러리 · 객체 팔레트

기준 `d5b5896`(main). 읽기 전용 감사: 저장소 소스는 바꾸지 않았고, 시험·빌드·Chrome은 돌리지 않았습니다(파일 읽기·grep만).
경로는 따로 적지 않으면 `src/` 기준입니다. **(C)** = 코드를 읽어 확인, **(S)** = 추측 — 실행해 확인해야 함.
범위: 명세 §3의 3번(재난)·4번(객체 팔레트)과, 명세에 언급이 없는 **기존 명령 시스템**(`src/commands/`, 하단 명령 서랍).

요약(먼저 읽을 것):

- 명령 시스템이 **이미 있습니다**. 재난·실행 제어 문장(한·영)을 파싱해 **인스턴스·실행 취소를 거치지 않고** `simulationController.addEvent`로 바로 실행합니다(§1.5, D1).
- 옛 Chrome 스크립트 3개가 그 입력란에 문장을 치고 **Enter 한 번 = 즉시 실행**을 기대합니다(§1.9, D2).
- 재난 종류·칸·한계는 `phenomena` 등록부 + `CATALOG`에서 **생성할 수 있습니다**. 별칭은 열거할 수 없는 정규식뿐입니다(§2.1, D15).
- 값 "잘림"은 UI 숫자 칸에만 있고, `placement.set`은 범위를 제한하지 않습니다(0.1 m 반올림만). zod는 거부만 합니다(§2.4, D19·D20).
- 객체는 `PALETTE` 한 표에서 이름(한·영)을 생성할 수 있지만 별칭·단위 명사·층수 매개변수 경로가 없습니다(§3.9, D32–D34).
- 권고: **(b)** 새 `src/command/` 파이프라인 + 옛 `src/commands/`는 바람·지진·물 문장 문법 **라이브러리로 재사용**, 패널은 하나로(§1.12).

---

## 1. 기존 명령 시스템

### 1.1 구성

| 파일 | 줄 수 | 역할 |
|---|---:|---|
| `commands/CommandParser.ts` | 42 | 계약: `ParsedCommand {command, source, notes, delay?, after?}`(:5-18), `ParseResult {ok, commands, unsupported, errors, warnings}`(:20-26), `ParseDefaults {direction, duration, gustStrength}`(:29-33), `CommandParser.parse(): Promise`(:39-42) (C) |
| `commands/schema.ts` | 47 | zod `simulationCommandSchema`(:25-29), `commandJsonSchema()`(:45-47) (C) |
| `commands/RuleBasedParser.ts` | 639 | 정규화·절 분리·숫자/단위 토큰·방향·바람 파서·분기 순서(`parseCommands` :342-514) (C) |
| `commands/earthquakeParser.ts` | 138 | 지진 절(:46-138) (C) |
| `commands/floodParser.ts` | 260 | 비·수위·물 유입 절(:101-260) (C) |
| `commands/CommandDispatcher.ts` | 80 | `CommandTarget`(:10-22), `dispatchCommands`(:49-80), 상대 시작 해석(:33-46) (C) |
| `commands/LlmParser.ts` | 54 | 같은 인터페이스의 LLM 구현체 — **호출부 없음**(§1.10) (C) |
| `app/actions.ts` | — | 배선: `commandParser`(:557), `commandTarget`(:559-579), `parseCommand`(:581-583), `executeCommand`(:586-596) (C) |
| `ui/BottomPanel/CommandPanel.tsx` | 185 | 입력란·실시간 해석·기록 목록 (C) |
| `ui/BottomPanel/commandStore.ts` | 29 | 기록(항목 60, 입력 50 — **메모리에만**) (:20-29) (C) |
| `ui/BottomPanel/describeCommand.ts` | 100 | 한 줄 설명(`describeParsed` :46-93, `describeUnsupported` :95-100) (C) |

의존 방향 (C): `commands/*`는 `events/specs`(타입)·각 재난 zod 스키마·`phenomena/registry`·`events/earthquake/resolveEarthquake`·`events/flood/resolveFlood`를 import합니다.
거꾸로 `simulation`·`events`·`physics`·`structure`가 `commands`를 import하는 곳은 없습니다. 예외는 **시험 파일** `climate/audit30.test.ts:24`와 탐침 `__audit__/identity/parse.probe.ts:3`, `__audit__/p355/parse.probe.ts:2`입니다.

### 1.2 파싱 흐름

1. `normalize`(`RuleBasedParser.ts:23-46`): NFKC + 소문자, 단위 통일(`m/s²`→`mpss`, `m³/s`→`cms`, `시간당 mm`→`mm/h`, `초속 30`→`30m/s` …). (C)
2. `splitClauses`(:49-55): 줄바꿈·`;`·`. `·"그리고/그 다음/then/after that"`·연결어미 "…시키고/일으키고 " 에서 절을 나눕니다. **쉼표만으로는 나누지 않습니다.** (C)
3. `tokenizeNumbers`(:146-178): 정규식 `(\d+(?:\.\d+)?)\s*([a-z가-힣/%°×]*)`(:148) + 단위 표(:77-142). 종류: speed·time·percent·degree·mm·cm·meter·multiplier·accel·km·freq·rainRate·flow·volume·riseRate·bare. (C)
4. 절마다 **위에서부터 처음 맞는 분기**(:353-510):

| 순서 | 조건 | 결과 | 근거 |
|---:|---|---|---|
| 1 | 화재 낱말(바람 낱말 없음) | 실행 안 함 — `unsupported: fire` + 경고 `parse.fire.editor` | :356-360 |
| 2 | 화산 | `unsupported: volcano` + `parse.volcano.editor` | :363-367 |
| 3 | 기후(바람·실행 낱말 없음) | `unsupported: climate` + `parse.climate.editor` | :372-376 |
| 4 | 대기 | `unsupported: atmosphere` + `parse.atmosphere.editor` | :379-383 |
| 5 | 계획 상태 현상(쓰나미·저산소·폭설) | `unsupported` + `parse.unsupported.planned` | :385-390 |
| 6 | 블랙홀·천체 | `unsupported: celestial` + `parse.celestial.editor` | :393-397 |
| 7 | 중력 | `unsupported: gravity` + `parse.gravity.editor` | :400-404 |
| 8 | 지진 낱말 또는 가속도 단위 | `earthquake` 스펙(규모·PGA·깊이·진앙·축·주파수·시드·기간·지연) | :416-425, `earthquakeParser.ts:46-138` |
| 9 | 물(유량·비·수위) | `rain` / `risingWater` / `waterSource`. 태풍 + 비면 바람도 함께 | :429-452, `floodParser.ts:37-42` |
| 10 | 소용돌이·운석·폭발·싱크홀·산사태·지형 변형 | **그 현상의 기본값**(`def.defaults()`) + 지연만. 숫자·위치는 읽지 않음 | :458-466 |
| 11 | 바람 낱말·속도 단위·증감 | `wind` 스펙(속도·방향·기간·돌풍·램프·연쇄) | :469-484, :516-629 |
| 12 | 리셋 → 배속 → 일시정지 → 재생 | `control` / `speed` | :487-507 |
| — | 아무것도 아님 | 오류 `parse.noIntent` | :509 |

`ok` = 오류 0개이고 (명령 ≥ 1 또는 unsupported ≥ 1)(:512). 순수 함수입니다 — `Date.now`·`Math.random` 없음 (C).

### 1.3 인식하는 문장 (시험에 고정된 것)

| 부류 | 한국어 | 영어 | 결과 | 시험 |
|---|---|---|---|---|
| 바람 | 풍속 30m/s의 바람을 동쪽에서 발생시켜 / 동쪽에서 서쪽 방향으로 풍속 45m/s의 태풍 발생 / 남서풍 25m/s 90초 | Wind 45m/s from East for 90 seconds / easterly … / 162 km/h NE | `wind {speed m/s, direction, duration s, gustStrength}` | `RuleBasedParser.test.ts:22-126` |
| 램프 | 풍속을 50m/s까지 20초 동안 증가시켜 / 20에서 50 | increase to 50 m/s over 20 seconds | `rampDuration`, `rampFrom` | 같은 파일 :34-44, :110 |
| 바람 정지 | 바람을 멈춰 | stop the wind | **속도 0인 새 바람 이벤트**(`speed: 0`, 램프 4 s) | :123, `RuleBasedParser.ts:529-537` |
| 지진 | 규모 6.5의 지진을 발생시켜 / 최대 지반가속도 0.3g … 30초 동안 / 깊이 10km / 동쪽 20km | Generate a magnitude 6.5 earthquake / Apply 0.3g peak ground acceleration for 30 seconds | `earthquake {magnitude, pga g, depth km, epicenter [x,z] m, direction °, dominantFrequency Hz, seed, duration s}` | `earthquakeParser.test.ts` 9건 |
| 비 | 시간당 80mm의 비를 30분 동안 내려줘 / 30분 동안 40mm | Start rainfall at 80 mm/h for 30 minutes | `rain {intensity mm/h, duration s, area?}` | `floodParser.test.ts:13-17, :61` |
| 수위 | 남쪽 경계에서 수위를 2m까지 올려줘 | Raise the southern boundary water level to 2 meters | `risingWater {boundary, level m, riseRate m/min?, duration?}` | :19-23, :65 |
| 물 유입 | 중앙에 초당 5세제곱미터의 물을 공급해줘 | … 5 m3/s at (10, -20) | `waterSource {position, rate m³/s, duration s, radius?}` | :25-29, :69 |
| 기본값 현상 | 싱크홀을 만들어줘 / 운석을 떨어뜨려 / 토네이도 발생 / 폭발을 일으켜 | Trigger a landslide / Drop an asteroid / Spawn a tornado / make an explosion | 기본 스펙(지도 중앙) + 메모 `parse.note.groundDefaults` | `multiParser.test.ts:60-65` |
| 편집기로 안내 | 화재를 발생시켜 / 블랙홀을 만들어줘 / 중력을 절반으로 | Create a black hole in the center / Switch to zero gravity | 실행 0건, `unsupported[0].event`, 경고 `parse.<type>.editor` | `RuleBasedParser.test.ts:78-83`, `multiParser.test.ts:67-88` |
| 순서·상대 시작 | 태풍을 발생시키고 10초 후 지진을 발생시켜 | Start an earthquake 10 seconds after the typhoon begins | `delay` 또는 `after {type, anchor, offset}` | `multiParser.test.ts:22-58` |
| 실행 제어 | 재생·실행 / 멈춰·일시정지 / 초기화·처음으로 / 속도 2배·2배속 | play·run / pause·stop / reset / speed 2× | `control {play\|pause\|reset}`, `speed`(가까운 `SIM_SPEEDS`로) | `RuleBasedParser.test.ts:128-140` |

범위를 벗어난 값은 **오류로 거부**합니다(잘라 넣지 않음): 풍속 > 150(`RuleBasedParser.ts:579-582`), 규모 3–9.5(`earthquakeParser.ts:60-63`), PGA > 2 g(:74-77), 강우 0.1–500(`floodParser.ts:156-159`), 수위 −30–60(:204-207), 유입 0.001–200(:245-248). (C)

### 1.4 명령 스키마 (zod)

```
SimulationCommand =
  { kind: 'event',   spec: EventSpec }          // schema.ts:26
| { kind: 'control', action: 'play'|'pause'|'reset' }   // :27
| { kind: 'speed',   value: 0.25|0.5|1|2|4|8|16 }       // :28  (core/units.ts:21)
```

- `spec`이 받는 종류는 **11종**뿐입니다: wind·earthquake·rain·risingWater·waterSource(`schema.ts:20`) + terrainDeformation·sinkhole·landslide·impact·blast·tornado(:23). heatSource·fire·volcano·atmosphere·climate·gravity·celestial은 없습니다. (C)
- 지반 쪽은 `as unknown as z.ZodTypeAny`로 합쳐 타입 추론을 끕니다(:23, :26). (C)
- 대상(객체)·위치 참조·문서 편집 개념이 없습니다 — Phase 37의 `Intent`가 될 수 없는 모양입니다. (C)

### 1.5 실행 경로

`executeCommand`(`app/actions.ts:586-596`) → `commandParser.parse` → `dispatchCommands`(`CommandDispatcher.ts:49-80`) → `commandTarget`(`actions.ts:559-579`).

| 명령 | 편집 모드에서 | 시뮬레이션 중 | 근거 |
|---|---|---|---|
| event | `enterSimulation()`(문서 잠금) → `simulationController.addEvent(spec + startTime = now + delay)` → `play()` | `addEvent` → `play()` | `actions.ts:561-569` |
| play | 시뮬레이션 진입 후 재생 | 재생 | :570-573 |
| pause | `simulationController.pause()` (불러온 것 없어도 호출) | 일시정지 | :574 |
| reset | 아무것도 안 함(`isLoaded()` 거짓) | `resetSimulation()` + 토스트 `toast.reset` | :575-577, :415-418 |
| speed | `setSpeed` | `setSpeed` | :578 |

- **문서를 쓰지 않습니다.** `doc.scenario.experiment`에 인스턴스가 생기지 않고, 핀·재난 목록에 나타나지 않으며, 실행 취소 단계가 없습니다. 인스턴스 키는 `<종류>#<n>`입니다(`simulation/SimulationController.ts:294`). (C)
- 지반을 바꾸는 종류(싱크홀·산사태·운석·지형 변형)의 사전 준비 `prepareGround`를 부르지 않습니다 — 마우스·실험 실행이 쓰는 `runSimulation`(:402-413)과 **다른 경로**입니다. (C) 첫 변형 때 프레임이 끊기는지는 실행해 봐야 압니다. (S)
- 상대 시작은 디스패치 때 풉니다: 같은 명령 묶음 → 예약된 이벤트(`scheduledTime`, `SimulationController.ts:634-642`) → 없으면 `now + offset` + 토스트 `cmd.warn.noRef`(`actions.ts:590-593`). (C)
- 입력에 없는 값은 `defaults()`가 채웁니다: 바람 폼의 방향·기간·돌풍, **실행 중이면 지금 부는 바람의 방향**(`CommandPanel.tsx:19-24`). 같은 문장이 UI 상태에 따라 다른 스펙이 됩니다. (C)

### 1.6 UI

- 위치: 중앙 하단 띠(`app/AppLayout.tsx:24-26`) → `BottomPanel`(타임라인 + 지진계 + 서랍 막대 26 px + 서랍 210 px: `BottomPanel.module.css:30-32`). 서랍은 `uiStore.commandOpen`(`ui/uiStore.ts:52-53, :90-94`, 브라우저 `ds.commandOpen`, 기본 **닫힘**)으로 여닫습니다. (C)
- 시험 id: 서랍 단추 `data-testid="command-toggle"`(`BottomPanel.tsx:22`), 입력란 `data-testid="command-input"`(`CommandPanel.tsx:113`). placeholder = `cmd.placeholder`(:111) — 한·영 모두 **"Enter"** 가 들어 있습니다(`ko.ts:397`, `en.ts:394`). (C)
- 키(`CommandPanel.tsx:64-81`): Enter = 제출(바로 실행), ↑/↓ = 기록. **`isComposing` 검사 없음**(D8). Esc 처리 없음. 여는 단축키 없음. (C)
- 실시간 해석: 120 ms 디바운스(:37-44), 한 줄(`PreviewLine` :125-140). 예시 칩 7개(:16, :98-104). 기록 항목에 JSON 보기(:151-155, :178-182). (C)
- `role="dialog"`·`aria-modal` 없음, `aria-live="polite"` 기록 영역(:92). 전역 단축키는 입력 중 쉽니다(`app/hotkeys.ts:227` `isTyping(e) || e.isComposing`). (C)

### 1.7 i18n 키

| 묶음 | 위치 (ko / en은 같은 이름의 `en.*.ts`) |
|---|---|
| `cmd.title·parser·parser.title·placeholder·run·preview·showJson·empty` | `i18n/locales/ko.ts:394-402` |
| `cmd.describe.wind·windRamp·windStop·delay·current·play·pause·reset·speed` | `ko.ts:405-413` |
| `cmd.describe.rain·rain.whole·rain.circle·risingWater·waterSource` | `ko.flood.ts:62-66` |
| `cmd.describe.earthquake·eq.assumed·eq.auto`, `cmd.ex.7·8` | `ko.earthquake.ts:39-43` |
| `cmd.describe.planned·after.start·after.end`, `cmd.warn.noRef` | `ko.phenomena.ts:144-147` |
| `cmd.toggle·toggleHint` | `ko.ux355.ts:143-144` |
| `cmd.ex.1–6` | `ko.ts:422-427` |
| `parse.*` 53개: 일반·바람 메모 | `ko.ts:371-392` |
| `parse.*` 물 | `ko.flood.ts:44-61` |
| `parse.*` 지진 | `ko.earthquake.ts:34-38` |
| `parse.<type>.editor` 등 | `ko.fire.ts:75`, `ko.volcano.ts:50`, `ko.atmosphere.ts:4`, `ko.climate.ts:5`, `ko.gravity.ts:150`, `ko.celestial.ts:231`, `ko.ground.ts:123`, `ko.phenomena.ts:143` |

쓰이지 않는 키 (C, `src` 전체 grep 0건): `parse.unsupported.rain·snow·earthquake·flood·tsunami·fire·explosion`(`ko.ts:376-382`), `cmd.describe.unsupported`(:414), `cmd.executed·failed`(:403-404), `cmd.examples`(:399), `cmd.ex.5`(:426).

### 1.8 시험

| 파일 | 건수 | 고정하는 것 |
|---|---:|---|
| `commands/RuleBasedParser.test.ts` | 27 | 정규화, 한·영 바람, 방향, 램프, 연쇄, 제어, 배속, 오류 |
| `commands/earthquakeParser.test.ts` | 9 | 지진 절, 범위 거부, `commandJsonSchema()`에 earthquake 포함(:71-72) |
| `commands/floodParser.test.ts` | 10 | 물 절, 단위 환산, 태풍 + 비 |
| `commands/multiParser.test.ts` | 7 | 순서·상대 시작, 기본값 현상, 계획 현상·편집기 안내 — **가짜 `CommandTarget`으로 `dispatchCommands` 실행**(:9-19) |
| `climate/audit30.test.ts:333, :344` | 2곳 | 기후 낱말이 다른 명령을 가로채지 않음 |

`LlmParser`·`CommandPanel`·`describeCommand`·`commandStore`의 시험은 없습니다. (C)

### 1.9 옛 Chrome 스크립트가 명령창에 기대하는 것

검증 스크립트 23개(`grep -l setCommandOpen scripts/*.mjs`; `verify-ux355`·`verify-editor36`은 없음)에는 같은 호환 덧붙임이 있습니다: 선택자·함수 문자열에 `placeholder*="Enter"`·`cmd-`·`command-input`이 보이면 `__ds.ui.getState().setCommandOpen(true)`로 서랍을 엽니다(예: `scripts/verify-phenomena.mjs:24, :28`). 실제로 입력란을 쓰는 곳은 넷입니다.

| 스크립트 | 무엇을 하나 | 통과 조건 |
|---|---|---|
| `scripts/verify-flood.mjs:146-153` | `input[placeholder*="Enter"]`에 "시간당 80mm의 비를 30분 동안 내려줘 그리고 서쪽 경계에서 수위를 0.8m까지 올려줘"(영: "Start rainfall at 80 mm/h … then raise the western boundary water level to 0.8 meters") 입력 → 0.8 s 뒤 화면 → **Enter 한 번** | `__ds.sim.isLoaded() && simStore.flood !== null` (120 s 안) |
| `scripts/verify-ux355.mjs:186-192` (S5) | `command-toggle` 클릭 → `command-input` 클릭 → "폭발을 일으켜"/"make an explosion" → **기다리지 않고 Enter** | `simStore.status === 'running'`, `sim.instances()`에 `spec.event === 'blast'`인 것이 있음(:68, :192) |
| `scripts/verify-phenomena.mjs:135-145` | 문장을 치고(Enter 없음) 화면만 찍음. "블랙홀을 지도 중앙에 만들어줘" 뒤 본문에서 `/(미구현 현상\|Not implemented)[^\n]*/`를 읽어 **기록만**(단언 아님) | 오류 0 |
| `scripts/verify-celestial.mjs:541-542` (52번) | `__ds.celestialLib.parse('블랙홀을 만들어줘')` = `parseCommands`(`app/devtools.ts:258`) | `unsupported[0].event === 'celestial'`, 명령 0건, `warnings[0].key === 'parse.celestial.editor'` |

그 밖에 `scripts/_try-panel.mjs:15`(추적되지 않는 시험 스크립트)가 `command-toggle`을 누릅니다.

### 1.10 LlmParser

- `LlmParser`(`commands/LlmParser.ts:22-54`)는 `CommandParser`를 구현하고, **주입된 함수** `LlmComplete({system, user, jsonSchema}) → Promise<string>`(:13)을 부를 뿐입니다. 파일 안에 `fetch`·키·주소가 없습니다. 주석은 "브라우저에 키를 두지 말고 백엔드 경유"(:5-7)입니다. (C)
- 응답 JSON의 `commands[]`를 `simulationCommandSchema`로 검증해 통과한 것만 돌려줍니다(:46-50). (C)
- **어디서도 만들지 않습니다.** `app/actions.ts:556-557`의 주석 "Swap for `new LlmParser(transport)`"와 `new RuleBasedParser()`뿐. 기본 끔이 아니라 **연결되지 않음**입니다. 시험도 없습니다. (C)
- 명세 §16의 `IntentProvider`(Intent JSON)와 계약이 다릅니다(옛 것은 실행 명령 JSON, 11종). 그대로 쓸 수 없습니다.

### 1.11 Phase 37 문장을 옛 파서에 넣으면 (읽어서 추적)

| 문장 | 옛 파서의 결과 | 근거 |
|---|---|---|
| "지진 멈춰" / "stop the earthquake" | **규모 6.5 지진을 새로 시작**. 지진 분기(8)가 제어 분기(12)보다 먼저이고 "멈춰"는 지진 파서가 읽지 않음 | `RuleBasedParser.ts:416-425`, `earthquakeParser.ts:20, :25-27, :53, :67-69` (C) |
| "비 멈춰" | **30 mm/h 비 30분을 새로 시작** | `floodParser.ts:24, :39, :145-155` (C) |
| "교차로 n4에 폭발 1.8e9 J, 5초 뒤" | 지도 중앙 `[0,0]`에 **기본 1e8 J** 폭발, 5 s 뒤. `n4`·`1.8e9 J`는 버려짐 | `RuleBasedParser.ts:458-463`, `phenomena/blastDefinitions.ts:44` (C) |
| "1.8×10⁹" | NFKC가 `⁹`를 `9`로 바꿔 "10⁹" → "109"; `×`는 배속 단위로 읽힘 | `RuleBasedParser.ts:24, :121, :148` (C: 유니코드 규칙 — 시험으로 고정 권장) |
| "화재 #3 지워" | 실행 없음, "화재는 편집기에서" 경고 | :356-360 (C) |
| "실행 / 멈춰 / 처음으로 / 2배속", "run / pause / reset / speed 2×" | 기대대로 `control`·`speed` | :187-191, :487-507 (C) |
| "주택 세 채", "선택한 것 5 m 이동" | `parse.noIntent` 오류(실행 없음) | :509 (C) |

→ 옛 파서를 "모르는 문장의 뒷받침"으로 그냥 붙이면 인스턴스 제어 문장이 재난을 새로 일으킵니다(D3). 새 문법이 **먼저** 제어·배치 문장을 가져가야 합니다.

### 1.12 권고 — Phase 37 명령 계층과의 관계

| 안 | 내용 | 깨지는 것 / 위험 |
|---|---|---|
| (a) `src/commands`를 그 자리에서 확장 | `SimulationCommand`에 편집 종류를 더하고 `parseCommands` 분기에 새 부류를 끼움 | ① `ParseResult`·`ParsedCommand` 모양이 시험 53건 + `audit30.test.ts` + 탐침 2개 + Chrome 52번에 고정 — 모양을 바꾸면 전부 손봐야 함. ② 분기 **순서가 의미**라서(§1.2) 새 부류를 끼울 때마다 옛 문장 결과가 흔들림. ③ `parse()`가 `Promise`, 대상·문서 스냅숏 인자가 없음 → 명세 §4 "순수 함수 `(text, DocSnapshot, Context)`"와 안 맞음. ④ 실행 계약 `CommandTarget.runEvents`가 인스턴스·미리보기·일괄 단계를 모름(§1.5). 사실상 다시 쓰는 것과 같고 옛 시험을 약하게 할 위험이 가장 큼 |
| **(b) 새 `src/command/` + 옛 문법 재사용 + 패널 하나** (권고) | 새 파이프라인(Intent → resolve → plan → preview → commit). 옛 `src/commands/`는 **바람·지진·비·수위·물 유입 문장 문법 라이브러리**로 그대로 두고 어댑터(`ParsedCommand` → `Intent`)로 연결. 서랍의 `CommandPanel`을 새 명령창으로 바꾸되 식별자는 유지 | ① `verify-flood.mjs:146-153`, `verify-ux355.mjs:186-192`가 **Enter 한 번에 실행**을 기대 → 옛 문법으로 인식된 "…발생시켜/일으켜/내려줘/start/make" 문장은 **배치 + 지금 실행**(= 마우스의 "클릭 즉시 실행", `app/placementActions.ts:72`)으로 정의해야 통과. 이때 키가 `blast#1` → `p1`로 바뀌고 인스턴스가 문서에 남음(두 스크립트는 키를 단언하지 않음: `verify-ux355.mjs:192`, `verify-flood.mjs:153`). ② Enter는 디바운스된 미리보기를 기다리지 말고 **제출 시점에 동기 계획**해야 함(`verify-ux355.mjs:188-189`는 대기 없이 Enter). ③ `verify-phenomena.mjs:145`가 읽는 "미구현 현상/Not implemented" 문구는 기록용 — 블랙홀 명령을 지원하게 되면 값이 `null`로 바뀜(단언 아님, 변경 목록에 기재). ④ `__ds.celestialLib.parse` = 옛 `parseCommands`는 그대로 둬야 Chrome 52번 통과. ⑤ `data-testid="command-toggle"`·`"command-input"`, placeholder의 "Enter", `uiStore.commandOpen/setCommandOpen` 유지 필요(§1.9 덧붙임이 이것으로 서랍을 엶) |
| (c) 둘 다 유지 | 옛 서랍은 "재난 즉시 실행", 새 명령창은 편집 | 옛 스크립트는 그대로 통과. 그러나 ① 입력란 두 개, 같은 문장("폭발")이 한쪽은 인스턴스 없는 즉시 실행·다른 쪽은 핀 + 실행 취소 — 명세 §1 "마우스 편집과 구별되지 않음"·§2 "사본 금지"에 어긋남. ② 기록·i18n·Chrome 경로가 두 벌. ③ 하단이 서랍 210 px + 새 명령창으로 커져 §14 레이아웃 기준(3D 면적 ≥ 35 %)에 불리 |

**권고 (b)의 구체안**

1. `src/commands/*`와 시험 53건은 **동작을 바꾸지 않습니다**(한·영 재난 문법의 회귀 기준). `parseCommands` 내보내기 유지.
2. 어댑터 `src/command/legacyDisaster.ts`(가칭): `ParsedCommand(event)` → `Intent{disaster.place, type, spec, start, run: true}`. `delay` → `start: { at }`, `after` → `start: { after: <인스턴스 id>, anchor, offset }`(인스턴스 모델에 이미 있음: `phenomena/types.ts:146-148`). `control`·`speed` → 실행 제어 Intent.
3. 어댑터가 맡는 종류는 **값을 실제로 읽는 5종**(wind·earthquake·rain·risingWater·waterSource)으로 한정합니다. 숫자를 버리는 분기 10(§1.2)과 "편집기로 안내" 6종은 새 문법이 `ParamField` 표(§2.3)로 직접 다룹니다(D4).
4. 새 문법이 **먼저** 봅니다: 인스턴스 제어(멈춰·지워·stop·delete + 재난 이름), 배치·선택 등. 새 문법이 실패한 절만 어댑터로 보냅니다(D3).
5. 확정 경로는 하나: `setExperiment`(일괄 단계 안) → "지금 실행"이면 `runInstance`/`runSimulation(specs, keys)`. `commandTarget.runEvents`의 직접 `addEvent`(`app/actions.ts:561-569`)는 UI 경로에서 뺍니다(D1). `dispatchCommands`는 시험이 쓰므로 파일은 둡니다.
   - "지금 실행"은 **이번 명령이 만든 인스턴스만** 넣습니다(`runExperiment`가 아님). `verify-ux355` S5는 S4의 소용돌이 인스턴스 2개가 문서에 남은 채로 명령을 칩니다(`scripts/verify-ux355.mjs:155-157, :186-192`) — 옛 경로는 폭발만 시작했습니다. (C)
   - S5 뒤 문서에 폭발 인스턴스가 남게 되지만, S6이 검색마다 `setExperiment({ instances: [] })`로 비우고(:214) S7이 `fresh()`를 부르므로(:220) 뒤 시나리오에는 영향이 없습니다. (C)
6. `ParseDefaults`(바람 폼·현재 바람)는 `Context`의 명시 칸으로 옮겨 계획 해시에 넣습니다(D9).
7. `LlmParser`는 확장하지 않습니다. `IntentProvider`를 새로 두고, 옛 파일은 호출부가 없으므로 같은 커밋에서 지우거나 "사용 안 함" 주석 — 지우면 `commandJsonSchema()` 시험(`earthquakeParser.test.ts:71-72`)은 `schema.ts`에 남으므로 영향 없음.
8. 모듈 이름: `src/command`(단수)와 `src/commands`(복수)가 함께 있으면 의존 방향 grep이 헷갈립니다. `@/command/`처럼 **끝 빗금까지** 맞추고 시험 파일을 빼거나(D12), 새 모듈을 `src/commandline/` 등으로 달리 짓는 것을 검토.

결정이 필요한 것: 옛 문장의 "Enter = 즉시 실행"을 유지할지(유지하면 편집 모드에서 미리보기 없는 실행 경로가 하나 남음), 실행 중 재난 명령을 허용할지(D23).

---

## 2. 재난 (명세 §3-3)

### 2.1 데이터가 있는 곳

| 무엇 | 어디 | 비고 |
|---|---|---|
| 종류 등록부 | `phenomena/registry.ts:10-48` — `phenomena.listImplemented()`(:32-34), `implemented(type)`(:23-26), `matchPlanned(text)`(:41-43) | 구현 18종(`phenomena/definitions.ts:219`) + 계획 3종(:225-245: atmosphereLoss·tsunami·snow) (C) |
| 종류 정의 | `ImplementedPhenomenon`(`phenomena/types.ts:119-133`): `type, labelKey, icon, channels, models, keywords, schema(zod), defaults(), fields[], seeded, duration(), assumptions(), describe()` | (C) |
| 칸 메타 | `ParamField`(`types.ts:75-94`): `key, labelKey, unit(표시), min, max, step, precision, scale?, optional?, options?, get?/set?, autoValue?, visible?` | **표시 = 저장 × scale**(:86-87) (C) |
| 라이브러리 메타 | `CATALOG`(`phenomena/catalog.ts:88-219`): `category, shortKey, basic[], placement{kind, get, set, footprint}` | "시뮬레이션은 읽지 않음"(:16) (C) |
| 범주 | `CATEGORIES` 7개(`catalog.ts:36-37`), 이름 `lib.cat.<id>`(`ko.ux355.ts:42-48`, `en.ux355.ts:41-47`) | (C) |
| 표시 이름 | `def.labelKey` = `phen.<…>` — **6개 로케일 파일에 흩어짐**(§2.2 표) | `translate('ko'\|'en', key)`(`i18n/i18n.ts:42-51`)로 UI 언어와 무관하게 둘 다 읽을 수 있음 (C) |
| 한 줄 설명 | `lib.short.<type>`(`ko.ux355.ts:49-66`, `en.ux355.ts:48-65`) | (C) |
| 검색 | `ui/Phenomena/DisasterLibrary.tsx:34-35` — 건초더미 = 한·영 이름 + 한·영 설명 + 범주 이름(현재 언어) + type id, 부분 문자열 **또는** `def.keywords.test(q)` | **컴포넌트 안 인라인**(D16) (C) |
| 별칭 | `def.keywords: RegExp`(`types.ts:115-116`)뿐 | 열거 불가·겹침 있음(D15) (C) |
| 즐겨찾기·최근 | `ui/placement/placementStore.ts:14-15, :71-72, :87-97` — 브라우저 `ds.disasterFavorites`, `ds.disasterRecent`(6개) | 문서와 무관 (C) |
| 배치 환경 설정 | `ds.placement` = `{runMode: 'plan'\|'now', continuous}`(:16, :61-67, 기본 plan·연속 켬) | (C) |

### 2.2 종류 표 — 이름·범주·위치

위치 규칙 `kind`는 `catalog.ts:39`. "위치 칸"은 스펙에서 x·z가 들어가는 곳입니다 — 종류마다 이름이 달라 **반드시 `placement.set`으로** 넣어야 합니다(D30).

| type | 한국어 이름 (키 @ 파일:줄) | 영어 이름 | 별칭 `keywords` (정의 파일:줄) | 범주 | 위치 규칙 → 위치 칸 | 범위 원 |
|---|---|---|---|---|---|---|
| `wind` | 바람 / 태풍 (`phen.wind` @ `ko.phenomena.ts:77`) | Wind / typhoon | 바람·풍속·태풍·강풍·돌풍·폭풍·wind·typhoon·hurricane·gale·storm·gust (`definitions.ts:47`) | weather | **global** — 위치 없음 (`catalog.ts:89`) | 없음 |
| `tornado` | 토네이도 (`ko.phenomena.ts:82`) | Tornado | 토네이도·회오리·소용돌이 바람·tornado·twister·whirlwind·vortex (`vortexDefinitions.ts:24`) | weather | ground → `position` (:93) | `outerRadius`, 실선 |
| `rain` | 폭우 (`ko.phenomena.ts:79`) | Heavy rain | 폭우·호우·강우·장대비·소나기·rain·downpour·rainfall (`definitions.ts:104`) | weather | area → `area.center`(없으면 반경 30 m로 새로 만듦) (:100-102) | `area.radius`, 실선 |
| `climate` | 기후·눈·얼음 (`ko.climate.ts:3`) | Climate / snow / ice | 폭염·한파·혹한·강설·폭설·눈·결빙·해빙·융설·서리·습도·증발·응결·heat wave·cold wave/snap·snow·frost·freez·thaw·humid·evaporat·icing (`climateDefinitions.ts:35`) | weather | area → `area.center`(반경 40 m) (:108-110) | `area.radius` |
| `earthquake` | 지진 (`ko.phenomena.ts:78`) | Earthquake | 지진·여진·earthquake·quake·seismic·tremor (`definitions.ts:78`) | geology | epicentre → `epicenter` (:116-117) | 12 m 참고(점선) |
| `sinkhole` | 싱크홀 (`ko.phenomena.ts:83`) | Sinkhole | 싱크홀·땅 꺼짐·지반 함몰·sinkhole (`groundDefinitions.ts:67`) | geology | ground → `center` (:124) | 공동 반경 + 피복, 참고 |
| `landslide` | 산사태 (`ko.phenomena.ts:84`) | Landslide | 산사태·토석류·사면 붕괴·landslide·mudslide·debris flow (`groundDefinitions.ts:138`) | geology | area → `area`(원 중심 또는 다각형 전체 이동) (:131-132, :71-75) | 영역 반경 |
| `terrainDeformation` | 지형 변형(침하·융기) (`ko.deformation.ts:4`) | Terrain deformation (subsidence / uplift) | 지형 변형/침하/융기·지반 침하/융기·침하·융기·subsid·uplift·terrain deform·ground settle (`definitions.ts:188`) | geology | ground → `center` (:139) | `radius` |
| `volcano` | 화산 (`ko.phenomena.ts:87`) | Volcano | 화산·용암·화산재·분화·분출·volcan·lava·eruption·ash fall (`volcanoDefinitions.ts:52`) | geology | ground → `vents[0].position`(+ `end` 같이 이동) (:146-152) | 25 m 참고 |
| `risingWater` | 수위 상승 (`ko.phenomena.ts:80`) | Rising water | 수위·범람·홍수·침수·water level·rising water·flood·inundat (`definitions.ts:124`) | hydrology | **edge** → `boundary` = 가장 가까운 변 N/E/S/W (:158, :78-81) | 없음 |
| `waterSource` | 물 공급원 (`ko.phenomena.ts:81`) | Water source | 물 공급·유입·수도관·water source·inflow·pump (`definitions.ts:146`) | hydrology | ground → `position` (:163) | `radius ?? 2` |
| `fire` | 화재 (`ko.phenomena.ts:88`) | Fire | 화재·산불·불길·불이 나·점화·fire·blaze·wildfire·ignit (`fireDefinitions.ts:25`) | fireHeat | ground → `position` (:170) | `radius` |
| `heatSource` | 열원 (열물리) (`ko.thermal.ts:3`) | Heat source (thermal physics) | 열원·가열·히터·발열·열 실험/전달·온도 경계/지정·heat source·heater·heating·thermal (`thermalDefinitions.ts:29`) | fireHeat | ground → `position` (:177) | max(radius, 5) 참고 |
| `blast` | 대기 압력파(폭발) (`ko.blast.ts:3`) | Atmospheric pressure wave (blast) | 폭발·압력파·폭풍파·폭풍압·충격파·explosion·explode·blast·pressure wave·shock wave (`blastDefinitions.ts:42`) | impactBlast | ground → `position` (:184) | 7 kPa 환산 거리, 참고 (:84) |
| `impact` | 운석 충돌 (`phen.meteor` @ `ko.phenomena.ts:85`) | Meteor impact | 운석·소행성·유성체·meteor·asteroid·meteoroid·impactor (`impactDefinitions.ts:43`) | impactBlast | ground → `target` (:191) | max(5, 12 × 지름) 참고 |
| `gravity` | 가변 중력 (`ko.gravity.ts:5`) | Variable gravity | 중력·무중력·저중력·고중력·gravity·zero-g·weightless (`gravityDefinitions.ts:86`) | spaceGravity | space → `sources[0].center`의 x·z(y 유지). **기본은 전역**이라 위치 없음 (:198-199, :230) | 20 m 참고 |
| `celestial` | 블랙홀·극한 중력원 (`ko.celestial.ts:3`) | Black hole / extreme gravity | 블랙홀·극한 중력·중력원·천체·black hole·celestial·gravity well·singularity (`celestialDefinitions.ts:126`) | spaceGravity | space → `sources[0].center`의 x·z (:206-207) | `influence` 또는 25 m 참고 |
| `atmosphere` | 대기·기압 (`ko.atmosphere.ts:3`) | Atmosphere / air pressure | 대기·기압·공기 밀도·대기 제거·진공·atmospher·air pressure·vacuum·air density (`atmosphereDefinitions.ts:33`) | atmosphere | area → `position`(`extent === 'local'`일 때만). **기본은 uniform**이라 위치 없음 (:214-216, :231) | `radius ?? 30` |

- `placeable(type, spec)`(`catalog.ts:226-233`): global이면 거짓, gravity는 `!global && sources.length > 0`, atmosphere는 `extent === 'local'`. 거짓이면 카드가 클릭 없이 바로 추가합니다(`app/placementActions.ts:47-54`). (C)
- 모든 `placement.set`은 좌표를 **0.1 m로 반올림**합니다(`pt`, `r1`: `catalog.ts:68-69`). 범위 검사는 없습니다. (C)
- 종류 id와 표시 키가 다른 것: `impact` ↔ `phen.meteor`. (C)

### 2.3 종류별 칸 — 저장 단위·한계·기본값

"기본 칸"은 `CATALOG[type].basic`(배치 막대에서 접히지 않는 칸). 단위는 **저장 단위**이고, 괄호 안이 UI 표시 단위입니다(다를 때만).
한계 = zod 스키마가 거부하는 범위이자 `ParamField.min/max`(표시 단위)입니다. 위치 칸 `x`·`z`(산사태는 `ax`·`az`·`ar`)의 UI 한계는 ±100 하드코딩입니다(예: `definitions.ts:153, :157`).

| type | 기본 칸: 저장 단위 [최소, 최대] 기본값 | 그 밖의 칸 | 한계 상수 · zod |
|---|---|---|---|
| `wind` | `speed` m/s [0,150] 40 · `direction` 나침반 8방위 또는 ° [0,360] `'E'`(불어오는 쪽) · `duration` s (0,3600] 60 | `gustStrength` 0–1 0.3(표시 %) · `rampDuration` s (0,3600] 4 · `rampFrom` m/s(칸 없음) | `events/wind/windSchema.ts:7-16` · `definitions.ts:49, :52-59` |
| `tornado` | `maxSpeed` m/s [5,140] 45 · `coreRadius` m [3,200] 15 · `duration` s [5,3600] 60 · `trackSpeed` m/s [0,40] 자동 0 | `outerRadius` m [10,1000] 80 · `trackBearing` ° 자동 90 · `rotation` ccw/cw · `shape` [0.5,2.5] · `inflowAngle` ° [0,45] · `rampDuration` s [0.5,120] | `vortex/types.ts:36-47` · `events/vortex/vortexSchema.ts` · `vortexDefinitions.ts:26, :29-40` |
| `rain` | `intensity` mm/h [0.1,500] 80 · `duration` s [1,21600] 1800(표시 분) | `area {center, radius m [0.5,100]}` 또는 없음(= 지도 전체) | `events/flood/resolveFlood.ts:12-19` · `floodSchema.ts:12-18` · `definitions.ts:106, :109-110` |
| `climate` | `scenario`(선택) heatwave · `temperature` K [213.15,333.15] 298.15(표시 °C) · `duration` s [1,172800] 3600(표시 분) | `target` K 311.15 · `forcing` · `profile` · `ramp` s · `humidity` 0.01–1 0.4(%) · `precipitation` mm/h [0,300] 0 · `area` · `solar`·`latitude`·`hour` · `initialSnow` m [0,5](cm) … 40여 칸 | `climate/types.ts:96-114, :124-128` · `events/climate/climateSchema.ts` · `climateDefinitions.ts:41-94` |
| `earthquake` | `magnitude` Mw [3,9.5] 6.5 · `pga` g [0.01,2] 0.3(없으면 가정값) · `duration` s [5,180] 25(없으면 자동) | `dominantFrequency` Hz [0.3,10] · `depth` km [0,700] · `epicenter` [x,z] m(**지도 밖 허용**) · `direction` ° · `verticalRatio` [0,1.5] · `seed` | `events/earthquake/resolveEarthquake.ts:34-41` · `earthquakeSchema.ts:8-20` · `definitions.ts:80, :83-87` |
| `sinkhole` | `cavityRadius` m [0.5,40] 3 · `cover` m [1,60] 6 · `initiation`(선택) growth | `cavityHeight` m [0.5,30] 6 · `growthRate` m/s [0,1] 0.2(표시 cm/s) · `duration` s [0,3600] 30 · `supportLoss` 0–0.95 · `saturation` 0–1 · `surcharge` kPa [0,500] · `variability` 0–0.5 · `material` | `ground/types.ts:75-78` · `events/ground/groundSchema.ts` · `groundDefinitions.ts:69, :72-88` |
| `landslide` | `trigger`(선택) saturation · `duration` s [0,7200] 60 | `area` 원 반경 m [3,150] 25 · `thickness` m [0.3,10] 2 · `saturation` 0–1 0.3 · `targetSaturation` 0–1 1 · `newmarkLimit` m [0.01,1](cm) · `turbulence` m/s² [50,5000] · `boundary` closed/open | `ground/types.ts:80-82` · `groundSchema.ts` · `groundDefinitions.ts:140, :143-158` |
| `terrainDeformation` | `kind`(선택) subsidence · `radius` m [2,150] 20 · `amount` m [0,30] 2 | `duration` s [0,3600] 5 · `profile` smooth · `falloff` smooth · `stages` [1,50] · `period` s [0.5,600] · `length` m [4,300] · `bearing` ° · `variability` · `supportLoss` 0–0.9 | `deformation/field.ts:29-39` · `events/deformation/deformationSchema.ts` · `definitions.ts:190, :193-206` |
| `volcano` | `layout`(선택) · `rate` m³/s [0.01,20] 2 · `duration` s [10,21600] 600(표시 분) | 분출구 `radius` m [0.5,10] 2 · `material` basalt · `temperature` °C [900,1300] 1140 · `profile` · `bombFraction`·`ashFraction` 0–0.3 · `plumeHeight` m [10,300] | `volcano/types.ts:63-74` · `events/volcano/volcanoSchema.ts` · `volcanoDefinitions.ts:54, :58-93` |
| `risingWater` | `level` m(수면 **표고**, 수심 아님) [−30,60] 1.5 · `riseRate` m/min [0.01,10] 0.5 · `duration` s [1,21600] 자동(상승 시간 + 180) | `boundary` N/E/S/W `'S'` | `resolveFlood.ts:12-19` · `floodSchema.ts:20-27` · `definitions.ts:126, :129-132` |
| `waterSource` | `rate` m³/s [0.001,200] 5 · `duration` s [1,21600] 600(표시 분) | `radius` m [0.5,100] 자동 2 | 같은 파일 · `floodSchema.ts:29-36` · `definitions.ts:148, :151-161` |
| `fire` | `radius` m [0.2,10] 1 · `duration` s [10,21600] 600(표시 분) | `height` m [0,60] 1 · `target`(객체 id 문자열, 칸 없음: `events/fire/fireSchema.ts:12`) | `fire/types.ts:28-32` · `fireDefinitions.ts:27, :30-34` |
| `heatSource` | `kind`(선택) point · `power` W [1,1e9] 5e5(표시 kW) · `duration` s [0.1,21600] 300 | `height` m [0,50] 1.5 · `radius` m [0.2,50] 2 · `input` power/energy · `energy` J [1,1e12](MJ) · `temperature` K [173.15,2273.15](°C) · `profile` · `radiativeFraction` 0–1 | `thermal/types.ts:56-67` · `events/thermal/thermalSchema.ts` · `thermalDefinitions.ts:31, :35-77` |
| `blast` | `energy` **J** [1e3,1e12] 1e8(표시 MJ, scale 1e-6) · `height` m [0,200] 1 | `model` weakShock · `waveform` nWave/positive · `ambientPressure` Pa [30000,110000](kPa) · `ambientDensity` kg/m³ [0.4,1.5] | `blast/types.ts:51-56` · `events/blast/blastSchema.ts:8-20` · `blastDefinitions.ts:44, :47-54` |
| `impact` | `diameter` m [0.05,20] 2 · `speed` m/s [1000,72000] 12000(표시 km/s) · `angle` ° [5,90] 60 | `material` iron · `azimuth` ° 90 · `entry` atmosphere/direct · `airBlast` 참 · `density` kg/m³ [300,8000] · `mass` kg(구 질량과 1 % 안: `impactSchema.ts:27-33`) · `airCoupling` 0.001–0.5 · `thermalShare` 0–0.5 | `impact/types.ts:62-69` · `events/impact/impactSchema.ts:10-33` · `impactDefinitions.ts:45, :48-70` |
| `gravity` | `scenario`(선택) moon · `magnitude` m/s² [0,50] 1.62 · `duration` s [1,21600] 120 | `global` 참 · `direction` 벡터 · `transition` · `profile` smooth · `ramp` s 10 · `end` restore/hold · `sources[]`(≤ 8; 반경 [1,400], 세기 [−50,50]) | `gravity/types.ts:105-112, :147-152` · `events/gravity/gravitySchema.ts` · `gravityDefinitions.ts:92-127` |
| `celestial` | `scenario`(선택) compactWell · `duration` s [1,21600] 120 | `scale` educational/physical · `sources[]`(≤ 4, 기본 중심 `[0,30,0]`) · `end` · `tidal` · `lensing` · `limitPolicy` · 강착 원반 칸 | `celestial/types.ts:133-151, :243-254` · `events/celestial/celestialSchema.ts` · `celestialDefinitions.ts:132-153` |
| `atmosphere` | `removal`(선택) none · `extent` uniform/local · `duration` s [1,21600] 600 | `altitude` m [−400,8000] 0 · `pressure` Pa [100,120000](kPa) · `temperature` K(°C) · `target` 0–1 0.5(%) · `radius` m [2,100] 25 · `boundary` · `restore*` · `thermo` | `atmosphere/types.ts:70-81, :93-97` · `events/atmosphere/atmosphereSchema.ts` · `atmosphereDefinitions.ts:38-88` |

명세 예문 확인: "폭발 1.8e9 J"는 `energy` 한계 [1e3, 1e12] 안입니다(`blast/types.ts:52`). 저장 단위가 J이므로 그대로 넣으면 됩니다 — UI 표시(MJ)와 헷갈리지 않게 해야 합니다(D18). (C)

### 2.4 검증·잘림이 일어나는 곳

| 층 | 무엇을 하나 | 근거 |
|---|---|---|
| UI 숫자 칸 | **유일한 잘림**: `clamp(v, min, max)` — 입력·확정·↑↓ | `ui/common/fields.tsx:54, :80, :111`; `SpecFields`가 `f.min/f.max`를 넘김(`ui/BottomPanel/ExperimentPanel.tsx:292`) (C) |
| 칸 읽기·쓰기 | `fieldValue`·`setField` — scale, 중첩 `get/set` 처리. **UI 파일의 비공개 함수** | `ExperimentPanel.tsx:177-189` (C) |
| `placement.set` | 위치를 스펙에 넣고 0.1 m 반올림. **범위 제한 없음**. 전역 중력·균일 대기에는 원본을 그대로 돌려줌(조용히 무시) | `catalog.ts:68-69, :199, :215` (C) |
| 월드 밖 검사 | 마우스 층에서만: 지면 광선 → `\|x\|, \|z\| ≤ mapHalf()`가 아니면 `null` | `rendering/placement/PlacementLayer.tsx:151-159` (C) |
| `addPhenomenon` / `updatePhenomenon` / `setExperiment` | **검증 없음** — 구현된 종류인지만 확인 | `app/actions.ts:437-448`, `world/worldStore.ts:735-745` (C) |
| zod | **거부**(잘라 넣지 않음). 위치는 `finite`뿐 — 월드 범위 없음 | 예 `events/blast/blastSchema.ts:5-6, :10`, 전 종류 위치 줄: `events/*/…Schema.ts` (C) |
| 실행 직전 | `resolveSchedule`이 `def.schema.safeParse` — 실패하면 그 인스턴스를 빼고 `invalidSpec` 문제(토스트 `exp.issue.invalidSpec`) | `phenomena/schedule.ts:58-59`, `app/actions.ts:475` (C) |
| 편집기 표시 | 잘못된 스펙이면 "⚠" 줄(`exp-invalid`) | `ExperimentPanel.tsx:195, :240` (C) |
| 불러오기 | 스키마에 안 맞는 인스턴스는 **조용히 버림** | `phenomena/experimentSchema.ts:26-35` (C) |
| 시작 시각 | `start.at` 0–86400 s, `offset` ±86400 s (불러오기 스키마) | `experimentSchema.ts:10-13` (C) |

→ 명세 §11의 "`placement.set`의 범위 제한"은 코드에 없습니다. 명령이 "잘린 값은 요약에 표시"하려면 **잘림 함수를 새로(공유로) 만들어야** 합니다(D19): `ParamField.min/max/scale`로 자르고, 자른 뒤 `def.schema.safeParse`로 최종 확인.

### 2.5 `PhenomenonInstance`·키·시작 시각

```
PhenomenonInstance { id: 'p1'…; type; spec: EventSpec(startTime 없음); enabled; start; seed?; visualize }   // phenomena/types.ts:154-165
InstanceStart = { at: number } | { after: string; anchor: 'start'|'end'; offset: number }                  // :146-148
```

- 저장 위치: `doc.scenario.experiment.instances`(`ExperimentSettings`: `types.ts:168-173`, 스키마 v5). (C)
- 만들기: `createInstance(type, instances, spec?)`(`phenomena/schedule.ts:101-108`) — `spec.startTime`이 있으면 **`start: { at }`로 옮기고 스펙에서 지웁니다**. id = `nextInstanceId` = 비어 있는 가장 작은 `p<n>`(:93-98) → 지운 번호를 **다시 씁니다**(D25). (C)
- 일정: `resolveSchedule(instances, ctx, timeBase = 0)`(:38-90) — 순수 함수. 상대 시작을 깊이 우선으로 풀고, 순환·없는 참조·꺼진 참조·잘못된 스펙·음수 시작은 문제로 보고하고 그 인스턴스를 **예약하지 않습니다**. 결과 스펙의 `startTime = timeBase + start`. (C)
- 실행 키: 실험 인스턴스는 그 id(`p3`), 직접 시작한 이벤트는 `<type>#<n>`(그 실행에서 그 종류의 n번째), 겹치면 `~2`(`simulation/SimulationController.ts:294, :305-310`). 이름 있는 종류(`NAMED_EVENTS`: `events/specs.ts:152`)는 이름이 없으면 키가 이름이 됩니다(:295, `schedule.ts:77`). (C)
- **"5초 뒤"의 뜻이 경로마다 다릅니다**(D24):

| 경로 | 시작 |
|---|---|
| 편집 모드에서 놓고 나중에 실행 | 실행 시작 후 `at` 초(`schedule.ts:63, :77`) |
| 실행 중 "실험 적용"(`runExperiment`) | **지금 + `at`**(`app/actions.ts:473-474`) |
| `runInstance`(한 개만 실행, "클릭 즉시 실행") | 편집 모드: `at` 유지 / 실행 중: **지연을 버리고 지금**(`app/placementActions.ts:87`) |
| 옛 명령 | 지금 + `delay`(`app/actions.ts:564-566`) |

### 2.6 API

**위치 정책** — 명세가 말하는 `placement.set/get` (`phenomena/catalog.ts:49-56`, `catalogOf(type)` :221-223):

```
placement.kind: 'ground'|'space'|'area'|'edge'|'epicentre'|'global'
placement.get(spec): [x, z] | null
placement.set(spec, [x, z], half): EventSpec        // half = mapHalf(), edge만 씀
placement.footprint(spec): { radius, reference, labelKey } | null
```

**배치 액션** (`app/placementActions.ts`; `window.__ds.placement`로 노출: `app/devtools.ts:146`):

| 함수 | 하는 일 | 부수 효과 |
|---|---|---|
| `mapHalf(): number` (:27-30) | `(nx − 1) × cellSize / 2` | 없음 |
| `runningKeys(): Set<string>` (:33-35) | 이번 실행에 들어간 키 | 없음 |
| `armPlacement(type)` (:38-56) | 카드 선택. 위치 없는 종류는 바로 `addPhenomenon` | 최근 목록 저장, 오른쪽 탭 → 재난, 지반·변형 지점 고르기 취소, 토스트 `exp.toast.added`(전역 종류), `runMode === 'now'`면 실행 |
| `disarmPlacement()` (:58-60) | 무장 해제 | — |
| `placeAt([x, z]): id \| null` (:63-75) | **무장된 종류·템플릿**으로 `placement.set` → `addPhenomenon(quiet)` | 핀 선택, 토스트 `place.placed`, `now`면 `runInstance`, 연속 아니면 해제. **무장 상태에 의존**(D21) |
| `runInstance(id)` (:81-94) | 그 인스턴스만 `runSimulation` | 시뮬레이션 진입, 이미 들어간 것은 무시, 문제는 토스트 |
| `moveInstance(id, [x, z]): boolean` (:97-108) | `placement.set` → `updatePhenomenon` | 실행에 들어간 것은 거부 + 토스트 `place.lockedRunning` |
| `deleteInstance(id)` (:111-122) | 계획에서 지움. 실행 중이면 시작 전 = cancel, 지속형 = stop | 멈출 수 없는 것은 **계획에서만** 지움(D29). 핀 선택 해제 |
| `duplicateInstance(id): id \| null` (:125-134) | 동쪽 6 m에 복사(시작 시각 유지) | 새 핀 선택 |
| `undoPlacement()` / `redoPlacement()` (:141-154) | **월드 실행 취소 그 자체** | — |

**실험 액션** (`app/actions.ts`; `__ds.actions`):

- `addPhenomenon(type, spec?, { quiet? }): id | null`(:437-444) — `createInstance` → `setExperiment({ instances: [...cur, inst] })`. 조용하지 않으면 토스트.
- `updatePhenomenon(id, patch)`(:446-448), `removePhenomenon(id)`(:450-457, 이것을 기준으로 삼던 인스턴스는 풀린 절대 시각으로 고정).
- `runExperiment()`(:470-487) — 켜진 전부를 한 시계에. 실행 중이면 이미 들어간 키는 뺌. `runSimulation(specs, keys?)`(:402-413) — 지반 준비 후 `addEvent(spec, { key })`.
- `phenomenonContext()`(:431-434) = `{ seed, terrain, water }`.

**실행 취소** (C): `setExperiment`(`world/worldStore.ts:735-745`)는 호출마다 **월드 기록 1단계**(`config: { settings, scenario }`)입니다. 문서가 잠겼거나 `history: false`면 적용만 하고 기록하지 않습니다(:739-742).
→ 재난 3개를 `addPhenomenon` 세 번으로 넣으면 3단계입니다. 한 번의 `setExperiment({ instances })`로 넣어야 1단계입니다(D22).

**컨트롤러** (`simulation/SimulationController.ts`; `__ds.sim`):

- `addEvent(spec, { key? }): string`(:293-303) — 키 결정, `startTime ?? 지금`, 시나리오 기록, 예약. 끝난 실행이면 일시정지 상태로.
- `controlEvent(key, op): boolean`(:317-332) — `op` = `'cancel'|'stop'|'pause'|'resume'`(`events/EventScheduler.ts:10`). 지금 상태에서 안 되면 **`false`**(아무 일 없음). 되면 시나리오에 `{t, op}` 기록 → 리셋 때 재현.
- `instances()`(:335-341) → `{ key, spec, status, stop, pause, start, end }[]`. `status` = pending·active·paused·done·superseded·stopped·cancelled(`EventScheduler.ts:7`).
- `scheduledTime(type, 'start'|'end')`(:634-642).
- UI용 목록은 `simStore.events: TimelineEventView[]`(`simulation/simStore.ts:19-35` — `key, type, start, duration, status, stop, pause`).

**`window.__ds`** (`app/devtools.ts:114-160`, DEV 또는 `?devtools`: `app/main.tsx:7`): `placement`(:146), `placementStore`(:151), `actions`(:144), `sim`(:153), `simStore`(:154), `ui`(:155), `world`(:116), `tr(key)`(:143), `deformLib.phenomena`(등록부, :159), `celestialLib.parse`(옛 파서, :258). **`CATALOG`는 노출돼 있지 않습니다**(D31). (C)

### 2.7 제어 지원 표 (35.5 §8의 "표"는 문서에 글로만 있음 — 코드에서 뽑음)

`controlsOf(event)`(`events/EventScheduler.ts:31-33`) = 이벤트 클래스에 `stop` / `pause`+`resume` 메서드가 있는지. 시작 전 `cancel`은 모든 종류가 됩니다(`SimulationController.ts:322`).

| type | 채널 (같은 채널은 **시작할 때 앞의 것을 대체**: `EventScheduler.ts:113-120`) | stop | pause·resume | 근거 |
|---|---|:-:|:-:|---|
| `wind` | `'wind'` — **전역 하나** | ✓ | ✗ | `events/wind/WindEvent.ts:22, :75-77` |
| `rain` | 지도 전체: `'rain'` — **전역 하나** / 원형: `rain:<id>` | ✓ | ✓ | `events/flood/WaterEvents.ts:31, :48, :52, :56` |
| `risingWater` | `water.<N\|E\|S\|W>` — **변마다 하나** | ✓ | ✓ | `WaterEvents.ts:83, :112, :116, :120` |
| `waterSource` | `source.<id>` | ✓ | ✓ | `WaterEvents.ts:146, :163, :167, :171` |
| `earthquake` | `earthquake:<id>`(선형 합) | ✓ | ✓ | `events/earthquake/EarthquakeEvent.ts:31, :47, :51, :55` |
| `tornado` | `vortex:<id>` | ✓ | ✓ | `events/vortex/VortexEvent.ts:24, :55, :59, :63` |
| `heatSource` | `heat:<id>` | ✓ | ✗ | `events/thermal/HeatSourceEvent.ts:26, :36` |
| `blast` | `blast:<id>` | ✗ | ✗ | `events/blast/BlastEvent.ts:39` |
| `impact` | `impact:<id>` | ✗ | ✗ | `events/impact/ImpactEvent.ts:71` |
| `sinkhole`·`landslide` | `ground:<id>` | ✗ | ✗ | `events/ground/GroundEvents.ts:29, :63` |
| `terrainDeformation` | `deform:<id>` | ✗ | ✗ | `events/deformation/TerrainDeformationEvent.ts:25` |
| `fire` | `fire:<id>` | ✗ | ✗ | `events/fire/FireEvent.ts:22` |
| `volcano` | `volcano:<id>` | ✗ | ✗ | `events/volcano/VolcanoEvent.ts:23` |
| `atmosphere` | `atmosphere:<id>` | ✗ | ✗ | `events/atmosphere/AtmosphereEvent.ts:24` |
| `climate` | `climate:<id>` | ✗ | ✗ | `events/climate/ClimateEvent.ts:24` |
| `gravity` | `gravity:<id>` | ✗ | ✗ | `events/gravity/GravityEvent.ts:23` |
| `celestial` | `gravity:<id>` | ✗ | ✗ | `events/celestial/CelestialEvent.ts:22` |

- 명령 "지진 멈춰" = `controlEvent(key, 'stop')`, "지워" = `deleteInstance(id)`, "일시정지/계속" = `'pause'`/`'resume'`. 지원 여부는 실행 중이면 `instances()[i].stop/pause`에서 읽고, 편집 모드에서는 이 표(정적)를 써야 합니다 — **정적 표는 코드에 없습니다**(클래스에 메서드가 있는지로만 판단). (C)
- 전역 중력 두 개가 어떻게 합쳐지는지는 스케줄러 대체가 아니라 런타임 규칙입니다 — 이번 범위에서 확인하지 않았습니다. (S)

### 2.8 실행 중 배치 (문서 잠금)

- 시뮬레이션에 들어가면 `setLocked(true)`(`app/actions.ts:364`), 나오면 해제(:383). (C)
- **마우스 배치는 실행 중에도 됩니다**: `PlacementLayer`는 두 장면 모두에 붙고(35.5 §4), 클릭 → `placeAt` → `addPhenomenon` → `setExperiment`. 잠겨 있으면 **문서는 바뀌되 기록은 남지 않습니다**(`worldStore.ts:739-742`). (C)
- 실행에 넣는 호출: `runMode === 'now'`면 `runInstance` → `runSimulation` → `addEvent(spec, { key: id })`(지금 시작). `'plan'`이면 문서에만 있고 "실험 적용"(`runExperiment`)을 눌러야 들어갑니다. (C)
- 실행에 들어간 인스턴스는 옮길 수 없고(`placementActions.ts:101-104`), 값을 바꿔도 다음 실행부터입니다(`inst.locked`: `ko.ux355.ts:130`). (C)
- 잠금 중에는 `undo`가 아무것도 하지 않습니다(`worldStore.ts:891-893`). 실행 중 넣은 인스턴스는 편집 모드로 돌아와도 **실행 취소로 지울 수 없습니다**(기록이 없으므로) — 목록에서 손으로 지워야 합니다(D23). (C)

### 2.9 전역·단일 상태 정리

| 상태 | 문서에 둘 이상 두면 | 계획 단계에서 할 일 |
|---|---|---|
| 전역 바람 | 나중에 시작한 것이 앞의 것을 대체(`superseded`) | "바람은 하나 — 앞의 것을 대신함" 경고 |
| 지도 전체 비(`area` 없음) | 같음 | 같음. 원형 비는 합쳐짐 |
| 같은 변의 수위 상승 | 같음 (`water.<변>`) — **명세·35.5 문서에 없는 경우** | 같음 |

문서에 넣는 것 자체는 막지 않습니다(`addPhenomenon`에 검사 없음). 대체는 실행 시작 시점에 일어납니다. (C)

---

## 3. 객체 팔레트 (명세 §3-4)

### 3.1 데이터가 있는 곳

| 무엇 | 어디 | 비고 |
|---|---|---|
| 팔레트 항목 | `PALETTE: PaletteItem[]`(`objects/palette.ts:38-105`) — `id, type, category, labelKey, icon, params?, randomize?, buildingPreset?` | 38개 + 숨은 `building.custom`(:108) (C) |
| 범주 | `CATEGORY_ORDER` 7개(`palette.ts:28-36`), 이름 `category.<id>`(`ko.ts:76-81`, `ko.dynamicObjects.ts:3`) | (C) |
| 종류 정의 | `allDefinitions()`(`objects/registry.ts:15-42`) — `ObjectDefinition`: `type, labelKey, defaultParams, paramSchema[], getDimensions(), terrainFit, randomizeParams?`(`objects/ObjectDefinition.ts:59-90`) | 종류 14개 (C) |
| 매개변수 메타 | `ParamSchema {key, labelKey, kind, min?, max?, step?, unit?, options?}`(`ObjectDefinition.ts:30-39`) | (C) |
| 놓을 수 있는 것 | `PLACEABLE`(`ui/ObjectPalette/ObjectPalette.tsx:75`) | UI 파일 안 (C) |
| 검색 | `ObjectPalette.tsx:92-99` — 한·영 라벨 + 범주(현재 언어) + type + id, 부분 문자열 | **별칭 없음**, 인라인 (C) |
| 항목의 실제 매개변수 | `itemParams(item)`·`itemDesign(item)`(`editor/build/itemDesign.ts:15-34`) | `'custom'`은 저장소(`buildStore.creator.design`)를 읽음 (C) |
| 건물 프리셋 | `BUILDING_PRESETS`(`buildings/spec.ts:55-71`), `presetSpec(id)`(:73-76) | 이름 `building.preset.<id>`(`ko.building.ts:254-260`) (C) |
| 즐겨찾기·최근 | `buildStore.favorites/recent`(`ObjectPalette.tsx:83-84`) | 브라우저 (C) |

### 3.2 팔레트 항목 표

바닥면 = `getDimensions(params)`의 x × z(m). 차·상자류는 **x = 길이**입니다(`definitions/car.ts:49`). 세는 말은 코드에 없어 제안입니다(D42).

| id | type | 범주 | 한국어 / 영어 (키 @ `ko` 파일:줄) | 주요 매개변수 (기본) | 바닥면 x × z | 세는 말 |
|---|---|---|---|---|---|---|
| `building.lowrise` | building | buildings | 상가 건물 / Shop Building (`preset.building.lowrise` @ `ko.ts:105`) | floors 3, 10 × 8 m, 층고 3.2 — **상자 건물** | 10 × 8 | 채·동 |
| `building.office` | building | buildings | 오피스 빌딩 / Office Tower (`ko.ts:106`) | floors 10, 14 × 12 — 상자 | 14 × 12 | 채·동 |
| `building.house` | building | buildings | 주택 / House (`ko.ts:107`) | floors 2, 7 × 7, 층고 2.9 — 상자 | 7 × 7 | 채·동 |
| `building.m.house` | building | buildings | 소형 주택 (목조) / Small house (timber) (`building.preset.house` @ `ko.building.ts:254`) | 프리셋 `house`: 8 × 7, 2층, 목조·박공 | 부재 범위(설계 8 → 8.4: `docs/ADVANCED_WORLD_EDITOR.md:165`) | 채·동 |
| `building.m.apartment` | building | buildings | 중층 아파트 (RC) / Mid-rise apartment (RC) (`:255`) | `apartment`: 18 × 12, 6층, RC + 코어 | 부재 범위 (S) | 채·동 |
| `building.m.office` | building | buildings | 오피스 빌딩 (철골+코어) / Office building (steel + core) (`:256`) | `office`: 24 × 18, 10층 | 부재 범위 (S) | 채·동 |
| `building.m.warehouse` | building | buildings | 창고 (철골 포털) / Warehouse (steel portal) (`:257`) | `warehouse`: 36 × 24, 1층(8 m) | 부재 범위 (S) | 채·동 |
| `building.m.industrial` | building | buildings | 공장 건물 (RC) / Industrial building (RC) (`:258`) | `industrial`: 30 × 20, 2층 | 부재 범위 (S) | 채·동 |
| `building.m.tower` | building | buildings | 고층 타워 (RC+코어) / High-rise tower (RC + core) (`:259`) | `tower`: 30 × 30, 30층 | 부재 범위 (S) | 채·동 |
| `tree.broadleaf` | tree | nature | 활엽수 / Broadleaf (`ko.ts:108`) | height 8, canopyRadius 2.6, trunkRadius 0.3, 무작위 변형 | 5.2 × 5.2 (겹침 판정은 × 0.45: `editor/build/footprint.ts:29`) | 그루 |
| `tree.conifer` | tree | nature | 침엽수 / Conifer (`ko.ts:109`) | height 11, canopyRadius 2.2 | 4.4 × 4.4 | 그루 |
| `car.sedan` | car | vehicles | 승용차 / Sedan (`ko.ts:110`) | variant sedan, 4.5 × 1.8 × 1.45 | 4.5 × 1.8 | 대 |
| `car.suv` | car | vehicles | SUV / SUV (`ko.ts:111`) | 4.8 × 1.95 × 1.8 | 4.8 × 1.95 | 대 |
| `car.truck` | car | vehicles | 트럭 / Truck (`ko.ts:112`) | 8 × 2.5 × 3.2 | 8 × 2.5 | 대 |
| `human.adult` | human | people | 보행자 / Pedestrian (`ko.ts:113`) | height 1.75(무작위 1.55–1.90: `definitions/human.ts:54-61`) | 0.5 × 0.3 | 명 |
| `infra.streetLight` | streetLight | infrastructure | 가로등 / Street Light (`object.streetLight` @ `ko.ts:100`) | height 8, armLength 1.6 | 2.1 × 0.4 | 개 |
| `infra.sign` | sign | infrastructure | 도로 표지판 / Road Sign (`ko.ts:436`) | height 3.2, 판 2.4 × 1.4 | 2.4 × 0.2 | 개 |
| `infra.billboard` | sign | infrastructure | 광고판 / Billboard (`ko.ts:437`) | height 6, 판 6 × 3 | 6 × 0.2 | 개 |
| `infra.signal` | sign | infrastructure | 신호등 / Traffic signal (`ko.roads.ts:5`) | height 5.2, 판 0.45 × 1.2 | 0.45 × 0.2 | 개 |
| `infra.guardrail` | wall | infrastructure | 가드레일 / Guardrail (`ko.roads.ts:6`) | length 4, height 0.75 | 4 × 0.15 | 개 |
| `infra.wall` | wall | infrastructure | 조적 담장 / Masonry Wall (`ko.ts:438`) | length 6, height 2, 두께 0.25 | 6 × 0.25 | 개 |
| `infra.fence` | wall | infrastructure | 블록 펜스 / Block Fence (`ko.ts:439`) | length 8, height 1.8 | 8 × 0.12 | 개 |
| `obj.crate.wood`·`.steel`·`.plastic` | crate | objects | 나무 상자·강철 상자·플라스틱 상자 / Wooden·Steel·Plastic crate (`ko.dynamicObjects.ts:10-12`) | material, 길이·폭·높이, cargo kg, sealed | 1.2 × 0.8 · 1 × 1 · 0.6 × 0.4 | 개 |
| `obj.barrel.empty`·`.water`·`.oil` | barrel | objects | 빈 드럼통 (200 L)·물 채운 드럼통·기름 채운 드럼통 (`:13-15`) | fill | 0.572 × 0.572 (`definitions/dynamicObjects.ts:138, :180`) | 개 |
| `obj.container.20ft`·`.40ft` | container | objects | 20피트·40피트 컨테이너 (`:16-17`) | size, cargo kg | 6.058 × 2.438 · 12.192 × 2.438 (`:217-219`) | 개 |
| `obj.furniture.sofa`·`.table`·`.cabinet` | furniture | objects | 소파·식탁·수납장 / Sofa·Dining table·Cabinet (`:18-20`) | kind, 치수 | 2.0 × 0.9 · 1.6 × 0.9 · 1.0 × 0.55 | 개 |
| `obj.roadBarrier` | roadBarrier | objects | 콘크리트 방호벽 (NJ형) / Concrete barrier (NJ) (`:21`) | length 3.0 | 3.0 × NJ 밑폭 | 개 |
| `obj.ball`·`obj.ball.hollow` | ball | objects | 공 (반지름 0.3 m)·속이 빈 공 (반지름 0.35 m) (`:22-23`) | radius, mass kg, construction | 0.6 × 0.6 · 0.7 × 0.7 | 개 |
| `env.road` | road | environment | 2차로 도로 / 2-Lane Road (`ko.ts:440`) | length 20, width 7, lanes 2 → **네트워크 도로 `street` 조각** | — | 개·구간 |
| `env.road4` | road | environment | 4차로 도로 / 4-Lane Road (`ko.ts:441`) | length 40, width 14, lanes 4 → `avenue` 조각 | — | 개·구간 |

종류(type) 이름: 건물·나무·자동차·사람·가로등·표지판·담장·도로(`object.<type>` @ `ko.ts:95-102`), 상자·드럼통·컨테이너·가구·콘크리트 방호벽·공(`ko.dynamicObjects.ts:4-9`). 영어: Building·Tree·Car·Person·Street Light·Sign·Wall·Road(`en.ts:92-99`) 등. (C)

종류별 매개변수 한계(`paramSchema`): building `definitions/building.ts:74-80`(floors 1–30, 폭·깊이 4–40 m, 층고 2.6–5 m), tree `tree.ts:29-39`(높이 3–25 m), car `car.ts:24-36`(길이 2.5–12 m), human `human.ts:21`(키 1–2.1 m), streetLight `streetLight.ts:21-23`, sign `sign.ts:20-23`, wall `wall.ts:22-25`(길이 1–40 m), road `road.ts:23-25`, 수동 물체 `dynamicObjects.ts:98-103, :253, :379-381, :446, :499-500`. 이 한계는 인스펙터 칸에서 쓰입니다 — 저장소가 강제하는지는 확인하지 않았습니다. (S)

### 3.3 건물 프리셋과 `building.spec`

`BuildingSpec`(`buildings/types.ts:78-112`), 한계 `SPEC_LIMITS`(`buildings/spec.ts:13-25`), 칸 이름 `building.field.<key>`(`ko.building.ts:72-91`).

| 칸 | 단위 | 한계 | 기본(`defaultSpec`, `spec.ts:37-45`) | 한국어 라벨 |
|---|---|---|---|---|
| `width` / `depth` | m | 3–60 | 12 / 10 | 폭 (x) / 깊이 (z) |
| `floors` | 정수 | 1–40 | 4 | 층수 |
| `floorHeight` | m | 2.2–8 | 3.2 | 기준층 높이 |
| `groundFloorHeight` | m | 2.2–10 | 3.2 | 1층 높이 |
| 전체 높이 | m | ≤ 150 | — | (오류 `tooTall`: `spec.ts:113-114`) |
| `bay` | m | 2.5–15 | 6 | 기둥 간격 (목표) — **베이 "개수" 칸은 없음**(`nx = round(width / bay)`) |
| `system` | 선택 | rcFrame·steelFrame·masonry·wood (`spec.ts:27`) | rcFrame | 구조 형식 |
| `structureMaterial`·`slabMaterial`·`claddingMaterial` | 선택 | `MaterialId` | RC·RC·조적 | 주 구조·바닥·외장 재료 |
| `roof` / `roofPitch` | 선택 / ° | flat·gable·shed / 3–60 | flat / 25 | 지붕 형태 / 경사 |
| `facade` / `windowDensity` | 선택 / 비율 | punched·ribbon·curtain / 0–0.9 | punched / 0.35 | 외관 형식 / 창 면적 비율 |
| `foundation` | 선택 | spread·mat·pile | mat | 기초 형식 |
| `core`·`ceiling`·`sign` | 참/거짓 | — | 거짓·참·거짓 | RC 코어벽 · 최상층 천장 슬래브 |
| `occupancy` | 선택 | residential·office·storage·industrial | office | 용도 |
| `rooftopUnits` | 정수 | 0–6 | 0 | — |

- 검증: `validateSpec(spec)`(`spec.ts:93-140`) — 범위·정수·선택지·재료는 **오류**(적용 막음, 잘라 넣지 않음), 조적 > 5층·목조 > 6층·긴 경간·연약층 등은 **경고**. 불러오기만 `normalizeSpec`으로 자릅니다(:145-165). (C)
- 프리셋(`spec.ts:55-71`): `house`(8 × 7, 2층, 목조, 박공 30°, bay 4), `apartment`(18 × 12, 6층, RC, 코어), `office`(24 × 18, 10층, 철골, 커튼월, 코어), `warehouse`(36 × 24, 1층 8 m, 철골), `industrial`(30 × 20, 2층, RC), `tower`(30 × 30, 30층, RC, 말뚝, 코어). (C)
- **층수를 바꿔 놓는 함수가 이미 있습니다**: `presetDesign(preset, floors)`(`roads/city.ts:158-167`) = `createDesign({ ...presetSpec(preset), floors }, preset)` + 캐시. 도시 생성기 전용 위치에 있습니다(D34). 구역별 층수 범위는 `ZONE_BUILDINGS`(:149-154). (C)
- 구조 형식 v2(steel·rc·masonry·timber·light)는 스펙 칸이 아니라 부재 재료에서 나옵니다(Phase 36 감사 `docs/phase36-audit/buildings.md` §1.4).

### 3.4 차량·사람·나무·숲

- 차량 종류는 `variant` 셋뿐: sedan·suv·truck(`vehicle/params.ts:12`). `vehicle/presets.ts`의 "프리셋" 32개는 **실험 월드**(문서 교체)이지 놓는 종류가 아닙니다(`vehicle/presets.ts:1-14`). 사람도 같습니다 — `human/presets.ts` 20개는 실험 월드이고, 놓는 종류는 `human.adult` 하나입니다. (C)
- 도로에 차를 늘어놓는 기존 함수: `addVehiclesAlong(segIds, 'lanes'|'parked', spacing, seed)`(`app/roadActions.ts:220-233`) → `vehiclesAlong`(`roads/city.ts:435`). 건물은 `addBuildingsAlong(segIds, zone, side, setback, gap, seed, slopeLimit)`(:212-218) → `buildingsAlong`(`city.ts:250`), 가로 시설은 `addInfrastructure`(:204-210). 구역별 무작위 건물을 놓는 생성기라 "주택 세 채"처럼 **프리셋·개수를 지정하지는 못합니다**. (C)
- 나무: 수종 broadleaf·conifer(`definitions/tree.ts:29-36`). 숲 = `planForest(points, settings, ctx?, stroke)`(`app/natureActions.ts:265-299`) — 순수(문맥을 넘기면), 거부 사유 `elevation·water·ground·soil·road·placement`(:254).
  `ForestSettings`(`editor/natureStore.ts:22-48`), 기본 `DEFAULT_FOREST`(:65-66: 침엽 0.4, 밀도 1.6 그루/100 m², 간격 3.5 m, 반경 12 m, 시드 1, 경사 35°, 고도 −5–80 m).
  UI 한계(`ui/Terrain/NatureSections.tsx:245-255`): 반경 2–40 m, 밀도 0.1–8, 간격 1–20 m, 침엽 0–100 %, 경사 1–60°, 고도 −40–80 m, 물 여유 0–30 m, 도로 여유 0–10 m. 획 키 `forestStrokeKey(x, z)`(:233-235). (C)
- "나무"의 매개변수가 세 벌입니다: 팔레트(`palette.ts:54-57`: 활엽 수관 2.6), 숲(`natureActions.ts` `planForest`: 활엽 수관 3·줄기 0.28), 가로수(`roads/city.ts:299`: 높이 7·수관 2.2)(D39). (C)
- 지형 요소 종류: mountain·hill·ridge·valley·canyon·river·lake·coast(`landscape/types.ts:29, :56, :83, :103, :119, :136`). (C)

### 3.5 도로 프리셋 — 표가 셋

| 표 | 키 | 이름 |
|---|---|---|
| 도로 도구 `PROFILE_PRESETS`(`roads/types.ts:118-127`) | `street`(7 m·2차로·보도 2 m), `narrow`(6 m·2차로), `wide`(10 m·2차로·갓길 1.5 m), `avenue`(14 m·4차로), `lane`(4.5 m·1차로·콘크리트), `gravel`(4 m), `dirt`(3.5 m) | `road.preset.<key>`: 2차로 도로·좁은 2차로·넓은 2차로 (갓길)·4차로 대로·골목길·자갈길·흙길(`ko.roads.ts:24-28`, `ko.ux355.ts:148-149`) / Two-lane street·Narrow 2-lane·Wide 2-lane (shoulders)·Four-lane avenue·Lane·Gravel road·Dirt track |
| 단면 `CROSS_SECTIONS`(`roads/crossSection.ts:57-65`) | `narrow2`·`normal2`·`wide2`·`avenue4` → 위의 `narrow`·`street`·`wide`·`avenue` | (이름 없음 — 위 것을 씀) |
| 팔레트(`objects/palette.ts:102-104`) | `env.road`·`env.road4` | 2차로 도로·4차로 도로(`ko.ts:440-441`) |

- 한계 `PROFILE_LIMITS`(`roads/types.ts:129-136`): 폭 2.5–30 m, 차로 1–8, 보도 0.8–6 m, 연석 0–0.3 m, 갓길 0–4 m, 중앙분리대 0–10 m. (C)
- 단면 계산: `crossSectionOf(profile)`(`crossSection.ts:34-46`), 차선 중심 `laneCenter`(:49-55), 지점별 `sectionAt`(끝난 차선 = `lanes[i] === null`: :109-110). (C)
- 팔레트 도로는 `placeRoadPiece(preset, center, yaw, length)`(`app/roadActions.ts:76-87`)로 네트워크 도로가 됩니다 — 차로 ≥ 4면 `avenue`, 아니면 `street`(`editor/tools/PlaceTool.tsx:138-141`). 실패하면 `null` + 토스트 `road.error.tooShort`, 잠겨 있으면 조용히 `null`(:77). (C)
- "2차로"라는 말은 `narrow`·`street`·`wide` 셋에 해당합니다(D40). 도로·노드 id는 문서 계수기에서 나오는 `n<k>`·`s<k>`라 결정론적입니다(`roads/network.ts:22-23`, `roads/types.ts:86`). (C)

### 3.6 템플릿·환경·지형 프리셋·Blueprint

| 묶음 | id | 이름 키 | 적용 함수 — 주의 |
|---|---|---|---|
| 월드 템플릿 8 (`templates/builtin.ts:26-27`) | emptyFlat·smallTown·denseCity·coastalCity·mountainVillage·riverValley·industrialDistrict·forestLake | `tpl.builtin.<id>.name`(`ko.blueprints.ts:266-280`): 빈 평지·작은 마을·밀집 도시·해안 도시·산골 마을·강 유역 마을·공업 지구·숲과 호수 | 순수 `buildTemplate(kind, seed)`(:89). UI 경로 `applyTemplate(id, seed, 'new'\|'replace', name?)`(`app/blueprintActions.ts:414`)는 비동기 |
| 환경 프리셋 6 (`landscape/presets.ts:27-28`) | mountainValley·riverBasin·coastalPlain·forestedHills·lakeDistrict·mixedUrbanNatural | `nature.env.<id>`(`ko.nature.ts:179-184`): 산악 계곡·강 유역·해안 평야·숲 언덕·호수 지대·도시·자연 혼합 | 순수 `buildEnvironment(kind, seed)`(:70). `applyEnvironment`(`app/natureActions.ts:315-331`)는 객체가 있으면 **`window.confirm`**(:317), 한 `applyEdit` 단계 |
| 지형 프리셋 5 (`core/model.ts:315`, `terrain/TerrainPresets.ts:15`) | flat·gentleHills·valley·coastal·lowland | `terrain.preset.<id>`(`ko.ts:578-581`, `ko.flood.ts:28`): 평지·완만한 언덕·계곡·해안 저지대·저지대 범람원 | `app/actions.ts:150-155`는 **`window.confirm`**; 저장소 메서드 `worldStore.applyTerrainPreset(preset, seed)`는 확인 없음(`scripts/verify-flood.mjs:141`이 그렇게 씀) |
| 내장 Blueprint 10 (`blueprints/builtin.ts:25-27`) | house·apartments·shoppingStreet·industrialPark·crossroads·forest·mountain·riverBasin·lakeVillage·mixedDistrict | `bp.builtin.<id>.name`(`ko.blueprints.ts:284-302`): 단독 주택·아파트 단지·상업 거리·공업 단지·교차로 구역·숲·산악 지형·강 유역·호수 주변 마을·도시·자연 혼합 지역 | `buildBuiltinBlueprint(id)`(:61) |
| 동네 생성 4 (`roads/city.ts:575-576`) | residentialStreet·commercialStreet·industrialBlock·parkBlock | — | `placeNeighborhood(kind, x, z, yaw, seed)`(`app/roadActions.ts:236`) |

명세 §5의 정규 문법에는 템플릿·환경·Blueprint 동사가 없습니다. 이름이 종류 이름과 겹치는 것만 조심하면 됩니다(D32): "강 유역"(환경·Blueprint), "숲"(Blueprint·`forest` 명령), "단독 주택"(Blueprint) ↔ "주택"(건물).

### 3.7 바닥면 — 스냅이 쓰는 실제 크기

```
footprintHalves(type, params, scale) = getDefinition(type).getDimensions(params) 의 x·z 절반 × scale     // editor/snap/snapEngine.ts:260-264
건물(모듈식): params = designParams(design) → width/depth = designExtent(design) = 지상 부재의 경계 상자       // buildings/design.ts:72-90, :93-106
건물(상자):   params.width / params.depth 그대로                                                          // objects/definitions/building.ts:93
겹침 판정:    collisionFootprint(type, params, scale, x, z, yaw) — 나무는 × 0.45, 지면 층(도로)은 null        // editor/build/footprint.ts:25-31
월드 안:      isInsideWorld(pos, dims, yaw) — 회전한 바닥면이 ±WORLD_HALF(100 m) 안                          // editor/placement.ts:12-18, core/units.ts:12-13
```

"주택 8 m 설계 → 8.4 m 바닥면"은 `designExtent`가 벽 두께까지 잰 결과입니다(`docs/ADVANCED_WORLD_EDITOR.md:165`). 명령의 "간격 2 m"는 **이 바닥면 기준**으로 계산해야 마우스 스냅(이웃 맞닿음)과 맞습니다. 다른 프리셋의 실제 값은 실행해 읽어야 합니다. (S)

### 3.8 놓는 경로 — 순수한 것과 아닌 것

| 경로 | 순수? | 내용 |
|---|:-:|---|
| `planPlacement(item, points, settings, ctx, startIndex?, plannedIndex?)`(`editor/build/placementPlan.ts:104-157`) | ✓ | `PlanItem {type, params?, building?, randomize?}` + 점 `{x, z, yaw?}` → `PlannedObject {input, ok, rejected?: 'outside'\|'slope'\|'collision', warnings}`. 시드 흐름 `subSeed(s.seed, 'obj', i)`, 지면 앉힘 `groundPose`, 검사 `checkPlacement`·`isInsideWorld`·겹침. **스냅은 하지 않음** — 점은 호출자가 줌 |
| `acceptedInputs(plan)`(:159) → `commitPlan(plan, itemId)`(`app/buildActions.ts:338`) | 확정 | 저장소에 쓰는 쪽 |
| `snapPoint(query, env)`(`editor/snap/snapEngine.ts:204-258`) | ✓ | `{x, z, yaw, half, type}` → `SnapTarget {kind, x, z, yaw?, ref, dist}`. 도로 접면 뒤로 물림 `FRONTAGE_SETBACK = 1`(:39) |
| `checkStamp(inputs, existing)`(`editor/build/placementCheck.ts:30`), `checkPlacement`(:67) | ✓ | 경고 `slope·floating·buried·overlap·outside·wheelContact·steep·inWater·offRoad`(:22) |
| `PlaceTool`(`editor/tools/PlaceTool.tsx`) | ✗ | 한 개 놓기의 조립(매개변수 합성 :71-83, 스냅 :109-121, 확정 :129-152)이 **컴포넌트 안**. 시드가 `Math.random`(:63, :66, :151)(D36) |
| `createWorldObject`(`world/WorldDocument.ts:68-90`) | ✗ | id = `createId(type)` — **무작위**(`core/id.ts:3-10`), `seed` 생략 시 `Math.random`(:70)(D37) |

### 3.9 명령 어휘를 생성할 "한 표"가 있는가

**결론: 영역마다 한 표씩은 있습니다. 모든 것을 담은 한 표는 없고, 이름 문자열은 로케일 파일 10여 개에 흩어져 있습니다. 그러나 표의 `labelKey`를 따라가면 한·영 이름을 UI 언어와 무관하게 읽을 수 있으므로 생성은 가능합니다. 없는 것은 별칭·단위 명사·괄호 정리 규칙입니다.**

| 어휘 | 생성 출처(이미 있음) | 없는 것 |
|---|---|---|
| 재난 종류 | `phenomena.listImplemented()` × `CATALOG` × `translate('ko'\|'en', labelKey\|shortKey)` | 열거 가능한 별칭(정규식뿐), 겹침 우선순위 |
| 재난 칸 이름·단위·한계 | `def.fields[]`(`key`, `labelKey`, `unit`, `min`, `max`, `scale`, `options`) | 저장 단위 표기(`unit`은 표시 단위), 편집 모드용 제어 지원 표 |
| 재난 범주 | `CATEGORIES` × `lib.cat.<id>` | — |
| 객체 종류·프리셋 | `PALETTE` × `translate(labelKey)` + `allDefinitions()` × `object.<type>` | 별칭("집"·"차"·"빌딩"), 괄호 붙은 라벨 정리, 같은 이름 우선순위 |
| 객체 매개변수 | `def.paramSchema[]`, 건물은 `SPEC_LIMITS` + `building.field.<key>` | 층수 → 설계 경로의 공유 위치 |
| 단위 명사 | — | **표 없음**. UI 문구에는 건물 "동"(`ko.nature.ts:139`), 나무 "그루"(:115), 사람 "명"(`ko.humanUi.ts:107`), 차 "대"(`ko.vehicleUi.ts:210`) |
| 도로 프리셋 | `PROFILE_PRESETS` × `road.preset.<key>` | "2차로" → 어느 프리셋인지 |
| 템플릿·환경·지형·Blueprint | 각 id 배열 × 이름 키(§3.6) | — |

**제안하는 단일 출처**

1. 재난: `CatalogEntry`(`phenomena/catalog.ts:58-66`)에 `aliases?: { ko: string[]; en: string[] }`를 더합니다(이 파일은 "시뮬레이션이 읽지 않는 UI 메타"). 시험으로 묶습니다: 모든 별칭이 그 종류의 `def.keywords`에 맞고, 다른 구현 종류에도 맞으면 우선순위 표에 적혀 있어야 함. → 옛 파서(정규식)와 새 어휘(목록)가 어긋날 수 없습니다.
2. 객체: `PaletteItem`(`objects/palette.ts:6-23`)에 `aliases?`를, `CATEGORY_ORDER` 옆에 `CATEGORY_COUNTERS: Record<ObjectCategory, string[]>`(건물 = 채·동, 차량 = 대, 자연 = 그루, 사람 = 명, 그 밖 = 개)를 둡니다.
3. 생성기 `src/command/lexicon.ts`는 **표를 읽기만** 합니다: 라벨을 `/`, `·`, `(…)`에서 쪼개 이름 후보를 만들고(예: "바람 / 태풍" → 바람·태풍, "소형 주택 (목조)" → 소형 주택), 별칭을 더하고, 겹치는 이름을 시험에서 나열합니다. `lexicon.ko.ts`·`lexicon.en.ts`에는 **조사·동사·수사·방향·지시어 같은 문법 낱말만** 손으로 둡니다(종류 이름은 금지).
4. 검색 함수 공유: `DisasterLibrary.tsx:34-35`와 `ObjectPalette.tsx:92-99`의 인라인 일치 로직을 순수 함수로 빼서 라이브러리 검색·팔레트 검색·명령 자동 완성이 같이 씁니다(D16).
5. 칸 접근 공유: `fieldValue`·`setField`(`ExperimentPanel.tsx:177-189`)를 `phenomena/`로 옮기고 `clampField(f, v) → { value, clamped }`를 더합니다(D17, D19).

---

## 4. 결함·빈 곳

| # | 결함·빈 곳 | 근거 file:line | 명령에 미치는 영향 | 권장 처리 |
|---|---|---|---|---|
| D1 | 옛 명령은 인스턴스·실행 취소를 거치지 않고 `addEvent`로 바로 실행, 편집 모드에서 Enter 한 번에 시뮬레이션 진입 (C) | `app/actions.ts:561-569`; `simulation/SimulationController.ts:294` | 명세 §11 "마우스와 같은 인스턴스·같은 실행 취소"와 어긋남. 핀·목록에 안 보임 | 확정은 `setExperiment` 경로 하나로. "지금 실행"은 `runInstance`/`runSimulation(specs, keys)` |
| D2 | 옛 Chrome 스크립트가 "Enter 한 번 = 즉시 실행"과 시험 id·placeholder "Enter"를 기대 (C) | `scripts/verify-flood.mjs:146-153`; `scripts/verify-ux355.mjs:186-192`; `scripts/verify-phenomena.mjs:135-145`; `scripts/verify-celestial.mjs:541-542` | §9 "편집은 미리보기 → 확정"과 충돌. 식별자를 바꾸면 23개 스크립트의 서랍 열기 덧붙임이 헛돎 | 옛 문법 문장 = "배치 + 지금 실행", 제출 시 동기 계획, 식별자 유지. **결정 필요** |
| D3 | 인스턴스 제어 문장이 옛 파서에서는 새 재난 시작: "지진 멈춰" → M6.5 지진, "비 멈춰" → 30 mm/h 비 (C) | `commands/RuleBasedParser.ts:416-425`; `commands/earthquakeParser.ts:25-27, :53, :67-69`; `commands/floodParser.ts:24, :39, :145-155` | 옛 파서를 뒷받침으로 붙이면 "멈춰"가 재난을 일으킴 | 새 문법이 제어·삭제 문장을 먼저 가져감. 말뭉치에 반례로 고정 |
| D4 | 폭발·운석·싱크홀·산사태·소용돌이·지형 변형 문장은 숫자·위치를 버리고 기본값으로 실행 (C) | `commands/RuleBasedParser.ts:458-466` | "n4에 폭발 1.8e9 J" → 중앙 1e8 J. §6 "추측 실행 금지" 위반 | 이 6종은 어댑터에 넘기지 않고 새 문법이 칸 표로 처리 |
| D5 | 숫자 토큰화가 `1.8e9`·`×10⁹`(NFKC로 "109")·`18억`·음수·한글 수사를 모름 (C: 정규식·유니코드 규칙) | `commands/RuleBasedParser.ts:24, :121, :148` | §6의 수 표기 전부 새로 필요. 옛 `normalize`를 그대로 앞에 두면 지수가 깨짐 | 새 `normalize.ts`에서 지수·억·수사를 **NFKC 전에** 처리. 옛 파서에는 풀어쓴 숫자를 넘김 |
| D6 | 구현된 현상을 편집기로 안내할 때 문구가 "미구현 현상: …" (C) | `ui/BottomPanel/describeCommand.ts:95-99`; `ko.phenomena.ts:144` | 화재·화산·기후·대기·중력·블랙홀이 "미구현"으로 보임 | 새 명령창에서는 이 6종을 실제 지원하거나 "편집기에서 설정" 문구로 분리 |
| D7 | 옛 zod 계약은 18종 중 11종, 타입 캐스팅으로 추론 꺼짐 (C) | `commands/schema.ts:20-29` | Intent 스키마로 재사용 불가 | `Intent`는 `def.schema`(종류별 zod)를 참조해 새로 정의 |
| D8 | 명령 입력란 Enter가 `isComposing`을 보지 않음. 재난 검색 Enter도 같음 (S — CDP 조합 입력으로 확인) | `ui/BottomPanel/CommandPanel.tsx:64-68`; `ui/Phenomena/DisasterLibrary.tsx:51` | 한글 조합 중 Enter에 제출(§6, S2) | 새 입력란에서 `e.nativeEvent.isComposing \|\| keyCode === 229` 검사. 검색창도 같이 |
| D9 | 파서 입력에 UI 상태(바람 폼, 지금 부는 바람)가 섞임 (C) | `ui/BottomPanel/CommandPanel.tsx:19-24` | 같은 문장 → 다른 스펙. 계획 해시 결정론 깨짐 | `ParseDefaults`를 `Context`의 명시 칸으로, 요약에 "풍향 미지정 → …" 표시 |
| D10 | 명령 기록이 메모리에만 (C) | `ui/BottomPanel/commandStore.ts:20-29` | §14 `ds.commands.history` 50개 없음 | 새 저장소에서 브라우저 저장 |
| D11 | `LlmParser`는 호출부·시험이 없고 옛 실행 명령 JSON 계약 (C) | `commands/LlmParser.ts:22-54`; `app/actions.ts:556-557` | §16 `IntentProvider`와 다름 | 확장하지 않음. 새 인터페이스 + 가짜 공급자. 옛 파일은 지우거나 표시 |
| D12 | 시험 파일이 `@/commands/…`를 import, `@/command` 접두 grep은 `@/commands/`도 잡음 (C) | `climate/audit30.test.ts:24`; `__audit__/identity/parse.probe.ts:3`; `__audit__/p355/parse.probe.ts:2` | §18 의존 방향 grep 시험이 거짓 양성 | `@/command/`(끝 빗금) + 시험·탐침 제외, 또는 모듈 이름을 달리 |
| D13 | 쓰이지 않는 i18n 키 (C) | `ko.ts:376-382, :399, :403-404, :414, :426` (en 같은 키) | 혼동만 | p37 문구를 만들 때 정리(선택) |
| D14 | "바람 멈춰"의 뜻이 둘: 옛 = 속도 0 바람을 새로 추가, 35.5 = `controlEvent(stop)` (C) | `commands/RuleBasedParser.ts:529-537`; `events/wind/WindEvent.ts:75-77` | 타임라인·기록이 다름 | 명령은 `controlEvent`로 통일, 옛 시험(`RuleBasedParser.test.ts:123`)은 그대로 둠 |
| D15 | 별칭이 정규식뿐이라 열거 불가, 서로 겹침: 폭풍파 ↔ 폭풍, 폭설·snow(구현 기후 ↔ 계획 폭설), "대기"(= 기다림, 상태 문구 `inst.status.notRun`), "눈" 한 글자, 지진해일 ↔ 지진 (C) | `phenomena/types.ts:115-116`; `definitions.ts:47, :243`; `blastDefinitions.ts:42`; `climateDefinitions.ts:35`; `atmosphereDefinitions.ts:33`; `ko.ux355.ts:115` | 자동 완성·"가까운 후보"·모호성 판정 불가. 우선순위가 옛 파서 분기 순서에만 있음 | §3.9 제안 1(별칭 배열 + 정규식 일치 시험 + 우선순위 표) |
| D16 | 검색 일치 로직이 컴포넌트 안 인라인 (C) | `ui/Phenomena/DisasterLibrary.tsx:34-35`; `ui/ObjectPalette/ObjectPalette.tsx:92-99` | 재사용하려면 복사해야 함(사본 금지 위반) | 순수 함수로 추출해 셋이 공유 |
| D17 | 칸 읽기·쓰기(scale·중첩)가 UI 비공개 함수 (C) | `ui/BottomPanel/ExperimentPanel.tsx:177-189` | `energy=1.8e9` 같은 칸 대입을 명령이 못 함 | `phenomena/`로 옮겨 UI·명령 공유 |
| D18 | `ParamField.unit`은 표시 단위, 저장은 SI: 에너지 MJ/J, 속도 km/s·m/s, 출력 kW/W, 기간 분/초, %/0–1, °C/K, cm/s·m/s (C) | `phenomena/types.ts:71-73, :86-87`; `blastDefinitions.ts:50`; `impactDefinitions.ts:59`; `thermalDefinitions.ts:55-58`; `definitions.ts:110`; `climateDefinitions.ts:26-29` | §5 "칸 단위는 EventSpec 그대로" — 표의 `unit`을 그대로 쓰면 1e6배 틀림. °C는 `scale`이 아니라 `get/set`이라 기계적 환산 불가 | 정규 명령은 저장 단위. 생성기에서 `unit` + `scale` → 저장 단위 표를 만들고 °C 칸은 시험으로 고정 |
| D19 | 범위 "잘림"은 UI 숫자 칸에만. zod는 거부, 액션·저장소는 무검증, 잘못된 스펙은 실행 때 빠지고 불러오기 때 조용히 사라짐. `placement.set`에 범위 제한 없음 (C) | `ui/common/fields.tsx:54, :80, :111`; `app/actions.ts:437-448`; `world/worldStore.ts:735-745`; `phenomena/schedule.ts:58-59`; `phenomena/experimentSchema.ts:26-35`; `phenomena/catalog.ts:68-69` | §11 "기존 검증을 거치고 잘린 값은 요약에" — 거칠 "기존 잘림"이 없음. 그대로 넣으면 저장 뒤 인스턴스가 사라질 수 있음 | 공유 `clampField` + 계획 단계 `def.schema.safeParse` 필수. 잘림은 경고, 스키마 실패는 그 항목 거부 |
| D20 | 월드 밖 위치 검사는 마우스 층에만. zod 위치는 `finite`뿐, x·z 칸 ±100은 하드코딩. 지진 진앙은 지도 밖 허용 (C) | `rendering/placement/PlacementLayer.tsx:151-159`; `events/blast/blastSchema.ts:10`; `phenomena/definitions.ts:153`; `events/specs.ts:68` | `at=500,500`이 통과. 종류마다 허용 범위가 다름 | 공유 순수 함수 `insideMap(p, half)` + 종류별 정책(진앙 예외)을 `catalog`에 |
| D21 | `placeAt`이 무장된 UI 상태·토스트·선택·최근 기록에 묶임 (C) | `app/placementActions.ts:38-56, :63-75` | 명령이 부르면 UI가 바뀌고, 무장 없이는 `null` | `placeAt`에서 순수 부분(템플릿 + 위치 → 스펙/인스턴스)을 떼어 둘이 공유 → "키 제외 동일" 시험이 쉬워짐 |
| D22 | 재난 하나 = 실행 취소 한 단계(`addPhenomenon`당) (C) | `app/actions.ts:441`; `world/worldStore.ts:743-744` | 재난 N개 명령 = N단계 | 인스턴스 배열을 한 번에 `setExperiment`, 또는 §10 일괄 단계 안에서 |
| D23 | 실행 중 재난 배치는 문서를 바꾸지만 기록이 없고, 잠금 중 `undo`는 무시 → 나와도 되돌릴 수 없음. 마우스는 허용 (C) | `world/worldStore.ts:739-742, :891-893`; `app/actions.ts:364, :383` | §10 "실행 중 편집 명령 거부"와 마우스 동작이 다름. 옛 명령은 실행 중 바람 변경이 주 용도 | **결정 필요**: 실행 중 재난 명령 = 마우스와 같이 허용(기록 없음 표시) / 거부 |
| D24 | 시작 시각의 기준이 경로마다 다름 (C) | `phenomena/schedule.ts:63, :77`; `app/actions.ts:473-474, :564-566`; `app/placementActions.ts:87` | "5초 뒤"가 실행 시작 후인지 지금부터인지 | 편집 모드 = 실행 시작 후, 실행 중 = 지금부터로 정하고 요약에 표시. `runInstance`가 지연을 버리는 것은 피해 `runSimulation`에 풀린 스펙을 직접 |
| D25 | 인스턴스 id 재사용(가장 작은 빈 번호). "#3"이 `p3`인지 종류별 세 번째인지 정의 없음 (C) | `phenomena/schedule.ts:93-98`; `simulation/SimulationController.ts:294`; `ui/BottomPanel/ExperimentPanel.tsx:94` | 결과 집합·"화재 #3"이 다른 재난을 가리킬 수 있음 | `#p3` = id로 고정, 종류 + 순번은 모호하면 고르게. 결과 집합은 실행 취소 때 비움 |
| D26 | 단일 상태가 셋: 전역 바람, 지도 전체 비, **같은 변의 수위 상승**. 문서에 두 개 넣는 것은 안 막음 (C) | `events/wind/WindEvent.ts:22`; `events/flood/WaterEvents.ts:31, :83`; `events/EventScheduler.ts:113-120` | §11 "비 두 개는 대신함을 알림" — 수위 상승이 빠져 있음 | 계획 단계에서 같은 채널의 켜진 인스턴스를 찾아 경고(채널 규칙을 순수 함수로) |
| D27 | 비·기후: 라이브러리 클릭은 항상 원형(30 m / 40 m), 옛 명령·"현상 추가"는 지도 전체 (C) | `phenomena/catalog.ts:100-102, :108-110`; `phenomena/definitions.ts:106`; `ui/BottomPanel/ExperimentPanel.tsx:123` | "비 내려"의 범위가 경로마다 다름 | `at=` 있으면 원형, 없으면 전체로 정하고 요약에 표시 |
| D28 | 전역 중력·균일 대기에 위치를 주면 `placement.set`이 조용히 원본 반환 (C) | `phenomena/catalog.ts:199, :215, :230-231` | `at=`이 말없이 무시됨 | `placeable`이 거짓이면 "위치 없는 재난 — 위치 무시" 보고 |
| D29 | 멈출 수 없는 실행 중 재난을 지우면 계획에서만 지워지고 이번 실행은 계속 (C) | `app/placementActions.ts:115-120` | "폭발 지워"가 파면을 멈추지 못함 | 요약에 "이번 실행에는 남음" 표시 |
| D30 | 위치 칸 이름이 종류마다 다름(`position`·`center`·`target`·`epicenter`·`area.center`·`vents[0].position`·`sources[0].center`·`boundary`) (C) | `phenomena/catalog.ts:93-216` | 칸 이름으로 위치를 넣으면 종류마다 분기 | 위치는 `placement.set`만. 수위 상승은 변 이름(N/E/S/W)으로 |
| D31 | `CATALOG`·제어 지원 표가 `__ds`에 없음 (C) | `app/devtools.ts:114-160` | Chrome S11·S12에서 기대값을 읽을 곳이 부족 | `__ds.command`(계획·어휘) 추가 때 같이 노출 |
| D32 | 표시 이름이 겹침: "주택"(상자) ↔ "소형 주택 (목조)", "오피스 빌딩" 둘, "2차로 도로"(팔레트 ↔ 도로 프리셋), "강 유역"·"숲" (C) | `objects/palette.ts:43-49`; `ko.ts:106-107, :440`; `ko.building.ts:254, :256`; `ko.roads.ts:24`; `ko.nature.ts:180`; `ko.blueprints.ts:294, :298` | "2층 주택 세 채"가 상자 건물인지 부재 모델인지 | 우선순위 규칙(모듈식 > 상자)을 어휘 시험에 명시, 요약에 프리셋 id 표시. **결정 필요** |
| D33 | 객체 별칭·괄호 정리 없음: "집"·"차"·"빌딩", 라벨에 "(목조)"·"(200 L)"·"(반지름 0.3 m)" (C) | `ui/ObjectPalette/ObjectPalette.tsx:97`; `ko.building.ts:254-259`; `ko.dynamicObjects.ts:13, :21-23` | 흔한 말로 종류를 못 찾음 | §3.9 제안 2·3 |
| D34 | 층수를 바꿔 놓는 경로가 팔레트에 없음. `presetDesign(preset, floors)`가 도시 생성기 파일에 있음 (C) | `editor/build/itemDesign.ts:15-26`; `roads/city.ts:158-167` | `floors=N` 배치가 UI와 공유할 함수가 엉뚱한 곳에 | `buildings/`로 옮겨 공유, `validateSpec`으로 검사(오류는 거부) |
| D35 | 상자 건물과 모듈식의 한계가 다름: 층수 1–30 ↔ 1–40, 폭 4–40 ↔ 3–60 (C). 상자 쪽 한계가 저장소에서 강제되는지 미확인 (S) | `objects/definitions/building.ts:74-77`; `buildings/spec.ts:13-17` | 같은 "35층"이 한쪽만 됨 | 종류를 정한 뒤 그 종류의 한계로 검사, 요약에 표시 |
| D36 | 한 개 놓기의 조립이 `PlaceTool` 컴포넌트 안, 시드는 `Math.random` (C) | `editor/tools/PlaceTool.tsx:63, :66, :71-83, :109-152` | 명령이 재사용할 함수 없음, 결정론 없음 | `snapPoint` + `planPlacement` 조합을 순수 함수로 만들고 `PlaceTool`도 그것을 쓰게 |
| D37 | 객체 id·그룹 id가 무작위, `seed` 기본값도 무작위. `CreateObjectInput`에 id 칸 없음. 지문은 id를 포함 (C) | `core/id.ts:3-10`; `world/WorldDocument.ts:43-59, :70`; `app/buildActions.ts:246`; `world/fingerprint.ts:9-10` | §15·S22 "같은 스크립트 → 같은 결과 문서 해시" 불가. 계획 해시는 가능(id 이전 단계) | 계획 해시와 문서 해시를 구분: 문서 비교는 id를 정규화한 지문(순수 함수 추가)으로, 시드는 항상 명시 |
| D38 | 놓인 객체에서 팔레트 프리셋을 되찾을 수 없음(모듈식 건물의 `building.preset`만 있음) (C) | `core/model.ts:69-109`; `buildings/types.ts:141-149` | `type:sign:signal`, "가드레일 전부" 같은 선택은 매개변수 추정 | `paletteItemOf(obj)`(매개변수 일치) 순수 함수 + 못 맞추면 종류까지만. 새 문서 칸은 두지 않음 |
| D39 | "나무" 매개변수가 세 벌(팔레트·숲·가로수) (C) | `objects/palette.ts:54-57`; `app/natureActions.ts` `planForest`(:265-299); `roads/city.ts:299` | "나무 3그루"와 "숲"의 나무가 다름 | 명령마다 출처를 정하고 문서화(나무 = 팔레트, 숲 = `planForest`) |
| D40 | 도로 프리셋 표가 셋, "2차로"가 세 프리셋에 해당, 팔레트 ↔ 프리셋 대응이 `PlaceTool` 안 조건식 (C) | `roads/types.ts:118-127`; `roads/crossSection.ts:57-65`; `objects/palette.ts:102-104`; `editor/tools/PlaceTool.tsx:138-141` | `road … preset=`의 이름·"2차로 도로" 해석 | 정규 이름 = `PROFILE_PRESETS` 키. "2차로" = `street` 기본, 좁은·넓은은 수식어 |
| D41 | 프리셋 적용 액션에 `window.confirm` (C) | `app/actions.ts:152, :158, :177, :196, :218, :238, :264, :283, :306`; `app/natureActions.ts:317` | 명령에서 부르면 대화상자에 막힘 | 순수 빌더·저장소 메서드를 쓰고 확인은 명령창의 미리보기로 |
| D42 | 단위 명사 표가 없음. UI 문구는 "동", 명세 예문은 "채" (C) | `ko.nature.ts:115, :139`; `ko.humanUi.ts:107`; `ko.vehicleUi.ts:210` | "세 채"·"세 동"·"세 개" | 범주별 표(§3.9 제안 2), 둘 다 받고 종류와 안 맞는 단위 명사는 무시하지 말고 후보 제시 |

---

## 5. 구현 전에 정할 것 (이 부록에서 나온 것만)

| 항목 | 선택지 | 임시안 |
|---|---|---|
| 옛 재난 문장의 Enter (D2) | 즉시 실행 유지 / 미리보기 → 확정으로 바꾸고 옛 스크립트 기대값 변경 | 유지: "배치 + 지금 실행" 한 단계, 요약 표시 |
| 실행 중 재난 명령 (D23) | 마우스처럼 허용 / 거부 | 허용하되 "실행 취소 기록 없음" 표시 |
| 같은 이름의 종류 (D32) | 모듈식 우선 / 묻기 | 모듈식 우선, 요약에 프리셋 id |
| 옛 모듈 처리 (§1.12) | (a) 확장 / (b) 새 모듈 + 재사용 / (c) 병존 | (b) |
| 문서 해시의 id (D37) | id 정규화 지문 / 결정론적 id 주입 | 정규화 지문(저장 형식·id 생성 불변) |
