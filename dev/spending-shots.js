/*
 * Screenshots of the Spending tile and its Trend page:
 *   node dev/spending-shots.js [out dir]   (default /mnt/project-files/spending-tile/build)
 * Needs Playwright and port 8095 free; deviceScaleFactor 2; made-up figures
 * (dev/budget-sample.js spendingDays, goals $75 from Oct 16, $60 from Nov 9).
 * Saves, in English and Spanish: the tile at 1x1, 3x2, 4x3 and 8x3, the Trend
 * page at full screen (TV 1920x1080), the page in Guest mode, the page with
 * reduced motion (its final state), the page with no goal, the Budget layout,
 * and the tablet page at 1280x800 and 600 wide.
 *
 *   node dev/spending-shots.js --where [out dir]   (default /mnt/project-files/spending-where-it-goes)
 * saves the Where it goes page instead (dev/budget-sample.js whereSample()):
 * TV and tablet (1280x800, 600 wide) in English and Spanish, Guest mode, the
 * state before the budget app sends trends ("on its way"), a frame mid-motion,
 * and the stale-data state ("No data since Nov 12": pace stops 3 days before
 * yesterday) on the tile at 4x3, 8x3 and 3x1 and on the Trend page.
 * --stale-only saves just the stale-data pictures (run on an older checkout
 * for "before" pictures with the same data and framing).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const H = require('./awws-harness');
const WHERE = process.argv.indexOf('--where') >= 0;
const ARGS = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0);
const out = ARGS[0] || (WHERE ? '/mnt/project-files/spending-where-it-goes' : '/mnt/project-files/spending-tile/build');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const GOALS = JSON.stringify(H.budgetSample.SPENDING_GOALS);

function storage(o) {
  const s = { 'homeHub.budget.seen.v1': '["a-1042"]' };
  if (o.goals !== false) s['spending-test-goals'] = GOALS;
  if (o.guest) s['homeHub.guest.v1'] = 'on';
  if (o.lang) s['homeHub.lang'] = o.lang;
  return s;
}

function open(env, o) {
  return env.newPage({ layout: o.layout || [{ widget: 'spending', x: 0, y: 0, w: o.w || 4, h: o.h || 3 }], storage: storage(o),
    scale: o.scale || 2, lang: o.lang, config: H.budgetSample.spendingHook, query: o.query, touch: o.touch, motion: o.motion });
}

async function tileShot(env, name, w, h, o) {
  o = Object.assign({ w: w, h: h }, o || {});
  const page = await open(env, o);
  try {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.cell[data-widget="spending"]').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const pad = 24;
    await page.screenshot({ path: path.join(out, name + '.png'),
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
  } finally { await page.ctx.close(); }
}

async function pageShot(env, name, o) {
  o = o || {};
  const page = await open(env, Object.assign({ w: 8, h: 3 }, o));
  try {
    if (o.reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    if (o.view) await page.setViewportSize(o.view);
    await H.openPanel(page, 'spending');
    await H.sleep(o.wait || 2200);
    if (o.where) {
      await H.key(page, 'ArrowDown');
      await H.sleep(o.whereWait || 2200);
    }
    if (o.left) await H.key(page, 'ArrowLeft', o.left);
    await H.sleep(400);
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: false });
  } finally { await page.ctx.close(); }
}

// The Where it goes page and the stale-data state (--where).
async function whereShots(dir, staleOnly) {
  fs.mkdirSync(dir, { recursive: true });
  const env = await H.start({});
  try {
    // Stale: pace stops on Nov 12, three days before yesterday.
    const stale = H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000), trend: true });
    stale.pace.days = stale.pace.days.slice(0, -3);
    await env.setBudget(stale);
    for (const lang of ['en', 'es']) {
      await tileShot(env, 'stale-' + lang + '-tile-4x3', 4, 3, { lang });
      await tileShot(env, 'stale-' + lang + '-tile-8x3', 8, 3, { lang });
      await tileShot(env, 'stale-' + lang + '-tile-3x1', 3, 1, { lang });
      await pageShot(env, 'stale-' + lang + '-trend-tv', { lang });
    }
    if (staleOnly) return;
    const snap = H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000), trend: true, where: true });
    await env.setBudget(snap);
    for (const lang of ['en', 'es']) {
      await pageShot(env, 'where-' + lang + '-tv', { lang, where: true });
      await pageShot(env, 'trend-' + lang + '-tv', { lang });
      await pageShot(env, 'where-' + lang + '-guest', { lang, guest: true, where: true });
      await pageShot(env, 'where-' + lang + '-tablet-1280x800', { lang, where: true, query: 'as=tablet', touch: true, view: { width: 1280, height: 800 }, scale: 1 });
      await pageShot(env, 'where-' + lang + '-tablet-600', { lang, where: true, query: 'as=tablet', touch: true, view: { width: 600, height: 960 }, scale: 1 });
    }
    await pageShot(env, 'where-en-motion-frame', { where: true, whereWait: 450, motion: 'push' });
    // Before the budget app sends trends: "Where it goes is on its way".
    await env.setBudget(Object.assign(H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000), trend: true }), { trends: null }));
    for (const lang of ['en', 'es']) await pageShot(env, 'where-' + lang + '-empty', { lang, where: true });
  } finally { await env.stop(); }
}

(async () => {
  if (WHERE) {
    await whereShots(out, process.argv.indexOf('--stale-only') >= 0);
    console.log('saved to ' + out);
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000), trend: true }));
    for (const lang of ['en', 'es']) {
      await tileShot(env, 'tile-' + lang + '-1x1', 1, 1, { lang });
      await tileShot(env, 'tile-' + lang + '-3x2', 3, 2, { lang });
      await tileShot(env, 'tile-' + lang + '-4x3', 4, 3, { lang });
      await tileShot(env, 'tile-' + lang + '-8x3', 8, 3, { lang });
      await pageShot(env, 'page-' + lang + '-tv', { lang, left: 5 });
      await pageShot(env, 'page-' + lang + '-guest', { lang, guest: true, left: 5 });
      await pageShot(env, 'page-' + lang + '-reduced', { lang, reduced: true, wait: 300 });
      await pageShot(env, 'page-' + lang + '-nogoal', { lang, goals: false });
      const page = await env.newPage({ storage: storage({ lang }), scale: 1, lang, config: H.budgetSample.spendingHook,
        layout: [{ widget: 'budget-room', x: 0, y: 0, w: 4, h: 3 }, { widget: 'spending', x: 4, y: 0, w: 8, h: 3 },
          { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 }, { widget: 'budget-card', x: 4, y: 3, w: 4, h: 3 }, { widget: 'budget-goals', x: 8, y: 3, w: 4, h: 3 }] });
      try { await page.screenshot({ path: path.join(out, 'layout-' + lang + '-budget.png') }); } finally { await page.ctx.close(); }
    }
    await pageShot(env, 'page-en-tablet-1280x800', { query: 'as=tablet', touch: true, view: { width: 1280, height: 800 }, scale: 1 });
    await pageShot(env, 'page-en-tablet-600', { query: 'as=tablet', touch: true, view: { width: 600, height: 960 }, scale: 1 });
    await pageShot(env, 'page-en-motion-frame', { wait: 500, motion: 'push' });
  } finally { await env.stop(); }
  console.log('saved to ' + out);
})().catch((e) => { console.log(e); process.exit(1); });
