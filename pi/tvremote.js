/*
 * The TV's remote, driven from the Pi. The TV refuses remote key presses it
 * sends to itself, so the Pi sends them over Samsung's remote-control
 * WebSocket (wss://<tv>:8002, or ws://<tv>:8001), the same channel service.js
 * uses on the TV. Used by the "two-step launch" rows of the watch link test:
 * open the streaming app, wait, press Enter (the default profile), wait, then
 * send the title link while the app is already running.
 *
 *   run(spec): { id, appId, open, waitOpen, enter, waitAfter, link, payload, dialApp }
 *   link: 'deeplink' (ed.apps.launch with a metaTag), 'dial' (HTTP POST to the
 *   TV's DIAL port, Netflix and YouTube only) or 'none'.
 *
 * The first time, the TV shows an "Allow" prompt; the token it answers with
 * is kept in data/tvremote.json (mode 0600) and is never logged or returned.
 * One run at a time. Steps are kept in memory (the last run only), and the
 * log lines hold no link, payload or token.
 *
 * Node 14 or newer, no npm packages. Run the tests with: node pi/tvremote-test.js
 */
'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REMOTE_NAME = 'Home Hub Pi';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const APP_RE = /^[A-Za-z0-9._-]{1,60}$/;
const NAME_RE = /^[A-Za-z0-9 .+&'_-]{1,40}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,100}$/;
const KEYS = ['KEY_ENTER', 'KEY_RETURN'];
const DIAL_APPS = ['Netflix', 'YouTube'];
const LINKS = ['deeplink', 'dial', 'none'];
const SPEC_KEYS = ['id', 'appId', 'appName', 'open', 'waitOpen', 'enter', 'waitAfter', 'link', 'payload', 'dialApp'];
const MAX_PAYLOAD = 300;
const MAX_WAIT = 30;
const MAX_FRAME = 1024 * 1024;
const DEFAULTS = { open: true, waitOpen: 10, enter: true, waitAfter: 5, link: 'none' };
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

const DENIED = 'The TV said no to Home Hub Pi. On the TV, allow it under Settings > General > External Device Manager > Device Connection Manager > Device List, then try again.';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(msg, status) {
  const e = new Error(msg);
  e.status = status || 400;
  return e;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- the spec ---------- */

function num(name, v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > MAX_WAIT) throw bad('"' + name + '" must be a number of seconds from 0 to ' + MAX_WAIT);
  return v;
}

function flag(name, v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') throw bad('"' + name + '" must be true or false');
  return v;
}

// A run request, checked and filled in. Throws a 400 error that names the problem.
function normalizeSpec(raw) {
  if (!isObj(raw)) throw bad('send an object such as { "id": "...", "appId": "...", "link": "dial", ... }');
  Object.keys(raw).forEach((k) => {
    if (SPEC_KEYS.indexOf(k) < 0) throw bad('"' + k + '" is not something a run takes (use ' + SPEC_KEYS.join(', ') + ')');
  });
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw bad('"id" must be 1 to 40 of A-Z, a-z, 0-9, "_" or "-"');
  if (typeof raw.appId !== 'string' || !APP_RE.test(raw.appId)) throw bad('"appId" must be 1 to 60 of A-Z, a-z, 0-9, ".", "_" or "-"');
  if (raw.appName !== undefined && raw.appName !== null && (typeof raw.appName !== 'string' || !NAME_RE.test(raw.appName))) throw bad('"appName" must be 1 to 40 letters, digits, spaces or . + & \' _ -');
  const spec = {
    id: raw.id,
    appId: raw.appId,
    appName: typeof raw.appName === 'string' ? raw.appName : '',
    open: flag('open', raw.open, DEFAULTS.open),
    waitOpen: num('waitOpen', raw.waitOpen, DEFAULTS.waitOpen),
    enter: flag('enter', raw.enter, DEFAULTS.enter),
    waitAfter: num('waitAfter', raw.waitAfter, DEFAULTS.waitAfter),
    link: raw.link === undefined || raw.link === null ? DEFAULTS.link : raw.link
  };
  if (LINKS.indexOf(spec.link) < 0) throw bad('"link" must be ' + LINKS.join(', ') + ' or left out');
  if (spec.link !== 'none') {
    if (typeof raw.payload !== 'string' || !raw.payload.trim()) throw bad('"payload" is needed for a ' + spec.link + ' link');
    if (CONTROL_RE.test(raw.payload)) throw bad('"payload" must not hold control characters');
    if (Array.from(raw.payload).length > MAX_PAYLOAD) throw bad('"payload" is at most ' + MAX_PAYLOAD + ' characters');
    spec.payload = raw.payload;
  }
  if (spec.link === 'dial') {
    if (DIAL_APPS.indexOf(raw.dialApp) < 0) throw bad('"dialApp" must be ' + DIAL_APPS.join(' or '));
    spec.dialApp = raw.dialApp;
  } else if (raw.dialApp !== undefined && raw.dialApp !== null) {
    throw bad('"dialApp" only goes with a dial link');
  }
  if (!spec.open && !spec.enter && spec.link === 'none') throw bad('nothing to do: turn on open, enter or a link');
  return spec;
}

/* ---------- a small WebSocket client ---------- */

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 0x80 | 126, (len >> 8) & 255, len & 255]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Reads whole frames from the server (which sends them unmasked). Returns
// { frames: [{ opcode, fin, data }], rest } or { error } for a frame too big.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = buf.readUInt32BE(off + 2) * 4294967296 + buf.readUInt32BE(off + 6);
      head = 10;
    }
    if (len > MAX_FRAME) return { error: 'a frame from the TV was too big', frames: frames, rest: Buffer.alloc(0) };
    const masked = (b1 & 0x80) !== 0;
    if (masked) head += 4;
    if (buf.length - off < head + len) break;
    let data = buf.slice(off + head, off + head + len);
    if (masked) {
      const mk = buf.slice(off + head - 4, off + head);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = data[i] ^ mk[i % 4];
      data = out;
    }
    frames.push({ opcode: b0 & 0x0f, fin: (b0 & 0x80) !== 0, data: data });
    off += head + len;
  }
  return { frames: frames, rest: buf.slice(off) };
}

/*
 * Opens one channel: resolves to { send(obj), close(), alive(), next(ms) }.
 * next(ms) waits for the next JSON message (null on timeout, rejects when the
 * line closes). Rejects when it cannot connect or the TV refuses the upgrade.
 */
function openChannel(host, port, secure, pathAndQuery, connectMs) {
  return new Promise((resolve, reject) => {
    let sock;
    let upgraded = false;
    let settled = false;
    let closed = false;
    let pending = Buffer.alloc(0);
    let fragments = [];
    const queue = [];
    const waiters = [];

    const fail = (msg) => {
      if (!settled) { settled = true; clearTimeout(timer); try { sock.destroy(); } catch (e) { /* gone */ } reject(new Error(msg)); }
    };
    const timer = setTimeout(() => fail('no answer on port ' + port), connectMs);

    function onClosed() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift().reject(new Error('the TV closed the line'));
    }

    function message(text) {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      const w = waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
    }

    const conn = {
      alive: () => upgraded && !closed,
      send: (obj) => {
        if (!conn.alive()) throw new Error('the line to the TV is closed');
        sock.write(encodeFrame(1, Buffer.from(JSON.stringify(obj), 'utf8')));
      },
      next: (ms) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        if (closed) return rej(new Error('the TV closed the line'));
        const w = { resolve: res, reject: rej, timer: null };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          res(null);
        }, ms);
        waiters.push(w);
        return undefined;
      }),
      close: () => new Promise((res) => {
        if (closed) return res();
        const done = () => { clearTimeout(t); try { sock.destroy(); } catch (e) { /* gone */ } res(); };
        const t = setTimeout(done, 500);
        sock.once('close', done);
        try {
          sock.write(encodeFrame(8, Buffer.from([0x03, 0xe8])));
          sock.end();
        } catch (e) { done(); }
        return undefined;
      })
    };

    function onData(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const text = pending.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) { if (pending.length > 16384) fail('the TV answered oddly'); return; }
        if (!/^HTTP\/1\.1 101/.test(text)) return fail('the TV refused the connection on port ' + port);
        upgraded = true;
        settled = true;
        clearTimeout(timer);
        pending = pending.slice(end + 4);
        resolve(conn);
      }
      const parsed = decodeFrames(pending);
      pending = parsed.rest;
      parsed.frames.forEach((f) => {
        if (f.opcode === 9) { try { sock.write(encodeFrame(10, f.data)); } catch (e) { /* closing */ } return; }
        if (f.opcode === 8) { try { sock.end(); } catch (e) { /* closing */ } return; }
        if (f.opcode === 1 || f.opcode === 2) fragments = [f.data];
        else if (f.opcode === 0) fragments.push(f.data);
        else return;
        if (f.fin) { const all = Buffer.concat(fragments); fragments = []; message(all.toString('utf8')); }
      });
      if (parsed.error) { try { sock.destroy(); } catch (e) { /* gone */ } }
    }

    const onConnect = () => {
      sock.write(
        'GET ' + pathAndQuery + ' HTTP/1.1\r\n' +
        'Host: ' + host + ':' + port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    };
    sock = secure
      ? tls.connect({ host: host, port: port, rejectUnauthorized: false }, onConnect)
      : net.connect({ host: host, port: port }, onConnect);
    try { sock.setNoDelay(true); } catch (e) { /* not fatal */ }
    sock.on('data', onData);
    sock.on('error', (e) => { fail(e && e.code ? 'could not connect on port ' + port + ' (' + e.code + ')' : 'could not connect on port ' + port); onClosed(); });
    sock.on('close', () => { fail('the TV closed the line on port ' + port); onClosed(); });
  });
}

/* ---------- the remote ---------- */

function create(options) {
  const opt = options || {};
  const file = opt.dataDir ? path.join(opt.dataDir, 'tvremote.json') : null;
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const ports = Object.assign({ tls: 8002, plain: 8001, dial: 8080 }, opt.ports || {});
  const secondMs = typeof opt.secondMs === 'number' ? opt.secondMs : 1000; // tests make a "second" short
  const pairMs = typeof opt.pairMs === 'number' ? opt.pairMs : 30000;
  const connectMs = typeof opt.connectMs === 'number' ? opt.connectMs : 8000;
  const dialMs = typeof opt.dialMs === 'number' ? opt.dialMs : 8000;
  const keyGapMs = typeof opt.keyGapMs === 'number' ? opt.keyGapMs : 250;
  const findMs = typeof opt.findMs === 'number' ? opt.findMs : 5000;
  const wait = typeof opt.sleep === 'function' ? opt.sleep : sleepMs;
  const fixedHost = typeof opt.host === 'string' && HOST_RE.test(opt.host) ? opt.host : '';

  let token = '';
  let seenHost = '';
  try {
    if (file && fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isObj(d)) {
        if (typeof d.token === 'string' && /^[\x21-\x7e]{1,200}$/.test(d.token)) token = d.token;
        if (typeof d.host === 'string' && HOST_RE.test(d.host)) seenHost = d.host;
      }
    }
  } catch (e) { /* start without a token */ }

  let running = false;
  let last = null;

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ token: token, host: seenHost }) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (e) { log('tvremote: could not save the pairing (' + e.code + ')'); }
  }

  function address() {
    return fixedHost || seenHost;
  }

  // The TV's address as the screen showed it. Kept (and saved) when it changes.
  function seen(ip, onlyIfUnknown) {
    let a = String(ip || '').trim().toLowerCase();
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) a = m[1];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a) || (a === '127.0.0.1' && !opt.allowLoopback)) return;
    if (onlyIfUnknown && (seenHost || fixedHost)) return;
    if (a !== seenHost) { seenHost = a; save(); }
  }

  /* --- one run's record --- */

  function newRun(spec) {
    return { id: spec.id, appId: spec.appId, startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: '', steps: [] };
  }

  async function step(rec, name, fn) {
    const t0 = Date.now();
    let out;
    try {
      const d = await fn();
      out = { step: name, ok: true, ms: Date.now() - t0, detail: typeof d === 'string' ? d : '' };
    } catch (e) {
      out = { step: name, ok: false, ms: Date.now() - t0, detail: e && e.message ? e.message : 'failed' };
    }
    rec.steps.push(out);
    return out;
  }

  /* --- the channel --- */

  function pathFor() {
    return '/api/v2/channels/samsung.remote.control?name=' + Buffer.from(REMOTE_NAME).toString('base64') +
      (token ? '&token=' + encodeURIComponent(token) : '');
  }

  // Connects (8002 first, then 8001) and waits for the TV to accept.
  async function connect(host) {
    let conn;
    let firstError = '';
    try {
      conn = await openChannel(host, ports.tls, true, pathFor(), connectMs);
    } catch (e) {
      firstError = e.message;
      conn = await openChannel(host, ports.plain, false, pathFor(), connectMs).catch((e2) => {
        throw new Error(firstError + '; ' + e2.message);
      });
    }
    const end = Date.now() + pairMs;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) {
        conn.close();
        throw new Error('The TV did not answer in ' + Math.round(pairMs / 1000) + ' seconds. If it shows an Allow prompt for "Home Hub Pi", choose Allow, then try again.');
      }
      let msg;
      try { msg = await conn.next(left); } catch (e) { throw new Error('The TV closed the line before it said yes.'); }
      if (!msg) continue;
      if (msg.event === 'ms.channel.connect') {
        const t = msg.data && msg.data.token;
        if (typeof t === 'string' && /^[\x21-\x7e]{1,200}$/.test(t) && t !== token) { token = t; save(); }
        return conn;
      }
      if (msg.event === 'ms.channel.unauthorized') { conn.close(); throw new Error(DENIED); }
      if (msg.event === 'ms.channel.timeOut') { conn.close(); throw new Error('The Allow prompt on the TV timed out. Try again and choose Allow.'); }
    }
  }

  function sendKey(conn, name) {
    if (KEYS.indexOf(name) < 0) throw new Error('that key is not allowed');
    conn.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: name, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  }

  function appEvent(appId, metaTag) {
    const data = { appId: appId, action_type: 'DEEP_LINK' };
    if (metaTag !== undefined) data.metaTag = metaTag;
    return { method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: data } };
  }

  function dial(host, appName, body) {
    return new Promise((resolve, reject) => {
      if (DIAL_APPS.indexOf(appName) < 0) return reject(new Error('that DIAL app is not allowed'));
      const buf = Buffer.from(body, 'utf8');
      const req = http.request({
        host: host, port: ports.dial, method: 'POST', path: '/ws/apps/' + appName,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length }
      }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve('HTTP ' + res.statusCode);
          else reject(new Error('HTTP ' + res.statusCode + (res.statusCode === 404 ? ' (the TV does not know that app over DIAL)' : '')));
        });
      });
      req.setTimeout(dialMs, () => { req.destroy(new Error('no answer from the DIAL port')); });
      req.on('error', (e) => reject(new Error(e && e.message && /DIAL/.test(e.message) ? e.message : 'could not reach the DIAL port' + (e && e.code ? ' (' + e.code + ')' : ''))));
      req.end(buf);
      return undefined;
    });
  }

  // The remote channel's id for an installed app, by name ('' when not found).
  async function findApp(conn, name) {
    conn.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
    const end = Date.now() + findMs;
    const want = name.toLowerCase();
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return '';
      const msg = await conn.next(left);
      if (!msg || msg.event !== 'ed.installedApp.get') continue;
      const list = msg.data && Array.isArray(msg.data.data) ? msg.data.data : [];
      let hit = null;
      list.forEach((a) => {
        const n = a && typeof a.name === 'string' ? a.name.toLowerCase() : '';
        if (!a || typeof a.appId !== 'string' || !APP_RE.test(a.appId)) return;
        if (n === want) hit = hit && hit.exact ? hit : { id: a.appId, exact: true };
        else if (!hit && n.indexOf(want) === 0) hit = { id: a.appId, exact: false };
      });
      return hit ? hit.id : '';
    }
  }

  /* --- the sequence --- */

  async function execute(spec, host, rec) {
    let conn = null;
    const secs = (s) => wait(Math.round(s * secondMs));
    // The line is kept for the whole run; if the TV dropped it during a wait, open it again (no prompt now).
    const line = async () => {
      if (!conn || !conn.alive()) conn = await connect(host);
      return conn;
    };
    const fails = () => rec.steps.some((s) => !s.ok);
    try {
      const needsWs = spec.open || spec.enter || spec.link === 'deeplink';
      if (needsWs) {
        await step(rec, 'connect', async () => { await line(); return paired() ? 'paired' : 'connected'; });
        if (fails()) return;
      }
      // The id the TV's own app list gives (org.tizen.netflix-app, say) is not
      // always the one the remote channel launches by (11101200001), so ask
      // the TV's remote for its installed apps and take the id under that name.
      if (spec.appName && (spec.open || spec.link === 'deeplink')) {
        await step(rec, 'find', async () => {
          const found = await findApp(await line(), spec.appName);
          if (found) { spec.appId = found; return 'found by name'; }
          return 'not in the TV\'s list; kept the hub\'s id';
        });
      }
      if (spec.open) {
        await step(rec, 'open', async () => { (await line()).send(appEvent(spec.appId)); return 'sent'; });
        if (fails()) return;
        if (spec.waitOpen > 0) await step(rec, 'wait', async () => { await secs(spec.waitOpen); return spec.waitOpen + ' s'; });
      }
      if (spec.enter) {
        await step(rec, 'enter', async () => { const c = await line(); sendKey(c, 'KEY_ENTER'); await wait(keyGapMs); return 'sent'; });
        if (fails()) return;
        if (spec.waitAfter > 0) await step(rec, 'wait', async () => { await secs(spec.waitAfter); return spec.waitAfter + ' s'; });
      }
      if (spec.link === 'deeplink') {
        await step(rec, 'deeplink', async () => { const c = await line(); c.send(appEvent(spec.appId, spec.payload)); await wait(keyGapMs); return 'sent'; });
      } else if (spec.link === 'dial') {
        await step(rec, 'dial', () => dial(host, spec.dialApp, spec.payload));
      }
    } finally {
      if (conn) await conn.close();
    }
  }

  // The log line: what was done, in words, with no link, payload or token.
  function summary(spec, rec) {
    const names = { open: 'opened app', enter: 'Enter', deeplink: 'deep link', find: 'found app' };
    const parts = [];
    rec.steps.forEach((s) => {
      if (s.step === 'wait') return;
      if (s.step === 'connect') { if (!s.ok) parts.push('could not connect'); return; }
      if (s.step === 'dial') { parts.push('DIAL ' + spec.dialApp + ' -> ' + (s.ok ? s.detail : s.detail.replace(/^(HTTP \d+).*/, '$1').replace(/^could not reach.*/, 'no answer'))); return; }
      parts.push(names[s.step] + ' (' + (s.ok ? 'ok' : 'failed') + ')');
    });
    return 'tvremote: ' + spec.id + ': ' + parts.join(', ');
  }

  function paired() {
    return !!token;
  }

  // Starts a run and returns at once: { started, paired, done } where done is
  // a promise of the finished record (it never rejects).
  function run(rawSpec, hostIn) {
    const spec = normalizeSpec(rawSpec);
    const host = hostIn !== undefined && hostIn !== null && hostIn !== '' ? String(hostIn) : address();
    if (!host) throw bad('The Pi does not know the TV\'s address yet. Open Home Hub on the TV once, or set HUB_TV_REMOTE_IP in pi/.env.');
    if (!HOST_RE.test(host)) throw bad('that TV address is not usable');
    if (running) throw bad('A TV remote run is already going (' + last.id + '). Wait for it to finish.', 409);
    running = true;
    const rec = newRun(spec);
    last = rec;
    const wasPaired = paired();
    const done = (async () => {
      try {
        await execute(spec, host, rec);
        rec.ok = !rec.steps.some((s) => !s.ok);
        const badStep = rec.steps.filter((s) => !s.ok)[0];
        if (badStep) rec.error = badStep.step === 'connect' ? badStep.detail : badStep.step + ' failed: ' + badStep.detail;
      } catch (e) {
        rec.ok = false;
        rec.error = e && e.message ? e.message : 'failed';
      }
      rec.finishedAt = new Date().toISOString();
      running = false;
      try { log(summary(spec, rec)); } catch (e) { /* logging never stops a run */ }
      return rec;
    })();
    return { started: true, paired: wasPaired, done: done };
  }

  function status() {
    return {
      paired: paired(),
      host: address() || null,
      hostFrom: fixedHost ? 'HUB_TV_REMOTE_IP' : (seenHost ? 'the screen' : null),
      running: running,
      last: last ? JSON.parse(JSON.stringify(last)) : null
    };
  }

  return { run: run, status: status, seen: seen, paired: paired, address: address, isRunning: () => running };
}

// The lines for ./hub tvremote.
function lines(s) {
  if (!isObj(s)) return ['No answer about the TV remote.'];
  const out = [];
  out.push('TV remote from the Pi: ' + (s.paired ? 'paired with the TV' : 'not paired yet (the first run makes the TV ask; choose Allow)') +
    (s.host ? '; TV address known' + (s.hostFrom ? ' (from ' + s.hostFrom + ')' : '') : '; TV address not known yet') + (s.running ? '; a run is going now' : '') + '.');
  const l = s.last;
  if (!l) { out.push('No run yet.'); return out; }
  out.push('Last run [' + l.id + '] ' + (l.finishedAt ? (l.ok ? 'worked' : 'did not work') : 'is still going') + ', started ' + String(l.startedAt || '').slice(0, 19).replace('T', ' ') + ' UTC' + (l.error ? ': ' + l.error : '') + '.');
  (l.steps || []).forEach((st) => out.push('  ' + st.step + ' ' + (st.ok ? 'ok' : 'FAILED') + ' (' + st.ms + ' ms)' + (st.detail ? ' ' + st.detail : '')));
  return out;
}

module.exports = {
  create: create,
  normalizeSpec: normalizeSpec,
  lines: lines,
  encodeFrame: encodeFrame,
  decodeFrames: decodeFrames,
  KEYS: KEYS,
  DIAL_APPS: DIAL_APPS,
  SPEC_KEYS: SPEC_KEYS,
  DEFAULTS: DEFAULTS,
  DENIED: DENIED
};
