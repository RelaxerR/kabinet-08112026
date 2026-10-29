// Нужен, чтобы страница открывалась и без интернета (например, в дороге): сеть в приоритете, кэш как запасной вариант.
const CACHE = "kabinet-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.includes("/media/")) return;
  e.respondWith(
    fetch(r)
      .then((res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(r, c)); } return res; })
      .catch(() => caches.match(r, { ignoreSearch: true }))
  );
});
