// 출발일과 귀국일 짝을 자동으로 만들어 줍니다.
// 예: 30일 뒤부터 300일 뒤까지, 7일 간격으로 출발 / 체류 10~20일을 2일 간격으로.
import { SETTINGS } from "../config/settings.js";

/**
 * 날짜를 'YYYY-MM-DD' 글자로 바꿉니다. **한국시간 기준**입니다.
 * 우리가 인천에서 출발하므로 한국 달력을 봐야 합니다.
 * (세계 표준시로 계산하면 밤 시간대에 하루가 어긋납니다)
 */
export function ymd(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * 달력으로 몇 달 뒤를 계산합니다. 월말은 그 달의 마지막 날로 맞춥니다.
 * 예) 8월 31일에서 6개월 뒤 = 2월 28일 (2월엔 31일이 없으니까요)
 */
export function addMonths(date, months) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
  // 옮겨간 달의 마지막 날이 며칠인지 먼저 알아냅니다
  const lastDay = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m + months, Math.min(d, lastDay)));
  return new Date(target.getTime() - 9 * 60 * 60 * 1000);
}

/**
 * 여행이 며칠짜리인지 셉니다.
 * **떠나는 날을 1일째로 세어 돌아오는 날까지 포함한 달력 일수**입니다.
 * 예) 10월 11일 출발, 10월 15일 귀국 → 11·12·13·14·15 = 5일
 */
export function tripDaysBetween(departYmd, returnYmd) {
  if (!departYmd || !returnYmd) return null;
  const a = Date.parse(departYmd + "T00:00:00Z");
  const b = Date.parse(returnYmd + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const days = Math.round((b - a) / 86400000) + 1;   // +1 = 떠나는 날도 하루로 셈
  return days > 0 ? days : null;
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
  // 마지막 출발 가능일 = 오늘부터 6개월 뒤 (달력 기준)
  const lastDepart = s.searchWindow.toMonthsAhead
    ? ymd(addMonths(today, s.searchWindow.toMonthsAhead))
    : ymd(addDays(today, s.searchWindow.toDaysAhead ?? 300));

  for (let ahead = s.searchWindow.fromDaysAhead; ; ahead += s.departStepDays) {
    const depart = addDays(today, ahead);
    if (ymd(depart) > lastDepart) break;

    // 안쪽 반복: 그 출발일에 대해 체류 10일, 12일, 14일... 을 붙여봅니다.
    for (let days = s.minTripDays; days <= s.maxTripDays; days += s.tripDaysStep) {
      // 5일짜리면 떠난 날 + 4일 뒤가 돌아오는 날입니다 (떠난 날도 하루로 세므로)
      combos.push({
        departDate: ymd(depart),
        returnDate: ymd(addDays(depart, days - 1)),
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
