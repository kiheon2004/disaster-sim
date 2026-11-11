/** Phase 36(고급 월드 에디터) 한국어 문자열. */
import type { enP36Editor } from './en.p36editor';

export const koP36Editor: Record<keyof typeof enP36Editor, string> = {
  'ed36.pos': '위치 (m)',
  'ed36.rot': '회전 (°) — X 기울기 · Y 방향 · Z 기울기',
  'ed36.scale': '크기 (배)',
  'ed36.hag': '지면 위 높이',
  'ed36.hag.hint': '0 = 이 X·Z에서 지면에 서 있음(배치와 같은 앉힘 규칙).',
  'ed36.drop': '지면에 놓기',
  'ed36.drop.title': '이 자리의 지면에 놓습니다(높이, 경사면에서는 기울기). 방향은 유지합니다.',
  'ed36.alignSlope': '경사 따르기',
  'ed36.alignSlope.hint': '켬: 바닥면 아래 지면을 따라 기울어짐. 끔: 똑바로 섬.',
  'ed36.clamped': '월드 안으로 제한했습니다: {axes}가 지도·고도 범위를 넘었습니다.',
  'ed36.rejected': '숫자가 아닙니다: {axes}는 바꾸지 않았습니다.',
  'ed36.lockedSkipped': '잠긴 객체 {count}개는 그대로 두었습니다(옮기거나 지우려면 잠금을 푸세요).',
  'ed36.autosave.failed': '자동 저장 실패 — 브라우저가 저장을 거부했습니다(저장 공간 부족?). 프로젝트를 파일로 내보내 두세요.',
  'ed36.autosave.large': '자동 저장하기에 큰 월드입니다({mb} MB). 안전하게 파일로 내보내 두세요.',
  'ed36.autosave.unreadable': '마지막 자동 저장을 열 수 없어 백업해 두었습니다 — ⋯ 메뉴 → "읽지 못한 자동 저장 내보내기". 지금은 샘플 월드가 열려 있습니다.',
  'ed36.autosave.unreadableNoBackup': '마지막 자동 저장을 열 수 없고 백업도 못 했습니다(저장 공간 부족). 편집하기 전에 브라우저 저장소에서 내보내세요.',
  'ed36.exportBackup': '읽지 못한 자동 저장 내보내기',
};
