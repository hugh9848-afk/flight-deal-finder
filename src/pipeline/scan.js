// 전체 탐색 흐름(깔때기).
//
//  1단계  넓게 훑기   : 전화 1번으로 수십 개 목적지 참고가        (indicative)
//  2단계  실제 조회   : 좋아 보이는 상위 15개만 진짜 운임 조회     (live)
//  3단계  가격 확정   : 그중 상위 5개만 총액·수하물·환불규정 확인  (confirmed)
//
// 3단계를 통과했고, 화면마다 값이 어긋나지 않은 것만 '확정 특가'라고 부릅니다.
import { SETTINGS } from "../config/settings.js";
import { pickDestinations, findAirport, maxStopsFor } from "../config/destinations.js";
import { addDays, ymd } from "../core/dateCombos.js";
import { buildCohorts, judgeDeal } from "../core/dealDetector.js";
import { scoreCandidate } from "../core/valueScorer.js";
import { dedupe, dealSignature, shouldAlert } from "../core/dedup.js";
import { estimateGround, findOpenJawPartners } from "../providers/ground/staticGround.js";
import { PRICE_TYPE } from "../core/model.js";

export async function runScan({
  provider,
  history,
  alertState,
  regions = [],
  settings = SETTINGS,
  today = new Date(),
  log = console.log,
  maxFallbackDestinations = 40,
} = {}) {
  const t0 = Date.now();
  // 이번 스캔이 시작된 시각. 판정할 때 '이 시각 이전' 이력만 씁니다.
  const scanStartedAt = new Date().toISOString();
  const destinations = pickDestinations(regions);
  const allowed = new Set(destinations.map((d) => d.iata));
  const departFrom = ymd(addDays(today, settings.searchWindow.fromDaysAhead));
  const departTo = ymd(addDays(today, settings.searchWindow.toDaysAhead));

  const report = {
    startedAt: new Date().toISOString(),
    provider: provider.name,
    window: { departFrom, departTo },
    regions: regions.length ? regions : ["전체"],
    destinationCount: destinations.length,
    stages: {},
    warnings: [],
  };

  // ───────────────── 1단계: 넓게 훑기 ─────────────────
  log(`[1단계] ${departFrom} ~ ${departTo} 출발, ${settings.minTripDays}~${settings.maxTripDays}일 일정으로 넓게 훑는 중...`);
  let indicative = [];
  const insp = await provider.searchInspiration({
    origin: settings.origin, departFrom, departTo,
    minTripDays: settings.minTripDays, maxTripDays: settings.maxTripDays,
    tripDaysStep: settings.tripDaysStep,
    destinations,
    maxPrice: settings.deal.maxTotalKRW,
  });
  if (insp.ok && insp.candidates.length) {
    indicative = insp.candidates.filter((c) => allowed.has(c.destIn));
  } else {
    // 넓게 훑기가 비었으면 목적지를 하나씩 물어봅니다 (전화 수가 늘어납니다)
    report.warnings.push(
      `넓은 탐색이 비어 예비 방식으로 전환했습니다${insp.error ? ` (${insp.error})` : ""}`
    );
    log(`  → 넓은 탐색 결과 없음. 목적지별 조회로 전환 (최대 ${maxFallbackDestinations}곳)`);
    for (const d of destinations.slice(0, maxFallbackDestinations)) {
      const r = await provider.searchCheapestDates({
        origin: settings.origin, destination: d.iata, departFrom, departTo,
        minTripDays: settings.minTripDays, maxTripDays: settings.maxTripDays,
      });
      if (r.ok) indicative.push(...r.candidates.filter((c) => allowed.has(c.destIn)));
    }
  }
  // 경유 제한을 참고가 단계에도 적용합니다.
  // (2단계를 건너뛰는 공급자에서도 "유럽 1회 / 아프리카 2회" 약속이 지켜지도록)
  const beforeStopFilter = indicative.length;
  indicative = indicative.filter((c) => {
    const s = c.outbound?.stops;
    if (typeof s !== "number") return true;   // 모르면 남겨둡니다 (거르지 않음)
    return s <= maxStopsFor(c.destIn, settings);
  });
  const droppedIndicativeByStops = beforeStopFilter - indicative.length;
  if (droppedIndicativeByStops) {
    log(`  → 경유 제한 초과 ${droppedIndicativeByStops}건 제외`);
  }

  report.stages.indicative = { found: indicative.length, droppedByStops: droppedIndicativeByStops };
  if (insp.coverage) {
    const withData = insp.coverage.filter((c) => c.rows > 0);
    report.stages.indicative.coverage = {
      queried: insp.coverage.length,
      withData: withData.length,
      empty: insp.coverage.filter((c) => c.rows === 0).map((c) => c.destination),
    };
    log(`  → 목적지 ${insp.coverage.length}곳 조회, ${withData.length}곳에서 자료 확보`);
  }
  log(`  → 참고가 후보 ${indicative.length}건`);

  if (!indicative.length) {
    report.finishedAt = new Date().toISOString();
    report.warnings.push("후보를 하나도 찾지 못했습니다. 공급자 설정과 노선 커버리지를 확인하세요.");
    return { report, deals: [], needsReview: [], alerts: [] };
  }

  // 본 값은 전부 공책에 적습니다 (다음 스캔부터 '평소 가격'을 알 수 있게)
  const written = history?.append(indicative) ?? 0;
  report.stages.indicative.historyRows = written;

  // ───────────────── 참고가로 순위 매기기 ─────────────────
  const cohorts = buildCohorts(indicative);
  const ranked = indicative
    .map((c) => {
      const verdict = judgeDeal(c, { history, cohorts, settings, historyBefore: scanStartedAt });
      return { candidate: c, verdict, value: scoreCandidate(c, verdict) };
    })
    .filter((x) => !x.verdict.tooExpensive)
    .sort((a, b) => rankKey(b) - rankKey(a));

  const shortlist = ranked.slice(0, settings.funnel.liveCheckTop);
  report.stages.shortlist = {
    count: shortlist.length,
    dealFlagged: ranked.filter((x) => x.verdict.isDeal).length,
    method: shortlist[0]?.verdict.method ?? null,
  };
  log(`[2단계] 상위 ${shortlist.length}개를 실제 조회합니다 (판정 방식: ${shortlist[0]?.verdict.method ?? "-"})`);

  // ───────────────── 2단계: 실제 조회 ─────────────────
  // 공급자가 실제 조회를 못 하면(참고가 전용) 이 단계를 건너뜁니다.
  // 그 경우 결과는 전부 '참고가'로 남고, 확정 특가는 만들어지지 않습니다.
  if (!provider.capabilities.live) {
    report.warnings.push(
      `${provider.name} 은(는) 실제 운임 조회를 지원하지 않습니다. ` +
      `참고가까지만 표시되며 확정 특가는 만들어지지 않습니다.`
    );
    log(`[2단계] 건너뜀 — ${provider.name} 은 참고가만 제공합니다`);
    return finishIndicativeOnly({
      report, ranked, shortlist, history, alertState, settings, cohorts, log, t0, provider,
    });
  }

  const live = [];
  const coverage = [];      // 목적지별로 결과가 있었는지 기록 (커버리지 확인용)
  let droppedByStops = 0;
  for (const item of shortlist) {
    const c = item.candidate;
    const departureDate = c.outbound?.departAt?.slice(0, 10);
    const returnDate = c.inbound?.departAt?.slice(0, 10);
    if (!departureDate || !returnDate) continue;

    // 목적지마다 허용 경유 횟수가 다릅니다 (아프리카는 2회까지)
    const stopLimit = maxStopsFor(c.destIn, settings);
    const r = await provider.searchLive({
      origin: settings.origin, destination: c.destIn,
      departureDate, returnDate,
      adults: settings.adults, cabin: settings.cabin,
      max: 3, maxPrice: settings.deal.maxTotalKRW,
      maxStops: stopLimit,
    });
    if (r.ok) {
      // 공급자가 제한을 무시했을 수도 있으니 우리 쪽에서 한 번 더 거릅니다.
      const kept = r.candidates.filter((x) => withinStops(x, stopLimit));
      droppedByStops += r.candidates.length - kept.length;
      live.push(...kept);
      coverage.push({ destination: c.destIn, departureDate, found: kept.length, maxStops: stopLimit });
    } else {
      coverage.push({ destination: c.destIn, departureDate, found: 0, maxStops: stopLimit, error: r.error });
      report.warnings.push(`실제 조회 실패 ${c.destIn} ${departureDate}: ${r.error}`);
    }
  }
  log(`  → 실제 운임 ${live.length}건${droppedByStops ? ` (경유 ${settings.maxStops}회 초과 ${droppedByStops}건 제외)` : ""}`);

  const emptyDests = coverage.filter((x) => x.found === 0).map((x) => x.destination);
  if (emptyDests.length) {
    log(`  → 결과 없음: ${emptyDests.join(", ")}`);
  }

  // ───────────────── 2단계-b: 오픈조 만들어보기 ─────────────────
  // 이미 싸게 나온 도시 근처의 다른 도시로 나오는 일정을 시험합니다.
  // (전수조사가 아니라 '싼 곳 주변'만 봅니다 — 조합이 폭발하지 않게)
  const openJaw = [];
  if (provider.capabilities.openJaw) {
    const seeds = live
      .filter((c) => typeof c.total === "number")
      .sort((a, b) => a.total - b.total)
      .slice(0, 3);
    for (const seed of seeds) {
      const partners = findOpenJawPartners(seed.destIn, destinations, { limit: 2 });
      for (const p of partners) {
        const departureDate = seed.outbound?.departAt?.slice(0, 10);
        const returnDate = seed.inbound?.departAt?.slice(0, 10);
        if (!departureDate || !returnDate) continue;
        const r = await provider.searchLiveOpenJaw({
          origin: settings.origin, destIn: seed.destIn, destOut: p.iata,
          departureDate, returnDate, adults: settings.adults, cabin: settings.cabin, max: 2,
          maxStops: Math.max(maxStopsFor(seed.destIn, settings), maxStopsFor(p.iata, settings)),
        }).catch((e) => ({ ok: false, error: String(e), candidates: [] }));
        if (r.ok) {
          const limit = Math.max(maxStopsFor(seed.destIn, settings), maxStopsFor(p.iata, settings));
          for (const c of r.candidates.filter((x) => withinStops(x, limit))) {
            // 들어간 도시 -> 나오는 도시 육로 이동비를 붙입니다 (추정치)
            c.ground = estimateGround(seed.destIn, p.iata);
            openJaw.push(c);
          }
        }
      }
    }
  }
  if (openJaw.length) log(`  → 오픈조 후보 ${openJaw.length}건`);

  const liveAll = [...live, ...openJaw];
  history?.append(liveAll);
  report.stages.live = {
    found: live.length,
    openJaw: openJaw.length,
    maxStops: settings.maxStops,
    maxStopsByRegion: settings.maxStopsByRegion ?? {},
    droppedByStops,
    coverage,
    emptyDestinations: emptyDests,
  };

  // ───────────────── 실제 운임으로 다시 판정 ─────────────────
  // 실제 운임은 건수가 적으니, 넓게 훑은 결과까지 합쳐 비교군을 만듭니다.
  const liveCohorts = buildCohorts([...indicative, ...liveAll]);
  const liveScored = liveAll.map((c) => {
    const verdict = judgeDeal(c, { history, cohorts: liveCohorts, settings, historyBefore: scanStartedAt });
    return { candidate: c, verdict, value: scoreCandidate(c, verdict) };
  });

  const deduped = dedupe(liveScored).sort((a, b) => rankKey(b) - rankKey(a));
  report.stages.deduped = { count: deduped.length, from: liveScored.length };
  log(`  → 중복 정리 후 ${deduped.length}건`);

  // ───────────────── 3단계: 가격 확정 ─────────────────
  const toConfirm = provider.capabilities.confirm ? deduped.slice(0, settings.funnel.confirmTop) : [];
  if (!provider.capabilities.confirm) {
    report.warnings.push(`${provider.name} 은(는) 가격 확정을 지원하지 않습니다. 모든 후보가 '확인 필요'로 남습니다.`);
    log(`[3단계] 건너뜀 — ${provider.name} 은 가격 확정을 지원하지 않습니다`);
  } else {
    log(`[3단계] 상위 ${toConfirm.length}개의 총액·수하물·환불규정을 확정합니다`);
  }
  const finalItems = [];
  for (const item of toConfirm) {
    let confirmed;
    try {
      confirmed = await provider.confirmPrice(item.candidate);
    } catch (e) {
      item.candidate.notes.push(`가격 확정 중 오류: ${e.message}`);
      confirmed = item.candidate;
    }
    confirmed.ground = confirmed.ground ?? item.candidate.ground;
    const verdict = judgeDeal(confirmed, { history, cohorts: liveCohorts, settings, historyBefore: scanStartedAt });
    finalItems.push({
      candidate: confirmed,
      verdict,
      value: scoreCandidate(confirmed, verdict),
      signature: dealSignature(confirmed),
    });
  }
  // 확정하지 않은 나머지도 목록에는 남깁니다 (다만 '확정 특가'는 아님)
  for (const item of deduped.slice(toConfirm.length)) {
    finalItems.push({ ...item, signature: dealSignature(item.candidate) });
  }

  // ───────────────── 확정 특가 / 확인 필요 나누기 ─────────────────
  const deals = [];
  const needsReview = [];
  for (const item of finalItems) {
    const c = item.candidate;
    const isConfirmed = c.priceType === PRICE_TYPE.CONFIRMED;
    const hasConflict = c.fareRules?.conflict === true;
    const missing = c.unknown.filter((k) => ["total", "taxes"].includes(k));

    if (item.verdict.isDeal && isConfirmed && !hasConflict && !missing.length) {
      item.status = "confirmed_deal";
      deals.push(item);
    } else if (item.verdict.isDeal) {
      item.status = "needs_review";
      item.statusReason = hasConflict
        ? "화면마다 값이 달라 확인이 필요합니다"
        : !isConfirmed
          ? "총액·환불규정을 아직 확정하지 않았습니다"
          : `미확인 항목: ${missing.join(", ")}`;
      needsReview.push(item);
    } else {
      item.status = "watch";
      needsReview.push(item);
    }
  }

  // ───────────────── 알림 대상 고르기 ─────────────────
  const alerts = [];
  if (alertState) {
    for (const item of deals) {
      const decision = shouldAlert(item, alertState.data, settings);
      item.alertDecision = decision;
      if (decision.alert) {
        alerts.push(item);
        alertState.record(item.signature, { price: item.candidate.total, score: item.value.score });
      }
    }
  }

  report.stages.final = {
    confirmedDeals: deals.length,
    needsReview: needsReview.length,
    alerts: alerts.length,
  };
  report.providerStats = provider.stats ?? null;
  report.finishedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - t0) / 1000);

  log(`[완료] 확정 특가 ${deals.length}건 / 확인 필요 ${needsReview.length}건 / 알릴 것 ${alerts.length}건 (${report.elapsedSec}초)`);
  return { report, deals, needsReview, alerts };
}

/**
 * 참고가만 주는 공급자로 스캔을 끝냅니다.
 * 실제 조회를 못 했으므로 확정 특가는 하나도 만들지 않고,
 * 값이 싸 보이는 후보를 '확인 필요' 목록으로만 넘깁니다.
 */
function finishIndicativeOnly({ report, ranked, shortlist, settings, log, t0, provider }) {
  const merged = mergeSameFlight(ranked);
  const needsReview = [];
  for (const item of merged.slice(0, Math.max(settings.funnel.liveCheckTop, shortlist.length) * 3)) {
    item.signature = dealSignature(item.candidate);
    item.status = item.verdict.isDeal ? "needs_review" : "watch";
    if (item.verdict.isDeal) {
      item.statusReason = "참고가입니다. 실제 구매 가능 여부와 총액을 아직 확인하지 못했습니다.";
    }
    needsReview.push(item);
  }

  report.stages.live = { skipped: true, reason: `${provider.name} 은 참고가 전용`, mergedFrom: ranked.length };
  report.stages.final = { confirmedDeals: 0, needsReview: needsReview.length, alerts: 0 };
  report.providerStats = provider.stats ?? null;
  report.finishedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - t0) / 1000);

  log(`[완료] 확정 특가 0건 / 확인 필요 ${needsReview.length}건 (참고가 전용, ${report.elapsedSec}초)`);
  return { report, deals: [], needsReview, alerts: [] };
}

/**
 * 목적지·출발일·가격이 같은데 귀국일만 다른 후보들을 하나로 묶습니다.
 * (같은 비행기인데 "17일·18일·19일·20일" 로 네 줄이 되는 걸 막습니다)
 * 묶을 때는 체류가 가장 긴 쪽을 대표로 남기고, 고를 수 있는 범위를 적어 둡니다.
 */
function mergeSameFlight(items) {
  const groups = new Map();
  for (const item of items) {
    const c = item.candidate;
    const key = `${c.destIn}|${c.outbound?.departAt?.slice(0, 10)}|${c.total}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const out = [];
  for (const group of groups.values()) {
    // 체류가 긴 쪽이 여행 가치가 높으므로 그걸 대표로 삼습니다
    group.sort((a, b) => (b.candidate.tripDays ?? 0) - (a.candidate.tripDays ?? 0));
    const rep = group[0];
    if (group.length > 1) {
      const days = group.map((g) => g.candidate.tripDays).filter((d) => typeof d === "number");
      const min = Math.min(...days), max = Math.max(...days);
      rep.candidate.notes.push(`같은 가격으로 체류 ${min}~${max}일 선택 가능 (${group.length}가지)`);
      rep.tripDaysRange = [min, max];
      rep.mergedCount = group.length;
    }
    out.push(rep);
  }
  return out.sort((a, b) => rankKey(b) - rankKey(a));
}

/** 가는 편·오는 편 모두 정해진 경유 횟수 안에 드는지 확인합니다. */
function withinStops(c, maxStops) {
  if (typeof maxStops !== "number") return true;
  for (const leg of [c.outbound, c.inbound]) {
    if (leg && typeof leg.stops === "number" && leg.stops > maxStops) return false;
  }
  return true;
}

/** 순위 정하는 기준: 특가로 판정된 것을 먼저, 그다음 여행가치 점수 순 */
function rankKey(item) {
  return (item.verdict.isDeal ? 1000 : 0) + item.value.score;
}
