// 전체 흐름 시험. 특히 '확인 필요'인 후보가 확정 특가로 새어나가지 않는지 봅니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScan } from "../src/pipeline/scan.js";
import { PriceHistory } from "../src/store/history.js";
import { AlertState } from "../src/store/alertState.js";
import { FlightProvider } from "../src/providers/base.js";
import { makeCandidate, makeLeg, PRICE_TYPE } from "../src/core/model.js";
import { pickDestinations } from "../src/config/destinations.js";

/** 시험용 임시 폴더 (진짜 데이터를 건드리지 않게) */
function tmpDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdf-test-"));
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  return {
    history: new PriceHistory(path.join(dir, "history")),
    alertState: new AlertState(path.join(dir, "alert-state.json")),
    dir,
  };
}

function leg(from, to, departAt, durationMin) {
  return makeLeg({
    from, to, departAt, arriveAt: departAt, durationMin,
    segments: [{ carrier: "XX", number: "XX1", from, to, departAt, arriveAt: departAt, durationMin, layoverMin: null }],
  });
}

// 시험에 쓸 유럽 목적지 20곳과, 그중 '아주 싼 곳' 하나를 미리 정해 둡니다.
const EURO20 = pickDestinations(["europe"]).slice(0, 20);
const BARGAIN = EURO20[4].iata;
const AFRICA20 = pickDestinations(["africa"]).slice(0, 20);

/**
 * 시험용 공급자.
 * 유럽 목적지 여러 곳을 비싸게 내놓고, 딱 한 곳(BARGAIN)만 아주 싸게 내놓습니다.
 * conflictOnConfirm 이 켜져 있으면 가격 확정 단계에서 값이 달라집니다.
 */
class StubProvider extends FlightProvider {
  constructor({ conflictOnConfirm = false } = {}) {
    super();
    this.conflictOnConfirm = conflictOnConfirm;
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [] };
  }
  get name() { return "stub"; }
  get capabilities() { return { indicative: true, live: true, confirm: true, openJaw: false }; }

  #make(dest, total, priceType) {
    return makeCandidate({
      source: "stub", priceType, total, base: Math.round(total * 0.6), taxes: Math.round(total * 0.4),
      originOut: "ICN", destIn: dest, destOut: dest, tripDays: 14,
      outbound: leg("ICN", dest, "2026-11-10T10:00:00", 900),
      inbound: leg(dest, "ICN", "2026-11-24T12:00:00", 930),
      baggage: { checkedPieces: 2, checkedKg: 23, cabinKg: 8 },
      separateTickets: false, selfTransfer: false, airportChange: false,
    });
  }

  async searchInspiration({ origin } = {}) {
    this.stats.indicativeCalls++;
    // 유럽·아프리카 후보를 모두 내놓고, 스캔 쪽에서 지역으로 걸러 쓰게 합니다.
    const pool = [...EURO20, ...AFRICA20];
    const candidates = pool.map((d, i) =>
      this.#make(d.iata, d.iata === BARGAIN ? 420000 : 1150000 + i * 15000, PRICE_TYPE.INDICATIVE)
    );
    return { ok: true, candidates };
  }
  async searchCheapestDates() { return { ok: true, candidates: [] }; }

  async searchLive({ destination }) {
    this.stats.liveCalls++;
    const total = destination === BARGAIN ? 430000 : 1160000;
    return { ok: true, candidates: [this.#make(destination, total, PRICE_TYPE.LIVE)] };
  }

  async confirmPrice(candidate) {
    this.stats.confirmCalls++;
    const c = JSON.parse(JSON.stringify(candidate));
    c.priceType = PRICE_TYPE.CONFIRMED;
    if (this.conflictOnConfirm) {
      // 확정 화면에서 값이 달라진 상황
      c.total = Math.round(candidate.total * 1.2);
      c.fareRules = { refundable: null, changeFeeKRW: null, conflict: true };
      c.notes.push("확인 필요: 조회가와 확정가가 다릅니다");
    } else {
      c.fareRules = { refundable: false, changeFeeKRW: 120000, conflict: false };
      c.unknown = c.unknown.filter((k) => k !== "fareRules");
    }
    return c;
  }
}

test("유난히 싼 후보가 확정 단계를 통과하면 확정 특가가 된다", async () => {
  const { history, alertState } = tmpDirs();
  const r = await runScan({
    provider: new StubProvider(), history, alertState,
    regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });

  assert.ok(r.deals.length >= 1, "특가가 최소 1건은 나와야 한다");
  const best = r.deals.find((d) => d.candidate.destIn === BARGAIN);
  assert.ok(best, `가장 싼 ${BARGAIN} 가 특가로 잡혀야 한다`);
  assert.equal(best.candidate.priceType, PRICE_TYPE.CONFIRMED);
  assert.equal(best.status, "confirmed_deal");
  assert.equal(best.verdict.isDeal, true);
  assert.ok(best.candidate.fareRules && best.candidate.fareRules.conflict === false);
  assert.equal(r.alerts.length >= 1, true, "새 특가이므로 알림 대상이어야 한다");
});

test("확정 화면에서 값이 달라지면 확정 특가로 내보내지 않는다", async () => {
  const { history, alertState } = tmpDirs();
  const r = await runScan({
    provider: new StubProvider({ conflictOnConfirm: true }), history, alertState,
    regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });

  for (const d of r.deals) {
    assert.notEqual(d.candidate.fareRules?.conflict, true, "값이 어긋난 후보가 확정 특가에 있으면 안 된다");
  }
  const flagged = r.needsReview.find((i) => i.candidate.fareRules?.conflict === true);
  assert.ok(flagged, "어긋난 후보는 '확인 필요' 쪽에 있어야 한다");
  assert.equal(flagged.status, "needs_review");
  assert.match(flagged.statusReason, /확인이 필요/);
  assert.equal(r.alerts.length, 0, "확인 필요 항목은 알림으로 나가면 안 된다");
});

test("같은 특가를 연달아 스캔하면 두 번째에는 알리지 않는다", async () => {
  const { history, alertState } = tmpDirs();
  const opts = { history, alertState, regions: ["europe"], today: new Date("2026-09-03"), log: () => {} };

  const first = await runScan({ provider: new StubProvider(), ...opts });
  assert.ok(first.alerts.length >= 1);
  alertState.save();

  const second = await runScan({ provider: new StubProvider(), ...opts });
  assert.equal(second.alerts.length, 0, "값이 그대로면 다시 알리지 않아야 한다");
});

test("유럽은 경유 2회를 걸러내고, 아프리카는 2회를 허용한다", async () => {
  // 경유 2회짜리만 내놓는 공급자
  class TwoStopProvider extends StubProvider {
    async searchLive({ destination }) {
      this.stats.liveCalls++;
      const c = makeCandidate({
        source: "stub", priceType: PRICE_TYPE.LIVE, total: 300000, base: 180000, taxes: 120000,
        originOut: "ICN", destIn: destination, destOut: destination, tripDays: 14,
        outbound: makeLeg({ from: "ICN", to: destination, departAt: "2026-11-10T10:00:00", durationMin: 1800,
          segments: [
            { carrier: "XX", number: "XX1", from: "ICN", to: "A", departAt: "2026-11-10T10:00:00", arriveAt: "2026-11-10T12:00:00", durationMin: 120, layoverMin: 120 },
            { carrier: "XX", number: "XX2", from: "A", to: "B", departAt: "2026-11-10T14:00:00", arriveAt: "2026-11-10T18:00:00", durationMin: 240, layoverMin: 120 },
            { carrier: "XX", number: "XX3", from: "B", to: destination, departAt: "2026-11-10T20:00:00", arriveAt: "2026-11-11T06:00:00", durationMin: 600, layoverMin: null },
          ]}),
        inbound: leg(destination, "ICN", "2026-11-24T12:00:00", 930),
        baggage: { checkedPieces: 1, checkedKg: 23, cabinKg: 8 },
        separateTickets: false, selfTransfer: false, airportChange: false,
      });
      assert.equal(c.outbound.stops, 2, "시험용 후보는 경유 2회여야 한다");
      return { ok: true, candidates: [c] };
    }
  }

  // --- 유럽: 경유 1회까지만 허용 → 전부 걸러져야 한다 ---
  {
    const { history, alertState } = tmpDirs();
    const r = await runScan({
      provider: new TwoStopProvider(), history, alertState,
      regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
    });
    assert.equal(r.deals.length, 0, "유럽에서 경유 2회짜리는 특가로 나가면 안 된다");
    assert.ok(r.report.stages.live.droppedByStops > 0, "걸러진 건수가 기록되어야 한다");
    assert.equal(r.report.stages.live.maxStops, 1);
    assert.ok(r.report.stages.live.emptyDestinations.length > 0, "결과 없는 목적지가 기록되어야 한다");
  }

  // --- 아프리카: 경유 2회까지 허용 → 그대로 남아야 한다 ---
  {
    const { history, alertState } = tmpDirs();
    const r = await runScan({
      provider: new TwoStopProvider(), history, alertState,
      regions: ["africa"], today: new Date("2026-09-03"), log: () => {},
    });
    assert.equal(r.report.stages.live.droppedByStops, 0, "아프리카에서는 경유 2회를 걸러내면 안 된다");
    assert.ok(r.report.stages.live.found > 0, "아프리카 후보가 남아야 한다");
    assert.ok(r.report.stages.live.coverage.every((x) => x.maxStops === 2), "아프리카 제한은 2회로 기록되어야 한다");
  }
});

test("스캔한 가격은 이력 공책에 쌓인다", async () => {
  const { history, alertState } = tmpDirs();
  assert.equal(history.load().length, 0);
  await runScan({
    provider: new StubProvider(), history, alertState,
    regions: ["europe"], today: new Date("2026-09-03"), log: () => {},
  });
  const rows = history.load();
  assert.ok(rows.length >= 20, `이력이 쌓여야 한다 (실제 ${rows.length}건)`);
  assert.ok(rows.every((r) => typeof r.total === "number" && r.key.includes("ICN-")));
});

test("공급자가 아무것도 못 찾으면 조용히 끝나고 경고를 남긴다", async () => {
  const { history, alertState } = tmpDirs();
  class EmptyProvider extends StubProvider {
    async searchInspiration() { return { ok: true, candidates: [] }; }
    async searchCheapestDates() { return { ok: true, candidates: [] }; }
  }
  const r = await runScan({
    provider: new EmptyProvider(), history, alertState,
    regions: ["mongolia"], today: new Date("2026-09-03"), log: () => {},
  });
  assert.equal(r.deals.length, 0);
  assert.ok(r.report.warnings.some((w) => w.includes("찾지 못했습니다")));
});
