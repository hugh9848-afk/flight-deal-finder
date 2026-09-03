// 가격 이력 창고. 한 줄에 한 건씩 적는 글자 파일(NDJSON)이라
// 서버나 데이터베이스 없이도 깃허브에 그대로 쌓아둘 수 있습니다.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = new URL("../../data/history/", import.meta.url).pathname;

/** 체류 일수를 세 칸(짧게/보통/길게)으로 묶습니다. */
export function tripBucket(days) {
  if (days === null || days === undefined) return "unknown";
  if (days <= 13) return "10-13";
  if (days <= 16) return "14-16";
  return "17-20";
}

/**
 * 이력을 찾을 때 쓰는 열쇠글.
 * 같은 노선 + 같은 달 + 비슷한 체류기간끼리만 비교합니다.
 * (7월 파리행과 1월 파리행을 같이 비교하면 안 되니까요)
 */
export function historyKey({ origin, destination, departureDate, tripDays }) {
  const month = String(departureDate ?? "").slice(5, 7) || "??";
  return `${origin}-${destination}|m${month}|${tripBucket(tripDays)}`;
}

export class PriceHistory {
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = null;
  }

  /** 이번 달 파일 이름 (예: 2026-09.ndjson) */
  #fileFor(date = new Date()) {
    return path.join(this.dir, `${date.toISOString().slice(0, 7)}.ndjson`);
  }

  /** 후보들을 공책에 적습니다. 값이 없는 건 적지 않습니다. */
  append(candidates) {
    const rows = [];
    for (const c of candidates) {
      if (typeof c.total !== "number") continue;
      const departureDate = c.outbound?.departAt?.slice(0, 10) ?? null;
      if (!departureDate || !c.destIn) continue;
      rows.push({
        ts: c.fetchedAt ?? new Date().toISOString(),
        key: historyKey({ origin: c.originOut, destination: c.destIn, departureDate, tripDays: c.tripDays }),
        origin: c.originOut,
        destination: c.destIn,
        departureDate,
        tripDays: c.tripDays,
        total: c.total,
        currency: c.currency,
        priceType: c.priceType,
        source: c.source,
      });
    }
    if (!rows.length) return 0;
    fs.appendFileSync(this.#fileFor(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    this.cache = null; // 새로 적었으니 기억해 둔 건 버립니다
    return rows.length;
  }

  /** 공책 전체를 읽어옵니다. (한 번 읽으면 기억해 둡니다) */
  load() {
    if (this.cache) return this.cache;
    const rows = [];
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".ndjson")).sort()) {
      const text = fs.readFileSync(path.join(this.dir, f), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* 깨진 줄은 건너뜁니다 */ }
      }
    }
    this.cache = rows;
    return rows;
  }

  /**
   * "이 노선은 평소 얼마였나?"에 답합니다.
   * @returns {{count, median, p25, min, max}|null}  기록이 없으면 null
   */
  stats(key, { maxAgeDays = 400, before = null } = {}) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    // before 를 주면 그 시각 이전 기록만 봅니다.
    // 이번 스캔에서 방금 적은 값을 판정 근거로 쓰면 자기 자신과 비교하게 되니까요.
    const until = before ? Date.parse(before) : Infinity;
    const values = this.load()
      .filter((r) => r.key === key && Date.parse(r.ts) >= cutoff && Date.parse(r.ts) < until)
      .map((r) => r.total)
      .sort((a, b) => a - b);
    if (!values.length) return null;
    return {
      count: values.length,
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      min: values[0],
      max: values.at(-1),
    };
  }

  /** 같은 노선 기록을 전부 (달 구분 없이) 봅니다. 기록이 적을 때 예비로 씁니다. */
  routeStats(origin, destination, { maxAgeDays = 400, before = null } = {}) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const until = before ? Date.parse(before) : Infinity;
    const values = this.load()
      .filter((r) => r.origin === origin && r.destination === destination
                  && Date.parse(r.ts) >= cutoff && Date.parse(r.ts) < until)
      .map((r) => r.total)
      .sort((a, b) => a - b);
    if (!values.length) return null;
    return { count: values.length, median: quantile(values, 0.5), p25: quantile(values, 0.25), min: values[0], max: values.at(-1) };
  }
}

/** 정렬된 숫자 목록에서 가운데 값 등을 뽑습니다. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}
