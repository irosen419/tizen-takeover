/*
 * Home Hub service. TizenBrew runs this file in its Node service on the TV
 * when the hub opens. It gives the hub page three things a web page can't
 * always do on its own:
 *
 *   GET /ping            health check
 *   GET /apps            installed apps, as [{ id, name }]
 *   GET /launch?id=...   open an app by its Tizen app ID
 *   GET /key?k=KEY_...   press a remote key (used for HDMI inputs)
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

var PORT = 8095;
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
        if (a.show === false) continue;
        out.push({ id: a.id, name: a.name });
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
function pressKeyVia(secure, key, cb) {
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
  var timer = setTimeout(function () { finish('timed out waiting for the TV'); }, 30000);

  var onConnect = function () {
    var wsKey = crypto.randomBytes(16).toString('base64');
    sock.write(
      'GET ' + path + ' HTTP/1.1\r\n' +
      'Host: 127.0.0.1:' + port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + wsKey + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  };

  if (secure) {
    sock = tls.connect({ host: '127.0.0.1', port: port, rejectUnauthorized: false }, onConnect);
  } else {
    sock = net.connect({ host: '127.0.0.1', port: port }, onConnect);
  }

  sock.on('data', function (chunk) {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      var text = pending.toString('binary');
      var end = text.indexOf('\r\n\r\n');
      if (end === -1) return;
      if (text.slice(0, 12).indexOf('101') === -1) return finish('remote channel refused on port ' + port);
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
        finish('the TV said no (Allow was declined or turned off)');
      } else if (msg.event === 'ms.channel.timeOut') {
        finish('the Allow prompt timed out on the TV');
      }
    }
  });
  sock.on('error', function (e) { finish(e.message); });
  sock.on('close', function () { finish('connection closed on port ' + port); });
}

function pressKey(key, cb) {
  // Most 2016 to 2018 sets take plain 8001. Newer ones want 8002 with a token.
  pressKeyVia(false, key, function (err) {
    if (!err) return cb(null);
    pressKeyVia(true, key, function (err2) {
      cb(err2 ? ('8001: ' + err + ' / 8002: ' + err2) : null);
    });
  });
}

/* ---------- HTTP server ---------- */

var server = http.createServer(function (req, res) {
  var parsed = urlLib.parse(req.url, true);
  var q = parsed.query || {};

  if (parsed.pathname === '/ping') return send(res, 200, { ok: true });

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

  if (parsed.pathname === '/key') {
    var key = String(q.k || '');
    if (!/^KEY_[A-Z0-9_]+$/.test(key)) return send(res, 400, { ok: false, error: 'bad key' });
    return pressKey(key, function (err) {
      if (err) return send(res, 500, { ok: false, error: String(err) });
      send(res, 200, { ok: true });
    });
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', function (e) {
  // A copy of this service is already running from an earlier launch. That one keeps serving.
  if (e && e.code === 'EADDRINUSE') return;
  console.log('Home Hub service error: ' + (e && e.message));
});

server.listen(PORT, '127.0.0.1');
