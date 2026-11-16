/*
 * To-do notes: checks and screenshots. node dev/todo-notes-shots.js
 *
 * Runs the preview and the Pi's real hub server (through dev/awws-harness.js),
 * adds three to-dos on the Pi (one with long notes, one with short notes, one
 * without), then opens the hub in headless Chromium at 1920x1080 and checks,
 * in English and again with Spanish words and notes (longer, with accents):
 *
 *   - an item without notes has no notes element at all, on the tile and in
 *     the panel and full screen
 *   - notes show under the title, with the text the Pi holds
 *   - notes are cut between lines (1 on the tile, 3 in the panel, 4 in full
 *     screen), never through a glyph, and never run sideways
 *   - ticking an item on the TV keeps its notes on the Pi
 *
 * Prints one line per check and "N passed, M failed".
 *
 *   --out <folder>    also write the screenshots there (todo-notes-*.png)
 *   --scale 2         sharper screenshots (3840x2160)
 *
 * Needs Playwright and port 8095 free.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const OUT = arg('--out') ? path.resolve(arg('--out')) : null;
const SCALE = parseFloat(arg('--scale')) || 1;

const LAYOUT = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 4 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'entertainment', x: 3, y: 4, w: 9, h: 2 }
];

const ITEMS = {
  en: [
    { title: 'Buy milk', notes: 'Oat milk, not dairy. Ask at the bakery whether the gluten-free bread is back for Saturday, and pick up two if it is. The loyalty card is in the kitchen drawer, next to the spare keys and the batteries.' },
    { title: 'Call the dentist', notes: 'Ask for a morning slot.' },
    { title: 'Return the library books' }
  ],
  es: [
    { title: 'Comprar leche', notes: 'Leche de avena, no de vaca. Preguntar en la panadería si ya volvió el pan sin gluten para el sábado y, si volvió, llevar dos. La tarjeta está en el cajón de la cocina, junto a las llaves.' },
    { title: 'Llamar al dentista', notes: 'Pedir una cita por la mañana. Ñandú, Ángela, ¿Él?' },
    { title: 'Devolver los libros de la biblioteca' }
  ]
};

// The widget's words in Spanish (window.HUB_TODO_STRINGS).
const SPANISH = {
  sub: 'En esta TV', subSynced: 'Sincronizada', subToSend: 'Guardada aquí, {n} por enviar', subSaved: 'Guardada aquí',
  heroOne: 'por hacer ahora', heroMany: 'por hacer ahora', allClear: 'Nada pendiente por ahora',
  metaNext: '{n} después', metaWaiting: '{n} en espera', metaDone: '{n} hechas hoy',
  emptyTitle: 'La lista está vacía.', emptyHint: 'Pulsa OK para añadir algo.', more: '+{n} más',
  overdue: 'Atrasada', dueToday: 'Vence hoy', dueOn: 'Vence el {d}',
  sections: { now: 'Ahora', next: 'Después', waiting: 'En espera de', done: 'Hechas hoy' },
  moveTo: { now: 'A Ahora', next: 'A Después', waiting: 'A En espera de' },
  remove: 'Quitar', removeArmed: 'Confirmar', addPlaceholder: 'Añadir una tarea',
  hintOk: 'OK para escribir', hintTyping: 'Listo o Intro la añade',
  emptyNow: 'Nada por ahora.', emptySection: 'Nada aquí.'
};

let passed = 0;
let failed = 0;
const written = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     '));
  }
}

function assert(ok, text) { if (!ok) throw new Error(text); }

async function shot(page, name) {
  if (!OUT) return;
  const file = path.join(OUT, 'todo-notes-' + name + '.png');
  await page.screenshot({ path: file });
  written.push(file);
}

// What the page shows: for each title, its notes text (or null), and how
// each notes element fits.
function look(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    const rows = document.querySelectorAll(sel.rows);
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].querySelector(sel.title);
      const n = rows[i].querySelector(sel.notes);
      const o = { title: t ? t.textContent : null, notes: n ? n.textContent : null, count: rows[i].querySelectorAll(sel.notes).length };
      if (n) {
        const cs = getComputedStyle(n);
        const fs = parseFloat(cs.fontSize);
        const lh = parseFloat(cs.lineHeight);
        const h = n.getBoundingClientRect().height;
        o.ratio = lh / fs;
        o.lines = h / lh;
        o.sideways = n.scrollWidth > n.clientWidth + 1;
        o.full = n.scrollHeight <= n.clientHeight + 1;
      }
      out.push(o);
    }
    return out;
  }, scope);
}

const TILE = { rows: '.cell[data-widget="todo"] .todo-tile-row', title: '.todo-tile-title', notes: '.todo-tile-notes' };
const PANEL = { rows: '#panel .todo-row', title: '.todo-title', notes: '.todo-notes' };

function checkFit(rows, items, maxLines, where) {
  items.forEach((item) => {
    const r = rows.find((x) => x.title === item.title);
    assert(r, where + ': no row for "' + item.title + '"');
    if (!item.notes) {
      assert(r.count === 0, where + ': "' + item.title + '" has an empty notes element');
      return;
    }
    assert(r.count === 1 && r.notes === item.notes, where + ': notes of "' + item.title + '": ' + JSON.stringify(r.notes));
    assert(r.ratio >= 1.3, where + ': notes line-height is ' + r.ratio.toFixed(2) + ' of the font size');
    const whole = Math.abs(r.lines - Math.round(r.lines)) < 0.05;
    assert(whole && Math.round(r.lines) >= 1 && Math.round(r.lines) <= maxLines,
      where + ': notes of "' + item.title + '" are ' + r.lines.toFixed(2) + ' lines (whole lines, 1 to ' + maxLines + ')');
    assert(!r.sideways, where + ': notes of "' + item.title + '" run sideways');
  });
}

async function run(env, lang) {
  const items = ITEMS[lang];
  const tag = lang === 'es' ? '-es' : '';
  // A fresh list on the Pi: these three, in this order.
  const old = (await env.control('GET', '/api/todo')).items || [];
  const ops = old.map((i) => ({ op: 'remove', id: i.id }));
  items.forEach((it, n) => {
    const item = { id: 'n' + lang + n, title: it.title, section: 'now', createdAt: Date.now() };
    if (it.notes) item.notes = it.notes;
    ops.push({ op: 'add', item: item, at: 'end' });
  });
  const r = await env.control('POST', '/api/todo/ops', { ops: ops });
  assert(r && r.ok, 'the Pi refused the items: ' + JSON.stringify(r));

  const page = await env.newPage({
    layout: LAYOUT, scale: SCALE,
    config: lang === 'es' ? 'window.HUB_TODO_STRINGS = ' + JSON.stringify(SPANISH) + ';' : undefined
  });
  try {
    await H.until(() => page.evaluate(() => document.querySelectorAll('.cell[data-widget="todo"] .todo-tile-row').length >= 3), 8000, 'the tile did not show the three items');
    await check(lang + ': the tile shows notes in one line, and nothing for an item without', async () => {
      checkFit(await look(page, TILE), items, 1, 'tile');
    });
    await shot(page, 'tile' + tag);

    await H.openPanel(page, 'todo');
    await check(lang + ': the panel shows notes under the title (up to 3 lines), and nothing for an item without', async () => {
      const rows = await look(page, PANEL);
      checkFit(rows, items, 3, 'panel');
      assert(rows.find((x) => x.title === items[0].title).lines > 2.9, 'the long notes should fill 3 lines in the panel');
    });
    await shot(page, 'panel' + tag);

    await H.fullScreen(page);
    await check(lang + ': full screen shows notes (up to 4 lines), and nothing for an item without', async () => {
      checkFit(await look(page, PANEL), items, 4, 'full screen');
    });
    await shot(page, 'full' + tag);

    await check(lang + ': ticking an item on the TV keeps its notes on the Pi', async () => {
      await page.click('#panel .todo-main[data-key="item:n' + lang + '1"]');
      await H.until(async () => {
        const list = (await env.control('GET', '/api/todo')).items;
        const it = list.find((i) => i.id === 'n' + lang + '1');
        return it && it.done && it.notes === items[1].notes;
      }, 6000, 'the Pi did not get the tick with the notes kept');
      checkFit(await look(page, PANEL), items, 4, 'full screen after the tick');
    });
    await shot(page, 'ticked' + tag);

    await check(lang + ': notes set on the Pi show up and go away on the TV by themselves', async () => {
      await env.control('POST', '/api/todo/ops', { ops: [{ op: 'set', id: 'n' + lang + '2', fields: { notes: lang === 'es' ? 'Antes del viernes.' : 'Before Friday.' } },
        { op: 'set', id: 'n' + lang + '1', fields: { notes: null } }] });
      await H.until(async () => {
        const rows = await look(page, PANEL);
        const a = rows.find((x) => x.title === items[2].title);
        const b = rows.find((x) => x.title === items[1].title);
        return a && a.count === 1 && b && b.count === 0;
      }, 6000, 'the TV did not take the new notes');
    });
    const errors = H.errorsOf(page, true);
    await check(lang + ': no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
  } finally {
    await page.ctx.close();
  }
}

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ snapshot: false, calendars: false });
  try {
    await run(env, 'en');
    await run(env, 'es');
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + (e && e.stack || e));
  } finally {
    await env.stop();
  }
  written.forEach((f) => console.log('wrote ' + f));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
