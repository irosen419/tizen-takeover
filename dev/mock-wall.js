/*
 * A pretend WLED controller for the plant wall, for the Moods tests
 * (pi/moods-test.js, pi/moods/controller.js) and the Moods screenshots. It
 * answers the calls Moods makes, and records every one:
 *
 *   GET  /json/state      the state (on, bri, transition, ps, seg)
 *   POST /json/state      a change: on, bri, ps (preset 1 or 2 puts the live
 *                         segments back), seg entries merged by id ({ id, stop: 0 }
 *                         deletes one); answers { success: true }
 *   GET  /json/effects    effect names (index = id), from pi/moods/moods.json's fx table
 *   GET  /json/palettes   palette names, the same way
 *   GET  /json/info       { ver, leds: { count, maxpwr, maxseg, pwr }, ... }
 *   GET  /json/cfg        { hw: { led: { maxpwr, ledma } }, light: { gc: { bri, col, val } }, if: { live: { en } } }
 *
 *   const w = await require('./mock-wall').start();
 *   w.url                 'http://127.0.0.1:PORT' (loopback only)
 *   w.calls               [{ method, path, body }] every call seen, in order
 *   w.posts()             the bodies POSTed to /json/state, in order
 *   w.state()             a copy of the state as it stands
 *   w.mode(m)             ok | down (drops connections) | slow (never answers) |
 *                         refuse (400 to every POST) | broken (not JSON) |
 *                         failAfter:N (POSTs after the first N answer 500)
 *   w.effects(fn)         change the effect list: fn(names) returns the new list
 *                         (move an id, drop the mic effects)
 *   w.set(fields)         change the state behind the hub's back ({ on, bri })
 *   w.presetLag(ms)       like a real WLED: a POST that selects preset 1 or 2 answers
 *                         at once, and the preset lands ms later, bringing its own
 *                         on and bri (state.ps changes only then). 0 (the default):
 *                         at once, keeping the brightness
 *   w.gamma(v)            the colour gamma /json/cfg reports as light.gc.col
 *                         (default 2.8; null leaves light out of cfg)
 *   w.reset()             all ok, preset 2 on, the calls forgotten
 *   w.close()
 *
 * Nothing here reaches a real wall: it listens on 127.0.0.1 only.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pi', 'moods', 'moods.json'), 'utf8'));
const LIVE = [{ id: 0, start: 0, stop: 50 }, { id: 1, start: 50, stop: 112 }, { id: 2, start: 112, stop: 162 }];

function names(table, count, prefix) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(prefix + ' ' + i);
  Object.keys(table).forEach((k) => { out[table[k].id] = table[k].name; });
  return out;
}

function liveState() {
  return {
    on: true, bri: 128, transition: 7, ps: 2, pl: -1,
    seg: LIVE.map((s) => ({ id: s.id, start: s.start, stop: s.stop, on: true, bri: 255, fx: 0, sx: 40, ix: 128, pal: 10, col: [[0, 100, 0], [0, 0, 0], [0, 0, 0]] }))
  };
}

function start(opts) {
  const o = opts || {};
  let state = liveState();
  let mode = 'ok';
  let posts = 0;
  let effects = names(CATALOG.fx, 190, 'FX');
  const palettes = names(CATALOG.pals, 72, 'Pal');
  const calls = [];
  const hanging = new Set();
  let lag = 0;
  let gamma = 2.8;
  const lagTimers = new Set();

  function send(res, status, body) {
    const text = mode === 'broken' ? 'not json' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function apply(b) {
    if (Number.isInteger(b.ps) && (b.ps === 1 || b.ps === 2) && lag > 0) {
      // The preset lands later, with its own on and bri, over whatever came meanwhile.
      const ps = b.ps;
      const t = setTimeout(() => { lagTimers.delete(t); state = liveState(); state.ps = ps; }, lag);
      lagTimers.add(t);
      b = Object.assign({}, b);
      delete b.on;
      delete b.ps;
    } else if (Number.isInteger(b.ps) && (b.ps === 1 || b.ps === 2)) {
      const keepBri = state.bri;
      state = liveState();
      state.bri = keepBri;
    }
    if (typeof b.on === 'boolean') state.on = b.on;
    if (Number.isInteger(b.bri)) state.bri = b.bri;
    if (Array.isArray(b.seg)) {
      if (b.seg.length && !Number.isInteger(b.ps)) state.ps = -1;
      b.seg.forEach((s) => {
        if (!s || !Number.isInteger(s.id)) return;
        const i = state.seg.findIndex((x) => x.id === s.id);
        if (s.stop === 0) { if (i >= 0) state.seg.splice(i, 1); return; }
        if (i >= 0) Object.assign(state.seg[i], s);
        else if (Number.isInteger(s.start)) state.seg.push(Object.assign({}, s));
      });
      state.seg.sort((x, y) => x.id - y.id);
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
      calls.push({ method: req.method, path: req.url, body: body });
      if (mode === 'down') { req.socket.destroy(); return; }
      if (mode === 'slow') { hanging.add(res); res.on('close', () => hanging.delete(res)); return; }
      const p = req.url.split('?')[0];
      if (p === '/json/state' && req.method === 'POST') {
        posts += 1;
        if (mode === 'refuse') return send(res, 400, { error: 9 });
        const m = /^failAfter:(\d+)$/.exec(mode);
        if (m && posts > Number(m[1])) return send(res, 500, { error: 1 });
        if (body && typeof body === 'object') apply(body);
        return send(res, 200, { success: true });
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method' });
      if (p === '/json/state') return send(res, 200, state);
      if (p === '/json/effects') return send(res, 200, effects);
      if (p === '/json/palettes') return send(res, 200, palettes);
      if (p === '/json/info') return send(res, 200, { ver: '16.0.1', name: 'Pretend wall', leds: { count: 164, maxpwr: 1000, maxseg: 32, pwr: 420, fps: 42 }, live: false });
      if (p === '/json/cfg') {
        const cfg = { hw: { led: { total: 164, maxpwr: 1000, ledma: 55, ins: [{ len: 164, ledma: 55 }] } }, if: { live: { en: true } } };
        if (gamma !== null) cfg.light = { 'scale-bri': 100, gc: { bri: 1, col: gamma, val: 2.8 } };
        return send(res, 200, cfg);
      }
      return send(res, 404, { error: 'not found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        port: port,
        calls: calls,
        posts: () => calls.filter((c) => c.method === 'POST' && c.path === '/json/state').map((c) => c.body),
        state: () => JSON.parse(JSON.stringify(state)),
        mode: (m) => { mode = m || 'ok'; posts = 0; },
        effects: (fn) => { effects = fn(effects.slice()); },
        set: (f) => { Object.assign(state, f || {}); },
        presetLag: (ms) => { lag = ms || 0; },
        gamma: (v) => { gamma = v === undefined ? 2.8 : v; },
        reset: () => {
          lagTimers.forEach((t) => clearTimeout(t)); lagTimers.clear();
          state = liveState(); mode = 'ok'; posts = 0; lag = 0; gamma = 2.8; effects = names(CATALOG.fx, 190, 'FX'); calls.length = 0;
        },
        close: () => new Promise((r) => {
          lagTimers.forEach((t) => clearTimeout(t)); lagTimers.clear();
          hanging.forEach((h) => { try { if (h.socket) h.socket.destroy(); } catch (e) { /* gone */ } });
          server.close(() => r());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        })
      });
    });
  });
}

module.exports = { start: start, LIVE: LIVE };

if (require.main === module) {
  start({ port: Number(process.env.MOCK_WALL_PORT) || 0 }).then((w) => {
    console.log('Pretend plant wall (WLED) on ' + w.url);
    console.log('For the preview: WLED_URL=' + w.url);
  });
}
