import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerpApiAccounts, createSerpApiAccounts } from "../src/providers/serpapi/accounts.js";
import { SerpApiClient } from "../src/providers/serpapi/client.js";
import { SerpApiProvider } from "../src/providers/serpapi/index.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdf-accounts-"));
function fake(name, left, { id = name, failed = false } = {}) {
  let used = 0;
  const calls = [];
  return { name, client: { accountId: id, calls,
    checkQuota: async () => ({ ok: !failed, left, perMonth: 250, used: 250 - left }),
    remaining: () => left - used,
    search: async (p) => { used++; calls.push(p); return { ok: true, data: { name } }; },
    get stats() { return { completed: used }; },
  } };
}

test("키 하나는 기존 예산과 장부를 유지하고 친구 키는 다른 장부를 쓴다", () => {
  const dataDir = dir(); const clientFactory = (o) => o;
  const one = createSerpApiAccounts({ env: { SERPAPI_API_KEY: "main-key" }, dataDir, clientFactory });
  assert.equal(one.client.runBudget, 19); assert.equal(one.detailCalls, 12);
  assert.equal(one.client.entries[0].client.ledgerPath, path.join(dataDir, "serpapi-ledger.json"));
  const two = createSerpApiAccounts({ env: { SERPAPI_API_KEY: "main-key", SERPAPI_API_KEY_FRIEND: "friend-key" }, dataDir, clientFactory });
  assert.equal(two.client.runBudget, 35); assert.equal(two.detailCalls, 28);
  assert.deepEqual(two.client.entries.map((e) => e.client.monthlyBudget), [200, 200]);
  assert.equal(two.client.entries[1].client.ledgerPath, path.join(dataDir, "serpapi-ledger-friend.json"));
});

test("같은 키를 두 번 넣어도 한도는 늘지 않고 친구 키만 있어도 작동한다", () => {
  const dataDir = dir();
  const a = createSerpApiAccounts({ env: { SERPAPI_API_KEY: "key", SERPAPI_API_KEY_FRIEND: " key " }, dataDir });
  assert.equal(a.client.entries.length, 1); assert.equal(a.client.runBudget, 19);
  const b = createSerpApiAccounts({ env: { SERPAPI_API_KEY_FRIEND: "friend" }, dataDir });
  assert.equal(b.client.entries.length, 1); assert.equal(b.client.entries[0].name, "friend");
  assert.equal(createSerpApiAccounts({ env: {}, dataDir }), null);
});

test("명시한 실행 상한과 잘못된 상한을 자동 설정으로 덮어쓰지 않는다", () => {
  const dataDir = dir();
  const env = { SERPAPI_API_KEY: "a", SERPAPI_API_KEY_FRIEND: "b", SERPAPI_RUN_BUDGET: "19" };
  assert.equal(createSerpApiAccounts({ env, dataDir }).detailCalls, 12);
  assert.throws(() => createSerpApiAccounts({ env: { ...env, SERPAPI_RUN_BUDGET: "bad" }, dataDir }));
});

test("계정 확인 전에는 검색하지 않고 실패한 계정만 제외한다", async () => {
  const bad = fake("main", 100, { failed: true }); const good = fake("friend", 100);
  const pool = new SerpApiAccounts([bad, good], { runBudget: 4 });
  assert.equal((await pool.search({})).skipped, true);
  const q = await pool.checkQuota(); assert.equal(q.ok, true); assert.equal(q.left, 100);
  await pool.search({ engine: "test" });
  assert.equal(bad.client.calls.length, 0); assert.equal(good.client.calls.length, 1);
});

test("키가 달라도 계정 ID가 같으면 같은 한도를 두 번 더하지 않는다", async () => {
  const a = fake("main", 100, { id: "one-account" }); const b = fake("friend", 100, { id: "one-account" });
  const pool = new SerpApiAccounts([a, b], { runBudget: 4 });
  const q = await pool.checkQuota(); assert.equal(q.left, 100);
  assert.equal(q.accounts[1].ok, false);
  await pool.search({}); assert.equal(b.client.calls.length, 0);
});

test("각각 1회 남은 두 계정으로 왕복 한 쌍을 시작하지 않는다", async () => {
  const pool = new SerpApiAccounts([fake("main", 1), fake("friend", 1)], { runBudget: 4 });
  await pool.checkQuota(); assert.equal(pool.remaining(), 2); assert.equal(pool.canAffordPair(), false);
  let called = false;
  const r = await pool.withAccount(2, () => { called = true; });
  assert.equal(r.skipped, true); assert.equal(called, false);
});

test("왕복의 두 호출은 같은 계정에 고정하고 다음 일정은 여유 있는 계정에 배정한다", async () => {
  const a = fake("main", 2); const b = fake("friend", 2);
  const pool = new SerpApiAccounts([a, b], { runBudget: 4 });
  await pool.checkQuota();
  const pair = () => pool.withAccount(2, async (c) => {
    const x = await c.search({ step: "outbound" });
    const y = await c.search({ step: "return" });
    assert.equal(x.data.name, y.data.name);
  });
  await Promise.all([pair(), pair()]);
  assert.equal(a.client.calls.length, 2); assert.equal(b.client.calls.length, 2);
  assert.equal(pool.remaining(), 0);
});

test("동시에 요청해도 공유 실행 상한을 넘지 않는다", async () => {
  const a = fake("main", 100); const b = fake("friend", 100);
  const pool = new SerpApiAccounts([a, b], { runBudget: 3 }); await pool.checkQuota();
  const results = await Promise.all(Array.from({ length: 8 }, () => pool.search({})));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(a.client.calls.length + b.client.calls.length, 3);
});

test("한 작업이 실패해도 대기열은 계속하며 자동으로 다른 계정에 재시도하지 않는다", async () => {
  const a = fake("main", 5); const b = fake("friend", 4);
  const pool = new SerpApiAccounts([a, b], { runBudget: 5 }); await pool.checkQuota();
  await assert.rejects(pool.withAccount(2, async (c) => { await c.search({}); throw new Error("실패"); }));
  assert.equal(b.client.calls.length, 0);
  assert.equal((await pool.search({})).ok, true);
});

test("실제 클라이언트의 별도 월 장부와 계정 잔여를 함께 적용하며 키는 상태에 없다", async (t) => {
  const root = dir();
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (u) => {
    const url = new URL(u); const key = url.searchParams.get("api_key");
    if (url.pathname === "/account") return { ok: true, json: async () => ({
      account_id: key === "secret-main" ? "id-main" : "id-friend", total_searches_left: 250,
      this_month_usage: 0, searches_per_month: 250 }) };
    searches++; return { ok: true, status: 200, json: async () => ({}) };
  });
  const config = createSerpApiAccounts({ dataDir: root,
    env: { SERPAPI_API_KEY: "secret-main", SERPAPI_API_KEY_FRIEND: "secret-friend", SERPAPI_MONTHLY_BUDGET: "2" },
    clientFactory: (o) => new SerpApiClient({ ...o, minIntervalMs: 0 }) });
  const q = await config.client.checkQuota();
  for (let i = 0; i < 6; i++) await config.client.search({ engine: "test" });
  assert.equal(searches, 4);
  for (const f of ["serpapi-ledger.json", "serpapi-ledger-friend.json"]) {
    const raw = fs.readFileSync(path.join(root, f), "utf8");
    assert.equal(JSON.parse(raw).calls.length, 2); assert.doesNotMatch(raw, /secret-|id-main|id-friend/);
  }
  assert.doesNotMatch(JSON.stringify({ q, stats: config.client.stats }), /secret-|id-main|id-friend/);
});

test("장부에 1회만 남았으면 계정 대시보드에 여유가 있어도 왕복을 시작하지 않는다", async (t) => {
  const ledgerPath = path.join(dir(), "ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ month: new Date().toISOString().slice(0, 7), calls: [{}, {}] }));
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ total_searches_left: 250 }) }));
  const c = new SerpApiClient({ apiKey: "k", ledgerPath, monthlyBudget: 3 }); await c.checkQuota();
  assert.equal(c.remaining(), 1);
});

test("Flights 어댑터가 같은 계정으로 출국·귀국 토큰을 보내고 2회씩 정확히 센다", async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/serp-roundtrip-icn-cdg.json", import.meta.url)));
  const entries = [fake("main", 2), fake("friend", 2)];
  for (const e of entries) {
    const original = e.client.search;
    e.client.search = async (p) => { await original(p); return { ok: true, data: {
      best_flights: p.departure_token ? fixture.returns : [fixture.outbound], price_insights: fixture.priceInsights,
    } }; };
  }
  const pool = new SerpApiAccounts(entries, { runBudget: 4 });
  const provider = new SerpApiProvider({ client: pool, discoveryCalls: 0, detailCalls: 4 });
  await provider.prepare();
  const params = { destination: "CDG", departureDate: "2027-01-16", returnDate: "2027-01-30" };
  for (let i = 0; i < 2; i++) {
    const r = await provider.searchLive(params); assert.ok(r.candidates.some((c) => c.returnAirportVerified));
  }
  for (const e of entries) {
    assert.equal(e.client.calls.length, 2);
    assert.equal(e.client.calls[0].departure_token, undefined); assert.ok(e.client.calls[1].departure_token);
  }
  assert.equal((await provider.searchLive(params)).skipped, true);
});


test("세 번째 계정은 별도 장부를 쓰고 중복·빈 키는 예산을 늘리지 않는다", () => {
  const dataDir = dir(); const clientFactory = (o) => o;
  const env = { SERPAPI_API_KEY: "main-key", SERPAPI_API_KEY_FRIEND: "friend-key", SERPAPI_API_KEY_FRIEND_2: "third-key" };
  const three = createSerpApiAccounts({ env, dataDir, clientFactory });
  assert.equal(three.client.runBudget, 51); assert.equal(three.detailCalls, 44);
  assert.deepEqual(three.client.entries.map((e) => e.name), ["main", "friend", "friend2"]);
  assert.deepEqual(three.client.entries.map((e) => e.client.monthlyBudget), [200, 200, 200]);
  assert.equal(three.client.entries[2].client.ledgerPath, path.join(dataDir, "serpapi-ledger-friend2.json"));
  for (const key of [" friend-key ", "  "]) {
    const config = createSerpApiAccounts({ env: { ...env, SERPAPI_API_KEY_FRIEND_2: key }, dataDir, clientFactory });
    assert.equal(config.client.entries.length, 2); assert.equal(config.client.runBudget, 35);
  }
  const solo = createSerpApiAccounts({ env: { SERPAPI_API_KEY_FRIEND_2: "third-key" }, dataDir, clientFactory });
  assert.equal(solo.client.runBudget, 19); assert.equal(solo.client.entries[0].name, "friend2");
  const capped = createSerpApiAccounts({ env: { ...env, SERPAPI_RUN_BUDGET: "19" }, dataDir, clientFactory });
  assert.equal(capped.client.runBudget, 19); assert.equal(capped.detailCalls, 12);
});

test("앞의 두 계정에 왕복 예산이 없으면 세 번째 계정에서 왕복을 끝낸다", async () => {
  const entries = [fake("main", 1), fake("friend", 1), fake("friend2", 2)];
  const pool = new SerpApiAccounts(entries, { runBudget: 51 });
  const q = await pool.checkQuota(); assert.equal(q.left, 4);
  assert.equal(pool.canAffordPair(), true);
  await pool.withAccount(2, async (client) => {
    assert.equal(client.cacheKey, "friend2");
    await client.search({ step: "outbound" }); await client.search({ step: "return" });
  });
  assert.deepEqual(entries.map((e) => e.client.calls.length), [0, 0, 2]);
  assert.equal(pool.canAffordPair(), false);
});


test("세 계정도 하나의 검색 예산을 공유하며 여유 있는 계정이 전체 작업을 맡을 수 있다", async () => {
  const entries = [fake("main", 0), fake("friend", 0), fake("friend2", 200)];
  const pool = new SerpApiAccounts(entries, { runBudget: 51 });
  await pool.checkQuota();
  const results = await Promise.all(Array.from({ length: 60 }, () => pool.search({ engine: "test" })));
  assert.equal(results.filter((r) => r.ok).length, 51);
  assert.deepEqual(entries.map((e) => e.client.calls.length), [0, 0, 51]);
  assert.equal(pool.remaining(), 0);
  assert.equal(pool.stats.reserved, 51);
});
