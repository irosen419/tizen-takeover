/*
 * Tests for the photo album: node pi/photos-test.js
 *
 * photos.js on its own (WebP VP8/VP8L/VP8X, JPEG and PNG headers from tiny
 * made-up buffers, the index build, ids), then the real server over HTTP:
 * GET /photos/list and /photos/img/<id> (types, cache header, bad ids and
 * path tricks refused, outside addresses refused, Tailscale allowed even with
 * HUB_TV_IPS), GET /api/photos, ./hub photos status and the mailbox's
 * photos.status, and no file name or id in any log line. Every picture here
 * is synthetic (a few bytes). Only Node, no packages.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const photos = require('./photos');
const hubctl = require('./hubctl');
const mailbox = require('./mailbox');
const hubServer = require('./server');

const TOKEN = 'photos-test-token-0123456789abcdef';
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-photos-'));
  dirs.push(d);
  return d;
}

/* ---------- tiny synthetic headers ---------- */

function riff(kind, payload) {
  const chunk = Buffer.concat([Buffer.from(kind, 'ascii'), Buffer.alloc(4), payload]);
  chunk.writeUInt32LE(payload.length, 4);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii');
  head.writeUInt32LE(4 + chunk.length, 4);
  return Buffer.concat([head, chunk]);
}

function webpVP8(w, h) {
  const p = Buffer.alloc(10);
  p[3] = 0x9d; p[4] = 0x01; p[5] = 0x2a;
  p.writeUInt16LE(w, 6);
  p.writeUInt16LE(h, 8);
  return riff('VP8 ', p);
}

function webpVP8L(w, h) {
  const p = Buffer.alloc(5);
  p[0] = 0x2f;
  p.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 1);
  return riff('VP8L', p);
}

function webpVP8X(w, h) {
  const p = Buffer.alloc(10);
  p.writeUIntLE(w - 1, 4, 3);
  p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
}

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: body, json: json });
      });
    });
    req.on('error', reject);
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

// A made-up album: names a real phone might give, never real photos.
const NAMES = ['IMG_friend_one.webp', 'party photo.JPG', 'lossless.webp', 'clip.mp4', 'notes.txt'];
function album(dataDir) {
  const dir = path.join(dataDir, 'photos');
  fs.mkdirSync(path.join(dir, 'orig'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'thumb'), { recursive: true });
  const files = { 'IMG_friend_one.webp': webpVP8X(1080, 1440), 'party photo.JPG': jpeg(1440, 1080), 'lossless.webp': webpVP8L(300, 400), 'clip.mp4': Buffer.from('not a photo'), 'notes.txt': Buffer.from('x') };
  const times = { 'IMG_friend_one.webp': '2026-10-05T12:00:00', 'party photo.JPG': '2026-11-02T12:00:00', 'lossless.webp': '2026-09-20T12:00:00' };
  Object.keys(files).forEach((n) => {
    const f = path.join(dir, 'orig', n);
    fs.writeFileSync(f, files[n]);
    if (times[n]) fs.utimesSync(f, new Date(times[n]), new Date(times[n]));
  });
  // One thumb (named by id, as photos-sync.sh writes it); the others fall back to the original.
  fs.writeFileSync(path.join(dir, 'thumb', photos.idFor('IMG_friend_one.webp') + '.jpg'), jpeg(480, 640));
  fs.writeFileSync(path.join(dir, 'orig', '.part-123'), webpVP8(10, 10)); // a pull in progress
  return dir;
}

async function main() {
  /* ---------- photos.js ---------- */

  await check('imageSize: WebP VP8, VP8L, VP8X, JPEG SOF (after APP0), PNG IHDR', () => {
    assert.deepStrictEqual(photos.imageSize(webpVP8(1080, 1440)), { w: 1080, h: 1440 });
    assert.deepStrictEqual(photos.imageSize(webpVP8L(1080, 1440)), { w: 1080, h: 1440 });
    assert.deepStrictEqual(photos.imageSize(webpVP8X(4000, 3000)), { w: 4000, h: 3000 });
    assert.deepStrictEqual(photos.imageSize(jpeg(640, 480)), { w: 640, h: 480 });
    assert.deepStrictEqual(photos.imageSize(png(33, 77)), { w: 33, h: 77 });
  });

  await check('imageSize: junk, truncated and odd buffers give null, never throw', () => {
    [Buffer.alloc(0), Buffer.from('hello world, not an image'), webpVP8(10, 10).subarray(0, 20), jpeg(10, 10).subarray(0, 12),
      png(1, 1).subarray(0, 18), Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]), null, 'RIFF']
      .forEach((b, i) => assert.strictEqual(photos.imageSize(b), null, 'case ' + i));
    assert.strictEqual(photos.imageSize(png(0, 5)), null);
  });

  await check('ids: 12 hex of sha1(name); isId refuses path tricks', () => {
    assert.strictEqual(photos.idFor('a.webp'), require('crypto').createHash('sha1').update('a.webp').digest('hex').slice(0, 12));
    assert.ok(photos.isId(photos.idFor('x')));
    ['', '../etc/passwd', '0123456789ab/', '0123456789AB', '0123456789a', '0123456789abc', '..%2f..%2f', 12345, null].forEach((v) => assert.strictEqual(photos.isId(v), false, String(v)));
  });

  await check('buildIndex: images only, sizes, month, newest first, "added" kept, atomic, no names', () => {
    const d = tmp();
    const dir = album(d);
    const r = photos.buildIndex(dir, 1000);
    assert.deepStrictEqual(r, { count: 3, skipped: 0 });
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.deepStrictEqual(idx.items.map((i) => i.month), ['2026-11', '2026-10', '2026-09']);
    assert.deepStrictEqual(idx.items[0], { id: photos.idFor('party photo.JPG'), w: 1440, h: 1080, month: '2026-11', added: 1000 });
    assert.deepStrictEqual(idx.items[1].w + 'x' + idx.items[1].h, '1080x1440');
    const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    NAMES.forEach((n) => assert.ok(text.indexOf(n) < 0 && text.indexOf(n.split('.')[0]) < 0, 'name in index'));
    // A second build keeps "added"; a new photo gets the new time.
    fs.writeFileSync(path.join(dir, 'orig', 'later.png'), png(20, 10));
    photos.buildIndex(dir, 2000);
    const idx2 = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.strictEqual(idx2.items.length, 4);
    assert.strictEqual(idx2.items.find((i) => i.id === photos.idFor('party photo.JPG')).added, 1000);
    assert.strictEqual(idx2.items.find((i) => i.id === photos.idFor('later.png')).added, 2000);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /\.tmp$/.test(n)), []);
    // A missing folder is just an empty album.
    assert.deepStrictEqual(photos.buildIndex(path.join(tmp(), 'photos')), { count: 0, skipped: 0 });
  });

  await check('store: list caps at 500 and has a rev; readThumb falls back; stat; ids not in the index are refused', async () => {
    const dir = path.join(tmp(), 'photos');
    fs.mkdirSync(dir, { recursive: true });
    const many = [];
    for (let i = 0; i < 520; i++) many.push({ id: photos.idFor('p' + i), w: 3, h: 4, month: '2026-11', added: i });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: 1, items: many.concat([{ id: '../x', w: 1, h: 1, month: '2026-11' }]) }));
    const s = photos.createLocalStore({ dir: dir });
    const v = await s.list();
    assert.strictEqual(v.count, 500);
    assert.ok(/^[0-9a-f]{12}$/.test(v.rev));
    assert.strictEqual(await s.readOriginal(photos.idFor('p1')), null); // indexed, but no file
    assert.strictEqual(await s.readOriginal('ffffffffffff'), null);
    assert.deepStrictEqual(await s.stat(), { count: 500, lastRun: null, ok: null, newCount: 0 });
    const d2 = tmp();
    const dir2 = album(d2);
    photos.buildIndex(dir2);
    const s2 = photos.createLocalStore({ dir: dir2 });
    const t = await s2.readThumb(photos.idFor('lossless.webp'));
    assert.strictEqual(t.type, 'image/webp');
    assert.strictEqual(path.basename(t.file), 'lossless.webp');
    assert.strictEqual((await s2.readThumb(photos.idFor('IMG_friend_one.webp'))).type, 'image/jpeg');
  });

  /* ---------- the server ---------- */

  const h = await start();
  const P = h.port;
  const dir = album(h.dataDir);
  photos.buildIndex(dir);
  photos.writeState(dir, { lastRun: '2026-11-23T10:30:00.000Z', ok: true, count: 3, newCount: 2 });
  const idWebp = photos.idFor('IMG_friend_one.webp');
  const idJpg = photos.idFor('party photo.JPG');

  await check('GET /photos/list: { ok, rev, count, items: [{ id, w, h, month }] }, no names', async () => {
    const r = await request(P, 'GET', '/photos/list');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['count', 'items', 'ok', 'rev']);
    assert.strictEqual(r.json.count, 3);
    assert.deepStrictEqual(Object.keys(r.json.items[0]).sort(), ['h', 'id', 'month', 'w']);
    assert.strictEqual(r.json.items[0].id, idJpg);
    NAMES.forEach((n) => assert.ok(r.body.toString().indexOf(n) < 0));
    const again = await request(P, 'GET', '/photos/list');
    assert.strictEqual(again.json.rev, r.json.rev);
  });

  await check('a new photo changes rev (no restart); the log says the count only', async () => {
    const before = (await request(P, 'GET', '/photos/list')).json.rev;
    fs.writeFileSync(path.join(dir, 'orig', 'new one.png'), png(8, 8));
    photos.buildIndex(dir);
    const t = new Date(Date.now() + 5000); // a later mtime, even on a coarse clock
    fs.utimesSync(path.join(dir, 'index.json'), t, t);
    const r = await request(P, 'GET', '/photos/list');
    assert.strictEqual(r.json.count, 4);
    assert.notStrictEqual(r.json.rev, before);
    assert.ok(h.lines.some((l) => / photos: the album now has 4 photos$/.test(l)), h.lines.join('\n'));
  });

  await check('GET /photos/img/<id>: full and thumb, right types, immutable cache, HEAD', async () => {
    let r = await request(P, 'GET', '/photos/img/' + idWebp + '?size=full');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/webp');
    assert.strictEqual(r.headers['cache-control'], 'public, max-age=86400, immutable');
    assert.ok(r.body.equals(webpVP8X(1080, 1440)));
    r = await request(P, 'GET', '/photos/img/' + idWebp + '?size=thumb');
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    assert.ok(r.body.equals(jpeg(480, 640)));
    r = await request(P, 'GET', '/photos/img/' + idJpg);
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    r = await request(P, 'GET', '/photos/img/' + idJpg + '?size=thumb'); // no thumb: the original
    assert.strictEqual(r.status, 200);
    r = await request(P, 'HEAD', '/photos/img/' + idJpg);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 0);
    assert.strictEqual(Number(r.headers['content-length']), jpeg(1440, 1080).length);
  });

  await check('bad ids, path tricks, videos, bad size and POST are refused', async () => {
    const bad = ['/photos/img/../index.json', '/photos/img/..%2findex.json', '/photos/img/' + idWebp.toUpperCase(),
      '/photos/img/' + idWebp + 'a', '/photos/img/' + idWebp.slice(1), '/photos/img/', '/photos/img/%2e%2e',
      '/photos/img/' + photos.idFor('clip.mp4'), '/photos/img/' + photos.idFor('notes.txt'), '/photos/img/ffffffffffff',
      '/photos/img/' + photos.idFor('.part-123')];
    for (const p of bad) {
      const r = await request(P, 'GET', p);
      assert.ok(r.status === 404 || r.status === 400, p + ' ' + r.status);
      assert.ok(!/^image\//.test(r.headers['content-type'] || ''), p);
    }
    assert.strictEqual((await request(P, 'GET', '/photos/img/' + idWebp + '?size=huge')).status, 400);
    assert.strictEqual((await request(P, 'POST', '/photos/list')).status, 405);
  });

  await check('who gets in: home and Tailscale yes, the internet no, a foreign Host no', async () => {
    for (const ip of ['192.168.1.50', '100.70.0.9', '10.0.0.4']) {
      assert.strictEqual((await request(P, 'GET', '/photos/list', { headers: { 'x-test-ip': ip } })).status, 200, ip);
    }
    assert.strictEqual((await request(P, 'GET', '/photos/list', { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/photos/img/' + idWebp, { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/photos/list', { headers: { Host: 'evil.example.com' } })).status, 403);
  });

  await check('GET /api/photos (token), ./hub photos status and mailbox photos.status: counts only', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/photos')).status, 401);
    const r = await request(P, 'GET', '/api/photos', { token: TOKEN });
    assert.deepStrictEqual(r.json, { ok: true, store: 'local', count: 4, lastRun: '2026-11-23T10:30:00.000Z', syncOk: true, newCount: 2 });
    const line = hubctl.photosStatusText(r.json);
    assert.ok(/^Photo album: 4 photos\. Last sync .+ \(ok, 2 new\)\.$/.test(line), line);
    assert.ok(/Never synced/.test(hubctl.photosStatusText({ count: 0, lastRun: null })));
    assert.ok(/some files could not be copied/.test(hubctl.photosStatusText({ count: 1, lastRun: '2026-11-23T10:30:00Z', syncOk: false, newCount: 0 })));
    const out = await mailbox.COMMANDS['photos.status'].run({}, {
      call: (m, p) => request(P, m, p, { token: TOKEN }).then((x) => x.json)
    });
    assert.strictEqual(out.message, line);
    assert.deepStrictEqual(out.data, { count: 4, newCount: 2, lastRun: '2026-11-23T10:30:00.000Z', ok: true });
  });

  await check('no file name or id in any log line', () => {
    const all = h.lines.join('\n');
    NAMES.concat(['new one.png']).forEach((n) => assert.ok(all.indexOf(n) < 0, n));
    [idWebp, idJpg].forEach((id) => assert.ok(all.indexOf(id) < 0, 'id in log'));
  });

  await stop(h);

  await check('startup logs the count; an album-less Pi says nothing and lists empty', async () => {
    const d = tmp();
    photos.buildIndex(album(d));
    const h2 = await start({ dataDir: d });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(h2.lines.some((l) => / photos: 3 in the album$/.test(l)), h2.lines.join('\n'));
    await stop(h2);
    const h3 = await start();
    const r = await request(h3.port, 'GET', '/photos/list');
    assert.deepStrictEqual(r.json, { ok: true, rev: '', count: 0, items: [] });
    assert.ok(!h3.lines.some((l) => / photos: /.test(l)));
    await stop(h3);
  });

  await check('photos.js CLI: index writes index.json and state.json, prints counts only', () => {
    const d = tmp();
    album(d);
    const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'photos.js'), 'index', d, '--new', '3'], { encoding: 'utf8' });
    assert.strictEqual(out.trim(), 'photos: 3 in the album, 3 new');
    const st = JSON.parse(fs.readFileSync(path.join(d, 'photos', 'state.json'), 'utf8'));
    assert.deepStrictEqual([st.ok, st.count, st.newCount], [true, 3, 3]);
  });

  await check('photos-sync.sh: POSIX sh syntax, never deletes on the calendar', () => {
    const file = path.join(__dirname, 'photos-sync.sh');
    require('child_process').execFileSync('sh', ['-n', file]);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/adb[^\n]*shell[^\n]*\brm\b/.test(text));
    assert.ok(!/rm -[rf]*\s+"\$ORIG\/\$name"/.test(text));
  });

  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
