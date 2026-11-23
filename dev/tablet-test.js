/*
 * Tablet mode: node dev/tablet-test.js
 *
 * The hub on a wall tablet (Android, Fully Kiosk, Chrome 52 WebView): no
 * remote, no Tizen API, no service.js (hub.js "tablet mode", app/tablet.css,
 * docs/tablet-mode.md). Runs the real hub in headless Chromium at 1920x1080
 * against the preview and checks:
 *   - a TV (no ?as=, no touch screen) gets none of it, even with service.js
 *     down: no class, no tab, no sheet, "Back to close"
 *   - ?as=tv keeps it off on a touch screen with service.js down
 *   - ?as=tablet: the class on html and body, the tab; the apps tile stays
 *     while service.js answers
 *   - tapping the chip closes a panel, shrinks full screen first, and only
 *     stops the typing while a text box is typed in
 *   - tapping the dark around a panel closes it
 *   - the tab (a tap, or a drag up) brings up the sheet with About on the
 *     left and the layouts on the right; a layout is tapped and used; Close,
 *     a drag down and Back put it away
 *   - service.js down: the apps stay, no "Couldn't read the app list" toast,
 *     and an app opens through the Pi (POST /tv/launch, mocked: nothing is
 *     ever sent to a TV) with "Opening ... on the TV" or a plain failure; with
 *     service.js a tablet uses it; a touch screen with no ?as= turns tablet
 *     mode on by itself
 *   - Ambience: a tap on a light's bar sets that level (never off), a drag
 *     scrubs it, a mouse click does the same; on a TV a click is still OK
 *   - Settings in the sheet (look, language, Guest mode behind the PIN, the
 *     same setters as the Clock page); Slideshow full screen until a tap or
 *     Back; the Photos layout in the sheet
 *   - Spanish: the chip, the tab and the sheet, accents not clipped
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 */
'use strict';

const H = require('./awws-harness');

const LAYOUT = [
  { widget: 'todo', x: 0, y: 0, w: 3, h: 4 }, { widget: 'today', x: 3, y: 0, w: 3, h: 2 },
  { widget: 'weather', x: 9, y: 0, w: 3, h: 2 }, { widget: 'calendar', x: 6, y: 0, w: 3, h: 4 },
  { widget: 'entertainment', x: 3, y: 4, w: 9, h: 2 }
];

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n     '));
  }
}
function assert(ok, text) { if (!ok) throw new Error(text); }

// service.js on 127.0.0.1:8095 refuses (registered after the harness's own route, so it wins).
function noHelper(context) { return context.route('http://127.0.0.1:8095/**', (route) => route.abort('connectionrefused')); }

async function hub(env, o) {
  return env.newPage(Object.assign({ layout: LAYOUT, live: 'off', motion: 'fade' }, o));
}

function state(page) {
  return page.evaluate(() => {
    const ent = document.querySelector('.cell[data-widget="entertainment"]');
    return {
      html: document.documentElement.classList.contains('tablet'),
      body: document.body.classList.contains('tablet'),
      tab: !!document.querySelector('.tablet-tab'),
      sheet: !!document.querySelector('.tsheet'),
      t: window.HUB_TEST.tablet(),
      apps: !!ent && ent.offsetWidth > 0,
      toast: document.getElementById('toast').textContent
    };
  });
}

async function openTile(page, id) {
  await page.click('.cell[data-widget="' + id + '"] .tile');
  await H.until(() => page.evaluate((w) => window.HUB_TEST.open() === w, id), 5000, id + ' did not open');
  await H.idle(page);
}

async function closed(page) {
  await H.until(() => page.evaluate(() => window.HUB_TEST.open() === null && !window.HUB_TEST.busy()), 5000, 'the panel did not close');
}

function hint(page) { return page.evaluate(() => document.querySelector('#panel .panel-hint').textContent); }

// One finger from y0 to y1 on node (TouchEvent, as Chrome 52 sends).
function drag(page, selector, y0, y1) {
  return page.evaluate(([sel, a, b]) => {
    const node = document.querySelector(sel);
    const r = node.getBoundingClientRect();
    const x = r.left + r.width / 2;
    function fire(type, y) {
      const t = new Touch({ identifier: 1, target: node, clientX: x, clientY: y });
      node.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    }
    fire('touchstart', a);
    for (let i = 1; i <= 6; i++) fire('touchmove', a + (b - a) * i / 6);
    fire('touchend', b);
  }, [selector, y0, y1]);
}


// A made-up hub server with one dimmable lamp (on, 80%), for the Ambience
// sliders: /live/state, /live/poll and POST /ambience/light (kept in posts).
const FAKE = 'http://127.0.0.1:1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function fakeLive(posts, tv) {
  const amb = { lights: [{ id: 'lamp', name: 'Floor lamp', kind: 'light', on: true, pct: 80, reachable: true, tone: '#ffd6aa' }], scenes: [], moods: [] };
  const state = { ok: true, v: 1, epoch: 'e1', rev: 1, resources: { ambience: { rev: 1, data: amb } } };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  return (context) => context.route(FAKE + '/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (/\/live\/events/.test(url)) return route.abort('connectionrefused');
    if (/\/live\/(state|poll)/.test(url)) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(state) });
    if (/\/photos\/list/.test(url)) {
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
        body: JSON.stringify({ rev: 1, count: 2, items: [{ id: 'a1', w: 1080, h: 1440, month: '2026-11' }, { id: 'b2', w: 1440, h: 1080, month: '2026-10' }] }) });
    }
    if (/\/photos\/img\//.test(url)) return route.fulfill({ status: 200, headers: cors, contentType: 'image/png', body: PNG });
    if (/\/tv\/launch/.test(url)) {
      tv.calls.push(JSON.parse(req.postData() || '{}'));
      if (tv.mode === 'missing') return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"ok":false,"error":"not found"}' });
      if (tv.mode === 'queued') return route.fulfill({ status: 202, headers: cors, contentType: 'application/json', body: '{"ok":true,"queued":true}' });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (/\/ambience\/light/.test(url)) {
      const b = JSON.parse(req.postData() || '{}');
      posts.push(b);
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true, result: 'ok', on: b.on !== false, pct: b.pct || 80 }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });
}

// One finger on selector at fractions fx of its width (first is the press, last the lift).
function touchBar(page, selector, fx) {
  return page.evaluate(([sel, xs]) => {
    let node = document.querySelector(sel);
    const r = node.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const target = node;
    function fire(type, f) {
      const t = new Touch({ identifier: 2, target: target, clientX: r.left + r.width * f, clientY: y });
      return target.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    }
    const notCancelled = fire('touchstart', xs[0]);
    for (let i = 1; i < xs.length; i++) fire('touchmove', xs[i]);
    fire('touchend', xs[xs.length - 1]);
    return notCancelled;
  }, [selector, fx]);
}

function lampText(page) { return page.evaluate(() => document.querySelector('#panel [data-light="lamp"] .am-lrow-state').textContent); }

function sheetUp(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.tsheet');
    return window.HUB_TEST.tablet().sheet && s.classList.contains('is-shown') && getComputedStyle(s).display !== 'none';
  });
}

(async () => {
  const env = await H.start({ snapshot: false, calendars: false, ownService: true });
  try {
    await check('A TV gets none of it, even with service.js down', async () => {
      const page = await hub(env, { route: noHelper });
      await H.sleep(3500);
      const s = await state(page);
      assert(!s.html && !s.body && !s.tab && !s.sheet && !s.t.on && !s.t.noHelper && !s.t.show, JSON.stringify(s));
      assert(!(await page.evaluate(() => document.querySelector('.tsheet-settings, .tshow, .tsheet-show'))), 'tablet parts on a TV');
      assert(s.apps, 'the apps tile went');
      await openTile(page, 'todo');
      assert(await hint(page) === 'Back to close', await hint(page));
      // The dark around the panel still closes it at once, as before.
      await page.mouse.click(1900, 1060);
      await closed(page);
      await page.ctx.close();
    });

    await check('?as=tv keeps it off on a touch screen with service.js down', async () => {
      const page = await hub(env, { route: noHelper, touch: true, query: 'as=tv' });
      await H.sleep(3500);
      const s = await state(page);
      assert(!s.body && !s.tab && !s.t.on && s.apps, JSON.stringify(s));
      await page.ctx.close();
    });

    const page = await hub(env, { query: 'as=tablet' });

    await check('?as=tablet: class on html and body, the tab; apps stay while service.js answers', async () => {
      await H.sleep(1500);
      const s = await state(page);
      assert(s.html && s.body && s.tab && s.sheet && s.t.on && !s.t.noHelper && s.apps, JSON.stringify(s));
      const tab = await page.evaluate(() => {
        const r = document.querySelector('.tablet-tab').getBoundingClientRect();
        const p = document.querySelector('.tablet-tab-pill').getBoundingClientRect();
        return { h: r.height, w: r.width, pillTop: p.top, bottom: r.bottom };
      });
      assert(tab.h >= 48 && tab.w >= 200 && tab.bottom === 1080, 'touch area ' + JSON.stringify(tab));
      // The visible tab stays in the gutter under the tiles (1.2rem = 28.8 px).
      assert(1080 - tab.pillTop <= 30, 'the tab reaches into the tiles: ' + JSON.stringify(tab));
    });

    await check('Tapping the chip closes a panel', async () => {
      await openTile(page, 'calendar');
      assert(await hint(page) === 'Tap to close', await hint(page));
      await page.click('#panel .panel-hint');
      await closed(page);
    });

    await check('Tapping the chip in full screen shrinks it first', async () => {
      await openTile(page, 'calendar');
      await page.click('#panel .panel-btn');
      await H.until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full'), 5000, 'no full screen');
      await H.idle(page);
      assert(await hint(page) === 'Tap to shrink', await hint(page));
      await page.click('#panel .panel-hint');
      await H.until(() => page.evaluate(() => window.HUB_TEST.mode() === 'panel'), 5000, 'did not shrink');
      await H.idle(page);
      await page.click('#panel .panel-hint');
      await closed(page);
    });

    await check('Tapping the chip while typing only stops the typing', async () => {
      await openTile(page, 'todo');
      await page.click('#panel .todo-input');
      await H.until(() => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('todo-input')), 3000, 'not typing');
      assert(await hint(page) === 'Tap to stop typing', await hint(page));
      await page.click('#panel .panel-hint');
      await H.sleep(300);
      const s = await page.evaluate(() => ({ open: window.HUB_TEST.open(), typing: document.activeElement && document.activeElement.classList.contains('todo-input') }));
      assert(s.open === 'todo' && !s.typing, JSON.stringify(s));
      // The clock is fixed here; move it on past the stray-tap guard (300 ms).
      await page.clock.setFixedTime(new Date(env.at + 60000));
      await page.click('#panel .panel-hint');
      await closed(page);
    });

    await check('Tapping the dark around a panel closes it', async () => {
      await openTile(page, 'calendar');
      await page.mouse.click(1900, 1060);
      await closed(page);
    });

    await check('The tab brings up the sheet: About left, layouts right', async () => {
      await page.click('.tablet-tab');
      await H.until(() => sheetUp(page), 3000, 'the sheet did not come up');
      await H.sleep(400);
      const s = await page.evaluate(() => ({
        about: !!document.querySelector('.tsheet-left #about .about-row'),
        layouts: document.querySelectorAll('.tsheet-right #switcher .switcher-item').length,
        top: document.querySelector('.tsheet').getBoundingClientRect().top,
        titles: Array.prototype.map.call(document.querySelectorAll('.tsheet-title'), (n) => n.textContent)
      }));
      assert(s.about && s.layouts >= 2 && Math.abs(s.top) < 1, JSON.stringify(s));
      assert(s.titles.join('|') === 'Settings|About this hub|Layouts|Photos', s.titles.join('|'));
    });

    await check('Close puts the sheet away and gives About and the layouts back', async () => {
      await page.click('.tsheet-close');
      await H.until(async () => !(await sheetUp(page)), 3000, 'still up');
      await H.sleep(500);
      const s = await page.evaluate(() => ({
        sheetShown: getComputedStyle(document.querySelector('.tsheet')).display,
        about: document.getElementById('about').parentNode === document.body,
        sw: document.getElementById('switcher').parentNode === document.body
      }));
      assert(s.sheetShown === 'none' && s.about && s.sw, JSON.stringify(s));
    });

    await check('A drag up on the tab brings it up; a drag down on its head puts it away', async () => {
      await drag(page, '.tablet-tab', 1070, 400);
      await H.until(() => sheetUp(page), 3000, 'drag up did not open it');
      await H.sleep(400);
      await drag(page, '.tsheet-head', 30, 700);
      await H.until(async () => !(await sheetUp(page)), 3000, 'drag down did not close it');
      await H.sleep(400);
      // A short drag snaps back down.
      await drag(page, '.tablet-tab', 1070, 1000);
      await H.sleep(500);
      assert(!(await sheetUp(page)), 'a short drag opened it');
    });

    await check('Back (Escape) closes the sheet', async () => {
      await page.click('.tablet-tab');
      await H.until(() => sheetUp(page), 3000, 'not up');
      await page.keyboard.press('Escape');
      await H.until(async () => !(await sheetUp(page)), 3000, 'still up');
      await H.sleep(400);
    });

    await check('A layout in the sheet is tapped and used', async () => {
      await page.click('.tablet-tab');
      await H.until(() => sheetUp(page), 3000, 'not up');
      await H.sleep(400);
      const name = await page.evaluate(() => {
        const items = document.querySelectorAll('.tsheet .switcher-item');
        for (let i = 0; i < items.length; i++) if (!items[i].classList.contains('is-active') && items[i].textContent === 'Get ready') return items[i].textContent;
        return null;
      });
      assert(name, 'no Get ready layout');
      await page.click('.tsheet .switcher-item:has-text("Get ready")');
      await H.until(() => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('homeHub.layoutChoice')).id === 'get-ready'; } catch (e) { return false; } }), 5000, 'not picked');
      await H.sleep(1500);
      await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 15000 });
      const s = await page.evaluate(() => ({ up: window.HUB_TEST.tablet().sheet, tablet: document.body.classList.contains('tablet') }));
      assert(!s.up && s.tablet, JSON.stringify(s));
    });
    await page.ctx.close();

    await check('service.js down: the apps stay, no app list warning, and an app opens through the Pi', async () => {
      const tv = { calls: [], mode: 'ok' };
      const p = await hub(env, { live: FAKE, route: async (c) => { await fakeLive([], tv)(c); await noHelper(c); }, query: 'as=tablet', waitLive: false });
      await H.until(() => p.evaluate(() => window.HUB_TEST.tablet().noHelper), 5000, 'noHelper never set');
      await H.sleep(2500);
      const s = await state(p);
      assert(s.t.on && s.apps, JSON.stringify(s));
      assert(!/app list|lista de apps|aplicaciones/i.test(s.toast), 'toast: ' + s.toast);
      const chips = await p.evaluate(() => document.querySelectorAll('.cell[data-widget="entertainment"] .ent-chip:not(.is-blank)').length);
      assert(chips >= 2, 'app chips: ' + chips);
      await openTile(p, 'entertainment');
      const subs = await p.evaluate(() => document.querySelector('#panel').textContent);
      assert(!/Looking for it|Couldn.t check|Not installed/.test(subs), 'app states: ' + subs.slice(0, 200));
      await p.click('#panel .ent-item:has-text("Netflix")');
      await H.until(() => tv.calls.length === 1, 3000, 'nothing sent to the Pi');
      assert(tv.calls[0].kind === 'app' && tv.calls[0].name === 'Netflix' && tv.calls[0].match.indexOf('Netflix') >= 0, JSON.stringify(tv.calls));
      assert(/Opening Netflix on the TV/.test(await p.evaluate(() => document.getElementById('toast').textContent)), 'no Opening toast');
      // A Pi without the route yet: a plain failure line.
      tv.mode = 'missing';
      await p.click('#panel .ent-item:has-text("Hulu")');
      await H.until(() => p.evaluate(() => /Couldn.t open Hulu on the TV \(the Pi needs an update\)/.test(document.getElementById('toast').textContent)), 3000, 'no failure toast');
      // The Pi's real answer: 202, queued; the work goes on there. Success, the toast stays.
      tv.mode = 'queued';
      await p.click('#panel .ent-item:has-text("Disney+")');
      await H.until(() => tv.calls.length === 3, 3000, 'Disney+ not sent');
      await H.sleep(1500);
      const t202 = await p.evaluate(() => ({ text: document.getElementById('toast').textContent, shown: document.getElementById('toast').classList.contains('is-shown') }));
      assert(/Opening Disney\+ on the TV/.test(t202.text) && t202.shown, JSON.stringify(t202));
      // All apps: the list lives on the TV; a short line, no endless "Still looking".
      await p.click('#panel .ent-item:has-text("All apps")');
      await H.until(() => p.evaluate(() => /All apps works on the TV/.test(document.getElementById('toast').textContent)), 3000, 'no All apps line');
      assert(tv.calls.length === 3, 'All apps went to the Pi');
      await p.ctx.close();
    });

    await check('With service.js, a tablet still opens apps through it (not the Pi)', async () => {
      const tv = { calls: [], mode: 'ok' };
      const p = await hub(env, { live: FAKE, route: fakeLive([], tv), query: 'as=tablet', waitLive: false });
      await H.sleep(2500);
      await openTile(p, 'entertainment');
      await p.click('#panel .ent-item:has-text("Netflix")');
      await H.sleep(1200);
      assert(tv.calls.length === 0, JSON.stringify(tv.calls));
      await p.ctx.close();
    });

    await check('A touch screen with no Tizen and service.js down turns it on by itself', async () => {
      const p = await hub(env, { route: noHelper, touch: true });
      await H.until(() => p.evaluate(() => window.HUB_TEST.tablet().on), 5000, 'not on');
      await H.sleep(500);
      const s = await state(p);
      assert(s.body && s.tab && s.t.noHelper && s.apps, JSON.stringify(s));
      await p.ctx.close();
    });


    const AMB = [{ widget: 'ambience', x: 0, y: 0, w: 6, h: 3 }, { widget: 'calendar', x: 6, y: 0, w: 6, h: 3 }];
    const BAR = '#panel [data-light="lamp"] .am-bar';

    await check('Ambience: a tap on a light\'s bar sets that level and never turns it off', async () => {
      const posts = [];
      const p = await hub(env, { layout: AMB, live: FAKE, route: fakeLive(posts), query: 'as=tablet', waitLive: false });
      await H.until(() => p.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'fake live');
      await openTile(p, 'ambience');
      const free = await touchBar(p, BAR, [0.25]);
      assert(!free, 'the touch was not kept from becoming a click');
      assert(await lampText(p) === '25%', 'shows ' + await lampText(p));
      await H.until(() => posts.length > 0, 3000, 'nothing sent');
      assert(posts.every((b) => b.on !== false) && posts[posts.length - 1].pct === 25, JSON.stringify(posts));
      assert(await p.evaluate(() => window.HUB_TEST.open()) === 'ambience', 'the panel closed');
      // A mouse click on the bar (Fully with a mouse) does the same, no toggle.
      posts.length = 0;
      await p.mouse.click(...(await p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width * 0.6, r.top + r.height / 2]; }, BAR)));
      await H.until(() => posts.length > 0, 3000, 'nothing sent for the click');
      assert(posts.every((b) => b.on !== false) && posts[posts.length - 1].pct === 60, JSON.stringify(posts));
      await p.ctx.close();
    });

    await check('Ambience: a drag along the bar scrubs the level', async () => {
      const posts = [];
      const p = await hub(env, { layout: AMB, live: FAKE, route: fakeLive(posts), query: 'as=tablet', waitLive: false });
      await H.until(() => p.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'fake live');
      await openTile(p, 'ambience');
      await touchBar(p, BAR, [0.2, 0.3, 0.45, 0.6, 0.7]);
      assert(await lampText(p) === '70%', 'shows ' + await lampText(p));
      await H.until(() => posts.length > 0, 3000, 'nothing sent');
      assert(posts.every((b) => b.on !== false) && posts[posts.length - 1].pct === 70 && posts.length <= 2, JSON.stringify(posts));
      await p.ctx.close();
    });

    await check('Ambience on a TV: a click on the bar is still OK (on or off), as before', async () => {
      const posts = [];
      const p = await hub(env, { layout: AMB, live: FAKE, route: fakeLive(posts), query: 'as=tv', waitLive: false });
      await H.until(() => p.evaluate(() => window.HUB_LIVE.status().state === 'live'), 8000, 'fake live');
      await openTile(p, 'ambience');
      await p.click(BAR);
      await H.until(() => posts.length > 0, 3000, 'nothing sent');
      assert(posts[0].on === false && posts[0].pct === undefined, JSON.stringify(posts));
      await p.ctx.close();
    });



    await check('A web page full screen closes with a tap on its chip (and still with Back)', async () => {
      const addDash = () => {
        let v;
        Object.defineProperty(window, 'HUB_CONFIG', { configurable: true, get: () => v, set: (x) => {
          v = x;
          try { const secs = v.widgets.entertainment.sections; secs[secs.length - 1].items.push({ kind: 'dashboard', label: 'Dash', url: 'http://127.0.0.1:1/dash' }); } catch (e) { /* ignore */ }
        } });
      };
      const p = await hub(env, { live: FAKE, route: fakeLive([], { calls: [] }), query: 'as=tablet', waitLive: false, config: addDash });
      await H.sleep(800);
      await openTile(p, 'entertainment');
      await p.click('#panel .ent-item:has-text("Dash")');
      await H.until(() => p.evaluate(() => !document.getElementById('frameWrap').hidden), 3000, 'no frame');
      assert(await p.evaluate(() => document.querySelector('.frame-hint').textContent) === 'Tap to close', 'chip text');
      await p.click('.frame-hint');
      await H.until(() => p.evaluate(() => document.getElementById('frameWrap').hidden), 3000, 'the chip did not close it');
      await p.click('#panel .ent-item:has-text("Dash")');
      await H.until(() => p.evaluate(() => !document.getElementById('frameWrap').hidden), 3000, 'no frame again');
      await p.evaluate(() => document.body.focus());
      await p.keyboard.press('Escape');
      await H.until(() => p.evaluate(() => document.getElementById('frameWrap').hidden), 3000, 'Back did not close it');
      await p.ctx.close();
    });

    await check('Closing the sheet keeps About and the layouts drawn until it is down', async () => {
      const p = await hub(env, { query: 'as=tablet' });
      await H.sleep(800);
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      await p.click('.tsheet-close');
      await H.sleep(280);
      const mid = await p.evaluate(() => ({ about: document.querySelectorAll('.tsheet #about .about-row').length, sw: getComputedStyle(document.getElementById('switcher')).display }));
      assert(mid.about > 0 && mid.sw !== 'none', 'emptied mid-slide: ' + JSON.stringify(mid));
      await H.sleep(300);
      const end = await p.evaluate(() => ({ about: document.getElementById('about').innerHTML, home: document.getElementById('about').parentNode === document.body }));
      assert(end.about === '' && end.home, JSON.stringify(end));
      await p.ctx.close();
    });

    await check('Settings in the sheet: language, look and Guest mode (behind the PIN)', async () => {
      const p = await hub(env, { live: FAKE, route: fakeLive([], { calls: [] }), query: 'as=tablet', waitLive: false });
      await H.sleep(800);
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      const rows = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.tsheet-set-label'), (n) => n.textContent));
      assert(rows.join('|') === 'Look|Language|Guest mode', rows.join('|'));
      await p.click('.tsheet-opt[data-set="lang-es"]');
      await H.sleep(300);
      let s = await p.evaluate(() => ({ lang: window.HUB_I18N.lang(), title: document.querySelector('.tsheet-title').textContent, on: document.querySelector('.tsheet-opt[data-set="lang-es"]').classList.contains('is-on'), up: window.HUB_TEST.tablet().sheet }));
      assert(s.lang === 'es' && s.title === 'Ajustes' && s.on && s.up, JSON.stringify(s));
      await p.click('.tsheet-opt[data-set="look-night"]');
      await H.sleep(300);
      s = await p.evaluate(() => ({ look: window.HUB_LOOK.get(), night: document.body.classList.contains('theme-night') }));
      assert(s.look === 'night' && s.night, JSON.stringify(s));
      await p.click('.tsheet-opt[data-set="look-auto"]');
      await p.click('.tsheet-opt[data-set="guest-on"]');
      await H.until(() => p.evaluate(() => window.HUB_PIN.isOpen()), 3000, 'no PIN pop-up');
      // A tap on the PIN pad does not close the sheet or About behind it.
      await p.click('.pin-key >> nth=0').catch(() => {});
      s = await p.evaluate(() => ({ guest: window.HUB_GUEST.on(), pin: window.HUB_PIN.isOpen(), up: window.HUB_TEST.tablet().sheet }));
      assert(!s.guest && s.pin && s.up, JSON.stringify(s));
      await p.evaluate(() => window.HUB_PIN.cancel());
      await H.sleep(300);
      assert(!(await p.evaluate(() => window.HUB_GUEST.on())), 'Guest mode turned on without the PIN');
      await p.ctx.close();
    });

    await check('Slideshow: full screen photos until a tap, or Back', async () => {
      const p = await hub(env, { live: FAKE, route: fakeLive([], { calls: [] }), query: 'as=tablet', waitLive: false });
      await H.sleep(800);
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      await p.click('.tsheet-show');
      await H.until(() => p.evaluate(() => !!document.querySelector('.tshow .ph-layer.is-on img.ph-img[src]')), 5000, 'no photo showed');
      let s = await p.evaluate(() => {
        const r = document.querySelector('.tshow').getBoundingClientRect();
        return { w: r.width, h: r.height, show: window.HUB_TEST.tablet().show, sheet: window.HUB_TEST.tablet().sheet, hint: document.querySelector('.tshow-hint').textContent };
      });
      assert(s.w === 1920 && s.h === 1080 && s.show && !s.sheet && s.hint === 'Tap to close', JSON.stringify(s));
      await p.mouse.click(960, 540);
      await H.sleep(500);
      assert(!(await p.evaluate(() => window.HUB_TEST.tablet().show || !!document.querySelector('.tshow'))), 'a tap did not end it');
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      await p.click('.tsheet-show');
      await H.sleep(500);
      await p.keyboard.press('Escape');
      await H.sleep(500);
      s = await p.evaluate(() => ({ show: window.HUB_TEST.tablet().show, el: !!document.querySelector('.tshow'), open: window.HUB_TEST.open() }));
      assert(!s.show && !s.el && s.open === null, JSON.stringify(s));
      await p.ctx.close();
    });

    await check('The Photos layout is in the sheet', async () => {
      const p = await hub(env, { query: 'as=tablet' });
      await H.sleep(800);
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      const names = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.tsheet .switcher-item'), (n) => n.textContent));
      assert(names.indexOf('Photos') >= 0, names.join(', '));
      await p.ctx.close();
    });

    await check('Spanish: chip, tab and sheet, accents not clipped', async () => {
      const p = await hub(env, { query: 'as=tablet', lang: 'es' });
      await H.sleep(800);
      await openTile(p, 'calendar');
      assert(await hint(p) === 'Toca para cerrar', await hint(p));
      await p.click('#panel .panel-hint');
      await closed(p);
      await p.click('.tablet-tab');
      await H.until(() => sheetUp(p), 3000, 'not up');
      await H.sleep(400);
      const s = await p.evaluate(() => {
        const out = { texts: [], bad: [] };
        const nodes = document.querySelectorAll('.tablet-tab-label, .tsheet-close-label, .tsheet-title');
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const cs = getComputedStyle(n);
          out.texts.push(n.textContent);
          if (parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) < 1.29) out.bad.push(n.className + ' line-height');
          if (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1) out.bad.push(n.className + ' clipped');
        }
        return out;
      });
      assert(s.texts.join('|') === 'Menú|Cerrar|Ajustes|Acerca de este hub|Diseños|Fotos', s.texts.join('|'));
      assert(!s.bad.length, s.bad.join(', '));
      await p.ctx.close();
    });
  } finally {
    await env.stop();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
