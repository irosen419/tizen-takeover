/*
 * Touch scrolling on the tablet: node dev/scroll-test.js
 *
 * The hub in tablet mode (?as=tablet, a touch screen) at 1920x800 and
 * 1280x600, in English and Spanish, with realistically long sample data (the
 * calendars, the A World Worth Saving and budget snapshots, a long to-do and
 * grocery list, the show sample, a room with many lights). For every widget
 * that opens a panel (window.HUB_WIDGETS, expandable), in its panel and at
 * full screen: every region of the panel whose content is taller than its box
 * (the panel body, or an inner clipped list) is swiped up with real touches
 * (CDP Input.dispatchTouchEvent, as a finger on Chrome 52 would) until it
 * stops; the region must have scrolled and its last row must end inside the
 * region and the screen. The shared mechanism is the "Touch scrolling" block
 * in app/tablet.css (docs/tablet-mode.md). A TV page (no ?as=) keeps the panel
 * body's overflow hidden and gets none of it.
 *
 * Prints one ok/FAIL line per widget x viewport x language and
 * "N passed, M failed"; exits 1 on a failure. ONLY=calendar,todo limits the
 * widgets, VIEW=1280 and LANG_ONLY=es the passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const VIEWS = [{ width: 1920, height: 800 }, { width: 1280, height: 600 }].filter((v) => !process.env.VIEW || String(v.width) === process.env.VIEW);
const LANGS = ['en', 'es'].filter((l) => !process.env.LANG_ONLY || process.env.LANG_ONLY === l);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
let failed = 0;
const failures = [];
function report(name, problems) {
  if (!problems.length) { passed += 1; console.log('ok   ' + name); return; }
  failed += 1;
  failures.push(name);
  console.log('FAIL ' + name + '\n     ' + problems.join('\n     '));
}
function assert(ok, text) { if (!ok) throw new Error(text); }

/* ---------- long sample data ---------- */

const TODO_TITLES = ['Call the dentist about the cleaning', 'Renew the passport before the trip', 'Pick up the dry cleaning', 'Book the car service',
  'Send the thank-you cards', 'Return the library books', 'Order new air filters', 'Pay the water bill', 'Schedule the furnace check',
  'Buy a birthday present for Mom', 'Clean out the garage shelves', 'Fix the squeaky hinge', 'Plan the weekend trip', 'Back up the laptop',
  'Wrap the holiday gifts', 'Replace the smoke alarm batteries', 'Donate the old coats', 'Print the boarding passes', 'Water the plants',
  'Sort the mail on the desk', 'Write the school email', 'Check the tire pressure'];
function todoOps(old) {
  const ops = old.map((i) => ({ op: 'remove', id: i.id }));
  TODO_TITLES.forEach((t, i) => {
    const item = { id: 'scroll-' + i, title: t, level: i % 5 === 0 ? 'must' : 'optional', done: false, doneAt: null, createdAt: H.MONDAY - i * 60000 };
    if (i % 3 === 0) item.notes = 'A longer note under the title, so the row takes two lines on the tablet.';
    if (i % 4 === 1) item.due = '2026-11-' + String(17 + (i % 10)).padStart(2, '0');
    ops.push({ op: 'add', item: item, at: 'end' });
  });
  return ops;
}
const GROCERIES = ['Milk', 'Eggs', 'Bread', 'Butter', 'Apples', 'Bananas', 'Spinach', 'Carrots', 'Onions', 'Garlic', 'Rice', 'Pasta', 'Tomatoes',
  'Cheddar cheese', 'Greek yogurt', 'Chicken thighs', 'Ground coffee', 'Olive oil', 'Black beans', 'Tortillas', 'Lemons', 'Avocados',
  'Paper towels', 'Dish soap', 'Oat milk', 'Peanut butter', 'Frozen peas', 'Cereal', 'Honey', 'Salsa'];

// The show sample as the Pi publishes it (no episode lists), and a room with many lights.
function showsData() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pi', 'fixtures', 'shows-sample.json'), 'utf8'));
  const shift = H.MONDAY - Date.parse(raw.sampleToday);
  const move = (v) => (typeof v === 'string' && isFinite(Date.parse(v)) && /T/.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v);
  raw.shows.forEach((s) => {
    delete s.episodes;
    if (s.nextEpisode) s.nextEpisode.airstamp = move(s.nextEpisode.airstamp);
    (s.upcoming || []).forEach((e) => { e.airstamp = move(e.airstamp); });
    if (s.returning) s.returning.airstamp = move(s.returning.airstamp);
  });
  delete raw.about;
  delete raw.sampleToday;
  raw.sample = true;
  return raw;
}
function ambienceData(base) {
  const names = ['Floor lamp', 'Ceiling light', 'Desk lamp', 'Bedside left', 'Bedside right', 'Hallway', 'Porch light', 'Kitchen island',
    'Dining pendant', 'Reading lamp', 'TV backlight', 'Bookshelf strip', 'Bathroom mirror', 'Closet light'];
  const out = Object.assign({}, base || {});
  out.lights = names.map((n, i) => ({ id: 'l' + i, name: n, kind: 'light', on: i % 3 !== 0, pct: 20 + i * 5, reachable: true, tone: '#ffd6aa' }));
  out.scenes = ['Chill', 'Bright', 'Movie', 'Dinner', 'Reading', 'Night'].map((n) => ({ id: n.toLowerCase(), name: n, icon: 'sparkle' }));
  out.moods = [{ id: 'dim', name: 'Dim' }, { id: 'warm', name: 'Warm' }, { id: 'party', name: 'Party' }];
  out.state = 'ok';
  return out;
}

// Long shows and lights into the live state the page reads (/live/state and /live/poll).
async function richLive(env, context) {
  const shows = showsData();
  await context.route(env.LIVE + '/live/events**', (route) => route.abort('connectionrefused'));
  await context.route(/\/live\/(state|poll)/, async (route) => {
    let res;
    try { res = await route.fetch(); } catch (e) { return route.abort(); }
    let body = await res.text();
    try {
      const j = JSON.parse(body);
      const rs = j.resources || (j.changes && j.changes.resources);
      if (rs) {
        if (rs.shows) rs.shows.data = shows;
        if (rs.ambience) rs.ambience.data = ambienceData(rs.ambience.data);
      }
      body = JSON.stringify(j);
    } catch (e) { /* leave it */ }
    return route.fulfill({ response: res, body: body });
  });
}

/* ---------- measuring ---------- */

// Every region of the open panel whose content is taller than its box and
// that a finger would need to scroll: the panel body, or a visible inner box
// at least 60 px tall that clips (or scrolls) more than 12 px of content.
// Line-clamped text and single-line ellipses are not regions.
function regions(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('panel');
    const out = [];
    const all = [panel.querySelector('.panel-body')].concat(Array.prototype.slice.call(panel.querySelectorAll('.panel-body *')));
    all.forEach((n, i) => {
      if (!n || n.nodeType !== 1) return;
      const cs = getComputedStyle(n);
      if (!/hidden|clip|auto|scroll/.test(cs.overflowY)) return;
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return;
      if (n.clientHeight < 60 || n.scrollHeight - n.clientHeight <= 12) return;
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || cs.visibility === 'hidden') return;
      // Inside a region already listed with the same box: skip.
      n.setAttribute('data-scroll-test', String(i));
      out.push({ id: String(i), cls: (n.className && n.className.baseVal === undefined ? n.className : n.tagName).toString().split(' ').slice(0, 2).join('.'), sh: n.scrollHeight, ch: n.clientHeight, oy: cs.overflowY });
    });
    return out;
  });
}

// Up to 12 finger swipes up in the region, until it stops moving.
async function swipe(page, cdp, id) {
  const sel = '[data-scroll-test="' + id + '"]';
  // From the top, as a fresh look would (the panel's own scroll may linger from the small panel).
  const start = await page.evaluate((s) => { const n = document.querySelector(s); n.scrollTop = 0; return n.scrollTop; }, sel);
  await H.sleep(100);
  let last = -1;
  for (let k = 0; k < 12; k++) {
    const at = await page.evaluate((s) => {
      const n = document.querySelector(s);
      const r = n.getBoundingClientRect();
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, window.innerHeight);
      // A point in the region that is not over an inner region that scrolls by itself.
      function owner(hit) {
        for (let a = hit; a && a !== document.body; a = a.parentNode) {
          if (a === n) return true;
          if (/hidden|clip|auto|scroll/.test(getComputedStyle(a).overflowY) && a.scrollHeight - a.clientHeight > 12 && a.clientHeight >= 60) return false;
        }
        return false;
      }
      const xs = [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95];
      const ys = [0.75, 0.5, 0.9, 0.3];
      for (let j = 0; j < ys.length; j++) {
        for (let i = 0; i < xs.length; i++) {
          const x = r.left + r.width * xs[i];
          const y = top + (bottom - top) * ys[j];
          const hit = document.elementFromPoint(x, y);
          if (hit && owner(hit)) return { x: x, y: y, dy: Math.min(360, (y - top) * 0.7), top: n.scrollTop };
        }
      }
      return { x: r.left + r.width / 2, y: top + (bottom - top) * 0.75, dy: Math.min(360, (bottom - top) * 0.55), top: n.scrollTop, covered: true };
    }, sel);
    if (at.top === last) break;
    last = at.top;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y - at.dy * i / 8 }] });
      await H.sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await H.sleep(350);
  }
  return page.evaluate(([s, top0]) => {
    const n = document.querySelector(s);
    const r = n.getBoundingClientRect();
    // The last thing drawn in it: the deepest last visible child.
    let last = n.lastElementChild;
    while (last && getComputedStyle(last).display === 'none') last = last.previousElementSibling;
    let lastBottom = last ? last.getBoundingClientRect().bottom : r.bottom;
    const panel = document.getElementById('panel').getBoundingClientRect();
    return {
      moved: n.scrollTop - top0, top: n.scrollTop, max: n.scrollHeight - n.clientHeight,
      lastBottom: Math.round(lastBottom), boxBottom: Math.round(r.bottom), screen: window.innerHeight, panelBottom: Math.round(panel.bottom)
    };
  }, [sel, start]);
}

async function checkMode(page, cdp, label, problems) {
  const list = await regions(page);
  for (const reg of list) {
    const s = await swipe(page, cdp, reg.id);
    const name = label + ' .' + reg.cls + ' (' + reg.ch + '/' + reg.sh + ', ' + reg.oy + ')';
    if (!(s.moved > 0) || s.top < s.max - 2) problems.push(name + ' did not scroll to its end: ' + JSON.stringify(s));
    else if (s.lastBottom > s.boxBottom + 2 || s.lastBottom > s.screen + 1) problems.push(name + ' last row still hidden: ' + JSON.stringify(s));
  }
  return list.length;
}

async function openIt(page, id) {
  const ok = await page.evaluate((w) => window.HUB_TEST.openPanel(w), id);
  if (!ok) return false;
  await H.until(() => page.evaluate((w) => window.HUB_TEST.open() === w, id), 5000, id + ' did not open');
  await H.idle(page);
  await H.sleep(400);
  return true;
}

async function closeIt(page) {
  await page.evaluate(() => window.HUB_TEST.closePanel());
  await H.until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 5000, 'did not close');
  await H.sleep(200);
}

// The widgets to try, grouped 12 to a layout (3x2 tiles on the 12x6 grid).
function layoutOf(ids) {
  return ids.map((id, i) => ({ widget: id, x: (i % 4) * 3, y: Math.floor(i / 4) * 2, w: 3, h: 2 }));
}

(async () => {
  const env = await H.start({ ownService: true });
  try {
    const old = (await env.control('GET', '/api/todo')).items || [];
    assert((await env.control('POST', '/api/todo/ops', { ops: todoOps(old) })).ok, 'to-dos refused');
    assert((await env.control('POST', '/api/grocery/ops', { ops: GROCERIES.map((n) => ({ op: 'add', name: n })) })).ok, 'groceries refused');
    await env.setBudget(H.budgetSample.snapshot());

    await (async () => {
      const problems = [];
      const p = await env.newPage({ layout: layoutOf(['calendar', 'todo']), touch: false });
      await openIt(p, 'calendar');
      const s = await p.evaluate(() => ({ tablet: document.body.classList.contains('tablet'), oy: getComputedStyle(document.querySelector('#panel .panel-body')).overflowY, ox: getComputedStyle(document.querySelector('#panel .panel-body')).overflowX }));
      if (s.tablet || s.oy !== 'hidden' || s.ox !== 'hidden') problems.push(JSON.stringify(s));
      await p.ctx.close();
      report('A TV page: the panel body stays overflow hidden, no tablet class', problems);
    })();

    // Which widgets open a panel.
    const probe = await env.newPage({ layout: layoutOf(['calendar']) });
    let ids = await probe.evaluate(() => {
      // As hub.js pickWidgets: a real widget beats a placeholder; expandable unless false.
      const byId = {};
      (window.HUB_WIDGETS || []).forEach((w) => {
        if (!w || !w.id || !w.title) return;
        const prev = byId[w.id];
        if (prev && !prev.planned && w.planned) return;
        byId[w.id] = w;
      });
      return Object.keys(byId).filter((id) => byId[id].expandable !== false);
    });
    await probe.ctx.close();
    if (ONLY) ids = ids.filter((id) => ONLY.indexOf(id) >= 0);
    const groups = [];
    for (let i = 0; i < ids.length; i += 12) groups.push(ids.slice(i, i + 12));

    for (const lang of LANGS) {
      for (const view of VIEWS) {
        for (const group of groups) {
          const p = await env.newPage({ layout: layoutOf(group), touch: true, query: 'as=tablet', lang: lang === 'es' ? 'es' : undefined, spanish: lang === 'es', route: (c) => richLive(env, c) });
          await p.setViewportSize(view);
          await H.sleep(600);
          await H.idle(p);
          const cdp = await p.ctx.newCDPSession(p);
          for (const id of group) {
            const name = id + ' ' + view.width + 'x' + view.height + ' ' + lang;
            const problems = [];
            let n = 0;
            try {
              if (!(await openIt(p, id))) { console.log('skip ' + name + ' (not on the layout or not openable)'); continue; }
              n += await checkMode(p, cdp, 'panel', problems);
              const canFull = await p.evaluate(() => window.HUB_TEST.mode() !== 'full' && getComputedStyle(document.querySelector('#panel .panel-btn')).display !== 'none');
              if (canFull) {
                await p.click('#panel .panel-btn');
                await H.until(() => p.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'no full screen');
                await H.idle(p);
                await H.sleep(400);
              }
              n += await checkMode(p, cdp, 'full', problems);
              await closeIt(p);
            } catch (e) {
              problems.push(String(e && e.message || e).split('\n')[0]);
              try { await closeIt(p); } catch (e2) { /* ignore */ }
            }
            report(name + ' (' + n + ' tall region' + (n === 1 ? '' : 's') + ')', problems);
          }
          await p.ctx.close();
        }
      }
    }
  } finally {
    await env.stop();
  }
  if (failures.length) console.log('Failed: ' + failures.join('; '));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
