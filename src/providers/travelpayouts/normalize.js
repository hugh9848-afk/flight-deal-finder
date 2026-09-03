// Travelpayouts 응답 -> 우리 공통 양식지.
//
// 중요: 이 API 는 '참고가'만 줍니다. 이동시간·수하물·환불규정이 응답에 없습니다.
// 없는 값을 지어내지 않고 전부 미확인(null)으로 두며, 화면에는 '참고가(캐시)'로 표시됩니다.
import { makeCandidate, makeLeg, PRICE_TYPE } from "../../core/model.js";

/** 'YYYY-MM-DD' 또는 ISO 시각에서 날짜 부분만 뽑습니다. */
function dayOf(v) {
  if (typeof v !== "string" || v.length < 10) return null;
  return v.slice(0, 10);
}

/** 두 날짜 사이 일수. 하나라도 없으면 null. */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const d = Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  return Number.isFinite(d) ? d : null;
}

/**
 * 한 건을 후보 한 장으로 바꿉니다.
 * v1(city-directions) 과 v2(prices/latest) 는 필드 이름이 조금 달라서 둘 다 받아들입니다.
 *
 * v1: { origin, destination, price, transfers, airline, flight_number, departure_at, return_at, expires_at }
 * v2: { origin, destination, value, number_of_changes, depart_date, return_date, found_at, distance, actual }
 */
export function normalizeRow(row, { currency = "KRW", fetchedAt, link = null, endpoint = "?" } = {}) {
  const departureDate = dayOf(row.departure_at ?? row.depart_date);
  const returnDate = dayOf(row.return_at ?? row.return_date);

  // 값은 v1 이 price, v2 가 value 로 옵니다.
  const rawPrice = row.price ?? row.value;
  const total = typeof rawPrice === "number" ? Math.round(rawPrice) : null;

  // 경유 횟수. 이 값이 가는 편만인지 왕복 합인지 문서가 분명하지 않아
  // '가는 편'으로만 받아들이고, 오는 편은 미확인으로 둡니다.
  const rawStops = row.transfers ?? row.number_of_changes;
  const outStops = typeof rawStops === "number" ? rawStops : null;

  const notes = ["참고가(캐시)입니다. 실제 구매 가능 여부와 총액은 확인 전입니다."];
  if (row.actual === false) notes.push("공급자가 '최신 아님'으로 표시한 가격입니다.");
  if (outStops !== null) notes.push(`경유 ${outStops}회로 표시됨 (가는 편 기준, 오는 편은 미확인)`);

  const c = makeCandidate({
    source: "travelpayouts",
    priceType: PRICE_TYPE.INDICATIVE,
    fetchedAt,
    // v1 은 이 가격이 언제까지 유효한지 알려줍니다.
    priceValidUntil: row.expires_at ?? null,
    currency,
    total,
    base: null,    // 항공료/세금 분리 정보 없음
    taxes: null,
    outbound: makeLeg({
      from: row.origin,
      to: row.destination,
      departAt: departureDate,
      durationMin: null,   // 이 API 는 이동시간을 주지 않습니다
      segments: [],
    }),
    inbound: returnDate
      ? makeLeg({ from: row.destination, to: row.origin, departAt: returnDate, durationMin: null, segments: [] })
      : null,
    originOut: row.origin,
    destIn: row.destination,
    destOut: returnDate ? row.destination : null,
    tripDays: daysBetween(departureDate, returnDate),
    openJaw: false,
    // 이 자료만으로는 별도 발권·자가환승 여부를 알 수 없습니다.
    separateTickets: null,
    selfTransfer: null,
    airportChange: null,
    baggage: null,
    fareRules: null,
    links: link ? [{ label: "아비아세일즈에서 같은 조건 검색", url: link }] : [],
    notes,
  });

  // 경유 횟수는 알아냈으니 후보에 얹어 둡니다 (경유 제한 거르기에 쓰입니다).
  if (outStops !== null && c.outbound) c.outbound.stops = outStops;

  c.raw = {
    endpoint,
    airline: row.airline ?? null,
    flightNumber: row.flight_number ?? null,
    observedAt: row.found_at ?? null,   // 이 가격을 '언제 봤는지' (우리가 조회한 시각과 다름)
    distanceKm: typeof row.distance === "number" ? row.distance : null,
    actual: row.actual ?? null,
  };
  return c;
}

/**
 * v1 city-directions 는 목적지를 열쇠로 하는 꾸러미로 옵니다.
 *   { "AER": {...}, "CDG": {...} }  ->  [{...}, {...}]
 */
export function rowsFromCityDirections(data) {
  const obj = data?.data;
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).map(([destination, v]) => ({ destination, ...v }));
}

/** v2 는 그냥 배열입니다. */
export function rowsFromLatest(data) {
  return Array.isArray(data?.data) ? data.data : [];
}
