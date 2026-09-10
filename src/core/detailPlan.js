// 가격 없는 지역도 직접 조회하도록 별도 검색 계획을 만듭니다.
// query 는 검색 조건일 뿐이며 후보·가격 이력·특가 목록에 넣지 않습니다.
export function planDetails(ranked, { cap, destinations, departFrom, departTo, today,
  minTripDays, maxTripDays, emptyRegionShare = 0.3 } = {}) {
  const key = (x) => `${x.candidate.destIn}|${x.candidate.outbound?.departAt?.slice(0, 10)}|${x.candidate.inbound?.departAt?.slice(0, 10)}`;
  const seen = new Set();
  const unique = ranked.filter((x) => {
    const c = x.candidate;
    if (!c.outbound?.departAt || !c.inbound?.departAt) return false;
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const africa = destinations.filter((d) => d.region === "africa");
  const forThin = africa.length ? Math.round(cap * emptyRegionShare) : 0;
  const top = unique.slice(0, cap - forThin);
  const priced = new Set(unique.map((x) => x.candidate.destIn));
  const empty = africa.filter((d) => !priced.has(d.iata));
  const rotation = Math.floor(Date.parse(String(today.toISOString()).slice(0, 10)) / 86400000 / 3);
  const offset = empty.length ? (rotation * Math.max(1, forThin)) % empty.length : 0;
  const pool = [...empty.slice(offset), ...empty.slice(0, offset)];
  const daysInWindow = Math.floor((Date.parse(departTo) - Date.parse(departFrom)) / 86400000) + 1;
  const thin = pool.slice(0, forThin).map((d, i) => {
    const departure = Date.parse(departFrom) + ((rotation * 11 + i * 29) % daysInWindow) * 86400000;
    // 귀국 출발일은 어림값입니다. 실제 ICN 도착일은 상세 응답에서 판정합니다.
    const tripDays = minTripDays + ((rotation + i * 3) % (maxTripDays - minTripDays + 1));
    return { query: { destination: d.iata,
      departureDate: new Date(departure).toISOString().slice(0, 10),
      returnDate: new Date(departure + (tripDays - 1) * 86400000).toISOString().slice(0, 10) },
      reason: "아프리카 캐시 공백 직접 조회" };
  });
  const selected = new Set(top.map(key));
  const remaining = unique.filter((x) => !selected.has(key(x)));
  const africaCodes = new Set(africa.map((d) => d.iata));
  const preferred = remaining.filter((x) => africaCodes.has(x.candidate.destIn));
  for (const x of [...preferred, ...remaining]) {
    if (top.length + thin.length >= cap) break;
    if (selected.has(key(x))) continue;
    thin.push(x); selected.add(key(x));
  }
  return { items: [...top, ...thin], plan: { cap, reservedForThin: forThin,
    directQueries: thin.filter((x) => x.query).length, rotation } };
}
