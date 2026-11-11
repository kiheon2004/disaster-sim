/** Phase 37 자연어 파서: 빠진 칸 질문, "이해하지 못함" 사유, 후보 제시. */
import type { enP37Nl } from './en.p37nl';

export const koP37Nl: Record<keyof typeof enP37Nl, string> = {
  // 한 가지가 빠졌습니다 — 알려 주기 전에는 아무것도 실행하지 않습니다.
  'cmd37.nl.ask.direction': '어느 쪽으로요? 방위(동·서·남·북, 위·아래)나 옮길 위치를 말해 주세요.',
  'cmd37.nl.ask.amount': '얼마나요? 숫자와 단위를 함께 적어 주세요(5 m, 30도, 2배).',
  'cmd37.nl.ask.target': '어느 것을 기준으로 할까요? (첫 번째 것, #id, 가장 큰 건물 …)',
  'cmd37.nl.ask.kind': '무엇을 놓을까요? (주택, 나무, 차 …)',
  'cmd37.nl.ask.name': '이름을 따옴표 안에 적어 주세요: \'북쪽 블록\'.',
  'cmd37.nl.ask.field': '그 값이 어느 칸의 값인가요? 칸 이름이나 단위를 적어 주세요(에너지 1.8e9 J, 규모 7, x 10).',
  'cmd37.nl.ask.axis': '어느 쪽을 맞출까요? (서쪽·동쪽·북쪽·남쪽, 앞쪽, 뒤쪽, 가운데)',
  'cmd37.nl.ask.place': '어디에요? (여기, n4, (40, 60), 교차로, 언덕 …)',
  // 이해하지 못했습니다 — 아무것도 실행하지 않습니다.
  'cmd37.nl.unknown.empty': '실행할 내용이 없습니다.',
  'cmd37.nl.unknown.words': '이해하지 못한 말: {words}. 아무것도 바꾸지 않았습니다.',
  'cmd37.nl.unknown.sentence': '낱말은 알지만 실행할 수 있는 명령이 아닙니다. 아무것도 바꾸지 않았습니다.',
  'cmd37.nl.unknown.negation': '"…지 마", "빼고", "말고"가 들어간 문장은 실행하지 않습니다. 할 일을 말해 주세요.',
  'cmd37.nl.unknown.conditional': '조건·반복("…면", "…초마다", "…때까지")은 지원하지 않습니다.',
  'cmd37.nl.unknown.canonical': '올바른 명령이 아닙니다: {detail}',
  'cmd37.nl.unknown.twoKinds': '명령 하나에는 종류 하나만 쓸 수 있습니다(나무와 차는 두 번에 나누어).',
  'cmd37.nl.unknown.twoTargets': '대상이 둘 이상입니다.',
  'cmd37.nl.unknown.facing': '방위로 바라보게 하는 것은 지원하지 않습니다 — 방향을 각도로 적어 주세요(방향 90도).',
  'cmd37.nl.unknown.specificGap': '정해진 간격으로 다시 벌릴 수는 없습니다 — 놓을 때 간격을 적거나, 같은 간격으로 나누어 주세요.',
  'cmd37.nl.unknown.floors': '층수는 건물에만 쓸 수 있습니다.',
  'cmd37.nl.unknown.direction': '여기서는 그 방향을 쓸 수 없습니다 — 동·서·남·북으로 적어 주세요.',
  'cmd37.nl.unknown.raiseTo': '어느 높이"까지" 올리거나 내리는 것은 지원하지 않습니다 — 올릴 양을 적거나(2 m 올려), 그 높이로 평탄화하세요.',
  'cmd37.nl.unknown.unwritable': '이해했지만 명령으로 적을 수 없습니다: {detail}',
  'cmd37.nl.unknown.provider': '언어 모델의 답이 올바른 명령이 아닙니다({detail}). 아무것도 바꾸지 않았습니다.',
  // 이해한 명령과 함께 보여 주는 메모.
  'cmd37.nl.note.legacy': '이전 재난 문법으로 읽었습니다: 놓고 바로 시작하며, 기본 설정을 모두 적었습니다.',
  'cmd37.nl.note.provider': '언어 모델이 읽었고, 명령 문법으로 검사했습니다.',
  'cmd37.nl.note.afterUnresolved': '기준이 되는 {type}이(가) 이 문장에 없어 지금부터 {s}초 뒤에 시작합니다.',
};
