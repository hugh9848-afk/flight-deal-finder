// Travelpayouts 어댑터 시험.
// 문서에 나온 실제 응답 예시를 그대로 써서 확인합니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TravelpayoutsProvider } from "../src/providers/travelpayouts/index.js";
import { TravelpayoutsClient } from "../src/providers/travelpayouts/client.js";
import { normalizeRow, rowsFromCityDirections, rowsFromLatest } from "../src/providers/travelpayouts/normalize.js";
import { runScan } from "../src/pipeline/scan.js";
import { PriceHistory } from "../src/store/history.js";
import { AlertState } from "../src/store/alertState.js";
import { PRICE_TYPE } from "../src/core/model.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-test-"));
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  return { history: new PriceHistory(path.join(dir, "history")), alertState: new AlertState(path.join(dir, "s.json")) };
}

/**
 * 전화기를 흉내 내는 가짜 (진짜 통신은 하지 않습니다).
 * 이제 어댑터가 목적지별로 물어보므로, 목적지를 열쇠로 응답을 돌려줍니다.
 */
class FakeClient {
  constructor(rowsByDestination) { this.rowsByDestination = rowsByDestination; this.calls = []; }
  async request(path, query) {
    this.calls.push({ path, query });
    if (path === "/v2/prices/latest") {
      return { ok: true, status: 200, data: { success: true, data: this.rowsByDestination[query.destination] ?? [] } };
    }
    return { ok: true, status: 200, data: { success: true, data: {} } };
  }
  searchLink(a) { return TravelpayoutsClient.prototype.searchLink.call({ marker: "m1" }, a); }
}

/** 목적지 목록을 만들어 줍니다 (어댑터가 이 목록을 돌며 물어봅니다). */
function dests(...codes) {
  return codes.map((iata) => ({ iata, city: iata, city_code: iata, region: "europe", lat: 0, lon: 0 }));
}

test("문서에 나온 v1 응답을 그대로 읽어낸다", () => {
  const rows = rowsFromCityDirections({
    success: true,
    data: { CDG: { origin: "ICN", destination: "CDG", price: 837700, transfers: 1, airline: "MU",
                   flight_number: 5034, departure_at: "2026-10-11T16:35:00Z",
                   return_at: "2026-10-25T16:05:00Z", expires_at: "2026-09-10T09:32:44Z" } },
  });
  assert.equal(rows.length, 1);
  const c = normalizeRow(rows[0], { endpoint: "v1" });
  assert.equal(c.total, 837700);
  assert.equal(c.tripDays, 15, "떠나는 날을 1일째로 세므로 15일");
  assert.equal(c.outbound.stops, 1);
  assert.equal(c.priceValidUntil, "2026-09-10T09:32:44Z");
  assert.equal(c.priceType, PRICE_TYPE.INDICATIVE, "참고가로 표시되어야 한다");
});

test("문서에 나온 v2 응답을 그대로 읽어낸다", () => {
  const rows = rowsFromLatest({ success: true, data: [
    { origin: "ICN", destination: "CDG", depart_date: "2026-11-10", return_date: "2026-11-24",
      number_of_changes: 1, value: 912000, found_at: "2026-09-01T06:33:32+04:00", distance: 8900, actual: true },
  ]});
  const c = normalizeRow(rows[0], { endpoint: "v2" });
  assert.equal(c.total, 912000);
  assert.equal(c.tripDays, 15, "떠나는 날을 1일째로 세므로 15일");
  assert.equal(c.tripDaysBasis, "local_departure_estimated", "인천 도착일을 모르므로 어림값이어야 한다");
  assert.equal(c.raw.observedAt, "2026-09-01T06:33:32+04:00");
});

test("없는 값을 지어내지 않고 미확인으로 남긴다", () => {
  const c = normalizeRow({ origin: "ICN", destination: "TBS", value: 700000,
                           depart_date: "2026-11-10", return_date: "2026-11-22" }, {});
  assert.equal(c.total, 700000);
  assert.equal(c.taxes, null, "세금 정보가 없으면 null 이어야 한다");
  assert.equal(c.baggage, null);
  assert.equal(c.fareRules, null);
  assert.equal(c.selfTransfer, null, "알 수 없으면 false 가 아니라 null 이어야 한다");
  assert.equal(c.outbound.durationMin, null);
  for (const k of ["taxes", "baggage", "fareRules", "selfTransfer", "airportChange"]) {
    assert.ok(c.unknown.includes(k), `${k} 가 미확인 목록에 있어야 한다`);
  }
});

test("'최신 아님' 표시가 붙은 가격은 기록에 남긴다", () => {
  const c = normalizeRow({ origin: "ICN", destination: "CDG", value: 500000,
                           depart_date: "2026-11-10", return_date: "2026-11-22", actual: false }, {});
  assert.ok(c.notes.some((n) => n.includes("최신 아님")));
});

test("체류일수와 출발 기간을 벗어난 후보는 걸러낸다", async () => {
  const p = new TravelpayoutsProvider({
    client: new FakeClient({
      CDG: [{ origin: "ICN", destination: "CDG", depart_date: "2026-11-10", return_date: "2026-11-24", value: 900000, number_of_changes: 1 }],
      FCO: [{ origin: "ICN", destination: "FCO", depart_date: "2026-11-10", return_date: "2026-11-17", value: 400000, number_of_changes: 1 }], // 체류 7일 → 제외
      VIE: [{ origin: "ICN", destination: "VIE", depart_date: "2026-09-01", return_date: "2026-09-15", value: 300000, number_of_changes: 1 }], // 기간 밖 → 제외
    }),
  });
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-06-30",
    minTripDays: 10, maxTripDays: 20, destinations: dests("CDG", "FCO", "VIE"),
  });
  assert.equal(r.ok, true);
  const got = r.candidates.map((c) => c.destIn);
  assert.deepEqual(got, ["CDG"], `조건에 맞는 것만 남아야 한다 (실제: ${got.join(",")})`);
  assert.ok(r.candidates[0].links[0].url.includes("aviasales.com/search/ICN1011CDG2411"));
});

test("값이 다르면 같은 날짜라도 둘 다 남긴다 (싼 후보를 잃지 않기 위해)", async () => {
  const p = new TravelpayoutsProvider({
    client: new FakeClient({
      CDG: [
        { origin: "ICN", destination: "CDG", depart_date: "2026-11-10", return_date: "2026-11-20", value: 900000 },
        { origin: "ICN", destination: "CDG", depart_date: "2026-11-10", return_date: "2026-11-20", value: 750000 },
      ],
    }),
  });
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-06-30",
    minTripDays: 5, maxTripDays: 20, destinations: dests("CDG"),
  });
  // 날짜가 같아도 값이 다르면 다른 운임일 수 있습니다. 함부로 지우지 않습니다.
  assert.equal(r.candidates.length, 2, "값이 다르면 둘 다 남아야 한다");
  const totals = r.candidates.map((c) => c.total).sort((a, b) => a - b);
  assert.deepEqual(totals, [750000, 900000]);
  // 같은 일정끼리 묶어 볼 수 있도록 표시가 붙어야 합니다
  assert.equal(new Set(r.candidates.map((c) => c.itinerarySlot)).size, 1);
});

test("값까지 같으면 하나만 남기고 자세한 v3 를 고른다", async () => {
  class SamePriceClient {
    constructor() { this.marker = "m1"; }
    async request(path) {
      if (path === "/v2/prices/latest") {
        return { ok: true, status: 200, data: { success: true, data: [
          { origin: "ICN", destination: "PAR", depart_date: "2026-11-10",
            return_date: "2026-11-20", value: 730000, number_of_changes: 1 },
        ]}};
      }
      return { ok: true, status: 200, data: { data: [
        { origin: "SEL", destination: "PAR", origin_airport: "ICN", destination_airport: "CDG",
          departure_at: "2026-11-10T10:00:00+09:00", return_at: "2026-11-20T12:00:00+01:00",
          price: 730000, transfers: 1, return_transfers: 2,
          duration_to: 900, duration_back: 840, gate: "Trip.com", link: "/search/x" },
      ]}};
    }
    searchLink() { return "https://x"; }
  }
  const p = new TravelpayoutsProvider({ client: new SamePriceClient() });
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-06-30",
    minTripDays: 5, maxTripDays: 20, destinations: dests("CDG"),
  });
  assert.equal(r.candidates.length, 1, "값이 같으면 하나만 남는다");
  const c = r.candidates[0];
  assert.equal(c.destIn, "CDG", "도시코드가 아니라 실제 공항");
  assert.equal(c.outbound.durationMin, 900);
  assert.equal(c.inbound.stops, 2, "귀국편 경유 횟수를 알아야 한다");
});

test("비싼 v3 가 싼 v2 를 지우면 안 된다", async () => {
  // 점검에서 발견된 결함: 날짜만 같으면 v3 를 무조건 남겨서
  // v2 50만원짜리가 v3 150만원 때문에 사라졌다.
  class CheapV2Client {
    constructor() { this.marker = "m1"; }
    async request(path) {
      if (path === "/v2/prices/latest") {
        return { ok: true, status: 200, data: { success: true, data: [
          { origin: "ICN", destination: "PAR", depart_date: "2026-11-10",
            return_date: "2026-11-20", value: 500000, number_of_changes: 1 },
        ]}};
      }
      return { ok: true, status: 200, data: { data: [
        { origin: "SEL", destination: "PAR", origin_airport: "ICN", destination_airport: "CDG",
          departure_at: "2026-11-10T10:00:00+09:00", return_at: "2026-11-20T12:00:00+01:00",
          price: 1500000, transfers: 1, return_transfers: 1,
          duration_to: 900, duration_back: 840, link: "/search/x" },
      ]}};
    }
    searchLink() { return "https://x"; }
  }
  const p = new TravelpayoutsProvider({ client: new CheapV2Client() });
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-06-30",
    minTripDays: 5, maxTripDays: 20, destinations: dests("CDG"),
  });
  const totals = r.candidates.map((c) => c.total).sort((a, b) => a - b);
  assert.ok(totals.includes(500000), `싼 후보가 남아야 한다 (실제: ${totals.join(",")})`);
  assert.equal(r.candidates.length, 2, "값이 다르므로 둘 다 남는다");
});

test("v2 가 실패해도 v3 는 따로 시도한다", async () => {
  const calls = [];
  class V2FailsClient {
    constructor() { this.marker = "m1"; }
    async request(path) {
      calls.push(path);
      if (path === "/v2/prices/latest") return { ok: false, status: 503, error: "서버 오류" };
      return { ok: true, status: 200, data: { data: [
        { origin: "SEL", destination: "PAR", origin_airport: "ICN", destination_airport: "CDG",
          departure_at: "2026-11-10T10:00:00+09:00", return_at: "2026-11-20T12:00:00+01:00",
          price: 800000, transfers: 1, return_transfers: 1,
          duration_to: 900, duration_back: 840, link: "/search/x" },
      ]}};
    }
    searchLink() { return "https://x"; }
  }
  const p = new TravelpayoutsProvider({ client: new V2FailsClient() });
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-06-30",
    minTripDays: 5, maxTripDays: 20, destinations: dests("CDG"),
  });
  assert.ok(calls.includes("/aviasales/v3/prices_for_dates"), "v2 가 죽어도 v3 는 불러야 한다");
  assert.equal(r.candidates.length, 1, "v3 결과는 살아남아야 한다");
  assert.equal(r.candidates[0].total, 800000);
});

test("응답이 없는 호출은 정해진 시간에 끊는다", async () => {
  const { TravelpayoutsClient } = await import("../src/providers/travelpayouts/client.js");
  const real = globalThis.fetch;
  // 영영 응답하지 않는 서버를 흉내 냅니다 (신호를 받으면 중단)
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; reject(e);
    });
  });
  try {
    const c = new TravelpayoutsClient({ token: "t", minIntervalMs: 0, timeoutMs: 50 });
    const started = Date.now();
    const r = await c.request("/v2/prices/latest", {});
    const took = Date.now() - started;
    assert.equal(r.ok, false);
    assert.match(r.error, /응답 없음/);
    // 3번까지 재시도하므로 넉넉히 잡되, 영영 매달리지는 않아야 합니다
    assert.ok(took < 5000, `끝없이 기다리면 안 된다 (실제 ${took}ms)`);
  } finally { globalThis.fetch = real; }
});

test("공급자가 느리면 시간 예산 안에서 멈추고 그 사실을 남긴다", async () => {
  // 한 번 부를 때마다 시간이 걸리는 공급자를 흉내 냅니다
  class SlowClient {
    constructor() { this.marker = "m1"; this.calls = 0; }
    async request() {
      this.calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200, data: { success: true, data: [] } };
    }
    searchLink() { return "https://x"; }
  }
  const client = new SlowClient();
  const p = new TravelpayoutsProvider({ client });
  const many = Array.from({ length: 50 }, (_, i) => ({
    iata: "X" + i, city: "도시" + i, city_code: "X" + i, region: "europe", lat: 0, lon: 0,
  }));
  const r = await p.searchInspiration({
    origin: "ICN", departFrom: "2026-10-01", departTo: "2027-03-09",
    minTripDays: 5, maxTripDays: 20, destinations: many,
    timeBudgetMs: 200,          // 0.2초만 허용
  });
  assert.equal(r.ok, true, "시간이 다 돼도 그때까지 모은 것은 돌려줘야 한다");
  assert.ok(client.calls < 50, `50곳을 다 돌면 안 된다 (실제 ${client.calls}곳)`);
  assert.ok(p.stats.errors.some((e) => e.step === "time-budget"),
    "시간이 모자랐다는 사실을 기록해야 한다");
});

test("귀국편 경유가 많으면 가는 편이 괜찮아도 걸러낸다", async () => {
  const { history, alertState } = tmp();
  class ReturnStopsClient {
    constructor() { this.marker = "m1"; }
    async request(path, q) {
      if (path === "/v2/prices/latest") return { ok: true, status: 200, data: { success: true, data: [] } };
      return { ok: true, status: 200, data: { data: [
        { origin: "SEL", destination: q.destination, origin_airport: "ICN", destination_airport: q.destination,
          departure_at: "2026-11-10T10:00:00+09:00", return_at: "2026-11-20T12:00:00+01:00",
          price: 800000, transfers: 1,
          return_transfers: q.destination === "PRG" ? 4 : 1,   // 프라하만 귀국 4회 경유
          duration_to: 900, duration_back: 840, link: "/search/x" },
      ]}};
    }
    searchLink() { return "https://x"; }
  }
  const r = await runScan({
    provider: new TravelpayoutsProvider({ client: new ReturnStopsClient() }),
    history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });
  const kept = r.needsReview.map((i) => i.candidate.destIn);
  assert.ok(!kept.includes("PRG"), "귀국편 경유 4회짜리는 걸러져야 한다");
  assert.ok(kept.length > 0, "나머지는 남아야 한다");
});

test("출발 공항이 인천으로 확인되지 않으면 알리지 않는다", async () => {
  const { history, alertState } = tmp();
  const codes = ["CDG", "FCO", "VIE", "PRG", "MAD", "BCN", "LIS", "ATH", "BUD", "WAW"];
  class GmpClient {
    constructor() { this.marker = "m1"; }
    async request(path, q) {
      if (path === "/v2/prices/latest") return { ok: true, status: 200, data: { success: true, data: [] } };
      return { ok: true, status: 200, data: { data: Array.from({ length: 6 }, (_, k) => ({
        origin: "SEL", destination: q.destination,
        origin_airport: q.destination === "FCO" ? "GMP" : "ICN",   // 로마행만 김포 출발
        destination_airport: q.destination,
        departure_at: `2026-11-${String(10 + k).padStart(2, "0")}T10:00:00+09:00`,
        return_at: `2026-11-${String(20 + k).padStart(2, "0")}T12:00:00+01:00`,
        price: q.destination === "FCO" ? 300000 : 1200000 + k * 5000,
        transfers: 1, return_transfers: 1, duration_to: 900, duration_back: 840, link: "/search/x",
      }))}};
    }
    searchLink() { return "https://x"; }
  }
  const opts = { history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {} };
  const mk = () => new TravelpayoutsProvider({ client: new GmpClient() });
  await runScan({ provider: mk(), ...opts });   // 이력 쌓기
  const r = await runScan({ provider: mk(), ...opts });

  const fco = r.needsReview.find((i) => i.candidate.destIn === "FCO");
  assert.equal(fco, undefined, "김포 출발로 확인된 후보는 ICN 전용 목록에서 제외한다");
  assert.ok(!r.alerts.some((a) => a.candidate.destIn === "FCO"),
    "출발 공항이 인천으로 확인되지 않으면 아무리 싸도 알리지 않는다");
});

test("여행 일수가 경계 밖인 후보는 알림으로 내보내지 않는다", async () => {
  const { history, alertState } = tmp();
  // 21일짜리(범위 밖)와 15일짜리(범위 안)를 같은 조건으로 내놓습니다
  const codes = ["CDG", "FCO", "VIE", "PRG", "MAD", "BCN", "LIS", "ATH", "BUD", "WAW"];
  const build = (fcoDays) => {
    const byDest = {};
    codes.forEach((d, i) => {
      byDest[d] = Array.from({ length: 6 }, (_, k) => ({
        origin: "ICN", destination: d,
        depart_date: `2026-11-${String(10 + k).padStart(2, "0")}`,
        return_date: `2026-11-${String(10 + k + (d === "FCO" ? fcoDays : 14) - 1).padStart(2, "0")}`,
        value: (d === "FCO" ? 1_150_000 : 1_200_000 + i * 20000) + k * 5000,
        number_of_changes: 1,
      }));
    });
    return byDest;
  };
  const opts = { history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {} };

  // 이력을 쌓아 신뢰도를 올립니다 (평범한 값으로 두 번)
  await runScan({ provider: new TravelpayoutsProvider({ client: new FakeClient(build(15)) }), ...opts });
  await runScan({ provider: new TravelpayoutsProvider({ client: new FakeClient(build(15)) }), ...opts });

  // 이제 FCO 를 21일(범위 밖)이면서 아주 싸게 만듭니다
  const cheapOutOfRange = build(21);
  for (const r of cheapOutOfRange.FCO) r.value = 380000;
  const r = await runScan({
    provider: new TravelpayoutsProvider({ client: new FakeClient(cheapOutOfRange) }), ...opts,
  });

  const fco = r.needsReview.find((i) => i.candidate.destIn === "FCO");
  assert.ok(fco, "경계 밖이어도 목록에는 남아야 한다");
  assert.equal(fco.candidate.outOfRange, true);
  assert.ok(fco.candidate.notes.some((n) => n.includes("경계 밖")));
  assert.ok(!r.alerts.some((a) => a.candidate.destIn === "FCO"),
    "경계 밖 후보는 아무리 싸도 알림으로 나가면 안 된다");
});

test("값이 실제로 떨어져도 귀국 공항·도착일이 없는 참고가는 알리지 않는다", async () => {
  const { history, alertState } = tmp();
  const codes = ["CDG", "FCO", "VIE", "PRG", "MAD", "BCN", "LIS", "ATH", "BUD", "WAW"];

  /** 목적지마다 여러 날짜를 내놓는 공급자를 만듭니다. fcoPrice 로 로마 값만 조절합니다. */
  const providerWith = (fcoPrice) => {
    const byDest = {};
    codes.forEach((d, i) => {
      byDest[d] = Array.from({ length: 6 }, (_, k) => ({
        origin: "ICN", destination: d,
        depart_date: `2026-11-${String(10 + k).padStart(2, "0")}`,
        return_date: `2026-11-${String(24 + k).padStart(2, "0")}`,
        value: (d === "FCO" ? fcoPrice : 1200000 + i * 20000) + k * 5000,
        number_of_changes: 1,
      }));
    });
    return new TravelpayoutsProvider({ client: new FakeClient(byDest) });
  };
  const opts = { history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {} };

  // 1회차: 전부 평범한 값. 이력이 없어 신뢰도 '낮음' → 알리지 않는다
  const first = await runScan({ provider: providerWith(1_150_000), ...opts });
  assert.equal(first.alerts.length, 0, "확신 없는 판정으로 알림을 보내면 안 된다");
  assert.ok(history.load().length >= 60, "이력이 쌓여야 한다");

  // 2회차: 값이 그대로면 '이 노선은 원래 이 값' 이므로 특가가 아니다
  const same = await runScan({ provider: providerWith(1_150_000), ...opts });
  const unchanged = same.needsReview.find((i) => i.candidate.destIn === "FCO");
  assert.match(unchanged.verdict.method, /^history/, "이력 기반으로 판정해야 한다");
  assert.equal(unchanged.verdict.isDeal, false, "값이 안 변했으면 특가가 아니다");
  assert.equal(same.alerts.length, 0);

  // 3회차: 값이 크게 떨어지면 특가로 잡고 알린다
  const dropped = await runScan({ provider: providerWith(380_000), ...opts });
  const deal = dropped.needsReview.find((i) => i.candidate.destIn === "FCO");
  assert.equal(deal.verdict.isDeal, true, "평소보다 크게 싸지면 특가여야 한다");
  assert.ok(deal.verdict.discountPct > 50, `할인율이 커야 한다 (실제 ${deal.verdict.discountPct}%)`);
  assert.notEqual(deal.verdict.confidence, "low");
  assert.equal(dropped.alerts.length, 0, "귀국편을 확인하기 전에는 알리지 않는다");
  assert.equal(deal.candidate.priceType, "indicative", "참고가는 목록에 유지한다");
  alertState.save();

  // 4회차: 같은 값이면 다시 알리지 않는다
  const again = await runScan({ provider: providerWith(380_000), ...opts });
  assert.equal(again.alerts.length, 0, "같은 값이면 다시 알리면 안 된다");
});

test("알림 문구에는 미확인이라는 사실이 반드시 들어간다", async () => {
  const { renderAlertText } = await import("../src/notify/index.js");
  const { makeCandidate, makeLeg } = await import("../src/core/model.js");
  const c = makeCandidate({
    source: "travelpayouts", priceType: "indicative", total: 576287,
    originOut: "ICN", destIn: "IST", destOut: "IST", tripDays: 14,
    outbound: makeLeg({ from: "ICN", to: "IST", departAt: "2026-10-28", segments: [] }),
    links: [{ label: "확인", url: "https://www.aviasales.com/search/x?marker=1" }],
  });
  const text = renderAlertText([{
    candidate: c, verdict: { discountPct: 30.9, confidence: "medium", sampleSize: 64 },
    value: { score: 76 }, alertDecision: { kind: "new" },
  }]);
  assert.match(text, /참고가/);
  assert.match(text, /확인되지 않았습니다/);
  assert.match(text, /이스탄불/, "코드가 아니라 한글 도시 이름이어야 한다");
  assert.match(text, /aviasales\.com/, "확인 링크가 있어야 한다");
  assert.doesNotMatch(text, /확정 특가/, "확정이라고 부르면 안 된다");
});

test("가격 이력은 참고가라도 쌓인다", async () => {
  const { history, alertState } = tmp();
  const byDest = {};
  for (const d of ["CDG", "FCO", "VIE"]) {
    byDest[d] = [{ origin: "ICN", destination: d, depart_date: "2026-11-10", return_date: "2026-11-24", value: 900000 }];
  }
  await runScan({
    provider: new TravelpayoutsProvider({ client: new FakeClient(byDest) }),
    history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });
  const saved = history.load();
  assert.equal(saved.length, 3, "본 가격은 전부 공책에 적혀야 한다");
  assert.ok(saved.every((r) => r.priceType === "indicative"));
});
