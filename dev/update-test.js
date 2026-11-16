/*
 * Updates, end to end: node dev/update-test.js
 *
 * Runs the shell (app/index.html) and app/update.js in headless Chromium
 * against a pretend TizenBrew proxy that behaves like the real one: every
 * /module/<encodeURIComponent(module)>/<file> answers 200, a file or commit
 * jsDelivr "can't find" is a short plain-text body, the type comes from the
 * extension, and it can be told to hang. It serves several pretend commits
 * built from the working tree:
 *
 *   @main      the working tree, as jsDelivr's branch cache would
 *   A          the working tree
 *   B          the same with another BUILD, so the screen shows which runs
 *   BROKEN     its hub.js throws at once
 *   MISSING    jsDelivr can't find anything
 *   LEGACY     made before update.js: no hubPage, index.html is the whole hub
 *
 * GitHub is faked with Playwright routing (a sha, 403, garbage, an abort or
 * no answer at all). The pretend service on 8095 and the laptop preview come
 * from dev/preview.js. Nothing reaches the internet: every other outside
 * address is aborted.
 *
 * Prints one line per check and "N passed, M failed"; exits 1 on a failure.
 * Screenshots go to $UPDATE_TEST_SHOTS when it is set.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const { chromium } = require('playwright');
const clockPage = require('./clock-page');

const ROOT = path.join(__dirname, '..');
const OWNER = 'irosen419';
const REPO = 'tizen-takeover';
const TOKEN = 'preview-token-not-a-secret-000000';
const SHOTS = process.env.UPDATE_TEST_SHOTS || '';

function fakeSha(name) { return crypto.createHash('sha1').update('pretend commit ' + name).digest('hex'); }
const A = fakeSha('A');
const B = fakeSha('B');
const BROKEN = fakeSha('broken');
const MISSING = fakeSha('missing');
const LEGACY = fakeSha('legacy');

let PROXY_PORT, PROXY, PAGE_PORT, PAGE, LIVE_PORT;
let proxyServer = null;
let preview = null;
let pi = null;
let browser = null;
let dataDir = null;
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

/* ---------- the pretend commits ---------- */

function readWorking(rest) {
  const file = path.normalize(path.join(ROOT, rest));
  if (file.indexOf(ROOT + path.sep) !== 0) return null;
  // Only what TizenBrew would see: the module's own files.
  if (!/^(app\/|package\.json$|service\.js$)/.test(rest)) return null;
  try { return fs.readFileSync(file); } catch (e) { return null; }
}

function withBuild(text, build) {
  const out = text.replace(/var BUILD = 'v[^']*';/, "var BUILD = '" + build + "';");
  if (out === text) throw new Error('hub.js has no BUILD line');
  return out;
}

const COMMITS = {
  main: (rest) => readWorking(rest),
  [A]: (rest) => readWorking(rest),
  [B]: (rest) => {
    const body = readWorking(rest);
    if (rest === 'app/hub.js' && body) return Buffer.from(withBuild(body.toString('utf8'), 'v0.18.0-B'));
    return body;
  },
  [BROKEN]: (rest) => {
    if (rest === 'app/hub.js') return Buffer.from("throw new Error('pretend broken build');\n");
    return readWorking(rest);
  },
  [MISSING]: () => null,
  [LEGACY]: (rest) => {
    if (rest === 'package.json') {
      const pkg = JSON.parse(readWorking('package.json').toString('utf8'));
      delete pkg.hubPage;
      pkg.version = '0.9.9';
      return Buffer.from(JSON.stringify(pkg, null, 2));
    }
    if (rest === 'app/index.html') {
      const html = readWorking('app/hub.html').toString('utf8');
      const out = html.replace(/\s*<script src="update\.js"><\/script>/, '');
      if (out === html) throw new Error('hub.html does not load update.js');
      return Buffer.from(out);
    }
    if (rest === 'app/hub.html' || rest === 'app/update.js') return null;
    if (rest === 'app/hub.js') return Buffer.from(withBuild(readWorking(rest).toString('utf8'), 'v0.9.9-legacy'));
    return readWorking(rest);
  }
};

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml'
};

const proxy = { hang: false, log: [], held: [] };

function startProxy() {
  proxyServer = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/__blank') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>blank</title>');
    }
    const m = /^\/module\/([^/]+)\/(.+)$/.exec(pathname);
    let mod = null;
    try { mod = m ? decodeURIComponent(m[1]) : null; } catch (e) { mod = null; }
    const r = mod ? /^gh\/([^/@]+)\/([^/@]+)@(.+)$/.exec(mod) : null;
    const rest = m ? m[2] : '';
    const entry = { ref: r ? r[3] : null, rest: rest, notFound: false, at: Date.now() };
    proxy.log.push(entry);
    if (proxy.hang) { proxy.held.push(res); return; }
    let body = null;
    if (r && r[1] === OWNER && r[2] === REPO && COMMITS[r[3]]) body = COMMITS[r[3]](rest);
    // Like TizenBrew: always 200, the type from the extension, jsDelivr's words when it has nothing.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rest)] || 'text/plain' });
    if (body === null) {
      entry.notFound = true;
      return res.end("Couldn't find the requested file /" + rest + ' in ' + OWNER + '/' + REPO + '.');
    }
    res.end(body);
  });
  return new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));
}

function mark() { return proxy.log.length; }
function logSince(at) { return proxy.log.slice(at); }

/* ---------- pretend GitHub ---------- */

// mode: 'sha' (answer github.sha), '403', 'garbage', 'abort', 'hang'.
const github = { mode: 'sha', sha: A, requests: [] };

async function answerGitHub(route) {
  const req = route.request();
  github.requests.push({ url: req.url(), headers: req.headers(), method: req.method() });
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (github.mode === 'abort') return route.abort();
  if (github.mode === 'hang') return;   // never answered
  if (github.mode === '403') {
    return route.fulfill({ status: 403, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ message: 'API rate limit exceeded' }) });
  }
  if (github.mode === 'garbage') {
    return route.fulfill({ status: 200, headers: cors, contentType: 'text/html', body: '<html><body>Hello from a captive portal</body></html>' });
  }
  return route.fulfill({ status: 200, headers: cors, contentType: 'application/vnd.github.sha', body: github.sha + '\n' });
}

/* ---------- pages ---------- */

function moduleUrl(ref, file, query) {
  return PROXY + '/module/' + encodeURIComponent('gh/' + OWNER + '/' + REPO + '@' + ref) + '/' + file + (query ? '?' + query : '');
}

function shellUrl(query) { return moduleUrl('main', 'app/index.html', query); }

// Where a page is: { ref, file, search } or null.
function where(page) {
  let u;
  try { u = new URL(page.url()); } catch (e) { return null; }
  const m = /^\/module\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!m) return { ref: null, file: u.pathname, search: u.search };
  const r = /@(.+)$/.exec(decodeURIComponent(m[1]));
  return { ref: r ? r[1] : null, file: m[2], search: u.search };
}

async function newContext(options) {
  const context = await browser.newContext(Object.assign({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }, options || {}));
  context.log = { errors: [], external: [], requests: [] };
  openContexts.add(context);
  context.on('close', () => openContexts.delete(context));
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^https:\/\/api\.github\.com\//.test(url)) return answerGitHub(route);
    if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url) || /^(data|blob|about):/.test(url)) return route.continue();
    context.log.external.push(url);
    return route.abort();
  });
  context.on('page', (page) => watchPage(context, page));
  return context;
}

function watchPage(context, page) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = (msg.location() && msg.location().url) || '';
    // Aborted outside addresses (the Pi, the weather services, a faked GitHub
    // failure) are the test's doing.
    if (where && !/^https?:\/\/127\.0\.0\.1[:/]/.test(where)) return;
    context.log.errors.push(msg.text() + (where ? ' @ ' + where : ''));
  });
  page.on('pageerror', (e) => context.log.errors.push('page error: ' + e.message + ' @ ' + page.url()));
  page.on('request', (req) => context.log.requests.push(req.url()));
}

async function go(page, url) {
  try {
    await page.goto(url, { waitUntil: 'commit' });
  } catch (e) {
    // The shell moves on at once; a goto cut short by that is fine.
    if (!/interrupted|ERR_ABORTED|frame was detached/i.test(e.message)) throw e;
  }
}

function hubDrawn(page) {
  return page.evaluate(() => !!window.HUB_TEST && document.querySelectorAll('#grid .tile').length >= 8 &&
    !!document.querySelector('.cell[data-widget="today"] .today-time'));
}

// Waits until the page is on ref's file and the hub has drawn.
async function waitAt(page, ref, file, ms) {
  await until(async () => {
    const w = where(page);
    if (!w || w.ref !== ref || w.file !== file) return false;
    return hubDrawn(page);
  }, ms || 15000, 'not on ' + short(ref) + ' ' + file + ' with the hub drawn (at ' + page.url() + ')');
}

function short(ref) { return ref && ref.length === 40 ? ref.substring(0, 7) : String(ref); }

async function record(page) {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('homeHub.release')); } catch (e) { return 'unreadable'; }
  });
}

const look = {
  // The About panel (opened, read and closed again).
  lines: (page) => clockPage.lines(page),
  updateLine: (page) => clockPage.line(page, 'updates'),
  status: (page) => page.evaluate(() => window.HUB_UPDATE ? window.HUB_UPDATE.status() : null),
  open: (page) => page.evaluate(() => window.HUB_TEST.busy() ? 'busy' : window.HUB_TEST.open())
};

async function waitIdle(page) {
  await until(() => page.evaluate(() => !window.HUB_TEST.busy()), 4000, 'the hub stayed busy');
}

function noErrors(context) {
  assert(!context.log.errors.length, 'console errors: ' + context.log.errors.join(' | '));
  assert(!context.log.external.filter((u) => !/192\.168\.1\.219|open-meteo\.com|ipwho\.is|geojs\.io/.test(u)).length,
    'unexpected outside requests: ' + context.log.external.join(', '));
}

// Nothing the hub asked for was a file jsDelivr couldn't find.
function noMissingFiles(entries, allow) {
  const bad = entries.filter((e) => e.notFound && !(allow && allow(e)));
  assert(!bad.length, 'files not found: ' + bad.map((e) => short(e.ref) + '/' + e.rest).join(', '));
}

function githubAsks(since) { return github.requests.slice(since); }

// A context that has run the hub once with GitHub answering `sha`, so that
// commit is the stored good one. Returns the page, on that commit.
async function contextWithGood(sha, query) {
  const context = await newContext();
  const page = await context.newPage();
  github.mode = 'sha';
  github.sha = sha;
  await go(page, shellUrl(query));
  await waitAt(page, sha, 'app/hub.html');
  await until(async () => ((await record(page)) || {}).good === sha, 3000, 'good was not stored');
  return { context, page };
}

async function openPanelAndClose(page) {
  await waitIdle(page);
  await page.keyboard.press('Enter');
  await until(async () => typeof (await look.open(page)) === 'string' && (await look.open(page)) !== 'busy', 4000, 'no panel opened with Enter');
  await waitIdle(page);
  await sleep(350);
  await page.keyboard.press('Escape');
  await until(async () => (await look.open(page)) === null, 4000, 'the panel did not close with Escape');
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
  github.mode = 'sha';
  github.sha = A;
  proxy.hang = false;
}

async function closeContexts() {
  for (const c of Array.from(openContexts)) {
    try { await c.close(); } catch (e) { /* already closed */ }
  }
}

let firstPage = null;   // check 1 leaves its page for check 2

async function check1() {
  const context = await newContext();
  const page = await context.newPage();
  github.mode = 'sha';
  github.sha = A;
  const asked = github.requests.length;
  const at = mark();
  await go(page, shellUrl());
  await waitAt(page, A, 'app/hub.html');
  const rec = await until(async () => { const r = await record(page); return r && r.good === A ? r : false; }, 3000, 'good is not A');
  assert(!rec.trying, 'trying was not cleared: ' + JSON.stringify(rec));
  assert(rec.goodPage === 'app/hub.html' && rec.goodVersion === '0.18.0', 'record: ' + JSON.stringify(rec));
  assert(rec.entry === new URL(shellUrl()).pathname, 'entry: ' + rec.entry);
  const lines = await look.lines(page);
  assert(/^v0\.18\.0 \(newest\)/.test(lines[0]), 'first status line: ' + lines[0]);
  // Version, browser, motion: no version check row when this is the newest.
  assert(lines.length === 3, 'About rows: ' + JSON.stringify(lines));
  const asks = githubAsks(asked);
  assert(asks.length === 1, 'GitHub was asked ' + asks.length + ' times');
  assert(asks[0].url === 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/commits/main', 'GitHub address: ' + asks[0].url);
  assert(asks[0].headers.accept === 'application/vnd.github.sha', 'Accept: ' + asks[0].headers.accept);
  const odd = Object.keys(asks[0].headers).filter((h) => !/^(accept|user-agent|referer|origin|sec-ch-ua.*)$/.test(h));
  assert(!odd.length, 'headers that could need a preflight: ' + odd.join(', '));
  assert(asks[0].method === 'GET', 'method: ' + asks[0].method);
  noMissingFiles(logSince(at));
  // Every hub file came from commit A, none from the branch.
  const fromMain = logSince(at).filter((e) => e.ref === 'main' && e.rest !== 'app/index.html' && e.rest !== 'app/update.js');
  assert(!fromMain.length, 'files from @main: ' + fromMain.map((e) => e.rest).join(', '));
  noErrors(context);
  firstPage = { context, page };
  openContexts.delete(context);   // kept for check 2
}

async function check2() {
  assert(firstPage, 'check 1 did not leave a page');
  const { context, page } = firstPage;
  openContexts.add(context);
  github.sha = B;
  const at = mark();
  await go(page, shellUrl());
  await waitAt(page, B, 'app/hub.html');
  const lines = await look.lines(page);
  assert(/^v0\.18\.0-B \(newest\)/.test(lines[0]), 'first status line: ' + lines[0]);
  const rec = await until(async () => { const r = await record(page); return r && r.good === B ? r : false; }, 3000, 'good is not B');
  assert(!rec.trying, 'trying was not cleared');
  noMissingFiles(logSince(at));
  noErrors(context);
}

async function check3() {
  for (const mode of ['abort', 'hang', '403', 'garbage']) {
    // With a good commit stored: straight to it, within the time limit.
    const { context, page } = await contextWithGood(A);
    github.mode = mode;
    const t0 = Date.now();
    await go(page, shellUrl());
    await waitAt(page, A, 'app/hub.html');
    const took = Date.now() - t0;
    assert(took < 9000, mode + ': took ' + took + ' ms');
    await clockPage.waitFor(page, (a) => a.updates === 'Updates: can\'t reach GitHub', 3000,
      mode + ': update line ');
    const lines = await look.lines(page);
    assert(lines[0].indexOf('(newest)') < 0, mode + ': first line says newest');
    noErrors(context);
    await context.close();

    // Nothing stored: the branch's own hub.html, which works.
    const fresh = await newContext();
    const page2 = await fresh.newPage();
    const at = mark();
    await go(page2, shellUrl());
    await waitAt(page2, 'main', 'app/hub.html');
    await clockPage.waitFor(page2, (a) => a.updates === 'Updates: can\'t reach GitHub', 3000,
      mode + ' (nothing stored): update line ');
    await openPanelAndClose(page2);
    noMissingFiles(logSince(at));
    noErrors(fresh);

    // GitHub answers again: the next check pins it.
    github.mode = 'sha';
    github.sha = A;
    await page2.evaluate(() => { window.HUB_TEST.setIdleMs(0); window.HUB_TEST.checkUpdates(); });
    await waitAt(page2, A, 'app/hub.html');
    await until(async () => ((await record(page2)) || {}).good === A, 3000, 'good is not A after pinning');
    noErrors(fresh);
    await fresh.close();
  }
}

async function check4() {
  const { context, page } = await contextWithGood(A);
  github.sha = BROKEN;
  await go(page, shellUrl());
  await until(() => { const w = where(page); return w && w.ref === BROKEN; }, 10000, 'did not go to the broken commit');
  const leftAt = Date.now();
  await waitAt(page, A, 'app/hub.html', 25000);
  const after = Date.now() - leftAt;
  assert(after > 12000, 'went back after only ' + after + ' ms');
  await clockPage.waitFor(page, (a) => a.updates === 'Updates: a newer version didn\'t start', 3000,
    'update line ');
  let rec = await record(page);
  assert(rec.trying === BROKEN && rec.good === A && rec.note === 'held', 'record: ' + JSON.stringify(rec));

  // Reopening goes straight to A, the broken one isn't touched.
  context.log.errors = [];
  const at = mark();
  await go(page, shellUrl());
  await waitAt(page, A, 'app/hub.html');
  assert(!logSince(at).filter((e) => e.ref === BROKEN).length, 'the broken commit was asked for again');
  assert((await look.updateLine(page)) === 'Updates: a newer version didn\'t start', 'update line after reopening');
  noErrors(context);

  // The branch moves on: B loads.
  github.sha = B;
  await go(page, shellUrl());
  await waitAt(page, B, 'app/hub.html');
  rec = await until(async () => { const r = await record(page); return r && r.good === B ? r : false; }, 3000, 'good is not B');
  assert(!rec.trying, 'trying was not cleared on B: ' + JSON.stringify(rec));
  assert(/^v0\.18\.0-B \(newest\)/.test((await look.lines(page))[0]), 'first line on B');
  noErrors(context);
}

async function check5() {
  const { context, page } = await contextWithGood(A);
  github.sha = MISSING;
  const at = mark();
  await go(page, shellUrl());
  await until(() => logSince(at).some((e) => e.ref === MISSING && e.rest === 'package.json'), 5000, 'no preflight');
  await waitAt(page, A, 'app/hub.html');
  await clockPage.waitFor(page, (a) => a.updates === 'Updates: a newer version isn\'t ready yet', 3000,
    'update line ');
  const rec = await record(page);
  assert(rec.trying !== MISSING, 'the missing commit was tried');
  assert(!logSince(at).some((e) => e.ref === MISSING && e.rest !== 'package.json'), 'more than package.json was asked of it');
  noErrors(context);
}

async function check6() {
  const { context, page } = await contextWithGood(A);
  await page.evaluate(() => window.HUB_TEST.setIdleMs(1500));
  github.sha = B;

  // A panel open: no reload.
  await page.click('.cell[data-widget="todo"] .tile');
  await until(async () => (await look.open(page)) === 'todo', 4000, 'the to-do panel did not open');
  await waitIdle(page);
  await page.evaluate(() => window.HUB_TEST.checkUpdates());
  await until(async () => (await look.status(page)).state === 'waiting', 5000, 'not waiting');
  // The to-do panel is open, so read the text the About panel would show.
  assert((await look.status(page)).text === 'Updates: a newer version is ready', 'update text ' + (await look.status(page)).text);
  await sleep(2500);
  assert(where(page).ref === A, 'reloaded with a panel open');

  // Closed with a key just now: still held back.
  await sleep(350);
  await page.keyboard.press('Escape');
  await until(async () => (await look.open(page)) === null, 4000, 'the panel did not close');
  await page.evaluate(() => window.HUB_TEST.checkUpdates());
  await sleep(800);
  assert(where(page).ref === A, 'reloaded right after a key press');
  assert((await look.status(page)).state === 'waiting', 'not waiting after the key press');

  // Quiet for long enough: into B.
  await sleep(1500);
  await page.evaluate(() => window.HUB_TEST.checkUpdates());
  await waitAt(page, B, 'app/hub.html');
  await until(async () => ((await record(page)) || {}).good === B, 3000, 'good is not B');
  noErrors(context);
}

async function check7() {
  const server = require(path.join(ROOT, 'pi', 'server.js'));
  pi = server.start({ token: TOKEN, port: LIVE_PORT, host: '127.0.0.1', origins: [PROXY], dataDir: dataDir, log: false });
  if (pi.ready) await pi.ready; else await waitForPort(LIVE_PORT);
  const query = 'live=' + encodeURIComponent('http://127.0.0.1:' + LIVE_PORT);
  const { context, page } = await contextWithGood(A, query);
  assert(where(page).search === '?' + query, 'the query was lost: ' + where(page).search);
  await until(() => page.evaluate(() => window.HUB_LIVE && window.HUB_LIVE.status().state === 'live'), 10000, 'not live');
  github.sha = B;
  // The hub ignores reload for 30 seconds after loading.
  await sleep(31000);
  const at = mark();
  const r = await controlCommand('reload');
  assert(r.ok && r.delivered === 1, 'reload: ' + JSON.stringify(r));
  await waitAt(page, B, 'app/hub.html');
  assert(logSince(at).some((e) => e.ref === 'main' && e.rest === 'app/index.html'), 'did not go through the shell');
  assert(where(page).search === '?' + query, 'the query was lost on the way: ' + where(page).search);
  noErrors(context);
}

function controlCommand(type) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify({ type: type, data: {} });
    const req = http.request({
      host: '127.0.0.1', port: LIVE_PORT, path: '/api/command', method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function check8() {
  const { context, page } = await contextWithGood(A);
  github.sha = LEGACY;
  let at = mark();
  await go(page, shellUrl());
  await waitAt(page, LEGACY, 'app/index.html');
  assert(/^v0\.9\.9-legacy/.test((await look.lines(page))[0]), 'first line: ' + (await look.lines(page))[0]);
  const rec = await record(page);
  assert(rec.good === LEGACY && rec.goodPage === 'app/index.html', 'record: ' + JSON.stringify(rec));
  noMissingFiles(logSince(at), (e) => e.ref === LEGACY && e.rest === 'app/update.js');
  // No watchdog there to roll it back, and nothing loops.
  const loads = logSince(at).filter((e) => e.rest === 'app/index.html').length;
  await sleep(16000);
  assert(where(page).ref === LEGACY, 'it was rolled back');
  assert(logSince(at).filter((e) => e.rest === 'app/index.html').length === loads, 'it loaded again by itself');
  // Reopening goes straight there, without asking jsDelivr first.
  at = mark();
  await go(page, shellUrl());
  await waitAt(page, LEGACY, 'app/index.html');
  assert(!logSince(at).some((e) => e.rest === 'package.json'), 'a known good commit was checked again');
  noErrors(context);
}

async function check9() {
  const context = await newContext();
  const page = await context.newPage();
  const asked = github.requests.length;
  await go(page, moduleUrl(B, 'app/index.html', 'motion=fade'));
  await waitAt(page, B, 'app/hub.html');
  assert(where(page).search === '?motion=fade', 'query: ' + where(page).search);
  await sleep(500);
  assert(github.requests.length === asked, 'GitHub was asked');
  assert((await record(page)) === null, 'something was stored: ' + JSON.stringify(await record(page)));
  noErrors(context);
}

async function check10() {
  const entry = new URL(shellUrl()).pathname;
  const bad = [
    'not json {',
    JSON.stringify({ v: 1, entry: entry, good: 'G'.repeat(40), goodPage: 'app/hub.html' }),
    JSON.stringify({ v: 1, entry: entry, good: A.toUpperCase(), goodPage: 'app/hub.html' }),
    JSON.stringify({ v: 1, entry: entry, good: A, goodPage: '../../evil.html' }),
    JSON.stringify({ v: 1, entry: entry, good: A, goodPage: '//evil.example/x.html' }),
    JSON.stringify({ v: 1, entry: entry, good: A, goodPage: 'app//hub.html' }),
    JSON.stringify({ v: 1, entry: '//evil.example/module/x/app/index.html', good: A, goodPage: 'app/hub.html' }),
    JSON.stringify({ v: 1, entry: moduleUrl('main', 'app/index.html').replace(OWNER, 'someone-else').replace(PROXY, ''), good: A, goodPage: 'app/hub.html' }),
    JSON.stringify({ v: 2, entry: entry, good: A, goodPage: 'app/hub.html' }),
    JSON.stringify([1, 2, 3])
  ];
  for (const raw of bad) {
    const context = await newContext();
    const page = await context.newPage();
    await go(page, PROXY + '/__blank');
    await page.evaluate((v) => localStorage.setItem('homeHub.release', v), raw);
    // GitHub away, so a stored good commit would be used if it were believed.
    github.mode = 'abort';
    await go(page, shellUrl());
    await waitAt(page, 'main', 'app/hub.html');
    const rec = await record(page);
    assert(rec && rec.entry === entry && !rec.good, 'record not reset for ' + raw + ': ' + JSON.stringify(rec));
    assert(!context.log.requests.some((u) => /evil/.test(u)), 'went somewhere odd for ' + raw);
    noErrors(context);
    await context.close();
  }

  // The same values with GitHub answering: a goodPage like that never ends up in an address.
  github.mode = 'sha';
  github.sha = B;
  const ctx2 = await newContext();
  const p2 = await ctx2.newPage();
  await go(p2, PROXY + '/__blank');
  await p2.evaluate((v) => localStorage.setItem('homeHub.release', v),
    JSON.stringify({ v: 1, entry: entry, good: B, goodPage: '//evil.example/x.html' }));
  await go(p2, shellUrl());
  await waitAt(p2, B, 'app/hub.html');
  assert(!ctx2.log.requests.some((u) => /evil/.test(u)), 'went somewhere odd');
  await ctx2.close();

  // localStorage that throws: everything works, just without memory.
  github.sha = A;
  const ctx3 = await newContext();
  await ctx3.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new Error('storage denied'); } });
  });
  const p3 = await ctx3.newPage();
  await go(p3, shellUrl());
  await waitAt(p3, A, 'app/hub.html');
  const st = await look.status(p3);
  assert(st && st.managed && st.pinned && st.sha === A, 'status: ' + JSON.stringify(st));
  const pageErrors = ctx3.log.errors.filter((e) => /^page error/.test(e));
  assert(!pageErrors.length, 'page errors: ' + pageErrors.join(' | '));
  await ctx3.close();
}

async function check11() {
  const context = await newContext();
  const page = await context.newPage();
  const asked = github.requests.length;
  await go(page, PAGE + '/?motion=fade');
  await until(async () => new URL(page.url()).pathname === '/hub.html' && (await hubDrawn(page)), 10000, 'not on /hub.html (' + page.url() + ')');
  assert(new URL(page.url()).search === '?motion=fade', 'query: ' + page.url());
  await sleep(500);
  assert(github.requests.length === asked && !context.log.requests.some((u) => /api\.github\.com/.test(u)), 'GitHub was asked');
  assert((await look.updateLine(page)) === null, 'an update line showed');
  const lines = await look.lines(page);
  assert(lines.length === 3 && lines[0].indexOf('(newest)') < 0, 'status lines: ' + JSON.stringify(lines));
  const st = await look.status(page);
  assert(st && st.managed === false && st.text === '' && st.newest === false, 'status: ' + JSON.stringify(st));
  await openPanelAndClose(page);
  assert(await page.evaluate(() => localStorage.getItem('homeHub.release')) === null, 'something was stored');
  noErrors(context);
}

// The About panel with three, four and five rows before the Wanderers ones
// (version, browser, motion, then updates and live updates), and once with
// a visit's load times: every row inside the strip, none over another,
// nothing cut off, the strip on the screen. The Clock page has no About
// section any more, and its time and date fit, in the panel and full screen.
// (That the rows refresh by themselves is checked in dev/clay-test.js.)
async function checkTile() {
  const s = await stranger(403, 'application/json', JSON.stringify({ ok: false, error: 'screen not allowed' }));
  const cases = [
    { rows: 3, mode: 'sha', query: '' },
    { rows: 4, mode: 'abort', query: '' },
    { rows: 5, mode: 'abort', query: 'live=' + encodeURIComponent(s.url) },
    { rows: 5, mode: 'abort', query: 'live=' + encodeURIComponent(s.url), visit: true }
  ];
  for (const c of cases) {
    const { context, page } = await contextWithGood(A, c.query);
    github.mode = c.mode;
    await go(page, shellUrl(c.query));
    await waitAt(page, A, 'app/hub.html');
    // The tile itself shows only the time and the date.
    const tile = await page.evaluate(() => {
      const body = document.querySelector('.cell[data-widget="today"] .tile-body');
      return { text: body.textContent, status: body.querySelectorAll('.today-status-line, .today-place').length };
    });
    assert(tile.status === 0 && !/v0\.|Motion|Updates|Live|Wanderers/.test(tile.text), 'the clock tile shows more than the time: ' + tile.text);
    if (c.visit) {
      // One visit first, stopped once it plays: the Loading row (load times) shows.
      await until(() => page.evaluate(() => !window.HUB_TEST.busy() && window.HUB_TEST.clay.play('fetch', { seed: 1 })), 4000, 'no visit');
      await until(() => page.evaluate(() => window.HUB_TEST.clay.state().phase === 'playing'), 10000, 'the visit did not play');
      await page.evaluate(() => window.HUB_TEST.clay.stop());
    }
    const a = await clockPage.waitFor(page, (x) => x.lines.length === c.rows ? x : null, 10000, c.rows + ' rows');
    assert(/^v0\.18\.0/.test(a.lines[0]), 'version row: ' + a.lines[0]);
    const wand = a.rows.filter((r) => r.group === 'Wanderers').map((r) => r.label + ': ' + r.value);
    if (c.visit) {
      assert(wand.length === 4 && /^Now: due back in \d+ s$/.test(wand[0]) && wand[1] === 'Visits: 1 played · 0 slow · 0 failed' &&
        /^Last visit: fetch stopped, \d+ s ago$/.test(wand[2]) && /^Loading: sprite list \d+ ms · fetch (\d+)\/\1 frames in \d+ ms$/.test(wand[3]), 'wanderers rows: ' + JSON.stringify(wand));
    } else {
      assert(wand.length === 2 && /^Now: due back in \d+ s$/.test(wand[0]) && wand[1] === 'Visits: 0 played · 0 slow · 0 failed', 'wanderers rows: ' + JSON.stringify(wand));
    }
    await clockPage.openAbout(page);
    await sleep(400);
    const fit = await page.evaluate(() => {
      const box = document.querySelector('.about-box').getBoundingClientRect();
      const rows = Array.prototype.map.call(document.querySelectorAll('.about-group, .about-row'), (e) => e.getBoundingClientRect());
      const problems = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].left < box.left - 0.5 || rows[i].right > box.right + 0.5 || rows[i].bottom > box.bottom + 0.5) problems.push('row ' + i + ' outside the strip');
        if (i && rows[i].top < rows[i - 1].bottom - 0.5) problems.push('row ' + i + ' overlaps');
      }
      Array.prototype.forEach.call(document.querySelectorAll('.about-label, .about-value, .about-group'), (e) => {
        if (e.scrollWidth > e.clientWidth + 1) problems.push('"' + e.textContent + '" is cut off');
      });
      if (box.bottom > window.innerHeight || box.top < 0) problems.push('the strip is off the screen');
      return { problems, height: box.height };
    });
    assert(!fit.problems.length, c.rows + ' rows: ' + fit.problems.join(', '));
    await clockPage.closeAbout(page);
    // The Clock page: no About section, the time and date fit.
    await clockPage.open(page);
    for (const mode of ['panel', 'full']) {
      if (mode === 'full') {
        await page.evaluate(() => document.querySelector('#panel .panel-btn').click());
        await until(() => page.evaluate(() => window.HUB_TEST.mode() === 'full' && !window.HUB_TEST.busy()), 4000, 'no full screen');
      }
      await sleep(200);
      const clock = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const problems = [];
        if (document.querySelector('.clock-about, [class*="clock-about"]')) problems.push('an About section is there');
        if (/v0\.\d|Motion|Wanderers/.test(document.querySelector('.clock-page').textContent)) problems.push('the page shows hub facts');
        if (r('.clock-fulldate').bottom > r('.clock-display').bottom + 0.5) problems.push('date below its box');
        if (r('.clock-big').bottom > r('.clock-display').bottom + 0.5) problems.push('time below its box');
        return { problems, clock: r('.clock-display').height };
      });
      assert(!clock.problems.length, 'Clock page, ' + mode + ': ' + clock.problems.join(', '));
      if (SHOTS) {
        await page.screenshot({ path: path.join(SHOTS, 'clock-' + mode + '-' + c.rows + (c.visit ? '-visit' : '') + '.png') });
        console.log('      ' + c.rows + ' rows' + (c.visit ? ' and a visit' : '') + ': About strip ' + fit.height.toFixed(0) + ' px tall; Clock page ' + mode + ', clock box ' + clock.clock.toFixed(0) + ' px tall');
      }
    }
    await context.close();
  }
  s.server.close();
}

function stranger(status, type, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': PROXY, 'Cache-Control': 'no-store' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

// The shell while it waits (GitHub never answers), and how long a normal start takes.
async function checkShell() {
  const context = await newContext();
  const page = await context.newPage();
  github.mode = 'hang';
  await go(page, shellUrl());
  await sleep(400);
  const early = await page.evaluate(() => getComputedStyle(document.querySelector('.wait')).opacity);
  assert(Number(early) < 0.05, 'the text showed early: opacity ' + early);
  await sleep(1700);
  const later = await page.evaluate(() => {
    const e = document.querySelector('.wait');
    const r = e.getBoundingClientRect();
    return { opacity: getComputedStyle(e).opacity, text: e.textContent, right: r.right, width: window.innerWidth,
      bg: getComputedStyle(document.body).backgroundColor };
  });
  assert(Number(later.opacity) > 0.95 && later.text === 'Getting the newest version…', 'shell text: ' + JSON.stringify(later));
  assert(later.bg === 'rgb(5, 5, 6)', 'background: ' + later.bg);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'shell-waiting.png') });
  await waitAt(page, 'main', 'app/hub.html', 10000);
  await context.close();

  // Normal path: GitHub answers, the newest is the stored good one.
  const times = [];
  for (let i = 0; i < 5; i++) {
    const { context: c, page: p } = await contextWithGood(A);
    github.mode = 'sha';
    github.sha = A;
    const t0 = Date.now();
    await go(p, shellUrl());
    await waitAt(p, A, 'app/hub.html');
    const paint = await until(() => p.evaluate(() => {
      const e = performance.getEntriesByName('first-paint')[0] || performance.getEntriesByName('first-contentful-paint')[0];
      return e ? performance.timeOrigin + e.startTime : 0;
    }), 5000, 'no paint timing');
    times.push(Math.round(paint - t0));
    await c.close();
  }
  times.sort((a, b) => a - b);
  console.log('      shell to the hub\'s first paint (normal path, ms): ' + times.join(', ') + '; median ' + times[2]);
}

/* ---------- run ---------- */

async function main() {
  PROXY_PORT = await spare();
  PAGE_PORT = await spare();
  LIVE_PORT = await spare();
  PROXY = 'http://127.0.0.1:' + PROXY_PORT;
  PAGE = 'http://127.0.0.1:' + PAGE_PORT;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-test-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  await startProxy();
  // The laptop preview, and the pretend service.js on 8095 that hub.js asks.
  preview = childProcess.spawn(process.execPath, [path.join(__dirname, 'preview.js')], {
    env: Object.assign({}, process.env, { HUB_PAGE_PORT: String(PAGE_PORT), HUB_SERVICE_PORT: '8095', HUB_LIVE_PORT: 'off' }),
    stdio: 'ignore'
  });
  await waitForPort(PAGE_PORT);
  browser = await chromium.launch();

  await check('1. First run: the @main shell lands on commit A, which is stored as good', check1);
  await check('2. Main moves to B: reopening lands on B', check2);
  await check('3. GitHub unreachable (abort, no answer, 403, garbage): the stored good one, or @main; then pinned', check3);
  await check('4. Broken newest commit: back to A by itself, held, then B when main moves on', check4);
  await check('5. Newest commit not on jsDelivr yet: stays on A', check5);
  await check('6. Idle update: not with a panel open or a key just pressed, then into B', check6);
  await check('7. The live reload command goes through the shell to the newest', check7);
  await check('8. Legacy newest commit: its index.html, no loop, no roll back', check8);
  await check('9. A pinned shell address: no lookup, that commit\'s hub.html', check9);
  await check('10. Tampered or damaged memory is ignored; localStorage that throws is fine', check10);
  await check('11. Laptop preview: /hub.html with the query, no GitHub, no update text', check11);
  await check('12. The About panel fits its rows at 1920x1080; the Clock page has no About section and fits, panel and full screen', checkTile);
  await check('13. The shell: dark, quiet text after 1.2 s, and the normal start time', checkShell);
}

main().catch((e) => {
  results.push(false);
  console.log('FAIL  the test itself: ' + (e && e.stack));
}).then(async () => {
  try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
  if (pi) await new Promise((r) => pi.close(() => r()));
  proxy.held.forEach((res) => { try { res.destroy(); } catch (e) { /* ignore */ } });
  if (proxyServer) proxyServer.close();
  if (preview) preview.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
