// 결과를 파일로 저장합니다.
// 공개 폴더(web/data)에는 API 키가 절대 들어가지 않게, 필요한 값만 골라 적습니다.
import fs from "node:fs";
import path from "node:path";
import { findAirport } from "../config/destinations.js";

// 출발지 이름 (목적지 표에는 없으므로 따로 적어둡니다)
const ORIGIN_NAMES = { ICN: "인천", GMP: "김포", SEL: "서울" };

/** 공항·도시 코드를 사람이 읽는 이름으로 바꿉니다. 모르면 null. */
function placeName(code) {
  if (!code) return null;
  if (ORIGIN_NAMES[code]) return { city: ORIGIN_NAMES[code], country: "대한민국" };
  const a = findAirport(code);
  return a ? { city: a.city, country: a.country } : null;
}

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
    region: findAirport(c.destIn)?.region ?? null,
    // 화면에 보여줄 한글 이름 (코드만 보면 어딘지 모르니까요)
    originName: placeName(c.originOut),
    destInName: placeName(c.destIn),
    destOutName: placeName(c.destOut),
    tripDays: c.tripDays, usableDays: item.value?.usableDays ?? null,
    tripDaysBasis: c.tripDaysBasis ?? null,
    arrivalTimeBasis: c.arrivalTimeBasis ?? null,
    departureAirportVerified: c.departureAirportVerified ?? null,
    returnAirportVerified: c.returnAirportVerified ?? null,
    outOfRange: c.outOfRange === true,
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
    providerBaseline: c.providerBaseline ?? null,
    providerRange: c.providerRange ?? null,
    searchPriceLevel: c.searchPriceLevel ?? null,
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
  const reviewCandidates = needsReview.filter((i) => i.status === "needs_review");
  const watch = needsReview.filter((i) => i.status === "watch");
  L.push(`✈️ 인천 출발 특가 스캔 결과 (${report.provider})`);
  L.push(`기간: ${report.window.departFrom} ~ ${report.window.departTo} 출발 · 목적지 ${report.destinationCount}곳`);
  L.push(`확정 특가 ${deals.length}건 / 확인 필요 특가 후보 ${reviewCandidates.length}건 / 관찰 ${watch.length}건 / 새 알림 ${alerts.length}건`);

  // 알림이 0건일 때, '특가가 없어서'인지 '확인할 수단이 없어서'인지 구분해 줍니다.
  // 이걸 안 적으면 조용한 것을 "좋은 표가 없다"로 오해하게 됩니다.
  const reviewVerified = reviewCandidates.filter((i) => i.candidate?.returnAirportVerified === true).length;
  if (!alerts.length && reviewCandidates.length && reviewVerified === 0) {
    // 이번 회차에 상세 조회를 **한 번이라도** 했는지 봅니다.
    // 했는데도 특가 후보가 안 뽑힌 것과, 아예 못 한 것은 원인이 다릅니다.
    // 이걸 구분하지 않으면 멀쩡한 예산·키를 확인하라고 엉뚱한 데로 보내게 됩니다.
    const all = [...deals, ...needsReview];
    const detailed = all.filter((i) => i.candidate?.priceType === "live").length;
    L.push("");
    L.push("ℹ️ 알림이 없는 이유: 특가 후보 중 귀국편이 인천에 내리는지 확인된 후보가 0건입니다.");
    L.push("   (알림은 출국·귀국 공항이 모두 인천으로 확인된 후보에만 보냅니다)");
    if (detailed) {
      L.push(`   이번 회차에 상세 조회는 ${detailed}건 했지만, 위 특가 후보들은 그 대상에 뽑히지 않았습니다.`);
      L.push("   (특가 후보는 아직 참고가입니다. 실제로 조회하면 값이 달라질 수 있습니다)");
    } else {
      L.push("   이번 회차에는 상세 조회를 한 건도 하지 못했습니다.");
      L.push("   상세 조회 예산이 남아 있는지, SerpApi 키가 설정돼 있는지 확인하세요.");
    }
  }
  L.push("");

  if (!deals.length) {
    L.push("확정된 특가는 없습니다.");
  }
  for (const item of deals.slice(0, 8)) {
    const c = item.candidate;
    const d = discountText(item.verdict);
    L.push(`── ${c.originOut} → ${c.destIn}${c.openJaw ? ` (귀국 ${c.destOut})` : ""} · ${c.tripDays}일`);
    L.push(`   ${won(c.total)} (항공료 ${won(c.base)} + 세금 ${won(c.taxes)})`);
    L.push(`   ${d} · 기준 ${basisKor(item.verdict.basis)} · 신뢰도 ${kor(item.verdict.confidence)} · 여행가치 ${item.value.score}점`);
    L.push(`   출발 ${c.outbound?.departAt ?? "?"} · 이동 ${hm(c.outbound?.durationMin)} · 경유 ${c.outbound?.stops ?? "미확인"}회`);
    L.push(`   귀국 ${c.inbound?.departAt ?? "?"} · 이동 ${hm(c.inbound?.durationMin)} · 경유 ${c.inbound?.stops ?? "미확인"}회`);
    if (c.ground) L.push(`   ${c.ground.fromCity}→${c.ground.toCity} ${c.ground.mode} 약 ${won(c.ground.estCostKRW)} (추정)`);
    for (const w of item.value.warnings.slice(0, 3)) L.push(`   ⚠ ${w}`);
    L.push("");
  }

  const review = reviewCandidates.toSorted(compareReviewCandidates).slice(0, 15);
  if (review.length) {
    // 아직 실제로 조회하지 않은 참고가는 **할인율도** 못 믿습니다.
    // 실측에서 참고가 40% 짜리가 실제 조회하면 11% 대로 내려앉았습니다.
    // 전부 참고가면 머리에 한 번만 적고, 섞여 있을 때만 줄마다 표시합니다.
    const allRough = review.length > 0 && review.every((i) => isRough(i.candidate));
    L.push(review.length < reviewCandidates.length
      ? `── 확인 필요 특가 후보 ${reviewCandidates.length}건 중 상위 ${review.length}건 (할인율 순)`
      : `── 확인 필요 특가 후보 ${reviewCandidates.length}건 (할인율 순)`);
    if (allRough) L.push("   ⚠ 아래는 모두 참고가입니다. 실제로 조회하면 가격도 할인율도 달라집니다.");
    for (const item of review) {
      const rough = isRough(item.candidate) && !allRough
        ? " · ⚠ 참고가" : "";
      L.push(`   ${item.candidate.destIn} ${won(item.candidate.total)} · ${discountText(item.verdict)} · 기준 ${basisKor(item.verdict.basis)}${rough} — ${item.statusReason}`);
    }
  }
  return L.join("\n");
}

function compareReviewCandidates(a, b) {
  const aSameScan = a.verdict?.basis === "same_scan";
  const bSameScan = b.verdict?.basis === "same_scan";
  if (aSameScan !== bSameScan) return aSameScan ? 1 : -1;

  const aDiscount = a.verdict?.discountPct;
  const bDiscount = b.verdict?.discountPct;
  const aHasDiscount = typeof aDiscount === "number";
  const bHasDiscount = typeof bDiscount === "number";
  if (aHasDiscount !== bHasDiscount) return aHasDiscount ? -1 : 1;
  if (aHasDiscount && aDiscount !== bDiscount) return bDiscount - aDiscount;

  return (a.candidate?.total ?? Infinity) - (b.candidate?.total ?? Infinity);
}

/**
 * 할인율을 사람 말로 옮깁니다.
 *
 * **무엇과 견준 값인지에 따라 말이 달라집니다.**
 * `same_scan` 은 "같은 스캔에 함께 걸린 다른 후보들"과 견준 것뿐이라,
 * 이걸 "평소보다 싸다"고 쓰면 **거짓말**이 됩니다.
 * 그 노선의 평소 가격은 아직 모르는 상태입니다.
 */
/** 아직 실제로 조회하지 않은 값인가 (참고가인가) */
const isRough = (c) => c?.priceType !== "live" && c?.priceType !== "confirmed";

const discountText = (verdict) => {
  if (typeof verdict?.discountPct !== "number") return "할인율 미확인";
  return verdict.basis === "same_scan"
    ? `같은 스캔의 다른 후보보다 ${verdict.discountPct}% 저렴 (평소 가격은 아직 모름)`
    : `평소보다 ${verdict.discountPct}% 저렴`;
};
const basisKor = (basis) => ({
  google_deals_reported: "구글 제공 할인율",
  app_computed_from_google_history: "구글 이력 기반 계산",
  self_observed: "자체 관측 대비",
  same_scan: "동일 스캔 내 비교",
}[basis] ?? "판정 기준 미확인");
const won = (n) => (typeof n === "number" ? `${n.toLocaleString("ko-KR")}원` : "미확인");
const hm = (m) => (typeof m === "number" ? `${Math.floor(m / 60)}시간 ${m % 60}분` : "미확인");
const kor = (c) => ({ high: "높음", medium: "보통", low: "낮음", none: "없음" }[c] ?? c);
