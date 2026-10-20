// Ponte do app: IndexedDB (persistência local) + Supabase (remoto) + agendamento da sincronização.
import { TABLES, newStore, sync } from './sync.js';

const DB = 'saude-diaria';
const USER_KEY = 'saude-diaria:user';
const WIPE_KEY = 'saude-diaria:wipe';
const req = r => new Promise((ok, err) => { r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });

export const supa = String(window.SUPABASE_URL).includes('SEU-PROJETO') ? null
  : window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

const remote = userId => ({
  async upsert(t, rows) {
    const { error } = await supa.from(t).upsert(rows.map(({ synced_at, ...r }) => r), { onConflict: 'id' });
    if (error) throw error;
  },
  async pull(t, since, limit) {
    const { data, error } = await supa.from(t).select('*').eq('user_id', userId).gte('synced_at', since).order('synced_at').limit(limit);
    if (error) throw error;
    return data;
  },
});

// Usuário deste aparelho: guardado à parte para o app abrir offline mesmo com o token vencido.
export const savedUser = () => localStorage.getItem(USER_KEY);

export async function login(email, password) {
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (savedUser() && savedUser() !== data.user.id) localStorage.setItem(WIPE_KEY, '1'); // outra conta: não mistura dados
  localStorage.setItem(USER_KEY, data.user.id);
  location.reload();
}

export async function logout() {
  try { await supa.auth.signOut(); } catch {}
  localStorage.removeItem(USER_KEY);
  localStorage.setItem(WIPE_KEY, '1');
  location.reload();
}

async function openIDB() {
  if (localStorage.getItem(WIPE_KEY)) { await req(indexedDB.deleteDatabase(DB)); localStorage.removeItem(WIPE_KEY); }
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => {
    for (const t of TABLES) r.result.createObjectStore(t, { keyPath: 'id' });
    r.result.createObjectStore('meta'); // fila e cursores
  };
  return req(r);
}

// on.status({ state: 'ok'|'syncing'|'pending'|'login', pending }) e on.synced(linhasQueMudaram)
export async function openStore(userId, on) {
  const idb = await openIDB();
  const put = (name, v, k) => idb.transaction(name, 'readwrite').objectStore(name).put(v, k);
  const meta = (await req(idb.transaction('meta').objectStore('meta').get(userId))) || { queue: [], cursors: {} };

  let metaSoon = false; // agrupa várias mudanças da fila numa só gravação
  const saveMeta = () => {
    if (metaSoon) return;
    metaSoon = true;
    queueMicrotask(() => { metaSoon = false; put('meta', { queue: [...store.queue], cursors: store.cursors }, userId); });
  };
  const store = newStore({ row: (t, r) => put(t, r), queue: saveMeta, cursor: saveMeta });
  for (const t of TABLES) for (const r of await req(idb.transaction(t).objectStore(t).getAll())) store.rows[t].set(r.id, r);
  meta.queue.forEach(k => store.queue.add(k));
  store.cursors = meta.cursors;

  let running = null, again = false, needLogin = false;
  const status = () => on.status({
    state: running ? 'syncing' : needLogin ? 'login' : store.queue.size ? 'pending' : 'ok',
    pending: store.queue.size,
  });

  store.syncNow = () => {
    if (running) { again = true; return running; }
    if (!navigator.onLine) return status();
    running = (async () => {
      const { data, error } = await supa.auth.getSession();
      if (error) throw error; // falha de rede ao renovar o token: tenta de novo depois
      needLogin = data.session?.user.id !== userId;
      if (needLogin) return;
      const changed = await sync(store, remote(userId), userId);
      await on.synced(changed);
    })().catch(e => console.warn('sync', e)).finally(() => {
      running = null; status();
      if (again) { again = false; store.syncNow(); }
    });
    status();
    return running;
  };
  // chamado pela tela depois de cada alteração local
  store.changed = () => { status(); store.syncNow(); };

  addEventListener('online', store.syncNow);
  addEventListener('offline', status);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.syncNow());
  setInterval(store.syncNow, 2 * 60_000);
  return store;
}
