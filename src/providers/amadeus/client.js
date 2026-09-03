// Amadeus 회사에 전화를 거는 '전화기'.
// 1) 먼저 신분증(토큰)을 받고 2) 너무 자주 걸지 않게 간격을 지키고
// 3) 통화가 끊기면(429/5xx) 잠깐 쉬었다 다시 겁니다.
const HOSTS = {
  test: "https://test.api.amadeus.com",
  production: "https://api.amadeus.com",
};

export class AmadeusClient {
  constructor({ clientId, clientSecret, env = "test", minIntervalMs = 120 } = {}) {
    if (!clientId || !clientSecret) {
      throw new Error("AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET 가 필요합니다");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.host = HOSTS[env] ?? HOSTS.test;
    this.env = env;
    this.minIntervalMs = minIntervalMs; // 전화 사이 최소 간격
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastCallAt = 0;
    this.callCount = 0;
  }

  /** 신분증(토큰)을 받아옵니다. 아직 유효하면 그대로 씁니다. */
  async #ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    const res = await fetch(`${this.host}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Amadeus 인증 실패 ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  /** 전화 간격을 지키기 위해 잠깐 기다립니다. */
  async #throttle() {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /**
   * 실제 호출. 실패하면 최대 3번까지 쉬었다 다시 겁니다.
   * @returns {{ok:boolean, status:number, data:any, error?:string}}
   */
  async request(path, { method = "GET", query, body, headers = {} } = {}) {
    const token = await this.#ensureToken();
    const url = new URL(path, this.host);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#throttle();
      this.callCount++;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt === 2) return { ok: false, status: 0, data: null, error: String(e) };
        await sleep(500 * (attempt + 1));
        continue;
      }

      // 너무 많이 걸었거나 서버가 아플 때 → 쉬었다 재시도
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 2) {
          return { ok: false, status: res.status, data: null, error: await safeText(res) };
        }
        await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          data,
          error: data?.errors?.[0]?.detail ?? `HTTP ${res.status}`,
        };
      }
      return { ok: true, status: res.status, data };
    }
    return { ok: false, status: 0, data: null, error: "재시도 모두 실패" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeText = (res) => res.text().catch(() => "");
