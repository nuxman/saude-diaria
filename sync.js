// Lógica de sincronização local-first, sem dependência do navegador (testável no Node).
// Estado em memória + "hooks" que persistem cada mudança (IndexedDB no app, nada nos testes).

export const TABLES = ['meds', 'doses', 'glucose', 'bp']; // meds antes de doses (chave estrangeira)
const PAGE = 1000;
const OVERLAP_MS = 60_000; // relê o último minuto: cobre transações que gravaram synced_at antes de outras e confirmaram depois
const noop = () => {};
// Postgres devolve microssegundos (.123456+00:00); corta para milissegundos, que todo navegador entende.
const ms = iso => Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1'));

export function newStore(hooks = {}) {
  return {
    rows: Object.fromEntries(TABLES.map(t => [t, new Map()])),
    queue: new Set(), // chaves "tabela:id" com alterações não enviadas
    cursors: {},      // tabela -> maior synced_at já recebido
    hooks: { row: noop, queue: noop, cursor: noop, ...hooks },
  };
}

function setRow(s, t, row) { s.rows[t].set(row.id, row); s.hooks.row(t, row); }
function setQueued(s, key, on) { on ? s.queue.add(key) : s.queue.delete(key); s.hooks.queue(key, on); }

// Grava localmente e enfileira. updated_at sempre avança, mesmo se o relógio do aparelho voltar.
export function save(s, t, fields, now = new Date()) {
  const old = s.rows[t].get(fields.id);
  const ts = new Date(Math.max(now.getTime(), old ? ms(old.updated_at) + 1 : 0)).toISOString();
  const row = { created_at: ts, deleted_at: null, ...old, ...fields, updated_at: ts };
  setRow(s, t, row);
  setQueued(s, `${t}:${row.id}`, true);
  return row;
}

export const remove = (s, t, id, now = new Date()) => save(s, t, { id, deleted_at: now.toISOString() }, now);

export const live = (s, t) => [...s.rows[t].values()].filter(r => !r.deleted_at);

// Mescla linhas vindas do servidor: vence o updated_at mais recente; empate fica com o local.
// Retorna quantas linhas mudaram localmente.
export function applyRemote(s, t, rows) {
  let n = 0;
  for (const r of rows) {
    const l = s.rows[t].get(r.id);
    if (l && ms(l.updated_at) >= ms(r.updated_at)) continue;
    setRow(s, t, r); n++;
    if (s.queue.has(`${t}:${r.id}`)) setQueued(s, `${t}:${r.id}`, false);
  }
  return n;
}

// remote: { upsert(tabela, linhas), pull(tabela, desdeISO, limite) -> linhas ordenadas por synced_at }
// Retorna quantas linhas vieram do servidor e mudaram algo local.
export async function sync(s, remote, userId) {
  let changed = 0;
  for (const t of TABLES) {
    const keys = [...s.queue].filter(k => k.startsWith(t + ':'));
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500).map(k => s.rows[t].get(k.slice(t.length + 1)));
      await remote.upsert(t, batch.map(r => ({ ...r, user_id: userId })));
      // só sai da fila se não foi editada de novo durante o envio
      for (const r of batch) if (s.rows[t].get(r.id) === r) setQueued(s, `${t}:${r.id}`, false);
    }
  }
  for (const t of TABLES) {
    const start = s.cursors[t] ?? '1970-01-01T00:00:00.000Z';
    let since = new Date(ms(start) - OVERLAP_MS).toISOString();
    let max = start;
    for (;;) {
      const rows = await remote.pull(t, since, PAGE);
      changed += applyRemote(s, t, rows);
      if (!rows.length) break;
      const last = rows.at(-1).synced_at;
      if (ms(last) > ms(max)) max = last;
      // ponytail: paginação por synced_at (gte); clock_timestamp() no servidor torna empates de 1000 linhas impossíveis na prática
      if (rows.length < PAGE || last === since) break;
      since = last;
    }
    if (max !== s.cursors[t]) { s.cursors[t] = max; s.hooks.cursor(t, max); }
  }
  return changed;
}

// uuid determinístico a partir de um texto (mesma entrada = mesmo id em qualquer aparelho).
export async function hashId(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// Dose: id por (remédio, dia), então dois aparelhos marcando offline geram a mesma linha.
export const doseId = (medId, day) => hashId(`${medId}|${day}`);

const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Formato do backup do protótipo (version 1) + updated_at de cada registro. É também o "state" que as telas leem.
// doses_updated_at tem o mesmo formato de doses ({dia: {remédio: updated_at}}), para o protótipo continuar lendo doses.
export function toBackup(s) {
  const doses = {}, doses_updated_at = {};
  for (const d of live(s, 'doses')) {
    (doses[d.day] ||= {})[d.med_id] = hm(new Date(ms(d.taken_at)));
    (doses_updated_at[d.day] ||= {})[d.med_id] = d.updated_at;
  }
  return {
    version: 1,
    meds: live(s, 'meds').sort((a, b) => a.sort - b.sort).map(({ id, name, instr, period, updated_at }) => ({ id, name, instr, period, updated_at })),
    doses, doses_updated_at,
    glucose: live(s, 'glucose').map(e => ({ id: e.id, ts: ms(e.measured_at), value: e.value, moment: e.moment, note: e.note, updated_at: e.updated_at })),
    bp: live(s, 'bp').map(e => ({ id: e.id, ts: ms(e.measured_at), sys: e.systolic, dia: e.diastolic, pulse: e.pulse, note: e.note, updated_at: e.updated_at })),
  };
}

// Junta um backup (ou os dados do protótipo) aos dados atuais, passando pela fila:
// acrescenta o que falta, e quando o registro já existe fica a versão com updated_at mais recente.
// Nunca apaga o que não está no backup. Registro sem updated_at (backup do protótipo) conta como o mais antigo.
// Ids antigos viram uuid fixo por usuário: importar duas vezes, ou em dois aparelhos, não duplica.
// Retorna quantos registros foram acrescentados ou atualizados.
export async function importBackup(s, userId, d, now = new Date()) {
  const idFor = (kind, id) => UUID.test(id) ? id : hashId(`${userId}|${kind}|${id}`);
  const iso = ts => new Date(ts).toISOString(); // lança erro se a data for inválida
  const stamp = v => v == null ? iso(0) : iso(ms(v));
  const out = [], medIds = {};
  for (const [i, m] of d.meds.entries())
    out.push(['meds', { id: medIds[m.id] = await idFor('med', String(m.id)), name: String(m.name), instr: m.instr || '', period: m.period || 'livre', sort: i, deleted_at: null, updated_at: stamp(m.updated_at) }]);
  for (const [day, taken] of Object.entries(d.doses)) for (const [mid, time] of Object.entries(taken)) {
    let med_id = medIds[mid];
    if (!med_id) { // dose de um remédio já removido da lista: recria o remédio como excluído para o histórico ter a referência
      med_id = medIds[mid] = await idFor('med', mid);
      out.push(['meds', { id: med_id, name: 'Remédio removido', instr: '', period: 'livre', sort: 999, deleted_at: iso(0), updated_at: iso(0) }]);
    }
    const [y, mo, dd] = day.split('-').map(Number), [hh, mm] = String(time).split(':').map(Number);
    out.push(['doses', { id: await doseId(med_id, day), med_id, day, taken_at: iso(new Date(y, mo - 1, dd, hh || 0, mm || 0)), deleted_at: null,
      updated_at: stamp(d.doses_updated_at?.[day]?.[mid]) }]);
  }
  for (const e of d.glucose)
    out.push(['glucose', { id: await idFor('glucose', String(e.id)), value: Math.round(e.value), moment: e.moment || '', note: e.note || '', measured_at: iso(e.ts), deleted_at: null, updated_at: stamp(e.updated_at) }]);
  for (const e of d.bp)
    out.push(['bp', { id: await idFor('bp', String(e.id)), systolic: Math.round(e.sys), diastolic: Math.round(e.dia), pulse: e.pulse ?? null, note: e.note || '', measured_at: iso(e.ts), deleted_at: null, updated_at: stamp(e.updated_at) }]);
  let n = 0;
  for (const [t, row] of out) { // só grava depois de validar tudo
    const l = s.rows[t].get(row.id);
    if (l && ms(l.updated_at) >= ms(row.updated_at)) continue; // o daqui é igual ou mais novo
    // mantém o updated_at do backup: o servidor também descarta a versão mais antiga
    setRow(s, t, { ...row, created_at: l?.created_at ?? now.toISOString() });
    setQueued(s, `${t}:${row.id}`, true);
    n++;
  }
  return n;
}

export async function toggleDose(s, medId, day, now = new Date()) {
  const id = await doseId(medId, day);
  const cur = s.rows.doses.get(id);
  return cur && !cur.deleted_at
    ? remove(s, 'doses', id, now)
    : save(s, 'doses', { id, med_id: medId, day, taken_at: now.toISOString(), deleted_at: null }, now);
}
