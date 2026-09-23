const CACHE='papercut-site-v1';
const URLS=['./','./index.html','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(URLS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method==='GET'&&url.origin===location.origin&&!url.pathname.includes('/api/'))event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));});
