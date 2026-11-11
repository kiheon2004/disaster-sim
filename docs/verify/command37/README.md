# Phase 37 — `verify-command37` · `look-command37` 자료 (빌드 `4ed406c`, 2026-11-11)

- `verify-command37-{ko,en}.log`, `results-{ko,en}.json`: S1–S22 검사 85개, 한국어 85/85 · 영어 85/85.
- `shots/`: 검사가 찍은 화면. `look/`: 사람이 볼 화면 19장 × 한·영(`scripts/look-command37.mjs`).
  스크립트는 PNG로 쓰고, 저장소에는 크기를 줄이려 JPEG(품질 78)로 바꿔 넣었습니다.
- `heap-probe-saveload.txt`: 저장/불러오기 1200회 힙 조사(`scripts/probe-selection-heap.mjs`, 보고서 §17).
