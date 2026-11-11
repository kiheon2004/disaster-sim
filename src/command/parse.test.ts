/**
 * Phase 37 (§6, §20): the rule-based Korean / English parser. Every expectation below was written BY HAND from
 * NL-CONVENTIONS.md (the section is named with each group) — as canonical strings, never copied from parser output.
 * (The large corpus, written by someone else from the same conventions, is run by corpus.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { formatCanonical, parseCanonical } from './canonical';
import { validateIntents } from './intent';
import { parseCommand, suggest, type AskSlot, type ParseOutcome } from './parse';

type Case = [text: string, expect: string[]];

const show = (o: ParseOutcome): string => (o.kind === 'ok' ? o.canonical.join(' | ') : o.kind === 'ask' ? `ask ${o.slot}` : `unknown (${o.reason.key})`);

/** Sentence classes of the specification (§6 table), Korean and English: at least eight sentences each. */
const CLASSES: Record<string, Case[]> = {
  // §3.1 place
  'place · ko': [
    ['큰길 북쪽에 2층 주택 세 채 간격 2미터', ['place building:house count=3 along=road:main side=north gap=2 floors=2']],
    ['큰길 북쪽에 2층 주택 세 채, 간격 2 m', ['place building:house count=3 along=road:main side=north gap=2 floors=2']],
    ['여기에 주택 한 채 놓아 줘', ['place building:house at=cursor']],
    ['주택세채', ['place building:house count=3']],
    ['2층주택', ['place building:house floors=2']],
    ['교차로 옆에 아파트 두 동 지어', ['place building:apartment count=2 at=next(junction)']],
    ['n4 북쪽 10 m에 창고 세워', ['place building:warehouse at=north(node:n4,10)']],
    ['큰길 왼쪽에 오피스 빌딩 네 채, 3 m 간격으로', ['place building:office count=4 along=road:main side=left gap=3']],
    ['가운데에 10층 타워 하나 만들어', ['place building:tower at=center floors=10']],
    ['건물 다섯 채 배치해', ['place building count=5']],
    ['큰길 양쪽에 주택 세 채', ['place building:house count=3 along=road:main side=left', 'place building:house count=3 along=road:main side=right']],
    ['여기에 가로등 하나, 방향 90도', ['place streetLight at=cursor heading=90']],
    ['저기에 상자 두 개 붙여서 놓아', ['place crate count=2 at=view gap=0']],
    ['(40, 60)에 공장 추가해', ['place building:industrial at=40,60']],
    ['큰길을 따라 주택 다섯 채, 2 m씩 띄워서', ['place building:house count=5 along=road:main gap=2']],
    ['s2 도로에 가로등 하나', ['place streetLight at=seg:s2@0.5']],
    ['s2 도로를 따라 가로등 네 개', ['place streetLight count=4 along=seg:s2']],
    ['여기에 담장', ['place wall at=cursor']],
  ],
  'place · en': [
    ['put three 2-storey houses north of the main road, 2 m apart', ['place building:house count=3 along=road:main side=north gap=2 floors=2']],
    ['place a house here', ['place building:house at=cursor']],
    ['build two apartments next to the junction', ['place building:apartment count=2 at=next(junction)']],
    ['add a warehouse 10 m north of n4', ['place building:warehouse at=north(node:n4,10)']],
    ['four office buildings on the left side of the main road with 3 m gaps', ['place building:office count=4 along=road:main side=left gap=3']],
    ['create a 10-storey tower at the centre', ['place building:tower at=center floors=10']],
    ['five buildings', ['place building count=5']],
    ['three houses on both sides of the main road', ['place building:house count=3 along=road:main side=left', 'place building:house count=3 along=road:main side=right']],
    ['a street light here, heading 90', ['place streetLight at=cursor heading=90']],
    ['put two crates over there, touching', ['place crate count=2 at=view gap=0']],
    ['a factory at (40, 60)', ['place building:industrial at=40,60']],
    ['a dozen houses along the avenue', ['place building:house count=12 along=road:main']],
    ['a street light on road s2', ['place streetLight at=seg:s2@0.5']],
    ['four street lights along road s2', ['place streetLight count=4 along=seg:s2']],
    ['put a tree there', ['place tree at=view']],
    ['Place a two-story house on the hill', ['place building:house at=feature:hill floors=2']],
  ],
  // §3.1 vehicles and people (cars go on the lanes: a road → along=)
  'vehicles · ko': [
    ['n2–n3 도로에 차 다섯 대', ['place car count=5 along=road:n2-n3']],
    ['큰길에 트럭 두 대 주차해', ['place car:truck count=2 along=road:main']],
    ['여기에 사람 세 명', ['place human count=3 at=cursor']],
    ['구간 s2에 차 세 대', ['place car count=3 along=seg:s2']],
    ['교차로에 SUV 한 대', ['place car:suv at=junction']],
    ['도로에 승용차 열 대 놓아', ['place car:sedan count=10 along=road:any']],
    ['n2에서 n3까지 도로에 보행자 네 명', ['place human count=4 along=road:n2-n3']],
    ['가장 가까운 도로에 화물차 한 대', ['place car:truck along=road:nearest(cursor)']],
    ['저기에 행인 두 명 세워', ['place human count=2 at=view']],
    ['s2 도로 오른쪽에 차량 세 대', ['place car count=3 along=seg:s2 side=right']],
  ],
  'vehicles · en': [
    ['five cars on the road from n2 to n3', ['place car count=5 along=road:n2-n3']],
    ['park two trucks on the main road', ['place car:truck count=2 along=road:main']],
    ['three people here', ['place human count=3 at=cursor']],
    ['three cars on segment s2', ['place car count=3 along=seg:s2']],
    ['an SUV at the junction', ['place car:suv at=junction']],
    ['put ten sedans on the road', ['place car:sedan count=10 along=road:any']],
    ['four pedestrians on the road between n2 and n3', ['place human count=4 along=road:n2-n3']],
    ['a lorry on the nearest road', ['place car:truck along=road:nearest(cursor)']],
    ['two pedestrians over there', ['place human count=2 at=view']],
    ['three vehicles on the right side of road s2', ['place car count=3 along=seg:s2 side=right']],
  ],
  // §3.2 forest (and single trees)
  'nature · ko': [
    ['언덕 위에 숲, 밀도 낮게', ['forest feature:hill density=low']],
    ['여기에 나무 한 그루', ['place tree at=cursor']],
    ['나무 세 그루 심어', ['place tree count=3']],
    ['여기 반경 20 m에 숲을 만들어', ['forest circle cursor r=20']],
    ['산에 숲 빽빽하게', ['forest feature:mountain density=high']],
    ['언덕에 나무를 심어, 밀도 0.4', ['forest feature:hill density=0.4']],
    ['여기 반경 15 m 숲 시드 7', ['forest circle cursor r=15 seed=7']],
    ['(0, 0)에서 (30, 20)까지 숲', ['forest rect 0,0,30,20']],
    ['저기에 소나무 다섯 그루 심어', ['place tree:conifer count=5 at=view']],
    ['여기 지름 20 m 숲 보통', ['forest circle cursor r=10 density=medium']],
    ['강 옆에 활엽수 두 그루', ['place tree:broadleaf count=2 at=next(feature:river)']],
  ],
  'nature · en': [
    ['plant a sparse forest on the hill', ['forest feature:hill density=low']],
    ['a tree here', ['place tree at=cursor']],
    ['plant three trees', ['place tree count=3']],
    ['a forest in a 20 m circle here', ['forest circle cursor r=20']],
    ['a dense forest on the mountain', ['forest feature:mountain density=high']],
    ['plant trees on the hill, density 0.4', ['forest feature:hill density=0.4']],
    ['a forest within 15 m of here, seed 7', ['forest circle cursor r=15 seed=7']],
    ['a forest in the rectangle from (0, 0) to (30, 20)', ['forest rect 0,0,30,20']],
    ['plant five pines over there', ['place tree:conifer count=5 at=view']],
    ['woods 20 m across here, medium', ['forest circle cursor r=10 density=medium']],
    ['two broadleaf trees next to the river', ['place tree:broadleaf count=2 at=next(feature:river)']],
  ],
  // §3.3 select, §2.3 targets and filters
  'select · ko': [
    ['경사 20도 넘는 곳의 나무 다 선택', ['select type:tree where slope>20']],
    ['나무 전부 선택해', ['select type:tree']],
    ['2층 이상인 건물 선택', ['select type:building where floors>=2']],
    ['여기 근처 30 m 안의 건물 골라', ['select type:building where near cursor r=30']],
    ['도로 위의 차 선택해 줘', ['select type:car where on road']],
    ['트럭도 선택', ['add type:car:truck']],
    ['나무는 선택에서 빼 줘', ['remove type:tree']],
    ['선택 해제', ['select none']],
    ['아무것도 선택하지 마', ['select none']],
    ['숨긴 것 전부 선택', ['select all where hidden']],
    ['가장 큰 건물 선택', ['select type:building largest']],
    ["'북쪽 블록' 그룹 선택", ['select group:"북쪽 블록"']],
    ['높이 10 m 넘는 건물 선택', ['select type:building where height>10']],
    ['n4에서 30 m 이내 나무 선택', ['select type:tree where near node:n4 r=30']],
    ['잠긴 것 선택', ['select all where locked']],
    ['3층짜리 건물 추가 선택', ['add type:building where floors=3']],
    ['선택 취소', ['select none']],
    ['나무 선택', ['select type:tree']],
    ['경사가 20° 이상인 2층 이상 주택 선택', ['select type:building:house where slope>=20 and floors>=2']],
  ],
  'select · en': [
    ['select every tree on slopes over 20°', ['select type:tree where slope>20']],
    ['select all trees on slopes steeper than 20°', ['select type:tree where slope>20']],
    ['pick the buildings with at least 2 floors', ['select type:building where floors>=2']],
    ['select the buildings within 30 m of here', ['select type:building where near cursor r=30']],
    ['choose the cars on the road', ['select type:car where on road']],
    ['also select the trucks', ['add type:car:truck']],
    ['remove the trees from the selection', ['remove type:tree']],
    ['deselect all', ['select none']],
    ['clear the selection', ['select none']],
    ['select everything hidden', ['select all where hidden']],
    ['select the largest building', ['select type:building largest']],
    ['select the group "North block"', ['select group:"North block"']],
    ['select buildings taller than 10 m', ['select type:building where height>10']],
    ['deselect the trees', ['remove type:tree']],
    ['select the 3-storey buildings', ['select type:building where floors=3']],
    ['add the locked cars to the selection', ['add type:car where locked']],
    ['select nothing', ['select none']],
    ['select cars on road s3', ['select type:car where on road seg:s3']],
    ['select tree', ['select type:tree']],
    ['select the trees within 30 m of n4', ['select type:tree where near node:n4 r=30']],
  ],
  // §3.4 transform
  'transform · ko': [
    ['선택한 것 동쪽으로 5 m, 30도 회전', ['move selection by=5,0,0', 'rotate selection by=30']],
    ['이것 북쪽으로 3 m 옮겨', ['move selection by=0,0,-3']],
    ['선택한 것 모두 높이 0.5 m 올려', ['move selection by=0,0.5,0']],
    ['그것 n4로 옮겨', ['move it to=node:n4']],
    ['시계 방향으로 90도 돌려', ['rotate it by=-90']],
    ['나무 전부 두 배로', ['scale type:tree x2']],
    ['선택한 것 절반으로', ['scale selection x0.5']],
    ['x를 10으로', ['set it x=10']],
    ['방향을 90도로', ['set it heading=90']],
    ['지면에 붙여', ['set it lift=0']],
    ['이 건물들 남쪽으로 2 m 이동', ['move selection by=0,0,2']],
    ['반시계 방향으로 45도 회전', ['rotate it by=45']],
    ['선택한 것 뒤로 돌려', ['rotate selection by=180']],
    ['10% 크게', ['scale it x1.1']],
    ['1.5배', ['scale it x1.5']],
    ['선택한 것 지면 위 2 m로', ['set selection lift=2']],
    ['방금 만든 것 아래로 1 m 내려', ['move last by=0,-1,0']],
    ['x를 10으로, y는 3으로', ['set it x=10 y=3']],
    ['선택한 것 서쪽으로 2.5미터', ['move selection by=-2.5,0,0']],
    ['크기를 1.5로', ['set it scale=1.5']],
    ['선택한 것 n4로 이동', ['move selection to=node:n4']],
    ['그것 n4의 남쪽으로 옮겨', ['move it to=south(node:n4)']],
  ],
  'transform · en': [
    ['move the selection 5 m east and turn it 30°', ['move selection by=5,0,0', 'rotate selection by=30']],
    ['move it 3 m north', ['move it by=0,0,-3']],
    ['raise the selection by 0.5 m', ['move selection by=0,0.5,0']],
    ['move it to n4', ['move it to=node:n4']],
    ['rotate it 90 degrees clockwise', ['rotate it by=-90']],
    ['double the selection', ['scale selection x2']],
    ['halve the selection', ['scale selection x0.5']],
    ['set x to 10', ['set it x=10']],
    ['set the heading to 90°', ['set it heading=90']],
    ['drop it to the ground', ['set it lift=0']],
    ['move these buildings 2 m south', ['move selection by=0,0,2']],
    ['turn it 45° counter-clockwise', ['rotate it by=45']],
    ['turn the selection around', ['rotate selection by=180']],
    ['make it 10% bigger', ['scale it x1.1']],
    ['twice as big', ['scale it x2']],
    ['set it 2 m above the ground', ['set it lift=2']],
    ['lower the new ones by 1 m', ['move last by=0,-1,0']],
    ['set x to 10 and y to 3', ['set it x=10 y=3']],
    ['move the selection 2.5 metres west', ['move selection by=-2.5,0,0']],
    ['move it next to #b1', ['move it to=next(#b1)']],
    ['move it to the south of n4', ['move it to=south(node:n4)']],
    ['Move all trees up 2 m', ['move type:tree by=0,2,0']],
  ],
  // §3.5 align · distribute · match
  'align · ko': [
    ['이 건물들 바닥면 기준으로 앞쪽 맞춰', ['align selection edge=front ref=footprint']],
    ['선택한 것 서쪽 끝 맞춰', ['align selection axis=x mode=min ref=origin']],
    ['동쪽으로 정렬', ['align it axis=x mode=max ref=origin']],
    ['북쪽 맞춰', ['align it axis=z mode=min ref=origin']],
    ['가로 가운데 정렬', ['align it axis=x mode=center ref=origin']],
    ['뒤쪽 맞춰, 원점 기준', ['align it edge=back ref=origin']],
    ['선택한 것 같은 간격으로', ['distribute selection axis=auto gaps']],
    ['남북으로 고르게', ['distribute it axis=z gaps']],
    ['가로로 균등하게, 원점 간격', ['distribute it axis=x']],
    ['같은 방향으로', ['match it heading']],
    ['같은 높이로 맞춰', ['match it height']],
    ['같은 크기로', ['match it scale']],
    ['같은 방향으로 첫 번째 것에 맞춰', ['match it heading to=(selection first 1)']],
    ['#b1처럼 같은 높이로', ['match it height to=#b1']],
    ['선택한 것 아래쪽 맞춰', ['align selection axis=z mode=max ref=origin']],
    ['#b1처럼 같은 크기로', ['match it scale to=#b1']],
  ],
  'align · en': [
    ["align these buildings' fronts by footprint", ['align selection edge=front ref=footprint']],
    ["align the selection's west edges", ['align selection axis=x mode=min ref=origin']],
    ['align them to the east', ['align it axis=x mode=max ref=origin']],
    ['line up the north edges', ['align it axis=z mode=min ref=origin']],
    ['align centres on x', ['align it axis=x mode=center ref=origin']],
    ['align the backs by origin', ['align it edge=back ref=origin']],
    ['space them evenly', ['distribute it axis=auto gaps']],
    ['distribute the selection north-south', ['distribute selection axis=z gaps']],
    ['distribute them horizontally by origins', ['distribute it axis=x']],
    ['same heading', ['match it heading']],
    ['give them the same height', ['match it height']],
    ['make them the same size', ['match it scale']],
    ['the same heading as the first one', ['match it heading to=(selection first 1)']],
    ['same height as #b1', ['match it height to=#b1']],
    ['align the bottoms of the selection', ['align selection axis=z mode=max ref=origin']],
    ['face the same way', ['match it heading']],
  ],
  // §3.6 properties (copy), §6 D9 D10 D35
  'properties · ko': [
    ['첫 번째 건물이랑 같은 구조로', ['copy structure from=(selection first 1) to=selection']],
    ['#b1과 같은 구조로', ['copy structure from=#b1 to=selection']],
    ['가장 큰 건물처럼 같은 물성으로', ['copy physics from=(type:building largest) to=selection']],
    ['첫 번째 것과 같은 크기와 방향으로', ['copy scale,heading from=(selection first 1) to=selection']],
    ['#b1의 방향을 복사해', ['copy heading from=#b1 to=selection']],
    ['선택한 것을 #b1이랑 같은 매개변수로', ['copy params from=#b1 to=selection']],
    ['#b1의 크기 복사', ['copy scale from=#b1 to=selection']],
    ['방금 만든 것 첫 번째 건물이랑 같은 구조로', ['copy structure from=(selection first 1) to=last']],
  ],
  'properties · en': [
    ['give them the same structure as the first one', ['copy structure from=(selection first 1) to=it']],
    ['copy the structure of #b1', ['copy structure from=#b1 to=selection']],
    ['copy the physics of the largest building', ['copy physics from=(type:building largest) to=selection']],
    ['copy the size and heading of the first one', ['copy scale,heading from=(selection first 1) to=selection']],
    ['copy the heading of #b1', ['copy heading from=#b1 to=selection']],
    ['give the selection the same parameters as #b1', ['copy params from=#b1 to=selection']],
    ['copy the size of #b1', ['copy scale from=#b1 to=selection']],
    ['give the new ones the same structure as the first building', ['copy structure from=(selection first 1) to=last']],
    ['same structure as the largest building', ['copy structure from=(type:building largest) to=selection']],
    ['copy the material properties from #b1', ['copy physics from=#b1 to=selection']],
  ],
  // §3.7 group · name
  'group · ko': [
    ["묶어서 '북쪽 블록'이라고 해", ['group it name="북쪽 블록"']],
    ["방금 만든 건물들 그룹으로 묶고 이름을 '북쪽 블록'으로", ['group last name="북쪽 블록"']],
    ['선택한 것 묶어', ['group selection']],
    ['그룹 풀어', ['ungroup it']],
    ["이름을 '창고 A'로 바꿔", ['rename it "창고 A"']],
    ["이것을 '정문'이라고 불러", ['rename selection "정문"']],
    ["'북쪽 블록' 그룹 풀어", ['ungroup group:"북쪽 블록"']],
    ['나무 전부 그룹으로 묶어', ['group type:tree']],
    ['주택 세 채 놓고 묶어', ['place building:house count=3', 'group last']],
    ['선택한 것 그룹 만들어', ['group selection']],
    ["이것들 묶어서 이름을 '남쪽'으로", ['group selection name="남쪽"']],
  ],
  'group · en': [
    ['group them as "North block"', ['group it name="North block"']],
    ['group the selection', ['group selection']],
    ['ungroup them', ['ungroup it']],
    ['rename it to "Depot A"', ['rename it "Depot A"']],
    ['call this "Main gate"', ['rename selection "Main gate"']],
    ['group all trees', ['group type:tree']],
    ['ungroup the group "North block"', ['ungroup group:"North block"']],
    ['group the new ones called "Row 1"', ['group last name="Row 1"']],
    ['place three houses and group them', ['place building:house count=3', 'group last']],
    ['name it "Shed"', ['rename it "Shed"']],
    ['group these buildings named "East"', ['group selection name="East"']],
  ],
  // §3.7 hide · lock · delete · duplicate
  'hide · ko': [
    ['나무 전부 숨겨', ['hide type:tree']],
    ['숨긴 것 다시 보여 줘', ['show all where hidden']],
    ['선택한 것 잠가', ['lock selection']],
    ['잠금 풀어', ['unlock it']],
    ['이것 지워', ['delete selection']],
    ['차 전부 삭제해', ['delete type:car']],
    ['선택한 것 복제', ['duplicate selection']],
    ['동쪽으로 10 m 떨어뜨려 복제', ['duplicate it offset=10,0']],
    ['나무 다시 보이게 해', ['show type:tree']],
    ['건물 잠금 해제', ['unlock type:building']],
    ['방금 만든 것 없애', ['delete last']],
    ['가로등 감춰', ['hide type:streetLight']],
    ['선택한 것 북쪽으로 5 m 떨어뜨려 복제', ['duplicate selection offset=0,-5']],
    ['숨김 해제', ['show it']],
    ['도로 위의 차 제거해', ['delete type:car where on road']],
    ['복사해서 동쪽에 10 m 놓아', ['duplicate it offset=10,0']],
    ['나무 지워', ['delete type:tree']],
    ['건물 잠가', ['lock type:building']],
  ],
  'hide · en': [
    ['hide all trees', ['hide type:tree']],
    ['show hidden', ['show all where hidden']],
    ['lock the selection', ['lock selection']],
    ['unlock them', ['unlock it']],
    ['delete this', ['delete selection']],
    ['remove all cars', ['delete type:car']],
    ['duplicate the selection', ['duplicate selection']],
    ['duplicate it 10 m east', ['duplicate it offset=10,0']],
    ['make the trees visible again', ['show type:tree']],
    ['unlock the buildings', ['unlock type:building']],
    ['get rid of the new ones', ['delete last']],
    ['hide the street lights', ['hide type:streetLight']],
    ['copy them 5 m north', ['duplicate it offset=0,-5']],
    ['unhide everything', ['show all']],
    ['erase the cars on the road', ['delete type:car where on road']],
    ['delete tree', ['delete type:tree']],
  ],
  // §3.9 terrain · paint
  'terrain · ko': [
    ['여기 반경 10 m 평평하게', ['terrain flatten circle cursor r=10']],
    ['여기 반경 10 m 땅을 2 m 올려', ['terrain raise circle cursor r=10 by=2']],
    ['n4 반경 5 m 1 m 파', ['terrain lower circle node:n4 r=5 by=1']],
    ['언덕을 부드럽게', ['terrain smooth feature:hill']],
    ['여기 반경 8 m 높이 3 m로 평탄화', ['terrain flatten circle cursor r=8 to=3']],
    ['(0, 0)에서 (20, 20)까지 평평하게', ['terrain flatten rect 0,0,20,20']],
    ['선택한 것 주변 4 m 평평하게', ['terrain flatten around selection r=4']],
    ['여기 반경 10 m 잔디로 칠해', ['paint circle cursor r=10 ground=grass']],
    ['가운데 반경 6 m 바닥을 아스팔트로', ['paint circle center r=6 ground=asphalt']],
    ['여기 지름 20 m 낮춰', ['terrain lower circle cursor r=10']],
    ['호수를 모래로 칠해', ['paint feature:lake ground=sand']],
    ['여기 반경 10 m 평평하게 하고 잔디로 칠해', ['terrain flatten circle cursor r=10', 'paint circle cursor r=10 ground=grass']],
    ['여기 반경 5 m 높여', ['terrain raise circle cursor r=5']],
  ],
  'terrain · en': [
    ['flatten a 10 m circle here', ['terrain flatten circle cursor r=10']],
    ['raise the ground within 10 m of here by 2 m', ['terrain raise circle cursor r=10 by=2']],
    ['dig a 5 m circle at n4 by 1 m', ['terrain lower circle node:n4 r=5 by=1']],
    ['smooth the hill', ['terrain smooth feature:hill']],
    ['flatten a 8 m circle here to 3 m', ['terrain flatten circle cursor r=8 to=3']],
    ['flatten the rectangle from (0, 0) to (20, 20)', ['terrain flatten rect 0,0,20,20']],
    ['level 4 m around the selection', ['terrain flatten around selection r=4']],
    ['paint a 10 m circle here with grass', ['paint circle cursor r=10 ground=grass']],
    ['paint a 6 m circle at the centre asphalt', ['paint circle center r=6 ground=asphalt']],
    ['lower the ground 20 m across here', ['terrain lower circle cursor r=10']],
    ['paint the lake sand', ['paint feature:lake ground=sand']],
    ['flatten a 10 m circle here and paint it with grass', ['terrain flatten circle cursor r=10', 'paint circle cursor r=10 ground=grass']],
    ['raise a 5 m circle here', ['terrain raise circle cursor r=5']],
  ],
  // §3.8 roads
  'road · ko': [
    ['n4에서 (40, 60)까지 2차로 도로', ['road node:n4 -> 40,60 preset=street']],
    ['n1에서 n2까지 도로 만들어', ['road node:n1 -> node:n2']],
    ['여기에서 교차로까지 4차로 도로 그려', ['road cursor -> junction preset=avenue']],
    ['(0, 0)에서 (50, 0)까지 좁은 도로 깔아', ['road 0,0 -> 50,0 preset=narrow']],
    ['n3부터 n5까지 골목길', ['road node:n3 -> node:n5 preset=lane']],
    ['n1에서 저기까지 자갈길 놓아', ['road node:n1 -> view preset=gravel']],
    ['가운데에서 n2까지 넓은 도로', ['road center -> node:n2 preset=wide']],
    ['n1에서 n6까지 흙길', ['road node:n1 -> node:n6 preset=dirt']],
  ],
  'road · en': [
    ['a two-lane road from n4 to (40, 60)', ['road node:n4 -> 40,60 preset=street']],
    ['draw a road from n1 to n2', ['road node:n1 -> node:n2']],
    ['build a four-lane road from here to the junction', ['road cursor -> junction preset=avenue']],
    ['a narrow road from (0, 0) to (50, 0)', ['road 0,0 -> 50,0 preset=narrow']],
    ['an alley from n3 to n5', ['road node:n3 -> node:n5 preset=lane']],
    ['a gravel road from n1 to over there', ['road node:n1 -> view preset=gravel']],
    ['a wide road from the centre to n2', ['road center -> node:n2 preset=wide']],
    ['a dirt road from n1 to n6', ['road node:n1 -> node:n6 preset=dirt']],
  ],
  // §2.2, §3.10 disasters; §6 D1 D2 D30
  'disaster · ko': [
    ['교차로에 폭발 1.8×10⁹ J, 5초 뒤', ['disaster blast at=junction energy=1.8e9 start=5']],
    ['교차로 n4에 폭발 1.8e9 J, 5초 뒤', ['disaster blast at=node:n4 energy=1.8e9 start=5']],
    ['여기에 규모 7 지진', ['disaster earthquake at=cursor magnitude=7']],
    ['폭발을 일으켜', ['disaster blast now']],
    ['n4에 TNT 500 kg 폭발', ['disaster blast at=node:n4 energy=2.092e9']],
    ['여기에 화재, 반경 3 m, 10분 동안', ['disaster fire at=cursor duration=600 radius=3']],
    ['운석 지름 2 m, 속도 20 km/s, 각도 45도', ['disaster impact angle=45 diameter=2 speed=20000']],
    ['가운데에 싱크홀 반경 5 m 놓아', ['disaster sinkhole at=center cavityRadius=5']],
    ['교차로에 바람 30 m/s', ['disaster wind at=junction speed=30']],
    ['동풍 20 m/s 30초 동안', ['disaster wind direction=E duration=30 speed=20']],
    ['규모 7 지진을 발생시켜', ['disaster earthquake magnitude=7 now']],
    ['여기에 규모 7 지진을 일으켜', ['disaster earthquake at=cursor magnitude=7 now']],
    ['여기에 토네이도 풍속 60 m/s 발생시켜', ['disaster tornado at=cursor maxSpeed=60 now']],
    ['무중력', ['disaster gravity magnitude=0']],
    ['여기에 열원 50 kW 5분 동안', ['disaster heatSource at=cursor duration=300 power=50000']],
    ['폭염', ['disaster climate scenario=heatwave']],
    ['여기에 2 m 침하 반경 10 m', ['disaster terrainDeformation at=cursor amount=2 kind=subsidence radius=10']],
    ['중앙에 초당 5세제곱미터의 물을 공급해줘', ['disaster waterSource at=center duration=600 rate=5 now']],
    ['화산 초당 3 m³ 20분 동안', ['disaster volcano duration=1200 rate=3']],
    ['서쪽 경계에서 수위 2 m', ['disaster risingWater boundary=W level=2']],
    ['블랙홀을 저기에 놓아', ['disaster celestial at=view']],
    ['18억 J 폭발을 n4에서 터뜨려', ['disaster blast at=node:n4 energy=1.8e9 now']],
    ['교차로에 풍속 30 m/s 바람을 일으켜', ['disaster wind at=junction direction=E duration=60 speed=30 now']],
    ['n4에 blast', ['disaster blast at=node:n4']],
  ],
  'disaster · en': [
    ['a 1.8e9 J explosion at the junction in 5 s', ['disaster blast at=junction energy=1.8e9 start=5']],
    ['an explosion at n4 with 1.8 GJ', ['disaster blast at=node:n4 energy=1.8e9']],
    ['a magnitude 7 earthquake here', ['disaster earthquake at=cursor magnitude=7']],
    ['make an explosion', ['disaster blast now']],
    ['an explosion of TNT 500 kg at n4', ['disaster blast at=node:n4 energy=2.092e9']],
    ['a fire here, radius 3 m, for 10 minutes', ['disaster fire at=cursor duration=600 radius=3']],
    ['a meteor with diameter 2 m, speed 20 km/s, angle 45°', ['disaster impact angle=45 diameter=2 speed=20000']],
    ['put a sinkhole at the centre, radius 5 m', ['disaster sinkhole at=center cavityRadius=5']],
    ['wind 30 m/s at the junction', ['disaster wind at=junction speed=30']],
    ['an easterly wind of 20 m/s for 30 seconds', ['disaster wind direction=E duration=30 speed=20']],
    ['trigger a magnitude 7 earthquake', ['disaster earthquake magnitude=7 now']],
    ['make an earthquake', ['disaster earthquake magnitude=6.5 now']],
    ['unleash a tornado here with wind speed 60 m/s', ['disaster tornado at=cursor maxSpeed=60 now']],
    ['zero gravity', ['disaster gravity magnitude=0']],
    ['a 50 kW heat source here for 5 minutes', ['disaster heatSource at=cursor duration=300 power=50000']],
    ['a heat wave', ['disaster climate scenario=heatwave']],
    ['a 1.8e9 J explosion at a height of 20 m at n4', ['disaster blast at=node:n4 energy=1.8e9 height=20']],
    ['start a flood from the west', ['disaster risingWater boundary=W level=1.5 riseRate=0.5 now']],
    ['a volcano here, 3 m³/s for 20 minutes', ['disaster volcano at=cursor duration=1200 rate=3']],
    ['wind from the east at 25 m/s', ['disaster wind direction=E speed=25']],
    ['place a black hole over there', ['disaster celestial at=view']],
    ['an M7 earthquake at the junction', ['disaster earthquake at=junction magnitude=7']],
    ['gravity 3 m/s²', ['disaster gravity magnitude=3']],
    ['rain at the junction', ['disaster rain at=junction']],
    ['wind toward the east at 10 m/s', ['disaster wind direction=W speed=10']],
  ],
  // §3.11 run control; §6 D16 D17
  'run control · ko': [
    ['실행', ['run']], ['시작해', ['run']], ['재생', ['run']], ['돌려', ['run']], ['멈춰', ['pause']], ['일시정지', ['pause']], ['잠깐', ['pause']], ['정지', ['pause']],
    ['처음으로', ['reset']], ['초기화해 줘', ['reset']], ['다시 처음부터', ['reset']], ['2배속', ['speed=2']], ['속도 4배', ['speed=4']], ['절반 속도', ['speed=0.5']],
    ['정상 속도', ['speed=1']], ['1배속', ['speed=1']], ['계속', ['run']], ['재개', ['run']], ['다시 시작', ['reset']], ['전부 멈춰', ['pause']], ['시뮬레이션 시작', ['run']],
  ],
  'run control · en': [
    ['run', ['run']], ['start', ['run']], ['play', ['run']], ['go', ['run']], ['pause', ['pause']], ['stop', ['pause']], ['hold', ['pause']],
    ['reset', ['reset']], ['restart', ['reset']], ['start over', ['reset']], ['speed 2×', ['speed=2']], ['2 times speed', ['speed=2']], ['2x', ['speed=2']],
    ['half speed', ['speed=0.5']], ['normal speed', ['speed=1']], ['resume', ['run']], ['continue', ['run']], ['stop everything', ['pause']], ['start the simulation', ['run']],
    ['Pause, please.', ['pause']],
  ],
  // §3.11 placed disasters; §6 D15
  'instance · ko': [
    ['지진 멈춰', ['disaster earthquake stop']],
    ['지진 멈춰, 화재 #3 지워', ['disaster earthquake stop', 'disaster fire#3 delete']],
    ['비 멈춰', ['disaster rain stop']],
    ['지진 일시정지', ['disaster earthquake pause']],
    ['폭발 지워', ['disaster blast delete']],
    ['p3 삭제', ['disaster p3 delete']],
    ['재난 p2 멈춰', ['disaster p2 stop']],
    ['3번 화재 없애', ['disaster fire#3 delete']],
    ['세 번째 화재 삭제', ['disaster fire#3 delete']],
    ['재난 전부 멈춰', ['disaster all stop']],
    ['모든 재난 삭제', ['disaster all delete']],
    ['지진 계속', ['disaster earthquake resume']],
    ['지진 다시 시작', ['disaster earthquake resume']],
    ['화재를 n4로 옮겨', ['disaster fire move to=node:n4']],
    ['바람을 멈춰', ['disaster wind stop']],
    ['지진 취소', ['disaster earthquake delete']],
    ['#p3 재개', ['disaster p3 resume']],
  ],
  'instance · en': [
    ['stop the earthquake', ['disaster earthquake stop']],
    ['stop the earthquake, delete fire #3', ['disaster earthquake stop', 'disaster fire#3 delete']],
    ['stop the rain', ['disaster rain stop']],
    ['pause the earthquake', ['disaster earthquake pause']],
    ['remove the explosion', ['disaster blast delete']],
    ['delete p3', ['disaster p3 delete']],
    ['stop disaster P2', ['disaster p2 stop']],
    ['delete the third fire', ['disaster fire#3 delete']],
    ['stop all disasters', ['disaster all stop']],
    ['resume the earthquake', ['disaster earthquake resume']],
    ['continue the fire', ['disaster fire resume']],
    ['move the fire to n4', ['disaster fire move to=node:n4']],
    ['stop the wind', ['disaster wind stop']],
    ['cancel the fire', ['disaster fire delete']],
    ['resume #p3', ['disaster p3 resume']],
  ],
  // §3.12 camera; §6 D11 D33
  'camera · ko': [
    ['가장 높은 건물 보여 줘', ['focus type:building tallest']],
    ['n4로 가', ['focus at=node:n4']],
    ['선택한 것 보여 줘', ['focus selection']],
    ['여기 봐', ['focus at=cursor']],
    ['교차로로 이동', ['focus at=junction']],
    ['가장 큰 건물 확대', ['focus type:building largest']],
    ['나무 보여 줘', ['focus type:tree']],
    ['가운데로 가 줘', ['focus at=center']],
    ['#b1 봐', ['focus #b1']],
    ['가장 가까운 나무 보여 줘', ['focus type:tree nearest cursor']],
    ['(40, 60)으로 가', ['focus at=40,60']],
    ['방금 만든 것 보여 줘', ['focus last']],
    ['N4로 가', ['focus at=node:n4']],
  ],
  'camera · en': [
    ['show me the tallest building', ['focus type:building tallest']],
    ['go to n4', ['focus at=node:n4']],
    ['show me the selection', ['focus selection']],
    ['look at the junction', ['focus at=junction']],
    ['zoom to the largest building', ['focus type:building largest']],
    ['focus on building', ['focus type:building']],
    ['go to the centre', ['focus at=center']],
    ['look at #b1', ['focus #b1']],
    ['show me the nearest tree', ['focus type:tree nearest cursor']],
    ['go to (40, 60)', ['focus at=40,60']],
    ['zoom to the new ones', ['focus last']],
    ['show me the hill', ['focus at=feature:hill']],
    ['zoom to tree', ['focus type:tree']],
  ],
  // §3.13 queries; §6 D26 D31
  'query · ko': [
    ['건물 몇 채야?', ['count type:building']],
    ['가새 경고 있는 건물은?', ['list type:building where warning=brace']],
    ['건물 몇 채야? 가새 경고 있는 건물은?', ['count type:building', 'list type:building where warning=brace']],
    ['나무 몇 그루?', ['count type:tree']],
    ['재난 몇 개야?', ['count disasters']],
    ['그룹 몇 개?', ['count groups']],
    ['도로 몇 개 있어?', ['count roads']],
    ['숨긴 것 목록', ['list all where hidden']],
    ['재난 목록', ['list disasters']],
    ['n1에서 n4까지 거리', ['measure node:n1 node:n4']],
    ['이 건물 높이는?', ['measure selection']],
    ['이거 뭐야?', ['info selection']],
    ['피해 알려 줘', ['info sim']],
    ['선택한 것 정보', ['info selection']],
    ['도로 위의 차 몇 대야?', ['count type:car where on road']],
    ['가장 높은 건물 크기는?', ['measure type:building tallest']],
    ['여기서 교차로까지 얼마나 떨어져 있어?', ['measure cursor junction']],
    ['나무 몇 그루야? 숨긴 것은?', ['count type:tree', 'list type:tree where hidden']],
  ],
  'query · en': [
    ['how many buildings?', ['count type:building']],
    ['which have brace warnings?', ['list all where warning=brace']],
    ['how many buildings? which have brace warnings?', ['count type:building', 'list type:building where warning=brace']],
    ['how many trees are there?', ['count type:tree']],
    ['how many disasters?', ['count disasters']],
    ['how many groups', ['count groups']],
    ['how many roads are there', ['count roads']],
    ['list the hidden ones', ['list all where hidden']],
    ['list the disasters', ['list disasters']],
    ['how far is it from n1 to n4?', ['measure node:n1 node:n4']],
    ['how tall is this building?', ['measure selection']],
    ['what is this?', ['info selection']],
    ['damage', ['info sim']],
    ['tell me about the selection', ['info selection']],
    ['how many cars are on the road?', ['count type:car where on road']],
    ['how big is the tallest building?', ['measure type:building tallest']],
    ['distance between here and the junction', ['measure cursor junction']],
    ['which buildings are locked?', ['list type:building where locked']],
  ],
  // §3.14 undo
  'undo · ko': [
    ['방금 거 취소', ['undo']], ['되돌려', ['undo']], ['취소', ['undo']], ['취소해', ['undo']], ['실행 취소', ['undo']], ['되돌려 줘', ['undo']],
    ['다시 실행', ['redo']], ['다시 해', ['redo']], ['되살려', ['redo']], ['실행취소', ['undo']],
  ],
  'undo · en': [
    ['undo', ['undo']], ['undo that', ['undo']], ['take that back', ['undo']], ['revert that', ['undo']], ['undo it', ['undo']], ['please undo', ['undo']],
    ['redo', ['redo']], ['redo that', ['redo']], ['Undo.', ['undo']],
  ],
  // §4 clauses and fragments; references; places relative to objects (more forms of the classes above)
  'more forms · ko': [
    ['홍수, 수위 3 m, 서쪽 경계', ['disaster risingWater boundary=W level=3']],
    ['홍수 수위 2 m, 분당 0.3 m', ['disaster risingWater level=2 riseRate=0.3']],
    ['여기에 지반 침하 반경 15 m, 1 m 침하', ['disaster terrainDeformation at=cursor amount=1 kind=subsidence radius=15']],
    ["선택한 것 묶어서 'A 구역'이라고 하고 잠가", ['group selection name="A 구역"', 'lock selection']],
    ['4배속, 재생', ['speed=4', 'run']],
    ['선택한 것 45도 돌리고 절반으로', ['rotate selection by=45', 'scale selection x0.5']],
    ['이 나무들 가장 큰 건물과 같은 크기로', ['match selection scale to=(type:building largest)']],
    ['방금 만든 건물들 첫 번째 건물이랑 같은 구조와 물성으로', ['copy structure,physics from=(selection first 1) to=last']],
    ['선택에서 차들 빼 줘', ['remove type:car']],
    ['선택에 나무 전부 추가', ['add type:tree']],
    ['좌표 10, 20에서 좌표 30, 20까지 도로', ['road 10,20 -> 30,20']],
    ['100,200에 나무', ['place tree at=100,200']],
    ['여기에 TNT 1,800 kg 폭발', ['disaster blast at=cursor energy=7.5312e9']],
    ['경사 15도 아래 건물 선택', ['select type:building where slope<15']],
    ['이것 #b1의 북쪽으로 옮겨', ['move selection to=north(#b1)']],
    ['선택한 것 북쪽 4 m에 나무 한 그루', ['place tree at=north(selection,4)']],
    ['주택 다섯 채 지으세요', ['place building:house count=5']],
    ['나무 몇 그루 있습니까?', ['count type:tree']],
    ['이 건물들 방향을 45도로 해', ['set selection heading=45']],
  ],
  'more forms · en': [
    ['a flood, water level 2 m, southern boundary', ['disaster risingWater boundary=S level=2']],
    ['speed 4×, then pause', ['speed=4', 'pause']],
    ['give them the same height, like #b1', ['match it height to=#b1']],
    ['group these buildings, called "West"', ['group selection name="West"']],
    ['copy the structure, physics and parameters of #b1', ['copy structure,physics,params from=#b1 to=selection']],
    ['give it the same size and heading as #b1', ['copy scale,heading from=#b1 to=it']],
    ['centre them vertically', ['align it axis=z mode=center ref=origin']],
    ['centre the selection horizontally', ['align selection axis=x mode=center ref=origin']],
    ['go to 10, -5', ['focus at=10,-5']],
    ['select every 3-storey office', ['select type:building:office where floors=3']],
    ['move it there', ['move it to=view']],
    ['set the heading of the selection to 45°', ['set selection heading=45']],
    ['set the scale of these buildings to 2', ['set selection scale=2']],
    ['put it 1 m above the ground', ['set it lift=1']],
    ['drop the selection to the ground', ['set selection lift=0']],
    ['move it to the west of #b1', ['move it to=west(#b1)']],
    ['a crate west of the group "Yard"', ['place crate at=west(group:"Yard")']],
    ['two trees 3 m south of the selection', ['place tree count=2 at=south(selection,3)']],
    ['how many buildings have at least 3 floors?', ['count type:building where floors>=3']],
    ['how many trees are there? which are hidden?', ['count type:tree', 'list type:tree where hidden']],
    ['distance between the selection and n4', ['measure selection node:n4']],
    ['make a forest within 25 m of n4', ['forest circle node:n4 r=25']],
    ['a forest in a circle 40 m across here', ['forest circle cursor r=20']],
  ],
  // §5 old run-now sentences (typed by the existing Chrome scripts) — legacy form, §6 D1
  'legacy run-now': [
    ['시간당 80mm의 비를 30분 동안 내려줘 그리고 서쪽 경계에서 수위를 0.8m까지 올려줘', ['disaster rain duration=1800 intensity=80 now', 'disaster risingWater boundary=W level=0.8 riseRate=0.5 now']],
    ['Start rainfall at 80 mm/h for 30 minutes then raise the western boundary water level to 0.8 meters', ['disaster rain duration=1800 intensity=80 now', 'disaster risingWater boundary=W level=0.8 riseRate=0.5 now']],
    ['폭발을 일으켜', ['disaster blast now']],
    ['make an explosion', ['disaster blast now']],
    ['태풍을 발생시키고 10초 후 지진을 발생시켜', ['disaster wind direction=E duration=60 speed=40 now', 'disaster earthquake magnitude=6.5 start=10 now']],
    ['Start an earthquake 10 seconds after the typhoon begins', ['disaster earthquake magnitude=6.5 start=10 now']],
  ],
};

/** One piece is missing (§0, §3, §6): the slot that is asked for. */
const ASKS: [string, AskSlot][] = [
  ['5 m 옮겨', 'direction'], ['동쪽으로 옮겨', 'amount'], ['북동쪽으로 5 m', 'direction'], ['왼쪽으로 3 m 옮겨', 'direction'], ['조금만 옮겨', 'amount'],
  ['회전', 'amount'], ['이것 돌려', 'amount'], ['더 크게', 'amount'], ['이름 바꿔', 'name'], ['맞춰', 'axis'], ['n4에서 도로 만들어', 'place'], ['도로 만들어', 'place'],
  ['중력 0.5 g', 'field'], ['여기에 다섯 대 놓아', 'kind'], ['세 그루 심어', 'kind'], ['숲을 만들어', 'place'], ['여기를 평평하게', 'amount'], ['땅을 2 m 올려', 'place'],
  ['같은 구조로', 'target'], ['첫 번째 건물이랑 같게', 'field'], ['선택한 것 동쪽으로 옮기고 30도 회전', 'amount'], ['선택한 것 동쪽으로 5 옮겨', 'amount'], ['30 회전', 'amount'],
  ['폭발 5', 'field'], ['선택한 것 10으로 설정해', 'field'], ['더 빠르게', 'amount'], ['p3 옮겨', 'place'], ['여기에 숲을 만들어', 'amount'], ['여기를 잔디로 칠해', 'amount'],
  ['주택 세 채 놓고 이름 바꿔', 'name'], ['여기에 세 개 놓아', 'kind'],
  ['move it 5 m', 'direction'], ['move it east', 'amount'], ['move it 5 m north-east', 'direction'], ['move it 3 m left', 'direction'], ['rotate it', 'amount'],
  ['make it bigger', 'amount'], ['rename it', 'name'], ['align them', 'axis'], ['draw a road from n4', 'place'], ['build a road', 'place'], ['plant a forest', 'place'],
  ['flatten here', 'amount'], ['copy the structure', 'target'], ['plant three', 'kind'], ['park five here', 'kind'], ['an explosion 5', 'field'], ['a forest here', 'amount'],
  ['paint here with grass', 'amount'], ['paint over there with sand', 'amount'], ['move it a bit', 'amount'], ['scale it', 'amount'], ['gravity 0.5 g', 'field'],
  ['move the selection east and turn it 30°', 'amount'],
  // a name that is not in quotes is asked for, never guessed
  ['rename it to Shed', 'name'], ['이것 5 m 옮기고 두 배로', 'direction'], ['make it faster', 'amount'],
];

/** Nothing may run (§5, §6): unrelated text, negation, unsupported edits, conditionals, two kinds, traps. */
const UNKNOWNS: string[] = [
  // unrelated text, greetings, questions about the app
  '안녕', 'hello there', '오늘 날씨 어때?', 'what can you do?', '고마워', 'asdf qwer',
  // negation and prohibition
  '나무는 지우지 마', "don't delete the trees", '나무 빼고 전부 지워', 'delete everything except the trees', '건물 말고 나무 숨겨', 'hide the trees but not the cars',
  'never delete the selection', '차는 옮기지 마세요', 'do not move it 5 m east', '나무 안 지워', 'delete all trees without the pines',
  // unsupported edits
  '건물을 빨간색으로 칠해', 'make the house red', '저장해', 'save the world', '새 월드 만들어', 'load the template', '재질을 콘크리트로 바꿔',
  // conditionals and loops
  '비가 오면 실행', 'if it rains run', '5초마다 회전', 'rotate it 30° every 5 seconds', 'pause until the fire stops', '지진이 나면 멈춰',
  // two kinds in one target
  '나무랑 차 지워', 'delete the trees and cars', '나무와 가로등 숨겨', '나무하고 차 선택', 'hide trees and street lights',
  // facing words, a fixed gap afterwards, floors of a tree
  '북쪽을 보게 주택 한 채', 'a house facing north', '간격 2 m로 균등하게', '2층 나무 세 그루',
  // §6 D8, D19, D21, D22, D29
  '여기 반경 10 m를 3 m로 올려', 'raise it to 3 m', '언덕에 소나무 숲', 'a pine forest', '화재 보여 줘', '큰길 보여 줘', '도로 지워', 'show me the fire', 'delete the road',
  '6차로 도로 n1에서 n2까지', '여기 반경 5 m 눈으로 칠해',
  // a command is never built from part of a sentence (the leftover rule)
  '주택 세 채 놓고 블라블라', 'delete selection now', 'rotate the selection 30° purple', '나무 숨겨 그리고 커피 주문', 'run now', '선택한 것 동쪽으로 5 m 파랗게',
  // loading is not supported ("불러와" is not "불러" + a particle); two commands with nothing between them
  '불러와', '템플릿 불러와', '2배속 실행', 'run 5', '화재 #3', 'thanks', 'the third fire',
  // canonical syntax that does not parse is an error of that syntax
  'place building count=three', 'move selection by=5,0', 'select type:tree and then delete them',
];

describe('parseCommand', () => {
  for (const [name, cases] of Object.entries(CLASSES)) {
    it(`${name} (${cases.length} sentences)`, () => {
      if (!name.startsWith('legacy')) expect(cases.length).toBeGreaterThanOrEqual(8);
      const bad: string[] = [];
      for (const [text, want] of cases) {
        const o = parseCommand(text);
        if (o.kind !== 'ok' || o.canonical.join(' | ') !== want.join(' | ')) bad.push(`${text}\n      want ${want.join(' | ')}\n      got  ${show(o)}`);
      }
      expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
    });
  }

  it('one missing piece → ask for exactly that piece; nothing runs', () => {
    const bad: string[] = [];
    for (const [text, slot] of ASKS) {
      const o = parseCommand(text);
      if (o.kind !== 'ask' || o.slot !== slot) bad.push(`${text}: want ask ${slot}, got ${show(o)}`);
      else {
        expect(o.question.key).toBe(`cmd37.nl.ask.${slot}`);
        expect(o.understood.length).toBeGreaterThan(0);
      }
    }
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
  });

  it('not understood, negated, conditional, unsupported → unknown with 2–3 canonical suggestions; never a command', () => {
    const bad: string[] = [];
    for (const text of UNKNOWNS) {
      const o = parseCommand(text);
      if (o.kind !== 'unknown') { bad.push(`${text}: got ${show(o)}`); continue; }
      expect(o.suggestions.length, text).toBeGreaterThanOrEqual(2);
      expect(o.suggestions.length, text).toBeLessThanOrEqual(3);
      for (const s of o.suggestions) expect(parseCanonical(s).ok, `${text} → ${s}`).toBe(true);
    }
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
    expect(parseCommand('').kind).toBe('unknown');
    expect(parseCommand('   ').kind).toBe('unknown');
  });

  it('every returned intent validates and is exactly what its canonical text parses to', () => {
    let n = 0;
    for (const cases of Object.values(CLASSES)) {
      for (const [text] of cases) {
        const o = parseCommand(text);
        if (o.kind !== 'ok') continue;
        expect(validateIntents(o.intents).ok, text).toBe(true);
        expect(o.canonical.length).toBe(o.intents.length);
        o.intents.forEach((intent, k) => {
          expect(formatCanonical(intent), text).toBe(o.canonical[k]);
          const back = parseCanonical(o.canonical[k]);
          expect(back.ok && back.intent, text).toEqual(intent);
          n++;
        });
      }
    }
    expect(n).toBeGreaterThan(500);
  });

  it('deterministic: the same text twice gives deep-equal outcomes', () => {
    const texts = [...Object.values(CLASSES).flat().map((c) => c[0]), ...ASKS.map((a) => a[0]), ...UNKNOWNS];
    for (const text of texts) expect(parseCommand(text), text).toEqual(parseCommand(text));
  });

  it('order: canonical text first; canonical syntax that fails is unknown with the canonical error, not natural language', () => {
    const c = parseCommand('place building:house count=3 along=road:main side=north gap=2 floors=2');
    expect(c.kind === 'ok' && c.source).toBe('canonical');
    expect(c.kind === 'ok' && c.canonical).toEqual(['place building:house count=3 along=road:main side=north gap=2 floors=2']);
    const ko = parseCommand('배치 building:house count=3');
    expect(ko.kind === 'ok' && [ko.source, ...ko.canonical]).toEqual(['canonical', 'place building:house count=3']);
    const bad = parseCommand('place building count=three');
    expect(bad.kind === 'unknown' && bad.reason).toEqual({ key: 'cmd37.nl.unknown.canonical', params: { detail: 'badValue "three" → count' } });
    expect(bad.kind === 'unknown' && bad.suggestions[0].startsWith('place ')).toBe(true);
    // An English sentence that merely starts with a canonical verb is natural language.
    const nl = parseCommand('select every tree on slopes over 20°');
    expect(nl.kind === 'ok' && [nl.source, ...nl.canonical]).toEqual(['rules', 'select type:tree where slope>20']);
    // A Korean verb alias that does not parse falls through to the rules ("선택 해제" is not `선택 <target>`).
    const alias = parseCommand('선택 해제');
    expect(alias.kind === 'ok' && [alias.source, ...alias.canonical]).toEqual(['rules', 'select none']);
    // A typo of a canonical verb: the nearest verb's templates are suggested.
    const typo = parseCommand('delet selection');
    expect(typo.kind === 'unknown' && typo.suggestions[0]).toBe('delete selection');
  });

  it('sources and notes: rules, legacy grammar', () => {
    const rules = parseCommand('규모 7 지진을 발생시켜');
    expect(rules.kind === 'ok' && rules.source).toBe('rules');
    const legacy = parseCommand('Start an earthquake 10 seconds after the typhoon begins');
    expect(legacy.kind === 'ok' && legacy.source).toBe('legacy');
    expect(legacy.kind === 'ok' && legacy.notes.map((x) => x.key)).toEqual(['cmd37.nl.note.legacy', 'cmd37.nl.note.afterUnresolved']);
  });

  it('normalisation never changes the meaning: case, spaces, punctuation, politeness, full-width', () => {
    const same: [string, string][] = [
      ['나무 전부 숨겨', '나무 전부 숨겨 주세요!'], ['나무 전부 숨겨', '나무   전부 숨겨줘~'], ['나무 전부 숨겨', '나무 전부 숨겨라.'], ['나무 전부 숨겨', '나무 전부 숨기세요'],
      ['hide all trees', 'Please hide all trees.'], ['hide all trees', 'could you HIDE ALL TREES?'], ['hide all trees', "let's hide all the trees!"], ['hide all trees', 'I want to hide all trees'], ['hide all trees', 'hide all trees, thanks'], ['나무 전부 숨겨', '나무 전부 숨겨 줘, 고마워'],
      ['2배속', '２배속'], ['선택한 것 동쪽으로 5 m', '선택한것 동쪽으로 5미터'], ['주택 세 채', '주택 3채'], ['주택 세 채', '주택3채'], ['a house here', 'A  House  Here'],
      ['교차로에 폭발 1.8e9 J', '교차로에 폭발 1.8×10⁹ J'], ['교차로에 폭발 1.8e9 J', '교차로에 폭발 18억 J'], ['교차로에 폭발 1.8e9 J', '교차로에 폭발 1,800,000,000 J'], ['교차로에 폭발 1.8e9 J', '교차로에 폭발 1.8 GJ'],
    ];
    for (const [a, b] of same) expect(show(parseCommand(b)), `${a} = ${b}`).toBe(show(parseCommand(a)));
    expect(show(parseCommand('나무 전부 숨겨'))).toBe('hide type:tree');
    expect(show(parseCommand('교차로에 폭발 1.8e9 J'))).toBe('disaster blast at=junction energy=1.8e9');
  });

  it('quoted names are literal', () => {
    const o = parseCommand('rename it to "Depot  ＡＢ, don\'t 10⁹"');
    expect(o.kind === 'ok' && o.intents[0]).toEqual({ kind: 'rename', target: { base: { b: 'it' } }, name: "Depot  ＡＢ, don't 10⁹" });
  });

  it('suggestions are deterministic and ranked by shared words', () => {
    expect(suggest('나무를 빨갛게 숨겨', [])).toEqual(suggest('나무를 빨갛게 숨겨', []));
    const o = parseCommand('나무 숨겨 그리고 커피 주문');
    expect(o.kind === 'unknown' && o.suggestions[0]).toBe('hide type:tree');
  });

  it('a 200-character sentence of eleven commands is read completely (its parse time is in nl-REPORT.md, not asserted here)', () => {
    const text = "큰길 북쪽에 2층 주택 세 채, 간격 2 m 그리고 방금 만든 건물들 그룹으로 묶고 이름을 '북쪽 블록'으로, 선택한 것 동쪽으로 5 m, 30도 회전하고 나무 전부 숨겨, 교차로 n4에 폭발 1.8×10⁹ J, 5초 뒤 그리고 여기 반경 10 m 평평하게 하고 잔디로 칠해, n4에서 (40, 60)까지 2차로 도로 만들어, 가장 높은 건물 보여 줘, 건물 몇 채야?";
    expect(text.length).toBeGreaterThanOrEqual(200);
    expect(show(parseCommand(text))).toBe([
      'place building:house count=3 along=road:main side=north gap=2 floors=2', 'group last name="북쪽 블록"', 'move selection by=5,0,0', 'rotate selection by=30',
      'hide type:tree', 'disaster blast at=node:n4 energy=1.8e9 start=5', 'terrain flatten circle cursor r=10', 'paint circle cursor r=10 ground=grass',
      'road node:n4 -> 40,60 preset=street', 'focus type:building tallest', 'count type:building',
    ].join(' | '));
  });
});
