/*
 * The Guest mode PIN pop-up (app/pin.js, app/pin.css): node dev/pin-test.js
 *
 * Runs the real hub in headless Chromium against the preview (needs port
 * 8095 free, like the other browser tests). The live line is stubbed:
 * app/live.js is served as dev/pin-live-stub.js, which answers POST
 * /guest/pin like pi/server.js with pi/guestpin.js. No Pi server is started
 * and nothing reaches the internet. Checks:
 *
 *   - pin.js is plain ES5; pin.css has no grid and no flex gap, moves only
 *     transform and opacity, has a reduced-motion and quick-fade fallback
 *     and ends with .css-end; hub.html loads both (pin.js before the
 *     widgets); every pin.* key has Spanish; the stub is not in hub.html.
 *   - First time: Guest mode On asks to create a PIN, then to enter it
 *     again; a mismatch starts over; after that Guest mode is on, the
 *     pop-up is gone and focus is back on the Guest mode row.
 *   - Off is gated the same way; On again too.
 *   - Only digits: letters, Shift+digit and other keys are ignored, the
 *     numpad works, the pop-up shows dots and never a typed digit, and the
 *     4th digit sends it by itself.
 *   - Back takes the last digit off; Back with none, or while the Pi is being
 *     asked, cancels with no change (the late answer is dropped);
 *     the hub never sees the keys (the Clock page stays open).
 *   - Wrong PIN: dots cleared, "Wrong PIN", still open. 3 wrong: "Too many
 *     tries. Try again in 25 s", counting down, digits ignored.
 *   - The Pi unreachable: "Can't reach the hub. Try again." and no change.
 *   - The on-screen keypad with the arrows and OK (digits, Delete, Cancel).
 *   - Spanish with every pin.* text 25% longer (Á É ñ ¿ ¡): nothing outside
 *     the card, nothing cut sideways, every line at least 1.3 times its type.
 *
 * --shots <folder> (or PIN_SHOTS) saves pictures at device scale 2: the
 * empty pop-up, two dots, a wrong PIN (English), locked and create (Spanish).
 * Prints one line per check and "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const childProcess = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OCEAN_JPG = fs.readFileSync(path.join(ROOT, 'app', 'backgrounds', 'ocean.jpg'));
const STUB = fs.readFileSync(path.join(__dirname, 'pin-live-stub.js'), 'utf8');
const argShots = process.argv.indexOf('--shots');
const SHOTS = argShots > 0 ? process.argv[argShots + 1] : (process.env.PIN_SHOTS || '');
let passed = 0;
let failed = 0;

function assert(ok, text) { if (!ok) throw new Error(text); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(60);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok    ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + ': ' + String(e && e.message).split('\n')[0]);
  }
}
function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getOk(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
  });
}

/* Spanish 25% longer: every pin.* text grown (with Á, É, ñ, ¿, ¡). */
const I18N = fs.readFileSync(path.join(ROOT, 'app', 'i18n.js'), 'utf8');
const GROW = '\n;(function () { var es = window.HUB_I18N.strings.es; var add = " ÁÉñ¿¡áéíóúÑÍÓÚÁÉñ¿¡áéíóú";' +
  ' for (var k in es) { if (!es.hasOwnProperty(k) || !/^pin\\./.test(k)) continue;' +
  ' var s = es[k]; var n = Math.max(1, Math.ceil(s.replace(/\\{\\w+\\}/g, "").length * 0.25)); es[k] = s + add.slice(0, n); } })();\n';

const LAYOUT = [{ widget: 'today', x: 0, y: 0, w: 3, h: 2 }];
const env = {};

// o: { lang, scale, grow, guest: true (Guest mode on at the start), pin: the PIN on the "Pi" }
async function open(o) {
  o = o || {};
  const context = await env.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: o.scale || 1 });
  context.errors = [];
  await context.route(/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'pub-1a6256c9f3df467ba787267fe45d9fee.r2.dev') return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*' }, body: OCEAN_JPG });
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return route.abort();
    return route.fallback();
  });
  await context.route(/\/live\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
  if (o.grow) await context.route(/\/i18n\.js(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: I18N + GROW }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) context.errors.push(m.text()); });
  page.on('pageerror', (e) => context.errors.push('page error: ' + e.message));
  const storage = { 'homeHub.layout': JSON.stringify(LAYOUT), 'homeHub.lang': o.lang || 'en' };
  if (o.guest) storage['homeHub.guest.v1'] = 'on';
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem('pin-seeded')) return;
      sessionStorage.setItem('pin-seeded', '1');
      localStorage.clear();
      for (const k in items) localStorage.setItem(k, items[k]);
    } catch (e) { /* ignore */ }
  }, storage);
  await page.goto(env.PAGE + '/?motion=fade&clay=off&live=off' + (o.lang ? '&lang=' + o.lang : ''));
  await page.waitForFunction(() => window.HUB_TEST && window.HUB_PIN && window.PIN_STUB && document.querySelector('.cell[data-widget="today"]'), null, { timeout: 15000 });
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 5000, 'the hub stayed busy');
  if (o.pin) await page.evaluate((p) => { window.PIN_STUB.pin = p; }, o.pin);
  await sleep(300);
  page.ctx = context;
  return page;
}

async function key(page, k, times) {
  for (let i = 0; i < (times || 1); i++) { await page.keyboard.press(k); await sleep(90); }
}
async function type(page, digits) {
  for (const d of digits) { await page.keyboard.press(d); await sleep(70); }
}
// A number pad digit with Num Lock on: keyCode 96-105 (Playwright's Numpad keys send arrows).
async function numpad(page, n) {
  const cdp = await page.context().newCDPSession(page);
  const ev = { key: String(n), code: 'Numpad' + n, windowsVirtualKeyCode: 96 + n, nativeVirtualKeyCode: 96 + n, location: 3, text: String(n) };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, ev));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, ev));
  await cdp.detach();
  await sleep(70);
}
async function openClock(page) {
  assert(await page.evaluate(() => window.HUB_TEST.openPanel('today')), 'no panel');
  await until(() => page.evaluate(() => window.HUB_TEST.open() === 'today' && !window.HUB_TEST.busy() && !!document.querySelector('#panel [data-key="guest-on"]')), 5000, 'the Clock page did not open');
  await sleep(250);
}
function focused(page) {
  return page.evaluate(() => { const f = document.querySelector('#panel .is-focused'); return f ? f.getAttribute('data-key') || 'hub' : ''; });
}
// Moves to the option with data-key k with the arrows, as the remote would.
async function focusKey(page, k) {
  for (let i = 0; i < 30; i++) {
    const dir = await page.evaluate((want) => {
      const f = document.querySelector('#panel .is-focused');
      const t = document.querySelector('#panel [data-key="' + want + '"]');
      if (!t) return 'missing';
      if (f === t) return '';
      if (!f) return 'ArrowDown';
      const a = f.getBoundingClientRect(), b = t.getBoundingClientRect();
      const dy = (b.top + b.bottom) / 2 - (a.top + a.bottom) / 2, dx = (b.left + b.right) / 2 - (a.left + a.right) / 2;
      if (Math.abs(dy) > Math.min(a.height, b.height) / 2) return dy > 0 ? 'ArrowDown' : 'ArrowUp';
      return dx > 0 ? 'ArrowRight' : 'ArrowLeft';
    }, k);
    if (!dir) return;
    assert(dir !== 'missing', 'no ' + k);
    await key(page, dir);
  }
  assert(await focused(page) === k, 'never reached ' + k + ' (at ' + await focused(page) + ')');
}
// Guest mode row: OK on On or Off, then wait for the pop-up to be ready.
async function choose(page, which, stage) {
  await focusKey(page, 'guest-' + which);
  await key(page, 'Enter');
  await until(() => page.evaluate((st) => { const s = window.HUB_PIN.state(); return !!s && !s.busy && (!st || s.stage === st); }, stage), 3000, 'no PIN pop-up' + (stage ? ' at ' + stage : ''));
}
function pin(page) { return page.evaluate(() => window.HUB_PIN.state()); }
function guestOn(page) { return page.evaluate(() => window.HUB_GUEST.on()); }
function popupText(page) { return page.evaluate(() => { const c = document.querySelector('.pin-card'); return c ? c.innerText.replace(/\s+/g, ' ').trim() : ''; }); }
function msg(page) { return page.evaluate(() => { const m = document.querySelector('.pin-msg'); return m ? m.textContent : ''; }); }
function filledDots(page) { return page.evaluate(() => document.querySelectorAll('.pin-dot.is-filled').length); }
async function closed(page) { await until(() => page.evaluate(() => !window.HUB_PIN.isOpen() && !document.querySelector('.pin-wrap')), 3000, 'the pop-up stayed open'); await sleep(150); }

/* Every fit problem inside the card. */
function measure(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.pin-card');
    const b = box.getBoundingClientRect();
    const problems = [];
    box.querySelectorAll('*').forEach((el) => {
      if (el.closest('svg')) return;
      const own = [].some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const name = el.className + ' "' + el.textContent.slice(0, 24) + '"';
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) problems.push(name + ' is outside');
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) problems.push(name + ' is cut');
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);
      if (lh && lh < fs * 1.3 - 0.3) problems.push(name + ' line-height ' + (lh / fs).toFixed(2));
    });
    const vw = window.innerWidth, vh = window.innerHeight;
    if (b.left < 0 || b.top < 0 || b.right > vw || b.bottom > vh) problems.push('the card leaves the screen');
    return { problems: problems, text: box.innerText.replace(/\s+/g, ' ').trim() };
  });
}

async function shot(page, file) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, file) });
}

async function main() {
  env.PAGE_PORT = await spare();
  env.PAGE = 'http://127.0.0.1:' + env.PAGE_PORT;
  env.preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(env.PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off', LIGHTS_MODE: 'off', HUB_SPOTIFY: 'off' }),
    stdio: 'ignore'
  });
  await until(() => getOk(env.PAGE + '/'), 10000, 'the preview did not start');
  env.browser = await chromium.launch();

  try {
    await check('pin.js is plain ES5; pin.css: no grid or flex gap, only transform and opacity move, fallbacks, .css-end; hub.html loads both; every pin.* key has Spanish', () => {
      let acorn = null;
      for (const p of ['acorn', '/opt/node-tools/node_modules/acorn', '/usr/local/lib/node_modules_global/acorn']) {
        try { acorn = require(p); break; } catch (e) { /* next */ }
      }
      const text = fs.readFileSync(path.join(ROOT, 'app/pin.js'), 'utf8');
      if (acorn) acorn.parse(text, { ecmaVersion: 5 });
      else assert(!/(^|[^.\w])(let|const)\s|=>|`|\bclass\s/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'ES2015 syntax');
      assert(!/<input|createElement\('input'\)|createElement\("input"\)|textarea/i.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), 'a text box in pin.js');
      const css = fs.readFileSync(path.join(ROOT, 'app/pin.css'), 'utf8');
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/display:\s*grid|\bgap:/.test(bare), 'grid or gap');
      (bare.match(/transition:[^;]+;/g) || []).forEach((t) => {
        t.replace(/^transition:/, '').replace(/\([^)]*\)/g, '').split(',').forEach((part) => {
          const prop = part.trim().replace(/;$/, '').split(/\s+/)[0];
          assert(prop === 'opacity' || prop === 'transform' || prop === 'none', 'transition on ' + prop);
        });
      });
      (bare.match(/@keyframes[^{]+\{([\s\S]*?\}\s*)\}/g) || []).forEach((k) => {
        (k.match(/\{\s*([a-z-]+):/g) || []).forEach((p) => assert(/transform|opacity/.test(p), 'keyframes move ' + p));
      });
      assert(/prefers-reduced-motion/.test(bare) && /\.motion-fade \.pin/.test(bare), 'no fallback');
      assert(/\.css-end \{ top: 0; \}\s*$/.test(css), 'no .css-end');
      const hub = fs.readFileSync(path.join(ROOT, 'app/hub.html'), 'utf8');
      assert(hub.indexOf('href="pin.css"') > 0 && hub.indexOf('src="pin.js"') > 0, 'hub.html');
      assert(hub.indexOf('src="pin.js"') < hub.indexOf('src="widgets/today.js"'), 'pin.js after the widgets');
      assert(hub.indexOf('pin-live-stub') < 0, 'the test stub is in hub.html');
      const order = fs.readFileSync(path.join(__dirname, 'styles-test.js'), 'utf8');
      assert(/ pin\.css /.test(order), 'pin.css is not in dev/styles-test.js ORDER');
      const box = { window: {}, location: { search: '' } };
      box.window = box;
      vm.runInNewContext(I18N, box);
      const es = box.HUB_I18N.strings.es;
      const used = {};
      (text.match(/\bT\('(\w+)'/g) || []).forEach((m) => { used['pin.' + m.slice(3, -1)] = 1; });
      const missing = Object.keys(used).filter((k) => !es[k]);
      assert(Object.keys(used).length >= 11 && !missing.length, 'no Spanish for ' + missing.join(', '));
      assert(/PIN/.test(es['pin.wrong']) && /\{n\} s/.test(es['pin.locked']), 'Spanish keeps "PIN" and {n} s');
    });

    await check('first time: On asks to create a PIN, then to confirm it; a mismatch starts over; then On, pop-up gone, focus on the Guest mode row', async () => {
      const p = await open();
      await openClock(p);
      await choose(p, 'on', 'create');
      assert(!(await guestOn(p)), 'on before the PIN');
      assert(/Turn on Guest mode/.test(await popupText(p)) && /Create a 4-digit PIN/.test(await popupText(p)), await popupText(p));
      await type(p, '1357');
      await until(async () => (await pin(p)).stage === 'confirm', 2000, 'no confirm step');
      assert(/Enter it again to confirm/.test(await popupText(p)), await popupText(p));
      await type(p, '1358');
      await until(async () => (await pin(p)).stage === 'create', 2000, 'a mismatch did not start over');
      assert(/didn.t match/.test(await msg(p)), await msg(p));
      assert(!(await p.evaluate(() => window.PIN_STUB.posts.some((x) => x.body.action === 'set'))), 'a mismatch was sent');
      await type(p, '1357');
      await until(async () => (await pin(p)).stage === 'confirm', 2000, 'no confirm step');
      await type(p, '1357');
      await closed(p);
      assert(await guestOn(p), 'Guest mode is not on');
      assert(await p.evaluate(() => window.PIN_STUB.pin === '1357'), 'the PIN was not set on the "Pi"');
      assert(await focused(p) === 'guest-on', 'focus: ' + await focused(p));
      assert(await p.evaluate(() => !!document.querySelector('#panel [data-key="guest-on"].is-selected')), 'On not selected');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    await check('Off and On are both gated: the right PIN turns Guest mode off, then on again', async () => {
      const p = await open({ guest: true, pin: '2580' });
      await openClock(p);
      await choose(p, 'off', 'enter');
      assert(/Turn off Guest mode/.test(await popupText(p)) && /Enter your 4-digit PIN/.test(await popupText(p)), await popupText(p));
      assert(await guestOn(p), 'off before the PIN');
      await type(p, '2580');
      await closed(p);
      assert(!(await guestOn(p)), 'still on');
      assert(await focused(p) === 'guest-off', 'focus: ' + await focused(p));
      await choose(p, 'on', 'enter');
      await type(p, '2580');
      await closed(p);
      assert(await guestOn(p), 'not on again');
      // Choosing the side already chosen asks nothing.
      await focusKey(p, 'guest-on');
      await key(p, 'Enter');
      await sleep(300);
      assert(!(await p.evaluate(() => window.HUB_PIN.isOpen())), 'a pop-up for no change');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    await check('only digits: letters, Shift+digit and other keys ignored, numpad works, dots never digits, the 4th digit sends it', async () => {
      const p = await open({ pin: '4826' });
      await openClock(p);
      await choose(p, 'on', 'enter');
      const before = await p.evaluate(() => document.querySelector('.pin-card').innerText);
      await type(p, ['KeyA', 'KeyZ', 'Space', 'Shift+Digit4', 'Period', 'Minus', 'Tab', 'F1']);
      assert((await pin(p)).filled === 0, 'a non-digit was taken: ' + JSON.stringify(await pin(p)));
      await type(p, ['Digit4']);
      await numpad(p, 8);      // keyCode 104, as a keyboard's number pad sends it
      const s = await pin(p);
      assert(s.filled === 2 && await filledDots(p) === 2, 'dots: ' + JSON.stringify(s));
      const after = await p.evaluate(() => document.querySelector('.pin-card').innerText);
      assert(after === before, 'the card text changed while typing (a digit shown?)');
      assert(await p.evaluate(() => document.querySelector('.pin-dots').textContent === '' && !document.querySelector('.pin-wrap input, .pin-wrap textarea')), 'digits in the dots, or a text box');
      assert(!(await p.evaluate(() => window.PIN_STUB.posts.some((x) => x.body.action === 'check'))), 'sent before 4 digits');
      await type(p, ['Digit2']);
      await numpad(p, 6);
      await closed(p);
      assert(await guestOn(p), 'the numpad PIN did not work');
      const sent = await p.evaluate(() => window.PIN_STUB.posts.filter((x) => x.body.action === 'check').map((x) => x.body.pin));
      assert(sent.length === 1 && sent[0] === '4826', 'sent: ' + sent.join(','));
      await p.ctx.close();
    });

    await check('Back deletes the last digit, Back with none (or while checking) cancels with no change; the hub never sees the keys', async () => {
      const p = await open({ pin: '1111' });
      await openClock(p);
      await choose(p, 'on', 'enter');
      await type(p, '12');
      await key(p, 'Escape');
      assert((await pin(p)).filled === 1, 'Back did not delete: ' + JSON.stringify(await pin(p)));
      await key(p, 'Backspace');
      assert((await pin(p)).filled === 0, 'Backspace did not delete');
      assert(await p.evaluate(() => window.HUB_TEST.open() === 'today'), 'the hub closed the Clock page');
      await key(p, 'ArrowDown');
      await key(p, 'ArrowUp');
      assert(await focused(p) === 'guest-on', 'the arrows moved the Clock page focus: ' + await focused(p));
      await key(p, 'Escape');
      await closed(p);
      assert(!(await guestOn(p)), 'cancel changed Guest mode');
      assert(await p.evaluate(() => window.HUB_TEST.open() === 'today'), 'the Back that cancelled also closed the Clock page');
      assert(await focused(p) === 'guest-on', 'focus after cancel: ' + await focused(p));
      assert(!(await p.evaluate(() => window.PIN_STUB.posts.some((x) => x.body.action === 'check'))), 'a check was sent');
      // Back while the PIN is being checked: closes at once, the late (right) answer changes nothing.
      await p.evaluate(() => { window.PIN_STUB.delay = 800; });
      await choose(p, 'on', 'enter');
      await type(p, '1111');
      assert((await pin(p)).busy, 'not busy while checking');
      await key(p, 'Escape');
      await closed(p);
      await sleep(1000);
      assert(!(await guestOn(p)), 'the late answer turned Guest mode on');
      assert(await p.evaluate(() => window.HUB_TEST.open() === 'today'), 'Back also closed the Clock page');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    await check('wrong PIN: dots cleared, "Wrong PIN", still open; 3 wrong: "Too many tries. Try again in 25 s" counting down, digits ignored', async () => {
      const p = await open({ pin: '9753' });
      await openClock(p);
      await choose(p, 'on', 'enter');
      await type(p, '1111');
      await until(async () => /Wrong PIN/.test(await msg(p)), 2000, 'no Wrong PIN');
      assert((await pin(p)).filled === 0 && await filledDots(p) === 0, 'dots not cleared');
      assert(await p.evaluate(() => window.HUB_PIN.isOpen() && document.querySelector('.pin-dots').className.indexOf('is-wrong') >= 0), 'closed, or no nudge');
      await type(p, '2');
      assert(await msg(p) === '', 'the message stayed after typing again');
      await type(p, '222');
      await until(async () => /Wrong PIN/.test(await msg(p)), 2000, 'no second Wrong PIN');
      await type(p, '3333');
      await until(async () => /Too many tries\. Try again in 25 s/.test(await msg(p)), 2000, 'no lock message');
      assert((await pin(p)).locked, 'not locked');
      await type(p, '9753');
      assert((await pin(p)).filled === 0, 'digits taken while locked');
      await until(async () => /Try again in 24 s/.test(await msg(p)), 2500, 'no countdown');
      assert(!(await guestOn(p)), 'Guest mode changed');
      await key(p, 'Escape');
      await closed(p);
      await p.ctx.close();
    });

    await check('the Pi unreachable: "Can\'t reach the hub. Try again." and nothing changes (on open and on a check)', async () => {
      const p = await open({ pin: '1212' });
      await openClock(p);
      await p.evaluate(() => { window.PIN_STUB.down = true; });
      await focusKey(p, 'guest-on');
      await key(p, 'Enter');
      await until(async () => /Can.t reach the hub\. Try again\./.test(await msg(p)), 3000, 'no message on open');
      await type(p, '1212');
      await until(async () => (await pin(p)) && !(await pin(p)).busy && (await pin(p)).filled === 0, 3000, 'dots not cleared');
      assert(/Can.t reach the hub/.test(await msg(p)), await msg(p));
      assert(await p.evaluate(() => window.HUB_PIN.isOpen()), 'closed');
      assert(!(await guestOn(p)), 'Guest mode changed with the Pi down');
      await p.evaluate(() => { window.PIN_STUB.down = false; });
      await type(p, '1212');
      await closed(p);
      assert(await guestOn(p), 'not on once the Pi answered');
      await p.ctx.close();
    });

    await check('the on-screen keypad with the arrows and OK: digits, Delete, Cancel', async () => {
      const p = await open({ pin: '5208' });
      await openClock(p);
      await choose(p, 'on', 'enter');
      assert((await pin(p)).focus === '1', 'starts on ' + (await pin(p)).focus);
      // 5: right, down. Then 2: up. Delete: down x3 to row 4, right.
      await key(p, 'ArrowRight'); await key(p, 'ArrowDown'); await key(p, 'Enter');
      await key(p, 'ArrowUp'); await key(p, 'Enter');
      assert((await pin(p)).filled === 2, 'pad digits: ' + JSON.stringify(await pin(p)));
      await key(p, 'ArrowDown', 3); await key(p, 'ArrowRight');
      assert((await pin(p)).focus === 'd', 'not on Delete: ' + (await pin(p)).focus);
      await key(p, 'Enter');
      assert((await pin(p)).filled === 1, 'Delete did not delete');
      await key(p, 'ArrowLeft'); await key(p, 'ArrowUp', 3); await key(p, 'Enter');   // 2 again (middle column, top row)
      await key(p, 'ArrowDown', 3); await key(p, 'Enter');          // 0
      await key(p, 'ArrowUp'); await key(p, 'Enter');               // 8
      await closed(p);
      assert(await guestOn(p), 'the keypad PIN did not work');
      // Cancel on the pad.
      await choose(p, 'off', 'enter');
      await key(p, 'ArrowDown', 3); await key(p, 'ArrowLeft', 2);
      assert((await pin(p)).focus === 'c', 'not on Cancel');
      await key(p, 'Enter');
      await closed(p);
      assert(await guestOn(p), 'Cancel changed Guest mode');
      // A click on a key works too.
      await choose(p, 'off', 'enter');
      for (const d of '5208') await p.click('.pin-key[data-pin="' + d + '"]');
      await closed(p);
      assert(!(await guestOn(p)), 'clicks did not work');
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    await check('Spanish +25% (Á É ñ ¿ ¡): create, enter on/off, wrong, locked, can\'t reach: nothing outside the card, nothing cut, line-height 1.3', async () => {
      const p = await open({ lang: 'es', grow: true });
      await openClock(p);
      const all = [];
      const look = async (what) => {
        await sleep(250);
        const r = await measure(p);
        r.problems.forEach((x) => all.push(what + ': ' + x));
        return r;
      };
      await choose(p, 'on', 'create');
      let r = await look('create');
      assert(/Activar el modo invitados/.test(r.text) && /Cancelar/.test(r.text) && /Borrar/.test(r.text), r.text);
      await type(p, '4444');
      await until(async () => (await pin(p)).stage === 'confirm', 2000, 'no confirm');
      await look('confirm');
      await type(p, '4445');
      await until(async () => (await msg(p)).length > 0, 2000, 'no mismatch');
      await look('mismatch');
      await p.evaluate(() => { window.PIN_STUB.pin = '4444'; });
      await key(p, 'Escape');
      await closed(p);
      await choose(p, 'on', 'enter');
      await type(p, '0000');
      await until(async () => /PIN incorrecto/.test(await msg(p)), 2000, 'no wrong');
      await look('wrong');
      await type(p, '00000000');
      await until(async () => /Demasiados intentos/.test(await msg(p)), 2500, 'no lock');
      r = await look('locked');
      await key(p, 'Escape');
      await closed(p);
      await p.evaluate(() => { window.PIN_STUB.down = true; window.PIN_STUB.lockedUntil = 0; window.HUB_GUEST.set(true); });
      await p.evaluate(() => window.HUB_TEST.closePanel());
      await until(() => p.evaluate(() => !window.HUB_TEST.busy() && !window.HUB_TEST.open()), 4000, 'did not close');
      await openClock(p);
      await focusKey(p, 'guest-off');
      await key(p, 'Enter');
      await until(async () => /No se puede conectar/.test(await msg(p)), 3000, 'no unreachable');
      r = await look('unreachable, off');
      assert(/Desactivar el modo invitados/.test(r.text), r.text);
      assert(!all.length, all.slice(0, 4).join('; '));
      assert(!p.ctx.errors.length, 'console: ' + p.ctx.errors.join(' | '));
      await p.ctx.close();
    });

    if (SHOTS) {
      await check('pictures (device scale 2): empty, two dots, wrong (English); locked, create (Spanish)', async () => {
        let p = await open({ scale: 2, pin: '7531' });
        await openClock(p);
        await choose(p, 'on', 'enter');
        await sleep(400);
        await shot(p, 'pin-popup-empty-en.png');
        await type(p, '75');
        await sleep(300);
        await shot(p, 'pin-popup-dots-en.png');
        await type(p, '00');
        await until(async () => /Wrong PIN/.test(await msg(p)), 2000, 'no wrong');
        await sleep(450);
        await shot(p, 'pin-wrong-en.png');
        await p.ctx.close();
        p = await open({ scale: 2, lang: 'es', pin: '7531' });
        await openClock(p);
        await choose(p, 'on', 'enter');
        await type(p, '000000000000');
        await until(async () => /Demasiados intentos/.test(await msg(p)), 2500, 'no lock');
        await sleep(400);
        await shot(p, 'pin-locked-es.png');
        await p.ctx.close();
        p = await open({ scale: 2, lang: 'es' });
        await openClock(p);
        await choose(p, 'on', 'create');
        await type(p, '1');
        await sleep(400);
        await shot(p, 'pin-create-es.png');
        await p.ctx.close();
      });
    }
  } finally {
    await env.browser.close();
    env.preview.kill();
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
