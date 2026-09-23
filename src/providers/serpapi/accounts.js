// 공동 사용자가 제공한 계정마다 한도·장부를 따로 관리합니다.
// 키나 계정 식별자는 결과·로그에 넣지 않고 main/friend/friend2 이름만 공개합니다.
import path from "node:path";
import { SerpApiClient } from "./client.js";

export class SerpApiAccounts {
  constructor(entries, { runBudget }) {
    if (!Number.isSafeInteger(runBudget) || runBudget < 0) throw new Error("잘못된 실행 예산");
    this.entries = entries;
    this.runBudget = runBudget;
    this.used = 0;
    this.queue = Promise.resolve();
    this.ready = new Set();
  }

  async checkQuota() {
    this.ready.clear();
    const accounts = [];
    const ids = new Set();
    for (const entry of this.entries) {
      let q;
      try { q = await entry.client.checkQuota(); }
      catch { q = { ok: false, error: "계정 잔여량 확인 실패" }; }
      const id = entry.client.accountId;
      if (q.ok && id && ids.has(id)) {
        q = { ok: false, error: "이미 연결된 같은 계정입니다" };
      }
      if (q.ok) { this.ready.add(entry); if (id) ids.add(id); }
      accounts.push({ name: entry.name, ...q });
    }
    return { ok: this.ready.size > 0, accounts,
      left: accounts.filter((a) => a.ok).reduce((n, a) => n + (a.left ?? 0), 0),
      error: this.ready.size ? null : "사용 가능한 SerpApi 계정이 없습니다" };
  }

  remaining() {
    const sum = [...this.ready].reduce((n, e) => n + e.client.remaining(), 0);
    return Math.max(0, Math.min(this.runBudget - this.used, sum));
  }

  canAffordPair() {
    return this.runBudget - this.used >= 2
      && [...this.ready].some((e) => e.client.remaining() >= 2);
  }

  // 작업 하나(발굴 1회 또는 왕복 2회)가 끝날 때까지 계정을 바꾸지 않습니다.
  // 대기열에서 꺼낼 때 한도를 다시 확인하므로 동시에 요청해도 초과하지 않습니다.
  withAccount(count, work) {
    const run = this.queue.then(async () => {
      const entry = [...this.ready].filter((e) => e.client.remaining() >= count)
        .sort((a, b) => b.client.remaining() - a.client.remaining())[0];
      if (!entry || this.runBudget - this.used < count) {
        return { ok: false, skipped: true, candidates: [], error: "계정별 잔여량 또는 실행 예산 부족" };
      }
      let calls = 0;
      return work({
        cacheKey: entry.name,
        remaining: () => Math.min(count - calls, entry.client.remaining()),
        search: async (params) => {
          if (calls >= count) return { ok: false, skipped: true, error: "예약한 호출 수 초과" };
          calls++; this.used++;
          return entry.client.search(params);
        },
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }

  search(params) { return this.withAccount(1, (client) => client.search(params)); }

  get stats() {
    return { runBudget: this.runBudget, reserved: this.used, remaining: this.remaining(),
      accounts: this.entries.map((e) => ({ name: e.name, available: this.ready.has(e), ...e.client.stats })) };
  }
}

/** 본인과 친구 두 명까지, 서로 다른 키 개수에 맞춰 예산을 적용합니다. */
export function createSerpApiAccounts({ env = process.env, dataDir, clientFactory = (opts) => new SerpApiClient(opts) }) {
  const keys = new Set();
  const accounts = [
    { name: "main", key: env.SERPAPI_API_KEY, ledger: "serpapi-ledger.json" },
    { name: "friend", key: env.SERPAPI_API_KEY_FRIEND, ledger: "serpapi-ledger-friend.json" },
    { name: "friend2", key: env.SERPAPI_API_KEY_FRIEND_2, ledger: "serpapi-ledger-friend2.json" },
  ].filter((a) => {
    a.key = a.key?.trim();
    if (!a.key || keys.has(a.key)) return false;
    keys.add(a.key); return true;
  });
  if (!accounts.length) return null;
  const configured = env.SERPAPI_RUN_BUDGET;
  const runBudget = configured?.trim() ? Number(configured) : 19 + 16 * (accounts.length - 1);
  const monthlyBudget = Number(env.SERPAPI_MONTHLY_BUDGET || 200); // 계정당 상한
  const entries = accounts.map((a) => ({ name: a.name, client: clientFactory({
    apiKey: a.key, runBudget, monthlyBudget, ledgerPath: path.join(dataDir, a.ledger),
  }) }));
  return { client: new SerpApiAccounts(entries, { runBudget }), discoveryCalls: 7,
    detailCalls: Math.max(0, Math.min(12 + 16 * (accounts.length - 1), runBudget - 7)) };
}
