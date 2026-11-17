/*
 * Preview the hub on a laptop: node dev/preview.js
 *
 * Serves app/ at http://127.0.0.1:8090/ and pretends to be service.js on
 * 127.0.0.1:8095 with a made-up app list. Opening apps, keys and webhooks are
 * only printed here. No dependencies.
 *
 * Weather: GET /fetch?url=... answers from dev/samples/*.json (edit them, no
 * restart needed). Try failure states with WEATHER_MODE=fail node dev/preview.js
 * or GET http://127.0.0.1:8095/preview?weather=MODE while it runs. Modes: ok,
 * fail, slow, badjson, nolookup, nogeocode, forecastfail.
 * HUB_PAGE_PORT and HUB_SERVICE_PORT change the two ports (for tests).
 *
 * Live updates: when pi/server.js is there, the hub server runs here too, on
 * 127.0.0.1:8097 (HUB_LIVE_PORT changes it), with a made-up token and its
 * data in dev/.live-data. Open the hub with ?live=http://127.0.0.1:8097 to
 * use it, and steer it with pi/hubctl.js (the address it prints).
 * HUB_LIVE_PORT=off leaves it out (dev/live-test.js runs its own).
 *
 * Calendar: that hub server reads four sample calendars (dev/calendar-sample.js)
 * from a small local feed server, the way it reads Google on the Pi. Try the
 * other states with CALENDAR_MODE=MODE node dev/preview.js or GET
 * http://127.0.0.1:8095/preview?calendar=MODE while it runs (the Pi reads the
 * feeds again at once). Modes: sample, empty, fail, partial, many, and off
 * (only at start: no calendars set up).
 *
 * Spotify: the hub server also gets a stand-in for Spotify (dev/mock-spotify.js)
 * and is signed in to it, so Now Playing has something to show. Start with
 * SPOTIFY_MODE=MODE node dev/preview.js, or switch while it runs with
 * GET http://127.0.0.1:8095/preview?spotify=MODE (and ?spotify=next for the
 * next song). Modes: playing, paused, idle, long (long Spanish text),
 * episode, advert, down, ratelimit, forbidden, revoked, plus signin (set up,
 * not signed in) and off (no Spotify settings). HUB_SPOTIFY=off leaves it out.
 * ?spotify=next goes through seven songs, each with its own vibe for the
 * full screen visualizer (upbeat, calm and acoustic, moody, hard and fast,
 * calm again, one known only by its genres, one with nothing known); the
 * same stand-in plays ReccoBeats and answers 1.2 s late, as the real one
 * may. VIBE_MODE=MODE or ?vibe=MODE: ok, empty, garbage, slow, ratelimit, down.
 *
 * Ambience: the hub server also gets a made-up Home Assistant and plant wall
 * (dev/mock-lights.js) with the lights, scenes and moods of
 * pi/ambience.example.json. LIGHTS_MODE=MODE at start: sample (the default),
 * nolights (Home Assistant set up, no lights saved) or off (not set up).
 * While it runs, GET http://127.0.0.1:8095/preview?lights=MODE changes the
 * room: ok, sengled (the Sengled bulb unavailable), slow, down, unauthorized,
 * wall-down. HUB_LIGHTS=off leaves it out.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var urlLib = require('url');

var APP_DIR = path.join(__dirname, '..', 'app');
var SAMPLE_DIR = path.join(__dirname, 'samples');
var PAGE_PORT = parseInt(process.env.HUB_PAGE_PORT, 10) || 8090;
var SERVICE_PORT = parseInt(process.env.HUB_SERVICE_PORT, 10) || 8095;
var LIVE_PORT = parseInt(process.env.HUB_LIVE_PORT, 10) || 8097;
var LIVE_TOKEN = 'preview-token-not-a-secret-000000';
var LIVE_DATA_DIR = process.env.HUB_LIVE_DATA_DIR || path.join(__dirname, '.live-data');

var MODES = ['ok', 'fail', 'slow', 'badjson', 'nolookup', 'nogeocode', 'forecastfail'];
var weatherMode = process.env.WEATHER_MODE || 'ok';
var calendarMode = process.env.CALENDAR_MODE || 'sample';
var calendarFeeds = null;
var spotifyMode = process.env.SPOTIFY_MODE || 'playing';
var mockSpotify = null;
var vibeMode = process.env.VIBE_MODE || 'ok';
var lightsMode = process.env.LIGHTS_MODE || 'sample';
var mockLights = null;

// Same four addresses as service.js, each with the sample file that stands in for it.
var FETCH_ALLOWED = [
  { host: 'api.open-meteo.com', path: '/v1/forecast', sample: 'weather.json', kind: 'forecast' },
  { host: 'geocoding-api.open-meteo.com', path: '/v1/search', sample: 'geocode.json', kind: 'geocode' },
  { host: 'ipwho.is', path: '/', sample: 'ipwho.json', kind: 'lookup' },
  { host: 'get.geojs.io', path: '/v1/ip/geo.json', sample: 'geojs.json', kind: 'lookup' }
];

var TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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

/* Returns the matching list entry, or null if the address is not exactly on the list. */
function checkFetchUrl(target) {
  if (typeof target !== 'string' || !target || target.length > 2000) return null;
  // Printable ASCII only: old Node writes the request path as latin1.
  if (/[^\x21-\x7e]/.test(target)) return null;
  var u = urlLib.parse(target, true);
  if (u.protocol !== 'https:' || u.auth) return null;
  if (u.port && String(u.port) !== '443') return null;
  var host = String(u.hostname || '').toLowerCase();
  for (var i = 0; i < FETCH_ALLOWED.length; i++) {
    if (FETCH_ALLOWED[i].host === host && FETCH_ALLOWED[i].path === u.pathname) {
      return { entry: FETCH_ALLOWED[i], query: u.query || {} };
    }
  }
  return null;
}

function round1(x) { return Math.round(x * 10) / 10; }
function toC(f) { return round1((f - 32) * 5 / 9); }

/* Turns the Fahrenheit/mph sample into what the widget asked for. */
function convertForecast(data, query) {
  var celsius = query.temperature_unit === 'celsius' || query.temperature_unit !== 'fahrenheit';
  var kmh = query.wind_speed_unit !== 'mph';
  var i;
  if (celsius) {
    data.current.temperature_2m = toC(data.current.temperature_2m);
    data.current.apparent_temperature = toC(data.current.apparent_temperature);
    for (i = 0; i < data.hourly.temperature_2m.length; i++) data.hourly.temperature_2m[i] = toC(data.hourly.temperature_2m[i]);
    for (i = 0; i < data.daily.temperature_2m_max.length; i++) {
      data.daily.temperature_2m_max[i] = toC(data.daily.temperature_2m_max[i]);
      data.daily.temperature_2m_min[i] = toC(data.daily.temperature_2m_min[i]);
    }
    data.current_units.temperature_2m = '°C';
    data.current_units.apparent_temperature = '°C';
    data.hourly_units.temperature_2m = '°C';
    data.daily_units.temperature_2m_max = '°C';
    data.daily_units.temperature_2m_min = '°C';
  }
  if (kmh) {
    data.current.wind_speed_10m = round1(data.current.wind_speed_10m * 1.609);
    data.current_units.wind_speed_10m = 'km/h';
  }
  return data;
}

/* The pretend /fetch: same replies as service.js, answered from dev/samples. */
function handleFetch(q, res) {
  var hit = checkFetchUrl(q.url);
  if (!hit) return send(res, 400, { ok: false, error: 'address not allowed' });
  var kind = hit.entry.kind;
  log('fetch ' + hit.entry.host + ' (weather mode: ' + weatherMode + ')');
  function answer() {
    if (weatherMode === 'fail') return send(res, 502, { ok: false, error: 'not reachable' });
    if (weatherMode === 'nolookup' && kind === 'lookup') return send(res, 502, { ok: false, error: 'not reachable' });
    if (weatherMode === 'forecastfail' && kind === 'forecast') return send(res, 502, { ok: false, error: 'HTTP 503' });
    if (weatherMode === 'badjson' && kind === 'forecast') return send(res, 200, { ok: true, data: { latitude: 40.0 } });
    if (weatherMode === 'nogeocode' && kind === 'geocode') return send(res, 200, { ok: true, data: { generationtime_ms: 0.4 } });
    var data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, hit.entry.sample), 'utf8'));
    } catch (e) {
      return send(res, 502, { ok: false, error: 'sample file problem: ' + e.message });
    }
    if (kind === 'forecast') data = convertForecast(data, hit.query);
    send(res, 200, { ok: true, data: data });
  }
  if (weatherMode === 'slow') setTimeout(answer, 6000);
  else answer();
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
  if (p === '/fetch') return handleFetch(q, res);
  if (p === '/preview') {
    if (q.weather !== undefined) {
      if (MODES.indexOf(String(q.weather)) === -1) {
        return send(res, 400, { ok: false, error: 'unknown mode', modes: MODES });
      }
      weatherMode = String(q.weather);
      log('weather mode: ' + weatherMode);
    }
    if (q.lights !== undefined) {
      var lm = String(q.lights);
      if (!mockLights || !liveServer) return send(res, 400, { ok: false, error: 'no sample lights running' });
      var LM = ['ok', 'sengled', 'slow', 'down', 'unauthorized', 'wall-down'];
      if (LM.indexOf(lm) < 0) return send(res, 400, { ok: false, error: 'unknown lights mode', modes: LM });
      mockLights.light('light.example_sengled_1', lm === 'sengled' ? 'unavailable' : 'ok');
      mockLights.mode(lm === 'slow' || lm === 'down' || lm === 'unauthorized' ? lm : 'ok');
      mockLights.wled(lm === 'wall-down' ? 'down' : 'ok');
      liveServer.ambience.poll();
      return send(res, 200, { ok: true, lights: lm });
    }
    if (q.spotify !== undefined) {
      var sp = String(q.spotify);
      if (!mockSpotify || !liveServer) return send(res, 400, { ok: false, error: 'no sample Spotify running' });
      if (sp === 'next') mockSpotify.next();
      else if (!mockSpotify.set(sp)) return send(res, 400, { ok: false, error: 'unknown Spotify mode', modes: mockSpotify.modes.concat(['next']) });
      else spotifyMode = sp;
      log('Spotify mode: ' + sp);
      liveServer.spotify.poll();
    }
    if (q.vibe !== undefined) {
      if (!mockSpotify || !mockSpotify.vibes(String(q.vibe))) {
        return send(res, 400, { ok: false, error: mockSpotify ? 'unknown vibe mode' : 'no sample Spotify running', modes: mockSpotify ? mockSpotify.vibeModes : [] });
      }
      vibeMode = String(q.vibe);
      log('Vibe mode: ' + vibeMode + ' (songs already looked up keep their vibe until the preview restarts)');
    }
    if (q.calendar !== undefined) {
      if (!calendarFeeds || !calendarFeeds.setMode(String(q.calendar))) {
        return send(res, 400, { ok: false, error: calendarFeeds ? 'unknown calendar mode' : 'no sample calendars running' });
      }
      calendarMode = String(q.calendar);
      log('calendar mode: ' + calendarMode + ' (asking the hub server to read again)');
      refreshCalendars();
    }
    return send(res, 200, { ok: true, weather: weatherMode, calendar: calendarMode, spotify: spotifyMode, vibe: vibeMode });
  }
  send(res, 404, { ok: false, error: 'not found' });
});

page.listen(PAGE_PORT, '127.0.0.1', function () {
  log('Hub:      http://127.0.0.1:' + PAGE_PORT + '/');
  log('          add ?motion=fade, ?motion=expand or ?motion=auto to try the animations');
});
service.listen(SERVICE_PORT, '127.0.0.1', function () {
  log('Service:  http://127.0.0.1:' + SERVICE_PORT + ' (pretend service.js)');
  log('Weather:  answers from dev/samples, mode "' + weatherMode + '"');
  log('          switch with /preview?weather=' + MODES.join('|') + ' on the service port');
  log('Keys: arrows to move, Enter for OK, Escape for Back.');
});

/* The hub server from pi/, in the same process, if it's there. */
var liveServer = null;
(function startLive() {
  var file = path.join(__dirname, '..', 'pi', 'server.js');
  if (process.env.HUB_LIVE_PORT === 'off' || !fs.existsSync(file)) return;
  var sample = require('./calendar-sample');
  var feeds = calendarMode === 'off' ? Promise.resolve(null) :
    sample.feedServer({ mode: calendarMode }).catch(function (e) {
      log('Calendar: the sample feeds did not start (' + (e && e.message) + ')');
      return null;
    });
  try { fs.unlinkSync(path.join(LIVE_DATA_DIR, 'spotify.json')); } catch (e) { /* none */ }
  try { fs.unlinkSync(path.join(LIVE_DATA_DIR, 'vibes.json')); } catch (e) { /* none */ }
  var spotifyUp = process.env.HUB_SPOTIFY === 'off' || spotifyMode === 'off' ? Promise.resolve(null) :
    require('./mock-spotify').start({ mode: spotifyMode === 'signin' ? 'playing' : spotifyMode, vibeMode: vibeMode, vibeDelayMs: 1200 }).catch(function () { return null; });
  var lightsUp = process.env.HUB_LIGHTS === 'off' || lightsMode === 'off' ? Promise.resolve(null) :
    require('./mock-lights').start({}).catch(function () { return null; });
  Promise.all([feeds, spotifyUp, lightsUp]).then(function (both) {
    calendarFeeds = both[0];
    mockSpotify = both[1];
    mockLights = both[2];
    // The sample room (or no lights) for Ambience, written before the server reads it.
    try {
      fs.mkdirSync(LIVE_DATA_DIR, { recursive: true });
      var amb = require('../pi/ambience');
      amb.saveConfig(LIVE_DATA_DIR, lightsMode === 'sample'
        ? amb.validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pi', 'ambience.example.json'), 'utf8')))
        : amb.defaultConfig());
    } catch (e) { /* an older pi/ without Ambience */ }
    start(both[0]);
  });
  function start(f) {
  try {
    liveServer = require('../pi/server').start({
      token: LIVE_TOKEN,
      port: LIVE_PORT,
      host: '127.0.0.1',
      origins: ['http://127.0.0.1:' + PAGE_PORT],
      dataDir: LIVE_DATA_DIR,
      calendars: f ? f.calendars : [],
      allowHttp: true,
      timezone: sample.TZ,
      spotifyEnv: mockSpotify ? {
        SPOTIFY_CLIENT_ID: mockSpotify.clientId, SPOTIFY_CLIENT_SECRET: mockSpotify.clientSecret,
        SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:' + LIVE_PORT + '/spotify/callback'
      } : {},
      spotify: { accounts: mockSpotify && mockSpotify.url, api: mockSpotify && mockSpotify.url, vibe: mockSpotify && mockSpotify.url, allowHttp: true,
        playMs: 1500, idleMs: 1500, awayMs: 1500 },
      ambienceEnv: mockLights ? { HA_URL: mockLights.url, HA_TOKEN: mockLights.token, WLED_URL: mockLights.wledUrl } : {},
      ambience: { timeoutMs: 1500, screenMs: 3000, idleMs: 3000 }
    });
    if (mockLights) log('Lights:   sample Home Assistant and plant wall, mode "' + lightsMode + '"; switch with /preview?lights=ok|sengled|slow|down|unauthorized|wall-down');
    signInToMock();
    log('Calendar: ' + (f ? 'sample calendars, mode "' + calendarMode + '"; switch with /preview?calendar=' + sample.MODES.join('|') :
      'none set up (CALENDAR_MODE=off)'));
    var hub = 'http://127.0.0.1:' + LIVE_PORT;
    log('Live:     ' + hub + ' (the Pi\'s hub server, data in ' + path.relative(process.cwd(), LIVE_DATA_DIR) + ')');
    log('          open http://127.0.0.1:' + PAGE_PORT + '/?live=' + hub + ' for live updates');
    log('          then try, in another terminal:');
    log('            HUB_TOKEN=' + LIVE_TOKEN + ' HUB_URL=' + hub + ' node pi/hubctl.js show weather');
    log('            HUB_TOKEN=' + LIVE_TOKEN + ' HUB_URL=' + hub + ' node pi/hubctl.js say "Dinner in 10"');
  } catch (e) {
    log('Live:     the hub server in pi/ did not start (' + (e && e.message) + '); the preview runs without it');
  }
  }
})();

// Signs the hub server in to the stand-in Spotify, as ./hub spotify login does.
function signInToMock() {
  if (!mockSpotify || spotifyMode === 'signin' || !liveServer) return;
  try {
    var l = liveServer.spotify.loginUrl();
    http.get(l.url, function (res) {
      res.resume();
      liveServer.spotify.finishLogin(res.headers.location || '').then(function () {
        log('Spotify:  sample Spotify, mode "' + spotifyMode + '"; switch with /preview?spotify=' + mockSpotify.modes.join('|') + '|next');
      }, function (e) { log('Spotify:  sign-in to the sample failed (' + e.message + ')'); });
    }).on('error', function () { /* the sample is gone */ });
  } catch (e) { log('Spotify:  ' + e.message); }
}

// Asks the hub server to read the calendars again now (the control API).
function refreshCalendars() {
  var req = http.request({
    host: '127.0.0.1', port: LIVE_PORT, path: '/api/calendar/refresh', method: 'POST',
    headers: { Authorization: 'Bearer ' + LIVE_TOKEN, 'Content-Type': 'application/json', 'Content-Length': 2 }
  }, function (res) { res.resume(); });
  req.on('error', function (e) { log('Calendar: refresh failed (' + e.message + ')'); });
  req.end('{}');
}

module.exports = {
  page: page,
  service: service,
  live: function () { return liveServer; }
};
