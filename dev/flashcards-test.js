/*
 * Flashcards and "engage on OK": node dev/flashcards-test.js
 *
 * Runs the real hub in headless Chromium against the preview and the real
 * hub server from pi/ (dev/awws-harness.js), at the real time (no fixed day
 * or zone: the Pi's day and the page's are whatever today is). Checks:
 *   - wiring: hub.html and touch.html load the math and the deck before the
 *     widget, the Spanish layout in config.js, the deck file, ES5, and a
 *     Spanish string for every English one;
 *   - the deck and the queue (app/flash-math.js): 1,400 cards, 10 new a day,
 *     due cards first, a missed card back the same day;
 *   - engage on OK: a short OK on the 3x2 tile engages it (ring class, the
 *     hint shows, no panel); OK flips; Right = Got it and Left = Again reach
 *     the Pi; a held Right counts once; Back leaves; Up leaves and moves on;
 *     another tile's OK still opens its panel at once;
 *   - a long press opens the page, engaged or not, by a late keyup and by
 *     a key repeat when no keyup was ever seen; a remote with neither keyup
 *     nor repeat gets a short press after a second;
 *   - a strip and a narrow tile never engage (OK opens the page);
 *   - the page: Left, OK, Right answer and flip; the sentence on the back;
 *     Up reaches the Full screen button; a finished round offers Ten more;
 *   - tablet mode: taps on the card and the buttons, the tile never opens;
 *   - the phone (app/touch.html): tap to flip, Got it reaches the Pi;
 *   - Spanish and Spanish 25% longer: tile, hint and page, nothing clipped;
 *   - motion: only transform and opacity animate.
 * FLASH_SHOTS=dir/ (or --shots dir) keeps the before/after pictures.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');
const hubServer = require('../pi/server');

const ROOT = path.join(__dirname, '..');
const SEL = '.cell[data-widget="flashcards"] .tile';
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.FLASH_SHOTS || '');

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

const LAYOUT = [
  { widget: 'wotd', x: 0, y: 0, w: 3, h: 2 },
  { widget: 'flashcards', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 6, y: 0, w: 3, h: 2 },
  { widget: 'todo', x: 0, y: 2, w: 9, h: 4 }
];

function open(env, o) {
  o = o || {};
  return env.newPage({ layout: o.layout || LAYOUT, lang: o.lang, query: 'theme=night' + (o.query ? '&' + o.query : ''), touch: o.touch, at: Date.now(), scale: o.scale, config: o.config });
}

const fc = (page) => page.evaluate(() => window.HUB_FLASHCARDS_TEST.state());
const engaged = (page) => page.evaluate(() => window.HUB_TEST.engaged());
const opened = (page) => page.evaluate(() => window.HUB_TEST.open());
const tileText = (page) => page.evaluate((s) => document.querySelector(s).textContent, SEL);

async function progress(env) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    http.get(env.LIVE + '/spanish/progress', (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// What a reader would miss: type cut without an ellipsis, a line height under
// 1.25, or text outside the tile.
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
    if (!r.width || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
    if (el.closest('.fc-face') && parseFloat(getComputedStyle(el.closest('.fc-face')).opacity) === 0) return;
    const fs = parseFloat(cs.fontSize);
    if (cs.lineHeight !== 'normal' && parseFloat(cs.lineHeight) / fs < 1.245) out.push('line height: ' + txt.slice(0, 20));
    const ell = cs.textOverflow === 'ellipsis';
    if (!ell && (el.scrollWidth > el.clientWidth + 1) && cs.overflow === 'hidden') out.push('cut: ' + txt.slice(0, 20));
    if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.bottom > rr.bottom + 1 || r.top < rr.top - 1) out.push('outside the tile: ' + txt.slice(0, 20));
  });
  return out;
}

async function shot(page, name, sel) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left - 16, y: r.top - 16, width: r.width + 32, height: r.height + 32 }; }, sel || SEL);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), clip: box });
}

async function main() {
  await check('wiring: hub.html and touch.html load math and deck before the widget; the Spanish layout; ES5; Spanish for every label', () => {
    for (const f of ['hub.html', 'touch.html']) {
      const html = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
      const a = html.indexOf('src="flash-math.js"');
      const b = html.indexOf('src="spanish-cards.js"');
      const c = html.indexOf('src="widgets/flashcards.js"');
      assert(a > 0 && b > a && c > b && html.indexOf('widgets/flashcards.css') > 0, f);
    }
    const box = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
    const lay = box.c.layouts.filter((l) => l.id === 'spanish')[0];
    assert(lay && lay.layout.some((e) => e.widget === 'flashcards' && e.w === 3 && e.h === 2), 'Spanish layout');
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    for (const f of ['widgets/flashcards.js', 'flash-math.js', 'spanish-cards.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
      if (acorn) acorn.parse(src, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), f + ': ES2015 syntax');
    }
    const src = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'flashcards.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
    const keys = {};
    let m;
    const re = /T\('(flash\.\w+)'/g;
    while ((m = re.exec(src))) keys[m[1]] = 1;
    const missing = Object.keys(keys).filter((k) => i18n.indexOf("'" + k + "':") < 0);
    assert(Object.keys(keys).length >= 15 && !missing.length, 'no Spanish: ' + missing.join(', '));
    assert(i18n.indexOf("'hub.engageHint':") > 0, 'hub.engageHint');
    const css = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'flashcards.css'), 'utf8');
    assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'css-end');
    assert(!/\bgap\s*:|display:\s*grid/.test(css), 'no gap or grid');
  });

  await check('the deck and the queue: 1,400 cards, 10 new a day, due first, a miss back today', () => {
    const F = require('../app/flash-math');
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'spanish-cards.js'), 'utf8'), box);
    const list = F.cards(box.window.HUB_SPANISH_CARDS);
    assert(list.length === 1400, list.length + ' cards');
    assert(list.every((c) => F.ID_RE.test(c.id) && c.form && c.verb && c.en), 'every card complete');
    assert(list[0].id === 'ser.pres.0' && list[0].form === 'soy', JSON.stringify(list[0]));
    const today = F.dayOf(new Date());
    let q = F.queue(list, {}, today);
    assert(q.length === 10 && q[0] === 'ser.pres.0', 'new: ' + q.join());
    const p = { 'tener.pret.1': [2, F.addDays(today, -1), 0], 'ir.fut.2': [1, today, 0], 'ser.pres.0': [3, F.addDays(today, 5), 0] };
    q = F.queue(list, p, today, { intro: 4 });
    assert(q[0] === 'tener.pret.1' && q[1] === 'ir.fut.2' && q.length === 8 && q.indexOf('ser.pres.0') < 0, q.join());
    assert(F.apply([3, today, 0], 'again', today)[1] === today, 'a miss is due today');
  });

  const env = await H.start({ at: Date.now(), snapshot: false, calendars: false });
  try {
    let page = await open(env);

    await check('the tile: the first new card, its cue, Again and Got it; not engaged', async () => {
      const t = await tileText(page);
      assert(/1\/10/.test(t) && /ser/.test(t) && /yo · presente/.test(t) && /Again/.test(t) && /Got it/.test(t), t);
      assert(!(await engaged(page)), 'engaged at start');
      await H.focusTile(page, 'flashcards');
      const foot = await page.evaluate((s) => getComputedStyle(document.querySelector(s + ' .fc-foot')).visibility, SEL);
      assert(foot === 'visible', 'OK to start hidden: ' + foot);
      await shot(page, 'before-not-engaged-en');
    });

    await check('a short OK engages the tile (ring, hint, no panel); OK flips; Right and Left answer and reach the Pi', async () => {
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      await H.sleep(250);
      assert(!(await opened(page)), 'a panel opened');
      const look = await page.evaluate((s) => {
        const t = document.querySelector(s);
        const h = t.querySelector('.tile-engage-hint');
        return { cls: t.classList.contains('is-engaged'), body: document.body.classList.contains('hub-engaged'), hint: h && h.textContent, op: h && getComputedStyle(h).opacity,
          border: getComputedStyle(t).borderTopColor, foot: getComputedStyle(t.querySelector('.fc-foot')).visibility };
      }, SEL);
      assert(look.cls && look.body && /Hold OK: open/.test(look.hint) && look.op === '1' && look.foot === 'hidden', JSON.stringify(look));
      await shot(page, 'after-engaged-en');
      await H.key(page, 'Enter');
      await H.until(async () => (await fc(page)).flipped, 2000, 'did not flip');
      await H.sleep(250);
      assert(/soy/.test(await tileText(page)), 'the back');
      await shot(page, 'after-engaged-flipped-en');
      await H.key(page, 'ArrowRight');
      let s = await fc(page);
      assert(s.pos === 1 && !s.flipped && s.card.id === 'ser.pres.1', JSON.stringify(s));
      await H.key(page, 'ArrowLeft');
      s = await fc(page);
      assert(s.pos === 2 && s.queue.indexOf('ser.pres.1', 2) > 0, 'missed card back in the round: ' + s.queue.join());
      await H.until(async () => { const p = await progress(env); return p.cards['ser.pres.0'] && p.cards['ser.pres.1']; }, 4000, 'the Pi did not get the answers');
      const p = await progress(env);
      assert(p.cards['ser.pres.0'][0] === 1 && p.cards['ser.pres.1'][0] === 0 && p.cards['ser.pres.1'][2] === 1, JSON.stringify(p.cards));
      assert(await engaged(page), 'still engaged');
    });

    await check('a held Right counts once', async () => {
      const before = (await fc(page)).pos;
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.up('ArrowRight');
      await H.sleep(100);
      assert((await fc(page)).pos === before + 1, 'pos ' + (await fc(page)).pos);
    });

    await check('Back leaves (no panel); Up leaves and moves on', async () => {
      await H.key(page, 'Escape');
      assert(!(await engaged(page)) && !(await opened(page)), 'Back');
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged again');
      await H.key(page, 'ArrowDown');
      assert(!(await engaged(page)), 'still engaged after Down');
      const f = await page.evaluate(() => document.querySelector('#grid .tile.is-focused').parentNode.getAttribute('data-widget'));
      assert(f === 'todo', 'focus on ' + f);
      assert(!(await page.evaluate((s) => document.querySelector(s).classList.contains('is-engaged'), SEL)), 'ring class left behind');
    });

    await check('another tile keeps OK = open, at once', async () => {
      await H.focusTile(page, 'wotd');
      await H.key(page, 'Enter');
      await H.until(async () => (await opened(page)) === 'wotd', 3000, 'wotd did not open');
      await H.idle(page);
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('a long press opens the page, not engaged and engaged (late keyup)', async () => {
      await H.focusTile(page, 'flashcards');
      await page.keyboard.down('Enter');
      await H.sleep(800);
      await page.keyboard.up('Enter');
      await H.until(async () => (await opened(page)) === 'flashcards', 3000, 'not opened');
      assert(!(await engaged(page)), 'engaged');
      await H.idle(page);
      await H.key(page, 'Escape');
      await H.idle(page);
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      await page.keyboard.down('Enter');
      await H.sleep(800);
      await page.keyboard.up('Enter');
      await H.until(async () => (await opened(page)) === 'flashcards', 3000, 'not opened when engaged');
      assert(!(await engaged(page)), 'still engaged under the panel');
      await H.idle(page);
    });

    await check('the page: Left again, OK flips, Right got it; the sentence; Up reaches Full screen', async () => {
      let s = await fc(page);
      const at = s.pos;
      await H.key(page, 'Enter');
      await H.until(async () => (await fc(page)).flipped, 2000, 'no flip');
      await H.sleep(250);
      await shot(page, 'page-flipped-en', '#panel');
      await H.key(page, 'ArrowRight');
      s = await fc(page);
      assert(s.pos === at + 1 && !s.flipped, JSON.stringify(s));
      await H.key(page, 'ArrowLeft');
      assert((await fc(page)).pos === at + 2, 'Left');
      const pageText = await page.evaluate(() => document.querySelector('#panel .panel-body').textContent);
      assert(/Again/.test(pageText) && /Flip/.test(pageText) && /Got it/.test(pageText), pageText);
      await H.key(page, 'ArrowUp');
      const onBtn = await page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f && !document.querySelector('#panel .panel-body').contains(f); });
      assert(onBtn, 'Up did not reach the Full screen button');
      await H.key(page, 'Escape');
      await H.idle(page);
    });

    await check('a finished round: Done for now, then OK engaged gives Ten more', async () => {
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      for (let i = 0; i < 20 && (await fc(page)).st === 'card'; i++) await H.key(page, 'ArrowRight');
      const s = await fc(page);
      assert(s.st === 'done', JSON.stringify(s));
      assert(/Done for now/.test(await tileText(page)) && /Ten more/.test(await tileText(page)), await tileText(page));
      await H.key(page, 'Enter');
      await H.until(async () => (await fc(page)).st === 'card', 3000, 'no new round');
      assert((await fc(page)).queue.length === 10, 'ten more');
      await H.key(page, 'Escape');
    });

    await check('Spanish: tile, hint and page, also 25% longer; nothing clipped', async () => {
      await page.close();
      page = await open(env, { lang: 'es' });
      await H.focusTile(page, 'flashcards');
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged');
      // Today's new cards are used up by now: Ten more, as Ian would.
      if ((await fc(page)).st !== 'card') await H.key(page, 'Enter');
      await H.until(async () => (await fc(page)).st === 'card', 2000, 'no cards');
      await H.sleep(300);
      let t = await tileText(page);
      assert(/\d+\/\d+/.test(t) && /Otra vez/.test(t) && /Me la sé/.test(t) && /Mantén OK/.test(t), t);
      let bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, bad.join(' | '));
      await shot(page, 'after-engaged-es');
      await H.key(page, 'Escape');
      await shot(page, 'before-not-engaged-es');
      // 25% longer, with accents.
      await page.evaluate(() => {
        const L = window.HUB_I18N;
        const t = L.t;
        L.t = function (k, en, vars) { const s = String(t.call(L, k, en, vars)); return /^(flash|hub)\./.test(k) ? s + ' ' + 'ÁÉñ¿¡áé'.repeat(4).slice(0, Math.ceil(s.length / 4)) : s; };
      });
      await page.evaluate(() => window.HUB_I18N.setLang('en'));
      await page.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(200);
      await H.key(page, 'Enter');
      await H.until(() => engaged(page), 2000, 'not engaged (long)');
      await H.sleep(300);
      bad = await page.evaluate(clipped, SEL);
      assert(!bad.length, '+25%: ' + bad.join(' | '));
    });

    await check('motion: only transform and opacity animate', async () => {
      const props = await page.evaluate(() => {
        const out = [];
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          for (const r of rules) {
            const txt = r.cssText || '';
            if (!/fc-|tile-engage-hint/.test(txt)) continue;
            const m = /transition(?:-property)?:\s*([^;]+)/.exec(txt);
            if (m) m[1].split(',').forEach((p) => out.push(p.trim().split(' ')[0]));
            if (r.type === 7 && /fc-in/.test(r.name)) for (const k of r.cssRules) k.style && Array.prototype.forEach.call(k.style, (p) => out.push(p));
          }
        }
        return out;
      });
      const bad = props.filter((p) => !/^(opacity|transform|-webkit-transform|none)$/.test(p));
      assert(props.length && !bad.length, props.join(','));
    });

    await check('a strip and a narrow tile never engage: OK opens the page', async () => {
      for (const sz of [[3, 1], [2, 2]]) {
        await page.close();
        page = await open(env, { layout: [{ widget: 'flashcards', x: 0, y: 0, w: sz[0], h: sz[1] }, { widget: 'todo', x: 3, y: 2, w: 3, h: 4 }] });
        await H.focusTile(page, 'flashcards');
        await H.key(page, 'Enter');
        await H.until(async () => (await opened(page)) === 'flashcards', 3000, sz.join('x') + ' did not open');
        assert(!(await engaged(page)), sz.join('x') + ' engaged');
        const bad = await page.evaluate(clipped, SEL);
        assert(!bad.length, sz.join('x') + ': ' + bad.join(' | '));
      }
    });

    await check('a remote with no keyup: a held OK (key repeat) opens the page; a lone keydown is short after a second', async () => {
      await page.close();
      page = await open(env);
      await page.addInitScript(() => {});
      // Swallow every keyup, as a remote that never sends one.
      await page.evaluate(() => document.addEventListener('keyup', (e) => e.stopImmediatePropagation(), true));
      await H.focusTile(page, 'flashcards');
      await page.keyboard.down('Enter');
      await H.sleep(1300);
      assert(await engaged(page), 'a lone keydown did not engage after a second');
      assert(!(await opened(page)), 'opened');
      await page.keyboard.up('Enter');
      await page.keyboard.down('Enter');
      await H.sleep(150);
      await page.keyboard.down('Enter');   // the repeat
      await H.until(async () => (await opened(page)) === 'flashcards', 3000, 'a repeat did not open it');
      await page.keyboard.up('Enter');
    });

    await check('tablet mode: tap the card to flip, tap Got it; the tile never opens', async () => {
      await page.close();
      page = await open(env, { query: 'as=tablet', touch: true });
      if ((await fc(page)).st !== 'card') await page.click(SEL + ' .fc-more');
      await H.until(async () => (await fc(page)).st === 'card', 2000, 'no cards');
      const pos = (await fc(page)).pos;
      await page.click(SEL + ' .fc-card');
      await H.until(async () => (await fc(page)).flipped, 2000, 'tap did not flip');
      await page.click(SEL + ' .fc-got');
      await H.sleep(200);
      assert((await fc(page)).pos === pos + 1, 'Got it');
      assert(!(await opened(page)), 'the tile opened');
      const t = await tileText(page);
      assert(/Tap the card/.test(t) && !/◀|▶/.test(t), 'tablet words: ' + t);
      await shot(page, 'tablet-en');
    });
  } finally {
    await env.stop();
  }

  await check('the phone: tap to flip, Got it reaches the Pi', async () => {
    const { chromium } = require('playwright');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-flash-'));
    const hub = hubServer.start({ port: 0, token: 'flash-test-token-0123456789abcdef', log: false, dataDir: dataDir, appDir: path.join(ROOT, 'app') });
    await hub.ready;
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('http://127.0.0.1:' + hub.port + '/app/touch.html#/flashcards');
      await page.waitForSelector('.fc-touch .fc-card', { timeout: 8000 });
      await page.tap('.fc-touch .fc-card');
      await H.until(() => page.evaluate(() => window.HUB_FLASHCARDS_TEST.state().flipped), 2000, 'no flip');
      await page.tap('.fc-touch .fc-got');
      await H.until(() => page.evaluate(() => window.HUB_FLASHCARDS_TEST.state().pending === 0 && window.HUB_FLASHCARDS_TEST.state().pos === 1), 4000, 'not sent');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-en.png') });
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
