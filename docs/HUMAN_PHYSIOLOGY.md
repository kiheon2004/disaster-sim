# Phase 34 — 인간 생리 반응·환경 노출·복합 재난 생존 조건 (HUMAN_PHYSIOLOGY)

기준 커밋 `816f48e`(Phase 33 최종). 이 문서는 Phase 33 확장 인체 모델 위에 얹은 축약 생리 모델의 설계·수식·검증·한계를 기록합니다.
**교육용·연구 탐색용 축약 모델입니다. 의료 진단, 사망 시각 예측, 개인별 생존 확률, 실제 사고의 의학적 재구성에 쓸 수 없습니다.**
결과의 단계 이름(예: 열 부담, 행동 불가)은 모델 상태이지 임상 진단이 아닙니다.

## 1. 개발 목적

Phase 33의 **외부 힘 → 균형 상실 → 운동 → 접촉·충돌 → 부위별 손상 위험 → 행동 능력**에 이어, 이번 단계는
**환경 상태 → 인체 노출 → 열·물·기체 교환 → 생리 상태 → 기능 저하 → 행동 능력 → 이후 노출**을 시간 적분으로 잇습니다. 세계가 이미
계산한 환경(열·화재·기후·대기·홍수)을 읽기만 하고, 없는 값은 만들어내지 않고 가정·경계 조건으로 명시합니다.

## 2. 기존 Phase 33 연결점

- `e.human`(구획 8개의 국소 기하, 자세, 서 있음, 이동 능력, 행동 불가, 매몰), `flags.captured`.
- `humanSnapshot(e)`의 구성 요소(구획 세계 위치, 이동 능력, 매몰, 물 깊이). `headSubmerged`(머리 중심 < 수면)는 기도 침수가 아니므로
  쓰지 않고, 기도 위치를 따로 근사합니다(§23).
- Phase 33은 `e.health`의 단일 소유자로 남고, 생리는 `health`를 쓰지 않습니다(§28).

## 3. 환경 시스템 감사

`docs/PHASE34_PREIMPLEMENTATION_AUDIT.md` 전문. 요약: 공기 온도는 열 모델이 돌 때만(5 m 기둥, 0–10 m 한 값, 0.1 s), 방 공기는 모듈러
건물만, 습도는 기후 실험만, 기압은 대기 실험만, O₂·매연은 화재 중만, **CO·CO₂·유해가스·평균 복사 온도·인체 접촉 온도는 어디에도 없음**,
수온은 물과 열 모델이 함께 있을 때만. 기존 시스템 중 열·연기·물로 사람의 `health`를 깎는 것은 없음 → 이중 계산 경로 없음.

## 4. 전체 아키텍처

| 층 | 위치 | 역할 |
|---|---|---|
| 파라미터 | `src/physiology/params.ts` | 모든 계수: 단위·기본값·범위·출처·수준(A/B/C)·비고 (§50) |
| 열 | `src/physiology/thermal.ts` | 2노드 체온 조절, 의복, 대류·복사·증발·물·접촉, 호흡 열 |
| 기체 | `src/physiology/gas.ts` | 몰분율·단위 변환, 흡기·폐포 O₂, ISO 13571/Purser FED |
| 엔진 | `src/physiology/engine.ts` | 사람 1명의 상태, Heun 적분, 장부, 기도 이력, 수분, 피로, 단계·히스테리시스, 능력 해석기 |
| 설정 | `src/physiology/settings.ts` | `settings.simulation.physiology`, zod, 기준값, 경계 조건 구역 |
| 샘플러 | `src/simulation/physiology/sampler.ts` | 환경 → 노출 샘플 + 출처 |
| 구역 | `src/simulation/physiology/zones.ts` | 경계 조건 구역, 밀폐 공기 구획(질량 보존) |
| 시스템 | `src/simulation/physiology/PhysiologySystem.ts` | 0.1 s마다, postPhysics 맨 끝: 샘플 → 적분 → 사건 → Phase 33 결합 계수 |
| Phase 35 | `src/simulation/physiology/interface.ts` | `physiologySnapshot(e)` 읽기 전용 |

흐름: 환경 시스템(열·화재·기후·대기·홍수·바람) → 샘플러(읽기만) → 엔진(사람별 상태) → 능력(물리 ⊕ 생리) → Phase 33 자세 제어
(발목 모멘트 비율, 서기 가능) → 결과·UI·내보내기. 환경으로 되돌려 쓰는 것은 없습니다(§41 일방향).

## 5. 데이터 모델

```ts
settings.simulation.physiology = {
  model: 'reduced',
  activity?: 'resting' | 'light' | 'moderate' | 'strenuous',   // 명시적 활동 강도 (기본 resting)
  clothing?: 'light' | 'normal' | 'insulated' | 'protective', // 기본 normal
  waterIntake?: number,            // L/h, 명시할 때만 (자동으로 마시지 않음)
  modules?: { thermal?, respiration?, gas?, submersion?, hydration?, fatigue? },  // 기본 모두 켬
  reference?: { humidity?, pressure?, o2?, co2?, waterTemperature? },            // 가정값 (사용자 변경 가능)
  people?: { [objectId]: { activity?, clothing?, waterIntake? } },
  zones?: PhysiologyZone[],        // 실험용 경계 조건 (§35)
}
```

확장 인체 모델(`humans`)이 필수입니다. `humans` 없이 `physiology`만 있는 파일은 불러올 때 `physiology`를 버리고(검증, 수정하지 않음),
UI는 생리 스위치를 켤 때 확장 모델도 켭니다. 확장 모델을 끄면 생리도 지워집니다.

사람별 런타임 상태 `e.physio`: 설정(`cfg`), 상태(`s`: 중심·피부 온도 K, 장부, 선량, FED, 기도 이력, 호흡, 단계, 능력), 샘플 출처
(`provenance`), 표시용 샘플 값, Phase 33 결합 계수, 시계열(처음 32명), 포획 시 동결 표시. 런 상태 `runtime.physiology`: 설정, 밀폐 구획.

## 6. 노출 샘플러

0.1 s마다 사람마다 한 번. 각 값의 출처(`provenance`)를 함께 기록합니다:

| 값 | 출처 순서 | 단위 |
|---|---|---|
| 공기 온도 | 방(`thermal.room`) → 공기 기둥(`thermal.air`, 높이 반영) → 층 위(`thermal.above`) → 장면 기준 온도(`scene.ambient`, 가정) | K |
| 습도 | 기후 실험(`climate`) → 기준값(`reference`, 가정) | 0–1 → 수증기압 Pa |
| 기압 | 대기 실험(`atmosphere`) → 기준값(`reference`) | Pa |
| 바람 | 국지 바람장 − 몸 속도(상대 속도) | m/s |
| 평균 복사 온도 | 기후의 하늘·지면(`climate`) → 공기 온도와 같다고 가정(`assumedAir`) | K |
| 직접 복사 | 열원(시간 형상 반영) + 화염(점원) + 태양(기후, 그늘) | W/m² |
| 물 | 홍수장(수면·유속) / 구역 물 | m, m/s |
| 수온 | 열 모델의 물(`thermal.water`) → 구역 → 기준 수온(`reference`, 가정) | K |
| 접촉 온도 | (누운 경우) 용암 표면 → 지면 열 노드 → 미지원(`unknown`) | K |
| 기체 | 화재 방(`fire.room`) / 화재 공기 기둥(`fire.air`) → 기준 공기(`reference`) / 구역 / 밀폐 구획(`confined`) / 매몰(`buriedUnknown`) | mol/mol, kg/m³ |

없는 값은 `undefined`로 남고 0으로 위조하지 않습니다(예: 매몰된 사람의 기체 → 미지원, O₂ 공급 지표 없음).

## 7. 좌표계와 노출 위치

세계 좌표 m, +y 위. 사람 국소 좌표는 Phase 33과 같음(+y 몸 축, +z 얼굴 방향). 노출 위치: **기도**(머리 축 0.90 H, 머리 반지름 × 0.85
앞 — 입·코 근사, 자세·머리 방향 반영), **몸통 중심**(대표 위치: 공기·복사·접촉), **구획 8개**(침수 비율). 공기층은 5 m 기둥의 한 값,
방은 한 노드, 물은 1 m 칸이므로 신체 부위 해상도는 그보다 정밀하지 않습니다(부분 침수·국소 노출은 근사).

## 8. 체온 모델 (수준 B)

Gagge 2노드 모델(Gagge 1971; Gagge, Fobelets & Berglund 1986)을 기반으로 하되 열용량을 고정했습니다:

$$C_c\,\frac{dT_c}{dt} = M - W - Q_{cs} - Q_{res}, \qquad C_s\,\frac{dT_s}{dt} = Q_{cs} - Q_{dry} - Q_{water} - Q_{contact} - E_{sk} + Q_{cond}$$

- \(C_c = 0.9\,m\,c\), \(C_s = 0.1\,m\,c\), \(c = 3492\) J/(kg·K). Gagge의 혈류 의존 α는 평균 체온 신호에만 쓰고 열용량은 고정 →
  에너지 \(U = C_c T_c + C_s T_s\)가 정확히 보존됩니다(수준 C 단순화).
- 중심 → 피부: \(Q_{cs} = (5.28 + 1.163\,SKBF)(T_c - T_s)\,A\), \(SKBF = (6.3 + 100\,\text{warm}_{cr})/(1 + 0.5\,\text{cold}_{sk})\), 0.5–90 L/(m²h).
- 땀: \(\text{reg}_{sw} = 170\,\text{warm}_b\,e^{\text{warm}_{sk}/10.7}\) g/(m²h) (최대 500), 떨림: \(19.4\,\text{cold}_{sk}\,\text{cold}_{cr}\) W/m²
  (최대 250, 중심 33 → 31 °C에서 0으로 줄어듦 — 가정).
- 설정점: 중심 36.8 °C, 피부 33.7 °C, 평균 36.49 °C. 체수분 부족은 설정점을 1 %당 0.15 K 올립니다(§25).
- 체표면적: DuBois \(A = 0.007184\,m^{0.425}(100H)^{0.725}\). 초기: 중심 36.8 °C, 피부 34.0 °C(교육용 기본값).

## 9. 열수지

부호: 몸에서 나가는 열이 +. 열 흐름(W)과 물 흐름(kg/s)은 `Flows` 하나로 계산하고 장부에 같은 가중치로 적분합니다:
\(\Delta U = \int (M - W - Q_{res} - (Q_{conv} + Q_{rad} - Q_{abs}) - Q_{water} - Q_{contact} - E_{sk} + Q_{cond})\,dt\). 장부 잔차는 반올림 수준입니다(§31).

## 10. 대사 열 (수준 B)

명시적 활동 강도: 휴식 1.2 met, 가벼움 2.0, 보통 3.5, 격렬 6.5(ISO 8996), 1 met = 58.15 W/m², 누운 사람 0.8 met. **수동으로 움직이는
속도(바람·물에 밀림)는 대사량으로 환산하지 않습니다.** 능력 저하·피로 한계·물리적 이동 불가에서는 실제 활동이 휴식으로 줄어듭니다.
외부 일 W = 0(기본, 효율 계수는 파라미터).

## 11. 대류 (수준 B)

공기: \(h_c = \max(3.1,\ 8.6\,v^{0.53})\) W/(m²K) (Gagge 1986, 약 0.2–4 m/s에서 검증 — 그 밖은 외삽하고 플래그). \(v\)는 공기와 몸의 상대 속도.
물: \(h_w = 230\,(1 + 2v)\) W/(m²K), 최대 1000 (정지 물 230은 Boutelier 1977의 크기 정도, 유속 의존은 가정). 공기 계수를 물에 쓰지 않습니다.

## 12. 복사 (수준 A/B)

의복 표면 온도를 균형식에서 풉니다(켈빈, 정확한 4제곱):
\((T_s - T_{cl})/R_{cl} + q_{abs} = f_{cl}\,[h_c (T_{cl} - T_a) + \varepsilon\sigma (A_r/A)(T_{cl}^4 - T_r^4)]\) — 좌변−우변이 \(T_{cl}\)에 대해
단조이므로 근이 하나(구간 보호 뉴턴, 이전 스텝 값으로 시작). ε 0.95, \(A_r/A\) 0.73(서 있음)·0.65(누움). 직접 복사(화염·열원·태양)는 투영
면적 0.25 A에 흡수율 0.8로 흡수(가정). 장면 복사(평균 복사 온도)와 직접 복사를 따로 두어 같은 화재 복사를 두 번 넣지 않습니다.

## 13. 증발 (수준 A/B)

\(E_{max} = (p_{sk,s} - p_a)/(R_{e,cl} + 1/(f_{cl} h_e))\), \(h_e = 16.5\,h_c\) (Lewis), \(R_{e,cl} = R_{cl}/(16.5\,i_{cl})\). **땀 생성과 실제 증발을
구분**: \(w_{rsw} = \min(1, E_{rsw}/E_{max})\), 증발 = \(w_{rsw} E_{max} + 0.06(1 - w_{rsw})E_{max}\), 나머지 땀은 흘러내려 냉각하지 않습니다.
증발 질량 × \(L_v\)(2.43 MJ/kg) = 증발 열(시험으로 확인). \(E_{max} < 0\)(피부보다 뜨겁고 습한 공기)이면 증발 0, 피부에 응결(열 유입).
호흡: 현열 \(0.0014\,M(34 - t_a)\), 잠열 \(0.0173\,M(5.87 - p_a)\) W/m²(ASHRAE), 잠열/\(L_v\) = 호흡 수분 손실. 기도가 잠기면 0.

## 14. 의복 (수준 B/C)

| 의복 | clo | \(i_{cl}\) | 피복률 |
|---|---|---|---|
| light | 0.3 | 0.45 | 0.4 |
| normal | 0.7 | 0.38 | 0.8 |
| insulated | 1.6 | 0.34 | 0.92 |
| protective | 2.0 | 0.20 | 0.97 |

1 clo = 0.155 m²K/W, \(f_{cl} = 1 + 0.31\,\text{clo}\) (ISO 9920 크기). 젖으면 단열이 0.2배로(가정), 물에 잠긴 부분은 완전히 젖은 의복,
마름은 30분 시간 상수(가정). **보호복도 화염을 막는다고 가정하지 않습니다**(열 저항만).

## 15. 저온 노출

피부·중심 온도 하강, 혈관 수축, 떨림(상한·약화 포함). 단계(교육용, 수준 C): 중심 36 / 35 / 32 / 30 °C 또는 평균 피부 30 / 25 °C(피부만으로는
'심한 저온 부담'까지) → `coldStress` / `severeColdStress` / `thermoregulationFailure`. 저체온증 진단 등급을 출력하지 않습니다.

## 16. 고온 노출

대사 열·흡수 열·증발 냉각·중심 상승·수분 손실. 습도가 높으면 \(E_{max}\)가 줄어 땀이 흘러내리고 중심이 더 오릅니다(시험). 단계: 중심
38 / 39 / 40 / 41 °C → `heatStress` / `severeHeatStress` / `thermoregulationFailure`(ISO 7933의 38 °C 한계를 기준점으로 한 교육용 경계).

## 17. 화재 열 노출

공기 온도(열 모델 기둥·방), 직접 복사(화염 점원 \(q = \chi_r Q/(4\pi r^2)\), \(\chi_r = 0.35\)), 접촉(누운 경우), 연기·기체(§21–22)를
따로 다룹니다. 조직 열 부담은 **열 선량** \(\int q^{4/3} dt\) ((kW/m²)^{4/3}·s, 1.7 kW/m² 이상)과 ISO 13571 형태의 열 FED
(대류 60 °C 이상: \(t = 5\cdot10^7\,T^{-3.4}\) min, 복사: \(t = r/q^{4/3}\), r = 6.9 — 값 불확실, 수준 C)로만 나타냅니다.
화상 깊이·면적·임상 등급은 판정하지 않습니다.

## 18. 호흡 (수준 B)

산소 섭취 \(\dot V_{O_2} = M / 20.2\) kJ/L(STPD, RQ 0.85), CO₂ = RQ × O₂, 환기 요구 = 25 L/L × \(\dot V_{O_2}\), 호흡 부담 = 요구 / 최대 환기
120 L/min(가정). 기도가 잠기면 실제 환기 0, 그동안의 O₂ 소비는 몸 저장분에서(장부 `o2Debt`). 혈중 산소포화도는 예측하지 않습니다.

## 19. 산소 (수준 A/B)

흡기 \(P_{IO_2} = x_{O_2}(p - 6.27\,\text{kPa})\), 폐포 \(P_{AO_2} = P_{IO_2} - P_{ACO_2}/RQ\), \(P_{ACO_2} = 5.33\) kPa + 흡기 CO₂(가정).
**O₂ 공급 지표** = \(P_{AO_2}/P_{AO_2,\text{ref}}\)(해수면 기준 공기). 저압과 저산소를 같은 흡기 분압으로 다룹니다(등가 O₂ % = 해수면에서 같은
\(P_{IO_2}\)의 %). 기압만으로 조성을 안다고 주장하지 않습니다 — 조성은 기준값(가정)이거나 화재·구역·구획에서 옵니다.

## 20. CO₂

흡기 CO₂(구역·화재 O₂ 결손에서 1:1·밀폐 구획). Purser CO₂ FED는 5 % 초과에서만, CO 흡수 가속 \(e^{\%CO_2/5}\). 밀폐 공간 CO₂ 증가는 **부피와
환기율이 주어진 구획에서만**(§31), 그 밖에서는 만들지 않습니다.

## 21. 연기

화재 매연 농도(kg/m³, 실외 5 m 기둥·방). 선량 \(\int C dt\)과 흡입량 \(\int C\,\dot V_E\,dt\)(침착 30 %, 가정)을 구분합니다. 렌더링 입자는
쓰지 않습니다. 자극성 효과는 화학종이 없어 계산하지 않습니다(노출량만).

## 22. CO (수준 B/C)

화재 런: 매연과 함께 운반된다고 보고 CO 질량 농도 = 매연 × 0.27(환기 양호 목재 수율비 0.004/0.015, Tewarson) → 몰분율. **환기 부족 화재는
CO 수율이 훨씬 커서 과소 추정**(잔여 문제). 구역으로 명시 농도를 줄 수 있음. 선량 ppm·min과 ISO 13571 FED(35 000 ppm·min = 1, CO₂ 가속).
CO 중독을 진단하지 않으며 FED는 회복이 없는 누적 지표입니다(체내 제거 모델 없음).

## 23. 침수와 기도

기도 위치(§7)와 그 자리의 수면을 비교: `clear` / `intermittent`(10 s 안에 잠김 시작 2회 이상) / `submerged`(2 s 이상 연속, 또는 막 잠김) /
`unknown`(매몰 — 정보 없음). 기록: 첫 침수 시각, 누적·연속·최장 시간, 잠김·복귀 횟수. 숨 참기 여력: 잠긴 동안 \(dt/60\) s(15 °C 미만 물은 2배,
가정)씩 쓰고 숨 쉬면 30 s 시간 상수로 회복. 이 값은 노출 지표이며 익사 시간 예측이 아닙니다.

## 24. 수중 열손실

잠긴 구획 면적 비율(구획 세로 범위 대 수면) × 물 대류 + 젖은 의복 저항, 수온은 §6. 잠긴 피부는 증발·복사 없음. 공기 대류 계수를 물에
쓰지 않습니다.

## 25. 수분 (수준 B/C)

총 체수분 0.6 m(일반 성인). 손실 = 생성된 땀(증발 + 흘러내림) + 피부 확산 + 호흡. 섭취는 명시할 때만. 부족 % 체중 → 중심 설정점 +0.15 K/%
(Sawka; Montain & Coyle), 땀 민감도 1/(1 + 0.1(부족 − 1))(가정). 단계 2 / 4 / 6 / 10 %.

## 26. 피로 (수준 C)

상대 강도 \(r = M_{act}/(M_{max}\,c)\), \(c\) = 열(38 °C 초과 1 K당 −10 %)·수분 부족(1 %당 −2 %)·O₂ 공급으로 줄어든 능력. \(r > 0.4\)에서
쌓이고(최대 강도에서 10 min에 한계), 그 아래에서 15 min 시간 상수로 회복. 시간만으로 늘지 않습니다(휴식 1시간 피로 0, 시험).

## 27. 기능 상태

구성 요소별 단계(normal → stressed → impaired → severelyImpaired → unableToAct): 열(§15–16), 호흡(1 − O₂ 공급 지표 또는 숨 참기 여력),
기체 FED, 열 FED, 수분, 피로. 생리 능력 = 최악 구성 요소, **제한 원인 목록**을 함께 기록. 물리 능력(Phase 33: 행동 불가 → unableToAct,
이동 불가 → severelyImpaired, 이동 제한 → impaired)과 합친 최종 능력과 원인(`physical`과 생리 구성 요소를 따로). 히스테리시스: 올라갈 때는
즉시, 내려갈 때는 경계보다 여유만큼 낮은 상태가 10 s 지속돼야. 단계 경계: `THRESHOLDS`(engine.ts)와 §50 표.

## 28. Phase 33 통합

- 생리는 `e.health`·부상 지표를 쓰지 않습니다(물리 손상과 생리 부담의 중복 체력 감소 없음).
- 결합 계수(다음 스텝에 Phase 33이 읽음): 발목 모멘트 비율(stressed까지 1, impaired 0.8, severelyImpaired 0.5) → 균형 모델의 교정
  모멘트 한계에 곱함; `unableToAct` → 자세 제어 상실: 서 있으면 원인 'physiological'로 해제되고 Phase 33의 **제어된 주저앉기**(다리가
  풀림, 충격 없이 엎드림, 위치 에너지는 다리 소산으로 장부 기록)로 이어집니다. 다시 서기는 막힙니다. 강체 속도를 직접 바꾸지 않습니다.
- 생리 설정이 없으면 Phase 33 계산은 그대로입니다(계수 경로가 아예 실행되지 않음; §32).

## 29. 복합 재난

공통 상태 변수로 상호작용합니다(단순 합산 없음): 고온+습도 → \(E_{max}\) 감소; 저온+바람 → \(h_c\) 증가; 저온+침수 → 물 대류·젖은 의복;
화재+연기 → 직접 복사·공기 온도·CO·매연이 각자 경로; 연기+저산소 → CO FED는 CO₂로 가속, O₂ FED는 따로; 홍수+행동 불가 → 기도 침수;
매몰+환기 부족 → 밀폐 구획 O₂ 감소; 충돌 손상+생리 → 최종 능력에서 원인 따로; 고온+활동 → 대사·피로·수분.
결과는 `combos.sim.test.ts`(§36).

## 30. 시간 적분

생리 시스템은 0.1 s(6 물리 스텝)마다 시뮬레이션 시간으로 진행(렌더링 FPS와 무관). 2노드: Heun(2차) — 독립 시험에서 집중 냉각의 해석해와
1e−3 K 이내, 스텝 절반에 오차 ≈ 1/4. 선량: 이전 샘플과 현재 샘플의 사다리꼴(구간별 선형 노출에 정확, 시작 샘플로 초기화). 수분·피로·의복
젖음: 1차, 음수·1 초과는 막고 플래그. 시간 간격 수렴: 찬물 침수(5 °C 공기·8 °C 물, 바람 2 m/s, 10 min) — 1/960 s 기준해와의 차이:

| 간격 | 중심 |ΔT_c| | 피부 |ΔT_s| |
|---|---|---|
| 0.1 s (실행값) | 1.1·10⁻⁷ K | 3.1·10⁻⁶ K |
| 1/60 s | 1.7·10⁻⁸ K | 4.6·10⁻⁷ K |
| 1/120 s | 8.1·10⁻⁹ K | 2.2·10⁻⁷ K |
| 1/240 s | 3.5·10⁻⁹ K | 9.2·10⁻⁸ K |

오차는 1차로 줄어듭니다(절반 간격에 ≈ ½): Heun 노드 자체는 2차(§59 집중 냉각 시험에서 ≈ ¼)지만 의복 젖음·수분 같은 1차 항이 지배합니다.
크기는 실행 간격 0.1 s에서도 10⁻⁶ K 수준입니다. 단계 전환 시각(고온 45 °C·80 %, 격렬한 활동에서 열 부담 도달): 0.1 s 376.20 s, 1/60 s
376.17 s, 1/240 s 376.16 s, 1/960 s 376.16 s — 차이는 생리 간격(0.1 s) 이하입니다.

## 31. 보존 장부

사람별: 열(J) — 대사·떨림·외부 일·중심→피부·호흡 현열·잠열·대류·복사·흡수·물·접촉·증발·응결·잔차; 물(kg) — 땀 생성·증발·흘러내림·
호흡·섭취; 기체(mol) — O₂ 소비, CO₂ 생성, 숨 못 쉴 때의 O₂(몸 저장분). 에너지와 질량 단위를 섞지 않습니다. 밀폐 구획(mol): 사람이
가져간 O₂·내놓은 CO₂·교환 → \(\Delta n = -\text{taken} + \text{exchange}\)(시험). 환경 장부는 바꾸지 않습니다(일방향 — 사람의 열·수분·기체가
환경에 반영됐다고 주장하지 않음).

## 32. 결정론

같은 시드·초기 상태·시간 간격·환경·사건 순서 → 같은 결과(같은 실행 2회, 사람 추가 순서 뒤집기 시험). 사람마다 독립이고 밀폐 구획 흡수
합은 사람 순회 뒤에 한 번 적용. 렌더링·UI·언어·카메라·오버레이·차트는 상태를 읽기만 합니다. **생리 설정이 없는 장면은 Phase 33과 비트 동일:**
기준 `816f48e`와 Phase 34 코드 커밋 `9523afb`(고정 worktree 두 개, 같은 프로브)를 잎 단위로 비교했습니다
(시간 측정 잎만 제외, Phase 33 비교 스크립트와 같은 규칙):

| 세트 | 결과 | 비교한 잎 |
|---|---|---|
| 동일성 all (32장면, 사람 기존 모델) | 32/32 동일 | 3 561 684 |
| 동일성 p31 (20) + p31i (1) | 21/21 동일 | 1 137 746 |
| 차등 (44장면) | 44/44 동일 | 9 745 019 |
| **Phase 33 확장 인체, 생리 꺼짐** (프리셋 20종 전체 시간 + 군중 100명 폭풍·지진, 사람 상태·자세·속도·사건 전부) | 22/22 동일 | 183 625 |

즉 동일성 53/53, 차등 44/44, Phase 33 인체 22/22. `HumanSystem`·`balance.ts`의 결합 코드는 생리 설정이 있을 때만 실행됩니다.

## 33. 저장 호환성

선택 필드, 스키마 버전 그대로. 잘못된 값은 버림(잘못된 구역은 그 구역만), `humans` 없으면 버림, Phase 33 파일은 그대로 읽힘,
`updateSimulationSettings`: 다른 설정 변경 시 유지, `null`이면 삭제, 확장 모델을 끄면 함께 삭제(시험).

## 34. UI

- **설정**: 시뮬레이션 설정의 "생리 반응" 스위치(켜면 확장 인체 모델도 켬, 끄면 `physiology: null`). 고급: 활동 강도, 의복, 명시적 수분 섭취
  L/h, 하위 모델 6개 토글, 기준값(습도·기압·O₂·수온)과 "가정값" 안내.
- **인스펙터**(`PhysiologyInspector`): 중심·피부 온도, 그 자리 공기 온도와 출처, 열 유입·손실(W), 호흡(숨 쉼, 환기 L/min, O₂ 공급 지표 또는
  "계산 안 됨"), CO·O₂·CO₂ FED, CO 선량, 연기 선량·흡입량, 기도 상태·첫 침수·누적·최장, 수분 부족 %, 피로, 열 상태, 생리 능력·최종 능력과
  제한 원인, 활동·의복, 값 출처(번역된 출처, "가정" 표시), 모델 수준 범례(A/B/C), 한계 문구. 계산하지 않은 값은 0이 아니라 "계산 안 됨".
- **오버레이**(`PhysiologyLayer`): 지표 8종(중심 온도, 열 부담, O₂ 공급, 연기 선량, 기도, 수분 부족, 피로, 행동 능력) 중 하나로 색칠한 표시,
  단위·의미·"계산 안 됨"을 적은 범례, 기도 침수 고리. 임상 색 분류를 쓰지 않음. 인스턴싱, 프레임당 할당 없음, 해제 시 GPU 자원 반납, 읽기 전용.
- **결과**(`PhysiologyResults`): 카드 12개, 능력 단계 표, 사람 표, 시계열 차트 10개(시간 축 s, 단위, NaN은 공백), 생리 CSV(스키마 줄, "의학적
  예측 아님" 문구, 단위 줄, 값 출처 열, 사건·시계열 구역, 없는 값은 빈 칸), 주 JSON 내보내기의 `physiology` 블록(스키마 1, 단위, 수준,
  파라미터, 설정, 구획, 사람, 시계열(null), 사건). Phase 33 `humans` 블록과 기존 내보내기는 그대로, 손상 사건 CSV 끝에 `physio_*` 열 추가.
- 문구는 한국어·영어 모두(`physioUi.*` 228키, 프리셋, 핵심 키).

## 35. 프리셋

교육용 실험 24종(`src/physiology/presets.ts`, `demos.ts`, 시드 3401+k), 각각 목적·조건·가정·예상 현상·한계를 한국어·영어로 문서화:
안정 기준(24 °C), 추운 실내, 추운 야외, 한파+강풍, 찬물 부분 침수, 찬물 전신 침수, 더운 실내, 폭염, 고온·고습, 건조한 고온, 높은 활동, 장시간 활동,
활동 후 회복, 수분 부족, 화재 복사열, 화재 주변 고온 공기, 연기, CO, 저산소, 낮은 기압, 기도 간헐 침수, 기도 지속 침수, 매몰 후 환경 노출,
지진·화재·행동 불가 복합.

| 환경 원천 | 프리셋 |
|---|---|
| 장면 기준 공기(가정) | 안정 기준, 추운 실내, 더운 실내, 높은 활동, 장시간 활동, 회복, 수분 부족 |
| 기후 실험 | 추운 야외, 한파+강풍(+바람 사건), 폭염(태양), 고온·고습, 건조한 고온 |
| 홍수(물 차오름, 지형 해안) | 찬물 부분 침수(수온은 기준값, 가정 표시), 기도 지속 침수 |
| 화재 점화 | 화재 복사열, 연기(CO는 매연 기반 추정) |
| 대기 실험 | 낮은 기압(3 500 m) |
| 지진 + 붕괴 / 화재 | 매몰 후 환경 노출(잔해 매몰 + 밀폐 공기 구역), 지진·화재·행동 불가 |
| **실험용 경계 조건 구역** | 찬물 전신 침수(강체가 목 깊이 물에 뜸), 화재 주변 고온 공기(실외 공기 기둥은 화재 옆에서 1–5 K만 오름, 건물 안 배치 불가), CO, 저산소, 기도 간헐 침수, 매몰 공기 주머니 |

구역을 쓰는 프리셋은 조건·한계에 "실험용 경계 조건이며 시뮬레이션 결과가 아님"을 두 언어로 적었고 시험이 이 문구를 확인합니다.

## 36. 독립 검증

기대값은 구현 코드를 쓰지 않고 해석해·손계산·문헌 기준값으로 따로 만듭니다(§59–63). 새 시험 80개(+ 성능 측정 2개는 `BENCH=1`에서만):

| 파일 | 개수 | 내용 |
|---|---|---|
| `src/physiology/physiology.test.ts` | 32 | 집중 냉각 해석해(Heun 오차 스텝 절반에 ≈ ¼), 일정 열 ΔT = Qt/C, 2노드 닫힌계 에너지 보존, 전체 모델 2 h ΔU = 열 장부(추위·더위·물), 의복 표면 εσ(T⁴ − T_r⁴) 손계산, DuBois 면적, 중립 실내 2 h, 바람·습도·사우나 응결·복사, 증발 질량 × L_v = 증발 열, P_IO₂ / P_AO₂ 손계산, 고도 5 500 m, ppm ↔ mg/m³, CO FED 1 000 ppm × 35 min = 1, O₂ FED 12 % = 27.8 min, 선형 경사 노출 사다리꼴 정확, O₂ 소비 = M t / 20.2 kJ·L⁻¹, 가스 자료 없음 → 계산 안 함, 기도 이력·숨 참기, 수분·피로·히스테리시스·능력 분리, 시간 간격 수렴(§30) |
| `src/simulation/physiology/physiology.sim.test.ts` | 9 | 꺼짐 = 상태 없음, 설정 저장/불러오기/잘못된 구역, 출처 표시, 고온 다습 구역(사건 1회·장부), 밀폐 8 m³ O₂/CO₂ 질량 보존, 기도 침수/해제 사건, CO 행동 불가 → Phase 33 제어된 주저앉기(충격 없음), 결정론(추가 순서 무관), 리셋 |
| `src/simulation/physiology/combos.sim.test.ts` | 10 | 복합 재난 10종(§29): 각 항이 한 번만 장부에 들어가는지 |
| `src/simulation/physiology/presets.sim.test.ts` | 25 | 프리셋 24종 두 언어 문서 + 각각 유한·결정론·전환당 사건 1회·기대 거동 |
| `src/ui/Results/PhysiologyResults.test.ts` | 4 | 계열 범위의 NaN 공백, CSV/JSON 스키마·단위·출처(계산 안 한 값 = 빈칸/null, 0 아님), 사건 행, i18n 키 |
| `src/phenomena/phenomena.test.ts` | (수정) | 시스템 순서 `post:physiology` |

전체 스위트(커밋 `9523afb`): **1 161 통과 / 0 실패 / 31 건너뜀**(기준 816f48e: 1 081 / 0 / 29). 스위트 한 번에서 기후 시험 하나
(`climate.sim` 지붕 눈 붕괴)가 기계 부하 40–60에서 900 s 제한 시간을 넘겼고, 단독 재실행에서 통과했습니다(생리 코드와 무관 — 생리 꺼짐).
`tsc --noEmit` 오류 0, `vite build` 성공.

동일성(§32, 기준 816f48e, 생리 꺼짐): 기존 장면 32/32 + Phase 31 장면 20/20 + 의도 변경 장면 1/1 = **53/53 차이 0**, 미분 검사
**44/44 차이 0**, Phase 33 사람 장면 **22/22 동일**(무작위 ID 정규화 후, 시간 측정 값 제외).

## 37. Chrome 검증

`npx vite build && npx vite preview --port 4199`, 헤드리스 Chrome(puppeteer-core), Phase 34 코드 커밋 `9523afb`:

| 스크립트 | 한국어 | 영어 |
|---|---|---|
| `scripts/verify-physiology.mjs` (Phase 34, 70항목) | **70/70** | **70/70** |
| `scripts/verify-human.mjs` (Phase 33 회귀) | **48/48** | **48/48** |
| `scripts/verify-celestial.mjs` (Phase 32 회귀) | **62/62** | **62/62** |
| `scripts/verify-gravity.mjs` (Phase 31 회귀) | **57/57** | **57/57** |

모든 실행에서 페이지·콘솔 오류 0, 탭 정상, GPU 지오메트리 17 → 8. 생리 70항목: 켜기/끄기(확장 모델 함께 켜짐), 사람 배치, 평온한 실행의
출처 표시(가정/기준), 추위·더위·복사열·연기·CO·저산소·저압·기도 침수·수분·피로·능력과 제한 원인, 생리적 주저앉기, 오버레이·범례·GPU 자원,
차트 공백, CSV/JSON(스키마·단위·출처), 프리셋 24종(번역), 저장/불러오기, 리셋, 원본 복원, 언어 전환, 복합 재난, 기존 모델 영향 없음,
번역 안 된 키·NaN 표시 없음. 처음 실행에서 2항목이 실패했는데(프리셋 설계와 다른 기대: 전신 침수 프리셋의 수온 출처가 구역, 화재 복사
프리셋은 120 s에 화염이 이미 약해짐) 검사를 프리셋 설계에 맞게 고쳤습니다(물리 기준을 완화하지 않음 — 누적 열 FED를 확인).
로그·스크린숏: `docs/verify/physiology/`.

## 38. 성능

`src/bench/physiology.bench.test.ts`, Apple M3(8코어), Node v24.21.0, 헤드리스(렌더링 없음), 1/60 s 물리 스텝, 2 m 격자 군중. 부하 평균
3.8–8.9(재부팅 직후, 다른 세션 적음 — 이전 Phase 측정보다 조용함). L1 = 확장 인체 모델만, L2 = L1 + 생리. 값은 시뮬레이션 1초당 ms,
반복 3회 중앙값(5 000명은 1회). 원자료: `docs/bench-phase34.json`.

| 사람 | L1 전체 (calm) | L2 전체 calm / heat / cold | 생리 합계 (calm) | 샘플링 | 생리 스텝 | 기록 | L2 p95 스텝 | 힙 |
|---|---|---|---|---|---|---|---|---|
| 1 | 1.25 | 1.23 / 0.99 / 0.85 | 0.21 | 0.04 | 0.15 | 0.01 | 0.05 | 65 MB |
| 10 | 2.17 | 2.92 / 2.39 / 1.82 | 0.94 | 0.08 | 0.80 | 0.04 | 0.14 | 66 MB |
| 50 | 4.10 | 7.0 / 6.7 / 7.0 | 3.0 | 0.64 | 2.1 | 0.09 | 0.37 | 66 MB |
| 100 | 7.28 | 12.1 / 11.5 / 11.5 | 4.9 | 0.59 | 3.8 | 0.14 | 0.60 | 67 MB |
| 250 | 15.3 | 28.1 / 28.1 / 28.3 | 12.2 | 1.5 | 9.9 | 0.20 | 1.43 | 70 MB |
| 500 | 31.2 | 56.0 / 56.7 / 54.9 | 25.2 | 3.1 | 20.2 | 0.36 | 2.89 | 73 MB |
| 1 000 | 75.5 | 133 / 140 / 127 | 53.1 | 7.8 | 40.7 | 0.67 | 6.6 | 80 MB |
| 5 000 | 649 | 1 053 / 1 043 / 898 | 318 | 64 | 214 | 4.4 | 41.8 | 135 MB |

- 생리 비용은 사람 수에 선형: 1인당 시뮬레이션 1초에 ≈ 50 µs(0.1 s 간격 10회 × 사람 스텝 ≈ 4 µs + 샘플링). 마이크로벤치: 열 흐름 793 ns,
  FED 비율 257 ns, 사람 한 스텝 4.0 µs.
- 1 000명: 생리 53 ms/s ≈ 프레임당 0.9 ms(60 FPS 예산의 5 %). Rapier + 확장 인체(humans 26, physics 26 ms/s)와 같은 크기 — 실시간 1배속은
  5 000명까지(1 053 ms/s ≈ 실시간 0.95배) 유지되지만 p95 스텝 42 ms라 5 000명은 프레임이 끊깁니다.
- 기록(결과 계열·사건)은 1 % 미만. 장면 종류(중립·고온 다습·한랭 강풍) 차이는 잡음 범위 — 비용은 노출 값이 아니라 사람 수가 정합니다.
- 모든 실행: 비유한 값 없음, 사건 0(측정 5–10 s 안에는 단계 전환 없음), 끝난 뒤 Rapier 월드 0개.
- 브라우저: Chrome 검증(§37)의 작은 장면에서 프레임 영향 미측정 — 렌더링 표시는 오버레이를 켤 때만 사람 수에 비례합니다.

## 39. 장기 실행

`BENCH=1 LONG=3600 NODE_OPTIONS=--expose-gc npx vitest run src/bench/physiology.bench -t long`, 최종 코드(커밋 `9523afb` + 측정 스크립트),
장면마다 20명, 3600 s, 60 s마다 비유한 값·음의 체수분·모델 범위 밖 온도·사건·계열·잔차·밀폐 구획 O₂·힙(GC 후)을 확인. 원자료:
`docs/bench-phase34-long.json`.

| 장면 | 벽시계 | 문제 | 중심 온도 (최종) | 사건 | 열 장부 잔차 최대 | 힙 60 s → 3600 s |
|---|---|---|---|---|---|---|
| baseline(장면 기준 공기) | 8.4 s | 없음 | 36.83 °C | 40 (피부 냉각 coldStress + 능력 stressed, 1인 2개) | 1.2·10⁻⁶ J | 65.9 → 80.9 MB |
| cold(−15 °C, 12 m/s) | 8.5 s | 없음 | 36.55 °C | 80 (coldStress → severeColdStress, 능력 impaired) | 1.2·10⁻⁶ J | 66.1 → 81.1 MB |
| heatwave(40 °C, 35 %) | 8.4 s | 없음 | 37.50 °C | 0 (증발로 버팀) | 1.9·10⁻⁶ J | 66.2 → 81.2 MB |
| hotHumid(35 °C, 90 %) | 8.3 s | 없음 | 38.21–38.23 °C | 40 (heatStress) | 1.5·10⁻⁶ J | 66.3 → 81.2 MB |
| smoke(매연 0.2 g/m³, CO 300 ppm, CO₂ 1 %) | 8.4 s | 없음 | 36.83 °C | 80 (가스 노출 stressed, 능력 impaired) | 1.2·10⁻⁶ J | 66.5 → 81.5 MB |
| hypoxia(O₂ 15 %) | 8.4 s | 없음 | 36.83 °C | 100 (호흡·가스 stressed, 능력 impaired) | 1.2·10⁻⁶ J | 66.5 → 81.5 MB |
| submersion(12 °C 물, 수위 0.6–1.8 m, 주기 20 s) | 9.2 s | 없음 | 36.61 °C | 9 421 | 1.7·10⁻⁶ J | 66.6 → 86.8 MB |
| dehydration(36 °C, 중간 활동) | 8.3 s | 없음 | 37.93–37.94 °C | 0 | 1.3·10⁻⁶ J | 66.7 → 81.5 MB |
| buried(밀폐 40 m³, 교환 0.2 /h) | 8.7 s | 없음 | 36.83 °C | 40 | 1.2·10⁻⁶ J | 66.7 → 81.6 MB (구획 O₂ 0.2095 → 0.1993) |
| combined(38 °C, 60 %, 연기·CO·복사 1.5 kW/m², 지진 M7) | 51.6 s | 없음 | 36.77–39.45 °C | 43 (unableToAct 4) | 1.7·10⁻⁶ J | 83.4 → 98.5 MB |

- 비유한 값·음의 체수분·모델 범위 밖 온도: 모든 장면, 모든 점검 시각에서 0.
- 힙: 처음 60 s 뒤 +15 MB(결과 계열이 1 s 간격 3 600 점 × 20명 = 72 000 점까지 자람) — 이후 증가는 계열 크기와 같은 수준, 누수 징후 없음.
- submersion의 사건 9 421개는 단계마다 한 번씩 생긴 실제 전환입니다: 수위가 20 s 주기로 기도 위아래를 오가 1인 180주기 × 2
  (AIRWAY_SUBMERGED 3 600 + AIRWAY_CLEARED 3 600), 숨 참기 여유가 줄었다 회복될 때 능력 impaired ↔ severelyImpaired 2 122, 나머지
  열·호흡 단계 99. 히스테리시스(10 s 유지)가 반주기(≈ 10 s)와 비슷해 주기마다 능력이 바뀝니다 — 스텝마다 생기는 사건은 없습니다.
- 지난 실행(열 상태 이름·호흡 수정 이전)과 비교: 사건 수만 달라짐(cold 100 → 80, hypoxia 80 → 100, submersion 160 → 9 421). submersion은 기도 침수 → 호흡
  '행동 불가' 연결을 고친 결과로 해석합니다(이전에는 짧은 잠수로도 주저앉아 기도가 계속 물속에 있었을 것으로 추정 — 이전 실행은 사건 종류를
  기록하지 않아 직접 확인은 못 함). NaN·누수 판정은 같음.

## 40. 과학적 한계

- 교육용 축약 생리 모델 — 개인별 생리 반응 예측, 의료 진단, 사망 시각, 생존 확률, 실제 사고 재구성 불가.
- 개인차(체지방·연령·성별·질환·약물·적응) 미반영. 일반 성인 하나의 파라미터.
- 2노드 체온: 체지방 파라미터 없음 — 10 °C 물에서 중심 냉각 ≈ 0.2 °C/h로 마른 사람의 실측(1–3 °C/h)보다 느림(검증 소견, §36).
- 심혈관계(저·고중력의 순환 부담 포함), 폐포 가스 교환, 혈액 가스, 조직 손상, 화상 깊이를 풀지 않음.
- FED(ISO 13571/Purser)는 집단 기준의 누적 지표이며 회복이 없음; 기준 1은 개인 예측이 아님.
- 환경 데이터 해상도(5 m 공기 기둥, 방 한 노드, 1 m 물 칸)와 가정값(습도·기압·수온·조성·평균 복사 온도)의 한계.
- 화재 CO는 환기 양호 수율비로 추정(환기 부족 시 과소), 화산가스·화산재는 계산하지 않음.
- 일부 계수는 교육용 가정(§50의 수준 C).

## 41. 잔여 문제

| 심각도 | 파일 / 함수 | 재현 | 원인 | 영향 | 권장 |
|---|---|---|---|---|---|
| 중 | `src/simulation/human/HumanSystem.ts`(Phase 33) — 누운 사람 | 지진 1.2 g 후 넘어진 사람이 바람 없이 ≈ 0.23 m/s로 계속 구름; 3 m/s 바람에 바람 반대쪽으로 0.077 m/s; 산사태 매몰 후에도 이동 | 누운 캡슐에 구름 저항·각 감쇠 없음(Phase 33부터, 생리와 무관 — 생리 유무로 위치 같음) | 누운 사람의 위치·노출 지점이 천천히 바뀜 | 누운 강체의 구름 마찰/각 감쇠(Phase 33 결과가 바뀌므로 별도 단계에서) |
| 중 | 건물 + Phase 33 사람 | 집 안(바닥 위)에 둔 사람이 10 s 안에 넘어지거나 밖으로 밀려남 | 건물 충돌체와 사람 캡슐의 배치 문제 | 방 화재 노출(`fire.room`, `thermal.room`)을 사람으로 보여 줄 수 없음(코드 경로는 있음) | 건물 내부 배치 규칙 |
| 중 | `sampler.ts` CO 추정 | 환기 부족 방 화재 | CO/매연 비 0.27(환기 양호 목재) 고정 | CO 과소 추정 | 화학종 화재 모델 또는 환기 의존 수율 |
| 중 | `thermal.ts` 2노드 | 10 °C 물 1 h | Gagge 최소 조직 전도 + 떨림, 체지방 파라미터 없음 | 중심 냉각 ≈ 0.2 °C/h(마른 사람 실측 1–3 °C/h보다 느림) | 체지방·조직 단열 파라미터 |
| 낮 | 실외 화재 공기 | 숲·집 화재 옆 | 5 m × 10 m 잘 섞인 기둥 | 실제 화재로는 대류 열 FED가 거의 생기지 않음(복사는 계산됨) | 플룸 근접 온도 모델 |
| 낮 | 매몰 | 잔해 매몰 | Phase 33이 매몰을 이동 능력에 반영하지 않음 | 물리 능력 'normal' 유지 | 매몰 → 이동 불가 연결 |
| 낮 | 성능 측정 | — | 재부팅 직후지만 부하 3.8–8.9 | §38 값에 수 % 잡음(반복 범위는 원자료) | 완전히 조용한 기계에서 재측정, 브라우저 FPS 측정 |

## 42. Phase 35 연동 인터페이스

`physiologySnapshot(e)`(`src/simulation/physiology/interface.ts`): 사람 ID, 자세, 물리 이동 능력·행동 불가, 생리 능력, 최종 능력(지표 0–4)과
원인, 숨 쉬는지, 기도 상태, 열 상태·열 부담 척도, 피로, 동결(포획). 차량 충돌·탑승·운전·구조 행동은 구현하지 않습니다.

## 부록: 파라미터 표 (§50)

| 이름 | 값 | 단위 | 범위 | 수준 | 출처 / 적용 조건 | 비고 |
|---|---|---|---|---|---|---|
| **body** | | | | | | |
| `specificHeat` | 3492 | J/(kg·K) | [3300, 3600] | B | Gagge et al. 1971/1986 two-node model (0.97 W·h/(kg·K)) |  |
| `skinMassShare` | 0.1 | 1 | [0.05, 0.2] | C | fixed skin-node share of the heat capacity (Gagge α at thermoneutrality ≈ 0.1) | the variable α of Gagge enters only the mean-body signal, so the energy of the two nodes is conserved exactly |
| `coreSet` | 36.8 | °C | [36.5, 37.2] | B | Gagge 1986 set point (core) |  |
| `skinSet` | 33.7 | °C | [33, 34.5] | B | Gagge 1986 set point (skin) |  |
| `bodySet` | 36.49 | °C | [36.2, 36.8] | B | Gagge 1986 set point (mean body) |  |
| `coreSkinConductance` | 5.28 | W/(m²·K) | [4, 7] | B | Gagge 1986 tissue conductance |  |
| `bloodHeat` | 1.163 | W·h/(L·K) | [1.1, 1.2] | A | heat capacity of blood per litre (Gagge 1986) |  |
| `skinBloodFlowNeutral` | 6.3 | L/(m²·h) | [5, 8] | B | Gagge 1986 |  |
| `vasodilation` | 100 | L/(m²·h·K) | [50, 200] | B | Gagge 1986 (c_dil) |  |
| `vasoconstriction` | 0.5 | 1/K | [0.1, 1] | B | Gagge 1986 (c_str) |  |
| `skinBloodFlowRange` | 90 | L/(m²·h) | [0.5, 90] | B | Gagge 1986 limits 0.5–90 |  |
| `sweatGain` | 170 | g/(m²·h·K) | [100, 250] | B | Gagge 1986 (c_sw) |  |
| `sweatMax` | 500 | g/(m²·h) | [300, 800] | B | Gagge 1986 cap |  |
| `shiverGain` | 19.4 | W/(m²·K²) | [10, 30] | B | Gagge 1986 |  |
| `shiverMax` | 250 | W/m² | [150, 350] | C | cap of shivering heat (≈ 4 met) — assumption |  |
| `shiverStop` | 31 | °C | [30, 33] | C | core temperature below which shivering has ceased (linear fade from 33 °C) — literature order of magnitude, assumption |  |
| `latentHeat` | 2.43e6 | J/kg | [2.40e6, 2.45e6] | A | latent heat of vaporisation of water at skin temperature |  |
| `skinDiffusion` | 0.06 | 1 | [0.04, 0.08] | B | Gagge 1986 diffusion wettedness of non-sweating skin |  |
| `lewis` | 16.5e-3 | K/Pa | [16e-3, 17e-3] | A | Lewis relation 16.5 K/kPa (ASHRAE) |  |
| `emissivity` | 0.95 | 1 | [0.9, 0.98] | B | skin / clothing emissivity (ASHRAE) |  |
| `radiativeShare` | 0.73 | 1 | [0.65, 0.78] | B | effective radiation area / body area, standing (Fanger); 0.65 seated / lying |  |
| `projectedShare` | 0.25 | 1 | [0.15, 0.35] | B | projected area factor for a directed horizontal source (Fanger / Underwood & Ward) |  |
| `absorptivity` | 0.8 | 1 | [0.5, 0.95] | C | absorbed share of directed (fire) radiation — depends on clothing colour / material |  |
| **convection** | | | | | | |
| `hcAirStill` | 3.1 | W/(m²·K) | [2.5, 4] | B | natural convection of a standing person (ASHRAE / Gagge) |  |
| `hcAirForcedA` | 8.6 | W/(m²·K) | [8, 9] | B | h_c = 8.6 v^0.53 (Gagge 1986, valid ≈ 0.2–4 m/s; extrapolated beyond and flagged) |  |
| `hcAirForcedB` | 0.53 | 1 | [0.5, 0.6] | B | exponent of the forced-convection relation |  |
| `hcAirValid` | 4 | m/s | [2, 6] | B | upper end of the validated air-speed range (flag above) |  |
| `hcWaterStill` | 230 | W/(m²·K) | [100, 400] | B | skin convection in still water — order of magnitude (Boutelier et al. 1977) |  |
| `hcWaterFlow` | 2 | s/m | [0.5, 4] | C | h_w = h_still (1 + k v) — increase with relative water speed, assumption |  |
| `hcWaterMax` | 1000 | W/(m²·K) | [500, 2000] | C | cap of water convection |  |
| `wetClothingFactor` | 0.2 | 1 | [0.1, 0.5] | C | insulation retained by wet / immersed clothing (share of dry R_cl) |  |
| `contactResistance` | 0.05 | m²·K/W | [0.02, 0.15] | C | skin–ground contact resistance in addition to clothing |  |
| `contactShareLying` | 0.2 | 1 | [0.1, 0.3] | C | share of the body surface touching the ground when lying |  |
| **metabolism / respiration** | | | | | | |
| `met` | 58.15 | W/m² | [58.15, 58.15] | A | 1 met (definition) |  |
| `metResting` | 1.2 | met | [1, 1.4] | B | standing relaxed (ISO 8996 / ASHRAE) |  |
| `metLight` | 2.0 | met | [1.6, 2.4] | B | light activity (ISO 8996) |  |
| `metModerate` | 3.5 | met | [2.6, 4.4] | B | moderate activity / brisk walking (ISO 8996) |  |
| `metStrenuous` | 6.5 | met | [5, 8] | B | strenuous activity / running (ISO 8996) |  |
| `metMax` | 12 | met | [8, 16] | C | maximal metabolic capacity of the generic adult — assumption |  |
| `workEfficiency` | 0 | 1 | [0, 0.25] | C | external mechanical work share W/M (no work done on the environment by default) |  |
| `oxygenEnergy` | 20.2e3 | J/L | [19.6e3, 21.1e3] | B | energy equivalent of oxygen at RQ 0.85 (STPD) |  |
| `respiratoryQuotient` | 0.85 | 1 | [0.7, 1] | B | mixed-diet respiratory quotient |  |
| `ventilatoryEquivalent` | 25 | L/L | [20, 35] | B | minute ventilation per oxygen uptake, sub-maximal |  |
| `ventilationMax` | 120 | L/min | [80, 180] | C | maximal voluntary ventilation of the generic adult — assumption |  |
| `airwayWaterPressure` | 6.27e3 | Pa | [6.2e3, 6.3e3] | A | saturated water-vapour pressure at 37 °C (inspired gas humidified) |  |
| `alveolarCO2` | 5.33e3 | Pa | [4.5e3, 6e3] | B | alveolar CO₂ partial pressure (40 mmHg) |  |
| **fire / gases (ISO 13571 / Purser)** | | | | | | |
| `coDose` | 35000 | ppm·min | [27000, 45000] | B | ISO 13571 CO dose for FED = 1 |  |
| `co2Hyperventilation` | 5 | % CO₂ | [4, 6] | B | ISO 13571 / Purser: CO uptake factor exp(%CO₂ / 5) |  |
| `co2Threshold` | 5 | % CO₂ | [3, 7] | B | Purser CO₂ FED relation applied above this concentration |  |
| `hypoxiaA` | 8.13 | 1 | [8, 8.3] | B | Purser: t(O₂) = exp(8.13 − 0.54 (20.9 − %O₂)) min |  |
| `hypoxiaB` | 0.54 | 1/% | [0.5, 0.6] | B | Purser hypoxia slope |  |
| `convHeatA` | 5e7 | min·°C^3.4 | [4e7, 6e7] | B | ISO 13571: t(conv) = 5·10⁷ T^−3.4 min (lightly clothed) |  |
| `convHeatMin` | 60 | °C | [50, 80] | C | lower end where the convective-heat FED is applied (below: the thermoregulation model) |  |
| `radHeatR` | 6.9 | (kW/m²)^(4/3)·min | [4, 10] | C | radiant-heat FED: t = r / q^(4/3) — ISO 13571 form, value uncertain |  |
| `radHeatMin` | 1.7 | kW/m² | [1, 2.5] | B | directed radiant flux tolerable without a heat dose (ISO 13571 order) |  |
| `smokeDeposition` | 0.3 | 1 | [0.1, 0.6] | C | deposited share of inhaled smoke particles — assumption |  |
| **water / fatigue / capacity** | | | | | | |
| `bodyWaterShare` | 0.6 | 1 | [0.45, 0.65] | B | total body water / body mass, generic adult |  |
| `dehydrationCoreShift` | 0.15 | K/% | [0.1, 0.25] | B | core set-point rise per % body-mass water deficit (Sawka; Montain & Coyle 1992) |  |
| `dehydrationSweatLoss` | 0.1 | 1/% | [0.05, 0.2] | C | reduction of sweat sensitivity per % deficit above 1 % — assumption |  |
| `sustainable` | 0.4 | 1 | [0.3, 0.5] | C | relative intensity sustainable without fatigue — assumption |  |
| `fatigueTime` | 600 | s | [300, 1800] | C | time to reach the fatigue limit at maximal intensity — assumption |  |
| `recoveryTime` | 900 | s | [300, 3600] | C | e-folding recovery time at rest — assumption |  |
| `breathHold` | 60 | s | [20, 120] | C | reference breath-hold reserve of a resting adult in thermoneutral water — order of magnitude, assumption (shorter in cold water) |  |
| `coldShockHold` | 0.5 | 1 | [0.25, 1] | C | breath-hold reserve factor in water below 15 °C (cold shock) — assumption |  |

수준: **A** 보존 법칙·물리, **B** 문헌의 축약 생리 모델(적용 범위 안), **C** 명시적 교육용 가정. 범위는 파라미터를 바꿀 때 허용하는 폭이자
불확실성의 크기 정도입니다. 극단 입력: 공기 대류는 4 m/s 넘으면 외삽하고 `thermalOutOfRange` 플래그, 호흡 열식은 −40–50 °C 밖에서 플래그,
중심 온도 10–46 °C 밖은 `temperatureOutOfModelRange`, 비유한 값은 `nonFinite`(조용히 고치지 않음). 의복 표(§14), 단계 경계(§27,
`THRESHOLDS`)도 같은 원칙입니다.

## 커밋

- `c5a6747` Phase 34 (1): 축약 생리 모델(2노드 체온·의복·호흡·가스 FED·기도·수분·피로·능력)과 설정
- `dc11a47` Phase 34 (2): 시뮬레이션 런타임 연결(노출 샘플러·구역·밀폐 구획·PhysiologySystem·Phase 33 능력 연결·사건)
- `ca67c68` Phase 34 (3): 인스펙터·오버레이·결과·CSV/JSON 내보내기, Chrome 검증 스크립트
- `9523afb` Phase 34 (4): 프리셋 24종과 복합 재난 검사
- (이 문서) Phase 34 (5): HUMAN_PHYSIOLOGY.md, PHASE34_PREIMPLEMENTATION_AUDIT.md, README·PHENOMENA, 성능·장기 실행 자료, Chrome 검증 결과(생리·인체·천체·중력 재실행)

원격 push는 하지 않았습니다. Phase 35는 시작하지 않았습니다.
