# Corpus — open questions (Phase 37 §6)

Sentences the corpus author could not give an expectation for from `NL-CONVENTIONS.md` alone are listed here instead
of being guessed. The 30 questions of the first round were decided on 2026-11-11 (`NL-CONVENTIONS.md` §6, D1–D30) and
are now cases in the corpus; section 1 keeps the short record. Section 2 is the second round (N1–N5 → D31–D35), also decided. Section 3 lists expectations that ARE in the corpus but rest on combining two rules. Section 4 is what the
canonical grammar cannot write.

## 1. Decided (A1–A30 → D1–D30) — now in the corpus

| # | Example sentence | Outcome (rule D#) | Class file |
|---|---|---|---|
| D1 | 규모 7 지진을 발생시켜 · make an earthquake | legacy form with a run verb: `disaster earthquake magnitude=7 now` / `magnitude=6.5 now` (pga / duration only when said); the other four legacy types write every basic field | disaster |
| D2 | 여기에 규모 7 지진을 일으켜 · 중앙에 초당 5세제곱미터의 물을 공급해줘 | a said position / start time is written too; 공급해 / supply runs a water source: `disaster waterSource at=center duration=600 rate=5 now` | disaster |
| D3 | 선택한 것 모두 높이 0.5 m 올려 | 모두 / all after a set only stresses it: `move selection by=0,0.5,0` | transform, flags, edit |
| D4 | 큰길 양쪽에 주택 세 채 | each side gets the count (two commands, both `count=3`) | place, vehicles |
| D5 | 여기에 다섯 대 놓아 · 세 그루 심어 | a counter names no kind: `ask kind` | vehicles, nature, place |
| D6 | 숲을 만들어 · plant a forest | no area: `ask place` | nature |
| D7 | 여기를 평평하게 / 땅을 2 m 올려 | a place but no extent: `ask amount`; no place at all: `ask place` | terrain |
| D8 | 여기 반경 10 m를 3 m로 올려 · raise it to 3 m | `unknown` | terrain |
| D9 | 같은 구조로 / 첫 번째 건물이랑 같게 | no reference: `ask target`; no property: `ask field` | properties |
| D10 | #b1처럼 같은 크기로 · the same heading as #b1 | heading / scale / height + a reference, no copy verb: `match … to=`; copy is for structure / params / physics, lists, and the verb 복사 / copy | align, properties |
| D11 | 선택한 것 n4로 이동 · 이것 북쪽으로 3 m 이동 | 이동 with an object target is a move; with only a place, the camera | transform |
| D12 | 그것 n4의 남쪽으로 옮겨 | `move it to=south(node:n4)` | transform |
| D13 | 구간 s2에 차 세 대 | a segment with 에 / on: `along=seg:s2` for cars and people, `at=seg:s2@0.5` for everything else | vehicles, place |
| D14 | put a tree there | "there" alone = `view` | nature, place (en) |
| D15 | 지진 취소 · cancel the fire | `disaster <type> delete` | instance |
| D16 | 계속 · 재개 · resume · continue / 다시 시작 · restart (alone) | `run` / `reset` | run |
| D17 | 전부 멈춰 · stop everything | `pause` | run |
| D18 | 중력 0.5 g | `ask field` | disaster |
| D19 | 언덕에 소나무 숲 · a pine forest | `unknown` | nature |
| D20 | 나무 지워 · delete tree · 건물 잠가 | a bare kind noun with an editing verb = every object of the kind | edit, flags |
| D21 | 화재 보여 줘 · 큰길 보여 줘 · 도로 지워 | `unknown` ("화재 지워" stays `disaster fire delete`) | camera, edit |
| D22 | 도로 만들어 / 6차로 도로 n1에서 n2까지 | `ask place` / `unknown` | road |
| D23 | 선택한 것 동쪽으로 옮기고 30도 회전 | the whole sentence is the `ask` of the incomplete clause | mixed |
| D24 | 선택한 것 동쪽으로 5 옮겨 · 30 회전 | a number with no unit where one is needed: `ask amount` | transform |
| D25 | N4로 가 · select #Building_AB12 | node / segment / instance ids lower-case; object ids as typed | camera, select, vehicles, road, instance, edit |
| D26 | 건물 몇 채야? 가새 경고 있는 건물은? | `?` separates clauses: two queries | query |
| D27 | 복사해서 동쪽에 10 m 놓아 / 복사해 | `duplicate it offset=10,0` / `duplicate it` | edit |
| D28 | show hidden | `show all where hidden` | flags |
| D29 | 여기 반경 5 m 눈으로 칠해 | `unknown` | terrain |
| D30 | 교차로에 바람 30 m/s · rain at the junction | a said position is written: `disaster wind at=junction speed=30` | disaster |

Checked against the 1,550 earlier cases: none contradicted a decision, no expectation was changed.

## 2. Second-round questions (N1–N5 → D31–D35) — decided 2026-11-11, now in the corpus

| # | Example sentence | Outcome (rule D#) | Class file |
|---|---|---|---|
| D31 | how many buildings? which have brace warnings? · 건물 몇 채야? 가새 경고 있는 것은? | in a sentence of several clauses, a later query clause with no kind takes the earlier clause's kind (§4): `count type:building` + `list type:building where warning=brace`; the same words alone stay `list all where warning=brace` | query |
| D32 | 여기에 숲을 만들어 · a forest here / 여기를 잔디로 칠해 · paint here with grass | a place but no extent for `forest` / `paint`: `ask amount` (as D7 for terrain) | nature, terrain |
| D33 | 나무 선택 · select tree / 나무 보여 줘 · focus on building | a bare kind noun is every object of the kind for select and the camera too: `select type:tree`, `focus type:tree` (D21 stays: a road or a placed disaster is not such a target) | select, camera |
| D34 | s2 도로에 가로등 하나 · a street light on road s2 | for everything but cars and people, a plain 에 / on with a segment id is D13 (`at=seg:s2@0.5`) whether it is called 구간 / segment or 도로 / road; a side word or 따라 / along makes it `along=seg:s2` | place |
| D35 | #building_ab12의 방향을 복사해 | 복사 / copy with a property as its object is `copy <property> from=<ref> to=selection`; 복사해 with no property stays duplicate (D27) | properties |

Nothing is open after the second round.

## 3. In the corpus, by combining rules (no example of their own)

B1–B18 were accepted as written on 2026-11-11 (§6, last paragraph); B19–B24 (second round) were accepted the same day.

| # | Sentence → expectation | Rules combined |
|---|---|---|
| B1 | 여기에 세 개 놓아 · put three here → `ask kind` | §0 (place cannot be written without a kind) |
| B2 | 선택한 것 10으로 설정해 · set the selection to 10 → `ask field` | §0 ("`set` a field + value") |
| B3 | 더 빠르게 · faster → `ask amount` | §5 (relative amounts) applied to speed |
| B4 | p3 옮겨 · move p3 → `ask place` | §0 + §3.11 (`disaster <instance> move` needs `to=`) |
| B5 | 여기 반경 10 m 평평하게 하고 잔디로 칠해 → flatten + `paint circle cursor r=10 ground=grass` | §4 (position words carry over) applied to an area |
| B6 | 주택 두 채 놓고 이름을 '쌍둥이 집'으로 → `place …` + `rename last "쌍둥이 집"` | §4 (after place: `last`) + §3.7 rename |
| B7 | 나무 처음 세 개 선택 · select the first three trees → `select type:tree first 3` | §2.3 limits on a kind base |
| B8 | 숨겨 · 잠금 풀어 · 숨김 해제 · 묶어 · 지워 · 복제해 (and the English verbs alone) → `<verb> it` | §3 (a target that is not said is `it`) |
| B9 | 잠긴 것 선택 해제 → `remove all where locked` · how many are hidden? → `count all where hidden` | by analogy with "숨긴 것 다시 보여 줘" → `show all where hidden` |
| B10 | 가장 큰 건물과 같은 구조와 크기로 · copy the structure and scale of … → `copy structure,scale …` | §3.6 ("order as said"); the list's 와 / and is not a clause split |
| B11 | give them the same structure as the first one → `copy structure from=(selection first 1) to=it` | §2.3 (them = `it`) + §3.6 (`to=` is the sentence's target) |
| B12 | 강풍 불게 해 · unleash a gale → `disaster wind direction=E duration=60 speed=40 now` | §5 / D1 with the defaults of the audit §2.3 (wind 40 m/s, E, 60 s; rain 80 mm/h, 1800 s; rising water S, 1.5 m, 0.5 m/min; water source 5 m³/s, 600 s) |
| B13 | 남풍 72 km/h 바람 → `speed=20` | §2.2 (km/h ÷ 3.6) — values chosen so the division is exact |
| B14 | 두 번째 폭발 멈춰 · stop the second explosion → `disaster blast#2 stop` | §3.11 for another ordinal and type |
| B15 | 선택한 것에서 #building_ab12까지 거리 → `measure selection #building_ab12` | §3.13 + §2.4 (selection / last / #id as places) |
| B16 | put the selection 2 m above the ground → `set selection lift=2` | §3.4 (the phrase decides, whatever the verb) |
| B17 | 산에서 분화, 10분 동안 → `disaster volcano at=feature:mountain duration=600` | §2.2 position from "…에서" |
| B18 | 방금 만든 것 묶어서 '동쪽 줄'이라고 하고 숨겨 → `group last name=…` + `hide last` | §4 (a later clause takes the earlier clause's target) |
| B19 | plant three · park five here → `ask kind` | D5: "세 그루 심어" asks although it has the tree verb AND the tree counter — a verb alone names a kind even less |
| B20 | copy it 10 m east · copy these 5 m north → `duplicate … offset=` · copy → `duplicate it` | §3.7 ("copy (them)" = duplicate; "duplicate it 10 m east") + D27 |
| B21 | 선택한 것 전부 지워 → `delete selection` · delete them all → `delete it` · hide these all → `hide selection` | D3 with the other all-words of §2.3 (전부) and with it / these as the set |
| B22 | 교차로에 풍속 30 m/s 바람을 일으켜 → `disaster wind at=junction direction=E duration=60 speed=30 now` | D1 (every basic field) + D2 / D30 (a said position is written) |
| B23 | 주택 세 채 놓고 이름 바꿔 · place three houses and rename them → `ask name` | D23 (the incomplete clause's ask) + §3.7 (rename with no quoted name) |
| B24 | s3에 창고 한 동 · a warehouse on s3 → `place building:warehouse at=seg:s3@0.5` | D13 for a bare segment id (§2.4 reads "s2" as a segment) |

## 4. What the canonical grammar cannot write (reported, not worked around)

| What | Outcome now |
|---|---|
| A forest of one species ("언덕에 소나무 숲") | `unknown` (D19) |
| Terrain raise / lower TO a height ("3 m로 올려") | `unknown` (D8) — `to=` is for flatten only |
| A road or a placed disaster as a camera / delete / hide target ("큰길 보여 줘", "화재 보여 줘", "도로 지워") | `unknown` (D21) |
| Two kinds in one target, diagonal and camera-relative moves, distribute with a given gap | `unknown` / `ask` by rule (§3.4, §3.5, §5) |
| `copy … to=` a group whose name has a space | canonical only with parentheses — `to=(group:"북쪽 블록")` (the formatter wraps any target text with a space); the corpus follows the formatter |

Fixed since the first round: a bare `wall` (담장 · 벽 · 담 / wall) is the masonry wall (`kinds.ts`, main `1e3e1e2`) — the
corpus's `place wall` lines needed no change.
Noted, not a grammar limit: §5 / D1 list the legacy rising-water fields as `boundary level riseRate`; the catalog's
basic fields are `level riseRate duration`. The corpus follows the conventions.
