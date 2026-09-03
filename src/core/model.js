// 어느 데이터 회사에서 받아오든 항상 이 서식으로 옮겨 적습니다.
// 확인하지 못한 값은 반드시 null 로 두고 unknown 목록에 이름을 남깁니다.
import { createHash } from "node:crypto";

/** 가격의 신뢰 수준 */
export const PRICE_TYPE = {
  INDICATIVE: "indicative", // 캐시/참고가 — 실제로 살 수 있다는 보장 없음
  LIVE: "live",             // 실시간 조회 결과
  CONFIRMED: "confirmed",   // 총액·수하물·규정까지 재확인한 값
};

/** 비어 있는 후보 한 장(양식지)을 만듭니다. */
export function makeCandidate(input) {
  const c = {
    id: null,
    source: input.source,                 // 어디서 받아온 자료인지
    priceType: input.priceType,           // indicative / live / confirmed
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    priceValidUntil: input.priceValidUntil ?? null,

    currency: input.currency ?? "KRW",
    total: nz(input.total),               // 왕복 총액
    base: nz(input.base),                 // 항공료만
    taxes: nz(input.taxes),               // 세금 + 수수료

    outbound: input.outbound ?? null,     // 가는 편 (아래 makeLeg 서식)
    inbound: input.inbound ?? null,       // 오는 편 (편도만이면 null)

    originOut: input.originOut ?? null,   // 출국 출발 공항 (보통 ICN)
    destIn: input.destIn ?? null,         // 입국(도착) 도시 공항
    destOut: input.destOut ?? null,       // 귀국편 출발 공항 (오픈조면 destIn 과 다름)
    tripDays: nz(input.tripDays),

    openJaw: input.openJaw ?? false,          // 들어간 도시 ≠ 나오는 도시
    separateTickets: input.separateTickets ?? false, // 별도 발권 위험
    selfTransfer: input.selfTransfer ?? null,        // 자가환승 여부
    airportChange: input.airportChange ?? null,      // 경유 중 공항 변경

    baggage: input.baggage ?? null,       // { cabinKg, checkedPieces, checkedKg }
    fareRules: input.fareRules ?? null,   // { changeFeeKRW, refundable, conflict }
    seatsLeft: nz(input.seatsLeft),

    ground: input.ground ?? null,         // 도시 간 육로 이동 (추정치 표시 포함)
    links: input.links ?? [],             // 확인/구매 링크

    unknown: [],                          // 확인 못 한 항목 이름들
    notes: input.notes ?? [],
  };

  // 아직 모르는 항목을 자동으로 표시해 둡니다.
  for (const key of ["total", "taxes", "baggage", "fareRules", "selfTransfer", "airportChange"]) {
    if (c[key] === null || c[key] === undefined) c.unknown.push(key);
  }

  c.id = candidateId(c);
  return c;
}

/** 한쪽 방향(가는 편 또는 오는 편) 서식 */
export function makeLeg({ from, to, departAt, arriveAt, durationMin, segments = [] }) {
  return {
    from,
    to,
    departAt: departAt ?? null,
    arriveAt: arriveAt ?? null,
    durationMin: nz(durationMin),         // 문 앞에서 문 앞까지 총 이동 분
    // 구간 정보가 아예 없으면 경유 횟수를 '모른다(null)'로 둡니다.
    // 0 으로 적으면 '직항'이라고 단정하는 셈이라 사실과 다를 수 있습니다.
    stops: segments.length ? segments.length - 1 : null,
    segments,                             // [{ carrier, number, from, to, departAt, arriveAt, durationMin, layoverMin }]
    layovers: segments
      .map((s) => s.layoverMin)
      .filter((m) => typeof m === "number" && m > 0),
  };
}

/**
 * 같은 일정이면 항상 같은 id 가 나오도록 만듭니다.
 * (가격은 빼고 노선·날짜·항공사만 씁니다 → 가격만 바뀌면 같은 후보로 인식)
 */
export function candidateId(c) {
  const key = [
    c.originOut,
    c.destIn,
    c.destOut,
    c.outbound?.departAt?.slice(0, 10),
    c.inbound?.departAt?.slice(0, 10),
    (c.outbound?.segments ?? []).map((s) => s.carrier).join(","),
    (c.inbound?.segments ?? []).map((s) => s.carrier).join(","),
  ].join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/** 숫자가 아니면 null 로. (0은 살립니다) */
function nz(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 두 화면의 값이 어긋나면 '확인 필요'로 표시합니다. */
export function markConflict(candidate, field, a, b) {
  candidate.fareRules = candidate.fareRules ?? {};
  candidate.fareRules.conflict = true;
  candidate.notes.push(`확인 필요: ${field} 값이 화면마다 다름 (${a} vs ${b})`);
  if (!candidate.unknown.includes(field)) candidate.unknown.push(field);
  return candidate;
}
