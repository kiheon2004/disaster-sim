/** Phase 37: Phase 36 잔여(다중 인스펙터 공통 칸, 아웃라이너). */
import type { enP37Left } from './en.p37left';

export const koP37Left: Record<keyof typeof enP37Left, string> = {
  'p37left.common': '모두 같은 값으로',
  'p37left.common.note': '값을 입력하면 선택한 모든 객체에 들어갑니다(실행 취소 한 단계). — = 객체마다 값이 다름. X·Z를 바꾸면 지면에 서 있던 객체는 새 자리의 지면에 앉고, 떠 있던 객체는 높이를 유지합니다.',
  'p37left.common.x': 'X (m)',
  'p37left.common.y': 'Y (m)',
  'p37left.common.z': 'Z (m)',
  'p37left.common.heading': 'Y 방향 (°)',
  'p37left.common.scale': '크기 (배)',
  'p37left.common.lift': '지면 위 높이',
  'p37left.common.mixed': '—',
  'p37left.common.mixed.title': '선택한 객체들의 값이 서로 다릅니다',
  'p37left.outliner.keys': 'Shift+클릭 = 범위 · Ctrl/⌘+클릭 = 추가/제외 · ↑ ↓ = 이동(Shift = 범위 늘리기)',
  'p37left.outliner.keys.title': 'Shift+클릭은 마지막으로 누른 줄부터 이 줄까지, 목록에 보이는 순서대로 모두 선택합니다(Ctrl/⌘+Shift = 그 범위를 선택에 더함). ↑ / ↓ / Home / End는 목록에 키보드 초점이 있을 때 움직입니다. 3D 화면에서는 Shift+클릭이 객체 하나를 추가/제외합니다.',
  'p37left.stamp.busy': '끌기나 브러시 획을 먼저 끝내세요 — 아무것도 복사하지 않았습니다(차의 설정이 같은 실행 취소 단계로 함께 복사됩니다).',
  'p37left.common.keptSize': '모듈식 건물 {count}채는 크기를 유지했습니다(치수는 설계 매개변수 — 건물 탭에서 바꾸세요).',
};
