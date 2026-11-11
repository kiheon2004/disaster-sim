# Corpus — open questions (Phase 37 §6)

Sentences the corpus author could not give an expectation for from `NL-CONVENTIONS.md` alone. None of them is in the
corpus (no guessed answers). Each needs a rule; then the sentence can be added with a hand-written expectation.
Section B lists expectations that ARE in the corpus but rest on combining two rules (no example of their own in the
conventions) — veto any of them and the case is removed.

## A. Not decided by the conventions (left out)

| # | Sentence | Question |
|---|---|---|
| A1 | 규모 7 지진을 발생시켜 · make an earthquake · generate a magnitude 6.5 earthquake | §5 legacy form: "earthquake = `duration magnitude pga` (only those the type resolves)". Which fields are written when only the magnitude is said — the definition's defaults (`duration=25 pga=0.3`), or nothing because the type resolves them? No earthquake + run-verb sentence is in the corpus. |
| A2 | 여기에 규모 7 지진을 일으켜 · 중앙에 초당 5세제곱미터의 물을 공급해줘 | Legacy run-now sentence WITH a position (or a start time): is `at=` / `start=` written next to "every basic field"? And 공급해 is not in the run-verb list. |
| A3 | 선택한 것 모두 높이 0.5 m 올려 (specification §1) | "선택한 것 모두": `selection` (모두 only stresses it) or `all`? Proposed: `move selection by=0,0.5,0`. |
| A4 | 큰길 양쪽에 주택 세 채 · three houses on both sides of the main road | Two commands — each with `count=3`, or three in all? (The corpus has both-sides sentences without a count only.) |
| A5 | 여기에 다섯 대 놓아 · 세 그루 심어 | A counter with no kind word ("counters also hint the kind"): `place car count=5 at=cursor` / `place tree count=3`, or `ask kind`? (The corpus asks `kind` only with 개 / no counter.) |
| A6 | 숲을 만들어 · plant a forest · 숲, 밀도 낮게 | `forest` needs an area and none is said: `ask` — with which slot (`place`?) — or `unknown`? |
| A7 | 여기를 평평하게 · 땅을 2 m 올려 · flatten here | §3.9 says 여기를 / 땅을 is GROUND, but an area needs a radius / rectangle. `ask amount`? `ask place`? A default radius? |
| A8 | 여기 반경 10 m를 3 m로 올려 · raise it to 3 m | A height to raise / lower TO: the grammar has `to=` for flatten only. `unknown`? |
| A9 | 같은 구조로 · copy the structure · 첫 번째 건물이랑 같게 | `copy` with no reference (→ `ask target`?) or with no property (→ `ask field`?). |
| A10 | #building_ab12처럼 같은 크기로 · 첫 번째 건물이랑 같은 방향으로 · give them the same heading as #b1 | §3.5 (`match … scale to=#id`) and §3.6 (`copy scale from=#id to=selection`) both fit when the property is heading / scale and a reference is named. Which wins? (The corpus uses height for match-with-reference and structure / params / physics, lists, or the verb "copy" for copy.) |
| A11 | 선택한 것 n4로 이동 · 이것 북쪽으로 3 m 이동 | 이동 with an object target: §3.12 lists "로 이동 (camera)", §3.4 only shows 옮겨. Move, or camera? (The corpus uses 이동 only as the camera verb with a place and no target.) |
| A12 | 그것 n4의 남쪽으로 옮겨 · move it to the south of n4 | Place `south(node:n4)` + move-to, or "a direction without a distance" → `ask amount`? |
| A13 | 구간 s2에 차 세 대 · three cars on segment s2 | §2.4 reads "구간 s2 / segment s2" as a point (`at=seg:s2@0.5`), §2.5 as a road (`along=seg:s2`). In `place`, which? (The corpus uses "s2 도로 / road s2" for along and "구간 s2 / segment s2" only where a point is needed.) |
| A14 | put a tree there | "there" alone: `view` (pointing) or `last` (back there)? |
| A15 | 지진 취소 · cancel the fire | "취소 with a disaster word is not undo" — then what: `disaster earthquake delete`, `stop`, or `unknown`? |
| A16 | 다시 시작 · 계속 · resume · continue (no disaster word) | Resume the whole simulation (`run`)? `reset` (다시 시작 ≈ restart)? `unknown`? |
| A17 | 전부 멈춰 · stop everything | `pause`, or `disaster all stop` ("everything with a disaster verb object")? |
| A18 | 중력 0.5 g · gravity 0.5 g | "`<n>` g (×9.81)… only m/s² is accepted": `ask field`, or `magnitude=4.905`? |
| A19 | 언덕에 소나무 숲 · a pine forest on the hill | The grammar's `forest` has no species. Drop the species, or `unknown`? |
| A20 | 나무 지워 · delete tree · 건물 잠가 | A bare kind noun (no 전부 / 들 / 다 / all / the …s, no filter) as the target of an editing verb: `type:tree` (every tree)? The corpus uses bare kinds only in queries and with a filter / rank, as the conventions' own examples do. |
| A21 | 화재 보여 줘 · 큰길 보여 줘 · 도로 지워 | A placed disaster or a road as a camera / delete target: no target or place form exists for them. |
| A22 | 도로 만들어 · 6차로 도로 n1에서 n2까지 | A road with no end at all (two missing pieces — `ask place` or `unknown`?) and a lane count that is not a preset. |
| A23 | 선택한 것 동쪽으로 옮기고 30도 회전 | Several clauses, one of them missing a piece: is the whole sentence `ask amount`? |
| A24 | 선택한 것 동쪽으로 5 옮겨 · 30 회전 | A number with no unit: §0 says "`ask` / `unknown`" — which, and which slot? |
| A25 | N4로 가 · select #Building_AB12 | §1: case never changes the meaning — are ids lower-cased (`node:n4`), or kept as typed? |
| A26 | 건물 몇 채야? 가새 경고 있는 건물은? (specification §6, one line) | Is "?" a clause separator (two queries), like `,` and `;`? The corpus has the two questions as separate sentences. |
| A27 | 복사해서 … (§3.7) | Which continuations are meant ("복사해서 동쪽에 놓아"?), and is the result `duplicate` alone? |
| A28 | show hidden | The phrase is listed as a verb form of `show <target>`: with nothing else, `show it` or `show all where hidden`? (The corpus has "show everything hidden again" → `show all where hidden`.) |
| A29 | 여기 반경 5 m 눈으로 칠해 | A ground name that is not in the list: `unknown`, or `ask field`? |
| A30 | 교차로에 바람 30 m/s · rain at the junction | `at=` on a map-wide disaster (wind) — written and ignored later, or left out? |

## B. In the corpus, by combining rules (no example of their own)

| # | Sentence → expectation | Rules combined |
|---|---|---|
| B1 | 여기에 세 개 놓아 · put three here → `ask kind` | §0 (place cannot be written without a kind; the slot list has `kind`) |
| B2 | 선택한 것 10으로 설정해 · set the selection to 10 → `ask field` | §0 ("`set` a field + value") |
| B3 | 더 빠르게 · faster → `ask amount` | §5 (relative amounts the grammar cannot write) applied to speed |
| B4 | p3 옮겨 · move p3 → `ask place` | §0 + §3.11 (`disaster <instance> move` needs `to=`) |
| B5 | 여기 반경 10 m 평평하게 하고 잔디로 칠해 → `terrain flatten circle cursor r=10` + `paint circle cursor r=10 ground=grass` | §4 (position words carry over when the later clause needs one) applied to an area |
| B6 | 주택 두 채 놓고 이름을 '쌍둥이 집'으로 → `place …` + `rename last "쌍둥이 집"` | §4 (after place: `last`) + §3.7 rename; the name merges into `group … name=` only after a group clause |
| B7 | 나무 처음 세 개 선택 · select the first three trees → `select type:tree first 3` | §2.3 limits on a kind base |
| B8 | 숨겨 · 잠금 풀어 · 숨김 해제 · 묶어 · 지워 · 복제해 (and hide / unlock / unhide / group / delete / duplicate) → `<verb> it` | §3 (a target that is not said is `it`) |
| B9 | 잠긴 것 선택 해제 → `remove all where locked` · how many are hidden? → `count all where hidden` · 숨긴 것 전부 삭제해 → `delete all where hidden` | by analogy with "숨긴 것 다시 보여 줘" → `show all where hidden` and "which have brace warnings?" → `list all where …` |
| B10 | 가장 큰 건물과 같은 구조와 크기로 · copy the structure and scale of … → `copy structure,scale …` | §3.6 ("order as said" implies a list); the `와` / `and` of the list is not a clause split (§4) |
| B11 | give them the same structure as the first one → `copy structure from=(selection first 1) to=it` | §2.3 (them = `it`) + §3.6 (`to=` is the sentence's target). The Korean twin has no target word → `to=selection`. |
| B12 | 강풍 불게 해 · unleash a gale → `disaster wind direction=E duration=60 speed=40 now` | §5 legacy form with every default from `phenomena/definitions.ts` (wind 40 m/s, E, 60 s; rain 80 mm/h, 1800 s; rising water S, 1.5 m, 0.5 m/min) |
| B13 | 남풍 72 km/h 바람 → `speed=20` | §2.2 (km/h ÷ 3.6) — values chosen so the division is exact |
| B14 | 두 번째 폭발 멈춰 · stop the second explosion → `disaster blast#2 stop` | §3.11 ("세 번째 화재 / the third fire") for another ordinal and type |
| B15 | 선택한 것에서 #building_ab12까지 거리 → `measure selection #building_ab12` | §3.13 + §2.4 (selection / last / #id as places) |
| B16 | put the selection 2 m above the ground → `set selection lift=2` | §3.4 (the phrase decides, whatever the verb) |
| B17 | 산에서 분화, 10분 동안 → `disaster volcano at=feature:mountain duration=600` | §2.2 position from "…에서" |
| B18 | 방금 만든 것 묶어서 '동쪽 줄'이라고 하고 숨겨 → `group last name=…` + `hide last` | §4 (a later clause with no target takes the earlier clause's target — here the group clause's) |

## C. What the canonical grammar cannot write (reported, not worked around)

- A forest of one species (A19); a terrain raise / lower TO a height (A8); a road or a placed disaster as a camera or
  delete target (A21).
- `place wall` (담장 · 벽 · 담 / wall): `findKind('wall')` gives the first palette wall, `wall:guardrail` — a bare "wall"
  places a guardrail, not `wall:masonry` (`kinds.ts` DEFAULT_PRESET names building only).
- `copy … to=` a group whose name has a space is written with parentheses: `to=(group:"북쪽 블록")` (the formatter wraps
  any target text with a space). The corpus follows the formatter.
- §5 lists the legacy rising-water fields as `boundary level riseRate`; the catalog's basic fields are
  `level riseRate duration`. The corpus follows the conventions.
