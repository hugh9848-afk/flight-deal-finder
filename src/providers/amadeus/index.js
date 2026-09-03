// Amadeus Self-Service API 어댑터.
// 1단계(넓게 훑기) -> 2단계(실제 조회) -> 3단계(가격 확정) 세 가지 일을 합니다.
import { FlightProvider } from "../base.js";
import { AmadeusClient } from "./client.js";
import { normalizeOffer, normalizeIndicative } from "./normalize.js";
import { PRICE_TYPE, markConflict } from "../../core/model.js";

export class AmadeusProvider extends FlightProvider {
  constructor(opts = {}) {
    super();
    this.client = opts.client ?? new AmadeusClient(opts);
    this.currency = opts.currency ?? "KRW";
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [] };
  }

  get name() { return "amadeus"; }
  get capabilities() {
    return { indicative: true, live: true, confirm: true, openJaw: true };
  }

  /**
   * 1단계: 인천에서 갈 수 있는 곳을 한꺼번에 넓게 훑습니다.
   * 호출 1번으로 수십 개 목적지 참고가를 받아옵니다.
   */
  async searchInspiration({ origin, departFrom, departTo, minTripDays, maxTripDays, maxPrice }) {
    this.stats.indicativeCalls++;
    const res = await this.client.request("/v1/shopping/flight-destinations", {
      query: {
        origin,
        departureDate: `${departFrom},${departTo}`,
        duration: `${minTripDays},${maxTripDays}`,
        oneWay: false,
        nonStop: false,
        currencyCode: this.currency,
        maxPrice: maxPrice ? Math.floor(maxPrice) : undefined,
        viewBy: "DURATION",
      },
    });
    if (!res.ok) {
      this.stats.errors.push({ step: "inspiration", status: res.status, error: res.error });
      return { ok: false, candidates: [], error: res.error, status: res.status };
    }
    const fetchedAt = new Date().toISOString();
    const candidates = (res.data?.data ?? []).map((row) =>
      normalizeIndicative(row, { currency: this.currency, fetchedAt })
    );
    return { ok: true, candidates };
  }

  /**
   * 1단계 예비책: 목적지를 하나씩 지정해 '가장 싼 날짜'를 물어봅니다.
   * (넓게 훑기가 비어서 돌아올 때만 씁니다. 목적지 하나당 전화 1번.)
   */
  async searchCheapestDates({ origin, destination, departFrom, departTo, minTripDays, maxTripDays }) {
    this.stats.indicativeCalls++;
    const res = await this.client.request("/v1/shopping/flight-dates", {
      query: {
        origin,
        destination,
        departureDate: `${departFrom},${departTo}`,
        duration: `${minTripDays},${maxTripDays}`,
        oneWay: false,
        nonStop: false,
        currencyCode: this.currency,
        viewBy: "DURATION",
      },
    });
    if (!res.ok) {
      this.stats.errors.push({ step: "flight-dates", destination, status: res.status, error: res.error });
      return { ok: false, candidates: [], error: res.error, status: res.status };
    }
    const fetchedAt = new Date().toISOString();
    const candidates = (res.data?.data ?? []).map((row) =>
      normalizeIndicative(row, { currency: this.currency, fetchedAt })
    );
    return { ok: true, candidates };
  }

  /**
   * 실제 운임 조회의 공통 부분.
   * '경유 몇 번까지'를 API 에 직접 요청하므로, 받아서 버리는 낭비가 없습니다.
   */
  async #searchOffers({ originDestinations, adults = 1, cabin = "ECONOMY", max = 5, maxStops = 1, label = "live" }) {
    this.stats.liveCalls++;
    const ids = originDestinations.map((od) => od.id);
    const res = await this.client.request("/v2/shopping/flight-offers", {
      method: "POST",
      body: {
        currencyCode: this.currency,
        originDestinations,
        travelers: Array.from({ length: adults }, (_, i) => ({ id: String(i + 1), travelerType: "ADULT" })),
        sources: ["GDS"],
        searchCriteria: {
          maxFlightOffers: max,
          flightFilters: {
            // 경유 횟수 제한을 API 에 직접 알려줍니다
            connectionRestriction: { maxNumberOfConnections: maxStops },
            cabinRestrictions: [{ cabin, coverage: "MOST_SEGMENTS", originDestinationIds: ids }],
          },
        },
      },
    });
    if (!res.ok) {
      this.stats.errors.push({ step: label, ids, status: res.status, error: res.error });
      return { ok: false, candidates: [], error: res.error, status: res.status };
    }
    const fetchedAt = new Date().toISOString();
    return {
      ok: true,
      candidates: (res.data?.data ?? []).map((o) =>
        normalizeOffer(o, { priceType: PRICE_TYPE.LIVE, fetchedAt })
      ),
    };
  }

  /** 2단계: 실제로 살 수 있는 운임을 조회합니다. (왕복) */
  async searchLive({ origin, destination, departureDate, returnDate, adults = 1, cabin = "ECONOMY", max = 5, maxStops = 1 }) {
    return this.#searchOffers({
      originDestinations: [
        { id: "1", originLocationCode: origin, destinationLocationCode: destination,
          departureDateTimeRange: { date: departureDate } },
        { id: "2", originLocationCode: destination, destinationLocationCode: origin,
          departureDateTimeRange: { date: returnDate } },
      ],
      adults, cabin, max, maxStops, label: "live",
    });
  }

  /**
   * 2단계(오픈조): 들어가는 도시와 나오는 도시가 다른 일정.
   * 예: 인천 -> 파리 (들어가고), 로마 -> 인천 (나옴)
   */
  async searchLiveOpenJaw({ origin, destIn, destOut, departureDate, returnDate, adults = 1, cabin = "ECONOMY", max = 5, maxStops = 1 }) {
    return this.#searchOffers({
      originDestinations: [
        { id: "1", originLocationCode: origin, destinationLocationCode: destIn,
          departureDateTimeRange: { date: departureDate } },
        { id: "2", originLocationCode: destOut, destinationLocationCode: origin,
          departureDateTimeRange: { date: returnDate } },
      ],
      adults, cabin, max, maxStops, label: "live-openjaw",
    });
  }

  /**
   * 3단계: 진짜 그 값에 살 수 있는지, 수하물·환불규정까지 확정합니다.
   * 조회 때 값과 확정 값이 다르면 '확인 필요'로 표시하고 특가 확정을 막습니다.
   */
  async confirmPrice(candidate) {
    const offer = candidate._rawOffer;
    if (!offer) {
      candidate.notes.push("가격 확정 불가: 원본 응답이 없습니다");
      return candidate;
    }
    this.stats.confirmCalls++;
    const res = await this.client.request("/v1/shopping/flight-offers/pricing", {
      method: "POST",
      query: { include: "detailed-fare-rules,bags" },
      body: { data: { type: "flight-offers-pricing", flightOffers: [offer] } },
    });
    if (!res.ok) {
      this.stats.errors.push({ step: "confirm", id: candidate.id, status: res.status, error: res.error });
      candidate.notes.push(`가격 확정 실패(${res.status}): ${res.error}`);
      return candidate;
    }

    const priced = res.data?.data?.flightOffers?.[0];
    if (!priced) {
      candidate.notes.push("가격 확정 실패: 응답에 운임이 없습니다");
      return candidate;
    }

    const confirmed = normalizeOffer(priced, {
      priceType: PRICE_TYPE.CONFIRMED,
      fetchedAt: new Date().toISOString(),
    });

    // 조회 때 총액과 확정 총액이 다르면 특가로 확정하지 않습니다.
    if (candidate.total !== null && confirmed.total !== null && candidate.total !== confirmed.total) {
      markConflict(confirmed, "total", candidate.total, confirmed.total);
    }

    confirmed.fareRules = extractFareRules(res.data);
    if (confirmed.fareRules) {
      confirmed.unknown = confirmed.unknown.filter((k) => k !== "fareRules");
    }
    confirmed.ground = candidate.ground;
    confirmed.links = candidate.links;
    confirmed.notes = [...candidate.notes, ...confirmed.notes];
    return confirmed;
  }
}

/** 환불·변경 규정을 응답에서 꺼냅니다. 못 찾으면 null(=미확인). */
function extractFareRules(pricingData) {
  const rules = pricingData?.included?.["detailed-fare-rules"];
  if (!rules) return null;
  const texts = Object.values(rules)
    .flatMap((r) => r.fareNotes?.descriptions ?? [])
    .map((d) => `${d.descriptionType ?? ""}: ${d.text ?? ""}`);
  if (!texts.length) return null;

  const blob = texts.join("\n").toUpperCase();
  // 규정 문구에서 환불 가능 여부를 읽어봅니다. 애매하면 null(미확인)로 둡니다.
  let refundable = null;
  if (/\bNON[- ]?REFUNDABLE\b|\bTICKET IS NON REF/.test(blob)) refundable = false;
  else if (/\bREFUNDABLE\b|\bREFUND PERMITTED\b/.test(blob)) refundable = true;

  return { refundable, changeFeeKRW: null, conflict: false, rawTextCount: texts.length };
}
