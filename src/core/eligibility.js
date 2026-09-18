import { tripDaysBetween } from "./dateCombos.js";
import { SETTINGS } from "../config/settings.js";

/** 검색 조건과 응답에서 확인한 사실을 구분합니다. */
export function checkEligibility(c, { settings, departFrom, departTo }) {
  const first = c.outbound?.segments?.[0];
  const last = c.inbound?.segments?.at(-1);
  if (first?.from) c.departureAirportVerified = first.from === settings.origin;
  if (last?.to) c.returnAirportVerified = last.to === settings.origin;
  if (c.departureAirportVerified && c.returnAirportVerified && last?.arriveAt) {
    c.tripDays = tripDaysBetween(first?.departAt?.slice(0, 10), last.arriveAt.slice(0, 10));
    c.tripDaysBasis = "icn_confirmed";
  }
  const departure = c.outbound?.departAt?.slice(0, 10);
  const wrongAirport = (first?.from && first.from !== settings.origin)
    || (last?.to && last.to !== settings.origin) || c.originOut === "GMP";
  const inWindow = departure && departure >= departFrom && departure <= departTo;
  c.outOfRange = typeof c.tripDays === "number"
    && (c.tripDays < settings.minTripDays || c.tripDays > settings.maxTripDays);
  return !wrongAirport && Boolean(inWindow);
}

/**
 * 우리가 직접 모은 기록이 '알릴 만큼' 두꺼운지 봅니다.
 *
 * 건수만 보면 안 됩니다. 하루에 몰아서 열 번 본 것은 사실상 하루치이기 때문입니다.
 * 그래서 **몇 건을 봤나** 와 **서로 다른 며칠에 걸쳐 봤나** 를 함께 따집니다.
 * 둘 중 하나라도 모르면(null) 모자란 것으로 봅니다 — 모르는 것을 괜찮다고 치지 않습니다.
 */
export function hasEnoughEvidence(verdict, settings = SETTINGS) {
  const need = settings.alertEvidence ?? { minSampleSize: 12, minDistinctDays: 3 };
  const samples = verdict.sampleSize;
  const days = verdict.distinctDays;
  if (!Number.isFinite(samples) || !Number.isFinite(days)) return false;
  return samples >= need.minSampleSize && days >= need.minDistinctDays;
}

export function canAlert(item, settings = SETTINGS) {
  const c = item.candidate;
  const v = item.verdict;
  if (!v.isDeal || c.outOfRange || c.fareRules?.conflict) return false;
  if (c.departureAirportVerified !== true || c.returnAirportVerified !== true
      || c.tripDaysBasis !== "icn_confirmed" || !Number.isFinite(c.tripDays)) return false;

  // 판매 화면까지 확인한 후보는 기존 확정 알림 정책을 유지합니다.
  if (c.priceType === "confirmed") return true;

  // 우리 기록만으로 '싸다'고 말하는 경우에는 근거가 얇으면 알리지 않습니다.
  // (구글이 준 기준가는 우리 기록이 아니므로 여기 걸리지 않습니다)
  if (v.basis === "self_observed" && !hasEnoughEvidence(v, settings)) return false;

  return ["medium", "high"].includes(v.confidence)
    || (v.basis === "app_computed_from_google_history" && v.sampleSize >= 5);
}

/** 유효한 일정과 노선 가격 비교의 할인율을 우선하고 여행가치는 동률에 씁니다. */
export function compareDeals(a, b) {
  const discount = (x) => x.verdict.basis !== "same_scan" && Number.isFinite(x.verdict.discountPct)
    ? x.verdict.discountPct : -Infinity;
  return Number(Boolean(a.candidate.outOfRange)) - Number(Boolean(b.candidate.outOfRange))
    || (discount(b) > discount(a) ? 1 : discount(b) < discount(a) ? -1 : 0)
    || Number(b.verdict.isDeal) - Number(a.verdict.isDeal)
    || b.value.score - a.value.score;
}
