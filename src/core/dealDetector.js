// "이 값이 평소보다 싼가?"를 판단합니다.
//
// 문제: 이력은 첫날 0건입니다. 그러면 몇 달 동안 아무 판정도 못 합니다.
// 해결: 두 가지 방법을 섞어 씁니다.
//   방법 A (이력) : 같은 노선·같은 달·비슷한 체류기간의 평소 가격과 비교  → 정확
//   방법 B (동기간): 이력이 없으면, 같은 스캔 안의 비슷한 조건들끼리 줄 세우기 → 첫날부터 가능
// 방법 B 로 판정한 건 신뢰도를 '낮음'으로 표시해 알림 문구에서 구분합니다.
import { SETTINGS } from "../config/settings.js";
import { historyKey, tripBucket } from "../store/history.js";
import { findAirport } from "../config/destinations.js";

const MIN_HISTORY_EXACT = 8;  // 이 정도는 쌓여야 '평소 가격'이라 부를 수 있습니다
const MIN_HISTORY_ROUTE = 5;
const MIN_COHORT = 5;         // 줄 세우려면 최소 이만큼 친구가 필요합니다

/**
 * 같은 스캔 결과를 '비슷한 것끼리' 묶습니다.
 * 한 칸에 표본이 적을 수 있으니 세 단계로 나눠 담습니다.
 *   좁게: 지역+월+체류기간  /  보통: 지역+체류기간  /  넓게: 지역
 * 좁은 칸에 친구가 부족하면 자동으로 넓은 칸을 봅니다.
 * @returns Map<string, number[]>  묶음이름 -> 가격들
 */
export function buildCohorts(candidates) {
  const groups = new Map();
  const put = (key, v) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  };
  for (const c of candidates) {
    if (typeof c.total !== "number") continue;
    for (const key of cohortKeys(c)) put(key, c.total);
  }
  return groups;
}

/** 좁은 칸부터 넓은 칸까지 이름을 순서대로 만들어 줍니다. */
export function cohortKeys(c) {
  const air = findAirport(c.destIn);
  if (!air) return [];
  const month = c.outbound?.departAt?.slice(5, 7) ?? "??";
  const bucket = tripBucket(c.tripDays);
  return [
    `${air.region}|m${month}|${bucket}`,
    `${air.region}|${bucket}`,
    `${air.region}`,
  ];
}

/** 가장 좁으면서도 표본이 충분한 칸을 고릅니다. */
export function cohortKey(c) {
  return cohortKeys(c)[0] ?? null;
}

/**
 * 후보 하나를 판정합니다.
 * @returns {{isDeal, method, confidence, discountPct, zScore, baseline, sampleSize, reason}}
 */
export function judgeDeal(candidate, { history, cohorts, settings = SETTINGS, historyBefore = null } = {}) {
  const total = candidate.total;
  const departureDate = candidate.outbound?.departAt?.slice(0, 10) ?? null;

  if (typeof total !== "number") {
    return none("가격을 확인하지 못했습니다");
  }
  if (total > settings.deal.maxTotalKRW) {
    return { ...none(`상한(${settings.deal.maxTotalKRW.toLocaleString()}원)보다 비쌉니다`), tooExpensive: true };
  }

  // --- 방법 A: 정확히 같은 조건의 이력 ---
  if (history && departureDate) {
    const key = historyKey({
      origin: candidate.originOut, destination: candidate.destIn, departureDate, tripDays: candidate.tripDays,
    });
    const s = history.stats(key, { before: historyBefore });
    if (s && s.count >= MIN_HISTORY_EXACT) {
      return fromBaseline(total, s.median, s.count, "history", settings,
        s.count >= 20 ? "high" : "medium",
        `같은 노선·${departureDate.slice(5, 7)}월·${tripBucket(candidate.tripDays)}일 일정 ${s.count}건의 평소값 ${fmt(s.median)}원 대비`);
    }

    // --- 방법 A': 달 구분 없이 같은 노선 ---
    const r = history.routeStats(candidate.originOut, candidate.destIn, { before: historyBefore });
    if (r && r.count >= MIN_HISTORY_ROUTE) {
      return fromBaseline(total, r.median, r.count, "history-route", settings, "medium",
        `같은 노선 전체 ${r.count}건의 평소값 ${fmt(r.median)}원 대비 (계절 구분 없음)`);
    }
  }

  // --- 방법 B: 이력이 없으니 같은 스캔 안에서 줄 세우기 ---
  // 좁은 칸(지역+월+기간)부터 보고, 친구가 5명 미만이면 한 단계씩 넓힙니다.
  if (cohorts) {
    const levels = ["지역·월·기간", "지역·기간", "지역"];
    const keys = cohortKeys(candidate);
    for (let i = 0; i < keys.length; i++) {
      const peers = cohorts.get(keys[i]);
      if (!peers || peers.length < MIN_COHORT) continue;
      const { mean, sd } = meanSd(peers);
      const z = sd > 0 ? (mean - total) / sd : 0;  // 평균보다 얼마나 아래인가
      return {
        isDeal: z >= settings.deal.minZScore,
        method: "cohort",
        cohortLevel: levels[i],
        confidence: "low",
        discountPct: mean > 0 ? round1(((mean - total) / mean) * 100) : null,
        zScore: round1(z),
        baseline: Math.round(mean),
        sampleSize: peers.length,
        reason: `가격 이력이 아직 없어 같은 ${levels[i]} 후보 ${peers.length}개와 비교 (평균 ${fmt(Math.round(mean))}원)`,
      };
    }
  }

  return none("비교할 자료가 아직 없습니다 (이력·비교군 모두 부족)");
}

/** 평소값(baseline)과 비교해 결과를 만듭니다. */
function fromBaseline(total, baseline, sampleSize, method, settings, confidence, reason) {
  const discountPct = baseline > 0 ? round1(((baseline - total) / baseline) * 100) : null;
  return {
    isDeal: discountPct !== null && discountPct >= settings.deal.minDiscountPct,
    method,
    confidence,
    discountPct,
    zScore: null,
    baseline,
    sampleSize,
    reason,
  };
}

function none(reason) {
  return { isDeal: false, method: "none", confidence: "none", discountPct: null, zScore: null, baseline: null, sampleSize: 0, reason };
}

function meanSd(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("ko-KR") : "?");
