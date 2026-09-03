// Amadeus 응답 -> 우리 공통 양식지로 옮겨 적기.
import { makeCandidate, makeLeg, PRICE_TYPE } from "../../core/model.js";

/** "PT21H10M" 같은 글자를 분 단위 숫자로 바꿉니다. */
export function isoDurationToMinutes(iso) {
  if (typeof iso !== "string") return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const [, d, h, min] = m;
  const total = (Number(d || 0) * 24 * 60) + (Number(h || 0) * 60) + Number(min || 0);
  return total > 0 ? total : null;
}

/** 두 시각(같은 공항이라 시차가 없음) 사이의 대기 분을 셉니다. */
function minutesBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

// 경유 대기가 이보다 길면 앞뒤가 뒤바뀐 자료로 봅니다 (14일)
const MAX_SANE_LAYOVER_MIN = 14 * 24 * 60;

/** 한 방향(가는 편 또는 오는 편)을 우리 서식으로 바꿉니다. */
function normalizeItinerary(itin, fareBySegment) {
  const segs = itin.segments ?? [];
  const problems = [];
  const segments = segs.map((s, i) => {
    const next = segs[i + 1];
    // 경유 대기시간: 도착한 공항에서 다음 비행기 뜰 때까지.
    // 같은 공항이라 시차가 없으므로 그냥 빼도 맞습니다.
    let layoverMin = next ? minutesBetween(s.arrival.at, next.departure.at) : null;
    // 다음 비행기가 앞 비행기보다 먼저 뜨는 건 있을 수 없습니다.
    // 이런 자료는 믿지 않고 '미확인'으로 두고 문제로 기록합니다.
    if (layoverMin !== null && (layoverMin < 0 || layoverMin > MAX_SANE_LAYOVER_MIN)) {
      problems.push(`${s.arrival.iataCode} 경유 시각이 앞뒤가 맞지 않습니다 (${s.arrival.at} → ${next.departure.at})`);
      layoverMin = null;
    }
    const fare = fareBySegment?.get(s.id);
    return {
      carrier: s.carrierCode,
      operatingCarrier: s.operating?.carrierCode ?? s.carrierCode,
      number: `${s.carrierCode}${s.number}`,
      from: s.departure.iataCode,
      fromTerminal: s.departure.terminal ?? null,
      to: s.arrival.iataCode,
      toTerminal: s.arrival.terminal ?? null,
      departAt: s.departure.at,
      arriveAt: s.arrival.at,
      durationMin: isoDurationToMinutes(s.duration),
      cabin: fare?.cabin ?? null,
      layoverMin,
      // 앞 비행기가 내린 공항과 다음 비행기가 뜨는 공항이 다르면 '공항 변경'
      airportChange: next ? s.arrival.iataCode !== next.departure.iataCode : false,
    };
  });

  const leg = makeLeg({
    from: segs[0]?.departure.iataCode ?? null,
    to: segs.at(-1)?.arrival.iataCode ?? null,
    departAt: segs[0]?.departure.at ?? null,
    arriveAt: segs.at(-1)?.arrival.at ?? null,
    // 시차가 섞이므로 직접 빼지 않고 회사가 알려준 총 소요시간을 씁니다.
    durationMin: isoDurationToMinutes(itin.duration),
    segments,
  });
  leg.problems = problems;
  return leg;
}

/** 수하물 조건을 꺼냅니다. 구간마다 다르면 가장 나쁜 쪽(적은 쪽)을 씁니다. */
function extractBaggage(offer) {
  const details = offer.travelerPricings?.[0]?.fareDetailsBySegment ?? [];
  if (!details.length) return null;

  let checkedPieces = null, checkedKg = null, cabinKg = null;
  let sawAny = false;

  for (const d of details) {
    const cb = d.includedCheckedBags;
    if (cb) {
      sawAny = true;
      if (typeof cb.quantity === "number") {
        checkedPieces = checkedPieces === null ? cb.quantity : Math.min(checkedPieces, cb.quantity);
      }
      if (typeof cb.weight === "number") {
        checkedKg = checkedKg === null ? cb.weight : Math.min(checkedKg, cb.weight);
      }
    }
    const cab = d.includedCabinBags;
    if (cab && typeof cab.weight === "number") {
      sawAny = true;
      cabinKg = cabinKg === null ? cab.weight : Math.min(cabinKg, cab.weight);
    }
  }
  return sawAny ? { checkedPieces, checkedKg, cabinKg } : null;
}

/** 세금+수수료 = 총액 - 항공료 */
function computeTaxes(price) {
  const total = Number(price?.grandTotal ?? price?.total);
  const base = Number(price?.base);
  if (!Number.isFinite(total) || !Number.isFinite(base)) return null;
  return Math.round(total - base);
}

/**
 * Amadeus 항공권 제안 하나를 우리 후보 한 장으로 바꿉니다.
 */
export function normalizeOffer(offer, { priceType = PRICE_TYPE.LIVE, fetchedAt } = {}) {
  const fareBySegment = new Map(
    (offer.travelerPricings?.[0]?.fareDetailsBySegment ?? []).map((f) => [f.segmentId, f])
  );
  const itins = offer.itineraries ?? [];
  const outbound = itins[0] ? normalizeItinerary(itins[0], fareBySegment) : null;
  const inbound = itins[1] ? normalizeItinerary(itins[1], fareBySegment) : null;

  const total = Number(offer.price?.grandTotal ?? offer.price?.total);
  const base = Number(offer.price?.base);

  // 체류 일수 = 귀국편 출발일 - 출국편 출발일
  let tripDays = null;
  if (outbound?.departAt && inbound?.departAt) {
    tripDays = Math.round(
      (Date.parse(inbound.departAt.slice(0, 10)) - Date.parse(outbound.departAt.slice(0, 10))) / 86400000
    );
  }

  // 경유 중 공항이 바뀌는 구간이 하나라도 있으면 true
  const airportChange = [outbound, inbound]
    .filter(Boolean)
    .some((leg) => leg.segments.some((s) => s.airportChange));

  const c = makeCandidate({
    source: "amadeus",
    priceType,
    fetchedAt,
    priceValidUntil: offer.lastTicketingDate ?? null,
    currency: offer.price?.currency ?? "KRW",
    total: Number.isFinite(total) ? total : null,
    base: Number.isFinite(base) ? base : null,
    taxes: computeTaxes(offer.price),
    outbound,
    inbound,
    originOut: outbound?.from ?? null,
    destIn: outbound?.to ?? null,
    destOut: inbound?.from ?? null,
    tripDays,
    // 들어간 도시와 나오는 도시가 다르면 오픈조
    openJaw: Boolean(inbound && outbound && inbound.from !== outbound.to),
    // GDS 단일 발권이므로 별도 발권/자가환승이 아닙니다.
    separateTickets: false,
    selfTransfer: false,
    airportChange,
    baggage: extractBaggage(offer),
    fareRules: null, // 환불·변경 규정은 가격확정 단계에서만 확인됩니다
    seatsLeft: typeof offer.numberOfBookableSeats === "number" ? offer.numberOfBookableSeats : null,
  });

  // 앞뒤가 안 맞는 시각이 있었으면 '확인 필요'로 남깁니다.
  const problems = [...(outbound?.problems ?? []), ...(inbound?.problems ?? [])];
  if (problems.length) {
    c.notes.push(...problems.map((p) => `확인 필요: ${p}`));
    if (!c.unknown.includes("layover")) c.unknown.push("layover");
  }

  c.raw = { offerId: offer.id, validatingAirlines: offer.validatingAirlineCodes ?? [] };
  // 원본 서류는 가격확정 단계에서 그대로 다시 보내야 합니다.
  // enumerable:false 로 두면 JSON 으로 저장할 때는 빠집니다.
  Object.defineProperty(c, "_rawOffer", { value: offer, enumerable: false, writable: true });
  return c;
}

/**
 * '넓게 훑기' 응답(flight-destinations / flight-dates)을 후보로 바꿉니다.
 * 이건 캐시된 참고가라서 실제로 살 수 있다는 보장이 없습니다.
 */
export function normalizeIndicative(row, { currency = "KRW", fetchedAt } = {}) {
  const total = Number(row.price?.total);
  const departAt = row.departureDate;
  const returnAt = row.returnDate ?? null;
  const tripDays = returnAt
    ? Math.round((Date.parse(returnAt) - Date.parse(departAt)) / 86400000)
    : null;

  const c = makeCandidate({
    source: "amadeus",
    priceType: PRICE_TYPE.INDICATIVE,
    fetchedAt,
    currency,
    total: Number.isFinite(total) ? total : null,
    base: null,
    taxes: null,
    outbound: makeLeg({ from: row.origin, to: row.destination, departAt, segments: [] }),
    inbound: returnAt
      ? makeLeg({ from: row.destination, to: row.origin, departAt: returnAt, segments: [] })
      : null,
    originOut: row.origin,
    destIn: row.destination,
    destOut: returnAt ? row.destination : null,
    tripDays,
    notes: ["참고가(캐시). 실제 구매 가능 여부는 미확인."],
  });
  return c;
}
