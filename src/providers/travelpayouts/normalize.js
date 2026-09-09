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

// 여행 일수는 공통 규칙(떠나는 날을 1일째로 셈)을 씁니다.
import { tripDaysBetween } from "../../core/dateCombos.js";

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
  if (returnDate) notes.push("여행 일수는 현지 출발일 기준 어림값입니다. 인천 도착일은 하루 뒤일 수 있습니다.");
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
    // 이 공급자는 '현지에서 뜨는 날'까지만 알려줍니다.
    // 인천에 실제로 내리는 날은 밤 비행기면 하루 뒤일 수 있어 확정할 수 없습니다.
    tripDays: tripDaysBetween(departureDate, returnDate),
    tripDaysBasis: "local_departure_estimated",
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

// ───────────────────────────────────────────────────────────
// v3 (aviasales/v3/prices_for_dates) 전용
//
// v3 는 v2 보다 훨씬 자세합니다. 특히 이 세 가지가 중요합니다.
//   origin_airport / destination_airport : 도시코드가 아닌 진짜 공항
//   duration_to / duration_back          : 가는 편·오는 편 이동시간(분)
//   return_transfers                     : 귀국편 경유 횟수
// 그리고 시각에 시간대가 붙어 있어서
// '귀국 출발 시각 + 오는 편 소요시간' 으로 실제 인천 도착 날짜를 계산할 수 있습니다.
// ───────────────────────────────────────────────────────────

/** 시각을 한국 날짜(YYYY-MM-DD)로 바꿉니다. */
function kstDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 숫자면 그대로, 아니면 null */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * v3 한 줄을 후보로 바꿉니다.
 * @param {object} row      v3 응답의 한 항목
 * @param {string} linkBase 링크 앞에 붙일 주소 (예: https://www.aviasales.com)
 * @param {string} marker   제휴 번호 (없으면 생략)
 */
export function normalizeV3Row(row, { currency = "KRW", fetchedAt, linkBase = "https://www.aviasales.com", marker = null } = {}) {
  const departAt = row.departure_at ?? null;
  const returnAt = row.return_at ?? null;
  const durTo = num(row.duration_to);
  const durBack = num(row.duration_back);

  // 실제 인천 도착 시각 = 귀국 출발 시각 + 오는 편 소요시간
  //
  // 주의: 이건 '계산한 값'이지 공급자가 알려준 도착 시각이 아닙니다.
  // 그리고 이 응답에는 **귀국편이 어느 공항에 내리는지가 없습니다.**
  // 출발 공항과 같다고 넘겨짚으면 안 됩니다(김포로 돌아오는 표일 수도 있습니다).
  let icnArriveAt = null;
  let arrivalTimeBasis = null;
  if (returnAt && durBack !== null && durBack > 0) {
    // 시간대가 붙어 있어야 정확한 순간을 알 수 있습니다
    const hasZone = /[+-]\d{2}:?\d{2}$|Z$/.test(returnAt);
    const t = Date.parse(returnAt);
    if (Number.isFinite(t) && hasZone) {
      icnArriveAt = new Date(t + durBack * 60000).toISOString();
      arrivalTimeBasis = "derived_from_duration";   // 계산해서 얻은 값
    }
  }

  const departDay = departAt ? kstDate(departAt) : null;
  const arriveDay = icnArriveAt ? kstDate(icnArriveAt) : null;

  // 출발 공항이 실제로 인천인지 확인합니다. 귀국 도착 공항은 이 응답에 없으므로 '미확인'입니다.
  const outFrom0 = row.origin_airport ?? row.origin ?? null;
  const departureAirportVerified = outFrom0 === "ICN";
  const returnAirportVerified = false;   // 이 공급자는 귀국 도착 공항을 알려주지 않습니다

  // 여행 일수:
  //  - 양쪽 공항이 다 확인돼야 '확정'이라 부를 수 있습니다.
  //  - 지금은 귀국 공항을 모르므로, 시각 계산이 됐어도 '계산값'까지입니다.
  let tripDays = null, tripDaysBasis = null;
  if (departDay && arriveDay) {
    tripDays = tripDaysBetween(departDay, arriveDay);
    tripDaysBasis = (departureAirportVerified && returnAirportVerified)
      ? "icn_confirmed"
      : "arrival_time_derived";
  } else if (departDay && returnAt) {
    tripDays = tripDaysBetween(departDay, kstDate(returnAt));
    tripDaysBasis = "local_departure_estimated";
  }

  // 사람이 눌러 확인할 링크. v3 는 상대 주소로 주므로 앞을 채워 줍니다.
  let link = null;
  if (typeof row.link === "string" && row.link) {
    const u = new URL(row.link, linkBase);
    if (marker) u.searchParams.set("marker", marker);
    link = u.toString();
  }

  const outFrom = outFrom0;
  const outTo = row.destination_airport ?? row.destination ?? null;

  const notes = ["참고가(캐시)입니다. 실제 구매 가능 여부와 총액은 확인 전입니다."];
  if (row.gate) notes.push(`표시 판매처: ${row.gate}`);
  if (arrivalTimeBasis === "derived_from_duration") {
    notes.push(`도착 예정 ${arriveDay} — 귀국 출발 시각에 오는 편 ${Math.round(durBack / 60)}시간을 더해 계산했습니다.`);
    notes.push("귀국편이 내리는 공항은 이 자료에 없어 미확인입니다.");
  }

  const c = makeCandidate({
    source: "travelpayouts",
    priceType: PRICE_TYPE.INDICATIVE,
    fetchedAt,
    currency,
    total: num(row.price),
    base: null,
    taxes: null,
    outbound: makeLeg({
      from: outFrom, to: outTo,
      departAt, durationMin: durTo, segments: [],
    }),
    inbound: returnAt
      ? makeLeg({ from: outTo, to: outFrom, departAt: returnAt, arriveAt: icnArriveAt, durationMin: durBack, segments: [] })
      : null,
    originOut: outFrom,
    destIn: outTo,
    destOut: returnAt ? outTo : null,
    tripDays,
    tripDaysBasis,
    openJaw: false,
    separateTickets: null,
    selfTransfer: null,
    airportChange: null,
    baggage: null,
    fareRules: null,
    links: link ? [{ label: "아비아세일즈에서 이 일정 확인", url: link }] : [],
    notes,
  });

  // v3 는 양쪽 경유 횟수를 알려줍니다 (v2 는 가는 편만)
  if (c.outbound) c.outbound.stops = num(row.transfers);
  if (c.inbound) c.inbound.stops = num(row.return_transfers);
  // 이동시간을 알게 됐으니 미확인 목록에서 빼줍니다
  if (durTo !== null && durBack !== null) {
    c.unknown = c.unknown.filter((k) => k !== "duration");
  }

  c.arrivalTimeBasis = arrivalTimeBasis;
  c.departureAirportVerified = departureAirportVerified;
  c.returnAirportVerified = returnAirportVerified;
  c.raw = {
    endpoint: "aviasales/v3/prices_for_dates",
    airline: row.airline ?? null,
    flightNumber: row.flight_number ?? null,
    gate: row.gate ?? null,
    // v3 는 '언제 본 가격인지'를 주지 않으므로 우리가 받은 시각으로 대신합니다
    observedAt: null,
    icnArriveAt,
  };
  return c;
}

/** v3 응답은 배열입니다. */
export function rowsFromV3(data) {
  return Array.isArray(data?.data) ? data.data : [];
}
