// Craft Hub service worker: installable app + offline use.
//
// The build (scripts/fetch-apps.sh) fills in BUILD (changes with every hub or app change) and
// VERSIONS (the app versions in this deploy).
//
// Caches:
//   crafthub-shell-<BUILD>       the hub page, manifest and icons (small, refreshed every build)
//   crafthub-<app>-<version>     one app's files, kept across hub-only deploys and dropped when
//                                that app's version changes
// EffectCraft ships its own service worker for /effectcraft/, which serves that folder itself.
const BUILD = "__BUILD__";
const VERSIONS = __VERSIONS__;
const SHELL = `crafthub-shell-${BUILD}`;
const SHELL_FILES = [
  "./", "./ai.js", "./ai/lightcraft-commands.json", "./manifest.webmanifest", "./versions.json", "./offline.json",
  "./icons/hub-192.png", "./icons/hub-512.png", "./icons/hub-maskable-512.png",
  "./icons/favicon-32.png", "./icons/apple-touch-icon.png",
  "./icons/photocraft.png", "./icons/filmcraft.png", "./icons/lightcraft.png", "./icons/effectcraft.png",
];
const SELF_SW_APPS = ["effectcraft"];
const appCache = (app) => `crafthub-${app}-${VERSIONS[app]}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL, ...Object.keys(VERSIONS).map(appCache)]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("crafthub-") && !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Which app folder a same-origin path belongs to, or null for the hub.
function appOf(pathname) {
  const scope = new URL(self.registration.scope).pathname;
  if (!pathname.startsWith(scope)) return null;
  const first = pathname.slice(scope.length).split("/")[0];
  return Object.prototype.hasOwnProperty.call(VERSIONS, first) ? first : null;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.headers.has("range")) return; // media seeking: leave to the network / app
  const app = appOf(url.pathname);
  if (app && SELF_SW_APPS.includes(app)) return;
  if (url.pathname.endsWith("-config.json")) return; // app config files must stay live

  if (!app) {
    // Hub: network first (so hub updates show up), cache when offline.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") cache.put(req.mode === "navigate" ? "./" : req, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        const hit = await cache.match(req.mode === "navigate" ? "./" : req, { ignoreSearch: true });
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // App files: their versioned cache first (file names repeat between releases, but the cache
  // name carries the version), then the network, caching what comes back.
  event.respondWith((async () => {
    const cache = await caches.open(appCache(app));
    const key = url.origin + url.pathname; // ignore ?v=…, ?webgl and the like
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.status === 200 && res.type === "basic") cache.put(key, res.clone()).catch(() => {});
    return res;
  })());
});
