// 알림 보내기.
// 지금 확실히 되는 두 가지만 씁니다.
//   1) 요약문을 파일로 남긴다 (web/data/summary.txt) — 항상 동작
//   2) 웹훅 주소가 설정돼 있으면 그리로 보낸다 — 선택
// 카카오톡 '나에게 보내기'는 클로드 세션에서 이 요약문을 읽어 전달하는 방식입니다.
import fs from "node:fs";
import path from "node:path";

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

/** 알림 대상만 골라 짧은 문구로 만듭니다. */
export function renderAlertText(alerts) {
  if (!alerts.length) return "새로 알릴 특가가 없습니다.";
  const L = [`✈️ 새 특가 ${alerts.length}건`];
  for (const item of alerts) {
    const c = item.candidate;
    const d = item.verdict.discountPct;
    L.push(
      `· ${c.destIn}${c.openJaw ? `/${c.destOut}` : ""} ${c.tripDays}일 ` +
      `${c.total?.toLocaleString("ko-KR")}원` +
      `${d !== null ? ` (평소 대비 -${d}%)` : ""} ` +
      `${c.outbound?.departAt?.slice(0, 10) ?? ""} 출발 · ${item.alertDecision?.kind === "cheaper" ? "가격 하락" : "신규"}`
    );
  }
  return L.join("\n");
}
