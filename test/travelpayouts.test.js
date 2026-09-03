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
  assert.equal(c.tripDays, 14);
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
  assert.equal(c.tripDays, 14);
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

test("같은 노선·날짜가 겹치면 싼 쪽만 남긴다", async () => {
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
    minTripDays: 10, maxTripDays: 20, destinations: dests("CDG"),
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].total, 750000);
});

test("참고가만 주는 공급자로는 확정 특가가 절대 만들어지지 않는다", async () => {
  const { history, alertState } = tmp();
  // 유럽 여러 곳 + 유난히 싼 곳 하나
  const codes = ["CDG", "FCO", "VIE", "PRG", "MAD", "BCN", "LIS", "ATH", "BUD", "WAW"];
  const byDest = {};
  codes.forEach((d, i) => {
    byDest[d] = [{ origin: "ICN", destination: d, depart_date: "2026-11-10", return_date: "2026-11-24",
                   value: d === "FCO" ? 380000 : 1200000 + i * 20000, number_of_changes: 1 }];
  });
  const p = new TravelpayoutsProvider({ client: new FakeClient(byDest) });

  const r = await runScan({
    provider: p, history, alertState, regions: ["europe"],
    today: new Date("2026-09-03"), log: () => {},
  });

  assert.equal(r.deals.length, 0, "실제 조회를 못 했으므로 확정 특가는 0건이어야 한다");
  assert.equal(r.alerts.length, 0, "확정하지 않은 것을 알림으로 보내면 안 된다");
  assert.ok(r.report.stages.live.skipped, "2단계를 건너뛴 사실이 기록되어야 한다");
  assert.ok(r.report.warnings.some((w) => w.includes("실제 운임 조회를 지원하지 않습니다")));

  // 싼 후보는 '확인 필요'로는 올라와야 합니다
  const fco = r.needsReview.find((i) => i.candidate.destIn === "FCO");
  assert.ok(fco, "유난히 싼 후보는 확인 필요 목록에 있어야 한다");
  assert.equal(fco.status, "needs_review");
  assert.match(fco.statusReason, /참고가/);
  assert.equal(fco.candidate.priceType, PRICE_TYPE.INDICATIVE);
});

test("참고가 단계에서도 경유 제한이 지켜진다 (유럽 1회 / 아프리카 2회)", async () => {
  const { history, alertState } = tmp();
  const mk = (dest, stops) => [{ origin: "ICN", destination: dest, depart_date: "2026-11-10",
                                 return_date: "2026-11-24", value: 800000, number_of_changes: stops }];
  // 유럽(PRG) 2회 → 제외 / 유럽(VIE) 1회 → 통과 / 아프리카(CAI) 2회 → 통과 / 아프리카(NBO) 3회 → 제외
  const p = new TravelpayoutsProvider({
    client: new FakeClient({ PRG: mk("PRG", 2), VIE: mk("VIE", 1), CAI: mk("CAI", 2), NBO: mk("NBO", 3) }),
  });
  const r = await runScan({
    provider: p, history, alertState, today: new Date("2026-09-03"), log: () => {},
  });
  const kept = r.needsReview.map((i) => i.candidate.destIn).sort();
  assert.deepEqual(kept, ["CAI", "VIE"], `유럽 1회·아프리카 2회만 남아야 한다 (실제: ${kept.join(",")})`);
  assert.equal(r.report.stages.indicative.droppedByStops, 2);
});

test("값이 실제로 떨어졌을 때만 알리고, 같은 후보를 두 번 알리지 않는다", async () => {
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
  assert.ok(dropped.alerts.length >= 1, "떨어졌으면 알려야 한다");
  assert.equal(dropped.alerts[0].candidate.priceType, "indicative", "참고가임을 유지해야 한다");
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
