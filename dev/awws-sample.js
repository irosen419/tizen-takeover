/*
 * Sample data for the A World Worth Saving tiles: the screenshots, the tests
 * and a laptop preview. Everything is made up (schools, titles, numbers).
 *
 * Three small iCal feeds served the way Google would serve them, for the
 * Pi's real calendar reader (pi/calendar.js):
 *   "School Visits"         three visits about 15, 16 and 25 days out
 *   "A World Worth Saving"  project dates this week and next
 *   "Family"                unrelated, to prove the tiles filter by name
 * Titles carry accents (Río Niño, Año Nuevo, Árbol) and one is very long on
 * purpose. And the snapshot from pi/fixtures/awws-sample.json, optionally
 * moved to another day. Only what ships with Node is used.
 *
 *   const sample = require('./awws-sample');
 *   sample.feedServer({ today: () => '2026-11-16' }).then((feeds) => {
 *     feeds.calendars        // [{ name, url, details, color }] for server.start({ calendars })
 *     feeds.setMode('fail')  // sample | empty | fail | novisits
 *     feeds.close()
 *   });
 *   sample.snapshot({ today: '2026-11-16', sentAt: '2026-11-16T13:10:00Z' })
 *
 * From the command line it prints the snapshot moved to today:
 *   node dev/awws-sample.js | HUB_TOKEN=... node pi/hubctl.js awws set -
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const TZ = 'America/Chicago';
const MODES = ['sample', 'empty', 'fail', 'novisits'];
const FIXTURE = path.join(__dirname, '..', 'pi', 'fixtures', 'awws-sample.json');
const FIXTURE_DAY = '2026-11-16';   // the day the fixture's dates were written around

function pad(n) { return (n < 10 ? '0' : '') + n; }

// 'YYYY-MM-DD' plus k days, as 'YYYYMMDD'.
function dayPlus(today, k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + k));
  return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate());
}

function chicagoToday(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(ms === undefined ? Date.now() : ms));
}

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

function vevent(cal, i, today, e) {
  const lines = ['BEGIN:VEVENT', 'UID:' + cal + '-' + i + '@sample.test', 'DTSTAMP:20261101T120000Z'];
  if (e.allDay) {
    lines.push('DTSTART;VALUE=DATE:' + dayPlus(today, e.d));
    lines.push('DTEND;VALUE=DATE:' + dayPlus(today, e.d + (e.days || 1)));
  } else {
    lines.push('DTSTART;TZID=' + TZ + ':' + dayPlus(today, e.d) + 'T' + e.start + '00');
    lines.push('DTEND;TZID=' + TZ + ':' + dayPlus(today, e.d) + 'T' + e.end + '00');
  }
  lines.push('SUMMARY:' + esc(e.title));
  if (e.where) lines.push('LOCATION:' + esc(e.where));
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function feed(name, cal, today, events) {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Home Hub sample//EN', 'X-WR-CALNAME:' + name, 'X-WR-TIMEZONE:' + TZ];
  events.forEach((e, i) => out.push(vevent(cal, i, today, e)));
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

const CALENDARS = [
  { name: 'School Visits', path: '/visits.ics', color: 'green' },
  { name: 'A World Worth Saving', path: '/awws.ics', color: 'teal' },
  { name: 'Family', path: '/family.ics' }
];

// Days are counted from "today" (0). With today Monday 16 November 2026,
// the first visit is Tuesday 1 December.
function events() {
  return {
    '/visits.ics': [
      { d: 15, start: '1215', end: '1400', title: 'Maple Grove Elementary', where: 'Library, Room 4' },
      { d: 16, start: '0930', end: '1100', title: 'Río Niño Academy', where: 'Gym, Calle Ñandú 12' },
      { d: 25, start: '1300', end: '1500',
        title: 'Cedar Hollow Elementary: second-grade reading assembly and the whole-school otter puppet show',
        where: 'Auditorium, 400 Cedar Hollow Road' }
    ],
    '/awws.ics': [
      { d: 0, start: '1400', end: '1500', title: 'Call with the illustrator about Año Nuevo', where: 'Video call' },
      { d: 2, allDay: true, title: 'Pip and the Reef: layout due' },
      { d: 3, start: '1000', end: '1030', title: 'Newsletter goes out' },
      { d: 5, start: '1100', end: '1230', title: 'Bookstore reading: Luma the Otter', where: 'Libros Árbol, Main St' },
      { d: 8, allDay: true, title: 'Printer proof arrives' },
      { d: 10, start: '1800', end: '1900', title: 'Teacher webinar: reading with otters' },
      { d: 12, start: '0900', end: '0945', title: 'Señora Peña’s class Q&A (video)' }
    ],
    '/family.ics': [
      { d: 0, start: '1700', end: '1800', title: 'Family: soccer practice', where: 'Fair Park field 3' },
      { d: 1, allDay: true, title: 'Family: Grandma visiting' },
      { d: 4, start: '1900', end: '2100', title: 'Family: dinner out' },
      { d: 15, start: '1800', end: '1900', title: 'Family: piano recital' }
    ]
  };
}

/*
 * opts.today: () => 'YYYY-MM-DD' (default: today in Chicago).
 * Resolves { calendars, setMode(mode), mode(), close() }.
 */
function feedServer(opts) {
  opts = opts || {};
  const todayOf = opts.today || (() => chicagoToday());
  let mode = MODES.indexOf(opts.mode) >= 0 ? opts.mode : 'sample';
  const srv = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    const cal = CALENDARS.find((c) => c.path === p);
    if (!cal) { res.writeHead(404); return res.end('not found'); }
    if (mode === 'fail' && p === '/visits.ics') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('nope');
    }
    let list = mode === 'empty' ? [] : events()[p];
    if (mode === 'novisits' && p === '/visits.ics') list = [];
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=UTF-8' });
    res.end(feed(cal.name, CALENDARS.indexOf(cal) + 1, todayOf(), list));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(opts.port || 0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      resolve({
        calendars: CALENDARS.map((c) => ({ name: c.name, url: base + c.path, details: 'show', color: c.color || '' })),
        setMode: (m) => { if (MODES.indexOf(m) < 0) return false; mode = m; return true; },
        mode: () => mode,
        close: () => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); })
      });
    });
  });
}

// Moves every date and time in the snapshot by whole days.
function shift(value, days) {
  if (!days) return value;
  if (Array.isArray(value)) return value.map((v) => shift(v, days));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = shift(value[k], days);
    return out;
  }
  if (typeof value !== 'string') return value;
  let m = /^(\d{4})-(\d{2})-(\d{2})T(.*)Z$/.exec(value);
  if (m) {
    const t = Date.parse(value) + days * 86400000;
    return new Date(t).toISOString().replace(/\.000Z$/, 'Z');
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days)).toISOString().slice(0, 10);
  return value;
}

/*
 * The snapshot from pi/fixtures/awws-sample.json, as the Pi keeps it.
 * opts.today: 'YYYY-MM-DD' moves its dates to that day (default: as written,
 * for Monday 16 November 2026). opts.sentAt: another sentAt.
 * opts.receivedAt: the Pi's time it was stored (default: sentAt plus 12 s).
 */
function snapshot(opts) {
  opts = opts || {};
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let days = 0;
  if (opts.today) days = Math.round((Date.parse(opts.today + 'T00:00:00Z') - Date.parse(FIXTURE_DAY + 'T00:00:00Z')) / 86400000);
  const snap = shift(raw, days);
  if (opts.sentAt) snap.sentAt = opts.sentAt;
  snap.receivedAt = opts.receivedAt || new Date(Date.parse(snap.sentAt) + 12000).toISOString().replace(/\.\d+Z$/, 'Z');
  return snap;
}

/*
 * Starts the Pi's hub server in a child process with its clock set to
 * opts.at (UTC ms), see dev/awws-pi.js. opts: { at, port, token, origins,
 * dataDir, calendars, timezone }. Resolves { close() }.
 */
function startPi(opts) {
  const childProcess = require('child_process');
  const options = Object.assign({ host: '127.0.0.1', allowHttp: true, timezone: TZ }, opts);
  const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'awws-pi.js'), JSON.stringify(options)],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('the hub server did not start')), 10000);
    child.on('exit', (code) => reject(new Error('the hub server stopped (' + code + ')')));
    child.stdout.on('data', (c) => {
      out += c;
      if (/ready/.test(out)) {
        clearTimeout(timer);
        resolve({
          close: () => new Promise((r) => {
            child.removeAllListeners('exit');
            child.on('exit', () => r());
            child.kill('SIGTERM');
          })
        });
      }
    });
  });
}

module.exports = { feedServer, snapshot, startPi, chicagoToday, MODES, TZ, CALENDARS };

// node dev/awws-sample.js: prints the sample snapshot moved to today, sent a
// minute ago, for ./hub awws set - (or node pi/hubctl.js awws set -).
if (require.main === module) {
  const sent = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const snap = snapshot({ today: chicagoToday(), sentAt: sent });
  delete snap.receivedAt;
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
}
