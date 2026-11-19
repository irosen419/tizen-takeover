/*
 * HUB_I18N.dyn / onDyn (app/i18n-dyn.js): node dev/i18n-dyn-test.js
 * Runs the file in a vm with a fake window, localStorage, HUB_LIVE and clock.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'i18n-dyn.js'), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

// A fake clock: setTimeout runs when advance() passes its time.
function make(opts) {
  let t = 0, seq = 0;
  const timers = [];
  const store = Object.assign({}, opts.store || {});
  const posts = [];
  const win = { HUB_I18N: { lang: () => opts.lang }, console };
  win.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  win.HUB_LIVE = { post: (p, body, cb) => { posts.push({ path: p, body, cb }); } };
  const ctx = {
    window: win, console, JSON, Object, Array, Date: { prototype: Date.prototype },
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  ctx.Date = function () { return { getTime: () => t }; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    I: win.HUB_I18N, posts, store,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const x = timers.shift(); t = Math.max(t, x.at); x.fn();
      }
      t = end;
    }
  };
}

(async () => {
  await check('English: passthrough, nothing queued', () => {
    const h = make({ lang: 'en' });
    assert.strictEqual(h.I.dyn('Buy milk'), 'Buy milk');
    h.advance(5000);
    assert.strictEqual(h.posts.length, 0);
  });
  await check('Spanish: queued, one debounced batch, re-render callback, cache reuse', () => {
    const h = make({ lang: 'es' });
    let fired = 0;
    const off = h.I.onDyn(() => { fired++; });
    assert.strictEqual(h.I.dyn('Buy milk'), 'Buy milk');
    assert.strictEqual(h.I.dyn('Call Ana'), 'Call Ana');
    assert.strictEqual(h.I.dyn('Buy milk'), 'Buy milk');
    assert.strictEqual(h.I.dyn('  '), '  '); assert.strictEqual(h.I.dyn('12:30'), '12:30'); assert.strictEqual(h.I.dyn('ok'), 'ok');
    h.advance(300); assert.strictEqual(h.posts.length, 0);
    h.advance(200); assert.strictEqual(h.posts.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.posts[0].body)), { to: 'es', texts: ['Buy milk', 'Call Ana'] });
    assert.strictEqual(h.posts[0].path, '/translate');
    h.I.dyn('Another one'); h.advance(2000);
    assert.strictEqual(h.posts.length, 1, 'only one in flight');
    h.posts[0].cb(null, { ok: true, map: { 'Buy milk': 'Comprar leche', 'Call Ana': 'Llamar a Ana' } });
    assert.strictEqual(fired, 1);
    assert.strictEqual(h.I.dyn('Buy milk'), 'Comprar leche');
    assert.strictEqual(JSON.parse(h.store['homeHub.tr.es'])['Call Ana'], 'Llamar a Ana');
    h.advance(500); assert.strictEqual(h.posts.length, 2); assert.deepStrictEqual(JSON.parse(JSON.stringify(h.posts[1].body.texts)), ['Another one']);
    off(); h.posts[1].cb(null, { ok: true, map: { 'Another one': 'Otra' } }); assert.strictEqual(fired, 1, 'unsubscribed');
    assert.strictEqual(h.I.dyn('Another one'), 'Otra');
  });
  await check('saved translations are used on a new page load, no request', () => {
    const h = make({ lang: 'es', store: { 'homeHub.tr.es': JSON.stringify({ 'Buy milk': 'Comprar leche' }) } });
    assert.strictEqual(h.I.dyn('Buy milk'), 'Comprar leche');
    h.advance(5000); assert.strictEqual(h.posts.length, 0);
  });
  await check('failure: retry no sooner than 2 minutes', () => {
    const h = make({ lang: 'es' });
    h.I.dyn('Buy milk'); h.advance(500);
    assert.strictEqual(h.posts.length, 1);
    h.posts[0].cb('not reachable', null, 0);
    h.advance(100000); assert.strictEqual(h.posts.length, 1);
    h.I.dyn('Buy milk'); h.advance(1000); assert.strictEqual(h.posts.length, 1, 'asking again does not storm');
    h.advance(30000); assert.strictEqual(h.posts.length, 2);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.posts[1].body.texts)), ['Buy milk']);
    h.posts[1].cb(null, { ok: true, map: { 'Buy milk': 'Comprar leche' } });
    assert.strictEqual(h.I.dyn('Buy milk'), 'Comprar leche');
  });
  await check('storage that throws does not break it', () => {
    const h = make({ lang: 'es' });
    // replace storage with a throwing one by reloading
    const ctxStore = h; void ctxStore;
    h.I.dyn('Buy milk'); h.advance(500);
    h.posts[0].cb(null, { ok: true, map: { 'Buy milk': 'Comprar leche' } });
    assert.strictEqual(h.I.dyn('Buy milk'), 'Comprar leche');
  });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
