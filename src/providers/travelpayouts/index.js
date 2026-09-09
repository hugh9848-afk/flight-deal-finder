// Travelpayouts(아비아세일즈) 어댑터.
//
// 이 공급자는 '넓게 훑기'만 할 수 있습니다.
// 실제 조회와 가격 확정은 못 하므로 capabilities 에 솔직히 적어둡니다.
// 그래서 이 공급자만 쓰면 결과는 전부 '확인 필요'로 남고 확정 특가는 나오지 않습니다.
import { FlightProvider } from "../base.js";
import { TravelpayoutsClient } from "./client.js";
import { normalizeRow, normalizeV3Row, rowsFromCityDirections, rowsFromLatest, rowsFromV3 } from "./normalize.js";
import { DESTINATIONS, uniqueByCity, findAirport } from "../../config/destinations.js";

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
  async searchInspiration({ origin, departFrom, departTo, minTripDays, maxTripDays, destinations = [], limit = 500, slack = 0 }) {
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
      // v2 가 실패해도 v3 는 따로 시도합니다.
      // 서로 보완하려고 둘을 쓰는데 하나가 죽었다고 나머지까지 막으면 안 됩니다.
      let got = [];
      if (res.ok) {
        got = rowsFromLatest(res.data);
        rows.push(...got.map((r) => ({ row: r, endpoint: "v2/prices/latest" })));
      } else {
        errors.push({ step: "latest", destination: d.iata, status: res.status, error: res.error });
      }

      // v3 도 함께 물어봅니다. 건수는 v2 보다 적지만 훨씬 자세합니다.
      // (진짜 공항, 가는·오는 편 이동시간, 귀국 경유 횟수, 판매처, 확인 링크)
      this.stats.indicativeCalls++;
      const res3 = await this.client.request("/aviasales/v3/prices_for_dates", {
        origin, destination: d.iata, currency: this.currency,
        one_way: false, sorting: "price", limit: 1000, page: 1,
      });
      let got3 = [];
      if (res3.ok) {
        got3 = rowsFromV3(res3.data);
        rows.push(...got3.map((r) => ({ row: r, endpoint: "aviasales/v3/prices_for_dates" })));
      } else {
        errors.push({ step: "v3", destination: d.iata, status: res3.status, error: res3.error });
      }
      coverage.push({
        destination: d.iata, city: d.city,
        rows: got.length + got3.length, v2: got.length, v3: got3.length,
        v2ok: res.ok, v3ok: res3.ok,
      });
    }

    this.stats.errors.push(...errors);
    this.lastCoverage = coverage;

    const candidates = this.#toCandidates(rows, { fetchedAt, departFrom, departTo, minTripDays, maxTripDays, slack });
    // 목적지마다 2번(v2·v3) 부르므로, '전부 실패' 는 오류가 2배일 때입니다
    if (!candidates.length && errors.length >= targets.length * 2) {
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
  #toCandidates(rows, { fetchedAt, departFrom, departTo, minTripDays, maxTripDays, slack = 0 }) {
    // 시차와 밤 비행기 때문에 경계에 걸친 일정이 통째로 빠지지 않도록
    // 받을 때는 앞뒤로 slack 일만큼 넉넉하게 받습니다.
    const lo = Math.max(1, minTripDays - slack);
    const hi = maxTripDays + slack;
    const best = new Map();
    for (const { row, endpoint } of rows) {
      let c;
      if (endpoint.startsWith("aviasales/v3")) {
        // v3 전용 변환기 (실제 공항·이동시간·귀국 경유·확인 링크가 들어 있습니다)
        c = normalizeV3Row(row, { currency: this.currency, fetchedAt, marker: this.client.marker });
      } else {
        const link = this.client.searchLink({
          origin: row.origin,
          destination: row.destination,
          departureDate: (row.departure_at ?? row.depart_date ?? "").slice(0, 10),
          returnDate: (row.return_at ?? row.return_date ?? "").slice(0, 10),
        });
        c = normalizeRow(row, { currency: this.currency, fetchedAt, link, endpoint });
      }

      const depart = c.outbound?.departAt?.slice(0, 10);
      if (!depart || !c.total) continue;
      if (departFrom && depart < departFrom) continue;
      if (departTo && depart > departTo) continue;
      if (c.tripDays === null) continue;
      if (c.tripDays < lo || c.tripDays > hi) continue;
      // 넉넉히 받은 것 중 실제 범위를 벗어난 건 '경계 후보'로 표시해 둡니다.
      if (c.tripDays < minTripDays || c.tripDays > maxTripDays) {
        c.notes.push(`여행 일수 ${c.tripDays}일 — 요청 범위(${minTripDays}~${maxTripDays}일) 경계 밖. 실제 인천 도착일에 따라 달라질 수 있습니다.`);
        c.outOfRange = true;
      }

      // 같은 일정(도시 + 출발일 + 귀국일)이라도 **같은 운임이라는 보장이 없습니다.**
      // 항공사·편명·판매처가 다를 수 있으므로, 값이 다르면 둘 다 남깁니다.
      //
      // 예전에는 v3 를 무조건 우선했는데, 그러면
      // v2 50만원짜리가 v3 150만원 때문에 사라졌습니다. 가장 중요한 단서를 잃는 셈입니다.
      const city = findAirport(c.destIn)?.city_code ?? c.destIn;
      const back = c.inbound?.departAt?.slice(0, 10) ?? "";
      const slot = `${city}|${depart}|${back}`;
      const key = `${slot}|${c.total}`;          // 값까지 같아야 같은 후보
      const prev = best.get(key);

      const isV3 = (x) => Boolean(x.raw?.endpoint?.startsWith("aviasales/v3"));
      // 값도 같고 일정도 같으면 자세한 쪽(v3)만 남깁니다
      if (!prev || (isV3(c) && !isV3(prev))) {
        c.itinerarySlot = slot;                  // 같은 일정끼리 묶어 보여줄 때 씁니다
        best.set(key, c);
      }
    }
    return [...best.values()];
  }
}
