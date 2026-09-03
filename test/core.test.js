// 핵심 판정 로직 시험. node --test 로 실행합니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDateCombos } from "../src/core/dateCombos.js";
import { buildCohorts, judgeDeal } from "../src/core/dealDetector.js";
import { scoreCandidate } from "../src/core/valueScorer.js";
import { dedupe, dealSignature, shouldAlert, isoWeek } from "../src/core/dedup.js";
import { makeCandidate, makeLeg, markConflict } from "../src/core/model.js";
import { isoDurationToMinutes, normalizeOffer } from "../src/providers/amadeus/normalize.js";
import { estimateGround, haversineKm } from "../src/providers/ground/staticGround.js";
import { SETTINGS } from "../src/config/settings.js";

// 시험용 후보 한 장을 빠르게 만드는 도우미
function cand({ dest = "CDG", total = 1000000, depart = "2026-11-10", tripDays = 14, ...rest } = {}) {
  return makeCandidate({
    source: "test", priceType: "live", total, base: Math.round(total * 0.6), taxes: Math.round(total * 0.4),
    originOut: "ICN", destIn: dest, destOut: dest, tripDays,
    outbound: makeLeg({ from: "ICN", to: dest, departAt: `${depart}T10:00:00`, durationMin: 900, segments: [
      { carrier: "MU", number: "MU5034", from: "ICN", to: "PVG", departAt: `${depart}T10:00:00`, arriveAt: `${depart}T11:10:00`, durationMin: 130, layoverMin: 180 },
      { carrier: "MU", number: "MU553", from: "PVG", to: dest, departAt: `${depart}T14:10:00`, arriveAt: `${depart}T20:00:00`, durationMin: 735, layoverMin: null },
    ]}),
    inbound: makeLeg({ from: dest, to: "ICN", departAt: `2026-11-24T12:00:00`, durationMin: 930, segments: [
      { carrier: "MU", number: "MU554", from: dest, to: "PVG", departAt: `2026-11-24T12:00:00`, arriveAt: `2026-11-25T07:00:00`, durationMin: 695, layoverMin: 125 },
      { carrier: "MU", number: "MU5041", from: "PVG", to: "ICN", departAt: `2026-11-25T09:05:00`, arriveAt: `2026-11-25T11:55:00`, durationMin: 110, layoverMin: null },
    ]}),
    baggage: { checkedPieces: 2, checkedKg: 23, cabinKg: 8 },
    ...rest,
  });
}

test("날짜 조합은 정해진 체류기간과 검색창 안에서만 만들어진다", () => {
  const combos = buildDateCombos({ today: "2026-09-03" });
  assert.ok(combos.length > 0);
  for (const c of combos) {
    assert.ok(c.tripDays >= SETTINGS.minTripDays && c.tripDays <= SETTINGS.maxTripDays);
    const days = (Date.parse(c.returnDate) - Date.parse(c.departDate)) / 86400000;
    assert.equal(days, c.tripDays, "귀국일 - 출발일 이 체류일수와 같아야 한다");
  }
});

test("ISO 소요시간 글자를 분으로 바꾼다", () => {
  assert.equal(isoDurationToMinutes("PT21H10M"), 1270);
  assert.equal(isoDurationToMinutes("PT2H10M"), 130);
  assert.equal(isoDurationToMinutes("P1DT2H30M"), 1590);
  assert.equal(isoDurationToMinutes("이상한값"), null);
});

test("경유 대기시간과 공항 변경을 원본에서 읽어낸다", () => {
  const offer = {
    id: "1", numberOfBookableSeats: 2,
    price: { currency: "KRW", total: "1102200", grandTotal: "1102200", base: "602100" },
    itineraries: [{ duration: "PT21H10M", segments: [
      { departure: { iataCode: "ICN", terminal: "1", at: "2026-10-11T16:20:00" },
        arrival: { iataCode: "PVG", at: "2026-10-11T17:30:00" },
        carrierCode: "MU", number: "5034", duration: "PT2H10M", id: "1" },
      { departure: { iataCode: "PVG", at: "2026-10-12T00:15:00" },
        arrival: { iataCode: "CDG", terminal: "2E", at: "2026-10-12T06:30:00" },
        carrierCode: "MU", number: "553", duration: "PT12H15M", id: "2" },
    ]}],
    travelerPricings: [{ fareDetailsBySegment: [
      { segmentId: "1", cabin: "ECONOMY", includedCheckedBags: { quantity: 2 }, includedCabinBags: { weight: 8, weightUnit: "KG" } },
      { segmentId: "2", cabin: "ECONOMY", includedCheckedBags: { quantity: 2 }, includedCabinBags: { weight: 8, weightUnit: "KG" } },
    ]}],
  };
  const c = normalizeOffer(offer);
  assert.equal(c.total, 1102200);
  assert.equal(c.taxes, 500100, "세금 = 총액 - 항공료");
  assert.equal(c.outbound.durationMin, 1270, "총 이동시간은 원본 값을 그대로 쓴다");
  assert.equal(c.outbound.layovers[0], 405, "PVG 경유 대기 6시간 45분");
  assert.equal(c.outbound.stops, 1);
  assert.equal(c.airportChange, false);
  assert.equal(c.seatsLeft, 2);
  assert.deepEqual(c.baggage, { checkedPieces: 2, checkedKg: null, cabinKg: 8 });
  assert.ok(c.unknown.includes("fareRules"), "환불규정은 아직 미확인이어야 한다");
});

test("경유 중 공항이 바뀌면 표시한다", () => {
  const offer = {
    id: "2", price: { currency: "KRW", total: "900000", base: "500000" },
    itineraries: [{ duration: "PT20H", segments: [
      { departure: { iataCode: "ICN", at: "2026-11-01T10:00:00" }, arrival: { iataCode: "NRT", at: "2026-11-01T12:30:00" }, carrierCode: "KE", number: "1", duration: "PT2H30M", id: "1" },
      { departure: { iataCode: "HND", at: "2026-11-01T18:00:00" }, arrival: { iataCode: "CDG", at: "2026-11-02T00:00:00" }, carrierCode: "AF", number: "2", duration: "PT13H", id: "2" },
    ]}],
    travelerPricings: [{ fareDetailsBySegment: [] }],
  };
  assert.equal(normalizeOffer(offer).airportChange, true);
});

test("앞뒤가 맞지 않는 경유 시각은 믿지 않고 확인 필요로 남긴다", () => {
  const offer = {
    id: "3", price: { currency: "KRW", total: "900000", base: "500000" },
    itineraries: [{ duration: "PT20H", segments: [
      // 두 번째 비행기가 첫 번째보다 먼저 뜨는, 있을 수 없는 자료
      { departure: { iataCode: "ICN", at: "2026-11-01T10:00:00" }, arrival: { iataCode: "PVG", at: "2026-11-01T23:30:00" }, carrierCode: "MU", number: "1", duration: "PT2H30M", id: "1" },
      { departure: { iataCode: "PVG", at: "2026-11-01T23:20:00" }, arrival: { iataCode: "CDG", at: "2026-11-02T06:00:00" }, carrierCode: "MU", number: "2", duration: "PT13H", id: "2" },
    ]}],
    travelerPricings: [{ fareDetailsBySegment: [] }],
  };
  const c = normalizeOffer(offer);
  assert.equal(c.outbound.segments[0].layoverMin, null, "말이 안 되는 대기시간은 미확인으로 둔다");
  assert.deepEqual(c.outbound.layovers, [], "음수가 목록에 들어가면 안 된다");
  assert.ok(c.unknown.includes("layover"));
  assert.ok(c.notes.some((n) => n.includes("앞뒤가 맞지 않습니다")));
});

test("이력이 없어도 같은 스캔 안에서 유난히 싼 것을 찾아낸다", () => {
  // 비슷한 후보 12개는 100만원대, 하나만 45만원
  const pool = Array.from({ length: 12 }, (_, i) => cand({ dest: "CDG", total: 1000000 + i * 20000 }));
  const bargain = cand({ dest: "FCO", total: 450000 });
  const cohorts = buildCohorts([...pool, bargain]);

  const v = judgeDeal(bargain, { cohorts });
  assert.equal(v.method, "cohort");
  assert.equal(v.isDeal, true, "평균보다 크게 싸면 특가로 판정되어야 한다");
  assert.ok(v.zScore >= SETTINGS.deal.minZScore);
  assert.equal(v.confidence, "low", "이력 없이 판정한 건 신뢰도 낮음이어야 한다");

  const normal = judgeDeal(pool[5], { cohorts });
  assert.equal(normal.isDeal, false, "평범한 값은 특가가 아니어야 한다");
});

test("비교군이 작으면 범위를 넓혀서 판단한다", () => {
  // 11월 유럽 10-13일 칸에는 2개뿐, 유럽 전체로 넓히면 충분
  const wide = Array.from({ length: 10 }, (_, i) =>
    cand({ dest: "CDG", total: 1000000 + i * 30000, depart: "2027-03-05", tripDays: 18 }));
  const target = cand({ dest: "FCO", total: 400000, depart: "2026-11-10", tripDays: 11 });
  const cohorts = buildCohorts([...wide, target, cand({ dest: "VIE", total: 1100000, depart: "2026-11-10", tripDays: 11 })]);
  const v = judgeDeal(target, { cohorts });
  assert.equal(v.method, "cohort");
  assert.ok(["지역·기간", "지역"].includes(v.cohortLevel), `넓은 칸을 써야 한다 (실제: ${v.cohortLevel})`);
  assert.equal(v.isDeal, true);
});

test("이번 스캔에서 방금 적은 이력은 판정 근거로 쓰지 않는다", async () => {
  const { PriceHistory } = await import("../src/store/history.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  const h = new PriceHistory(dir);

  // 같은 노선 기록 12건을 '지금' 적습니다
  const rows = Array.from({ length: 12 }, (_, i) => cand({ dest: "CDG", total: 1000000 + i * 10000 }));
  h.append(rows);

  const target = cand({ dest: "CDG", total: 400000 });
  const cohorts = buildCohorts([target]);

  // 방금 적은 기록을 그대로 쓰면 '이력 기반'으로 판정됩니다
  const withOwn = judgeDeal(target, { history: h, cohorts });
  assert.match(withOwn.method, /^history/, "차단하지 않으면 이력 기반으로 판정된다");

  // 스캔 시작 시각을 주면 그 이후 기록은 무시됩니다
  const before = new Date(Date.now() - 60000).toISOString();
  const blocked = judgeDeal(target, { history: h, cohorts, historyBefore: before });
  assert.notEqual(blocked.method, "history", "같은 스캔의 기록으로 판정하면 안 된다");
  assert.notEqual(blocked.method, "history-route");
});

test("상한을 넘는 가격은 아예 후보에서 뺀다", () => {
  const v = judgeDeal(cand({ total: 3000000 }), { cohorts: new Map() });
  assert.equal(v.tooExpensive, true);
  assert.equal(v.isDeal, false);
});

test("비교할 자료가 없으면 특가라고 우기지 않는다", () => {
  const v = judgeDeal(cand({ total: 300000 }), { cohorts: new Map() });
  assert.equal(v.isDeal, false);
  assert.equal(v.method, "none");
});

test("짧은 경유·수하물 미포함은 경고와 감점으로 이어진다", () => {
  const risky = cand({ total: 700000 });
  risky.outbound.layovers = [50];
  risky.baggage = null;
  risky.selfTransfer = true;
  const good = cand({ total: 700000 });

  const rs = scoreCandidate(risky, { discountPct: 30, method: "history" });
  const gs = scoreCandidate(good, { discountPct: 30, method: "history" });
  assert.ok(rs.score < gs.score, "위험한 일정이 더 낮은 점수를 받아야 한다");
  assert.ok(rs.warnings.some((w) => w.includes("50분")));
  assert.ok(rs.warnings.some((w) => w.includes("자가환승")));
  assert.ok(rs.warnings.some((w) => w.includes("수하물")));
});

test("실제로 놀 수 있는 날은 이동시간을 뺀 값이다", () => {
  const c = cand({ tripDays: 14 });
  const s = scoreCandidate(c, { discountPct: 10, method: "history" });
  assert.ok(s.usableDays < 14 && s.usableDays > 12, `이동시간만큼 줄어야 한다 (실제 ${s.usableDays})`);
});

test("같은 특가는 하나로 묶고 점수 높은 쪽을 남긴다", () => {
  const a = { candidate: cand({ total: 1000000 }), verdict: { isDeal: true }, value: { score: 70 } };
  const b = { candidate: cand({ total: 1010000 }), verdict: { isDeal: true }, value: { score: 85 } };
  assert.equal(dealSignature(a.candidate), dealSignature(b.candidate), "10만원 차이는 같은 특가로 본다");
  const out = dedupe([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value.score, 85);
});

test("한 번 알린 특가는 크게 더 싸질 때만 다시 알린다", () => {
  const item = { candidate: cand({ total: 1000000 }), value: { score: 80 } };
  item.signature = dealSignature(item.candidate);

  assert.equal(shouldAlert(item, {}).kind, "new");

  const justAlerted = { [item.signature]: { price: 1000000, at: new Date().toISOString() } };
  assert.equal(shouldAlert(item, justAlerted).alert, false, "같은 값이면 다시 알리지 않는다");

  const cheaper = { candidate: cand({ total: 900000 }), value: { score: 80 } };
  cheaper.signature = item.signature;
  const d = shouldAlert(cheaper, justAlerted);
  assert.equal(d.alert, true);
  assert.equal(d.kind, "cheaper");
});

test("구간 정보가 없으면 경유 횟수를 0 이라고 단정하지 않는다", () => {
  const leg = makeLeg({ from: "ICN", to: "CDG", departAt: "2026-11-10", segments: [] });
  assert.equal(leg.stops, null, "모르는 것을 직항이라고 하면 안 된다");
  const one = makeLeg({ from: "ICN", to: "CDG", departAt: "2026-11-10",
    segments: [{ carrier: "KE", from: "ICN", to: "CDG" }] });
  assert.equal(one.stops, 0, "구간이 1개면 진짜 직항이다");
});

test("스캔마다 새 파일에 적어서 서로 부딪히지 않는다", async () => {
  const { PriceHistory } = await import("../src/store/history.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsplit-"));

  // 서로 다른 두 스캔이 각자 적습니다
  new PriceHistory(dir).append([cand({ total: 100000 }), cand({ total: 200000 })]);
  new PriceHistory(dir).append([cand({ total: 300000 })]);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  assert.equal(files.length, 2, "스캔마다 낱장이 하나씩 생겨야 한다");
  assert.equal(new PriceHistory(dir).load().length, 3, "읽을 때는 낱장을 전부 모아 읽어야 한다");
});

test("연습용 가짜 자료는 가격 이력에 남기지 않는다", async () => {
  const { PriceHistory } = await import("../src/store/history.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hmock-"));
  const h = new PriceHistory(dir);

  const fake = cand({ total: 111111 });
  fake.source = "mock";
  const real = cand({ dest: "FCO", total: 900000 });

  const written = h.append([fake, real]);
  assert.equal(written, 1, "가짜는 빼고 진짜만 적어야 한다");
  const rows = new PriceHistory(dir).load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "test");
  assert.ok(!rows.some((r) => r.total === 111111), "가짜 가격이 섞이면 안 된다");
});

test("주차 계산이 맞는다", () => {
  assert.equal(isoWeek("2026-10-11"), "2026W41");
});

test("육로 이동은 같은 지역 안에서만, 항상 추정치 도장이 찍힌다", () => {
  const g = estimateGround("CDG", "FCO");
  assert.equal(g.estimated, true);
  assert.ok(g.km > 1000 && g.km < 1200, `파리-로마 직선거리 (실제 ${g.km}km)`);
  assert.equal(estimateGround("CDG", "CAI"), null, "대륙이 다르면 육로로 잇지 않는다");
  assert.equal(estimateGround("CDG", "CDG"), null);
  assert.ok(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) > 110);
});

test("화면마다 값이 다르면 확인 필요로 표시된다", () => {
  const c = cand({ total: 1000000 });
  markConflict(c, "total", 1000000, 1060000);
  assert.equal(c.fareRules.conflict, true);
  assert.ok(c.unknown.includes("total"));
  assert.ok(c.notes.some((n) => n.includes("확인 필요")));
  const s = scoreCandidate(c, { discountPct: 40, method: "history" });
  assert.ok(s.warnings.some((w) => w.includes("확인 필요")));
});

test("같은 일정이면 가격이 달라도 같은 id 를 갖는다", () => {
  assert.equal(cand({ total: 900000 }).id, cand({ total: 1200000 }).id);
  assert.notEqual(cand({ dest: "CDG" }).id, cand({ dest: "FCO" }).id);
});
