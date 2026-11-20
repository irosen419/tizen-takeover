/*
 * Tests for the grocery list and the touch app's doors: node pi/grocery-test.js
 *
 * grocery.js on its own (ops, clean-up, match), then the real server over
 * HTTP: the control API, GET /touch/state and POST /grocery/ops, the app
 * files (GET / and /app/...) with path tricks refused, Tailscale addresses
 * and .ts.net names, Origin rules, a phone never counted as a screen, and
 * HUB_TV_IPS not shutting a phone out of the touch routes. Only Node, no
 * packages. Prints one line per check, then "N passed, 0 failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const grocery = require('./grocery');
const hubServer = require('./server');

const TOKEN = 'grocery-test-token-0123456789abcdef';
let passed = 0;
let failed = 0;
const dirs = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e));
  }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-grocery-'));
  dirs.push(d);
  return d;
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function start(extra) {
  const lines = [];
  const opts = Object.assign({
    port: 0, token: TOKEN, dataDir: tmp(), log: (s) => lines.push(String(s)),
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress
  }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.lines = lines; h.dataDir = opts.dataDir; return h; });
}
const stop = (h) => new Promise((r) => h.close(r));

async function main() {
  /* ---------- grocery.js ---------- */

  await check('applyOps: add (trimmed, no doubles, a ticked one comes back), check, remove, clear', () => {
    const t = 1000;
    let l = grocery.applyOps([], [{ op: 'add', name: '  Oat   milk ' }, { op: 'add', name: 'Eggs' }, { op: 'add', name: 'oat MILK' }], t);
    assert.deepStrictEqual(l.map((i) => i.name), ['Eggs', 'Oat milk']);
    const eggs = l[0].id;
    l = grocery.applyOps(l, [{ op: 'check', id: eggs, done: true }], t + 1);
    assert.strictEqual(l[0].done, true);
    assert.strictEqual(l[0].doneAt, t + 1);
    l = grocery.applyOps(l, [{ op: 'add', name: 'EGGS' }], t + 2);
    assert.strictEqual(l.length, 2);
    assert.strictEqual(l[0].done, false, 'unticked by adding it again');
    l = grocery.applyOps(l, [{ op: 'check', id: eggs, done: true }, { op: 'clear' }], t + 3);
    assert.deepStrictEqual(l.map((i) => i.name), ['Oat milk']);
    l = grocery.applyOps(l, [{ op: 'remove', id: l[0].id }], t + 4);
    assert.deepStrictEqual(l, []);
  });

  await check('applyOps: wrong ops throw a 400 and change nothing', () => {
    const l = grocery.applyOps([], [{ op: 'add', name: 'Milk' }], 1);
    const cases = [
      [undefined, /send \{ "ops"/], [[], /send \{ "ops"/], [Array(51).fill({ op: 'clear' }), /at most 50 ops/],
      [[{ op: 'add', name: '' }], /must not be empty/], [[{ op: 'add', name: 'x'.repeat(61) }], /at most 60/],
      [[{ op: 'add', name: 5 }], /must be text/], [[{ op: 'check', id: 'nope' }], /no grocery item/],
      [[{ op: 'check', id: l[0].id, done: 'yes' }], /true or false/], [[{ op: 'zap' }], /unknown op/], [['add'], /needs an "op"/]
    ];
    cases.forEach(([ops, re]) => {
      assert.throws(() => grocery.applyOps(l, ops, 2), (e) => e.status === 400 && re.test(e.message), JSON.stringify(ops));
    });
    assert.strictEqual(l.length, 1);
  });

  await check('applyOps: a ticked item goes after 48 hours; the list holds at most 200', () => {
    let l = grocery.applyOps([], [{ op: 'add', name: 'Old' }], 0);
    l = grocery.applyOps(l, [{ op: 'check', id: l[0].id, done: true }], 0);
    l = grocery.applyOps(l, [{ op: 'add', name: 'New' }], 49 * 3600 * 1000);
    assert.deepStrictEqual(l.map((i) => i.name), ['New']);
    const many = [];
    for (let i = 0; i < 4; i++) many.push(grocery.applyOps(many.length ? many[many.length - 1] : [], Array.from({ length: 50 }, (x, j) => ({ op: 'add', name: 'i' + i + '-' + j })), 5));
    assert.strictEqual(many[3].length, 200);
    assert.throws(() => grocery.applyOps(many[3], [{ op: 'add', name: 'one more' }], 5), /full \(200 items\)/);
  });

  await check('cleanResource: rebuilds a damaged saved list, drops bad and doubled items', () => {
    assert.deepStrictEqual(grocery.cleanResource(undefined), { rev: 0, data: { items: [] } });
    const r = grocery.cleanResource({ rev: 4, data: { items: [{ id: 'a1', name: 'Milk', done: true, doneAt: 5, addedAt: 1 }, { id: 'a1', name: 'Twin' }, { name: '' }, 'x', { id: '../bad id', name: 'Eggs', extra: 1 }] } });
    assert.strictEqual(r.rev, 4);
    assert.deepStrictEqual(r.data.items.map((i) => i.name), ['Milk', 'Eggs']);
    assert.ok(/^g[0-9a-f]{10}$/.test(r.data.items[1].id), 'a bad id is replaced');
    assert.strictEqual(r.data.items[1].extra, undefined);
  });

  await check('items carry upc: empty for a typed name, kept when canonical, dropped when not', () => {
    let l = grocery.applyOps([], [{ op: 'add', name: 'Milk' }, { op: 'add', name: 'Cola', upc: '0036000291452' }], 1);
    assert.deepStrictEqual(l.map((i) => i.upc), ['0036000291452', '']);
    l = grocery.applyOps(l, [{ op: 'add', name: 'milk', upc: '96385074' }], 2);
    assert.strictEqual(l.length, 2, 'a typed item of that name takes the upc');
    assert.strictEqual(l.find((i) => i.name === 'Milk').upc, '96385074');
    assert.throws(() => grocery.applyOps(l, [{ op: 'add', name: 'X', upc: '0036' }], 3), /8 or 13 digits/);
    assert.strictEqual(grocery.cleanItem({ name: 'Old' }, 1).upc, '');
  });

  await check('match: by id, then by name in any case; listLines', () => {
    const items = [{ id: 'g1', name: 'Milk', done: false }, { id: 'g2', name: 'Eggs', done: true }];
    assert.strictEqual(grocery.match(items, 'g2').name, 'Eggs');
    assert.strictEqual(grocery.match(items, 'milk').id, 'g1');
    assert.strictEqual(grocery.match(items, 'Bread'), null);
    assert.deepStrictEqual(grocery.listLines(items), ['[ ] Milk   id g1', '[x] Eggs   id g2']);
    assert.deepStrictEqual(grocery.listLines([]), ['The grocery list is empty.']);
  });

  /* ---------- the server ---------- */

  const h = await start();
  const P = h.port;

  await check('control API: GET /api/grocery and POST /api/grocery/ops need the token', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/grocery')).status, 401);
    let r = await request(P, 'POST', '/api/grocery/ops', { token: TOKEN, body: { ops: [{ op: 'add', name: 'Milk' }, { op: 'add', name: 'Eggs' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.changed, true);
    assert.deepStrictEqual(r.json.items.map((i) => i.name), ['Eggs', 'Milk']);
    r = await request(P, 'GET', '/api/grocery', { token: TOKEN });
    assert.strictEqual(r.json.items.length, 2);
    r = await request(P, 'POST', '/api/grocery/ops', { token: TOKEN, body: { ops: [{ op: 'add', name: 'milk' }] } });
    assert.strictEqual(r.json.changed, false, 'adding what is there changes nothing');
    r = await request(P, 'POST', '/api/grocery/ops', { token: TOKEN, body: { ops: [{ op: 'zap' }] } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await request(P, 'GET', '/api/grocery/ops', { token: TOKEN })).status, 405);
  });

  await check('GET /touch/state: the grocery list only, from loopback and a Tailscale address', async () => {
    for (const ip of [null, '100.101.102.103', '192.168.1.20', 'fd7a:115c:a1e0::5']) {
      const r = await request(P, 'GET', '/touch/state', { headers: ip ? { 'x-test-ip': ip } : {} });
      assert.strictEqual(r.status, 200, String(ip));
      assert.strictEqual(r.json.ok, true);
      assert.deepStrictEqual(Object.keys(r.json.grocery).sort(), ['data', 'rev']);
      assert.strictEqual(r.json.grocery.data.items.length, 2);
      assert.deepStrictEqual(r.json.products, {}, 'no scanned items, no products');
      assert.strictEqual(r.json.todo, undefined);
      assert.strictEqual(r.json.resources, undefined);
    }
    for (const ip of ['8.8.8.8', '100.128.0.1', '100.63.0.1']) {
      assert.strictEqual((await request(P, 'GET', '/touch/state', { headers: { 'x-test-ip': ip } })).status, 403, ip);
    }
    assert.strictEqual((await request(P, 'POST', '/touch/state')).status, 405);
  });

  await check('a phone reading /touch/state is never counted as a screen', async () => {
    for (let i = 0; i < 3; i++) await request(P, 'GET', '/touch/state', { headers: { 'x-test-ip': '100.70.0.9' } });
    const r = await request(P, 'GET', '/api/status', { token: TOKEN });
    assert.deepStrictEqual(r.json.screens, []);
  });

  await check('POST /grocery/ops: no token; changes saved and logged by count, never by name', async () => {
    const r = await request(P, 'POST', '/grocery/ops', { headers: { 'x-test-ip': '100.70.0.9' }, body: { ops: [{ op: 'add', name: 'Secret sauce' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.items[0].name, 'Secret sauce');
    const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir || '', 'state.json'), 'utf8'));
    assert.strictEqual(saved.resources.grocery.data.items[0].name, 'Secret sauce');
    assert.ok(h.lines.some((l) => /touch app changed the grocery list/.test(l)));
    assert.ok(!h.lines.some((l) => /Secret sauce|Milk|Eggs/.test(l)), 'a name in the log');
    const bad = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'remove', id: 'nope' }] } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await request(P, 'GET', '/grocery/ops')).status, 405);
    assert.strictEqual((await request(P, 'POST', '/grocery/ops', { headers: { 'x-test-ip': '8.8.8.8' }, body: { ops: [{ op: 'clear' }] } })).status, 403);
  });

  await check('Origin: a foreign site is refused; the page\'s own address (http or https) and a listed one are allowed', async () => {
    const ops = { ops: [{ op: 'add', name: 'Bread' }] };
    let r = await request(P, 'POST', '/grocery/ops', { headers: { Origin: 'http://evil.example', Host: '192.168.1.219:8097' }, body: ops });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'origin not allowed');
    r = await request(P, 'POST', '/grocery/ops', { headers: { Origin: 'http://192.168.1.219:8097', Host: '192.168.1.219:8097' }, body: ops });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(P, 'POST', '/grocery/ops', { headers: { Origin: 'https://pi.tail1234.ts.net', Host: 'pi.tail1234.ts.net' }, body: ops });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(P, 'POST', '/grocery/ops', { headers: { Origin: 'http://pi.tail1234.ts.net:8097', Host: 'other.tail1234.ts.net:8097' }, body: ops });
    assert.strictEqual(r.status, 403, 'another host on the tailnet is still another origin');
    r = await request(P, 'POST', '/grocery/ops', { headers: { Origin: 'http://127.0.0.1:8081' }, body: ops });
    assert.strictEqual(r.status, 200, 'the default listed origin');
    // The TV's own POSTs follow the same rule.
    r = await request(P, 'POST', '/todo/ops', { headers: { Origin: 'http://192.168.1.219:8097', Host: '192.168.1.219:8097' }, body: { ops: [] } });
    assert.notStrictEqual(r.status, 403);
  });

  await check('Host: .ts.net and the Pi\'s address are fine; another site\'s name is refused', async () => {
    for (const host of ['pi.tail1234.ts.net', 'pi.tail1234.ts.net:8097', '100.101.102.103:8097', 'raspberrypi.local:8097']) {
      assert.strictEqual((await request(P, 'GET', '/touch/state', { headers: { Host: host } })).status, 200, host);
    }
    for (const host of ['evil.example', 'ts.net.evil.example', 'evil.example:8097']) {
      assert.strictEqual((await request(P, 'GET', '/touch/state', { headers: { Host: host } })).status, 403, host);
      assert.strictEqual((await request(P, 'GET', '/app/touch.html', { headers: { Host: host } })).status, 403, host);
    }
    assert.strictEqual(hubServer.hostAllowed('pi.tail1234.ts.net'), true);
    assert.strictEqual(hubServer.hostAllowed('ts.net.example.com'), false);
  });

  await check('GET / sends the phone to the app, keeping ?as= and ?lang=', async () => {
    let r = await request(P, 'GET', '/');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/app/touch.html');
    r = await request(P, 'GET', '/?as=tablet&lang=es');
    assert.strictEqual(r.headers.location, '/app/touch.html?as=tablet&lang=es');
    assert.strictEqual((await request(P, 'GET', '/', { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
  });

  await check('GET /app/...: the app\'s files read only, with their types', async () => {
    let r = await request(P, 'GET', '/app/touch.html');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(/touch\.js/.test(r.text));
    r = await request(P, 'GET', '/app/widgets/grocery.js');
    assert.strictEqual(r.headers['content-type'], 'application/javascript; charset=utf-8');
    r = await request(P, 'GET', '/app/touch.css');
    assert.strictEqual(r.headers['content-type'], 'text/css; charset=utf-8');
    r = await request(P, 'HEAD', '/app/config.js');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, '');
    assert.strictEqual((await request(P, 'POST', '/app/touch.html')).status, 405);
    assert.strictEqual((await request(P, 'GET', '/app/touch.html', { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
  });

  await check('GET /app/...: path tricks, dotfiles, unknown types and missing files are 404', async () => {
    const tries = ['/app/../pi/.env', '/app/%2e%2e/pi/.env', '/app/%2E%2E%2Fpi%2F.env', '/app/..%2fpi%2fserver.js', '/app/widgets/../../pi/server.js',
      '/app/.git/config', '/app/widgets/.hidden.js', '/app/%00touch.html', '/app/touch.html%00.js', '/app/', '/app/widgets',
      '/app/nope.html', '/app/README', '/app/touch.txt', '/app//etc/passwd.js', '/app/%2fetc%2fpasswd.js', '/app/..', '/app/%2e%2e'];
    for (const p of tries) {
      const r = await request(P, 'GET', p);
      // /app/.. is read as / (the URL parser folds it), which only redirects to the app.
      const home = r.status === 302 && r.headers.location === '/app/touch.html';
      assert.ok(r.status === 404 || r.status === 400 || home, p + ' -> ' + r.status);
      assert.ok(!/HUB_TOKEN|require\(/.test(r.text), p + ' leaked a file');
    }
  });

  await stop(h);

  await check('HUB_TV_IPS set: a phone at home or on Tailscale still uses the touch routes, but not /live/state', async () => {
    const h2 = await start({ tvIps: '192.168.1.50' });
    const phone = { 'x-test-ip': '192.168.1.77' };
    const tail = { 'x-test-ip': '100.88.1.2' };
    assert.strictEqual((await request(h2.port, 'GET', '/live/state', { headers: phone })).status, 403);
    assert.strictEqual((await request(h2.port, 'GET', '/live/state', { headers: tail })).status, 403);
    assert.strictEqual((await request(h2.port, 'GET', '/live/state', { headers: { 'x-test-ip': '192.168.1.50' } })).status, 200);
    for (const hd of [phone, tail]) {
      assert.strictEqual((await request(h2.port, 'GET', '/touch/state', { headers: hd })).status, 200);
      assert.strictEqual((await request(h2.port, 'GET', '/app/touch.html', { headers: hd })).status, 200);
      assert.strictEqual((await request(h2.port, 'POST', '/grocery/ops', { headers: hd, body: { ops: [{ op: 'add', name: 'Tea' }] } })).status, 200);
    }
    assert.strictEqual((await request(h2.port, 'GET', '/touch/state', { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
    await stop(h2);
  });

  await check('a saved list survives a restart; an old state file without one starts empty', async () => {
    const dir = tmp();
    let h3 = await start({ dataDir: dir });
    await request(h3.port, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', name: 'Rice' }] } });
    await stop(h3);
    h3 = await start({ dataDir: dir });
    let r = await request(h3.port, 'GET', '/touch/state');
    assert.deepStrictEqual(r.json.grocery.data.items.map((i) => i.name), ['Rice']);
    await stop(h3);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    delete st.resources.grocery;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    h3 = await start({ dataDir: dir });
    r = await request(h3.port, 'GET', '/touch/state');
    assert.deepStrictEqual(r.json.grocery.data.items, []);
    await stop(h3);
  });

  await check('the app folder can be moved (HUB_APP_DIR), and a missing one is just 404', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'touch.html'), '<p>moved</p>');
    let h4 = await start({ appDir: dir });
    assert.strictEqual((await request(h4.port, 'GET', '/app/touch.html')).text, '<p>moved</p>');
    await stop(h4);
    h4 = await start({ appDir: path.join(dir, 'gone') });
    assert.strictEqual((await request(h4.port, 'GET', '/app/touch.html')).status, 404);
    await stop(h4);
  });

  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
