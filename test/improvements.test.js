// 2026-09 검토에서 발견한 실제 흐름의 회귀 시험. 외부 검색·알림 전송 없음.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerpApiClient } from "../src/providers/serpapi/client.js";
import { SerpApiProvider, AREA_ID, expandAreas } from "../src/providers/serpapi/index.js";
import { normalizeFlightOffer, normalizeRoundTrip } from "../src/providers/serpapi/normalize.js";
import { CompositeProvider } from "../src/providers/composite.js";
import { FlightProvider } from "../src/providers/base.js";
import { runScan } from "../src/pipeline/scan.js";
import { SETTINGS } from "../src/config/settings.js";
import { makeCandidate, makeLeg } from "../src/core/model.js";
import { checkEligibility, compareDeals, canAlert, hasEnoughEvidence } from "../src/core/eligibility.js";
import { planDetails } from "../src/core/detailPlan.js";
import { AlertState } from "../src/store/alertState.js";
import { writeResults } from "../src/pipeline/output.js";
import { pickDestinations, DESTINATIONS, allowedCodes } from "../src/config/destinations.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdf-audit-"));
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const today = new Date("2026-09-10T00:00:00Z");
const opts = { today, regions: ["europe", "africa"], log: () => {} };
const historyPoints = { price_history: Array.from({ length: 6 }, (_, i) => [1700000000 + i * 86400, 1200000]) };

function offer(from, to, depart, arrive, price = 600000) {
  return { type: "Round trip", price, total_duration: 800, flights: [{ airline: "Test airline",
    flight_number: `${from}-${to}`, duration: 800,
    departure_airport: { id: from, time: `${depart} 10:00` },
    arrival_airport: { id: to, time: `${arrive} 18:00` } }] };
}
function seed(dest = "CDG", back = "2026-11-20", total = 600000) {
  const c = makeCandidate({ source: "seed", priceType: "indicative", currency: "KRW", total,
    originOut: "ICN", destIn: dest, destOut: dest, tripDays: 11,
    tripDaysBasis: "local_departure_estimated",
    outbound: makeLeg({ from: "ICN", to: dest, departAt: "2026-11-10" }),
    inbound: makeLeg({ from: dest, to: "ICN", departAt: back }) });
  c.providerBaseline = { kind: "google_deals_reported", baseline: 1200000, discountPct: 50 };
  return c;
}
class SeedProvider extends FlightProvider {
  constructor(seeds) { super(); this.seeds = seeds; }
  get name() { return "seeds"; }
  get capabilities() { return { indicative: true, live: false, confirm: false, openJaw: false }; }
  async searchInspiration() { return { ok: true, candidates: this.seeds }; }
}
function fakeSerp({ failReturn = false, discovery = [] } = {}) {
  const calls = [];
  return { calls, checkQuota: async () => ({ ok: true }), search: async (p) => {
    calls.push(p);
    if (p.engine !== "google_flights") return { ok: true, data: { deals: discovery, destinations: discovery } };
    if (p.departure_token && failReturn) return { ok: false, error: "귀국 조회 실패" };
    const out = offer("ICN", p.arrival_id, p.outbound_date, p.outbound_date);
    out.departure_token = `selected-${p.arrival_id}`;
    const back = offer(p.arrival_id, "ICN", p.return_date,
      new Date(Date.parse(p.return_date) + 86400000).toISOString().slice(0, 10), 650000);
    return { ok: true, data: { best_flights: [p.departure_token ? back : out],
      price_insights: historyPoints, search_metadata: { google_flights_url: "https://www.google.com/travel/flights?test=1" } } };
  } };
}

test("월 예산 3회는 순차 실행에서도 정확히 3회 사용한다", async (t) => {
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (u) => String(u).includes("/account")
    ? json({ total_searches_left: 250 }) : (searches++, json({})));
  const c = new SerpApiClient({ apiKey: "test", monthlyBudget: 3, runBudget: 10, minIntervalMs: 0,
    ledgerPath: path.join(tmp(), "ledger.json") });
  await c.checkQuota();
  for (let i = 0; i < 4; i++) await c.search({ engine: "test" });
  assert.equal(searches, 3);
  assert.equal(c.stats.monthlyUsed, 3);
});

test("장부가 손상되면 대기 중인 요청까지 네트워크 호출 전에 멈춘다", async (t) => {
  let searches = 0;
  const ledger = path.join(tmp(), "ledger.json"); fs.writeFileSync(ledger, "{broken");
  t.mock.method(globalThis, "fetch", async (u) => String(u).includes("/account")
    ? json({ total_searches_left: 250 }) : (searches++, json({})));
  const c = new SerpApiClient({ apiKey: "test", minIntervalMs: 0, ledgerPath: ledger });
  await c.checkQuota();
  const results = await Promise.all([1, 2, 3].map(() => c.search({ engine: "test" })));
  assert.equal(searches, 0); assert.ok(results.every((r) => r.skipped));
  assert.equal(fs.readFileSync(ledger, "utf8"), "{broken");
});

test("두 클라이언트가 장부를 공유해도 월 예산을 넘지 않는다", async (t) => {
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (u) => String(u).includes("/account")
    ? json({ total_searches_left: 250 }) : (searches++, json({})));
  const ledgerPath = path.join(tmp(), "ledger.json");
  const clients = [1, 2].map(() => new SerpApiClient({ apiKey: "test", monthlyBudget: 1, ledgerPath, minIntervalMs: 0 }));
  await Promise.all(clients.map((c) => c.checkQuota()));
  await Promise.all(clients.map((c) => c.search({ engine: "test" })));
  assert.equal(searches, 1);
});

test("계정이 이미 월 상한까지 썼으면 빈 로컬 장부로도 검색하지 않는다", async (t) => {
  let searches = 0;
  // 기본 상한값을 바꿔도 이 시험이 깨지지 않도록 예산을 직접 지정합니다.
  const budget = 100;
  t.mock.method(globalThis, "fetch", async (u) => String(u).includes("/account")
    ? json({ total_searches_left: 50, this_month_usage: budget }) : (searches++, json({})));
  const c = new SerpApiClient({ apiKey: "test", monthlyBudget: budget, ledgerPath: path.join(tmp(), "ledger.json") });
  await c.checkQuota(); assert.equal((await c.search({ engine: "test" })).skipped, true);
  assert.equal(searches, 0);
});

test("HTTP 오류의 가짜 잔여 숫자와 잘못된 예산은 허용하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ total_searches_left: 250 }, 500));
  const c = new SerpApiClient({ apiKey: "test" });
  assert.equal((await c.checkQuota()).ok, false);
  for (const n of [NaN, Infinity, -1, 1.5]) assert.throws(() => new SerpApiClient({ apiKey: "test", runBudget: n }));
});

test("응답 본문이 멈춰도 제한 시간 안에 끝내고 예약 장부는 남긴다", async (t) => {
  t.mock.method(globalThis, "fetch", async (u, init) => {
    if (String(u).includes("/account")) return json({ total_searches_left: 250 });
    return { ok: true, status: 200, json: () => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
  });
  const c = new SerpApiClient({ apiKey: "test", timeoutMs: 15, minIntervalMs: 0, ledgerPath: path.join(tmp(), "ledger.json") });
  await c.checkQuota(); assert.equal((await c.search({ engine: "test" })).ok, false);
  assert.equal(c.stats.monthlyUsed, 1);
});

test("최초 응답에는 귀국 공항 확인을 붙이지 않고 귀국 조회에서 왕복 총액을 갱신한다", async () => {
  const client = fakeSerp(); const p = new SerpApiProvider({ client, detailCalls: 2 });
  const params = { destination: "CDG", departureDate: "2026-11-10", returnDate: "2026-11-20", maxStops: 2 };
  const r = await p.searchLive(params);
  const full = r.candidates.find((c) => c.returnAirportVerified);
  assert.equal(full.total, 650000); assert.equal(full.tripDays, 12);
  assert.equal(full.tripDaysBasis, "icn_confirmed");
  assert.equal(full.providerBaseline.discountPct, 45.8);
  assert.ok(full.links.length);
  assert.ok(r.candidates.some((c) => c.returnAirportVerified === false));
  assert.equal(client.calls[0].stops, "3"); assert.ok(client.calls[1].departure_token);
  await p.searchLive(params); assert.equal(client.calls.length, 2, "동일 검색은 실행 중 재사용한다");
  assert.equal((await p.searchLive({ ...params, destination: "NBO" })).skipped, true);
});

test("귀국 조회 실패 시 출국편과 참고 가격을 남기고 양방향 확인으로 승격하지 않는다", async () => {
  const p = new SerpApiProvider({ client: fakeSerp({ failReturn: true }), detailCalls: 2 });
  const r = await p.searchLive({ destination: "CDG", departureDate: "2026-11-10", returnDate: "2026-11-20" });
  assert.ok(r.candidates.length); assert.ok(r.candidates.every((c) => c.returnAirportVerified === false));
  assert.ok(p.stats.errors.some((e) => e.step === "return"));
});

test("현지 귀국 출발이 20일째여도 인천 도착이 21일째면 기간 밖이다", () => {
  const out = offer("ICN", "CDG", "2026-11-01", "2026-11-01");
  const back = offer("CDG", "ICN", "2026-11-20", "2026-11-21");
  const c = normalizeRoundTrip(out, back, { returnDate: "2026-11-20" });
  assert.equal(c.tripDays, 21);
  checkEligibility(c, { settings: SETTINGS, departFrom: "2026-09-25", departTo: "2027-03-10" });
  assert.equal(c.outOfRange, true);
  const wrong = normalizeRoundTrip(out, offer("CDG", "GMP", "2026-11-20", "2026-11-21"));
  assert.equal(checkEligibility(wrong, { settings: SETTINGS, departFrom: "2026-09-25", departTo: "2027-03-10" }), false);
});

test("복합 공급자 실제 흐름에서 12회 예산 중 4회는 캐시 없는 아프리카 직접 조회에 쓴다", async () => {
  const client = fakeSerp();
  const sp = new SerpApiProvider({ client, discoveryCalls: 0, detailCalls: 12 });
  const provider = new CompositeProvider([{ provider: new SeedProvider(["CDG", "FCO", "VIE", "MAD", "LHR", "AMS"].map((d) => seed(d))) }, { provider: sp }]);
  const result = await runScan({ provider, ...opts });
  assert.equal(result.report.stages.shortlist.plan.directQueries, 2);
  assert.equal(result.report.stages.shortlist.count, 6);
  assert.equal(client.calls.length, 12);
  const probes = client.calls.filter((p) => !["CDG", "FCO", "VIE", "MAD", "LHR", "AMS"].includes(p.arrival_id));
  assert.equal(probes.length, 4);
  assert.ok(probes.every((p) => p.outbound_date >= "2026-09-25" && p.outbound_date <= "2027-03-10"));
});

test("넓은 탐색이 전부 비어도 아프리카 직접 조회는 실행한다", async () => {
  const client = fakeSerp();
  const r = await runScan({ provider: new SerpApiProvider({ client, discoveryCalls: 0, detailCalls: 12 }), ...opts });
  assert.ok(client.calls.length > 0); assert.ok(r.needsReview.length > 0);
  assert.ok(r.needsReview.every((x) => x.candidate.total > 0), "검색 조건을 가짜 후보로 내보내지 않는다");
});

test("5회 발굴 예산에서는 요청한 네 지역과 Deals를 모두 조회한다", async () => {
  const client = fakeSerp(); const p = new SerpApiProvider({ client, discoveryCalls: 5 });
  await p.searchInspiration({ regions: ["europe", "africa", "caucasus", "mongolia"],
    departFrom: "2026-09-25", departTo: "2027-03-10", minTripDays: 5, maxTripDays: 20 });
  assert.equal(client.calls.length, 5);
  assert.equal(new Set(client.calls.filter((p) => p.arrival_area_id).map((p) => p.arrival_area_id)).size, 4);
  assert.equal(client.calls.at(-1).engine, "google_flights_deals");
});

test("상세 조회해도 다른 귀국일·더 싼 가격·Google 제공 할인 근거가 사라지지 않는다", async () => {
  const seeds = [seed("CDG", "2026-11-20", 500000), seed("CDG", "2026-11-25", 400000)];
  const provider = new CompositeProvider([{ provider: new SeedProvider(seeds) },
    { provider: new SerpApiProvider({ client: fakeSerp(), discoveryCalls: 0, detailCalls: 2 }) }]);
  const r = await runScan({ provider, ...opts, regions: ["europe"] });
  assert.ok(r.needsReview.some((x) => x.candidate.total === 400000));
  assert.ok(r.needsReview.some((x) => x.candidate.total === 500000 && x.verdict.basis === "google_deals_reported"));
  assert.ok(r.needsReview.some((x) => x.candidate.total === 650000));
});

test("복합 공급자에서도 양방향 확인된 미확정 특가를 알리고 동일 가격은 재알림하지 않는다", async () => {
  const dir = tmp(); const alertState = new AlertState(path.join(dir, "alerts.json"));
  const provider = () => new CompositeProvider([{ provider: new SeedProvider([seed()]) },
    { provider: new SerpApiProvider({ client: fakeSerp(), discoveryCalls: 0, detailCalls: 2 }) }]);
  const r = await runScan({ provider: provider(), alertState, ...opts, regions: ["europe"] });
  assert.equal(r.deals.length, 0); assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].candidate.returnAirportVerified, true);
  assert.equal(r.alerts[0].verdict.basis, "app_computed_from_google_history");
  const again = await runScan({ provider: provider(), alertState, ...opts, regions: ["europe"] });
  assert.equal(again.alerts.length, 0);
  writeResults(r, { webDir: path.join(dir, "web"), dataDir: path.join(dir, "data") });
  const publicText = fs.readFileSync(path.join(dir, "web/deals.json"), "utf8");
  assert.doesNotMatch(publicText, /departure_token|departureToken|bookingToken|api_key/);
});

test("기간 밖 출발은 공급자와 무관하게 걸러내고 요청 지역도 전달한다", async () => {
  const c = seed(); c.outbound.departAt = "2026-09-24";
  const provider = new SeedProvider([c]);
  const r = await runScan({ provider, ...opts });
  assert.equal(r.needsReview.length, 0);
});

test("할인율을 여행가치보다 우선하고 같은 스캔 비교율은 실제 할인율로 순위를 매기지 않는다", () => {
  const mk = (pct, score, basis = "self_observed") => ({ candidate: {},
    verdict: { discountPct: pct, isDeal: true, basis }, value: { score } });
  const more = mk(50, 20), less = mk(25, 99), cohort = mk(90, 100, "same_scan");
  assert.deepEqual([less, cohort, more].sort(compareDeals), [more, less, cohort]);
});

test("실제 귀국 응답 재생: 790500원 후보의 인천 도착은 2월 1일, 여행은 17일이다", async () => {
  const f = JSON.parse(fs.readFileSync(new URL("./fixtures/serp-roundtrip-icn-cdg.json", import.meta.url)));
  const p = new SerpApiProvider({ detailCalls: 2, client: { search: async (q) => ({ ok: true, data: {
    best_flights: q.departure_token ? f.returns : [f.outbound], price_insights: f.priceInsights } }) } });
  const r = await p.searchLive({ destination: "CDG", departureDate: "2027-01-16", returnDate: "2027-01-30" });
  const c = r.candidates.find((c) => c.returnAirportVerified && c.total === 790500);
  assert.ok(c); assert.equal(c.inbound.arriveAt, "2027-02-01 10:30");
  assert.equal(c.tripDays, 17); assert.equal(c.inbound.stops, 1);
});

test("직접 조회 도시는 다음 주기에 순환하고 귀국일 없는 후보는 예산을 차지하지 않는다", () => {
  const p = new SerpApiProvider({ client: fakeSerp(), detailCalls: 12 });
  const missing = seed(); missing.inbound = null;
  const opts = { cap: 6, destinations: pickDestinations(["europe", "africa"]),
    departFrom: "2026-09-25", departTo: "2027-03-10", minTripDays: 5, maxTripDays: 20 };
  const a = p.planDetails([{ candidate: missing }], { ...opts, today });
  const b = p.planDetails([], { ...opts, today: new Date("2026-09-13") });
  assert.ok(a.items.every((x) => x.query));
  assert.notDeepEqual(a.items.map((x) => x.query.destination), b.items.map((x) => x.query.destination));
});

test("한 공급자의 준비 과정이 실패해도 다른 공급자의 준비는 진행한다", async () => {
  const a = new SeedProvider([]); a.prepare = async () => { throw new Error("준비 실패"); };
  const b = new SerpApiProvider({ client: fakeSerp() });
  const r = await new CompositeProvider([{ provider: a }, { provider: b }]).prepare();
  assert.equal(r.seeds.ok, false); assert.equal(r.serpapi.ok, true);
});

test("알림이 0건일 때 '확인 수단이 없어서'인지 설명한다", async () => {
  const { renderSummary } = await import("../src/pipeline/output.js");
  const { makeCandidate, makeLeg } = await import("../src/core/model.js");

  const mk = (returnVerified) => {
    const c = makeCandidate({
      source: "travelpayouts", priceType: "indicative", total: 700000,
      originOut: "ICN", destIn: "CDG", destOut: "CDG", tripDays: 14,
      outbound: makeLeg({ from: "ICN", to: "CDG", departAt: "2026-11-10", segments: [] }),
      inbound: makeLeg({ from: "CDG", to: "ICN", departAt: "2026-11-24", segments: [] }),
    });
    c.returnAirportVerified = returnVerified;
    return { candidate: c, verdict: { isDeal: true, confidence: "medium" }, value: { score: 70, warnings: [] } };
  };
  const report = { provider: "travelpayouts", window: { departFrom: "2026-09-25", departTo: "2027-03-10" },
                   destinationCount: 95 };

  // 귀국 공항이 하나도 확인 안 됐으면 이유를 알려줘야 합니다
  const blind = renderSummary({ report, deals: [], needsReview: [mk(false)], alerts: [] });
  assert.match(blind, /귀국편이 인천에 내리는지 확인된 후보가 0건/);

  // 확인된 후보가 있는데 알림이 없으면, 그건 진짜 특가가 없는 것이므로 설명하지 않습니다
  const seeing = renderSummary({ report, deals: [], needsReview: [mk(true)], alerts: [] });
  assert.doesNotMatch(seeing, /확인된 후보가 0건/);
});

// ── 알림 근거 두께 (2026-09-19) ─────────────────────────────
// 표본 5건짜리 자체 기록으로 "20% 싸다"고 알리던 것을 막습니다.

/** 알림 직전 상태의 후보 하나를 만듭니다 (공항·일수는 모두 확인된 것으로). */
const alertable = (verdict) => ({
  candidate: {
    priceType: "live", outOfRange: false, fareRules: { conflict: false },
    departureAirportVerified: true, returnAirportVerified: true,
    tripDaysBasis: "icn_confirmed", tripDays: 9,
  },
  verdict: { isDeal: true, confidence: "medium", basis: "self_observed", ...verdict },
});

test("자체 기록 표본이 얇으면 싸도 알리지 않는다", () => {
  // 실제로 있었던 알제 건: 표본 5건 · 서로 다른 2일 · 20.6% 할인
  assert.equal(canAlert(alertable({ sampleSize: 5, distinctDays: 2, discountPct: 20.6 })), false);
  // 건수만 채우고 하루에 몰아본 것도 막습니다
  assert.equal(canAlert(alertable({ sampleSize: 40, distinctDays: 1 })), false);
  // 서로 다른 날은 많아도 건수가 모자라면 막습니다
  assert.equal(canAlert(alertable({ sampleSize: 6, distinctDays: 9 })), false);
  // 실제로 알린 이스탄불 건: 표본 63건 · 서로 다른 4일
  assert.equal(canAlert(alertable({ sampleSize: 63, distinctDays: 4 })), true);
});

test("표본이나 관측일수를 모르면 알리지 않는다", () => {
  assert.equal(hasEnoughEvidence({ sampleSize: null, distinctDays: 4 }), false);
  assert.equal(hasEnoughEvidence({ sampleSize: 40 }), false);
  assert.equal(hasEnoughEvidence({ sampleSize: 40, distinctDays: 4 }), true);
});

test("알림 근거 문턱은 자체 기록에만 걸리고 구글 기준가에는 걸리지 않는다", () => {
  const google = alertable({ basis: "google_deals_reported", sampleSize: 3, distinctDays: 1 });
  assert.equal(canAlert(google), true, "구글이 준 평소가는 우리 기록이 아니므로 그대로 알린다");
  const computed = alertable({ basis: "app_computed_from_google_history", sampleSize: 62, distinctDays: null, confidence: "low" });
  assert.equal(canAlert(computed), true, "구글 가격 이력 62개짜리도 그대로 알린다");
});

test("판매 화면까지 확인한 후보는 근거 문턱과 무관하게 알린다", () => {
  const confirmed = alertable({ sampleSize: 5, distinctDays: 1 });
  confirmed.candidate.priceType = "confirmed";
  assert.equal(canAlert(confirmed), true);
});

test("알림 근거 문턱은 설정값으로 조절된다", () => {
  const item = alertable({ sampleSize: 8, distinctDays: 3 });
  assert.equal(canAlert(item, SETTINGS), false, "기본값 12건에는 못 미친다");
  const loose = { ...SETTINGS, alertEvidence: { minSampleSize: 8, minDistinctDays: 3 } };
  assert.equal(canAlert(item, loose), true, "문턱을 낮추면 통과한다");
});

// ── 오세아니아 추가와 예산 (2026-09-23) ─────────────────────
// 호주·뉴질랜드를 넣으면 탐색 칸이 4개에서 6개로 늘어납니다.
// 예산을 함께 올리지 않으면 뒤쪽 지역이 말없이 빠집니다.

test("오세아니아는 탐색 주소가 둘이라 지역 하나가 두 칸으로 펼쳐진다", () => {
  assert.deepEqual(expandAreas(["oceania"]).map(([, id]) => id), ["/m/0chghy", "/m/0ctw_b"]);
  // 지역을 안 주면 아는 지역 전부 = 6칸
  assert.equal(expandAreas(Object.keys(AREA_ID)).length, 6);
  assert.deepEqual(expandAreas(["europe"]), [["europe", "/m/02j9z"]]);
  assert.deepEqual(expandAreas(["없는지역"]), []);
});

test("발굴 예산 7이면 6개 지역을 모두 훑는다 (5면 호주·뉴질랜드가 빠진다)", async () => {
  const run = async (discoveryCalls) => {
    const client = fakeSerp();
    const sp = new SerpApiProvider({ client, discoveryCalls, detailCalls: 0 });
    await sp.prepare();
    await sp.searchInspiration({
      destinations: pickDestinations([]), regions: [],
      departFrom: "2026-10-04", departTo: "2027-03-19",
      minTripDays: 5, maxTripDays: 20,
    });
    const areas = client.calls.filter((p) => p.engine === "google_travel_explore")
      .map((p) => p.arrival_area_id);
    return new Set(areas);
  };
  const withFive = await run(5);
  assert.ok(!withFive.has("/m/0chghy"), "예산 5면 호주가 조회되지 않는다");
  assert.ok(!withFive.has("/m/0ctw_b"), "예산 5면 뉴질랜드가 조회되지 않는다");

  const withSeven = await run(7);
  for (const id of ["/m/02j9z", "/m/0dg3n1", "/m/0d0kn", "/m/04w8f", "/m/0chghy", "/m/0ctw_b"]) {
    assert.ok(withSeven.has(id), `예산 7이면 ${id} 가 조회된다`);
  }
});

test("캐시 공백 직접 조회를 아프리카가 독차지하지 않고 오세아니아와 나눈다", () => {
  const mk = (dest) => ({ candidate: { destIn: dest,
    outbound: { departAt: "2026-11-10T00:00:00Z" }, inbound: { departAt: "2026-11-20T00:00:00Z" } } });
  const ranked = ["CDG", "FCO", "VIE", "MAD", "LHR", "AMS", "BCN", "PRG"].map(mk);
  const r = planDetails(ranked, { cap: 6, destinations: DESTINATIONS,
    departFrom: "2026-10-04", departTo: "2027-03-19", today: new Date("2026-09-23"),
    minTripDays: 5, maxTripDays: 20 });
  const probes = r.items.filter((x) => x.query);
  assert.equal(probes.length, 2);
  const regions = probes.map((x) => DESTINATIONS.find((d) => d.iata === x.query.destination)?.region);
  assert.deepEqual([...new Set(regions)].sort(), ["africa", "oceania"], "두 지역이 한 칸씩 가져간다");
  assert.deepEqual(r.plan.thinRegions, ["africa", "oceania"]);
});

test("값이 다 차 있는 지역은 공백 몫을 순위 후보에 돌려준다", () => {
  const onlyAfricaAndOceania = DESTINATIONS.filter((d) => ["africa", "oceania"].includes(d.region));
  const mk = (dest) => ({ candidate: { destIn: dest,
    outbound: { departAt: "2026-11-10T00:00:00Z" }, inbound: { departAt: "2026-11-20T00:00:00Z" } } });
  // 두 지역의 모든 공항에 값이 있으면 공백이 없다
  const ranked = onlyAfricaAndOceania.map((d) => mk(d.iata));
  const r = planDetails(ranked, { cap: 6, destinations: onlyAfricaAndOceania,
    departFrom: "2026-10-04", departTo: "2027-03-19", today: new Date("2026-09-23"),
    minTripDays: 5, maxTripDays: 20 });
  assert.equal(r.plan.reservedForThin, 0, "공백이 없으면 예약 몫도 0");
  assert.equal(r.items.filter((x) => x.query).length, 0);
  assert.equal(r.items.length, 6, "여섯 칸 모두 실제 후보로 채운다");
});

test("왕복 한 쌍을 채울 예산이 없으면 상세 조회를 시작조차 하지 않는다", async () => {
  const client = fakeSerp();
  // 상세 1회치만 남은 상황 — 출국만 부르고 끊기면 안 된다
  const sp = new SerpApiProvider({ client, discoveryCalls: 0, detailCalls: 1 });
  await sp.prepare();
  const before = client.calls.length;
  const r = await sp.searchLive({ destination: "CDG", departureDate: "2026-11-10", returnDate: "2026-11-20" });
  assert.equal(client.calls.length, before, "호출을 한 번도 쓰지 않는다");
  assert.equal(r.candidates.length, 0);
  assert.ok(sp.stats.skipped.some((x) => x.step === "pair"), "건너뛴 사실을 남긴다");

  // 2회치가 있으면 정상 진행
  const sp2 = new SerpApiProvider({ client: fakeSerp(), discoveryCalls: 0, detailCalls: 2 });
  await sp2.prepare();
  const r2 = await sp2.searchLive({ destination: "CDG", departureDate: "2026-11-10", returnDate: "2026-11-20" });
  assert.ok(r2.candidates.length > 0, "예산이 두 번치면 왕복을 끝까지 확인한다");
});

test("오세아니아 목적지가 표와 허용코드에 모두 들어간다", () => {
  const oc = pickDestinations(["oceania"]);
  assert.equal(oc.length, 13);
  assert.deepEqual([...new Set(oc.map((d) => d.country))].sort(), ["뉴질랜드", "호주"]);
  const codes = allowedCodes();
  for (const iata of ["SYD", "MEL", "BNE", "PER", "AKL", "CHC", "ZQN"]) {
    assert.ok(codes.has(iata), `${iata} 가 허용코드에 있어야 한다`);
  }
  // 좌표가 남반구인지 (부호를 잘못 넣으면 육로 거리 계산이 통째로 틀어진다)
  assert.ok(oc.every((d) => d.lat < 0), "오세아니아 공항은 모두 남위다");
});

test("연습용 가짜 자료는 알림 기록에 남기지 않는다", () => {
  // 가격 이력이 mock 을 막듯, 알림 기록도 막아야 합니다.
  // 안 막으면 나중에 진짜 특가가 나와도 "이미 알렸다"며 건너뜁니다.
  const st = new AlertState(path.join(tmp(), "alert-state.json"));
  assert.equal(st.record("ICN>SYD>SYD|2026W45|16d|MU|9", { price: 1, score: 1, source: "mock" }), false);
  assert.deepEqual(Object.keys(st.data), []);
  assert.equal(st.record("ICN>SYD>SYD|2026W45|16d|MU|9", { price: 1, score: 1, source: "serpapi" }), true);
  assert.equal(Object.keys(st.data).length, 1);
});
