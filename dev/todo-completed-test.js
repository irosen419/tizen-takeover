/*
 * To-do "Completed": checks. node dev/todo-completed-test.js
 *
 * Opens the hub in headless Chromium at 1920x1080 with the clock fixed
 * (Chicago, UTC-6) and the list kept on the TV, and checks:
 *   - a done item stays until midnight: ticked at 1 AM stays at 3 PM, ticked
 *     at 11 PM the night before goes (also from the saved list); at 1 AM,
 *     ticked at 10 PM the night before goes and at 12:30 AM stays
 *   - the panel calls the section "Completed", with no date on today's rows
 *   - the home tile shows a "Completed" section between the open rows and
 *     "Coming up": a label, at most 2 one-line rows (newest first, check
 *     circle, struck gray title) and "+N more"; no "{n} done today" line then
 *   - with many open rows the section is dropped (the open rows keep every
 *     row they have without it); the newest takes the meta line if that
 *     costs no row, else nothing about Completed shows
 *   - Ian's Main 3 x 2 (two must-dos, one done): both must-do rows show
 *     (the big count and red strip give way first) and nothing runs past
 *     the tile's bottom, in English and Spanish
 *   - strip tiles are unchanged
 *   - Spanish: "Completadas", "Ayer", nothing cut sideways, room for accents
 *
 * Prints one line per check and "N passed, M failed". Needs Playwright and
 * port 8095 free.
 */
'use strict';

const H = require('./awws-harness');

const LAYOUT = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 4 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'entertainment', x: 3, y: 4, w: 9, h: 2 }
];
const STRIP = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 1 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'entertainment', x: 3, y: 4, w: 9, h: 2 }
];

const HOUR = 3600 * 1000;
const T3PM = Date.parse('2026-11-17T21:00:00Z');   // Tue 17 Nov, 3 PM
const T1AM = Date.parse('2026-11-18T07:00:00Z');   // Wed 18 Nov, 1 AM
const CREATED = Date.parse('2026-11-16T14:00:00Z');

let passed = 0;
let failed = 0;

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

function open(id, title, level, extra) {
  return Object.assign({ id: id, title: title, level: level, section: 'now', done: false, doneAt: null, createdAt: CREATED }, extra || {});
}
function done(id, title, at) {
  return { id: id, title: title, level: 'optional', section: 'now', done: true, doneAt: at, createdAt: CREATED };
}
function storage(list) {
  return { 'homeHub.todo.v1': JSON.stringify({ v: 1, items: list }), 'homeHub.todo.outbox': JSON.stringify({ v: 1, ops: [], whole: false }) };
}

// What fits on a 3 x 4 tile with the red strip: one open row, Coming up and
// the Completed section. (Three open rows and Coming up leave no room.)
const FIT = [
  open('m1', 'Take weekly shot', 'must', { due: '2026-11-17' }),
  open('p1', 'Concert tickets on sale Fri', 'passive', { due: '2026-11-19' })
];
const BASE = [
  open('m1', 'Take weekly shot', 'must', { due: '2026-11-17' }),
  open('o1', 'Buy the olive oil set', 'optional'),
  open('o2', 'Call the dentist', 'optional'),
  open('p1', 'Concert tickets on sale Fri', 'passive', { due: '2026-11-19' })
];

// The tile's rows are fitted again a moment after the first draw (the hub
// settles the tile head), so wait for that.
async function openHub(env, o) {
  const page = await env.newPage(Object.assign({ layout: LAYOUT, live: 'off', motion: 'push' }, o));
  await H.sleep(800);
  return page;
}

function titlesInStore(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.map((i) => i.id));
}

function tile(page) {
  return page.evaluate(() => {
    function text(n) { return n ? n.textContent : null; }
    const t = document.querySelector('.cell[data-widget="todo"] .tile');
    const sec = t.querySelector('.todo-tile-done');
    const bad = [];
    const nodes = t.querySelectorAll('.todo-done-line, .todo-done-title, .todo-foot-label, .todo-foot-line');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const cs = getComputedStyle(n);
      if (parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) < 1.295) bad.push(n.className + ' line-height');
      if (n.classList.contains('todo-done-title') && n.scrollWidth > n.clientWidth + 1 && cs.textOverflow !== 'ellipsis') bad.push('cut sideways');
      if (n.classList.contains('todo-done-line') && n.getBoundingClientRect().height > parseFloat(cs.fontSize) * 2.2) bad.push('line wrapped');
    }
    const w = t.querySelector('.todo-tile') ;
    const r = sec ? sec.getBoundingClientRect() : null;
    const list = t.querySelector('.todo-tile-list');
    const foot = t.querySelector('.todo-tile-foot');
    const tb = t.getBoundingClientRect();
    return {
      sec: !!sec,
      label: sec ? text(sec.querySelector('.todo-foot-label')) : null,
      lines: sec ? Array.prototype.map.call(sec.querySelectorAll('.todo-done-line'), (l) => l.textContent) : [],
      more: sec && sec.querySelector('.todo-foot-more') ? text(sec.querySelector('.todo-foot-more')) : null,
      struck: sec && sec.querySelector('.todo-done-title') ? getComputedStyle(sec.querySelector('.todo-done-title')).textDecoration : '',
      tickBg: sec && sec.querySelector('.todo-tick') ? getComputedStyle(sec.querySelector('.todo-tick')).backgroundImage : '',
      meta: text(t.querySelector('.todo-meta')),
      rows: t.querySelectorAll('.todo-tile-row').length,
      foot: foot ? text(foot.querySelector('.todo-foot-label')) : null,
      order: !!(sec && (!list || list.getBoundingClientRect().bottom <= r.top + 1) && (!foot || r.bottom <= foot.getBoundingClientRect().top + 1)),
      inside: !r || (r.bottom <= tb.bottom + 1 && w && w.scrollHeight <= w.clientHeight + 1),
      bad: bad
    };
  });
}

function panel(page) {
  return page.evaluate(() => {
    const secs = document.querySelectorAll('#panel .todo-sec');
    const out = { names: [], done: [] };
    for (let i = 0; i < secs.length; i++) out.names.push(secs[i].querySelector('.todo-sec-name').textContent);
    const rows = document.querySelectorAll('#panel .todo-sec-done .todo-row');
    for (let j = 0; j < rows.length; j++) {
      const y = rows[j].querySelector('.todo-yday');
      out.done.push({ title: rows[j].querySelector('.todo-title').textContent, yday: y ? y.textContent : null, due: rows[j].querySelectorAll('.todo-due').length });
    }
    return out;
  });
}

async function run(env) {
  // ---- until midnight ----
  let p = await openHub(env, { at: T3PM, storage: storage(BASE.concat([
    done('d1am', 'Done at 1 AM today', Date.parse('2026-11-17T07:00:00Z')),
    done('d11pm', 'Done at 11 PM last night', Date.parse('2026-11-17T05:00:00Z')),
    done('d1', 'Done an hour ago', T3PM - 1 * HOUR)])) });
  try {
    await check('midnight: done at 1 AM today stays, done at 11 PM last night goes (also from the saved list)', async () => {
      const ids = await titlesInStore(p);
      assert(ids.indexOf('d1am') >= 0 && ids.indexOf('d1') >= 0, 'one from today went: ' + ids);
      assert(ids.indexOf('d11pm') < 0, 'last night\'s stayed: ' + ids);
    });
    await check('panel: Completed lists today\'s, with no date or Yesterday label', async () => {
      await H.openPanel(p, 'todo');
      const s = await panel(p);
      assert(s.names.indexOf('Completed') >= 0, 'sections: ' + s.names);
      assert(s.done.length === 2 && s.done.every((d) => d.yday === null && d.due === 0), JSON.stringify(s.done));
    });
  } finally { await p.ctx.close(); }

  // Across midnight: 1 AM on the 18th.
  p = await openHub(env, { at: T1AM, storage: storage(BASE.concat([
    done('late', 'Ticked at 10 PM', Date.parse('2026-11-18T04:00:00Z')),       // 3 h ago, yesterday
    done('new', 'Ticked at half past midnight', Date.parse('2026-11-18T06:30:00Z'))])) });   // 30 min ago, today
  try {
    await check('across midnight: ticked at 10 PM (3 h ago) goes; ticked at 12:30 AM stays', async () => {
      const ids = await titlesInStore(p);
      assert(ids.indexOf('new') >= 0, 'went: ' + ids);
      assert(ids.indexOf('late') < 0, 'yesterday\'s stayed: ' + ids);
    });
  } finally { await p.ctx.close(); }

  // ---- the tile ----
  const three = [done('c1', 'Water the plants', T3PM - 1 * HOUR), done('c2', 'Pay the water bill', T3PM - 2 * HOUR),
    done('c3', 'Send the form', T3PM - 3 * HOUR), done('c4', 'Drop off the parcel', T3PM - 4 * HOUR)];
  p = await openHub(env, { at: T3PM, storage: storage(FIT.concat(three)) });
  try {
    let s;
    await check('tile: Completed sits between the open rows and Coming up, 2 rows newest first, +2 more, no "done today" line', async () => {
      s = await tile(p);
      assert(s.sec && s.label === 'Completed', JSON.stringify(s));
      assert(s.lines.length === 2 && s.lines[0] === 'Water the plants' && s.lines[1] === 'Pay the water bill', JSON.stringify(s.lines));
      assert(s.more === '+2 more', 'more: ' + s.more);
      assert(s.meta === null, 'the meta line is still there: ' + s.meta);
      assert(s.rows === 1 && s.foot === 'Coming up' && s.order, 'order/rows: ' + JSON.stringify(s));
      assert(/line-through/.test(s.struck) && /gradient/.test(s.tickBg), 'look: ' + s.struck + ' ' + s.tickBg);
      assert(s.inside && !s.bad.length, 'fit: ' + JSON.stringify(s.bad));
    });
    await check('tile: no "+N more" with 1 or 2 completed', async () => {
      await p.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('homeHub.todo.v1'));
        st.items = st.items.filter((i) => i.id !== 'c3' && i.id !== 'c4');
        localStorage.setItem('homeHub.todo.v1', JSON.stringify(st));
      });
      await p.reload();
      await H.sleep(1300);
      const t = await tile(p);
      assert(t.lines.length === 2 && t.more === null, JSON.stringify(t));
    });
  } finally { await p.ctx.close(); }

  // Many open rows: Completed would squeeze them, so it is dropped.
  const many = [];
  for (let i = 0; i < 9; i++) many.push(open('x' + i, 'Open to-do number ' + (i + 1), i === 0 ? 'must' : 'optional', i === 0 ? { due: '2026-11-17' } : {}));
  many.push(open('p1', 'Concert tickets on sale Fri', 'passive', { due: '2026-11-19' }));
  const without = await openHub(env, { at: T3PM, storage: storage(many) });
  let rowsWithout;
  try { rowsWithout = (await tile(without)).rows; } finally { await without.ctx.close(); }
  p = await openHub(env, { at: T3PM, storage: storage(many.concat(three)) });
  try {
    await check('tile: open rows would be squeezed, so the newest completed takes the meta line: same open rows (' + rowsWithout + ' without any done items)', async () => {
      const s = await tile(p);
      assert(!s.sec, 'the section shows');
      // The line takes the "+N more" row's spare room, so it costs no row.
      assert(rowsWithout >= 3 && s.rows === rowsWithout, 'open rows ' + s.rows + ' vs ' + rowsWithout + ' without any done items');
      const m = await p.evaluate(() => {
        const n = document.querySelector('.cell[data-widget="todo"] .todo-meta-done');
        return n && { t: n.querySelector('.todo-done-title').textContent, more: n.querySelector('.todo-meta-more').textContent, tick: !!n.querySelector('.todo-tick svg'),
          h: n.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(n).lineHeight), fs: parseFloat(getComputedStyle(n).fontSize),
          strike: getComputedStyle(n.querySelector('.todo-done-title')).textDecoration };
      });
      assert(m && m.t === 'Water the plants' && m.more === '+3 more' && m.tick && /line-through/.test(m.strike), JSON.stringify(m));
      assert(Math.abs(m.h - m.lh) < 1.5 && m.lh / m.fs >= 1.295, 'the line is not the meta line\'s height: ' + JSON.stringify(m));
    });
    await check('tile: the compact line in Spanish, accents and a long title: one line, nothing cut', async () => {
      await p.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('homeHub.todo.v1'));
        st.items.forEach((i) => { if (i.id === 'c1') i.title = 'Llamar a Ángela: ¿Ñandú? Él llevará la documentación médica completa del niño'; });
        localStorage.setItem('homeHub.todo.v1', JSON.stringify(st));
        window.HUB_I18N.setLang('es');
      });
      await p.reload();
      await H.sleep(1500);
      await p.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(500);
      const m = await p.evaluate(() => {
        const n = document.querySelector('.cell[data-widget="todo"] .todo-meta-done');
        const t = n && n.querySelector('.todo-done-title');
        return n && { more: n.querySelector('.todo-meta-more').textContent, h: n.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(n).lineHeight),
          ell: getComputedStyle(t).textOverflow, cut: t.scrollWidth > t.clientWidth, w: t.clientWidth };
      });
      assert(m && m.more === '+3 más' && m.h < m.lh * 1.5 && m.ell === 'ellipsis' && m.w > 40, JSON.stringify(m));
    });
  } finally { await p.ctx.close(); }

  // Four open rows fill the tile: any word of Completed would cost a row.
  const four = [open('m1', 'Take weekly shot', 'must', { due: '2026-11-17' }), open('o1', 'Open to-do number 1', 'optional'),
    open('o2', 'Open to-do number 2', 'optional'), open('o3', 'Open to-do number 3', 'optional'),
    open('p1', 'Concert tickets on sale Fri', 'passive', { due: '2026-11-19' })];
  p = await openHub(env, { at: T3PM, storage: storage(four.concat(three)) });
  try {
    await check('tile: when even one line would cost an open row, nothing about Completed shows', async () => {
      const s = await tile(p);
      const line = await p.evaluate(() => !!document.querySelector('.cell[data-widget="todo"] .todo-meta-done'));
      assert(s.rows === 4 && !s.sec && !line && s.meta === null, JSON.stringify(s) + ' line ' + line);
    });
  } finally { await p.ctx.close(); }

  // Ian's Main: the to-do tile 3 x 2 under the calendar, two must-dos in the
  // strip and one done (photo 2026-11-25: Completed ran past the bottom).
  const MAIN = [
    { widget: 'today', x: 0, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 3, y: 0, w: 3, h: 2 },
    { widget: 'todo', x: 3, y: 2, w: 3, h: 2 }, { widget: 'entertainment', x: 3, y: 4, w: 3, h: 2 }];
  const ian = [open('m1', 'Call Stamford Health', 'must', { due: '2026-11-17' }), open('m2', 'Settle balance with HSA card', 'must', { due: '2026-11-17' }),
    done('c1', 'Pick up plant shelf', T3PM - HOUR)];
  for (const lang of ['en', 'es']) {
    p = await openHub(env, { at: T3PM, layout: MAIN, lang: lang, storage: storage(ian) });
    try {
      await check('Main 3 x 2 (' + lang + '): both must-dos listed first, nothing runs past the tile\'s bottom', async () => {
        const r = await p.evaluate(() => {
          const t = document.querySelector('.cell[data-widget="todo"] .tile');
          const w = t.querySelector('.todo-tile');
          const cs = getComputedStyle(t);
          const limit = t.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
          let low = 0;
          const all = w.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) { const b = all[i].getBoundingClientRect(); if (b.height) low = Math.max(low, b.bottom); }
          return { low: low, limit: limit, sh: w.scrollHeight, ch: w.clientHeight, musts: w.querySelectorAll('.todo-tile-row.lv-must').length };
        });
        assert(r.low <= r.limit + 1 && r.sh <= r.ch + 1, JSON.stringify(r));
        assert(r.musts === 2, 'both must-dos are not listed: ' + JSON.stringify(r));
      });
    } finally { await p.ctx.close(); }
  }

  // Strip: unchanged.
  p = await openHub(env, { at: T3PM, layout: STRIP, storage: storage(FIT.concat(three)) });
  try {
    await check('strip tile: no Completed section', async () => {
      const n = await p.evaluate(() => document.querySelectorAll('.cell[data-widget="todo"] .todo-tile-done, .cell[data-widget="todo"] .todo-done-line').length);
      assert(n === 0, 'found ' + n);
    });
  } finally { await p.ctx.close(); }

  // Only completed items, no open ones: the section still shows.
  p = await openHub(env, { at: T3PM, storage: storage([done('c1', 'Water the plants', T3PM - HOUR)]) });
  try {
    await check('tile: with nothing open, "All clear" and the Completed section', async () => {
      const s = await tile(p);
      assert(s.sec && s.lines.length === 1 && s.meta === null, JSON.stringify(s));
    });
  } finally { await p.ctx.close(); }

  // ---- Spanish, and 25% longer ----
  p = await openHub(env, { at: T3PM, lang: 'es', storage: storage(FIT.concat(three, [done('c5', 'Llamar a Ángela: ¿Ñandú? Él llevará la documentación médica completa del niño', T3PM - 30 * 60 * 1000)])) });
  try {
    await check('Spanish: Completadas, one-line rows with ellipsis, +3 más, nothing cut, panel lists all five', async () => {
      const s = await tile(p);
      assert(s.label === 'Completadas' && s.more === '+3 más', JSON.stringify(s));
      assert(s.lines.length === 2 && !s.bad.length && s.inside, JSON.stringify(s));
      await H.openPanel(p, 'todo');
      const pn = await panel(p);
      assert(pn.names.indexOf('Completadas') >= 0, 'sections: ' + pn.names);
      assert(pn.done.length === 5 && pn.done.every((d) => d.yday === null), JSON.stringify(pn.done));
    });
    await check('Spanish 25% longer with accents: the Completed rows stay on one line, ellipsis not sideways cut', async () => {
      await p.evaluate(() => {
        const es = window.HUB_I18N.strings.es;
        es['todo.sections.done'] += ' ÁÉñ';
        es['todo.more'] += ' ÁÉñ';
        window.HUB_I18N.setLang('en');
        window.HUB_I18N.setLang('es');
      });
      await H.sleep(300);
      const s = await tile(p);
      assert(/ÁÉñ/.test(s.label) && s.lines.length >= 1, JSON.stringify(s));
      assert(!s.bad.length, JSON.stringify(s.bad));
    });
    const errors = H.errorsOf(p, true);
    await check('no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
  } finally { await p.ctx.close(); }
}

(async () => {
  const env = await H.start({ snapshot: false, calendars: false, at: T3PM });
  try {
    await run(env);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + (e && e.stack || e));
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
