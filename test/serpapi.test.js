// SerpApi 어댑터 시험. 특히 예산이 새지 않는지를 집중적으로 봅니다.
// 실제 호출은 하지 않고, 저장해 둔 진짜 응답과 가짜 fetch 로만 시험합니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerpApiClient } from "../src/providers/serpapi/client.js";
import {
  normalizeDeal, normalizeExplore, normalizeFlightOffer,
  rowsFromDeals, rowsFromExplore, offersFromFlights,
} from "../src/providers/serpapi/normalize.js";

const FIX = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/serp-${n}.json`, import.meta.url), "utf8"));
const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serp-")), "ledger.json");

/** fetch 를 가짜로 바꿔치기하고, 원래대로 되돌리는 도우미 */
function fakeFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

// ───────────────── 예산 ─────────────────

test("잔여량을 확인하기 전에는 검색하지 않는다", async () => {
  let called = 0;
  const undo = fakeFetch(async () => { called++; return jsonRes({}); });
  try {
    const c = new SerpApiClient({ apiKey: "k", runBudget: 5, ledgerPath: tmpLedger() });
    const r = await c.search({ engine: "google_flights" });
    assert.equal(r.skipped, true);
    assert.match(r.error, /잔여량을 먼저 확인/);
    assert.equal(called, 0, "확인 전에는 아예 호출하면 안 된다");
  } finally { undo(); }
});

test("잔여량 확인이 실패하면 검색을 멈춘다", async () => {
  const undo = fakeFetch(async () => jsonRes({ error: "잘못된 키" }));
  try {
    const c = new SerpApiClient({ apiKey: "k", ledgerPath: tmpLedger() });
    const q = await c.checkQuota();
    assert.equal(q.ok, false);
    const r = await c.search({ engine: "google_flights" });
    assert.equal(r.skipped, true, "확인 실패면 검색하지 않는다");
  } finally { undo(); }
});

test("잔여가 0이면 검색하지 않는다", async () => {
  let searches = 0;
  const undo = fakeFetch(async (u) => {
    const url = String(u);
    if (url.includes("/account")) return jsonRes({ total_searches_left: 0, plan_name: "Free" });
    searches++; return jsonRes({});
  });
  try {
    const c = new SerpApiClient({ apiKey: "k", ledgerPath: tmpLedger() });
    await c.checkQuota();
    const r = await c.search({ engine: "google_flights" });
    assert.equal(r.skipped, true);
    assert.equal(searches, 0);
  } finally { undo(); }
});

test("예산이 1인데 동시에 3번 요청해도 1번만 나간다", async () => {
  // 예전 결함: 확인 → 기다림 → 사용 순서라 셋 다 확인을 통과했다.
  let searches = 0;
  const undo = fakeFetch(async (u) => {
    const url = String(u);
    if (url.includes("/account")) return jsonRes({ total_searches_left: 200 });
    searches++;
    await new Promise((r) => setTimeout(r, 5));
    return jsonRes({ ok: true });
  });
  try {
    const c = new SerpApiClient({ apiKey: "k", runBudget: 1, minIntervalMs: 0, ledgerPath: tmpLedger() });
    await c.checkQuota();
    const rs = await Promise.all([1, 2, 3].map(() => c.search({ engine: "e" })));
    assert.equal(searches, 1, `실제 호출은 1번이어야 한다 (실제 ${searches}번)`);
    assert.equal(rs.filter((r) => r.skipped).length, 2, "나머지 둘은 건너뛰어야 한다");
  } finally { undo(); }
});

test("이번 달 자체 예산을 넘기지 않는다 (장부 기준)", async () => {
  const ledger = tmpLedger();
  const month = new Date().toISOString().slice(0, 7);
  // 이미 이번 달에 3번 썼다고 장부에 적어 둡니다
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ month, calls: [1, 2, 3].map(() => ({ at: new Date().toISOString() })) }));

  let searches = 0;
  const undo = fakeFetch(async (u) => {
    if (String(u).includes("/account")) return jsonRes({ total_searches_left: 200 });
    searches++; return jsonRes({ ok: true });
  });
  try {
    const c = new SerpApiClient({ apiKey: "k", runBudget: 10, monthlyBudget: 4, minIntervalMs: 0, ledgerPath: ledger });
    await c.checkQuota();
    await c.search({ engine: "e" });          // 4번째 — 여기까지 허용
    const r = await c.search({ engine: "e" }); // 5번째 — 막혀야 함
    assert.equal(searches, 1);
    assert.match(r.error, /이번 달 자체 예산/);
  } finally { undo(); }
});

test("사용 기록은 장부에 남고, 새 실행도 그 기록을 이어받는다", async () => {
  const ledger = tmpLedger();
  const undo = fakeFetch(async (u) => {
    if (String(u).includes("/account")) return jsonRes({ total_searches_left: 200 });
    return jsonRes({ ok: true });
  });
  try {
    const a = new SerpApiClient({ apiKey: "k", runBudget: 5, minIntervalMs: 0, ledgerPath: ledger });
    await a.checkQuota(); await a.search({ engine: "e" }); await a.search({ engine: "e" });
    assert.equal(a.stats.monthlyUsed, 2);

    // 실행이 새로 시작돼도 장부는 남아 있어야 합니다
    const b = new SerpApiClient({ apiKey: "k", runBudget: 5, minIntervalMs: 0, ledgerPath: ledger });
    assert.equal(b.stats.monthlyUsed, 2, "새 실행이 이전 사용량을 이어받아야 한다");
  } finally { undo(); }
});

test("장부를 못 쓰면 안전하게 멈춘다", async () => {
  const undo = fakeFetch(async (u) => {
    if (String(u).includes("/account")) return jsonRes({ total_searches_left: 200 });
    return jsonRes({ ok: true });
  });
  try {
    // 쓸 수 없는 경로를 줍니다
    const c = new SerpApiClient({ apiKey: "k", minIntervalMs: 0, ledgerPath: "/proc/불가능/ledger.json" });
    await c.checkQuota();
    await c.search({ engine: "e" });
    assert.ok(c.stopped, "장부 저장 실패는 조용히 넘어가면 안 된다");
    const r = await c.search({ engine: "e" });
    assert.equal(r.skipped, true, "그 뒤로는 멈춰야 한다");
  } finally { undo(); }
});

test("시간이 초과되면 쓴 것으로 치고 기록한다", async () => {
  const ledger = tmpLedger();
  const undo = fakeFetch(async (u) => {
    if (String(u).includes("/account")) return jsonRes({ total_searches_left: 200 });
    const e = new Error("aborted"); e.name = "AbortError"; throw e;
  });
  try {
    const c = new SerpApiClient({ apiKey: "k", minIntervalMs: 0, timeoutMs: 10, ledgerPath: ledger });
    await c.checkQuota();
    const r = await c.search({ engine: "e" });
    assert.equal(r.ok, false);
    assert.equal(c.stats.monthlyUsed, 1, "과금 여부를 모르므로 쓴 것으로 세야 한다");
  } finally { undo(); }
});

// ───────────────── 자료 옮겨 적기 ─────────────────

test("Deals 는 구글이 '직접 준' 할인율로 표시한다", () => {
  const c = normalizeDeal(rowsFromDeals(FIX("deals-triplen-4-19"))[0], {});
  assert.equal(c.providerBaseline.kind, "google_deals_reported");
  assert.ok(c.providerBaseline.baseline > 0);
  assert.equal(typeof c.providerBaseline.discountPct, "number");
});

test("Flights 는 '앱이 계산한 값'임을 이름에 남긴다", () => {
  const f = FIX("flights-icn-cdg");
  const c = normalizeFlightOffer(offersFromFlights(f)[0], { priceInsights: f.price_insights, returnDate: "2027-01-30" });
  assert.equal(c.providerBaseline.kind, "app_computed_from_google_history");
  assert.ok(c.providerBaseline.historyPoints >= 5);
  assert.match(c.providerBaseline.method, /중앙값/);
  // 통상 가격대는 범위 그대로 두고 할인율을 만들지 않습니다
  assert.equal(c.providerRange.kind, "google_typical_range");
  assert.equal(c.providerRange.discountPct, undefined);
});

test("통상 가격대만 있으면 할인율을 만들지 않는다", () => {
  const offer = { type: "Round trip", price: 600000, total_duration: 100,
    flights: [{ departure_airport: { id: "ICN", time: "2026-11-10 10:00" },
                arrival_airport: { id: "CDG", time: "2026-11-10 20:00" }, duration: 100 }], layovers: [] };
  const c = normalizeFlightOffer(offer, {
    priceInsights: { typical_price_range: [800000, 1600000], price_history: [] }, returnDate: "2026-11-20" });
  assert.equal(c.providerBaseline, undefined, "범위의 중간점으로 가짜 할인율을 만들면 안 된다");
  assert.ok(c.providerRange, "범위는 범위대로 남긴다");
});

test("왕복 표시만으로 자가환승·별도발권이 없다고 하지 않는다", () => {
  const f = FIX("flights-icn-cdg");
  const c = normalizeFlightOffer(offersFromFlights(f)[0], { returnDate: "2027-01-30" });
  assert.equal(c.separateTickets, null, "근거가 없으면 모름이어야 한다");
  assert.equal(c.selfTransfer, null);
  assert.ok(c.unknown.includes("separateTickets"));
});

test("연속 구간의 공항이 다르면 공항 변경으로 잡는다", () => {
  const offer = { type: "Round trip", price: 900000, total_duration: 1500, layovers: [{ duration: 300 }],
    flights: [
      { departure_airport: { id: "ICN", time: "2026-11-10 10:00" }, arrival_airport: { id: "LHR", time: "2026-11-10 15:00" }, duration: 800 },
      { departure_airport: { id: "LGW", time: "2026-11-10 20:00" }, arrival_airport: { id: "FCO", time: "2026-11-10 23:00" }, duration: 180 },
    ]};
  assert.equal(normalizeFlightOffer(offer, { returnDate: "2026-11-20" }).airportChange, true);

  const same = JSON.parse(JSON.stringify(offer));
  same.flights[1].departure_airport.id = "LHR";
  assert.equal(normalizeFlightOffer(same, { returnDate: "2026-11-20" }).airportChange, false);
});

test("시간대 없는 시각이어도 어느 컴퓨터에서나 같은 날짜가 나온다", () => {
  const offer = { type: "Round trip", price: 500000, total_duration: 600, layovers: [],
    flights: [{ departure_airport: { id: "ICN", time: "2026-10-01 23:00" },
                arrival_airport: { id: "CDG", time: "2026-10-02 05:00" }, duration: 600 }] };
  const before = process.env.TZ;
  const days = [];
  for (const tz of ["Asia/Seoul", "UTC", "America/Los_Angeles"]) {
    process.env.TZ = tz;
    days.push(normalizeFlightOffer(offer, { returnDate: "2026-10-07" }).tripDays);
  }
  process.env.TZ = before;
  assert.equal(new Set(days).size, 1, `시간대가 달라도 같아야 한다 (실제 ${days.join(",")})`);
  assert.equal(days[0], 7);
});

test("Explore 는 실제 공항코드와 경유 횟수를 옮겨 적는다", () => {
  const c = normalizeExplore(rowsFromExplore(FIX("explore-europe"))[0], {});
  assert.equal(c.originOut, "ICN");
  assert.match(c.destIn, /^[A-Z]{3}$/);
  assert.equal(typeof c.outbound.stops, "number");
  assert.ok(c.total > 0);
});

// ───────────────── 판정 연결 ─────────────────

test("구글 기준과 자체 관측을 평균내지 않고 나란히 보관한다", async () => {
  const { judgeDeal } = await import("../src/core/dealDetector.js");
  const { makeCandidate, makeLeg } = await import("../src/core/model.js");
  const { PriceHistory } = await import("../src/store/history.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
  const history = new PriceHistory(dir);
  const mk = (total) => makeCandidate({
    source: "t", priceType: "live", total, originOut: "ICN", destIn: "CDG", tripDays: 14,
    outbound: makeLeg({ from: "ICN", to: "CDG", departAt: "2026-11-10", segments: [] }),
  });
  // 자체 이력 8건을 100만원대로 쌓습니다
  history.append(Array.from({ length: 8 }, (_, i) => mk(1000000 + i * 10000)));

  const c = mk(600000);
  c.providerBaseline = { kind: "google_deals_reported", baseline: 900000, discountPct: 33 };
  const v = judgeDeal(c, { history, cohorts: new Map(), historyBefore: new Date(Date.now() + 60000).toISOString() });

  assert.equal(v.basis, "google_deals_reported", "구글이 준 값을 먼저 쓴다");
  assert.equal(v.discountPct, 33, "구글이 준 할인율을 그대로 쓴다");
  assert.ok(v.selfObserved, "자체 관측도 함께 보관해야 한다");
  assert.equal(v.selfObserved.basis, "self_observed");
  assert.notEqual(v.discountPct, v.selfObserved.discountPct, "두 값을 평균내면 안 된다");
});

test("기준가가 0이나 음수면 할인율을 만들지 않는다", async () => {
  const { judgeDeal } = await import("../src/core/dealDetector.js");
  const { makeCandidate, makeLeg } = await import("../src/core/model.js");
  const mk = () => makeCandidate({
    source: "t", priceType: "live", total: 500000, originOut: "ICN", destIn: "CDG", tripDays: 14,
    outbound: makeLeg({ from: "ICN", to: "CDG", departAt: "2026-11-10", segments: [] }),
  });
  for (const bad of [0, -100, NaN]) {
    const c = mk();
    c.providerBaseline = { kind: "google_deals_reported", baseline: bad, discountPct: 50 };
    const v = judgeDeal(c, { cohorts: new Map() });
    assert.notEqual(v.basis, "google_deals_reported", `기준가 ${bad} 로는 판정하면 안 된다`);
  }
});

test("상세 조회 예산을 자료 부족 지역에 나눠 준다", async () => {
  const { SerpApiProvider } = await import("../src/providers/serpapi/index.js");
  const p = new SerpApiProvider({ apiKey: "k", detailCalls: 10, emptyRegionShare: 0.3 });
  const ranked = [
    ...Array.from({ length: 20 }, (_, i) => ({ destIn: "IST", i })),
    ...Array.from({ length: 5 }, (_, i) => ({ destIn: "NBO", i })),
  ];
  const { top, thin, plan } = p.splitDetailBudget(ranked, new Set(["NBO"]));
  assert.equal(plan.forThin, 3, "10회 중 3회는 자료 부족 지역 몫");
  assert.equal(top.length, 7);
  assert.equal(thin.length, 3);
  assert.ok(thin.every((x) => x.destIn === "NBO"));
});
