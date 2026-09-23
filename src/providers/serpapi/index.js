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
  normalizeDeal, normalizeExplore, normalizeFlightOffer, normalizeRoundTrip,
  rowsFromDeals, rowsFromExplore, offersFromFlights,
} from "./normalize.js";
import { findAirport } from "../../config/destinations.js";
import { planDetails } from "../../core/detailPlan.js";

// 지역 이름 -> 구글이 쓰는 지역 번호 (위키데이터 P646 에서 확인한 값)
//
// 값이 배열이면 **한 지역을 여러 번 나눠 조회**한다는 뜻입니다.
// 오세아니아는 전체를 가리키는 번호가 없어서 호주·뉴질랜드를 따로 불러야 합니다.
export const AREA_ID = {
  europe: "/m/02j9z",
  africa: "/m/0dg3n1",
  caucasus: "/m/0d0kn",   // 조지아
  mongolia: "/m/04w8f",   // 몽골
  oceania: ["/m/0chghy", "/m/0ctw_b"],   // 호주, 뉴질랜드
};

/** 지역 목록을 실제 조회 단위(= 호출 한 번짜리 area)로 펼칩니다. */
export function expandAreas(regions) {
  const out = [];
  for (const r of regions) {
    const id = AREA_ID[r];
    if (!id) continue;
    // 번호가 여럿이면 그 수만큼 조회 단위가 늘어납니다
    for (const one of Array.isArray(id) ? id : [id]) out.push([r, one]);
  }
  return out;
}

export class SerpApiProvider extends FlightProvider {
  constructor(opts = {}) {
    super();
    this.client = opts.client ?? new SerpApiClient(opts);
    this.currency = opts.currency ?? "KRW";
    // 발굴에 쓸 호출 수와 상세 조회에 쓸 호출 수를 따로 정합니다.
    // 계획서의 70:30 은 **상세 조회 예산**을 나누는 비율입니다.
    this.discoveryCalls = opts.discoveryCalls ?? 7;
    this.detailCalls = opts.detailCalls ?? 12;
    this.emptyRegionShare = opts.emptyRegionShare ?? 0.3;  // 자료 없는 지역 몫
    for (const n of [this.discoveryCalls, this.detailCalls]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("호출 예산은 0 이상의 정수여야 합니다");
    }
    if (!Number.isFinite(this.emptyRegionShare) || this.emptyRegionShare < 0 || this.emptyRegionShare > 1) {
      throw new Error("자료 부족 지역 비율은 0~1이어야 합니다");
    }
    this.detailUsed = 0;
    this.detailCache = new Map();
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [], skipped: [] };
  }

  get name() { return "serpapi"; }
  // 일정당 출국 목록 1회 + 선택한 출국편의 귀국 목록 1회를 확보합니다.
  get detailBudget() { return Math.floor(this.detailCalls / 2); }

  /**
   * 일정 하나를 **끝까지** 확인할 수 있을 때만 true.
   *
   * 출국 조회와 귀국 조회는 한 쌍입니다. 한 번만 부르고 예산이 떨어지면
   * 귀국 공항을 모르는 반쪽 결과가 남아 알림 자격도 못 얻고 호출만 버립니다.
   * 그래서 **두 번 치가 남아 있을 때만** 시작합니다.
   */
  canAffordPair() {
    if (this.detailCalls - this.detailUsed < 2) return false;
    const left = this.client.remaining?.();
    return left == null || left >= 2;
  }
  planDetails(ranked, opts) {
    return planDetails(ranked, { ...opts, emptyRegionShare: this.emptyRegionShare });
  }
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
    // 지역을 안 주면 우리가 아는 지역 전부를 봅니다.
    // 오세아니아처럼 번호가 둘인 지역은 여기서 두 칸으로 펼쳐집니다.
    const areas = expandAreas(regions.length ? regions : Object.keys(AREA_ID));

    const reserveDeals = departFrom && departTo ? 1 : 0;
    const cycle = Math.floor(Date.parse(departFrom ?? fetchedAt.slice(0, 10)) / 86400000 / 3);
    const durations = cycle % 2 ? ["3", "2"] : ["2", "3"];
    // 예산상 한 기간만 볼 수 있을 때도 매번 2주 여행만 수집하지 않게 순환합니다.
    for (const dur of durations) {          // 모든 지역을 한 번씩 본 뒤 두 번째 기간
      for (const [region, areaId] of areas) {
        if (budget <= reserveDeals) break;
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

    // 우리가 쫓는 지역만 남깁니다 (지역을 안 주면 AREA_ID 에 있는 전부)
    const wanted = new Set(regions.length ? regions : Object.keys(AREA_ID));
    const filtered = candidates.filter((c) => {
      const air = findAirport(c.destIn);
      return air ? wanted.has(air.region) : false;
    });

    return { ok: true, candidates: filtered, coverage, budgetLeft: budget };
  }

  /**
   * 2단계: 유망 후보를 자세히 조회합니다.
   * 첫 응답은 출국편만 있습니다. 토큰으로 귀국편을 추가 조회합니다.
   */
  async searchLive({ origin = "ICN", destination, departureDate, returnDate, max = 5, maxStops = 2 }) {
    // 출국·귀국은 한 쌍입니다. 두 번 치가 없으면 **아예 시작하지 않습니다.**
    // 반쪽만 조회하면 귀국 공항을 몰라 알림 자격도 못 얻고 호출만 버리게 됩니다.
    if (!this.canAffordPair()) {
      this.stats.skipped.push({ step: "pair", destination, error: "왕복 한 쌍을 채울 예산이 없어 시작하지 않음" });
      return { candidates: [], skipped: true, reason: "왕복 예산 부족" };
    }
    const params = {
      engine: "google_flights", departure_id: origin, arrival_id: destination,
      outbound_date: departureDate, return_date: returnDate,
      currency: this.currency, hl: "ko", gl: "kr",
      type: "1", travel_class: "1", adults: "1",
      stops: String(maxStops + 1), sort_by: "2",
    };
    const search = async (p) => {
      const key = JSON.stringify(p);
      if (this.detailCache.has(key)) return this.detailCache.get(key);
      if (this.detailUsed >= this.detailCalls) return { ok: false, skipped: true, error: "상세 조회 예산 소진" };
      this.detailUsed++;
      this.stats.liveCalls++;
      const promise = this.client.search(p);
      this.detailCache.set(key, promise);
      return promise;
    };
    const res = await search(params);
    if (!res.ok) {
      (res.skipped ? this.stats.skipped : this.stats.errors).push({ step: "flights", destination, error: res.error });
      return { ok: false, candidates: [], error: res.error, skipped: res.skipped };
    }
    const fetchedAt = new Date().toISOString();
    const opts = { currency: this.currency, fetchedAt, priceInsights: res.data.price_insights, origin, returnDate };
    const offers = offersFromFlights(res.data)
      .filter((o) => Number.isFinite(o.price) && o.price > 0)
      .sort((a, b) => a.price - b.price);
    const eligible = offers.filter((o) => {
      const c = normalizeFlightOffer(o, opts);
      return c.departureAirportVerified && c.outbound.stops <= maxStops
        && (c.destIn === destination || findAirport(c.destIn)?.city_code === destination)
        && c.outbound.departAt?.slice(0, 10) === departureDate;
    });
    let candidates = eligible.slice(0, max).map((o) => normalizeFlightOffer(o, opts));
    const selected = eligible.find((o) => o.departure_token);
    let url = res.data.search_metadata?.google_flights_url;
    if (selected) {
      const back = await search({ ...params, departure_token: selected.departure_token });
      if (back.ok) {
        const complete = offersFromFlights(back.data)
          .map((o) => normalizeRoundTrip(selected, o, opts))
          .filter((c) => c.returnAirportVerified && c.inbound.stops <= maxStops
            && (c.destOut === destination || findAirport(c.destOut)?.city_code === destination)
            && c.inbound.departAt?.slice(0, 10) === returnDate && Number.isFinite(c.total) && c.total > 0);
        candidates = [...complete, ...candidates];
        url = back.data.search_metadata?.google_flights_url ?? url;
      } else {
        (back.skipped ? this.stats.skipped : this.stats.errors).push({ step: "return", destination, error: back.error });
      }
    }
    for (const c of candidates) {
      if (url) c.links = [{ label: "Google 항공권에서 같은 조건 확인", url }];
      if (!c.returnAirportVerified) c.notes.push("귀국편 구간과 실제 인천 도착일은 아직 확인하지 못했습니다.");
    }
    return { ok: true, candidates };
  }

  /** 판매 화면 확인은 하지 않습니다. 그대로 돌려줍니다. */
  async confirmPrice(candidate) {
    candidate.notes.push("이 앱은 판매 화면 최종 확인까지는 하지 않습니다.");
    return candidate;
  }

}
