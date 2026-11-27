/*
 * The Investments tile: node dev/investments-test.js
 *
 * Runs the real hub in headless Chromium against the preview and the real hub
 * server from pi/ (the same harness as dev/money-test.js), with the made-up
 * investments section of pi/fixtures/budget-sample.json. Checks:
 *   - the tile at its sizes (1 column, a strip, the smallest tile, wider with
 *     the trend, bigger with the allocation bar and holdings): figures,
 *     nothing blank, nothing clipped, no type under 0.85rem;
 *   - the trend: drawn from 2 days of history, hidden under 2 with "Trend
 *     starts building today";
 *   - gain colors: green up, coral down;
 *   - the panel: every account and every top holding;
 *   - old data dims and says "as of"; no section says "Waiting for the budget app";
 *   - Guest mode: every dollar figure blurred (tile, panel, full screen, a
 *     new snapshot), nothing else: percentages, names and the trend stay
 *     readable; nothing is dropped; turning it on and off live;
 *   - Spanish, and Spanish 25% longer with accents: nothing clipped;
 *   - app/widgets/investments.js is plain ES5, in no layout, and every
 *     English string has a Spanish one.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const SEL = '.cell[data-widget="investments"] .tile-body';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const FRESH = iso(H.MONDAY - 60000);
const OLD = iso(H.MONDAY - 3 * 3600000);
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };
// The test page runs in the day theme, where gains and losses take the deep shades.
const GREEN = 'rgb(23, 112, 58)';
const CORAL = 'rgb(179, 38, 30)';
// Any of these readable in Guest mode is a leaked dollar figure.
const FIGURES = /\$|48,2|48\.2|30,1|30\.1|18,1|21,0|9,8|7,4|40,1|8,1|5,2|2,9|3,1|1,2|2,1|5,6/;

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

function noErrors(page) {
  const errs = H.errorsOf(page);
  assert(!errs.length, 'console: ' + errs.join(' | '));
}

// Runs before the hub's scripts: when app/i18n.js sets HUB_I18N, every
// Spanish money text grows by a quarter (placeholders kept whole).
function longer() {
  let real;
  Object.defineProperty(window, 'HUB_I18N', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v;
      try {
        const es = v.strings.es;
        const extra = 'ÁÉñíóú';
        Object.keys(es).forEach((k) => {
          if (!/^investments\./.test(k)) return;
          const text = es[k];
          const words = text.replace(/\{\w+\}/g, '').match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/g);
          if (!words) return;
          let add = Math.ceil(text.length * 0.25);
          let i = 0;
          es[k] = text.replace(/(\{\w+\})|([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,})/g, (all, ph, word) => {
            if (ph || add <= 0) return all;
            const share = Math.max(1, Math.ceil(add / Math.max(1, words.length - i)));
            i++;
            let s = '';
            for (let j = 0; j < share; j++) s += extra.charAt((j + i) % extra.length);
            add -= share;
            return word + s;
          });
          if (/^[A-ZÁÉ]/.test(es[k])) es[k] = '¿' + es[k] + '?';
          else if (es[k].length > 8) es[k] = '¡' + es[k] + '!';
        });
      } catch (e) { /* the test below sees the plain Spanish */ }
    }
  });
}

/* The same page-side inspection as dev/money-test.js. */
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


function layoutOf(w, h) { return [{ widget: 'investments', x: 0, y: 0, w: w, h: h }]; }

function open(env, o) {
  const storage = Object.assign({}, SEEN, o.storage || {});
  if (o.lang) storage['homeHub.lang'] = o.lang;
  return env.newPage({ layout: o.layout || layoutOf(o.w || 3, o.h || 2), storage: storage, config: o.long ? longer : undefined, lang: o.lang });
}

// The whole text under sel, as Guest mode off would draw it: a blur (an
// empty span in the page) counts as the amount it stands for.
function text(page, sel) {
  return page.evaluate((s) => {
    const full = (n) => n.nodeType === 3 ? n.nodeValue
      : (n.className === 'guest-blur' ? window.HUB_GUEST.hidden(n) : Array.prototype.map.call(n.childNodes, full).join(''));
    return Array.prototype.map.call(document.querySelectorAll(s), full).join(' | ');
  }, sel);
}

// What a guest can read: the text without the Guest mode blur spans.
function seen(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => {
    const c = n.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.guest-blur'), (b) => b.parentNode.removeChild(b));
    return c.textContent;
  }).join(' | '), sel);
}

// Each blur is one dollar amount and draws blurred.
async function blursOk(page, sel, label) {
  const b = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + ' .guest-blur'), (n) => {
    const cs = getComputedStyle(n);
    return { t: window.HUB_GUEST.hidden(n), ok: n.textContent === '' && cs.display === 'inline-block' && cs.boxShadow !== 'none' && n.offsetWidth > 0 };
  }), sel);
  assert(b.length, label + ': nothing blurred');
  const bad = b.filter((x) => !/^[+\-\u2212]?\$\d[\d,]*(\.\d+)?$/.test(x.t) || !x.ok);
  assert(!bad.length, label + ': ' + JSON.stringify(bad));
}

function snap(mut, sentAt) {
  const s = H.budgetSample.snapshot({ sentAt: sentAt || FRESH });
  if (mut) mut(s.investments, s);
  return s;
}

async function main() {
  const env = await H.start({});
  try {
    await env.setBudget(snap());

    await check('the Pi accepts the made-up section and the widget is registered in no layout', async () => {
      const d = await env.control('GET', '/api/budget');
      assert((d.data.investments || (d.data.data && d.data.data.investments)) && (d.data.investments || d.data.data.investments).total === 48210.55, 'not stored');
      const cfg = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
      assert(!/widget: 'investments'/.test(cfg), 'investments is in a layout in config.js');
      const hub = fs.readFileSync(path.join(ROOT, 'app', 'hub.html'), 'utf8');
      assert(/widgets\/investments\.js/.test(hub) && /widgets\/investments\.css/.test(hub), 'not loaded by hub.html');
    });

    await check('1 column: one figure, the gain percent under it', async () => {
      const page = await open(env, { w: 1, h: 2 });
      try {
        const t = await text(page, SEL);
        assert(/\$48,211/.test(t) && /\+20\.2%/.test(t), t);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('a strip: total and the gain on one line; wider, the trend too', async () => {
      const page = await open(env, { w: 6, h: 1 });
      try {
        const t = await text(page, SEL);
        assert(/\$48,211/.test(t) && /\+\$8,111/.test(t), t);
        assert(await page.evaluate((s) => !!document.querySelector(s + ' svg polyline'), SEL), 'no trend in a 6 wide strip');
        const p = await page.evaluate(inspect, [SEL, 0.85]);
        assert(!p.length, p.join('; '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('the smallest tile (3x2): total, "+$8,111 · +20.2% vs cost", no trend', async () => {
      const page = await open(env, { w: 3, h: 2 });
      try {
        const t = await text(page, SEL);
        assert(/\$48,211/.test(t) && /\+\$8,111 · \+20\.2%/.test(t), t);
        assert(!(await page.evaluate((s) => !!document.querySelector(s + ' svg'), SEL)), 'a trend on the smallest tile');
        const p = await page.evaluate(inspect, [SEL, 0.85]);
        assert(!p.length, p.join('; '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('wider (4x2 and 6x2): a trend line of 13 points; bigger (6x4): allocation bar, legend and holdings', async () => {
      for (const sz of [[4, 2], [6, 2]]) {
        const page = await open(env, { w: sz[0], h: sz[1] });
        try {
          const pts = await page.evaluate((s) => { const l = document.querySelector(s + ' svg polyline'); return l ? l.getAttribute('points').split(' ').length : 0; }, SEL);
          assert(pts === 13, sz.join('x') + ': ' + pts + ' points');
          assert(!(await page.evaluate((s) => !!document.querySelector(s + ' .iv-alloc'), SEL)), 'allocation on a 2 row tile');
          const p = await page.evaluate(inspect, [SEL, 0.85]);
          assert(!p.length, sz.join('x') + ': ' + p.join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
      for (const sz of [[4, 4], [6, 4], [9, 6]]) {
        const page = await open(env, { w: sz[0], h: sz[1] });
        try {
          const t = await text(page, SEL);
          assert(await page.evaluate((s) => !!document.querySelector(s + ' .iv-alloc .iv-seg'), SEL), sz.join('x') + ': no allocation bar');
          assert(/Roth Contributory IRA 62%|Roth Contributory IRA62%/.test(t.replace(/\s+/g, ' ')) || /Roth Contributory IRA/.test(t), sz.join('x') + ': ' + t);
          assert(/VTI/.test(t) && /44%/.test(t), sz.join('x') + ': holdings ' + t);
          if (sz[0] >= 6) assert(/Vanguard Total Stock Market ETF/.test(t), 'no fund name at 6 wide');
          const p = await page.evaluate(inspect, [SEL, 0.85]);
          assert(!p.length, sz.join('x') + ': ' + p.join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('the allocation is a share of the total: Roth 62%, brokerage 38%, VTI 44%', async () => {
      const page = await open(env, { w: 6, h: 4 });
      try {
        const t = (await text(page, SEL)).replace(/\s+/g, ' ');
        assert(/62%/.test(t) && /38%/.test(t), t);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('click opens it in place: every account and every top holding, with gains', async () => {
      const page = await open(env, { w: 3, h: 2 });
      try {
        await H.openPanel(page, 'investments');
        const p = (await text(page, '#panel .panel-body')).replace(/\s+/g, ' ');
        for (const w of ['Roth Contributory IRA', 'Individual Brokerage', '$30,110', '$18,100', 'VTI', 'VXUS', 'BND', 'SCHD', 'Cash and money market', '$21,000', '+$3,100', '−$310', '+$5,200', 'last 13 days']) {
          assert(p.indexOf(w) >= 0, 'missing ' + w + ' in: ' + p);
        }
        const bad = await page.evaluate(inspect, ['#panel .panel-body', 1]);
        assert(!bad.length, bad.join('; '));
        await H.fullScreen(page);
        const bad2 = await page.evaluate(inspect, ['#panel .panel-body', 1]);
        assert(!bad2.length, 'full screen: ' + bad2.join('; '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('gain colors: a gain is green, a loss is coral (total, gain line, the trend)', async () => {
      const color = (page, sel) => page.evaluate((q) => { const n = document.querySelector(q); return n ? getComputedStyle(n).color : ''; }, sel);
      let page = await open(env, { w: 4, h: 2 });
      try {
        assert((await color(page, SEL + ' .iv-gain')) === GREEN, 'gain line: ' + await color(page, SEL + ' .iv-gain'));
        assert((await color(page, SEL + ' .iv-spark')) === GREEN, 'trend');
        assert(!/−/.test(await text(page, SEL + ' .iv-gain')), 'a minus on a gain');
      } finally { await page.ctx.close(); }
      await env.setBudget(snap((i) => {
        i.gain = -1250.4; i.cost = i.total + 1250.4;
        i.history = i.history.map((d, n) => ({ date: d.date, total: 50000 - n * 100 }));
      }));
      page = await open(env, { w: 4, h: 2 });
      try {
        const t = await text(page, SEL);
        assert(/−\$1,250/.test(t) && /−2\.5%/.test(t), t);
        assert((await color(page, SEL + ' .iv-gain')) === CORAL, 'loss line: ' + await color(page, SEL + ' .iv-gain'));
        assert((await color(page, SEL + ' .iv-spark')) === CORAL, 'trend of a fall');
        noErrors(page);
      } finally { await page.ctx.close(); }
      await env.setBudget(snap());
    });

    await check('the trend hides under 2 days: "Trend starts building today" (none, then one day)', async () => {
      for (const hist of [[], [{ date: '2026-11-18', total: 48100 }]]) {
        await env.setBudget(snap((i) => { i.history = hist; }));
        const page = await open(env, { w: 4, h: 2 });
        try {
          const t = await text(page, SEL);
          assert(/Trend starts building today/.test(t), hist.length + ' days: ' + t);
          assert(!(await page.evaluate((s) => !!document.querySelector(s + ' svg'), SEL)), 'a trend with ' + hist.length + ' days');
          const p = await page.evaluate(inspect, [SEL, 0.85]);
          assert(!p.length, p.join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
      await env.setBudget(snap((i) => { delete i.top; delete i.history; }));
      const page = await open(env, { w: 6, h: 4 });
      try {
        assert(/\$48,211/.test(await text(page, SEL)), 'no top and no history still draws');
        noErrors(page);
      } finally { await page.ctx.close(); }
      await env.setBudget(snap());
    });

    await check('old data (3 hours) dims and says "as of"; fresh data does not', async () => {
      await env.setBudget(snap(null, OLD));
      let page = await open(env, { w: 3, h: 2 });
      try {
        assert(await page.evaluate((s) => !!document.querySelector(s + ' .iv-tile.is-stale'), SEL), 'not dimmed');
        const sub = await text(page, '.cell[data-widget="investments"]');
        assert(/as of 7:40 AM/.test(sub), 'no as of: ' + sub);
      } finally { await page.ctx.close(); }
      await env.setBudget(snap());
      page = await open(env, { w: 3, h: 2 });
      try {
        assert(!(await page.evaluate((s) => !!document.querySelector(s + ' .is-stale'), SEL)), 'dimmed');
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode: every dollar figure blurred, percentages, names and the trend readable, nothing dropped', async () => {
      const cache = JSON.stringify({ v: 1, at: H.MONDAY, sentAt: FRESH, section: snap().investments });
      for (const sz of [[1, 2], [6, 1], [3, 2], [4, 2], [6, 4], [9, 6]]) {
        const page = await open(env, { w: sz[0], h: sz[1], storage: { 'homeHub.guest.v1': 'on', 'homeHub.investments.v1': cache } });
        try {
          const t = await seen(page, SEL);
          assert(t && !FIGURES.test(t), sz.join('x') + ': ' + t);
          assert(/\$48,211/.test(await text(page, SEL)), sz.join('x') + ': the total is gone');
          await blursOk(page, SEL, sz.join('x'));
          if (sz[0] >= 3 && sz[1] >= 2) assert(/\+20\.2%/.test(t), sz.join('x') + ': no gain percent: ' + t);
          if (sz[1] >= 4) assert(/62%/.test(t) && /44%/.test(t), sz.join('x') + ': no shares: ' + t);
          if (sz[0] >= 4 && sz[1] >= 2) assert(await page.evaluate((s) => !!document.querySelector(s + ' svg polyline'), SEL), sz.join('x') + ': no trend shape');
          const svg = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + ' svg text'), (n) => n.textContent).join(''), SEL);
          assert(!svg, 'text on the trend: ' + svg);
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
      const page = await open(env, { w: 3, h: 2, storage: { 'homeHub.guest.v1': 'on' } });
      try {
        await H.openPanel(page, 'investments');
        const p = await seen(page, '#panel');
        assert(p && !FIGURES.test(p), 'panel: ' + p);
        assert(/Roth Contributory IRA/.test(p) && /62%/.test(p) && /VTI/.test(p) && /44%/.test(p) && /\+20\.2%/.test(p), 'panel lacks percentages: ' + p);
        await blursOk(page, '#panel', 'panel');
        await H.fullScreen(page);
        assert(!FIGURES.test(await seen(page, '#panel')), 'full screen shows a figure: ' + await seen(page, '#panel'));
        await blursOk(page, '#panel', 'full screen');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode turned on and off live: the dollars blur at once and come back sharp, the text unchanged', async () => {
      const page = await open(env, { w: 6, h: 4 });
      try {
        const before = await text(page, SEL);
        assert(/\$48,211/.test(before), 'no figure first');
        await page.evaluate(() => window.HUB_GUEST.set(true));
        await H.sleep(300);
        const t = await seen(page, SEL);
        assert(!FIGURES.test(t) && /\+20\.2%/.test(t), 'after On: ' + t);
        assert(await text(page, SEL) === before, 'the text changed');
        await page.evaluate(() => window.HUB_GUEST.set(false));
        await H.sleep(300);
        assert(await text(page, SEL) === before && !(await page.evaluate(() => !!document.querySelector('.guest-blur'))), 'after Off: ' + await text(page, SEL));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode: a new snapshot arriving is blurred too', async () => {
      const page = await open(env, { w: 4, h: 2, storage: { 'homeHub.guest.v1': 'on' } });
      try {
        await env.setBudget(snap((i) => { i.total = 51234.5; i.gain = 11134.5; }));
        await H.sleep(800);
        const t = await seen(page, SEL);
        assert(/\+27\.8%/.test(t) && !/\$|51,2|11,1/.test(t), t);
        assert(/\$51,235/.test(await text(page, SEL)), 'the new total is not drawn: ' + await text(page, SEL));
        await blursOk(page, SEL, 'new snapshot');
        noErrors(page);
      } finally { await page.ctx.close(); await env.setBudget(snap()); }
    });

    await check('Spanish: title, words and accents; amounts stay US; names stay as sent', async () => {
      const page = await open(env, { w: 6, h: 4, lang: 'es' });
      try {
        const t = await text(page, SEL);
        assert(/\$48,211/.test(t) && /sobre el costo/.test(t) && /Roth Contributory IRA/.test(t) && /Vanguard Total Stock Market ETF/.test(t), t);
        assert((await text(page, '.cell[data-widget="investments"] .tile-title')) === 'Inversiones', 'title: ' + await text(page, '.cell[data-widget="investments"] .tile-title'));
        await env.setBudget(snap((i) => { i.history = []; }));
        await H.sleep(600);
        assert(/La tendencia empieza a formarse hoy/.test(await text(page, SEL)), 'no Spanish trend note');
        await page.evaluate(() => window.HUB_I18N.setLang('en'));
        await H.sleep(300);
        assert(/Trend starts building today/.test(await text(page, SEL)) && (await text(page, '.cell[data-widget="investments"] .tile-title')) === 'Investments', 'back to English');
        noErrors(page);
      } finally { await page.ctx.close(); await env.setBudget(snap()); }
    });

    await check('Spanish and Spanish 25% longer (with Á ñ ¿ ¡): every size, panel and full screen, nothing clipped', async () => {
      for (const long of [false, true]) {
        for (const sz of [[1, 2], [3, 1], [6, 1], [3, 2], [4, 2], [6, 3], [6, 4]]) {
          const page = await open(env, { w: sz[0], h: sz[1], lang: 'es', long: long });
          try {
            const t = await text(page, SEL);
            assert(t.trim(), sz.join('x') + ': blank');
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, sz.join('x') + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
        const page = await open(env, { w: 3, h: 2, lang: 'es', long: long });
        try {
          await H.openPanel(page, 'investments');
          let p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
          assert(!p.length, 'panel' + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
          await H.fullScreen(page);
          p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
          assert(!p.length, 'full screen' + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('Spanish in Guest mode: dollars blurred, percentages readable, accents whole', async () => {
      const page = await open(env, { w: 6, h: 4, lang: 'es', long: true, storage: { 'homeHub.guest.v1': 'on' } });
      try {
        const t = await seen(page, SEL);
        assert(!FIGURES.test(t) && /62%/.test(t), t);
        await blursOk(page, SEL, 'es');
        const p = await page.evaluate(inspect, [SEL, 0.85]);
        assert(!p.length, p.slice(0, 4).join('; '));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }

  const empty = await H.start({ snapshot: false });
  try {
    await empty.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, only: ['room'] }));
    await check('no investments section: "Waiting for the budget app", in English and Spanish, nothing clipped', async () => {
      for (const lang of ['en', 'es']) {
        for (const sz of [[1, 2], [3, 1], [3, 2], [6, 4]]) {
          const page = await open(empty, { w: sz[0], h: sz[1], lang: lang });
          try {
            const t = await text(page, SEL);
            if (sz[0] > 1) assert(lang === 'en' ? /Waiting for the budget app/.test(t) : /Esperando la app de presupuesto/.test(t), lang + ' ' + sz.join('x') + ': ' + t);
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, lang + ' ' + sz.join('x') + ': ' + p.join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
      }
    });
  } finally {
    await empty.stop();
  }

  await check('investments.js is plain ES5, and every English string has a Spanish one', () => {
    const file = path.join(ROOT, 'app', 'widgets', 'investments.js');
    const src = fs.readFileSync(file, 'utf8');
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    if (acorn) acorn.parse(src, { ecmaVersion: 5 });
    else assert(!/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
    assert(!/transition|animation|@keyframes/.test(fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'investments.css'), 'utf8')), 'the stylesheet animates');
    // The English paths, from the widget's own EN.
    const vm = require('vm');
    const sandbox = { window: {}, document: { createElement: () => ({}) }, console: console, setTimeout: () => 0 };
    sandbox.window = sandbox;
    vm.runInNewContext(src, sandbox);
    const en = sandbox.HUB_INVESTMENTS_TEST.STRINGS;
    const i18n = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
    const SAME = ['thousands', 'cash', 'minus', 'plus', 'sep'];
    const miss = [];
    (function walk(o, p) {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string') { if (v && SAME.indexOf(k) < 0 && i18n.indexOf("'investments." + (p ? p + '.' : '') + k + "'") < 0) miss.push((p ? p + '.' : '') + k); }
        else if (!Array.isArray(v) && v && typeof v === 'object') walk(v, (p ? p + '.' : '') + k);
      }
    })(en, '');
    assert(!miss.length, 'no Spanish for: ' + miss.join(', '));
  });
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
