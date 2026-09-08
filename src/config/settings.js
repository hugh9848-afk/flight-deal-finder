// 검색 규칙 설정표. 여기 숫자만 바꾸면 탐색 범위가 달라집니다.
export const SETTINGS = {
  origin: "ICN",
  currency: "KRW",
  adults: 1,
  cabin: "ECONOMY",

  // 편도당 경유 몇 번까지 받아들일지.
  // 유럽·아프리카 모두 2회까지 엽니다. 1회로 묶으면 후보가 너무 줄어듭니다.
  // 경유가 많으면 여행가치 점수의 이동시간·대기 항목이 알아서 깎입니다.
  maxStops: 2,
  maxStopsByRegion: {},

  // 여행 기간(달력 일수). 인천에서 뜨는 날을 1일째로 세어 인천에 내리는 날까지.
  // 예: 10월 11일 출국, 10월 15일 귀국 = 5일
  minTripDays: 5,
  maxTripDays: 20,

  // 공급자에게 받아올 때는 조금 넉넉하게 받습니다.
  // 시차와 밤 비행기 때문에 경계에 걸친 일정이 통째로 빠지는 걸 막습니다.
  collectTripDaysSlack: 1,

  // 언제 출발하는 표를 찾을지.
  // 오늘부터 15일 뒤 ~ 6개월 뒤 (달력 기준, 양 끝 포함).
  // 월말은 그 달의 마지막 날로 맞춥니다 (8월 31일 + 6개월 = 2월 28일).
  searchWindow: { fromDaysAhead: 15, toMonthsAhead: 6 },

  // 날짜를 며칠 간격으로 훑을지. 1이면 하루하루 전부(너무 많음), 7이면 주 단위.
  departStepDays: 7,
  tripDaysStep: 2,

  // 깔때기 단계별로 몇 개까지 남길지 (호출량·비용을 여기서 통제)
  funnel: {
    liveCheckTop: 15,     // 실제 운임 조회까지 갈 후보 수
    confirmTop: 5,        // 총액·수하물·환불규정까지 확정할 후보 수
  },

  // 특가로 인정할 기준
  deal: {
    minDiscountPct: 20,   // 평소 대비 최소 20% 싸야 특가 후보
    minZScore: 1.5,       // 이력이 없을 때 쓰는 상대점수 기준
    // 총액 상한. null 이면 비싸다고 버리지 않습니다.
    // 할인율이 우선이라, 비싼 노선에서 크게 싸진 것도 놓치지 않기 위해서입니다.
    // 숫자를 넣으면 그 값을 넘는 후보를 화면에서 걸러내는 '선택 필터'로만 씁니다.
    maxTotalKRW: null,
  },

  // 자체 관측 이력을 '믿을 만하다'고 부르기 위한 최소 조건.
  // 이걸 채우기 전에는 신뢰도를 '높음'으로 올리지 않습니다.
  selfHistory: {
    minObservationDays: 30,   // 관측 기간이 30일은 넘어야
    minDistinctDays: 14,      // 서로 다른 날 14일 이상 봤어야
  },

  // 화면에 몇 건까지 내보낼지. null 이면 제한 없음.
  maxResults: null,

  // 알림 재발송 규칙
  renotify: {
    minPriceDropPct: 7,   // 이전 알림보다 7% 이상 더 싸져야 다시 알림
    cooldownDays: 3,
  },
};
