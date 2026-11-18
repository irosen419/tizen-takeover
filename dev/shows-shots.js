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
    // The count badges: the expanded panel, full screen and four tile sizes.
    {
      const p = await env.newPage({});
      await H.openGrid(p);
      await shot(p, 'counts-panel-en.png');
      await H.fullScreen(p);
      await shot(p, 'counts-full-en.png');
      await p.ctx.close();
      for (const [w, h] of [[1, 1], [2, 1], [3, 1], [2, 2]]) {
        const t = await env.newPage({ layout: [{ widget: 'entertainment', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: 4, y: 0, w: 3, h: 2 }] });
        await H.sleep(600);
        await shot(t, 'counts-tile-' + w + 'x' + h + '.png');
        await t.ctx.close();
      }
    }
    {
      const p = await env.newPage({});
      await H.openSchedule(p, 'week');
      await H.focusKey(p, 'sh:row:paradise:');
      await H.key(p, 'Enter');
      await H.sleep(500);
      await shot(p, 'watch-card-en.png');
      await p.ctx.close();
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
    // Watched: Slow Horses S5 E4 and the Baking Show S16 E9 are marked.
    const mark = await H.start({ watched: [['slow-horses', 5, 4], ['the-great-british-baking-show', 16, 9]] });
    try {
      for (const lang of ['en', 'es']) {
        const page = await mark.newPage(lang === 'es' ? { lang: 'es' } : {});
        await H.openSchedule(page, 'week');
        await shot(page, 'schedule-watched-' + lang + '.png');
        await H.fullScreen(page);
        await shot(page, 'schedule-watched-full-' + lang + '.png');
        await page.ctx.close();
      }
      const p = await mark.newPage({});
      await H.openGrid(p);
      await shot(p, 'counts-watched-panel-en.png');
      await p.ctx.close();
      const t = await mark.newPage({ layout: [{ widget: 'entertainment', x: 0, y: 0, w: 2, h: 2 }, { widget: 'today', x: 4, y: 0, w: 3, h: 2 }] });
      await H.sleep(600);
      await shot(t, 'counts-watched-tile-2x2.png');
      await t.ctx.close();
      // The service has no /watch-track yet: the About row says so.
      const o = await mark.newPage({});
      await o.route(/:8095\/watch-track/, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"ok":false,"error":"not found"}' }));
      await H.sleep(4800);
      await o.evaluate(() => window.HUB_TEST.about.open());
      await H.sleep(500);
      await shot(o, 'about-watch-tracking.png');
      await o.ctx.close();
    } finally {
      await mark.stop();
    }
  } finally {
    await env.stop();
  }
  console.log(shots.join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
