/**
 * Korean (default) dictionary. This file defines the canonical set of keys;
 * every other locale must provide the same keys (enforced by the type system).
 */
export const ko = {
  // App
  'app.title': '재난 시뮬레이션 샌드박스',
  'app.untitled': '이름 없는 프로젝트',
  'app.loadingPhysics': '물리 엔진 초기화 중…',

  // Top bar
  'topbar.projectName': '프로젝트 이름',
  'topbar.save': '저장',
  'topbar.load': '불러오기',
  'topbar.more': '더보기',
  'topbar.new': '새 프로젝트',
  'topbar.sample': '샘플 도시 불러오기',
  'topbar.export': '파일로 내보내기 (.json)',
  'topbar.import': '파일에서 가져오기 (.json)',
  'topbar.undo': '실행 취소 (Ctrl+Z)',
  'topbar.redo': '다시 실행 (Ctrl+Shift+Z)',
  'topbar.help': '도움말 및 단축키',
  'topbar.language': '언어',
  'topbar.languageToggle': 'Switch to English',

  // Modes
  'mode.editor': '편집 모드',
  'mode.simulation': '시뮬레이션 모드',
  'mode.editorShort': 'EDITOR',
  'mode.simulationShort': 'SIMULATION',

  // Panels
  'panel.objects': '오브젝트',
  'panel.inspector': '인스펙터',
  'panel.command': '명령',
  'panel.wind': '바람 설정',
  'panel.timeline': '타임라인',

  // Categories
  'category.environment': '환경',
  'category.buildings': '건물',
  'category.nature': '자연',
  'category.vehicles': '차량',
  'category.people': '사람',
  'category.infrastructure': '인프라',

  // Viewport
  'viewport.hint.camera': '좌클릭 드래그: 회전 · 우클릭 드래그: 이동 · 휠: 확대/축소',
  'viewport.compass.n': 'N',
  'viewport.compass.e': 'E',
  'viewport.compass.s': 'S',
  'viewport.compass.w': 'W',

  // Generic
  'common.close': '닫기',
  'common.cancel': '취소',
  'common.confirm': '확인',
  'common.comingSoon': '준비 중',
  'common.on': '켜짐',
  'common.off': '꺼짐',
  'common.none': '없음',
} as const;

export type MessageKey = keyof typeof ko;
