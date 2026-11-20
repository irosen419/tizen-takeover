/*
 * Screenshots of the Investments tile: node dev/investments-shots.js <out dir>
 * (needs Playwright and port 8095 free; deviceScaleFactor 2; made-up figures).
 * Saves: tile 3x2, 6x2 and 6x4 in English, 6x4 in Spanish, 6x4 in Guest mode
 * and the expanded view (the panel opened in place).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const H = require('./awws-harness');
const out = process.argv[2] || path.join(__dirname, '..', 'shots-investments');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const SEEN = { 'homeHub.budget.seen.v1': '["a-1042"]' };

async function tileShot(env, name, w, h, o) {
  o = o || {};
  const storage = Object.assign({}, SEEN, o.guest ? { 'homeHub.guest.v1': 'on' } : {});
  const page = await env.newPage({ layout: [{ widget: 'investments', x: 0, y: 0, w: w, h: h }], storage: storage, scale: 2, lang: o.lang });
  try {
    const box = await page.evaluate(() => {
      const r = document.querySelector('.cell[data-widget="investments"]').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const pad = 24;
    await page.screenshot({ path: path.join(out, name + '.png'),
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
  } finally { await page.ctx.close(); }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000) }));
    await tileShot(env, 'investments-en-3x2', 3, 2);
    await tileShot(env, 'investments-en-6x2', 6, 2);
    await tileShot(env, 'investments-en-6x4', 6, 4);
    await tileShot(env, 'investments-es-6x4', 6, 4, { lang: 'es' });
    await tileShot(env, 'investments-guest-6x4', 6, 4, { guest: true });
    const page = await env.newPage({ layout: [{ widget: 'investments', x: 0, y: 0, w: 3, h: 2 }, { widget: 'today', x: 3, y: 0, w: 4, h: 2 }], storage: SEEN, scale: 2 });
    try {
      await H.openPanel(page, 'investments');
      await H.sleep(400);
      await page.screenshot({ path: path.join(out, 'investments-expanded.png') });
      await H.fullScreen(page);
      await page.screenshot({ path: path.join(out, 'investments-expanded-full.png') });
    } finally { await page.ctx.close(); }
  } finally { await env.stop(); }
})().catch((e) => { console.log(e); process.exit(1); });
