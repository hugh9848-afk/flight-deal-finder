// 알림 보내기.
// 지금 확실히 되는 두 가지만 씁니다.
//   1) 요약문을 파일로 남긴다 (web/data/summary.txt) — 항상 동작
//   2) 웹훅 주소가 설정돼 있으면 그리로 보낸다 — 선택
// 카카오톡 '나에게 보내기'는 클로드 세션에서 이 요약문을 읽어 전달하는 방식입니다.
import fs from "node:fs";
import path from "node:path";
import { findAirport } from "../config/destinations.js";

/** 공항·도시 코드를 한글 이름으로. 모르면 코드를 그대로 씁니다. */
function cityName(code) {
  return findAirport(code)?.city ?? code ?? "?";
}

/** 요약문을 파일로 남깁니다. */
export function writeSummaryFile(text, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "summary.txt");
  fs.writeFileSync(file, text);
  return file;
}

/**
 * 웹훅으로 보냅니다. (NOTIFY_WEBHOOK_URL 환경변수가 있을 때만)
 * 실패해도 스캔 전체가 멈추지 않게 조용히 넘어갑니다.
 */
export async function sendWebhook(text, { url = process.env.NOTIFY_WEBHOOK_URL, timeoutMs = 10000 } = {}) {
  if (!url) return { sent: false, reason: "웹훅 주소가 설정되지 않았습니다" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 흔한 웹훅들이 알아듣는 키를 함께 넣어 둡니다
      body: JSON.stringify({ text, content: text, message: text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: String(e) };
  }
}

/**
 * 알림 문구를 만듭니다.
 *
 * 중요: 이 후보들은 '참고가'입니다. 실제로 그 값에 살 수 있다는 보장이 없습니다.
 * 사람이 이 문구를 보고 돈 쓰는 판단을 하게 되므로,
 * 확인되지 않았다는 사실을 맨 앞과 각 항목에 분명히 적습니다.
 */
export function renderAlertText(alerts, { siteUrl = null } = {}) {
  if (!alerts.length) return "새로 알릴 후보가 없습니다.";

  const L = [];
  L.push(`✈️ 인천 출발 특가 후보 ${alerts.length}건`);
  L.push("");
  L.push("⚠️ 아래는 모두 참고가(캐시)입니다. 실제 구매 가능 여부·총액·수하물·환불조건은 확인되지 않았습니다.");
  L.push("각 항목의 링크를 눌러 실제 가격을 직접 확인하세요.");
  L.push("");

  for (const item of alerts) {
    const c = item.candidate;
    const v = item.verdict;
    const name = cityName(c.destIn);
    const kind = item.alertDecision?.kind === "cheaper" ? "가격 하락" : "신규";

    L.push(`── ${name} (${c.destIn}) · ${kind}`);
    L.push(`   ${won(c.total)}${v.discountPct != null ? ` · 평소보다 ${v.discountPct}% 저렴` : ""}`);
    L.push(`   ${c.outbound?.departAt?.slice(0, 10) ?? "?"} 출발 · ${tripLabel(item)}`);
    L.push(`   경유 ${c.outbound?.stops ?? "미확인"}회(가는 편) · 판정 신뢰도 ${kor(v.confidence)} · 표본 ${v.sampleSize ?? 0}건`);
    if (item.alertDecision?.kind === "cheaper") L.push(`   ${item.alertDecision.reason}`);
    const link = (c.links ?? [])[0]?.url;
    if (link) L.push(`   실제 가격 확인 → ${link}`);
    L.push("");
  }

  if (siteUrl) L.push(`전체 목록: ${siteUrl}`);
  return L.join("\n");
}

/** 체류 기간 표시 (같은 값으로 여러 날짜를 고를 수 있으면 범위로) */
function tripLabel(item) {
  if (item.tripDaysRange) return `체류 ${item.tripDaysRange[0]}~${item.tripDaysRange[1]}일 중 선택`;
  return `체류 ${item.candidate.tripDays ?? "?"}일`;
}

const won = (n) => (typeof n === "number" ? `${n.toLocaleString("ko-KR")}원` : "가격 미확인");
const kor = (c) => ({ high: "높음", medium: "보통", low: "낮음", none: "없음" }[c] ?? String(c));

/** 알림 대상을 파일로 남깁니다 (워크플로우가 읽어 GitHub 이슈로 올립니다). */
export function writeAlertsFile(alerts, dir, { siteUrl = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "alerts.json");
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: alerts.length,
    text: renderAlertText(alerts, { siteUrl }),
    items: alerts.map((i) => ({
      signature: i.signature,
      destination: i.candidate.destIn,
      destinationName: cityName(i.candidate.destIn),
      total: i.candidate.total,
      departureDate: i.candidate.outbound?.departAt?.slice(0, 10) ?? null,
      tripDays: i.candidate.tripDays,
      discountPct: i.verdict.discountPct,
      confidence: i.verdict.confidence,
      priceType: i.candidate.priceType,
      kind: i.alertDecision?.kind ?? null,
      link: (i.candidate.links ?? [])[0]?.url ?? null,
    })),
  }, null, 2));
  return file;
}
