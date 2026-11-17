/*
 * Design pass 2, end to end: node dev/headers-test.js
 *
 * Runs the real hub in headless Chromium against the preview and the real
 * hub server from pi/ (dev/awws-harness.js: the clock at Monday 16 November
 * 2026, 10:40 AM in Chicago, the sample calendars, the AWWS snapshot and the
 * budget sample). Needs Playwright and port 8095 free. Checks:
 *
 *   - One header on every titled tile, in the five layouts of the switcher
 *     (Main, AWWS desk, AWWS one screen, AWWS money, Budget) and the stock
 *     one, and at every size class (strips, two rows, three rows; narrow,
 *     3 to 5 columns, wide), in English, in Spanish (app/i18n.js) and in
 *     Spanish with every title and badge 25% longer (with Á, É, ñ, ¿, ¡):
 *     the icon and the title are there; the title is one line, inside the
 *     tile, with no "..." (in 3-column tiles and wider even at +25%: the short
 *     form takes over), line height 1.3 or more and nothing clipped above or
 *     below (scrollHeight against clientHeight); the badge never overlaps the
 *     title. The A World Worth Saving title is the full name or "AWWS",
 *     never half of it.
 *   - Secondary words on the tiles (sub lines, badges, hints, quiet lines)
 *     reach 4.5:1 on the glass, measured on the rendered pixels.
 *   - The opened panel is as tall as its content (within 24 px), at most
 *     26rem; the Back hint is a chip that can't take focus; pushed-aside
 *     tiles show only their icon and title, and get their body back on close.
 *     Budget lab's panel stops at 26rem and scrolls down to its merchants,
 *     and its section heads (Merchants, Put it somewhere, Pace) are one line
 *     each in English, Spanish and Spanish +25%.
 *   - The accent edge (a faint blue border over the tile's whole border):
 *     on a new to-do, a changed snapshot, a changed budget and a calendar
 *     change, and for an event starting within the hour; it goes after its
 *     hold (a short one here, through HUB_FX.edgeHold) and when the tile is
 *     opened; 60 s by default; never on focus; static (no lap, no fades) in
 *     fade mode; none with motionFx.edge off.
 *   - Guest mode (app/guest.js): the money tiles keep the same header (the
 *     same title and short title, in English, Spanish and Spanish +25%)
 *     while their bodies say "Hidden for guests"; turning it on takes the
 *     edge off the money tiles at once and a budget sent then raises none,
 *     while other tiles keep theirs; the Clock page with its four control
 *     groups (Face, Clock, Language, Guest mode) fits its panel, every group
 *     inside, at the panel's size and full screen, in English and Spanish.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');

const ROOT = path.join(__dirname, '..');
const FRESH = new Date(H.MONDAY - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log('ok    ' + name + ' (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.message).split('\n').join('\n      '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }

function configLayouts() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + ';this.C = HUB_CONFIG;', box);
  const out = { stock: box.C.layout };
  box.C.layouts.forEach((l) => { if (l.layout) out[l.id] = l.layout; });
  return out;
}
const LAYOUTS = configLayouts();

// Every widget with a title, laid out in tiles of one size class each.
const WIDS = ['awws', 'awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab', 'wotd', 'calendar', 'todo', 'weather',
  'mirror', 'ambiance', 'entertainment', 'awws-todo', 'awws-visits', 'awws-agenda', 'awws-reach', 'nowplaying', 'today'];
function grid(w, h, ids) {
  const out = [];
  const perRow = 12 / w;
  ids.forEach((id, i) => out.push({ widget: id, x: (i % perRow) * w, y: Math.floor(i / perRow) * h, w: w, h: h }));
  return out;
}
function chunks(w, h) {
  const n = (12 / w) * (6 / h);
  const out = [];
  for (let i = 0; i < WIDS.length; i += n) out.push(grid(w, h, WIDS.slice(i, i + n)));
  return out;
}
const SIZES = [];
[['strip 3 col', 3, 1], ['two rows 3 col', 3, 2], ['three rows 3 col', 3, 3], ['narrow 2 col', 2, 2], ['narrow strip', 2, 1], ['wide 6 col', 6, 2], ['wide 6 col tall', 6, 3]]
  .forEach(([name, w, h]) => chunks(w, h).forEach((l, i) => SIZES.push({ name: name + ' #' + (i + 1), layout: l })));

/* Spanish 25% longer: the hub's own i18n.js, with every title, short title
   and badge grown, served in place of the real one. */
const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚ";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k)) continue;' +
  ' if (/\\.titles\\.|\\.titlesShort\\.|^wotd\\.title|^hub\\.soon$|^nowplaying\\.badge\\.|^weather\\.(sample|asOf)$/.test(k)) {' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.length * 0.25)); es[k] = s + add.slice(0, n); } } })();\n';
async function growSpanish(context) {
  await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
}

async function page(env, o) {
  o = o || {};
  const storage = Object.assign({ 'homeHub.lang': o.lang || 'en' }, SEEN, o.storage || {});
  return env.newPage({ layout: o.layout, storage: storage, route: o.grow ? growSpanish : undefined, at: o.at, config: o.config });
}

// Push mode, the extras on, the wanderers off: the harness opens fade mode.
async function pushPage(env, o) {
  const p = await page(env, o);
  const url = p.url().replace('motion=fade', 'motion=' + ((o && o.motion) || 'push')) + '&clay=off' + (o && o.query ? '&' + o.query : '');
  await p.goto(url);
  await p.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await H.until(() => p.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'not live');
  await H.until(() => p.evaluate(() => !window.HUB_TEST.busy()), 5000, 'busy');
  await H.sleep(900);
  return p;
}

/* Every header on the page: what is wrong with it, as a list of strings. */
function headerProblems(p, strict3) {
  return p.evaluate((strict3) => {
    const bad = [];
    const heads = document.querySelectorAll('#grid .tile-head');
    heads.forEach((head) => {
      const tile = head.closest('.tile');
      const id = tile.parentNode.getAttribute('data-widget');
      const cls = ['tile-h1', 'tile-h2', 'tile-h3', 'tile-wn', 'tile-wm', 'tile-ww', 'tile-w1'].filter((c) => tile.classList.contains(c)).join(' ');
      const where = id + ' (' + cls + ')';
      if (head.offsetParent === null || getComputedStyle(head).display === 'none') return;   // a one-column tile shows no head
      const T = tile.getBoundingClientRect();
      const icon = head.querySelector('.tile-icon');
      const title = head.querySelector('.tile-title');
      const titles = head.querySelector('.tile-titles');
      const badge = head.querySelector('.tile-badge');
      const ir = icon && icon.getBoundingClientRect();
      if (!ir || ir.width < 20 || !icon.querySelector('svg')) bad.push(where + ': no icon');
      const titleShown = titles && getComputedStyle(titles).display !== 'none';
      // A narrow strip shows only the icon there, by design.
      if (!titleShown) { if (!tile.classList.contains('tile-h1')) bad.push(where + ': no title'); return; }
      const cs = getComputedStyle(title);
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      const r = title.getBoundingClientRect();
      if (!title.textContent) bad.push(where + ': empty title');
      if (cs.whiteSpace !== 'nowrap' || r.height > lh * 1.5 + 4) bad.push(where + ': title on more than one line (' + Math.round(r.height) + ' px)');
      if (lh < fs * 1.3 - 0.5) bad.push(where + ': title line height ' + (lh / fs).toFixed(2));
      if (title.scrollHeight > title.clientHeight + 1) bad.push(where + ': title clipped above or below (' + title.scrollHeight + '/' + title.clientHeight + ')');
      const cut = title.scrollWidth > title.clientWidth + 1;
      const wide = tile.classList.contains('tile-wm') || tile.classList.contains('tile-ww');
      if (cut && (wide || strict3)) bad.push(where + ': "' + title.textContent + '" ends in "..." (' + title.scrollWidth + '/' + title.clientWidth + ')');
      if (r.left < T.left - 1 || r.right > T.right + 1 || r.top < T.top - 1) bad.push(where + ': title outside the tile');
      const hr = head.getBoundingClientRect();
      if (hr.right > T.right + 1 || hr.left < T.left - 1) bad.push(where + ': head wider than the tile');
      if (id === 'awws') {
        const t = title.textContent;
        if (!/^(A World Worth Saving|Un mundo que vale la pena salvar.*|AWWS.*)$/.test(t)) bad.push(where + ': AWWS title "' + t + '"');
      }
      if (badge && badge.offsetParent !== null && getComputedStyle(badge).display !== 'none' && badge.textContent) {
        const b = badge.getBoundingClientRect();
        const tr = { left: r.left, right: r.left + Math.min(r.width, title.scrollWidth), top: r.top, bottom: r.bottom };
        if (b.left < tr.right - 1 && tr.left < b.right - 1 && b.top < tr.bottom - 1 && tr.top < b.bottom - 1) bad.push(where + ': the badge overlaps the title');
        if (b.right > T.right + 1) bad.push(where + ': the badge sticks out');
        if (badge.scrollWidth > badge.clientWidth + 1 && wide) bad.push(where + ': the badge is cut');
      }
    });
    return { bad: bad, n: heads.length };
  }, !!strict3);
}

/* Contrast of the secondary words, on the rendered pixels: the brightest
   pixel in the element's box (the text) against the median (the glass). */
async function contrast(p, selectors) {
  const shot = (await p.screenshot()).toString('base64');
  return p.evaluate(async ({ shot, selectors }) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + shot; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    function lum(r, gg, b) {
      const v = [r, gg, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    }
    const out = [];
    document.querySelectorAll(selectors).forEach((e) => {
      if (e.offsetParent === null || !e.textContent.trim() || getComputedStyle(e).visibility === 'hidden') return;
      if (e.closest('.cell') === null) return;
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom > innerHeight || r.right > innerWidth) return;
      const d = g.getImageData(Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)).data;
      const ls = [];
      for (let i = 0; i < d.length; i += 4) ls.push(lum(d[i], d[i + 1], d[i + 2]));
      ls.sort((a, b) => a - b);
      const fg = ls[Math.floor(ls.length * 0.995)];
      const bg = ls[Math.floor(ls.length * 0.5)];
      out.push({ what: e.closest('.cell').getAttribute('data-widget') + ' ' + e.className.split(' ')[0] + ' "' + e.textContent.trim().slice(0, 30) + '"',
        ratio: Math.round((fg + 0.05) / (bg + 0.05) * 100) / 100 });
    });
    return out;
  }, { shot, selectors });
}

/* How the open panel's content fits its box. */
function panelFit(p) {
  return p.evaluate(() => {
    const panel = document.getElementById('panel');
    const ghost = document.getElementById('ghost');
    const body = panel.querySelector('.panel-body');
    let max = 0;
    for (let c = body.firstElementChild; c; c = c.nextElementSibling) {
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (cs.position === 'absolute') { max = Math.max(max, body.clientHeight); continue; }
      max = Math.max(max, c.offsetTop + c.offsetHeight + (parseFloat(cs.marginBottom) || 0));
    }
    const ps = getComputedStyle(panel);
    const want = body.offsetTop + max + parseFloat(ps.paddingBottom) + parseFloat(ps.borderBottomWidth);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const hint = panel.querySelector('.panel-hint');
    return { height: panel.offsetHeight, ghost: ghost.offsetHeight, want: Math.round(want), max: 26 * rem,
      overflow: body.scrollHeight > body.clientHeight + 1, hintFocusable: hint.classList.contains('f') || hint.tabIndex >= 0,
      hint: hint.textContent, hintChip: getComputedStyle(hint).borderTopStyle === 'solid' && parseFloat(getComputedStyle(hint).borderTopLeftRadius) > 8 };
  });
}

async function edges(p) { return (await p.evaluate(() => window.HUB_TEST.fx())).edges || []; }
function edgeOn(p, id) {
  return p.evaluate((id) => !!document.querySelector('.cell[data-widget="' + id + '"] .tile > .fx-accent'), id);
}

(async function main() {
  const env = await H.start();
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));

    /* ---------- headers ---------- */

    for (const name of ['main', 'awws-desk', 'awws-one-screen', 'awws-money', 'budget', 'stock']) {
      await check('Headers: ' + name + ' layout, English and Spanish', async () => {
        for (const lang of ['en', 'es']) {
          const p = await page(env, { layout: LAYOUTS[name], lang: lang });
          const r = await headerProblems(p, true);
          const errs = H.errorsOf(p, true);
          await p.context().close();
          assert(r.n >= 3, lang + ': only ' + r.n + ' headers');
          assert(!r.bad.length, lang + ': ' + r.bad.join('; '));
          assert(!errs.length, lang + ': console: ' + errs.join(' | '));
        }
      });
    }

    for (const s of SIZES) {
      await check('Headers: ' + s.name + ' (' + s.layout.map((e) => e.widget).join(', ') + '), English, Spanish and Spanish +25%', async () => {
        for (const v of [{ lang: 'en' }, { lang: 'es' }, { lang: 'es', grow: true }]) {
          const p = await page(env, { layout: s.layout, lang: v.lang, grow: v.grow });
          // Narrow tiles may end a grown title in "..." (one line still); 3 columns and up never.
          const r = await headerProblems(p, !v.grow);
          await p.context().close();
          assert(!r.bad.length, v.lang + (v.grow ? ' +25%' : '') + ': ' + r.bad.join('; '));
        }
      });
    }

    await check('The A World Worth Saving title: the full name where it fits, else AWWS (English and Spanish)', async () => {
      const L = [{ widget: 'awws', x: 0, y: 0, w: 6, h: 3 }, { widget: 'today', x: 6, y: 0, w: 3, h: 3 }, { widget: 'calendar', x: 9, y: 0, w: 3, h: 6 },
        { widget: 'awws-money', x: 0, y: 3, w: 9, h: 3 }];
      const seen = {};
      for (const lang of ['en', 'es']) {
        for (const [w, x] of [[6, 0], [3, 0], [2, 0]]) {
          const lay = L.map((e) => Object.assign({}, e));
          lay[0].w = w; lay[1].x = w; lay[1].w = 9 - w;
          const p = await page(env, { layout: lay, lang: lang });
          seen[lang + w] = await p.evaluate(() => document.querySelector('.cell[data-widget="awws"] .tile-title').textContent);
          await p.context().close();
        }
      }
      assert(seen.en6 === 'A World Worth Saving' && seen.en3 === 'A World Worth Saving' && seen.en2 === 'AWWS', JSON.stringify(seen));
      assert(seen.es6 === 'Un mundo que vale la pena salvar' && seen.es3 === 'AWWS' && seen.es2 === 'AWWS', JSON.stringify(seen));
    });

    await check('A language change refits every title (and the Soon badge) at once, and back', async () => {
      const p = await page(env, { layout: LAYOUTS.main, lang: 'en' });
      const read = () => p.evaluate(() => ({ awws: document.querySelector('.cell[data-widget="awws"] .tile-title').textContent,
        soon: document.querySelector('.cell[data-widget="mirror"] .tile-badge').textContent }));
      const a = await read();
      await p.evaluate(() => window.HUB_I18N.setLang('es'));
      await H.sleep(200);
      const b = await read();
      const r = await headerProblems(p, true);
      await p.evaluate(() => window.HUB_I18N.setLang('en'));
      await H.sleep(200);
      const c = await read();
      await p.context().close();
      assert(a.awws === 'A World Worth Saving' && a.soon === 'Soon', JSON.stringify(a));
      assert(b.awws === 'AWWS' && b.soon === 'Pronto' && !r.bad.length, JSON.stringify(b) + ' ' + r.bad.join('; '));
      assert(c.awws === a.awws && c.soon === a.soon, JSON.stringify(c));
    });

    await check('Weather: the place is the title, Sample the badge; Spotify: its state as the badge; the Clock has no title row', async () => {
      for (const lang of ['en', 'es']) {
        const p = await page(env, { layout: LAYOUTS.main, lang: lang });
        const r = await p.evaluate(() => {
          const q = (id, s) => { const e = document.querySelector('.cell[data-widget="' + id + '"] ' + s); return e && e.offsetParent !== null ? e.textContent : null; };
          return { wTitle: q('weather', '.tile-title'), wBadge: q('weather', '.tile-badge'), npTitle: q('nowplaying', '.tile-title'), npBadge: q('nowplaying', '.tile-badge'),
            clockHead: !!document.querySelector('.cell[data-widget="today"] .tile-head'), oldLabel: !!document.querySelector('.wx-label, .np-label') };
        });
        await p.context().close();
        assert(r.wTitle === 'Deep Ellum' && r.wBadge === (lang === 'es' ? 'Muestra' : 'Sample'), lang + ': ' + JSON.stringify(r));
        assert(r.npTitle === 'Spotify' && !!r.npBadge && !r.clockHead && !r.oldLabel, lang + ': ' + JSON.stringify(r));
      }
    });

    await check('Secondary words on the tiles reach 4.5:1 on the glass (sub lines, badges, hints, quiet lines)', async () => {
      const low = [];
      let n = 0;
      for (const name of ['main', 'stock', 'budget', 'awws-money']) {
        const p = await page(env, { layout: LAYOUTS[name], lang: 'en' });
        const list = await contrast(p, '.tile-sub, .tile-badge, .todo-empty-hint, .hub-quiet-line, .np-hint, .planned-text, .aw-sub, .bu-sub, .cal-tile-sub');
        n += list.length;
        list.forEach((x) => { if (x.ratio < 4.5) low.push(name + ': ' + x.what + ' ' + x.ratio + ':1'); });
        await p.context().close();
      }
      assert(n >= 8, 'only ' + n + ' measured');
      assert(!low.length, low.join('; '));
    });

    /* ---------- the panel ---------- */

    await check('The opened panel is as tall as its content (within 24 px), first open and again', async () => {
      const p = await pushPage(env, { layout: LAYOUTS.stock });
      const out = [];
      for (const id of ['entertainment', 'wotd', 'todo', 'calendar', 'awws', 'mirror']) {
        for (let k = 0; k < 2; k++) {
          await p.evaluate((id) => window.HUB_TEST.openPanel(id), id);
          await H.until(() => p.evaluate((id) => window.HUB_TEST.open() === id && !window.HUB_TEST.busy(), id), 5000, 'no panel ' + id);
          await H.sleep(250);
          const f = await panelFit(p);
          out.push(id + '#' + (k + 1) + ' ' + f.height + '/' + f.want);
          assert(f.height === f.ghost, id + ': the frame and the content differ: ' + JSON.stringify(f));
          const fits = f.want >= f.max - 1 ? Math.abs(f.height - f.max) <= 1 : Math.abs(f.height - Math.max(f.want, 10 * f.max / 26)) <= 24;
          assert(fits, id + ' open ' + (k + 1) + ': panel ' + f.height + ' px for content ' + f.want + ' px: ' + JSON.stringify(f));
          assert(!f.hintFocusable && f.hintChip && f.hint === 'Back to close', id + ': the Back hint: ' + JSON.stringify(f));
          await p.keyboard.press('Escape');
          await H.until(() => p.evaluate(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy()), 5000, 'did not close');
          await H.sleep(150);
        }
      }
      const ent = out.filter((x) => /^entertainment/.test(x))[0].split(' ')[1].split('/').map(Number);
      await p.context().close();
      assert(ent[0] < 26 * 24 - 24, 'Entertainment still full height: ' + out.join(', '));
    });

    await check('Full screen and back keep their sizes; the grown panel still fits after', async () => {
      const p = await pushPage(env, { layout: LAYOUTS.stock });
      await p.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
      await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 5000, 'no panel');
      const a = await panelFit(p);
      await H.fullScreen(p);
      const full = await p.evaluate(() => ({ h: document.getElementById('panel').offsetHeight, g: document.getElementById('ghost').offsetHeight, H: innerHeight }));
      await p.keyboard.press('Escape');
      await H.until(() => p.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 5000, 'not back');
      const b = await panelFit(p);
      await p.context().close();
      assert(full.h === full.H && full.g === full.H, 'full screen: ' + JSON.stringify(full));
      assert(a.height === b.height && b.ghost === b.height, 'back from full screen: ' + JSON.stringify([a, b]));
    });

    await check('Budget lab panel: 26rem at most and it scrolls to the merchants; its section heads are one line each, English, Spanish and +25%', async () => {
      for (const v of [{ lang: 'en' }, { lang: 'es' }, { lang: 'es', grow: true }]) {
        const p = await page(env, { layout: LAYOUTS.budget, lang: v.lang, grow: v.grow });
        const where = v.lang + (v.grow ? ' +25%' : '');
        try {
          await H.openPanel(p, 'budget-lab');
          const f = await panelFit(p);
          assert(Math.abs(f.height - f.max) <= 1 && f.overflow, where + ': the panel does not cap and scroll: ' + JSON.stringify(f));
          // Down to the first merchant: the panel body scrolls it into view.
          for (let i = 0; i < 3; i++) await H.key(p, 'ArrowDown');
          const r = await p.evaluate(() => {
            const body = document.querySelector('#panel .panel-body');
            const b = body.getBoundingClientRect();
            const f = document.querySelector('#panel .is-focused');
            const fr = f.getBoundingClientRect();
            const heads = Array.prototype.map.call(document.querySelectorAll('#panel .bl-msec > .bu-label, #panel .bl-dest > .bu-label, #panel .bl-pace > .bu-label'), (n) => {
              const cs = getComputedStyle(n);
              return { t: n.textContent, lines: Math.round(n.offsetHeight / parseFloat(cs.lineHeight)), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
                cut: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1 };
            });
            return { key: f.getAttribute('data-key'), inside: fr.top >= b.top - 1 && fr.bottom <= b.bottom + 1, top: body.scrollTop, heads: heads };
          });
          assert(r.key === 'cut-0' && r.inside && r.top > 0, where + ': the first merchant: ' + JSON.stringify(r).slice(0, 200));
          assert(r.heads.length === 3, where + ': heads: ' + JSON.stringify(r.heads));
          const bad = r.heads.filter((h) => h.lines !== 1 || h.lh < 1.245 || h.cut);
          assert(!bad.length, where + ': ' + JSON.stringify(bad));
          const errs = H.errorsOf(p, true);
          assert(!errs.length, where + ': console: ' + errs.join(' | '));
        } finally { await p.context().close(); }
      }
    });

    await check('Pushed-aside tiles show only icon and title; the body comes back on close', async () => {
      const p = await pushPage(env, { layout: LAYOUTS.stock });
      await p.evaluate(() => window.HUB_TEST.openPanel('entertainment'));
      await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 5000, 'no panel');
      const r = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#grid .tile'), (t) => ({
        id: t.parentNode.getAttribute('data-widget'), pushed: t.classList.contains('is-pushed'), headless: t.classList.contains('is-headless'),
        body: getComputedStyle(t.querySelector('.tile-body')).visibility,
        title: t.querySelector('.tile-title') ? getComputedStyle(t.querySelector('.tile-title')).visibility : null,
        transition: t.querySelector('.tile-body').style.transition })));
      await p.keyboard.press('Escape');
      await H.until(() => p.evaluate(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy()), 5000, 'did not close');
      const after = await p.evaluate(() => ({ pushed: document.querySelectorAll('.tile.is-pushed').length,
        hidden: Array.prototype.filter.call(document.querySelectorAll('#grid .tile-body'), (b) => getComputedStyle(b).visibility === 'hidden').length }));
      await p.context().close();
      const others = r.filter((x) => x.id !== 'entertainment');
      assert(others.every((x) => x.pushed), 'not pushed: ' + JSON.stringify(others.filter((x) => !x.pushed)));
      assert(others.every((x) => x.headless ? x.body === 'visible' : x.body === 'hidden' && x.title === 'visible'), JSON.stringify(others));
      assert(!after.pushed && !after.hidden, 'after closing: ' + JSON.stringify(after));
    });

    /* ---------- the accent edge ---------- */

    await check('Accent edge: a new to-do raises it on the To-do tile (with the chip), it goes after its hold and leaves nothing', async () => {
      const p = await pushPage(env, { layout: LAYOUTS.stock });
      const hold = await p.evaluate(() => window.HUB_FX.edgeHold());
      assert(hold === 60000, 'the default hold: ' + hold);
      await p.evaluate(() => window.HUB_FX.edgeHold(2500));
      await env.control('POST', '/api/todo', { title: 'Edge test ' + Date.now(), section: 'now' });
      await H.until(() => edgeOn(p, 'todo'), 4000, 'no edge on the To-do tile');
      const e = await p.evaluate(() => {
        const n = document.querySelector('.cell[data-widget="todo"] .fx-accent');
        const r = n.getBoundingClientRect();
        const t = n.parentNode.getBoundingClientRect();
        const cs = getComputedStyle(n);
        // A faint blue border over the tile's whole border box, the same rounding.
        return { box: [r.left - t.left, r.top - t.top, r.width - t.width, r.height - t.height].map(Math.round).join(), chip: !!document.querySelector('.fx-chip'),
          colors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor], width: cs.borderTopWidth,
          radius: cs.borderTopLeftRadius, tileRadius: getComputedStyle(n.parentNode).borderTopLeftRadius, tileWidth: getComputedStyle(n.parentNode).borderTopWidth };
      });
      assert(e.box === '0,0,0,0' && e.chip && e.colors.every((c) => /^rgba\(127, 209, 255, 0\.\d+\)$/.test(c)) &&
        e.width === e.tileWidth && e.radius === e.tileRadius, JSON.stringify(e));
      // Still there after the chip went.
      await H.until(() => p.evaluate(() => !document.querySelector('.fx-chip')), 4000, 'the chip stayed');
      assert(await edgeOn(p, 'todo'), 'the edge went with the chip');
      // Then it fades out, and nothing is left.
      await H.until(() => p.evaluate(() => !document.querySelector('.fx-accent')), 4000, 'the edge stayed past its hold');
      const st = await edges(p);
      await p.context().close();
      assert(!st.length, JSON.stringify(st));
    });

    await check('Accent edge: a changed snapshot (AWWS tiles), a changed budget (budget tiles) and changed events (Calendar)', async () => {
      const lay = [
        { widget: 'awws', x: 0, y: 0, w: 3, h: 3 }, { widget: 'awws-money', x: 3, y: 0, w: 6, h: 3 }, { widget: 'calendar', x: 9, y: 0, w: 3, h: 6 },
        { widget: 'budget-room', x: 0, y: 3, w: 3, h: 3 }, { widget: 'budget-card', x: 3, y: 3, w: 3, h: 3 }, { widget: 'today', x: 6, y: 3, w: 3, h: 3 }
      ];
      const p = await pushPage(env, { layout: lay });
      assert(!(await edges(p)).length, 'an edge at start: ' + JSON.stringify(await edges(p)));
      const snap = H.sample.snapshot();
      snap.reach = H.sample.reach('subscribers');
      snap.sentAt = new Date(H.MONDAY - 5000).toISOString().replace(/\.\d+Z$/, 'Z');
      await env.setSnapshot(snap);
      await H.until(() => edgeOn(p, 'awws'), 5000, 'no edge on the Glance');
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, short: true }));
      await H.until(async () => (await edgeOn(p, 'budget-room')) && (await edgeOn(p, 'budget-card')), 5000, 'no edge on the budget tiles');
      await env.feedMode('novisits');
      await H.until(() => edgeOn(p, 'calendar'), 20000, 'no edge on the Calendar');
      await env.feedMode('sample');
      const st = await edges(p);
      await env.setSnapshot(H.sample.snapshot());
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      await p.context().close();
      assert(!st.some((e) => e.widget === 'today'), 'an edge on the Clock: ' + JSON.stringify(st));
    });

    await check('Accent edge: an event starting within the hour, once; opening the tile clears it; focus never raises one', async () => {
      // 1:15 PM in Chicago: the 2:00 PM call starts within the hour.
      const p = await pushPage(env, { layout: LAYOUTS.stock, at: Date.parse('2026-11-16T19:15:00Z') });
      await H.until(() => edgeOn(p, 'calendar'), 4000, 'no edge for the 2:00 PM event');
      const st = await edges(p);
      assert(st.length === 1 && st[0].reason === 'soon', JSON.stringify(st));
      // Moving focus around adds nothing.
      for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowDown']) { await p.keyboard.press(k); await H.sleep(120); }
      assert((await edges(p)).length === 1, 'focus raised an edge: ' + JSON.stringify(await edges(p)));
      await p.evaluate(() => window.HUB_TEST.openPanel('calendar'));
      await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'calendar' && !window.HUB_TEST.busy()), 5000, 'no panel');
      assert(!(await edgeOn(p, 'calendar')), 'the edge stayed on an opened tile');
      await p.keyboard.press('Escape');
      await H.until(() => p.evaluate(() => !window.HUB_TEST.open() && !window.HUB_TEST.busy()), 5000, 'did not close');
      await H.sleep(1500);
      const again = await edges(p);
      await p.context().close();
      assert(!again.length, 'the same event raised it again: ' + JSON.stringify(again));
    });

    await check('Accent edge: static in fade mode (no lap, no fades); none with motionFx.edge off', async () => {
      const p = await pushPage(env, { layout: LAYOUTS.stock, motion: 'fade' });
      await env.control('POST', '/api/todo', { title: 'Edge fade ' + Date.now(), section: 'now' });
      await H.until(() => edgeOn(p, 'todo'), 4000, 'no edge in fade mode');
      const r = await p.evaluate(() => {
        const n = document.querySelector('.cell[data-widget="todo"] .fx-accent');
        return { sweep: !!n.querySelector('.fx-accent-sweep'), transition: n.style.transition, opacity: getComputedStyle(n).opacity,
          anim: Array.prototype.some.call(n.querySelectorAll('*'), (c) => getComputedStyle(c).animationName !== 'none'), chip: !!document.querySelector('.fx-chip') };
      });
      await p.evaluate(() => window.HUB_FX.edgeHold(300));
      await H.sleep(500);
      const gone = await p.evaluate(() => !document.querySelector('.fx-accent'));
      await p.context().close();
      assert(!r.sweep && !r.anim && (!r.transition || r.transition === 'none') && r.opacity === '1' && !r.chip, JSON.stringify(r));
      assert(gone, 'the static edge did not go at once after its hold');

      // ?fx= keeps only the extras it names: all but the edge.
      const q = await pushPage(env, { layout: LAYOUTS.stock, query: 'fx=quietTiles,ring,stagger,cover,bloom,activity' });
      const flags = (await q.evaluate(() => window.HUB_TEST.fx())).flags;
      await env.control('POST', '/api/todo', { title: 'Edge off ' + Date.now(), section: 'now' });
      await H.until(() => q.evaluate(() => !!document.querySelector('.fx-chip')), 4000, 'no chip');
      const none = await q.evaluate(() => document.querySelectorAll('.fx-accent').length);
      await q.context().close();
      assert(flags.edge === false && flags.activity === true && none === 0, JSON.stringify({ flags, none }));
    });

    /* ---------- Guest mode ---------- */

    const GUEST = { 'homeHub.guest.v1': 'on' };
    const MONEY = ['awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab'];
    const titlesOf = (p) => p.evaluate((ids) => ids.map((id) => {
      const t = document.querySelector('.cell[data-widget="' + id + '"] .tile-title');
      return t ? t.textContent : null;
    }), MONEY);

    await check('Guest mode: the money tiles keep the same header (title or short title, icon), English, Spanish and Spanish +25%; their bodies say hidden', async () => {
      const lays = [LAYOUTS['awws-money'], LAYOUTS.budget, grid(3, 2, MONEY), grid(2, 2, MONEY), grid(6, 3, MONEY.slice(0, 4)), grid(6, 3, MONEY.slice(4))];
      for (const lay of lays) {
        for (const v of [{ lang: 'en' }, { lang: 'es' }, { lang: 'es', grow: true }]) {
          const off = await page(env, { layout: lay, lang: v.lang, grow: v.grow });
          const before = await titlesOf(off);
          await off.context().close();
          const p = await page(env, { layout: lay, lang: v.lang, grow: v.grow, storage: GUEST });
          const r = await headerProblems(p, !v.grow);
          const after = await titlesOf(p);
          const hidden = await p.evaluate((ids) => ids.filter((id) => {
            const c = document.querySelector('.cell[data-widget="' + id + '"] .tile-body');
            return c && !/Hidden for guests|Oculto para invitados|Guest mode is on|Modo invitados activado/.test(c.textContent);
          }), MONEY.filter((id) => lay.some((e) => e.widget === id)));
          const errs = H.errorsOf(p, true);
          await p.context().close();
          const where = lay.map((e) => e.widget + ' ' + e.w + 'x' + e.h).join(', ') + ' ' + v.lang + (v.grow ? ' +25%' : '');
          assert(!r.bad.length, where + ': ' + r.bad.join('; '));
          assert(JSON.stringify(before) === JSON.stringify(after), where + ': titles changed: ' + JSON.stringify([before, after]));
          assert(!hidden.length, where + ': not hidden: ' + hidden.join(', '));
          assert(!errs.length, where + ': console: ' + errs.join(' | '));
        }
      }
    });

    await check('Guest mode: turning it on takes the edge off the money tiles; a budget sent then raises none; other tiles keep theirs', async () => {
      const lay = [
        { widget: 'budget-room', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-card', x: 3, y: 0, w: 3, h: 3 }, { widget: 'todo', x: 6, y: 0, w: 3, h: 6 },
        { widget: 'calendar', x: 9, y: 0, w: 3, h: 6 }, { widget: 'awws-money', x: 0, y: 3, w: 6, h: 3 }
      ];
      const p = await pushPage(env, { layout: lay });
      await p.evaluate(() => window.HUB_FX.edgeHold(60000));
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH, short: true }));
      await H.until(async () => (await edgeOn(p, 'budget-room')) && (await edgeOn(p, 'budget-card')), 5000, 'no edge on the budget tiles');
      await env.control('POST', '/api/todo', { title: 'Guest edge ' + Date.now(), section: 'now' });
      await H.until(() => edgeOn(p, 'todo'), 4000, 'no edge on the To-do tile');
      const heads = await titlesOf(p);
      await p.evaluate(() => window.HUB_GUEST.set(true));
      await H.sleep(300);
      const st = await edges(p);
      const headsOn = await titlesOf(p);
      await env.setBudget(H.budgetSample.snapshot({ sentAt: FRESH }));
      await H.sleep(2500);
      const st2 = await edges(p);
      const chips = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.fx-chip'), (c) => c.closest('.cell').getAttribute('data-widget')));
      await p.evaluate(() => window.HUB_GUEST.set(false));
      await p.context().close();
      assert(!st.some((e) => MONEY.indexOf(e.widget) >= 0), 'an edge stayed on a money tile: ' + JSON.stringify(st));
      assert(st.some((e) => e.widget === 'todo'), 'the To-do edge went too: ' + JSON.stringify(st));
      assert(!st2.some((e) => MONEY.indexOf(e.widget) >= 0) && !chips.some((w) => MONEY.indexOf(w) >= 0), 'a budget in Guest mode raised news: ' + JSON.stringify({ st2, chips }));
      assert(JSON.stringify(heads) === JSON.stringify(headsOn), 'the headers changed: ' + JSON.stringify([heads, headsOn]));
    });

    await check('The Clock page with four control groups fits its panel, every group inside (English and Spanish, panel and full screen)', async () => {
      for (const lang of ['en', 'es']) {
        const p = await pushPage(env, { layout: LAYOUTS.stock, lang: lang });
        await p.evaluate(() => window.HUB_TEST.openPanel('today'));
        await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'today' && !window.HUB_TEST.busy()), 5000, 'no Clock page');
        await H.sleep(250);
        const look = () => p.evaluate(() => {
          const body = document.querySelector('#panel .panel-body').getBoundingClientRect();
          const panel = document.getElementById('panel');
          const groups = Array.prototype.map.call(document.querySelectorAll('#panel .clock-group'), (g) => {
            const r = g.getBoundingClientRect();
            return { label: (g.querySelector('.clock-group-label') || {}).textContent, top: r.top, bottom: r.bottom, right: r.right, left: r.left };
          });
          return { body: { top: body.top, bottom: body.bottom, left: body.left, right: body.right }, groups: groups,
            frame: panel.offsetHeight, ghost: document.getElementById('ghost').offsetHeight };
        });
        const out = [];
        const a = await look();
        await H.fullScreen(p);
        await H.sleep(250);
        const b = await look();
        await p.keyboard.press('Escape');
        await H.until(() => p.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 5000, 'not back');
        const errs = H.errorsOf(p, true);
        await p.context().close();
        [['panel', a], ['full screen', b]].forEach(([w, s]) => {
          if (s.groups.length !== 4) out.push(w + ': ' + s.groups.length + ' groups');
          if (s.frame !== s.ghost) out.push(w + ': frame ' + s.frame + ' vs content ' + s.ghost);
          s.groups.forEach((g) => {
            if (g.bottom > s.body.bottom + 1 || g.top < s.body.top - 1 || g.right > s.body.right + 1 || g.left < s.body.left - 1) out.push(w + ': "' + g.label + '" outside the panel ' + JSON.stringify(g) + ' ' + JSON.stringify(s.body));
          });
        });
        assert(a.groups.length && /Guest mode|Modo invitados/.test(a.groups[3] && a.groups[3].label), lang + ': last group ' + JSON.stringify(a.groups[3]));
        assert(!out.length, lang + ': ' + out.join('; '));
        assert(!errs.length, lang + ': console: ' + errs.join(' | '));
      }
    });
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
