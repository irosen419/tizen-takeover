/*
 * Screenshots for the Entertainment polish (tile strip, Coming soon, tabs,
 * show page chips), EN and ES, from the made-up sample:
 *   node dev/ent-polish-shots.js [dir] [name]   (default: dev/shots, after)
 * Files: <name>-strip-<lang>.png (a 4x1 strip with a count and one to check),
 * <name>-soon-<lang>.png (Coming soon, full screen), <name>-chip-soon-<lang>.png
 * (a Your shows row's show page chip focused), <name>-chip-month-<lang>.png
 * (the same on This month), <name>-tab-right-<lang>.png (on the Today tab,
 * Right once). Nothing reaches the internet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./shows-harness');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
const NAME = process.argv[3] || 'after';
const STRIP = [{ widget: 'entertainment', x: 0, y: 0, w: 4, h: 1 }, { widget: 'today', x: 4, y: 0, w: 3, h: 2 }];

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ upTo: [['slow-horses', 3, 6]] });
  const errors = [];
  const shots = [];
  async function shot(page, name, el) {
    const file = path.join(OUT, NAME + '-' + name + '.png');
    if (el) await (await page.$(el)).screenshot({ path: file });
    else await page.screenshot({ path: file });
    shots.push(file);
  }
  async function done(p) { errors.push.apply(errors, p.ctx.errors.filter((e) => !/Failed to load resource/.test(e))); await p.ctx.close(); }
  try {
    for (const lang of ['en', 'es']) {
      const o = { lang: lang === 'es' ? 'es' : undefined, scale: 2 };
      let p = await env.newPage(Object.assign({ layout: STRIP, started: [['hells-kitchen', 24, 8, 1]] }, o));
      await H.sleep(600);
      await shot(p, 'strip-' + lang, '.cell[data-widget="entertainment"]');
      await done(p);

      p = await env.newPage(o);
      await H.openSchedule(p, 'soon');
      await H.fullScreen(p);
      await H.sleep(300);
      await shot(p, 'soon-' + lang);
      if (await H.focusKey(p, 'sh:show:slow-horses')) {
        await H.key(p, 'ArrowRight');
        await H.sleep(250);
        await shot(p, 'chip-soon-' + lang);
      }
      await done(p);

      p = await env.newPage(o);
      await H.openSchedule(p, 'month');
      await H.fullScreen(p);
      await H.focusChip(p, 'hells-kitchen');
      await H.sleep(250);
      await shot(p, 'chip-month-' + lang);
      await done(p);

      p = await env.newPage(o);
      await H.openSchedule(p, 'today');
      await H.fullScreen(p);
      await H.focusKey(p, 'sh:tab:');
      // To the Today tab (OK there, so the old build starts in the same place), then Right once.
      for (let i = 0; i < 4 && !(await p.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && f.getAttribute('data-key') === 'sh:tab:today'; })); i++) await H.key(p, 'ArrowLeft');
      await H.key(p, 'Enter');
      await H.key(p, 'ArrowRight');
      await H.sleep(300);
      await shot(p, 'tab-right-' + lang);
      await done(p);
    }
  } finally {
    await env.stop();
  }
  shots.forEach((f) => console.log(f));
  if (errors.length) { console.log('page errors: ' + errors.join(' | ')); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
