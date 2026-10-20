// node tests/sync.test.mjs
import assert from 'node:assert/strict';
import { newStore, save, remove, live, sync, toggleDose, doseId, toBackup, importBackup } from '../sync.js';

// Servidor falso que imita o schema.sql: gatilho LWW + synced_at do relógio do servidor.
function fakeServer() {
  const db = { meds: new Map(), doses: new Map(), glucose: new Map(), bp: new Map() };
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const api = {
    online: true, upserts: 0,
    async upsert(t, rows) {
      if (!api.online) throw new Error('offline');
      api.upserts++;
      for (const r of rows) {
        const old = db[t].get(r.id);
        if (old && Date.parse(r.updated_at) < Date.parse(old.updated_at)) continue;
        db[t].set(r.id, { ...r, synced_at: new Date(++clock).toISOString().replace('Z', '123+00:00') }); // formato do Postgres (µs)
      }
    },
    async pull(t, since, limit) {
      if (!api.online) throw new Error('offline');
      const p = x => Date.parse(x.replace(/(\.\d{3})\d+/, '$1'));
      return [...db[t].values()].filter(r => p(r.synced_at) >= p(since))
        .sort((a, b) => p(a.synced_at) - p(b.synced_at)).slice(0, limit).map(r => ({ ...r }));
    },
  };
  return { api, db };
}

const T = s => new Date(`2026-03-01T${s}Z`);
const U = 'user-1';
const tests = {
  async 'fila: offline guarda, online envia e esvazia'() {
    const { api, db } = fakeServer();
    const a = newStore();
    save(a, 'glucose', { id: 'g1', value: 110, measured_at: T('08:00:00').toISOString() }, T('08:00:00'));
    api.online = false;
    await assert.rejects(sync(a, api, U));
    assert.equal(a.queue.size, 1, 'continua na fila se falhou');
    api.online = true;
    await sync(a, api, U);
    assert.equal(a.queue.size, 0);
    assert.equal(db.glucose.get('g1').user_id, U);
    await sync(a, api, U);
    assert.equal(api.upserts, 1, 'não reenvia o que já subiu');
  },

  async 'propaga entre dois aparelhos'() {
    const { api } = fakeServer();
    const a = newStore(), b = newStore();
    save(a, 'meds', { id: 'm1', name: 'Losartana' }, T('08:00:00'));
    await sync(a, api, U); await sync(b, api, U);
    assert.equal(b.rows.meds.get('m1').name, 'Losartana');
  },

  async 'conflito: vence updated_at mais recente, em qualquer ordem de envio'() {
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const { api } = fakeServer();
      const d = { a: newStore(), b: newStore() };
      save(d.a, 'meds', { id: 'm1', name: 'v0' }, T('08:00:00'));
      await sync(d.a, api, U); await sync(d.b, api, U);
      save(d.a, 'meds', { id: 'm1', name: 'nova' }, T('10:00:00'));   // mais recente
      save(d.b, 'meds', { id: 'm1', name: 'antiga' }, T('09:00:00'));
      for (const k of order) await sync(d[k], api, U);
      for (const k of ['a', 'b']) await sync(d[k], api, U);
      assert.equal(d.a.rows.meds.get('m1').name, 'nova', order.join());
      assert.equal(d.b.rows.meds.get('m1').name, 'nova', order.join());
    }
  },

  async 'edição offline enviada tarde ainda chega ao outro aparelho'() {
    const { api } = fakeServer();
    const a = newStore(), b = newStore();
    save(a, 'bp', { id: 'p1', systolic: 120 }, T('08:00:00')); // updated_at antigo
    save(b, 'bp', { id: 'p2', systolic: 130 }, T('12:00:00'));
    await sync(b, api, U);                                      // cursor de b avança
    await sync(a, api, U);                                      // a sobe depois
    await sync(b, api, U);
    assert.ok(b.rows.bp.get('p1'), 'synced_at do servidor evita perder a linha');
  },

  async 'exclusão viaja como deleted_at e some da lista'() {
    const { api, db } = fakeServer();
    const a = newStore(), b = newStore();
    save(a, 'glucose', { id: 'g1', value: 99 }, T('08:00:00'));
    await sync(a, api, U); await sync(b, api, U);
    remove(b, 'glucose', 'g1', T('09:00:00'));
    await sync(b, api, U); await sync(a, api, U);
    assert.ok(db.glucose.get('g1').deleted_at, 'servidor guarda a lápide');
    assert.equal(live(a, 'glucose').length, 0);
  },

  async 'exclusão antiga não apaga edição mais nova'() {
    const { api } = fakeServer();
    const a = newStore(), b = newStore();
    save(a, 'meds', { id: 'm1', name: 'x' }, T('08:00:00'));
    await sync(a, api, U); await sync(b, api, U);
    remove(b, 'meds', 'm1', T('09:00:00'));
    save(a, 'meds', { id: 'm1', name: 'y' }, T('10:00:00'));
    await sync(a, api, U); await sync(b, api, U); await sync(a, api, U);
    assert.equal(live(b, 'meds')[0]?.name, 'y');
  },

  async 'dose: mesmo id nos dois aparelhos, desmarcar = deleted_at'() {
    const { api, db } = fakeServer();
    const a = newStore(), b = newStore();
    assert.equal(await doseId('m1', '2026-03-01'), await doseId('m1', '2026-03-01'));
    assert.notEqual(await doseId('m1', '2026-03-01'), await doseId('m1', '2026-03-02'));
    await toggleDose(a, 'm1', '2026-03-01', T('08:00:00'));
    await toggleDose(b, 'm1', '2026-03-01', T('08:05:00'));
    await sync(a, api, U); await sync(b, api, U); await sync(a, api, U);
    assert.equal(db.doses.size, 1, 'sem duplicata');
    await toggleDose(a, 'm1', '2026-03-01', T('09:00:00'));
    await sync(a, api, U); await sync(b, api, U);
    assert.equal(live(b, 'doses').length, 0);
    await toggleDose(b, 'm1', '2026-03-01', T('10:00:00'));
    assert.equal(live(b, 'doses').length, 1, 'remarcar revive a linha');
  },

  async 'relógio voltando no tempo não perde a própria edição'() {
    const a = newStore();
    save(a, 'meds', { id: 'm1', name: 'x' }, T('10:00:00'));
    const r = save(a, 'meds', { id: 'm1', name: 'y' }, T('09:00:00'));
    assert.ok(Date.parse(r.updated_at) > Date.parse(T('10:00:00').toISOString()));
  },

  async 'paginação traz mais de 1000 linhas'() {
    const { api } = fakeServer();
    const a = newStore(), b = newStore();
    for (let i = 0; i < 2500; i++) save(a, 'glucose', { id: 'g' + i, value: i }, T('08:00:00'));
    await sync(a, api, U); await sync(b, api, U);
    assert.equal(b.rows.glucose.size, 2500);
  },

  async 'importar dados do protótipo: formato v1 vira linhas na fila e volta igual'() {
    const legacy = {
      version: 1,
      meds: [{ id: 'm1', name: 'Levotiroxina', instr: 'Em jejum', period: 'manha' }, { id: 'm2', name: 'Trezor', instr: 'À noite.', period: 'noite' }],
      doses: { '2026-03-01': { m1: '07:15', mX: '08:00' } }, // mX = remédio já removido da lista
      glucose: [{ id: 'abc1', ts: T('11:00:00').getTime(), value: 110, moment: 'Jejum', note: '' }],
      bp: [{ id: 'abc2', ts: T('11:05:00').getTime(), sys: 120, dia: 80, pulse: null, note: 'sentado' }],
    };
    const a = newStore();
    await importBackup(a, U, legacy);
    const b = toBackup(a);
    assert.deepEqual(b.meds.map(m => m.name), ['Levotiroxina', 'Trezor']);
    assert.deepEqual(Object.values(b.doses['2026-03-01']).sort(), ['07:15', '08:00']);
    assert.equal(b.glucose[0].value, 110); assert.equal(b.glucose[0].ts, legacy.glucose[0].ts);
    assert.equal(b.bp[0].sys, 120); assert.equal(b.bp[0].note, 'sentado');
    assert.equal(a.rows.meds.size, 3, 'remédio removido recriado como excluído');
    assert.equal(a.queue.size, 7);
    for (const t of ['meds', 'doses', 'glucose', 'bp']) for (const id of a.rows[t].keys()) assert.match(id, /^[0-9a-f-]{36}$/);
  },

  async 'importar o mesmo backup em dois aparelhos não duplica'() {
    const { api, db } = fakeServer();
    const seed = { version: 1, meds: [{ id: 'm1', name: 'A', instr: '', period: 'manha' }], doses: {}, glucose: [], bp: [] };
    const a = newStore(), b = newStore();
    await importBackup(a, U, seed); await importBackup(b, U, seed);
    await sync(a, api, U); await sync(b, api, U);
    assert.equal(db.meds.size, 1);
  },

  async 'restaurar backup mescla: acrescenta o que falta e não apaga o que não está nele'() {
    const { api } = fakeServer();
    const a = newStore(), b = newStore();
    const g1 = save(a, 'glucose', { id: crypto.randomUUID(), value: 90, measured_at: T('08:00:00').toISOString() }, T('08:00:00'));
    const backup = JSON.parse(JSON.stringify(toBackup(a)));
    const g2 = save(b, 'glucose', { id: crypto.randomUUID(), value: 95, measured_at: T('09:00:00').toISOString() }, T('09:00:00'));
    assert.equal(await importBackup(b, U, backup, T('10:00:00')), 1);
    await sync(b, api, U); await sync(a, api, U);
    for (const x of [a, b]) assert.deepEqual(live(x, 'glucose').map(e => e.id).sort(), [g1.id, g2.id].sort());
  },

  async 'restaurar backup: fica a versão com updated_at mais recente'() {
    const { api, db } = fakeServer();
    const a = newStore();
    const med = save(a, 'meds', { id: crypto.randomUUID(), name: 'v1', instr: '', period: 'manha', sort: 0 }, T('08:00:00'));
    const g = save(a, 'glucose', { id: crypto.randomUUID(), value: 100, measured_at: T('08:00:00').toISOString() }, T('08:00:00'));
    const backup = JSON.parse(JSON.stringify(toBackup(a)));            // med "v1" e glicose 100, às 08:00
    save(a, 'meds', { id: med.id, name: 'v2' }, T('09:00:00'));        // daqui mais novo que o backup
    backup.glucose[0].value = 111; backup.glucose[0].updated_at = T('09:30:00').toISOString(); // backup mais novo
    await sync(a, api, U);
    await importBackup(a, U, backup, T('10:00:00'));
    assert.equal(a.rows.meds.get(med.id).name, 'v2', 'local mais novo fica');
    assert.equal(a.rows.glucose.get(g.id).value, 111, 'backup mais novo entra');
    assert.equal(a.rows.glucose.get(g.id).updated_at, T('09:30:00').toISOString(), 'mantém o updated_at do backup');
    await sync(a, api, U);
    assert.equal(db.glucose.get(g.id).value, 111); assert.equal(db.meds.get(med.id).name, 'v2');
  },

  async 'restaurar backup não ressuscita o que foi excluído depois do backup'() {
    const a = newStore();
    const g = save(a, 'glucose', { id: crypto.randomUUID(), value: 100, measured_at: T('08:00:00').toISOString() }, T('08:00:00'));
    const backup = JSON.parse(JSON.stringify(toBackup(a)));
    remove(a, 'glucose', g.id, T('09:00:00'));
    await importBackup(a, U, backup, T('10:00:00'));
    assert.equal(live(a, 'glucose').length, 0);
  },

  async 'backup do protótipo (sem updated_at) não sobrescreve edições já feitas'() {
    const a = newStore();
    const legacy = { version: 1, meds: [{ id: 'm1', name: 'Original', instr: '', period: 'manha' }], doses: { '2026-03-01': { m1: '07:00' } }, glucose: [], bp: [] };
    await importBackup(a, U, legacy, T('08:00:00'));
    const id = [...a.rows.meds.keys()][0];
    save(a, 'meds', { id, name: 'Editado' }, T('09:00:00'));
    await toggleDose(a, id, '2026-03-01', T('09:00:00'));             // desmarcou depois
    assert.equal(await importBackup(a, U, legacy, T('10:00:00')), 0);
    assert.equal(a.rows.meds.get(id).name, 'Editado');
    assert.equal(live(a, 'doses').length, 0);
  },

  async 'exportar e restaurar no mesmo aparelho não muda nada'() {
    const a = newStore();
    await importBackup(a, U, { version: 1, meds: [{ id: 'm1', name: 'A', instr: '', period: 'manha' }], doses: { '2026-03-01': { m1: '07:00' } },
      glucose: [{ id: 'x', ts: T('08:00:00').getTime(), value: 99 }], bp: [{ id: 'y', ts: T('08:00:00').getTime(), sys: 120, dia: 80 }] });
    a.queue.clear();
    assert.equal(await importBackup(a, U, JSON.parse(JSON.stringify(toBackup(a)))), 0);
    assert.equal(a.queue.size, 0);
  },

  async 'backup inválido não grava nada'() {
    const a = newStore();
    const bad = { version: 1, meds: [{ id: 'm1', name: 'A' }], doses: {}, glucose: [{ id: 'g', ts: 'lixo', value: 1 }], bp: [] };
    await assert.rejects(importBackup(a, U, bad));
    assert.equal(a.queue.size, 0);
  },

  async 'hooks de persistência são chamados'() {
    const log = [];
    const a = newStore({ row: (t, r) => log.push(['row', t, r.id]), queue: (k, on) => log.push(['q', k, on]) });
    save(a, 'meds', { id: 'm1' });
    assert.deepEqual(log, [['row', 'meds', 'm1'], ['q', 'meds:m1', true]]);
  },
};

let fail = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok  ', name); } catch (e) { fail++; console.log('FALHOU', name, '\n  ', e.message); }
}
process.exit(fail ? 1 : 0);
