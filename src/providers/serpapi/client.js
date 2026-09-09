// SerpApi 에 전화를 거는 '전화기'.
//
// 무료 요금제는 한 달에 250번만 걸 수 있습니다. 넘기면 돈이 나가거나 막힙니다.
// 그래서 예산을 다루는 방식이 이 파일에서 가장 중요합니다.
//
// 핵심 규칙 세 가지
//   1) 걸기 전에 계정 잔여를 **반드시** 확인한다. 확인 못 하면 아예 걸지 않는다.
//   2) 확인과 동시에 자리를 **예약**한다.
//      (확인 → 기다림 → 사용 순서면, 여럿이 동시에 확인만 통과해 한도를 넘긴다)
//   3) 쓴 횟수는 파일 장부에 남긴다. 장부를 못 쓰면 안전하게 멈춘다.
import fs from "node:fs";
import path from "node:path";

const HOST = "https://serpapi.com";
const SAFETY_MARGIN = 5;      // 계정 잔여에서 이만큼은 남겨 둡니다
const DEFAULT_TIMEOUT = 20000;

export class SerpApiClient {
  constructor({ apiKey, runBudget = 30, monthlyBudget = 200, ledgerPath = null,
                minIntervalMs = 300, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!apiKey) throw new Error("SERPAPI_API_KEY 가 필요합니다");
    this.apiKey = apiKey;
    this.runBudget = runBudget;         // 이번 실행에서 쓸 수 있는 최대
    this.monthlyBudget = monthlyBudget; // 우리가 스스로 정한 한 달 상한
    this.ledgerPath = ledgerPath;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;

    this.reserved = 0;        // 예약한 자리 수 (기다리는 중인 것 포함)
    this.completed = 0;       // 실제로 끝난 호출 수
    this.accountLeft = null;  // 계정 잔여 (확인 전에는 모름)
    this.quotaChecked = false;
    this.stopped = null;      // 멈춘 이유
    this.lastCallAt = 0;
    this.queue = Promise.resolve();   // 호출을 한 줄로 세우기 위한 대기줄
  }

  /**
   * 계정에 남은 횟수를 물어봅니다. 이 조회는 검색 횟수를 소모하지 않습니다.
   * **이걸 통과해야만 검색을 시작할 수 있습니다.**
   */
  async checkQuota() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${HOST}/account?api_key=${encodeURIComponent(this.apiKey)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      const j = await res.json().catch(() => null);
      if (!j || j.error) {
        this.stopped = `잔여량 확인 실패: ${j?.error ?? "응답 없음"}`;
        return { ok: false, error: this.stopped };
      }
      const left = j.total_searches_left ?? j.plan_searches_left;
      if (typeof left !== "number" || !Number.isFinite(left)) {
        this.stopped = "잔여량이 숫자가 아닙니다";
        return { ok: false, error: this.stopped };
      }
      this.accountLeft = left;
      this.quotaChecked = true;
      return { ok: true, plan: j.plan_name ?? null, perMonth: j.searches_per_month ?? null,
               used: j.this_month_usage ?? null, left };
    } catch (e) {
      this.stopped = `잔여량 확인 실패: ${e}`;
      return { ok: false, error: this.stopped };
    }
  }

  /** 이번 달에 우리가 이미 쓴 횟수 (장부 기준) */
  #ledgerUsed() {
    if (!this.ledgerPath) return 0;
    try {
      const led = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8"));
      const month = new Date().toISOString().slice(0, 7);
      return led.month === month ? (led.calls ?? []).length : 0;
    } catch { return 0; }
  }

  /**
   * 자리를 하나 예약합니다. 확인과 예약을 **한 번에** 처리해
   * 여러 요청이 동시에 통과하는 일을 막습니다.
   * @returns {string|null} 못 쓰면 이유, 쓸 수 있으면 null
   */
  #reserve() {
    if (this.stopped) return this.stopped;
    if (!this.quotaChecked) return "잔여량을 먼저 확인해야 합니다";
    if (this.reserved >= this.runBudget) return "이번 실행 예산 소진";
    if (this.#ledgerUsed() + this.reserved >= this.monthlyBudget) return "이번 달 자체 예산 소진";
    if (this.reserved >= this.accountLeft - SAFETY_MARGIN) return "계정 잔여 부족";
    this.reserved++;              // ← 기다리기 전에 미리 자리를 잡습니다
    return null;
  }

  /** 사용 기록을 장부에 남깁니다. 실패하면 안전하게 멈춥니다. */
  #record(entry) {
    if (!this.ledgerPath) return true;
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      let led = { month: null, calls: [] };
      try { led = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")); } catch { /* 첫 장부 */ }
      const month = new Date().toISOString().slice(0, 7);
      if (led.month !== month) led = { month, calls: [] };
      led.calls.push(entry);
      fs.writeFileSync(this.ledgerPath, JSON.stringify(led, null, 2));
      return true;
    } catch (e) {
      // 장부를 못 쓰면 얼마나 썼는지 알 수 없게 됩니다. 조용히 넘어가면 안 됩니다.
      this.stopped = `사용 기록 저장 실패로 중단: ${e}`;
      return false;
    }
  }

  async #throttle() {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /**
   * 한 번 호출합니다. 예산이 없으면 걸지 않고 그 사실을 알려줍니다.
   * 호출은 한 줄로 세워 순서대로 처리합니다.
   */
  async search(params) {
    const denied = this.#reserve();      // 기다리기 전에 예약
    if (denied) return { ok: false, skipped: true, error: denied };

    // 앞 호출이 끝난 뒤에 이어서 실행되도록 줄을 세웁니다
    const run = this.queue.then(() => this.#doSearch(params));
    this.queue = run.catch(() => {});
    return run;
  }

  async #doSearch(params) {
    const url = new URL("/search.json", HOST);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    url.searchParams.set("api_key", this.apiKey);

    await this.#throttle();
    const at = new Date().toISOString();

    let res, json, timedOut = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeoutMs);
      res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      json = await res.json().catch(() => null);
    } catch (e) {
      // 시간이 초과되면 과금됐는지 알 수 없습니다.
      // 예약은 그대로 두고(=쓴 것으로 치고) 장부에도 남깁니다.
      this.completed++;
      this.#record({ at, engine: params.engine, ok: false, timedOut, error: String(e) });
      return { ok: false, error: timedOut ? "시간 초과 (과금 여부 불명)" : String(e) };
    }

    this.completed++;
    const failed = !res.ok || !json || json.error;
    const saved = this.#record({ at, engine: params.engine, ok: !failed, status: res.status, error: json?.error ?? null });
    if (!saved) return { ok: false, error: this.stopped };

    if (failed) return { ok: false, status: res.status, error: json?.error ?? `HTTP ${res.status}`, data: json };
    return { ok: true, data: json };
  }

  get stats() {
    return {
      reserved: this.reserved, completed: this.completed,
      runBudget: this.runBudget, monthlyBudget: this.monthlyBudget,
      monthlyUsed: this.#ledgerUsed(), accountLeft: this.accountLeft, stopped: this.stopped,
    };
  }
}
