/*
 * Tests for the calendar reader. Run from the repo root with:
 *
 *   node pi/calendar-test.js
 *
 * The first part checks the iCalendar reader on the hand-written feeds in
 * pi/fixtures. The second part starts the live server with a tiny local web
 * server standing in for Google, and checks the whole path: reading, pushing
 * to a screen, failures, the control API and restarts. It prints one line per
 * check, then "N passed, 0 failed". Only what ships with Node is used.
 */
'use strict';

const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cal = require('./calendar');
const hubServer = require('./server');

const TOKEN = 'test-token-0123456789abcdef-long-enough';
const TZ = 'America/Chicago';
const FIX = path.join(__dirname, 'fixtures');
// A link part that must never show up anywhere but the request itself.
const SECRET = 'private-a1b2c3d4e5f6SECRETPATH0987';
const SECRET_QUERY = 'zz9secretquery';
const SECRET_BITS = [SECRET, 'SECRETPATH', SECRET_QUERY, 'a1b2c3d4e5f6'];

let passed = 0;
let failed = 0;
const tmpDirs = [];
const printed = [];

function say(line) {
  printed.push(line);
  console.log(line);
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cal-test-'));
  tmpDirs.push(d);
  return d;
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    say('ok   ' + name);
  } catch (e) {
    failed++;
    say('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('condition not met in time');
}

const fixture = (name) => fs.readFileSync(path.join(FIX, name));

function expand(name, nowIso, details) {
  const parsed = cal.parseIcs(typeof name === 'string' && /\.ics$/.test(name) ? fixture(name) : name);
  const w = cal.windowFor(Date.parse(nowIso || '2026-10-31T17:00:00Z'), TZ);
  return cal.expandEvents(parsed, { cal: 1, tz: TZ, window: w, details: details || 'show' });
}

const byTitle = (events, t) => events.filter((e) => e.title === t);
const starts = (events, t) => byTitle(events, t).map((e) => e.start);

/* ---------- talking to the hub ---------- */

const answers = []; // every API answer text, checked for the secret at the end

function request(port, method, p, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = {};
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        answers.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, text: text, json: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function openEvents(port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: port, path: '/live/events' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        answers.push(c);
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          block.split('\n').forEach((line) => {
            if (line.indexOf('event: ') === 0) ev.event = line.slice(7);
            else if (line.indexOf('data: ') === 0) ev.data = JSON.parse(line.slice(6));
          });
          events.push(ev);
        }
      });
      resolve({ events: events, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

// Stands in for Google. Each path has a mode; "held" requests wait for open().
function feedServer() {
  const st = { hits: 0, gate: true, held: [], modes: {} };
  const srv = http.createServer((req, res) => {
    st.hits++;
    st.lastHeaders = req.headers;
    const serve = () => {
      const u = new URL(req.url, 'http://x');
      const mode = st.modes[u.pathname] || { status: 404 };
      if (mode.slow) return; // never answers
      if (mode.redirect) {
        res.writeHead(302, { Location: mode.redirect });
        return res.end();
      }
      if (mode.status && mode.status !== 200) {
        res.writeHead(mode.status, { 'Content-Type': 'text/plain' });
        return res.end('nope');
      }
      res.writeHead(200, { 'Content-Type': mode.type || 'text/calendar; charset=UTF-8' });
      res.end(fixture(mode.file));
    };
    if (st.gate) serve();
    else st.held.push(serve);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    st.port = srv.address().port;
    st.base = 'http://127.0.0.1:' + st.port;
    st.close = () => new Promise((r) => { srv.close(r); srv.closeAllConnections && srv.closeAllConnections(); });
    st.hold = () => { st.gate = false; };
    st.open = () => { st.gate = true; const h = st.held; st.held = []; h.forEach((f) => f()); };
    resolve(st);
  }));
}

function startHub(extra) {
  const opts = Object.assign({ port: 0, token: TOKEN, log: false, dataDir: tmpDir(), timezone: TZ, allowHttp: true }, extra || {});
  const h = hubServer.start(opts);
  return h.ready.then(() => { h.dataDir = opts.dataDir; return h; });
}

const stop = (h) => new Promise((r) => h.close(r));

/* ---------- the tests ---------- */

async function main() {
  /* --- time zones --- */

  await check('time zone: 9:00 in Chicago is 14:00 UTC before 1 Nov 2026 and 15:00 UTC after', () => {
    assert.strictEqual(new Date(cal.zonedToUtc(2026, 10, 30, 9, 0, 0, TZ)).toISOString(), '2026-10-30T14:00:00.000Z');
    assert.strictEqual(new Date(cal.zonedToUtc(2026, 11, 2, 9, 0, 0, TZ)).toISOString(), '2026-11-02T15:00:00.000Z');
  });

  await check('time zone: the repeated hour takes the first one, the skipped hour moves forward', () => {
    assert.strictEqual(new Date(cal.zonedToUtc(2026, 11, 1, 1, 30, 0, TZ)).toISOString(), '2026-11-01T06:30:00.000Z');
    assert.strictEqual(new Date(cal.zonedToUtc(2026, 11, 1, 2, 30, 0, TZ)).toISOString(), '2026-11-01T08:30:00.000Z');
    // 2:30 on 14 March 2027 does not exist in Chicago: it becomes 3:30 CDT.
    assert.strictEqual(new Date(cal.zonedToUtc(2027, 3, 14, 2, 30, 0, TZ)).toISOString(), '2027-03-14T08:30:00.000Z');
    assert.strictEqual(new Date(cal.zonedToUtc(2027, 3, 14, 3, 0, 0, TZ)).toISOString(), '2027-03-14T08:00:00.000Z');
    assert.strictEqual(new Date(cal.zonedToUtc(2026, 6, 1, 12, 0, 0, 'UTC')).toISOString(), '2026-06-01T12:00:00.000Z');
  });

  await check('window: start of yesterday to the start of the 61st day after today, in the hub zone', () => {
    const w = cal.windowFor(Date.parse('2026-11-15T18:00:00Z'), TZ);
    assert.strictEqual(new Date(w.from).toISOString(), '2026-11-14T06:00:00.000Z');
    assert.strictEqual(new Date(w.to).toISOString(), '2027-01-15T06:00:00.000Z');
    // 03:00 UTC on the 16th is still the 15th in Chicago.
    const w2 = cal.windowFor(Date.parse('2026-11-16T03:00:00Z'), TZ);
    assert.strictEqual(new Date(w2.from).toISOString(), '2026-11-14T06:00:00.000Z');
  });

  /* --- single events --- */

  const basic = expand('basic.ics');
  const ev = (t) => byTitle(basic.events, t)[0];

  await check('a feed that is not a calendar gives null', () => {
    assert.strictEqual(cal.parseIcs(fixture('bad.html')), null);
    assert.strictEqual(cal.parseIcs(''), null);
    assert.strictEqual(cal.parseIcs('{"items":[]}'), null);
    assert.ok(cal.parseIcs(fixture('basic.ics')).events.length > 5);
  });

  await check('plain timed event in UTC', () => {
    assert.deepStrictEqual(Object.keys(ev('Plain UTC meeting')), ['id', 'cal', 'title', 'start', 'end', 'allDay', 'location']);
    assert.strictEqual(ev('Plain UTC meeting').start, '2026-11-16T15:00:00Z');
    assert.strictEqual(ev('Plain UTC meeting').end, '2026-11-16T16:00:00Z');
    assert.strictEqual(ev('Plain UTC meeting').allDay, false);
    assert.strictEqual(ev('Plain UTC meeting').cal, 1);
    assert.strictEqual(ev('Plain UTC meeting').location, '');
  });

  await check('TZID America/Chicago either side of the 1 November change: 9:00 stays 9:00', () => {
    assert.strictEqual(ev('Before the clock change').start, '2026-10-30T14:00:00Z');
    assert.strictEqual(ev('Before the clock change').location, 'Kitchen');
    assert.strictEqual(ev('After the clock change').start, '2026-11-02T15:00:00Z');
    assert.strictEqual(ev('In the repeated hour').start, '2026-11-01T06:30:00Z');
    assert.strictEqual(ev('In the repeated hour').end, '2026-11-01T08:30:00Z');
  });

  await check('a floating time is read in the hub time zone', () => {
    assert.strictEqual(ev('Floating breakfast').start, '2026-11-03T14:30:00Z');
  });

  await check('all-day events: one day, several days, no end date, on the clock change day', () => {
    assert.deepStrictEqual([ev('Bin day').start, ev('Bin day').end, ev('Bin day').allDay], ['2026-11-05', '2026-11-06', true]);
    assert.deepStrictEqual([ev('Weekend trip').start, ev('Weekend trip').end], ['2026-11-06', '2026-11-09']);
    assert.deepStrictEqual([ev('No end date').start, ev('No end date').end], ['2026-11-10', '2026-11-11']);
    assert.deepStrictEqual([ev('Clocks go back').start, ev('Clocks go back').end], ['2026-11-01', '2026-11-02']);
  });

  await check('DURATION gives the end time', () => {
    assert.strictEqual(ev('Ninety minutes').start, '2026-11-12T19:00:00Z');
    assert.strictEqual(ev('Ninety minutes').end, '2026-11-12T20:30:00Z');
  });

  await check('a cancelled single event is dropped; TRANSPARENT ones are kept', () => {
    assert.strictEqual(ev('Cancelled lunch'), undefined);
    assert.ok(ev('Bin day'));
  });

  await check('line folding and escaped text', () => {
    assert.strictEqual(ev('Pick up milk, eggs; bread \\ more second line and a very long title that is folded').location,
      'Corner shop, Main Street');
    const raw = Buffer.concat([
      Buffer.from('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261102T150000Z\r\nSUMMARY:Caf'),
      Buffer.from([0xc3]), Buffer.from('\r\n '), Buffer.from([0xa9]), Buffer.from(' au lait\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
    ]);
    const r = expand(raw);
    assert.strictEqual(r.events[0].title, 'Caf\u00e9 au lait');
    assert.strictEqual(r.events[0].end, r.events[0].start);
  });

  await check('titles are cut at 120 characters and places at 80, with an ellipsis; empty title is "(No title)"', () => {
    const long = basic.events.find((e) => /^This title/.test(e.title));
    const n = Array.from(long.title).length;
    assert.ok(n <= 120 && n >= 115, 'length ' + n); // a space before the cut is dropped
    assert.ok(/\u2026$/.test(long.title));
    assert.ok(Array.from(long.location).length <= 80 && Array.from(long.location).length >= 75);
    assert.ok(/\u2026$/.test(long.location));
    assert.strictEqual(ev('(No title)').start, '2026-11-14T17:00:00Z');
  });

  await check('only title and place are ever kept (no description, people, link or alarm)', () => {
    const text = JSON.stringify(basic.events);
    ['hidden agenda', 'organizer-xyz', 'attendee-xyz', 'meeting-link-xyz', 'Alarm text', 'Organizer Person'].forEach((s) => {
      assert.ok(text.indexOf(s) < 0, s);
    });
    assert.ok(ev('Zebra planning secret'));
  });

  await check('DETAILS=busy: every title is Busy, no place, nothing from the event leaks', () => {
    const r = expand('basic.ics', null, 'busy');
    assert.strictEqual(r.events.length, basic.events.length);
    assert.ok(r.events.every((e) => e.title === 'Busy' && e.location === ''));
    const text = JSON.stringify(r);
    ['Zebra', 'planning', 'Fortytwo', 'Annex', 'hidden agenda', 'organizer-xyz', 'attendee-xyz', 'meeting-link-xyz',
      'Alarm text', 'Kitchen', 'Corner shop', 'Plain UTC', 'Person'].forEach((s) => assert.ok(text.indexOf(s) < 0, s));
  });

  await check('ids are short base36, stable between reads and different per calendar', () => {
    const again = expand('basic.ics');
    assert.deepStrictEqual(again.events.map((e) => e.id), basic.events.map((e) => e.id));
    assert.ok(basic.events.every((e) => /^[0-9a-z]{1,12}$/.test(e.id)));
    assert.strictEqual(new Set(basic.events.map((e) => e.id)).size, basic.events.length);
    const w = cal.windowFor(Date.parse('2026-10-31T17:00:00Z'), TZ);
    const other = cal.expandEvents(cal.parseIcs(fixture('basic.ics')), { cal: 2, tz: TZ, window: w });
    assert.notStrictEqual(other.events[0].id, basic.events[0].id);
    assert.strictEqual(other.events[0].cal, 2);
  });

  await check('events are sorted by start, then title', () => {
    const r = expand('recurring.ics').events;
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1].allDay ? Date.parse(r[i - 1].start + 'T05:00:00Z') : Date.parse(r[i - 1].start);
      const b = r[i].allDay ? Date.parse(r[i].start + 'T05:00:00Z') : Date.parse(r[i].start);
      assert.ok(a <= b + 3600000, r[i - 1].start + ' then ' + r[i].start);
    }
  });

  /* --- repeating events --- */

  const rec = expand('recurring.ics');

  await check('weekly with BYDAY, INTERVAL=2, WKST and EXDATE (with TZID)', () => {
    assert.deepStrictEqual(starts(rec.events, 'Swim class'), [
      '2026-11-04T00:00:00Z', '2026-11-18T00:00:00Z', '2026-11-20T00:00:00Z', '2026-12-02T00:00:00Z',
      '2026-12-04T00:00:00Z', '2026-12-16T00:00:00Z', '2026-12-18T00:00:00Z', '2026-12-30T00:00:00Z'
    ]);
  });

  await check('COUNT, across the clock change (7:00 local each day)', () => {
    assert.deepStrictEqual(starts(rec.events, 'Five mornings'), ['2026-10-30T12:00:00Z', '2026-10-31T12:00:00Z', '2026-11-01T13:00:00Z']);
  });

  await check('UNTIL as UTC (inclusive), as a date, and weekly 9:00 local across the change', () => {
    assert.deepStrictEqual(starts(rec.events, 'Lunch club'), ['2026-11-02T18:00:00Z', '2026-11-09T18:00:00Z', '2026-11-16T18:00:00Z']);
    assert.deepStrictEqual(starts(rec.events, 'Three days'), ['2026-11-10', '2026-11-11', '2026-11-12']);
    assert.deepStrictEqual(starts(rec.events, 'Friday nine'), ['2026-10-30T14:00:00Z', '2026-11-06T15:00:00Z']);
  });

  await check('monthly on the 2nd Monday and on the last Friday', () => {
    assert.deepStrictEqual(starts(rec.events, 'Book club'), ['2026-11-10T01:00:00Z', '2026-12-15T01:00:00Z']);
    assert.deepStrictEqual(starts(rec.events, 'Pizza night'), ['2026-10-30', '2026-11-27', '2026-12-25']);
  });

  await check('monthly BYMONTHDAY=1,-1 and BYSETPOS=-1 (last weekday of the month)', () => {
    assert.deepStrictEqual(starts(rec.events, 'Check the budget'), ['2026-10-31', '2026-11-01', '2026-11-30', '2026-12-01']);
    assert.deepStrictEqual(starts(rec.events, 'Month end report'), ['2026-10-30T21:00:00Z', '2026-11-30T22:00:00Z']);
  });

  await check('yearly, and yearly on the 4th Thursday of November', () => {
    assert.deepStrictEqual(byTitle(rec.events, 'Birthday').map((e) => [e.start, e.end]), [['2026-12-07', '2026-12-08']]);
    assert.deepStrictEqual(starts(rec.events, 'Thanksgiving'), ['2026-11-26']);
  });

  await check('all-day weekly series across the clock change stays on Sunday', () => {
    assert.deepStrictEqual(starts(rec.events, 'Sunday chores'), ['2026-11-01', '2026-11-08']);
  });

  await check('RECURRENCE-ID: a moved instance replaces its day, a cancelled one is removed; EXDATE in UTC', () => {
    assert.deepStrictEqual(starts(rec.events, 'Standup'), ['2026-11-02T16:00:00Z', '2026-11-05T16:00:00Z']);
    const moved = byTitle(rec.events, 'Standup (moved)');
    assert.deepStrictEqual(moved.map((e) => [e.start, e.end]), [['2026-11-03T20:00:00Z', '2026-11-03T20:30:00Z']]);
  });

  await check('RDATE adds an instance; EXDATE with several dates removes them', () => {
    assert.deepStrictEqual(starts(rec.events, 'Lessons'), ['2026-11-10T21:00:00Z', '2026-11-17T21:00:00Z', '2026-11-20T21:00:00Z']);
    assert.deepStrictEqual(starts(rec.events, 'Gym'), ['2026-11-02', '2026-11-05']);
  });

  await check('rules this reader does not do are skipped and counted, never guessed', () => {
    assert.strictEqual(byTitle(rec.events, 'Hourly pill').length, 0);
    assert.strictEqual(byTitle(rec.events, 'Twice a day').length, 0);
    assert.strictEqual(rec.skipped, 3); // HOURLY, BYHOUR, and the one over the 1000 cap
    ['FREQ=HOURLY', 'FREQ=MINUTELY', 'FREQ=DAILY;BYHOUR=8', 'FREQ=YEARLY;BYWEEKNO=20', 'FREQ=YEARLY;BYYEARDAY=100',
      'FREQ=WEEKLY;BYDAY=2MO', 'FREQ=WEEKLY;BYMONTHDAY=3', 'FREQ=MONTHLY;RSCALE=HEBREW', 'INTERVAL=2', 'FREQ=DAILY;COUNT=0']
      .forEach((r) => assert.strictEqual(cal.parseRrule(r), null, r));
    assert.ok(cal.parseRrule('FREQ=MONTHLY;BYDAY=-1FR;WKST=SU'));
  });

  await check('the 1000-instance cap stops a huge series quickly', () => {
    const t0 = Date.now();
    const r = expand('recurring.ics');
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(byTitle(r.events, 'Too many').length, 0);
    // Without COUNT a series that began long ago jumps ahead and still shows.
    const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:old\r\nDTSTART:19500101T120000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Old daily\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const r2 = expand(text);
    assert.strictEqual(r2.events.length, 62);
    assert.strictEqual(r2.skipped, 0);
  });

  await check('window edges: yesterday in, the day before out, day 60 in, day 61 out', () => {
    const r = expand('window.ics').events.map((e) => e.title);
    assert.deepStrictEqual(r, ['Crosses the window start', 'Yesterday', 'Day sixty', 'Late on day sixty']);
  });

  await check('a broken event (no start, bad values) is skipped, the rest still read', () => {
    const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:No start\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\n' +
      'DTSTART:2026XX01\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nDTSTART;TZID=/example.org/2005/America/Chicago:20261102T090000\r\n' +
      'SUMMARY:Fine\r\nNOT A LINE\r\nX;BROKEN="unclosed:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const r = expand(text);
    assert.deepStrictEqual(r.events.map((e) => [e.title, e.start]), [['Fine', '2026-11-02T15:00:00Z']]);
    assert.strictEqual(r.skipped, 2);
  });

  await check('settings: names, webcal, https only, duplicates and bad DETAILS are logged by name and skipped', () => {
    const lines = [];
    const list = cal.checkCalendars(cal.calendarsFromEnv({
      CALENDAR_1_NAME: 'Ian', CALENDAR_1_URL: 'webcal://calendar.example.test/ical/' + SECRET + '/basic.ics',
      CALENDAR_2_NAME: 'Plain', CALENDAR_2_URL: 'http://calendar.example.test/' + SECRET + '/x.ics',
      CALENDAR_3_URL: 'https://calendar.example.test/three/' + SECRET,
      CALENDAR_4_NAME: 'Copy', CALENDAR_4_URL: 'https://calendar.example.test/ical/' + SECRET + '/basic.ics',
      CALENDAR_5_NAME: 'Odd', CALENDAR_5_URL: 'https://calendar.example.test/five', CALENDAR_5_DETAILS: 'some',
      CALENDAR_6_NAME: 'Inside', CALENDAR_6_URL: 'https://192.168.1.5/' + SECRET,
      CALENDAR_7_NAME: 'Work', CALENDAR_7_URL: 'https://calendar.example.test/seven', CALENDAR_7_DETAILS: 'BUSY',
      CALENDAR_8_NAME: 'Nameonly',
      CALENDAR_9_NAME: 'Junk', CALENDAR_9_URL: 'not a link ' + SECRET
    }), (s) => lines.push(s), false);
    assert.deepStrictEqual(list.map((c) => [c.cal, c.name, c.details]), [[1, 'Ian', 'show'], [3, 'Calendar 3', 'show'], [7, 'Work', 'busy']]);
    assert.ok(/^https:\/\//.test(list[0].url));
    assert.strictEqual(lines.length, 6);
    ['Plain', 'Copy', 'Odd', 'Inside', 'Nameonly', 'Junk'].forEach((n) => assert.ok(lines.some((l) => l.indexOf('calendar ' + n + ':') === 0), n));
    assert.ok(lines.every((l) => SECRET_BITS.every((b) => l.indexOf(b) < 0) && l.indexOf('example.test') < 0), lines.join('\n'));
    assert.strictEqual(cal.refreshMinutes('0', () => {}), 1);
    assert.strictEqual(cal.refreshMinutes('500', () => {}), 120);
    assert.strictEqual(cal.refreshMinutes('', () => {}), 5);
    assert.strictEqual(cal.timezone('Mars/Base', () => {}), 'America/Chicago');
  });

  /* --- the server, end to end --- */

  const feeds = await feedServer();
  const linkA = feeds.base + '/cal/' + SECRET + '/a.ics?k=' + SECRET_QUERY;
  const linkB = feeds.base + '/cal/' + SECRET + '/b.ics';
  const pathA = '/cal/' + SECRET + '/a.ics';
  const pathB = '/cal/' + SECRET + '/b.ics';
  feeds.modes[pathA] = { file: 'small.ics' };
  feeds.modes[pathB] = { file: 'basic.ics' };
  const logs = [];
  let fakeNow = Date.parse('2026-10-31T17:00:00Z');
  const calendars = [{ name: 'Ian', url: linkA }, { name: 'Health', url: linkB, details: 'busy' }];
  const dir = tmpDir();
  feeds.hold();
  let h = await startHub({ dataDir: dir, calendars: calendars, now: () => new Date(fakeNow), log: (s) => logs.push(s), calendarTimeout: 400 });
  const P = h.port;
  const es = await openEvents(P);
  const calChanges = () => es.events.filter((e) => e.event === 'change' && e.data.resource === 'calendar');
  const stateText = () => fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  let rev1;

  await check('server: the first read pushes one change to a connected screen', async () => {
    await waitUntil(() => h._debug().sse === 1 && es.events.some((e) => e.event === 'hello'));
    assert.strictEqual(h._debug().calendar.configured, true);
    assert.strictEqual(h._debug().calendar.refreshing, true);
    const pending = request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    await sleep(50);
    feeds.open();
    const r = await pending;
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.done, true);
    assert.strictEqual(r.json.changed, true);
    assert.strictEqual(feeds.hits, 2, 'the joined refresh read each feed once');
    assert.strictEqual(feeds.lastHeaders['user-agent'], 'HomeHub');
    assert.strictEqual(feeds.lastHeaders.accept, 'text/calendar');
    await waitUntil(() => calChanges().length === 1);
    const ch = calChanges()[0].data;
    assert.strictEqual(ch.data.configured, true);
    assert.deepStrictEqual(r.json.calendars.map((c) => [c.cal, c.name, c.ok, c.error, c.count]), [[1, 'Ian', true, '', 2], [2, 'Health', true, '', 14]]);
    rev1 = ch.rev;
  });

  await check('server: the data has the agreed shape; busy calendar shows only Busy', async () => {
    const r = await request(P, 'GET', '/api/calendar', { token: TOKEN });
    const d = r.json.data;
    assert.strictEqual(r.json.rev, rev1);
    assert.deepStrictEqual(Object.keys(d), ['configured', 'tz', 'from', 'to', 'updatedAt', 'truncated', 'calendars', 'events']);
    assert.strictEqual(d.tz, TZ);
    assert.strictEqual(d.from, '2026-10-30T05:00:00Z');
    assert.strictEqual(d.to, '2026-12-31T06:00:00Z');
    assert.strictEqual(d.updatedAt, '2026-10-31T17:00:00Z');
    assert.strictEqual(d.truncated, false);
    assert.deepStrictEqual(Object.keys(d.calendars[0]), ['cal', 'name', 'ok', 'error', 'count', 'skipped', 'updatedAt']);
    const dentist = d.events.find((e) => e.title === 'Dentist');
    assert.deepStrictEqual([dentist.cal, dentist.start, dentist.end, dentist.location], [1, '2026-11-02T15:00:00Z', '2026-11-02T16:00:00Z', 'Downtown clinic']);
    const health = d.events.filter((e) => e.cal === 2);
    assert.strictEqual(health.length, 14);
    assert.ok(health.every((e) => e.title === 'Busy' && e.location === ''));
    assert.ok(r.text.indexOf('Bring the form') < 0 && r.text.indexOf('Zebra') < 0 && r.text.indexOf('Kitchen') < 0);
    const st = await request(P, 'GET', '/live/state');
    assert.strictEqual(st.json.resources.calendar.rev, rev1);
    assert.strictEqual(st.json.resources.calendar.data.events.length, d.events.length);
    const poll = await request(P, 'GET', '/live/poll?epoch=' + st.json.epoch + '&rev=' + (rev1 - 1));
    assert.ok(poll.json.resources.calendar);
    const status = await request(P, 'GET', '/api/status', { token: TOKEN });
    assert.deepStrictEqual(status.json.calendar, { configured: true, calendars: 2, lastRefresh: '2026-10-31T17:00:00Z' });
  });

  await check('server: a second read of the same feeds pushes nothing, keeps rev and does not rewrite the file', async () => {
    const before = stateText();
    const mtime = fs.statSync(path.join(dir, 'state.json')).mtimeMs;
    fakeNow += 60000;
    await sleep(20);
    const r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.deepStrictEqual([r.json.done, r.json.changed], [true, false]);
    await sleep(150);
    assert.strictEqual(calChanges().length, 1);
    assert.strictEqual((await request(P, 'GET', '/api/calendar', { token: TOKEN })).json.rev, rev1);
    assert.strictEqual(stateText(), before);
    assert.strictEqual(fs.statSync(path.join(dir, 'state.json')).mtimeMs, mtime);
    // The "read at" time still moves in memory.
    assert.strictEqual((await request(P, 'GET', '/api/calendar', { token: TOKEN })).json.data.updatedAt, '2026-10-31T17:01:00Z');
  });

  await check('server: a changed feed pushes again with a new rev', async () => {
    feeds.modes[pathA] = { file: 'small-changed.ics' };
    const r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.deepStrictEqual([r.json.done, r.json.changed], [true, true]);
    await waitUntil(() => calChanges().length === 2);
    const ch = calChanges()[1].data;
    assert.ok(ch.rev > rev1);
    assert.ok(ch.data.events.some((e) => e.title === 'Parent evening'));
    assert.ok(JSON.parse(stateText()).resources.calendar.data.events.some((e) => e.title === 'Parent evening'));
    rev1 = ch.rev;
  });

  await check('server: two refreshes at the same time read each feed once', async () => {
    const hits = feeds.hits;
    const both = await Promise.all([
      request(P, 'POST', '/api/calendar/refresh', { token: TOKEN }),
      request(P, 'POST', '/api/calendar/refresh', { token: TOKEN })
    ]);
    assert.ok(both.every((r) => r.status === 200 && r.json.done === true));
    assert.strictEqual(feeds.hits - hits, 2);
  });

  await check('server: calendar calls need the token', async () => {
    assert.strictEqual((await request(P, 'GET', '/api/calendar')).status, 401);
    assert.strictEqual((await request(P, 'POST', '/api/calendar/refresh', { token: 'wrong' })).status, 401);
    assert.strictEqual((await request(P, 'GET', '/api/calendar/refresh', { token: TOKEN })).status, 405);
  });

  await check('server: a failing feed keeps its last good events, marked ok:false, with a plain error', async () => {
    feeds.modes[pathB] = { status: 404 };
    fakeNow += 60000;
    const r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    const health = r.json.calendars.find((c) => c.name === 'Health');
    assert.deepStrictEqual([health.ok, health.error, health.count, health.updatedAt],
      [false, 'could not be read (HTTP 404)', 14, '2026-10-31T17:01:00Z']);
    assert.strictEqual(r.json.changed, true);
    assert.ok(logs.some((l) => /calendar Health: could not be read \(HTTP 404\)$/.test(l)));
    const d = (await request(P, 'GET', '/api/calendar', { token: TOKEN })).json.data;
    assert.strictEqual(d.events.filter((e) => e.cal === 2).length, 14);
  });

  await check('server: other failures read plainly (not a calendar, timed out, redirects)', async () => {
    feeds.modes[pathA] = { file: 'bad.html', type: 'text/html' };
    let r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(r.json.calendars[0].error, 'did not look like a calendar');
    assert.strictEqual(r.json.calendars[0].count, 3);
    feeds.modes[pathA] = { slow: true };
    r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(r.json.calendars[0].error, 'timed out');
    feeds.modes[pathA] = { redirect: '/hop1' };
    feeds.modes['/hop1'] = { redirect: feeds.base + '/hop2' };
    feeds.modes['/hop2'] = { file: 'small-changed.ics' };
    r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.deepStrictEqual([r.json.calendars[0].ok, r.json.calendars[0].error], [true, '']);
    feeds.modes['/hop2'] = { redirect: '/hop3' };
    feeds.modes['/hop3'] = { redirect: '/hop4' };
    r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(r.json.calendars[0].error, 'could not be read (too many redirects)');
    feeds.modes[pathA] = { redirect: 'ftp://127.0.0.1/x.ics' };
    r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.ok(/not allowed/.test(r.json.calendars[0].error));
    feeds.modes[pathA] = { file: 'small-changed.ics' };
    r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(r.json.calendars[0].ok, true);
    assert.ok(logs.some((l) => /calendar Ian: can be read again/.test(l)));
  });

  await check('server: after 24 hours of failure a calendar\'s events are dropped', async () => {
    fakeNow += 25 * 3600 * 1000;
    const r = await request(P, 'POST', '/api/calendar/refresh', { token: TOKEN });
    const health = r.json.calendars.find((c) => c.name === 'Health');
    assert.deepStrictEqual([health.ok, health.count], [false, 0]);
    const d = (await request(P, 'GET', '/api/calendar', { token: TOKEN })).json.data;
    assert.strictEqual(d.events.filter((e) => e.cal === 2).length, 0);
    assert.strictEqual(d.from, '2026-10-31T05:00:00Z', 'the window moved a day');
  });

  es.close();
  await stop(h);

  await check('server: the calendar survives a restart from state.json', async () => {
    const saved = JSON.parse(stateText());
    feeds.hold();
    h = await startHub({ dataDir: dir, calendars: calendars, now: () => new Date(fakeNow), log: (s) => logs.push(s) });
    const r = await request(h.port, 'GET', '/api/calendar', { token: TOKEN });
    assert.strictEqual(r.json.rev, saved.resources.calendar.rev);
    assert.deepStrictEqual(r.json.data, saved.resources.calendar.data);
    assert.ok(r.json.data.events.length > 0);
    feeds.open();
    const again = await request(h.port, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(again.json.changed, false);
    await stop(h);
  });

  await check('server: removing every calendar clears the resource on the next start', async () => {
    const before = JSON.parse(stateText());
    const h2 = await startHub({ dataDir: dir, log: (s) => logs.push(s) });
    const r = await request(h2.port, 'GET', '/api/calendar', { token: TOKEN });
    assert.deepStrictEqual(r.json.data, { configured: false, calendars: [], events: [] });
    assert.strictEqual(r.json.rev, before.rev + 1);
    await stop(h2);
  });

  await check('server: nothing set up means no timers, no reads and configured:false', async () => {
    const hits = feeds.hits;
    const h2 = await startHub({});
    await sleep(100);
    assert.deepStrictEqual(h2._debug().calendar, { configured: false, calendars: 0, timer: false, refreshing: false });
    const r = await request(h2.port, 'GET', '/live/state');
    assert.deepStrictEqual(r.json.resources.calendar, { rev: 0, data: { configured: false, calendars: [], events: [] } });
    assert.strictEqual(feeds.hits, hits);
    await stop(h2);
  });

  await check('server: a damaged calendar in state.json is replaced and the to-do list kept', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ epoch: 'abc123', rev: 4, resources: {
      todo: { rev: 4, data: { items: [{ id: 'k1', title: 'Kept' }] } }, calendar: { rev: 'x', data: [1, 2] }
    } }));
    const h2 = await startHub({ dataDir: d });
    const r = await request(h2.port, 'GET', '/live/state');
    assert.strictEqual(r.json.resources.todo.data.items[0].title, 'Kept');
    assert.deepStrictEqual(r.json.resources.calendar, { rev: 0, data: { configured: false, calendars: [], events: [] } });
    await stop(h2);
  });

  await check('server: at most 500 events, the latest dropped, truncated:true', async () => {
    feeds.modes['/many/' + SECRET] = { file: 'many.ics' };
    const h2 = await startHub({ calendars: [{ name: 'Lots', url: feeds.base + '/many/' + SECRET }], now: () => new Date(Date.parse('2026-10-31T17:00:00Z')) });
    const r = await request(h2.port, 'POST', '/api/calendar/refresh', { token: TOKEN });
    assert.strictEqual(r.json.calendars[0].count, 500);
    const d = (await request(h2.port, 'GET', '/api/calendar', { token: TOKEN })).json.data;
    assert.strictEqual(d.truncated, true);
    assert.strictEqual(d.events.length, 500);
    assert.strictEqual(d.events[0].start, '2026-10-30');
    assert.strictEqual(d.events[499].start, '2026-12-24');
    assert.strictEqual(d.events[499].title, 'Daily 5');
    await stop(h2);
  });

  await check('server: refuses http links and home network addresses without allowHttp', async () => {
    const lines = [];
    const h2 = await startHub({ allowHttp: false, log: (s) => lines.push(s), calendars: [{ name: 'Local', url: linkA }] });
    assert.strictEqual(h2._debug().calendar.configured, false);
    assert.ok(lines.some((l) => /calendar Local: the link must start with https:\/\/, skipped/.test(l)));
    logs.push.apply(logs, lines);
    await stop(h2);
  });

  await check('no part of a secret link is in any log line, answer, state file or test output', () => {
    const files = tmpDirs.filter((d) => fs.existsSync(path.join(d, 'state.json'))).map((d) => fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    const all = [].concat(logs, answers, files, printed);
    assert.ok(logs.length > 10 && answers.length > 20 && files.length >= 3);
    SECRET_BITS.forEach((bit) => all.forEach((text) => assert.ok(text.indexOf(bit) < 0, 'found a secret in: ' + text.slice(0, 120))));
    assert.ok(!all.some((t) => t.indexOf('/cal/') >= 0 || t.indexOf('a.ics') >= 0 || t.indexOf('b.ics') >= 0));
  });

  await feeds.close();
  tmpDirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('the tests crashed: ' + (e && e.stack));
  process.exit(1);
});
