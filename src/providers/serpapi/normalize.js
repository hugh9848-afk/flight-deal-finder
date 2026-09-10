// SerpApi 응답 3종 -> 우리 공통 양식지.
//
//   Deals   : 할인율을 직접 준다 (average_price, discount_percentage)
//   Explore : 지역을 넓게 훑는다 (공항코드·가격·이동시간·경유)
//   Flights : 상세. 구간·경유·시각 + price_insights(구글 가격 이력)
//
// 중요: Google 이 준 기준가는 우리 자체 관측과 **섞지 않고** 따로 보관합니다.
// 기준이 다른 두 숫자를 평균내면 둘 다 못 믿게 됩니다.
import { makeCandidate, makeLeg, candidateId, PRICE_TYPE } from "../../core/model.js";
import { tripDaysBetween } from "../../core/dateCombos.js";

/**
 * 날짜 글자에서 달력 날짜만 꺼냅니다.
 *
 * 구글은 "2027-01-16 13:15" 처럼 **시간대 없는 현지 시각**을 줍니다.
 * 이걸 그대로 Date 로 바꾸면 컴퓨터가 어느 나라에 있느냐에 따라 날짜가 달라집니다.
 * 우리가 필요한 건 '현지 달력 날짜'뿐이므로 앞 10글자만 씁니다.
 */
function calDay(v) {
  if (typeof v !== "string" || v.length < 10) return null;
  const day = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 가운데 값 */
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Deals 한 건 -> 후보.
 * Google 이 '평소 가격'과 '할인율'을 직접 주므로 그대로 보관합니다.
 */
export function normalizeDeal(row, { currency = "KRW", fetchedAt, origin = "ICN" } = {}) {
  const dep = calDay(row.outbound_date ?? row.start_date);
  const ret = calDay(row.return_date ?? row.end_date);
  const c = makeCandidate({
    source: "serpapi:deals",
    priceType: PRICE_TYPE.INDICATIVE,
    fetchedAt, currency,
    total: num(row.price),
    outbound: makeLeg({
      from: row.departure_airport_code ?? origin,
      to: row.arrival_airport_code ?? null,
      departAt: dep, durationMin: num(row.flight_duration), segments: [],
    }),
    inbound: ret ? makeLeg({
      from: row.arrival_airport_code ?? null,
      to: row.departure_airport_code ?? origin,
      departAt: ret, segments: [],
    }) : null,
    originOut: row.departure_airport_code ?? origin,
    departureAirportVerified: row.departure_airport_code === origin,
    returnAirportVerified: false,
    destIn: row.arrival_airport_code ?? null,
    destOut: ret ? (row.arrival_airport_code ?? null) : null,
    // 날짜만 알고 실제 도착 시각은 모르므로 어림값입니다
    tripDays: tripDaysBetween(dep, ret),
    tripDaysBasis: dep && ret ? "local_departure_estimated" : null,
    links: row.flight_link ? [{ label: "구글 항공권에서 확인", url: row.flight_link }] : [],
    notes: ["Google 특가 목록에서 찾은 후보입니다. 실제 총액·수하물·환불조건은 확인 전입니다."],
  });
  if (c.outbound) c.outbound.stops = num(row.stops);

  // Google 이 **직접 알려준** 기준가와 할인율.
  // 우리가 계산한 게 아니라 받은 값 그대로입니다.
  const avg = num(row.average_price);
  if (avg !== null && avg > 0) {
    c.providerBaseline = {
      kind: "google_deals_reported",   // 공급자가 직접 제공
      baseline: avg,
      discountPct: num(row.discount_percentage),
      observedAt: fetchedAt,
      note: "Google 특가 목록이 제공한 평소가와 할인율입니다.",
    };
  }
  c.raw = { endpoint: "google_flights_deals", airline: row.airline ?? null,
            destinationName: row.name ?? null, country: row.country ?? null,
            serpapiFlightLink: row.serpapi_flight_link ?? null };
  return c;
}

/** Explore 한 건 -> 후보. 지역을 넓게 훑을 때 씁니다. */
export function normalizeExplore(row, { currency = "KRW", fetchedAt, origin = "ICN" } = {}) {
  const dep = calDay(row.start_date);
  const ret = calDay(row.end_date);
  const air = row.destination_airport?.code ?? null;
  const c = makeCandidate({
    source: "serpapi:explore",
    priceType: PRICE_TYPE.INDICATIVE,
    fetchedAt, currency,
    total: num(row.flight_price),
    outbound: makeLeg({ from: origin, to: air, departAt: dep,
                        durationMin: num(row.flight_duration), segments: [] }),
    inbound: ret ? makeLeg({ from: air, to: origin, departAt: ret, segments: [] }) : null,
    originOut: origin,
    departureAirportVerified: false,
    returnAirportVerified: false,
    destIn: air,
    destOut: ret ? air : null,
    tripDays: tripDaysBetween(dep, ret),
    tripDaysBasis: dep && ret ? "local_departure_estimated" : null,
    links: row.link ? [{ label: "구글 여행 탐색에서 확인", url: row.link }] : [],
    notes: ["Google 지역 탐색에서 찾은 후보입니다. 실제 총액·수하물·환불조건은 확인 전입니다."],
  });
  if (c.outbound) c.outbound.stops = num(row.number_of_stops);
  c.raw = { endpoint: "google_travel_explore", airline: row.airline ?? null,
            destinationName: row.name ?? null, country: row.country ?? null,
            serpapiLink: row.serpapi_link ?? null };
  return c;
}

/**
 * Flights 상세 한 건 -> 후보.
 * 구간·경유·시각이 다 들어 있고, price_insights 로 구글 가격 이력을 함께 받습니다.
 */
export function normalizeFlightOffer(offer, { currency = "KRW", fetchedAt, priceInsights = null, origin = "ICN", returnDate = null } = {}) {
  const legs = offer.flights ?? [];
  const layovers = offer.layovers ?? [];

  const segments = legs.map((s, i) => {
    const next = legs[i + 1];
    const arrive = s.arrival_airport?.id ?? null;
    const nextDepart = next?.departure_airport?.id ?? null;
    return {
      carrier: s.airline ?? null,
      number: s.flight_number ?? null,
      from: s.departure_airport?.id ?? null,
      to: arrive,
      departAt: s.departure_airport?.time ?? null,
      arriveAt: s.arrival_airport?.time ?? null,
      durationMin: num(s.duration),
      layoverMin: num(layovers[i]?.duration),
      // 앞 비행기가 내린 공항과 다음 비행기가 뜨는 공항이 다르면 '공항 변경'.
      // 다음 구간이 없으면 판단할 게 없으므로 false 가 아니라 null 입니다.
      airportChange: next ? (arrive !== null && nextDepart !== null ? arrive !== nextDepart : null) : false,
      overnight: layovers[i]?.overnight ?? null,
    };
  });

  const first = segments[0], last = segments.at(-1);
  const outbound = makeLeg({
    from: first?.from ?? origin, to: last?.to ?? null,
    departAt: first?.departAt ?? null, arriveAt: last?.arriveAt ?? null,
    durationMin: num(offer.total_duration), segments,
  });

  const depDay = calDay(first?.departAt);
  const retDay = calDay(returnDate);

  const c = makeCandidate({
    source: "serpapi:flights",
    // 실제 조회 결과입니다. 다만 판매 화면에서 확인한 것은 아니므로 confirmed 가 아닙니다.
    priceType: PRICE_TYPE.LIVE,
    fetchedAt, currency,
    total: num(offer.price),
    outbound,
    inbound: retDay ? makeLeg({ from: last?.to ?? null, to: origin, departAt: retDay, segments: [] }) : null,
    originOut: first?.from ?? origin,
    departureAirportVerified: first?.from === origin,
    returnAirportVerified: false,
    destIn: last?.to ?? null,
    destOut: retDay ? (last?.to ?? null) : null,
    tripDays: tripDaysBetween(depDay, retDay),
    tripDaysBasis: depDay && retDay ? "local_departure_estimated" : null,
    // "Round trip" 은 '왕복으로 검색했다'는 표시일 뿐,
    // 한 장으로 보호되는 발권이라는 증거가 아닙니다. 근거가 없으므로 모름으로 둡니다.
    separateTickets: null,
    selfTransfer: null,
    // 하나라도 공항이 바뀌면 true, 전부 아니면 false, 판단할 수 없으면 null
    airportChange: segments.some((s) => s.airportChange === true) ? true
      : segments.some((s) => s.airportChange === null) ? null : false,
    notes: ["Google 항공권 상세 조회 결과입니다. 판매 화면에서 최종 확인한 값은 아닙니다."],
  });

  // 구글이 준 가격 자료.
  // **직접 받은 값**과 **우리가 계산한 값**을 반드시 구분합니다.
  // 통상 가격대의 중간점은 '중앙값'이 아니고, 이력의 중앙값도 구글의 비교 기준과 다릅니다.
  if (priceInsights) {
    const hist = (priceInsights.price_history ?? [])
      .map((p) => p?.[1]).filter((v) => num(v) !== null && v > 0);
    const range = Array.isArray(priceInsights.typical_price_range)
      && priceInsights.typical_price_range.length === 2
      && priceInsights.typical_price_range.every((v) => num(v) !== null && v > 0)
      ? priceInsights.typical_price_range : null;

    // ① 구글이 준 통상 가격대 — 범위 그대로 보관하고 할인율을 만들지 않습니다
    if (range) {
      c.providerRange = {
        kind: "google_typical_range",
        range,
        note: "Google 이 제시한 통상 가격대입니다. 이 범위로 할인율을 계산하지 않습니다.",
      };
    }

    // ② 우리가 구글 이력으로 계산한 값 — 계산했다는 사실을 이름에 남깁니다
    if (hist.length >= 5) {
      const mid = median(hist);
      if (mid !== null && mid > 0) {
        c.providerBaseline = {
          kind: "app_computed_from_google_history",   // 앱이 계산
          baseline: mid,
          discountPct: c.total ? Math.round((1 - c.total / mid) * 1000) / 10 : null,
          historyPoints: hist.length,
          method: "구글이 준 가격 이력의 중앙값",
          observedAt: fetchedAt,
          note: "Google 이 준 이력을 앱이 계산한 값입니다. Google 이 제시한 할인율이 아닙니다.",
        };
      }
    }

    // ③ price_level 은 그 검색의 최저가에 대한 판정입니다.
    //    개별 후보마다 붙이면 사실과 달라지므로 검색 전체 정보로만 남깁니다.
    c.searchPriceLevel = priceInsights.price_level ?? null;
  }

  c.raw = { endpoint: "google_flights", offerType: offer.type ?? null,
            carbon: offer.carbon_emissions?.this_flight ?? null,
            departureToken: offer.departure_token ?? null };
  return c;
}

/** departure_token 으로 선택한 출국편에 귀국편 응답을 결합합니다. */
export function normalizeRoundTrip(outboundOffer, returnOffer, opts = {}) {
  // 귀국 응답의 price 는 선택된 왕복 총액입니다. 편도 두 가격을 더하지 않습니다.
  const c = normalizeFlightOffer({ ...outboundOffer, price: returnOffer.price }, opts);
  const back = normalizeFlightOffer(returnOffer, { currency: opts.currency, fetchedAt: opts.fetchedAt });
  c.inbound = back.outbound;
  c.destOut = c.inbound.from;
  c.returnAirportVerified = c.inbound.segments.length > 0 && c.inbound.to === (opts.origin ?? "ICN");
  const arrivalDay = calDay(c.inbound.arriveAt);
  if (c.departureAirportVerified && c.returnAirportVerified && arrivalDay) {
    c.tripDays = tripDaysBetween(calDay(c.outbound.departAt), arrivalDay);
    c.tripDaysBasis = "icn_confirmed";
  }
  c.airportChange = [c.airportChange, back.airportChange].includes(true) ? true
    : [c.airportChange, back.airportChange].includes(null) ? null : false;
  c.raw.bookingToken = returnOffer.booking_token ?? null;
  c.id = candidateId(c);
  return c;
}

export const rowsFromDeals = (d) => (Array.isArray(d?.deals) ? d.deals : []);
export const rowsFromExplore = (d) => (Array.isArray(d?.destinations) ? d.destinations : []);
export const offersFromFlights = (d) => [...(d?.best_flights ?? []), ...(d?.other_flights ?? [])];
