/*
 * Live updates, end to end: node dev/live-test.js
 *
 * Runs the nine checks in docs/live-updates.md ("How it is tested") against
 * the real hub in headless Chromium, the preview (dev/preview.js) and the hub
 * server from pi/, all on spare ports with a fresh data folder each run.
 * Checks 4 to 7 run a second time with ?livepoll=1 (the fallback for old
 * browsers), which is check 9. Needs Playwright (require('playwright')).
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * Nothing here reaches the internet: the weather services are blocked, so
 * the weather answers come from dev/samples through the pretend service.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const clockPage = require('./clock-page');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'preview-token-not-a-secret-000000';
const BLOCKED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'ipwho.is', 'get.geojs.io', '192.168.1.219'];

let PAGE_PORT, SERVICE_PORT, LIVE_PORT, PAGE, LIVE;
let dataDir;
let preview = null;
let pi = null;
let browser = null;
const extraServers = [];
const openContexts = new Set();

const results = [];

/* ---------- small helpers ---------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function spare() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function assert(cond, text) {
  if (!cond) throw new Error(text);
}

async function until(fn, ms, text) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(text + (last !== undefined && last !== false ? ' (last: ' + JSON.stringify(last) + ')' : ''));
}

function waitForPort(port) {
  return until(() => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: 500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  }), 10000, 'port ' + port + ' did not open');
}

// The control API, with the test token.
function control(method, route, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: LIVE_PORT, path: route, method: method,
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('not JSON: ' + out.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

function command(type, data) { return control('POST', '/api/command', { type: type, data: data || {} }); }

async function serverItems() { return (await control('GET', '/api/todo')).items; }

/* ---------- servers ---------- */

async function startPi() {
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  pi = server.start({
    token: TOKEN, port: LIVE_PORT, host: '127.0.0.1', origins: [PAGE], dataDir: dataDir, log: false
  });
  if (pi.ready) await pi.ready;
  else await waitForPort(LIVE_PORT);
  return pi;
}

function stopPi() {
  return new Promise((resolve) => {
    if (!pi) return resolve();
    const old = pi;
    pi = null;
    old.close(() => resolve());
  });
}

// A stand-in at the live address that answers every request the same way.
function stranger(status, type, body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': PAGE,
        'Cache-Control': 'no-store'
      });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => {
      extraServers.push(s);
      resolve('http://127.0.0.1:' + s.address().port);
    });
  });
}

/* ---------- pages ---------- */

// A fresh browser profile (empty localStorage) that records what happens.
async function newContext(options) {
  const context = await browser.newContext(Object.assign({ viewport: { width: 1920, height: 1080 } }, options || {}));
  context.log = { errors: [], requests: [] };
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const url = route.request().url();
    for (const host of BLOCKED_HOSTS) {
      if (url.indexOf('://' + host + '/') > 0 || url.indexOf('://' + host + ':') > 0) return route.abort();
    }
    return route.continue();
  });
  return context;
}

async function openHub(context, query) {
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = (msg.location() && msg.location().url) || '';
    // The blocked weather services show as failed loads; those are the test's doing.
    if (BLOCKED_HOSTS.some((h) => where.indexOf('://' + h) > 0)) return;
    context.log.errors.push(msg.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.log.errors.push('page error: ' + e.message));
  page.on('request', (req) => context.log.requests.push(req.url()));
  await page.goto(PAGE + '/' + (query ? '?' + query : ''));
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 10000 });
  return page;
}

function liveQuery(poll) { return 'live=' + encodeURIComponent(LIVE) + (poll ? '&livepoll=1' : ''); }

const look = {
  // The About panel (opened, read and closed again).
  statusLines: (page) => clockPage.lines(page),
  liveLine: (page) => clockPage.line(page, 'live'),
  todoSub: (page) => page.evaluate(() => { const e = document.querySelector('.cell[data-widget="todo"] .tile-sub'); return e ? e.textContent : null; }),
  panelSub: (page) => page.evaluate(() => { const e = document.querySelector('#panel .panel-sub'); return e ? e.textContent : null; }),
  tileTitles: (page) => page.$$eval('.cell[data-widget="todo"] .todo-tile-title', (els) => els.map((e) => e.textContent)),
  state: (page) => page.evaluate(() => window.HUB_LIVE ? window.HUB_LIVE.status().state : 'none'),
  open: (page) => page.evaluate(() => window.HUB_TEST.busy() ? 'busy' : window.HUB_TEST.open()),
  mode: (page) => page.evaluate(() => window.HUB_TEST.mode()),
  tiles: (page) => page.$$eval('#grid .tile', (els) => els.length),
  toast: (page) => page.evaluate(() => { const t = document.getElementById('toast'); return t.className.indexOf('is-shown') >= 0 ? t.textContent : null; })
};

async function waitIdle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
}

async function openTodo(page) {
  await waitIdle(page);
  if (await look.open(page) !== 'todo') {
    await page.click('.cell[data-widget="todo"] .tile');
    await until(async () => (await look.open(page)) === 'todo', 4000, 'the to-do panel did not open');
  }
  await waitIdle(page);
}

async function closePanel(page) {
  await waitIdle(page);
  await sleep(350);   // the hub ignores Back just after typing stops
  if (await look.open(page)) await page.keyboard.press('Escape');
  await until(async () => (await look.open(page)) === null, 4000, 'the panel did not close');
}

// Adds a to-do with the remote's path: OK on the box, type, Done.
async function addOnScreen(page, title) {
  await openTodo(page);
  await page.click('#panel input.todo-input');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await until(async () => (await page.$$eval('#panel .todo-title', (els) => els.map((e) => e.textContent))).indexOf(title) >= 0,
    3000, 'the new item did not show in the panel');
}

async function tickOnScreen(page, title) {
  await openTodo(page);
  const key = await page.evaluate((t) => {
    const rows = document.querySelectorAll('#panel .todo-main');
    for (let i = 0; i < rows.length; i++) if (rows[i].querySelector('.todo-title').textContent === t) return rows[i].getAttribute('data-key');
    return null;
  }, title);
  assert(key, 'no row for "' + title + '"');
  await page.click('#panel .todo-main[data-key="' + key + '"]');
  await until(() => page.evaluate((k) => {
    const m = document.querySelector('#panel .todo-main[data-key="' + k + '"]');
    return !!m && m.parentNode.className.indexOf('is-done') >= 0;
  }, key), 3000, 'the row did not tick');
}

function noErrors(context, allowNetwork) {
  const errors = context.log.errors.filter((e) => !(allowNetwork && /Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)));
  assert(!errors.length, 'console errors: ' + errors.join(' | '));
}

/* ---------- the checks ---------- */

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    await closeContexts();
    results.push(true);
    console.log('ok    ' + name + ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    await closeContexts();
    results.push(false);
    console.log('FAIL  ' + name + ': ' + (e && e.message));
  }
}

// A failed check must not leave a screen connected for the next one.
async function closeContexts() {
  for (const c of Array.from(openContexts)) {
    if (shared && shared.context === c) continue;
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

async function check1() {
  // live.server '' in config.js, exactly as a hub with live updates turned off.
  const context = await newContext();
  await context.route('**/config.js', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    assert(/live:\s*\{\s*server:[^}]*\}/.test(body), 'config.js has no live setting');
    body = body.replace(/live:\s*\{\s*server:[^}]*\}/, "live: { server: '' }");
    await route.fulfill({ response: res, body: body });
  });
  const page = await openHub(context, '');
  await sleep(1500);
  const lines = await look.statusLines(page);
  // In the About panel: the version, the browser and motion; no live updates row.
  assert(lines.length === 3, 'expected 3 rows, got ' + JSON.stringify(lines));
  assert(lines[0].indexOf('v0.28.9') === 0, 'first status line: ' + lines[0]);
  assert((await look.todoSub(page)) === 'On this TV', 'to-do sub line: ' + (await look.todoSub(page)));
  assert((await look.state(page)) === 'off', 'live state: ' + (await look.state(page)));
  await addOnScreen(page, 'Milk');
  assert((await look.panelSub(page)) === 'On this TV', 'panel sub line: ' + (await look.panelSub(page)));
  await tickOnScreen(page, 'Milk');
  await closePanel(page);
  const stored = await page.evaluate(() => ({
    list: localStorage.getItem('homeHub.todo.v1'),
    outbox: localStorage.getItem('homeHub.todo.outbox'),
    seen: localStorage.getItem('homeHub.live.seen')
  }));
  assert(stored.list && stored.list.indexOf('Milk') > 0, 'the list was not saved');
  assert(stored.outbox === null && stored.seen === null, 'live keys were written: ' + JSON.stringify(stored));
  const live = context.log.requests.filter((u) => u.indexOf(':' + LIVE_PORT) > 0 || u.indexOf(':8097') > 0);
  assert(!live.length, 'requests to a live address: ' + live.join(', '));
  noErrors(context, false);
  await context.close();

  // Mixed versions: hub.js without live.js still builds the whole screen.
  const old = await newContext();
  await old.route('**/live.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  const page2 = await openHub(old, liveQuery(false));
  assert((await look.tiles(page2)) >= 8, 'the grid is missing tiles without live.js');
  assert((await look.statusLines(page2)).length === 3, 'a live updates row without live.js');
  assert((await look.todoSub(page2)) === 'On this TV', 'to-do sub line without live.js');
  await addOnScreen(page2, 'Eggs');
  await closePanel(page2);
  assert(!old.log.errors.filter((e) => e.indexOf('live.js') < 0 && !/Failed to load resource/.test(e)).length,
    'console errors without live.js: ' + old.log.errors.join(' | '));
  await old.close();
}

let shared = null;   // the page from check 2, reused by check 3

async function check2() {
  const context = await newContext();
  const page = await openHub(context, liveQuery(false));
  await page.evaluate(() => {
    localStorage.setItem('homeHub.todo.v1', JSON.stringify({ v: 1, items: [
      { id: 'tvlocal1', title: 'Made on the TV', section: 'now', done: false, doneAt: null, createdAt: Date.now() }] }));
  });
  await page.reload();
  await page.waitForFunction(() => window.HUB_TEST && document.querySelectorAll('#grid .tile').length > 0);
  await sleep(3000);
  assert((await look.state(page)) === 'quiet', 'state: ' + (await look.state(page)));
  assert((await look.statusLines(page)).length === 3, 'a live updates row showed');
  assert((await look.todoSub(page)) === 'On this TV', 'to-do sub line: ' + (await look.todoSub(page)));
  assert((await look.toast(page)) === null, 'a toast showed: ' + (await look.toast(page)));
  await addOnScreen(page, 'Bread');
  await closePanel(page);
  const outbox = await page.evaluate(() => localStorage.getItem('homeHub.todo.outbox'));
  assert(outbox === null, 'an outbox was written before the first contact');
  noErrors(context, true);
  shared = { context: context, page: page };
}

async function check3() {
  assert(shared, 'check 2 did not leave a page');
  const page = shared.page;
  await startPi();
  await until(async () => (await look.state(page)) === 'live', 20000, 'the hub did not connect by itself');
  await clockPage.waitFor(page, (a) => a.live === 'Live', 3000, 'no "Live" row in the About panel');
  await until(async () => (await look.todoSub(page)) === 'In sync', 5000, 'to-do sub line is not "In sync"');
  const titles = (await serverItems()).map((i) => i.title);
  assert(titles.indexOf('Made on the TV') >= 0 && titles.indexOf('Bread') >= 0, 'the TV\'s items did not reach the Pi: ' + JSON.stringify(titles));
  noErrors(shared.context, true);
  await shared.context.close();
  shared = null;
}

async function check4(poll) {
  const context = await newContext();
  const page = await openHub(context, liveQuery(poll));
  await until(async () => (await look.state(page)) === 'live', 10000, 'not live');
  if (poll) {
    await sleep(300);   // let the first poll hand out its cursor
    const screens = (await control('GET', '/api/status')).screens;
    assert(screens.length === 1 && screens[0].via === 'poll', 'not on the fallback: ' + JSON.stringify(screens));
  }

  let r = await command('show', { widget: 'weather' });
  assert(r.ok && r.delivered === 1, 'show weather: ' + JSON.stringify(r));
  await until(async () => (await look.open(page)) === 'weather', 4000, 'weather did not open');
  await waitIdle(page);
  const focused = await page.evaluate(() => { const t = document.querySelector('#grid .tile.is-focused'); return t && t.parentNode.getAttribute('data-widget'); });
  assert(focused === 'weather', 'home focus is on ' + focused);

  r = await command('home');
  assert(r.delivered === 1, 'home: ' + JSON.stringify(r));
  await until(async () => (await look.open(page)) === null, 4000, 'home did not close the panel');

  r = await command('say', { text: 'Dinner in 10', seconds: 3 });
  await until(async () => (await look.toast(page)) === 'Dinner in 10', 3000, 'say did not show');

  // From typing in another panel straight to a widget, full screen.
  await openTodo(page);
  await page.click('#panel input.todo-input');
  await page.keyboard.type('half typed');
  await command('show', { widget: 'entertainment', mode: 'full' });
  await until(async () => (await look.open(page)) === 'entertainment' && (await look.mode(page)) === 'full', 5000, 'show entertainment full did not land');
  await waitIdle(page);

  // The same panel open: only the mode changes.
  await command('show', { widget: 'entertainment', mode: 'panel' });
  await until(async () => (await look.mode(page)) === 'panel', 4000, 'the mode was not fixed');

  await waitIdle(page);
  await command('show', { widget: 'nosuch' });
  await until(async () => /Asked to show "nosuch", which this hub doesn.t have\./.test((await look.toast(page)) || ''), 3000, 'no toast for an unknown widget');
  assert((await look.open(page)) === 'entertainment', 'an unknown widget closed the panel');

  // A command older than 30 seconds' worth of page is fine; reload right after loading is ignored.
  await command('reload');
  await sleep(500);
  assert(await page.evaluate(() => !!window.HUB_TEST), 'reload was not ignored right after loading');

  await command('home');
  await until(async () => (await look.open(page)) === null, 4000, 'home did not close the panel');
  noErrors(context, false);
  await context.close();
}

async function check5(poll) {
  const context = await newContext();
  const page = await openHub(context, liveQuery(poll));
  await until(async () => (await look.state(page)) === 'live', 10000, 'not live');
  const title = poll ? 'Call the vet (poll)' : 'Buy milk';
  const r = await control('POST', '/api/todo', { title: title });
  assert(r.ok, 'add: ' + JSON.stringify(r));
  await until(async () => (await look.tileTitles(page)).indexOf(title) >= 0, 4000, 'the new to-do did not show on the tile');
  await tickOnScreen(page, title);
  await until(async () => {
    const it = (await serverItems()).filter((i) => i.title === title)[0];
    return it && it.done === true;
  }, 4000, 'the tick did not reach the Pi');
  // An add from the Pi while the panel is open shows in it, and the ticked row stays put.
  const other = title + ', too';
  await control('POST', '/api/todo', { title: other });
  await until(async () => (await page.$$eval('#panel .todo-title', (els) => els.map((e) => e.textContent))).indexOf(other) >= 0,
    4000, 'an add from the Pi did not show in the open panel');
  const stillThere = await page.$$eval('#panel .todo-sec-now .todo-row.is-done .todo-title', (els) => els.map((e) => e.textContent));
  assert(stillThere.indexOf(title) >= 0, 'the ticked row moved away while the panel was open');
  await until(async () => (await look.panelSub(page)) === 'In sync', 3000, 'panel sub line: ' + (await look.panelSub(page)));
  await closePanel(page);
  noErrors(context, false);
  await context.close();
}

async function check6(poll) {
  const context = await newContext();
  let page = await openHub(context, liveQuery(poll));
  await until(async () => (await look.state(page)) === 'live', 10000, 'not live');
  await page.close();
  if (!poll) {
    await until(async () => !(await control('GET', '/api/status')).screens.length, 15000, 'the server still lists the closed screen');
  } else {
    // A poll screen stays listed for a while after its last poll, and the
    // fallback remembers commands for 10 seconds while one was seen lately.
    // Past that nothing is kept.
    if (pi && typeof pi._debug === 'function') await until(() => pi._debug().polls === 0, 5000, 'a poll is still open');
    await sleep(11000);
  }

  const title = poll ? 'Dentist at 3 (poll)' : 'Dentist at 3';
  await control('POST', '/api/todo', { title: title });
  const r = await command('show', { widget: 'weather' });
  assert(r.ok && r.delivered === 0, 'show with the TV off: ' + JSON.stringify(r));
  if (pi && typeof pi._debug === 'function') {
    const d = pi._debug();
    assert(d.sse === 0 && d.polls === 0 && d.commands === 0, 'the server keeps something: ' + JSON.stringify(d));
  }

  page = await openHub(context, liveQuery(poll));
  await until(async () => (await look.tileTitles(page)).indexOf(title) >= 0, 10000, 'the new to-do is not there after turning on');
  await sleep(2000);
  assert((await look.open(page)) === null, 'the old show command fired');
  assert((await look.tiles(page)) >= 8, 'tiles are missing');
  assert((await look.liveLine(page)) === 'Live', 'live line: ' + (await look.liveLine(page)));
  noErrors(context, false);
  await context.close();
}

async function check7(poll) {
  const context = await newContext();
  const page = await openHub(context, liveQuery(poll));
  await until(async () => (await look.state(page)) === 'live', 10000, 'not live');
  await stopPi();
  await clockPage.waitFor(page, (a) => /^Live: lost the Pi at \d{1,2}:\d{2}\s?[AP]M$/.test(a.live || ''), 15000,
    'the About panel does not say the Pi is lost');
  await until(async () => (await look.todoSub(page)) === 'Saved here', 3000, 'to-do sub line: ' + (await look.todoSub(page)));
  const title = poll ? 'While away (poll)' : 'While away';
  await addOnScreen(page, title);
  await until(async () => (await look.panelSub(page)) === 'Saved here, 1 to send', 3000, 'panel sub line: ' + (await look.panelSub(page)));
  await tickOnScreen(page, title);
  await closePanel(page);
  await until(async () => (await look.todoSub(page)) === 'Saved here, 2 to send', 3000, 'to-do sub line: ' + (await look.todoSub(page)));
  const outbox = await page.evaluate(() => JSON.parse(localStorage.getItem('homeHub.todo.outbox') || '{}'));
  assert(outbox.ops && outbox.ops.length === 2, 'outbox: ' + JSON.stringify(outbox));

  await startPi();
  await until(async () => (await look.todoSub(page)) === 'In sync', 30000, 'did not get back in sync: ' + (await look.todoSub(page)));
  assert((await look.liveLine(page)) === 'Live', 'live line: ' + (await look.liveLine(page)));
  const it = (await serverItems()).filter((i) => i.title === title)[0];
  assert(it && it.done === true, 'the changes made while away did not reach the Pi: ' + JSON.stringify(it));
  noErrors(context, true);
  await context.close();
}

async function check8() {
  const refused = await stranger(403, 'application/json', JSON.stringify({ ok: false, error: 'screen not allowed' }));
  const html = await stranger(200, 'text/html', '<!doctype html><title>Router</title><p>Hello');
  const future = await stranger(200, 'application/json', JSON.stringify({ ok: true, v: 2, epoch: 'x', rev: 1, resources: {} }));
  const cases = [
    [refused, 'Live: the Pi refused this TV', 'refused'],
    [html, 'Live: unexpected reply from the Pi', 'badreply'],
    [future, 'Live: the hub needs an update', 'needsupdate']
  ];
  for (const c of cases) {
    const context = await newContext();
    const page = await openHub(context, 'live=' + encodeURIComponent(c[0]));
    await clockPage.waitFor(page, (a) => a.live === c[1], 10000, 'expected "' + c[1] + '"');
    assert((await look.state(page)) === c[2], 'state: ' + (await look.state(page)));
    assert((await look.todoSub(page)) === 'On this TV', 'to-do sub line: ' + (await look.todoSub(page)));
    assert((await look.tiles(page)) >= 8, 'tiles are missing');
    noErrors(context, true);
    await context.close();
  }
}

// A push line that never works, while snapshots do: after three failures
// the hub moves to the fallback for good.
async function checkSwitch() {
  const hits = { events: 0, poll: 0 };
  const s = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': PAGE, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const route = req.url.split('?')[0];
    if (route === '/live/state') {
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ ok: true, v: 1, epoch: 'sw', rev: 1, resources: { todo: { rev: 1, data: { items: [] } } } }));
    }
    if (route === '/live/events') { hits.events++; res.writeHead(500, cors); return res.end('{}'); }
    if (route === '/live/poll') {
      hits.poll++;
      return setTimeout(() => { res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, v: 1, epoch: 'sw', rev: 1, resources: {}, commands: [], cursor: 'c1' })); }, 1000);
    }
    res.writeHead(404, cors);
    res.end('{}');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  extraServers.push(s);
  const context = await newContext();
  const page = await openHub(context, 'live=' + encodeURIComponent('http://127.0.0.1:' + s.address().port));
  await until(() => hits.poll > 0, 20000, 'the fallback was not used (push line tries: ' + hits.events + ')');
  assert(hits.events === 3, 'push line tries: ' + hits.events);
  await sleep(2500);
  assert(hits.events === 3, 'the push line was tried again after the switch');
  assert((await look.liveLine(page)) === 'Live', 'live line: ' + (await look.liveLine(page)));
  noErrors(context, true);
  await context.close();
}

/* ---------- run ---------- */

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'pi', 'server.js'))) {
    console.log('pi/server.js is missing, so there is nothing to test against.');
    process.exit(1);
  }
  PAGE_PORT = await spare();
  // hub.js always asks for the TV's service on port 8095.
  SERVICE_PORT = 8095;
  LIVE_PORT = await spare();
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  LIVE = 'http://127.0.0.1:' + LIVE_PORT;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-live-test-'));

  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: String(SERVICE_PORT), HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(PAGE_PORT);
  browser = await chromium.launch();

  await check('1. No server set: the hub behaves as before', check1);
  await check('2. Server set but not running: nothing shows', check2);
  await check('3. Server starts later: the hub connects by itself', check3);
  await check('4. show, home, say: the screen follows', () => check4(false));
  await check('5. To-do: an add on the Pi shows, a tick on the screen reaches the Pi', () => check5(false));
  await check('6. TV off then on: nothing queued, new to-dos there, old command silent', () => check6(false));
  await check('7. Server stops: the About panel says so, changes are kept and sent later', () => check7(false));
  await check('8. Refused, wrong reply, newer server: each has its own words', check8);
  await check('9a. Fallback (?livepoll=1): show, home, say', () => check4(true));
  await check('9b. Fallback: to-do both ways', () => check5(true));
  await check('9c. Fallback: TV off then on', () => check6(true));
  await check('9d. Fallback: server stops and comes back', () => check7(true));
  await check('9e. Push line fails three times: the fallback takes over', checkSwitch);
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  await stopPi();
  extraServers.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } });
  if (preview) preview.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
