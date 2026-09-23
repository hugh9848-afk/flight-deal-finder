// 가격 없는 지역도 직접 조회하도록 별도 검색 계획을 만듭니다.
// query 는 검색 조건일 뿐이며 후보·가격 이력·특가 목록에 넣지 않습니다.
//
// 참고가가 잘 안 잡히는 지역이 여럿입니다(아프리카·오세아니아).
// 한 지역이 몫을 독차지하지 않도록 **번갈아 나눠 갖게** 합니다.
const THIN_REGIONS = ["africa", "oceania"];

export function planDetails(ranked, { cap, destinations, departFrom, departTo, today,
  minTripDays, maxTripDays, emptyRegionShare = 0.3, thinRegions = THIN_REGIONS } = {}) {
  const key = (x) => `${x.candidate.destIn}|${x.candidate.outbound?.departAt?.slice(0, 10)}|${x.candidate.inbound?.departAt?.slice(0, 10)}`;
  const seen = new Set();
  const unique = ranked.filter((x) => {
    const c = x.candidate;
    if (!c.outbound?.departAt || !c.inbound?.departAt) return false;
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  const priced = new Set(unique.map((x) => x.candidate.destIn));
  const rotation = Math.floor(Date.parse(String(today.toISOString()).slice(0, 10)) / 86400000 / 3);

  // 참고가가 비어 있는 곳만 지역별로 모읍니다. 값이 다 있으면 그 지역 몫은 0입니다.
  const emptyByRegion = thinRegions
    .map((r) => destinations.filter((d) => d.region === r && !priced.has(d.iata)))
    .filter((list) => list.length);

  // 몫이 있는 지역이 하나도 없으면 전부 순위 상위 후보에 돌려줍니다.
  const forThin = emptyByRegion.length ? Math.round(cap * emptyRegionShare) : 0;
  const top = unique.slice(0, cap - forThin);

  // 지역별로 한 칸씩 돌아가며 뽑습니다 (한 지역이 다 가져가지 않게).
  // 각 지역 안에서는 회차마다 시작점을 옮겨 매번 같은 공항만 찌르지 않습니다.
  const rings = emptyByRegion.map((list) => {
    const off = (rotation * Math.max(1, forThin)) % list.length;
    return [...list.slice(off), ...list.slice(0, off)];
  });
  const pool = [];
  for (let i = 0; pool.length < forThin && rings.some((r) => i < r.length); i++) {
    for (const ring of rings) if (i < ring.length && pool.length < forThin) pool.push(ring[i]);
  }
  const daysInWindow = Math.floor((Date.parse(departTo) - Date.parse(departFrom)) / 86400000) + 1;
  const thin = pool.slice(0, forThin).map((d, i) => {
    const departure = Date.parse(departFrom) + ((rotation * 11 + i * 29) % daysInWindow) * 86400000;
    // 귀국 출발일은 어림값입니다. 실제 ICN 도착일은 상세 응답에서 판정합니다.
    const tripDays = minTripDays + ((rotation + i * 3) % (maxTripDays - minTripDays + 1));
    return { query: { destination: d.iata,
      departureDate: new Date(departure).toISOString().slice(0, 10),
      returnDate: new Date(departure + (tripDays - 1) * 86400000).toISOString().slice(0, 10) },
      reason: `${d.region} 캐시 공백 직접 조회` };
  });
  const selected = new Set(top.map(key));
  const remaining = unique.filter((x) => !selected.has(key(x)));
  // 남는 칸은 자료가 부족한 지역 후보에게 먼저 줍니다.
  const thinRegionSet = new Set(thinRegions);
  const preferred = remaining.filter((x) => thinRegionSet.has(
    destinations.find((d) => d.iata === x.candidate.destIn)?.region));
  for (const x of [...preferred, ...remaining]) {
    if (top.length + thin.length >= cap) break;
    if (selected.has(key(x))) continue;
    thin.push(x); selected.add(key(x));
  }
  return { items: [...top, ...thin], plan: { cap, reservedForThin: forThin,
    directQueries: thin.filter((x) => x.query).length, rotation,
    thinRegions: emptyByRegion.map((l) => l[0].region) } };
}
