/* 医学术语背单词 · 离线缓存
   首次联网打开后，页面、样式、脚本、词库都会被存到本机，
   之后没网也能正常背单词（进度本来就存在本机）。 */
const CACHE = 'medvocab-v31';   // 每次发布新版本改这里，旧缓存会自动清掉

const CORE = [
  './',
  './terms.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png',
];

/* 从 HTML 里找出它引用的脚本 / 样式 / 图标 */
function assetUrls(html) {
  const urls = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+\.(?:js|css|png|json|webmanifest)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { urls.add(new URL(m[1], self.registration.scope).href); } catch (e) { /* 忽略非法地址 */ }
  }
  return urls;
}

async function putAll(cache, urls) {
  await Promise.all([...urls].map(u =>
    cache.add(new Request(u, { cache: 'reload' })).catch(() => { /* 单个失败不影响整体 */ })
  ));
}

/* 预缓存：固定清单 + index.html 里引用的资源，
   让「缓存下来的页面」和「缓存下来的脚本」版本始终对得上，断网才能完整打开 */
async function precacheAll(cache) {
  let urls = new Set();
  try {
    const res = await fetch('./', { cache: 'reload' });   // 用站点根路径，避免拿到被缓存过的旧页面
    urls = assetUrls(await res.text());
  } catch (e) { /* 抓不到页面时只缓存固定清单 */ }
  CORE.forEach(u => urls.add(u));
  await putAll(cache, urls);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await precacheAll(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* 页面把自己实际用到的脚本/样式报过来（首次打开就断网也不缺文件） */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type !== 'cache-urls' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(data.urls.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => { /* 忽略单个失败 */ })
    ));
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let origin;
  try { origin = new URL(req.url).origin; } catch (e) { return; }
  if (origin !== self.location.origin) return;

  // 打开页面：联网优先（保证拿到最新版本）；断网时用缓存离线打开
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        // 存下这次真正打开的那份 HTML，并把它的脚本/样式一起存好（两份版本永远一致）
        const htmlPromise = res.clone().text();
        event.waitUntil(
          cache.put('./', res.clone())
            .then(() => htmlPromise)
            .then(html => putAll(cache, new Set([...assetUrls(html), ...CORE])))
            .catch(() => {})
        );
        return res;
      } catch (err) {
        return (await caches.match('./'))
          || (await caches.match('./index.html'))
          || Response.error();
      }
    })());
    return;
  }

  // 脚本 / 样式：联网优先，保证「改了代码、刷新就能看到新版本」；断网时用缓存
  if (/\.(?:js|css)(?:\?|$)/i.test(req.url)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        return (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // 其它资源：先用缓存（秒开、离线可用），后台顺手更新
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) {
      fetch(req)
        .then(res => { if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {}); })
        .catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      return (await caches.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
