/*
 * Plant wall (app/widgets/plantwall.js): node dev/plantwall-test.js
 *
 * The real hub in headless Chromium on the shared harness (dev/awws-harness.js),
 * at the real clock (the drawing has no times). Checks:
 *   - the "Plants" layout holds Plant wall over Plant sun, filling the grid
 *     with no overlap;
 *   - the drawing has all 164 LEDs: 78 lit, 22 dark, 64 on the drum strip;
 *   - the labels carry the live WLED order: guitar tail LEDs 29-49, drum
 *     strip 50-113, mic tail 143-163; OUT 1 on the left, OUT 2 on the right;
 *     no "undefined" or unfilled {x};
 *   - the drawing stays inside its tile, and every label inside the drawing;
 *   - in Spanish, and in Spanish made 25% longer with Á, É, ñ, no English
 *     label is left, every boxed label fits its room, no type is shrunk
 *     below 7 px (drawing units);
 *   - OK opens it full screen (the head in Spanish too), Back closes it;
 *     no console errors.
 * Needs Playwright and port 8095 free. Prints one line per check and
 * "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./awws-harness');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }

const ROOT = path.join(__dirname, '..');
const box = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8') + '\nthis.c = HUB_CONFIG;', box);
const PLANTS = box.c.layouts.filter((l) => l.id === 'plant-wall')[0];

// Every plantwall Spanish text 25% longer, with accents, before the widget loads.
const LONG = new Function('var real; Object.defineProperty(window, "HUB_I18N", { configurable: true, get: function () { return real; }, set: function (v) {' +
  ' real = v; var es = v.strings.es; for (var k in es) if (k.indexOf("plantwall.") === 0) {' +
  ' var s = es[k]; var add = Math.ceil(s.length / 4); var pad = ""; while (pad.length < add) pad += "ÁÉñ"; es[k] = s + pad.slice(0, add); } } });');

// What the page says about the drawing.
function survey(where) {
  const svg = document.querySelector(where === 'panel' ? '#panel .pw-svg' : '.cell[data-widget="plantwall"] .pw-svg');
  if (!svg) return null;
  const tile = where === 'panel' ? svg.closest('#panel') : svg.closest('.tile');
  const tr = tile.getBoundingClientRect(), sr = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const texts = [].slice.call(svg.querySelectorAll('text')).map((t) => {
    const b = t.getBBox();
    return { s: t.textContent, x: +t.getAttribute('x'), w: +t.getAttribute('data-w') || 0, len: t.getComputedTextLength(),
      size: parseFloat(getComputedStyle(t).fontSize), box: { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height } };
  });
  return {
    lit: svg.querySelectorAll('circle.ledon').length,
    dark: svg.querySelectorAll('circle.leddark').length,
    strip: svg.querySelectorAll('circle.ledstrip').length,
    inside: sr.left >= tr.left - 1 && sr.top >= tr.top - 1 && sr.right <= tr.right + 1 && sr.bottom <= tr.bottom + 1,
    vb: { x: vb.x, y: vb.y, r: vb.x + vb.width, b: vb.y + vb.height },
    texts: texts
  };
}

function common(s) {
  assert(s, 'no drawing');
  assert(s.lit === 78 && s.dark === 22 && s.strip === 64, 'LEDs ' + s.lit + '+' + s.dark + '+' + s.strip);
  s.texts.forEach((t) => {
    assert(!/undefined|\{\w+\}/.test(t.s), 'unfilled label "' + t.s + '"');
    assert(t.box.x >= s.vb.x - 0.5 && t.box.r <= s.vb.r + 0.5 && t.box.y >= s.vb.y - 0.5 && t.box.b <= s.vb.b + 0.5, '"' + t.s + '" runs out of the drawing');
    if (t.w) assert(t.len <= t.w + 0.5, '"' + t.s + '" is ' + t.len.toFixed(1) + ' wide, room ' + t.w);
    assert(t.size >= 7, '"' + t.s + '" shrunk to ' + t.size + 'px');
  });
}

(async function main() {
  const env = await H.start({ at: Date.now() });
  try {
    await check('the Plants layout: Plant wall over Plant sun, filling the grid', async () => {
      assert(PLANTS && PLANTS.name === 'Plants', 'no Plants layout');
      const ids = PLANTS.layout.map((e) => e.widget).join(',');
      assert(ids === 'plantwall,sunpath', ids);
      const cells = {};
      let n = 0;
      PLANTS.layout.forEach((e) => { for (let x = e.x; x < e.x + e.w; x++) for (let y = e.y; y < e.y + e.h; y++) { assert(!cells[x + ',' + y], 'overlap at ' + x + ',' + y); cells[x + ',' + y] = 1; n++; } });
      assert(n === 72, n + ' of 72 cells');
    });

    const page = await env.newPage({ layout: PLANTS.layout, at: Date.now() });
    await check('English: 164 LEDs, the live numbering, all inside', async () => {
      const s = await page.evaluate(survey);
      common(s);
      assert(s.inside, 'the drawing runs past its tile');
      const all = s.texts.map((t) => t.s);
      ['LEDs 29 to 49', 'LEDs 50 to 113', 'LEDs 143 to 163', 'Painting 2, drums', 'Vase 4', 'Mic tail'].forEach((w) => assert(all.indexOf(w) >= 0, 'missing "' + w + '"'));
      const out1 = s.texts.filter((t) => t.s === 'OUT 1')[0], out2 = s.texts.filter((t) => t.s === 'OUT 2')[0];
      assert(out1 && out2 && out1.x < out2.x, 'OUT 1 should be left of OUT 2');
    });
    await check('OK opens full screen, Back closes', async () => {
      await H.openPanel(page, 'plantwall');
      const s = await page.evaluate(survey, 'panel');
      common(s);
      assert(s.inside, 'the drawing runs past the panel');
      const full = await page.evaluate(() => document.body.className + ' ' + (document.getElementById('panel') || {}).className);
      assert(/full/.test(full), 'not full screen: ' + full);
      await H.key(page, 'Escape');
      await H.sleep(600);
      const open = await page.evaluate(() => window.HUB_TEST.open());
      if (open) { await H.key(page, 'Backspace'); await H.sleep(600); }
      assert(!(await page.evaluate(() => window.HUB_TEST.open())), 'still open');
    });
    await check('no console errors', async () => {
      const errs = H.errorsOf(page, true);
      assert(!errs.length, errs.join(' | '));
    });
    await page.ctx.close();

    for (const [tag, cfg] of [['Spanish', null], ['Spanish +25%', LONG]]) {
      const p = await env.newPage({ layout: PLANTS.layout, at: Date.now(), storage: { 'homeHub.lang': 'es' }, config: cfg || undefined });
      await check(tag + ': no English left, every label fits', async () => {
        const s = await p.evaluate(survey);
        common(s);
        const all = s.texts.map((t) => t.s).join(' | ');
        ['Painting', 'Vase', 'tail', 'apart', 'aisle', 'floor', 'OUT'].forEach((w) => assert(all.indexOf(w) < 0, 'English "' + w + '" in ' + all));
        assert(/Cuadro 2, batería/.test(all) && /LED 50 a 113/.test(all), all);
      });
      await check(tag + ': full screen fits too', async () => {
        await H.openPanel(p, 'plantwall');
        const s = await p.evaluate(survey, 'panel');
        common(s);
        assert(s.inside, 'the drawing runs past the panel');
        const head = await p.evaluate(() => document.getElementById('panel').textContent);
        assert(/Luces del muro de plantas/.test(head) && !/Plant wall lights/.test(head), 'panel head: ' + head.slice(0, 80));
        const errs = H.errorsOf(p, true);
        assert(!errs.length, errs.join(' | '));
      });
      await p.ctx.close();
    }
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAILED: ' + (e && e.stack)); process.exit(1); });
