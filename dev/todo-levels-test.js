/*
 * To-do levels: checks and screenshots. node dev/todo-levels-test.js
 *
 * Runs the preview (and, for the sync checks, the Pi's real hub server
 * through dev/awws-harness.js) and opens the hub in headless Chromium at
 * 1920x1080 with the clock fixed on Tuesday 17 November 2026 in Chicago and
 * this list kept on the TV:
 *
 *   must      "Take weekly shot", due today
 *   optional  "Buy the olive oil set" (notes "Go back to the olive oil store.")
 *   optional  "Call the dentist"
 *   passive   "Concert tickets on sale Fri", due in 2 days
 *
 * It checks:
 *   - old items (section now, next or waiting, no level) are "If you can"
 *   - sections Must today (red) and If you can (yellow), then Done today; the
 *     colored edge on every row, the MUST pill on must-dos only
 *   - "Coming up": passive items only from 2 days before they are due (or
 *     with no date), no tick box, a green dot, under everything else
 *   - the must-do strip, its words for one and for two, and its pulse: still
 *     at 3 PM, faint at 6 PM, stronger at 11 PM, strongest at 1 AM the next
 *     day (the must-do is late); the tile's red edge; opacity is all that
 *     animates (3.5 s); no pulse in fade mode or with reduced motion
 *   - a passive item's own lead ("lead" field, or "[lead:N]" in its notes for
 *     an older Pi; the field wins; 0 means only on the day; a bad one is 2):
 *     Coming up from that many days before; the line says Today, Tomorrow or
 *     the day and "in N days", with no brackets or tags anywhere on screen
 *   - Move cycles must, optional, passive; an item added on the TV is
 *     optional; a "[level:must]" tag in the notes counts and is not shown
 *   - a level set on the TV reaches the Pi, and one set on the Pi reaches the TV;
 *     so does a lead set on the Pi
 *   - Spanish (the hub's language), and Spanish 25% longer: nothing cut
 *     sideways, room for accents (line height 1.3 or more)
 *   - the calendar prefix ("TODO!:", "TODO:", "TODO~:", any case, spaces or
 *     none after the colon) is never shown, in English or Spanish, but stays
 *     in the saved title; it sets the level of an item with no level field
 *     (before a notes tag); a title that is only a prefix shows as it is;
 *     "Todo list for Friday" and a "TODO:" later in a title are left alone
 *
 * Prints one line per check and "N passed, M failed".
 *
 *   --out <folder>    also write the screenshots there (todo-levels-*.png):
 *                     tile, panel and full screen, English and Spanish, at
 *                     3 PM, 6 PM, 11 PM and 1 AM, the pulse caught at its peak
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

// Times in Chicago (UTC-6 in November).
const TIMES = {
  '3pm': Date.parse('2026-11-17T21:00:00Z'),
  '6pm': Date.parse('2026-11-18T00:00:00Z'),
  '11pm': Date.parse('2026-11-18T05:00:00Z'),
  '1am': Date.parse('2026-11-18T07:00:00Z')
};
const CREATED = Date.parse('2026-11-17T14:00:00Z');

function items(extra) {
  return [
    { id: 'shot', title: 'Take weekly shot', level: 'must', section: 'now', due: '2026-11-17', done: false, doneAt: null, createdAt: CREATED },
    { id: 'olive', title: 'Buy the olive oil set', notes: 'Go back to the olive oil store.', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'dentist', title: 'Call the dentist', level: 'optional', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'concert', title: 'Concert tickets on sale Fri', level: 'passive', section: 'now', due: '2026-11-19', done: false, doneAt: null, createdAt: CREATED }
  ].concat(extra || []);
}

function storage(list) { return { 'homeHub.todo.v1': JSON.stringify({ v: 1, items: list }) }; }

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

// Holds every pulse at its peak, so a picture shows how strong it is.
async function peak(page) {
  await page.addStyleTag({ content: '.todo-glow::after { -webkit-animation-play-state: paused !important; animation-play-state: paused !important; -webkit-animation-delay: -1750ms !important; animation-delay: -1750ms !important; }' });
  await H.sleep(150);
}

async function shot(page, name, clip) {
  if (!OUT) return;
  const file = path.join(OUT, 'todo-levels-' + name + '.png');
  const o = { path: file };
  if (clip) {
    const r = await page.evaluate(() => {
      const t = document.querySelector('.cell[data-widget="todo"] .tile').getBoundingClientRect();
      return { x: t.left, y: t.top, w: t.width, h: t.height };
    });
    const m = 28;
    o.clip = { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: r.w + 2 * m, height: r.h + 2 * m };
  }
  await page.screenshot(o);
  written.push(file);
}

// What the tile, or the panel, shows.
function look(page) {
  return page.evaluate(() => {
    function text(n) { return n ? n.textContent : null; }
    function sideways(n) { return n.scrollWidth > n.clientWidth + 1; }
    const tile = document.querySelector('.cell[data-widget="todo"] .tile');
    const panel = document.querySelector('#panel .todo-panel');
    const out = { tile: {}, panel: null };
    const tglow = tile.querySelector('.todo-tile-glow .todo-glow');
    out.tile.edge = !!tile.querySelector('.todo-tile-glow');
    out.tile.glow = tglow ? (tglow.style.display === 'none' ? 0 : parseFloat(tglow.style.opacity)) : null;
    out.tile.alert = text(tile.querySelector('.todo-alert-text'));
    out.tile.rows = Array.prototype.map.call(tile.querySelectorAll('.todo-tile-row'), (r) => ({
      title: r.querySelector('.todo-tile-title').firstChild.nodeValue, lv: r.className.replace(/.*lv-(\w+).*/, '$1'),
      pill: text(r.querySelector('.todo-must-pill')),
      edge: getComputedStyle(r.querySelector('.todo-lv')).backgroundColor
    }));
    out.tile.foot = Array.prototype.map.call(tile.querySelectorAll('.todo-foot-line'), (r) => r.textContent);
    out.tile.footLabel = text(tile.querySelector('.todo-foot-label'));
    if (panel) {
      const glow = panel.querySelector('.todo-alert .todo-glow');
      out.panel = {
        alert: text(panel.querySelector('.todo-alert-text')),
        glow: glow ? (glow.style.display === 'none' ? 0 : parseFloat(glow.style.opacity)) : null,
        anim: glow ? getComputedStyle(glow, '::after').animationName : null,
        dur: glow ? getComputedStyle(glow, '::after').animationDuration : null,
        secs: Array.prototype.map.call(panel.querySelectorAll('.todo-sec'), (s) => {
          const name = s.querySelector('.todo-sec-name');
          return { key: s.className.replace(/.*todo-sec-(\w+).*/, '$1'), name: text(name), color: getComputedStyle(name).color,
            shown: getComputedStyle(s).display !== 'none',
            rows: Array.prototype.map.call(s.querySelectorAll('.todo-row'), (r) => ({ title: r.querySelector('.todo-title').firstChild.nodeValue,
              lv: r.className.replace(/.*lv-(\w+).*/, '$1'), pill: text(r.querySelector('.todo-must-pill')), tick: !!r.querySelector('.todo-tick'),
              notes: text(r.querySelector('.todo-notes')), due: text(r.querySelector('.todo-due')) })) };
        }),
        foot: Array.prototype.map.call(panel.querySelectorAll('.todo-panel-foot .todo-row'), (r) => ({
          title: r.querySelector('.todo-title').firstChild.nodeValue, tick: !!r.querySelector('.todo-tick'), dot: !!r.querySelector('.todo-dot'),
          due: text(r.querySelector('.todo-due')) })),
        footLabel: text(panel.querySelector('.todo-foot-label')),
        footLast: !!panel.querySelector('.todo-panel-foot') && !panel.querySelector('.todo-panel-foot').nextElementSibling
      };
    }
    // Fit: text cut sideways, line height under 1.3, the pill or strip outside its box.
    const bad = [];
    const nodes = document.querySelectorAll('.todo-alert-text, .todo-must-pill, .todo-title, .todo-tile-title, .todo-sec-name, .todo-foot-label, .todo-foot-line, .todo-foot-when, .todo-due');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.offsetParent) continue;
      const cs = getComputedStyle(n);
      const ratio = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
      if (ratio < 1.295) bad.push(n.className + ' line-height ' + ratio.toFixed(2));
      if (!n.classList.contains('todo-foot-line') && sideways(n)) bad.push(n.className + ' cut sideways: ' + n.textContent);
    }
    // The when of a Coming up line on the tile is never pushed out of its line.
    const whens = document.querySelectorAll('.todo-foot-when');
    for (let w = 0; w < whens.length; w++) {
      const r = whens[w].getBoundingClientRect();
      const line = whens[w].parentNode.getBoundingClientRect();
      if (r.right > line.right + 1 || r.width < 1) bad.push('when cut: ' + whens[w].textContent);
    }
    const pills = document.querySelectorAll('.todo-must-pill');
    for (let j = 0; j < pills.length; j++) {
      const p = pills[j].getBoundingClientRect();
      const box = (pills[j].closest('.todo-row') || pills[j].closest('.todo-tile-row')).getBoundingClientRect();
      if (p.right > box.right + 1 || p.left < box.left - 1) bad.push('pill outside its row: ' + pills[j].textContent);
    }
    const alerts = document.querySelectorAll('.todo-alert');
    for (let k = 0; k < alerts.length; k++) {
      const t = alerts[k].querySelector('.todo-alert-text');
      if (t.scrollHeight > t.clientHeight + 1 && t.getClientRects().length && t.clientHeight / parseFloat(getComputedStyle(t).lineHeight) < 1.9) bad.push('strip cut: ' + t.textContent);
    }
    out.bad = bad;
    return out;
  });
}

function near(a, b) { return Math.abs(a - b) < 0.011; }
const RED = 'rgb(255, 107, 107)';
const YELLOW = 'rgb(255, 201, 77)';

async function openAt(env, when, o) {
  return env.newPage(Object.assign({ layout: LAYOUT, scale: SCALE, live: 'off', at: TIMES[when], motion: 'push', storage: storage(items()) }, o || {}));
}

/* ---------- English and Spanish, four times of day ---------- */

async function times(env, lang) {
  const es = lang === 'es';
  const W = es
    ? { must: 'Para hoy', optional: 'Si puedes', coming: 'Próximamente', pill: 'CLAVE', alert: '1 tarea clave para hoy: Take weekly shot' }
    : { must: 'Must today', optional: 'If you can', coming: 'Coming up', pill: 'MUST', alert: '1 must-do today: Take weekly shot' };
  const expect = { '3pm': 0, '6pm': 0.15 + 0.4 * (60 / 419), '11pm': 0.15 + 0.4 * (360 / 419), '1am': 0.55 };
  for (const when of Object.keys(TIMES)) {
    const page = await openAt(env, when, { lang: es ? 'es' : undefined });
    try {
      let s = await look(page);
      await check(lang + ' ' + when + ': the tile shows the strip, the red edge, the rows by level and Coming up', async () => {
        assert(s.tile.alert === W.alert, 'strip: ' + s.tile.alert);
        assert(s.tile.edge, 'no red edge on the tile');
        assert(near(s.tile.glow, Math.round(expect[when] * 100) / 100), 'tile glow ' + s.tile.glow + ', want ' + expect[when].toFixed(2));
        assert(JSON.stringify(s.tile.rows.map((r) => r.title + ':' + r.lv)) ===
          JSON.stringify(['Take weekly shot:must', 'Buy the olive oil set:optional', 'Call the dentist:optional']), JSON.stringify(s.tile.rows));
        assert(s.tile.rows[0].pill === W.pill && !s.tile.rows[1].pill && !s.tile.rows[2].pill, 'pills: ' + JSON.stringify(s.tile.rows));
        assert(s.tile.rows[0].edge === RED && s.tile.rows[1].edge === YELLOW, 'edges: ' + JSON.stringify(s.tile.rows));
        assert(s.tile.footLabel === W.coming && s.tile.foot.length === 1 && s.tile.foot[0].indexOf('Concert tickets on sale Fri') === 0, 'foot: ' + JSON.stringify(s.tile.foot));
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await peak(page);
      await shot(page, 'tile-' + lang + '-' + when, true);

      await H.openPanel(page, 'todo');
      s = await look(page);
      await check(lang + ' ' + when + ': the panel has Must today, If you can, the strip and Coming up last', async () => {
        const p = s.panel;
        assert(p.alert === W.alert, 'strip: ' + p.alert);
        assert(near(p.glow, Math.round(expect[when] * 100) / 100), 'glow ' + p.glow);
        assert(p.anim === 'todo-pulse' && p.dur === '3.5s', 'pulse ' + p.anim + ' ' + p.dur);
        const shown = p.secs.filter((x) => x.shown);
        assert(shown.map((x) => x.key).join() === 'must,optional', 'sections: ' + shown.map((x) => x.key));
        assert(shown[0].name === W.must && shown[0].color === RED, 'must heading ' + shown[0].name + ' ' + shown[0].color);
        assert(shown[1].name === W.optional && shown[1].color === YELLOW, 'optional heading ' + shown[1].name + ' ' + shown[1].color);
        assert(shown[0].rows.length === 1 && shown[0].rows[0].pill === W.pill, 'must rows ' + JSON.stringify(shown[0].rows));
        assert(shown[1].rows.map((r) => r.title).join() === 'Buy the olive oil set,Call the dentist' && shown[1].rows.every((r) => !r.pill), JSON.stringify(shown[1].rows));
        assert(shown[1].rows[0].notes === 'Go back to the olive oil store.', 'notes ' + shown[1].rows[0].notes);
        assert(p.footLabel === W.coming && p.foot.length === 1 && !p.foot[0].tick && p.foot[0].dot && p.footLast, 'foot ' + JSON.stringify(p.foot));
        if (when === '1am') assert(shown[0].rows[0].due === (es ? 'Atrasada' : 'Overdue'), 'late must says ' + shown[0].rows[0].due);
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await shot(page, 'panel-' + lang + '-' + when);

      await H.fullScreen(page);
      s = await look(page);
      await check(lang + ' ' + when + ': full screen fits', async () => {
        assert(s.panel.alert === W.alert && s.panel.foot.length === 1 && s.panel.footLast, JSON.stringify(s.panel));
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await shot(page, 'full-' + lang + '-' + when);
      const errors = H.errorsOf(page, true);
      await check(lang + ' ' + when + ': no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
    } finally {
      await page.ctx.close();
    }
  }
}

/* ---------- the rules, one at a time ---------- */

async function rules(env) {
  // Old items, passives near and far, two must-dos, a tag in the notes.
  const list = [
    { id: 'm1', title: 'Pay the rent', level: 'must', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'm2', title: 'Renew the passport', notes: 'Photos first. [level:must] [cal:abc123@2026-11-17]', section: 'next', done: false, doneAt: null, createdAt: CREATED },
    { id: 'm3', title: 'Must, but later', level: 'must', section: 'now', due: '2026-11-25', done: false, doneAt: null, createdAt: CREATED },
    { id: 'o1', title: 'Old now item', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'o2', title: 'Old next item', section: 'next', done: false, doneAt: null, createdAt: CREATED },
    { id: 'o3', title: 'Old waiting item', section: 'waiting', done: false, doneAt: null, createdAt: CREATED },
    { id: 'o4', title: 'Bad level', level: 'urgent', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'p0', title: 'Passive today', level: 'passive', section: 'now', due: '2026-11-17', done: false, doneAt: null, createdAt: CREATED },
    { id: 'p1', title: 'Passive tomorrow', level: 'passive', section: 'now', due: '2026-11-18', done: false, doneAt: null, createdAt: CREATED },
    { id: 'p2', title: 'Passive in 2 days', level: 'passive', section: 'now', due: '2026-11-19', done: false, doneAt: null, createdAt: CREATED },
    { id: 'p3', title: 'Passive in 3 days', level: 'passive', section: 'now', due: '2026-11-20', done: false, doneAt: null, createdAt: CREATED },
    { id: 'p4', title: 'Passive, no date', level: 'passive', section: 'now', done: false, doneAt: null, createdAt: CREATED }
  ];
  const page = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['6pm'], motion: 'push', storage: storage(list) });
  try {
    await H.openPanel(page, 'todo');
    const s = await look(page);
    await check('old items (now, next, waiting, an unknown level) are "If you can"', async () => {
      const opt = s.panel.secs.find((x) => x.key === 'optional');
      assert(opt.rows.map((r) => r.title).join() === 'Old now item,Old next item,Old waiting item,Bad level', JSON.stringify(opt.rows));
    });
    await check('a "[level:must]" tag counts, and tags are not shown', async () => {
      const must = s.panel.secs.find((x) => x.key === 'must');
      assert(must.rows.map((r) => r.title).join() === 'Pay the rent,Renew the passport,Must, but later', JSON.stringify(must.rows));
      assert(must.rows[1].notes === 'Photos first.', 'notes ' + must.rows[1].notes);
    });
    await check('the strip counts must-dos for today only, and says "must-dos" for two', async () => {
      assert(s.panel.alert === '2 must-dos today: Pay the rent', s.panel.alert);
    });
    await check('Coming up: passives due today, tomorrow and in 2 days, and one with no date; not in 3 days', async () => {
      assert(s.panel.foot.map((f) => f.title).join() === 'Passive today,Passive tomorrow,Passive in 2 days,Passive, no date', JSON.stringify(s.panel.foot));
      assert(s.panel.foot.map((f) => f.due).join() === 'Today,Tomorrow,Thu · in 2 days,', JSON.stringify(s.panel.foot));
      assert(s.panel.foot.every((f) => !f.tick && f.dot), 'a passive line has a tick box');
    });
    await check('Move cycles must, optional, passive, must, and the label says where', async () => {
      const labels = [];
      for (let i = 0; i < 3; i++) {
        const lv = await page.evaluate(() => {
          const it = JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.find((x) => x.id === 'm1');
          return it.level;
        });
        labels.push(lv + '>' + await page.evaluate(() => document.querySelector('#panel [data-key="move:m1"]').getAttribute('aria-label')));
        await page.evaluate(() => {
          const node = document.querySelector('#panel [data-key="move:m1"]');
          node.click();
        });
        await H.sleep(150);
      }
      const last = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.find((x) => x.id === 'm1').level);
      assert(labels.join(' ') === 'must>To If you can optional>To Coming up passive>To Must today' && last === 'must', labels.join(' ') + ' then ' + last);
    });
    await check('an item added on the TV is "If you can"', async () => {
      await page.click('#panel input.todo-input');
      await page.keyboard.type('Water the plants');
      await page.keyboard.press('Enter');
      await H.sleep(300);
      const it = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.find((x) => x.title === 'Water the plants'));
      assert(it && it.level === 'optional', JSON.stringify(it));
    });
    await check('only opacity animates in todo.css', async () => {
      const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'widgets', 'todo.css'), 'utf8');
      const frames = css.match(/@(-webkit-)?keyframes[^{]+\{([^{}]*\{[^}]*\})*\s*\}/g) || [];
      assert(frames.length >= 8, 'found ' + frames.length + ' keyframes');
      frames.forEach((f) => {
        const props = (f.match(/([a-z-]+)\s*:/g) || []).map((p) => p.replace(/\s*:$/, ''));
        props.forEach((p) => assert(['opacity', 'transform', '-webkit-transform'].indexOf(p) >= 0, 'animates ' + p));
      });
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'todo.css must end with .css-end');
    });
  } finally {
    await page.ctx.close();
  }

  // Each passive item's own lead, from a field or a "[lead:N]" tag.
  const leads = [
    { id: 'l3', title: 'School meeting', level: 'passive', section: 'now', due: '2026-11-20', lead: 3, done: false, doneAt: null, createdAt: CREATED },
    { id: 'l0a', title: 'Only today', level: 'passive', section: 'now', due: '2026-11-17', lead: 0, done: false, doneAt: null, createdAt: CREATED },
    { id: 'l0b', title: 'Only tomorrow', level: 'passive', section: 'now', due: '2026-11-18', lead: 0, done: false, doneAt: null, createdAt: CREATED },
    { id: 'lt', title: 'Book club', section: 'now', due: '2026-11-27', notes: 'Bring the book. [level:passive] [lead:10] [cal:abc123@2026-11-27]', done: false, doneAt: null, createdAt: CREATED },
    { id: 'lw', title: 'Field wins', level: 'passive', section: 'now', due: '2026-11-20', lead: 1, notes: '[lead:10]', done: false, doneAt: null, createdAt: CREATED },
    { id: 'lb', title: 'Bad lead', level: 'passive', section: 'now', due: '2026-11-20', lead: 45, done: false, doneAt: null, createdAt: CREATED },
    { id: 'lx', title: 'Flu shot [cal:zz9@2026-11-18]', level: 'passive', section: 'now', due: '2026-11-18', done: false, doneAt: null, createdAt: CREATED },
    { id: 'l30', title: 'Far off', level: 'passive', section: 'now', due: '2026-12-17', lead: 30, done: false, doneAt: null, createdAt: CREATED }
  ];
  for (const lang of ['en', 'es']) {
    const es = lang === 'es';
    const lp = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['6pm'], motion: 'push', lang: es ? 'es' : undefined, storage: storage(leads) });
    try {
      const want = es
        ? [['School meeting', 'vie · en 3 días'], ['Only today', 'Hoy'], ['Book club', '27 nov · en 10 días'], ['Flu shot', 'Mañana'], ['Far off', '17 dic · en 30 días']]
        : [['School meeting', 'Fri · in 3 days'], ['Only today', 'Today'], ['Book club', 'Nov 27 · in 10 days'], ['Flu shot', 'Tomorrow'], ['Far off', 'Dec 17 · in 30 days']];
      let s = await look(lp);
      await check(lang + ' lead: each passive shows from its own lead (field, tag, 0, a bad one is 2), the tile shows clean lines', async () => {
        assert(s.tile.foot.length === 2, 'tile foot: ' + JSON.stringify(s.tile.foot));
        assert(s.tile.foot[0] === 'School meeting· ' + want[0][1] && s.tile.foot[1] === 'Only today· ' + want[1][1], 'tile foot: ' + JSON.stringify(s.tile.foot));
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await H.openPanel(lp, 'todo');
      s = await look(lp);
      await check(lang + ' lead: the panel says Today, Tomorrow or the day and "in N days", with no brackets', async () => {
        const got = s.panel.foot.map((f) => [f.title, f.due]);
        assert(JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
        const shown = await lp.evaluate(() => document.querySelector('#panel .todo-panel').textContent + document.querySelector('.cell[data-widget="todo"] .tile').textContent);
        assert(shown.indexOf('[') < 0 && shown.indexOf(']') < 0, 'brackets on screen');
        assert(!s.bad.length, s.bad.join(' | '));
      });
      if (OUT) await shot(lp, 'lead-panel-' + lang);
      await H.fullScreen(lp);
      s = await look(lp);
      await check(lang + ' lead: full screen fits', async () => { assert(!s.bad.length, s.bad.join(' | ')); });
      if (OUT) await shot(lp, 'lead-full-' + lang);
      const errors = H.errorsOf(lp, true);
      await check(lang + ' lead: no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
    } finally {
      await lp.ctx.close();
    }
  }

  // Fade mode and reduced motion: no pulse.
  for (const mode of ['fade', 'reduce']) {
    const p = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['11pm'], motion: mode === 'fade' ? 'fade' : 'push', storage: storage(items()) });
    try {
      if (mode === 'reduce') await p.emulateMedia({ reducedMotion: 'reduce' });
      await H.openPanel(p, 'todo');
      const s = await look(p);
      await check('no pulse ' + (mode === 'fade' ? 'in fade mode' : 'with reduced motion') + ', the glow just stays', async () => {
        assert(s.panel.anim === 'none', 'animation ' + s.panel.anim);
        const o = await p.evaluate(() => getComputedStyle(document.querySelector('#panel .todo-glow'), '::after').opacity);
        assert(o === '0.6', 'opacity ' + o);
      });
    } finally {
      await p.ctx.close();
    }
  }

  // Before 5 PM with a must-do, the strip is still; no must-do, no strip.
  const quiet = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['3pm'], motion: 'push',
    storage: storage(items().filter((i) => i.level !== 'must')) });
  try {
    const s = await look(quiet);
    await check('no open must-do: no strip and no red edge', async () => {
      assert(!s.tile.alert && !s.tile.edge, JSON.stringify(s.tile));
    });
  } finally {
    await quiet.ctx.close();
  }

  // Spanish 25% longer, with accents: still fits.
  const long = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['11pm'], motion: 'push', lang: 'es',
    storage: storage(items([{ id: 'long', title: 'Ángela: ¿Ñandú? Él llevará la documentación médica completa', level: 'must', section: 'now', done: false, doneAt: null, createdAt: CREATED },
      { id: 'longp', title: 'Reunión de la escuela: ¿Qué llevarán Íñigo y Ángela?', level: 'passive', section: 'now', due: '2026-11-21', lead: 5, done: false, doneAt: null, createdAt: CREATED }])) });
  try {
    await long.evaluate(() => {
      const es = window.HUB_I18N.strings.es;
      Object.keys(es).forEach((k) => {
        if (k.indexOf('todo.') !== 0 || k === 'todo.dateShort') return;
        const v = es[k];
        es[k] = v + ' ' + 'ÁÉñ¿¡'.repeat(Math.max(1, Math.ceil(v.replace(/\{\w+\}/g, '').length * 0.25 / 5))).slice(0, Math.max(2, Math.ceil(v.length * 0.25)));
      });
      window.HUB_I18N.setLang('en');
      window.HUB_I18N.setLang('es');
    });
    await H.sleep(300);
    let s = await look(long);
    await check('Spanish 25% longer on the tile: nothing cut sideways, room for accents', async () => {
      assert(s.tile.alert && s.tile.alert.indexOf('ÁÉñ') > 0, 'the longer words did not apply: ' + s.tile.alert);
      assert(s.tile.foot.some((f) => /sáb · en 4 días ÁÉ/.test(f)), 'the longer "in N days" is not on the tile: ' + JSON.stringify(s.tile.foot));
      assert(!s.bad.length, s.bad.join(' | '));
    });
    await H.openPanel(long, 'todo');
    s = await look(long);
    await check('Spanish 25% longer in the panel: nothing cut sideways, room for accents', async () => {
      assert(!s.bad.length, s.bad.join(' | '));
    });
    await H.fullScreen(long);
    s = await look(long);
    await check('Spanish 25% longer in full screen: nothing cut sideways, room for accents', async () => {
      assert(!s.bad.length, s.bad.join(' | '));
    });
    if (OUT) await shot(long, 'stress-es-long-full');
  } finally {
    await long.ctx.close();
  }
}

/* ---------- the calendar prefix ---------- */

async function prefixes(env) {
  const list = [
    { id: 'x1', title: 'TODO!: Take weekly shot', section: 'now', due: '2026-11-17', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x2', title: 'TODO!:Take the bins out', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x3', title: 'todo:Call the dentist', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x4', title: 'TODO:   Buy the olive oil set', notes: 'Go back to the olive oil store.', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x5', title: 'Todo list for Friday', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x6', title: 'Ask about TODO: later', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x7', title: 'TODO~: Concert tickets on sale Fri', section: 'now', due: '2026-11-19', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x8', title: 'Todo~:Passive, no date', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'x9', title: 'TODO!:', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'xa', title: 'TODO~: Level field wins', level: 'must', section: 'now', done: false, doneAt: null, createdAt: CREATED },
    { id: 'xb', title: 'TODO!: Prefix beats the tag', notes: 'Soon. [level:passive] [cal:abc@2026-11-17]', section: 'now', done: false, doneAt: null, createdAt: CREATED }
  ];
  // As saved (spaces tidied), in any order (Move puts an item last).
  const before = JSON.stringify(list.map((i) => i.title.replace(/\s+/g, ' ')).sort());
  for (const lang of ['en', 'es']) {
    const page = await env.newPage({ layout: LAYOUT, live: 'off', at: TIMES['6pm'], motion: 'push', lang: lang === 'es' ? 'es' : undefined, storage: storage(list) });
    try {
      let s = await look(page);
      const strip = lang === 'es' ? '5 tareas clave para hoy: Take weekly shot' : '5 must-dos today: Take weekly shot';
      await check(lang + ' prefix: the tile strip and rows show titles without it', async () => {
        assert(s.tile.alert === strip, 'strip: ' + s.tile.alert);
        assert(s.tile.rows.length > 0 && s.tile.rows.every((r) => !/^todo[!~]?:./i.test(r.title)), JSON.stringify(s.tile.rows));
        assert(s.tile.rows[0].title === 'Take weekly shot' && s.tile.rows[0].lv === 'must', JSON.stringify(s.tile.rows[0]));
        assert(s.tile.foot[0].indexOf('Concert tickets on sale Fri') === 0, 'foot: ' + JSON.stringify(s.tile.foot));
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await H.openPanel(page, 'todo');
      s = await look(page);
      await check(lang + ' prefix: the panel hides it, and it sets the level', async () => {
        const sec = (k) => s.panel.secs.find((x) => x.key === k).rows.map((r) => r.title).join('|');
        assert(s.panel.alert === strip, 'strip: ' + s.panel.alert);
        assert(sec('must') === 'Take weekly shot|Take the bins out|TODO!:|Level field wins|Prefix beats the tag', 'must: ' + sec('must'));
        assert(sec('optional') === 'Call the dentist|Buy the olive oil set|Todo list for Friday|Ask about TODO: later', 'optional: ' + sec('optional'));
        assert(s.panel.foot.map((f) => f.title).join('|') === 'Concert tickets on sale Fri|Passive, no date', 'foot: ' + JSON.stringify(s.panel.foot));
        const must = s.panel.secs.find((x) => x.key === 'must').rows;
        assert(must[4].notes === 'Soon.', 'notes ' + must[4].notes);
        const opt = s.panel.secs.find((x) => x.key === 'optional').rows;
        assert(opt[1].notes === 'Go back to the olive oil store.', 'notes ' + opt[1].notes);
        assert(!s.bad.length, s.bad.join(' | '));
      });
      if (lang === 'en') {
        await check('prefix: Move on a prefixed item sets its level field and keeps the title', async () => {
          await page.evaluate(() => document.querySelector('#panel [data-key="move:x1"]').click());
          await H.sleep(150);
          const it = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.find((x) => x.id === 'x1'));
          assert(it.level === 'optional' && it.title === 'TODO!: Take weekly shot', JSON.stringify(it));
        });
      }
      await H.fullScreen(page);
      s = await look(page);
      await check(lang + ' prefix: full screen hides it too', async () => {
        const all = s.panel.secs.reduce((a, x) => a.concat(x.rows.map((r) => r.title)), []).concat(s.panel.foot.map((f) => f.title));
        assert(all.filter((t) => /^todo[!~]?:\s*\S/i.test(t)).length === 0, JSON.stringify(all));
        assert(!s.bad.length, s.bad.join(' | '));
      });
      await check(lang + ' prefix: the saved titles still have it', async () => {
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.map((i) => i.title.replace(/\s+/g, ' ')).sort());
        assert(JSON.stringify(saved) === before, JSON.stringify(saved));
      });
      const errors = H.errorsOf(page, true);
      await check(lang + ' prefix: no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
    } finally {
      await page.ctx.close();
    }
  }
}

/* ---------- with the Pi ---------- */

async function withPi(env) {
  const old = (await env.control('GET', '/api/todo')).items || [];
  const ops = old.map((i) => ({ op: 'remove', id: i.id }));
  items().forEach((it) => ops.push({ op: 'add', item: it, at: 'end' }));
  const r = await env.control('POST', '/api/todo/ops', { ops: ops });
  assert(r && r.ok, 'the Pi refused the items: ' + JSON.stringify(r));
  const page = await env.newPage({ layout: LAYOUT, motion: 'fade' });
  try {
    await H.until(() => page.evaluate(() => document.querySelectorAll('.cell[data-widget="todo"] .todo-tile-row').length >= 3), 8000, 'the tile did not show the items');
    await H.openPanel(page, 'todo');
    await check('Move on the TV sends the level to the Pi', async () => {
      // Down to "Call the dentist", Right to its Move button, OK.
      for (let i = 0; i < 4 && !(await page.evaluate(() => !!document.querySelector('#panel [data-key="item:dentist"].is-focused'))); i++) await H.key(page, 'ArrowDown');
      await H.key(page, 'ArrowRight');
      assert(await page.evaluate(() => !!document.querySelector('#panel [data-key="move:dentist"].is-focused')), 'Move did not get focus');
      await H.key(page, 'Enter');
      await H.until(async () => {
        const it = (await env.control('GET', '/api/todo')).items.find((i) => i.id === 'dentist');
        return it && it.level === 'passive';
      }, 6000, 'the Pi did not get the level').catch(async (e) => {
        const tv = await page.evaluate(() => [localStorage.getItem('homeHub.todo.v1'), localStorage.getItem('homeHub.todo.outbox'), document.querySelector('#panel [data-key="move:dentist"]') ? 'btn' : 'nobtn']);
        throw new Error(e.message + ' TV: ' + JSON.stringify(tv) + ' Pi: ' + JSON.stringify((await env.control('GET', '/api/todo')).items));
      });
    });
    await check('a level set on the Pi reaches the TV by itself', async () => {
      await env.control('POST', '/api/todo/ops', { ops: [{ op: 'set', id: 'olive', fields: { level: 'must' } }] });
      await H.until(() => page.evaluate(() => {
        const row = document.querySelector('#panel .todo-sec-must [data-key="item:olive"]');
        return !!row && /2 must-dos today/.test(document.querySelector('#panel .todo-alert-text').textContent);
      }), 6000, 'the TV did not take the new level');
    });
    await check('a lead set on the Pi reaches the TV: 0 hides a passive due in 2 days, 2 brings it back', async () => {
      const foot = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .todo-panel-foot .todo-title'), (n) => n.textContent));
      await H.until(async () => (await foot()).indexOf('Concert tickets on sale Fri') >= 0, 6000, 'Concert is not under Coming up to start with');
      await env.control('POST', '/api/todo/ops', { ops: [{ op: 'set', id: 'concert', fields: { lead: 0 } }] });
      await H.until(async () => (await foot()).indexOf('Concert tickets on sale Fri') < 0, 6000, 'lead 0 did not hide it: ' + JSON.stringify(await foot()));
      const it = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.v1')).items.find((x) => x.id === 'concert'));
      assert(it.lead === 0, 'the TV did not keep the lead: ' + JSON.stringify(it));
      await env.control('POST', '/api/todo/ops', { ops: [{ op: 'set', id: 'concert', fields: { lead: 2 } }] });
      await H.until(async () => (await foot()).indexOf('Concert tickets on sale Fri') >= 0, 6000, 'lead 2 did not bring it back');
    });
    const errors = H.errorsOf(page, true);
    await check('with the Pi: no page errors', async () => { assert(!errors.length, errors.join(' | ')); });
  } finally {
    await page.ctx.close();
  }
}

(async () => {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ snapshot: false, calendars: false, at: TIMES['3pm'] });
  try {
    await rules(env);
    await prefixes(env);
    await times(env, 'en');
    await times(env, 'es');
    await withPi(env);
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
