/*
 * The Schedule, the Entertainment tile's counts and the watch link test:
 *   node dev/shows-test.js
 *
 * Starts the preview (its own ports, a pretend TV service) and the Pi's hub
 * server with the made-up show sample (pi/fixtures/shows-sample.json, never
 * TVmaze), opens the hub in headless Chromium at 1920x1080 in Chicago on
 * Tuesday 17 November 2026, 7:25 PM, and checks:
 *   - days, grouping and times (12 and 24 hour), the tile's line and counts;
 *   - Spanish words; the empty, error and no-Pi states; SAMPLE only on samples;
 *   - Watch: the ladder per service, Hulu titles opening Disney+ (the alias
 *     map) and the "Also on Hulu" chip opening Hulu;
 *   - the card shown before an app opens without a deep link (EN and ES;
 *     OK or Back launches at once);
 *   - the watch link test: placeholders never fire, a recipe fires through
 *     /launch-control, the answer reaches the Pi, the typed id is kept;
 *   - "Did you finish?": every Watch press adds one started line (no timers, no
 *     calls to the TV service), the tile and the Schedule item say "N to check",
 *     the strip lists the lines sorted by title, Watched tells the Pi, Not yet
 *     sends nothing, focus walks down the list, a line goes after 7 days or when
 *     the Pi has the episode watched, and an aired row's check toggle marks and
 *     unmarks (EN and ES, nothing clipped);
 *   - Entertainment at full screen: the app column (counts and all) beside the live
 *     Schedule, Left and Right between them, OK on an app and on a row, the tile and
 *     the panel unchanged, Spanish fitting the narrow column;
 *   - the Show page: the row's "Mark as up to date" and page chip, the page (header, bar, buttons, season pills,
 *     episodes), single marks, "Watched up to here", caught up, ended wording, Back to the row's chip, EN and ES,
 *     its states (partial, unreachable, cached, an old Pi), and watched following the Pi's progress;
 *   - service.js's /launch-control checks (run in a sandbox with a stand-in
 *     tizen object), and the new app files are plain ES5.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const H = require('./shows-harness');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function assert(ok, text) { if (!ok) throw new Error(text); }

async function check(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log('ok    ' + name + ' (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message || e));
  }
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: token ? { authorization: 'Bearer ' + token } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const cardText = (page) => page.evaluate(() => { const c = document.querySelector('.sh-go-card'); return c ? c.firstChild.textContent + ' | ' + c.lastChild.textContent : ''; });
const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);
const focusedKey = (page) => page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || '' : ''; });
const pageErrors = (page) => page.ctx.errors.filter((e) => !/net::ERR_FAILED|ERR_CONNECTION_REFUSED|Failed to load resource/.test(e));

// service.js in a sandbox: http.createServer hands back its handler; tizen
// records the app controls it is asked for.
function loadService() {
  const src = fs.readFileSync(path.join(ROOT, 'service.js'), 'utf8');
  const out = { handler: null, launched: [], fail: null };
  const fakeHttp = {
    createServer: (fn) => { out.handler = fn; return { on: () => {}, listen: () => {}, close: () => {} }; },
    get: () => ({ on: () => {} })
  };
  const tizen = {
    ApplicationControlData: function (key, value) { this.key = key; this.value = value; },
    ApplicationControl: function (op, uri, mime, category, data) { this.operation = op; this.uri = uri; this.data = data; },
    application: {
      getAppsContext: (ok) => ok([]),
      launchAppControl: (control, id, ok, err) => {
        out.launched.push({ id: id, op: control.operation, uri: control.uri, data: control.data });
        if (out.fail) err({ message: out.fail }); else ok();
      }
    }
  };
  const sandbox = {
    require: (m) => (m === 'http' ? fakeHttp : require(m)),
    console: { log: () => {} }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, tizen, process,
    module: {}, exports: {}, __dirname: ROOT
  };
  // new Buffer(...) in the old service: the same as Buffer.from here.
  sandbox.Buffer = function (a, b) { return Buffer.from(a, b); };
  Object.assign(sandbox.Buffer, { from: Buffer.from, alloc: Buffer.alloc, isBuffer: Buffer.isBuffer, concat: Buffer.concat, byteLength: Buffer.byteLength });
  vm.runInNewContext(src, sandbox, { filename: 'service.js' });
  out.call = (url) => new Promise((resolve) => {
    const res = { status: 0, writeHead: (s) => { res.status = s; }, end: (b) => resolve({ status: res.status, body: JSON.parse(b) }) };
    out.handler({ url: url, method: 'GET', headers: {} }, res);
  });
  return out;
}

async function main() {
  const env = await H.start();
  try {
    const page = await env.newPage({});

    await check('The week groups the sample by day in the TV\'s own time zone', async () => {
      const v = await page.evaluate(() => {
        const T = window.HUB_SHOWS._test;
        const view = T.view(JSON.parse(localStorage.getItem('homeHub.shows.v1')), 'week', Date.now());
        return view.groups.map((g) => g.rows.map((a) => a.show.id + '@' + new Date(a.ms).getDate() + ' ' + T.timeText(a.ms)).join(','));
      });
      assert(v.length === 5, 'days: ' + JSON.stringify(v));
      assert(v[0] === 'slow-horses@16 9:00 PM', v[0]);
      assert(v[1] === 'the-great-british-baking-show@17 2:00 AM,paradise@17 8:00 PM,the-pitt@17 9:00 PM', v[1]);
      assert(v[2] === 'hells-kitchen@19 8:00 PM' && v[3] === 'shark-tank@20 7:00 PM' && v[4] === 'task@21 8:00 PM', JSON.stringify(v));
    });

    await check('Streaming times: a broadcast show moves to the day it streams (next day, or the Baking Show\'s Friday), a streaming one stays, live rows say where it aired (EN, ES), the tile says "New today"', async () => {
      const v = await page.evaluate(() => {
        const T = window.HUB_SHOWS._test;
        const raw = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
        raw.shows.forEach((s) => { if (s.id === 'the-great-british-baking-show') s.channel = 'Channel 4'; });
        const d = T.streamView(raw);
        const by = (id) => d.shows.filter((s) => s.id === id)[0];
        const hk = by('hells-kitchen').upcoming[0];
        const gb = by('the-great-british-baking-show').upcoming[0];
        const pa = by('paradise').upcoming[0];
        const bear = by('the-bear');
        const st = window.HUB_SHOWS.streamTime(raw.shows.filter((s) => s.id === 'hells-kitchen')[0], raw.shows.filter((s) => s.id === 'hells-kitchen')[0].upcoming[0]);
        const week = T.view(d, 'week', Date.now()).groups.map((g) => g.rows.map((a) => a.show.id + '@' + new Date(a.ms).getDate()).join(','));
        return {
          hk: [new Date(hk.airstamp).getDate(), new Date(hk.airstamp).getHours(), hk.dayOnly, hk.airedAt],
          gb: [new Date(gb.airstamp).getDay(), gb.dayOnly],
          pa: [pa.airedAt === undefined, pa.dayOnly === undefined],
          bear: bear.upcoming[0].airedAt === undefined,
          st: st && [st.dayOnly, st.airedOn, new Date(st.ms).getDate()],
          again: JSON.stringify(T.streamView(d)) === JSON.stringify(d),
          chan: [T.channelStreams('FX on Hulu'), T.channelStreams('Netflix'), T.channelStreams('FOX'), T.channelStreams('Cinemax'), T.channelStreams('')],
          week: week
        };
      });
      // Hell's Kitchen: FOX Thu Nov 19, 8 PM in the sample -> Disney+ on Fri Nov 20, day only.
      assert(v.hk[0] === 20 && v.hk[1] === 0 && v.hk[2] === true && v.hk[3] === '2026-11-20T02:00:00Z', JSON.stringify(v.hk));
      assert(v.gb[0] === 5 && v.gb[1] === true, 'Baking Show not on a Friday: ' + JSON.stringify(v.gb));
      assert(v.pa[0] && v.pa[1] && v.bear, 'a streaming show moved');
      assert(v.st && v.st[0] === true && v.st[1] === 'FOX' && v.st[2] === 20, JSON.stringify(v.st));
      assert(v.again, 'moving twice moved again');
      assert(JSON.stringify(v.chan) === '[true,true,false,false,true]', JSON.stringify(v.chan));
      assert(v.week.join('|').indexOf('hells-kitchen@20') >= 0 && v.week.join('|').indexOf('the-great-british-baking-show@20') >= 0, JSON.stringify(v.week));
      // The drawn rows, at Fri Nov 20 noon: "Streams on Disney+" and the live line, in English and Spanish; the tile says New today.
      const fri = Date.parse('2026-11-20T18:00:00Z');
      for (const lang of ['en', 'es']) {
        const p = await env.newPage({ lang: lang === 'es' ? 'es' : undefined, at: fri });
        try {
          await H.openSchedule(p, 'today');
          const r = await p.evaluate(() => {
            const row = document.querySelector('[data-key^="sh:row:hells-kitchen:"]');
            const air = row && row.querySelector('.sh-air');
            const box = air && air.getBoundingClientRect();
            const info = row && row.querySelector('.sh-info').getBoundingClientRect();
            return { meta: row && row.querySelector('.sh-meta-text').textContent, air: air && air.textContent, fits: !!box && box.right <= info.right + 1 && air.scrollWidth <= air.clientWidth + 1, tile: window.HUB_SHOWS.tileLine() };
          });
          if (lang === 'en') {
            assert(r.meta === 'S24 E8 · Streams on Disney+' && r.air === 'Aired live on FOX · Thu 8 PM', JSON.stringify(r));
            assert(/^(Tonight|Today|New today): /.test(r.tile), r.tile);
          } else {
            assert(r.meta === 'T24 E8 · Disponible en Disney+' && r.air === 'Se emitió en vivo en FOX · Jue 8 p. m.', JSON.stringify(r));
          }
          assert(r.fits, 'the live line does not fit: ' + JSON.stringify(r));
        } finally { await p.ctx.close(); }
      }
    });

    await check('Today, This month and Coming soon pick the right episodes and seasons', async () => {
      const v = await page.evaluate(() => {
        const T = window.HUB_SHOWS._test;
        const d = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
        const ids = (view) => view.groups.map((g) => g.rows.map((a) => a.show.id).join(',')).join(' | ');
        return {
          today: ids(T.view(d, 'today', Date.now())),
          month: T.view(d, 'month', Date.now()).groups.length,
          soon: T.view(d, 'soon', Date.now()).soon.map((r) => r.show.id + ':' + (r.days === null || r.days === undefined ? '-' : r.days))
        };
      });
      assert(v.today === 'the-great-british-baking-show,paradise,the-pitt', v.today);
      assert(v.month === 8, 'month days (17, 19, 20, 21, 23, 24, 26, 30): ' + v.month);
      assert(v.soon.join(' ') === 'the-bear:23 stick:64 severance:-', v.soon.join(' '));
    });

    await check('The panel: tabs, today\'s edge, the "in 35 min" edge, badges and SAMPLE', async () => {
      await H.openSchedule(page, 'week');
      const s = await page.evaluate(() => {
        const q = (sel) => document.querySelectorAll('#panel ' + sel);
        const row = document.querySelector('[data-key^="sh:row:paradise:"]');
        return {
          tabs: Array.prototype.map.call(q('.sh-tab'), (b) => b.textContent).join('|'),
          on: document.querySelector('#panel .sh-tab.is-on').textContent,
          today: q('.sh-day.is-today').length,
          soon: row && /is-soon/.test(row.className),
          meta: row && row.querySelector('.sh-meta').textContent,
          badge: row && row.querySelector('.sh-badge').textContent,
          watch: row && row.querySelector('.sh-watch').textContent,
          alt: Array.prototype.map.call(q('.sh-alt'), (a) => a.textContent).join('|'),
          sample: q('.sh-sample').length,
          range: q('.sh-range')[0].textContent
        };
      });
      assert(s.tabs === 'Today|This week|This month|Coming soon' && s.on === 'This week', JSON.stringify(s));
      assert(s.today === 1 && s.soon, 'today/soon: ' + JSON.stringify(s));
      assert(s.meta === 'S2 E6 · 8:00 PMin 35 min', 'meta: ' + s.meta);
      assert(s.badge === 'Disney+' && s.watch === 'Watch on Disney+', 'alias: ' + s.badge + ' / ' + s.watch);
      assert(s.alt === 'Also on Hulu|Also on Hulu', 'alt chips: ' + s.alt);
      assert(s.sample === 1 && /SAMPLE/i.test(await page.evaluate(() => document.querySelector('#panel .sh-sample').textContent)), 'sample chip');
      assert(/Nov 16\s*–\s*22/.test(s.range), s.range);
    });

    await check('OK on a row opens its app: a Hulu title opens Disney+ and says what to search', async () => {
      assert((await focusedKey(page)).indexOf('sh:row:paradise:') === 0, 'focus: ' + await focusedKey(page));
      const before = env.launches.length;
      await H.key(page, 'Enter');
      // The card says what will happen first; the app opens after it (about 1.8 s).
      await H.until(() => page.evaluate(() => !!document.querySelector('.sh-go-card')), 1500, 'no card');
      assert(env.launches.length === before, 'launched before the card went');
      assert(await cardText(page) === 'Disney+ opens on its home screen | Search for: Paradise', await cardText(page));
      await H.until(() => env.launches.length > before, 3500, 'nothing was launched');
      assert(env.launches[env.launches.length - 1] === 'launch 3201901017640', env.launches.join(' | '));
      assert(await page.evaluate(() => !document.querySelector('.sh-go-card')), 'the card stayed');
    });

    await check('Right then OK on "Also on Hulu" opens Hulu instead', async () => {
      await H.key(page, 'ArrowRight');
      assert((await focusedKey(page)).indexOf('sh:alt:paradise:') === 0, 'focus: ' + await focusedKey(page));
      const before = env.launches.length;
      await H.key(page, 'Enter');
      await H.until(() => page.evaluate(() => !!document.querySelector('.sh-go-card')), 1500, 'no card');
      assert(await cardText(page) === 'Hulu opens on its home screen | Search for: Paradise', await cardText(page));
      // OK dismisses the card and launches at once.
      const t0 = Date.now();
      await H.key(page, 'Enter');
      await H.until(() => env.launches.length > before, 1000, 'OK did not launch at once');
      assert(Date.now() - t0 < 1000, 'slow');
      assert(env.launches[env.launches.length - 1] === 'launch 3201601007625', env.launches.join(' | '));
      assert(await page.evaluate(() => !document.querySelector('.sh-go-card')), 'the card stayed');
    });

    await check('The ladder: every service has a fallback app and a search hint; unknown names open by name', async () => {
      const v = await page.evaluate(() => {
        const T = window.HUB_SHOWS._test;
        const out = {};
        Object.keys(window.HUB_SHOWS.SERVICES).concat(['Some New App']).forEach((s) => {
          const l = T.ladder(s);
          out[s] = !!l.fallbackOpenApp && l.fallbackOpenApp.match.length > 0 && l.hint === 'search' && (l.tryDeepLink === null || typeof l.tryDeepLink === 'function');
        });
        out.alias = T.watchApp({ service: 'Hulu' }) + '/' + T.watchApp({ service: 'Netflix' }) + '/' + T.alternatives({ service: 'Hulu', alsoOn: ['Hulu', 'Peacock'] }).join('+');
        return out;
      });
      for (const k in v) if (k !== 'alias') assert(v[k] === true, 'ladder of ' + k);
      assert(v.alias === 'Disney+/Netflix/Hulu+Peacock', v.alias);
    });

    await check('The tile: apps with something on now come first, with a count, and the line says tonight', async () => {
      await page.evaluate(() => window.HUB_TEST.closePanel());
      await H.sleep(500);
      const v = await page.evaluate(() => ({
        avail: window.HUB_SHOWS.availability(),
        line: window.HUB_SHOWS.tileLine(),
        chips: Array.prototype.map.call(document.querySelectorAll('.cell[data-widget="entertainment"] .ent-count'), (c) => c.textContent).length,
        first: Array.prototype.map.call(document.querySelectorAll('.cell[data-widget="entertainment"] [data-app], .cell[data-widget="entertainment"] .ent-chip'), (c) => c.getAttribute('data-app') || c.getAttribute('title') || '').slice(0, 3)
      }));
      assert(JSON.stringify(v.avail) === JSON.stringify({ 'Apple TV': 1, Netflix: 1, 'Disney+': 1, 'HBO Max': 1 }) ||
        (v.avail['Apple TV'] === 1 && v.avail.Netflix === 1 && v.avail['Disney+'] === 1 && v.avail['HBO Max'] === 1 && Object.keys(v.avail).length === 4), JSON.stringify(v.avail));
      assert(v.line === 'Tonight: Paradise 8 PM', v.line);
      assert(v.chips === 3, 'count badges on the tile: ' + v.chips);
    });

    await check('Empty, error and old-copy states; SAMPLE is gone for real data', async () => {
      const v = await page.evaluate(() => {
        const T = window.HUB_SHOWS._test;
        const out = {};
        T.setData({ v: 1, updatedAt: '2026-11-17T12:00:00Z', shows: [] });
        out.empty = window.HUB_SHOWS.state();
        T.setData({ v: 1, updatedAt: null, error: 'No show could be read: unreachable', shows: [{ id: 'x', name: 'X', service: 'Netflix', upcoming: [] }] });
        out.error = window.HUB_SHOWS.state();
        T.setData({ v: 1, updatedAt: '2026-11-17T12:00:00Z', shows: [{ id: 'x', name: 'X', service: 'Netflix', checkedAt: '2026-11-17T12:00:00Z', upcoming: [{ season: 1, number: 2, airstamp: '2026-11-18T03:30:00Z' }] }] });
        out.real = window.HUB_SHOWS.state();
        return out;
      });
      assert(v.empty === 'empty' && v.error === 'error' && v.real === 'data', JSON.stringify(v));
      await H.openSchedule(page, 'today');
      const p = await page.evaluate(() => ({ sample: document.querySelectorAll('#panel .sh-sample').length, rows: document.querySelectorAll('#panel .sh-row').length }));
      assert(p.sample === 0 && p.rows === 1, JSON.stringify(p));
      await page.evaluate(() => window.HUB_SHOWS._test.setData({ v: 1, updatedAt: '2026-11-17T12:00:00Z', shows: [] }));
      await H.sleep(200);
      const text = await page.evaluate(() => document.querySelector('#panel .panel-body').textContent);
      assert(/No shows on the list yet/.test(text), text.slice(0, 200));
      await page.evaluate(() => window.HUB_TEST.closePanel());
      await H.sleep(400);
    });
    if (pageErrors(page).length) console.log('      page errors: ' + pageErrors(page).join(' | '));
    await page.ctx.close();

    await check('Small tiles (docs/tile-sizes.md): the counts stay inside the tile at every size', async () => {
      const seen = [];
      for (const [w, h] of [[1, 1], [2, 1], [2, 2], [3, 1], [3, 4], [12, 1]]) {
        const layout = [{ widget: 'entertainment', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: w === 12 ? 0 : w, y: w === 12 ? 1 : 0, w: 3, h: 2 }];
        const p = await env.newPage({ layout: layout });
        try {
          await H.sleep(500);
          const v = await p.evaluate(() => {
            const c = document.querySelector('.cell[data-widget="entertainment"] .tile');
            const r = c.getBoundingClientRect();
            let out = 0;
            const b = c.querySelectorAll('.ent-count');
            for (let i = 0; i < b.length; i++) {
              const q = b[i].getBoundingClientRect();
              if (q.right > r.right + 1 || q.left < r.left - 1 || q.top < r.top - 1 || q.bottom > r.bottom + 1) out++;
            }
            return { n: b.length, out: out };
          });
          seen.push(w + 'x' + h + ':' + v.n);
          assert(v.out === 0, w + 'x' + h + ': ' + v.out + ' counts outside the tile');
        } finally { await p.ctx.close(); }
      }
      // 1 column shows only the TV icon; a narrow strip has room for one logo.
      assert(seen.join(' ') === '1x1:0 2x1:1 2x2:3 3x1:1 3x4:3 12x1:3', seen.join(' '));
    });

    await check('via (Prime Video Channels): the badge keeps the service, a "via" hint, and Watch opens the via app', async () => {
      const p = await env.newPage({});
      try {
        // Per service in config (watchVia), and per show from the Pi (via).
        await p.evaluate(() => { window.HUB_CONFIG.widgets.entertainment.watchVia = { 'HBO Max': 'Prime Video' }; });
        const pure = await p.evaluate(() => {
          const T = window.HUB_SHOWS._test;
          return [
            T.viaApp({ service: 'HBO Max' }, 'HBO Max'),
            T.viaApp({ service: 'Netflix' }, 'Netflix'),
            T.viaApp({ service: 'Apple TV', via: 'Prime Video' }, 'Apple TV'),
            T.viaApp({ service: 'Apple TV', via: 'Apple TV' }, 'Apple TV'),
            JSON.stringify(window.HUB_SHOWS.availability())
          ];
        });
        assert(pure[0] === 'Prime Video' && pure[1] === '' && pure[2] === 'Prime Video' && pure[3] === '', JSON.stringify(pure));
        assert(/"Prime Video":1/.test(pure[4]) && !/HBO Max/.test(pure[4]), 'counted under the app OK opens: ' + pure[4]);
        await H.openSchedule(p, 'week');
        const row = await p.evaluate(() => {
          const r = document.querySelector('[data-key^="sh:row:the-pitt:"]');
          return { badge: r.querySelector('.sh-badge').textContent, via: (r.querySelector('.sh-via') || {}).textContent || '', others: document.querySelectorAll('#panel .sh-via').length };
        });
        assert(row.badge === 'HBO Max' && row.via === 'via Prime Video', JSON.stringify(row));
        assert(row.others === 2, 'via hints this week (The Pitt and Task): ' + row.others);
        await H.focusKey(p, 'sh:row:the-pitt:');
        const before = env.launches.length;
        await H.key(p, 'Enter');
        await H.until(() => p.evaluate(() => !!document.querySelector('.sh-go-card')), 1500, 'no card');
        assert(await cardText(p) === 'Prime Video opens on its home screen | Search for: The Pitt', await cardText(p));
        await H.key(p, 'Escape');
        await H.until(() => env.launches.length > before, 1000, 'Back did not launch at once');
        assert(env.launches[env.launches.length - 1] === 'launch 3201910019365', env.launches.join(' | '));
        // Without the setting, HBO Max opens HBO Max (Max on this TV) and no hint shows.
        await p.evaluate(() => { delete window.HUB_CONFIG.widgets.entertainment.watchVia; window.HUB_TEST.closePanel(); });
        await H.sleep(500);
        await H.openSchedule(p, 'week');
        assert(await p.evaluate(() => document.querySelectorAll('#panel .sh-via').length) === 0, 'a via hint without the setting');
      } finally { await p.ctx.close(); }
    });

    await check('Spanish words and a 24 hour clock', async () => {
      const es = await env.newPage({ lang: 'es', hours: '24' });
      try {
        await H.openSchedule(es, 'week');
        const s = await es.evaluate(() => {
          const row = document.querySelector('[data-key^="sh:row:paradise:"]');
          return {
            tabs: Array.prototype.map.call(document.querySelectorAll('#panel .sh-tab'), (b) => b.textContent).join('|'),
            meta: row.querySelector('.sh-meta').textContent,
            watch: row.querySelector('.sh-watch').textContent,
            alt: document.querySelector('#panel .sh-alt').textContent,
            sub: document.querySelector('#panel').textContent.indexOf('Programación') >= 0,
            line: window.HUB_SHOWS.tileLine()
          };
        });
        assert(s.tabs === 'Hoy|Esta semana|Este mes|Pronto', s.tabs);
        assert(s.meta === 'T2 E6 · 20:00en 35 min', s.meta);
        assert(s.watch === 'Ver en Disney+' && s.alt === 'También en Hulu' && s.sub, JSON.stringify(s));
        assert(s.line === 'Esta noche: Paradise 20:00', s.line);
        await H.focusKey(es, 'sh:row:paradise:');
        await H.key(es, 'Enter');
        await H.until(() => es.evaluate(() => !!document.querySelector('.sh-go-card')), 1500, 'no card');
        assert(await cardText(es) === 'Disney+ se abre en su pantalla de inicio | Busca: Paradise', await cardText(es));
        await H.key(es, 'Enter');
      } finally { await es.ctx.close(); }
    });

    await check('No Pi: the Schedule says it needs the Pi, and nothing breaks', async () => {
      const off = await env.newPage({ live: 'off', storage: { 'homeHub.shows.v1': '' } });
      try {
        await off.evaluate(() => localStorage.removeItem('homeHub.shows.v1'));
        await H.openSchedule(off, null);
        const text = await off.evaluate(() => document.querySelector('#panel .panel-body').textContent);
        assert(/Schedule needs the Pi|Shows come from the hub server/.test(text) || /needs the Pi/.test(text), text.slice(0, 200));
        assert(!pageErrors(off).some((e) => /page error/.test(e)), pageErrors(off).join(' | '));
      } finally { await off.ctx.close(); }
    });

    await check('Watch link test: placeholders say "needs id" and never fire', async () => {
      const lt = await env.newPage({});
      try {
        await H.openView(lt, 'linktests');
        const v = await lt.evaluate(() => {
          const T = window.HUB_LINKTEST._test;
          const list = T.recipes();
          const needs = list.filter((r) => r.needsId).map((r) => r.id);
          const fired = needs.map((id) => T.fire(list.filter((r) => r.id === id)[0]));
          return { n: list.length, needs: needs, fired: fired, prime: list[0].val, states: Array.prototype.map.call(document.querySelectorAll('#panel .lt-state.is-needs'), (s) => s.textContent) };
        });
        assert(v.n === 21, 'recipes: ' + v.n);
        assert(v.needs.join(',') === 'disney-view,disney-resume,hulu-view,peacock-view', v.needs.join(','));
        assert(v.fired.every((f) => f === 'needsid'), v.fired.join(','));
        assert(v.states.length === 4 && v.states.every((s) => s === 'needs id'), v.states.join(','));
        assert(v.prime === '{"values":"amzn1.dv.gti.50f41028-8256-4293-9d0d-14556b501136"}', v.prime);
        assert(!env.launches.some((l) => /launch-control/.test(l)), env.launches.join(' | '));
      } finally { await lt.ctx.close(); }
    });

    await check('Watch link test: the App probe row is first, not counted, and OK posts the probe results from a stubbed tizen', async () => {
      const lt = await env.newPage({});
      try {
        await H.openView(lt, 'linktests');
        const first = await lt.evaluate(() => ({ key: document.querySelector('#panel .lt .lt-row').getAttribute('data-key'), total: document.querySelector('.lt-total').textContent, nums: document.querySelectorAll('.lt-row .lt-num').length }));
        assert(first.key === 'lt:probe' && /^21 tests/.test(first.total) && first.nums === 21, JSON.stringify(first));
        const posts = await lt.evaluate(() => {
          window.tizen = {
            ApplicationControl: function (op) { this.operation = op; },
            application: {
              getAppsInfo: (ok) => ok([{ id: 'nf.app', name: 'Netflix' }, { id: 'x.plain', name: 'Calc' }, { id: 'x.meta', name: 'Guide' }]),
              getAppMetaData: (id) => id === 'nf.app' ? [{ key: 'a', value: 'b' }] : id === 'x.meta' ? [{ key: 'PreviewEndpoint', value: 'https://e/x' }] : [],
              findAppControl: (ac, ok) => ok(ac.operation.slice(-4) === 'view' ? [{ id: 'nf.app', name: 'Netflix' }] : [], ac)
            }
          };
          const sent = [];
          const Lv = window.HUB_LINKTEST._test.state().C.live;
          const orig = Lv.post;
          Lv.post = function (path, body, cb) { sent.push({ path: path, result: body.result }); cb(null); };
          const r = window.HUB_LINKTEST._test.probe();
          return new Promise((res) => setTimeout(() => { Lv.post = orig; res({ r: r, sent: sent, pending: window.HUB_LINKTEST._test.state().pending }); }, 600));
        });
        assert(posts.r === 'started' && posts.pending === null, JSON.stringify(posts));
        const ids = posts.sent.map((x) => x.result.id).join();
        assert(ids === 'probe-01,probe-02,probe-ops', ids);
        const a = posts.sent[0].result;
        assert(posts.sent.every((x) => x.path === '/linktests' && x.result.outcome === 'error' && x.result.name === 'App probe'), JSON.stringify(posts.sent));
        assert(a.app === 'Netflix' && a.op === 'a=b' && /^nf\.app view/.test(a.detail), JSON.stringify(a));
        assert(posts.sent[1].result.app === 'Guide' && posts.sent[1].result.op === 'PreviewEndpoint=https://e/x', JSON.stringify(posts.sent[1]));
        const s = posts.sent[2].result;
        assert(/view: nf\.app/.test(s.op) && /eden_resume: none/.test(s.op), JSON.stringify(s));
      } finally { await lt.ctx.close(); }
    });

    await check('Watch link test: OK fires through /launch-control, the answer is kept and reaches the Pi', async () => {
      const lt = await env.newPage({});
      try {
        await H.openView(lt, 'linktests');
        await H.focusKey(lt, 'lt:run:netflix-view');
        await H.key(lt, 'Enter');
        await H.until(() => env.launches.some((l) => /launch-control/.test(l)), 3000, 'no launch-control');
        const l = env.launches.filter((x) => /launch-control/.test(x));
        assert(l[0] === 'launch-control 3201907018807 (with a uri)', l.join(' | '));
        await H.sleep(300);
        assert((await focusedKey(lt)) === 'lt:ans:netflix-view:title', await focusedKey(lt));
        await H.key(lt, 'ArrowRight');
        await H.key(lt, 'Enter');
        await H.sleep(800);
        const kept = await lt.evaluate(() => JSON.parse(localStorage.getItem('homeHub.linkTests')));
        assert(kept.results[0].id === 'netflix-view' && kept.results[0].outcome === 'app' && kept.results[0].sent === true, JSON.stringify(kept.results[0]));
        const pi = await getJson(env.LIVE + '/api/linktests', H.TOKEN);
        const got = (pi.data || pi).results || pi.results;
        assert(got && got[0].id === 'netflix-view' && got[0].outcome === 'app', JSON.stringify(pi).slice(0, 300));
        const logs = env.logs.join('\n');
        assert(/screen sent a watch link test answer \(app\)/.test(logs), logs);
        assert(!/netflix|https?:/i.test(logs), 'a log line has a link or a name: ' + logs);
        assert(/only opened the app/.test(await lt.evaluate(() => document.querySelector('[data-key="lt:run:netflix-view"] .lt-state').textContent)), 'state text');
      } finally { await lt.ctx.close(); }
    });

    await check('Watch link test: a failed or out-of-date TV helper is said on the row until a key, and kept at the top (EN and ES)', async () => {
      const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
      const rowErr = (p) => p.evaluate(() => { const e = document.querySelector('[data-key="lt:run:netflix-view"] .lt-rowerr'); return e ? e.textContent : ''; });
      const top = (p) => p.evaluate(() => { const e = document.querySelector('#panel .lt-lasterr'); return e ? e.textContent : ''; });
      const unit = await env.newPage({});
      try {
        const u = await unit.evaluate(() => { const o = window.HUB_LINKTEST._test.isOlder; return [o('0.29.9', 'v0.29.10'), o('0.29.10', 'v0.29.10'), o('0.30.0', 'v0.29.10'), o('preview', 'v0.29.10'), o('0.28.12', 'v0.29.0')]; });
        assert(JSON.stringify(u) === '[true,false,false,false,true]', JSON.stringify(u));
      } finally { await unit.ctx.close(); }
      for (const lang of ['en', 'es']) {
        const lt = await env.newPage(lang === 'es' ? { lang: 'es' } : {});
        try {
          // An old service: /ping says an older version, nothing is launched.
          await lt.route(/:8095\/ping/, (r) => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ ok: true, version: '0.1.0' }) }));
          await H.openView(lt, 'linktests');
          await H.focusKey(lt, 'lt:run:netflix-view');
          const before = env.launches.filter((x) => /launch-control/.test(x)).length;
          await H.key(lt, 'Enter');
          await H.until(async () => (await rowErr(lt)) !== '', 3000, 'no message on the row');
          const stale = lang === 'es' ? 'El ayudante de la TV está desactualizado. Desconecta la TV 30 segundos y vuelve a intentarlo.' : 'The TV helper is out of date. Unplug the TV for 30 seconds, then try again.';
          assert((await rowErr(lt)) === stale, await rowErr(lt));
          assert((await top(lt)).indexOf(stale) > 0, 'top line: ' + await top(lt));
          assert(env.launches.filter((x) => /launch-control/.test(x)).length === before, 'fired against an old helper');
          // Stays until a key; then the row clears and the top line stays.
          await H.sleep(1200);
          assert((await rowErr(lt)) === stale, 'row message went by itself');
          await H.key(lt, 'ArrowDown');
          await H.sleep(300);
          assert((await rowErr(lt)) === '' && (await top(lt)) !== '', 'row: ' + await rowErr(lt) + ' top: ' + await top(lt));
          if (lang === 'en') {
            // A service with no /launch-control (404) says the same; another error is quoted.
            await lt.unroute(/:8095\/ping/);
            await lt.route(/:8095\/launch-control/, (r) => r.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'not found' }) }));
            await H.focusKey(lt, 'lt:run:netflix-view');
            await H.key(lt, 'Enter');
            await H.until(async () => (await rowErr(lt)) !== '', 3000, 'no message for a 404');
            assert((await rowErr(lt)) === stale, await rowErr(lt));
            await H.key(lt, 'ArrowDown');
            await H.sleep(300);
            await lt.unroute(/:8095\/launch-control/);
            await lt.route(/:8095\/launch-control/, (r) => r.fulfill({ status: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'boom' }) }));
            await H.focusKey(lt, 'lt:run:netflix-view');
            await H.key(lt, 'Enter');
            await H.until(async () => (await rowErr(lt)) !== '', 3000, 'no message for an error');
            assert((await rowErr(lt)) === 'Couldn’t open: boom', await rowErr(lt));
            assert((await top(lt)) === 'Last error: Couldn’t open: boom', await top(lt));
          }
        } finally { await lt.ctx.close(); }
      }
    });

    await check('Watch link test: tests are grouped by app and numbered with a total, an answer names the app it opened, and a plain open uses /launch and still asks what happened', async () => {
      const lt = await env.newPage({});
      try {
        const v = await lt.evaluate(() => {
          const t = window.HUB_LINKTEST._test;
          const r = t.recipes();
          return { ids: r.map((x) => x.id), about: window.HUB_LINKTEST.aboutText(), netflixWatch: r.filter((x) => x.id === 'netflix-watch-resume')[0].val, def: r.filter((x) => x.id === 'appletv-default-op')[0].op, plain: r.filter((x) => x.plain).map((x) => x.id + ':' + x.op + ':' + x.key) };
        });
        assert(v.ids.join() === 'prime-resume,plain-prime,netflix-resume,netflix-view,netflix-watch-resume,netflix-json-resume,netflix-default-op,plain-netflix,appletv-view,appletv-resume,appletv-fam,appletv-resume-url,appletv-default-op,plain-appletv,disney-view,disney-resume,plain-disney,hulu-view,plain-hulu,peacock-view,plain-peacock', v.ids.join());
        assert(v.ids.length === 21 && /^OK to open · 0 of \d+ tried$/.test(v.about), v.about);
        assert(v.netflixWatch === 'm=https://www.netflix.com/watch/81505776&source_type=4' && v.def === 'http://tizen.org/appcontrol/operation/default', JSON.stringify(v));
        assert(v.plain.length === 6 && v.plain.every((x) => /::undefined$/.test(x) || /:$/.test(x) || /::$/.test(x) || x.split(':')[1] === ''), v.plain.join());
        await H.openView(lt, 'linktests');
        const nums = await lt.evaluate(() => ({ total: document.querySelector('.lt-total').textContent, nums: [].map.call(document.querySelectorAll('.lt-row .lt-num'), (n) => n.textContent) }));
        assert(/^21 tests/.test(nums.total) && nums.nums.join() === Array.from({ length: 21 }, (_, i) => String(i + 1)).join(), JSON.stringify(nums));
        await H.focusKey(lt, 'lt:run:plain-netflix');
        const nc = env.launches.filter((x) => /launch-control/.test(x)).length;
        const nl = env.launches.length;
        await H.key(lt, 'Enter');
        await H.until(() => env.launches.length > nl, 3000, 'no /launch');
        assert(/^launch /.test(env.launches[env.launches.length - 1]), env.launches.join(' | '));
        assert(env.launches.filter((x) => /launch-control/.test(x)).length === nc, 'a plain open used an app control');
        await H.sleep(300);
        assert((await focusedKey(lt)) === 'lt:ans:plain-netflix:title', await focusedKey(lt));
        // The answer names the app it opened (name and id on this TV).
        await H.key(lt, 'ArrowRight');
        await H.key(lt, 'Enter');
        await H.until(() => lt.evaluate(() => { const d = JSON.parse(localStorage.getItem('homeHub.linkTests') || 'null'); return !!(d && d.results && d.results[0] && d.results[0].id === 'plain-netflix'); }), 3000, 'no answer kept');
        const det = await lt.evaluate(() => JSON.parse(localStorage.getItem('homeHub.linkTests')).results[0].detail || '');
        assert(/^opened Netflix \d+/.test(det), det);
      } finally { await lt.ctx.close(); }
    });

    await check('Watch link test: OK in About opens it even when the About strip is full and its row gave way', async () => {
      const lt = await env.newPage({});
      try {
        await lt.evaluate(() => window.HUB_TEST.about.open());
        await H.sleep(500);
        // A short strip: the spare row leaves at the next refresh.
        await lt.evaluate(() => { const b = document.querySelector('#about .about-box'); b.style.maxHeight = '60px'; b.style.height = '60px'; b.style.overflow = 'hidden'; });
        await H.until(() => lt.evaluate(() => window.HUB_TEST.about.rows().filter((r) => r.label === 'Watch link test').length === 0), 4000, 'the row did not give way');
        await H.key(lt, 'Enter');
        await H.until(() => lt.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy() && !!document.querySelector('#panel .lt')), 6000, 'the link test did not open');
      } finally { await lt.ctx.close(); }
    });

    await check('Apps: Samsung placeholders (an id ending in "dummy") never stand for an app: Apple TV is the real one', async () => {
      const lt = await env.newPage({});
      try {
        const v = await lt.evaluate(() => { const h = window.HUB_LINKTEST._test.state().host; return { a: h.findApp(['Apple TV', 'Apple TV+']), d: h.apps().filter((x) => /dummy$/.test(x.id)).length }; });
        assert(v.d === 1 && v.a && v.a.id === '3201807016597', JSON.stringify(v));
      } finally { await lt.ctx.close(); }
    });

    await check('Watch link test: the Prime id box keeps a typed id and refuses a bad one', async () => {
      const lt = await env.newPage({});
      try {
        await H.openView(lt, 'linktests');
        const v = await lt.evaluate(() => {
          const T = window.HUB_LINKTEST._test;
          const out = {};
          out.box = document.querySelector('#panel .lt-input').value;
          out.bad = T.setId('primeGti', 'has a space');
          out.good = T.setId('primeGti', 'amzn1.dv.gti.00000000-0000-0000-0000-000000000000');
          out.val = T.recipes()[0].val;
          out.other = T.setId('netflixTitle', '1');
          T.setId('primeGti', '');
          out.back = T.recipes()[0].val;
          return out;
        });
        assert(v.box === 'amzn1.dv.gti.50f41028-8256-4293-9d0d-14556b501136', v.box);
        assert(typeof v.bad === 'string' && v.good === null && typeof v.other === 'string', JSON.stringify(v));
        assert(v.val === '{"values":"amzn1.dv.gti.00000000-0000-0000-0000-000000000000"}' && /50f41028/.test(v.back), JSON.stringify(v));
      } finally { await lt.ctx.close(); }
    });
    await check('Count badges: in the panel, full screen and every tile size, matching availability(), inside the icon, live', async () => {
      const BADGES = () => {
        const avail = window.HUB_SHOWS.availability();
        const labels = {};
        (window.HUB_CONFIG.widgets.entertainment.sections || []).forEach((s) => s.items.forEach((i) => { if (i.kind === 'app') labels[i.label] = true; }));
        const nodes = document.querySelectorAll('#panel .ent-item');
        const got = {};
        let outside = 0;
        let hidden = 0;
        Array.prototype.forEach.call(nodes, (n) => {
          const b = n.querySelectorAll('.ent-count');
          const name = n.querySelector('.ent-name').textContent;
          if (b.length > 1) hidden++;
          if (b.length) {
            got[name] = Number(b[0].textContent);
            const f = n.querySelector('.logo').getBoundingClientRect();
            const q = b[0].getBoundingClientRect();
            if (q.right > f.right + 0.5 || q.left < f.left - 0.5 || q.top < f.top - 0.5 || q.bottom > f.bottom + 0.5) outside++;
            if (q.height < 20) hidden++;
          }
        });
        return { avail: avail, labels: labels, got: got, outside: outside, hidden: hidden };
      };
      const p = await env.newPage({});
      try {
        await H.openGrid(p);
        let v = await p.evaluate(BADGES);
        let want = {};
        Object.keys(v.avail).forEach((k) => { if (v.avail[k] && v.labels[k]) want[k] = v.avail[k]; });
        assert(Object.keys(want).length === 3 && JSON.stringify(v.got, Object.keys(v.got).sort()) === JSON.stringify(want, Object.keys(want).sort()), 'panel: ' + JSON.stringify(v.got) + ' vs ' + JSON.stringify(want));
        assert(v.outside === 0 && v.hidden === 0, 'panel badges outside the icon or doubled: ' + JSON.stringify(v));
        // New data while the panel is open: the badges follow.
        await p.evaluate(() => window.HUB_SHOWS._test.setData({ v: 1, updatedAt: '2026-11-17T12:00:00Z', shows: [{ id: 'x', name: 'X', service: 'Netflix', checkedAt: '2026-11-17T12:00:00Z', upcoming: [{ season: 1, number: 2, airstamp: '2026-11-18T03:30:00Z' }] }] }));
        await H.sleep(500);
        v = await p.evaluate(BADGES);
        assert(JSON.stringify(v.got) === '{"Netflix":1}', 'live update: ' + JSON.stringify(v.got));
        await p.evaluate(() => window.HUB_SHOWS._test.setData({ v: 1, updatedAt: '2026-11-17T12:00:00Z', shows: [] }));
        await H.sleep(500);
        v = await p.evaluate(BADGES);
        assert(Object.keys(v.got).length === 0, 'cleared: ' + JSON.stringify(v.got));
      } finally { await p.ctx.close(); }
      const f = await env.newPage({});
      try {
        await H.openGrid(f);
        await H.fullScreen(f);
        const v = await f.evaluate(BADGES);
        const want = {};
        Object.keys(v.avail).forEach((k) => { if (v.avail[k] && v.labels[k]) want[k] = v.avail[k]; });
        assert(Object.keys(want).length === 3 && JSON.stringify(v.got, Object.keys(v.got).sort()) === JSON.stringify(want, Object.keys(want).sort()), 'full: ' + JSON.stringify(v.got));
        assert(v.outside === 0 && v.hidden === 0, 'full screen badges outside the icon: ' + JSON.stringify(v));
      } finally { await f.ctx.close(); }
      // Tile sizes: every logo shown for an app with shows has its count, inside the logo.
      const seen = [];
      for (const [w, h] of [[2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 3], [3, 4], [6, 4]]) {
        const layout = [{ widget: 'entertainment', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: w === 12 ? 0 : w, y: w === 12 ? 1 : 0, w: 3, h: 2 }];
        const t = await env.newPage({ layout: layout });
        try {
          await H.sleep(500);
          const v = await t.evaluate(() => {
            const avail = window.HUB_SHOWS.availability();
            const chips = document.querySelectorAll('.cell[data-widget="entertainment"] .ent-chip:not(.is-blank) .logo:not(.ent-more)');
            let n = 0; let bad = 0; let shownWithShows = 0;
            Array.prototype.forEach.call(chips, (l) => {
              const b = l.querySelector('.ent-count');
              const c = l.parentNode;
              if (b) {
                n++;
                const f = l.getBoundingClientRect(); const q = b.getBoundingClientRect();
                if (q.right > f.right + 0.5 || q.left < f.left - 0.5 || q.top < f.top - 0.5 || q.bottom > f.bottom + 0.5) bad++;
              }
            });
            const total = Object.keys(avail).filter((k) => avail[k] && /^(Apple TV|Netflix|Disney\+)$/.test(k)).length;
            return { n: n, bad: bad, chips: chips.length, total: total, sum: Array.prototype.reduce.call(document.querySelectorAll('.cell[data-widget="entertainment"] .ent-count'), (a, b) => a + Number(b.textContent), 0) };
          });
          seen.push(w + 'x' + h + ':' + v.n);
          assert(v.bad === 0, w + 'x' + h + ': badge outside its logo');
          // Counted apps come first, so each one that fits has its badge.
          assert(v.n === Math.min(v.total, v.chips), w + 'x' + h + ': ' + v.n + ' badges, ' + v.total + ' apps with shows, ' + v.chips + ' logos');
          assert(v.sum === v.n, w + 'x' + h + ': a badge count differs from availability()');
        } finally { await t.ctx.close(); }
      }
      assert(seen.length === 10, seen.join(' '));
    });


    // ---------- "Did you finish?" ----------
    const NO_ANSWERS = ['the-great-british-baking-show', 'the-pitt'];
    const startedOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('homeHub.watch.v1') || '[]'));
    const outboxOf = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('homeHub.watch.out.v1') || '[]'));
    const piShow = async (id) => (await getJson(env.LIVE + '/live/state')).resources.shows.data.shows.filter((x) => x.id === id)[0];
    const piMarked = async (id, n) => (await piShow(id)).upcoming.some((e) => e.watched && e.number === n);
    const finLines = (p) => p.evaluate(() => [].map.call(document.querySelectorAll('.sh-fin-line'), (l) => l.querySelector('.sh-fin-text').textContent + ' | ' + [].map.call(l.querySelectorAll('.sh-fin-btn'), (b) => b.textContent).join(' / ')));
    const finKeys = (p) => p.evaluate(() => [].map.call(document.querySelectorAll('.sh-fin-line .sh-fin-btn:first-child'), (b) => b.getAttribute('data-key')));
    const postsOf = (p) => { const out = []; p.on('request', (r) => { if (r.method() === 'POST' && /\/shows\//.test(r.url())) out.push(r.url().replace(/^.*:\d+/, '')); }); return out; };
    const postPi = (route, body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const rq = http.request(env.LIVE + route, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: env.PAGE } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rq.on('error', reject);
      rq.end(data);
    });
    // The Pi is shared by these checks: marks made by one are taken off again.
    const unmarkAll = async () => { for (const [id, s, n] of [['the-great-british-baking-show', 16, 9], ['shark-tank', 17, 6], ['hells-kitchen', 24, 8]]) await postPi('/shows/unwatch', { id: id, season: s, number: n }); await H.sleep(300); };
    const SIX = [['the-pitt', 2, 6, 40], ['slow-horses', 5, 5, 2], ['the-great-british-baking-show', 16, 9, 20], ['slow-horses', 5, 4, 3], ['hells-kitchen', 24, 8, 1]];

    await check('Watch adds one started line, twice is still one; nothing is timed, asked or sent to the TV service', async () => {
      const wp = await env.newPage({});
      try {
        const service = [];
        wp.on('request', (r) => { if (/:8095\/(running|watch-track)/.test(r.url()) || /:8095\//.test(r.url()) && /watch|running/.test(r.url())) service.push(r.url()); });
        await H.openSchedule(wp, 'week');
        // Paradise has not aired yet (35 minutes to go): nothing is kept.
        await H.focusKey(wp, 'sh:row:paradise:');
        let before = env.launches.length;
        await H.key(wp, 'Enter');
        await H.until(() => env.launches.length > before, 3500, 'no launch');
        assert((await startedOf(wp)).length === 0, 'kept an episode that has not aired');
        // The Great British Baking Show S16 E9 is out.
        await H.focusKey(wp, 'sh:row:the-great-british-baking-show:');
        before = env.launches.length;
        await H.key(wp, 'Enter');
        await H.until(() => env.launches.length > before, 3500, 'no launch');
        let list = await startedOf(wp);
        assert(list.length === 1 && JSON.stringify(Object.keys(list[0]).sort()) === '["number","season","showId","startedAt"]', JSON.stringify(list));
        assert(list[0].showId === 'the-great-british-baking-show' && list[0].season === 16 && list[0].number === 9 && Math.abs(list[0].startedAt - H.TUESDAY) < 60000, JSON.stringify(list));
        // The same episode again: still one.
        before = env.launches.length;
        await H.key(wp, 'Enter');
        await H.until(() => env.launches.length > before, 3500, 'no second launch');
        list = await startedOf(wp);
        assert(list.length === 1, 'pressed twice: ' + JSON.stringify(list));
        // A show row (Coming soon) with no episode: its earliest one out and not watched, Slow Horses S5 E4.
        await H.openSchedule(wp, 'soon').catch(() => {});
        await wp.evaluate(() => window.HUB_SHOWS._test.tab('soon'));
        await wp.evaluate(() => window.HUB_TEST.closePanel());
        await H.sleep(500);
        await H.openSchedule(wp, 'soon');
        await H.focusKey(wp, 'sh:show:slow-horses');
        before = env.launches.length;
        await H.key(wp, 'Enter');
        await H.until(() => env.launches.length > before, 3500, 'no launch from the show row');
        list = await startedOf(wp);
        assert(list.length === 2 && list.some((r) => r.showId === 'slow-horses' && r.season === 5 && r.number === 4), JSON.stringify(list));
        assert(service.length === 0, 'the TV service was called: ' + service.join(' '));
        assert(await wp.evaluate(() => !document.querySelector('.sh-ask') && typeof window.HUB_SHOWS._test.checkTracked === 'undefined' && typeof window.HUB_SHOWS.trackText === 'undefined'), 'tracking code is still there');
        // The strip lists both when the Schedule is open; the tile says 2.
        await H.sleep(600);
        assert((await finLines(wp)).length === 2, JSON.stringify(await finLines(wp)));
        assert(await wp.evaluate(() => document.querySelector('.cell[data-widget="entertainment"] .ent-check').textContent) === '2', 'the tile count');
        assert(pageErrors(wp).length === 0, pageErrors(wp).join(' | '));
      } finally { await wp.ctx.close(); }
    });

    await check('"N to check" on the tile at every size (a pill with words from three columns, a count dot in a strip or a narrow tile), and on the Schedule item in the panel and full screen (EN and ES)', async () => {
      const seen = [];
      const SIZES = [[1, 1], [2, 1], [3, 1], [6, 1], [12, 1], [2, 2], [3, 2], [6, 2], [3, 3], [3, 4], [6, 4]];
      for (const [w, h] of SIZES) {
        const layout = [{ widget: 'entertainment', x: 0, y: 0, w: w, h: h }, { widget: 'today', x: w === 12 ? 0 : w, y: w === 12 ? 1 : 0, w: 3, h: 2 }];
        const t = await env.newPage({ layout: layout, started: SIX.slice(0, 3) });
        try {
          await H.sleep(500);
          const v = await t.evaluate(() => {
            const tile = document.querySelector('.cell[data-widget="entertainment"] .tile');
            const tr = tile.getBoundingClientRect();
            const b = tile.querySelectorAll('.ent-check');
            const q = b.length ? b[0].getBoundingClientRect() : null;
            let overlap = 0;
            let outside = 0;
            Array.prototype.forEach.call(tile.querySelectorAll('.ent-chip:not(.is-blank)'), (c) => {
              const r = c.getBoundingClientRect();
              if (r.bottom > tr.bottom + 0.5 || r.right > tr.right + 0.5 || r.left < tr.left - 0.5) outside++;
              if (q && b[0].className.indexOf('is-dot') < 0 && r.top < q.bottom - 1 && r.bottom > q.top + 1 && r.left < q.right && r.right > q.left) overlap++;
            });
            return { n: b.length, text: b.length ? b[0].textContent : '', dot: b.length ? /is-dot/.test(b[0].className) : null,
              inside: !!q && q.left >= tr.left - 0.5 && q.right <= tr.right + 0.5 && q.top >= tr.top - 0.5 && q.bottom <= tr.bottom + 0.5,
              clipped: b.length ? b[0].scrollWidth > b[0].clientWidth + 1 : null, overlap: overlap, outside: outside, size: tile.className };
          });
          const wantDot = h === 1 || w < 3;
          seen.push(w + 'x' + h + ':' + v.text);
          assert(v.n === 1 && v.inside && !v.clipped && v.overlap === 0 && v.outside === 0, w + 'x' + h + ': ' + JSON.stringify(v));
          assert(v.dot === wantDot && v.text === (wantDot ? '3' : '3 to check'), w + 'x' + h + ' says ' + v.text + ' (dot ' + v.dot + ')');
        } finally { await t.ctx.close(); }
      }
      assert(seen.length === SIZES.length, seen.join(' '));
      // Spanish, 6x2: the pill fits whole.
      const es = await env.newPage({ lang: 'es', started: SIX.slice(0, 3), layout: [{ widget: 'entertainment', x: 0, y: 0, w: 6, h: 2 }, { widget: 'today', x: 6, y: 0, w: 3, h: 2 }] });
      try {
        await H.sleep(500);
        const v = await es.evaluate(() => { const b = document.querySelector('.cell[data-widget="entertainment"] .ent-check'); const t = document.querySelector('.cell[data-widget="entertainment"] .tile').getBoundingClientRect(); const q = b.getBoundingClientRect(); return { text: b.textContent, clipped: b.scrollWidth > b.clientWidth + 1, inside: q.right <= t.right && q.left >= t.left }; });
        assert(v.text === '3 por revisar' && !v.clipped && v.inside, JSON.stringify(v));
      } finally { await es.ctx.close(); }
      // The Schedule item: a count on its icon and "3 to check" under it, in the panel and full screen; without lines, neither.
      for (const [lang, word] of [['en', '3 to check'], ['es', '3 por revisar']]) {
        const p = await env.newPage(lang === 'es' ? { lang: 'es', started: SIX.slice(0, 3) } : { started: SIX.slice(0, 3) });
        try {
          for (const full of [false, true]) {
            await H.openGrid(p);
            if (full) await H.fullScreen(p);
            const v = await p.evaluate(() => {
              const it = [].filter.call(document.querySelectorAll('#panel .ent-item'), (n) => n.querySelector('.ent-name').textContent !== '' && n.querySelector('.ent-state') && /por revisar|to check|Tus series|Your shows/.test(n.textContent))[0];
              const b = it.querySelectorAll('.ent-count');
              const f = it.querySelector('.logo').getBoundingClientRect();
              const q = b.length ? b[0].getBoundingClientRect() : null;
              return { text: it.querySelector('.ent-state').textContent, count: b.length ? b[0].textContent : '', inside: !!q && q.right <= f.right + 0.5 && q.top >= f.top - 0.5 };
            });
            assert(v.text === word && v.count === '3' && v.inside, lang + (full ? ' full' : ' panel') + ': ' + JSON.stringify(v));
            await p.evaluate(() => window.HUB_TEST.closePanel());
            await H.sleep(600);
          }
        } finally { await p.ctx.close(); }
      }
      const none = await env.newPage({});
      try {
        await H.openGrid(none);
        const v = await none.evaluate(() => ({ checks: document.querySelectorAll('.ent-check').length, text: [].filter.call(document.querySelectorAll('#panel .ent-state'), (n) => /to check/.test(n.textContent)).length }));
        assert(v.checks === 0 && v.text === 0, 'nothing started, nothing to check: ' + JSON.stringify(v));
      } finally { await none.ctx.close(); }
    });

    await check('The strip: sorted by show title (case-insensitive, "The " ignored), then season and episode; "started when" in words; EN and ES texts', async () => {
      const p = await env.newPage({ started: SIX });
      try {
        await H.openSchedule(p, 'week');
        const want = [
          'The Great British Baking Show · S16 E9 · started last night | Watched / Not yet',
          'Hell’s Kitchen · S24 E8 · started tonight | Watched / Not yet',
          'The Pitt · S2 E6 · started yesterday | Watched / Not yet',
          'Slow Horses · S5 E4 · started earlier today | Watched / Not yet',
          'Slow Horses · S5 E5 · started tonight | Watched / Not yet'
        ];
        const got = await finLines(p);
        assert(JSON.stringify(got.map((x) => x.replace(/'/g, '’'))) === JSON.stringify(want), JSON.stringify(got));
        assert(await p.evaluate(() => document.querySelector('.sh-fin-head').textContent) === 'Did you finish?', 'title');
        // The sort ignores case and a leading "The ", with names of every kind.
        const order = await p.evaluate(() => {
          const T = window.HUB_SHOWS._test;
          const ep = [{ season: 1, number: 2, airstamp: '2026-11-19T03:00:00Z' }];
          const mk = (id, name) => ({ id: id, name: name, service: 'Netflix', checkedAt: '2026-11-17T12:00:00Z', upcoming: ep, watched: [] });
          const d = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
          d.shows = [mk('b', 'beta'), mk('a', 'Alpha'), mk('c', 'The Gamma'), mk('d', 'the alpha show'), mk('e', 'ZETA'), mk('f', 'The Beta Two')];
          T.setData(d);
          const t = window.HUB_TEST ? Date.now() : Date.now();
          localStorage.setItem('homeHub.watch.v1', JSON.stringify(d.shows.map((s, i) => ({ showId: s.id, season: 1, number: 2 - (s.id === 'a' ? 0 : 0), startedAt: t - (i + 1) * 3600000 })).concat([{ showId: 'a', season: 1, number: 1, startedAt: t - 3600000 }, { showId: 'a', season: 0, number: 9, startedAt: t - 3600000 }])));
          return T.finishLines(t).map((l) => l.show.name + ' S' + l.rec.season + 'E' + l.rec.number);
        });
        assert(JSON.stringify(order) === JSON.stringify(['Alpha S0E9', 'Alpha S1E1', 'Alpha S1E2', 'the alpha show S1E2', 'beta S1E2', 'The Beta Two S1E2', 'The Gamma S1E2', 'ZETA S1E2']), JSON.stringify(order));
        // When, in words (now is Tuesday 7:25 PM in Chicago).
        const when = await p.evaluate(() => {
          const T = window.HUB_SHOWS._test;
          const now = Date.parse('2026-11-18T01:25:00Z');
          return [['2026-11-17T05:00:00Z'], ['2026-11-18T00:00:00Z'], ['2026-11-17T16:00:00Z'], ['2026-11-17T08:00:00Z'], ['2026-11-16T20:00:00Z'], ['2026-11-16T08:00:00Z'], ['2026-11-16T03:00:00Z'], ['2026-11-13T20:00:00Z']].map((a) => T.startedText(Date.parse(a[0]), now));
        });
        assert(JSON.stringify(when) === JSON.stringify(['started last night', 'started tonight', 'started earlier today', 'started last night', 'started yesterday', 'started yesterday', 'started Sun', 'started Fri']), JSON.stringify(when));
      } finally { await p.ctx.close(); }
      const es = await env.newPage({ lang: 'es', started: SIX });
      try {
        await H.openSchedule(es, 'week');
        const got = await finLines(es);
        assert(got[0] === 'The Great British Baking Show · T16 E9 · empezó anoche | Visto / Todavía no', got[0]);
        assert(got[3] === 'Slow Horses · T5 E4 · empezó hoy más temprano | Visto / Todavía no' && got[2].indexOf('empezó ayer') > 0, got.join(' ## '));
        assert(await es.evaluate(() => document.querySelector('.sh-fin-head').textContent) === '¿Lo terminaste?', 'title');
        const day = await es.evaluate(() => window.HUB_SHOWS._test.startedText(Date.parse('2026-11-16T03:00:00Z'), Date.parse('2026-11-18T01:25:00Z')));
        assert(day === 'empezó el domingo', day);
      } finally { await es.ctx.close(); }
    });

    await check('Watched tells the Pi and the row becomes watched; Not yet sends nothing; focus walks down the list and ends on the first Schedule row', async () => {
      const p = await env.newPage({ started: [['hells-kitchen', 24, 8, 40], ['shark-tank', 17, 6, 3], ['the-great-british-baking-show', 16, 9, 20]] });
      try {
        const posts = postsOf(p);
        await H.openSchedule(p, 'week');
        assert(await focusedKey(p) === 'sh:fin:yes:the-great-british-baking-show:16:9', 'first focus: ' + await focusedKey(p));
        assert(!(await piMarked('the-great-british-baking-show', 9)), 'marked early');
        const marks = () => env.logs.filter((l) => /screen marked an episode watched/.test(l)).length;
        const m0 = marks();
        await H.key(p, 'Enter');
        await H.until(() => piMarked('the-great-british-baking-show', 9), 4000, 'the Pi never marked it');
        await H.until(async () => (await finLines(p)).length === 2, 3000, 'the line stayed');
        assert(await focusedKey(p) === 'sh:fin:yes:hells-kitchen:24:8', 'focus after Watched: ' + await focusedKey(p));
        await H.until(() => p.evaluate(() => !!document.querySelector('[data-key^="sh:row:the-great-british-baking-show:"].is-watched')), 4000, 'the row is not marked watched');
        assert((await startedOf(p)).length === 2, 'the list kept the answered line');
        assert(JSON.stringify(posts) === '["/shows/watched"]', JSON.stringify(posts));
        // Not yet: Right, OK. Nothing is sent, nothing marked.
        await H.key(p, 'ArrowRight');
        assert(await focusedKey(p) === 'sh:fin:no:hells-kitchen:24:8', 'Right: ' + await focusedKey(p));
        await H.key(p, 'Enter');
        await H.until(async () => (await finLines(p)).length === 1, 3000, 'Not yet kept the line');
        assert(await focusedKey(p) === 'sh:fin:yes:shark-tank:17:6', 'focus after Not yet: ' + await focusedKey(p));
        await H.sleep(800);
        assert(JSON.stringify(posts) === '["/shows/watched"]' && marks() === m0 + 1, 'Not yet reached the Pi: ' + JSON.stringify(posts));
        assert((await startedOf(p)).length === 1, 'Not yet kept it in the list');
        // The last line: Watched, the strip goes and focus is the first Schedule row.
        await H.key(p, 'Enter');
        await H.until(() => piMarked('shark-tank', 6), 4000, 'the Pi never marked Shark Tank');
        await H.until(() => p.evaluate(() => !document.querySelector('.sh-fin')), 3000, 'the strip stayed');
        assert((await focusedKey(p)).indexOf('sh:row:paradise:') === 0, 'focus at the end: ' + await focusedKey(p));
        assert((await startedOf(p)).length === 0 && JSON.stringify(posts) === '["/shows/watched","/shows/watched"]', JSON.stringify(posts));
        assert(await p.evaluate(() => document.querySelectorAll('.cell[data-widget="entertainment"] .ent-check').length) === 0, 'the tile still says to check');
        const logs = env.logs.join('\n');
        assert(/screen marked an episode watched/.test(logs) && !/netflix|baking|hell|shark|S16|S17|3201907018807/i.test(logs), logs);
        assert(!(await piMarked('hells-kitchen', 8)), 'Not yet marked Hell’s Kitchen');
        assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
      } finally { await p.ctx.close(); await unmarkAll(); }
    });

    await check('Marks keep trying until the Pi answers: the row shows watched at once, the mark waits in homeHub.watch.out.v1 and goes through later', async () => {
      const p = await env.newPage({ started: [['the-great-british-baking-show', 16, 9, 20]] });
      try {
        await p.route(/:\d+\/shows\/(watched|unwatch)/, (r) => r.abort());
        await H.openSchedule(p, 'week');
        await H.key(p, 'Enter');
        await H.sleep(900);
        assert((await finLines(p)).length === 0, 'the line stayed');
        let out = await outboxOf(p);
        assert(out.length === 1 && out[0].op === 'watched' && out[0].showId === 'the-great-british-baking-show' && out[0].season === 16 && out[0].number === 9, JSON.stringify(out));
        assert(await p.evaluate(() => !!document.querySelector('[data-key^="sh:row:the-great-british-baking-show:"].is-watched')), 'the row does not show it while the Pi is out of reach');
        assert(await p.evaluate(() => window.HUB_SHOWS.availability().Netflix === undefined), 'the count still has it');
        assert(!(await piMarked('the-great-british-baking-show', 9)), 'the Pi has it already');
        await p.unroute(/:\d+\/shows\/(watched|unwatch)/);
        await p.evaluate(() => window.HUB_SHOWS._test.flushOut());
        await H.until(() => piMarked('the-great-british-baking-show', 9), 4000, 'the Pi never got it');
        await H.until(async () => (await outboxOf(p)).length === 0, 3000, 'the mark stayed in the outbox');
        assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
      } finally { await p.ctx.close(); await unmarkAll(); }
    });

    await check('A line goes after 7 days, at most 20 are kept, and a line the Pi already has as watched goes by itself', async () => {
      // 6.9 days stays, 7.1 days goes.
      let p = await env.newPage({ started: [['the-great-british-baking-show', 16, 9, 165], ['the-pitt', 2, 6, 171]] });
      try {
        await H.openSchedule(p, 'week');
        const got = await finLines(p);
        assert(got.length === 1 && got[0].indexOf('The Great British Baking Show · S16 E9 · started ') === 0, JSON.stringify(got));
        const kept = await startedOf(p);
        assert(kept.length === 1 && kept[0].showId === 'the-great-british-baking-show', 'the old one stayed in storage: ' + JSON.stringify(kept));
      } finally { await p.ctx.close(); }
      // 25 started: the newest 20 stay.
      const many = [];
      for (let i = 1; i <= 25; i++) many.push(['slow-horses', 1, i, i]);
      p = await env.newPage({ started: many });
      try {
        await H.openSchedule(p, 'week');
        const kept = await startedOf(p);
        assert(kept.length === 20 && Math.min.apply(null, kept.map((r) => r.number)) === 1 && Math.max.apply(null, kept.map((r) => r.number)) === 20, kept.length + ' kept: ' + kept.map((r) => r.number).join(','));
        assert((await finLines(p)).length === 20, 'lines: ' + (await finLines(p)).length);
        // One more Watch press makes room: still 20.
        await p.evaluate(() => { const T = window.HUB_SHOWS._test; const d = JSON.parse(localStorage.getItem('homeHub.shows.v1')); T.noteStarted(d.shows.filter((s) => s.id === 'slow-horses')[0], []); });
        const after = await startedOf(p);
        assert(after.length === 20 && after.some((r) => r.season === 5 && r.number === 4) && !after.some((r) => r.season === 1 && r.number === 20), 'after one more: ' + after.length + ' (the oldest goes)');
      } finally { await p.ctx.close(); }
      // The Pi says watched while the strip is open: the line goes by itself.
      p = await env.newPage({ started: [['the-great-british-baking-show', 16, 9, 20], ['the-pitt', 2, 6, 40]] });
      try {
        await H.openSchedule(p, 'week');
        assert((await finLines(p)).length === 2, 'two lines first');
        assert(await postPi('/shows/watched', { id: 'the-great-british-baking-show', season: 16, number: 9 }) === 200, 'the Pi refused');
        await H.until(async () => (await finLines(p)).length === 1, 5000, 'the line stayed after the Pi marked it');
        const left = await finLines(p);
        assert(left[0].indexOf('The Pitt') === 0, left[0]);
        assert((await startedOf(p)).length === 1, 'the list kept it');
        // Marked on the Pi before the hub opens (cache and all): never listed.
        const q = await env.newPage({ started: [['the-great-british-baking-show', 16, 9, 20]] });
        try {
          await H.openSchedule(q, 'week');
          assert((await finLines(q)).length === 0 && (await startedOf(q)).length === 0, 'listed an episode the Pi has watched');
        } finally { await q.ctx.close(); }
      } finally { await p.ctx.close(); await unmarkAll(); }
    });

    await check('The check toggle: "Mark as up to date" after "Also on" marks the row and every earlier episode (POST /shows/upto); marked, it says "Mark as not watched" and takes only that episode off; the Show page chip follows it; none on a row still to come', async () => {
      // Its own Pi: an up-to mark can not be taken back with the shared one's helpers.
      const own = await H.start();
      const ownShow = async (id) => (await getJson(own.LIVE + '/live/state')).resources.shows.data.shows.filter((x) => x.id === id)[0];
      const p = await own.newPage({});
      try {
        const posts = postsOf(p);
        await H.openSchedule(p, 'week');
        // Give the Baking Show an "Also on" chip, so the toggle comes after it.
        await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('homeHub.shows.v1')); d.shows.forEach((s) => { if (s.id === 'the-great-british-baking-show') s.alsoOn = ['Hulu']; }); window.HUB_SHOWS._test.setData(d); });
        await H.sleep(500);
        assert(await p.evaluate(() => !document.querySelector('[data-key^="sh:mark:paradise:"]') && !!document.querySelector('[data-key^="sh:mark:slow-horses:"]') && !document.querySelector('[data-key^="sh:mark:the-pitt:"]')), 'toggles on the wrong rows');
        // The Show page chip is on every row, aired or not.
        assert(await p.evaluate(() => document.querySelectorAll('.sh-row').length === document.querySelectorAll('.sh-page').length), 'a chip per row');
        await H.focusKey(p, 'sh:row:the-great-british-baking-show:');
        await H.key(p, 'ArrowRight');
        assert((await focusedKey(p)).indexOf('sh:alt:the-great-british-baking-show:') === 0, 'Right goes to Also on first: ' + await focusedKey(p));
        await H.key(p, 'ArrowRight');
        const mk = await focusedKey(p);
        assert(mk.indexOf('sh:mark:the-great-british-baking-show:') === 0, 'then the toggle: ' + mk);
        assert(await p.evaluate(() => document.querySelector('#panel .is-focused .sh-mark-text').textContent) === 'Mark as up to date', 'label');
        await H.key(p, 'ArrowRight');
        const chip = await focusedKey(p);
        assert(chip.indexOf('sh:page:the-great-british-baking-show:') === 0, 'then the Show page chip: ' + chip);
        assert(await p.evaluate(() => document.querySelector('#panel .is-focused .sh-page-text').textContent) === 'Show page', 'chip label');
        await H.key(p, 'ArrowRight');
        assert(await focusedKey(p) === chip, 'Right past the chip moved');
        await H.key(p, 'ArrowLeft');
        assert(await focusedKey(p) === mk, 'Left from the chip');
        await H.key(p, 'Enter');
        await H.until(async () => { const pr = (await ownShow('the-great-british-baking-show')).progress; return pr.upTo && pr.upTo.number === 9; }, 4000, 'the Pi never marked it up to here');
        await H.until(() => p.evaluate(() => /is-watched/.test(document.querySelector('[data-key^="sh:row:the-great-british-baking-show:"]').className)), 3000, 'the row is not watched');
        let st = await p.evaluate(() => { const t = document.querySelector('[data-key^="sh:mark:the-great-british-baking-show:"]'); return { on: /is-on/.test(t.className), aria: t.getAttribute('aria-checked'), text: t.querySelector('.sh-mark-text').textContent, focused: /is-focused/.test(t.className) }; });
        assert(st.on && st.aria === 'true' && st.text === 'Mark as not watched' && st.focused, JSON.stringify(st));
        assert(JSON.stringify(posts) === '["/shows/upto"]', JSON.stringify(posts));
        // OK again: only this episode comes off, on the Pi's unwatch door.
        await H.key(p, 'Enter');
        await H.until(async () => (await ownShow('the-great-british-baking-show')).progress.unwatched.length === 1, 4000, 'the Pi kept the mark');
        await H.until(() => p.evaluate(() => !/is-watched/.test(document.querySelector('[data-key^="sh:row:the-great-british-baking-show:"]').className)), 3000, 'the row stayed watched');
        st = await p.evaluate(() => { const t = document.querySelector('[data-key^="sh:mark:the-great-british-baking-show:"]'); return { on: /is-on/.test(t.className), aria: t.getAttribute('aria-checked'), text: t.querySelector('.sh-mark-text').textContent }; });
        assert(!st.on && st.aria === 'false' && st.text === 'Mark as up to date', JSON.stringify(st));
        assert(JSON.stringify(posts) === '["/shows/upto","/shows/unwatch"]', JSON.stringify(posts));
        assert(own.logs.filter((l) => /screen took a watched mark off an episode$/.test(l)).length === 1, 'no unwatch line in the Pi log');
        assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
      } finally { await p.ctx.close(); await own.stop(); }
    });

    await check('Spanish: the strip, the buttons and the toggle fit at panel and full screen widths, wrap instead of clipping, and keep room for ¿ É ñ', async () => {
      const LONG = 'El increíble caso de la niña que perdió su ñandú ¿Quién lo sabe? Éxito total de la temporada';
      for (const full of [false, true]) {
        const p = await env.newPage({ lang: 'es', started: SIX });
        try {
          await H.openSchedule(p, 'week');
          if (full) await H.fullScreen(p);
          await p.evaluate((name) => {
            const d = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
            d.shows.push({ id: 'largo', name: name, service: 'Netflix', checkedAt: '2026-11-17T12:00:00Z', upcoming: [{ season: 12, number: 10, airstamp: '2026-11-17T20:00:00Z' }], watched: [] });
            const l = JSON.parse(localStorage.getItem('homeHub.watch.v1')); l.push({ showId: 'largo', season: 12, number: 10, startedAt: Date.now() - 5 * 86400000 });
            localStorage.setItem('homeHub.watch.v1', JSON.stringify(l));
            window.HUB_SHOWS._test.setData(d);
          }, LONG);
          await H.sleep(700);
          const v = await p.evaluate((long) => {
            const bad = [];
            const body = document.querySelector('#panel .panel-body');
            const strip = document.querySelector('.sh-fin');
            const br = body.getBoundingClientRect();
            if (!strip) return { bad: ['no strip'] };
            if (strip.getBoundingClientRect().right > br.right + 0.5 || body.scrollWidth > body.clientWidth + 1) bad.push('the strip or the body is wider than the panel');
            const lines = strip.querySelectorAll('.sh-fin-line');
            const names = [];
            Array.prototype.forEach.call(lines, (l) => {
              const lr = l.getBoundingClientRect();
              const text = l.querySelector('.sh-fin-text');
              const tr = text.getBoundingClientRect();
              names.push(text.textContent);
              if (text.scrollWidth > text.clientWidth + 1) bad.push('text wider than its box: ' + text.textContent);
              const btns = l.querySelector('.sh-fin-btns').getBoundingClientRect();
              if (tr.right > btns.left + 0.5) bad.push('text runs under the buttons');
              Array.prototype.forEach.call(l.querySelectorAll('.sh-fin-btn'), (b) => {
                const r = b.getBoundingClientRect();
                if (b.scrollWidth > b.clientWidth + 1 || r.right > lr.right + 0.5 || r.left < lr.left - 0.5) bad.push('button clipped: ' + b.textContent);
                const cs = getComputedStyle(b);
                if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.25) bad.push('button line height ' + cs.lineHeight);
              });
              const cs = getComputedStyle(text);
              if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.25) bad.push('text line height ' + cs.lineHeight);
            });
            Array.prototype.forEach.call(strip.querySelectorAll('*'), (n) => { const o = getComputedStyle(n); if (o.overflow !== 'visible' || o.overflowX !== 'visible') bad.push('overflow ' + o.overflow + ' on ' + n.className); });
            const head = strip.querySelector('.sh-fin-head');
            const hc = getComputedStyle(head);
            if (parseFloat(hc.lineHeight) < parseFloat(hc.fontSize) * 1.25) bad.push('head line height');
            const longLine = [].filter.call(lines, (l) => l.textContent.indexOf(long.slice(0, 20)) === 0)[0];
            const lh = longLine ? parseFloat(getComputedStyle(longLine.querySelector('.sh-fin-text')).lineHeight) : 0;
            const wraps = longLine ? longLine.querySelector('.sh-fin-text').getBoundingClientRect().height > lh * 1.5 : false;
            // The toggle's label (focused) is whole too.
            return { bad: bad, n: lines.length, wraps: wraps, names: names };
          }, LONG);
          assert(v.bad.length === 0 && v.n === 6 && (full || v.wraps), (full ? 'full: ' : 'panel: ') + JSON.stringify(v));
          // The toggle with its Spanish label, focused, stays inside its row's line.
          await H.focusKey(p, 'sh:row:the-great-british-baking-show:');
          await H.key(p, 'ArrowRight');
          const t = await p.evaluate(() => { const f = document.querySelector('#panel .is-focused'); const line = f.closest('.sh-line').getBoundingClientRect(); const r = f.getBoundingClientRect(); const x = f.querySelector('.sh-mark-text'); return { key: f.getAttribute('data-key'), text: x ? x.textContent : '', inside: r.right <= line.right + 0.5, clipped: x ? x.scrollWidth > x.clientWidth + 1 : null }; });
          assert(t.key.indexOf('sh:mark:') === 0 && t.text === 'Marcar como al día' && t.inside && !t.clipped, JSON.stringify(t));
        } finally { await p.ctx.close(); }
      }
    });

    // ---------- fixed columns and Down from the tabs ----------
    for (const lang of ['en', 'es']) {
      await check('Columns: badges, "Also on", checks and chips start at the same x on every row, aired or not, nothing overlaps (' + lang + ', panel and full screen)', async () => {
        for (const full of [false, true]) {
          const p = await env.newPage({ lang: lang === 'es' ? 'es' : undefined });
          try {
            await H.openSchedule(p, 'week');
            if (full) await H.fullScreen(p);
            await H.sleep(300);
            const v = await p.evaluate(() => {
              const out = { bad: [], rows: 0 };
              const lefts = {};
              const note = (k, n) => { (lefts[k] = lefts[k] || []).push(n.getBoundingClientRect().left); };
              const rows = document.querySelectorAll('.sh-line');
              out.rows = rows.length;
              Array.prototype.forEach.call(rows, (line) => {
                const side = line.querySelector('.sh-side');
                note('side', side);
                const b = line.querySelector('.sh-badge');
                if (b) { note('badge', b); if (b.scrollWidth > b.clientWidth + 1 && !/ellipsis/.test(getComputedStyle(b.querySelector('.sh-badge-text')).textOverflow)) out.bad.push('badge clipped'); }
                ['alt', 'mark', 'page'].forEach((k) => { const sl = line.querySelector('.sh-slot.is-' + k); if (sl) note('slot-' + k, sl); });
                ['alt', 'mark', 'page'].forEach((k) => { const c = line.querySelector('.sh-slot.is-' + k + ' .f'); if (c) note('chip-' + k, c); });
                // Left to right, the pieces never overlap.
                const parts = [line.querySelector('.sh-info'), side].concat(['alt', 'mark', 'page'].map((k) => line.querySelector('.sh-slot.is-' + k))).filter(Boolean);
                for (let i = 1; i < parts.length; i++) {
                  if (parts[i - 1].getBoundingClientRect().right > parts[i].getBoundingClientRect().left + 0.5) out.bad.push('overlap ' + i);
                }
                const info = line.querySelector('.sh-info');
                if (info.scrollWidth > info.clientWidth + 1) {
                  const t = info.querySelector('.sh-title');
                  if (t.scrollWidth <= t.clientWidth + 1) out.bad.push('meta overflows its info');
                }
              });
              out.lefts = lefts;
              Object.keys(lefts).forEach((k) => {
                const a = lefts[k];
                if (Math.max.apply(null, a) - Math.min.apply(null, a) > 1) out.bad.push(k + ' not aligned: ' + a.join(','));
              });
              out.hasAired = !!document.querySelector('.sh-row.is-past'); out.hasUpcoming = !!document.querySelector('.sh-row:not(.is-past)');
              out.alts = document.querySelectorAll('.sh-alt').length; out.marks = document.querySelectorAll('.sh-slot.is-mark .sh-mark').length;
              return out;
            });
            assert(v.bad.length === 0 && v.rows >= 4 && v.hasAired && v.hasUpcoming && v.alts >= 1 && v.marks >= 1, (full ? 'full: ' : 'panel: ') + JSON.stringify(v.bad) + ' rows ' + v.rows);
            // Focus moving along a row does not move a column (the focused pills grow over their own slot).
            const before = await p.evaluate(() => [].map.call(document.querySelectorAll('.sh-slot'), (n) => Math.round(n.getBoundingClientRect().left)).join(','));
            await H.focusKey(p, 'sh:row:paradise:');
            await H.key(p, 'ArrowRight', 2);
            const after = await p.evaluate(() => [].map.call(document.querySelectorAll('.sh-slot'), (n) => Math.round(n.getBoundingClientRect().left)).join(','));
            assert(before === after, 'a column moved with focus: ' + before + ' / ' + after);
          } finally { await p.ctx.close(); }
        }
      });

      await check('Columns: on Coming soon the status pills and the badges line up, in Spanish too, and nothing is clipped (' + lang + ')', async () => {
        for (const full of [false, true]) {
          const p = await env.newPage({ lang: lang === 'es' ? 'es' : undefined });
          try {
            await H.openSchedule(p, 'soon');
            if (full) await H.fullScreen(p);
            await H.sleep(300);
            const v = await p.evaluate((full) => {
              const bad = [];
              const flags = [].slice.call(document.querySelectorAll('.sh-show .sh-flag'));
              const badges = [].slice.call(document.querySelectorAll('.sh-show .sh-badge'));
              const counts = [].slice.call(document.querySelectorAll('.sh-card .sh-count'));
              const off = (n) => { const c = n.closest('.sh-card'); return n.getBoundingClientRect().right - c.getBoundingClientRect().right; };
              const same = (a, k) => a.length > 1 && Math.max.apply(null, a.map(k || ((n) => n.getBoundingClientRect().left))) - Math.min.apply(null, a.map(k || ((n) => n.getBoundingClientRect().left))) <= 1;
              if (!same(flags)) bad.push('flags');
              if (!same(badges)) bad.push('badges');
              const cl = counts.filter((n) => !/is-blank/.test(n.className));
              if (cl.length > 1 && !same(cl, off)) bad.push('counts');
              flags.forEach((f) => { if (f.scrollWidth > f.clientWidth + 1 && (full || getComputedStyle(f).textOverflow !== 'ellipsis')) bad.push('flag clipped: ' + f.textContent); });
              badges.forEach((b) => { if (b.scrollWidth > b.clientWidth + 1) bad.push('badge clipped'); });
              document.querySelectorAll('.sh-show').forEach((r) => {
                const f = r.querySelector('.sh-flag'); const b = r.querySelector('.sh-badge'); const i = r.querySelector('.sh-info');
                if (f && b && f.getBoundingClientRect().right > b.getBoundingClientRect().left + 0.5) bad.push('flag over badge');
                if (f && i.getBoundingClientRect().right > f.getBoundingClientRect().left + 0.5) bad.push('info over flag');
              });
              return { bad: bad, n: flags.length };
            }, full);
            assert(v.bad.length === 0 && v.n >= 3, (full ? 'full: ' : 'panel: ') + JSON.stringify(v));
          } finally { await p.ctx.close(); }
        }
      });
    }

    await check('Down from any tab lands in the listing (never the apps column) at full screen, in all four tabs and with "Did you finish?" first; Up from the first line returns to the tab', async () => {
      for (const started of [undefined, SIX]) {
        for (const tab of ['today', 'week', 'month', 'soon']) {
          const p = await env.newPage({ started: started });
          try {
            await H.openSchedule(p, tab);
            await H.fullScreen(p);
            await H.sleep(300);
            const at = () => p.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? { key: f.getAttribute('data-key') || '', main: !!f.closest('.ent-main'), side: !!f.closest('.ent-side') } : null; });
            const isTab = (o) => !!o && o.key.indexOf('sh:tab:') === 0;
            const firstItem = () => p.evaluate(() => { const f = document.querySelector('#panel .is-focused'); const items = [].filter.call(document.querySelectorAll('.sh .f'), (n) => !/\bsh-tab\b/.test(n.className)); return items[0] === f; });
            // Focus starts on the Full screen button: Down enters the Schedule, then Up to the tab row (Up from the first line lands on the tab showing).
            await H.key(p, 'ArrowDown');
            for (let i = 0; i < 30 && !isTab(await at()); i++) await H.key(p, 'ArrowUp');
            assert(isTab(await at()), 'not on a tab, viewing ' + tab);
            assert((await at()).key === 'sh:tab:' + tab, 'Up did not land on the tab showing: ' + (await at()).key);
            // Down from each tab in turn (Right moves along the tabs without switching).
            for (let n = 0; n < 4; n++) {
              const here = await at();
              await H.key(p, 'ArrowDown');
              const a = await at();
              assert(a && a.main && !a.side && a.key.indexOf('sh:') === 0 && !isTab(a), 'Down from ' + here.key + ' (viewing ' + tab + (started ? ', finish strip' : '') + '): ' + JSON.stringify(a));
              assert(await firstItem(), 'Down from ' + here.key + ' did not land on the first listing item');
              await H.key(p, 'ArrowUp');
              assert(isTab(await at()), 'Up from the first line did not return to a tab: ' + JSON.stringify(await at()));
              if (n < 3) { await H.key(p, 'ArrowRight'); }
            }
          } finally { await p.ctx.close(); }
        }
      }
    });

    // ---------- the show page ----------
    const pgText = (p, sel) => p.evaluate((q) => { const n = document.querySelector(q); return n ? n.textContent : null; }, sel);
    const pgPosts = (p) => { const out = []; p.on('request', (r) => { if (r.method() === 'POST' && /\/shows\//.test(r.url())) out.push(r.url().replace(/^.*:\d+/, '') + ' ' + (r.postData() || '')); }); return out; };
    // The row of a show, then Right until its Show page chip.
    const toChip = async (p, id) => {
      if ((await focusedKey(p)).indexOf('sh:page:' + id + ':') === 0) return;
      await H.focusKey(p, 'sh:row:' + id + ':');
      for (let i = 0; i < 4 && (await focusedKey(p)).indexOf('sh:page:' + id + ':') !== 0; i++) await H.key(p, 'ArrowRight');
      assert((await focusedKey(p)).indexOf('sh:page:' + id + ':') === 0, 'no chip: ' + await focusedKey(p));
    };
    // Full screen, the Slow Horses row's chip, OK: the show page.
    const openPg = async (p, id) => {
      await H.openGrid(p);
      await H.fullScreen(p);
      await H.sleep(400);
      await toChip(p, id || 'slow-horses');
      await H.key(p, 'Enter');
      await H.until(() => p.evaluate(() => !!document.querySelector('.sh-pg-ep')), 5000, 'the show page did not fill');
      await H.sleep(300);
    };
    const WATCHED12 = { upTo: [['slow-horses', 4, 6]], watched: [['slow-horses', 5, 1], ['slow-horses', 5, 2]] };
    const pgEnv = await H.start(WATCHED12);
    try {
      const ps = async (id) => (await getJson(pgEnv.LIVE + '/live/state')).resources.shows.data.shows.filter((x) => x.id === id)[0];

      await check('The Show page chip opens the show page in the Schedule\'s place (apps stay on the left): header, progress bar, buttons, season pills, episodes', async () => {
        const p = await pgEnv.newPage({});
        try {
          await openPg(p);
          const v = await p.evaluate(() => {
            const q = (s) => document.querySelector(s);
            const all = (s) => [].map.call(document.querySelectorAll(s), (n) => n.textContent);
            return {
              side: !!q('#panel .ent-side .ent-item'), tabs: !!q('#panel .sh-tab[data-key="sh:tab:week"]'),
              title: q('.sh-pg-title').textContent, meta: q('.sh-pg-meta').textContent.replace(/\s+/g, ' ').trim(),
              prog: q('.sh-pg-prog-text').textContent, segs: [].map.call(document.querySelectorAll('.sh-pg-seg'), (n) => /is-on/.test(n.className) ? 'w' : /is-out/.test(n.className) ? 'a' : 'f').join(''),
              btns: all('.sh-pg-btn'), pills: all('.sh-pg-tabs .sh-tab'), back: q('.sh-pg-back').textContent,
              eps: all('.sh-pg-ep').map((t) => t.replace(/\s+/g, ' ').trim()),
              marks: [].map.call(document.querySelectorAll('.sh-pg-ep'), (n) => !!n.querySelector('.sh-mark')).join(','),
              focus: document.querySelector('#panel .is-focused').getAttribute('data-key')
            };
          });
          assert(v.side && !v.tabs, 'the page should replace the Schedule: ' + JSON.stringify(v));
          assert(v.title === 'Slow Horses' && /Apple TV/.test(v.meta) && /Still running/.test(v.meta) && /5 seasons/.test(v.meta), v.meta);
          assert(v.back === 'Schedule', v.back);
          assert(v.prog === 'Season 5 · 2 of 6 watched' && v.segs === 'wwaaff', v.prog + ' ' + v.segs);
          assert(JSON.stringify(v.btns) === '["Watch S5 E3","I’m caught up"]', JSON.stringify(v.btns));
          assert(v.pills.length === 5 && v.pills[0] === 'S1' && /^S5/.test(v.pills[4]) && /2\/6/.test(v.pills[4]), JSON.stringify(v.pills));
          assert(await p.evaluate(() => document.querySelectorAll('.sh-pg-tick').length === 4), 'seasons 1 to 4 are done');
          assert(v.eps.length === 6 && v.eps[0].indexOf('E1Cold OpenAired Oct 26') === 0 && /Watched/.test(v.eps[1]) && /Airs Nov 23/.test(v.eps[4]), JSON.stringify(v.eps));
          assert(v.marks === 'true,true,true,true,false,false', v.marks);
          assert(v.focus === 'sh:pg:watch', v.focus);
          assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
        } finally { await p.ctx.close(); }
      });

      await check('Season pills: Left and Right move, OK switches the list; the default season holds the next episode', async () => {
        const p = await pgEnv.newPage({});
        try {
          await openPg(p);
          await H.focusKey(p, 'sh:pg:season:5');
          await H.key(p, 'ArrowLeft');
          assert(await focusedKey(p) === 'sh:pg:season:4', await focusedKey(p));
          await H.key(p, 'Enter');
          await H.sleep(300);
          const v = await p.evaluate(() => ({ prog: document.querySelector('.sh-pg-prog-text').textContent, n: document.querySelectorAll('.sh-pg-ep').length, first: document.querySelector('.sh-pg-ep').textContent.replace(/\s+/g, ' ').trim(), focus: document.querySelector('#panel .is-focused').getAttribute('data-key') }));
          assert(v.prog === 'Season 4 · 6 of 6 watched' && v.n === 6 && /^E1Rain Check/.test(v.first) && v.focus === 'sh:pg:season:4', JSON.stringify(v));
        } finally { await p.ctx.close(); }
      });

      await check('Back (and the Schedule chip) returns to the Schedule with focus on that row\'s page chip, at full screen and in the panel', async () => {
        const p = await pgEnv.newPage({});
        try {
          await openPg(p);
          await H.key(p, 'Escape');
          await H.sleep(400);
          assert(await p.evaluate(() => !document.querySelector('.sh-pg') && !!document.querySelector('.sh-tab[data-key="sh:tab:week"]') && window.HUB_TEST.mode() === 'full'), 'Back should only close the page');
          assert((await focusedKey(p)).indexOf('sh:page:slow-horses:') === 0, await focusedKey(p));
          await H.key(p, 'Enter');
          await H.until(() => p.evaluate(() => !!document.querySelector('.sh-pg-ep')), 4000, 'page');
          await H.focusKey(p, 'sh:pg:back');
          await H.key(p, 'Enter');
          await H.sleep(400);
          assert((await focusedKey(p)).indexOf('sh:page:slow-horses:') === 0, 'chip: ' + await focusedKey(p));
        } finally { await p.ctx.close(); }
        const q = await pgEnv.newPage({});
        try {
          await H.openSchedule(q, 'week');
          await toChip(q, 'paradise');
          await H.key(q, 'Enter');
          await H.until(() => q.evaluate(() => !!document.querySelector('.sh-pg-ep')), 4000, 'panel page');
          assert(await q.evaluate(() => !document.querySelector('.sh-tabs .sh-tab[data-key="sh:tab:week"]') && window.HUB_TEST.mode() === 'panel'), 'the panel shows the page in the Schedule\'s place');
          await H.key(q, 'Escape');
          await H.sleep(400);
          assert(await q.evaluate(() => !!document.querySelector('.sh-tab[data-key="sh:tab:week"]') && window.HUB_TEST.open() === 'entertainment'), 'Back returns to the Schedule');
          assert((await focusedKey(q)).indexOf('sh:page:paradise:') === 0, await focusedKey(q));
        } finally { await q.ctx.close(); }
      });

      await check('Marks on the page: one episode (watched, then off), "Watched up to here" (the chip appears with the row\'s controls), "I\'m caught up" (done, OK does nothing); each redraws at once and reaches the Pi', async () => {
        const p = await pgEnv.newPage({});
        try {
          const posts = pgPosts(p);
          await openPg(p);
          await H.focusKey(p, 'sh:pg:ep:5:4');
          await H.key(p, 'ArrowRight');
          assert(await focusedKey(p) === 'sh:pg:mark:5:4', await focusedKey(p));
          assert(await pgText(p, '#panel .is-focused .sh-mark-text') === 'Mark as watched', 'label');
          // The chip is only there while this row or its controls are focused.
          assert(await p.evaluate(() => document.querySelectorAll('.sh-pg-upto.f').length === 1 && getComputedStyle(document.querySelector('.sh-pg-ep.is-in .sh-pg-upto')).display !== 'none'), 'one chip');
          await H.key(p, 'Enter');
          await H.until(async () => (await ps('slow-horses')).upcoming.some((e) => e.number === 4 && e.watched), 4000, 'the Pi never marked E4');
          assert(posts.join('|') === '/shows/watched {"id":"slow-horses","season":5,"number":4}', posts.join('|'));
          await H.sleep(500);
          let v = await p.evaluate(() => ({ prog: document.querySelector('.sh-pg-prog-text').textContent, watch: document.querySelector('.sh-pg-btn').textContent, focus: document.querySelector('#panel .is-focused').getAttribute('data-key'), on: /is-on/.test(document.querySelector('[data-key="sh:pg:mark:5:4"]').className) }));
          assert(v.prog === 'Season 5 · 3 of 6 watched' && v.watch === 'Watch S5 E3' && v.on && v.focus === 'sh:pg:mark:5:4', JSON.stringify(v));
          // Off again.
          await H.key(p, 'Enter');
          await H.until(async () => !(await ps('slow-horses')).upcoming.some((e) => e.number === 4 && e.watched), 4000, 'the Pi kept E4');
          await H.sleep(400);
          assert(await pgText(p, '.sh-pg-prog-text') === 'Season 5 · 2 of 6 watched', 'back to 2');
          // Up to here on E3: everything before it, E3 included.
          await H.focusKey(p, 'sh:pg:ep:5:3');
          await H.key(p, 'ArrowRight', 2);
          assert(await focusedKey(p) === 'sh:pg:upto:5:3' && await pgText(p, '#panel .is-focused') === 'Watched up to here', await focusedKey(p));
          await H.key(p, 'Enter');
          await H.until(async () => { const u = (await ps('slow-horses')).progress.upTo; return u && u.season === 5 && u.number === 3; }, 4000, 'the Pi never took the up to mark');
          assert(posts[posts.length - 1] === '/shows/upto {"id":"slow-horses","season":5,"number":3}', posts[posts.length - 1]);
          await H.sleep(500);
          v = await p.evaluate(() => ({ prog: document.querySelector('.sh-pg-btn').textContent, ticks: document.querySelectorAll('.sh-pg-tick').length, season5: document.querySelector('.sh-pg-tabs .is-on').textContent, focus: document.querySelector('#panel .is-focused').getAttribute('data-key') }));
          assert(v.prog === 'Watch S5 E4' && v.ticks === 4 && /3\/6/.test(v.season5) && v.focus === 'sh:pg:upto:5:3', JSON.stringify(v));
          // Catch up: E4 is the last one out.
          await H.focusKey(p, 'sh:pg:caught');
          await H.key(p, 'Enter');
          await H.until(async () => (await ps('slow-horses')).progress.caughtUp === true, 4000, 'the Pi never caught up');
          assert(posts[posts.length - 1] === '/shows/caughtup {"id":"slow-horses"}', posts[posts.length - 1]);
          await H.sleep(500);
          v = await p.evaluate(() => ({ btns: [].map.call(document.querySelectorAll('.sh-pg-btn'), (n) => n.textContent), done: /is-done/.test(document.querySelector('.sh-pg-btn').className), prog: document.querySelector('.sh-pg-prog-text').textContent }));
          assert(JSON.stringify(v.btns) === '["You’re caught up"]' && v.done && v.prog === 'Season 5 · 4 of 6 watched', JSON.stringify(v));
          const n = posts.length;
          await H.key(p, 'Enter');
          await H.sleep(400);
          assert(posts.length === n, 'OK on the done button must do nothing');
          assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
        } finally { await p.ctx.close(); }
      });
    } finally { await pgEnv.stop(); }

    await check('Ended show says "I\'ve seen it all", then "Seen it all"; caught up from the Schedule row too', async () => {
      const own = await H.start();
      const p = await own.newPage({});
      try {
        const posts = pgPosts(p);
        await H.openGrid(p);
        await H.fullScreen(p);
        await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('homeHub.shows.v1')); d.shows.forEach((s) => { if (s.id === 'andor') { s.running = false; s.status = 'Ended'; } }); window.HUB_SHOWS._test.setData(d); window.HUB_SHOWS._test.openPage('andor'); });
        await H.until(() => p.evaluate(() => !!document.querySelector('.sh-pg-ep')), 5000, 'andor');
        const v = await p.evaluate(() => ({ btns: [].map.call(document.querySelectorAll('.sh-pg-btn'), (n) => n.textContent), meta: document.querySelector('.sh-pg-meta').textContent, focus: document.querySelector('#panel .is-focused').getAttribute('data-key') }));
        assert(/Ended/.test(v.meta) && v.btns[v.btns.length - 1] === 'I’ve seen it all', JSON.stringify(v));
        await H.focusKey(p, 'sh:pg:caught');
        await H.key(p, 'Enter');
        await H.until(() => p.evaluate(() => /Seen it all/.test(document.querySelector('.sh-pg-btn:last-child').textContent)), 5000, 'not seen it all');
        assert(posts.some((x) => /^\/shows\/caughtup \{"id":"andor"\}$/.test(x)), posts.join('|'));
        const v2 = await p.evaluate(() => ({ btns: [].map.call(document.querySelectorAll('.sh-pg-btn'), (n) => n.textContent), prog: document.querySelector('.sh-pg-prog-text').textContent }));
        assert(JSON.stringify(v2.btns) === '["Seen it all"]' && /^All \d+ episodes watched$/.test(v2.prog), JSON.stringify(v2));
      } finally { await p.ctx.close(); await own.stop(); }
    });

    await check('Show page states: loading, "Only recent episodes so far", Pi unreachable (the cached list still draws), a Pi without the route or without progress', async () => {
      // Partial: the Pi has no full list for the show.
      const part = await env.newPage({});
      try {
        await part.route(/\/shows\/episodes/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, id: 'paradise', checkedAt: null, partial: true, seasons: [{ season: 2, episodes: [{ number: 3, name: 'Sunrise', airstamp: '2026-11-13T02:00:00Z', runtime: 55 }, { number: 4, name: 'Dusk', airstamp: '2026-11-25T02:00:00Z' }] }], progress: { upTo: null, unwatched: [], aired: 0, seen: 0, caughtUp: false, next: null } }) }));
        await openPg(part, 'paradise');
        assert(await pgText(part, '.sh-pg-note') === 'Only recent episodes so far', 'partial note');
        assert(await part.evaluate(() => document.querySelectorAll('.sh-pg-ep').length === 2), 'two rows');
      } finally { await part.ctx.close(); }
      // Unreachable, first with nothing cached, then cached.
      const lost = await env.newPage({});
      try {
        await lost.route(/\/shows\/episodes/, (r) => r.abort());
        await openPgOnly(lost, 'slow-horses');
        await H.until(() => lost.evaluate(() => !!document.querySelector('.sh-msg')), 5000, 'message');
        const m = await lost.evaluate(() => document.querySelector('.sh-msg-head').textContent);
        assert(m === 'Can’t reach the Pi', m);
        await lost.unroute(/\/shows\/episodes/);
        await H.key(lost, 'Escape');
        await H.sleep(300);
        await toChip(lost, 'slow-horses');
        await H.key(lost, 'Enter');
        await H.until(() => lost.evaluate(() => !!document.querySelector('.sh-pg-ep')), 5000, 'it never recovered');
        await H.key(lost, 'Escape');
        await H.sleep(300);
        await lost.route(/\/shows\/episodes/, (r) => r.abort());
        await toChip(lost, 'slow-horses');
        await H.key(lost, 'Enter');
        await H.until(() => lost.evaluate(() => !!document.querySelector('.sh-pg-ep')), 5000, 'the cached list was not drawn');
        await H.sleep(500);
        assert(await lost.evaluate(() => !document.querySelector('.sh-msg') && document.querySelectorAll('.sh-pg-ep').length === 6), 'cache');
        const keys = await lost.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('homeHub.showEps.v1.') === 0));
        assert(keys.indexOf('homeHub.showEps.v1.slow-horses') >= 0, keys.join(','));
      } finally { await lost.ctx.close(); }
      // Old Pi: 404 on the route, and a 200 without progress.
      for (const reply of [{ status: 404, body: { ok: false, error: 'not found' } }, { status: 200, body: { ok: true, seasons: [{ season: 1, episodes: [{ number: 1, name: 'x', airstamp: '2020-01-01T00:00:00Z' }] }] } }]) {
        const old = await env.newPage({});
        try {
          await old.route(/\/shows\/episodes/, (r) => r.fulfill({ status: reply.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply.body) }));
          await openPgOnly(old, 'slow-horses');
          await H.until(() => old.evaluate(() => !!document.querySelector('.sh-msg')), 5000, 'old message');
          const m = await old.evaluate(() => document.querySelector('.sh-msg-head').textContent);
          assert(m === 'Show page needs a newer Pi', reply.status + ': ' + m);
          assert(await old.evaluate(() => !!document.querySelector('.sh-pg-back')), 'a way back');
        } finally { await old.ctx.close(); }
      }
      // The same words in Spanish.
      const es = await env.newPage({ lang: 'es' });
      try {
        await es.route(/\/shows\/episodes/, (r) => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
        await openPgOnly(es, 'slow-horses');
        await H.until(() => es.evaluate(() => !!document.querySelector('.sh-msg')), 5000, 'old message es');
        assert(await pgText(es, '.sh-msg-head') === 'La página de la serie necesita una Pi más nueva', 'es old');
      } finally { await es.ctx.close(); }
      async function openPgOnly(p, id) {
        await H.openGrid(p);
        await H.fullScreen(p);
        await H.sleep(300);
        await toChip(p, id);
        await H.key(p, 'Enter');
        await H.sleep(300);
      }
    });

    await check('Show page in Spanish: words, dates, and nothing wider than its box (focused chip and toggle too)', async () => {
      const own = await H.start(WATCHED12);
      const p = await own.newPage({ lang: 'es' });
      try {
        await openPg(p);
        const v = await p.evaluate(() => ({
          prog: document.querySelector('.sh-pg-prog-text').textContent, btns: [].map.call(document.querySelectorAll('.sh-pg-btn'), (n) => n.textContent),
          pills: [].map.call(document.querySelectorAll('.sh-pg-tabs .sh-tab'), (n) => n.textContent), back: document.querySelector('.sh-pg-back').textContent,
          meta: document.querySelector('.sh-pg-meta').textContent, ep: document.querySelectorAll('.sh-pg-ep')[1].textContent.replace(/\s+/g, ' ').trim(), future: document.querySelectorAll('.sh-pg-ep')[4].textContent.replace(/\s+/g, ' ').trim()
        }));
        assert(v.prog === 'Temporada 5 · 2 de 6 vistos' && JSON.stringify(v.btns) === '["Ver T5 E3","Estoy al día"]', JSON.stringify(v));
        assert(v.pills[0] === 'T1' && /Sigue en emisión/.test(v.meta) && /5 temporadas/.test(v.meta) && v.back === 'Programación', JSON.stringify(v));
        assert(/^E2Dead DropEmitido el 2 nov/.test(v.ep) && /Visto/.test(v.ep) && /^E5Hello GoodbyeSe emite el 23 nov$/.test(v.future), v.ep + ' | ' + v.future);
        // A long title and the focused chips: nothing wider than its box.
        await p.evaluate(() => { document.querySelectorAll('.sh-pg-ep-title')[2].textContent = 'El increíble caso de la niña que perdió su ñandú ¿Quién lo sabe? Éxito total de la temporada'; });
        for (const k of ['sh:pg:watch', 'sh:pg:caught', 'sh:pg:ep:5:3']) {
          await H.focusKey(p, k);
          if (k.indexOf('ep') > 0) await H.key(p, 'ArrowRight');
          const f = await p.evaluate(() => {
            const bad = [];
            const body = document.querySelector('#panel .panel-body');
            if (body.scrollWidth > body.clientWidth + 1) bad.push('the body scrolls sideways');
            const root = document.querySelector('.sh-pg').getBoundingClientRect();
            [].forEach.call(document.querySelectorAll('.sh-pg-btn, .sh-pg-back, .sh-pg-tabs .sh-tab, .sh-pg-upto.f, .sh-mark.is-focused, .sh-pg-prog-text, .sh-pg-meta'), (n) => {
              const r = n.getBoundingClientRect();
              if (!r.width) return;
              if (r.right > root.right + 0.5) bad.push('outside the page: ' + n.textContent);
              if (n.scrollWidth > n.clientWidth + 1) bad.push('clipped: ' + n.textContent);
              const cs = getComputedStyle(n);
              if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.25) bad.push('line height on ' + n.textContent);
            });
            [].forEach.call(document.querySelectorAll('.sh-pg-ep'), (ep) => {
              const er = ep.getBoundingClientRect();
              [].forEach.call(ep.querySelectorAll('.f'), (n) => { if (n.getBoundingClientRect().right > er.right + 0.5) bad.push('control past its row: ' + n.textContent); });
            });
            return bad;
          });
          assert(!f.length, k + ': ' + f.join(' | '));
        }
        assert(await p.evaluate(() => { const t = document.querySelectorAll('.sh-pg-ep-title')[2]; return t.scrollWidth >= t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis'; }), 'long titles end in an ellipsis');
        assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
      } finally { await p.ctx.close(); await own.stop(); }
    });

    await check('Watched follows the Pi\'s progress (up to here minus exceptions) and marks on their way: "Did you finish?" drops covered episodes; upto and caughtup survive in the outbox', async () => {
      const state = (await getJson(env.LIVE + '/live/state')).resources.shows.data;
      const out = [{ op: 'upto', showId: 'the-pitt', season: 2, number: 3 }, { op: 'caughtup', showId: 'andor' }, { op: 'upto', showId: 'x' }, { op: 'bogus', showId: 'y', season: 1, number: 1 }];
      const p = await env.newPage({ live: 'http://127.0.0.1:1', waitLive: false, storage: { 'homeHub.shows.v1': JSON.stringify(state), 'homeHub.watch.out.v1': JSON.stringify(out) } });
      try {
        await H.sleep(500);
        const r = await p.evaluate(() => {
          const T = window.HUB_SHOWS._test;
          const pend = T.pendingOut();
          const d = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
          const sh = d.shows.filter((s) => s.id === 'slow-horses')[0];
          const air = Date.parse('2026-11-01T00:00:00Z');
          const a = { upto2: T.pendingMark('the-pitt', 2, 2, air), upto4: T.pendingMark('the-pitt', 2, 4, air), caughtOld: T.pendingMark('andor', 1, 1, air), caughtFuture: T.pendingMark('andor', 1, 1, Date.now() + 86400000 * 30) };
          // The Pi's own progress: up to S4E6 with S4E2 an exception.
          sh.progress = { upTo: { season: 4, number: 6 }, unwatched: [{ season: 4, number: 2 }], aired: 0, seen: 0, caughtUp: false, next: null };
          sh.watched = [{ season: 5, number: 1 }]; sh.upcoming = []; sh.nextEpisode = null;
          const base = [T.isWatchedEp(sh, 3, 1), T.isWatchedEp(sh, 4, 2), T.isWatchedEp(sh, 4, 6), T.isWatchedEp(sh, 5, 1), T.isWatchedEp(sh, 5, 2)];
          return { n: pend.length, ops: pend.map((x) => x.op).join(','), a: a, base: base };
        });
        assert(r.n === 2 && r.ops === 'upto,caughtup', JSON.stringify(r));
        assert(r.a.upto2 === 'watched' && r.a.upto4 === '' && r.a.caughtOld === 'watched' && r.a.caughtFuture === '', JSON.stringify(r.a));
        // The Pi's progress, with no mark of this show on its way.
        assert(JSON.stringify(r.base) === '[true,false,true,true,false]', JSON.stringify(r.base));
        // finishLines: a started episode covered by the progress goes by itself.
        const lines = await p.evaluate(() => {
          const d = JSON.parse(localStorage.getItem('homeHub.shows.v1'));
          const sh = d.shows.filter((s) => s.id === 'the-great-british-baking-show')[0];
          sh.progress = { upTo: { season: 16, number: 9 }, unwatched: [], aired: 0, seen: 0, caughtUp: false, next: null };
          sh.watched = []; sh.upcoming.forEach((e) => { delete e.watched; });
          localStorage.setItem('homeHub.watch.v1', JSON.stringify([{ showId: 'the-great-british-baking-show', season: 16, number: 8, startedAt: Date.now() - 3600000 }, { showId: 'the-great-british-baking-show', season: 16, number: 10, startedAt: Date.now() - 3600000 }]));
          window.HUB_SHOWS._test.setData(d);
          return window.HUB_SHOWS._test.finishLines(Date.now()).map((l) => l.rec.number);
        });
        assert(JSON.stringify(lines) === '[10]', JSON.stringify(lines));
      } finally { await p.ctx.close(); }
    });

  } finally {
    await env.stop();
  }

  await check('service.js /launch-control: strict checks, {ok} or {ok:false,error}', async () => {
    const s = loadService();
    let r = await s.call('/launch-control?id=3201907018807&op=' + encodeURIComponent('http://tizen.org/appcontrol/operation/view') + '&uri=' + encodeURIComponent('https://www.netflix.com/title/81505776'));
    assert(r.status === 200 && r.body.ok === true, JSON.stringify(r));
    assert(s.launched[0].id === '3201907018807' && s.launched[0].uri === 'https://www.netflix.com/title/81505776' && s.launched[0].data === null, JSON.stringify(s.launched[0]));
    r = await s.call('/launch-control?id=3201910019365&op=' + encodeURIComponent('http://samsung.com/appcontrol/operation/eden_resume') + '&key=PAYLOAD&val=' + encodeURIComponent('{"values":"amzn1.dv.gti.x"}'));
    assert(r.body.ok === true && s.launched[1].data[0].key === 'PAYLOAD' && s.launched[1].data[0].value[0] === '{"values":"amzn1.dv.gti.x"}', JSON.stringify(s.launched[1]));
    const bad = [
      ['id=../x&op=http://a.b/c', 'bad id'],
      ['id=1&op=javascript:alert(1)', 'bad op'],
      ['id=1&op=http://a.b/c&uri=' + encodeURIComponent('https://x y'), 'bad uri'],
      ['id=1&op=http://a.b/c&key=PAY LOAD&val=1', 'bad key'],
      ['id=1&op=http://a.b/c&key=PAYLOAD', 'key and val go together'],
      ['id=1&op=http://a.b/c&key=PAYLOAD&val=' + encodeURIComponent('a\nb'), 'bad val']
    ];
    for (const [q, err] of bad) {
      r = await s.call('/launch-control?' + q);
      assert(r.status === 400 && r.body.ok === false && r.body.error === err, q + ' -> ' + JSON.stringify(r));
    }
    assert(s.launched.length === 2, 'a bad query reached tizen');
    s.fail = 'NotFoundError';
    r = await s.call('/launch-control?id=1&op=http://a.b/c');
    assert(r.status === 500 && r.body.ok === false && r.body.error === 'NotFoundError', JSON.stringify(r));
  });


  {
    // Counts and the Schedule with a watched episode: Slow Horses S5 E4 (the
    // only one of its out) and Baking Show S16 E9 are marked.
    const base = await H.start();
    const mark = await H.start({ watched: [['slow-horses', 5, 4], ['the-great-british-baking-show', 16, 9]] });
    try {
      const a = await base.newPage({});
      const b = await mark.newPage({});
      await check('Counts skip watched episodes: a show whose aired episodes are all watched leaves the badge', async () => {
        const ca = await a.evaluate(() => window.HUB_SHOWS.availability());
        const cb = await b.evaluate(() => window.HUB_SHOWS.availability());
        assert(ca['Apple TV'] === 1 && ca.Netflix === 1, 'before: ' + JSON.stringify(ca));
        assert(cb['Apple TV'] === undefined && cb.Netflix === undefined, 'after: ' + JSON.stringify(cb));
        const rest = (o) => JSON.stringify(Object.keys(o).filter((k) => k !== 'Apple TV' && k !== 'Netflix').sort().map((k) => k + o[k]));
        assert(rest(ca) === rest(cb), 'other apps changed: ' + rest(ca) + ' vs ' + rest(cb));
        // The badge on the tile follows.
        const n = (p) => p.evaluate(() => document.querySelectorAll('.ent-count').length);
        const na = await n(a);
        const nb = await n(b);
        assert(na > 0 && nb === na - 2, 'count badges on the tile: ' + na + ' before, ' + nb + ' after');
      });
      await check('The Schedule dims watched rows with a check and "Watched" (EN, ES); watched rows are not the first focus; a row of several episodes counts only when all are watched', async () => {
        await H.openSchedule(b, 'week');
        const r = await b.evaluate(() => {
          const q = (k) => document.querySelector('[data-key^="sh:row:' + k + ':"]');
          const w = q('the-great-british-baking-show');
          const u = q('paradise');
          return { watched: /is-watched/.test(w.className), note: w.querySelector('.sh-note.is-watched').textContent, check: !!w.querySelector('.sh-check'),
            other: /is-watched/.test(u.className), aired: q('slow-horses').querySelector('.sh-note.is-watched').textContent };
        });
        assert(r.watched && r.note === 'Watched' && r.check && !r.other && r.aired === 'Watched', JSON.stringify(r));
        assert((await focusedKey(b)).indexOf('sh:row:paradise:') === 0, 'focus: ' + await focusedKey(b));
        const row = await b.evaluate(() => window.HUB_SHOWS._test.rowWatched({ eps: [{ watched: true }, {}] }) + '/' + window.HUB_SHOWS._test.rowWatched({ eps: [{ watched: true }, { watched: true }] }));
        assert(row === 'false/true', row);
        await b.ctx.close();
        const es = await mark.newPage({ lang: 'es' });
        await H.openSchedule(es, 'week');
        const t = await es.evaluate(() => document.querySelector('[data-key^="sh:row:slow-horses:"] .sh-note.is-watched').textContent);
        assert(t === 'Visto', t);
        await es.ctx.close();
      });
      await check('A started line whose episode the Pi has as watched is not listed (the Pi already knew)', async () => {
        const q = await mark.newPage({ started: [['the-great-british-baking-show', 16, 9, 20], ['the-pitt', 2, 6, 40], ['slow-horses', 5, 4, 3]] });
        try {
          await H.openSchedule(q, 'week');
          const lines = await q.evaluate(() => [].map.call(document.querySelectorAll('.sh-fin-line .sh-fin-name'), (n) => n.textContent));
          assert(JSON.stringify(lines) === '["The Pitt"]', JSON.stringify(lines));
          const kept = await q.evaluate(() => JSON.parse(localStorage.getItem('homeHub.watch.v1')));
          assert(kept.length === 1 && kept[0].showId === 'the-pitt', JSON.stringify(kept));
          assert(await q.evaluate(() => document.querySelectorAll('.cell[data-widget="entertainment"] .ent-check').length === 1 && document.querySelector('.cell[data-widget="entertainment"] .ent-check').textContent === '1'), 'tile count');
        } finally { await q.ctx.close(); }
      });
      await a.ctx.close();
    } finally {
      await base.stop();
      await mark.stop();
    }
  }

  {
    // Entertainment at full screen: the apps in a column beside the Schedule.
    const sp = await H.start();
    const fk = (pg) => pg.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? (f.getAttribute('data-key') || 'button') : ''; });
    const openFull = async (pg) => { await H.openGrid(pg); await H.fullScreen(pg); };
    try {
      await check('config.js opens Entertainment straight to full screen: no Full screen button, "Back to close", Back closes it; openMode \'panel\' in config keeps the small panel', async () => {
        const p = await sp.newPage({ entOpen: 'config' });
        try {
          assert(await p.evaluate(() => window.HUB_TEST.openPanel('entertainment')), 'did not open');
          await H.until(() => p.evaluate(() => window.HUB_TEST.open() === 'entertainment' && !window.HUB_TEST.busy()), 6000, 'not open');
          const v = await p.evaluate(() => ({ mode: window.HUB_TEST.mode(), btn: document.querySelector('#panel .panel-btn').style.display, hint: document.querySelector('#panel .panel-hint').textContent, direct: /is-direct/.test(document.getElementById('panel').className) }));
          assert(v.mode === 'full' && v.direct && v.btn === 'none' && v.hint === 'Back to close', JSON.stringify(v));
          await H.key(p, 'Escape');
          await H.until(() => p.evaluate(() => window.HUB_TEST.open() === null || window.HUB_TEST.open() === '' || !window.HUB_TEST.open()), 6000, 'Back did not close it');
          // A config.js openMode: 'panel' keeps the small panel (the harness default).
          const q = await sp.newPage({});
          try {
            await H.openGrid(q);
            assert((await q.evaluate(() => window.HUB_TEST.mode())) === 'panel', 'panel override ignored');
          } finally { await q.ctx.close(); }
        } finally { await p.ctx.close(); }
      });

      await check('Full screen: the app column (with its counts) and the live Schedule are both there, the column a quarter wide, and focus starts in the Schedule', async () => {
        const p = await sp.newPage({});
        try {
          await openFull(p);
          const v = await p.evaluate(() => {
            const body = document.querySelector('#panel .panel-body');
            const side = document.querySelector('#panel .ent-side');
            const main = document.querySelector('#panel .ent-main');
            if (!side || !main) return { none: true };
            const sr = side.getBoundingClientRect();
            const mr = main.getBoundingClientRect();
            const f = document.querySelector('#panel .is-focused');
            return {
              frac: sr.width / body.getBoundingClientRect().width,
              items: side.querySelectorAll('.ent-item.f').length,
              hiddenSched: side.querySelectorAll('.ent-item.is-off').length,
              counts: [].map.call(side.querySelectorAll('.ent-count'), (n) => n.textContent).join(','),
              tabs: main.querySelectorAll('.sh-tab').length,
              rows: main.querySelectorAll('.sh-row').length,
              apart: mr.left >= sr.right,
              fit: sr.bottom <= body.getBoundingClientRect().bottom + 0.5,
              scrollsX: body.scrollWidth > body.clientWidth + 1,
              focus: f ? f.getAttribute('data-key') || '' : ''
            };
          });
          assert(!v.none, 'no .ent-side / .ent-main');
          assert(v.frac > 0.2 && v.frac < 0.28, 'column width ' + v.frac);
          assert(v.items === 11 && v.hiddenSched === 1, 'items ' + v.items + ' hidden ' + v.hiddenSched);
          assert(v.counts === '1,1,1', 'counts ' + v.counts);
          assert(v.tabs === 4 && v.rows >= 5, 'schedule: ' + v.tabs + ' tabs, ' + v.rows + ' rows');
          assert(v.apart && v.fit && !v.scrollsX, JSON.stringify(v));
          // Focus stays on the Full screen button that was pressed; Down starts the Schedule.
          assert(v.focus === '', 'focus ' + v.focus);
          await H.key(p, 'ArrowDown');
          assert((await fk(p)).indexOf('sh:row:paradise:') === 0, 'Down from the button went to ' + await fk(p));
          assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
        } finally { await p.ctx.close(); }
      });

      await check('Full screen focus: Left from the Schedule goes to the column, Right back; Up and Down stay in their side; OK on an app opens it, OK on a row watches', async () => {
        const p = await sp.newPage({});
        try {
          await openFull(p);
          await H.key(p, 'ArrowDown');
          assert((await fk(p)).indexOf('sh:row:paradise:') === 0, 'start: ' + await fk(p));
          await H.key(p, 'ArrowLeft');
          let k = await fk(p);
          assert(/^item\d+$/.test(k), 'Left went to ' + k);
          await H.key(p, 'ArrowDown');
          const k2 = await fk(p);
          assert(/^item\d+$/.test(k2) && k2 !== k, 'Down in the column went to ' + k2);
          await H.key(p, 'ArrowDown', 20);
          k = await fk(p);
          assert(/^item\d+$/.test(k), 'Down past the last item left the column: ' + k);
          await H.key(p, 'ArrowRight');
          assert(/^sh:/.test(await fk(p)), 'Right went to ' + await fk(p));
          await H.key(p, 'ArrowDown', 30);
          assert(/^sh:/.test(await fk(p)), 'Down past the Schedule ended in the column: ' + await fk(p));
          // OK on an app chip opens the app.
          await H.key(p, 'ArrowLeft', 3);
          for (let i = 0; i < 20 && (await fk(p)) !== 'item0'; i++) await H.key(p, 'ArrowUp');
          assert((await fk(p)) === 'item0', 'could not reach the first app: ' + await fk(p));
          const n0 = sp.launches.length;
          await H.key(p, 'Enter');
          await H.until(() => sp.launches.length > n0, 3000, 'OK on an app chip launched nothing');
          assert(/^launch /.test(sp.launches[sp.launches.length - 1]), sp.launches.join(' | '));
          // OK on a Schedule row still watches (the card, then the app).
          await H.key(p, 'ArrowRight');
          await H.focusKey(p, 'sh:row:paradise:');
          const n1 = sp.launches.length;
          await H.key(p, 'Enter');
          await H.until(() => p.evaluate(() => !!document.querySelector('.sh-go-card')), 1500, 'no watch card');
          await H.until(() => sp.launches.length > n1, 3500, 'OK on a row launched nothing');
          assert(sp.launches[sp.launches.length - 1] === 'launch 3201901017640', sp.launches.join(' | '));
          assert(pageErrors(p).length === 0, pageErrors(p).join(' | '));
        } finally { await p.ctx.close(); }
      });

      await check('The tile and the expanded panel are unchanged: no column, the grid with its labels and the Schedule item; leaving full screen brings the grid back', async () => {
        const p = await sp.newPage({});
        try {
          assert(await p.evaluate(() => !document.querySelector('.ent-split') && document.querySelectorAll('#grid .ent-chip').length >= 6), 'the tile changed');
          await H.openGrid(p);
          const panel = () => p.evaluate(() => ({
            split: !!document.querySelector('#panel .ent-split'),
            grid: !!document.querySelector('#panel .panel-body > .ent-grid'),
            items: document.querySelectorAll('#panel .ent-item.f').length,
            sched: [].some.call(document.querySelectorAll('#panel .ent-item.f .ent-name'), (n) => n.textContent === 'Schedule'),
            label: getComputedStyle(document.querySelector('#panel .ent-section-label')).display,
            align: getComputedStyle(document.querySelector('#panel .ent-name')).textAlign
          }));
          let v = await panel();
          assert(!v.split && v.grid && v.items === 12 && v.sched && v.label === 'none' && v.align === 'center', 'panel: ' + JSON.stringify(v));
          await H.fullScreen(p);
          assert((await panel()).split, 'no column at full screen');
          await H.key(p, 'Escape');
          await H.until(() => p.evaluate(() => window.HUB_TEST.mode() === 'panel' && !window.HUB_TEST.busy()), 4000, 'Back did not leave full screen');
          await H.sleep(300);
          v = await panel();
          assert(!v.split && v.grid && v.items === 12 && v.sched, 'after full screen: ' + JSON.stringify(v));
        } finally { await p.ctx.close(); }
      });

      await check('Spanish: the column fits, names wrap with room for accents, and nothing is wider than its box', async () => {
        const p = await sp.newPage({ lang: 'es' });
        try {
          await openFull(p);
          await p.evaluate(() => { document.querySelectorAll('#panel .ent-side .ent-name')[1].textContent = 'Televisión por suscripción ¿Dónde está?'; });
          const v = await p.evaluate(() => {
            const bad = [];
            const side = document.querySelector('#panel .ent-side');
            const body = document.querySelector('#panel .panel-body');
            if (side.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 0.5) bad.push('the column runs past the panel');
            [].forEach.call(side.querySelectorAll('.ent-item.f'), (it) => {
              const ir = it.getBoundingClientRect();
              [].forEach.call(it.querySelectorAll('.ent-name, .ent-state'), (t) => {
                const cs = getComputedStyle(t);
                if (cs.display === 'none') return;
                if (t.scrollWidth > t.clientWidth + 1) bad.push('wider than its box: ' + t.textContent);
                if (t.getBoundingClientRect().right > ir.right + 0.5) bad.push('outside its item: ' + t.textContent);
                if (parseFloat(cs.lineHeight) < parseFloat(cs.fontSize) * 1.25) bad.push('line height ' + cs.lineHeight + ' on ' + t.textContent);
                if (cs.overflow !== 'visible') bad.push('overflow ' + cs.overflow);
              });
            });
            if (body.scrollWidth > body.clientWidth + 1) bad.push('the body scrolls sideways');
            const long = document.querySelectorAll('#panel .ent-side .ent-name')[1];
            return { bad: bad, wraps: long.getBoundingClientRect().height > parseFloat(getComputedStyle(long).lineHeight) * 1.5, tab: document.querySelector('#panel .sh-tab').textContent };
          });
          assert(!v.bad.length, v.bad.join(' | '));
          assert(v.wraps, 'the long name did not wrap');
          assert(v.tab === 'Hoy', 'tab ' + v.tab);
        } finally { await p.ctx.close(); }
      });
    } finally {
      await sp.stop();
    }
  }

  await check('Ready to watch on Coming soon: only shows started and behind, per-season lines, the count on the tab, Down reaches the cards, OK watches the next episode, the chips open show pages; Spanish fits', async () => {
    const own = await H.start({ upTo: [['slow-horses', 3, 6], ['andor', 1, 12], ['paradise', 1, 8], ['the-great-british-baking-show', 16, 99]] });
    const errs = pageErrors;
    try {
      const p = await own.newPage({});
      try {
        await H.openSchedule(p, 'soon');
        const v = await p.evaluate(() => ({
          head: document.querySelector('.sh-ready-head').textContent,
          tab: document.querySelector('.sh-tab[data-key="sh:tab:soon"]').textContent,
          rows: [].map.call(document.querySelectorAll('.sh-ready-row'), (r) => r.getAttribute('data-key') + '|' + r.querySelector('.sh-ready-line').textContent + '|' + ((r.querySelector('.sh-ready-next') || {}).textContent || '') + '|' + r.querySelector('.sh-count').textContent),
          chips: [].map.call(document.querySelectorAll('.sh-ready .sh-page, .sh-shows .sh-page'), (n) => n.getAttribute('data-key')).length,
          shows: document.querySelectorAll('.sh-shows .sh-show').length,
          tags: [].map.call(document.querySelectorAll('.sh-shows .sh-chip.is-ready'), (n) => n.textContent)
        }));
        // Baking Show is caught up (up to past the last aired), so it is not listed; shows never started are not either.
        assert(v.head === 'Ready to watch3' && v.tab === 'Coming soon3', JSON.stringify(v));
        assert(JSON.stringify(v.rows) === JSON.stringify([
          'sh:ready:andor|Season 2 · all 12 out|Up next: S2 E1|12to watch',
          'sh:ready:paradise|Season 2 · 5 of 8 out|Up next: S2 E1|5to watch',
          'sh:ready:slow-horses|Seasons 4–5|Up next: S4 E1|10to watch']), JSON.stringify(v.rows));
        assert(v.chips === 3 + v.shows && JSON.stringify(v.tags) === '["10 to watch","5 to watch","12 to watch"]', JSON.stringify(v));
        // Down: the three lines, then the Coming soon cards, then Your shows.
        const at = () => p.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || '' : ''; });
        await H.focusKey(p, 'sh:ready:andor');
        const keys = [];
        for (let i = 0; i < 4; i++) { await H.key(p, 'ArrowDown'); keys.push(await at()); }
        assert(JSON.stringify(keys) === '["sh:ready:paradise","sh:ready:slow-horses","sh:soon:the-bear","sh:soon:severance"]', JSON.stringify(keys));
        // OK on a line: its app opens and the next episode is the one started.
        await H.focusKey(p, 'sh:ready:slow-horses');
        const before = own.launches.length;
        await H.key(p, 'Enter');
        await H.until(() => own.launches.length > before, 3500, 'no launch from Ready to watch');
        const started = await p.evaluate(() => JSON.parse(localStorage.getItem('homeHub.watch.v1') || '[]'));
        assert(started.length === 1 && started[0].showId === 'slow-horses' && started[0].season === 4 && started[0].number === 1, JSON.stringify(started));
        assert(errs(p).length === 0, errs(p).join(' | '));
      } finally { await p.ctx.close(); }
      // The chip on a line opens that show's page; Back returns to the chip.
      const q = await own.newPage({});
      try {
        await H.openSchedule(q, 'soon');
        await H.focusKey(q, 'sh:ready:andor');
        await H.key(q, 'ArrowRight');
        assert(await q.evaluate(() => document.querySelector('#panel .is-focused').getAttribute('data-key')) === 'sh:page:andor:ready', 'Right from the line is its chip');
        await H.key(q, 'Enter');
        await H.until(() => q.evaluate(() => !!document.querySelector('.sh-pg-title') && /Andor/.test(document.querySelector('.sh-pg-title').textContent)), 4000, 'the show page did not open');
        await H.key(q, 'Escape');
        await H.until(() => q.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return !!f && f.getAttribute('data-key') === 'sh:page:andor:ready'; }), 4000, 'Back did not return to the chip');
        assert(errs(q).length === 0, errs(q).join(' | '));
      } finally { await q.ctx.close(); }
      // Spanish, full screen: the words, and no line wider than its box.
      const e = await own.newPage({ lang: 'es' });
      try {
        await H.openSchedule(e, 'soon');
        await H.fullScreen(e);
        const w = await e.evaluate(() => ({
          head: document.querySelector('.sh-ready-head').textContent,
          lines: [].map.call(document.querySelectorAll('.sh-ready-line, .sh-ready-next, .sh-ready-row .sh-count-word'), (n) => n.textContent),
          over: [].filter.call(document.querySelectorAll('.sh-ready-line, .sh-ready-next, .sh-ready-row .sh-title, .sh-ready-row .sh-count-word, .sh-chip.is-ready'), (n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent)
        }));
        assert(w.head === 'Para ver3' && w.lines.indexOf('Temporada 2 · los 12 disponibles') >= 0 && w.lines.indexOf('Temporada 2 · 5 de 8 disponibles') >= 0 && w.lines.indexOf('Temporadas 4–5') >= 0 && w.lines.indexOf('Sigue: T4 E1') >= 0 && w.lines.indexOf('por ver') >= 0, JSON.stringify(w));
        assert(!w.over.length, 'clipped: ' + JSON.stringify(w.over));
        assert(errs(e).length === 0, errs(e).join(' | '));
      } finally { await e.ctx.close(); }
    } finally { await own.stop(); }
  });

  await check('No Ready to watch when nothing is started: no group, no count on the tab', async () => {
    const own = await H.start();
    try {
      const p = await own.newPage({});
      try {
        await H.openSchedule(p, 'soon');
        const v = await p.evaluate(() => ({ ready: !!document.querySelector('.sh-ready'), n: !!document.querySelector('.sh-tab-n'), chips: document.querySelectorAll('.sh-shows .sh-page').length }));
        assert(!v.ready && !v.n && v.chips > 0, JSON.stringify(v));
      } finally { await p.ctx.close(); }
    } finally { await own.stop(); }
  });

  await check('The new and changed app files are plain ES5', () => {
    let acorn = null;
    for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
      try { acorn = require(p); break; } catch (e) { /* next */ }
    }
    const bad = [];
    for (const f of ['app/widgets/shows.js', 'app/widgets/linktest.js', 'app/widgets/entertainment.js', 'app/hub.js', 'app/config.js', 'app/i18n.js', 'app/logos.js', 'service.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (acorn) {
        try { acorn.parse(src, { ecmaVersion: 5 }); } catch (e) { bad.push(f + ': ' + e.message); }
      } else if (/(^|[^.\w])(let|const|class)\s|=>|`/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
        bad.push(f + ': ES2015 syntax');
      }
    }
    assert(!bad.length, bad.join(' | '));
    // The TV service no longer counts anything: no /running, no /watch-track, no timing code in the page.
    const svc = fs.readFileSync(path.join(ROOT, 'service.js'), 'utf8');
    assert(!/watch-track|\/running|settleTracks|runningApps/.test(svc), 'service.js still counts watching');
    const shw = fs.readFileSync(path.join(ROOT, 'app/widgets/shows.js'), 'utf8');
    assert(!/watch-track|\/running|askWatched|nextAsk|checkTracked|trackText|sh-ask/.test(shw), 'shows.js still tracks app time');
    assert(!/sh-ask|askTitle/.test(fs.readFileSync(path.join(ROOT, 'app/widgets/shows.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'app/i18n.js'), 'utf8')), 'the Did you watch it? card is still in the CSS or the words');
    // No CSS grid and no flex gap in the new stylesheet.
    const css = fs.readFileSync(path.join(ROOT, 'app/widgets/shows.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/display:\s*grid|(^|[^-])gap:/m.test(css), 'grid or gap in shows.css');
    // Animations only move transform and opacity.
    const tr = css.match(/transition:[^;]+;/g) || [];
    assert(tr.every((t) => !/\b(width|height|top|left|margin|padding|background|color)\b/.test(t)), tr.join(' '));
  });
}

main().catch((e) => { failed++; console.log('FAIL  ' + (e && e.stack || e)); }).then(() => {
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
