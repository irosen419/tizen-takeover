/*
 * The A World Worth Saving tiles in Spanish: node dev/i18n-es-awws-test.js
 *
 * Loads the hub with ?lang=es against the sample calendars and snapshot
 * (dev/awws-harness.js) and checks every awws tile and panel for leftover
 * English words the hub itself shows (countdown unit, "Now for you", the
 * date and time of a visit). Titles of events and tasks come from the
 * calendar and the snapshot and stay as sent. Also checks that English stays
 * English, and that a language change redraws the tiles.
 */
'use strict';

const H = require('./awws-harness');

const IDS = ['awws', 'awws-visits', 'awws-agenda', 'awws-todo', 'awws-reach', 'awws-money', 'awws-outreach', 'awws-pipeline'];
// Words the hub itself shows in English. The sample's own titles and names
// (e.g. "AWWS read-aloud at Henderson") are not in this list.
const ENGLISH = /\b(days?|Now for you|now for you|Today|Tomorrow|Coming up|Next visit|This week|To-do board|Overdue|Nothing|Not synced|Soon|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|AM|PM|replies waiting|visits this week|subscribers|booked|Earned|Spent|Progress|Then|All day|until|Needs the Pi|Loading)\b/;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function sheet(ids, w, h) {
  return ids.map((id, i) => ({ widget: id, x: (i % 2) * w, y: Math.floor(i / 2) * h, w: w, h: h }));
}

(async () => {
  const env = await H.start({});
  try {
    await check('Spanish: every awws tile shows no English words', async () => {
      for (const size of [[6, 3], [3, 2], [12, 6]]) {
        const ids = size[0] === 12 ? ['awws'] : IDS.slice(0, size[0] === 6 ? 6 : 8);
        for (let i = 0; i < ids.length; i += size[0] === 6 ? 4 : 8) {
          const page = await env.newPage({ layout: sheet(ids.slice(i, i + (size[0] === 6 ? 4 : 8)), size[0], size[1]), lang: 'es' });
          try {
            const texts = await page.evaluate(() => Array.prototype.map.call(
              document.querySelectorAll('.cell .tile-body, .cell .tile-title, .cell .tile-sub'), (n) => n.textContent));
            const joined = texts.join(' | ');
            assert(joined.length > 40, 'no text: ' + joined);
            const body = joined.replace(/AWWS read-aloud at [^|]*/g, '');
            const m = ENGLISH.exec(body);
            assert(!m, 'English "' + (m && m[0]) + '" at ' + size.join('x') + ' in: ' + joined);
          } finally { await page.ctx.close(); }
        }
      }
    });

    await check('Spanish: the Glance shows "días", "Ahora para ti" and a Spanish date and time', async () => {
      const page = await env.newPage({ layout: [{ widget: 'awws', x: 0, y: 0, w: 6, h: 4 }, { widget: 'awws-visits', x: 6, y: 0, w: 6, h: 4 }], lang: 'es' });
      try {
        const t = await page.evaluate(() => document.querySelector('.cell[data-widget="awws"] .tile-body').textContent + ' || ' +
          document.querySelector('.cell[data-widget="awws-visits"] .tile-body').textContent);
        assert(/días|Hoy|Mañana|Ahora/.test(t), 'countdown: ' + t);
        assert(/ahora para ti|Ahora para ti/.test(t), 'now for you: ' + t);
        assert(/(dom|lun|mar|mié|jue|vie|sáb) \d+ (ene|feb|mar|abr|may|jun|jul|ago|sept|oct|nov|dic)/.test(t) || /(dom|lun|mar|mié|jue|vie|sáb)/.test(t), 'date: ' + t);
        assert(!/\b(AM|PM)\b/.test(t) && /[ap]\. m\./.test(t), 'time: ' + t);
      } finally { await page.ctx.close(); }
    });

    await check('Spanish: every awws panel has no English words', async () => {
      for (const id of IDS) {
        const page = await env.newPage({ layout: [{ widget: id, x: 0, y: 0, w: 4, h: 3 }], lang: 'es' });
        try {
          await H.openPanel(page, id);
          const t = await page.evaluate(() => document.querySelector('#panel').textContent);
          const m = ENGLISH.exec(t.replace(/AWWS read-aloud at [^|]*/g, ''));
          assert(!m, id + ': English "' + (m && m[0]) + '" in: ' + t.slice(0, 300));
        } finally { await page.ctx.close(); }
      }
    });

    await check('Spanish: Now Playing and Ambience tiles and panels have no English words', async () => {
      for (const id of ['nowplaying', 'ambience']) {
        const page = await env.newPage({ layout: [{ widget: id, x: 0, y: 0, w: 4, h: 3 }], lang: 'es' });
        try {
          const tile = await page.evaluate(() => document.querySelector('.cell').textContent);
          await H.openPanel(page, id);
          const panel = await page.evaluate(() => document.querySelector('#panel').textContent);
          const m = /\b(Add the|Not set up|Now playing|Last played|Nothing playing|Waiting for|Can’t reach|needs an update|Live updates|Shuffle|Repeat|Paused)\b/.exec(tile + ' ' + panel);
          assert(!m, id + ': English "' + (m && m[0]) + '" in: ' + tile + ' | ' + panel.slice(0, 200));
        } finally { await page.ctx.close(); }
      }
    });

    await check('English stays English; a language change redraws the tiles', async () => {
      const page = await env.newPage({ layout: [{ widget: 'awws', x: 0, y: 0, w: 6, h: 4 }], lang: 'en' });
      try {
        const en = await page.evaluate(() => document.querySelector('.cell[data-widget="awws"] .tile-body').textContent);
        assert(/now for you|Now for you|days|Today|Tomorrow/.test(en), 'English: ' + en);
        await page.evaluate(() => window.HUB_I18N.setLang('es'));
        await H.sleep(400);
        const es = await page.evaluate(() => document.querySelector('.cell[data-widget="awws"] .tile-body').textContent);
        assert(es !== en && /ahora para ti|Ahora para ti/.test(es), 'not redrawn: ' + es);
      } finally { await page.ctx.close(); }
    });
  } finally { await env.stop(); }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
