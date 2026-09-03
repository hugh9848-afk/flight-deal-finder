// 같은 특가를 여러 번 알리지 않게 막는 문지기.
//
// 1) 노선·주차·항공사·가격대가 비슷하면 '같은 특가'로 묶고 제일 좋은 것만 남깁니다.
// 2) 한 번 알린 특가는, 값이 의미 있게 더 내려갔을 때만 다시 알립니다.
import { SETTINGS } from "../config/settings.js";

/**
 * 몇 년 몇 번째 주인지 (같은 주 출발이면 사실상 같은 일정으로 봅니다).
 * 국제 규칙(ISO 8601): '그 주의 목요일이 속한 해'가 그 주의 연도이고,
 * 1주차는 그 해의 첫 목요일이 있는 주입니다.
 */
export function isoWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  // 1) 이 날짜가 속한 주의 '목요일'로 옮깁니다. (월=0 … 일=6)
  const dayIdx = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIdx + 3);
  const thursday = d.getTime();
  const year = d.getUTCFullYear();

  // 2) 그 해의 '첫 목요일'을 찾습니다.
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const shift = (4 - jan1.getUTCDay() + 7) % 7; // 1월 1일에서 목요일까지 며칠?
  const firstThursday = Date.UTC(year, 0, 1 + shift);

  // 3) 두 목요일 사이가 몇 주 떨어졌는지 세면 그게 주차입니다.
  const week = 1 + Math.round((thursday - firstThursday) / 604800000);
  return `${year}W${String(week).padStart(2, "0")}`;
}

/** '같은 특가'인지 알아보는 지문. 가격은 10만원 단위로 뭉갭니다. */
export function dealSignature(c) {
  const week = c.outbound?.departAt ? isoWeek(c.outbound.departAt.slice(0, 10)) : "?";
  const carriers = [
    ...new Set((c.outbound?.segments ?? []).map((s) => s.carrier)),
  ].sort().join(",") || "?";
  const priceBucket = typeof c.total === "number" ? Math.round(c.total / 100000) : "?";
  return `${c.originOut}>${c.destIn}>${c.destOut ?? c.destIn}|${week}|${c.tripDays ?? "?"}d|${carriers}|${priceBucket}`;
}

/**
 * 비슷한 후보들을 묶고, 묶음마다 점수가 제일 높은 하나만 남깁니다.
 * @param {Array<{candidate, verdict, value}>} scored
 */
export function dedupe(scored) {
  const best = new Map();
  for (const item of scored) {
    const sig = dealSignature(item.candidate);
    const prev = best.get(sig);
    if (!prev || item.value.score > prev.value.score) {
      best.set(sig, { ...item, signature: sig, duplicatesMerged: (prev?.duplicatesMerged ?? -1) + 1 });
    } else {
      prev.duplicatesMerged = (prev.duplicatesMerged ?? 0) + 1;
    }
  }
  return [...best.values()];
}

/**
 * 이 특가를 지금 알려도 되는지 판단합니다.
 * @param {object} item      dedupe 를 거친 후보
 * @param {object} state     이전에 알린 기록 { [signature]: {price, at, score} }
 * @returns {{alert:boolean, kind:'new'|'cheaper'|'skip', reason:string}}
 */
export function shouldAlert(item, state, settings = SETTINGS) {
  const sig = item.signature ?? dealSignature(item.candidate);
  const prev = state[sig];
  const price = item.candidate.total;

  if (!prev) return { alert: true, kind: "new", reason: "처음 발견한 특가입니다" };

  const daysSince = (Date.now() - Date.parse(prev.at)) / 86400000;
  if (typeof price !== "number" || typeof prev.price !== "number") {
    return { alert: false, kind: "skip", reason: "가격을 비교할 수 없습니다" };
  }

  const dropPct = ((prev.price - price) / prev.price) * 100;
  if (dropPct >= settings.renotify.minPriceDropPct) {
    return {
      alert: true, kind: "cheaper",
      reason: `이전 알림(${prev.price.toLocaleString()}원)보다 ${dropPct.toFixed(1)}% 더 내려갔습니다`,
    };
  }
  if (daysSince < settings.renotify.cooldownDays) {
    return { alert: false, kind: "skip", reason: `${daysSince.toFixed(1)}일 전에 이미 알렸습니다` };
  }
  return { alert: false, kind: "skip", reason: `가격 변화가 ${dropPct.toFixed(1)}% 로 크지 않습니다` };
}
