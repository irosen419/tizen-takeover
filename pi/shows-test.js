/*
 * Tests for the TV show schedule (shows.js), its server routes and commands,
 * and the watch link test answers (linktests.js). Run from the repo root:
 *
 *   node pi/shows-test.js
 *
 * TVmaze is a stand-in on 127.0.0.1 (nothing reaches the internet): search,
 * the show with its embeds, the episode list, a 404, a 429 and an outage.
 * It prints one line per check, then "N passed, 0 failed".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const shows = require('./shows');
const linktests = require('./linktests');
const hubServer = require('./server');
const mailbox = require('./mailbox');

const TOKEN = 'shows-test-token-0123456789abcdef';
const NOW = Date.parse('2026-11-17T18:00:00Z');
const DAY = 86400000;
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shows-test-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (days, hourUtc) => new Date(Date.parse('2026-11-17T00:00:00Z') + days * DAY + (hourUtc || 0) * 3600000).toISOString().replace('.000Z', '+00:00');

/* ---------- the TVmaze stand-in ---------- */

// Three made-up shows. Hell's Kitchen is broadcast (network FOX), Stick
// streams (webChannel Apple TV+) and is between seasons, Andor has ended.
function catalog() {
  return {
    "hell's kitchen": { id: 101, name: "Hell's Kitchen", status: 'Running', network: { name: 'FOX' }, webChannel: null,
      episodes: [
        { season: 24, number: 6, name: 'Old', airstamp: at(-14, 1) },
        { season: 24, number: 7, name: 'Last week', airstamp: at(-5, 1), runtime: 44 },
        { season: 24, number: 8, name: 'Surf &amp; Turf', airstamp: at(2, 2) },
        { season: 24, number: 9, name: 'Later', airstamp: at(9, 2) },
        { season: 24, number: 10, name: 'Far', airstamp: at(90, 2) }
      ] },
    stick: { id: 202, name: 'Stick', status: 'Running', network: null, webChannel: { name: 'Apple TV+' },
      episodes: [
        { season: 1, number: 10, name: 'Finale', airstamp: at(-120, 1) },
        { season: 2, number: 1, name: 'Back Nine', airstamp: at(65, 2), airdate: '2027-01-20' }
      ] },
    andor: { id: 303, name: 'Andor', status: 'Ended', network: null, webChannel: { name: 'Disney+' },
      episodes: [{ season: 2, number: 12, name: 'End', airstamp: at(-200, 1) }] }
  };
}

function startTvmaze() {
  const cat = catalog();
  const byId = {};
  Object.keys(cat).forEach((k) => { byId[cat[k].id] = cat[k]; });
  const seen = [];
  const m = { mode: 'ok', seen: seen, limit429: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(req.url);
    const send = (status, body, headers) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (m.mode === 'down') return req.socket.destroy();
    if (m.mode === 'error') return send(503, { name: 'Service Unavailable' });
    if (m.limit429 > 0) { m.limit429--; return send(429, { name: 'Too Many Requests' }, { 'Retry-After': '0' }); }
    if (u.pathname === '/singlesearch/shows') {
      const s = cat[String(u.searchParams.get('q')).toLowerCase()];
      return s ? send(200, { id: s.id, name: s.name }) : send(404, { name: 'Not Found' });
    }
    let x = /^\/shows\/(\d+)$/.exec(u.pathname);
    if (x && byId[x[1]]) {
      const s = byId[x[1]];
      const emb = u.searchParams.getAll('embed[]');
      const future = s.episodes.filter((e) => Date.parse(e.airstamp) > NOW);
      const past = s.episodes.filter((e) => Date.parse(e.airstamp) <= NOW);
      const body = { id: s.id, name: s.name, status: s.status, network: s.network, webChannel: s.webChannel, _embedded: {} };
      if (emb.indexOf('nextepisode') >= 0 && future.length) body._embedded.nextepisode = future[0];
      if (emb.indexOf('previousepisode') >= 0 && past.length) body._embedded.previousepisode = past[past.length - 1];
      return send(200, body);
    }
    x = /^\/shows\/(\d+)\/episodes$/.exec(u.pathname);
    if (x && byId[x[1]]) return send(200, byId[x[1]].episodes);
    send(404, { name: 'Not Found' });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    m.url = 'http://127.0.0.1:' + server.address().port;
    m.close = () => new Promise((c) => server.close(c));
    r(m);
  }));
}

// A tracker on its own, with data kept in a plain variable.
function tracker(tv, extra) {
  const box = { data: shows.emptyData(), pushes: 0, logs: [] };
  const dir = tmpDir();
  const t = shows.createTracker(Object.assign({
    dataDir: dir, api: tv.url, now: () => new Date(NOW), autoRefresh: false,
    log: (s) => box.logs.push(s),
    current: () => box.data,
    publish: (d, changed) => { box.data = d; if (changed) box.pushes++; }
  }, extra || {}));
  box.t = t;
  box.dir = dir;
  return box;
}

function writeSeed(dir, list) {
  const f = path.join(dir, 'seed.json');
  fs.writeFileSync(f, JSON.stringify({ shows: list }));
  return f;
}

const LIST = [
  { name: "Hell's Kitchen", service: 'Disney+' },
  { name: 'Stick' },
  { name: 'Andor', service: 'Disney+', serviceOverride: 'Hulu' }
];

/* ---------- the server ---------- */

function startHub(extra) {
  const lines = [];
  const opts = Object.assign({ port: 0, token: TOKEN, log: (s) => lines.push(s), dataDir: tmpDir(), now: () => new Date(NOW) }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.lines = lines; h.dataDir = opts.dataDir; return h; });
}

function request(h, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: h.port, path: p, method: method,
      headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const authed = { Authorization: 'Bearer ' + TOKEN };

// ./hub itself, as a separate process (the server runs in this one, so it must not block).
function hubctl(h, args) {
  return new Promise((resolve) => {
    const p = childProcess.spawn(process.execPath, [path.join(__dirname, 'hubctl.js')].concat(args), {
      env: Object.assign({}, process.env, { HUB_TOKEN: TOKEN, HUB_URL: 'http://127.0.0.1:' + h.port })
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (code) => resolve({ status: code, stdout: stdout, stderr: stderr }));
  });
}

// A mailbox command as the mailbox runs it: the envelope check, then the command.
async function mail(h, cmd, args) {
  const name = 'c' + Date.now() + Math.floor(Math.random() * 1000);
  const env = mailbox.checkEnvelope(name, Buffer.from(JSON.stringify({ id: name, created: new Date().toISOString(), cmd: cmd, args: args || {} })), Date.now());
  const call = async (method, route, body) => {
    const r = await h.api(method, route, body);
    if (!r.body || !r.body.ok) throw new Error('The server said no: ' + ((r.body && r.body.error) || r.status));
    return r.body;
  };
  return mailbox.COMMANDS[cmd].run(env.args, { call: call });
}

function noNames(lines, names) {
  lines.forEach((l) => names.forEach((n) => {
    assert.ok(l.toLowerCase().indexOf(n.toLowerCase()) < 0, 'a log line names "' + n + '": ' + l);
  }));
  lines.forEach((l) => assert.ok(!/https?:\/\/|tvmaze\.com|singlesearch|\/shows\/\d/i.test(l), 'a log line holds an address: ' + l));
}

async function main() {
  /* ---------- the list ---------- */

  await check('list entries: name needed, service mapped, id a number, unknown fields refused', () => {
    assert.deepStrictEqual(shows.normalizeEntry({ name: '  Stick ', service: 'Apple TV+' }), { name: 'Stick', service: 'Apple TV' });
    assert.deepStrictEqual(shows.normalizeEntry({ name: 'X', tvmazeId: '42', serviceOverride: 'max' }), { name: 'X', tvmazeId: 42, serviceOverride: 'HBO Max' });
    assert.throws(() => shows.normalizeEntry({ service: 'Netflix' }), /"name" is missing/);
    assert.throws(() => shows.normalizeEntry({ name: 'X', tvmazeId: -1 }), /whole number/);
    assert.throws(() => shows.normalizeEntry({ name: 'X', link: 'y' }), /unknown field "link"/);
    assert.throws(() => shows.normalizeEntry(JSON.parse('{"name":"X","__proto__":{"a":1}}')), /unknown field/);
    assert.throws(() => shows.normalizeList([{ name: 'Stick' }, { name: 'stick' }]), /twice/);
    assert.strictEqual(shows.slug("Hell's Kitchen"), 'hells-kitchen');
    assert.deepStrictEqual(shows.normalizeEntry({ name: 'X', alsoOn: ['hulu', 'Peacock', 'Hulu'] }).alsoOn, ['Hulu', 'Peacock']);
    assert.deepStrictEqual(shows.normalizeEntry({ name: 'X', alsoOn: 'Hulu, Max' }).alsoOn, ['Hulu', 'HBO Max']);
    assert.throws(() => shows.normalizeEntry({ name: 'X', alsoOn: [1] }), /alsoOn/);
    assert.throws(() => shows.normalizeEntry({ name: 'X', alsoOn: ['a', 'b', 'c', 'd', 'e'] }), /at most 4/);
    // via: the app it is billed through (Prime Video Channels); names tidied like service.
    assert.strictEqual(shows.normalizeEntry({ name: 'X', service: 'Max', via: 'Prime Video' }).via, 'Prime Video');
    assert.strictEqual(shows.normalizeEntry({ name: 'X', service: 'Max', via: 'Prime Video' }).service, 'HBO Max');
    assert.throws(() => shows.normalizeEntry({ name: 'X', via: 3 }), /"via" must be text/);
  });

  await check('the seed list is the four shows, used when there is no list yet; a damaged list falls back to it', () => {
    const seed = JSON.parse(fs.readFileSync(shows.SEED_FILE, 'utf8')).shows;
    assert.deepStrictEqual(seed.map((s) => s.name + '/' + s.service),
      ["Hell's Kitchen/Disney+", 'Shark Tank/Disney+', 'The Great British Baking Show/Netflix', 'Stick/Apple TV']);
    const dir = tmpDir();
    const file = path.join(dir, 'shows.json');
    assert.strictEqual(shows.readList(file).seeded, true);
    assert.strictEqual(shows.readList(file).list.length, 4);
    fs.writeFileSync(file, '{ broken');
    const logs = [];
    const r = shows.readList(file, null, (s) => logs.push(s));
    assert.strictEqual(r.seeded, true);
    assert.ok(fs.readdirSync(dir).some((f) => /^shows\.bad-/.test(f)));
    noNames(logs, ['shows.json']);
  });

  /* ---------- reading TVmaze ---------- */

  await check('a show: webChannel for streaming, network for broadcast, the owner\'s service wins, status flag, window', () => {
    const cat = catalog();
    const hk = shows.buildShow({ name: "Hell's Kitchen", service: 'Disney+' }, Object.assign({}, cat["hell's kitchen"], { _embedded: {} }), cat["hell's kitchen"].episodes, NOW);
    assert.strictEqual(hk.channel, 'FOX');
    assert.strictEqual(hk.service, 'Disney+');
    assert.strictEqual(hk.running, true);
    assert.deepStrictEqual(hk.upcoming.map((e) => e.number), [7, 8, 9], 'a week back to 60 days ahead');
    assert.strictEqual(hk.nextEpisode.number, 8);
    assert.strictEqual(hk.nextEpisode.name, 'Surf & Turf');
    assert.strictEqual(hk.nextEpisode.airstamp, '2026-11-19T02:00:00Z');
    assert.strictEqual(hk.returning, null);
    const st = shows.buildShow({ name: 'Stick' }, cat.stick, cat.stick.episodes, NOW);
    assert.strictEqual(st.service, 'Apple TV');
    assert.deepStrictEqual(st.upcoming, []);
    assert.deepStrictEqual(st.returning, { season: 2, label: 'Season 2', date: '2027-01-20', airstamp: '2027-01-21T02:00:00Z' });
    const an = shows.buildShow({ name: 'Andor', service: 'Disney+', serviceOverride: 'Hulu' }, cat.andor, cat.andor.episodes, NOW);
    assert.strictEqual(an.running, false);
    assert.strictEqual(an.status, 'Ended');
    assert.strictEqual(an.returning, null);
    assert.strictEqual(an.watch, 'Hulu');
    assert.deepStrictEqual(an.alsoOn, []);
    assert.deepStrictEqual(shows.buildShow({ name: 'Z', alsoOn: ['Hulu'] }, {}, [], NOW).alsoOn, ['Hulu']);
    assert.strictEqual(shows.buildShow({ name: 'Z', service: 'HBO Max', via: 'Prime Video' }, {}, [], NOW).via, 'Prime Video');
    assert.strictEqual(an.via, null);
    const tbd = shows.buildShow({ name: 'Y' }, { id: 9, status: 'To Be Determined' }, [{ season: 3, number: 9, airstamp: at(-30) }], NOW);
    assert.deepStrictEqual(tbd.returning, { season: 4, label: 'Season 4', date: null, airstamp: null });
    assert.strictEqual(tbd.running, true);
  });

  await check('the call queue: never more than 20 calls in 10 seconds, in order', async () => {
    let clock = 0;
    const lim = shows.createLimiter({ calls: 20, windowMs: 10000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const startedAt = [];
    const all = [];
    for (let i = 0; i < 45; i++) all.push(lim.run(async () => { startedAt.push(clock); return i; }));
    const got = await Promise.all(all);
    assert.deepStrictEqual(got, Array.from({ length: 45 }, (x, i) => i));
    for (let i = 20; i < startedAt.length; i++) assert.ok(startedAt[i] - startedAt[i - 20] >= 10000, 'call ' + i);
    assert.strictEqual(startedAt[19], 0);
    assert.strictEqual(startedAt[20], 10000);
    assert.strictEqual(startedAt[40], 20000);
  });

  const tv = await startTvmaze();

  await check('a refresh: search once, the id kept in the list file, show with both embeds, episodes', async () => {
    const b = tracker(tv, { seedFile: writeSeed(tmpDir(), LIST) });
    tv.seen.length = 0;
    const r = await b.t.refresh();
    assert.deepStrictEqual(r.problems, []);
    assert.ok(tv.seen.indexOf('/singlesearch/shows?q=Hell\'s%20Kitchen') >= 0 || tv.seen.indexOf('/singlesearch/shows?q=Hell%27s%20Kitchen') >= 0, tv.seen.join(' '));
    assert.ok(tv.seen.indexOf('/shows/101?embed[]=nextepisode&embed[]=previousepisode') >= 0, tv.seen.join(' '));
    assert.ok(tv.seen.indexOf('/shows/101/episodes') >= 0);
    assert.strictEqual(tv.seen.length, 9);
    const saved = JSON.parse(fs.readFileSync(path.join(b.dir, 'shows.json'), 'utf8')).shows;
    assert.deepStrictEqual(saved.map((s) => s.tvmazeId), [101, 202, 303]);
    assert.strictEqual(b.data.shows.length, 3);
    assert.strictEqual(b.data.updatedAt, '2026-11-17T18:00:00Z');
    assert.deepStrictEqual(b.data.shows.map((s) => s.running), [true, true, false]);
    tv.seen.length = 0;
    await b.t.refresh();
    assert.strictEqual(tv.seen.filter((u) => /singlesearch/.test(u)).length, 0, 'searched again');
    assert.strictEqual(tv.seen.length, 6);
    assert.strictEqual(b.pushes, 1, 'an unchanged refresh pushes nothing');
    noNames(b.logs, ["Hell's Kitchen", 'Stick', 'Andor']);
    assert.deepStrictEqual(b.logs, ['shows refresh: 3 of 3 shows read', 'shows refresh: 3 of 3 shows read']);
  });

  await check('TVmaze down: every show keeps its last good copy, marked stale; nothing goes blank', async () => {
    const b = tracker(tv, { seedFile: writeSeed(tmpDir(), LIST) });
    await b.t.refresh();
    const good = JSON.parse(JSON.stringify(b.data));
    tv.mode = 'down';
    const r = await b.t.refresh();
    tv.mode = 'ok';
    assert.strictEqual(r.problems.length, 3);
    assert.strictEqual(b.data.shows.length, 3);
    assert.ok(b.data.shows.every((s) => s.stale === true && /TVmaze could not be/.test(s.error)));
    assert.deepStrictEqual(b.data.shows.map((s) => s.nextEpisode && s.nextEpisode.number), good.shows.map((s) => s.nextEpisode && s.nextEpisode.number));
    assert.strictEqual(b.data.updatedAt, good.updatedAt, 'updatedAt stays at the last good read');
    assert.ok(/No show could be read/.test(b.data.error));
    noNames(b.logs, ["Hell's Kitchen", 'Stick', 'Andor']);
    assert.strictEqual(b.logs[b.logs.length - 1], 'shows refresh: 0 of 3 shows read, 3 failed (unreachable, unreachable, unreachable)');
    // A restart: the copy comes back from state (the resource), and an outage still keeps it.
    const b2 = tracker(tv, { seedFile: writeSeed(tmpDir(), LIST) });
    b2.data = shows.cleanResource({ rev: 3, data: good }).data;
    tv.mode = 'error';
    await b2.t.refresh();
    tv.mode = 'ok';
    assert.ok(b2.data.shows.every((s) => s.stale && s.nextEpisode !== undefined));
    assert.strictEqual(b2.data.shows[0].nextEpisode.number, 8);
    assert.ok(/http-503/.test(b2.logs[b2.logs.length - 1]), b2.logs.join(' | '));
  });

  await check('a name TVmaze does not know: says so, the others still read; a 429 waits and tries again', async () => {
    const b = tracker(tv, { seedFile: writeSeed(tmpDir(), [{ name: 'No Such Show' }, { name: 'Stick' }]) });
    tv.limit429 = 2;
    const r = await b.t.refresh();
    assert.deepStrictEqual(r.problems, ['No Such Show: not found on TVmaze (check the name, or add --id)']);
    assert.strictEqual(b.data.shows[0].error, 'not found on TVmaze (check the name, or add --id)'.replace(/^/, 'No Such Show: '));
    assert.strictEqual(b.data.shows[1].nextEpisode.season, 2);
    assert.strictEqual(tv.limit429, 0);
    assert.strictEqual(b.logs[0], 'shows refresh: 1 of 2 shows read, 1 failed (not-found)');
    noNames(b.logs, ['No Such Show', 'Stick']);
  });

  await check('add, remove and set: saved, the TV told at once, bad input refused', async () => {
    const b = tracker(tv, { seedFile: writeSeed(tmpDir(), LIST) });
    await b.t.refresh();
    const r = b.t.add({ name: 'Paradise', service: 'Hulu' });
    assert.strictEqual(r.replaced, false);
    assert.strictEqual(b.data.shows.length, 4);
    assert.strictEqual(b.data.shows[3].error, 'not looked up yet');
    b.t.add({ name: 'stick', service: 'Netflix' });
    assert.strictEqual(b.t.list()[1].service, 'Netflix');
    assert.strictEqual(b.t.list()[1].tvmazeId, 202, 'the id is kept');
    assert.strictEqual(b.data.shows[1].service, 'Netflix');
    assert.strictEqual(b.t.remove('hells-kitchen').name, "Hell's Kitchen");
    assert.deepStrictEqual(b.data.shows.map((s) => s.id), ['stick', 'andor', 'paradise']);
    assert.throws(() => b.t.remove('Nope'), /not on the show list/);
    b.t.set([{ name: 'Andor' }]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'shows.json'), 'utf8')).shows, [{ name: 'Andor' }]);
    assert.throws(() => b.t.set('x'), /must be a list/);
  });

  await check('the made-up sample: marked sample, moved to today, never fetches', async () => {
    tv.seen.length = 0;
    const b = tracker(tv, { sampleFile: path.join(__dirname, 'fixtures', 'shows-sample.json'), now: () => new Date(NOW + 3 * DAY) });
    b.t.start();
    assert.strictEqual(b.data.sample, true);
    const par = b.data.shows.find((s) => s.id === 'paradise');
    assert.strictEqual(par.nextEpisode.airstamp, '2026-11-21T02:00:00Z');
    assert.strictEqual(b.data.shows.find((s) => s.id === 'the-bear').returning.date, '2026-12-13');
    assert.strictEqual(tv.seen.length, 0);
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'shows-sample.json'), 'utf8'));
    assert.deepStrictEqual(shows.cleanData(raw).shows.length, raw.shows.length, 'the fixture passes the resource checks');
    // A mark made on the sample can be taken off again (the preview and the TV tests do both).
    const hk = () => b.data.shows.find((s) => s.id === 'hells-kitchen');
    b.t.markWatched("Hell's Kitchen", { season: 24, number: 8 });
    assert.strictEqual(hk().upcoming.filter((e) => e.watched).length, 1);
    assert.strictEqual(hk().watched.length, 1);
    b.t.unwatch("Hell's Kitchen", { season: 24, number: 8 });
    assert.strictEqual(hk().upcoming.filter((e) => e.watched).length, 0, 'the sample kept the flag');
    assert.deepStrictEqual(hk().watched, []);
  });

  /* ---------- through the server, ./hub and the mailbox ---------- */

  await check('server: GET /api/shows, add / remove / set, refresh, status; logs hold no names', async () => {
    const h = await startHub({ shows: { api: tv.url, seedFile: writeSeed(tmpDir(), LIST) } });
    try {
      await new Promise((r) => setTimeout(r, 300));   // the first refresh, at start
      let r = await request(h, 'GET', '/api/shows', undefined, authed);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.data.shows.length, 3);
      assert.strictEqual(r.json.list.length, 3);
      assert.ok(r.json.rev > 0);
      r = await request(h, 'POST', '/api/shows', { add: { name: 'Paradise', service: 'Hulu' } }, authed);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.list.length, 4);
      r = await request(h, 'POST', '/api/shows', { add: { name: '' } }, authed);
      assert.strictEqual(r.status, 400);
      r = await request(h, 'POST', '/api/shows', { add: { name: 'A' }, remove: 'B' }, authed);
      assert.strictEqual(r.status, 400);
      r = await request(h, 'POST', '/api/shows', { remove: 'Nope' }, authed);
      assert.strictEqual(r.status, 400);
      r = await request(h, 'POST', '/api/shows/refresh', {}, authed);
      assert.strictEqual(r.json.done, true);
      assert.deepStrictEqual(r.json.problems, ['Paradise: not found on TVmaze (check the name, or add --id)']);
      r = await request(h, 'GET', '/api/status', undefined, authed);
      assert.strictEqual(r.json.shows.shows, 4);
      r = await request(h, 'GET', '/api/shows');
      assert.strictEqual(r.status, 401);
      const st = await request(h, 'GET', '/live/state');
      assert.ok(st.json.resources.shows && st.json.resources.linktests, 'both reach the screens');
      noNames(h.lines, ["Hell's Kitchen", 'Stick', 'Andor', 'Paradise']);
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  await check('server without shows settings (tests, older setups): no TVmaze call by itself', async () => {
    tv.seen.length = 0;
    const h = await startHub();
    try {
      await sleep(200);
      const r = await request(h, 'POST', '/api/shows', { add: { name: 'Stick' } }, authed);
      assert.strictEqual(r.status, 200);
      await sleep(200);
      assert.strictEqual(tv.seen.length, 0);
      const s = await request(h, 'GET', '/api/shows', undefined, authed);
      assert.strictEqual(s.json.list.length, 4, 'the seed list, Stick updated in place');
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  await check('./hub shows list | add | remove | refresh print what happened', async () => {
    const h = await startHub({ shows: { api: tv.url, seedFile: writeSeed(tmpDir(), LIST) } });
    try {
      await sleep(300);
      let out = await hubctl(h, ['shows', 'list']);
      assert.strictEqual(out.status, 0, out.stdout + out.stderr);
      assert.ok(/^3 shows on the list, last read from TVmaze /.test(out.stdout), out.stdout);
      assert.ok(/Hell's Kitchen \(Disney\+\): still running; next S24 E8 Wed, Nov 18, 8:00 PM \[TVmaze 101\]/.test(out.stdout), out.stdout);
      assert.ok(/Stick \(Apple TV\): still running; Season 2 returns 2027-01-20/.test(out.stdout), out.stdout);
      assert.ok(/Andor \(Disney\+, watch on Hulu\): ended/.test(out.stdout), out.stdout);
      out = await hubctl(h, ['shows', 'add', 'Paradise', '--service', 'Hulu', '--id', '12', '--also', 'Disney+']);
      assert.ok(/^Added Paradise \(Hulu\)\. Looking it up/.test(out.stdout), out.stdout);
      out = await hubctl(h, ['shows', 'list']);
      assert.ok(/Paradise \(Hulu, also on Disney\+\)/.test(out.stdout), out.stdout);
      out = await hubctl(h, ['shows', 'add', 'X', '--id', 'abc']);
      assert.strictEqual(out.status, 1);
      out = await hubctl(h, ['shows', 'remove', 'Paradise']);
      assert.strictEqual(out.stdout.trim(), 'Removed Paradise from the show list. The TV drops it now.');
      out = await hubctl(h, ['shows', 'refresh']);
      assert.strictEqual(out.stdout.trim(), 'Read 3 shows from TVmaze (no change).');
      out = await hubctl(h, ['shows', 'add', 'The Pitt', '--service', 'HBO Max', '--via', 'Prime Video']);
      out = await hubctl(h, ['shows', 'list']);
      assert.ok(/The Pitt \(HBO Max, via Prime Video\)/.test(out.stdout), out.stdout);
      out = await hubctl(h, ['shows', 'remove', 'The Pitt']);
      out = await hubctl(h, ['shows', 'nonsense']);
      assert.strictEqual(out.status, 1);
      out = await hubctl(h, ['help']);
      assert.ok(/\.\/hub shows add "Stick" --service "Apple TV"/.test(out.stdout));
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  await check('mailbox: shows.list, shows.add, shows.remove, shows.set, shows.refresh, linktests.show', async () => {
    const h = await startHub({ shows: { api: tv.url, seedFile: writeSeed(tmpDir(), LIST) } });
    try {
      await sleep(300);
      let r = await mail(h, 'shows.list');
      assert.deepStrictEqual(r.data.shows.map((s) => s.running), [true, true, false]);
      assert.ok(/3 shows on the list/.test(r.message));
      r = await mail(h, 'shows.add', { name: 'Paradise', service: 'Hulu', tvmazeId: 77, alsoOn: ['Disney+'] });
      assert.strictEqual(r.data.entry.tvmazeId, 77);
      assert.deepStrictEqual(r.data.entry.alsoOn, ['Disney+']);
      r = await mail(h, 'shows.add', { name: 'The Pitt', service: 'HBO Max', via: 'Prime Video' });
      assert.strictEqual(r.data.entry.via, 'Prime Video');
      r = await mail(h, 'shows.remove', { name: 'The Pitt' });
      r = await mail(h, 'shows.remove', { name: 'Paradise' });
      assert.strictEqual(r.data.removed.name, 'Paradise');
      r = await mail(h, 'shows.set', { shows: [{ name: 'Stick', service: 'Apple TV' }, { name: 'Andor' }] });
      assert.strictEqual(r.message, 'The show list now has 2 shows. Looking them up on TVmaze now.');
      r = await mail(h, 'shows.refresh');
      assert.strictEqual(r.data.done, true);
      assert.strictEqual(r.data.shows.length, 2);
      assert.throws(() => mailbox.checkEnvelope('c123456', Buffer.from(JSON.stringify({ id: 'c123456', created: new Date().toISOString(), cmd: 'shows.add', args: { name: 'X', link: 'y' } })), Date.now()), /does not take "link"/);
      r = await mail(h, 'linktests.show');
      assert.ok(/No watch link tests yet/.test(r.message));
    } finally {
      await new Promise((r) => h.close(r));
    }
  });


  /* ---------- watched episodes ---------- */

  await check('watched: stored per show in the list file, in the snapshot (shows[].watched, watched: true, runtime), kept over a refresh', async () => {
    const b = tracker(tv, { seedFile: writeSeed(tmpDir(), LIST) });
    await b.t.refresh();
    let hk = b.data.shows[0];
    assert.strictEqual(hk.upcoming[0].runtime, 44, 'the runtime reaches the TV');
    assert.deepStrictEqual(hk.watched, []);
    // No episode named: the earliest one out and not marked (S24 E7).
    let r = b.t.markWatched("Hell's Kitchen");
    assert.deepStrictEqual([r.season, r.number, r.changed], [24, 7, true]);
    hk = b.data.shows[0];
    assert.deepStrictEqual(hk.watched, [{ season: 24, number: 7, at: '2026-11-17T18:00:00Z' }]);
    assert.strictEqual(hk.upcoming[0].watched, true);
    assert.strictEqual(hk.upcoming[1].watched, undefined, 'a later episode is not marked');
    const saved = JSON.parse(fs.readFileSync(path.join(b.dir, 'shows.json'), 'utf8')).shows;
    assert.deepStrictEqual(saved[0].watched, [{ s: 24, e: 7, at: '2026-11-17T18:00:00Z' }]);
    assert.strictEqual(saved[1].watched, undefined);
    // Again: no change, no push. Nothing left to pick without naming one.
    const pushes = b.pushes;
    assert.strictEqual(b.t.markWatched("hell's kitchen", { season: 24, number: 7 }).changed, false);
    assert.strictEqual(b.pushes, pushes);
    assert.throws(() => b.t.markWatched('Stick'), /no episode out in the last week/);
    assert.throws(() => b.t.markWatched('Hell\'s Kitchen'), /no episode out in the last week/);
    assert.throws(() => b.t.markWatched('Nope', { season: 1, number: 1 }), /not on the show list/);
    assert.throws(() => b.t.markWatched('Stick', { season: -1, number: 1 }), /season and a number/);
    // A future episode may be marked by hand (a mistake can be fixed either way).
    b.t.markWatched('Stick', { season: 2, number: 1 });
    assert.strictEqual(b.data.shows[1].watched.length, 1);
    // A refresh keeps the marks; so does adding the same show again and setting the list again.
    await b.t.refresh();
    assert.strictEqual(b.data.shows[0].upcoming[0].watched, true);
    b.t.add({ name: "hell's kitchen", service: 'Hulu' });
    assert.strictEqual(b.t.list()[0].watched.length, 1);
    b.t.set([{ name: 'Stick' }, { name: "Hell's Kitchen" }]);
    assert.strictEqual(b.t.list()[1].watched.length, 1, 'set keeps the marks of a show that stays');
    // Unwatch takes it off again; unmarked says so.
    r = b.t.unwatch("Hell's Kitchen", { season: 24, number: 7 });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(b.data.shows.find((x) => x.id === 'hells-kitchen').upcoming[0].watched, undefined);
    assert.strictEqual(b.t.unwatch("Hell's Kitchen", { season: 24, number: 7 }).changed, false);
    assert.throws(() => b.t.unwatch("Hell's Kitchen"), /which episode/);
    // The list file may carry marks by hand; bad ones are refused, doubles dropped, the oldest go past 400.
    assert.deepStrictEqual(shows.normalizeEntry({ name: 'X', watched: [{ s: 1, e: 2, at: '2026-01-01T00:00:00Z' }, { s: 1, e: 2, at: '2026-02-01T00:00:00Z' }] }).watched, [{ s: 1, e: 2, at: '2026-01-01T00:00:00Z' }]);
    assert.throws(() => shows.normalizeEntry({ name: 'X', watched: [{ s: 'a', e: 1 }] }), /"watched" must be a list/);
    assert.throws(() => shows.normalizeEntry({ name: 'X', watched: 3 }), /"watched" must be a list/);
    const many = [];
    for (let i = 0; i < 450; i++) many.push({ s: 1, e: i, at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60000).toISOString() });
    const w = shows.normalizeEntry({ name: 'X', watched: many }).watched;
    assert.deepStrictEqual([w.length, w[0].e, w[399].e], [400, 50, 449]);
    assert.deepStrictEqual([shows.parseEpisode('S3E4'), shows.parseEpisode('3x4'), shows.parseEpisode(' s03 e12 '), shows.parseEpisode('S3'), shows.parseEpisode('x')],
      [{ season: 3, number: 4 }, { season: 3, number: 4 }, { season: 3, number: 12 }, null, null]);
    noNames(b.logs, ["Hell's Kitchen", 'Stick', 'Andor', 'Last week']);
  });

  await check('server: the TV marks watched on POST /shows/watched (no token, origin checked); the control API corrects it; logs carry no names', async () => {
    const h = await startHub({ shows: { api: tv.url, seedFile: writeSeed(tmpDir(), LIST) } });
    try {
      await sleep(300);
      h.lines.length = 0;
      let r = await request(h, 'POST', '/shows/watched', { id: 'hells-kitchen', season: 24, number: 7 });
      assert.deepStrictEqual([r.status, r.json.ok, r.json.changed], [200, true, true]);
      r = await request(h, 'POST', '/shows/watched', { id: 'hells-kitchen', season: 24, number: 7 });
      assert.strictEqual(r.json.changed, false);
      for (const bad of [{ id: 'nope', season: 1, number: 1 }, { id: 'stick', season: 'x', number: 1 }, {}, { id: 'stick', season: 1 }]) {
        r = await request(h, 'POST', '/shows/watched', bad);
        assert.strictEqual(r.status, 400, JSON.stringify(bad));
      }
      r = await request(h, 'POST', '/shows/watched', { id: 'stick', season: 2, number: 1 }, { Origin: 'http://evil.example' });
      assert.strictEqual(r.status, 403);
      r = await request(h, 'GET', '/shows/watched');
      assert.strictEqual(r.status, 405);
      // The TV takes a mark off again: POST /shows/unwatch, the same door (no token, origin checked).
      r = await request(h, 'POST', '/shows/unwatch', { id: 'hells-kitchen', season: 24, number: 7 });
      assert.deepStrictEqual([r.status, r.json.ok, r.json.changed], [200, true, true]);
      r = await request(h, 'GET', '/api/shows', undefined, authed);
      assert.strictEqual(r.json.data.shows[0].upcoming[0].watched, undefined, 'the mark is off');
      assert.strictEqual(r.json.data.shows[0].watched.length, 0);
      r = await request(h, 'POST', '/shows/unwatch', { id: 'hells-kitchen', season: 24, number: 7 });
      assert.deepStrictEqual([r.status, r.json.changed], [200, false], 'taking off a mark that is not there changes nothing');
      for (const bad of [{ id: 'nope', season: 1, number: 1 }, { id: 'stick', season: 'x', number: 1 }, {}, { id: 'stick', season: 1 }]) {
        r = await request(h, 'POST', '/shows/unwatch', bad);
        assert.strictEqual(r.status, 400, 'unwatch ' + JSON.stringify(bad));
      }
      r = await request(h, 'POST', '/shows/unwatch', { id: 'stick', season: 2, number: 1 }, { Origin: 'http://evil.example' });
      assert.strictEqual(r.status, 403);
      r = await request(h, 'GET', '/shows/unwatch');
      assert.strictEqual(r.status, 405);
      r = await request(h, 'POST', '/shows/watched', { id: 'hells-kitchen', season: 24, number: 7 });
      assert.strictEqual(r.json.changed, true, 'marked again for the rest of the test');
      r = await request(h, 'GET', '/api/shows', undefined, authed);
      assert.strictEqual(r.json.data.shows[0].upcoming[0].watched, true);
      assert.strictEqual(r.json.data.shows[0].watched.length, 1);
      const live = await request(h, 'GET', '/live/state');
      assert.strictEqual(live.json.resources.shows.data.shows[0].upcoming[0].watched, true, 'the TV gets it');
      // The control API: needs the token; a name or id; marks, corrects.
      r = await request(h, 'POST', '/api/shows/watched', { show: 'Stick', episode: 'S2E1' });
      assert.strictEqual(r.status, 401);
      r = await request(h, 'POST', '/api/shows/watched', { show: "Hell's Kitchen" }, authed);
      assert.strictEqual(r.status, 400, 'nothing left to pick');
      r = await request(h, 'POST', '/api/shows/watched', { show: 'Stick', episode: 'two' }, authed);
      assert.strictEqual(r.status, 400);
      r = await request(h, 'POST', '/api/shows/watched', { show: 'stick', episode: 'S2E1' }, authed);
      assert.deepStrictEqual([r.status, r.json.changed, r.json.season, r.json.number], [200, true, 2, 1]);
      r = await request(h, 'POST', '/api/shows/unwatch', { show: 'Stick' }, authed);
      assert.strictEqual(r.status, 400, 'unwatch needs the episode');
      r = await request(h, 'POST', '/api/shows/unwatch', { show: 'Stick', episode: 'S2E1' }, authed);
      assert.deepStrictEqual([r.status, r.json.changed], [200, true]);
      r = await request(h, 'GET', '/api/shows', undefined, authed);
      assert.strictEqual(r.json.data.shows[1].watched.length, 0);
      const bare = h.lines.map((l) => l.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, ''));
      assert.ok(bare.indexOf('screen marked an episode watched') >= 0, bare.join(' | '));
      assert.ok(bare.indexOf('screen marked an episode watched (already marked)') >= 0);
      assert.ok(bare.indexOf('screen took a watched mark off an episode') >= 0, bare.join(' | '));
      assert.ok(bare.filter((l) => /took a watched mark off/.test(l) && l !== 'screen took a watched mark off an episode' && l.indexOf('control ') !== 0).length === 0, 'an unwatch line with extras: ' + bare.join(' | '));
      assert.ok(bare.indexOf('control POST /api/shows/watched -> 200 marked an episode watched') >= 0, bare.join(' | '));
      assert.ok(bare.indexOf('control POST /api/shows/unwatch -> 200 took a watched mark off an episode') >= 0);
      noNames(h.lines, ["Hell's Kitchen", 'hells-kitchen', 'Stick', 'Andor', 'S24', 'S2E1']);
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  await check('./hub shows watched | unwatch and the mailbox shows.watched | shows.unwatch', async () => {
    const h = await startHub({ shows: { api: tv.url, seedFile: writeSeed(tmpDir(), LIST) } });
    try {
      await sleep(300);
      let out = await hubctl(h, ['shows', 'watched', "Hell's", 'Kitchen']);
      assert.strictEqual(out.stdout.trim(), "Marked S24E7 of Hell's Kitchen as watched. The TV counts and dims it now.", out.stdout + out.stderr);
      out = await hubctl(h, ['shows', 'watched', "Hell's Kitchen", 'S24E7']);
      assert.strictEqual(out.stdout.trim(), "S24E7 of Hell's Kitchen was already marked watched.");
      out = await hubctl(h, ['shows', 'list']);
      assert.ok(/Hell's Kitchen \(Disney\+\): .*\[TVmaze 101\] \[watched S24E7\]/.test(out.stdout), out.stdout);
      out = await hubctl(h, ['shows', 'unwatch', "Hell's Kitchen", 'S24E7']);
      assert.strictEqual(out.stdout.trim(), "Took the watched mark off S24E7 of Hell's Kitchen. The TV counts it again.");
      out = await hubctl(h, ['shows', 'unwatch', "Hell's Kitchen", 'S24E7']);
      assert.strictEqual(out.stdout.trim(), "S24E7 of Hell's Kitchen was not marked watched.");
      out = await hubctl(h, ['shows', 'unwatch', "Hell's Kitchen"]);
      assert.strictEqual(out.status, 1);
      assert.ok(/Say which episode/.test(out.stderr + out.stdout), out.stderr + out.stdout);
      out = await hubctl(h, ['shows', 'watched', 'Nope']);
      assert.strictEqual(out.status, 1);
      out = await hubctl(h, ['shows', 'watched']);
      assert.strictEqual(out.status, 1);
      out = await hubctl(h, ['help']);
      assert.ok(/\.\/hub shows watched "Stick" S3E4/.test(out.stdout) && /shows unwatch/.test(out.stdout));
      // The mailbox.
      let r = await mail(h, 'shows.watched', { name: "Hell's Kitchen" });
      assert.deepStrictEqual([r.data.season, r.data.number, r.data.changed], [24, 7, true]);
      r = await mail(h, 'shows.list');
      assert.deepStrictEqual(r.data.shows[0].watched.map((w) => w.season + 'x' + w.number), ['24x7']);
      r = await mail(h, 'shows.watched', { name: 'Stick', episode: 'S2E1' });
      assert.strictEqual(r.data.changed, true);
      r = await mail(h, 'shows.unwatch', { name: 'Stick', episode: 'S2E1' });
      assert.strictEqual(r.message, 'Took the watched mark off S2E1 of Stick. The TV counts it again.');
      assert.throws(() => mailbox.checkEnvelope('c123456', Buffer.from(JSON.stringify({ id: 'c123456', created: new Date().toISOString(), cmd: 'shows.unwatch', args: { name: 'X' } })), Date.now()), /episode/);
      await assert.rejects(() => mail(h, 'shows.watched', { name: 'Nope' }), /not on the show list/);
      noNames(h.lines, ["Hell's Kitchen", 'Stick', 'Andor']);
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  /* ---------- watch link test answers ---------- */

  await check('POST /linktests from the screen: checked, kept newest first, read back by ./hub linktests', async () => {
    const h = await startHub();
    try {
      const good = { id: 'netflix-view', app: 'Netflix', name: 'View the title page', outcome: 'title', op: 'http://tizen.org/appcontrol/operation/view', at: '2026-11-17T17:00:00Z', build: 'v0.28.16' };
      let r = await request(h, 'POST', '/linktests', { result: good }, { Origin: 'http://127.0.0.1:8081' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      r = await request(h, 'POST', '/linktests', { result: Object.assign({}, good, { id: 'prime-gti', outcome: 'app', at: '2026-11-17T17:05:00Z' }) });
      assert.strictEqual(r.status, 200);
      r = await request(h, 'POST', '/linktests', { result: Object.assign({}, good, { outcome: 'maybe' }) });
      assert.strictEqual(r.status, 400);
      r = await request(h, 'POST', '/linktests', { result: good }, { Origin: 'http://evil.example' });
      assert.strictEqual(r.status, 403);
      r = await request(h, 'GET', '/linktests');
      assert.strictEqual(r.status, 405);
      r = await request(h, 'GET', '/api/linktests', undefined, authed);
      assert.deepStrictEqual(r.json.data.results.map((x) => x.id + ':' + x.outcome), ['prime-gti:app', 'netflix-view:title']);
      const out = await hubctl(h, ['linktests']);
      assert.ok(/2 answers from the TV/.test(out.stdout), out.stdout);
      assert.ok(/Netflix: View the title page \[netflix-view\] opened the title/.test(out.stdout), out.stdout);
      assert.ok(/\[prime-gti\] only opened the app/.test(out.stdout), out.stdout);
      assert.ok(h.lines.some((l) => /screen sent a watch link test answer \(title\)$/.test(l)));
      noNames(h.lines, ['Netflix', 'netflix-view', 'prime-gti', 'View the title page']);
      let data = linktests.emptyData();
      for (let i = 0; i < 130; i++) data = linktests.addResult(data, linktests.normalizeResult({ id: 'x' + i, outcome: 'nothing' }, NOW));
      assert.strictEqual(data.results.length, linktests.MAX_RESULTS);
      assert.strictEqual(data.results[0].id, 'x129');
    } finally {
      await new Promise((r) => h.close(r));
    }
  });

  await tv.close();
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('FAIL (crashed) ' + (e && e.stack));
  process.exit(1);
});
