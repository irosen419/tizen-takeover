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
 *   budget data over 2 hours old (AWWS over 31 hours): "as of" under the title, and the tile dims;
 *   showMoney false hides every money figure; budget.show false hides the
 *   budget tiles and the banner;
 *   Guest mode (app/guest.js; turned on and off through the PIN pop-up,
 *   app/pin.js, against the real Pi server): every money tile, its panel and the banner
 *   keep their words with each dollar amount blurred (and only those), the
 *   blur really draws, nothing is dropped; the Clock page's Off / On turns
 *   it on and off live and is remembered, Off leaves the text as it was; the
 *   layouts stay as they are;
 *   the banner: "New charge: <label>" with no amount, OK dismisses it (no
 *   panel opens), it stays dismissed after a reload, a new charge shows again;
 *   the two layouts in the switcher ("AWWS money" and "Budget"), every pill
 *   whole, and each layout drawn with no gaps;
 *   Budget lab (budget-lab): the streak, yesterday and the suggested move on
 *   the tile, the card day outcome on a tall one; the panel's cap slider
 *   (a press changes text and the fill's one transform, never the panel),
 *   the mode pills, Save this cap and Back to calculated; a saved cap
 *   survives a reload and is dropped at a new card day; holding Right for
 *   3 s with the key repeat below lands on the value the math module's
 *   holdStep gives; the merchants' cut rows at panel and full screen (label
 *   above the track, a press changes text and one transform per changed bar,
 *   a cut stops at its p_i and the five together at combined, locked at a
 *   $0 cap); Put it somewhere filling card day first, then savings, AWWS and
 *   buffer (example B); Guest mode blurs the amounts and keeps the session
 *   and its cuts; the runway chart at full screen only (none at panel size): the
 *   owed line ends at P and moves with the cap and with a cut, no figure in
 *   it but the gap label ("Covered, $15 spare", "Short by $13"), and during
 *   a held key the owed line's points are written at most every 120 ms (one
 *   write a press at most, a trailing write after the last), nothing else in
 *   the chart changes and the scale stays; no runway sent says "Waiting for
 *   the budget app"; app/ files touched here are plain ES5.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure. Nothing reaches the internet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const IDS = ['awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab'];
const LABM = require(path.join(ROOT, 'app', 'budget-lab-math.js'));
// The test's key repeat for a held Right: one press, then the repeat after
// 500 ms, every 50 ms, until 3 s. Presses closer than 250 ms are one hold.
const REPEAT = [0];
for (let t = 500; t <= 3000; t += 50) REPEAT.push(t);
function holdOnPaper(from, capMax) {
  let v = from;
  let start = 0;
  let last = -Infinity;
  for (const t of REPEAT) {
    if (t - last >= 250) start = t;
    last = t;
    v = LABM.step(v, 1, LABM.holdStep(t - start, 'cap'), 0, capMax);
  }
  return v;
}
const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 4], [6, 4], [9, 6]];
const SEL = '.cell[data-widget="awws-money"] .tile-body, .cell[data-widget^="budget"] .tile-body';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const FRESH = iso(H.MONDAY - 60000);
const OLD = iso(H.MONDAY - 3 * 3600000);
// The AWWS snapshot dims only after 31 hours (it syncs once a day).
const SNAP_OLD = iso(H.MONDAY - 33 * 3600000);

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
  // A cut that is shown: "...", a line clamp, or (the redesign, app/theme.css) an edge that fades out under a mask.
  function cuts(cs) { return cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none'); }
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

// The text a guest can read: textContent without the Guest mode blur spans.
function seen(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => {
    const c = n.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.guest-blur'), (b) => b.parentNode.removeChild(b));
    return c.textContent;
  }).join(' | '), sel);
}

// The blurred amounts under sel, and whether each one really draws blurred.
function blurs(page, sel) {
  return page.evaluate((s) => {
    const out = [];
    document.querySelectorAll(s).forEach((n) => n.querySelectorAll('.guest-blur').forEach((b) => {
      const cs = getComputedStyle(b);
      out.push({ t: b.textContent, ok: cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' && cs.textShadow !== 'none' });
    }));
    return out;
  }, sel);
}

// Guest mode: every amount is blurred, each blur is an amount, and the blur draws.
const AMOUNT = /^[+\-\u2212]?\$\d[\d,]*(\.\d+)?$/;
async function allBlurred(page, sel, label) {
  const left = await seen(page, sel);
  assert(!/\$\s?\d/.test(left), label + ' shows a dollar amount: ' + left);
  const b = await blurs(page, sel);
  assert(b.length > 0, label + ': nothing blurred');
  const bad = b.filter((x) => !AMOUNT.test(x.t) || !x.ok);
  assert(!bad.length, label + ': ' + JSON.stringify(bad));
  return left;
}

function tileOf(id) { return '.cell[data-widget="' + id + '"] .tile-body'; }
function subOf(id) { return '.cell[data-widget="' + id + '"] .tile-sub'; }

const ROW = [
  { widget: 'awws-money', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-room', x: 3, y: 0, w: 3, h: 3 },
  { widget: 'budget-card', x: 6, y: 0, w: 3, h: 3 }, { widget: 'budget-goals', x: 9, y: 0, w: 3, h: 3 },
  { widget: 'awws', x: 0, y: 3, w: 6, h: 3 }, { widget: 'budget-lab', x: 6, y: 3, w: 3, h: 3 },
  { widget: 'entertainment', x: 9, y: 3, w: 3, h: 3 }
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
            // Budget lab opens straight at full screen and is read from the couch: 1.5rem at the least.
            const direct = id === 'budget-lab';
            let p = await page.evaluate(inspect, ['#panel .panel-body', direct ? 1.5 : 1]);
            assert(!p.length, id + ' panel: ' + p.slice(0, 5).join('; '));
            assert((await text(page, '#panel .panel-body')).trim().length > 0, id + ': a blank panel');
            if (!direct) await H.fullScreen(page);
            p = await page.evaluate(inspect, ['#panel .panel-body', direct ? 1.5 : 1]);
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

    await check('autopay days: short on the 1st but covered by autopay is amber with its plan rows; the room says so; still short with autopay stays coral', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true, autopay: true }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const card = await text(page, tileOf('budget-card'));
        assert(/Short \$955/.test(card) && /covered by autopay/.test(card), 'card: ' + card);
        assert(!/Short by/.test(card), 'a coral "Short by": ' + card);
        assert(/Nov 30\s*Sapphire Reserve\s*\$1,200/.test(card) && /Dec 7\s*Sapphire Reserve\s*\$400\s*autopay/.test(card), 'plan rows: ' + card);
        assert(await has(page, tileOf('budget-card') + ' .bu-hero-num.is-under') && !(await has(page, tileOf('budget-card') + ' .is-neg')), 'short by autopay is not amber');
        assert(/using autopay days/.test(await text(page, tileOf('budget-room'))), 'room: ' + await text(page, tileOf('budget-room')));
        const lab = await text(page, tileOf('budget-lab'));
        assert(!/short even at \$0/.test(lab), 'the lab tile says short even at $0: ' + lab);
        noErrors(page);
        await H.openPanel(page, 'budget-lab');
        const p = await text(page, '#panel .panel-body');
        assert(/Nov 30 is \$955 short, so this plan relies on autopay days through Dec 7/.test(p), 'lab header: ' + p);
        assert(!/even at \$0 a day/.test(p) && await has(page, '#panel .bl-big'), 'lab panel: ' + p);
        noErrors(page);
      } finally { await page.ctx.close(); }
      // Short with autopay too (no byAutopay): coral as before, with how short.
      const bad = H.budgetSample.snapshot({ sentAt: FRESH, payday: true, autopay: true });
      bad.cardDay.byAutopay = false;
      delete bad.cardDay.plan;
      bad.cardDay.autopayShortBy = 80;
      bad.room.basis = 'first';
      bad.lab.autopayRoom = -80;
      await env.setBudget(bad);
      const page2 = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const card = await text(page2, tileOf('budget-card'));
        assert(/Short by \$955/.test(card) && /\$80 short even with autopay/.test(card), 'card: ' + card);
        assert(await has(page2, tileOf('budget-card') + ' .bu-hero-num.is-neg'), 'not coral');
        await H.openPanel(page2, 'budget-lab');
        const p = await text(page2, '#panel .panel-body');
        assert(/short for Dec 7 even at \$0 a day/.test(p) && /Move \$80 into checking before Dec 7/.test(p), 'lab: ' + p);
        noErrors(page2);
      } finally {
        await page2.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    /* ---------- stale ---------- */
    await check('budget data over 2 hours old and AWWS over 31 hours: "as of" under each title, and the tiles dim', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: OLD }));
      await env.setSnapshot(H.sample.snapshot({ sentAt: SNAP_OLD }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        for (const id of IDS) {
          const s = await text(page, subOf(id));
          assert((id === 'awws-money' ? /as of Nov 15/ : /as of 7:40 AM/).test(s), id + ' sub: "' + s + '"');
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

    /* ---------- Guest mode ---------- */
    const GUEST_ROW = ROW.slice(0, 6).concat([{ widget: 'today', x: 9, y: 3, w: 3, h: 3 }]);
    const GUEST_CACHE = JSON.stringify({ v: 1, at: H.MONDAY, data: Object.assign(H.budgetSample.snapshot({ sentAt: FRESH }), { receivedAt: FRESH }) });

    await check('Guest mode on: every money tile keeps its figures with each dollar amount blurred (only those); no banner; the budget is kept', async () => {
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.guest.v1': 'on', 'homeHub.budget.v1': GUEST_CACHE } });
      try {
        for (const id of IDS) {
          const left = await allBlurred(page, tileOf(id), id);
          assert(!/Hidden for guests/.test(left), id + ': ' + left);
        }
        assert(/Covered/.test(await seen(page, tileOf('budget-card'))) && /days left/.test(await seen(page, tileOf('budget-room'))), 'words went with the amounts');
        assert(!/\$\s?\d/.test(await seen(page, tileOf('awws'))), 'the Glance shows an amount');
        await H.idle(page);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'the banner shows in Guest mode');
        const kept = await page.evaluate(() => ({ store: !!window.HUB_BUDGET_TEST.store.data, cache: !!localStorage.getItem('homeHub.budget.v1') }));
        assert(kept.store && kept.cache, 'budget dropped: ' + JSON.stringify(kept));
        await H.openPanel(page, 'budget-card');
        await allBlurred(page, '#panel', 'card panel');
        await H.key(page, 'Escape');
        await H.idle(page);
        await H.openPanel(page, 'awws-money');
        await allBlurred(page, '#panel', 'money panel');
        await H.key(page, 'Escape');
        await H.idle(page);
        // The Glance keeps its money line, blurred.
        await H.openPanel(page, 'awws');
        assert(/Spent \$1,841/.test(await text(page, '#panel')), 'the Glance dropped its money line: ' + await text(page, '#panel'));
        await allBlurred(page, '#panel', 'Glance panel');
        await H.key(page, 'Escape');
        await H.idle(page);
        // A tile that is not about money keeps its text as it is.
        assert(!(await has(page, '.cell[data-widget="today"] .guest-blur')), 'the clock has a blur');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode on: the New charge banner stays away (it names a merchant)', async () => {
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.guest.v1': 'on' } });
      try {
        await H.idle(page);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'the banner shows in Guest mode');
        noErrors(page);
      } finally {
        await page.ctx.close();
      }
    });

    await check('Guest mode on: Investments blurs every dollar; percentages, names and the trend stay; its copy is kept', async () => {
      const inv = JSON.stringify({ v: 1, at: H.MONDAY, sentAt: FRESH, section: H.budgetSample.snapshot({ sentAt: FRESH }).investments });
      const page = await env.newPage({ layout: [{ widget: 'investments', x: 0, y: 0, w: 6, h: 4 }, { widget: 'budget-room', x: 6, y: 0, w: 3, h: 2 }],
        storage: { 'homeHub.guest.v1': 'on', 'homeHub.investments.v1': inv, 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const t = await allBlurred(page, tileOf('investments'), 'investments');
        assert(/\+20\.2%/.test(t) && /62%/.test(t) && /VTI/.test(t) && !/48,2|30,1|21,0|8,1/.test(t), 'investments: ' + t);
        assert(/\$48,211/.test(await text(page, tileOf('investments'))), 'the total is gone');
        assert(await has(page, tileOf('investments') + ' svg polyline'), 'no trend');
        await allBlurred(page, tileOf('budget-room'), 'room');
        assert(await page.evaluate(() => !!localStorage.getItem('homeHub.investments.v1') && !!window.HUB_INVESTMENTS_TEST.state().m), 'dollars dropped');
        await H.openPanel(page, 'investments');
        const p = await allBlurred(page, '#panel', 'panel');
        assert(/62%/.test(p) && /Roth Contributory IRA/.test(p) && !/48,2|30,1|21,0|8,1/.test(p), 'panel: ' + p);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode from the Clock page: On (after creating the PIN) blurs the amounts at once, Off (after the PIN) takes the blur off, and it is remembered', async () => {
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const before = {};
        for (const id of IDS) before[id] = await text(page, tileOf(id));
        assert(/Covered/.test(before['budget-card']) && !(await has(page, '.guest-blur')), 'no budget to start with, or a blur');
        await H.openPanel(page, 'today');
        const labels = await text(page, '#panel .clock-group-label');
        assert(/Guest mode/.test(labels), 'no Guest mode row: ' + labels);
        assert(await has(page, '#panel [data-key="guest-off"].is-selected'), 'Off is not selected at first');
        const inside = await page.evaluate(() => {
          const groups = document.querySelectorAll('#panel .clock-group');
          const last = groups[groups.length - 1].getBoundingClientRect();
          const box = document.querySelector('#panel .panel-body').getBoundingClientRect();
          return last.bottom <= box.bottom + 1 && last.top >= box.top - 1;
        });
        assert(inside, 'the Guest mode row runs out of the panel');
        await page.click('#panel [data-key="guest-on"]');
        // The PIN pop-up (app/pin.js) against the real Pi server: no PIN yet,
        // so it asks to create one, then to enter it again.
        await H.until(() => page.evaluate(() => !!window.HUB_PIN.state() && window.HUB_PIN.state().stage === 'create' && !window.HUB_PIN.state().busy), 4000, 'no PIN pop-up asking to create a PIN');
        assert(!(await has(page, '#panel [data-key="guest-on"].is-selected')), 'On before the PIN');
        await page.keyboard.type('2468');
        await H.until(() => page.evaluate(() => window.HUB_PIN.state() && window.HUB_PIN.state().stage === 'confirm'), 3000, 'no confirm step');
        await page.keyboard.type('2468');
        await H.until(() => page.evaluate(() => !window.HUB_PIN.isOpen()), 4000, 'the PIN pop-up stayed open');
        await H.sleep(300);
        assert(await has(page, '#panel [data-key="guest-on"].is-selected'), 'On is not selected after the PIN');
        assert((await page.evaluate(() => localStorage.getItem('homeHub.guest.v1'))) === 'on', 'not remembered');
        assert(!(await has(page, '#panel .guest-blur')), 'the Clock page has a blur');
        for (const id of IDS) {
          await allBlurred(page, tileOf(id), 'after On, ' + id);
          assert(await text(page, tileOf(id)) === before[id], 'after On, ' + id + ' changed its text');
        }
        await page.click('#panel [data-key="guest-off"]');
        await H.until(() => page.evaluate(() => !!window.HUB_PIN.state() && window.HUB_PIN.state().stage === 'enter' && !window.HUB_PIN.state().busy), 4000, 'no PIN pop-up for Off');
        await page.keyboard.type('2468');
        await H.until(() => page.evaluate(() => !window.HUB_PIN.isOpen()), 4000, 'the PIN pop-up stayed open after Off');
        await H.sleep(300);
        assert((await page.evaluate(() => localStorage.getItem('homeHub.guest.v1'))) === null, 'Off not remembered');
        assert(!(await has(page, '.guest-blur')), 'a blur stayed after Off');
        for (const id of IDS) assert(await text(page, tileOf(id)) === before[id], 'after Off, ' + id + ' changed its text');
        await H.key(page, 'Escape');
        await H.idle(page);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode: the money layouts stay in the switcher', async () => {
      const page = await env.newPage({ storage: { 'homeHub.guest.v1': 'on' } });
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
        const names = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.switcher-item'), (n) => n.textContent));
        assert(names.indexOf('Main') >= 0 && names.indexOf('AWWS money') >= 0 && names.indexOf('Budget') >= 0, 'pills: ' + names.join(', '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode turned on while the Budget layout shows: the layout stays, its amounts blur', async () => {
      const budget = C.layouts.filter((l) => l.id === 'budget')[0].layout;
      const page = await env.newPage({ layout: budget, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        assert(await has(page, '.cell[data-widget="budget-goals"]'), 'not on Budget');
        const ids = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#grid .cell'), (c) => c.getAttribute('data-widget')).join(','));
        const first = await ids();
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(1500);
        assert(await ids() === first, 'the layout changed: ' + await ids());
        await allBlurred(page, tileOf('budget-goals'), 'goals');
        await page.evaluate(() => window.HUB_GUEST.set(false));
        await H.sleep(500);
        assert(await ids() === first && !(await has(page, '.guest-blur')), 'after Off: ' + await ids());
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

    await check('banner: OK dismisses it from inside a panel; an undismissed one clears itself', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-goals');
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, alerts: [{ id: 'a-2999', label: 'Corner Bakery Stand' }] }));
        await H.until(() => page.evaluate(() => window.HUB_ALERT.shown()), 5000, 'no banner over the panel');
        await H.key(page, 'Escape');
        await H.sleep(400);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'Back in a panel did not dismiss it');
        assert(await page.evaluate(() => !!window.HUB_TEST.open()), 'Back closed the panel too');
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, alerts: [{ id: 'a-3001', label: 'Late Night Tacos' }] }));
        await H.until(() => page.evaluate(() => window.HUB_ALERT.shown()), 5000, 'a new charge did not show');
        await H.key(page, 'Enter');
        await H.sleep(400);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'OK in a panel did not dismiss it');
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, alerts: [{ id: 'a-3002', label: 'Game Store Online' }] }));
        await H.until(() => page.evaluate(() => window.HUB_ALERT.shown()), 5000, 'the next charge did not show');
        await page.evaluate(() => window.HUB_ALERT.setExpiry(600));
        await H.until(() => page.evaluate(() => !window.HUB_ALERT.shown()), 3000, 'the banner did not expire');
        await H.sleep(500);
        assert(!(await page.evaluate(() => window.HUB_ALERT.shown())), 'an expired banner came back');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    /* ---------- Budget lab ---------- */
    const LAB_TILE = tileOf('budget-lab');
    const PREF = 'homeHub.budget.capPref.v1';   // the old per-screen key: app/prefs.js moves it to the shared 'budget.capPref'
    const labPanel = (page) => text(page, '#panel .panel-body');
    const focusedKey = (page) => page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') : null; });
    const session = (page) => page.evaluate(() => window.HUB_BUDGET_LAB_TEST.session());

    await check('Budget lab tile: today\'s cap big, the card day outcome, and the streak in a small box at the bottom', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const t = await text(page, LAB_TILE);
        assert(/^\$62\s*safe today/.test(t.trim()) && /Keeps Nov 19 covered/.test(t) && !/New streak|nothing to spare/.test(t), 'tile: ' + t);
        assert(/1 day under/.test(t) && /Stay under \$62 today/.test(t), 'tile: ' + t);
        assert(await has(page, LAB_TILE + ' .bl-oline.is-even'), 'the on track line is not amber');
        assert(await has(page, LAB_TILE + ' .bl-sbox.is-on .bl-scount') && await has(page, LAB_TILE + ' .bl-pip.is-lit'), 'no streak box with its count');
        noErrors(page);
      } finally { await page.ctx.close(); }
      const strip = await env.newPage({ layout: [{ widget: 'budget-lab', x: 0, y: 0, w: 6, h: 1 }, { widget: 'today', x: 6, y: 0, w: 6, h: 1 }],
        storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        const t = await text(strip, LAB_TILE);
        assert(/\$62 safe today · 1 day under/.test(t), 'strip: ' + t);
        noErrors(strip);
      } finally { await strip.ctx.close(); }
    });

    await check('Budget lab: OK on the tile opens full screen at once; Back closes it in one press', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        assert((await page.evaluate(() => window.HUB_TEST.mode())) === 'full', 'the lab did not open full screen');
        const box = await page.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect(); return [r.width, r.height, window.innerWidth, window.innerHeight, document.getElementById('panel').className]; });
        assert(box[0] === box[2] && box[1] === box[3] && /is-direct/.test(box[4]), 'panel box: ' + box.join());
        assert((await page.evaluate(() => getComputedStyle(document.querySelector('#panel .panel-btn')).display)) === 'none', 'a Full screen button on a panel that is already full');
        assert(/Back to close/.test(await text(page, '#panel .panel-hint')), 'hint: ' + await text(page, '#panel .panel-hint'));
        await H.key(page, 'Escape');
        await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'one Back did not close it');
        await H.idle(page);
        // Another widget still opens as a panel.
        await H.openPanel(page, 'budget-card');
        assert((await page.evaluate(() => window.HUB_TEST.mode())) === 'panel', 'another tile opens full screen');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Budget lab panel: the cap is huge and lit; a key press changes text and the fill only; Save with OK and Back to calculated', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        assert((await focusedKey(page)) === 'cap', 'the cap slider does not have focus: ' + await focusedKey(page));
        let p = await labPanel(page);
        assert(/\$62\s*a day/.test(p) && /Hold ◀ ▶ to change your daily cap/.test(p) && /Nov 19: on track at \$62 a day/.test(p) && !/covered, \$0 spare/i.test(p), 'panel: ' + p);
        assert(await has(page, '#panel .bl-result.is-even') && !(await has(page, '#panel .bl-result.is-ok')), 'the on track result is not amber');
        assert(/Safe today \$62/.test(p) && /No saved cap yet/.test(p) && /Down for your daily goal/.test(p), 'panel: ' + p);
        assert(/The Daily room tile uses \$60 a day/.test(p), 'panel: ' + p);
        assert(/Stay under \$62 today for 2 days in a row/.test(p), 'pace: ' + p);
        const look = await page.evaluate(() => {
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
          const big = getComputedStyle(document.querySelector('#panel .bl-big'));
          const f = document.querySelector('#panel .bl-hero');
          const fs = getComputedStyle(f);
          const res = document.querySelector('#panel .bl-result');
          const rs = res.getBoundingClientRect();
          const arrows = document.querySelectorAll('#panel .bl-hero .bl-arrow').length;
          return { big: parseFloat(big.fontSize) / rem, edge: parseFloat(fs.borderTopWidth) / rem, color: fs.borderTopColor, bg: fs.backgroundColor,
            res: parseFloat(getComputedStyle(res).fontSize) / rem, resColor: getComputedStyle(res).color, underBig: rs.top >= document.querySelector('#panel .bl-big').getBoundingClientRect().bottom - 2,
            keys: document.querySelectorAll('#panel .bl-hero .bl-keyhint').length, arrows: arrows };
        });
        assert(look.big >= 7, 'the cap is ' + look.big + 'rem');
        assert(look.edge >= 0.25 && /255, 255, 255/.test(look.color) && !/rgba\(0, 0, 0, 0\)|transparent/.test(look.bg), 'focus look: ' + JSON.stringify(look));
        assert(look.res >= 2.2 && look.underBig && look.arrows === 2 && look.keys === 1, 'result / arrows: ' + JSON.stringify(look));
        const before = await page.evaluate(() => {
          window.__labRoot = document.querySelector('#panel .bl-panel');
          window.__labBig = document.querySelector('#panel .bl-big').firstChild;
          return document.querySelector('#panel .bl-fill').style.transform;
        });
        await H.key(page, 'ArrowRight');
        const after = await page.evaluate(() => ({
          same: window.__labRoot === document.querySelector('#panel .bl-panel') && window.__labBig === document.querySelector('#panel .bl-big').firstChild,
          fill: document.querySelector('#panel .bl-fill').style.transform,
          big: document.querySelector('#panel .bl-big').textContent,
          trans: getComputedStyle(document.querySelector('#panel .bl-fill')).transitionDuration
        }));
        assert(after.same, 'the panel was drawn again for a key press');
        assert(after.big === '$63' && after.fill !== before && /^scaleX\(/.test(after.fill), 'after Right: ' + JSON.stringify(after) + ' from ' + before);
        assert(/^0s(, 0s)*$/.test(after.trans), 'the fill has a transition: ' + after.trans);
        assert((await session(page)).cap === 63, 'session: ' + JSON.stringify(await session(page)));
        p = await labPanel(page);
        assert(/Nov 19: short by \$3/.test(p) && /Back to calculated cap/.test(p), 'at $63: ' + p);
        assert(await has(page, '#panel .bl-result.is-neg'), 'short is not coral');
        await H.key(page, 'ArrowLeft', 2);
        assert((await session(page)).cap === 61, 'after Left twice: ' + JSON.stringify(await session(page)));
        assert((await focusedKey(page)) === 'cap', 'Left moved focus away');
        assert(await has(page, '#panel .bl-result.is-ok'), 'covered is not green');
        // OK on the cap saves it: stored as a keep amount for this card day, and a toast.
        await H.key(page, 'Enter');
        await H.sleep(150);
        const toast = await text(page, '#toast');
        assert(/Cap saved: \$61 a day \(re-averaged each morning\)/.test(toast), 'toast: ' + toast);
        const pref = await page.evaluate(() => window.HUB_PREFS.get('budget.capPref'));
        assert(pref.v === 1 && pref.cardDate === '2026-11-19' && Math.abs(pref.keep - 3.4) < 0.001 && typeof pref.at === 'string', 'stored: ' + JSON.stringify(pref));
        p = await labPanel(page);
        assert(/Saved \$61 a day/.test(p) && /Nov 19: covered, \$3 spare/.test(p) && await has(page, '#panel .bl-result.is-ok'), 'after Save: ' + p);
        assert(await page.evaluate(() => getComputedStyle(document.querySelector('#panel .bl-tick.is-saved')).display !== 'none'), 'no saved mark on the track');
        // Down from the cap is Back to calculated (lit now); Left and Right do nothing there.
        await H.key(page, 'ArrowDown');
        assert((await focusedKey(page)) === 'reset', 'Down from the cap: ' + await focusedKey(page));
        await H.key(page, 'ArrowRight');
        assert((await focusedKey(page)) === 'reset', 'Right left the row: ' + await focusedKey(page));
        await H.key(page, 'Enter');
        const s = await session(page);
        assert(s.cap === null && s.keep === null, 'after reset: ' + JSON.stringify(s));
        assert((await focusedKey(page)) === 'cap', 'focus did not go back to the cap: ' + await focusedKey(page));
        assert(!(await has(page, '#panel .bl-reset.f')), 'Back to calculated still takes focus with nothing to reset');
        p = await labPanel(page);
        assert(/\$62\s*a day/.test(p) && /Saved \$61 a day/.test(p) && /Using the calculated cap/.test(p), 'after reset: ' + p);
        assert(await page.evaluate(() => !!window.HUB_PREFS.get('budget.capPref')), 'reset dropped the saved cap');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Budget lab: short even at $0 a day says so plainly, gives the one action, and has no dead slider', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true, shortZero: true }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        const p = await labPanel(page);
        assert(/You’re \$138 short for Nov 30 even at \$0 a day/.test(p), 'message: ' + p);
        assert(/Move \$138 into checking before Nov 30/.test(p), 'action: ' + p);
        assert(/Cuts open up once you are back above \$0 a day/.test(p) && /no cap to set|nothing to set yet/i.test(p), 'explanation: ' + p);
        assert(await has(page, '#panel .bl-short-head.is-neg') && await has(page, '#panel .bl-action'), 'no message or action block');
        assert(!(await has(page, '#panel .bl-hero, #panel .bl-big, #panel .bl-arrow, #panel .bl-cut, #panel .bl-dest')), 'a slider or a cut row in the short case');
        assert(!(await has(page, '#panel .panel-body .f')), 'a focusable row with nothing to change');
        const rows = await text(page, '#panel .bl-mline');
        assert(/Hilltop Grocer · \$\d+ so far/.test(rows) && !/cut \$/.test(rows), 'merchants: ' + rows);
        assert(await has(page, '#panel .bl-chart'), 'no runway chart');
        const head = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#panel .bl-short-head')).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize));
        assert(head >= 3, 'the message is ' + head + 'rem');
        const sm = await page.evaluate(inspect, ['#panel .panel-body', 1.5]);
        assert(!sm.length, 'short case: ' + sm.slice(0, 5).join('; '));
        const fit = await page.evaluate(() => { const b = document.querySelector('#panel .panel-body'); return b.scrollHeight <= b.clientHeight + 1; });
        assert(fit, 'the short case does not fit one screen');
        await H.key(page, 'Escape');
        await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'Back did not close it');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Budget lab: a saved cap survives a reload; a new card day drops it', async () => {
      const pref = JSON.stringify({ v: 1, cardDate: '2026-11-19', keep: 3.4, at: FRESH });
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]', [PREF]: pref } });
      try {
        await page.reload();
        await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
        await H.until(() => page.evaluate(() => window.HUB_LIVE.status().state === 'live'), 10000, 'not live after the reload');
        await H.idle(page);
        await H.openPanel(page, 'budget-lab');
        let p = await labPanel(page);
        assert(/Saved \$61 a day/.test(p) && /\$62\s*a day/.test(p), 'after the reload: ' + p);
        const next = H.budgetSample.snapshot({ sentAt: FRESH });
        next.lab.cardDate = '2026-11-20';
        next.lab.daysLeft = 4;
        await env.setBudget(next);
        await H.until(async () => /No saved cap yet/.test(await labPanel(page)), 5000, 'the old cycle\'s cap stayed: ' + await labPanel(page));
        assert(await page.evaluate(() => window.HUB_PREFS.get('budget.capPref') === null), 'the old cycle\'s cap is still stored');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Budget lab: holding Right for 3 s (repeat after 500 ms, every 50 ms) lands where holdStep says', async () => {
      const big = H.budgetSample.snapshot({ sentAt: FRESH });
      big.lab.room = 7000;      // $500 a day for 14 days: room to run without reaching the top
      big.lab.daysLeft = 14;
      big.lab.cardDate = '2026-11-30';
      await env.setBudget(big);
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        assert(/\$500\s*a day/.test(await labPanel(page)), 'start: ' + await labPanel(page));
        const capMax = await page.evaluate(() => window.HUB_BUDGET_LAB_TEST.result().capMax);
        const want = holdOnPaper(500, capMax);
        assert(want === 900 && capMax === 1000, 'on paper: ' + want + ' of ' + capMax);
        for (const t of REPEAT) {
          await page.clock.setFixedTime(new Date(H.MONDAY + t));
          await page.keyboard.press('ArrowRight');
        }
        const s = await session(page);
        assert(s.cap === want, 'held 3 s: ' + JSON.stringify(s) + ', want ' + want);
        assert((await text(page, '#panel .bl-big')) === '$900', 'shown: ' + await text(page, '#panel .bl-big'));
        // A gap of 250 ms or more starts again at $1.
        await page.clock.setFixedTime(new Date(H.MONDAY + 3400));
        await page.keyboard.press('ArrowRight');
        assert((await session(page)).cap === 901, 'after a pause: ' + JSON.stringify(await session(page)));
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Guest mode: Budget lab keeps the session and the saved cap; its amounts blur on the tile and the panel, and come back sharp', async () => {
      const pref = JSON.stringify({ v: 1, cardDate: '2026-11-19', keep: 3.4, at: FRESH });
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]', [PREF]: pref } });
      try {
        await H.openPanel(page, 'budget-lab');
        await H.key(page, 'ArrowRight', 4);
        assert((await session(page)).cap === 66, 'session: ' + JSON.stringify(await session(page)));
        await H.key(page, 'Escape');
        await H.idle(page);
        const sharp = await text(page, LAB_TILE);
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(300);
        await allBlurred(page, LAB_TILE, 'tile');
        assert(await text(page, LAB_TILE) === sharp, 'the tile changed: ' + await text(page, LAB_TILE));
        assert((await session(page)).cap === 66, 'session dropped: ' + JSON.stringify(await session(page)));
        assert(await page.evaluate(() => !!window.HUB_PREFS.get('budget.capPref')), 'Guest mode deleted the saved cap');
        await H.openPanel(page, 'budget-lab');
        await allBlurred(page, '#panel', 'panel');
        // A press still works and its new amount is blurred too.
        await H.key(page, 'ArrowRight');
        assert((await session(page)).cap === 67, 'press: ' + JSON.stringify(await session(page)));
        await allBlurred(page, '#panel', 'panel after a press');
        await H.key(page, 'Escape');
        await H.idle(page);
        await page.evaluate(() => window.HUB_GUEST.set(false));
        await H.sleep(300);
        assert(!(await has(page, '.guest-blur')), 'a blur stayed');
        assert(/\$67/.test(await text(page, LAB_TILE)) || /Short by|Skip/.test(await text(page, LAB_TILE)), 'after Guest mode: ' + await text(page, LAB_TILE));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    /* ---------- Budget lab: merchants (row 6) and Put it somewhere (row 7) ---------- */
    // Presses with no pause: the page clock stands still, so each is $1 (one hold, held 0 ms).
    const press = async (page, k, n) => { for (let i = 0; i < (n || 1); i++) await page.keyboard.press(k); };
    // Moves focus with Up or Down until the row with that data-key has it.
    const goTo = async (page, want, dir) => {
      for (let i = 0; i < 16 && (await focusedKey(page)) !== want; i++) await press(page, dir || 'ArrowDown');
      assert((await focusedKey(page)) === want, 'could not reach ' + want + ', at ' + await focusedKey(page));
    };
    const cutLabels = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bl-cut'), (n) =>
      n.querySelector('.bl-clabel').textContent + ' · ' + n.querySelector('.bl-camount').textContent));
    const destVals = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bl-drow'), (n) =>
      n.querySelector('.bl-dname').textContent + ': ' + n.querySelector('.bl-dval').textContent));
    const fills = (page) => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bl-fill, #panel .bl-dfill'), (n) => n.style.transform));
    // The sample: room 186.40 over 3 days of a 16 day month. p_i is
    // round(mtd / 16 * 3): 35, 24, 17, 11, 10; combined 498.57 gives 93.48.
    const P_I = [35, 24, 17, 11, 10];

    await check('Budget lab merchants: five slider rows, label above the track; a press changes text and one transform per changed bar; p_i stops it', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        let labels = await cutLabels(page);
        assert(labels.length === 5 && labels[0] === 'Hilltop Grocer · $184 so far · cut $0' && labels[4] === 'Riverside Fuel · $55 so far · cut $0', 'rows: ' + labels.join(' | '));
        const above = await page.evaluate(() => Array.prototype.every.call(document.querySelectorAll('#panel .bl-cut'), (row) =>
          row.querySelector('.bl-clabel').getBoundingClientRect().bottom <= row.querySelector('.bl-ctrack').getBoundingClientRect().top + 0.5));
        assert(above, 'a label is not on its own line above its track');
        assert(/MERCHANTS|Merchants/.test(await labPanel(page)) && /Cut what you would skip before Nov 19/.test(await labPanel(page)), 'merchants head: ' + await labPanel(page));
        assert(/PUT IT SOMEWHERE|Put it somewhere/.test(await labPanel(page)), 'no Put it somewhere');
        let dest = await destVals(page);
        assert(dest.join(' | ') === 'Card day: On track | Savings: $0 of $500 | AWWS: $0 of $150 | Buffer: $0 of $350', 'destinations: ' + dest.join(' | '));
        assert(!(await has(page, '#panel .bl-dest.f, #panel .bl-dest .f')), 'Put it somewhere takes focus');
        // The panel is longer than its box at this size: it scrolls to the focused row.
        await goTo(page, 'cut-0');
        const view = await page.evaluate(() => {
          const body = document.querySelector('#panel .panel-body');
          const b = body.getBoundingClientRect();
          const r = document.querySelector('#panel [data-key="cut-0"]').getBoundingClientRect();
          return { scrolls: body.scrollHeight > body.clientHeight, top: body.scrollTop, inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 };
        });
        assert(view.inside && (!view.scrolls || view.top > 0), 'the merchants are out of view: ' + JSON.stringify(view));
        const before = await fills(page);
        await page.evaluate(() => {
          window.__labRoot = document.querySelector('#panel .bl-panel');
          window.__cutText = document.querySelector('#panel .bl-clabel').firstChild;
        });
        await press(page, 'ArrowRight', 3);
        const after = await page.evaluate(() => ({
          same: window.__labRoot === document.querySelector('#panel .bl-panel') && window.__cutText === document.querySelector('#panel .bl-clabel').firstChild,
          trans: Array.prototype.map.call(document.querySelectorAll('#panel .bl-cfill, #panel .bl-dfill'), (n) => getComputedStyle(n).transitionDuration)
        }));
        assert(after.same, 'the panel was drawn again for a key press');
        assert(after.trans.every((t) => /^0s(, 0s)*$/.test(t)), 'a bar has a transition: ' + after.trans.join());
        assert((await focusedKey(page)) === 'cut-0', 'Right moved focus away');
        const s = await session(page);
        assert(JSON.stringify(s.cuts) === '{"Hilltop Grocer":3}', 'session: ' + JSON.stringify(s));
        labels = await cutLabels(page);
        assert(labels[0] === 'Hilltop Grocer · $184 so far · cut $3', 'row: ' + labels[0]);
        const now = await fills(page);
        const changed = now.map((t, i) => t !== before[i] ? i : -1).filter((i) => i >= 0);
        // Index 0 is the cap's fill, 1 to 5 the cuts, 6 card day, 7 savings.
        assert(changed.join() === '1,7', 'changed bars: ' + changed.join() + ' ' + JSON.stringify(now));
        assert(now[1] === 'scaleX(' + Math.round(3 / 35 * 10000) / 10000 + ')', 'cut fill: ' + now[1]);
        dest = await destVals(page);
        assert(dest[1] === 'Savings: $3 of $500', 'destinations: ' + dest.join(' | '));
        assert(/Nov 19: covered, \$3 spare/.test(await labPanel(page)), 'outcome: ' + await labPanel(page));
        // Held on and on: the cut stops at the merchant's projection, $35.
        await press(page, 'ArrowRight', 45);
        assert((await session(page)).cuts['Hilltop Grocer'] === P_I[0], 'at the top: ' + JSON.stringify(await session(page)));
        assert((await cutLabels(page))[0] === 'Hilltop Grocer · $184 so far · cut $35', 'row: ' + (await cutLabels(page))[0]);
        assert((await fills(page))[1] === 'scaleX(1)', 'full fill: ' + (await fills(page))[1]);
        // Up and Down go through the rows in order; Back to calculated and the daily goal sit between the cap and the first row.
        await press(page, 'ArrowDown');
        assert((await focusedKey(page)) === 'cut-1', 'Down: ' + await focusedKey(page));
        await press(page, 'ArrowUp', 2);
        assert((await focusedKey(page)) === 'goal', 'Up from the first row: ' + await focusedKey(page));
        await press(page, 'ArrowUp');
        assert((await focusedKey(page)) === 'reset', 'Up from the goal: ' + await focusedKey(page));
        await press(page, 'ArrowUp');
        assert((await focusedKey(page)) === 'cap', 'Up from Back to calculated: ' + await focusedKey(page));
        // Full screen all along: the cap and the rows on the left, the runway and Put it somewhere on the right; the cut is still there.
        const cols = await page.evaluate(() => {
          const c = document.querySelectorAll('#panel .bl-pwrap > .bu-pcol');
          return { n: c.length, cuts: c[0] && c[0].querySelectorAll('.bl-cut').length, dest: c[1] && !!c[1].querySelector('.bl-dest'), pace: c[1] && !!c[1].querySelector('.bl-pace'), paceLeft: !!c[0].querySelector('.bl-pace') };
        });
        assert(cols.n === 2 && cols.cuts === 5 && cols.dest && !cols.pace && cols.paceLeft, 'full screen: ' + JSON.stringify(cols));
        assert((await cutLabels(page))[0] === 'Hilltop Grocer · $184 so far · cut $35', 'full row: ' + (await cutLabels(page))[0]);
        assert((await destVals(page))[1] === 'Savings: $35 of $500', 'full destinations: ' + (await destVals(page)).join(' | '));
        await goTo(page, 'cut-0');
        await press(page, 'ArrowLeft');
        assert((await session(page)).cuts['Hilltop Grocer'] === 34, 'Left at full screen: ' + JSON.stringify(await session(page)));
        const p = await page.evaluate(inspect, ['#panel .panel-body', 1.5]);
        assert(!p.length, 'full screen: ' + p.slice(0, 5).join('; '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Budget lab merchants: together the cuts stop at combined ($93.48 over 3 days), and lock at a $0 cap', async () => {
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        await goTo(page, 'cut-0');
        for (let i = 0; i < 4; i++) {
          await press(page, 'ArrowRight', P_I[i] + 5);
          await press(page, 'ArrowDown');
        }
        assert((await focusedKey(page)) === 'cut-4', 'at ' + await focusedKey(page));
        // 35 + 24 + 17 + 11 = 87 leaves $6 of the combined $93.48 for the fuel's $10.
        await press(page, 'ArrowRight', 12);
        const s = await session(page);
        assert(JSON.stringify(s.cuts) === JSON.stringify({ 'Hilltop Grocer': 35, 'Quick Bites Delivery': 24, 'Corner Bakery Stand': 17, 'Maple Street Books': 11, 'Riverside Fuel': 6 }),
          'cuts: ' + JSON.stringify(s.cuts));
        const r = await page.evaluate(() => window.HUB_BUDGET_LAB_TEST.result());
        assert(r.cuts === 93 && r.cuts <= r.cutsLimit && r.cutsLimit === 93.48, 'together: ' + r.cuts + ' of ' + r.cutsLimit);
        assert(/The five together cut at most \$93/.test(await labPanel(page)), 'note: ' + await labPanel(page));
        assert((await destVals(page))[1] === 'Savings: $93 of $500', 'destinations: ' + (await destVals(page)).join(' | '));
        // The cap down to $0: nothing left to cut from; the rows lock and dim.
        await goTo(page, 'cap', 'ArrowUp');
        await press(page, 'ArrowLeft', 70);
        assert((await text(page, '#panel .bl-big')) === '$0', 'cap: ' + await text(page, '#panel .bl-big'));
        const locked = await page.evaluate(() => ({
          rows: document.querySelectorAll('#panel .bl-cut.is-locked').length,
          r: window.HUB_BUDGET_LAB_TEST.result(),
          fills: Array.prototype.map.call(document.querySelectorAll('#panel .bl-cfill'), (n) => n.style.transform)
        }));
        assert(locked.rows === 5 && locked.r.locked && locked.r.cuts === 0 && locked.r.merchants.every((m) => m.cut === 0 && m.max === 0), 'locked: ' + JSON.stringify(locked).slice(0, 300));
        assert(locked.fills.every((f) => f === 'scaleX(0)'), 'locked fills: ' + locked.fills.join());
        assert(/Nothing left to cut from/.test(await labPanel(page)), 'no locked note: ' + await labPanel(page));
        assert((await cutLabels(page))[0] === 'Hilltop Grocer · $184 so far · cut $0', 'locked row: ' + (await cutLabels(page))[0]);
        await goTo(page, 'cut-0');
        await press(page, 'ArrowRight', 3);
        const kept = await session(page);
        assert(kept.cuts['Hilltop Grocer'] === 35 && kept.cap === 0, 'a locked press changed the session: ' + JSON.stringify(kept));
        assert((await focusedKey(page)) === 'cut-0', 'a locked press moved focus');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Budget lab Put it somewhere: example B fills card day first, then savings, AWWS, buffer', async () => {
      // Example B (made-up figures): room 1,334 over 14 days of a 17 day month; Amazon 495 so far projects to 408, DoorDash 120 to 99.
      const b = H.budgetSample.snapshot({ sentAt: FRESH });
      Object.assign(b.lab, { room: 1334, spentToday: 0, daysLeft: 14, monthDay: 17, cardDate: '2026-11-30' });
      b.merchants.combined = 640;
      b.merchants.items = [{ label: 'Amazon', mtd: 495, count: 11 }, { label: 'DoorDash', mtd: 120, count: 4 }, { label: 'Corner Bakery Stand', mtd: 40, count: 8 }];
      await env.setBudget(b);
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        assert(/\$95\s*a day/.test(await labPanel(page)), 'start: ' + await labPanel(page));
        assert((await cutLabels(page))[0] === 'Amazon · $495 so far · cut $0', 'row: ' + (await cutLabels(page))[0]);
        // Cap $80: K = 1,334 - 1,120 = 214, all of it to savings.
        await press(page, 'ArrowLeft', 16);
        assert((await session(page)).cap === 80, 'cap: ' + JSON.stringify(await session(page)));
        let d = await destVals(page);
        assert(d.join(' | ') === 'Card day: Covered | Savings: $214 of $500 | AWWS: $0 of $150 | Buffer: $0 of $350', 'cap $80: ' + d.join(' | '));
        // Cut Amazon $40 and DoorDash $15: K = 269.
        await goTo(page, 'cut-0');
        await press(page, 'ArrowRight', 40);
        await press(page, 'ArrowDown');
        await press(page, 'ArrowRight', 15);
        assert((await cutLabels(page))[0] === 'Amazon · $495 so far · cut $40', 'row: ' + (await cutLabels(page))[0]);
        d = await destVals(page);
        assert(d[1] === 'Savings: $269 of $500' && d[0] === 'Card day: Covered', 'with cuts: ' + d.join(' | '));
        assert(/Nov 30: covered, \$269 spare/.test(await labPanel(page)), 'outcome: ' + await labPanel(page));
        // Cap $100 is short 66 before any cut; the 55 of cuts go to card day first, 11 still short, nothing to savings.
        await goTo(page, 'cap', 'ArrowUp');
        await press(page, 'ArrowRight', 20);
        d = await destVals(page);
        assert(d.join(' | ') === 'Card day: $55 of $66 · short $11 | Savings: $0 of $500 | AWWS: $0 of $150 | Buffer: $0 of $350', 'cap $100: ' + d.join(' | '));
        assert(await has(page, '#panel .bl-dfill.is-neg') && await has(page, '#panel .bl-dval.is-neg'), 'card day short is not coral');
        // Cap $0: everything kept, the split filled in order and the rest is extra.
        await press(page, 'ArrowLeft', 110);
        d = await destVals(page);
        assert(d.join(' | ') === 'Card day: Covered | Savings: $500 of $500 | AWWS: $150 of $150 | Buffer: $350 of $350', 'cap $0: ' + d.join(' | '));
        assert(/\+\$334 more to savings/.test(await labPanel(page)), 'extra: ' + await labPanel(page));
        const f = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .bl-dfill'), (n) => n.style.transform));
        assert(f.join() === 'scaleX(1),scaleX(1),scaleX(1),scaleX(1)', 'fills: ' + f.join());
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    /* ---------- Budget lab: the runway chart (full screen) ---------- */
    // The sample's 14 day window with a payday (dev/budget-sample.js, payday):
    // room 2,045.75 over 14 days, calculated cap 146.125, capMax 293.
    const chartOf = (page) => page.evaluate(() => {
      const box = document.querySelector('#panel .bl-chart');
      if (!box) return null;
      const owed = box.querySelector('.bl-ch-owed');
      const pts = (owed.getAttribute('points') || '').trim().split(/\s+/).map((p) => p.split(',').map(Number));
      const gap = box.querySelector('.bl-ch-gap');
      let other = '';
      Array.prototype.forEach.call(box.querySelectorAll('*'), (n) => {
        if (n === gap || gap.contains(n)) return;
        for (const c of n.childNodes) if (c.nodeType === 3) other += c.nodeValue + ' ';
      });
      const col = box.closest('.bu-pcol');
      return { end: pts[pts.length - 1], start: pts[0], n: pts.length, gap: gap.textContent, gapCls: gap.className, other: other,
        labels: Array.prototype.map.call(box.querySelectorAll('.bl-ch-lab'), (n) => n.textContent),
        right: !!col && !!col.previousElementSibling, pay: box.querySelectorAll('.bl-ch-pay').length,
        room: box.querySelector('.bl-ch-room').getAttribute('points'), view: box.querySelector('svg').getAttribute('viewBox') };
    });
    // From the full screen button: Down into the left column's rows, then Up to the cap (the first row).
    const toCap = async (page) => {
      for (let i = 0; i < 4 && !/^(cap|reset|cut-\d+)$/.test(await focusedKey(page) || ''); i++) await H.key(page, 'ArrowDown');
      for (let i = 0; i < 16 && (await focusedKey(page)) !== 'cap'; i++) await H.key(page, 'ArrowUp');
      assert((await focusedKey(page)) === 'cap', 'could not reach the cap: ' + await focusedKey(page));
    };

    await check('Budget lab runway chart: at full screen; the owed line ends at P and moves with the cap and a cut; no $ but the gap', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        let c = await chartOf(page);
        assert(c && c.right && c.n === 2 && c.pay === 1, 'full screen chart: ' + JSON.stringify(c));
        assert(c.gap === 'On track, $0 spare' && /is-even/.test(c.gapCls) && !/is-ok/.test(c.gapCls), 'gap at the calculated cap: ' + c.gap + ' ' + c.gapCls);
        assert(!/\$/.test(c.other), 'a figure in the chart besides the gap: ' + c.other);
        assert(c.labels.indexOf('Nov 20') >= 0 && c.labels.indexOf('Nov 30') >= 0 && c.labels.indexOf('Mon') >= 0, 'labels: ' + c.labels.join(' | '));
        assert(/Runway to Nov 30/i.test(await text(page, '#panel .bl-chart-head')), 'head: ' + await text(page, '#panel .bl-chart-head'));
        // At the calculated cap the owed line ends where the headroom line does (K = 0).
        const roomEnd = c.room.trim().split(/\s+/).pop().split(',').map(Number);
        assert(Math.abs(roomEnd[0] - c.end[0]) < 0.11 && Math.abs(roomEnd[1] - c.end[1]) < 1.5, 'ends: ' + roomEnd + ' vs ' + c.end);
        const start = c.end;
        await toCap(page);
        await H.key(page, 'ArrowRight');
        await H.sleep(200);
        c = await chartOf(page);
        assert(c.end[1] < start[1] && c.end[0] === start[0], 'the end did not rise with the cap: ' + start + ' to ' + c.end);
        assert(c.gap === 'Short by $13' && /is-neg/.test(c.gapCls), '$147 a day: ' + c.gap + ' ' + c.gapCls);
        await H.key(page, 'ArrowLeft', 2);
        await H.sleep(200);
        c = await chartOf(page);
        assert(c.end[1] > start[1] && c.gap === 'Covered, $15 spare' && /is-ok/.test(c.gapCls), '$145 a day: ' + JSON.stringify(c.end) + ' ' + c.gap);
        const at145 = c.end;
        await goTo(page, 'cut-0');
        await H.key(page, 'ArrowRight', 10);
        await H.sleep(200);
        c = await chartOf(page);
        assert(c.end[1] > at145[1] && c.gap === 'Covered, $25 spare', 'a $10 cut: ' + JSON.stringify(c.end) + ' ' + c.gap);
        assert(!/\$/.test(c.other), 'a figure in the chart besides the gap: ' + c.other);
        const p = await page.evaluate(inspect, ['#panel .panel-body', 1.5]);
        assert(!p.length, 'chart text: ' + p.slice(0, 5).join('; '));
        await H.key(page, 'Escape');
        await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, 'Back did not close it');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Budget lab runway chart: a held key writes the owed line at most every 120 ms, one points write a tick, the scale fixed', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true }));
      const page = await env.newPage({ layout: ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        await toCap(page);
        const before = await chartOf(page);
        const every = await page.evaluate(() => window.HUB_BUDGET_LAB_TEST.CHART_EVERY);
        assert(every === 120, 'CHART_EVERY ' + every);
        await page.evaluate(() => {
          const box = document.querySelector('#panel .bl-chart');
          window.__chartBox = box;
          window.__muts = [];
          window.__writes = [];
          window.__presses = 0;
          window.addEventListener('keydown', () => { window.__presses++; }, true);
          const owed = box.querySelector('.bl-ch-owed');
          const set = owed.setAttribute;
          owed.setAttribute = function (k, v) { window.__writes.push({ k: k, t: performance.now(), press: window.__presses }); return set.call(this, k, v); };
          window.__obs = new MutationObserver((list) => list.forEach((m) => {
            const n = m.target.nodeType === 3 ? m.target.parentNode : m.target;
            window.__muts.push({ type: m.type, attr: m.attributeName, cls: String(n.getAttribute && n.getAttribute('class') || '') });
          }));
          window.__obs.observe(box, { attributes: true, characterData: true, childList: true, subtree: true });
          window.__trans = Array.prototype.map.call(box.querySelectorAll('*'), (n) => getComputedStyle(n).transitionDuration).filter((d) => !/^0s(, 0s)*$/.test(d));
        });
        // A hold of 1.5 s: one press, the repeat after 500 ms, every 50 ms (real time too).
        const t0 = Date.now();
        for (const t of REPEAT.filter((x) => x <= 1500)) {
          const wait = t0 + t - Date.now();
          if (wait > 0) await H.sleep(wait);
          await page.clock.setFixedTime(new Date(H.MONDAY + t));
          await page.keyboard.press('ArrowRight');
        }
        await H.sleep(400);
        const got = await page.evaluate(() => ({ writes: window.__writes, muts: window.__muts, presses: window.__presses, trans: window.__trans,
          same: window.__chartBox === document.querySelector('#panel .bl-chart') }));
        const s = await session(page);
        assert(got.same, 'the chart was drawn again during the hold');
        assert(!got.trans.length, 'a transition in the chart: ' + got.trans.join());
        assert(got.presses === REPEAT.filter((x) => x <= 1500).length && s.cap > 160, 'presses ' + got.presses + ', cap ' + s.cap);
        const pw = got.writes.filter((w) => w.k === 'points');
        assert(pw.length === got.writes.length, 'another attribute written on the owed line: ' + JSON.stringify(got.writes.slice(0, 3)));
        assert(pw.length >= 3 && pw.length < got.presses, got.presses + ' presses, ' + pw.length + ' points writes');
        const per = {};
        pw.forEach((w) => { per[w.press] = (per[w.press] || 0) + 1; });
        const last = got.presses;
        assert(Object.keys(per).every((k) => per[k] <= (Number(k) === last ? 2 : 1)), 'more than one write for a press: ' + JSON.stringify(per));
        for (let i = 1; i < pw.length; i++) assert(pw[i].t - pw[i - 1].t >= every - 8, 'writes ' + Math.round(pw[i].t - pw[i - 1].t) + ' ms apart');
        // Only the owed line's points and the gap label's words changed.
        const bad = got.muts.filter((m) => !(m.type === 'attributes' && m.attr === 'points' && /bl-ch-owed/.test(m.cls)) &&
          !(/bl-ch-gap/.test(m.cls) && (m.type !== 'attributes' || m.attr === 'class')));
        assert(!bad.length, 'other changes in the chart: ' + JSON.stringify(bad.slice(0, 4)));
        // The scale and every other mark stayed; the last press landed (the trailing write).
        const after = await chartOf(page);
        assert(after.room === before.room && after.view === before.view && after.labels.join() === before.labels.join() && after.start.join() === before.start.join(),
          'the axes moved: ' + JSON.stringify([before.room, after.room]).slice(0, 200));
        assert(after.end[1] < before.end[1] && after.end[1] >= 0, 'end: ' + before.end + ' to ' + after.end);
        const r = await page.evaluate(() => window.HUB_BUDGET_LAB_TEST.result());
        assert(after.gap === 'Short by $' + Math.ceil(-r.keep - 1e-9), 'the gap after release: ' + after.gap + ', K ' + r.keep);
        // Drawn again from nothing at the same session, the owed line ends in the same place.
        await H.key(page, 'Escape');
        await H.idle(page);
        await H.openPanel(page, 'budget-lab');
        const again = await chartOf(page);
        assert(again.end.join() === after.end.join() && again.gap === after.gap && again.room === before.room, 'redrawn: ' + again.end + ' vs ' + after.end);
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Budget lab runway chart: no runway sent shows the lab\'s waiting words; in Guest mode the chart draws with its gap blurred', async () => {
      const b = H.budgetSample.snapshot({ sentAt: FRESH });
      b.runway = null;     // the budget app's way to say the section is gone
      await env.setBudget(b);
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        assert(!(await has(page, '#panel .bl-chart')) && /Waiting for the budget app/.test(await text(page, '#panel .bl-chart-sec')), 'no runway: ' + await text(page, '#panel .bl-chart-sec'));
        await H.key(page, 'Escape');
        await H.idle(page);
        await H.key(page, 'Escape');
        await H.idle(page);
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, payday: true }));
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(300);
        await H.openPanel(page, 'budget-lab');
        const p = await labPanel(page);
        assert(await has(page, '#panel .bl-chart svg polyline'), 'guest full screen: no chart: ' + p);
        await allBlurred(page, '#panel .bl-ch-gap', 'the gap');
        await allBlurred(page, '#panel', 'guest full screen');
        noErrors(page);
      } finally {
        await page.ctx.close();
        await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      }
    });

    await check('Guest mode: Budget lab keeps the merchants and Put it somewhere with their names, amounts blurred, and the session cuts', async () => {
      const page = await env.newPage({ layout: GUEST_ROW, storage: { 'homeHub.budget.seen.v1': '["a-1042"]' } });
      try {
        await H.openPanel(page, 'budget-lab');
        await goTo(page, 'cut-1');
        await press(page, 'ArrowRight', 5);
        assert((await session(page)).cuts['Quick Bites Delivery'] === 5, 'session: ' + JSON.stringify(await session(page)));
        await H.key(page, 'Escape');
        await H.idle(page);
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(300);
        assert((await session(page)).cuts['Quick Bites Delivery'] === 5, 'cuts dropped: ' + JSON.stringify(await session(page)));
        await H.openPanel(page, 'budget-lab');
        assert(await has(page, '#panel .bl-cut') && await has(page, '#panel .bl-dest'), 'rows not drawn');
        const p = await allBlurred(page, '#panel', 'panel');
        assert(/Quick Bites/.test(p) && /Savings/.test(p), 'names: ' + p);
        assert((await cutLabels(page))[1] === 'Quick Bites Delivery · $127 so far · cut $5', 'cut label: ' + (await cutLabels(page))[1]);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

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
        if (id === 'awws-money') assert(preset.layout.some((t) => t.widget === 'entertainment'), 'no Entertainment on it');
        if (id === 'budget') {
          // Ian's call: Spending's trend on top (8 x 3), Card day and Goals (4 x 3 each) below.
          const goals = preset.layout.filter((t) => t.widget === 'budget-goals')[0];
          assert(goals && goals.w === 4 && goals.h === 3, 'budget-goals: ' + JSON.stringify(goals));
          const sp = preset.layout.filter((t) => t.widget === 'spending')[0];
          assert(sp && sp.x === 4 && sp.y === 0 && sp.w === 8 && sp.h === 3, 'spending: ' + JSON.stringify(sp));
        }
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

    await check('the switcher: eleven pills, all whole; "Budget" switches and back', async () => {
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
        assert(names.length === 11 && names.indexOf('AWWS money') >= 0 && names.indexOf('Budget') >= 0, 'pills: ' + names.join(', '));
        assert(!bar.over, 'the bar overflows');
        for (const it of bar.items) assert(it.l >= 0 && it.r <= bar.w && !it.cut, 'pill cut: ' + it.name);
        for (let i = 0; i < 9; i++) {
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

    await check('the default layout is unchanged', async () => {
      assert(C.layout.map((t) => t.widget).join() === 'today,calendar,awws,weather,todo,mirror,wotd,ambience,nowplaying,entertainment', 'stock layout changed');
      assert(C.layouts[0].id === 'stock' && C.layouts[0].layout === null, 'Default is not first');
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
    for (const f of ['app/widgets/budget.js', 'app/widgets/budget-lab.js', 'app/widgets/investments.js', 'app/budget-lab-math.js', 'app/widgets/awws.js', 'app/hub.js', 'app/config.js', 'app/icons.js', 'app/guest.js', 'app/widgets/today.js']) {
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
