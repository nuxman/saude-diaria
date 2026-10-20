// Mude a versão a cada publicação para os aparelhos trocarem o cache.
const CACHE = 'saude-v1';
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const FILES = ['./', 'index.html', 'config.js', 'sync.js', 'db.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', SUPABASE_JS];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// Rede primeiro (pega atualização), cache se offline. Chamadas à API do Supabase não passam pelo cache.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('.supabase.co')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })
    .then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
