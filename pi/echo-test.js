/*
 * Tests for the Echo controls (pi/echo.js), and how they reach the server,
 * ./hub and the mailbox. Run from the repo root with:
 *
 *   node pi/echo-test.js
 *
 * It uses the pretend Home Assistant (dev/mock-ha.js), which records every
 * service call, and the real hub server with a throwaway data folder.
 * Nothing reaches the internet, Home Assistant or Amazon. Prints one line
 * per check, then "N passed, M failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const hubServer = require('./server');
const echo = require('./echo');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const mockHa = require('../dev/mock-ha');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-echo-'));
  tmpDirs.push(d);
  return d;
}

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

function request(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const SHOW = 'media_player.ian_s_echo_show';
const DOT = 'media_player.ian_s_echo_dot';
const ALL = 'media_player.everywhere';

async function main() {
  const ha = await mockHa.start({});
  const HA_ENV = { HA_URL: ha.url, HA_TOKEN: ha.token };
  const logs = [];
  const QUERY = 'SecretJazzQuery';

  let clock = Date.UTC(2026, 10, 20, 12, 0, 0);
  function controller(extra, env) {
    const dir = (extra && extra.dataDir) || tmpDir();
    let changes = 0;
    const c = echo.createController(Object.assign({
      config: echo.configFromEnv(env || HA_ENV), dataDir: dir, log: (s) => logs.push(s),
      now: () => clock, changed: () => { changes += 1; }, timeoutMs: 400
    }, extra || {}));
    return { c: c, dir: dir, changes: () => changes };
  }
  const last = () => ha.services[ha.services.length - 1];
  const reset = () => { ha.services.length = 0; ha.serviceStatus = 0; ha.set('radio'); clock += 60000; };

  /* ---------- settings ---------- */

  await check('settings: token and address like All sounds; default targets; ECHO_TARGETS checked; the group', () => {
    assert.deepStrictEqual(echo.configFromEnv({}), { configured: false, problem: '' });
    assert.strictEqual(echo.configFromEnv({ HA_TOKEN: 'paste here' }).configured, false);
    assert.strictEqual(echo.configFromEnv({ HA_TOKEN: ha.token, HA_URL: 'ftp://x' }).configured, false);
    const d = echo.configFromEnv({ HA_TOKEN: ha.token });
    assert.strictEqual(d.url, 'http://127.0.0.1:8123');
    assert.deepStrictEqual(d.targets.map((t) => [t.key, t.entity, t.group]),
      [['show', SHOW, false], ['dot', DOT, false], ['everywhere', ALL, true]]);
    assert.deepStrictEqual(d.targets[2].members, [SHOW, DOT]);
    const own = echo.configFromEnv({ HA_TOKEN: ha.token, ECHO_TARGETS: ' kitchen=media_player.kitchen_echo , all=media_player.everywhere ' });
    assert.deepStrictEqual(own.targets.map((t) => [t.key, t.group]), [['kitchen', false], ['all', true]]);
    ['show', 'show=light.x', 'Bad Key=media_player.a', 'a=media_player.a,a=media_player.b', 'x'.repeat(21) + '=media_player.a',
      'a=media_player.a,b=media_player.b,c=media_player.c,d=media_player.d,e=media_player.e,f=media_player.f,g=media_player.g,h=media_player.h,i=media_player.i'
    ].forEach((v) => assert.strictEqual(echo.configFromEnv({ HA_TOKEN: ha.token, ECHO_TARGETS: v }).configured, false, v));
  });

  /* ---------- apps ---------- */

  await check('each app sends the right service and body; the label is kept', async () => {
    reset();
    const x = controller();
    const cases = [
      ['audible', undefined, { media_content_type: 'custom', media_content_id: 'resume my book on Audible' }],
      ['pandora', undefined, { media_content_type: 'custom', media_content_id: 'play Pandora' }],
      ['pandora', 'Jazz Classics', { media_content_type: 'PANDORA', media_content_id: 'Jazz Classics' }],
      ['amazon-music', undefined, { media_content_type: 'custom', media_content_id: 'play Amazon Music' }],
      ['amazon-music', ' Chill\u0007  mix ', { media_content_type: 'AMAZON_MUSIC', media_content_id: 'Chill mix' }],
      ['tunein', 'KERA', { media_content_type: 'TUNEIN', media_content_id: 'KERA' }],
      ['kera', undefined, { media_content_type: 'TUNEIN', media_content_id: 'KERA 90.1' }],
      ['news', undefined, { media_content_type: 'sequence', media_content_id: 'Alexa.FlashBriefing.Play' }]
    ];
    for (const [app, query, want] of cases) {
      const r = await x.c.start(app, undefined, query);
      assert.strictEqual(r.ok, true, app + ' ' + r.message);
      const call = last();
      assert.deepStrictEqual([call.domain, call.service], ['media_player', 'play_media']);
      assert.deepStrictEqual(call.body, Object.assign({ entity_id: SHOW }, want), app);
      clock += 2000;
    }
    assert.strictEqual(ha.lastAuth, 'Bearer ' + ha.token);
    const lab = x.c.labels()[SHOW];
    assert.deepStrictEqual([lab.app, lab.label, lab.hidden, lab.playing, lab.via, lab.base], ['news', 'Alexa news', true, true, '', null]);
    assert.strictEqual(x.changes(), cases.length, 'changed() after each success');
    await x.c.start('kera', 'dot');
    assert.strictEqual(x.c.labels()[SHOW].app, 'news', 'a bad target changes nothing');
    const k = await x.c.start('kera', 'dot');
    assert.strictEqual(k.ok, true);
    assert.deepStrictEqual([x.c.labels()[DOT].label, x.c.labels()[DOT].title, x.c.labels()[DOT].hidden], ['TuneIn', 'KERA 90.1', false]);
  });

  await check('query rules: none on audible, news and kera; tunein needs one; at most 100 characters', async () => {
    reset();
    const x = controller();
    for (const app of ['audible', 'news', 'kera']) {
      const r = await x.c.start(app, undefined, 'jazz');
      assert.strictEqual(r.ok, false);
      assert.ok(/does not take a query/.test(r.message), r.message);
    }
    assert.ok(/needs a query/.test((await x.c.start('tunein')).message));
    assert.ok(/needs a query/.test((await x.c.start('tunein', undefined, ' \n ')).message));
    assert.ok(/longer than 100/.test((await x.c.start('pandora', undefined, 'x'.repeat(101))).message));
    assert.strictEqual((await x.c.start('pandora', undefined, 'x'.repeat(100))).ok, true);
    assert.ok(/App must be one of/.test((await x.c.start('spotify')).message));
    assert.strictEqual(ha.services.length, 1, 'refused ones never reach Home Assistant');
  });

  /* ---------- transport and volume ---------- */

  await check('pause, resume, next and stop use media_player services; stop pauses and clears the label', async () => {
    reset();
    const x = controller();
    await x.c.start('kera');
    const seen = [];
    for (const a of ['pause', 'resume', 'next', 'stop']) {
      const r = await x.c[a]('dot');
      assert.strictEqual(r.ok, true, a);
      seen.push([last().service, last().body.entity_id]);
    }
    assert.deepStrictEqual(seen, [['media_pause', DOT], ['media_play', DOT], ['media_next_track', DOT], ['media_pause', DOT]]);
    assert.strictEqual(x.c.labels()[SHOW].app, 'kera', 'other speakers keep their labels');
    await x.c.pause();
    assert.strictEqual(x.c.labels()[SHOW].playing, false);
    await x.c.resume();
    assert.strictEqual(x.c.labels()[SHOW].playing, true);
    await x.c.stop();
    assert.deepStrictEqual(x.c.labels(), {});
    assert.strictEqual(ha.services.filter((s) => s.service === 'play_media').length, 1);
  });

  await check('a hidden label (Audible, news) turns pause, resume, next and stop into spoken commands', async () => {
    reset();
    const x = controller();
    await x.c.start('audible', 'show');
    for (const a of ['pause', 'resume', 'next', 'stop']) {
      const r = await x.c[a]('show');
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual([last().service, last().body], ['play_media', { entity_id: SHOW, media_content_type: 'custom', media_content_id: a }], a);
      if (a === 'pause') assert.strictEqual(x.c.labels()[SHOW].playing, false);
      if (a === 'resume') assert.strictEqual(x.c.labels()[SHOW].playing, true);
    }
    assert.deepStrictEqual(x.c.labels(), {}, 'stop clears it');
    await x.c.pause('show');
    assert.strictEqual(last().service, 'media_pause', 'no label: the plain service again');
    await x.c.start('news', 'dot');
    await x.c.pause('show');
    assert.strictEqual(last().service, 'media_pause', 'the dot\'s label does not matter for the show');
    await x.c.pause('dot');
    assert.strictEqual(last().body.media_content_id, 'pause');
  });

  await check('volume: a level is 0 to 1 with two decimals; up and down; bad levels are refused', async () => {
    reset();
    const x = controller();
    await x.c.start('audible');
    for (const [lvl, want] of [[40, 0.4], [0, 0], [100, 1], [7, 0.07], [33, 0.33]]) {
      assert.strictEqual((await x.c.volume(lvl, 'dot')).ok, true);
      assert.deepStrictEqual([last().service, last().body], ['volume_set', { entity_id: DOT, volume_level: want }]);
    }
    await x.c.volume('up');
    assert.deepStrictEqual([last().service, last().body], ['volume_up', { entity_id: SHOW }], 'volume ignores a hidden label');
    await x.c.volume('down', 'dot');
    assert.strictEqual(last().service, 'volume_down');
    const n = ha.services.length;
    for (const bad of [101, -1, 5.5, '40', null, undefined, 'loud']) assert.strictEqual((await x.c.volume(bad)).ok, false, String(bad));
    assert.strictEqual(ha.services.length, n);
  });

  await check('the Everywhere group: one call to the group, labels on every member with via', async () => {
    reset();
    const x = controller();
    await x.c.start('pandora', 'everywhere', 'jazz');
    assert.strictEqual(ha.services.length, 1);
    assert.strictEqual(last().body.entity_id, ALL);
    const l = x.c.labels();
    assert.deepStrictEqual(Object.keys(l).sort(), [DOT, SHOW]);
    assert.strictEqual(l[SHOW].via, 'Everywhere');
    assert.strictEqual(l[DOT].label, 'Pandora');
    await x.c.pause('everywhere');
    assert.deepStrictEqual([last().service, last().body.entity_id], ['media_pause', ALL]);
    assert.ok(l && x.c.labels()[SHOW].playing === false && x.c.labels()[DOT].playing === false);
    await x.c.start('audible', 'everywhere');
    await x.c.next('everywhere');
    assert.deepStrictEqual([last().service, last().body], ['play_media', { entity_id: ALL, media_content_type: 'custom', media_content_id: 'next' }]);
    await x.c.stop('everywhere');
    assert.deepStrictEqual(x.c.labels(), {});
    await x.c.start('audible', 'show');
    await x.c.start('kera', 'everywhere');
    assert.strictEqual(x.c.labels()[SHOW].app, 'kera', 'a start on the group replaces its members\' labels');
    await x.c.start('audible', 'show');
    assert.strictEqual(x.c.labels()[DOT].app, 'kera', 'starting on one speaker leaves the other');
    assert.strictEqual(x.c.labels()[SHOW].via, '');
  });

  /* ---------- failures ---------- */

  await check('Home Assistant answers: 401 and 403 are auth, others HTTP N, no answer is unreachable; no label on failure', async () => {
    reset();
    const x = controller();
    ha.serviceStatus = 401;
    let r = await x.c.start('audible');
    assert.deepStrictEqual([r.ok, r.problem, r.message], [false, 'auth', 'Home Assistant refused the token.']);
    ha.serviceStatus = 403;
    assert.strictEqual((await x.c.pause()).problem, 'auth');
    ha.serviceStatus = 500;
    r = await x.c.volume(30);
    assert.deepStrictEqual([r.ok, r.message], [false, 'Home Assistant answered HTTP 500.']);
    assert.deepStrictEqual(x.c.labels(), {});
    assert.strictEqual(x.changes(), 0, 'changed() only after a success');
    assert.strictEqual(x.c.status().problem, 'status');
    ha.serviceStatus = 0;
    ha.set('down');
    ha.set('radio');
    assert.strictEqual((await x.c.volume(30)).ok, true);
    assert.strictEqual(x.c.status().problem, '', 'a good answer clears the problem');
    const dead = controller({}, { HA_TOKEN: ha.token, HA_URL: 'http://127.0.0.1:1' });
    r = await dead.c.start('audible');
    assert.deepStrictEqual([r.ok, r.message], [false, 'Home Assistant could not be reached.']);
    ha.set('slow');
    ha.serviceStatus = 0;
    ha.set('radio');
  });

  await check('not set up: every action says so; status says so', async () => {
    const x = controller({}, {});
    const r = await x.c.start('audible');
    assert.deepStrictEqual([r.ok, r.message], [false, 'Echo controls are off (no HA_TOKEN in .env).']);
    assert.strictEqual((await x.c.volume(10)).ok, false);
    assert.strictEqual(x.c.status().configured, false);
    assert.deepStrictEqual(x.c.labels(), {});
    const bad = controller({}, { HA_TOKEN: ha.token, ECHO_TARGETS: 'nonsense' });
    assert.ok(/ECHO_TARGETS must look like/.test((await bad.c.pause()).message));
  });

  await check('rate limit: ten actions in ten seconds, then "too many"; a window later it works again', async () => {
    reset();
    const x = controller();
    for (let i = 0; i < 10; i++) assert.strictEqual((await x.c.volume('up')).ok, true, 'action ' + i);
    const r = await x.c.volume('up');
    assert.deepStrictEqual([r.ok, r.message], [false, 'Too many Echo commands; wait a few seconds.']);
    assert.strictEqual(ha.services.length, 10);
    clock += 10001;
    assert.strictEqual((await x.c.volume('up')).ok, true);
  });

  /* ---------- labels ---------- */

  await check('labels are saved (mode 600), come back after a restart, expire after six hours, and can be cleared', async () => {
    reset();
    const x = controller();
    await x.c.start('audible', 'show');
    await x.c.start('pandora', 'dot', 'jazz');
    const file = path.join(x.dir, 'echo.json');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(file, 'utf8').indexOf('jazz') < 0, 'the query is never saved');
    assert.strictEqual(x.c.setBase(SHOW, '["a","b",""]'), true);
    const y = controller({ dataDir: x.dir });
    assert.deepStrictEqual(y.c.labels(), x.c.labels());
    assert.strictEqual(y.c.labels()[SHOW].base, '["a","b",""]');
    clock += echo.LABEL_MAX_MS - 1000;
    assert.strictEqual(Object.keys(controller({ dataDir: x.dir }).c.labels()).length, 2, 'not yet six hours');
    clock += 2000;
    assert.deepStrictEqual(y.c.labels(), {}, 'six hours: gone');
    assert.deepStrictEqual(controller({ dataDir: x.dir }).c.labels(), {}, 'and not back after a restart');
    await y.c.start('news', 'show');
    assert.strictEqual(y.c.clearLabel(SHOW, 'other'), true);
    assert.strictEqual(y.c.clearLabel(SHOW, 'other'), false);
    assert.deepStrictEqual(controller({ dataDir: x.dir }).c.labels(), {});
    // A damaged or hand-edited file is cleaned field by field.
    fs.writeFileSync(path.join(x.dir, 'echo.json'), JSON.stringify({ v: 1, labels: {
      [SHOW]: { app: 'audible', label: 'x'.repeat(99), title: 5, hidden: false, at: clock - 5, playing: 'maybe', via: 7, base: 12 },
      [DOT]: { app: 'rm -rf', at: clock }, 'light.x': { app: 'audible', at: clock }, [ALL]: { app: 'news', at: 'now' }
    } }));
    const z = controller({ dataDir: x.dir }).c.labels();
    assert.deepStrictEqual(Object.keys(z), [SHOW]);
    assert.deepStrictEqual([z[SHOW].label.length, z[SHOW].title, z[SHOW].hidden, z[SHOW].playing, z[SHOW].via, z[SHOW].base], [30, '', true, true, '', null]);
    fs.writeFileSync(path.join(x.dir, 'echo.json'), '{ not json');
    assert.deepStrictEqual(controller({ dataDir: x.dir }).c.labels(), {});
  });

  await check('status: targets and labels, no titles', async () => {
    reset();
    const x = controller();
    await x.c.start('kera', 'dot');
    await x.c.start('audible', 'everywhere');
    const s = x.c.status();
    assert.deepStrictEqual(s.targets, [{ key: 'show', entity: SHOW, group: false }, { key: 'dot', entity: DOT, group: false }, { key: 'everywhere', entity: ALL, group: true }]);
    assert.deepStrictEqual(s.labels.map((l) => [l.target, l.app, l.label, l.playing]).sort(), [['dot', 'audible', 'Audible', true], ['show', 'audible', 'Audible', true]]);
    assert.ok(!isNaN(Date.parse(s.labels[0].since)));
    assert.deepStrictEqual(Object.keys(s).sort(), ['configured', 'labels', 'problem', 'targets']);
  });

  /* ---------- server, ./hub, mailbox ---------- */

  const allLogs = [];
  async function start(extra) {
    const o = Object.assign({
      token: TOKEN, port: 0, host: '127.0.0.1', dataDir: tmpDir(), log: (s) => allLogs.push(s),
      allsoundsEnv: HA_ENV, allsounds: { allowHttp: true, manual: true, timeoutMs: 400 },
      echoEnv: HA_ENV, echo: { timeoutMs: 400 }
    }, extra || {});
    const h = hubServer.start(o);
    await h.ready;
    return h;
  }
  const stop = (h) => new Promise((r) => h.close(r));
  const post = (h, body) => request(h.port, 'POST', '/api/echo', TOKEN, body);

  await check('server: GET and POST /api/echo need the token; 400 for bad input; 200 with ok false for Home Assistant trouble', async () => {
    reset();
    const h = await start();
    assert.strictEqual((await request(h.port, 'GET', '/api/echo')).status, 401);
    assert.strictEqual((await request(h.port, 'POST', '/api/echo', undefined, { action: 'pause' })).status, 401);
    let r = await request(h.port, 'GET', '/api/echo', TOKEN);
    assert.deepStrictEqual([r.status, r.json.ok, r.json.echo.configured, r.json.echo.targets.length], [200, true, true, 3]);
    assert.strictEqual((await request(h.port, 'PUT', '/api/echo', TOKEN, {})).status, 405);
    r = await post(h, { action: 'start', app: 'kera', target: 'dot' });
    assert.deepStrictEqual([r.status, r.json.ok, r.json.message], [200, true, 'Started TuneIn on dot.']);
    assert.strictEqual(r.json.echo.labels[0].app, 'kera');
    assert.deepStrictEqual(last().body, { entity_id: DOT, media_content_type: 'TUNEIN', media_content_id: 'KERA 90.1' });
    const bads = [
      [{}, /"action" must be one of/], [{ action: 'explode' }, /"action" must be one of: start, pause/], [{ action: 'start' }, /"app" must be one of: audible, pandora, amazon-music, tunein, kera, news/],
      [{ action: 'start', app: 'spotify' }, /"app" must be one of/], [{ action: 'start', app: 'audible', query: 'x' }, /does not take a query/],
      [{ action: 'start', app: 'tunein' }, /needs a query/], [{ action: 'start', app: 'pandora', target: 'garage' }, /"target" must be one of: show, dot, everywhere/],
      [{ action: 'pause', color: 'red' }, /unknown field "color"/], [{ action: 'pause', app: 'audible' }, /go with "start"/],
      [{ action: 'volume' }, /level must be/], [{ action: 'volume', level: 101 }, /level must be/], [{ action: 'pause', level: 5 }, /goes with "volume"/],
      [{ action: 'start', app: 'pandora', query: 'x'.repeat(101) }, /longer than 100/], [{ action: 'pause', target: 5 }, /"target" must be one of/]
    ];
    const n = ha.services.length;
    for (const [body, re] of bads) {
      r = await post(h, body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.ok(re.test(r.json.error), JSON.stringify(body) + ' -> ' + r.json.error);
    }
    assert.strictEqual(ha.services.length, n, 'nothing refused reached Home Assistant');
    ha.serviceStatus = 401;
    r = await post(h, { action: 'pause' });
    assert.deepStrictEqual([r.status, r.json.ok, r.json.message], [200, false, 'Home Assistant refused the token.']);
    ha.serviceStatus = 0;
    r = await post(h, { action: 'volume', level: 20 });
    assert.deepStrictEqual([r.status, r.json.ok], [200, true]);
    // The TV's own API has no door for it.
    assert.strictEqual((await request(h.port, 'POST', '/echo', undefined, { action: 'pause' })).status === 200, false);
    assert.strictEqual((await request(h.port, 'GET', '/live/state')).json.resources.echo, undefined, 'not in the TV resources');
    await stop(h);
  });

  await check('server: an action asks All sounds to look again at once; the label shows up as "started"', async () => {
    reset();
    ha.set('stale');
    const h = await start();
    const before = ha.calls.states + ha.calls.one;
    const r = await post(h, { action: 'start', app: 'audible', target: 'show' });
    assert.strictEqual(r.json.ok, true);
    await new Promise((res) => setTimeout(res, 150));
    assert.ok(ha.calls.states + ha.calls.one > before, 'All sounds polled');
    const d = (await request(h.port, 'GET', '/live/state')).json.resources.allsounds.data;
    assert.deepStrictEqual([d.state, d.source, d.title, d.started, d.device], ['playing', 'Audible', '', true, 'Ian\'s Echo Show']);
    await stop(h);
  });

  await check('./hub words and the mailbox echo.* commands say what the server says', async () => {
    reset();
    const h = await start();
    const call = async (method, route, body) => {
      const r = await h.api(method, route, body);
      if (r.status === 200 && route === '/api/echo' && r.body.ok === false && r.body.message) return r.body;
      if (!r.body.ok) throw new Error(r.body.error);
      return r.body;
    };
    const C = mailbox.COMMANDS;
    let out = await C['echo.start'].run({ app: 'audible', target: 'dot' }, { call: call });
    assert.strictEqual(out.message, 'Started Audible on dot.');
    out = await C['echo.pause'].run({ target: 'dot' }, { call: call });
    assert.strictEqual(out.message, 'Paused dot (by voice).');
    out = await C['echo.volume'].run({ level: 'up' }, { call: call });
    assert.strictEqual(out.message, 'Turned show up.');
    out = await C['echo.stop'].run({}, { call: call });
    assert.strictEqual(out.message, 'Stopped show.');
    out = await C['echo.status'].run({}, { call: call });
    assert.deepStrictEqual(out.message.split('\n'), ['Echo controls: on. Targets: show (default), dot, everywhere (group).', 'Started by the hub: Audible on dot (paused).']);
    ha.serviceStatus = 500;
    out = await C['echo.next'].run({}, { call: call });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.message, 'Home Assistant answered HTTP 500.');
    ha.serviceStatus = 0;
    assert.strictEqual(hubctl.echoText({ ok: true }), 'Done.');
    assert.ok(/needs 0\.22\.0/.test(hubctl.echoStatusLines(undefined)[0]));
    assert.ok(/off \(no HA_TOKEN in \.env\)/.test(hubctl.echoStatusLines({ configured: false, problem: '' })[0]));
    await stop(h);
  });

  await check('mailbox rejections: unknown app, query on audible, level 101, unknown args', () => {
    const C = mailbox.COMMANDS;
    ['echo.status', 'echo.start', 'echo.pause', 'echo.resume', 'echo.next', 'echo.stop', 'echo.volume'].forEach((n) => assert.ok(C[n], n));
    const validate = (e) => mailbox.checkEnvelope(e.id, Buffer.from(JSON.stringify(e)), Date.now());
    const env = (cmd, args) => ({ id: 'abcdef12', created: new Date().toISOString(), cmd: cmd, args: args });
    const fails = [
      [env('echo.start', { app: 'spotify' }), /"app" must be one of: audible/], [env('echo.start', { app: 'audible', query: 'x' }), /does not take a query/],
      [env('echo.start', {}), /needs "app"/], [env('echo.start', { app: 'tunein' }), /needs a query/],
      [env('echo.volume', { level: 101 }), /"level" must be a whole number from 0 to 100/], [env('echo.volume', {}), /needs "level"/],
      [env('echo.volume', { level: 'loud' }), /"level" must be/], [env('echo.volume', { level: 50.5 }), /"level" must be/],
      [env('echo.pause', { app: 'audible' }), /does not take "app"/], [env('echo.status', { target: 'show' }), /does not take "target"/],
      [env('echo.pause', { target: 'x'.repeat(21) }), /longer than 20/]
    ];
    fails.forEach(([e, re]) => assert.throws(() => validate(e), re, JSON.stringify(e.args)));
    assert.doesNotThrow(() => validate(env('echo.volume', { level: 0 })));
    assert.doesNotThrow(() => validate(env('echo.volume', { level: 'down', target: 'dot' })));
    assert.doesNotThrow(() => validate(env('echo.start', { app: 'pandora', query: 'jazz', target: 'show' })));
  });

  await check('the log never has a query, a speaker\'s name, the token or an address; only fixed lines', async () => {
    reset();
    ha.set('amazonmusic');
    const x = controller();
    await x.c.start('pandora', 'show', QUERY);
    await x.c.start('tunein', 'dot', QUERY);
    await x.c.start('audible', 'everywhere');
    await x.c.pause('everywhere');
    await x.c.volume(30);
    await x.c.stop('everywhere');
    ha.serviceStatus = 401;
    await x.c.pause();
    ha.serviceStatus = 502;
    await x.c.pause();
    ha.serviceStatus = 0;
    x.c.clearLabel(SHOW, 'other');
    await x.c.start('news', 'dot');
    clock += echo.LABEL_MAX_MS + 10;
    x.c.labels();
    controller({}, {}).c.startLog();
    x.c.startLog();
    const mine = logs.filter((l) => /^echo:/.test(l));
    const text = logs.join('\n');
    [QUERY, ha.token, ha.url, '127.0.0.1', 'Ian', 'Echo Show', 'Golden Hour', 'media_player', 'Bearer'].forEach((bad) => assert.ok(text.indexOf(bad) < 0, 'the log has "' + bad + '"'));
    const FIXED = [
      /^echo: started (Audible|Pandora|TuneIn|Amazon Music|Alexa news) on [a-z0-9-]+$/, /^echo: (pause|resume|next|stop) on [a-z0-9-]+( \(voice\))?$/,
      /^echo: volume on [a-z0-9-]+$/, /^echo: Home Assistant refused the token \((401|403)\)$/, /^echo: Home Assistant answered HTTP \d+$/,
      /^echo: Home Assistant could not be reached$/, /^echo: label cleared on [a-z0-9-]+ \((other playback|timeout|stop)\)$/,
      /^echo: off \(no HA_TOKEN in \.env\)$/, /^echo: ready \(\d targets\)$/
    ];
    assert.ok(mine.length > 12, 'lines were logged: ' + mine.length);
    mine.forEach((l) => assert.ok(FIXED.some((re) => re.test(l)), 'not a fixed line: ' + l));
    assert.ok(mine.indexOf('echo: pause on everywhere (voice)') >= 0 && mine.indexOf('echo: label cleared on show (other playback)') >= 0 && mine.indexOf('echo: label cleared on dot (timeout)') >= 0);
    const server = allLogs.join('\n');
    [ha.token, QUERY].forEach((bad) => assert.ok(server.indexOf(bad) < 0));
  });

  await ha.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
