// 출발일과 귀국일 짝을 자동으로 만들어 줍니다.
// 예: 30일 뒤부터 300일 뒤까지, 7일 간격으로 출발 / 체류 10~20일을 2일 간격으로.
import { SETTINGS } from "../config/settings.js";

/** 날짜를 'YYYY-MM-DD' 글자로 바꿉니다. */
export function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/** 기준일에 며칠을 더한 날짜를 돌려줍니다. */
export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * 날짜 짝 목록을 만듭니다.
 * 반환: [{ departDate, returnDate, tripDays }, ...]
 */
export function buildDateCombos(opts = {}) {
  const s = { ...SETTINGS, ...opts };
  const today = opts.today ? new Date(opts.today) : new Date();
  const combos = [];

  // 바깥 반복: 출발일을 정해진 간격으로 하나씩 옮겨갑니다.
  for (
    let ahead = s.searchWindow.fromDaysAhead;
    ahead <= s.searchWindow.toDaysAhead;
    ahead += s.departStepDays
  ) {
    const depart = addDays(today, ahead);

    // 안쪽 반복: 그 출발일에 대해 체류 10일, 12일, 14일... 을 붙여봅니다.
    for (let days = s.minTripDays; days <= s.maxTripDays; days += s.tripDaysStep) {
      combos.push({
        departDate: ymd(depart),
        returnDate: ymd(addDays(depart, days)),
        tripDays: days,
      });
    }
  }
  return combos;
}

/** 만들어질 조합이 몇 개인지 미리 세어봅니다. (호출량 가늠용) */
export function countCombos(opts = {}) {
  return buildDateCombos(opts).length;
}
