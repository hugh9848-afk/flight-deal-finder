// 가격 이력 창고. 한 줄에 한 건씩 적는 글자 파일(NDJSON)이라
// 서버나 데이터베이스 없이도 깃허브에 그대로 쌓아둘 수 있습니다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 한글 폴더명 때문에 pathname 을 쓰면 경로가 깨집니다 (%ED%95%AD…)
const DEFAULT_DIR = fileURLToPath(new URL("../../data/history/", import.meta.url));

/**
 * 여행 일수를 비슷한 것끼리 묶습니다.
 *
 * 5일 여행과 13일 여행은 성격이 완전히 다른데 예전엔 같은 칸이었습니다.
 * 여행 기간이 5~20일로 넓어졌으므로 네 칸으로 나눕니다.
 */
export function tripBucket(days) {
  if (days === null || days === undefined) return "unknown";
  if (days <= 7) return "5-7";     // 짧은 여행
  if (days <= 10) return "8-10";   // 일주일 남짓
  if (days <= 14) return "11-14";  // 두 주
  return "15-20";                  // 긴 여행
}

// 이력 형식 번호. 여행 일수를 세는 방법과 묶음이 바뀌면 올립니다.
// 옛 기록은 지우지 않되, 새 판정에는 섞지 않습니다.
export const HISTORY_VERSION = 3;

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

  /**
   * 이번 스캔이 쓸 파일 이름.
   *
   * 스캔마다 새 파일을 만듭니다 (예: 2026-09-03T0424-a3f1.ndjson).
   * 한 파일에 여러 곳이 번갈아 쓰면 깃에서 충돌이 나기 때문입니다.
   * 내 맥에서 돌린 것과 자동 실행이 돌린 것이 각자 낱장에 쓰고,
   * 읽을 때는 폴더에 있는 낱장을 전부 모아 읽습니다.
   */
  #fileFor(date = new Date()) {
    if (!this.runFile) {
      const stamp = date.toISOString().slice(0, 16).replace(/[:]/g, "").replace("T", "T");
      const rand = Math.random().toString(16).slice(2, 6);
      this.runFile = path.join(this.dir, `${stamp}-${rand}.ndjson`);
    }
    return this.runFile;
  }

  /**
   * 후보들을 공책에 적습니다.
   * 값이 없는 건 적지 않고, 연습용 가짜(mock) 자료는 절대 적지 않습니다.
   * 가짜 가격이 섞이면 '평소 가격' 판단이 통째로 망가집니다.
   */
  append(candidates) {
    const rows = [];
    for (const c of candidates) {
      if (typeof c.total !== "number") continue;
      if (c.source === "mock") continue;   // 연습용 자료는 이력에 남기지 않습니다
      const departureDate = c.outbound?.departAt?.slice(0, 10) ?? null;
      if (!departureDate || !c.destIn) continue;
      rows.push({
        v: HISTORY_VERSION,                      // 이력 형식 번호 (옛 기록과 섞이지 않게)
        ts: c.fetchedAt ?? new Date().toISOString(),   // 우리가 받아온 시각
        // 공급자가 '이 가격을 실제로 본 시각'. 같은 캐시를 다시 받아도 이 값은 같습니다.
        observedAt: c.raw?.observedAt ?? null,
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
  /**
   * 같은 관측을 여러 번 세지 않도록 추립니다.
   *
   * 우리는 3일마다 훑는데 공급자 캐시는 2~7일 남아 있어서,
   * **같은 가격을 여러 번 다시 받게 됩니다.**
   * 그걸 다 세면 "여러 번 확인했다"가 아니라 "같은 걸 여러 번 봤다"인데도
   * 표본이 많은 것처럼 보여 '평소 가격' 판단이 망가집니다.
   *
   * 그래서 (노선·날짜·가격·공급자가 본 시각) 이 같으면 한 번으로 셉니다.
   */
  #distinct(rows) {
    const seen = new Map();
    for (const r of rows) {
      const key = [
        r.key, r.departureDate, r.total,
        // 본 시각을 모르면 받아온 '날짜'로 대신합니다 (같은 날 같은 값이면 한 번으로)
        r.observedAt ?? String(r.ts).slice(0, 10),
      ].join("|");
      if (!seen.has(key)) seen.set(key, r);
    }
    return [...seen.values()];
  }

  /** 이 기록들이 며칠에 걸쳐, 서로 다른 몇 날에 모였는지 셉니다. */
  #spread(rows) {
    if (!rows.length) return { spanDays: 0, distinctDays: 0 };
    const days = new Set(rows.map((r) => String(r.observedAt ?? r.ts).slice(0, 10)));
    const times = rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
    const spanDays = times.length
      ? Math.round((Math.max(...times) - Math.min(...times)) / 86400000)
      : 0;
    return { spanDays, distinctDays: days.size };
  }

  stats(key, { maxAgeDays = 400, before = null } = {}) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    // before 를 주면 그 시각 이전 기록만 봅니다.
    // 이번 스캔에서 방금 적은 값을 판정 근거로 쓰면 자기 자신과 비교하게 되니까요.
    const until = before ? Date.parse(before) : Infinity;
    const raw = this.load()
      // 형식이 다른 옛 기록은 섞지 않습니다 (일수 세는 법이 달랐습니다)
      .filter((r) => (r.v ?? 1) === HISTORY_VERSION)
      .filter((r) => r.key === key && Date.parse(r.ts) >= cutoff && Date.parse(r.ts) < until);
    const rows = this.#distinct(raw);
    if (!rows.length) return null;
    const values = rows.map((r) => r.total).sort((a, b) => a - b);
    return {
      count: values.length,
      rawCount: raw.length,          // 다시 받은 것까지 포함한 원래 건수
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      min: values[0],
      max: values.at(-1),
      ...this.#spread(rows),
    };
  }

  /** 같은 노선 기록을 전부 (달 구분 없이) 봅니다. 기록이 적을 때 예비로 씁니다. */
  routeStats(origin, destination, { maxAgeDays = 400, before = null } = {}) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const until = before ? Date.parse(before) : Infinity;
    const raw = this.load()
      .filter((r) => (r.v ?? 1) === HISTORY_VERSION)
      .filter((r) => r.origin === origin && r.destination === destination
                  && Date.parse(r.ts) >= cutoff && Date.parse(r.ts) < until);
    const rows = this.#distinct(raw);
    if (!rows.length) return null;
    const values = rows.map((r) => r.total).sort((a, b) => a - b);
    return {
      count: values.length, rawCount: raw.length,
      median: quantile(values, 0.5), p25: quantile(values, 0.25),
      min: values[0], max: values.at(-1),
      ...this.#spread(rows),
    };
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
