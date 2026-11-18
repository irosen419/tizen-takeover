/*
 * Screenshots of the Schedule, the Entertainment tile and the watch link test,
 * at 1920x1080 in Chicago, from the made-up show sample:
 *   node dev/shows-shots.js [dir]   (default: dev/shots)
 * Nothing reaches the internet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./shows-harness');

const OUT = process.argv[2] || path.join(__dirname, 'shots');

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start();
  const shots = [];
  async function shot(page, name) {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  try {
    for (const lang of ['en', 'es']) {
      const page = await env.newPage(lang === 'es' ? { lang: 'es' } : {});
      await H.sleep(600);
      if (lang === 'en') await shot(page, 'home-tile-en.png');
      await H.openSchedule(page, 'week');
      await shot(page, 'schedule-week-' + lang + '.png');
      await H.fullScreen(page);
      await H.focusKey(page, 'sh:row:paradise:');
      await shot(page, 'schedule-week-full-' + lang + '.png');
      await page.evaluate(() => window.HUB_TEST.closePanel());
      await H.sleep(500);
      await H.openSchedule(page, 'soon');
      await shot(page, 'schedule-soon-' + lang + '.png');
      if (page.ctx.errors.length) console.log(lang + ' page errors: ' + page.ctx.errors.join(' | '));
      await page.ctx.close();
    }
    const page = await env.newPage({});
    await page.evaluate(() => window.HUB_TEST.about.open());
    await H.sleep(500);
    await shot(page, 'about-watch-link-test.png');
    await page.evaluate(() => window.HUB_TEST.about.close());
    await H.sleep(400);
    await H.openView(page, 'linktests');
    await shot(page, 'watch-link-test-list.png');
    await page.ctx.close();
  } finally {
    await env.stop();
  }
  console.log(shots.join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
