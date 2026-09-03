// 오프라인 도우미.
//
// 규칙:
//   화면(HTML) — 먼저 새로 받아보고, 인터넷이 안 되면 저장해둔 걸 씁니다.
//                (캐시 우선으로 하면 새로 배포해도 옛 화면이 계속 나옵니다)
//   결과 자료(deals.json) — 항상 새로 받습니다. 저장하지 않습니다.
//   나머지 — 저장해둔 게 있으면 그걸 씁니다.
const CACHE = "fdf-v2";
const SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 결과 자료는 손대지 않습니다 (항상 최신을 봐야 합니다)
  if (url.pathname.endsWith("deals.json") || url.pathname.endsWith("summary.txt")) return;

  const isPage = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/");
  if (isPage) {
    // 화면: 새로 받기 → 실패하면 저장해둔 것
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r ?? caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(caches.match(req).then((r) => r ?? fetch(req)));
});
