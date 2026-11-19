/*
 * Screenshots of "Ready to watch" on the Schedule's Coming soon tab: shows
 * started (a "watched up to" point) with aired episodes not marked watched.
 * From the made-up sample with Slow Horses watched up to S3 E6 (seasons 4 and
 * 5 out), Andor up to S1 E12 (season 2 out in full) and Paradise up to S1 E8
 * (season 2 still airing). 1920x1080 at twice the pixels, EN and ES:
 *   node dev/ready-shots.js [dir] [name]   (default: dev/shots, after)
 * Files: <name>-soon-full-<lang>.png (full screen), <name>-soon-panel-<lang>.png
 * (the panel), <name>-row-focus-es.png and <name>-page-focus-es.png (a ready
 * row and its show page chip focused), <name>-yourshows-<lang>.png (Your shows
 * scrolled to Slow Horses). Nothing reaches the internet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./shows-harness');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
const NAME = process.argv[3] || 'after';

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start({ upTo: [['slow-horses', 3, 6], ['andor', 1, 12], ['paradise', 1, 8]] });
  const shots = [];
  const errors = [];
  async function shot(page, name) {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  try {
    for (const lang of ['en', 'es']) {
      const o = { lang: lang === 'es' ? 'es' : undefined, scale: 2 };
      let p = await env.newPage(o);
      await H.openSchedule(p, 'soon');
      await H.fullScreen(p);
      await H.sleep(300);
      await shot(p, NAME + '-soon-full-' + lang + '.png');
      if (lang === 'es') {
        if (await H.focusKey(p, 'sh:ready:')) {
          await H.sleep(250);
          await shot(p, NAME + '-row-focus-es.png');
          await H.key(p, 'ArrowRight');
          await H.sleep(250);
          await shot(p, NAME + '-page-focus-es.png');
        }
      }
      // Your shows, further down: a row with its "N to watch" tag and the show page chip.
      if (await H.focusKey(p, 'sh:show:slow-horses')) {
        await H.sleep(300);
        await shot(p, NAME + '-yourshows-' + lang + '.png');
      }
      errors.push.apply(errors, p.ctx.errors);
      await p.ctx.close();
      p = await env.newPage(o);
      await H.openSchedule(p, 'soon');
      await H.sleep(300);
      await shot(p, NAME + '-soon-panel-' + lang + '.png');
      errors.push.apply(errors, p.ctx.errors);
      await p.ctx.close();
    }
  } finally {
    await env.stop();
  }
  if (errors.length) console.log('page errors: ' + errors.join(' | '));
  console.log(shots.join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
