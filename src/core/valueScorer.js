// 값만 보지 않고 '실제로 좋은 여행인가'를 0~100점으로 채점합니다.
// 조금 비싸도 이동시간이 훨씬 짧거나 위험이 적으면 점수가 높게 나옵니다.

const WEIGHTS = {
  price: 40,     // 얼마나 싼가
  time: 20,      // 총 이동시간이 짧은가
  layover: 12,   // 경유 대기가 적당한가
  risk: 16,      // 자가환승·별도발권·공항변경 같은 위험이 없는가
  baggage: 6,    // 위탁수하물이 포함인가
  stay: 6,       // 실제로 놀 수 있는 날이 충분한가
};

/**
 * @param {object} c            후보
 * @param {object} verdict      dealDetector 결과
 * @returns {{score, breakdown, warnings, totalTripCostKRW, usableDays}}
 */
export function scoreCandidate(c, verdict = {}) {
  const warnings = [];
  const b = {};

  // --- 1. 가격 점수: 평소보다 몇 % 싼가 (0%면 50점, 40% 싸면 100점) ---
  const d = verdict.discountPct;
  b.price = d === null || d === undefined
    ? 50
    : clamp(50 + d * 1.25, 0, 100);
  // 이력 없이 줄 세우기로만 판정했으면 점수를 조금 깎습니다 (덜 믿음직하니까)
  if (verdict.method === "cohort") b.price *= 0.85;
  if (verdict.method === "none") b.price = 40;

  // --- 2. 이동시간 점수: 편도 12시간이면 만점, 30시간이면 0점 ---
  const outMin = c.outbound?.durationMin ?? null;
  const inMin = c.inbound?.durationMin ?? null;
  const legs = [outMin, inMin].filter((m) => typeof m === "number");
  if (legs.length) {
    const avgH = legs.reduce((a, x) => a + x, 0) / legs.length / 60;
    b.time = clamp(100 - (avgH - 12) * (100 / 18), 0, 100);
    if (avgH > 24) warnings.push(`편도 평균 이동시간이 ${avgH.toFixed(1)}시간으로 깁니다`);
  } else {
    b.time = 50;
    warnings.push("이동시간 미확인");
  }

  // --- 3. 경유 대기 점수 ---
  const layovers = [...(c.outbound?.layovers ?? []), ...(c.inbound?.layovers ?? [])];
  if (layovers.length) {
    let s = 100;
    for (const m of layovers) {
      if (m < 75) { s -= 45; warnings.push(`경유 대기 ${m}분 — 놓칠 위험이 큽니다`); }
      else if (m < 100) { s -= 20; warnings.push(`경유 대기 ${m}분 — 빠듯합니다`); }
      else if (m > 600) { s -= 30; warnings.push(`경유 대기 ${Math.round(m / 60)}시간 — 숙박이 필요할 수 있습니다`); }
      else if (m > 360) { s -= 12; }
    }
    b.layover = clamp(s, 0, 100);
  } else {
    b.layover = c.outbound?.stops === 0 ? 100 : 60;
  }

  // --- 4. 위험 점수: 문제가 있을 때마다 깎습니다 ---
  let risk = 100;
  if (c.selfTransfer === true) { risk -= 40; warnings.push("자가환승 — 짐을 직접 찾아 다시 부쳐야 합니다"); }
  if (c.separateTickets === true) { risk -= 30; warnings.push("별도 발권 — 앞 비행기가 늦으면 보상받기 어렵습니다"); }
  if (c.airportChange === true) { risk -= 20; warnings.push("경유 중 공항이 바뀝니다"); }
  if (c.fareRules?.conflict === true) { risk -= 50; warnings.push("화면마다 조건이 다릅니다 — 확인 필요"); }
  if (c.selfTransfer === null) { risk -= 8; }
  if (typeof c.seatsLeft === "number" && c.seatsLeft <= 2) warnings.push(`남은 좌석 ${c.seatsLeft}석 — 곧 사라질 수 있습니다`);
  b.risk = clamp(risk, 0, 100);

  // --- 5. 수하물 점수 ---
  const bg = c.baggage;
  if (!bg) { b.baggage = 40; warnings.push("수하물 조건 미확인"); }
  else if ((bg.checkedPieces ?? 0) >= 1 || (bg.checkedKg ?? 0) >= 20) b.baggage = 100;
  else { b.baggage = 25; warnings.push("위탁수하물 미포함 — 추가 요금이 듭니다"); }

  // --- 6. 실제로 놀 수 있는 날 ---
  const travelHours = legs.reduce((a, x) => a + x, 0) / 60;
  const usableDays = c.tripDays !== null && c.tripDays !== undefined
    ? Math.max(0, Math.round((c.tripDays - travelHours / 24) * 10) / 10)
    : null;
  b.stay = usableDays === null ? 50 : clamp((usableDays / 14) * 100, 0, 100);

  // --- 총점: 각 항목에 정해진 무게를 곱해 더합니다 ---
  const score = Math.round(
    Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (b[k] ?? 50) * w, 0) /
    Object.values(WEIGHTS).reduce((a, x) => a + x, 0)
  );

  // 항공료 + 오픈조 육로비 (육로비는 추정치)
  const groundCost = c.ground?.estCostKRW ?? 0;
  const totalTripCostKRW = typeof c.total === "number" ? c.total + groundCost : null;
  if (c.ground?.estimated) {
    warnings.push(`도시 간 이동비 약 ${groundCost.toLocaleString()}원은 거리로 짐작한 추정치입니다`);
  }

  return {
    score,
    breakdown: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])),
    warnings,
    totalTripCostKRW,
    usableDays,
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
