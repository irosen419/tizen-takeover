/*
 * Conjugation table, and Word of the day's Conjugation tab:
 *   node dev/conjugate-test.js
 *
 * Runs the real hub in headless Chromium against the preview and the real
 * hub server (dev/awws-harness.js). No fixed day or zone: the page's day is
 * now, or now plus whole days to land on a Word of the day that is (or is
 * not) a verb. Checks:
 *   - wiring: hub.html and touch.html load the verbs before the widget, the
 *     Spanish layout, ES5, Spanish for every label, the CSS rules;
 *   - the data (app/spanish-verbs.js): every Flashcards and Word of the day
 *     verb, irregular marks, the search (start, English, a form);
 *   - the tile: today's word when it is a verb; engage on OK, Left and
 *     Right change the tense, OK the verb, Back leaves;
 *   - the page (hold OK, full screen): focus on the verb shown; a letter
 *     lists its verbs; a verb shows its table; typing "tuve" finds tener;
 *   - Word of the day: a verb's page has Word and Conjugation tabs; another
 *     word's page has none;
 *   - tablet mode taps; the phone (touch.html): letters, verbs, typing;
 *   - Spanish and Spanish 25% longer: nothing clipped; motion only
 *     transform and opacity.
 * CONJ_SHOTS=dir/ (or --shots dir) keeps the pictures.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const SEL = '.cell[data-widget="conjugate"] .tile';
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.CONJ_SHOTS || '');
const DAY = 86400000;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      '));
  }
}

function assert(ok, text) { if (!ok) throw new Error(text); }

function loadApp(files) {
  const box = { window: {} };
  box.window.window = box.window;
  files.forEach((f) => vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'), box.window));
  return box.window;
}

// The page's day: now plus the fewest whole days whose word is (or isn't) a verb.
function dayWhere(wantVerb) {
  const w = loadApp(['wotd-data.js', 'widgets/wotd.js', 'spanish-verbs.js']);
  const have = {};
  w.HUB_SPANISH_VERBS.verbs.forEach((v) => { have[v[0]] = 1; });
  for (let d = 0; d < 400; d++) {
    const at = Date.now() + d * DAY;
    // The day as the page sees it (its zone is the harness's, not this machine's).
    const parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: H.sample.TZ, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(at)).forEach((x) => { parts[x.type] = +x.value; });
    const pick = w.HUB_WOTD.wordFor(new Date(parts.year, parts.month - 1, parts.day));
    const isVerb = pick && pick.w.pos === 'verb' && have[pick.w.es];
    if (!!isVerb === wantVerb) return { at: at, word: pick.w.es };
  }
  throw new Error('no such day');
}

const LAYOUT = [
  { widget: 'wotd', x: 0, y: 0, w: 3, h: 2 },
  { widget: 'conjugate', x: 3, y: 0, w: 3, h: 4 },
  { widget: 'weather', x: 6, y: 0, w: 3, h: 2 },
  { widget: 'todo', x: 6, y: 2, w: 6, h: 4 },
  { widget: 'calendar', x: 0, y: 2, w: 3, h: 4 }
];

function open(env, o) {
  o = o || {};
  return env.newPage({ layout: o.layout || LAYOUT, lang: o.lang, query: 'theme=night' + (o.query ? '&' + o.query : ''), touch: o.touch, at: o.at, scale: o.scale });
}

const cj = (page) => page.evaluate(() => window.HUB_CONJ.state());
const engaged = (page) => page.evaluate(() => window.HUB_TEST.engaged());
const opened = (page) => page.evaluate(() => window.HUB_TEST.open());
const tileText = (page, sel) => page.evaluate((s) => document.querySelector(s).textContent, sel || SEL);
const focused = (page) => page.evaluate(() => { const f = document.querySelector('#panel .panel-body .is-focused'); return f ? (f.getAttribute('data-key') || f.className) : ''; });

// What a reader would miss: text cut by an ellipsis or overflow, a line
// height under 1.25, or text outside the box.
function clipped(sel) {
  const root = document.querySelector(sel);
  const out = [];
  const rr = root.getBoundingClientRect();
  root.querySelectorAll('*').forEach((el) => {
    let txt = '';
    for (const n of el.childNodes) if (n.nodeType === 3) txt += n.textContent;
    txt = txt.trim();
    if (!txt) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || cs.visibility === 'hidden' || cs.display === 'none') return;
    // The hub's own engage hint ends in "..." by design (app/style.css), as for Flashcards.
    if (el.classList.contains('tile-engage-hint')) return;
    // A verb scrolled out of the list's box is hidden, not clipped.
    const list = el.closest('.cj-list');
    if (list) { const lr = list.getBoundingClientRect(); if (r.bottom <= lr.top + 1 || r.top >= lr.bottom - 1) return; }
    const fs = parseFloat(cs.fontSize);
    if (cs.lineHeight !== 'normal' && parseFloat(cs.lineHeight) / fs < 1.245) out.push('line height: ' + txt.slice(0, 20));
    if (el.scrollWidth > el.clientWidth + 1 && (cs.overflow === 'hidden' || cs.overflowX === 'hidden')) out.push('cut: ' + txt.slice(0, 24));
    if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.bottom > rr.bottom + 1 || r.top < rr.top - 1) out.push('outside: ' + txt.slice(0, 20));
  });
  return out;
}

async function shot(page, name, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  if (sel === 'screen') { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); return; }
  const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 16), width: r.width + 32, height: r.height + 32 }; }, sel || SEL);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), clip: box });
}

async function holdOk(page) {
  await page.keyboard.down('Enter');
  await H.sleep(800);
  await page.keyboard.up('Enter');
}

async function main() {
  await check('wiring: verbs before the widget in hub.html and touch.html; the Spanish layout; ES5; Spanish for every label; CSS rules', () => {
    for (const f of ['hub.html', 'touch.html']) {
      const html = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
      const a = html.indexOf('src="spanish-verbs.js"');
      const b = html.indexOf('src="widgets/conjugate.js"');
      assert(a > 0 && b > a && html.indexOf('widgets/conjugate.css') > 0, f);
    }
    const touch = fs.readFileSync(path.join(ROOT, 'app', 'touch.html'), 'utf8');
    assert(touch.indexOf('src="widgets/wotd.js"') > 0, 'touch.html: Word of the day for today\'s verb');
    const box = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
    const lay = box.c.layouts.filter((l) => l.id === 'spanish')[0];
    assert(lay && lay.layout.some((e) => e.widget === 'conjugate' && e.w === 3 && e.h === 4), 'Spanish layout');
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    for (const f of ['widgets/conjugate.js', 'spanish-verbs.js', 'widgets/wotd.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
      if (acorn) acorn.parse(src, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), f + ': ES2015 syntax');
    }
    const i18n = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
    const keys = {};
    let m;
    for (const f of ['widgets/conjugate.js', 'widgets/wotd.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
      const re = /T\('((?:conj|wotd)\.[\w.]+)'/g;
      while ((m = re.exec(src))) if (!/\.$/.test(m[1])) keys[m[1]] = 1;
    }
    ['pres', 'pret', 'imp', 'fut', 'cond', 'perf', 'subj', 'impv'].forEach((k) => { keys['conj.use.' + k] = 1; });
    const missing = Object.keys(keys).filter((k) => i18n.indexOf("'" + k + "':") < 0);
    assert(Object.keys(keys).length >= 25 && !missing.length, 'no Spanish: ' + missing.join(', '));
    for (const f of ['conjugate.css', 'wotd.css']) {
      const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', f), 'utf8');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), f + ': css-end');
      assert(!/\bgap\s*:|display:\s*grid/.test(css), f + ': no gap or grid');
    }
  });

  await check('the data: every Flashcards and Word of the day verb, eight tenses, irregular marks; the search', () => {
    const w = loadApp(['wotd-data.js', 'widgets/wotd.js', 'spanish-cards.js', 'spanish-verbs.js', 'widgets/conjugate.js']);
    const C = w.HUB_CONJ;
    const V = w.HUB_SPANISH_VERBS;
    assert(V.tenses.join() === 'pres,pret,imp,fut,cond,perf,subj,impv', V.tenses.join());
    w.HUB_SPANISH_CARDS.verbs.forEach((v) => assert(C.find(v[0]), 'no ' + v[0]));
    w.HUB_WOTD_DATA.filter((x) => x.pos === 'verb').forEach((x) => assert(C.find(x.es), 'no ' + x.es));
    const tener = C.find('tener');
    assert(tener.forms[1][0] === 'tuve' && (tener.irr[1] & 1), 'tener pretérito');
    assert(C.find('hablar').irr.every((x) => x === 0), 'hablar is regular');
    assert(C.find('buscar').irr[1] === 1, 'busqué is a spelling change: ' + C.find('buscar').irr[1]);
    assert(C.find('ir').forms[7][0] === null, 'no yo in the imperative');
    let r = C.search('tuve');
    assert(r[0].v.inf === 'tener' && r[0].hit.t === 1 && r[0].hit.p === 0, JSON.stringify(r[0]));
    r = C.search('to have');
    assert(r[0].v.inf === 'tener', r.map((x) => x.v.inf).join());
    r = C.search('HAB');
    assert(r[0].v.inf === 'hablar' && !r[0].hit, 'start');
    r = C.search('levanto');
    assert(r[0].v.inf === 'levantarse', 'reflexive form');
    r = C.search('oir');
    assert(r[0].v.inf === 'oír', 'accents off');
    assert(C.search('zzz').length === 0, 'nothing');
  });

  const verbDay = dayWhere(true);
  const otherDay = dayWhere(false);
  const env = await H.start({ at: verbDay.at, snapshot: false, calendars: false });
  try {
    let page = await open(env, { at: verbDay.at });

    await check('the tile: today\'s word when it is a verb, its presente, not engaged', async () => {
      const s = await cj(page);
      assert(s.verb === verbDay.word && s.tense === 'pres', JSON.stringify(s) + ' want ' + verbDay.word);
      const t = await tileText(page);
      assert(t.indexOf(verbDay.word) >= 0 && /Today’s word/.test(t) && /Presente/.test(t) && /nosotros/.test(t), t);
      await H.focusTile(page, 'conjugate');
      const foot = await page.evaluate((s2) => getComputedStyle(document.querySelector(s2 + ' .cj-foot')).visibility, SEL);
      assert(foot === 'visible', 'OK to browse hidden');
      const bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, bad.join(' | '));
      await shot(page, 'tile-en');
    });

    await check('engage: Right and Left change the tense, OK the verb, Back leaves', async () => {
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      assert(!(await opened(page)), 'a panel opened');
      await H.key(page, 'ArrowRight');
      let s = await cj(page);
      assert(s.tense === 'pret', s.tense);
      await H.sleep(250);
      assert(/Pretérito/.test(await tileText(page)), 'tile tense');
      await shot(page, 'tile-engaged-en');
      await H.key(page, 'ArrowLeft');
      await H.key(page, 'ArrowLeft');
      s = await cj(page);
      assert(s.tense === 'impv', 'wraps: ' + s.tense);
      await H.key(page, 'Enter');
      s = await cj(page);
      assert(s.verb !== verbDay.word, 'next verb');
      await H.key(page, 'Escape');
      assert(!(await engaged(page)) && !(await opened(page)), 'Back');
    });

    await check('the page: hold OK opens full screen on the verb shown; a letter lists its verbs; a verb shows its table', async () => {
      const before = (await cj(page)).verb;
      await holdOk(page);
      await H.until(async () => (await opened(page)) === 'conjugate', 3000, 'not opened');
      await H.idle(page);
      assert(await page.evaluate(() => window.HUB_TEST.mode() === 'full'), 'not full screen');
      assert((await focused(page)) === 'v-' + before, 'focus ' + (await focused(page)));
      const n = await page.evaluate(() => document.querySelectorAll('#panel .cj-table .cj-tname').length);
      assert(n === 8, n + ' tenses');
      // Up to the letters, then to the letter T.
      for (let i = 0; i < 20 && !/^l-/.test(await focused(page)); i++) await H.key(page, 'ArrowUp');
      for (let i = 0; i < 30 && (await focused(page)) !== 'l-t'; i++) {
        const f = await focused(page);
        const want = await page.evaluate((cur) => {
          const ls = Array.prototype.map.call(document.querySelectorAll('#panel .cj-let'), (x) => x.getAttribute('data-letter'));
          return ls.indexOf('t') > ls.indexOf(cur.slice(2)) ? 'ArrowRight' : 'ArrowLeft';
        }, f);
        await H.key(page, want);
      }
      assert((await focused(page)) === 'l-t', 'letter t: ' + (await focused(page)));
      const list = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .cj-item'), (x) => x.getAttribute('data-verb')));
      assert(list.length > 3 && list.every((v) => v.charAt(0) === 't') && list.indexOf('tener') >= 0, list.join());
      await H.key(page, 'Enter');
      assert(/^v-t/.test(await focused(page)), 'OK goes to the first verb');
      for (let i = 0; i < 12 && (await focused(page)) !== 'v-tener'; i++) await H.key(page, 'ArrowDown');
      assert((await cj(page)).verb === 'tener', 'table follows focus');
      const forms = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .cj-f.is-irr'), (x) => x.textContent));
      assert(forms.indexOf('tuve') >= 0 && forms.indexOf('tengo') >= 0, 'irregular marks: ' + forms.join());
      const bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, bad.join(' | '));
      await shot(page, 'page-en', 'screen');
    });

    await check('the page: typing "tuve" lists tener, Enter shows it with the form ringed', async () => {
      for (let i = 0; i < 20 && (await focused(page)) !== 'q'; i++) await H.key(page, 'ArrowUp');
      assert((await focused(page)) === 'q', 'search box');
      await H.key(page, 'Enter');
      await page.keyboard.type('tuve');
      await H.sleep(150);
      const first = await page.evaluate(() => { const r = document.querySelector('#panel .cj-item'); return r && r.textContent; });
      assert(/tuve → tener/.test(first) && /pretérito · yo/.test(first), first);
      await H.key(page, 'Enter');
      await H.sleep(150);
      assert(/^v-tener-1-0/.test(await focused(page)), 'focus ' + (await focused(page)));
      const hit = await page.evaluate(() => { const h = document.querySelector('#panel .cj-f .is-hit'); return h && h.textContent; });
      assert(hit === 'tuve', 'ringed ' + hit);
      await shot(page, 'page-search-en', 'screen');
      // Up from the first result reaches the box and Down comes back: the letters never clear the search.
      await H.key(page, 'ArrowUp');
      assert((await focused(page)) === 'q', 'Up to the box: ' + (await focused(page)));
      await H.key(page, 'ArrowDown');
      assert(/^v-tener-1-0/.test(await focused(page)) && (await cj(page)).query === 'tuve', 'Down to the results: ' + (await focused(page)));
      // The hub ignores Back for 300 ms after typing stops; the page's clock is fixed, so move it on.
      await page.clock.setFixedTime(new Date(verbDay.at + 1000));
      await H.key(page, 'Escape');
      await H.idle(page);
      assert(!(await opened(page)), 'Back closes');
      assert(/tener/.test(await tileText(page)), 'the tile follows the page');
    });

    await check('Word of the day: a verb\'s page has Word and Conjugation tabs; Right shows the table', async () => {
      await H.openPanel(page, 'wotd');
      const tabs = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#panel .wotd-tab'), (x) => x.textContent));
      assert(tabs.join() === 'Word,Conjugation', tabs.join());
      assert(await page.evaluate(() => !!document.querySelector('#panel .wotd-panel .wotd-es')), 'word first');
      await shot(page, 'wotd-word-en', '#panel');
      await H.key(page, 'ArrowRight');
      await H.sleep(200);
      assert((await focused(page)) === 'tab-conj', 'focus ' + (await focused(page)));
      const t = await page.evaluate(() => document.querySelector('#panel .panel-body').textContent);
      assert(t.indexOf(verbDay.word) >= 0 && /Presente/.test(t) && /Imperativo/.test(t), t.slice(0, 200));
      let bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, bad.join(' | '));
      await shot(page, 'wotd-conj-en', '#panel');
      await H.fullScreen(page);
      bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, 'full: ' + bad.join(' | '));
      await shot(page, 'wotd-conj-full-en', 'screen');
      await H.key(page, 'Escape');
      await H.idle(page);
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('Spanish: tile, page and the tab; also 25% longer; nothing clipped', async () => {
      await page.close();
      page = await open(env, { at: verbDay.at, lang: 'es' });
      let bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, bad.join(' | '));
      assert(/Palabra del día/.test(await tileText(page)), 'Spanish tile');
      await shot(page, 'tile-es');
      await H.openPanel(page, 'wotd');
      await H.key(page, 'ArrowRight');
      await H.sleep(200);
      bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, 'tab: ' + bad.join(' | '));
      await shot(page, 'wotd-conj-es', '#panel');
      await H.key(page, 'Escape');
      await H.idle(page);
      await H.focusTile(page, 'conjugate');
      await holdOk(page);
      await H.until(async () => (await opened(page)) === 'conjugate', 3000, 'not opened');
      await H.idle(page);
      bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, 'page: ' + bad.join(' | '));
      await shot(page, 'page-es', 'screen');
      await H.key(page, 'Escape');
      await H.idle(page);
      await page.evaluate(() => {
        const L = window.HUB_I18N;
        const t = L.t;
        L.t = function (k, en, vars) { const s = String(t.call(L, k, en, vars)); return /^(conj|wotd\.tab|hub)\./.test(k) ? s + ' ' + 'ÁÉñ¿¡áé'.repeat(4).slice(0, Math.ceil(s.length / 4)) : s; };
      });
      await page.evaluate(() => window.HUB_I18N.setLang('en'));
      await page.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(200);
      bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, '+25% tile: ' + bad.join(' | '));
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      await H.sleep(300);
      bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, '+25% engaged: ' + bad.join(' | '));
      await H.key(page, 'Escape');
      await holdOk(page);
      await H.until(async () => (await opened(page)) === 'conjugate', 3000, 'not opened');
      await H.idle(page);
      bad = await page.evaluate(clipped, '#panel');
      assert(!bad.length, '+25% page: ' + bad.join(' | '));
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('motion: only transform and opacity animate', async () => {
      const props = await page.evaluate(() => {
        const out = [];
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          for (const r of rules) {
            const txt = r.cssText || '';
            if (!/cj-|wotd-tab/.test(txt)) continue;
            const m = /transition(?:-property)?:\s*([^;]+)/.exec(txt);
            if (m) m[1].split(',').forEach((p) => out.push(p.trim().split(' ')[0]));
            if (r.type === 7 && /cj-in/.test(r.name)) for (const k of r.cssRules) k.style && Array.prototype.forEach.call(k.style, (p) => out.push(p));
          }
        }
        return out;
      });
      const bad = props.filter((p) => !/^(opacity|transform|-webkit-transform|none)$/.test(p));
      assert(!bad.length, bad.join());
    });

    await check('another day: a word that is not a verb has no tabs; the tile shows a Flashcards verb', async () => {
      await page.close();
      page = await open(env, { at: otherDay.at });
      const s = await cj(page);
      const w = loadApp(['spanish-cards.js']);
      assert(w.HUB_SPANISH_CARDS.verbs.some((v) => v[0] === s.verb), 'a Flashcards verb: ' + s.verb);
      assert(!/Today’s word/.test(await tileText(page)), 'not today\'s word');
      await H.openPanel(page, 'wotd');
      assert(await page.evaluate(() => !document.querySelector('#panel .wotd-tab') && !!document.querySelector('#panel .wotd-panel')), 'tabs on a non-verb');
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('strip and narrow tiles: one line, or the verb; OK opens the page', async () => {
      await page.close();
      page = await open(env, { at: verbDay.at, layout: [
        { widget: 'conjugate', x: 0, y: 0, w: 6, h: 1 },
        { widget: 'weather', x: 6, y: 0, w: 6, h: 1 },
        { widget: 'todo', x: 0, y: 1, w: 10, h: 5 },
        { widget: 'wotd', x: 10, y: 1, w: 2, h: 5 }
      ] });
      const t = await tileText(page);
      assert(t.indexOf(verbDay.word) >= 0 && /,/.test(t), t);
      await H.focusTile(page, 'conjugate');
      await H.key(page, 'Enter');
      await H.until(async () => (await opened(page)) === 'conjugate', 3000, 'strip did not open');
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('tablet mode: the arrows change the tense by tap; a tap on the page picks a letter and a verb', async () => {
      await page.close();
      page = await open(env, { at: verbDay.at, query: 'as=tablet', touch: true });
      await H.sleep(300);
      await page.tap(SEL + ' .cj-next');
      assert((await cj(page)).tense === 'pret', 'tense by tap');
      assert(!(await opened(page)), 'the tap opened the page');
      await page.tap(SEL + ' .cj-forms');
      await H.until(async () => (await opened(page)) === 'conjugate', 3000, 'not opened');
      await H.idle(page);
      await page.tap('#panel .cj-let[data-letter="v"]');
      await H.sleep(100);
      await page.tap('#panel .cj-item[data-verb="vivir"]');
      await H.sleep(100);
      assert((await cj(page)).verb === 'vivir', 'tap a verb');
      await shot(page, 'tablet-page-en', 'screen');
    });
  } finally {
    await env.stop();
  }

  await check('the phone: letters, verbs and typing', async () => {
    const { chromium } = require('playwright');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-conj-'));
    const hub = hubServer.start({ port: 0, token: 'conj-test-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app') });
    await hub.ready;
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('http://127.0.0.1:' + hub.port + '/app/touch.html#/conjugate');
      await page.waitForSelector('.cj-touch .cj-table', { timeout: 8000 });
      await page.tap('.cj-touch .cj-let[data-letter="d"]');
      await page.tap('.cj-touch .cj-item[data-verb="dormir"]');
      assert(await page.evaluate(() => window.HUB_CONJ.state().verb === 'dormir'), 'tap a verb');
      await page.fill('.cj-touch .cj-q', 'fueron');
      await H.sleep(100);
      const first = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.cj-touch .cj-item'), (x) => x.getAttribute('data-verb')).join());
      assert(/^ir,ser|^ser,ir|ir.*ser|ser.*ir/.test(first), first);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-en.png'), fullPage: true });
      assert(!errs.length, errs.join(' | '));
    } finally {
      await browser.close();
      await hub.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
