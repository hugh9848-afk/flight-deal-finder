// SerpApi 어댑터.
//
// 세 가지 창구를 역할에 맞게 나눠 씁니다.
//   Explore : 유럽·아프리카를 넓게 훑는다 (한 번에 76~96곳)
//   Deals   : 할인율이 붙은 후보를 찾는다 (구글이 할인율을 직접 준다)
//   Flights : 유망 후보를 자세히 조회한다 (구간·경유·가격이력)
//
// 호출 하나하나가 돈이므로, 예산을 정해두고 그 안에서만 씁니다.
import { FlightProvider } from "../base.js";
import { SerpApiClient } from "./client.js";
import {
  normalizeDeal, normalizeExplore, normalizeFlightOffer,
  rowsFromDeals, rowsFromExplore, offersFromFlights,
} from "./normalize.js";
import { findAirport } from "../../config/destinations.js";

// 지역 이름 -> 구글이 쓰는 지역 번호 (위키데이터에서 확인한 값)
export const AREA_ID = {
  europe: "/m/02j9z",
  africa: "/m/0dg3n1",
  caucasus: "/m/0d0kn",   // 조지아
  mongolia: "/m/04w8f",   // 몽골
};

export class SerpApiProvider extends FlightProvider {
  constructor(opts = {}) {
    super();
    this.client = opts.client ?? new SerpApiClient(opts);
    this.currency = opts.currency ?? "KRW";
    // 발굴에 쓸 호출 수와 상세 조회에 쓸 호출 수를 따로 정합니다.
    // 계획서의 70:30 은 **상세 조회 예산**을 나누는 비율입니다.
    this.discoveryCalls = opts.discoveryCalls ?? 6;
    this.detailCalls = opts.detailCalls ?? 12;
    this.emptyRegionShare = opts.emptyRegionShare ?? 0.3;  // 자료 없는 지역 몫
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [], skipped: [] };
  }

  get name() { return "serpapi"; }
  get capabilities() {
    // 실제 조회는 되지만, 판매 화면에서 확인한 것은 아니므로 confirm 은 false 입니다.
    return { indicative: true, live: true, confirm: false, openJaw: false };
  }

  /** 시작 전에 잔여량을 확인합니다. 실패하면 이 공급자는 쓰지 않습니다. */
  async prepare() {
    const q = await this.client.checkQuota();
    if (!q.ok) this.stats.errors.push({ step: "quota", error: q.error });
    return q;
  }

  /**
   * 1단계: 넓게 훑기.
   * 지역별 Explore + 날짜 구간별 Deals 를 정해진 호출 수 안에서 씁니다.
   */
  async searchInspiration({ origin = "ICN", departFrom, departTo, minTripDays, maxTripDays, regions = [] } = {}) {
    const fetchedAt = new Date().toISOString();
    const candidates = [];
    const coverage = [];
    let budget = this.discoveryCalls;

    // ── Explore: 지역을 넓게 (기간은 1주·2주 두 가지만 지원) ──
    const areas = (regions.length ? regions : ["europe", "africa"])
      .map((r) => [r, AREA_ID[r]]).filter(([, id]) => id);

    for (const [region, areaId] of areas) {
      if (budget <= 0) break;
      for (const dur of ["3", "2"]) {          // 3=2주, 2=1주
        if (budget <= 0) break;
        budget--;
        this.stats.indicativeCalls++;
        const res = await this.client.search({
          engine: "google_travel_explore", departure_id: origin, arrival_area_id: areaId,
          currency: this.currency, hl: "ko", gl: "kr",
          type: "1", month: "0", travel_duration: dur, travel_class: "1", adults: "1",
        });
        if (!res.ok) {
          (res.skipped ? this.stats.skipped : this.stats.errors).push({ step: "explore", region, error: res.error });
          continue;
        }
        const rows = rowsFromExplore(res.data);
        const got = rows.map((r) => normalizeExplore(r, { currency: this.currency, fetchedAt, origin }));
        candidates.push(...got);
        coverage.push({ engine: "explore", region, duration: dur, rows: rows.length,
                        priced: got.filter((c) => c.total !== null).length });
      }
    }

    // ── Deals: 할인율이 붙은 후보 (여행 기간을 정확히 지정할 수 있는 유일한 창구) ──
    if (budget > 0 && departFrom && departTo) {
      budget--;
      this.stats.indicativeCalls++;
      const res = await this.client.search({
        engine: "google_flights_deals", departure_id: origin,
        outbound_date: `${departFrom},${departTo}`,
        // 구글은 '날짜 차이'로 세고 우리는 '떠나는 날'도 하루로 셉니다. 그래서 1을 뺍니다.
        trip_length: `${Math.max(1, minTripDays - 1)},${Math.max(1, maxTripDays - 1)}`,
        currency: this.currency, hl: "ko", gl: "kr",
        type: "1", travel_class: "1", adults: "1",
      });
      if (res.ok) {
        const rows = rowsFromDeals(res.data);
        const got = rows.map((r) => normalizeDeal(r, { currency: this.currency, fetchedAt, origin }));
        candidates.push(...got);
        coverage.push({ engine: "deals", rows: rows.length });
      } else {
        (res.skipped ? this.stats.skipped : this.stats.errors).push({ step: "deals", error: res.error });
      }
    }

    // 우리가 쫓는 지역(유럽·아프리카·캅카스·몽골)만 남깁니다
    const wanted = new Set(regions.length ? regions : ["europe", "africa", "caucasus", "mongolia"]);
    const filtered = candidates.filter((c) => {
      const air = findAirport(c.destIn);
      return air ? wanted.has(air.region) : false;
    });

    return { ok: true, candidates: filtered, coverage, budgetLeft: budget };
  }

  /**
   * 2단계: 유망 후보를 자세히 조회합니다.
   * 한 번 호출로 왕복 총액·구간·경유·구글 가격이력까지 받습니다.
   */
  async searchLive({ origin = "ICN", destination, departureDate, returnDate, max = 5 }) {
    this.stats.liveCalls++;
    const res = await this.client.search({
      engine: "google_flights", departure_id: origin, arrival_id: destination,
      outbound_date: departureDate, return_date: returnDate,
      currency: this.currency, hl: "ko", gl: "kr",
      type: "1", travel_class: "1", adults: "1",
    });
    if (!res.ok) {
      (res.skipped ? this.stats.skipped : this.stats.errors).push({ step: "flights", destination, error: res.error });
      return { ok: false, candidates: [], error: res.error, skipped: res.skipped };
    }
    const fetchedAt = new Date().toISOString();
    const offers = offersFromFlights(res.data).slice(0, max);
    const candidates = offers.map((o) => normalizeFlightOffer(o, {
      currency: this.currency, fetchedAt, priceInsights: res.data.price_insights, origin, returnDate,
    }));
    return { ok: true, candidates };
  }

  /** 판매 화면 확인은 하지 않습니다. 그대로 돌려줍니다. */
  async confirmPrice(candidate) {
    candidate.notes.push("이 앱은 판매 화면 최종 확인까지는 하지 않습니다.");
    return candidate;
  }

  /**
   * 상세 조회 예산을 나눕니다.
   * 늘 많이 나오는 도시가 예산을 독점하지 않도록, 일부는 '자료 없는 지역'에 씁니다.
   * @param {Array} ranked  좋아 보이는 순서로 정렬된 후보
   * @param {Set}   thinSet 자료가 부족한 목적지 코드
   */
  splitDetailBudget(ranked, thinSet) {
    const total = this.detailCalls;
    const forThin = Math.round(total * this.emptyRegionShare);
    const forTop = total - forThin;

    const top = ranked.filter((x) => !thinSet.has(x.candidate?.destIn ?? x.destIn)).slice(0, forTop);
    const thin = ranked.filter((x) => thinSet.has(x.candidate?.destIn ?? x.destIn)).slice(0, forThin);
    return { top, thin, plan: { total, forTop, forThin } };
  }
}
