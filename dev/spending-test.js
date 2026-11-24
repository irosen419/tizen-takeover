/*
 * The Spending tile and its Trend page: node dev/spending-test.js
 *
 * Runs the real hub in headless Chromium against the preview and the real hub
 * server from pi/ (dev/awws-harness.js), with the made-up month of
 * dev/budget-sample.js (spendingDays: Oct 16 to Nov 15; goals $75 from Oct 16
 * and $60 from Nov 9, added on the TV side by budgetSample.spendingHook,
 * since the snapshot does not carry the goal history yet). Checks:
 *   - wiring: hub.html loads spending-math.js before the widget, the Budget
 *     layout in config.js, Guest mode's MONEY list;
 *   - the tile at 1x1, a strip, 3x2, 4x3 and 8x3: figures, nothing clipped;
 *   - the Trend page: the four numbers, the section line, the legend, the
 *     readout, the chart (31 days, red only above the goal, the goal stepping
 *     on Nov 9 with its tick), the dated goals;
 *   - a goal change mid-window: days before Nov 9 read against $75;
 *   - Left and Right move the readout a day (the marker moves by transform);
 *     a click on a bar focuses that day;
 *   - no goal: no goal line, no Goal legend entry, the typical day and the
 *     30-day average instead; empty and partial data ("Trend starts
 *     building"); no pace section ("Waiting for the budget app"); old data
 *     dims; widgets.budget.show false hides it;
 *   - stale data (pace stops before yesterday): "No data since Nov 12" in
 *     place of the streak and the verdict, the chart runs to yesterday with
 *     empty days, over a week stale a message instead of the figures;
 *   - Guest mode: no dollar readable on the tile or the page, every blur is
 *     one amount, "12 of 14 days" and the legend stay readable;
 *   - Spanish, and Spanish 25% longer with accents: tile sizes and the page,
 *     nothing clipped, the legend localized;
 *   - motion: only transform and opacity animate, at most 40 elements, the
 *     numbers end exact; reduced motion draws the final state at once;
 *   - tablet (1280x800 and 600 wide): the page scrolls by touch to its end;
 *   - app/widgets/spending.js is plain ES5 and every English string has a
 *     Spanish one.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const SEL = '.cell[data-widget="spending"] .tile-body';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const FRESH = iso(H.MONDAY - 60000);
const OLD = iso(H.MONDAY - 3 * 3600000);
const GOALS = JSON.stringify(H.budgetSample.SPENDING_GOALS);
// The sample month: 11 days over their goal, 4 days of $0.
const OVER = 11;
const ZERO = 4;

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

/* The page-side inspection of dev/investments-test.js: type too small, a
   text cut without an ellipsis, a line height under 1.25 on a clipped line,
   text clipped by an ancestor. */
function inspect(args) {
  const sel = args[0];
  const minRem = args[1];
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const out = [];
  const roots = document.querySelectorAll(sel);
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
      if (cs.lineHeight !== 'normal' && parseFloat(cs.lineHeight) / fs < 1.245) out.push('line height ' + (parseFloat(cs.lineHeight) / fs).toFixed(2) + ': ' + label);
      if (hides(cs) || cuts(cs)) {
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

function storage(o) {
  const s = { 'homeHub.budget.seen.v1': '["a-1042"]' };
  if (o.goals !== false) s['spending-test-goals'] = o.goals || GOALS;
  if (o.guest) s['homeHub.guest.v1'] = 'on';
  if (o.lang) s['homeHub.lang'] = o.lang;
  if (o.long) s['spending-test-long'] = '1';
  if (o.hide) s['spending-test-hide'] = '1';
  return s;
}

function open(env, o) {
  return env.newPage({ layout: o.layout || [{ widget: 'spending', x: 0, y: 0, w: o.w || 4, h: o.h || 3 }], storage: storage(o),
    lang: o.lang, config: H.budgetSample.spendingHook, motion: o.motion, query: o.query, touch: o.touch });
}

function text(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => n.textContent).join(' | '), sel);
}

// What a guest can read: the text without the Guest mode blur spans.
function seen(page, sel) {
  return page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s), (n) => {
    const c = n.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.guest-blur'), (b) => b.parentNode.removeChild(b));
    return c.textContent;
  }).join(' | '), sel);
}

async function blursOk(page, sel, label) {
  const b = await page.evaluate((s) => Array.prototype.map.call(document.querySelectorAll(s + ' .guest-blur'), (n) => {
    const cs = getComputedStyle(n);
    return { t: n.textContent, ok: cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' && cs.textShadow !== 'none' };
  }), sel);
  assert(b.length, label + ': nothing blurred');
  const bad = b.filter((x) => !/^[+\-−]?\$\d[\d,]*(\.\d+)?$/.test(x.t) || !x.ok);
  assert(!bad.length, label + ': ' + JSON.stringify(bad));
}

async function openPage(page) {
  await H.openPanel(page, 'spending');
  await H.sleep(300);
}

const readout = (page) => text(page, '#panel .sp-read');

async function main() {
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, trend: true }));

    await check('wiring: hub.html loads the math before the widget, the Budget layout, Guest mode knows it', () => {
      const hub = fs.readFileSync(path.join(ROOT, 'app', 'hub.html'), 'utf8');
      const a = hub.indexOf('src="spending-math.js"');
      const b = hub.indexOf('src="widgets/spending.js"');
      assert(a > 0 && b > a && hub.indexOf('widgets/spending.css') > 0, 'hub.html');
      const vm = require('vm');
      const box = {};
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
      const lay = box.c.layouts.filter((l) => l.id === 'budget')[0].layout.map((e) => [e.widget, e.x, e.y, e.w, e.h].join(',')).sort().join(' ');
      assert(lay === ['budget-card,4,3,4,3', 'budget-goals,8,3,4,3', 'budget-lab,0,3,4,3', 'budget-room,0,0,4,3', 'spending,4,0,8,3'].join(' '), lay);
      assert(/'spending'\]/.test(fs.readFileSync(path.join(ROOT, 'app', 'guest.js'), 'utf8')), 'guest.js MONEY');
    });

    await check('the tile: 1x1 one figure; strip; 3x2 and 4x3 the week, the verdict, the footer; nothing clipped', async () => {
      for (const sz of [[1, 1], [1, 2], [3, 1], [6, 1], [3, 2], [4, 2], [4, 3], [5, 4]]) {
        const page = await open(env, { w: sz[0], h: sz[1] });
        try {
          const t = await text(page, SEL);
          assert(/\$42/.test(t), sz.join('x') + ': ' + t);
          if (sz[0] >= 3 && sz[1] >= 2) assert(/Down from \$59/.test(t), sz.join('x') + ' verdict: ' + t);
          if (sz[0] >= 4 && sz[1] >= 3) {
            assert(/Under your goal 12 of 14 days|12 of 14 days under/.test(t) && /\$306 kept/.test(t), sz.join('x') + ' footer: ' + t);
            assert(/a day this week/.test(t), sz.join('x') + ' cap: ' + t);
            const bars = await page.evaluate((s) => document.querySelectorAll(s + ' .sp-day').length, SEL);
            assert(bars === 14, sz.join('x') + ': ' + bars + ' days');
          }
          const p = await page.evaluate(inspect, [SEL, 0.85]);
          assert(!p.length, sz.join('x') + ': ' + p.join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('the wide tile (8x3, 6x2): three numbers across, 31 days, the 7-day line, direct labels, the legend', async () => {
      for (const sz of [[8, 3], [6, 2], [12, 3]]) {
        const page = await open(env, { w: sz[0], h: sz[1] });
        try {
          const t = await text(page, SEL);
          assert(/7-day average/.test(t) && /\$42/.test(t) && /Under goal/.test(t) && /12/.test(t) && /\$306/.test(t), sz.join('x') + ': ' + t);
          const c = await page.evaluate((s) => ({ days: document.querySelectorAll(s + ' .sp-day').length, avg: !!document.querySelector(s + ' .sp-avg'),
            goal: !!document.querySelector(s + ' .sp-goal'), labs: Array.prototype.map.call(document.querySelectorAll(s + ' .sp-lab'), (n) => n.textContent),
            legend: Array.prototype.map.call(document.querySelectorAll(s + ' .sp-leg'), (n) => n.textContent) }), SEL);
          assert(c.days === 31 && c.avg && c.goal, sz.join('x') + ': ' + JSON.stringify(c));
          assert(c.labs.indexOf('$60 goal') >= 0 && c.labs.indexOf('7-day $42') >= 0, sz.join('x') + ' labels: ' + c.labs);
          if (sz[1] >= 3) assert(c.legend.join('|') === '7-day average|Goal', sz.join('x') + ' legend: ' + c.legend);
          const p = await page.evaluate(inspect, [SEL, 0.85]);
          assert(!p.length, sz.join('x') + ': ' + p.join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('the Trend page: the four numbers, the section line, the legend, the readout, the chart and the dated goals', async () => {
      const page = await open(env, { w: 8, h: 3 });
      try {
        await openPage(page);
        assert(await page.evaluate(() => window.HUB_TEST.open() === 'spending' && document.getElementById('panel').classList.contains('is-full')), 'not full screen');
        const t = (await text(page, '#panel .panel-body')).replace(/\s+/g, ' ');
        for (const w of ['7-day average', '$42', 'Down from $59 over 30 days', 'Under goal', '12', 'of 14 days', '5 days in a row', 'Kept against your goal', '$306', 'last 14 days',
          'Typical day', '$51', '30-day average $59', 'Everyday spending, last 31 days', 'Rent and bills are left out', 'Sun, Nov 15 · $41', '$19 under the $60 goal',
          'Nov 9 · $60 goal', 'Your goal', '$60', 'from Nov 9', '$75', 'from Oct 16', 'Left and right move day by day', 'Goal', 'Each point is that day and the 6 before it']) {
          assert(t.indexOf(w) >= 0, 'missing "' + w + '" in: ' + t);
        }
        const c = await page.evaluate(() => {
          const svg = document.querySelector('#panel .sp-svg');
          return { days: svg.querySelectorAll('.sp-day').length, over: svg.querySelectorAll('.sp-over').length, zero: svg.querySelectorAll('.sp-zero').length,
            goal: svg.querySelector('.sp-goal').getAttribute('d'), svgText: svg.querySelectorAll('text').length,
            legend: Array.prototype.map.call(document.querySelectorAll('#panel .sp-leg'), (n) => n.textContent) };
        });
        assert(c.days === 31 && c.over === OVER && c.zero === ZERO && c.svgText === 0, JSON.stringify(c));
        // The goal line steps once: two y values.
        const ys = {};
        c.goal.replace(/[ML][\d.]+,([\d.]+)/g, (a, y) => { ys[y] = 1; });
        assert(Object.keys(ys).length === 2, 'goal levels: ' + Object.keys(ys));
        assert(c.legend.join('|') === '7-day average|Goal', 'legend: ' + c.legend);
        const p = await page.evaluate(inspect, ['#panel .panel-body', 0.95]);
        assert(!p.length, p.join('; '));
        const fits = await page.evaluate(() => { const b = document.querySelector('#panel .panel-body'); return b.scrollHeight <= b.clientHeight + 1; });
        assert(fits, 'the TV page does not fit the screen');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Left and Right move the readout a day; the marker moves by transform; a goal change mid-window reads the old goal before Nov 9', async () => {
      const page = await open(env, { w: 8, h: 3 });
      try {
        await openPage(page);
        const before = await readout(page);
        const x0 = await page.evaluate(() => document.querySelector('#panel .sp-cross').style.transform);
        await H.key(page, 'ArrowRight');
        assert((await readout(page)) === before, 'Right past the last day moved: ' + await readout(page));
        await H.key(page, 'ArrowLeft', 5);
        const r = await readout(page);
        assert(/Tue, Nov 10 · \$73\s*\$13 over the \$60 goal/.test(r), 'readout: ' + r);
        const x1 = await page.evaluate(() => document.querySelector('#panel .sp-cross').style.transform);
        assert(/translateX/.test(x1) && x1 !== x0, 'marker: ' + x0 + ' -> ' + x1);
        await H.key(page, 'ArrowLeft', 2);
        assert(/Sun, Nov 8 · \$\d+.*\$75 goal/.test(await readout(page)), 'Nov 8 reads the $75 goal: ' + await readout(page));
        assert(await page.evaluate(() => document.querySelectorAll('#panel .sp-bar.is-focus, #panel .sp-zero.is-focus').length === 1), 'one focused bar');
        const f = await page.evaluate(() => window.HUB_SPENDING_TEST.focus());
        assert(f && f.date === '2026-11-08', JSON.stringify(f));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('a click on a bar focuses that day', async () => {
      const page = await open(env, { w: 8, h: 3 });
      try {
        await openPage(page);
        const pt = await page.evaluate(() => {
          const bars = document.querySelectorAll('#panel .sp-day');
          const r = bars[3].getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.bottom - 4 };
        });
        await page.mouse.click(pt.x, pt.y);
        await H.sleep(300);
        const r = await readout(page);
        assert(/Mon, Oct 19 · \$\d+/.test(r), 'after the click: ' + r);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('no goal: no goal line or Goal legend entry, the typical day and the 30-day average, a note instead of the dated goals', async () => {
      for (const sz of [[4, 3], [8, 3]]) {
        const page = await open(env, { w: sz[0], h: sz[1], goals: false });
        try {
          const t = await text(page, SEL);
          assert(/\$42/.test(t) && !/kept|Under/.test(t) && !(await page.evaluate((s) => !!document.querySelector(s + ' .sp-goal, ' + s + ' .sp-over'), SEL)), sz.join('x') + ': ' + t);
          if (sz[0] === 8) assert(/Typical day/.test(t) && /30-day average/.test(t), t);
        } finally { await page.ctx.close(); }
      }
      const page = await open(env, { w: 8, h: 3, goals: false });
      try {
        await openPage(page);
        const t = await text(page, '#panel .panel-body');
        assert(/No goal set yet/.test(t) && /Typical day/.test(t) && !/Kept against/.test(t), t);
        const legend = await text(page, '#panel .sp-leg');
        assert(legend === '7-day average', 'legend: ' + legend);
        assert(/No goal that day/.test(await readout(page)), await readout(page));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('a goal that starts mid-chart: grey bars before it, not judged', async () => {
      const page = await open(env, { w: 8, h: 3, goals: JSON.stringify([{ from: '2026-11-09', goal: 60 }]) });
      try {
        await openPage(page);
        const c = await page.evaluate(() => ({ free: document.querySelectorAll('#panel .sp-bar.is-free').length, over: document.querySelectorAll('#panel .sp-over').length }));
        assert(c.free > 15 && c.over === 1, JSON.stringify(c));
        assert(/of 7 days/.test(await text(page, '#panel .sp-kpis')), await text(page, '#panel .sp-kpis'));
      } finally { await page.ctx.close(); }
    });

    await check('Guest mode: no dollar readable on the tile or the page; "12 of 14 days" and the legend stay; every blur one amount', async () => {
      for (const sz of [[1, 1], [3, 1], [4, 3], [8, 3]]) {
        const page = await open(env, { w: sz[0], h: sz[1], guest: true });
        try {
          const t = await seen(page, SEL);
          assert(!/\$|\d{2,}\s?kept/.test(t), sz.join('x') + ': ' + t);
          await blursOk(page, SEL, sz.join('x'));
          if (sz[0] >= 4 && sz[1] >= 3) assert(/12\s*of 14 days/.test(t), sz.join('x') + ': ' + t);
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
      const page = await open(env, { w: 8, h: 3, guest: true });
      try {
        await openPage(page);
        await H.key(page, 'ArrowLeft', 3);
        const t = await seen(page, '#panel');
        assert(!/\$/.test(t), 'page: ' + t);
        assert(/of 14 days/.test(t) && /7-day average/.test(t) && /Goal/.test(t) && /(over|under) the/.test(t), 'page lost its words: ' + t);
        await blursOk(page, '#panel', 'page');
        assert(await page.evaluate(() => document.querySelectorAll('#panel .sp-day').length === 31), 'shapes gone');
        assert(!(await page.evaluate(() => Array.prototype.some.call(document.querySelectorAll('#panel .sp-legend .guest-blur'), () => true))), 'the legend is blurred');
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('Spanish and Spanish 25% longer (Á é ñ): tile sizes and the page, nothing clipped, the legend localized', async () => {
      for (const long of [false, true]) {
        for (const sz of [[1, 1], [3, 1], [3, 2], [4, 3], [6, 2], [8, 3]]) {
          const page = await open(env, { w: sz[0], h: sz[1], lang: 'es', long: long });
          try {
            const t = await text(page, SEL);
            assert(t.trim(), sz.join('x') + ': blank');
            if (!long && sz[0] >= 3 && sz[1] >= 2 && !(sz[0] >= 6 && sz[1] === 2)) assert(/Baja desde \$59/.test(t), sz.join('x') + ': ' + t);
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, sz.join('x') + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
        const page = await open(env, { w: 8, h: 3, lang: 'es', long: long });
        try {
          await openPage(page);
          const t = await text(page, '#panel .panel-body');
          if (!long) {
            for (const w of ['Promedio de 7 días', 'Bajo la meta', 'de 14 días', '5 días seguidos', 'Guardado frente a tu meta', 'Día típico', 'Gasto diario, últimos 31 días', 'Meta', 'Tu meta', 'desde el 9 nov']) {
              assert(t.indexOf(w) >= 0, 'missing "' + w + '": ' + t);
            }
            assert((await text(page, '#panel .sp-leg')) === 'Promedio de 7 días | Meta', 'legend: ' + await text(page, '#panel .sp-leg'));
          }
          const p = await page.evaluate(inspect, ['#panel .panel-body', 0.95]);
          assert(!p.length, 'page' + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('motion: only transform and opacity, at most 40 elements, the numbers end exact', async () => {
      const page = await open(env, { w: 8, h: 3, motion: 'push' });
      try {
        await H.focusTile(page, 'spending');
        await H.key(page, 'Enter');
        await H.sleep(250);
        const a = await page.evaluate(() => {
          const list = document.getAnimations().filter((x) => x.effect && x.effect.target && document.getElementById('panel').contains(x.effect.target) &&
            /^sp-/.test(x.animationName || ''));
          const props = {};
          list.forEach((x) => x.effect.getKeyframes().forEach((k) => Object.keys(k).forEach((p) => { props[p] = 1; })));
          return { n: list.length, props: Object.keys(props), moving: !!document.querySelector('#panel .sp-anim') };
        });
        assert(a.moving && a.n > 0, 'no motion: ' + JSON.stringify(a));
        assert(a.n <= 40, a.n + ' animations');
        const bad = a.props.filter((p) => ['offset', 'easing', 'composite', 'computedOffset', 'transform', 'opacity', 'webkitTransform'].indexOf(p) < 0);
        assert(!bad.length, 'animates ' + bad.join(', '));
        await H.sleep(2300);
        const end = await page.evaluate(() => ({ anim: !!document.querySelector('#panel .sp-anim'), nums: Array.prototype.map.call(document.querySelectorAll('#panel .sp-kpi-num'), (n) => n.textContent) }));
        assert(!end.anim && end.nums.join('|') === '$42|12|$306|$51', JSON.stringify(end));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('reduced motion: the final state at once, nothing running', async () => {
      const page = await open(env, { w: 8, h: 3, motion: 'push' });
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await H.focusTile(page, 'spending');
        await H.key(page, 'Enter');
        await H.until(() => page.evaluate(() => !!document.querySelector('#panel .sp-kpi-num')), 3000, 'no page');
        const a = await page.evaluate(() => ({ anim: !!document.querySelector('#panel .sp-anim'),
          running: document.getAnimations().filter((x) => /^sp-/.test(x.animationName || '')).length,
          nums: Array.prototype.map.call(document.querySelectorAll('#panel .sp-kpi-num'), (n) => n.textContent) }));
        assert(!a.anim && !a.running && a.nums.join('|') === '$42|12|$306|$51', JSON.stringify(a));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('tablet: the page scrolls by touch to its end at 1280x800 and 600 wide; a tap reads a day', async () => {
      for (const view of [{ width: 1280, height: 800 }, { width: 1280, height: 600 }, { width: 600, height: 960 }]) {
        const page = await open(env, { w: 8, h: 3, query: 'as=tablet', touch: true });
        try {
          await page.setViewportSize(view);
          await H.sleep(500);
          await openPage(page);
          const s = await page.evaluate(() => {
            const b = document.querySelector('#panel .panel-body');
            const oy = getComputedStyle(b).overflowY;
            b.scrollTop = b.scrollHeight;
            const br = b.getBoundingClientRect();
            const fr = document.querySelector('#panel .sp-pfoot').getBoundingClientRect();
            return { oy: oy, inside: fr.bottom <= br.bottom + 1 && fr.top >= br.top - 1, hint: document.querySelector('#panel .sp-hint').textContent };
          });
          assert(s.oy === 'auto' && s.inside && s.hint === 'Tap a day to read it', view.width + 'x' + view.height + ': ' + JSON.stringify(s));
          const pt = await page.evaluate(() => {
            const b = document.querySelector('#panel .panel-body');
            b.scrollTop = 0;
            const r = document.querySelectorAll('#panel .sp-day')[2].getBoundingClientRect();
            document.querySelector('#panel .sp-day').scrollIntoView && document.querySelectorAll('#panel .sp-day')[2].scrollIntoView({ block: 'center' });
            const r2 = document.querySelectorAll('#panel .sp-day')[2].getBoundingClientRect();
            return { x: r2.left + r2.width / 2, y: r2.bottom - 3, r: r.width };
          });
          await page.touchscreen.tap(pt.x, pt.y);
          await H.sleep(300);
          assert(/Oct 18 · \$/.test(await readout(page)), view.width + ': tap: ' + await readout(page));
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
    });

    await check('old data (3 hours) dims and says "as of"', async () => {
      await env.setBudget(H.budgetSample.snapshot({ sentAt: OLD, trend: true }));
      const page = await open(env, { w: 4, h: 3 });
      try {
        assert(await page.evaluate((s) => !!document.querySelector(s + ' .sp-tile.is-stale'), SEL), 'not dimmed');
        assert(/as of 7:40 AM/.test(await text(page, '.cell[data-widget="spending"]')), 'no as of');
      } finally { await page.ctx.close(); await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, trend: true })); }
    });

    await check('partial data: 2 days say "Trend starts building"; no days too', async () => {
      for (const days of [[{ date: '2026-11-14', spent: 30 }, { date: '2026-11-15', spent: 40 }], []]) {
        const snap = H.budgetSample.snapshot({ sentAt: FRESH });
        snap.pace.days = days;
        await env.setBudget(snap);
        const page = await open(env, { w: 4, h: 3 });
        try {
          assert(/Trend starts building/.test(await text(page, SEL)), days.length + ' days: ' + await text(page, SEL));
          await openPage(page);
          assert(/Trend starts building/.test(await text(page, '#panel .panel-body')), 'page');
          noErrors(page);
        } finally { await page.ctx.close(); }
      }
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, trend: true }));
    });

    await check('stale data: the windows end yesterday; "No data since Nov 12" where the streak and verdict go, empty days to yesterday (English and Spanish)', async () => {
      const snap = H.budgetSample.snapshot({ sentAt: FRESH, trend: true });
      snap.pace.days = snap.pace.days.slice(0, -3);
      await env.setBudget(snap);
      try {
        for (const lang of ['en', 'es']) {
          const gapWords = lang === 'en' ? 'No data since Nov 12' : 'Sin datos desde el 12 nov';
          for (const sz of [[3, 1], [4, 3], [8, 3]]) {
            const page = await open(env, { w: sz[0], h: sz[1], lang: lang });
            try {
              const t = await text(page, SEL);
              const short = lang === 'en' ? 'Last data Nov 12' : 'Último dato 12 nov';
              assert(t.indexOf(gapWords) >= 0 || (sz[1] === 1 && t.indexOf(short) >= 0), lang + ' ' + sz.join('x') + ': ' + t);
              assert(!/in a row|seguid/.test(t), lang + ' ' + sz.join('x') + ' stale streak: ' + t);
              const p = await page.evaluate(inspect, [SEL, 0.85]);
              assert(!p.length, lang + ' ' + sz.join('x') + ': ' + p.join('; '));
              noErrors(page);
            } finally { await page.ctx.close(); }
          }
          const page = await open(env, { w: 8, h: 3, lang: lang });
          try {
            await openPage(page);
            const sub = await text(page, '#panel .sp-kpi-sub.is-gap');
            assert(sub === gapWords, lang + ' page: ' + sub);
            const c = await page.evaluate(() => ({ days: document.querySelectorAll('#panel .sp-day').length, f: window.HUB_SPENDING_TEST.focus() }));
            // 31 chart days to Nov 15; the last 3 are empty, so 28 drawn; focus on the last day with data.
            assert(c.days === 28 && c.f.n === 31 && c.f.date === '2026-11-12', JSON.stringify(c));
            const p = await page.evaluate(inspect, ['#panel .panel-body', 0.95]);
            assert(!p.length, p.join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
        // Over a week stale: a message, never a number from old days.
        snap.pace.days = snap.pace.days.slice(0, -6);
        await env.setBudget(snap);
        const page = await open(env, { w: 4, h: 3 });
        try {
          const t = await text(page, SEL);
          assert(/No data since Nov 6/.test(t) && !/\$/.test(t), t);
          await openPage(page);
          assert(/No data since Nov 6/.test(await text(page, '#panel .panel-body')), 'page');
          noErrors(page);
        } finally { await page.ctx.close(); }
      } finally { await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, trend: true })); }
    });

    await check('widgets.budget.show false: "Budget is hidden"', async () => {
      const page = await open(env, { w: 4, h: 3, hide: true });
      try {
        assert(/Budget is hidden/.test(await text(page, SEL)), await text(page, SEL));
      } finally { await page.ctx.close(); }
    });
  } finally {
    await env.stop();
  }

  const empty = await H.start({ snapshot: false });
  try {
    await empty.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, only: ['room'] }));
    await check('no pace section: "Waiting for the budget app", English and Spanish, nothing clipped', async () => {
      for (const lang of ['en', 'es']) {
        for (const sz of [[1, 1], [3, 1], [3, 2], [8, 3]]) {
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

  await check('spending.js is plain ES5, and every English string has a Spanish one', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'spending.js'), 'utf8');
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    if (acorn) acorn.parse(src, { ecmaVersion: 5 });
    else assert(!/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
    const vm = require('vm');
    const sandbox = { document: { createElement: () => ({}) }, console: console, setTimeout: () => 0 };
    sandbox.window = sandbox;
    vm.runInNewContext(src, sandbox);
    const en = sandbox.HUB_SPENDING_TEST.STRINGS;
    const i18n = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
    const SAME = ['cash', 'minus', 'sep'];
    const miss = [];
    (function walk(o, p) {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string') { if (v && SAME.indexOf(k) < 0 && i18n.indexOf("'spending." + (p ? p + '.' : '') + k + "'") < 0) miss.push((p ? p + '.' : '') + k); }
        else if (!Array.isArray(v) && v && typeof v === 'object') walk(v, (p ? p + '.' : '') + k);
      }
    })(en, '');
    assert(!miss.length, 'no Spanish for: ' + miss.join(', '));
    const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'spending.css'), 'utf8');
    assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'css-end');
    const anims = css.match(/@keyframes [\s\S]*?\}\s*\}/g) || [];
    anims.forEach((k) => assert(!/(width|height|left|top|filter|fill|stroke)\s*:/.test(k), 'keyframes animate layout: ' + k));
  });
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
