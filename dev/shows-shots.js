/*
 * Screenshots of the Schedule, the Entertainment tile and the watch link test
 * (and, with `finish` after the folder, the "Did you finish?" strip, the "N to check"
 * tile and the row's check toggle, at twice the pixels),
 * at 1920x1080 in Chicago, from the made-up show sample:
 *   node dev/shows-shots.js [dir]   (default: dev/shots)
 * Nothing reaches the internet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./shows-harness');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
const ONLY = process.argv[3] || '';          // 'finish': only the "Did you finish?" pictures (at twice the pixels)

// "Did you finish?": three started lines (not in order), the tile and the Schedule item with "N to check", and a row with its check toggle. 3840x2160 files.
async function finishShots(env, shot) {
  const started = [['the-pitt', 2, 6, 40], ['slow-horses', 5, 4, 3], ['the-great-british-baking-show', 16, 9, 20]];
  const panel = { x: 400, y: 215, width: 1120, height: 650 };
  for (const lang of ['en', 'es']) {
    const page = await env.newPage({ lang: lang === 'es' ? 'es' : undefined, started: started, scale: 2 });
    await H.openSchedule(page, 'week');
    await H.sleep(300);
    await shot(page, 'finish-schedule-' + lang + '.png', panel);
    await page.ctx.close();
  }
  // The tile: the home screen with the Entertainment tile as a 3x2 and as a strip, and the panel's Schedule item.
  for (const [w, h] of [[3, 2], [6, 1], [2, 2]]) {
    const t = await env.newPage({ started: started, scale: 2, layout: [{ widget: 'entertainment', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: 6, y: 0, w: 3, h: 2 }] });
    await H.sleep(600);
    await shot(t, 'finish-tile-' + w + 'x' + h + '.png', { x: 0, y: 0, width: 760, height: 480 });
    await t.ctx.close();
  }
  const es = await env.newPage({ lang: 'es', started: started, scale: 2, layout: [{ widget: 'entertainment', x: 0, y: 0, w: 3, h: 2 }, { widget: 'today', x: 6, y: 0, w: 3, h: 2 }] });
  await H.sleep(600);
  await shot(es, 'finish-tile-3x2-es.png', { x: 0, y: 0, width: 760, height: 480 });
  await es.ctx.close();
  const g = await env.newPage({ started: started, scale: 2 });
  await H.openGrid(g);
  await shot(g, 'finish-schedule-item.png', panel);
  await g.ctx.close();
  // A row with its check toggle: focused and unmarked, then marked (the Baking Show has an "Also on" chip here).
  const r = await env.newPage({ scale: 2 });
  await H.openSchedule(r, 'week');
  await r.evaluate(() => { const d = JSON.parse(localStorage.getItem('homeHub.shows.v1')); d.shows.forEach((s) => { if (s.id === 'the-great-british-baking-show') s.alsoOn = ['Hulu']; }); window.HUB_SHOWS._test.setData(d); });
  await H.sleep(400);
  await H.focusKey(r, 'sh:row:the-great-british-baking-show:');
  await H.key(r, 'ArrowRight', 2);
  await H.sleep(200);
  await shot(r, 'finish-row-toggle.png', panel);
  await H.key(r, 'Enter');
  await H.sleep(900);
  await shot(r, 'finish-row-toggle-marked.png', panel);
  await H.key(r, 'Enter');
  await H.sleep(900);
  await r.ctx.close();
}

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const env = await H.start();
  const shots = [];
  async function shot(page, name, clip) {
    const file = path.join(OUT, name);
    await page.screenshot(clip ? { path: file, clip: clip } : { path: file });
    shots.push(file);
  }
  try {
    if (ONLY === 'finish') {
      await finishShots(env, shot);
      console.log(shots.join('\n'));
      await env.stop();
      process.exit(0);
    }
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
    await finishShots(env, shot);
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
    } finally {
      await mark.stop();
    }
  } finally {
    await env.stop();
  }
  console.log(shots.join('\n'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
