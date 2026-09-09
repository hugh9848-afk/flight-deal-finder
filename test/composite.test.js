// 여러 공급자를 묶었을 때의 동작 시험.
// 가장 중요한 것: 한 공급자가 죽어도 나머지 결과가 살아남아야 합니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositeProvider, mergeAcrossProviders } from "../src/providers/composite.js";
import { FlightProvider } from "../src/providers/base.js";
import { makeCandidate, makeLeg, PRICE_TYPE } from "../src/core/model.js";

/** 시험용 후보 한 장 */
function cand({ dest = "CDG", total = 800000, depart = "2026-11-10", back = "2026-11-24", rich = false } = {}) {
  const c = makeCandidate({
    source: "t", priceType: PRICE_TYPE.INDICATIVE, total,
    originOut: "ICN", destIn: dest, destOut: dest, tripDays: 15,
    outbound: makeLeg({ from: "ICN", to: dest, departAt: depart,
                        durationMin: rich ? 900 : null, segments: [] }),
    inbound: makeLeg({ from: dest, to: "ICN", departAt: back,
                       durationMin: rich ? 840 : null, segments: [] }),
  });
  if (rich) {
    c.inbound.stops = 1;
    c.providerBaseline = { kind: "google_deals_reported", baseline: total * 1.5, discountPct: 33 };
    c.departureAirportVerified = true;
  }
  return c;
}

/** 정해진 후보를 내놓는 가짜 공급자 */
class Fake extends FlightProvider {
  constructor(name, candidates, opts = {}) {
    super();
    this._name = name; this._c = candidates; this._opts = opts;
    this.stats = { indicativeCalls: 1, liveCalls: 0, confirmCalls: 0, errors: [], skipped: [] };
  }
  get name() { return this._name; }
  get capabilities() {
    return { indicative: true, live: this._opts.live ?? false, confirm: false, openJaw: false };
  }
  get detailCalls() { return this._opts.detailCalls; }
  async searchInspiration() {
    if (this._opts.throws) throw new Error("공급자 사고");
    if (this._opts.fails) return { ok: false, candidates: [], error: "서버 오류" };
    return { ok: true, candidates: this._c };
  }
  async searchLive() {
    if (this._opts.liveSkipped) return { ok: false, candidates: [], skipped: true, error: "예산 소진" };
    return { ok: true, candidates: [cand({ dest: "LHR", total: 700000, rich: true })] };
  }
}

test("한 공급자가 사고를 내도 나머지 결과는 살아남는다", async () => {
  const good = new Fake("good", [cand({ dest: "CDG" }), cand({ dest: "FCO" })]);
  const bad = new Fake("bad", [], { throws: true });
  const c = new CompositeProvider([{ provider: bad }, { provider: good }]);

  const r = await c.searchInspiration({ origin: "ICN" });
  assert.equal(r.candidates.length, 2, "멀쩡한 공급자 결과는 그대로 나와야 한다");
  assert.ok(c.stats.errors.some((e) => e.provider === "bad"), "사고는 기록되어야 한다");
});

test("한 공급자가 실패를 알려와도 나머지는 계속한다", async () => {
  const good = new Fake("good", [cand({ dest: "CDG" })]);
  const bad = new Fake("bad", [], { fails: true });
  const c = new CompositeProvider([{ provider: bad }, { provider: good }]);

  const r = await c.searchInspiration({ origin: "ICN" });
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1);
  const badCov = r.coverage.find((x) => x.provider === "bad");
  assert.equal(badCov.ok, false, "실패한 공급자도 기록에 남아야 한다");
});

test("같은 일정·같은 값이면 더 많이 아는 쪽을 남긴다", () => {
  const thin = cand({ dest: "CDG", total: 800000, rich: false });
  const rich = cand({ dest: "CDG", total: 800000, rich: true });
  const merged = mergeAcrossProviders([thin, rich]);
  assert.equal(merged.length, 1, "같은 값이면 하나로 합친다");
  assert.ok(merged[0].providerBaseline, "할인 기준을 아는 쪽이 남아야 한다");
  assert.equal(merged[0].inbound.stops, 1);
});

test("값이 다르면 서로 다른 운임일 수 있으므로 둘 다 남긴다", () => {
  const merged = mergeAcrossProviders([
    cand({ dest: "CDG", total: 800000 }),
    cand({ dest: "CDG", total: 650000 }),
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.map((c) => c.total).includes(650000), "싼 쪽을 잃으면 안 된다");
});

test("실제 조회는 그걸 할 수 있는 공급자에게만 간다", async () => {
  const noLive = new Fake("no-live", []);
  const withLive = new Fake("with-live", [], { live: true });
  const c = new CompositeProvider([{ provider: noLive }, { provider: withLive }]);

  assert.equal(c.capabilities.live, true, "하나라도 되면 된다고 본다");
  const r = await c.searchLive({ destination: "LHR" });
  assert.equal(r.ok, true);
  assert.equal(r.candidates[0].destIn, "LHR");
});

test("실제 조회 예산이 다 되면 그 사실을 그대로 알린다", async () => {
  const c = new CompositeProvider([
    { provider: new Fake("paid", [], { live: true, liveSkipped: true }) },
  ]);
  const r = await c.searchLive({ destination: "LHR" });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true, "예산 소진은 오류가 아니라 '건너뜀'으로 알려야 한다");
});

test("실제 조회 횟수는 유료 공급자의 예산을 넘지 않는다", () => {
  const c = new CompositeProvider([
    { provider: new Fake("free", []) },
    { provider: new Fake("paid", [], { live: true, detailCalls: 12 }) },
  ]);
  assert.equal(c.detailBudget, 12, "유료 공급자의 예산이 상한이 되어야 한다");
});

test("상세 조회를 해도 넓게 훑은 후보를 버리지 않는다", async () => {
  const { runScan } = await import("../src/pipeline/scan.js");
  const { PriceHistory } = await import("../src/store/history.js");
  const { AlertState } = await import("../src/store/alertState.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-"));
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  const history = new PriceHistory(path.join(dir, "history"));
  const alertState = new AlertState(path.join(dir, "s.json"));

  // 넓게 훑어 유럽 12곳을 찾고, 상세 조회는 1곳만 하는 공급자
  const wide = ["CDG", "FCO", "VIE", "PRG", "MAD", "BCN", "LIS", "ATH", "BUD", "WAW", "AMS", "BER"]
    .map((d, i) => cand({ dest: d, total: 900000 + i * 10000 }));

  class WideAndDeep extends Fake {
    get capabilities() { return { indicative: true, live: true, confirm: false, openJaw: false }; }
    get detailCalls() { return 1; }
    async searchInspiration() { return { ok: true, candidates: wide }; }
    async searchLive({ destination }) {
      return { ok: true, candidates: [cand({ dest: destination, total: 500000, rich: true })] };
    }
  }
  const r = await runScan({
    provider: new WideAndDeep("wide-deep", []), history, alertState,
    regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });

  const all = [...r.deals, ...r.needsReview];
  assert.ok(all.length >= 10,
    `넓게 훑은 후보가 남아야 한다 (실제 ${all.length}건)`);
  assert.ok(r.report.stages.live.keptIndicative > 0, "남긴 참고가 건수가 기록되어야 한다");
  // 상세 조회한 자리는 상세 결과로 바뀌어야 합니다
  assert.ok(all.some((x) => x.candidate.total === 500000), "상세 조회 결과도 들어 있어야 한다");
});
