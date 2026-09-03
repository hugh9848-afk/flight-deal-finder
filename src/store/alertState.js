// 어떤 특가를 언제 얼마에 알렸는지 적어두는 수첩.
import fs from "node:fs";

const DEFAULT_PATH = new URL("../../data/alert-state.json", import.meta.url).pathname;

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
  record(sig, { price, score }) {
    this.data[sig] = { price, score, at: new Date().toISOString() };
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
