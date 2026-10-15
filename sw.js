/* Service Worker —— 让 App 离线也能用
   策略：安装时把静态文件全部缓存；之后优先走缓存，后台悄悄更新。 */
var CACHE = "fitness-v8";
var ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* AI 那两个大文件（tf.min.js 1.5MB + weights.bin 16.2MB）单独走一条路：
     只在本地没有时才去网上拿，拿到就存下来，以后永远不回源。
     照下面的通用分支走的话，每次打开 App 都会在后台把 17.7MB 重下一遍。 */
  if (/\/model\/|\/tf\.min\.js$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === "basic") {
            var c2 = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, c2); });
          }
          return res;
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit || caches.match("./index.html");
      });
      return hit || net;
    })
  );
});
