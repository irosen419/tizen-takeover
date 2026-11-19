/*
 * Screenshots of the Schedule, the Entertainment tile and the watch link test
 * (and, with `finish` after the folder, the "Did you finish?" strip, the "N to check"
 * tile and the row's check toggle, at twice the pixels),
 * at 1920x1080 in Chicago, from the made-up show sample:
 *   node dev/shows-shots.js [dir]   (default: dev/shots)
 *   node dev/shows-shots.js <dir> split [name]   (Entertainment full screen, EN and ES, at twice the pixels)
 *   node dev/shows-shots.js <dir> showpage   (the Schedule row's new toggle and Show page chip, the show page and its states, EN and ES, at twice the pixels)
 * Nothing reaches the internet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./shows-harness');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
const ONLY = process.argv[3] || '';          // 'finish': only the "Did you finish?" pictures (at twice the pixels); 'split': the Entertainment full screen (files named by argv[4], default after)
const NAME = process.argv[4] || 'after';

// Entertainment at full screen, 3840x2160: same sample, same clock, same screen. Run it on the commit before a change and on the change with a different name (before, after).
async function splitShots(env, shot) {
  for (const lang of ['en', 'es']) {
    const page = await env.newPage({ lang: lang === 'es' ? 'es' : undefined, scale: 2 });
    await H.openGrid(page);
    await H.fullScreen(page);
    await H.sleep(500);
    await shot(page, NAME + (lang === 'es' ? '-es' : '') + '.png');
    if (page.ctx.errors.length) console.log(lang + ' page errors: ' + page.ctx.errors.join(' | '));
    await page.ctx.close();
  }
}

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

// The show page: Slow Horses with E1 and E2 of season 5 watched, Andor (ended). 3840x2160 files.
async function showPageShots(env, shot) {
  const rowClip = { x: 535, y: 150, width: 1345, height: 125 };
  const headClip = { x: 535, y: 120, width: 1345, height: 330 };
  for (const lang of ['en', 'es']) {
    const opt = { lang: lang === 'es' ? 'es' : undefined, scale: 2 };
    const page = await env.newPage(opt);
    await H.openGrid(page);
    await H.fullScreen(page);
    await H.sleep(500);
    await H.focusKey(page, 'sh:row:the-great-british-baking-show:');
    await H.key(page, 'ArrowRight', 1);
    await H.sleep(250);
    await shot(page, 'row-toggle-' + lang + '.png', rowClip);
    await H.key(page, 'ArrowRight', 1);
    await H.sleep(250);
    await shot(page, 'row-showpage-' + lang + '.png', rowClip);
    if (page.ctx.errors.length) console.log(lang + ' page errors: ' + page.ctx.errors.join(' | '));
    await page.ctx.close();

    // Slow Horses: seasons 1 to 4 and E1, E2 of season 5 watched. A Pi of its own per language, since the pictures mark things.
    const mark = await H.start({ upTo: [['slow-horses', 4, 6]], watched: [['slow-horses', 5, 1], ['slow-horses', 5, 2]] });
    try {
      const p = await mark.newPage(opt);
      await H.openGrid(p);
      await H.fullScreen(p);
      await H.sleep(500);
      await H.focusChip(p, 'slow-horses');
      await H.key(p, 'Enter');
      await H.sleep(900);
      await H.focusKey(p, 'sh:pg:ep:5:3');
      await H.key(p, 'ArrowRight', 2);
      await H.sleep(300);
      await shot(p, 'show-page-' + lang + '.png');
      // I'm caught up, pressed: the header with the done button.
      await H.focusKey(p, 'sh:pg:caught');
      await H.key(p, 'Enter');
      await H.sleep(1200);
      await shot(p, 'show-page-caughtup-' + lang + '.png', headClip);
      if (p.ctx.errors.length) console.log(lang + ' page errors: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    } finally {
      await mark.stop();
    }

    // Andor, ended: "I've seen it all", pressed.
    const end = await H.start();
    try {
      const a = await end.newPage(opt);
      await H.openGrid(a);
      await H.fullScreen(a);
      await H.sleep(500);
      await a.evaluate(() => { const d = JSON.parse(localStorage.getItem('homeHub.shows.v1')); d.shows.forEach((s) => { if (s.id === 'andor') { s.running = false; s.status = 'Ended'; } }); window.HUB_SHOWS._test.setData(d); });
      await H.sleep(300);
      await a.evaluate(() => window.HUB_SHOWS._test.openPage('andor'));
      await H.sleep(900);
      await H.focusKey(a, 'sh:pg:caught');
      await H.key(a, 'Enter');
      await H.sleep(1200);
      await shot(a, 'show-page-ended-' + lang + '.png', headClip);
      await a.ctx.close();
    } finally {
      await end.stop();
    }
  }
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
    if (ONLY === 'split') {
      await splitShots(env, shot);
      console.log(shots.join('\n'));
      await env.stop();
      process.exit(0);
    }
    if (ONLY === 'showpage') {
      await showPageShots(env, shot);
      console.log(shots.join('\n'));
      await env.stop();
      process.exit(0);
    }
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
