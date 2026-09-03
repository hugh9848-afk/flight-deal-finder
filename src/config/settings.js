// 검색 규칙 설정표. 여기 숫자만 바꾸면 탐색 범위가 달라집니다.
export const SETTINGS = {
  origin: "ICN",
  currency: "KRW",
  adults: 1,
  cabin: "ECONOMY",

  // 경유 몇 번까지 받아들일지. 1 = 직항 + 1회 경유까지.
  // 인천발 유럽은 직항이 드물어서 1회 경유를 빼면 후보가 거의 없습니다.
  maxStops: 1,
  // 지역마다 사정이 다릅니다. 아프리카 남부·서부는 1회 경유 조합이 거의 없어서
  // 2회까지 열어두지 않으면 결과가 통째로 0건이 됩니다.
  maxStopsByRegion: { africa: 2 },

  // 여행 기간(체류 일수) 범위
  minTripDays: 10,
  maxTripDays: 20,

  // 언제 출발하는 표를 찾을지 (오늘부터 며칠 뒤 ~ 며칠 뒤)
  searchWindow: { fromDaysAhead: 30, toDaysAhead: 300 },

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
    maxTotalKRW: 1500000, // 이 금액보다 비싸면 아예 후보에서 제외
  },

  // 알림 재발송 규칙
  renotify: {
    minPriceDropPct: 7,   // 이전 알림보다 7% 이상 더 싸져야 다시 알림
    cooldownDays: 3,
  },
};
