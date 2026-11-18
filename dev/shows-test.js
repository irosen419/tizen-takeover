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
      launchAppControl: (control, id, ok, err) => {
        out.launched.push({ id: id, op: control.operation, uri: control.uri, data: control.data });
        if (out.fail) err({ message: out.fail }); else ok();
      }
    }
  };
  const sandbox = {
    require: (m) => (m === 'http' ? fakeHttp : require(m)),
    Buffer: { from: Buffer.from, alloc: Buffer.alloc, isBuffer: Buffer.isBuffer, concat: Buffer.concat },
    console: { log: () => {} }, setTimeout, clearTimeout, setInterval, clearInterval, process, tizen,
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

    await check('Watch link test: the added recipes are listed after the first ten, and a plain open uses /launch and still asks what happened', async () => {
      const lt = await env.newPage({});
      try {
        const v = await lt.evaluate(() => {
          const t = window.HUB_LINKTEST._test;
          const r = t.recipes();
          return { ids: r.map((x) => x.id), about: window.HUB_LINKTEST.aboutText(), netflixWatch: r.filter((x) => x.id === 'netflix-watch-resume')[0].val, def: r.filter((x) => x.id === 'appletv-default-op')[0].op, plain: r.filter((x) => x.plain).map((x) => x.id + ':' + x.op + ':' + x.key) };
        });
        assert(v.ids.slice(0, 10).join() === 'prime-resume,netflix-resume,netflix-view,appletv-view,appletv-resume,appletv-fam,disney-view,disney-resume,hulu-view,peacock-view', v.ids.join());
        assert(v.ids.slice(10, 15).join() === 'netflix-watch-resume,netflix-json-resume,netflix-default-op,appletv-resume-url,appletv-default-op', v.ids.join());
        assert(v.ids.length === 21 && /^OK to open · 0 of \d+ tried$/.test(v.about), v.about);
        assert(v.netflixWatch === 'm=https://www.netflix.com/watch/81505776&source_type=4' && v.def === 'http://tizen.org/appcontrol/operation/default', JSON.stringify(v));
        assert(v.plain.length === 6 && v.plain.every((x) => /::undefined$/.test(x) || /:$/.test(x) || /::$/.test(x) || x.split(':')[1] === ''), v.plain.join());
        await H.openView(lt, 'linktests');
        await H.focusKey(lt, 'lt:run:plain-netflix');
        const nc = env.launches.filter((x) => /launch-control/.test(x)).length;
        const nl = env.launches.length;
        await H.key(lt, 'Enter');
        await H.until(() => env.launches.length > nl, 3000, 'no /launch');
        assert(/^launch /.test(env.launches[env.launches.length - 1]), env.launches.join(' | '));
        assert(env.launches.filter((x) => /launch-control/.test(x)).length === nc, 'a plain open used an app control');
        await H.sleep(300);
        assert((await focusedKey(lt)) === 'lt:ans:plain-netflix:title', await focusedKey(lt));
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
