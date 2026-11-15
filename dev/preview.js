/*
 * Preview the hub on a laptop: node dev/preview.js
 *
 * Serves app/ at http://127.0.0.1:8090/ and pretends to be service.js on
 * 127.0.0.1:8095 with a made-up app list. Opening apps, keys and webhooks are
 * only printed here. No dependencies.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var urlLib = require('url');

var APP_DIR = path.join(__dirname, '..', 'app');
var PAGE_PORT = 8090;
var SERVICE_PORT = 8095;

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

// Peacock is left out on purpose, so its "Not installed" state shows.
var APPS = [
  { id: '3201907018807', name: 'Netflix', hidden: false },
  { id: '3201910019365', name: 'Prime Video', hidden: false },
  { id: '3201901017640', name: 'Disney+', hidden: false },
  { id: '3201601007625', name: 'Hulu', hidden: false },
  { id: '3201807016597', name: 'Apple TV', hidden: false },
  { id: '3201808016802', name: 'Pluto TV', hidden: false },
  { id: '3201608010191', name: 'Twitch', hidden: false },
  { id: '3201606009684', name: 'Spotify - Music and Podcasts', hidden: false },
  { id: 'org.tizen.browser', name: 'Internet', hidden: false },
  { id: 'com.samsung.tv.gallery', name: 'Gallery', hidden: false },
  { id: 'org.tizen.e-manual', name: 'e-Manual', hidden: false },
  { id: '3201512006963', name: 'Plex', hidden: false },
  { id: '3201802015375', name: 'Paramount+', hidden: false },
  { id: '3202203026841', name: 'Max', hidden: false },
  { id: '3201710015037', name: 'Tubi - Free Movies and TV', hidden: false },
  { id: '111299001912', name: 'YouTube', hidden: false },
  { id: 'com.samsung.tv.smartthings', name: 'SmartThings', hidden: false },
  { id: 'TizenBrewStandalone.TizenBrew', name: 'TizenBrew', hidden: false },
  { id: 'com.samsung.tv.samsungtvplus', name: 'Samsung TV Plus', hidden: true },
  { id: 'org.tizen.settings', name: 'Settings', hidden: true }
];

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function log(text) {
  var t = new Date();
  console.log('[' + t.toTimeString().substring(0, 8) + '] ' + text);
}

var page = http.createServer(function (req, res) {
  var pathname = decodeURIComponent(urlLib.parse(req.url).pathname || '/');
  if (pathname === '/') pathname = '/index.html';
  var file = path.normalize(path.join(APP_DIR, pathname));
  if (file.indexOf(APP_DIR) !== 0) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

var service = http.createServer(function (req, res) {
  var parsed = urlLib.parse(req.url, true);
  var q = parsed.query || {};
  var p = parsed.pathname;

  if (p === '/ping') return send(res, 200, { ok: true, version: 'preview' });
  if (p === '/apps') return send(res, 200, { ok: true, apps: APPS });
  if (p === '/launch') {
    log('launch ' + q.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/key') {
    log('key ' + q.k);
    return send(res, 200, { ok: true });
  }
  if (p === '/webhook') {
    log('webhook ' + q.url);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: 'not found' });
});

page.listen(PAGE_PORT, '127.0.0.1', function () {
  log('Hub:      http://127.0.0.1:' + PAGE_PORT + '/');
  log('          add ?motion=fade, ?motion=expand or ?motion=auto to try the animations');
});
service.listen(SERVICE_PORT, '127.0.0.1', function () {
  log('Service:  http://127.0.0.1:' + SERVICE_PORT + ' (pretend service.js)');
  log('Keys: arrows to move, Enter for OK, Escape for Back.');
});
