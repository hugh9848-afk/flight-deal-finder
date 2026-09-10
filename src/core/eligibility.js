import { tripDaysBetween } from "./dateCombos.js";

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

export function canAlert(item) {
  const c = item.candidate;
  if (!item.verdict.isDeal || c.outOfRange || c.fareRules?.conflict) return false;
  if (c.departureAirportVerified !== true || c.returnAirportVerified !== true
      || c.tripDaysBasis !== "icn_confirmed" || !Number.isFinite(c.tripDays)) return false;
  // 판매 화면까지 확인한 후보는 기존 확정 알림 정책을 유지합니다.
  return c.priceType === "confirmed" || ["medium", "high"].includes(item.verdict.confidence)
    || (item.verdict.basis === "app_computed_from_google_history" && item.verdict.sampleSize >= 5);
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
