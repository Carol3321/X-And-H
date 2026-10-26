// 只缓存 MediaPipe 那两个大文件：模型重新加载时秒开，其它请求完全不拦
const CACHE = 'mp-assets-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const hit = url.pathname.includes('/assets/wasm/') || url.pathname.endsWith('hand_landmarker.task');
  if (!hit) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    if (cached) return cached;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  })());
});
