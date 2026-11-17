/*
 * Weather: today on the tile, the next 12 hours and the week in the panel.
 *
 * Forecasts come from Open-Meteo (free, no account). The place comes from
 * HUB_CONFIG.widgets.weather.location, or, when that is empty, from a public
 * lookup of the TV's internet address. Every remote call goes straight from
 * the page first and through the TV's helper (service.js /fetch) if that
 * fails, and whichever way worked is tried first next time.
 *
 * Times from Open-Meteo are the place's own wall clock ("2026-11-15T09:00").
 * They are never given to Date to parse (old browsers read them as UTC);
 * they are split by hand into Date.UTC numbers and read back with getUTC*.
 */
(window.HUB_WIDGETS = window.HUB_WIDGETS || []).push((function () {
  'use strict';

  var PLACE_KEY = 'homeHub.weather.place';
  var CACHE_KEY = 'homeHub.weather.v1';
  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var LOOKUPS = {
    ipwho: 'https://ipwho.is/',
    geojs: 'https://get.geojs.io/v1/ip/geo.json'
  };

  var MIN = 60000;
  var HOUR = 60 * MIN;
  var REFRESH_EVERY = 20 * MIN;
  var LIVE_FOR = 45 * MIN;        // younger than this is live, older is stale
  var USE_HOURLY_AFTER = 90 * MIN; // older than this, "now" comes from the hourly forecast
  var USABLE_FOR = 24 * HOUR;
  var RETRY_STEPS = [2 * MIN, 5 * MIN, 20 * MIN];
  var HOURS_SHOWN = 12;
  var MINUS = '−';
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  var C = null;              // ctx, kept from init
  var units = 'fahrenheit';
  var place = null;          // { source, provider, name, region, latitude, longitude }
  var placeProblem = null;   // null | 'setup' | 'notfound' | 'nolookup' (no lookup answered)
  var rec = null;            // the forecast record: { savedAt, placeKey, units, via, data }
  var via = 'direct';        // the way that worked last: 'direct' | 'helper'
  var refreshing = false;
  var startedAt = 0;         // when the running update began, for the watchdog
  var phase = 'place';       // what loading is waiting on: 'place' | 'forecast'
  var lastError = '';        // why the last refresh failed ('' after a success)
  var failCount = 0;
  var nextDue = 0;           // TV time of the next scheduled refresh
  var userAction = '';       // '' | 'refresh' | 'relocate' while a button press runs
  var view = 'day';          // Day or Week in panel mode, kept for the session
  var lastSig = '';
  var rootEl = null;         // the panel's root, for switching views without a redraw
  var nowEls = null;         // the now band's parts, to fit it once it is on screen
  var hoursEls = null;       // the hour strip's parts, likewise

  /* ---------- safety ---------- */

  // Wraps a callback the hub does not wrap (XHR, timers, listeners), so an
  // error in it can't escape and stop anything else.
  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        if (window.console && console.warn) console.warn('Weather: ' + (e && e.message));
        return undefined;
      }
    };
  }

  function lsGet(key) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function lsRemove(key) {
    try { if (window.localStorage) window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* ---------- small helpers ---------- */

  function el(tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function icon(name, cls, parent) {
    var node = el('span', 'icon ' + cls, parent);
    node.innerHTML = (window.HUB_ICONS && window.HUB_ICONS[name]) || '';
    return node;
  }

  // A finite number or null.
  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  // Readings outside these ranges are garbage; treat them as missing.
  function tnum(v) { v = num(v); return v !== null && v >= -150 && v <= 150 ? v : null; }
  function wnum(v) { v = num(v); return v !== null && v >= 0 && v <= 500 ? v : null; }
  function pnum(v) { v = num(v); return v !== null && v >= 0 && v <= 100 ? v : null; }

  function str(v) {
    return typeof v === 'string' ? v.replace(/^\s+|\s+$/g, '') : '';
  }

  function isArr(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function at(list, i) {
    return isArr(list) && i >= 0 && i < list.length ? list[i] : null;
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function inRange(lat, lon) {
    return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  /* ---------- time ---------- */

  // "2026-11-15T09:00" (seconds allowed, nothing else after) to a wall clock
  // number (Date.UTC), or NaN. Values out of range are refused, not rolled over.
  function parseTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(typeof s === 'string' ? s : '');
    if (!m || +m[4] > 23 || +m[5] > 59 || (m[6] && +m[6] > 59)) return NaN;
    return calendar(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  // "2026-11-15" exactly, to the wall clock number of its midnight, or NaN.
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    return m ? calendar(+m[1], +m[2], +m[3], 0, 0) : NaN;
  }

  function calendar(y, mo, d, h, mi) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    var t = Date.UTC(y, mo - 1, d, h, mi);
    // Date.UTC rolls 31 November into December; refuse it instead.
    return new Date(t).getUTCDate() === d ? t : NaN;
  }

  function ampm(h, m) {
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
  }

  // The TV's own clock time of a Date.now() value, e.g. "7:10 AM".
  function tvClock(ms) {
    var d = new Date(ms);
    return ampm(d.getHours(), d.getMinutes());
  }

  // A wall clock number as "7:04 AM".
  function wallClock(t) {
    var d = new Date(t);
    return ampm(d.getUTCHours(), d.getUTCMinutes());
  }

  function sameDay(a, b) {
    return Math.floor(a / (24 * HOUR)) === Math.floor(b / (24 * HOUR));
  }

  /* ---------- formatting ---------- */

  function temp(v) {
    v = tnum(v);
    if (v === null) return '–';
    var r = Math.round(v);
    return (r < 0 ? MINUS + (-r) : String(r)) + '°';
  }

  function pct(v) {
    v = pnum(v);
    return v === null ? '–' : Math.round(v) + '%';
  }

  function windText(v) {
    v = wnum(v);
    if (v === null) return '–';
    return Math.round(v) + (units === 'celsius' ? ' km/h' : ' mph');
  }

  /* ---------- weather codes ---------- */

  // code: [day text, night text, day icon, night icon]
  var CODES = {
    0: ['Sunny', 'Clear', 'wx-clear-day', 'wx-clear-night'],
    1: ['Mostly sunny', 'Mostly clear', 'wx-partly-day', 'wx-partly-night'],
    2: ['Partly cloudy', 'Partly cloudy', 'wx-partly-day', 'wx-partly-night'],
    3: ['Cloudy', 'Cloudy', 'wx-cloudy', 'wx-cloudy'],
    45: ['Fog', 'Fog', 'wx-fog', 'wx-fog'],
    48: ['Fog', 'Fog', 'wx-fog', 'wx-fog'],
    51: ['Light drizzle', '', 'wx-drizzle'],
    53: ['Drizzle', '', 'wx-drizzle'],
    55: ['Heavy drizzle', '', 'wx-drizzle'],
    56: ['Freezing drizzle', '', 'wx-drizzle'],
    57: ['Freezing drizzle', '', 'wx-drizzle'],
    61: ['Light rain', '', 'wx-rain'],
    63: ['Rain', '', 'wx-rain'],
    65: ['Heavy rain', '', 'wx-rain'],
    66: ['Freezing rain', '', 'wx-rain'],
    67: ['Freezing rain', '', 'wx-rain'],
    71: ['Light snow', '', 'wx-snow'],
    73: ['Snow', '', 'wx-snow'],
    75: ['Heavy snow', '', 'wx-snow'],
    77: ['Snow grains', '', 'wx-snow'],
    80: ['Light showers', '', 'wx-rain'],
    81: ['Showers', '', 'wx-rain'],
    82: ['Heavy showers', '', 'wx-rain'],
    85: ['Snow showers', '', 'wx-snow'],
    86: ['Snow showers', '', 'wx-snow'],
    95: ['Thunderstorm', '', 'wx-storm'],
    96: ['Thunderstorm with hail', '', 'wx-storm'],
    99: ['Thunderstorm with hail', '', 'wx-storm']
  };

  function condition(code, isDay) {
    code = num(code);
    var row = code === null ? null : CODES[code];
    if (!row) return { text: '', icon: 'wx-cloudy' };
    var night = num(isDay) === 0;
    return {
      text: (night && row[1]) || row[0],
      icon: (night && row[3]) || row[2]
    };
  }

  /* ---------- fetching ---------- */

  // The helper is missing or too old to have /fetch.
  function helperAbsent(err) {
    return err === 'service not reachable' || err === 'not found' || err === 'HTTP 404';
  }

  // GET a remote JSON address, one way then the other. check(data) returns
  // '' when the reply is usable, otherwise why not (that counts as a failure,
  // so the other way gets a go). cb(err, data, way, answered): answered is
  // true when some way did get a reply, but check() refused it.
  function fetchJSON(url, check, cb) {
    var order = via === 'helper' ? ['helper', 'direct'] : ['direct', 'helper'];
    var errors = {};
    var answered = false;
    function attempt(i) {
      if (i >= order.length) {
        var err = helperAbsent(errors.helper) ? (errors.direct || errors.helper) : errors.helper;
        return cb(err, null, '', answered);
      }
      var way = order[i];
      var done = safe(function (err, data) {
        try {
          if (way === 'helper' && !err) data = data && data.data;
          if (!err) {
            err = check(data);
            if (err) answered = true;
          }
        } catch (e) {
          err = 'unexpected reply';
          answered = true;
        }
        if (err) {
          errors[way] = err;
          return attempt(i + 1);
        }
        via = way;
        cb('', data, way);
      });
      if (way === 'direct') C.getJSON(url, 8000, done);
      else C.service('/fetch?url=' + encodeURIComponent(url), 12000, done);
    }
    attempt(0);
  }

  /* ---------- the place ---------- */

  // Place names are data; a 250-character one must not run out of the panel.
  function cap(v) {
    v = str(v);
    return v.length > 40 ? str(v.substring(0, 40)) + '…' : v;
  }

  function placeKeyOf(p) {
    return p ? p.latitude + ',' + p.longitude : '';
  }

  function placeLabel(p) {
    if (!p) return '';
    return p.name + (p.region && p.region !== p.name ? ', ' + p.region : '');
  }

  // Works out the place from config.js and what's saved, without the network.
  // Returns true when it knows the place.
  function placeFromSaved() {
    var loc = C.config.location;
    if (loc && typeof loc === 'object') {
      var lat = num(loc.latitude);
      var lon = num(loc.longitude);
      if (inRange(lat, lon)) {
        place = { source: 'coords', name: cap(loc.name) || 'Home', region: '', latitude: lat, longitude: lon };
        return true;
      }
      placeProblem = 'notfound';
      return false;
    }
    var query = str(loc);
    var saved = validPlace(lsGet(PLACE_KEY));
    if (query) {
      if (saved && saved.source === 'config' && saved.query === query) { place = saved; return true; }
      return false;
    }
    if (saved && saved.source === 'lookup') { place = saved; return true; }
    return false;
  }

  function validPlace(p) {
    if (!p || typeof p !== 'object') return null;
    var lat = num(p.latitude);
    var lon = num(p.longitude);
    var name = cap(p.name);
    if (!name || !inRange(lat, lon)) return null;
    return {
      source: p.source === 'config' ? 'config' : 'lookup',
      provider: p.provider === 'geojs' ? 'geojs' : 'ipwho',
      query: str(p.query),
      name: name,
      region: cap(p.region),
      latitude: lat,
      longitude: lon,
      savedAt: num(p.savedAt) || 0
    };
  }

  // Looks the configured city name up once. cb(err) where err is '' (found),
  // 'notfound', or a network reason.
  function geocode(cb) {
    var query = str(C.config.location);
    var comma = query.indexOf(',');
    var city = str(comma >= 0 ? query.substring(0, comma) : query);
    var hint = comma >= 0 ? str(query.substring(comma + 1)).toLowerCase() : '';
    var url = GEOCODE + '?name=' + encodeURIComponent(city) + '&count=10&language=en&format=json';
    fetchJSON(url, function (data) {
      return data && typeof data === 'object' && !data.error ? '' : 'unexpected reply';
    }, function (err, data) {
      if (err) return cb(err);
      var results = isArr(data.results) ? data.results : [];
      var pick = null;
      var first = null;
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (!r || !str(r.name) || !inRange(num(r.latitude), num(r.longitude))) continue;
        if (!first) first = r;
        if (!hint) break;
        var fields = [r.admin1, r.country, r.country_code];
        for (var j = 0; j < fields.length; j++) {
          if (str(fields[j]).toLowerCase().indexOf(hint) !== -1) { pick = r; break; }
        }
        if (pick) break;
      }
      pick = pick || first;
      if (!pick) return cb('notfound');
      place = {
        source: 'config', provider: 'ipwho', query: query, name: cap(pick.name),
        region: cap(pick.admin1) || cap(pick.country),
        latitude: num(pick.latitude), longitude: num(pick.longitude), savedAt: Date.now()
      };
      lsSet(PLACE_KEY, place);
      cb('');
    });
  }

  // One city lookup service. cb(err, place, answered) as fetchJSON.
  function lookupOne(provider, cb) {
    fetchJSON(LOOKUPS[provider], function (data) {
      return readLookup(provider, data) ? '' : 'no city in the reply';
    }, function (err, data, way, answered) {
      cb(err, err ? null : readLookup(provider, data), answered);
    });
  }

  function readLookup(provider, d) {
    if (!d || typeof d !== 'object') return null;
    if (provider === 'ipwho' && d.success !== true) return null;
    var lat = provider === 'geojs' ? parseFloat(d.latitude) : num(d.latitude);
    var lon = provider === 'geojs' ? parseFloat(d.longitude) : num(d.longitude);
    lat = num(lat);
    lon = num(lon);
    var city = cap(d.city);
    if (!city || !inRange(lat, lon)) return null;
    return {
      source: 'lookup', provider: provider, name: city, region: cap(d.region),
      latitude: round2(lat), longitude: round2(lon), savedAt: Date.now()
    };
  }

  // Asks the lookup services in order until one names a city.
  // cb(err, place, answered): answered is true when a service did reply but
  // named no usable city (as opposed to no service being reachable at all).
  function lookupCity(first, cb) {
    var order = first === 'geojs' ? ['geojs', 'ipwho'] : ['ipwho', 'geojs'];
    lookupOne(order[0], function (err, p, answered) {
      if (!err) return cb('', p, false);
      lookupOne(order[1], function (err2, p2, answered2) {
        cb(err2 ? err : '', p2, answered || answered2);
      });
    });
  }

  // Makes sure the place is known. cb(err): '' when it is.
  function ensurePlace(cb) {
    if (place) return cb('');
    if (placeProblem === 'notfound' && typeof C.config.location === 'object' && C.config.location) return cb('notfound');
    phase = 'place';
    redraw();
    if (str(C.config.location)) {
      return geocode(function (err) {
        placeProblem = err === 'notfound' ? 'notfound' : null;
        cb(err);
      });
    }
    lookupCity('ipwho', function (err, p, answered) {
      if (err) {
        // A reply without a city means the lookup can't place this TV: ask for
        // a city. No reply at all is a network problem: keep trying.
        placeProblem = answered ? 'setup' : 'nolookup';
        return cb(err);
      }
      placeProblem = null;
      place = p;
      lsSet(PLACE_KEY, p);
      cb('');
    });
  }

  /* ---------- the forecast ---------- */

  function forecastUrl(p) {
    var c = units === 'celsius';
    return FORECAST + '?latitude=' + p.latitude + '&longitude=' + p.longitude +
      '&current=temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      '&temperature_unit=' + (c ? 'celsius' : 'fahrenheit') + '&wind_speed_unit=' + (c ? 'kmh' : 'mph') +
      '&timezone=auto&forecast_days=7';
  }

  // All arrays present, the same length as their time list, and every time
  // readable by parse (parseTime for hours, parseDate for days).
  function columnsOk(block, keys, minLen, parse) {
    if (!block || typeof block !== 'object' || !isArr(block.time) || block.time.length < minLen) return false;
    var n = block.time.length;
    for (var i = 0; i < keys.length; i++) {
      if (!isArr(block[keys[i]]) || block[keys[i]].length !== n) return false;
    }
    for (var j = 0; j < n; j++) {
      if (isNaN(parse(block.time[j]))) return false;
    }
    return true;
  }

  // '' when the reply is a forecast we can draw, otherwise why not.
  function checkForecast(d) {
    if (!d || typeof d !== 'object') return 'unexpected reply';
    if (d.error) return str(d.reason) || 'the service refused';
    if (!d.current || typeof d.current !== 'object' || isNaN(parseTime(d.current.time))) return 'incomplete reply';
    if (!columnsOk(d.hourly, ['temperature_2m', 'precipitation_probability', 'weather_code', 'is_day'], 2, parseTime)) return 'incomplete reply';
    if (!columnsOk(d.daily, ['weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'precipitation_probability_max', 'sunrise', 'sunset'], 1, parseDate)) return 'incomplete reply';
    // The hourly data must cover the reply's own "now", or nothing could be shown.
    if (hourIndex(d, parseTime(d.current.time)) < 0) return 'incomplete reply';
    return '';
  }

  function loadCache() {
    var c = lsGet(CACHE_KEY);
    if (!c || typeof c !== 'object' || num(c.savedAt) === null) return null;
    if (c.placeKey !== placeKeyOf(place) || c.units !== units) return null;
    if (checkForecast(c.data)) return null;
    if (c.via === 'helper' || c.via === 'direct') via = c.via;
    return c;
  }

  // cb(err, record) with a new forecast record for place p.
  function fetchForecast(p, cb) {
    phase = 'forecast';
    redraw();
    fetchJSON(forecastUrl(p), checkForecast, function (err, data, way) {
      if (err) return cb(err, null);
      cb('', { savedAt: Date.now(), placeKey: placeKeyOf(p), units: units, via: way, data: data });
    });
  }

  function keep(r) {
    rec = r;
    lsSet(CACHE_KEY, r);
  }

  // Bookkeeping after an update: when to try next.
  function settle(err) {
    if (err) {
      lastError = err;
      failCount++;
      nextDue = Date.now() + RETRY_STEPS[Math.min(failCount, RETRY_STEPS.length) - 1];
    } else {
      lastError = '';
      failCount = 0;
      nextDue = Date.now() + REFRESH_EVERY;
    }
  }

  // The whole update: place if needed, then the forecast. cb(err) after the
  // state is updated. Never two at once.
  function refresh(cb) {
    if (refreshing) return;
    refreshing = true;
    startedAt = Date.now();
    var finish = safe(function (err) {
      refreshing = false;
      settle(err);
      if (cb) cb(err);
      redraw(true);
    });
    ensurePlace(safe(function (err) {
      if (err) return finish(err);
      fetchForecast(place, function (err2, r) {
        if (r) keep(r);
        finish(err2);
      });
    }));
  }

  /* ---------- what to show ---------- */

  function ageOf(r) {
    return Math.max(0, Date.now() - r.savedAt);
  }

  // The place's wall clock now: the forecast's "current" time plus the time since it was saved.
  function locNow(r) {
    return parseTime(r.data.current.time) + ageOf(r);
  }

  // Index of the hour that holds t, or -1 when t is past the end of the data.
  function hourIndex(d, t) {
    var times = d.hourly.time;
    var last = parseTime(times[times.length - 1]);
    if (t >= last + HOUR) return -1;
    for (var i = times.length - 1; i >= 0; i--) {
      if (parseTime(times[i]) <= t) return i;
    }
    return 0;
  }

  function dayIndex(d, t) {
    var times = d.daily.time;
    for (var i = times.length - 1; i >= 0; i--) {
      if (parseDate(times[i]) <= t) return i;
    }
    return 0;
  }

  // The forecast, if it is still worth showing.
  function usable() {
    if (!rec || ageOf(rec) > USABLE_FOR) return null;
    return hourIndex(rec.data, locNow(rec)) >= 0 ? rec : null;
  }

  // 'loading' | 'live' | 'stale' | 'setup' | 'notfound' | 'lookuperror' | 'error'
  function stateNow() {
    var r = usable();
    if (r) return ageOf(r) < LIVE_FOR ? 'live' : 'stale';
    if (placeProblem === 'setup' && !place) return 'setup';
    if (placeProblem === 'notfound') return 'notfound';
    if (placeProblem === 'nolookup' && !place && lastError) return 'lookuperror';
    if (lastError) return 'error';
    return 'loading';
  }

  // Everything the tile and panel draw, worked out once.
  function model() {
    var r = usable();
    if (!r) return null;
    var d = r.data;
    var now = locNow(r);
    var hi = hourIndex(d, now);
    var di = dayIndex(d, now);
    var age = ageOf(r);
    var h = d.hourly;
    var cur = d.current;
    var fromHourly = age > USE_HOURLY_AFTER;
    var m = {
      sample: d.sample === true,
      stale: age >= LIVE_FOR,
      asOf: tvClock(r.savedAt),
      hourIdx: hi,
      dayIdx: di,
      fromHourly: fromHourly
    };
    var today = new Date(now);
    m.date = LONG_DAYS[today.getUTCDay()] + ', ' + MONTHS[today.getUTCMonth()] + ' ' + today.getUTCDate();
    var code = fromHourly ? at(h.weather_code, hi) : cur.weather_code;
    var isDay = fromHourly ? at(h.is_day, hi) : cur.is_day;
    var forced = sceneQuery('wxscene');
    if (forced) {
      var fs = sceneSpec({ code: code, isDay: isDay !== 0, wind: null, twilight: '' }, forced);
      code = fs.code;
      isDay = fs.day ? 1 : 0;
    }
    var cond = condition(code, isDay);
    m.temp = fromHourly ? tnum(at(h.temperature_2m, hi)) : tnum(cur.temperature_2m);
    m.text = cond.text;
    m.icon = cond.icon;
    m.code = code;
    m.isDay = isDay !== 0;
    // "Feels like" belongs to the old reading, so it goes once the hourly forecast takes over.
    m.feels = fromHourly ? null : tnum(cur.apparent_temperature);
    m.wind = wnum(cur.wind_speed_10m);
    m.hi = tnum(at(d.daily.temperature_2m_max, di));
    m.lo = tnum(at(d.daily.temperature_2m_min, di));
    var rise = parseTime(at(d.daily.sunrise, di));
    var set = parseTime(at(d.daily.sunset, di));
    // Within 40 minutes of sunrise or sunset the sky is dawn or dusk coloured.
    var nowMs = now;
    m.twilight = '';
    if (!isNaN(rise) && Math.abs(nowMs - rise) <= 40 * MIN) m.twilight = 'dawn';
    else if (!isNaN(set) && Math.abs(nowMs - set) <= 40 * MIN) m.twilight = 'dusk';
    m.sunrise = isNaN(rise) ? '–' : wallClock(rise);
    m.sunset = isNaN(set) ? '–' : wallClock(set);

    // Chance of rain for the rest of today: the wettest hour left, else the day's figure.
    var rain = null;
    for (var i = hi; i < h.time.length; i++) {
      if (!sameDay(parseTime(h.time[i]), now)) break;
      var p = pnum(at(h.precipitation_probability, i));
      if (p !== null && (rain === null || p > rain)) rain = p;
    }
    m.rain = rain !== null ? rain : pnum(at(d.daily.precipitation_probability_max, di));

    m.hours = [];
    for (var k = hi; k < h.time.length && m.hours.length < HOURS_SHOWN; k++) {
      var t = new Date(parseTime(h.time[k])).getUTCHours();
      var hc = condition(at(h.weather_code, k), at(h.is_day, k));
      m.hours.push({
        now: k === hi,
        hour: t % 12 === 0 ? '12' : String(t % 12),
        ampm: t < 12 ? 'AM' : 'PM',
        icon: hc.icon,
        temp: tnum(at(h.temperature_2m, k)),
        rain: pnum(at(h.precipitation_probability, k))
      });
    }
    // The current hour shows the big reading when that is fresher.
    if (m.hours.length && !fromHourly && m.temp !== null) m.hours[0].temp = m.temp;
    if (m.hours.length && !fromHourly) m.hours[0].icon = m.icon;

    m.days = [];
    for (var j = di; j < d.daily.time.length && m.days.length < 7; j++) {
      var dt = new Date(parseDate(d.daily.time[j]));
      var dc = condition(at(d.daily.weather_code, j), 1);
      m.days.push({
        name: j === di ? 'Today' : DAY_NAMES[dt.getUTCDay()],
        date: String(dt.getUTCDate()),
        icon: dc.icon,
        text: dc.text,
        lo: tnum(at(d.daily.temperature_2m_min, j)),
        hi: tnum(at(d.daily.temperature_2m_max, j)),
        rain: pnum(at(d.daily.precipitation_probability_max, j))
      });
    }
    return m;
  }

  // A short summary of what the tile would show, to redraw only on change.
  function signature() {
    var s = stateNow();
    var m = model();
    var line = s + '|' + phase + '|' + lastError + '|' + placeLabel(place) + '|' + (refreshing ? 1 : 0) + '|' + userAction;
    if (m) line += '|' + m.hourIdx + '|' + m.dayIdx + '|' + m.stale + '|' + m.fromHourly + '|' + m.asOf;
    if (s === 'error' || s === 'lookuperror') line += '|' + nextDue;
    return line;
  }

  // Redraws what changed. force: redraw even if the signature is the same.
  function redraw(force) {
    if (!C) return;
    var sig = signature();
    if (!force && sig === lastSig) return;
    lastSig = sig;
    C.redrawTile();
    if (C.isOpen()) C.redrawPanel();
  }

  function rainClass(v) {
    return num(v) !== null && v >= 30 ? ' is-wet' : '';
  }

  /* ---------- message states ---------- */

  // Network reasons can be long ("getaddrinfo ENOTFOUND …"); the tile is small.
  function reason() {
    return lastError.length > 40 ? str(lastError.substring(0, 40)) + '…' : lastError;
  }

  // line is the panel's text. short is the tile's: the tile is small, so it
  // gets one brief sentence and leaves the reason and the advice to the panel.
  function message(state) {
    if (state === 'setup') {
      return { head: 'Set your city', line: 'The TV couldn’t work out where it is. Add a city to weather.location in config.js.',
        short: 'Add a city to weather.location in config.js.', button: 'Try again', icon: 'wx-pin' };
    }
    if (state === 'notfound') {
      var loc = C.config.location;
      var name = typeof loc === 'object' && loc ? 'the spot in config.js' : str(loc);
      return { head: 'City not found', line: 'Couldn’t find “' + name + '”. Check weather.location in config.js.',
        short: 'Check weather.location in config.js.', icon: 'wx-pin' };
    }
    if (state === 'lookuperror') {
      return { head: 'Can’t find your city yet', line: 'The city lookup didn’t answer (' + reason() + '). Trying again at ' + tvClock(nextDue) +
        '. To skip the lookup, add a city to weather.location in config.js.',
        short: 'Trying again at ' + tvClock(nextDue) + '.', button: 'Try now', icon: 'wx-pin' };
    }
    if (state === 'error') {
      return { head: 'No forecast right now', line: 'The weather service didn’t answer (' + reason() + '). Trying again at ' + tvClock(nextDue) + '.',
        short: 'Trying again at ' + tvClock(nextDue) + '.', button: 'Try now', icon: 'wx-cloudy' };
    }
    return { head: phase === 'place' && !place ? 'Finding your city…' : 'Getting the forecast…', line: '', short: '', icon: 'wx-partly-day' };
  }

  /* ---------- tile ---------- */

  // A one-row strip: temperature, icon and condition on one line; a wide
  // strip adds the high, low and rain on the right.
  function drawStrip(body, size) {
    var m = model();
    var root = el('div', 'wx-tile wx-strip', body);
    if (!m) {
      el('div', 'wx-strip-cond', root, message(stateNow()).head);
      return;
    }
    el('div', 'wx-strip-temp', root, temp(m.temp));
    icon(m.icon, 'wx-strip-icon', root);
    el('div', 'wx-strip-cond', root, m.text || '');
    if (size.width === 'wide') {
      var range = el('div', 'wx-range wx-strip-range', root);
      el('span', 'wx-hl-key', range, 'H');
      el('span', 'wx-hl-val', range, temp(m.hi));
      el('span', 'wx-hl-key wx-hl-gap', range, 'L');
      el('span', 'wx-hl-val', range, temp(m.lo));
      var rain = el('div', 'wx-rain' + rainClass(m.rain), root);
      icon('wx-drop', 'wx-rain-icon', rain);
      el('span', 'wx-rain-val', rain, pct(m.rain));
    }
  }

  // A tall tile: the next few hours in a row, each with its icon.
  function drawTileHours(root, m, size) {
    var hours = m.hours || [];
    var want = size.width === 'wide' ? 8 : size.width === 'narrow' ? 3 : 5;
    var row = el('div', 'wx-tile-hours', root);
    for (var i = 0; i < hours.length && i < want; i++) {
      var h = hours[i];
      var col = el('div', 'wx-th' + (h.now ? ' is-now' : ''), row);
      el('div', 'wx-th-hour', col, h.now ? 'Now' : h.hour + ' ' + h.ampm);
      icon(h.icon, 'wx-th-icon', col);
      el('div', 'wx-th-temp', col, temp(h.temp));
    }
    if (!row.firstChild) root.removeChild(row);
  }

  function drawTile(body) {
    var size = C && C.size ? C.size() : null;
    if (size && size.tier === 'strip') return drawStrip(body, size);
    var state = stateNow();
    var m = model();
    var root = el('div', 'wx-tile', body);
    var top = el('div', 'wx-tile-top', root);
    el('div', 'wx-label', top, m && place ? place.name : 'Weather');
    if (m && m.stale) el('div', 'wx-asof', top, 'as of ' + m.asOf);
    else if (m && m.sample) el('div', 'wx-tag', top, 'Sample');

    if (!m) {
      var msg = message(state);
      el('div', 'wx-msg-head', root, msg.head);
      if (msg.short) el('div', 'wx-msg-line', root, msg.short);
      icon(msg.icon, 'wx-mark', root);
      return;
    }

    var now = el('div', 'wx-tile-now', root);
    el('div', 'wx-tile-temp', now, temp(m.temp));
    icon(m.icon, 'wx-tile-icon', now);
    if (m.text) el('div', 'wx-tile-cond', root, m.text);
    if (size && size.tier === 'tall') drawTileHours(root, m, size);

    var foot = el('div', 'wx-tile-foot', root);
    var range = el('div', 'wx-range', foot);
    el('span', 'wx-hl-key', range, 'H');
    el('span', 'wx-hl-val', range, temp(m.hi));
    el('span', 'wx-hl-key wx-hl-gap', range, 'L');
    el('span', 'wx-hl-val', range, temp(m.lo));
    var rain = el('div', 'wx-rain' + rainClass(m.rain), foot);
    icon('wx-drop', 'wx-rain-icon', rain);
    el('span', 'wx-rain-val', rain, pct(m.rain));
  }

  /* ---------- panel ---------- */

  function sub() {
    if (!place) return '';
    var m = model();
    if (!m) return placeLabel(place);
    return placeLabel(place) + ' · ' + (m.stale ? 'As of ' : 'Updated ') + m.asOf;
  }

  function button(parent, key, label, iconName, extra) {
    var b = el('div', 'wx-btn f' + (extra || ''), parent);
    b.setAttribute('data-key', key);
    if (iconName) icon(iconName, 'wx-btn-icon', b);
    el('span', 'wx-btn-label', b, label);
    return b;
  }

  function drawBar(root, state, full) {
    var bar = el('div', 'wx-bar', root);
    var left = el('div', 'wx-bar-left', bar);
    var hasForecast = state === 'live' || state === 'stale';
    if (hasForecast && !full) {
      var day = button(left, 'tab-day', 'Day', '', ' wx-tab' + (view === 'day' ? ' is-selected' : ''));
      var week = button(left, 'tab-week', 'Week', '', ' wx-tab' + (view === 'week' ? ' is-selected' : ''));
      (view === 'week' ? week : day).setAttribute('data-autofocus', '');
    } else if (hasForecast) {
      // The hub's head already names the place; here, the place's own date.
      var m = model();
      if (m) el('div', 'wx-bar-date', left, m.date);
    }
    var right = el('div', 'wx-bar-right', bar);
    var busy = refreshing;
    if (hasForecast) {
      button(right, 'refresh', userAction === 'refresh' || (busy && userAction !== 'relocate') ? 'Updating…' : 'Update now', 'wx-refresh');
      if (place && place.source === 'lookup') {
        button(right, 'relocate', userAction === 'relocate' ? 'Looking…' : 'Wrong city?', 'wx-pin');
      }
    } else if (state === 'setup' || state === 'error' || state === 'lookuperror') {
      var b = button(right, 'retry', busy ? 'Trying…' : message(state).button, 'wx-refresh');
      b.setAttribute('data-autofocus', '');
    }
  }

  function footer(root, m) {
    el('div', 'wx-foot', root, (m && m.sample ? 'Sample data, not a live forecast · ' : '') + 'Weather data by Open-Meteo.com');
  }

  function drawNow(parent, m) {
    var band = el('div', 'wx-now', parent);
    var main = el('div', 'wx-now-main', band);
    el('div', 'wx-now-temp', main, temp(m.temp));
    icon(m.icon, 'wx-now-icon', main);
    var words = el('div', 'wx-now-words', main);
    if (m.text) el('div', 'wx-now-cond', words, m.text);
    if (m.feels !== null) el('div', 'wx-now-feels', words, 'Feels like ' + temp(m.feels));

    var stats = el('div', 'wx-stats', band);
    stat(stats, windText(m.wind), 'wx-wind', 'Wind', '');
    stat(stats, pct(m.rain), 'wx-drop', 'Rain today', rainClass(m.rain));
    stat(stats, m.sunrise, 'wx-sunrise', 'Sunrise', '');
    stat(stats, m.sunset, 'wx-sunset', 'Sunset', '');
    nowEls = { band: band, words: words, temp: main.firstChild, cond: words.firstChild && words.firstChild.className === 'wx-now-cond' ? words.firstChild : null };
  }

  // Four stats in a row leave little room beside the temperature. When the
  // words don't fit there (a longer language, a long condition), the stats
  // fold into two rows of two. Measured, because only the screen knows.
  function fitNow() {
    var n = nowEls;
    if (!n || !n.band.parentNode || !n.band.offsetWidth) return;
    n.band.className = 'wx-now';
    var tight = n.band.scrollWidth > n.band.clientWidth + 1 || n.words.offsetHeight > n.temp.offsetHeight + 1;
    if (tight) n.band.className = 'wx-now is-tight';
    fitWord(n);
  }

  // A condition word wider than its room ("Thunderstorm", a long Spanish word)
  // gets a smaller size instead of being cut in two.
  function fitWord(n) {
    var c = n.cond;
    if (!c) return;
    c.style.fontSize = '';
    c.style.wordWrap = 'normal';
    var size = parseFloat(getComputedStyle(c).fontSize) || 0;
    for (var i = 0; i < 4 && size && c.scrollWidth > c.clientWidth + 1; i++) {
      size = size * 0.9;
      c.style.fontSize = size + 'px';
    }
    c.style.wordWrap = '';
  }

  // Without room for a readable curve (a two-line head, a folded now band,
  // long text), the temperatures become a plain row and the curve goes.
  function fitHours() {
    var h = hoursEls;
    if (!h || !h.strip.parentNode || !h.strip.offsetWidth) return;
    h.strip.className = 'wx-hours';
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    if (h.plot.offsetHeight < 2.4 * rem) h.strip.className = 'wx-hours is-flat';
  }

  function fitDay() {
    fitNow();
    fitHours();
  }

  function stat(parent, value, iconName, label, extra) {
    var s = el('div', 'wx-stat' + extra, parent);
    var val = el('div', 'wx-stat-val', s);
    // "7:04 AM": the time leads, AM/PM smaller.
    var m = /^(.*) (AM|PM)$/.exec(value);
    if (m) {
      el('span', '', val, m[1]);
      el('span', 'wx-stat-ampm', val, ' ' + m[2]);
    } else {
      val.textContent = value;
    }
    var lab = el('div', 'wx-stat-label', s);
    icon(iconName, 'wx-stat-icon', lab);
    el('span', 'wx-stat-text', lab, label);
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (attrs.hasOwnProperty(k)) node.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  // A smooth line through the points that never overshoots them: each
  // segment's control points stay between its two ends' heights.
  function smoothPath(pts) {
    var d = 'M' + pts[0].x + ' ' + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i > 0 ? i - 1 : i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      var lo = Math.min(p1.y, p2.y);
      var hiY = Math.max(p1.y, p2.y);
      var c1y = Math.max(lo, Math.min(hiY, p1.y + (p2.y - p0.y) / 6));
      var c2y = Math.max(lo, Math.min(hiY, p2.y - (p3.y - p1.y) / 6));
      d += 'C' + (p1.x + (p2.x - p0.x) / 6).toFixed(1) + ' ' + c1y.toFixed(1) + ' ' +
        (p2.x - (p3.x - p1.x) / 6).toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2.x + ' ' + p2.y.toFixed(1);
    }
    return d;
  }

  function drawHours(parent, m) {
    var hours = m.hours;
    var n = hours.length;
    var strip = el('div', 'wx-hours', parent);
    var top = el('div', 'wx-hrow wx-hrow-top', strip);
    var i;
    for (i = 0; i < n; i++) {
      var col = el('div', 'wx-hcol' + (hours[i].now ? ' is-now' : ''), top);
      var label = el('div', 'wx-hour', col);
      if (hours[i].now) label.textContent = 'Now';
      else {
        el('span', 'wx-hour-num', label, hours[i].hour);
        el('span', 'wx-hour-ampm', label, ' ' + hours[i].ampm);
      }
      icon(hours[i].icon, 'wx-hour-icon', col);
    }

    // The curve: an honest scale from the lowest to the highest of these hours.
    var lo = Infinity;
    var hi = -Infinity;
    for (i = 0; i < n; i++) {
      if (hours[i].temp === null) continue;
      if (hours[i].temp < lo) lo = hours[i].temp;
      if (hours[i].temp > hi) hi = hours[i].temp;
    }
    var zone = el('div', 'wx-curve', strip);
    var plot = el('div', 'wx-plot', zone);
    hoursEls = { strip: strip, plot: plot };
    if (lo !== Infinity) {
      var W = n * 100;
      var pts = [];
      for (i = 0; i < n; i++) {
        if (hours[i].temp === null) continue;
        var f = hi > lo ? (hours[i].temp - lo) / (hi - lo) : 0.5;
        pts.push({ x: i * 100 + 50, y: (1 - f) * 100, f: f, i: i });
      }
      var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' 100', preserveAspectRatio: 'none', 'class': 'wx-curve-svg' }, plot);
      var line = smoothPath(pts);
      // The soft fill under the line fades out downward. Only one curve is
      // ever on screen, so a fixed id is safe.
      var grad = svgEl('linearGradient', { id: 'wx-curve-grad', x1: '0', y1: '0', x2: '0', y2: '1' }, svgEl('defs', {}, svg));
      svgEl('stop', { offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '0.12' }, grad);
      svgEl('stop', { offset: '1', 'stop-color': '#ffffff', 'stop-opacity': '0' }, grad);
      svgEl('path', { d: line + 'L' + pts[pts.length - 1].x + ' 130L' + pts[0].x + ' 130Z', 'class': 'wx-curve-fill', fill: 'url(#wx-curve-grad)' }, svg);
      svgEl('path', { d: line, 'class': 'wx-curve-line' }, svg);
    }
    // One number per hour, in order, so they also work as a plain row when
    // there is no room for the curve (see fitHours). On the curve each rides
    // just above its point; a missing one sits at the bottom as a dash.
    for (i = 0; i < n; i++) {
      var t = hours[i].temp;
      var f2 = t === null ? 0 : (hi > lo ? (t - lo) / (hi - lo) : 0.5);
      var label2 = el('div', 'wx-ctemp' + (hours[i].now ? ' is-now' : ''), plot, temp(t));
      label2.style.left = (i / n * 100) + '%';
      label2.style.width = (100 / n) + '%';
      label2.style.bottom = (f2 * 100) + '%';
      if (hours[i].now && t !== null) {
        var dot = el('div', 'wx-dot', plot);
        dot.style.left = ((i + 0.5) / n * 100) + '%';
        dot.style.top = ((1 - f2) * 100) + '%';
      }
    }

    var bottom = el('div', 'wx-hrow wx-hrow-rain', strip);
    for (i = 0; i < n; i++) {
      var r = hours[i].rain;
      var cell = el('div', 'wx-hcol wx-hrain' + rainClass(r) + (r === null || r < 5 ? ' is-dry' : ''), bottom);
      cell.textContent = r === null || r < 5 ? '–' : pct(r);
    }
  }

  // full: the condition goes under the day name, since rows are taller there.
  function drawWeek(parent, m, full) {
    var week = el('div', 'wx-week', parent);
    var lo = Infinity;
    var hi = -Infinity;
    var i;
    for (i = 0; i < m.days.length; i++) {
      if (m.days[i].lo !== null && m.days[i].lo < lo) lo = m.days[i].lo;
      if (m.days[i].hi !== null && m.days[i].hi > hi) hi = m.days[i].hi;
    }
    var span = hi > lo ? hi - lo : 1;
    for (i = 0; i < m.days.length; i++) {
      var d = m.days[i];
      var row = el('div', 'wx-day' + (i === 0 ? ' is-today' : ''), week);
      var lead = full ? el('div', 'wx-day-lead', row) : row;
      var name = el('div', 'wx-day-name', lead);
      el('span', 'wx-day-dow', name, d.name);
      el('span', 'wx-day-date', name, d.date);
      if (full) {
        el('div', 'wx-day-cond', lead, d.text);
        icon(d.icon, 'wx-day-icon', row);
      } else {
        icon(d.icon, 'wx-day-icon', row);
        el('div', 'wx-day-cond', row, d.text);
      }
      var rain = el('div', 'wx-day-rain' + rainClass(d.rain), row);
      icon('wx-drop', 'wx-day-drop', rain);
      el('span', 'wx-day-pct', rain, pct(d.rain));
      el('div', 'wx-day-lo', row, temp(d.lo));
      var track = el('div', 'wx-track', row);
      if (d.lo !== null && d.hi !== null && lo !== Infinity) {
        var a = (d.lo - lo) / span;
        var b = (d.hi - lo) / span;
        var fill = el('div', 'wx-fill', track);
        fill.style.left = (a * 100) + '%';
        fill.style.width = (Math.max(b - a, 0.02) * 100) + '%';
        // The gradient spans the whole track; the fill shows its own slice of it.
        var w = Math.max(b - a, 0.02);
        fill.style.backgroundSize = (100 / w) + '% 100%';
        fill.style.backgroundPosition = (w < 1 ? (a / (1 - w)) * 100 : 0) + '% 0';
      }
      el('div', 'wx-day-hi', row, temp(d.hi));
    }
  }

  function drawPanel(body, ctx) {
    var full = ctx.mode() === 'full';
    var state = stateNow();
    var m = model();
    nowEls = null;
    hoursEls = null;
    rootEl = el('div', 'wx-panel ' + (full ? 'is-full' : 'is-' + view), body);
    ctx.setSub(sub());
    drawBar(rootEl, state, full);
    var main = el('div', 'wx-main', rootEl);
    if (m) {
      var dayView = el('div', 'wx-view wx-view-day', main);
      drawNow(dayView, m);
      drawHours(dayView, m);
      if (full) el('div', 'wx-split', main);
      var weekView = el('div', 'wx-view wx-view-week', main);
      drawWeek(weekView, m, full);
    } else {
      var msg = message(state);
      var box = el('div', 'wx-msg', main);
      el('div', 'wx-msg-big', box, msg.head);
      if (msg.line) el('div', 'wx-msg-text', box, msg.line);
      icon(msg.icon, 'wx-mark wx-mark-panel', main);
    }
    footer(rootEl, m);
    if (!full) fitNow();
    fitHours();
  }

  // Switches Day and Week by a class, without a redraw.
  function showView(next) {
    view = next;
    if (!rootEl || !rootEl.parentNode) return;
    if (rootEl.className.indexOf('is-full') !== -1) return;
    rootEl.className = 'wx-panel is-' + next;
    if (next === 'day') fitDay();
    var tabs = rootEl.querySelectorAll('.wx-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-key') === 'tab-' + next;
      if (on) tabs[i].classList.add('is-selected');
      else tabs[i].classList.remove('is-selected');
    }
  }

  /* ---------- buttons ---------- */

  function updateNow() {
    if (refreshing) return;
    var before = rec;
    userAction = 'refresh';
    refresh(function (err) {
      userAction = '';
      if (err && before && usable()) {
        C.toast('Couldn’t update (' + err + '). Showing the forecast from ' + tvClock(before.savedAt) + '.', 5000);
      }
    });
    redraw(true);
  }

  // Forget the looked-up city and ask again, the other service first.
  function relocate() {
    if (refreshing || !place || place.source !== 'lookup') return;
    var old = place;
    userAction = 'relocate';
    refreshing = true;
    startedAt = Date.now();
    redraw(true);
    lsRemove(PLACE_KEY);
    function done() {
      refreshing = false;
      userAction = '';
      redraw(true);
    }
    lookupCity(old.provider === 'geojs' ? 'ipwho' : 'geojs', safe(function (err, p) {
      if (err) {
        lsSet(PLACE_KEY, old);
        C.toast('Couldn’t reach the city lookup (' + err + '). Still showing ' + old.name + '.', 6000);
        return done();
      }
      if (p.name.toLowerCase() === old.name.toLowerCase()) {
        // Keep the coordinates the forecast was made for, but remember who answered.
        old.provider = p.provider;
        lsSet(PLACE_KEY, old);
        C.toast('The lookup still says ' + p.name + '. To set it yourself, add a city to weather.location in config.js.', 7000);
        return done();
      }
      // A different city: keep the old place and forecast until the new
      // forecast is in, and keep them if it doesn't come.
      fetchForecast(p, safe(function (err2, r) {
        if (err2 || !r) {
          lsSet(PLACE_KEY, old);
          C.toast('Couldn’t get the forecast for ' + p.name + ' (' + (err2 || 'no answer') + '). Still showing ' + old.name + '.', 6000);
          return done();
        }
        place = p;
        lsSet(PLACE_KEY, p);
        keep(r);
        settle('');
        done();
      }));
    }));
  }

  /* ---------- timers ---------- */

  // The TV's clock can jump back (a wrong time fixed by the network). Then a
  // refresh scheduled by the old time would wait far too long, and a forecast
  // "saved in the future" would look fresh forever. Either one means: due now.
  function clockJumped() {
    var now = Date.now();
    return nextDue - now > REFRESH_EVERY || (rec && rec.savedAt - now > MIN) ||
      (refreshing && startedAt - now > MIN);
  }

  function tick() {
    if (clockJumped()) {
      nextDue = 0;
      if (rec && rec.savedAt > Date.now()) rec.savedAt = Date.now() - REFRESH_EVERY;
      // An update already running keeps going; restart its watchdog on the new clock.
      if (refreshing) startedAt = Date.now();
    }
    // Every call has its own timeout, so an update stuck this long lost its
    // callback to an error somewhere. Let the next one run.
    if (refreshing && Math.abs(Date.now() - startedAt) > 3 * MIN) {
      refreshing = false;
      userAction = '';
    }
    if (!document.hidden && !refreshing && Date.now() >= nextDue) refresh();
    else redraw();
  }

  function onVisible() {
    pauseTile();
    if (document.hidden) return;
    if (clockJumped()) {
      nextDue = 0;
      if (rec && rec.savedAt > Date.now()) rec.savedAt = Date.now() - REFRESH_EVERY;
      // An update already running keeps going; restart its watchdog on the new clock.
      if (refreshing) startedAt = Date.now();
    }
    if (refreshing) return;
    var due = rec ? ageOf(rec) >= REFRESH_EVERY || Date.now() >= nextDue : Date.now() >= nextDue;
    if (due) refresh();
    else redraw();
  }


  /* ---------- living scene ---------- */

  // A quiet picture of the weather behind the tile and the panel: drifting
  // clouds, rain and snow sheets, a sun with slow rays, stars, fog, lightning.
  // Only transform and opacity ever animate, and each kind is a handful of
  // layers (the rain is three sheets of a repeating picture, not hundreds of
  // drops). If the TV can't keep up, the picture stays but stands still.
  var SCENE_KEY = 'homeHub.weather.scene';
  var SCENE_PROBE_MS = 1600;
  var SCENE_MIN_FPS = 30;
  var SCENE_TRUST_MS = 6 * HOUR;   // how long a measured result is believed
  var scene = {
    calm: false,      // true: the picture stands still
    why: '',          // 'slow' | 'fade' | 'config' | 'URL' | '' (moving)
    fps: 0,
    probing: false,
    probed: false,
    source: 'auto'    // 'auto' | 'config' | 'URL'
  };
  var tileSceneEl = null;
  var panelSceneEl = null;

  function sceneQuery(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  // The condition behind the picture: a kind and how much of it (1 to 3).
  function sceneOf(code) {
    var c = num(code);
    if (c === null) return { kind: 'cloudy', level: 2 };
    if (c === 0) return { kind: 'clear', level: 1 };
    if (c === 1) return { kind: 'clear', level: 2 };
    if (c === 2) return { kind: 'partly', level: 2 };
    if (c === 3) return { kind: 'cloudy', level: 3 };
    if (c === 45 || c === 48) return { kind: 'fog', level: 2 };
    if (c >= 51 && c <= 57) return { kind: 'drizzle', level: c === 51 ? 1 : c === 53 ? 2 : 3 };
    if (c === 61 || c === 80) return { kind: 'rain', level: 1 };
    if (c === 63 || c === 81 || c === 66) return { kind: 'rain', level: 2 };
    if (c === 65 || c === 82 || c === 67) return { kind: 'rain', level: 3 };
    if (c === 71 || c === 77 || c === 85) return { kind: 'snow', level: 1 };
    if (c === 73 || c === 86) return { kind: 'snow', level: 2 };
    if (c === 75) return { kind: 'snow', level: 3 };
    if (c >= 95) return { kind: 'storm', level: 3 };
    return { kind: 'cloudy', level: 2 };
  }

  // What the picture shows now, from the model (or a test override).
  function sceneSpec(m, forced) {
    var o = forced || sceneQuery('wxscene');
    var code = m.code;
    var day = m.isDay;
    var wind = m.wind;
    var twi = m.twilight || '';
    if (o) {
      // Preview: ?wxscene=rain-3, snow-2-night, storm-wind, clear-dusk, partly-day
      var bits = o.split('-');
      var table = { clear: 0, mostlyclear: 1, partly: 2, cloudy: 3, fog: 45, drizzle: 53, rain: 63,
        snow: 73, storm: 95 };
      if (table.hasOwnProperty(bits[0])) code = table[bits[0]];
      for (var i = 1; i < bits.length; i++) {
        var b = bits[i];
        if (b === 'night') day = false;
        else if (b === 'day') { day = true; twi = ''; }
        else if (b === 'wind') wind = 24;
        else if (b === 'dawn' || b === 'dusk') twi = b;
        else if (/^[123]$/.test(b)) {
          var base = bits[0];
          var pick = { drizzle: [51, 53, 55], rain: [61, 63, 65], snow: [71, 73, 75] }[base];
          if (pick) code = pick[+b - 1];
        }
      }
    }
    var s = sceneOf(code);
    s.code = code;
    s.day = day !== false;
    s.twilight = !s.day && twi === 'dawn' ? '' : twi;
    // Wind carries the clouds faster and slants the rain (mph, or km/h on Celsius).
    var mph = wind === null ? 0 : (units === 'celsius' ? wind / 1.609 : wind);
    s.wind = mph >= 28 ? 2 : mph >= 14 ? 1 : 0;
    return s;
  }

  function rnd(i, salt) {
    var x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // A picture that repeats: a tile of random-looking streaks, flakes or stars.
  // Made once per look and kept as a data address.
  var tileCache = {};
  function pattern(kind, count, salt, w, h) {
    var key = kind + count + '-' + salt + '-' + w + 'x' + h;
    if (tileCache[key]) return tileCache[key];
    var out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';
    for (var i = 0; i < count; i++) {
      var x = 14 + rnd(i, salt) * (w - 28);
      var y = 34 + rnd(i, salt + 7) * (h - 68);
      var o = (0.35 + rnd(i, salt + 3) * 0.6).toFixed(2);
      if (kind === 'rain') {
        var len = 14 + rnd(i, salt + 5) * 16;
        out += '<line x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + (x - len * 0.12).toFixed(1) + '" y2="' + (y + len).toFixed(1) +
          '" stroke="#a8d4ff" stroke-width="0.9" stroke-linecap="round" opacity="' + o + '"/>';
      } else if (kind === 'snow') {
        out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (1.1 + rnd(i, salt + 5) * 1.6).toFixed(1) +
          '" fill="#ffffff" opacity="' + o + '"/>';
      } else {
        out += '<circle cx="' + x.toFixed(1) + '" cy="' + (rnd(i, salt + 7) * h * 0.7).toFixed(1) + '" r="' + (0.8 + rnd(i, salt + 5) * 1.2).toFixed(1) +
          '" fill="#fff6dc" opacity="' + o + '"/>';
      }
    }
    out += '</svg>';
    tileCache[key] = 'url("data:image/svg+xml,' + encodeURIComponent(out) + '")';
    return tileCache[key];
  }

  var RAYS = null;
  function raysImage() {
    if (RAYS) return RAYS;
    var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="100">' +
      '<stop offset="0.1" stop-color="#ffd166" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/>' +
      '</radialGradient></defs>';
    for (var i = 0; i < 16; i++) {
      var a = i * Math.PI / 8;
      var len = i % 2 ? 70 : 100;
      var a1 = a - 0.05;
      var a2 = a + 0.05;
      out += '<path d="M0 0L' + (Math.cos(a1) * len).toFixed(1) + ' ' + (Math.sin(a1) * len).toFixed(1) + 'L' +
        (Math.cos(a2) * len).toFixed(1) + ' ' + (Math.sin(a2) * len).toFixed(1) + 'Z" fill="url(#g)"/>';
    }
    out += '</svg>';
    RAYS = 'url("data:image/svg+xml,' + encodeURIComponent(out) + '")';
    return RAYS;
  }

  function cssAnim(node, name, seconds, shift, extra) {
    // A negative delay joins the loop where the clock says it is, so redrawing
    // the picture never restarts it.
    var phase = ((Date.now() / 1000) + shift * seconds) % seconds;
    var v = name + ' ' + seconds.toFixed(1) + 's ' + (extra || 'linear') + ' ' + (-phase).toFixed(2) + 's infinite';
    node.style.webkitAnimation = v;
    node.style.animation = v;
  }

  // One sheet of falling streaks or flakes. Its size is in the stylesheet
  // (wx-sheet-rain-0 ...), where its keyframes travel exactly one picture high,
  // so the loop has no seam. i: 0 far, 1 middle, 2 near.
  function sheet(root, kind, level, i, seconds, salt, tilt) {
    var wrap = el('div', 'wx-wrap wx-wrap-' + kind, root);
    var s = el('div', 'wx-sheet wx-sheet-' + kind + '-' + i, wrap);
    var counts = kind === 'rain' ? [5, 8, 12] : [4, 7, 10];
    s.style.backgroundImage = pattern(kind, counts[level - 1], salt, 120, 160);
    cssAnim(s, 'wx-fall-' + kind + '-' + i, seconds, 0);
    if (kind === 'snow') cssAnim(wrap, 'wx-sway', 6 + i * 2.2, rnd(i, 4), 'ease-in-out');
    if (tilt) {
      var css = 'rotate(' + tilt + 'deg)';
      wrap.style.webkitTransform = css;
      wrap.style.transform = css;
    }
    return wrap;
  }

  function cloud(root, i, dark, seconds, top, size) {
    var c = el('div', 'wx-cloud wx-cloud-' + (i % 3) + (dark ? ' is-dark' : ''), root);
    c.style.top = top + '%';
    c.style.width = size + '%';
    cssAnim(c, 'wx-drift', seconds, rnd(i, 9));
    return c;
  }

  function buildScene(spec, big) {
    var root = document.createElement('div');
    root.className = 'wx-scene wx-sc-' + spec.kind + ' ' + (spec.day ? 'is-day' : 'is-night') +
      (spec.twilight ? ' is-' + spec.twilight : '') + (big ? ' wx-scene-panel' : ' wx-scene-tile') +
      (scene.calm ? ' is-calm' : '');
    root.setAttribute('aria-hidden', 'true');
    el('div', 'wx-sky', root);
    var k = spec.kind;
    var windFast = spec.wind === 2 ? 0.45 : spec.wind === 1 ? 0.7 : 1;
    var i;

    // Sun, or moon and stars: behind the clouds.
    if (k === 'clear' || k === 'partly') {
      if (spec.day) {
        var rays = el('div', 'wx-sun-rays', root);
        cssAnim(rays, 'wx-turn', 180, 0);
        rays.style.backgroundImage = raysImage();
        var sun = el('div', 'wx-sun', root);
        cssAnim(sun, 'wx-glow', 7, 0, 'ease-in-out');
        if (k === 'partly') sun.className += ' is-dim';
      } else {
        for (i = 0; i < 2; i++) {
          var st = el('div', 'wx-stars wx-stars-' + i, root);
          st.style.backgroundImage = pattern('star', big ? 22 : 14, 40 + i * 9, 120, 160);
          cssAnim(st, 'wx-twinkle', 3.4 + i * 2.1, i * 0.5, 'ease-in-out');
        }
        el('div', 'wx-moon', root);
      }
    }
    // Clouds.
    var clouds = { clear: spec.level > 1 ? 1 : 0, partly: 3, cloudy: 4, fog: 2, drizzle: 3, rain: 4, snow: 3, storm: 5 }[k];
    var dark = k === 'storm' || k === 'rain';
    for (i = 0; i < clouds; i++) {
      var secs = (big ? 62 : 74) * windFast * (0.8 + rnd(i, 21) * 0.7);
      cloud(root, i, dark && (k === 'storm' || i % 2 === 0), secs, -6 + rnd(i, 23) * 46, 52 + rnd(i, 25) * 30);
    }

    // Fog: slow banks.
    if (k === 'fog') {
      for (i = 0; i < 3; i++) {
        var f = el('div', 'wx-fogbank wx-fogbank-' + i, root);
        cssAnim(f, 'wx-bank', 38 + i * 17, i * 0.3, 'ease-in-out');
      }
    }

    // Rain and drizzle: three sheets at three depths, slanted by the wind.
    if (k === 'rain' || k === 'drizzle' || k === 'storm') {
      var lvl = k === 'drizzle' ? Math.max(1, spec.level - 1) : spec.level;
      var pace = (lvl === 1 ? 1.35 : lvl === 2 ? 1.1 : 0.9) * (k === 'drizzle' ? 1.5 : 1) * (spec.wind ? 0.85 : 1);
      var tilt = (k === 'drizzle' ? 3 : 7) + spec.wind * 8;
      sheet(root, 'rain', lvl, 0, 0.62 * pace, 3, tilt);
      sheet(root, 'rain', lvl, 1, 0.5 * pace, 11, tilt);
      if (k !== 'drizzle') sheet(root, 'rain', lvl, 2, 0.42 * pace, 19, tilt);
    }
    if (k === 'snow') {
      sheet(root, 'snow', spec.level, 0, 3.4, 5, 0);
      sheet(root, 'snow', spec.level, 1, 3.6, 15, 0);
      sheet(root, 'snow', spec.level, 2, 3.8, 25, 0);
    }
    if (k === 'storm') {
      for (i = 0; i < 2; i++) {
        var flash = el('div', 'wx-flash wx-flash-' + i, root);
        var bolt = el('div', 'wx-bolt wx-bolt-' + i, root);
        bolt.innerHTML = '<svg viewBox="0 0 40 100" preserveAspectRatio="none"><path d="M26 0L10 46h11L8 100l26-60H22L32 0z" fill="#fff8d6" stroke="rgba(170,190,255,0.6)" stroke-width="3" stroke-linejoin="round"/></svg>';
        cssAnim(flash, 'wx-strike', i ? 14.3 : 10.7, i ? 0.35 : 0.05);
        cssAnim(bolt, 'wx-strike', i ? 14.3 : 10.7, i ? 0.35 : 0.05);
      }
    }

    // Wind: a few streaks across the top.
    if (spec.wind && k !== 'rain' && k !== 'drizzle' && k !== 'storm') {
      for (i = 0; i < 3; i++) {
        var g = el('div', 'wx-gust wx-gust-' + i, root);
        cssAnim(g, 'wx-gust', (spec.wind === 2 ? 3.4 : 5.2) + i * 1.3, rnd(i, 31));
      }
    }
    return root;
  }

  function sceneSig(spec, big) {
    return spec.kind + spec.level + (spec.day ? 'd' : 'n') + spec.twilight + spec.wind + (big ? 'P' : 'T') + (scene.calm ? 'c' : 'm');
  }

  // Puts the picture for spec into host (the tile or the panel box), reusing
  // the one already there when nothing changed.
  function placeScene(host, spec, big) {
    var old = big ? panelSceneEl : tileSceneEl;
    var sig = sceneSig(spec, big);
    if (old && old.parentNode === host && old.getAttribute('data-sig') === sig) return old;
    removeScene(big);
    var node = buildScene(spec, big);
    node.setAttribute('data-sig', sig);
    host.insertBefore(node, host.firstChild);
    if (big) panelSceneEl = node; else tileSceneEl = node;
    return node;
  }

  function removeScene(big) {
    var node = big ? panelSceneEl : tileSceneEl;
    if (big) panelSceneEl = null; else tileSceneEl = null;
    if (!node) return;
    var host = node.parentNode;
    if (host) host.removeChild(node);
  }

  // The tile's picture sits under the tile's text; the panel's, under the panel's.
  function showScene(body, big) {
    try {
      var m = model();
      if (!m || scene.off || !body.parentNode) { removeScene(big); return; }
      placeScene(body.parentNode, sceneSpec(m), big);
      pauseTile();
    } catch (e) {
      removeScene(big);
      if (window.console && console.warn) console.warn('Weather picture: ' + (e && e.message));
    }
  }

  // While the panel is open the tile is hidden behind it, so it stands still.
  function pauseTile() {
    if (!tileSceneEl) return;
    var paused = !!panelSceneEl || (document.hidden === true);
    var has = tileSceneEl.className.indexOf(' is-paused') !== -1;
    if (paused && !has) tileSceneEl.className += ' is-paused';
    else if (!paused && has) tileSceneEl.className = tileSceneEl.className.replace(' is-paused', '');
  }

  function setCalm(calm, why, fps) {
    if (scene.calm === calm && scene.why === why) { scene.fps = fps || scene.fps; return; }
    scene.calm = calm;
    scene.why = why;
    if (fps) scene.fps = fps;
    var nodes = [tileSceneEl, panelSceneEl];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      var on = nodes[i].className.indexOf(' is-calm') !== -1;
      if (calm && !on) nodes[i].className += ' is-calm';
      else if (!calm && on) nodes[i].className = nodes[i].className.replace(' is-calm', '');
      nodes[i].setAttribute('data-sig', nodes[i].getAttribute('data-sig').replace(/[cm]$/, calm ? 'c' : 'm'));
    }
  }

  // How the picture is allowed to run: settings first, then what the TV said
  // about its motion, then what the TV showed the last time it was measured.
  function sceneChoice() {
    var q = sceneQuery('weatherscene');
    var set = C && C.config ? C.config.scene : null;
    var wanted = q || set;
    if (wanted === 'off' || wanted === false) { scene.off = true; scene.source = q ? 'URL' : 'config'; return; }
    scene.off = false;
    if (wanted === 'calm' || wanted === 'still') { scene.source = q ? 'URL' : 'config'; setCalm(true, scene.source, 0); return; }
    if (wanted === 'full' || wanted === 'moving') { scene.source = q ? 'URL' : 'config'; setCalm(false, '', 0); scene.probed = true; return; }
    scene.source = 'auto';
    var saved = lsGet(SCENE_KEY);
    if (saved && saved.build === window.HUB_BUILD && Date.now() - saved.at < SCENE_TRUST_MS && Date.now() - saved.at >= 0) {
      scene.probed = true;
      scene.fps = saved.fps || 0;
      scene.calm = !!saved.calm;
      scene.why = saved.calm ? 'slow' : '';
    }
  }

  // Measures how many frames a second the page really draws with the picture
  // moving, once, a little after the page has settled. Under SCENE_MIN_FPS,
  // or when the hub already fell back to plain fades, the picture stands still.
  function probeScene() {
    if (scene.probed || scene.probing || scene.off || !window.requestAnimationFrame || !tileSceneEl) return;
    if (document.body.className.indexOf('motion-fade') !== -1) {
      scene.probed = true;
      setCalm(true, 'fade', 0);
      return;
    }
    scene.probing = true;
    var frames = 0;
    var started = 0;
    var worst = 0;
    var last = 0;
    function step(t) {
      if (document.hidden) { scene.probing = false; return; }
      if (!started) started = t;
      else if (last) worst = Math.max(worst, t - last);
      last = t;
      frames++;
      if (t - started < SCENE_PROBE_MS) { window.requestAnimationFrame(step); return; }
      scene.probing = false;
      scene.probed = true;
      var fps = Math.round((frames - 1) * 1000 / (t - started));
      var slow = fps < SCENE_MIN_FPS;
      setCalm(slow, slow ? 'slow' : '', fps);
      lsSet(SCENE_KEY, { build: window.HUB_BUILD, calm: slow, fps: fps, at: Date.now() });
    }
    window.requestAnimationFrame(step);
  }

  // For the About panel, which only has a line for it when something is off: a
  // picture that is moving is plain to see, so it says nothing, unless all is true.
  function sceneStatus(all) {
    if (scene.off) return 'Off' + (scene.source === 'auto' ? '' : ' (' + scene.source + ')');
    var m = null;
    try { m = model(); } catch (e) { m = null; }
    if (!m) return '';
    if (scene.calm) {
      var why = scene.why === 'slow' ? 'this TV drew ' + scene.fps + ' frames a second' :
        scene.why === 'fade' ? 'the hub is on plain fades' : 'set to calm (' + scene.source + ')';
      return 'Still, ' + why;
    }
    if (!all) return '';
    return 'Moving' + (scene.fps ? ', ' + scene.fps + ' frames a second' : (scene.source === 'auto' ? ', measuring' : ' (' + scene.source + ')'));
  }

  /* ---------- widget ---------- */

  function fallbackText(body, text) {
    try {
      body.innerHTML = '';
      el('div', 'wx-msg-line wx-broken', body, text);
    } catch (e) { /* nothing more to do */ }
  }

  return {
    id: 'weather',
    title: 'Weather',
    icon: 'sun-cloud',
    expandable: true,
    head: false,

    init: function (ctx) {
      C = ctx;
      sceneChoice();
      units = ctx.config.units === 'celsius' ? 'celsius' : 'fahrenheit';
      // Draw from the cache at once if there is one, then update in the background.
      if (placeFromSaved()) rec = loadCache();
      lastSig = signature();
      setInterval(safe(tick), MIN);
      if (document.addEventListener) document.addEventListener('visibilitychange', safe(onVisible));
      // After the hub has drawn every tile, so the first paint isn't held up.
      setTimeout(safe(function () { refresh(); }), 0);
      // The speed check waits until the page has settled and the picture is up.
      setTimeout(safe(probeScene), 6000);
    },

    // For the About panel: how the picture is running.
    sceneStatus: sceneStatus,

    renderTile: function (body, ctx) {
      C = ctx;
      try {
        drawTile(body);
        showScene(body, false);
      } catch (e) {
        if (window.console && console.warn) console.warn('Weather tile: ' + (e && e.message));
        fallbackText(body, 'The weather couldn’t be shown.');
      }
    },

    renderPanel: function (body, ctx) {
      C = ctx;
      try {
        drawPanel(body, ctx);
        showScene(body, true);
      } catch (e) {
        if (window.console && console.warn) console.warn('Weather panel: ' + (e && e.message));
        rootEl = null;
        fallbackText(body, 'The weather couldn’t be shown.');
      }
    },

    onFocus: function (target) {
      var key = target.getAttribute('data-key');
      if (key === 'tab-day' && view !== 'day') showView('day');
      else if (key === 'tab-week' && view !== 'week') showView('week');
    },

    onSelect: function (target) {
      var key = target.getAttribute('data-key');
      if (key === 'tab-day') showView('day');
      else if (key === 'tab-week') showView('week');
      else if (key === 'refresh' || key === 'retry') updateNow();
      else if (key === 'relocate') relocate();
    },

    onMode: function (mode, ctx) {
      ctx.redrawPanel();
    },

    onClose: function () {
      rootEl = null;
      removeScene(true);
      pauseTile();
    },

    // The weather now, for app/clay.js: { code, temp, wind, isDay, units }
    // from the forecast already on the TV, or null. Read-only; never fetches.
    current: function () {
      try {
        var r = usable();
        if (!r) return null;
        var d = r.data;
        var hi = hourIndex(d, locNow(r));
        var fromHourly = ageOf(r) > USE_HOURLY_AFTER;
        return {
          code: num(fromHourly ? at(d.hourly.weather_code, hi) : d.current.weather_code),
          temp: fromHourly ? tnum(at(d.hourly.temperature_2m, hi)) : tnum(d.current.temperature_2m),
          wind: wnum(d.current.wind_speed_10m),
          isDay: num(fromHourly ? at(d.hourly.is_day, hi) : d.current.is_day) !== 0,
          units: units
        };
      } catch (e) {
        return null;
      }
    }
  };
})());
