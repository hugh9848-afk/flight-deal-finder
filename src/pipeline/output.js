// 결과를 파일로 저장합니다.
// 공개 폴더(web/data)에는 API 키가 절대 들어가지 않게, 필요한 값만 골라 적습니다.
import fs from "node:fs";
import path from "node:path";

/** 화면에 보여줄 만큼만 추려 담습니다. */
function publicView(item) {
  const c = item.candidate;
  const legView = (leg) => leg && ({
    from: leg.from, to: leg.to,
    departAt: leg.departAt, arriveAt: leg.arriveAt,
    durationMin: leg.durationMin, stops: leg.stops,
    layovers: leg.layovers,
    segments: (leg.segments ?? []).map((s) => ({
      number: s.number, carrier: s.carrier, from: s.from, to: s.to,
      fromTerminal: s.fromTerminal, toTerminal: s.toTerminal,
      departAt: s.departAt, arriveAt: s.arriveAt,
      durationMin: s.durationMin, layoverMin: s.layoverMin, airportChange: s.airportChange,
    })),
  });

  return {
    id: c.id,
    signature: item.signature ?? null,
    status: item.status ?? null,
    statusReason: item.statusReason ?? null,
    source: c.source,
    priceType: c.priceType,
    fetchedAt: c.fetchedAt,
    priceValidUntil: c.priceValidUntil,
    currency: c.currency,
    total: c.total,
    base: c.base,
    taxes: c.taxes,
    totalTripCostKRW: item.value?.totalTripCostKRW ?? null,
    originOut: c.originOut, destIn: c.destIn, destOut: c.destOut,
    tripDays: c.tripDays, usableDays: item.value?.usableDays ?? null,
    tripDaysRange: item.tripDaysRange ?? null,
    mergedCount: item.mergedCount ?? null,
    openJaw: c.openJaw, separateTickets: c.separateTickets,
    selfTransfer: c.selfTransfer, airportChange: c.airportChange,
    seatsLeft: c.seatsLeft,
    baggage: c.baggage,
    fareRules: c.fareRules,
    ground: c.ground,
    outbound: legView(c.outbound),
    inbound: legView(c.inbound),
    verdict: item.verdict,
    score: item.value?.score ?? null,
    breakdown: item.value?.breakdown ?? null,
    warnings: item.value?.warnings ?? [],
    unknown: c.unknown,
    notes: c.notes,
    links: c.links,
  };
}

export function writeResults({ report, deals, needsReview }, { webDir, dataDir }) {
  fs.mkdirSync(webDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString(),
    report,
    deals: deals.map(publicView),
    needsReview: needsReview.map(publicView),
    disclaimer:
      "표시된 값은 조회 시점 기준입니다. priceType 이 confirmed 가 아닌 항목은 실제 구매가 보장되지 않습니다. " +
      "ground(도시 간 이동비)는 거리로 짐작한 추정치입니다.",
  };

  const webFile = path.join(webDir, "deals.json");
  fs.writeFileSync(webFile, JSON.stringify(payload, null, 2));

  const fullFile = path.join(dataDir, "last-scan.json");
  fs.writeFileSync(fullFile, JSON.stringify({ report, deals, needsReview }, null, 2));

  return { webFile, fullFile, dealCount: deals.length, reviewCount: needsReview.length };
}

/** 사람이 읽을 요약문(알림 문구로도 씁니다). */
export function renderSummary({ report, deals, needsReview, alerts = [] }) {
  const L = [];
  L.push(`✈️ 인천 출발 특가 스캔 결과 (${report.provider})`);
  L.push(`기간: ${report.window.departFrom} ~ ${report.window.departTo} 출발 · 목적지 ${report.destinationCount}곳`);
  L.push(`확정 특가 ${deals.length}건 / 확인 필요 ${needsReview.length}건 / 새 알림 ${alerts.length}건`);
  L.push("");

  if (!deals.length) {
    L.push("확정된 특가는 없습니다.");
  }
  for (const item of deals.slice(0, 8)) {
    const c = item.candidate;
    const d = item.verdict.discountPct;
    L.push(`── ${c.originOut} → ${c.destIn}${c.openJaw ? ` (귀국 ${c.destOut})` : ""} · ${c.tripDays}일`);
    L.push(`   ${won(c.total)} (항공료 ${won(c.base)} + 세금 ${won(c.taxes)})`);
    L.push(`   ${d !== null ? `평소보다 ${d}% 저렴` : "할인율 미확인"} · 신뢰도 ${kor(item.verdict.confidence)} · 여행가치 ${item.value.score}점`);
    L.push(`   출발 ${c.outbound?.departAt ?? "?"} · 이동 ${hm(c.outbound?.durationMin)} · 경유 ${c.outbound?.stops ?? "미확인"}회`);
    L.push(`   귀국 ${c.inbound?.departAt ?? "?"} · 이동 ${hm(c.inbound?.durationMin)} · 경유 ${c.inbound?.stops ?? "미확인"}회`);
    if (c.ground) L.push(`   ${c.ground.fromCity}→${c.ground.toCity} ${c.ground.mode} 약 ${won(c.ground.estCostKRW)} (추정)`);
    for (const w of item.value.warnings.slice(0, 3)) L.push(`   ⚠ ${w}`);
    L.push("");
  }

  const review = needsReview.filter((i) => i.status === "needs_review").slice(0, 5);
  if (review.length) {
    L.push("── 확인 필요 (특가 후보지만 확정하지 못함)");
    for (const item of review) {
      L.push(`   ${item.candidate.destIn} ${won(item.candidate.total)} — ${item.statusReason}`);
    }
  }
  return L.join("\n");
}

const won = (n) => (typeof n === "number" ? `${n.toLocaleString("ko-KR")}원` : "미확인");
const hm = (m) => (typeof m === "number" ? `${Math.floor(m / 60)}시간 ${m % 60}분` : "미확인");
const kor = (c) => ({ high: "높음", medium: "보통", low: "낮음", none: "없음" }[c] ?? c);
