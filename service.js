/*
 * Home Hub service. TizenBrew runs this file in its Node service on the TV
 * when the hub opens. It gives the hub page a few things a web page can't
 * always do on its own:
 *
 *   GET /ping            health check
 *   GET /apps            installed apps, as [{ id, name }]
 *   GET /launch?id=...   open an app by its Tizen app ID
 *   GET /launch-control?id=...&op=...[&uri=...][&key=...&val=...]
 *                        open an app with an app control (an operation, an
 *                        optional URI and one optional data key and value):
 *                        how the watch link test tries deep links
 *   GET /key?k=KEY_...   press a remote key (used for HDMI inputs)
 *   GET /webhook?url=... send an empty POST, e.g. to a Home Assistant webhook
 *   GET /fetch?url=...   read JSON from one of four public weather/city addresses
 *
 * It listens on 127.0.0.1 only, so nothing else on the network can reach it.
 * Written for the old Node that ships on Tizen TVs: plain ES5, no newer APIs.
 */
'use strict';

var http = require('http');
var net = require('net');
var tls = require('tls');
var fs = require('fs');
var crypto = require('crypto');
var urlLib = require('url');
var os = require('os');

var PORT = 8095;
var VERSION = '0.29.2';
var TOKEN_FILE = '/home/owner/share/tizen-takeover-remote-token.txt';
var REMOTE_NAME = new Buffer('Home Hub').toString('base64');

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function listApps(cb) {
  try {
    tizen.application.getAppsInfo(function (infos) {
      var out = [];
      for (var i = 0; i < infos.length; i++) {
        var a = infos[i];
        // Built-in apps like Samsung TV Plus can be marked hidden, so keep them and flag them.
        out.push({ id: a.id, name: a.name, hidden: a.show === false });
      }
      cb(null, out);
    }, function (e) {
      cb(e && e.message ? e.message : 'getAppsInfo failed');
    });
  } catch (e) {
    cb(e.message);
  }
}

function launchApp(id, cb) {
  try {
    tizen.application.launch(id, function () {
      cb(null);
    }, function (e) {
      cb(e && e.message ? e.message : 'launch failed');
    });
  } catch (e) {
    cb(e.message);
  }
}

/* ---------- Opening an app with an app control (watch link test) ---------- */

// Strict shapes, so only a plain app control can be asked for.
var APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var OP_RE = /^https?:\/\/[A-Za-z0-9.-]{1,64}(\/[A-Za-z0-9._-]{1,64}){1,8}$/;
var URI_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,15}:[\x21-\x7e]{1,500}$/;
var KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
var VAL_RE = /^[\x20-\x7e]{1,1000}$/;

/* Checks the query. Returns { id, op, uri, key, val } or a string saying what is wrong. */
function checkControl(q) {
  var id = String(q.id || '');
  var op = String(q.op || '');
  var uri = q.uri === undefined || q.uri === '' ? null : String(q.uri);
  var key = q.key === undefined || q.key === '' ? null : String(q.key);
  var val = q.val === undefined ? null : String(q.val);
  if (!APP_ID_RE.test(id)) return 'bad id';
  if (!OP_RE.test(op)) return 'bad op';
  if (uri !== null && !URI_RE.test(uri)) return 'bad uri';
  if (key !== null && !KEY_RE.test(key)) return 'bad key';
  if ((key === null) !== (val === null)) return 'key and val go together';
  if (val !== null && !VAL_RE.test(val)) return 'bad val';
  return { id: id, op: op, uri: uri, key: key, val: val };
}

function launchControl(c, cb) {
  try {
    var data = c.key !== null ? [new tizen.ApplicationControlData(c.key, [c.val])] : null;
    var control = new tizen.ApplicationControl(c.op, c.uri, null, null, data);
    tizen.application.launchAppControl(control, c.id, function () {
      cb(null);
    }, function (e) {
      cb(e && e.message ? e.message : 'launchAppControl failed');
    });
  } catch (e) {
    cb(e.message);
  }
}

/* ---------- Minimal WebSocket client for the TV's own remote control channel ---------- */

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, String(token));
  } catch (e) { /* not fatal */ }
}

function encodeFrame(text) {
  var payload = new Buffer(text, 'utf8');
  var len = payload.length;
  var header;
  if (len < 126) {
    header = new Buffer([0x81, 0x80 | len]);
  } else {
    header = new Buffer([0x81, 0x80 | 126, (len >> 8) & 255, len & 255]);
  }
  var mask = crypto.randomBytes(4);
  var masked = new Buffer(len);
  for (var i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/* Parses unmasked frames from the server. Returns { messages, rest }. */
function decodeFrames(buf) {
  var messages = [];
  var offset = 0;
  while (buf.length - offset >= 2) {
    var b0 = buf[offset];
    var b1 = buf[offset + 1];
    var opcode = b0 & 0x0f;
    var len = b1 & 0x7f;
    var head = 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(offset + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      len = buf.readUInt32BE(offset + 6);
      head = 10;
    }
    if (buf.length - offset < head + len) break;
    if (opcode === 1) messages.push(buf.slice(offset + head, offset + head + len).toString('utf8'));
    offset += head + len;
  }
  return { messages: messages, rest: buf.slice(offset) };
}

/*
 * Connects to the TV's remote channel (port 8001 plain, or 8002 with TLS),
 * waits for the TV to accept (the first time, the TV shows an Allow prompt),
 * presses one key, then closes.
 */
function pressKeyVia(host, secure, key, cb) {
  var port = secure ? 8002 : 8001;
  var token = readToken();
  var path = '/api/v2/channels/samsung.remote.control?name=' + REMOTE_NAME +
    (secure && token ? '&token=' + token : '');
  var done = false;
  var upgraded = false;
  var pending = new Buffer(0);
  var sock;

  function finish(err) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { sock.end(); sock.destroy(); } catch (e) { /* ignore */ }
    cb(err);
  }

  // Long enough for someone to press Allow on the TV the first time.
  var timer = setTimeout(function () { finish('no answer'); }, 20000);

  var onConnect = function () {
    var wsKey = crypto.randomBytes(16).toString('base64');
    sock.write(
      'GET ' + path + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + wsKey + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  };

  if (secure) {
    sock = tls.connect({ host: host, port: port, rejectUnauthorized: false }, onConnect);
  } else {
    sock = net.connect({ host: host, port: port }, onConnect);
  }

  sock.on('data', function (chunk) {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      var text = pending.toString('binary');
      var end = text.indexOf('\r\n\r\n');
      if (end === -1) return;
      if (text.slice(0, 12).indexOf('101') === -1) return finish('refused');
      upgraded = true;
      pending = pending.slice(end + 4);
    }
    var parsed = decodeFrames(pending);
    pending = parsed.rest;
    for (var i = 0; i < parsed.messages.length; i++) {
      var msg;
      try { msg = JSON.parse(parsed.messages[i]); } catch (e) { continue; }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data && msg.data.token) saveToken(msg.data.token);
        sock.write(encodeFrame(JSON.stringify({
          method: 'ms.remote.control',
          params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
        })));
        setTimeout(function () { finish(null); }, 400);
      } else if (msg.event === 'ms.channel.unauthorized') {
        finish('denied');
      } else if (msg.event === 'ms.channel.timeOut') {
        finish('prompt timed out');
      }
    }
  });
  sock.on('error', function (e) { finish(e.message); });
  sock.on('close', function () { finish('closed'); });
}

/* The TV's own network addresses, so the remote channel sees a normal LAN client. */
function lanAddresses() {
  var out = [];
  try {
    var ifs = os.networkInterfaces();
    for (var name in ifs) {
      if (!ifs.hasOwnProperty(name)) continue;
      for (var i = 0; i < ifs[name].length; i++) {
        var a = ifs[name][i];
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

/*
 * Tries each way in until one works: the TV's LAN address first, then
 * 127.0.0.1, each on 8002 (TLS, newer sets) and then 8001.
 * The error lists every attempt so the hub can show what happened.
 */
function pressKey(key, cb) {
  var attempts = [];
  var hosts = lanAddresses().concat(['127.0.0.1']);
  for (var h = 0; h < hosts.length; h++) {
    attempts.push({ host: hosts[h], secure: true });
    attempts.push({ host: hosts[h], secure: false });
  }
  var errors = [];
  (function next(i) {
    if (i >= attempts.length) return cb(errors.join(', '));
    var a = attempts[i];
    pressKeyVia(a.host, a.secure, key, function (err) {
      if (!err) return cb(null);
      errors.push(a.host + ':' + (a.secure ? 8002 : 8001) + ' ' + err);
      next(i + 1);
    });
  })(0);
}

/* Sends an empty POST, for example to a Home Assistant webhook automation. */
function postWebhook(target, cb) {
  var u = urlLib.parse(target);
  var lib = u.protocol === 'https:' ? require('https') : http;
  var finished = false;
  function done(err) { if (!finished) { finished = true; cb(err); } }
  var req = lib.request({
    method: 'POST',
    hostname: u.hostname,
    port: u.port,
    path: u.path,
    rejectUnauthorized: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
  }, function (r) {
    r.resume();
    done(r.statusCode >= 200 && r.statusCode < 300 ? null : 'HTTP ' + r.statusCode);
  });
  req.setTimeout(10000, function () { req.abort(); done('timed out'); });
  req.on('error', function (e) { done(e.message); });
  req.end('{}');
}

/* ---------- Fetching public weather and city data ---------- */

// The only addresses /fetch will read. Everything else is refused.
var FETCH_ALLOWED = [
  { host: 'api.open-meteo.com', path: '/v1/forecast' },
  { host: 'geocoding-api.open-meteo.com', path: '/v1/search' },
  { host: 'ipwho.is', path: '/' },
  { host: 'get.geojs.io', path: '/v1/ip/geo.json' }
];
var FETCH_MAX_BYTES = 300 * 1024;

/* Returns the parsed address if it is exactly on the list, otherwise null. */
function checkFetchUrl(target) {
  if (typeof target !== 'string' || !target || target.length > 2000) return null;
  // Printable ASCII only: old Node writes the request path as latin1.
  if (/[^\x21-\x7e]/.test(target)) return null;
  var u = urlLib.parse(target);
  if (u.protocol !== 'https:' || u.auth) return null;
  if (u.port && String(u.port) !== '443') return null;
  var host = String(u.hostname || '').toLowerCase();
  for (var i = 0; i < FETCH_ALLOWED.length; i++) {
    if (FETCH_ALLOWED[i].host === host && FETCH_ALLOWED[i].path === u.pathname) return u;
  }
  return null;
}

/*
 * Reads JSON with a plain GET and hands it to cb(err, data). The hub page asks
 * for this when its own direct call fails.
 * rejectUnauthorized is false because the old Node on the TV ships a 2016
 * certificate list that cannot verify today's certificates. This is only used
 * for public weather and city data from the four listed addresses, and the hub
 * shows it as plain text.
 */
function fetchJson(u, cb) {
  var finished = false;
  function done(err, data) { if (!finished) { finished = true; cb(err, data); } }
  var req = require('https').request({
    method: 'GET',
    hostname: u.hostname,
    port: 443,
    path: u.path,
    rejectUnauthorized: false,
    headers: { 'Accept': 'application/json', 'User-Agent': 'HomeHub' }
  }, function (r) {
    var chunks = [];
    var size = 0;
    r.on('data', function (chunk) {
      if (finished) return;
      size += chunk.length;
      if (size > FETCH_MAX_BYTES) {
        req.abort();
        return done('too large');
      }
      chunks.push(chunk);
    });
    r.on('error', function (e) { done(e.message); });
    r.on('aborted', function () { done('connection dropped'); });
    r.on('end', function () {
      var ok = r.statusCode >= 200 && r.statusCode < 300;
      var data = null;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { data = null; }
      var isObject = data !== null && typeof data === 'object';
      if (ok) return isObject ? done(null, data) : done('not JSON');
      var msg = 'HTTP ' + r.statusCode;
      if (isObject && typeof data.reason === 'string') msg += ': ' + data.reason.slice(0, 120);
      done(msg);
    });
  });
  req.setTimeout(10000, function () { req.abort(); done('timed out'); });
  req.on('error', function (e) { done(e.message); });
  req.end();
}

/* ---------- HTTP server ---------- */

var server = http.createServer(function (req, res) {
  var parsed = urlLib.parse(req.url, true);
  var q = parsed.query || {};

  if (parsed.pathname === '/ping') return send(res, 200, { ok: true, version: VERSION });

  // A newer copy of this service asks the running one to step aside.
  if (parsed.pathname === '/quit') {
    send(res, 200, { ok: true });
    return setTimeout(function () { server.close(); }, 50);
  }

  if (parsed.pathname === '/apps') {
    return listApps(function (err, apps) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true, apps: apps });
    });
  }

  if (parsed.pathname === '/launch') {
    if (!q.id) return send(res, 400, { ok: false, error: 'missing id' });
    return launchApp(String(q.id), function (err) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true });
    });
  }

  if (parsed.pathname === '/launch-control') {
    var c = checkControl(q);
    if (typeof c === 'string') return send(res, 400, { ok: false, error: c });
    return launchControl(c, function (err) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true });
    });
  }

  if (parsed.pathname === '/key') {
    var key = String(q.k || '');
    if (!/^KEY_[A-Z0-9_]+$/.test(key)) return send(res, 400, { ok: false, error: 'bad key' });
    return pressKey(key, function (err) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true });
    });
  }

  if (parsed.pathname === '/webhook') {
    var target = String(q.url || '');
    if (!/^https?:\/\/[^\s]+$/.test(target)) return send(res, 400, { ok: false, error: 'bad url' });
    return postWebhook(target, function (err) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true });
    });
  }

  if (parsed.pathname === '/fetch') {
    var u = checkFetchUrl(q.url);
    if (!u) return send(res, 400, { ok: false, error: 'address not allowed' });
    return fetchJson(u, function (err, data) {
      if (err) return send(res, 502, { ok: false, error: String(err) });
      send(res, 200, { ok: true, data: data });
    });
  }

  send(res, 404, { ok: false, error: 'not found' });
});

var listenTries = 0;
server.on('error', function (e) {
  // An older copy from an earlier launch still holds the port. Ask it to quit, then take over.
  if (e && e.code === 'EADDRINUSE' && listenTries < 5) {
    listenTries++;
    http.get('http://127.0.0.1:' + PORT + '/quit', function (r) { r.resume(); })
      .on('error', function () { /* ignore */ });
    return setTimeout(function () { server.listen(PORT, '127.0.0.1'); }, 600);
  }
  console.log('Home Hub service error: ' + (e && e.message));
});

server.listen(PORT, '127.0.0.1');
