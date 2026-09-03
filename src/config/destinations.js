// 도착 후보 공항 목록.
// 한 줄 = 공항코드|도시|나라|지역|위도|경도
// 좌표는 공항 위치(공개 정보)이며, 도시 사이 육로 거리를 어림잡는 데만 씁니다.
const TABLE = `
# ---- 서유럽 ----
LHR|런던|영국|europe|51.47|-0.45
LGW|런던|영국|europe|51.15|-0.18
MAN|맨체스터|영국|europe|53.35|-2.28
EDI|에든버러|영국|europe|55.95|-3.37
DUB|더블린|아일랜드|europe|53.43|-6.27
CDG|파리|프랑스|europe|49.01|2.55
ORY|파리|프랑스|europe|48.73|2.36
NCE|니스|프랑스|europe|43.66|7.21
LYS|리옹|프랑스|europe|45.73|5.09
MRS|마르세유|프랑스|europe|43.44|5.22
TLS|툴루즈|프랑스|europe|43.63|1.37
AMS|암스테르담|네덜란드|europe|52.31|4.76
BRU|브뤼셀|벨기에|europe|50.90|4.48
FRA|프랑크푸르트|독일|europe|50.03|8.56
MUC|뮌헨|독일|europe|48.35|11.79
BER|베를린|독일|europe|52.37|13.50
HAM|함부르크|독일|europe|53.63|10.01
DUS|뒤셀도르프|독일|europe|51.29|6.77
ZRH|취리히|스위스|europe|47.46|8.55
GVA|제네바|스위스|europe|46.24|6.11
VIE|빈|오스트리아|europe|48.11|16.57
# ---- 남유럽 ----
MAD|마드리드|스페인|europe|40.47|-3.56
BCN|바르셀로나|스페인|europe|41.30|2.08
AGP|말라가|스페인|europe|36.68|-4.50
VLC|발렌시아|스페인|europe|39.49|-0.48
SVQ|세비야|스페인|europe|37.42|-5.90
PMI|팔마|스페인|europe|39.55|2.74
LIS|리스본|포르투갈|europe|38.77|-9.13
OPO|포르투|포르투갈|europe|41.24|-8.68
FCO|로마|이탈리아|europe|41.80|12.25
MXP|밀라노|이탈리아|europe|45.63|8.72
VCE|베네치아|이탈리아|europe|45.51|12.35
NAP|나폴리|이탈리아|europe|40.88|14.29
BLQ|볼로냐|이탈리아|europe|44.53|11.30
FLR|피렌체|이탈리아|europe|43.81|11.20
TRN|토리노|이탈리아|europe|45.20|7.65
CTA|카타니아|이탈리아|europe|37.47|15.07
PMO|팔레르모|이탈리아|europe|38.18|13.09
MLA|몰타|몰타|europe|35.86|14.48
ATH|아테네|그리스|europe|37.94|23.95
LCA|라르나카|키프로스|europe|34.88|33.63
# ---- 중·동유럽 / 발칸 ----
PRG|프라하|체코|europe|50.10|14.26
WAW|바르샤바|폴란드|europe|52.17|20.97
KRK|크라쿠프|폴란드|europe|50.08|19.79
BUD|부다페스트|헝가리|europe|47.44|19.26
OTP|부쿠레슈티|루마니아|europe|44.57|26.10
SOF|소피아|불가리아|europe|42.69|23.41
ZAG|자그레브|크로아티아|europe|45.74|16.07
SPU|스플리트|크로아티아|europe|43.54|16.30
DBV|두브로브니크|크로아티아|europe|42.56|18.27
LJU|류블랴나|슬로베니아|europe|46.22|14.46
BEG|베오그라드|세르비아|europe|44.82|20.29
SKP|스코페|북마케도니아|europe|41.96|21.62
TIA|티라나|알바니아|europe|41.41|19.72
SJJ|사라예보|보스니아|europe|43.82|18.33
# ---- 북유럽 / 발트 ----
CPH|코펜하겐|덴마크|europe|55.62|12.66
ARN|스톡홀름|스웨덴|europe|59.65|17.92
GOT|예테보리|스웨덴|europe|57.66|12.29
OSL|오슬로|노르웨이|europe|60.19|11.10
BGO|베르겐|노르웨이|europe|60.29|5.22
HEL|헬싱키|핀란드|europe|60.32|24.96
KEF|레이캬비크|아이슬란드|europe|63.99|-22.61
RIX|리가|라트비아|europe|56.92|23.97
VNO|빌뉴스|리투아니아|europe|54.64|25.28
TLL|탈린|에스토니아|europe|59.41|24.83
# ---- 튀르키예 / 캅카스(조지아 포함) ----
IST|이스탄불|튀르키예|europe|41.28|28.75
SAW|이스탄불|튀르키예|europe|40.90|29.31
TBS|트빌리시|조지아|caucasus|41.67|44.95
BUS|바투미|조지아|caucasus|41.61|41.60
KUT|쿠타이시|조지아|caucasus|42.18|42.48
EVN|예레반|아르메니아|caucasus|40.15|44.40
GYD|바쿠|아제르바이잔|caucasus|40.47|50.05
# ---- 몽골 ----
UBN|울란바토르|몽골|mongolia|47.65|106.82
# ---- 북아프리카 ----
CAI|카이로|이집트|africa|30.11|31.41
HRG|후르가다|이집트|africa|27.18|33.80
SSH|샤름엘셰이크|이집트|africa|27.98|34.39
CMN|카사블랑카|모로코|africa|33.37|-7.59
RAK|마라케시|모로코|africa|31.61|-8.04
FEZ|페스|모로코|africa|33.93|-4.98
TUN|튀니스|튀니지|africa|36.85|10.23
ALG|알제|알제리|africa|36.69|3.22
# ---- 동·서·남아프리카 ----
ADD|아디스아바바|에티오피아|africa|8.98|38.80
NBO|나이로비|케냐|africa|-1.32|36.93
JRO|킬리만자로|탄자니아|africa|-3.43|37.07
ZNZ|잔지바르|탄자니아|africa|-6.22|39.22
DAR|다르에스살람|탄자니아|africa|-6.87|39.20
JNB|요하네스버그|남아공|africa|-26.13|28.24
CPT|케이프타운|남아공|africa|-33.97|18.60
VFA|빅토리아폴스|짐바브웨|africa|-18.10|25.84
WDH|빈트후크|나미비아|africa|-22.48|17.47
LOS|라고스|나이지리아|africa|6.58|3.32
ACC|아크라|가나|africa|5.61|-0.17
DKR|다카르|세네갈|africa|14.67|-17.07
MRU|모리셔스|모리셔스|africa|-20.43|57.68
SEZ|세이셸|세이셸|africa|-4.67|55.52
`;

// 위 표를 프로그램이 다루기 쉬운 목록으로 바꿔줍니다.
// (주석줄 '#'과 빈 줄은 건너뜁니다)
export const DESTINATIONS = TABLE.split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [iata, city, country, region, lat, lon] = line.split("|");
    return {
      iata,
      city,
      country,
      region,
      lat: Number(lat),
      lon: Number(lon),
    };
  });

export const ORIGIN = "ICN";

/**
 * 한 도시에 공항이 여러 개면 API 가 '도시코드'로 묶어서 돌려줍니다.
 * (예: CDG 로 물어도 PAR 로 답이 옵니다)
 * 실제 응답을 보고 확인한 것만 적었습니다.
 */
const CITY_CODE = {
  LHR: "LON", LGW: "LON",   // 런던
  CDG: "PAR", ORY: "PAR",   // 파리
  FCO: "ROM",               // 로마
  MXP: "MIL",               // 밀라노
  ARN: "STO",               // 스톡홀름
  SAW: "IST",               // 이스탄불
  GYD: "BAK",               // 바쿠
};

// 각 공항에 도시코드를 붙여 둡니다 (없으면 공항코드가 곧 도시코드).
for (const d of DESTINATIONS) {
  d.city_code = CITY_CODE[d.iata] ?? d.iata;
}

// 공항코드로도, 도시코드로도 찾을 수 있게 색인을 만듭니다.
const INDEX = new Map();
for (const d of DESTINATIONS) {
  INDEX.set(d.iata, d);
  if (!INDEX.has(d.city_code)) INDEX.set(d.city_code, d);
}

/**
 * 도시코드 기준으로 중복을 없앤 목록.
 * 런던을 LHR·LGW 두 번 조회할 필요가 없으므로 조회할 때 이걸 씁니다.
 */
export function uniqueByCity(list = DESTINATIONS) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (seen.has(d.city_code)) continue;
    seen.add(d.city_code);
    out.push(d);
  }
  return out;
}

/** 지역 이름으로 목적지를 골라냅니다. regions 가 비어 있으면 전부 돌려줍니다. */
export function pickDestinations(regions = []) {
  if (!regions.length) return DESTINATIONS;
  return DESTINATIONS.filter((d) => regions.includes(d.region));
}

/**
 * 이 공항까지 경유 몇 번까지 받아들일지 정합니다.
 * 지역별 예외가 있으면 그 값을, 없으면 기본값을 씁니다.
 */
export function maxStopsFor(iata, settings) {
  const region = findAirport(iata)?.region;
  const byRegion = settings?.maxStopsByRegion ?? {};
  return byRegion[region] ?? settings?.maxStops ?? 1;
}

/**
 * 공항코드 또는 도시코드로 한 곳을 찾습니다. 없으면 undefined.
 * API 가 PAR 로 답해도 CDG 항목을 찾아낼 수 있어야 합니다.
 */
export function findAirport(code) {
  return INDEX.get(code);
}
