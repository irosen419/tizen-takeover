/*
 * Sample calendars for the laptop preview and the screenshots.
 *
 * Makes four small iCal feeds (Family, Ian, Work as "busy only", Holidays)
 * with events placed around a given day, and a tiny web server that serves
 * them to the Pi's real calendar reader (pi/calendar.js), the way Google
 * would. Titles include accents (Ángel, Ñandú, Évènement) and one very long
 * title on purpose. Only what ships with Node is used.
 *
 *   const sample = require('./calendar-sample');
 *   sample.feedServer({ today: () => '2026-11-15' }).then((feeds) => {
 *     feeds.calendars        // [{ name, url, details }] for server.start({ calendars })
 *     feeds.setMode('fail')  // sample | empty | fail | partial | many
 *     feeds.close()
 *   });
 */
'use strict';

const http = require('http');

const TZ = 'America/Chicago';
const MODES = ['sample', 'empty', 'fail', 'partial', 'many'];

function pad(n) { return (n < 10 ? '0' : '') + n; }

// 'YYYY-MM-DD' plus k days, as 'YYYYMMDD'.
function dayPlus(today, k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + k));
  return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate());
}

// Today's date in Chicago for a moment (default now).
function chicagoToday(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(ms === undefined ? Date.now() : ms));
}

function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

// One event: { d, start: 'HHMM', end: 'HHMM', endD } or { d, allDay, days }.
function vevent(cal, i, today, e) {
  const lines = ['BEGIN:VEVENT', 'UID:' + cal + '-' + i + '@sample.test', 'DTSTAMP:20261101T120000Z'];
  if (e.allDay) {
    lines.push('DTSTART;VALUE=DATE:' + dayPlus(today, e.d));
    lines.push('DTEND;VALUE=DATE:' + dayPlus(today, e.d + (e.days || 1)));
  } else {
    lines.push('DTSTART;TZID=' + TZ + ':' + dayPlus(today, e.d) + 'T' + e.start + '00');
    lines.push('DTEND;TZID=' + TZ + ':' + dayPlus(today, e.endD === undefined ? e.d : e.endD) + 'T' + e.end + '00');
  }
  if (e.rrule) lines.push('RRULE:' + e.rrule);
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
  { name: 'Family', path: '/family.ics' },
  { name: 'Ian', path: '/ian.ics' },
  { name: 'Work', path: '/work.ics', details: 'busy' },
  { name: 'US Holidays', path: '/holidays.ics' }
];

function events(today) {
  return {
    '/family.ics': [
      { d: -1, allDay: true, days: 4, title: 'Grandma visiting' },
      { d: 0, start: '0800', end: '0900', title: 'Pancake breakfast' },
      { d: 0, start: '1230', end: '1400', title: 'Lunch with Ángel and Sofía', where: 'Café Évora, 2nd Ave' },
      { d: 0, start: '1830', end: '2000', title: 'Family dinner', where: 'Home' },
      { d: 1, start: '0900', end: '1000', title: 'Dentist: Maya', where: 'Elm Street Dental' },
      { d: 2, start: '1700', end: '1800', title: 'Soccer practice', where: 'Fair Park field 3', rrule: 'FREQ=WEEKLY;COUNT=6' },
      { d: 4, start: '1900', end: '2200', title: 'Concert at the Ñandú Lounge with the whole extended family and friends from school', where: 'Ñandú Lounge, Elm St' },
      { d: 6, start: '2200', end: '0130', endD: 7, title: 'Late flight home (AA 1432)', where: 'DFW Terminal C' },
      { d: 9, start: '1000', end: '1100', title: 'Parent-teacher meeting' },
      { d: 13, allDay: true, days: 3, title: 'Lake house weekend' },
      { d: 20, start: '1500', end: '1700', title: 'Évènement: vernissage at the gallery', where: 'Deep Ellum Art Co.' }
    ],
    '/ian.ics': [
      { d: 0, start: '1000', end: '1100', title: 'Call with the contractor' },
      { d: 0, start: '1030', end: '1130', title: 'Évènement planning review', where: 'Video call' },
      { d: 0, start: '1600', end: '1615', title: 'Quick check-in' },
      { d: 1, start: '1300', end: '1430', title: 'Haircut', where: 'Bishop Arts' },
      { d: 3, allDay: true, title: 'Pay rent' },
      { d: 5, start: '0730', end: '0830', title: 'Run club' },
      { d: 8, start: '1200', end: '1300', title: 'Lunch with Ñico' },
      { d: 17, start: '1830', end: '2100', title: 'Book club: “Cien años de soledad”' }
    ],
    '/work.ics': [
      { d: 0, start: '1400', end: '1530', title: 'Quarterly planning' },
      { d: 1, start: '1000', end: '1200', title: 'Design review' },
      { d: 2, start: '0900', end: '1200', title: 'Offsite' },
      { d: 3, start: '1100', end: '1130', title: 'Standup' },
      { d: 3, start: '1100', end: '1230', title: 'Interview' },
      { d: 3, start: '1115', end: '1200', title: 'Sync' },
      { d: 4, start: '0900', end: '1000', title: '1:1' },
      { d: 7, start: '0900', end: '1700', title: 'Training' }
    ],
    '/holidays.ics': [
      { d: 11, allDay: true, title: 'Thanksgiving Day' },
      { d: 12, allDay: true, title: 'Day after Thanksgiving' }
    ]
  };
}

// Many short events, for the "first 500" note.
function manyEvents() {
  const out = [];
  for (let d = -1; d < 58; d++) {
    for (let h = 0; h < 10; h++) out.push({ d: d, start: pad(8 + h) + '00', end: pad(8 + h) + '30', title: 'Slot ' + (h + 1) });
  }
  return out;
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
    const today = todayOf();
    if (mode === 'fail' || (mode === 'partial' && p === '/work.ics')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('nope');
    }
    let list = mode === 'empty' ? [] : events(today)[p];
    if (mode === 'many' && p === '/family.ics') list = list.concat(manyEvents());
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=UTF-8' });
    res.end(feed(cal.name, CALENDARS.indexOf(cal) + 1, today, list));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(opts.port || 0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      resolve({
        calendars: CALENDARS.map((c) => ({ name: c.name, url: base + c.path, details: c.details || 'show' })),
        setMode: (m) => { if (MODES.indexOf(m) < 0) return false; mode = m; return true; },
        mode: () => mode,
        close: () => new Promise((r) => { srv.close(() => r()); if (srv.closeAllConnections) srv.closeAllConnections(); })
      });
    });
  });
}

module.exports = { feedServer: feedServer, chicagoToday: chicagoToday, MODES: MODES, TZ: TZ };
