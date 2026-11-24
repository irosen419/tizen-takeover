/*
 * Tests for opening things on the TV from the Pi (pi/tvlaunch.js, POST /tv/launch).
 * A pretend Home Assistant and a pretend remote link; nothing reaches a real TV.
 *
 *   node pi/tvlaunch-test.js
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const tvlaunch = require('./tvlaunch');
const hubServer = require('./server');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

// A pretend Home Assistant: one TV whose state the test sets.
function fakeHa(opts) {
  const ha = { state: 'off', attrs: { source_list: ['Netflix', 'Prime Video', 'HDMI 1'] }, calls: [], gets: 0, status: 0, onAfterGets: 0, hooks: [] };
  Object.assign(ha, opts || {});
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
      if (ha.status) { res.writeHead(ha.status); return res.end('{}'); }
      if (req.method === 'GET' && req.url === '/api/states/media_player.living_room_tv') {
        ha.gets++;
        if (ha.onAfterGets && ha.gets > ha.onAfterGets) ha.state = 'on';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state: ha.state, attributes: ha.attrs }));
      }
      if (req.method === 'POST' && req.url.indexOf('/api/services/') === 0) {
        const body = b ? JSON.parse(b) : {};
        ha.calls.push({ path: req.url.slice(14), body: body });
        if (req.url.endsWith('/turn_on') && !ha.stuck) ha.state = 'on';
        if (req.url.endsWith('/select_source') && ha.attrs.app_name !== undefined && ha.follow) ha.attrs.app_name = body.source;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('[]');
      }
      if (req.method === 'POST' && req.url.indexOf('/api/webhook/') === 0) { ha.hooks.push(req.url); res.writeHead(200); return res.end(''); }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    ha.url = 'http://127.0.0.1:' + server.address().port;
    ha.close = () => new Promise((r) => server.close(r));
    resolve(ha);
  }));
}

function fakeRemote(ok) {
  const r = { found: true, runs: [], run: (spec) => { r.runs.push(spec); return { started: true, done: Promise.resolve({ ok: ok !== false, steps: [{ step: 'find', ok: true, detail: r.found === false ? 'not in the TV\'s list; kept the hub\'s id' : 'found by name' }] }) }; } };
  return r;
}

function make(ha, extra) {
  const logs = [];
  const remote = fakeRemote(extra && extra.remoteOk);
  const l = tvlaunch.create(Object.assign({
    config: tvlaunch.configFromEnv({ HA_TOKEN: TOKEN, HA_URL: ha.url }), remote: remote, log: (s) => logs.push(s),
    sleep: () => Promise.resolve(), timeoutMs: 1000, pollMs: 1, onSteadyMs: 0, bootMs: 5000, settleMs: 0, verifyMs: 0
  }, extra || {}));
  return { l: l, logs: logs, remote: remote };
}

(async () => {
  await check('normalize accepts the four kinds and refuses bad input', () => {
    assert.strictEqual(tvlaunch.normalize({ kind: 'app', name: 'Netflix' }).match[0], 'Netflix');
    assert.strictEqual(tvlaunch.normalize({ kind: 'key', name: 'HDMI', key: 'KEY_HDMI1' }).key, 'KEY_HDMI1');
    assert.strictEqual(tvlaunch.normalize({ kind: 'webhook', name: 'Xbox', url: 'http://1.2.3.4:8123/api/webhook/hub_xbox' }).hook, '/api/webhook/hub_xbox');
    ['x', { kind: 'bad', name: 'a' }, { kind: 'app' }, { kind: 'app', name: 'a', extra: 1 }, { kind: 'key', name: 'a', key: 'rm -rf' },
      { kind: 'webhook', name: 'a', url: 'http://evil/other' }, { kind: 'app', name: 'a', url: 'x' }].forEach((b) => {
      assert.throws(() => tvlaunch.normalize(b), (e) => e.status === 400);
    });
    assert.strictEqual(tvlaunch.normalize({ kind: 'app', name: 'Déjà vu' }).name, 'Déjà vu');
  });

  await check('pickSource: exact first, then starts-with, else empty', () => {
    assert.strictEqual(tvlaunch.pickSource(['Amazon Prime Video', 'Prime Video'], ['prime video']), 'Prime Video');
    assert.strictEqual(tvlaunch.pickSource(['Peacock TV'], ['Peacock']), 'Peacock TV');
    assert.strictEqual(tvlaunch.pickSource(['Hulu'], ['Netflix']), '');
    assert.strictEqual(tvlaunch.pickSource(undefined, ['x']), '');
  });

  await check('TV off: turns it on, waits, then selects the source', async () => {
    const ha = await fakeHa({ state: 'off', onAfterGets: 0 });
    const t = make(ha);
    const r = t.l.launch({ kind: 'app', name: 'Netflix', match: ['Netflix'] });
    assert.strictEqual(r.queued, true);
    const rec = await r.done;
    assert.strictEqual(rec.ok, true);
    assert.deepStrictEqual(ha.calls.map((c) => c.path), ['media_player/turn_on', 'media_player/select_source']);
    assert.strictEqual(ha.calls[1].body.source, 'Netflix');
    assert.strictEqual(t.remote.runs.length, 0);
    await ha.close();
  });

  await check('TV flapping while it boots is waited out', async () => {
    const ha = await fakeHa({ state: 'off' });
    let n = 0;
    const t = make(ha, { onSteadyMs: 5 , sleep: (ms) => { n++; if (n === 2) ha.state = 'off'; else if (n === 3) ha.state = 'on'; return new Promise((r) => setTimeout(r, 8)); } });
    const rec = await t.l.launch({ kind: 'app', name: 'Netflix' }).done;
    assert.strictEqual(rec.ok, true, rec.steps.join(','));
    await ha.close();
  });

  await check('TV never comes on: fails, says so, no source call', async () => {
    const ha = await fakeHa({ state: 'off', stuck: true });
    const t = make(ha, { bootMs: 30 });
    // turn_on is accepted but the fake stays off
    const origCalls = ha.calls;
    const rec = await (async () => { const r = t.l.launch({ kind: 'key', name: 'HDMI', key: 'KEY_HDMI1' }); ha.state = 'off'; return r.done; })();
    assert.strictEqual(rec.ok, false);
    await ha.close();
    assert.ok(origCalls.length >= 1);
  });

  await check('name not in the source list: falls back to the remote link by name', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    const rec = await t.l.launch({ kind: 'app', name: 'Pluto TV', match: ['Pluto TV', 'Pluto'] }).done;
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(t.remote.runs[0].appName, 'Pluto TV');
    assert.strictEqual(t.remote.runs[0].enter, false);
    assert.ok(!ha.calls.some((c) => c.path.endsWith('select_source')));
    await ha.close();
  });

  await check('remote link that cannot find the name is not counted as opened', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    t.remote.found = false;
    const rec = await t.l.launch({ kind: 'app', name: 'Pluto TV' }).done;
    assert.strictEqual(rec.ok, false);
    await ha.close();
  });

  await check('TizenBrew opens the TV\'s "TizenBrewNextGeneration" source', async () => {
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['Netflix', 'TizenBrewNextGeneration'] } });
    const t = make(ha);
    await t.l.launch({ kind: 'app', name: 'TizenBrew' }).done;
    assert.strictEqual(ha.calls[0].body.source, 'TizenBrewNextGeneration');
    assert.strictEqual(tvlaunch.pickSource(['Tizen Brew'], ['TizenBrew']), 'Tizen Brew');
    await ha.close();
  });

  await check('tizentube picks TizenTube over YouTube when both are listed', async () => {
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['YouTube', 'TizenTube'] } });
    const t = make(ha);
    await t.l.launch({ kind: 'tizentube', name: 'YouTube' }).done;
    assert.strictEqual(ha.calls[0].body.source, 'TizenTube');
    await ha.close();
  });

  await check('source selected but the app did not open: retries through the remote link', async () => {
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['Netflix'], app_name: 'TizenBrew' } });
    const t = make(ha);
    const rec = await t.l.launch({ kind: 'app', name: 'Netflix' }).done;
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(t.remote.runs.length, 1);
    await ha.close();
  });

  await check('app opened as seen by app_name: no remote link', async () => {
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['Netflix'], app_name: 'Netflix' } });
    const t = make(ha);
    assert.strictEqual((await t.l.launch({ kind: 'app', name: 'Netflix' }).done).ok, true);
    assert.strictEqual(t.remote.runs.length, 0);
    await ha.close();
  });

  await check('key goes through send_key; webhook posts only the path to Home Assistant', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    await t.l.launch({ kind: 'key', name: 'HDMI 2', key: 'KEY_HDMI2' }).done;
    assert.deepStrictEqual(ha.calls[0], { path: 'media_player/play_media', body: { entity_id: 'media_player.living_room_tv', media_content_type: 'send_key', media_content_id: 'KEY_HDMI2' } });
    const rec = await t.l.launch({ kind: 'webhook', name: 'Xbox', url: 'http://elsewhere.example:9/api/webhook/hub_xbox' }).done;
    assert.strictEqual(rec.ok, true);
    assert.deepStrictEqual(ha.hooks, ['/api/webhook/hub_xbox']);
    await ha.close();
  });

  await check('tizentube prefers a TizenTube source, else YouTube', async () => {
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['YouTube'] } });
    const t = make(ha);
    await t.l.launch({ kind: 'tizentube', name: 'YouTube' }).done;
    assert.strictEqual(ha.calls[0].body.source, 'YouTube');
    await ha.close();
  });

  await check('one launch at a time (409); Home Assistant down uses the remote link', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    const a = t.l.launch({ kind: 'app', name: 'Netflix' });
    assert.throws(() => t.l.launch({ kind: 'app', name: 'Hulu' }), (e) => e.status === 409);
    await a.done;
    ha.status = 500;
    const rec = await t.l.launch({ kind: 'app', name: 'Hulu' }).done;
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(t.remote.runs.length, 1);
    await ha.close();
  });

  await check('no token: apps use the remote link, keys and webhooks say 503', async () => {
    const remote = fakeRemote();
    const l = tvlaunch.create({ config: tvlaunch.configFromEnv({}), remote: remote, log: () => {} });
    assert.strictEqual((await l.launch({ kind: 'app', name: 'Netflix' }).done).ok, true);
    assert.throws(() => l.launch({ kind: 'key', name: 'x', key: 'KEY_A' }), (e) => e.status === 503);
  });

  await check('log lines hold no app name, token or address', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    await t.l.launch({ kind: 'app', name: 'Netflix' }).done;
    const all = t.logs.join('\n');
    assert.ok(/tvlaunch: app: ok/.test(all));
    assert.ok(all.indexOf('Netflix') < 0 && all.indexOf(TOKEN) < 0 && all.indexOf('127.0.0.1') < 0 && all.indexOf('living_room') < 0, all);
    await ha.close();
  });

  await check('title and link: checked, open the app only, never logged or kept', async () => {
    const r = tvlaunch.normalize({ kind: 'app', name: 'Netflix', title: 'Stranger Things', link: '80057281' });
    assert.strictEqual(r.title, 'Stranger Things');
    assert.strictEqual(r.link, '80057281');
    [{ kind: 'app', name: 'a', title: '' }, { kind: 'app', name: 'a', title: 'x'.repeat(81) }, { kind: 'app', name: 'a', title: 'a\nb' },
      { kind: 'app', name: 'a', link: 'https://x/y' }, { kind: 'app', name: 'a', link: 'a b' }, { kind: 'app', name: 'a', link: 5 },
      { kind: 'key', name: 'a', key: 'KEY_A', title: 'Show' }].forEach((b) => {
      assert.throws(() => tvlaunch.normalize(b), (e) => e.status === 400, JSON.stringify(b));
    });
    // Netflix with a link, and the app not seen open: the remote link opens the app by name, never a deep link.
    const ha = await fakeHa({ state: 'on', attrs: { source_list: ['Netflix'], app_name: 'TizenBrew' } });
    const t = make(ha);
    const rec = await t.l.launch({ kind: 'app', name: 'Netflix', title: 'Stranger Things', link: '80057281' }).done;
    assert.strictEqual(rec.ok, true);
    assert.strictEqual(ha.calls[0].body.source, 'Netflix');
    assert.strictEqual(t.remote.runs.length, 1);
    assert.strictEqual(t.remote.runs[0].link, 'none');
    assert.ok(JSON.stringify(t.remote.runs[0]).indexOf('80057281') < 0);
    // YouTube with a video id: TizenTube (or YouTube) opens, nothing more.
    ha.attrs.source_list = ['YouTube', 'TizenTube'];
    ha.attrs.app_name = 'TizenTube';
    const yt = await t.l.launch({ kind: 'tizentube', name: 'YouTube', title: 'Hot Ones', link: 'dQw4w9WgXcQ' }).done;
    assert.strictEqual(yt.ok, true);
    const all = t.logs.join('\n') + JSON.stringify(await t.l.status());
    ['Stranger', '80057281', 'Hot Ones', 'dQw4w9WgXcQ'].forEach((x) => assert.ok(all.indexOf(x) < 0, x + ' leaked: ' + all));
    assert.ok(/video id not used/.test(all) && /show link not used/.test(all), all);
    await ha.close();
  });

  await check('status lists the TV state and its sources, never the token', async () => {
    const ha = await fakeHa({ state: 'on' });
    const t = make(ha);
    const s = await t.l.status();
    assert.strictEqual(s.state, 'on');
    assert.deepStrictEqual(s.sources, ['Netflix', 'Prime Video', 'HDMI 1']);
    assert.ok(JSON.stringify(s).indexOf(TOKEN) < 0);
    await ha.close();
  });

  await check('the server: POST /tv/launch answers 202 at once, 400 for junk, and the TV is opened', async () => {
    const ha = await fakeHa({ state: 'on' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tvlaunch-test-'));
    const srv = hubServer.start({ port: 0, dataDir: dir, token: TOKEN + TOKEN, tvIps: ['127.0.0.1'], tvLaunchEnv: { HA_TOKEN: TOKEN, HA_URL: ha.url }, log: () => {} });
    await srv.ready;
    const port = srv.port;
    const post = (p, body) => new Promise((resolve, reject) => {
      const d = JSON.stringify(body);
      const rq = http.request({ host: '127.0.0.1', port: port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
      });
      rq.on('error', reject); rq.end(d);
    });
    const ok = await post('/tv/launch', { kind: 'app', name: 'Netflix', match: ['Netflix'] });
    assert.strictEqual(ok.status, 202);
    assert.strictEqual(ok.body.queued, true);
    const bad = await post('/tv/launch', { kind: 'nope', name: 'x' });
    assert.strictEqual(bad.status, 400);
    for (let i = 0; i < 100 && !ha.calls.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(ha.calls.some((c) => c.path === 'media_player/select_source'), JSON.stringify(ha.calls));
    await new Promise((r) => srv.close(r));
    await ha.close();
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
