/*
 * The money tiles, end to end: node dev/money-test.js
 *
 * Earned vs spent (awws-money, from the A World Worth Saving snapshot's money
 * section) and the personal budget tiles (budget-room, budget-card,
 * budget-goals, and the "New charge" banner, from the budget snapshot the
 * budget app sends to the Pi). Runs the real hub in headless Chromium
 * against the preview and the real hub server from pi/, with the clock fixed
 * at Monday 16 November 2026, 10:40 AM in Chicago (dev/awws-harness.js) and
 * the made-up samples (pi/fixtures/awws-sample.json and budget-sample.json).
 * Checks:
 *   every tile at 11 sizes in English and in Spanish: no console errors,
 *   never blank, nothing clipped, no type under 0.85rem on a tile or 1rem in
 *   a panel, line height 1.25 or more wherever text is cut;
 *   each panel and full screen, in both languages;
 *   the colors: a net that is down (coral) and up (green), room under the cap
 *   (amber), below zero (coral), a card day covered (green) and short by $120;
 *   the empty states: no snapshot ("Not synced yet", "Waiting for the budget
 *   app"), a snapshot without a money section ("No money data yet");
 *   data over 2 hours old: "as of" under the title, and the tile dims;
 *   showMoney false hides every money figure; budget.show false hides the
 *   budget tiles and the banner;
 *   the banner: "New charge: <label>" with no amount, OK dismisses it (no
 *   panel opens), it stays dismissed after a reload, a new charge shows again;
 *   the two layouts in the switcher ("AWWS money" and "Budget"), every pill
 *   whole, and each layout drawn with no gaps;
 *   app/ files touched here are plain ES5.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure. Nothing reaches the internet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const IDS = ['awws-money', 'budget-room', 'budget-card', 'budget-goals'];
const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 4], [6, 4], [9, 6]];
const SEL = '.cell[data-widget="awws-money"] .tile-body, .cell[data-widget^="budget"] .tile-body';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const FRESH = iso(H.MONDAY - 60000);
const OLD = iso(H.MONDAY - 3 * 3600000);

// HUB_CONFIG as config.js has it, for the layouts.
function hubConfig() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', ctx);
  return ctx.C;
}

// Runs before config.js: catches its HUB_CONFIG on the way in and changes it.
function configHook(body) {
  return new Function('let cfg; Object.defineProperty(window, "HUB_CONFIG", { configurable: true, get: () => cfg, set: (v) => {' +
    ' cfg = v; try { ' + body + ' } catch (e) {} } });');
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message : e));
  }
}

function assert(ok, text) { if (!ok) throw new Error(text); }

function noErrors(page, allowNetwork) {
  const errs = H.errorsOf(page, allowNetwork);
  assert(!errs.length, 'console: ' + errs.join(' | '));
}

function pages(ids, w, h) {
  const out = [];
  let list = [];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    if (x + w > 12) { x = 0; y += h; }
    if (y + h > 6) { out.push(list); list = []; x = 0; y = 0; }
    list.push({ widget: id, x: x, y: y, w: w, h: h });
    x += w;
  }
  if (list.length) out.push(list);
  return out;
}

/* The same page-side inspection as dev/awws-test.js: type size, line height,
   text cut without an ellipsis, and text pushed out of a box that hides it. */
function inspect(args) {
  const sel = args[0];
  const minRem = args[1];
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const out = [];
  const roots = document.querySelectorAll(sel);
  function cuts(cs) { return cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none'); }
  function hides(cs) { return cs.overflowX === 'hidden' || cs.overflowY === 'hidden'; }
  function scrolls(cs, el) { return /auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflowX) || el.classList.contains('panel-body'); }
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    for (const el of all) {
      let txt = '';
      for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent;
      txt = txt.trim();
      if (!txt) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const label = '"' + txt.slice(0, 28) + '"';
      const fs = parseFloat(cs.fontSize);
      if (fs < minRem * rem - 0.05) out.push((fs / rem).toFixed(2) + 'rem type: ' + label);
      if (hides(cs) || cuts(cs)) {
        const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / fs;
        if (lh < 1.245) out.push('line height ' + lh.toFixed(2) + ': ' + label);
        if (!cuts(cs) && cs.display !== 'inline' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
          out.push('cut without an ellipsis: ' + label);
        }
      }
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (scrolls(acs, a)) break;
        if (!hides(acs) || cuts(acs)) continue;
        const ar = a.getBoundingClientRect();
        if (r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1) {
          out.push('clipped by .' + String(a.className).split(' ').join('.') + ': ' + label);
          break;
        }
      }
    }
  }
  return out;
}

async function blankTiles(page) {
  return page.evaluate((sel) => {
    const out = [];
    document.querySelectorAll(sel).forEach((b) => { if (!b.textContent.trim() && !b.querySelector('svg')) out.push(b.parentNode.parentNode.getAttribute('data-widget')); });
    return out;
  }, SEL);
}

function text(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => n.textContent).join(' | '), sel);
}

function has(page, sel) { return page.evaluate((s) => !!document.querySelector(s), sel); }

function tileOf(id) { return '.cell[data-widget="' + id + '"] .tile-body'; }
function subOf(id) { return '.cell[data-widget="' + id + '"] .tile-sub'; }

const ROW = [
  { widget: 'awws-money', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-room', x: 3, y: 0, w: 3, h: 3 },
  { widget: 'budget-card', x: 6, y: 0, w: 3, h: 3 }, { widget: 'budget-goals', x: 9, y: 0, w: 3, h: 3 },
  { widget: 'awws', x: 0, y: 3, w: 6, h: 3 }, { widget: 'entertainment', x: 6, y: 3, w: 6, h: 3 }
];

async function main() {
  const C = hubConfig();
  let env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));

    /* ---------- every tile at every size ---------- */
    for (const es of [false, true]) {
      const lang = es ? 'Spanish' : 'English';
      for (const size of SIZES) {
        const sheets = pages(IDS, size[0], size[1]);
        await check(lang + ': every money tile at ' + size[0] + ' x ' + size[1], async () => {
          for (const sheet of sheets) {
            // Seen alerts keep the banner out of the way of the tiles.
            const page = await env.newPage({ layout: sheet, spanish: es, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
            try {
              const blank = await blankTiles(page);
              assert(!blank.length, 'blank: ' + blank.join(', '));
              const p = await page.evaluate(inspect, [SEL, 0.85]);
              assert(!p.length, p.slice(0, 6).join('; '));
              const all = await text(page, SEL);
              assert(!/Not synced|Waiting for|Sin sincronizar|Esperando/.test(all), 'a tile says it has no data: ' + all.slice(0, 160));
              noErrors(page);
            } finally { await page.ctx.close(); }
          }
        });
      }
    }

    /* ---------- the panels and full screen ---------- */
    for (const es of [false, true]) {
      const lang = es ? 'Spanish' : 'English';
      await check(lang + ': each panel and its full screen fit, nothing clipped', async () => {
        const page = await env.newPage({ layout: ROW, spanish: es, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
        try {
          for (const id of IDS) {
            await H.openPanel(page, id);
            let p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
            assert(!p.length, id + ' panel: ' + p.slice(0, 5).join('; '));
            assert((await text(page, '#panel .panel-body')).trim().length > 0, id + ': a blank panel');
            await H.fullScreen(page);
            p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
            assert(!p.length, id + ' full screen: ' + p.slice(0, 5).join('; '));
            await H.key(page, 'Escape');
            await H.idle(page);
            await H.key(page, 'Escape');
            await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, id + ' did not close');
            await H.idle(page);
          }
          const money = await page.evaluate(() => document.querySelectorAll('.cell[data-widget="awws-money"] .mo-bar').length);
          assert(money === 12, 'six months of bars, two each: ' + money);
          noErrors(page);
        } finally { await page.ctx.close(); }
      });
    }

    /* ---------- the figures and their colors ---------- */
    await check('the sample: net down in coral, room under the cap in amber, card covered in green, goals', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const m = await text(page, tileOf('awws-money'));
        assert(/−\$575/.test(m) && /\$1,265/.test(m) && /\$1,841/.test(m), 'money: ' + m);
        assert(await has(page, tileOf('awws-money') + ' .aw-hero-num.is-down'), 'the net is not coral');
        const r = await text(page, tileOf('budget-room'));
        assert(/\$42/.test(r) && /of \$60 a day/.test(r) && /9 days left/.test(r) && /about \$48/.test(r), 'room: ' + r);
        assert(await has(page, tileOf('budget-room') + ' .bu-hero-num.is-under'), 'room under the cap is not amber');
        const c = await text(page, tileOf('budget-card'));
        assert(/Covered/.test(c) && /in 3 days/.test(c) && /From checking/.test(c), 'card: ' + c);
        assert(await has(page, tileOf('budget-card') + ' .bu-hero-num.is-ok'), 'covered is not green');
        const g = await text(page, tileOf('budget-goals'));
        assert(/Coffee out/.test(g) && /\$62 over/.test(g), 'goals: ' + g);
        assert(await has(page, tileOf('budget-goals') + ' .bu-grow.is-g-over'), 'no goal marked over');
        assert(!(await text(page, subOf('budget-room'))), 'fresh data says "as of"');
        assert(!(await has(page, '.bu-tile.is-stale, .aw-tile.is-stale')), 'fresh data is dimmed');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('negative room in coral, a short card day, a net that is up in green', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, negative: true, short: true }));
      const snap = H.sample.snapshot();
      snap.money.earned = 2400;
      await env.setSnapshot(snap);
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        assert(/−\$14/.test(await text(page, tileOf('budget-room'))), 'room: ' + await text(page, tileOf('budget-room')));
        assert(await has(page, tileOf('budget-room') + ' .bu-hero-num.is-neg'), 'negative room is not coral');
        assert(/Short by \$120/.test(await text(page, tileOf('budget-card'))), 'card: ' + await text(page, tileOf('budget-card')));
        assert(await has(page, tileOf('budget-card') + ' .bu-hero-num.is-neg'), 'short is not coral');
        assert(/\+\$560/.test(await text(page, tileOf('awws-money'))), 'net: ' + await text(page, tileOf('awws-money')));
        assert(await has(page, tileOf('awws-money') + ' .aw-hero-num.is-up'), 'a net that is up is not green');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
        await env.setSnapshot(H.sample.snapshot());
      }
    });

    /* ---------- stale ---------- */
    await check('data over 2 hours old: "as of" under each title, and the tiles dim', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: OLD }));
      await env.setSnapshot(H.sample.snapshot({ sentAt: OLD }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        for (const id of IDS) {
          const s = await text(page, subOf(id));
          assert(/as of 7:40 AM/.test(s), id + ' sub: "' + s + '"');
          assert(await has(page, tileOf(id) + ' .is-stale'), id + ' is not dimmed');
        }
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
        await env.setSnapshot(H.sample.snapshot());
      }
    });

    /* ---------- switches ---------- */
    await check('showMoney false: Earned vs spent says it is hidden, no money figure anywhere', async () => {
      const page = await env.newPage({ layout: ROW, config: configHook('v.widgets.awws.showMoney = false;'), storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const m = await text(page, tileOf('awws-money'));
        assert(/Money is hidden/.test(m) && !/\$/.test(m), 'money tile: ' + m);
        await H.openPanel(page, 'awws-money');
        const p = await text(page, '#panel .panel-body');
        assert(/Money is hidden/.test(p) && !/\$/.test(p), 'money panel: ' + p);
        await H.key(page, 'Escape');
        await H.idle(page);
        assert(!/\$1,841/.test(await text(page, tileOf('awws'))), 'the Glance shows money');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('budget.show false: the budget tiles say so, and no banner', async () => {
      const page = await env.newPage({ layout: ROW, config: configHook('v.widgets.budget = { show: false };') });
      try {
        for (const id of ['budget-room', 'budget-card', 'budget-goals']) {
          const t = await text(page, tileOf(id));
          assert(/Budget is hidden/.test(t) && !/\$/.test(t), id + ': ' + t);
        }
        await H.sleep(500);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'the banner shows');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    /* ---------- the banner ---------- */
    for (const es of [false, true]) {
      await check((es ? 'Spanish' : 'English') + ': the banner names the charge, no amount; OK dismisses it and opens nothing; it stays dismissed', async () => {
        const page = await env.newPage({ layout: ROW, spanish: es });
        try {
          await H.until(() => page.evaluate(() => {
            const b = document.querySelector('.bu-alert.is-shown');
            return b && getComputedStyle(b).opacity === '1';
          }), 3000, 'no banner');
          const t = await text(page, '.bu-alert');
          assert((es ? /Cargo nuevo: Corner Bakery Stand/ : /New charge: Corner Bakery Stand/).test(t), 'banner: ' + t);
          assert(!/\$|\d+\.\d\d/.test(t), 'an amount in the banner: ' + t);
          const box = await page.evaluate(() => {
            const r = document.querySelector('.bu-alert').getBoundingClientRect();
            const x = document.querySelector('.bu-alert-text');
            return { l: r.left, r: r.right, w: window.innerWidth, cut: x.scrollWidth > x.clientWidth + 1 };
          });
          assert(box.l >= 0 && box.r <= box.w && !box.cut, 'the banner does not fit: ' + JSON.stringify(box));
          await H.key(page, 'Enter');
          await H.sleep(500);
          assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'OK did not dismiss it');
          assert(!(await page.evaluate(() => window.HUB_TEST.open())), 'OK opened a panel too');
          assert(!(await has(page, '.bu-alert.is-shown')), 'still on screen');
          await page.reload();
          await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
          await H.until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'live'), 10000, 'not live after the reload');
          await H.sleep(800);
          assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'back after a reload');
          // A second charge, then a third: one at a time, "+1 more".
          await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, alerts: [{ id: 'a-1042', label: 'Corner Bakery Stand' },
            { id: 'a-2001', label: 'Late Night Tacos' }, { id: 'a-2002', label: 'Game Store Online' }] }));
          await H.until(() => page.evaluate(() => window.HUB_ALERT.shown()), 5000, 'a new charge did not show');
          const t2 = await text(page, '.bu-alert');
          assert(/Late Night Tacos/.test(t2) && /\+1/.test(t2), 'banner: ' + t2);
          await H.key(page, 'Escape');
          await H.until(async () => /Game Store Online/.test(await text(page, '.bu-alert')), 3000, 'Back did not move to the next one');
          await H.key(page, 'Enter');
          await H.sleep(400);
          assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'the last one stayed');
          noErrors(page);
        } finally {
          await page.ctx.close();
          await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
        }
      });
    }

    /* ---------- the layouts ---------- */
    for (const id of ['awws-money', 'budget']) {
      const preset = C.layouts.find((l) => l.id === id);
      await check('layout "' + (preset && preset.name) + '": covers the grid, every tile draws, nothing clipped', async () => {
        assert(preset, 'no layout ' + id);
        const cells = {};
        for (const t of preset.layout) {
          for (let x = t.x; x < t.x + t.w; x++) for (let y = t.y; y < t.y + t.h; y++) {
            assert(!cells[x + ',' + y], 'overlap at ' + x + ',' + y);
            cells[x + ',' + y] = t.widget;
          }
        }
        assert(Object.keys(cells).length === 72, 'gaps: ' + Object.keys(cells).length + ' of 72 cells');
        assert(preset.layout.some((t) => t.widget === 'entertainment'), 'no Entertainment on it');
        for (const es of [false, true]) {
          const page = await env.newPage({ layout: preset.layout, spanish: es, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
          try {
            const shown = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cell'), (c) => c.getAttribute('data-widget')).sort().join());
            assert(shown === preset.layout.map((t) => t.widget).sort().join(), 'tiles: ' + shown);
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, p.slice(0, 5).join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
      });
    }

    await check('the switcher: seven pills, all whole; "Budget" switches and back', async () => {
      const page = await env.newPage({ storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.focusTile(page, await page.evaluate(() => {
          let best = null;
          document.querySelectorAll('#grid .cell').forEach((c) => {
            const r = c.getBoundingClientRect();
            if (!best || r.top < best.t - 2 || (Math.abs(r.top - best.t) <= 2 && r.left < best.l)) best = { t: r.top, l: r.left, id: c.getAttribute('data-widget') };
          });
          return best.id;
        }));
        await H.key(page, 'ArrowUp');
        await H.until(() => page.evaluate(() => document.querySelectorAll('.switcher-item').length > 0), 3000, 'the switcher did not open');
        await H.sleep(400);
        const bar = await page.evaluate(() => {
          const b = document.querySelector('.switcher-bar');
          return { over: b.scrollWidth > b.clientWidth + 1, w: window.innerWidth, items: Array.prototype.map.call(document.querySelectorAll('.switcher-item'), (n) => {
            const r = n.getBoundingClientRect();
            const name = n.querySelector('.switcher-name');
            return { name: n.textContent, l: r.left, r: r.right, cut: name.scrollWidth > name.clientWidth + 1 };
          }) };
        });
        const names = bar.items.map((i) => i.name);
        assert(names.length === 7 && names.indexOf('AWWS money') >= 0 && names.indexOf('Budget') >= 0, 'pills: ' + names.join(', '));
        assert(!bar.over, 'the bar overflows');
        for (const it of bar.items) assert(it.l >= 0 && it.r <= bar.w && !it.cut, 'pill cut: ' + it.name);
        for (let i = 0; i < 8; i++) {
          if ((await page.evaluate(() => (document.querySelector('.switcher-item.is-focused') || {}).textContent)) === 'Budget') break;
          await H.key(page, 'ArrowRight');
        }
        await H.key(page, 'Enter');
        await H.until(() => page.evaluate(() => !!document.querySelector('.cell[data-widget="budget-goals"]')), 15000, 'Budget did not open');
        await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
        await H.idle(page);
        assert(/Covered/.test(await text(page, tileOf('budget-card'))), 'the card tile on the Budget layout');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('the default layout and start tile are unchanged', async () => {
      assert(C.start === 'entertainment', 'start: ' + C.start);
      assert(C.layout.map((t) => t.widget).join() === 'today,calendar,awws,weather,todo,mirror,wotd,ambiance,nowplaying,entertainment', 'stock layout changed');
      assert(C.layouts[0].id === 'stock' && C.layouts[0].layout === null, 'Stock is not first');
      assert(C.widgets.budget && C.widgets.budget.show === true, 'budget.show is not true by default');
    });
  } finally {
    await env.stop();
  }

  /* ---------- empty: no snapshots at all ---------- */
  env = await H.start({ snapshot: false });
  try {
    await check('nothing sent yet: "Not synced yet" and "Waiting for the budget app", in every size', async () => {
      for (const size of [[1, 1], [3, 1], [3, 2], [6, 4]]) {
        for (const sheet of pages(IDS, size[0], size[1])) {
          const page = await env.newPage({ layout: sheet });
          try {
            assert(!(await blankTiles(page)).length, 'a blank tile at ' + size.join(' x '));
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, size.join(' x ') + ': ' + p.slice(0, 4).join('; '));
            if (size[0] > 1) {
              for (const t of sheet) {
                const words = await text(page, tileOf(t.widget));
                const want = t.widget === 'awws-money' ? /Not synced yet/ : /Waiting for the budget app/;
                assert(want.test(words), size.join(' x ') + ', ' + t.widget + ': ' + words);
              }
            }
            assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'a banner with no data');
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
      }
    });

    await check('a snapshot with no money section: "No money data yet"; a budget with only goals: the others wait', async () => {
      const snap = H.sample.snapshot();
      delete snap.money;
      await env.setSnapshot(snap);
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, only: ['goals'] }));
      const page = await env.newPage({ layout: ROW });
      try {
        assert(/No money data yet/.test(await text(page, tileOf('awws-money'))), 'money: ' + await text(page, tileOf('awws-money')));
        assert(/Waiting for the budget app/.test(await text(page, tileOf('budget-room'))), 'room');
        assert(/Waiting for the budget app/.test(await text(page, tileOf('budget-card'))), 'card');
        assert(/Coffee out/.test(await text(page, tileOf('budget-goals'))), 'goals');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('the Pi away: the TV keeps its last budget copy (homeHub.budget.v1)', async () => {
      const cached = JSON.stringify({ v: 1, at: H.MONDAY, data: Object.assign(H.budgetSample.snapshot({ sentAt: FRESH }), { receivedAt: FRESH }) });
      const page = await env.newPage({ layout: ROW, live: 'off', storage: { 'homeHub.budget.v1': cached, 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        assert(/Covered/.test(await text(page, tileOf('budget-card'))), 'card: ' + await text(page, tileOf('budget-card')));
        noErrors(page, true);
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }

  await check('the files touched here are plain ES5', () => {
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    const bad = [];
    for (const f of ['app/widgets/budget.js', 'app/widgets/awws.js', 'app/hub.js', 'app/config.js', 'app/icons.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (acorn) {
        try { acorn.parse(src, { ecmaVersion: 5 }); } catch (e) { bad.push(f + ': ' + e.message); }
      } else if (/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
        bad.push(f + ': ES2015 syntax');
      }
    }
    assert(!bad.length, bad.join(' | '));
  });
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
