// Travelpayouts(아비아세일즈) 어댑터.
//
// 이 공급자는 '넓게 훑기'만 할 수 있습니다.
// 실제 조회와 가격 확정은 못 하므로 capabilities 에 솔직히 적어둡니다.
// 그래서 이 공급자만 쓰면 결과는 전부 '확인 필요'로 남고 확정 특가는 나오지 않습니다.
import { FlightProvider } from "../base.js";
import { TravelpayoutsClient } from "./client.js";
import { normalizeRow, rowsFromCityDirections, rowsFromLatest } from "./normalize.js";
import { DESTINATIONS, uniqueByCity } from "../../config/destinations.js";

export class TravelpayoutsProvider extends FlightProvider {
  constructor(opts = {}) {
    super();
    this.client = opts.client ?? new TravelpayoutsClient(opts);
    this.currency = opts.currency ?? "KRW";
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [] };
  }

  get name() { return "travelpayouts"; }
  get capabilities() {
    // live/confirm 이 false 이므로 파이프라인이 알아서 '확정 특가'를 만들지 않습니다.
    return { indicative: true, live: false, confirm: false, openJaw: false };
  }

  /**
   * 1단계: 목적지를 하나씩 물어봅니다.
   *
   * 왜 '아무 데나' 방식을 안 쓰는가:
   *   목적지를 비우면 싼 순으로 정렬돼 제주·오사카 같은 단거리만 올라옵니다.
   *   유럽·아프리카는 아예 목록에 못 들어옵니다.
   * 왜 trip_duration 을 안 믿는가:
   *   14일을 요청해도 7·8·10일이 섞여 옵니다(실제 응답으로 확인).
   *   그래서 받은 뒤 우리가 직접 체류일수를 세어 거릅니다.
   *
   * 호출은 무료라서 목적지 수만큼(약 90회) 걸어도 부담이 없습니다.
   */
  async searchInspiration({ origin, departFrom, departTo, minTripDays, maxTripDays, destinations = [], limit = 500 }) {
    const fetchedAt = new Date().toISOString();
    const rows = [];
    const errors = [];
    const coverage = [];

    // 같은 도시를 두 번 묻지 않도록 도시 기준으로 추립니다 (런던 LHR/LGW 등)
    const targets = uniqueByCity(destinations.length ? destinations : DESTINATIONS);

    for (const d of targets) {
      this.stats.indicativeCalls++;
      const res = await this.client.request("/v2/prices/latest", {
        origin,
        destination: d.iata,
        currency: this.currency,
        period_type: "year",
        one_way: false,
        sorting: "price",
        show_to_affiliates: true,
        limit,
        page: 1,
      });
      if (!res.ok) {
        errors.push({ step: "latest", destination: d.iata, status: res.status, error: res.error });
        coverage.push({ destination: d.iata, city: d.city, rows: 0, error: res.error });
        continue;
      }
      const got = rowsFromLatest(res.data);
      rows.push(...got.map((r) => ({ row: r, endpoint: "v2/prices/latest" })));
      coverage.push({ destination: d.iata, city: d.city, rows: got.length });
    }

    this.stats.errors.push(...errors);
    this.lastCoverage = coverage;

    const candidates = this.#toCandidates(rows, { fetchedAt, departFrom, departTo, minTripDays, maxTripDays });
    if (!candidates.length && errors.length === targets.length) {
      return { ok: false, candidates: [], error: errors[0]?.error, status: errors[0]?.status, coverage };
    }
    return { ok: true, candidates, coverage };
  }

  /** 예비책: 목적지를 콕 집어 물어봅니다. */
  async searchCheapestDates({ origin, destination, departFrom, departTo, minTripDays, maxTripDays }) {
    this.stats.indicativeCalls++;
    const res = await this.client.request("/v2/prices/latest", {
      origin, destination,
      currency: this.currency,
      period_type: "year",
      one_way: false,
      sorting: "price",
      show_to_affiliates: true,
      limit: 200,
      page: 1,
    });
    if (!res.ok) {
      this.stats.errors.push({ step: "latest-dest", destination, status: res.status, error: res.error });
      return { ok: false, candidates: [], error: res.error, status: res.status };
    }
    const rows = rowsFromLatest(res.data).map((r) => ({ row: r, endpoint: "v2/prices/latest" }));
    return {
      ok: true,
      candidates: this.#toCandidates(rows, {
        fetchedAt: new Date().toISOString(), departFrom, departTo, minTripDays, maxTripDays,
      }),
    };
  }

  /**
   * 받은 줄들을 후보로 바꾸고, 조건에 안 맞는 것을 걸러냅니다.
   *  - 출발일이 우리가 정한 기간 밖이면 제외
   *  - 체류일수가 10~20일 밖이면 제외 (API 가 다른 것을 섞어 줄 수 있음)
   *  - 같은 (목적지·출발일·귀국일) 이 겹치면 싼 쪽만 남김
   */
  #toCandidates(rows, { fetchedAt, departFrom, departTo, minTripDays, maxTripDays }) {
    const best = new Map();
    for (const { row, endpoint } of rows) {
      const link = this.client.searchLink({
        origin: row.origin,
        destination: row.destination,
        departureDate: (row.departure_at ?? row.depart_date ?? "").slice(0, 10),
        returnDate: (row.return_at ?? row.return_date ?? "").slice(0, 10),
      });
      const c = normalizeRow(row, { currency: this.currency, fetchedAt, link, endpoint });

      const depart = c.outbound?.departAt?.slice(0, 10);
      if (!depart || !c.total) continue;
      if (departFrom && depart < departFrom) continue;
      if (departTo && depart > departTo) continue;
      if (c.tripDays === null) continue;
      if (c.tripDays < minTripDays || c.tripDays > maxTripDays) continue;

      const key = `${c.destIn}|${depart}|${c.inbound?.departAt?.slice(0, 10) ?? ""}`;
      const prev = best.get(key);
      if (!prev || c.total < prev.total) best.set(key, c);
    }
    return [...best.values()];
  }
}
