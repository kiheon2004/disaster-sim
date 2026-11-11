# Phase 37 — 기존 Chrome 스크립트 회귀 (빌드 `4ed406c`, 2026-11-11)

- `lanes.log`: 25개 스크립트 × 한·영 한 번에 하나씩 돌린 요약(끝에 `verify-command37`·`look-command37`과 재실행).
- `verify-gravity-en.log`: 재실행(57/57). 첫 실행은 14번이 부하 탓에 실패(`lanes.log` 16:36 줄).
- `verify-celestial-ko.log`: 다섯 번째 실행(62/62, 21:10). `run1`·`run2` = 46번(1000동 프레임률) 9.8 FPS 실패(부하 60–90),
  `run3-crash`·`run4-crash` = 부하 150–190에서 헤드리스 Chrome이 닫혀 중단.
- `celestial46-ab-p37-vs-p36.log`: 46번만 떼어 Phase 37 빌드(:4371)와 Phase 36 빌드 `cb3be20`(:4372)을 번갈아 잰 값
  (`meanFrameMs` = 180프레임 평균 × 3). 설명은 `docs/COMMAND_EDITOR.md` §23.
