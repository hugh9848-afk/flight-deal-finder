// Travelpayouts(아비아세일즈)에 전화를 거는 '전화기'.
// Amadeus 와 달리 신분증 발급 절차가 없고, 토큰을 머리말에 얹어 보내면 됩니다.
const HOST = "https://api.travelpayouts.com";

export class TravelpayoutsClient {
  constructor({ token, marker, minIntervalMs = 250, timeoutMs = 15000 } = {}) {
    if (!token) throw new Error("TRAVELPAYOUTS_TOKEN 이 필요합니다");
    this.token = token;
    this.marker = marker ?? null;   // 링크를 만들 때 쓰는 제휴 번호
    this.minIntervalMs = minIntervalMs;
    // 응답이 없을 때 얼마나 기다릴지. 이게 없으면 한 번의 호출이
    // 영영 매달려서 자동 실행 전체가 멈춥니다(실제로 5시간 28분 멈춘 적 있음).
    this.timeoutMs = timeoutMs;
    this.lastCallAt = 0;
    this.callCount = 0;
  }

  async #throttle() {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /**
   * 실제 호출. 막히거나(429) 서버가 아프면(5xx) 쉬었다 최대 3번까지 다시 겁니다.
   * @returns {{ok:boolean, status:number, data:any, error?:string}}
   */
  async request(path, query = {}) {
    const url = new URL(path, HOST);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#throttle();
      this.callCount++;
      let res;
      try {
        // 정해진 시간이 지나면 스스로 끊습니다
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          res = await fetch(url, {
            headers: { "x-access-token": this.token, Accept: "application/json" },
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const msg = e?.name === "AbortError" ? `응답 없음 (${this.timeoutMs / 1000}초 초과)` : String(e);
        if (attempt === 2) return { ok: false, status: 0, data: null, error: msg };
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt === 2) return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` };
        await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, status: res.status, data, error: data?.error ?? `HTTP ${res.status}` };
      }
      // 이 API 는 HTTP 200 이면서도 success:false 로 실패를 알려줄 때가 있습니다.
      if (data && data.success === false) {
        return { ok: false, status: res.status, data, error: data.error ?? "success:false" };
      }
      return { ok: true, status: res.status, data };
    }
    return { ok: false, status: 0, data: null, error: "재시도 모두 실패" };
  }

  /**
   * 사람이 눌러서 직접 확인할 검색 링크를 만듭니다.
   * 특정 운임을 콕 집는 링크가 아니라 '같은 조건으로 검색한 화면'입니다.
   */
  searchLink({ origin, destination, departureDate, returnDate, adults = 1 }) {
    const dm = (d) => (d ? d.slice(8, 10) + d.slice(5, 7) : ""); // YYYY-MM-DD -> DDMM
    if (!origin || !destination || !departureDate) return null;
    const path = `${origin}${dm(departureDate)}${destination}${returnDate ? dm(returnDate) : ""}${adults}`;
    const url = new URL(`https://www.aviasales.com/search/${path}`);
    if (this.marker) url.searchParams.set("marker", this.marker);
    return url.toString();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
