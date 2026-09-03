// 데이터 공급자(항공권 정보를 주는 회사)들이 지켜야 할 공통 약속.
// 나중에 회사를 바꿔도 이 약속만 지키면 나머지 코드는 그대로 씁니다.
//
//   searchIndicative(params) -> Candidate[]   넓게 훑는 참고가
//   searchLive(params)       -> Candidate[]   실제 조회 운임
//   confirmPrice(candidate)  -> Candidate     총액·수하물·규정 확정
//
// 못 하는 기능은 지원하지 않는다고 알려주면 됩니다.
export class FlightProvider {
  get name() {
    throw new Error("공급자 이름을 정해야 합니다");
  }
  get capabilities() {
    return { indicative: false, live: false, confirm: false, openJaw: false };
  }
  async searchIndicative() {
    throw new Error(`${this.name}: 넓은 탐색을 지원하지 않습니다`);
  }
  async searchLive() {
    throw new Error(`${this.name}: 실시간 조회를 지원하지 않습니다`);
  }
  async confirmPrice(candidate) {
    return candidate; // 확정 기능이 없으면 그대로 돌려줍니다
  }
}
