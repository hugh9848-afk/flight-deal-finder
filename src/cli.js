#!/usr/bin/env node
// 명령줄에서 실행하는 입구.
//   node src/cli.js scan --provider=mock
//   node src/cli.js scan --provider=amadeus --regions=europe,caucasus
import fs from "node:fs";
import path from "node:path";
import { runScan } from "./pipeline/scan.js";
import { writeResults, renderSummary } from "./pipeline/output.js";
import { PriceHistory } from "./store/history.js";
import { AlertState } from "./store/alertState.js";
import { MockProvider } from "./providers/mock/index.js";
import { AmadeusProvider } from "./providers/amadeus/index.js";
import { TravelpayoutsProvider } from "./providers/travelpayouts/index.js";
import { SETTINGS } from "./config/settings.js";
import { writeSummaryFile, sendWebhook, renderAlertText } from "./notify/index.js";

const ROOT = new URL("..", import.meta.url).pathname;

/** .env 파일이 있으면 읽어서 환경변수처럼 씁니다. (외부 라이브러리 없이) */
function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args[k] = v === undefined ? true : v;
    } else args._.push(a);
  }
  return args;
}

function makeProvider(name) {
  if (name === "mock") return new MockProvider();
  if (name === "travelpayouts") {
    const token = process.env.TRAVELPAYOUTS_TOKEN;
    if (!token) {
      console.error(
        "\n❌ Travelpayouts 토큰이 없습니다.\n" +
        "   1) https://www.travelpayouts.com 에서 무료 가입\n" +
        "   2) 대시보드 → Tools/API 에서 API 토큰과 마커(marker) 복사\n" +
        "   3) 이 폴더의 .env 파일에 붙여넣기 (.env.example 참고)\n" +
        "   지금 당장 시험만 해보려면 --provider=mock 을 쓰세요.\n"
      );
      process.exit(1);
    }
    return new TravelpayoutsProvider({ token, marker: process.env.TRAVELPAYOUTS_MARKER });
  }
  if (name === "amadeus") {
    const clientId = process.env.AMADEUS_CLIENT_ID;
    const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error(
        "\n❌ Amadeus 키가 없습니다.\n" +
        "   1) https://developers.amadeus.com 에서 무료 가입\n" +
        "   2) 앱을 만들면 나오는 API Key / API Secret 복사\n" +
        "   3) 이 폴더의 .env 파일에 붙여넣기 (.env.example 참고)\n" +
        "   지금 당장 시험만 해보려면 --provider=mock 을 쓰세요.\n"
      );
      process.exit(1);
    }
    return new AmadeusProvider({ clientId, clientSecret, env: process.env.AMADEUS_ENV ?? "test" });
  }
  console.error(`알 수 없는 공급자: ${name}`);
  process.exit(1);
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "scan";

  if (cmd !== "scan") {
    console.error("사용법: node src/cli.js scan [--provider=travelpayouts|mock|amadeus] [--regions=europe,africa,caucasus,mongolia]");
    process.exit(1);
  }

  const provider = makeProvider(args.provider ?? "travelpayouts");
  const regions = args.regions ? String(args.regions).split(",").map((s) => s.trim()) : [];
  const history = new PriceHistory(path.join(ROOT, "data", "history"));
  const alertState = new AlertState(path.join(ROOT, "data", "alert-state.json"));

  const settings = { ...SETTINGS };
  if (args.maxPrice) settings.deal = { ...settings.deal, maxTotalKRW: Number(args.maxPrice) };

  const result = await runScan({ provider, history, alertState, regions, settings });

  const out = writeResults(result, {
    webDir: path.join(ROOT, "web", "data"),
    dataDir: path.join(ROOT, "data"),
  });
  alertState.save();

  const summary = renderSummary(result);
  const summaryFile = writeSummaryFile(summary, path.join(ROOT, "web", "data"));

  // 새로 알릴 특가가 있을 때만 웹훅을 씁니다.
  if (result.alerts.length) {
    const sent = await sendWebhook(renderAlertText(result.alerts));
    console.log(`알림: ${sent.sent ? "웹훅 전송 완료" : `웹훅 미전송 (${sent.reason ?? sent.status})`}`);
  }

  console.log("\n" + summary);
  console.log(`\n저장: ${out.webFile}`);
  console.log(`요약: ${summaryFile}`);
  if (result.report.warnings.length) {
    console.log("\n주의:");
    for (const w of result.report.warnings.slice(0, 10)) console.log(`  - ${w}`);
  }
}

main().catch((e) => {
  console.error("실행 중 오류:", e);
  process.exit(1);
});
