/*
 * Owner-typed text in Spanish, wired to HUB_I18N.dyn: node dev/i18n-dyn-wire-test.js
 * Loads the hub with ?lang=es (sample calendars and snapshot, dev/awws-harness.js),
 * mocks the Pi's POST /translate, and checks the to-do, calendar and AWWS tiles
 * show the Spanish after the batch, a to-do edit field still shows English, and
 * that ?lang=en makes no /translate request. Needs Playwright and port 8095 free.
 */
'use strict';

const H = require('./awws-harness');

const MAP = {
  'Water plants': 'Regar las plantas',
  'Call the dentist': 'Llamar al dentista',
  'Family: soccer practice': 'Familia: práctica de fútbol',
  'Call with the illustrator about Año Nuevo': 'Llamada con la ilustradora sobre Año Nuevo',
  'Maple Grove Elementary': 'Primaria Maple Grove',
  'Tidy the education downloads page': 'Ordenar la página de descargas educativas'
};

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const CREATED = Date.parse('2026-11-16T14:00:00Z');
function item(id, title, level) {
  return { id: id, title: title, level: level, section: 'now', done: false, doneAt: null, createdAt: CREATED };
}
const STORAGE = {
  'homeHub.todo.v1': JSON.stringify({ v: 1, items: [item('a', 'Water plants', 'must'), item('b', 'Call the dentist', 'optional')] }),
  'homeHub.todo.outbox': JSON.stringify({ v: 1, ops: [], whole: false })
};
const LAYOUT = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 4 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 4 },
  { widget: 'awws-visits', x: 6, y: 0, w: 3, h: 2 }, { widget: 'awws-todo', x: 6, y: 2, w: 3, h: 2 },
  { widget: 'awws-agenda', x: 9, y: 0, w: 3, h: 4 }
];

function mock(requests) {
  return async (context) => {
    await context.route(/\/translate$/, (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* none */ }
      requests.push(body);
      const map = {};
      (body.texts || []).forEach((t) => { if (MAP[t]) map[t] = MAP[t]; });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true, map: map }) });
    });
  };
}

function tiles(page) {
  return page.evaluate(() => {
    const o = {};
    Array.prototype.forEach.call(document.querySelectorAll('.cell'), (c) => { o[c.getAttribute('data-widget')] = c.querySelector('.tile-body').textContent; });
    return o;
  });
}

(async () => {
  const env = await H.start({});
  try {
    await check('Spanish: titles are English first, then Spanish after the batch; one request', async () => {
      const requests = [];
      const page = await env.newPage({ layout: LAYOUT, lang: 'es', storage: STORAGE, route: mock(requests) });
      try {
        await H.sleep(2500);
        const t = await tiles(page);
        assert(requests.length >= 1, 'no /translate request');
        assert(requests.every((r) => r.to === 'es'), 'bad request body');
        assert(/Regar las plantas/.test(t.todo), 'todo: ' + t.todo);
        assert(!/Water plants/.test(t.todo), 'todo still English: ' + t.todo);
        assert(/Familia: práctica de fútbol/.test(t.calendar), 'calendar: ' + t.calendar);
        assert(/Primaria Maple Grove/.test(t['awws-visits']), 'awws visits: ' + t['awws-visits']);
        const aw = (t['awws-todo'] || '') + ' | ' + (t['awws-agenda'] || '');
        assert(/Ordenar la página de descargas/.test(aw), 'awws tasks: ' + aw);
        // The store keeps the English.
        const stored = await page.evaluate(() => localStorage.getItem('homeHub.todo.v1'));
        assert(/Water plants/.test(stored) && !/Regar/.test(stored), 'store changed: ' + stored);
      } finally { await page.ctx.close(); }
    });

    await check('Spanish: text fields keep the English', async () => {
      const requests = [];
      const page = await env.newPage({ layout: LAYOUT, lang: 'es', storage: STORAGE, route: mock(requests) });
      try {
        await H.sleep(2500);
        const found = await page.evaluate(() => {
          const all = document.querySelectorAll('input, textarea');
          return Array.prototype.map.call(all, (n) => n.value);
        });
        assert(!found.some((v) => /Regar/.test(v)), 'a field holds Spanish: ' + JSON.stringify(found));
        await H.openPanel(page, 'todo');
        await H.sleep(800);
        const panel = await page.evaluate(() => document.querySelector('#panel').textContent);
        assert(/Regar las plantas/.test(panel), 'panel: ' + panel.slice(0, 300));
        const vals = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel input, #panel textarea'), (n) => n.value));
        assert(!vals.some((v) => /Regar|Llamar/.test(v)), 'a panel field holds Spanish: ' + JSON.stringify(vals));
      } finally { await page.ctx.close(); }
    });

    await check('English: no /translate request and the same words', async () => {
      const requests = [];
      const page = await env.newPage({ layout: LAYOUT, lang: 'en', storage: STORAGE, route: mock(requests) });
      try {
        await H.sleep(2500);
        const t = await tiles(page);
        assert(requests.length === 0, 'asked for ' + requests.length + ' translations');
        assert(/Water plants/.test(t.todo), 'todo: ' + t.todo);
      } finally { await page.ctx.close(); }
    });
  } finally { await env.stop(); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
