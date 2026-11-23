/*
 * Screenshots of Guest mode: node dev/guest-shots.js <out dir> [off|on|both]
 * (needs Playwright and port 8095 free; deviceScaleFactor 1; made-up figures).
 * The money tiles (budget, Budget lab, Investments, Earned vs spent, the
 * Glance), the Card day panel and the Investments panel, in English and
 * Spanish, with Guest mode off and on. Off and on use the same layout, data,
 * time and focus, so the only difference is Guest mode (the blurred dollars).
 */
'use strict';
const path = require('path');
const H = require('./awws-harness');
const out = process.argv[2] || path.join(__dirname, '..', 'shots-guest');
const which = process.argv[3] || 'both';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const ROW = [
  { widget: 'budget-room', x: 0, y: 0, w: 3, h: 3 }, { widget: 'budget-card', x: 3, y: 0, w: 3, h: 3 },
  { widget: 'budget-goals', x: 6, y: 0, w: 3, h: 3 }, { widget: 'investments', x: 9, y: 0, w: 3, h: 3 },
  { widget: 'budget-lab', x: 0, y: 3, w: 4, h: 3 }, { widget: 'awws-money', x: 4, y: 3, w: 4, h: 3 },
  { widget: 'awws', x: 8, y: 3, w: 4, h: 3 }
];
(async () => {
  require('fs').mkdirSync(out, { recursive: true });
  const env = await H.start({});
  try {
    await env.setBudget(H.budgetSample.snapshot({ sentAt: iso(H.MONDAY - 60000) }));
    const modes = which === 'both' ? ['off', 'on'] : [which];
    for (const mode of modes) {
      for (const lang of ['en', 'es']) {
        const storage = { 'homeHub.budget.seen.v1': '["a-1042"]' };
        if (mode === 'on') storage['homeHub.guest.v1'] = 'on';
        const name = (s) => path.join(out, 'guest-' + mode + '-' + lang + '-' + s + '.png');
        const page = await env.newPage({ layout: ROW, storage, scale: 1, lang });
        try {
          await H.sleep(400);
          await page.screenshot({ path: name('1-tiles') });
          await H.openPanel(page, 'budget-card');
          await H.sleep(400);
          await page.screenshot({ path: name('2-card-panel') });
        } finally { await page.ctx.close(); }
        const p2 = await env.newPage({ layout: ROW, storage, scale: 1, lang });
        try {
          await H.openPanel(p2, 'investments');
          await H.sleep(400);
          await p2.screenshot({ path: name('3-investments-panel') });
        } finally { await p2.ctx.close(); }
      }
    }
  } finally { await env.stop(); }
})().catch((e) => { console.log(e); process.exit(1); });
