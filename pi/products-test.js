/*
 * Tests for the products catalog (barcodes): node pi/products-test.js
 *
 * products.js on its own (codes and check digits, UPC-E, the catalog, the
 * lookup order, the 24-hour miss memory, rate limits, manual entries winning,
 * photos, pictures from the web and their address checks, the export), then
 * the real server over HTTP: the touch routes /products/lookup, /products/save
 * and /products/image/<upc> (with path tricks), /touch/state's products, the
 * control routes /api/products, /api/products/image and /api/grocery/export,
 * and grocery adds by upc. No network: every web call goes to a fake.
 * Only Node, no packages. Prints one line per check, then "N passed, 0 failed".
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const products = require('./products');
const grocery = require('./grocery');
const hubServer = require('./server');

const TOKEN = 'products-test-token-0123456789abcdef';
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-products-'));
  dirs.push(d);
  return d;
}

// A small valid JPEG-looking buffer (magic bytes are all the code checks).
function jpeg(n) {
  const b = Buffer.alloc(n || 64, 7);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

// Valid codes, built with the real check digit.
function withCheck(body) {
  for (let c = 0; c < 10; c++) if (products.checkOk(body + c)) return body + c;
  throw new Error('no check digit');
}

const COLA = '036000291452'; // UPC-A, a well-known valid one
const COLA_KEY = '0036000291452';
const EAN13 = '4006381333931';

/* A fake web. routes: { off: fn(key) -> {status, json}, opf, upc, image: fn(url) -> {status, headers, body} } */
function fakeWeb(routes) {
  const calls = [];
  const request = async (url, o) => {
    const u = new URL(url);
    let r;
    if (u.hostname === 'world.openfoodfacts.org') { calls.push('off'); r = routes.off ? await routes.off(u, o) : { status: 404, json: { status: 0 } }; }
    else if (u.hostname === 'world.openproductsfacts.org') { calls.push('opf'); r = routes.opf ? await routes.opf(u, o) : { status: 404, json: { status: 0 } }; }
    else if (u.hostname === 'api.upcitemdb.com') { calls.push('upc'); r = routes.upc ? await routes.upc(u, o) : { status: 200, json: { code: 'OK', total: 0, items: [] } }; }
    else { calls.push('img:' + u.hostname); r = routes.image ? await routes.image(u, o) : { status: 404, headers: {}, body: Buffer.alloc(0) }; }
    if (r.json !== undefined) return { status: r.status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(r.json)) };
    return r;
  };
  const resolve = async (host) => (routes.dns && routes.dns[host]) ? routes.dns[host] : [{ address: '93.184.216.34', family: 4 }];
  return { calls: calls, request: request, resolve: resolve };
}

function offHit(fields) {
  return () => ({ status: 200, json: { status: 1, product: Object.assign({ product_name: 'Cola', brands: 'Fizz Co,Other', quantity: '12 fl oz', image_front_small_url: 'https://images.openfoodfacts.org/x/front.200.jpg' }, fields || {}) } });
}
const goodImage = () => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg(500) });

function catalogWith(web, extra) {
  const dir = tmp();
  const lines = [];
  let t = 1000000;
  const c = products.createCatalog(Object.assign({ dataDir: dir, log: (s) => lines.push(s), request: web.request, resolve: web.resolve, now: () => t }, extra || {}));
  c.dir = dir;
  c.lines = lines;
  c.tick = (ms) => { t += ms; };
  return c;
}

function request(port, method, p, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    const body = o.raw !== undefined ? Buffer.from(o.raw) : (o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null);
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf: buf, text: buf.toString('utf8'), json: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  /* ---------- codes ---------- */

  await check('normalize: UPC-A gets a leading 0, EAN-13 stays, 14 digits with a leading 0 drop it; spaces and dashes are fine', () => {
    assert.strictEqual(products.normalize(COLA), COLA_KEY);
    assert.strictEqual(products.normalize(COLA_KEY), COLA_KEY);
    assert.strictEqual(products.normalize('0' + COLA_KEY), COLA_KEY);
    assert.strictEqual(products.normalize(EAN13), EAN13);
    assert.strictEqual(products.normalize(' 0 36000-29145 2 '), COLA_KEY);
    assert.strictEqual(products.normalize(EAN13, 'ean_13'), EAN13);
  });

  await check('normalize: a wrong check digit, letters, odd lengths and a 14-digit code without a leading 0 are a 400', () => {
    const bad = ['036000291453', '4006381333932', '1' + COLA_KEY, 'abc', '', '1234567', '123456789', '12345678901', '123456789012345', '0x36000291452', '+036000291452', null, undefined, {}, '96385075'];
    bad.forEach((c) => assert.throws(() => products.normalize(c), (e) => e.status === 400 && e.message === "that isn't a valid barcode number", String(c)));
    assert.throws(() => products.normalize('96385074', 'upc_e'), /valid barcode/, 'a code that is not a UPC-E with that hint');
  });

  await check('normalize: UPC-E expands for every last digit (0-9), with the hint or without', () => {
    // [six digits, expected 10-digit middle of the UPC-A]
    const cases = [
      ['123450', '1200000345'], ['123451', '1210000345'], ['123452', '1220000345'], ['123453', '1230000045'],
      ['123454', '1234000005'], ['123455', '1234500005'], ['123456', '1234500006'], ['123457', '1234500007'],
      ['123458', '1234500008'], ['123459', '1234500009']
    ];
    cases.forEach(([six, mid]) => {
      const a = withCheck('0' + mid);
      const e = '0' + six + a[11];
      assert.strictEqual(products.expandUpcE(e), a, six);
      assert.strictEqual(products.normalize(e, 'upc_e'), '0' + a, six);
      assert.strictEqual(products.normalize(e), '0' + a, six + ' no hint');
    });
    assert.strictEqual(products.normalize('04252614', 'upc_e'), '0042100005264');
    assert.strictEqual(products.expandUpcE('24252614'), null, 'number system 2 is not UPC-E');
    // A broken UPC-E check digit
    assert.throws(() => products.normalize('04252615', 'upc_e'), /valid barcode/);
  });

  await check('normalize: EAN-8 keeps its 8 digits (hint, or no hint and not a UPC-E); toKey keeps keys we gave out', () => {
    assert.strictEqual(products.normalize('96385074', 'ean_8'), '96385074');
    assert.strictEqual(products.normalize('96385074'), '96385074');
    assert.throws(() => products.normalize('96385075', 'ean_8'), /valid barcode/);
    const ean8zero = withCheck('0123456');
    assert.strictEqual(products.toKey(ean8zero, (k) => k === ean8zero), ean8zero, 'a stored EAN-8 key starting with 0 round-trips');
    assert.strictEqual(products.toKey(ean8zero), products.normalize(ean8zero), 'not stored: the same rule as normalize');
    assert.strictEqual(products.toKey('04252614'), products.normalize('04252614'));
    assert.strictEqual(products.toKey('96385074'), '96385074');
    assert.strictEqual(products.toKey(COLA_KEY), COLA_KEY);
    assert.strictEqual(products.toKey(COLA), COLA_KEY);
    assert.ok(products.isKey(COLA_KEY) && products.isKey('96385074') && !products.isKey(COLA) && !products.isKey('0036000291453'));
  });

  await check('lineName and searchText: brand not doubled, size not doubled, cut to 60', () => {
    assert.strictEqual(products.lineName({ brand: 'Fizz Co', name: 'Cola', size: '12 fl oz' }), 'Fizz Co Cola');
    assert.strictEqual(products.lineName({ brand: 'Fizz', name: 'Fizz Cola' }), 'Fizz Cola');
    assert.strictEqual(products.lineName({ brand: '', name: 'Bananas' }), 'Bananas');
    assert.strictEqual(products.lineName({ brand: 'B'.repeat(40), name: 'N'.repeat(80) }).length, 60);
    assert.strictEqual(products.searchText({ brand: 'Fizz Co', name: 'Cola', size: '12 fl oz' }), 'Fizz Co Cola 12 fl oz');
    assert.strictEqual(products.searchText({ brand: 'Fizz', name: 'Fizz Cola 2 L', size: '2 l' }), 'Fizz Cola 2 L');
    assert.strictEqual(products.searchText(null, 'Milk'), 'Milk');
  });

  /* ---------- addresses and pictures ---------- */

  await check('isPublicIp: private, loopback, link-local, Tailscale, multicast, mapped and reserved are refused', () => {
    ['10.0.0.1', '127.0.0.1', '172.16.5.4', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '192.0.2.1', '198.18.0.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', 'fd7a:115c:a1e0::5', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1', '::127.0.0.1', 'bogus', '']
      .forEach((a) => assert.strictEqual(products.isPublicIp(a), false, a));
    ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'].forEach((a) => assert.strictEqual(products.isPublicIp(a), true, a));
  });

  await check('imageUrlOk: https and a host name only (no address, port, login, local names)', () => {
    assert.ok(products.imageUrlOk('https://images.openfoodfacts.org/images/products/1.200.jpg'));
    ['http://images.openfoodfacts.org/a.jpg', 'https://93.184.216.34/a.jpg', 'https://[::1]/a.jpg', 'https://2130706433/a.jpg', 'https://0x7f000001/a.jpg',
      'https://user:pw@example.com/a.jpg', 'https://example.com:8443/a.jpg', 'https://localhost/a.jpg', 'https://pi.local/a.jpg', 'https://pi.tail1.ts.net/a.jpg',
      'https://intranet/a.jpg', 'file:///etc/passwd', 'ftp://example.com/a.jpg', 'javascript:alert(1)', 5, null, 'https://' + 'a'.repeat(2050) + '.com/']
      .forEach((u) => assert.strictEqual(products.imageUrlOk(u), null, String(u).slice(0, 60)));
  });

  await check('picture download: private DNS, a redirect, a wrong type, mismatched bytes and a large file are refused; the address is pinned', async () => {
    let seen = null;
    const web = fakeWeb({
      dns: { 'evil.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], 'meta.example': [{ address: '169.254.169.254', family: 4 }] },
      image: (u, o) => {
        seen = o;
        if (u.pathname === '/redirect.jpg') return { status: 302, headers: { location: 'http://10.0.0.1/' }, body: Buffer.alloc(0) };
        if (u.pathname === '/html.jpg') return { status: 200, headers: { 'content-type': 'text/html' }, body: jpeg() };
        if (u.pathname === '/liar.jpg') return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('<html>' + 'x'.repeat(60)) };
        if (u.pathname === '/big.jpg') return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg(401 * 1024) };
        if (u.pathname === '/pic.png') return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
        return goodImage();
      }
    });
    const c = catalogWith(web);
    for (const [url, code] of [['https://evil.example/a.jpg', 'PRIVATE'], ['https://meta.example/a.jpg', 'PRIVATE'], ['https://ok.example/redirect.jpg', 'STATUS'],
      ['https://ok.example/html.jpg', 'TYPE'], ['https://ok.example/liar.jpg', 'TYPE'], ['https://ok.example/big.jpg', 'TOO_LARGE'], ['http://ok.example/a.jpg', 'REFUSED']]) {
      await assert.rejects(c._downloadImage(url), (e) => e.code === code, url);
    }
    const ok = await c._downloadImage('https://ok.example/a.jpg');
    assert.strictEqual(ok.ext, 'jpg');
    assert.strictEqual(seen.address, '93.184.216.34', 'the connection goes to the checked address');
    assert.strictEqual(seen.maxBytes, 400 * 1024);
    assert.strictEqual((await c._downloadImage('https://ok.example/pic.png')).ext, 'png');
  });

  /* ---------- the catalog ---------- */

  await check('lookup: an Open Food Facts hit is saved with its thumbnail; the next scan uses the catalog only', async () => {
    const web = fakeWeb({ off: offHit(), image: goodImage });
    const c = catalogWith(web);
    let r = await c.lookup(COLA);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.upc, COLA_KEY);
    assert.strictEqual(r.found, true);
    const p = r.product;
    assert.deepStrictEqual(Object.keys(p).sort(), ['addedAt', 'brand', 'image', 'name', 'size', 'source', 'upc', 'updatedAt']);
    assert.strictEqual(p.brand, 'Fizz Co');
    assert.strictEqual(p.name, 'Cola');
    assert.strictEqual(p.size, '12 fl oz');
    assert.strictEqual(p.source, 'off');
    assert.ok(/^\/products\/image\/0036000291452\?v=[0-9a-z]+$/.test(p.image), p.image);
    assert.deepStrictEqual(web.calls, ['off', 'img:images.openfoodfacts.org']);
    assert.ok(fs.existsSync(path.join(c.dir, 'products', COLA_KEY + '.jpg')));
    const saved = JSON.parse(fs.readFileSync(path.join(c.dir, 'products.json'), 'utf8'));
    assert.strictEqual(saved.products[COLA_KEY].name, 'Cola');
    r = await c.lookup(COLA_KEY);
    assert.strictEqual(r.found, true);
    assert.strictEqual(web.calls.length, 2, 'no web call the second time');
    // A new catalog reads the file back.
    const again = products.createCatalog({ dataDir: c.dir, request: () => { throw new Error('no web'); } });
    assert.strictEqual(again.get(COLA_KEY).brand, 'Fizz Co');
    assert.ok(again.imageFile(COLA_KEY).file.endsWith(COLA_KEY + '.jpg'));
    assert.ok(!c.lines.some((l) => /Cola|Fizz|0036000291452|036000291452/.test(l)), 'a name or code in the log: ' + c.lines.join(' | '));
  });

  await check('lookup order: OFF misses -> OPF; both miss -> UPCitemdb (sent the 12-digit UPC-A, brand cut from the title)', async () => {
    let asked = '';
    const web = fakeWeb({
      opf: () => ({ status: 200, json: { status: 0 } }),
      upc: (u) => { asked = u.searchParams.get('upc'); return { status: 200, json: { code: 'OK', total: 1, items: [{ title: 'Fizz Co Dish Soap', brand: 'Fizz Co', size: '20 oz', images: ['https://shop.example/soap.jpg'] }] } }; },
      image: goodImage
    });
    const c = catalogWith(web);
    const r = await c.lookup(COLA);
    assert.deepStrictEqual(web.calls, ['off', 'opf', 'upc', 'img:shop.example']);
    assert.strictEqual(asked, COLA);
    assert.strictEqual(r.product.source, 'upcitemdb');
    assert.strictEqual(r.product.name, 'Dish Soap');
    assert.strictEqual(r.product.brand, 'Fizz Co');

    const web2 = fakeWeb({ opf: offHit({ product_name: 'Sponge', brands: 'Scrub' }), image: () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }) });
    const c2 = catalogWith(web2);
    const r2 = await c2.lookup(EAN13);
    assert.deepStrictEqual(web2.calls, ['off', 'opf', 'img:images.openfoodfacts.org']);
    assert.strictEqual(r2.product.source, 'opf');
    assert.strictEqual(r2.product.image, '', 'a picture that fails leaves no image');
  });

  await check('a source failing (throws, 500, bad JSON) never fails the lookup', async () => {
    const web = fakeWeb({
      off: () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); },
      opf: () => ({ status: 500, headers: {}, body: Buffer.from('nope') }),
      upc: () => ({ status: 200, json: { code: 'OK', total: 1, items: [{ title: 'Tea', brand: '', size: '' }] } })
    });
    const c = catalogWith(web);
    const r = await c.lookup(COLA);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.product.name, 'Tea');
    assert.ok(c.lines.some((l) => /off did not answer \(ECONNRESET\)/.test(l)));
  });

  await check('a miss is remembered for 24 hours (no web calls), then asked again; a miss after a failure is not remembered', async () => {
    const web = fakeWeb({});
    const c = catalogWith(web);
    let r = await c.lookup(COLA);
    assert.deepStrictEqual(r, { ok: true, upc: COLA_KEY, found: false, product: null });
    assert.strictEqual(web.calls.length, 3);
    await c.lookup(COLA);
    assert.strictEqual(web.calls.length, 3, 'remembered');
    c.tick(24 * 3600 * 1000 + 1);
    await c.lookup(COLA);
    assert.strictEqual(web.calls.length, 6, 'asked again after a day');

    const web2 = fakeWeb({ upc: () => { throw new Error('down'); } });
    const c2 = catalogWith(web2);
    await c2.lookup(COLA);
    await c2.lookup(COLA);
    assert.strictEqual(web2.calls.length, 6, 'not remembered when a source failed');
    assert.ok(!fs.existsSync(path.join(c2.dir, 'products.json')), 'a miss is never saved');
  });

  await check('rate limits: OFF and OPF 15 a minute, UPCitemdb 6 a minute and 100 a day; a full source is skipped', async () => {
    const web = fakeWeb({ off: () => ({ status: 200, json: { status: 0 } }), opf: () => ({ status: 200, json: { status: 0 } }) });
    const c = catalogWith(web);
    const codes = [];
    for (let i = 0; i < 20; i++) codes.push(withCheck('4006381' + String(100000 + i).slice(1)));
    for (const code of codes) await c.lookup(code);
    const count = (s) => web.calls.filter((x) => x === s).length;
    assert.strictEqual(count('off'), 15);
    assert.strictEqual(count('opf'), 15);
    assert.strictEqual(count('upc'), 6);
    c.tick(61000);
    const more = withCheck('400638199999');
    await c.lookup(more);
    assert.strictEqual(count('off'), 16, 'a new minute');
    // 100 a day for UPCitemdb.
    const lim = c._sources[2].lim;
    let n = lim.used();
    for (let m = 0; m < 30 && n < 100; m++) { c.tick(61000); for (let k = 0; k < 6 && n < 100; k++) { if (lim.take()) n++; } }
    assert.strictEqual(lim.used(), 100);
    c.tick(61000);
    assert.strictEqual(lim.take(), false, 'the day is used up');
    c.tick(24 * 3600 * 1000);
    assert.strictEqual(lim.take(), true, 'a day later');
  });

  await check('a 429 blocks that source (UPCitemdb EXCEED_LIMIT for a day); OFF and OPF saying no is still remembered with UPCitemdb skipped', async () => {
    const web = fakeWeb({ upc: () => ({ status: 429, json: { code: 'EXCEED_LIMIT' } }) });
    const c = catalogWith(web);
    await c.lookup(COLA);
    await c.lookup(EAN13);
    assert.deepStrictEqual(web.calls, ['off', 'opf', 'upc', 'off', 'opf']);
    assert.strictEqual(c._misses.size, 2, 'both remembered');
    await c.lookup(EAN13);
    assert.strictEqual(web.calls.length, 5, 'no web call for a remembered miss');
    const a = withCheck('400638100005');
    c.tick(3600 * 1000);
    await c.lookup(a);
    assert.strictEqual(web.calls.filter((x) => x === 'upc').length, 1, 'still blocked an hour later');
    c.tick(24 * 3600 * 1000);
    await c.lookup(withCheck('400638100006'));
    assert.strictEqual(web.calls.filter((x) => x === 'upc').length, 2);
    // OPF failing (not just skipped): not remembered.
    const web2 = fakeWeb({ opf: () => { throw new Error('down'); } });
    const c2 = catalogWith(web2);
    await c2.lookup(COLA);
    assert.strictEqual(c2._misses.size, 0);
  });

  await check('a hit with no brand or picture borrows them from the next source; a missing brand stays empty when nobody has one', async () => {
    const web = fakeWeb({
      off: offHit({ brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' }),
      upc: () => ({ status: 200, json: { code: 'OK', items: [{ title: 'Fizz Co Cola', brand: 'Fizz Co', size: '12 oz', images: ['https://pics.example/a.jpg'] }] } }),
      image: goodImage
    });
    const c = catalogWith(web);
    const r = await c.lookup(COLA);
    assert.strictEqual(r.product.brand, 'Fizz Co');
    assert.strictEqual(r.product.source, 'off', 'the first source that answered stays the source');
    assert.ok(r.product.image, 'the borrowed picture was saved');
    assert.ok(c.lines.some((l) => /brand, picture/.test(l)), 'the log says brand and picture, no names');
    const bare = fakeWeb({ off: offHit({ brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' }) });
    const c2 = catalogWith(bare);
    const r2 = await c2.lookup(COLA);
    assert.strictEqual(r2.product.brand, '');
    assert.ok(c2.lines.some((l) => /no brand, no picture/.test(l)));
  });

  await check('a hit with no brand from a store house-brand prefix gets that brand; a source brand still wins', async () => {
    const bare = { brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' };
    const c = catalogWith(fakeWeb({ off: offHit(Object.assign({ product_name: 'No pulp 100% premium orange juice' }, bare)) }));
    const r = await c.lookup('021130095261');
    assert.strictEqual(r.product.brand, 'Signature Select');
    const c2 = catalogWith(fakeWeb({ off: offHit({ product_name: 'Juice', brands: 'Tropicana' }) }));
    assert.strictEqual((await c2.lookup('021130095261')).product.brand, 'Tropicana');
  });

  await check('one time budget per lookup: a hanging source ends the lookup in time and the rest are skipped; DNS has its own short limit; a picture that fails is followed by the next one', async () => {
    const web = fakeWeb({ off: () => new Promise(() => {}) });
    const c = catalogWith(web, { budgetMs: 400 });
    const t0 = Date.now();
    const r = await c.lookup(COLA);
    assert.strictEqual(r.found, false);
    assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + ' ms');
    assert.deepStrictEqual(web.calls, ['off'], 'no time left for the others');
    assert.strictEqual(c._misses.size, 0, 'a timeout is not a miss');
    // A second lookup queued behind the hanging one also ends in time.
    const t1 = Date.now();
    await c.lookup(EAN13);
    assert.ok(Date.now() - t1 < 1500);

    const slowDns = fakeWeb({});
    const c2 = catalogWith({ calls: [], request: slowDns.request, resolve: () => new Promise(() => {}) }, { dnsMs: 200 });
    const t2 = Date.now();
    await assert.rejects(c2._downloadImage('https://ok.example/a.jpg'), (e) => e.code === 'DNS_TIMEOUT');
    assert.ok(Date.now() - t2 < 1000);

    const web3 = fakeWeb({ upc: () => ({ status: 200, json: { code: 'OK', items: [{ title: 'Tea', images: ['https://a.example/1.jpg', 'https://b.example/2.jpg'] }] } }), image: () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }) });
    const c3 = catalogWith(web3);
    const r3 = await c3.lookup(COLA);
    assert.strictEqual(r3.found, true);
    assert.deepStrictEqual(web3.calls.filter((x) => /^img:/.test(x)), ['img:a.example', 'img:b.example'], 'the next picture is tried when the first fails');
  });

  await check('a rescan fills in a saved web item missing its brand and picture, once per 6 hours; its name and source stay', async () => {
    let brand = '';
    let pic = '';
    const web = fakeWeb({ off: () => offHit({ brands: brand, image_front_small_url: pic })(), image: goodImage });
    const c = catalogWith(web);
    const first = await c.lookup(COLA);
    assert.strictEqual(first.product.brand, '');
    assert.strictEqual(first.product.image, '');
    // The sources gain a brand and a picture; the next scan picks them up.
    brand = 'Fizz Co'; pic = 'https://images.openfoodfacts.org/x/front.200.jpg';
    c.tick(1000);
    const offCalls = web.calls.filter((x) => x === 'off').length;
    const again = await c.lookup(COLA);
    assert.strictEqual(again.found, true);
    assert.strictEqual(again.product.brand, 'Fizz Co');
    assert.ok(again.product.image && c.imageFile(COLA_KEY), 'the picture was saved');
    assert.strictEqual(again.product.name, first.product.name);
    assert.strictEqual(again.product.source, 'off');
    assert.strictEqual(again.product.addedAt, first.product.addedAt);
    assert.strictEqual(web.calls.filter((x) => x === 'off').length, offCalls + 1);
    assert.ok(c.lines.some((l) => /looked up again \(added brand and picture/.test(l)), c.lines.join(' | '));
    // Complete now: further scans are free.
    const n = web.calls.length;
    await c.lookup(COLA);
    assert.strictEqual(web.calls.length, n);
    // Still bare on the web: one more look, then none for 6 hours.
    const bare = fakeWeb({ off: offHit({ brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' }) });
    const c2 = catalogWith(bare);
    await c2.lookup(COLA);
    await c2.lookup(COLA);
    const looked = bare.calls.length;
    await c2.lookup(COLA);
    assert.strictEqual(bare.calls.length, looked, 'throttled');
    c2.tick(6 * 60 * 60 * 1000 + 1);
    await c2.lookup(COLA);
    assert.ok(bare.calls.length > looked, 'looked again after 6 hours');
    assert.ok(c2.lines.some((l) => /looked up again \(nothing new; no brand, no picture/.test(l)));
    // Gone from the web on a refill: the saved item stays as it was.
    const gone = fakeWeb({ off: offHit({ brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' }) });
    const c3 = catalogWith(gone);
    const kept = await c3.lookup(COLA);
    const goneWeb = fakeWeb({});
    const c4 = products.createCatalog({ dataDir: c3.dir, log: () => {}, request: goneWeb.request, resolve: goneWeb.resolve, now: () => 5000000 });
    const r4 = await c4.lookup(COLA);
    assert.strictEqual(r4.found, true);
    assert.strictEqual(r4.product.name, kept.product.name);
    assert.strictEqual(c4._misses.size, 0, 'not a miss: it is in the catalog');
  });

  await check('a rescan never looks again for a manual item or one already complete; a hand-edited brand and photo stick', async () => {
    const web = fakeWeb({ off: offHit({ brands: '', image_front_small_url: '', image_small_url: '', image_front_url: '' }) });
    const c = catalogWith(web);
    await c.lookup(COLA);
    c.save({ upc: COLA_KEY, brand: 'Mine', name: 'My cola', photo: 'data:image/jpeg;base64,' + jpeg(2000).toString('base64') });
    const n = web.calls.length;
    c.tick(7 * 60 * 60 * 1000);
    const r = await c.lookup(COLA);
    assert.strictEqual(web.calls.length, n, 'no web call');
    assert.strictEqual(r.product.brand, 'Mine');
    assert.strictEqual(r.product.source, 'manual');
    assert.ok(r.product.image);
    // A manual name with no brand stays manual too.
    c.save({ upc: EAN13, name: 'Plain bread' });
    await c.lookup(EAN13);
    assert.strictEqual(web.calls.length, n);
  });

  await check('per-phone cap on web lookups (429), catalog hits and remembered misses stay free', async () => {
    const web = fakeWeb({});
    const c = catalogWith(web, { clientPerMin: 2 });
    await c.lookup(withCheck('400638100011'), '', { client: '100.70.0.9' });
    await c.lookup(withCheck('400638100012'), '', { client: '100.70.0.9' });
    assert.throws(() => c.lookup(withCheck('400638100013'), '', { client: '100.70.0.9' }), (e) => e.status === 429);
    const again = await c.lookup(withCheck('400638100011'), '', { client: '100.70.0.9' });
    assert.strictEqual(again.found, false, 'a remembered miss is free');
    await c.lookup(withCheck('400638100013'), '', { client: '192.168.1.5' });
    c.tick(61000);
    await c.lookup(withCheck('400638100014'), '', { client: '100.70.0.9' });
  });

  await check('requests carry the generic User-Agent only; two scans of one code at once make one web lookup', async () => {
    let gate;
    const wait = new Promise((r) => { gate = r; });
    const web = fakeWeb({ off: async () => { await wait; return offHit()(); } });
    const c = catalogWith(web);
    const a = c.lookup(COLA);
    const b = c.lookup(COLA_KEY);
    gate();
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra.product, rb.product);
    assert.strictEqual(web.calls.filter((x) => x === 'off').length, 1);
    assert.strictEqual(products.USER_AGENT, 'HomeHub/1.0 (personal home dashboard)');
    assert.ok(!/@/.test(products.USER_AGENT));
  });

  await check('manual entries win: never overwritten by a web lookup, even one already on its way', async () => {
    let c;
    const web = fakeWeb({
      off: () => {
        c.save({ upc: COLA_KEY, brand: 'Mine', name: 'My cola' });
        return offHit()();
      }
    });
    c = catalogWith(web);
    const r = await c.lookup(COLA);
    assert.strictEqual(r.product.source, 'manual');
    assert.strictEqual(r.product.name, 'My cola');
    assert.strictEqual(c.get(COLA_KEY).brand, 'Mine');
    const web2 = fakeWeb({ off: offHit(), image: goodImage });
    const c2 = catalogWith(web2);
    c2.save({ upc: EAN13, brand: 'Shop', name: 'Bread', size: '1 loaf' });
    const r2 = await c2.lookup(EAN13);
    assert.strictEqual(r2.product.source, 'manual');
    assert.deepStrictEqual(web2.calls, []);
    // A manual save replaces a web product and clears a remembered miss.
    await c2.lookup(COLA);
    c2.save({ upc: COLA_KEY, name: 'Cola, corrected' });
    assert.strictEqual(c2.get(COLA_KEY).source, 'manual');
    assert.ok(c2.get(COLA_KEY).image, 'keeps the web picture when no photo is sent');
  });

  await check('save: checks the code, text and photo (data:image/jpeg, JPEG bytes, at most 150 KB); text is cleaned and cut', () => {
    const c = catalogWith(fakeWeb({}));
    const cases = [
      [{ upc: '123', name: 'x' }, /valid barcode/], [{ upc: COLA_KEY }, /"name" must not be empty/], [{ upc: COLA_KEY, name: '  \u0007 ' }, /must not be empty/],
      [{ upc: COLA_KEY, name: 5 }, /"name" must be text/], [{ upc: COLA_KEY, name: 'x', brand: [] }, /"brand" must be text/],
      [{ upc: COLA_KEY, name: 'x', photo: 'https://example.com/a.jpg' }, /data:image\/jpeg/], [{ upc: COLA_KEY, name: 'x', photo: 'data:image/png;base64,' + PNG.toString('base64') }, /data:image\/jpeg/],
      [{ upc: COLA_KEY, name: 'x', photo: 'data:image/jpeg;base64,' + PNG.toString('base64') }, /not a JPEG/],
      [{ upc: COLA_KEY, name: 'x', photo: 'data:image/jpeg;base64,' + jpeg(151 * 1024).toString('base64') }, /too large/],
      [{ upc: COLA_KEY, name: 'x', photo: 'data:image/jpeg;base64,<script>' }, /data:image\/jpeg/], ['nope', /JSON object/]
    ];
    cases.forEach(([b, re]) => assert.throws(() => c.save(b), (e) => e.status === 400 && re.test(e.message), JSON.stringify(b).slice(0, 80)));
    assert.strictEqual(c.size(), 0);
    const p = c.save({ upc: COLA, brand: ' Big\u0000 Brand ' + 'b'.repeat(60), name: 'Line\nbreak  name', size: '2\tL', photo: 'data:image/jpeg;base64,' + jpeg(2000).toString('base64') });
    assert.strictEqual(p.upc, COLA_KEY);
    assert.strictEqual(p.brand.length, 40);
    assert.strictEqual(p.name, 'Line break name');
    assert.strictEqual(p.size, '2 L');
    assert.strictEqual(p.source, 'manual');
    assert.ok(p.image);
    assert.deepStrictEqual(fs.readFileSync(c.imageFile(COLA_KEY).file), jpeg(2000));
  });

  await check('the catalog holds at most its limit: the oldest web product goes, manual ones stay', async () => {
    const web = fakeWeb({ off: offHit({ image_front_small_url: '' }) });
    const c = catalogWith(web, { maxProducts: 3 });
    c.save({ upc: EAN13, name: 'Mine' });
    c.tick(1);
    await c.lookup(COLA);
    c.tick(1);
    const a = withCheck('400638100001');
    const b = withCheck('400638100002');
    await c.lookup(a);
    c.tick(1);
    await c.lookup(b);
    assert.strictEqual(c.size(), 3);
    assert.strictEqual(c.get(COLA_KEY), null, 'the oldest web product went');
    assert.ok(c.get(EAN13) && c.get(a) && c.get(b));
    // Products on the grocery list are never dropped.
    const k = catalogWith(fakeWeb({ off: offHit({ image_front_small_url: '' }) }), { maxProducts: 2, keep: () => [COLA_KEY] });
    await k.lookup(COLA);
    k.tick(1);
    await k.lookup(a);
    k.tick(1);
    await k.lookup(b);
    assert.ok(k.get(COLA_KEY), 'on the list: kept although oldest');
    assert.strictEqual(k.get(a), null);
    const full = catalogWith(fakeWeb({}), { maxProducts: 1 });
    full.save({ upc: EAN13, name: 'One' });
    assert.throws(() => full.save({ upc: COLA, name: 'Two' }), /catalog is full/);
  });

  await check('a damaged catalog file starts empty; bad entries are dropped', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'products.json'), '{not json');
    const lines = [];
    assert.strictEqual(products.createCatalog({ dataDir: dir, log: (s) => lines.push(s) }).size(), 0);
    assert.ok(lines.some((l) => /could not be read/.test(l)));
    fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({ v: 1, products: {
      [COLA_KEY]: { upc: COLA_KEY, brand: 'A', name: 'B', source: 'weird', extra: 1 },
      '../x': { upc: '../x', name: 'evil' }, [EAN13]: { upc: COLA_KEY, name: 'wrong key' }, '96385074': { upc: '96385074' }
    } }));
    const c = products.createCatalog({ dataDir: dir });
    assert.strictEqual(c.size(), 1);
    assert.strictEqual(c.get(COLA_KEY).source, 'manual');
    assert.strictEqual(c.get(COLA_KEY).extra, undefined);
  });

  await check('exportList: one row per item with product fields, search text and picture path; ticked included', () => {
    const items = [
      { id: 'g1', name: 'Fizz Co Cola', done: false, addedAt: 5, upc: COLA_KEY },
      { id: 'g2', name: 'Bananas', done: true, addedAt: 6, upc: '' }
    ];
    const prod = { upc: COLA_KEY, brand: 'Fizz Co', name: 'Cola', size: '12 fl oz', source: 'off', image: '/products/image/x', addedAt: 1, updatedAt: 1 };
    const r = products.exportList(items, (k) => (k === COLA_KEY ? prod : null), Date.UTC(2026, 10, 20));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.generatedAt, '2026-11-20T00:00:00.000Z');
    assert.deepStrictEqual(r.counts, { left: 1, ticked: 1 });
    assert.deepStrictEqual(r.items[0], { id: 'g1', name: 'Fizz Co Cola', done: false, addedAt: 5, upc: COLA_KEY, brand: 'Fizz Co', productName: 'Cola', size: '12 fl oz', source: 'off', imagePath: '/api/products/image?upc=' + COLA_KEY, search: 'Fizz Co Cola 12 fl oz' });
    assert.deepStrictEqual(r.items[1], { id: 'g2', name: 'Bananas', done: true, addedAt: 6, upc: '', brand: '', productName: '', size: '', source: '', imagePath: '', search: 'Bananas' });
  });

  /* ---------- grocery adds by upc (grocery.js) ---------- */

  await check('grocery add with a upc: no double, a ticked one comes back, a same-name item gets the upc, another product gets its own row', () => {
    let l = grocery.applyOps([], [{ op: 'add', name: 'Fizz Co Cola', upc: COLA_KEY }], 1);
    assert.strictEqual(l[0].upc, COLA_KEY);
    l = grocery.applyOps(l, [{ op: 'add', name: 'Something else', upc: COLA_KEY }], 2);
    assert.strictEqual(l.length, 1, 'the same upc is not doubled');
    l = grocery.applyOps(l, [{ op: 'check', id: l[0].id, done: true }], 3);
    l = grocery.applyOps(l, [{ op: 'add', name: 'Fizz Co Cola', upc: COLA_KEY }], 4);
    assert.strictEqual(l[0].done, false, 'ticked comes back');
    l = grocery.applyOps(l, [{ op: 'add', name: 'Bread' }, { op: 'add', name: 'bread', upc: EAN13 }], 5);
    assert.strictEqual(l.length, 2);
    assert.strictEqual(l.find((i) => i.name === 'Bread').upc, EAN13, 'the upc is attached');
    l = grocery.applyOps(l, [{ op: 'add', name: 'Bread', upc: '96385074' }], 6);
    assert.strictEqual(l.length, 3, 'a different product with the same name gets its own row');
    l = grocery.applyOps(l, [{ op: 'add', name: 'Milk' }], 7);
    assert.strictEqual(l[0].upc, '', 'a typed item has an empty upc');
    assert.throws(() => grocery.applyOps(l, [{ op: 'add', name: 'x', upc: '12ab' }], 8), (e) => e.status === 400 && /upc/.test(e.message));
    assert.throws(() => grocery.applyOps(l, [{ op: 'add', name: 'x', upc: 123 }], 8), /upc/);
    const r = grocery.cleanResource({ data: { items: [{ id: 'a', name: 'Old' }, { id: 'b', name: 'Bad', upc: '../1' }, { id: 'c', name: 'Ok', upc: COLA_KEY }] } });
    assert.deepStrictEqual(r.data.items.map((i) => i.upc), ['', '', COLA_KEY], 'older items without upc stay valid');
  });

  /* ---------- the server ---------- */

  const web = fakeWeb({
    off: (u) => (u.pathname.indexOf(COLA_KEY) >= 0 ? offHit()() : { status: 404, json: { status: 0 } }),
    image: goodImage
  });
  const lines = [];
  const dataDir = tmp();
  const h = await hubServer.start({
    port: 0, token: TOKEN, dataDir: dataDir, log: (s) => lines.push(String(s)),
    clientAddress: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress,
    products: { request: web.request, resolve: web.resolve }
  }).ready;
  const P = h.port;

  await check('GET /products/lookup: found, not found, a bad code 400; only home and Tailscale addresses; foreign Origin refused', async () => {
    const T = { 'X-Hub-Touch': '1' };
    let r = await request(P, 'GET', '/products/lookup?upc=' + COLA + '&format=upc_a', { headers: { 'x-test-ip': '100.70.0.9', 'X-Hub-Touch': '1' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.found, true);
    assert.strictEqual(r.json.upc, COLA_KEY);
    assert.strictEqual(r.json.product.name, 'Cola');
    r = await request(P, 'GET', '/products/lookup?upc=' + EAN13, { headers: T });
    assert.deepStrictEqual(r.json, { ok: true, upc: EAN13, found: false, product: null });
    // Proof it comes from the app's own page: no Origin and no header is refused.
    r = await request(P, 'GET', '/products/lookup?upc=' + COLA);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'origin not allowed');
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { 'X-Hub-Touch': '0' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { Origin: 'https://pi.tail1234.ts.net', Host: 'pi.tail1234.ts.net' } })).status, 200);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { Origin: 'http://evil.example', Host: '192.168.1.2:8097', 'X-Hub-Touch': '1' } })).status, 403);
    r = await request(P, 'GET', '/products/lookup?upc=12345', { headers: T });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, "that isn't a valid barcode number");
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { Host: 'evil.example' } })).status, 403);
    assert.strictEqual((await request(P, 'GET', '/products/lookup?upc=' + COLA, { headers: { Origin: 'http://evil.example', Host: '192.168.1.2:8097' } })).status, 403);
    assert.strictEqual((await request(P, 'POST', '/products/lookup?upc=' + COLA)).status, 405);
  });

  await check('GET /products/image/<upc>: the saved picture (image/jpeg, long cache); missing 404; path tricks 404', async () => {
    let r = await request(P, 'GET', '/products/image/' + COLA_KEY);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    assert.ok(/max-age=\d{6,}/.test(r.headers['cache-control']), r.headers['cache-control']);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.deepStrictEqual(r.buf, jpeg(500));
    r = await request(P, 'GET', '/products/image/' + COLA + '?v=abc');
    assert.strictEqual(r.status, 200, 'a UPC-A finds its key; the ?v= is ignored');
    assert.strictEqual((await request(P, 'HEAD', '/products/image/' + COLA_KEY)).status, 200);
    const tries = ['/products/image/' + EAN13, '/products/image/0036000291453', '/products/image/..%2f..%2fstate.json', '/products/image/../state.json',
      '/products/image/%2e%2e', '/products/image/' + COLA_KEY + '.jpg', '/products/image/' + COLA_KEY + '%00', '/products/image/%2fetc%2fpasswd',
      '/products/image/' + COLA_KEY + '/x', '/products/image/abc', '/products/image/%E0%A4%A'];
    for (const p of tries) {
      r = await request(P, 'GET', p);
      assert.ok(r.status === 404 || r.status === 400, p + ' -> ' + r.status);
      assert.ok(!/"rev"|HUB_TOKEN/.test(r.text), p + ' leaked');
    }
    assert.strictEqual((await request(P, 'GET', '/products/image/' + COLA_KEY, { headers: { 'x-test-ip': '8.8.8.8' } })).status, 403);
    assert.strictEqual((await request(P, 'POST', '/products/image/' + COLA_KEY)).status, 405);
  });

  await check('POST /products/save: a manual product with a photo; body limit; Origin rule', async () => {
    const photo = 'data:image/jpeg;base64,' + jpeg(100 * 1024).toString('base64');
    let r = await request(P, 'POST', '/products/save', { headers: { 'x-test-ip': '192.168.1.40' }, body: { upc: EAN13, brand: 'Corner', name: 'Sourdough', size: '1 loaf', photo: photo } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.product.source, 'manual');
    assert.ok(r.json.product.image.indexOf('/products/image/' + EAN13) === 0);
    r = await request(P, 'GET', '/products/lookup?upc=' + EAN13, { headers: { 'X-Hub-Touch': '1' } });
    assert.strictEqual(r.json.found, true, 'the remembered miss is forgotten');
    assert.strictEqual((await request(P, 'GET', '/products/image/' + EAN13)).buf.length, 100 * 1024);
    r = await request(P, 'POST', '/products/save', { body: { upc: EAN13, name: 'x', photo: 'data:image/jpeg;base64,' + jpeg(230 * 1024).toString('base64') } });
    assert.strictEqual(r.status, 413);
    r = await request(P, 'POST', '/products/save', { body: { upc: '1', name: 'x' } });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'POST', '/products/save', { headers: { Origin: 'http://evil.example', Host: '192.168.1.2:8097' }, body: { upc: EAN13, name: 'x' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await request(P, 'GET', '/products/save')).status, 405);
  });

  await check('grocery ops by upc: the name comes from the catalog; unknown code 400; /touch/state carries those products', async () => {
    let r = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', upc: COLA }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.items[0].name, 'Fizz Co Cola');
    assert.strictEqual(r.json.items[0].upc, COLA_KEY);
    r = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', upc: COLA_KEY }] } });
    assert.strictEqual(r.json.changed, false, 'no double');
    r = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', name: 'Bread', upc: EAN13 }, { op: 'add', name: 'Milk' }] } });
    assert.strictEqual(r.json.items.length, 3);
    r = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', upc: withCheck('400638100009') }] } });
    assert.strictEqual(r.status, 400);
    assert.ok(/isn't in the product catalog/.test(r.json.error));
    r = await request(P, 'POST', '/grocery/ops', { body: { ops: [{ op: 'add', upc: '0036000291453' }] } });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'GET', '/touch/state', { headers: { 'x-test-ip': '100.70.0.9' } });
    assert.deepStrictEqual(Object.keys(r.json.products).sort(), [COLA_KEY, EAN13].sort());
    assert.strictEqual(r.json.products[EAN13].name, 'Sourdough');
    assert.strictEqual(r.json.grocery.data.items.length, 3);
    // A fix typed later renames the rows for that code ("Brand Name"), so the TV tile shows it.
    r = await request(P, 'POST', '/products/save', { body: { upc: EAN13, brand: 'Baker Bros', name: 'Rye', size: '1 loaf' } });
    assert.strictEqual(r.status, 200, r.text);
    r = await request(P, 'GET', '/touch/state', { headers: { 'x-test-ip': '100.70.0.9' } });
    const bread = r.json.grocery.data.items.find((i) => i.upc === EAN13);
    assert.strictEqual(bread.name, 'Baker Bros Rye');
    assert.strictEqual(r.json.grocery.data.items.length, 3);
  });

  await check('control API: /api/products, /api/products/image and /api/grocery/export need the token', async () => {
    for (const p of ['/api/products?upc=' + COLA, '/api/products/image?upc=' + COLA_KEY, '/api/grocery/export']) {
      assert.strictEqual((await request(P, 'GET', p)).status, 401, p);
    }
    let r = await request(P, 'GET', '/api/products?upc=' + COLA, { token: TOKEN });
    assert.strictEqual(r.json.found, true);
    assert.strictEqual(r.json.product.brand, 'Fizz Co');
    r = await request(P, 'GET', '/api/products?upc=nope', { token: TOKEN });
    assert.strictEqual(r.status, 400);
    r = await request(P, 'GET', '/api/products/image?upc=' + COLA_KEY, { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/jpeg');
    assert.deepStrictEqual(r.buf, jpeg(500));
    assert.strictEqual((await request(P, 'GET', '/api/products/image?upc=../state.json', { token: TOKEN })).status, 404);
    assert.strictEqual((await request(P, 'GET', '/api/products/image?upc=' + withCheck('400638100009'), { token: TOKEN })).status, 404);
    r = await request(P, 'GET', '/api/grocery/export', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['counts', 'generatedAt', 'items', 'ok']);
    assert.deepStrictEqual(r.json.counts, { left: 3, ticked: 0 });
    const cola = r.json.items.find((i) => i.upc === COLA_KEY);
    assert.strictEqual(cola.search, 'Fizz Co Cola 12 fl oz');
    assert.strictEqual(cola.imagePath, '/api/products/image?upc=' + COLA_KEY);
    assert.strictEqual(r.json.items.find((i) => i.name === 'Milk').search, 'Milk');
    assert.strictEqual((await request(P, 'POST', '/api/grocery/export', { token: TOKEN, body: {} })).status, 405);
    // Through the same api() the mailbox uses.
    const viaApi = await h.api('GET', '/api/grocery/export');
    assert.strictEqual(viaApi.body.items.length, 3);
  });

  await check('the app folder serves .wasm as application/wasm', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'vendor'));
    fs.writeFileSync(path.join(dir, 'vendor', 'x.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
    const h2 = await hubServer.start({ port: 0, token: TOKEN, dataDir: tmp(), log: false, appDir: dir, products: { web: false } }).ready;
    const r = await request(h2.port, 'GET', '/app/vendor/x.wasm');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'application/wasm');
    await new Promise((res) => h2.close(res));
  });

  await check('the log names no product, brand or code', async () => {
    const all = lines.join('\n');
    assert.ok(!/Cola|Fizz|Sourdough|Corner|Bread|Milk|0036000291452|036000291452|4006381333931/.test(all), all.split('\n').filter((l) => /Cola|Fizz|Sourdough|Corner|Bread|Milk|0036|4006/.test(l)).join(' | '));
    assert.ok(/products: found on off/.test(all));
  });

  await new Promise((r) => h.close(r));
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
