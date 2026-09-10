// 여러 공급자를 하나처럼 묶어주는 어댑터.
//
// 넓게 훑을 때는 모두에게 물어보고 결과를 합칩니다.
// **한 곳이 실패해도 나머지 결과는 그대로 씁니다** — 서로 보완하려고 여럿을 쓰는데
// 하나가 죽었다고 전체가 멈추면 의미가 없습니다.
//
// 실제 조회(live)는 그걸 할 수 있는 공급자에게만 넘깁니다.
import { FlightProvider } from "./base.js";
import { findAirport } from "../config/destinations.js";

export class CompositeProvider extends FlightProvider {
  /** @param {Array<{provider:FlightProvider, weight?:number}>} entries */
  constructor(entries) {
    super();
    this.entries = entries.filter(Boolean);
    this.stats = { indicativeCalls: 0, liveCalls: 0, confirmCalls: 0, errors: [], byProvider: {} };
  }

  get name() { return this.entries.map((e) => e.provider.name).join("+"); }

  /** 실제 조회를 몇 건까지 할 수 있는지 (유료 공급자의 예산을 그대로 씁니다) */
  get detailBudget() {
    const budgets = this.entries
      .filter((e) => e.provider.capabilities.live)
      .map((e) => e.provider.detailBudget ?? e.provider.detailCalls)
      .filter((n) => typeof n === "number");
    return budgets.length ? Math.min(...budgets) : undefined;
  }

  get capabilities() {
    // 하나라도 할 수 있으면 할 수 있는 것으로 봅니다
    const any = (k) => this.entries.some((e) => e.provider.capabilities[k]);
    return { indicative: any("indicative"), live: any("live"),
             confirm: any("confirm"), openJaw: any("openJaw") };
  }

  planDetails(ranked, opts) {
    const p = this.entries.find((e) => e.provider.capabilities.live && e.provider.planDetails)?.provider;
    return p ? p.planDetails(ranked, opts) : { items: ranked.slice(0, opts.cap) };
  }

  /** 시작 전 준비 (SerpApi 는 잔여량 확인이 필요합니다) */
  async prepare(opts) {
    const results = {};
    for (const { provider } of this.entries) {
      if (typeof provider.prepare === "function") {
        try { results[provider.name] = await provider.prepare(opts); }
        catch (e) {
          results[provider.name] = { ok: false, error: String(e) };
          this.stats.errors.push({ provider: provider.name, step: "prepare", error: String(e) });
        }
      }
    }
    return results;
  }

  /** 넓게 훑기 — 모두에게 물어보고 합칩니다 */
  async searchInspiration(params) {
    const all = [];
    const coverage = [];
    for (const { provider } of this.entries) {
      if (!provider.capabilities.indicative) continue;
      let res;
      try {
        res = await provider.searchInspiration(params);
      } catch (e) {
        // 한 공급자의 사고가 전체를 멈추지 않게 감싸둡니다
        this.stats.errors.push({ provider: provider.name, step: "inspiration", error: String(e) });
        continue;
      }
      const got = res?.candidates ?? [];
      all.push(...got);
      coverage.push({ provider: provider.name, found: got.length, ok: res?.ok !== false,
                      detail: res?.coverage ?? null, error: res?.error ?? null });
      this.stats.byProvider[provider.name] = {
        found: got.length,
        calls: provider.stats?.indicativeCalls ?? null,
        errors: (provider.stats?.errors ?? []).length,
        skipped: (provider.stats?.skipped ?? []).length,
      };
      this.stats.indicativeCalls += provider.stats?.indicativeCalls ?? 0;
    }

    const merged = mergeAcrossProviders(all);
    return {
      ok: merged.length > 0 || coverage.some((c) => c.ok),
      candidates: merged,
      coverage,
    };
  }

  /** 목적지별 조회 — 넓게 훑기가 비었을 때 쓰는 예비책 */
  async searchCheapestDates(params) {
    for (const { provider } of this.entries) {
      if (typeof provider.searchCheapestDates !== "function") continue;
      try {
        const r = await provider.searchCheapestDates(params);
        if (r?.ok && r.candidates?.length) return r;
      } catch { /* 다음 공급자로 */ }
    }
    return { ok: true, candidates: [] };
  }

  /** 실제 조회 — 할 수 있는 공급자에게만 넘깁니다 */
  async searchLive(params) {
    for (const { provider } of this.entries) {
      if (!provider.capabilities.live) continue;
      try {
        const r = await provider.searchLive(params);
        this.stats.liveCalls += 1;
        if (r?.ok) return r;
        // 예산이 다 됐으면 다음 공급자에게 넘기지 않고 그대로 알립니다
        if (r?.skipped) return r;
      } catch (e) {
        this.stats.errors.push({ provider: provider.name, step: "live", error: String(e) });
      }
    }
    return { ok: false, candidates: [], error: "실제 조회를 할 수 있는 공급자가 없습니다" };
  }

  async searchLiveOpenJaw(params) {
    for (const { provider } of this.entries) {
      if (!provider.capabilities.openJaw) continue;
      try { return await provider.searchLiveOpenJaw(params); } catch { /* 다음 */ }
    }
    return { ok: false, candidates: [], error: "오픈조를 지원하는 공급자가 없습니다" };
  }

  async confirmPrice(candidate) {
    for (const { provider } of this.entries) {
      if (provider.capabilities.confirm) return provider.confirmPrice(candidate);
    }
    return candidate;
  }
}

/**
 * 여러 공급자에서 온 후보를 합칩니다.
 *
 * 같은 일정(도시·출발일·귀국일)에 **값까지 같으면** 한 건으로 봅니다.
 * 값이 다르면 서로 다른 운임일 수 있으므로 둘 다 남깁니다.
 * 값이 같을 때는 아는 게 더 많은 쪽(이동시간·경유를 아는 쪽)을 남깁니다.
 */
export function mergeAcrossProviders(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const depart = c.outbound?.departAt?.slice(0, 10);
    if (!depart || typeof c.total !== "number") continue;
    const city = findAirport(c.destIn)?.city_code ?? c.destIn;
    const back = c.inbound?.departAt?.slice(0, 10) ?? "";
    const key = `${city}|${depart}|${back}|${c.total}`;

    const prev = best.get(key);
    if (!prev || richness(c) > richness(prev)) best.set(key, c);
  }
  return [...best.values()];
}

/** 얼마나 많이 아는 후보인지 점수를 매깁니다 (같은 값일 때 고르는 기준) */
function richness(c) {
  let n = 0;
  if (c.outbound?.durationMin != null) n += 2;
  if (c.inbound?.durationMin != null) n += 2;
  if (c.inbound?.stops != null) n += 2;
  if (c.providerBaseline) n += 3;          // 할인 기준을 아는 쪽이 훨씬 쓸모 있습니다
  if (c.departureAirportVerified === true) n += 1;
  if ((c.links ?? []).length) n += 1;
  return n;
}
