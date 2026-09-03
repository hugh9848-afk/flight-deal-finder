// 연습용 가짜 공급자. API 키 없이 전체 흐름을 시험할 때만 씁니다.
// 모든 결과에 mock 도장을 찍어 실제 특가와 절대 섞이지 않게 합니다.
import { FlightProvider } from "../base.js";
import { normalizeOffer, normalizeIndicative } from "../amadeus/normalize.js";
import { PRICE_TYPE } from "../../core/model.js";
import { findAirport, DESTINATIONS } from "../../config/destinations.js";

// 지역별로 대충 이 정도 값 하더라 하는 범위 (연습용 숫자입니다)
const PRICE_BAND = {
  europe:   [900000, 1700000],
  caucasus: [780000, 1350000],
  mongolia: [380000, 750000],
  africa:   [1100000, 2300000],
};

/** 같은 글자를 넣으면 항상 같은 숫자가 나오는 주사위 (시험 결과가 일정해집니다) */
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function priceFor(dest, departureDate, tripDays) {
  const air = findAirport(dest);
  const band = PRICE_BAND[air?.region ?? "europe"];
  const rnd = seededRandom(`${dest}|${departureDate}|${tripDays}`);
  const r = rnd();
  let price = band[0] + (band[1] - band[0]) * r;

  // 여름 성수기(7~8월)는 비싸게, 11~2월은 싸게 (계절 흉내)
  const month = Number(departureDate.slice(5, 7));
  if (month === 7 || month === 8) price *= 1.25;
  if (month >= 11 || month <= 2) price *= 0.85;

  // 스무 번에 한 번쯤 '특가'를 섞어 넣어 판정 로직을 시험합니다
  if (rnd() < 0.05) price *= 0.55;
  return Math.round(price / 100) * 100;
}

export class MockProvider extends FlightProvider {
  constructor(opts = {}) {
    super();
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [] };
    this.destinationPool = opts.destinations ?? DESTINATIONS;
  }
  get name() { return "mock"; }
  get capabilities() {
    return { indicative: true, live: true, confirm: true, openJaw: true };
  }

  async searchInspiration({ origin, departFrom, minTripDays, maxTripDays }) {
    this.stats.indicativeCalls++;
    const fetchedAt = new Date().toISOString();
    const rows = [];
    for (const d of this.destinationPool) {
      const rnd = seededRandom(`${d.iata}|${departFrom}`);
      // 출발일을 목적지마다 조금씩 흩뜨려 놓습니다
      const offset = Math.floor(rnd() * 60);
      const depart = new Date(Date.parse(departFrom) + offset * 86400000);
      const tripDays = minTripDays + Math.floor(rnd() * (maxTripDays - minTripDays + 1));
      const ret = new Date(depart.getTime() + tripDays * 86400000);
      const departureDate = depart.toISOString().slice(0, 10);
      rows.push({
        origin,
        destination: d.iata,
        departureDate,
        returnDate: ret.toISOString().slice(0, 10),
        price: { total: String(priceFor(d.iata, departureDate, tripDays)) },
      });
    }
    const candidates = rows.map((r) => {
      const c = normalizeIndicative(r, { currency: "KRW", fetchedAt });
      c.source = "mock";
      c.notes.push("연습용 가짜 데이터입니다. 실제 항공권이 아닙니다.");
      return c;
    });
    return { ok: true, candidates };
  }

  async searchCheapestDates(args) {
    const one = this.destinationPool.filter((d) => d.iata === args.destination);
    return this.searchInspiration({ ...args, });
  }

  async searchLive({ origin, destination, departureDate, returnDate, max = 3 }) {
    this.stats.liveCalls++;
    const fetchedAt = new Date().toISOString();
    const tripDays = Math.round((Date.parse(returnDate) - Date.parse(departureDate)) / 86400000);
    const rnd = seededRandom(`live|${destination}|${departureDate}`);
    const candidates = [];

    for (let i = 0; i < max; i++) {
      // 실제 조회하면 참고가보다 조금 비싸지는 경우가 많습니다
      const total = Math.round(priceFor(destination, departureDate, tripDays) * (1 + i * 0.08 + rnd() * 0.1));
      const base = Math.round(total * 0.6);
      const carrier = ["MU", "CA", "TK", "SU", "QR"][i % 5];
      const offer = buildMockOffer({
        origin, destination, departureDate, returnDate, total, base, carrier,
        seats: 1 + Math.floor(rnd() * 8), id: `mock-${destination}-${departureDate}-${i}`,
      });
      const c = normalizeOffer(offer, { priceType: PRICE_TYPE.LIVE, fetchedAt });
      c.source = "mock";
      c.notes.push("연습용 가짜 데이터입니다. 실제 항공권이 아닙니다.");
      candidates.push(c);
    }
    return { ok: true, candidates };
  }

  async searchLiveOpenJaw({ origin, destIn, destOut, departureDate, returnDate }) {
    const a = await this.searchLive({ origin, destination: destIn, departureDate, returnDate, max: 1 });
    const c = a.candidates[0];
    if (!c) return { ok: true, candidates: [] };
    // 돌아오는 편의 출발 도시만 다른 곳으로 바꿔 오픈조를 흉내 냅니다
    c.inbound.from = destOut;
    c.inbound.segments[0].from = destOut;
    c.destOut = destOut;
    c.openJaw = true;
    return { ok: true, candidates: [c] };
  }

  async confirmPrice(candidate) {
    this.stats.confirmCalls++;
    const rnd = seededRandom(`confirm|${candidate.id}`);
    const confirmed = structuredCloneSafe(candidate);
    confirmed.priceType = PRICE_TYPE.CONFIRMED;
    confirmed.fetchedAt = new Date().toISOString();

    // 열 번에 한 번쯤 값이 달라지는 상황을 흉내 냅니다 -> '확인 필요'로 걸러져야 합니다
    if (rnd() < 0.1) {
      confirmed.total = Math.round(candidate.total * 1.06);
      confirmed.fareRules = { refundable: null, changeFeeKRW: null, conflict: true };
      confirmed.notes.push(`확인 필요: 조회가(${candidate.total})와 확정가(${confirmed.total})가 다릅니다`);
    } else {
      confirmed.fareRules = { refundable: false, changeFeeKRW: 120000, conflict: false };
      confirmed.unknown = confirmed.unknown.filter((k) => k !== "fareRules");
    }
    return confirmed;
  }
}

/** JSON 으로 복사(숨긴 원본은 빠집니다) */
function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Amadeus 가 줄 법한 모양의 가짜 응답 한 장을 만듭니다. */
function buildMockOffer({ origin, destination, departureDate, returnDate, total, base, carrier, seats, id }) {
  const hub = { MU: "PVG", CA: "PEK", TK: "IST", SU: "SVO", QR: "DOH" }[carrier] ?? "PVG";

  // 시각 계산은 진짜 날짜 계산기로 합니다. 자정을 넘으면 다음 날이 됩니다.
  const at = (base, minutes) => {
    const d = new Date(base.getTime() + minutes * 60000);
    return d.toISOString().slice(0, 19); // "2026-10-11T16:20:00"
  };
  const iso = (min) => `PT${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")}M`;

  /** 한 방향을 만듭니다: [1구간 비행] - [경유 대기] - [2구간 비행] */
  function itinerary(from, via, to, dateStr, startHour, leg1Min, layoverMin, leg2Min, num1, num2) {
    const start = new Date(`${dateStr}T${String(startHour).padStart(2, "0")}:20:00Z`);
    const arr1 = new Date(start.getTime() + leg1Min * 60000);
    const dep2 = new Date(arr1.getTime() + layoverMin * 60000);
    const arr2 = new Date(dep2.getTime() + leg2Min * 60000);
    return {
      duration: iso(leg1Min + layoverMin + leg2Min),
      segments: [
        { departure: { iataCode: from, terminal: "1", at: at(start, 0) },
          arrival: { iataCode: via, at: at(arr1, 0) },
          carrierCode: carrier, number: String(num1), duration: iso(leg1Min), id: String(num1), numberOfStops: 0 },
        { departure: { iataCode: via, at: at(dep2, 0) },
          arrival: { iataCode: to, terminal: "2E", at: at(arr2, 0) },
          carrierCode: carrier, number: String(num2), duration: iso(leg2Min), id: String(num2), numberOfStops: 0 },
      ],
    };
  }

  return {
    type: "flight-offer",
    id,
    source: "GDS",
    lastTicketingDate: departureDate,
    numberOfBookableSeats: seats,
    itineraries: [
      // 가는 편: 16:20 출발, 2시간10분 비행, 6시간45분 경유, 12시간15분 비행
      itinerary(origin, hub, destination, departureDate, 16, 130, 405, 735, 5034, 553),
      // 오는 편: 12:25 출발, 11시간35분 비행, 2시간5분 경유, 1시간50분 비행
      itinerary(destination, hub, origin, returnDate, 12, 695, 125, 110, 554, 5041),
    ],
    price: { currency: "KRW", total: String(total), grandTotal: String(total), base: String(base) },
    validatingAirlineCodes: [carrier],
    travelerPricings: [{
      travelerId: "1", fareOption: "STANDARD", travelerType: "ADULT",
      fareDetailsBySegment: ["5034", "553", "554", "5041"].map((sid) => ({
        segmentId: sid, cabin: "ECONOMY",
        includedCheckedBags: { quantity: 2 },
        includedCabinBags: { weight: 8, weightUnit: "KG" },
      })),
    }],
  };
}
