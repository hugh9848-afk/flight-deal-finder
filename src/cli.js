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
import { SerpApiProvider } from "./providers/serpapi/index.js";
import { createSerpApiAccounts } from "./providers/serpapi/accounts.js";
import { CompositeProvider } from "./providers/composite.js";
import { SETTINGS } from "./config/settings.js";
import { writeSummaryFile, sendWebhook, renderAlertText, writeAlertsFile } from "./notify/index.js";
import { fileURLToPath } from "node:url";

// 폴더 이름에 한글이 있으면 URL.pathname 은 %ED%95%AD 처럼 바꿔버려 파일을 못 찾습니다.
// fileURLToPath 를 써야 한글이 한글 그대로 읽힙니다.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  if (name === "travelpayouts") return makeTravelpayouts({ required: true });
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
  if (name === "serpapi" || name === "all") {
    const tp = makeTravelpayouts({ required: name === "serpapi" ? false : true });
    const sp = makeSerpApi({ required: name === "serpapi" });
    const list = [sp, tp].filter(Boolean).map((provider) => ({ provider }));
    if (!list.length) {
      console.error("\n❌ 쓸 수 있는 공급자가 없습니다. .env 를 확인하세요.\n");
      process.exit(1);
    }
    return list.length === 1 ? list[0].provider : new CompositeProvider(list);
  }
  console.error(`알 수 없는 공급자: ${name}`);
  process.exit(1);
}

/** Travelpayouts 공급자를 만듭니다. 토큰이 없으면 null (필수면 종료). */
function makeTravelpayouts({ required = true } = {}) {
  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) {
    if (required) {
      console.error("\n❌ TRAVELPAYOUTS_TOKEN 이 없습니다. .env 를 확인하세요.\n");
      process.exit(1);
    }
    return null;
  }
  return new TravelpayoutsProvider({ token, marker: process.env.TRAVELPAYOUTS_MARKER });
}

/**
 * SerpApi 공급자를 만듭니다.
 * 무료 250회/월 이므로 실행마다 쓸 양을 미리 정해둡니다.
 *   발굴 7회 + 상세 12회 = 19회/실행 → 3일 주기(월 10회)면 약 190회
 *
 *   발굴이 7회인 까닭: 탐색할 지역 칸이 6개(유럽·아프리카·캅카스·몽골·호주·뉴질랜드)이고
 *   할인검색(Deals)용으로 1회를 따로 남겨두기 때문입니다.
 *   31일인 달은 11회 돌아서 209회가 될 수 있으므로, 월 상한(200)에 걸리면
 *   마지막 회차는 상세를 줄여 스스로 멈춥니다.
 * 친구 계정까지 연결하면 발굴 7회 + 상세 28회 = 35회, 최대 14개 일정.
 * 친구 두 명까지 연결하면 발굴 7회 + 상세 44회 = 51회, 최대 22개 일정.
 * 월 상한 200회와 사용 장부는 각 계정에 각각 적용합니다.
 */
function makeSerpApi({ required = false } = {}) {
  const config = createSerpApiAccounts({ dataDir: path.join(ROOT, "data") });
  if (!config) {
    if (required) {
      console.error(
        "\n❌ SERPAPI_API_KEY 가 없습니다.\n" +
        "   1) https://serpapi.com 에서 무료 가입 (월 250회)\n" +
        "   2) 대시보드에서 API Key 복사\n" +
        "   3) 이 폴더의 .env 에 붙여넣기\n"
      );
      process.exit(1);
    }
    return null;
  }
  return new SerpApiProvider(config);
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? "scan";

  // Account API는 무료입니다. 항공 검색·알림·배포 없이 연결만 점검합니다.
  if (cmd === "quota") {
    const config = createSerpApiAccounts({ dataDir: path.join(ROOT, "data") });
    if (!config) throw new Error("SerpApi 키가 없습니다");
    const quota = await config.client.checkQuota();
    console.log(JSON.stringify({ ...quota, budget: config.client.stats }, null, 2));
    if (!quota.ok) process.exitCode = 1;
    return;
  }

  if (cmd !== "scan") {
    console.error("사용법: node src/cli.js quota 또는 scan [--provider=all|travelpayouts|serpapi|mock] [--regions=europe,africa,caucasus,mongolia,oceania]");
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

  // 알림 대상을 파일로 남깁니다 (워크플로우가 읽어 GitHub 이슈로 올립니다).
  const siteUrl = process.env.SITE_URL ?? null;
  const alertsFile = writeAlertsFile(result.alerts, path.join(ROOT, "web", "data"), { siteUrl });

  // 웹훅 주소가 설정돼 있으면 그리로도 보냅니다.
  if (result.alerts.length) {
    const sent = await sendWebhook(renderAlertText(result.alerts, { siteUrl }));
    console.log(`알림 ${result.alerts.length}건 · ${sent.sent ? "웹훅 전송 완료" : `웹훅 미전송(${sent.reason ?? sent.status})`}`);
  } else {
    console.log("알림: 새로 알릴 후보 없음");
  }

  console.log("\n" + summary);
  console.log(`\n저장: ${out.webFile}`);
  console.log(`요약: ${summaryFile}`);
  console.log(`알림: ${alertsFile}`);
  if (result.report.warnings.length) {
    console.log("\n주의:");
    for (const w of result.report.warnings.slice(0, 10)) console.log(`  - ${w}`);
  }
}

main().catch((e) => {
  console.error("실행 중 오류:", e);
  process.exit(1);
});
