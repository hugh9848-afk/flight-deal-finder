// 도시와 도시 사이 육로/저가항공 이동을 '어림잡아' 계산합니다.
// 중요: 실제 요금 조회 API 가 아니라 거리로 짐작한 값입니다.
// 그래서 결과에는 항상 estimated: true 도장이 찍히고, 화면에도 '추정'으로 표시됩니다.
import { findAirport } from "../../config/destinations.js";

/** 지구 위 두 지점 사이 직선거리(km). */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// 거리 구간별 어림값. [최대km, 원, 시간, 수단]
const TIERS = [
  [150,  20000, 2.0, "기차/버스"],
  [400,  55000, 4.5, "기차/버스"],
  [900, 100000, 5.5, "저가항공 또는 야간기차"],
  [1800, 140000, 6.5, "저가항공"],
  [2500, 190000, 8.0, "저가항공"],
];

/**
 * 두 공항 사이 이동을 어림잡습니다.
 * @returns {{fromIata,toIata,km,estCostKRW,estHours,mode,estimated:true}|null}
 *          너무 멀거나 대륙이 다르면 null (= 미확인, 육로 연결 불가로 봅니다)
 */
export function estimateGround(fromIata, toIata) {
  if (!fromIata || !toIata || fromIata === toIata) return null;
  const a = findAirport(fromIata), b = findAirport(toIata);
  if (!a || !b) return null;

  // 대륙(지역)이 다르면 육로로 이어붙이지 않습니다.
  if (a.region !== b.region) return null;

  const km = haversineKm(a, b);
  const tier = TIERS.find(([maxKm]) => km <= maxKm);
  if (!tier) return null; // 2500km 넘으면 오픈조 후보로 삼지 않습니다

  const [, cost, hours, mode] = tier;
  return {
    fromIata, toIata,
    fromCity: a.city, toCity: b.city,
    km,
    estCostKRW: cost,
    estHours: hours,
    mode,
    estimated: true,
    note: "실제 요금 조회가 아니라 거리로 짐작한 값입니다. 예약 전 반드시 직접 확인하세요.",
  };
}

/**
 * 오픈조를 만들 수 있는 도시 짝을 찾습니다.
 * (같은 지역 안에서 2500km 이내인 곳끼리만)
 */
export function findOpenJawPartners(iata, pool, { maxKm = 2500, limit = 8 } = {}) {
  const a = findAirport(iata);
  if (!a) return [];
  return pool
    .filter((d) => d.iata !== iata && d.region === a.region)
    .map((d) => ({ ...d, km: haversineKm(a, d) }))
    .filter((d) => d.km <= maxKm)
    .sort((x, y) => x.km - y.km)
    .slice(0, limit);
}
