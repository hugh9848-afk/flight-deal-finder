// 어떤 특가를 언제 얼마에 알렸는지 적어두는 수첩.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 한글 폴더명 때문에 pathname 을 쓰면 경로가 깨집니다 (%ED%95%AD…)
const DEFAULT_PATH = fileURLToPath(new URL("../../data/alert-state.json", import.meta.url));

export class AlertState {
  constructor(file = DEFAULT_PATH) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {}; // 수첩이 아직 없으면 빈 수첩으로 시작
    }
  }
  get(sig) { return this.data[sig]; }
  /**
   * "이 특가는 알렸다"를 적어 둡니다.
   *
   * 연습용 가짜(mock) 자료는 **적지 않습니다.** 적어 두면 나중에 진짜 특가가 나와도
   * "이미 알렸다"며 건너뛰게 됩니다. 가격 이력(history.js)도 같은 이유로 mock 을 막습니다.
   */
  record(sig, { price, score, source } = {}) {
    if (source === "mock") return false;
    this.data[sig] = { price, score, at: new Date().toISOString() };
    return true;
  }
  /** 1년 넘은 기록은 지웁니다 (수첩이 계속 두꺼워지지 않게) */
  prune(maxAgeDays = 365) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    for (const [k, v] of Object.entries(this.data)) {
      if (Date.parse(v.at) < cutoff) delete this.data[k];
    }
  }
  save() {
    this.prune();
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
