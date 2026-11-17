/*
 * Screenshots of Guest mode: node dev/guest-shots.js <out dir>  (needs Playwright and port 8095 free)
 * The money row with Guest mode off and on, and the Clock page's Guest mode row.
 */
'use strict';
const path = require('path');
const H = require('./awws-harness');
const out = process.argv[2] || path.join(__dirname, '..', 'shots-guest');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const ROW = [
  { widget: 'awws-money', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-room', x: 3, y: 0, w: 3, h: 3 },
  { widget: 'budget-card', x: 6, y: 0, w: 3, h: 3 }, { widget: 'budget-goals', x: 9, y: 0, w: 3, h: 3 },
  { widget: 'awws', x: 0, y: 3, w: 6, h: 3 }, { widget: 'today', x: 6, y: 3, w: 6, h: 3 }
];
(async () => {
  require('fs').mkdirSync(out, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000) }));
    const seen = { 'homeHub.budget.seen.v1': '["a-1042"]' };
    let page = await env.newPage({ layout: ROW, storage: seen, scale: 1 });
    await page.screenshot({ path: path.join(out, 'guest-1-off.jpg'), quality: 82 });
    await H.openPanel(page, 'today');
    await page.click('#panel [data-key="guest-on"]');
    await H.sleep(500);
    await page.screenshot({ path: path.join(out, 'guest-2-clock-page-on.jpg'), quality: 82 });
    await H.key(page, 'Escape');
    await H.idle(page);
    await H.sleep(400);
    await page.screenshot({ path: path.join(out, 'guest-3-on.jpg'), quality: 82 });
    await H.openPanel(page, 'budget-card');
    await H.sleep(300);
    await page.screenshot({ path: path.join(out, 'guest-4-panel-on.jpg'), quality: 82 });
    await page.ctx.close();
  } finally { await env.stop(); }
})().catch((e) => { console.log(e); process.exit(1); });
