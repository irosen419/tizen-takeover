/*
 * The money tiles in the hub's language: node dev/money-i18n-test.js
 *
 * Earned vs spent (awws-money) and the budget tiles (budget-room,
 * budget-card, budget-goals, and the "New charge" banner) follow the Clock
 * page's Language choice through app/i18n.js. Runs the real hub in headless
 * Chromium against the preview and the real hub server from pi/, with the
 * clock fixed at Monday 16 November 2026, 10:40 AM in Chicago (the same
 * harness and samples as dev/money-test.js). Checks:
 *   - Spanish from HUB_I18N (homeHub.lang = es): the titles, the words, the
 *     Spanish month and day names; what the budget app sends (goal names,
 *     transfer labels, goal texts) and the amounts ($1,265) stay as sent;
 *   - every tile at its main sizes in Spanish, and again with every Spanish
 *     money string 25% longer (with Á, É, ñ, ¿ and ¡): never blank, nothing
 *     clipped or cut without an ellipsis, no type under 0.85rem, line height
 *     1.25 or more wherever text is cut (room for accents);
 *   - each panel and its full screen, in Spanish and 25% longer;
 *   - the empty states in Spanish ("Esperando la app de presupuesto",
 *     "Sin sincronizar todavía");
 *   - the banner in Spanish ("Cargo nuevo: <label>");
 *   - a language change (HUB_I18N.setLang) redraws the tiles, their titles
 *     and an open panel, and back to English;
 *   - app/i18n.js is plain ES5 and every money key has a Spanish text.
 *
 * --shots <folder> (or MONEY_I18N_SHOTS) also saves docs/screenshots/
 * money-es-*.png and money-en-*.png (deviceScaleFactor 1).
 *
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure. Nothing reaches the internet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const IDS = ['awws-money', 'budget-room', 'budget-card', 'budget-goals'];
const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 4], [6, 4], [9, 6]];
const SEL = '.cell[data-widget="awws-money"] .tile-body, .cell[data-widget^="budget"] .tile-body';
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const ROW = [
  { widget: 'awws-money', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-room', x: 3, y: 0, w: 3, h: 3 },
  { widget: 'budget-card', x: 6, y: 0, w: 3, h: 3 }, { widget: 'budget-goals', x: 9, y: 0, w: 3, h: 3 },
  { widget: 'awws', x: 0, y: 3, w: 6, h: 3 }, { widget: 'entertainment', x: 6, y: 3, w: 6, h: 3 }
];

let SHOTS = process.env.MONEY_I18N_SHOTS || '';
const at = process.argv.indexOf('--shots');
if (at >= 0) SHOTS = process.argv[at + 1] || path.join(ROOT, 'docs', 'screenshots');

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
          if (!/^(budget|awws)\./.test(k)) return;
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

function tileOf(id) { return '.cell[data-widget="' + id + '"] .tile-body'; }
function titleOf(id) { return '.cell[data-widget="' + id + '"] .tile-title'; }

function open(env, o) {
  const storage = Object.assign({}, SEEN, o.storage || {});
  if (o.lang) storage['homeHub.lang'] = o.lang;
  return env.newPage({ layout: o.layout, storage: storage, config: o.long ? longer : undefined });
}

// Four tiles in a row at one size, for the screenshots.
async function shot(env, lang, w, h) {
  const layout = [];
  for (let i = 0; i < IDS.length; i++) {
    if (w * (i + 1) > 12) break;
    layout.push({ widget: IDS[i], x: w * i, y: 0, w: w, h: h });
  }
  const page = await open(env, { layout: layout, lang: lang });
  try {
    const box = await page.evaluate((n) => {
      let r = null;
      document.querySelectorAll('#grid .cell').forEach((c, i) => {
        if (i >= n) return;
        const b = c.getBoundingClientRect();
        r = r ? { x: Math.min(r.x, b.left), y: Math.min(r.y, b.top), r: Math.max(r.r, b.right), b: Math.max(r.b, b.bottom) } :
          { x: b.left, y: b.top, r: b.right, b: b.bottom };
      });
      return r;
    }, layout.length);
    const pad = 6;
    await page.screenshot({ path: path.join(SHOTS, 'money-' + lang + '-' + w + 'x' + h + '.png'),
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.r - box.x + 2 * pad, height: box.b - box.y + 2 * pad } });
  } finally { await page.ctx.close(); }
}

async function main() {
  await check('app/i18n.js is plain ES5 and every money key it names is a real English key', () => {
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    const src = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
    if (acorn) acorn.parse(src, { ecmaVersion: 5 });
    const ctx = { window: { location: { search: '' } }, document: { documentElement: { setAttribute() {} } }, location: { search: '' } };
    require('vm').runInNewContext(src, ctx);
    const es = ctx.window.HUB_I18N.strings.es;
    const budget = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'budget.js'), 'utf8');
    const awws = fs.readFileSync(path.join(ROOT, 'app', 'widgets', 'awws.js'), 'utf8');
    const bad = [];
    Object.keys(es).forEach((k) => {
      const m = /^(budget|awws)\.(.+)$/.exec(k);
      if (!m) return;
      const last = m[2].split('.').pop();
      const file = m[1] === 'budget' ? budget : awws;
      if (file.indexOf(last + ':') < 0 && file.indexOf('\'' + last + '\':') < 0) bad.push(k);
    });
    assert(!bad.length, 'no such English key: ' + bad.join(', '));
  });

  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));

    await check('Spanish: titles, words, month and day names from HUB_I18N; data and amounts as sent', async () => {
      const page = await open(env, { layout: ROW, lang: 'es' });
      try {
        const titles = await text(page, IDS.map(titleOf).join(', '));
        assert(titles === 'Ganado y gastado | Margen diario | Pago de tarjeta | Metas', 'titles: ' + titles);
        const m = await text(page, tileOf('awws-money'));
        assert(/neto/.test(m) && /−\$575/.test(m) && /\$1,265/.test(m) && /ganado/.test(m) && /gastado/.test(m), 'money: ' + m);
        assert(/Próxima transferencia: 1 dic/.test(m), 'no Spanish date for the next transfer: ' + m);
        const r = await text(page, tileOf('budget-room'));
        assert(/\$42/.test(r) && /de \$60 al día/.test(r) && /quedan 9 días/.test(r), 'room: ' + r);
        const c = await text(page, tileOf('budget-card'));
        assert(/Cubierto/.test(c) && /en 3 días/.test(c) && /From checking/.test(c) && /jue 19 nov|19 nov/.test(c), 'card: ' + c);
        const g = await text(page, tileOf('budget-goals'));
        assert(/Coffee out/.test(g) && /\$62 over/.test(g), 'goals keep what the budget app sent: ' + g);
        const lang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
        assert(lang === 'es', 'html lang: ' + lang);
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    for (const long of [false, true]) {
      const name = long ? 'Spanish 25% longer' : 'Spanish';
      for (const size of SIZES) {
        await check(name + ': every money tile at ' + size[0] + ' x ' + size[1], async () => {
          for (const sheet of pages(IDS, size[0], size[1])) {
            const page = await open(env, { layout: sheet, lang: 'es', long: long });
            try {
              if (long) {
                const grown = await page.evaluate(() => window.HUB_I18N.t('budget.covered', 'Covered'));
                assert(grown.length >= 'Cubierto'.length * 1.25, 'the Spanish did not grow: ' + grown);
              }
              const blank = await blankTiles(page);
              assert(!blank.length, 'blank: ' + blank.join(', '));
              const p = await page.evaluate(inspect, [SEL, 0.85]);
              assert(!p.length, p.slice(0, 6).join('; '));
              noErrors(page);
            } finally { await page.ctx.close(); }
          }
        });
      }
      await check(name + ': each panel and its full screen fit, nothing clipped', async () => {
        const page = await open(env, { layout: ROW, lang: 'es', long: long });
        try {
          for (const id of IDS) {
            await H.openPanel(page, id);
            let p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
            assert(!p.length, id + ' panel: ' + p.slice(0, 5).join('; '));
            // The full name, or its short form when it doesn't fit (data-full holds the name then).
            const full = (sel) => page.evaluate((s) => { const n = document.querySelector(s); return n ? (n.getAttribute('data-full') || n.textContent) : null; }, sel);
            const title = await full('#panel .panel-title');
            assert(title === await full(titleOf(id)), id + ' panel title: ' + title);
            await H.fullScreen(page);
            p = await page.evaluate(inspect, ['#panel .panel-body', 1]);
            assert(!p.length, id + ' full screen: ' + p.slice(0, 5).join('; '));
            if (SHOTS && !long && (id === 'awws-money' || id === 'budget-card')) {
              await page.screenshot({ path: path.join(SHOTS, 'money-es-full-' + id + '.png') });
            }
            await H.key(page, 'Escape');
            await H.idle(page);
            await H.key(page, 'Escape');
            await H.until(() => page.evaluate(() => !window.HUB_TEST.open()), 5000, id + ' did not close');
            await H.idle(page);
          }
          noErrors(page);
        } finally { await page.ctx.close(); }
      });
    }

    await check('Spanish: the banner says "Cargo nuevo: <label>", the label as sent', async () => {
      const page = await open(env, { layout: ROW, lang: 'es', storage: { 'homeHub.budget.seen.v1': '[]' } });
      try {
        const t = await H.until(() => page.evaluate(() => window.HUB_ALERT && window.HUB_ALERT.shown() && window.HUB_ALERT.text()), 5000, 'no banner');
        assert(/^Cargo nuevo: Corner Bakery Stand/.test(t) && !/\$/.test(t), 'banner: ' + t);
        if (SHOTS) {
          await H.sleep(500);
          await page.screenshot({ path: path.join(SHOTS, 'money-es-banner.png'), clip: { x: 0, y: 0, width: 1920, height: 200 } });
        }
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    await check('a language change redraws the tiles, their titles and an open panel, and back', async () => {
      const page = await open(env, { layout: ROW, lang: 'en' });
      try {
        assert(/Covered/.test(await text(page, tileOf('budget-card'))), 'English first');
        await H.openPanel(page, 'budget-room');
        await page.evaluate(() => window.HUB_I18N.setLang('es'));
        await H.sleep(300);
        assert((await text(page, titleOf('budget-card'))) === 'Pago de tarjeta', 'card title: ' + await text(page, titleOf('budget-card')));
        assert((await text(page, titleOf('awws-money'))) === 'Ganado y gastado', 'money title');
        assert(/Cubierto/.test(await text(page, tileOf('budget-card'))), 'card: ' + await text(page, tileOf('budget-card')));
        assert(/neto/.test(await text(page, tileOf('awws-money'))), 'money: ' + await text(page, tileOf('awws-money')));
        assert((await text(page, '#panel .panel-title')) === 'Margen diario', 'panel title: ' + await text(page, '#panel .panel-title'));
        assert(/disponible al día/.test(await text(page, '#panel .panel-body')), 'panel: ' + await text(page, '#panel .panel-body'));
        // The A World Worth Saving Glance stays English for now.
        assert(/Next visit|Now for you|now for you|Progress|Coming up/.test(await text(page, tileOf('awws'))), 'the Glance changed: ' + (await text(page, tileOf('awws'))).slice(0, 120));
        await page.evaluate(() => window.HUB_I18N.setLang('en'));
        await H.sleep(300);
        assert((await text(page, titleOf('budget-card'))) === 'Card day', 'back to English');
        assert(/room a day/.test(await text(page, '#panel .panel-body')), 'panel back: ' + await text(page, '#panel .panel-body'));
        noErrors(page);
      } finally { await page.ctx.close(); }
    });

    if (SHOTS) {
      await check('screenshots: money-en-* and money-es-*', async () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        for (const s of [[3, 1], [3, 2], [3, 4], [6, 2]]) {
          for (const lang of ['en', 'es']) await shot(env, lang, s[0], s[1]);
        }
      });
    }
  } finally {
    await env.stop();
  }

  const empty = await H.start({ snapshot: false });
  try {
    await check('Spanish, nothing sent yet: "Sin sincronizar todavía" and "Esperando la app de presupuesto", nothing clipped', async () => {
      for (const size of [[3, 1], [3, 2], [6, 4]]) {
        for (const long of [false, true]) {
          const page = await open(empty, { layout: pages(IDS, size[0], size[1])[0], lang: 'es', long: long });
          try {
            const all = await text(page, SEL);
            if (!long) assert(/Sin sincronizar todavía/.test(all) && /Esperando la app de presupuesto/.test(all), size.join(' x ') + ': ' + all.slice(0, 200));
            const p = await page.evaluate(inspect, [SEL, 0.85]);
            assert(!p.length, size.join(' x ') + (long ? ' (longer)' : '') + ': ' + p.slice(0, 4).join('; '));
            noErrors(page);
          } finally { await page.ctx.close(); }
        }
      }
    });
  } finally {
    await empty.stop();
  }
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
