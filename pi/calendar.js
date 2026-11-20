/*
 * Calendar reader for the Home Hub live server. server.js requires it.
 *
 * Each calendar is a private iCal link (Google Calendar calls it the "Secret
 * address in iCal format"). The reader fetches each link in turn, reads the
 * events (RFC 5545), works out every event that falls between the start of
 * yesterday and 60 days after today, and hands the result to the server,
 * which keeps it as the "calendar" resource and pushes it to the TV.
 *
 * The links are secrets. Nothing here ever puts a link, or any part of one,
 * in a log line, an error, an answer or the data file. Errors only name the
 * calendar: "Ian: could not be read (HTTP 404)".
 *
 * The resource data:
 *   { configured: true, tz, from, to, updatedAt, truncated,
 *     calendars: [{ cal, name, color, ok, error, count, skipped, updatedAt }],
 *     events: [{ id, cal, title, start, end, allDay, location, note? }],
 *     notes: { key: text } }
 * An event with notes (the event's description in Google Calendar) carries
 * note, a short key into notes; a repeating event shares one copy. Notes are
 * plain text: HTML is turned into lines, links and email addresses are taken
 * out, at most MAX_NOTES characters each and MAX_NOTES_TOTAL in all (the
 * nearest events keep theirs). A "busy" calendar never has notes. Notes text
 * is never logged.
 * An event with other people on it carries guestCount and guests (their
 * names, at most MAX_GUESTS): everyone on the invitation except the
 * calendar's owner (read from a Google link, else the organizer), rooms and
 * people who declined. A name is the CN; without one, the part of the email
 * address before the @ (never a whole address). Busy calendars carry none.
 * Guest names are never logged.
 * Timed events have UTC start and end like "2026-11-16T15:00:00Z". All-day
 * events have dates like "2026-11-16", and the end date is the day after the
 * last day. With nothing set up the data is
 *   { configured: false, calendars: [], events: [] }
 *
 * Time zones come from Intl.DateTimeFormat (no library). A local time that
 * does not exist (the hour skipped in spring) moves forward by the gap; a
 * local time that happens twice (the hour repeated in autumn) takes the first.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_TZ = 'America/Chicago';
const DEFAULT_REFRESH_MINUTES = 5;
const MAX_CALENDARS = 9;
const MAX_EVENTS = 500;
const MAX_INSTANCES = 1000; // per repeating event
const MAX_WORK = 200000;    // steps per feed, so a strange feed cannot run for long
const MAX_TITLE = 120;
const MAX_LOCATION = 80;
const MAX_NOTES = 2000;
const MAX_NOTES_TOTAL = 60000;
const MAX_GUESTS = 25;
const MAX_GUEST_NAME = 60;
const MAX_NAME = 40;
const FEED_LIMIT = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 10000;
const MAX_REDIRECTS = 3;
const KEEP_FAILED_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const DAYS_AFTER = 60;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/* ---------- days and time zones ---------- */

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

// Days since 1970-01-01. Plain whole numbers make date sums easy.
function dayNum(y, m, d) {
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayParts(n) {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// 0 is Sunday. 1970-01-01 was a Thursday.
function weekday(n) {
  return (((n + 4) % 7) + 7) % 7;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayText(n) {
  const p = dayParts(n);
  return p.y + '-' + pad(p.m) + '-' + pad(p.d);
}

function parseDayText(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return m ? dayNum(+m[1], +m[2], +m[3]) : null;
}

function isoText(ms) {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

const formatters = new Map();

function zoneFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    });
    formatters.set(tz, f);
  }
  return f;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    zoneFormatter(tz);
    return true;
  } catch (e) {
    return false;
  }
}

// The wall clock in a zone at an instant.
function zoneParts(ms, tz) {
  const o = {};
  zoneFormatter(tz).formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  let h = Number(o.hour);
  if (h === 24) h = 0;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: h, mi: Number(o.minute), s: Number(o.second) };
}

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
function zoneOffset(ms, tz) {
  const t = Math.floor(ms / 1000) * 1000;
  const p = zoneParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
}

// The instant of a wall clock time in a zone. The offsets a day before and
// a day after give the two possible answers around a clock change.
function zonedToUtc(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  const oA = zoneOffset(guess - DAY_MS, tz);
  const oB = zoneOffset(guess + DAY_MS, tz);
  const tA = guess - oA;
  const tB = guess - oB;
  const okA = zoneOffset(tA, tz) === oA;
  const okB = zoneOffset(tB, tz) === oB;
  if (okA && okB) return Math.min(tA, tB); // repeated hour: the first one
  if (okA) return tA;
  if (okB) return tB;
  return tA; // skipped hour: the old offset lands just after the change
}

function toUtc(day, sec, tz) {
  if (tz === 'UTC') return day * DAY_MS + sec * 1000;
  const p = dayParts(day);
  return zonedToUtc(p.y, p.m, p.d, Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60, tz);
}

// The wall clock day (days since 1970) of an instant in a zone.
function wallDay(ms, tz) {
  if (tz === 'UTC') return Math.floor(ms / DAY_MS);
  const p = zoneParts(ms, tz);
  return dayNum(p.y, p.m, p.d);
}

// The wall clock as a plain number, for "is this before that" in one zone.
function wallNumber(ms, tz) {
  if (tz === 'UTC') return ms;
  const p = zoneParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

// Start of yesterday to the start of the day 61 days after today, so the
// 60th day after today is the last day shown.
function windowFor(nowMs, tz) {
  const today = wallDay(nowMs, tz);
  const fromDay = today - 1;
  const toDay = today + DAYS_AFTER + 1;
  return { today: today, fromDay: fromDay, toDay: toDay, from: toUtc(fromDay, 0, tz), to: toUtc(toDay, 0, tz) };
}

/* ---------- reading the iCalendar text ---------- */

// Joins folded lines. Works on bytes first, because some programs fold in the
// middle of a multi-byte character.
function unfold(input) {
  let text;
  if (Buffer.isBuffer(input)) {
    const joined = input.toString('latin1').replace(/\r?\n[ \t]/g, '');
    text = Buffer.from(joined, 'latin1').toString('utf8');
  } else {
    text = String(input || '').replace(/\r?\n[ \t]/g, '');
  }
  return text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
}

// One content line: NAME;PARAM=value;PARAM="quoted":value
function parseLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!name) return null;
  const params = Object.create(null);
  while (i < n && line[i] === ';') {
    i++;
    let j = i;
    while (j < n && line[j] !== '=' && line[j] !== ';' && line[j] !== ':') j++;
    const pname = line.slice(i, j).trim().toUpperCase();
    i = j;
    const values = [];
    if (line[i] === '=') {
      i++;
      for (;;) {
        if (line[i] === '"') {
          const close = line.indexOf('"', i + 1);
          if (close < 0) return null;
          values.push(line.slice(i + 1, close));
          i = close + 1;
        } else {
          let k = i;
          while (k < n && line[k] !== ',' && line[k] !== ';' && line[k] !== ':') k++;
          values.push(line.slice(i, k));
          i = k;
        }
        if (line[i] === ',') { i++; continue; }
        break;
      }
    }
    if (pname) params[pname] = values.join(',');
  }
  if (line[i] !== ':') return null;
  return { name: name, params: params, value: line.slice(i + 1) };
}

// Returns { events: [props] }, where props maps a property name to a list of
// { name, params, value }, or null when the text is not a calendar at all.
// Only events directly inside the calendar are kept; alarms inside events
// and time zone blocks are passed over.
function parseIcs(input) {
  const lines = unfold(input);
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  if (first >= lines.length || lines[first].trim().toUpperCase() !== 'BEGIN:VCALENDAR') return null;
  const events = [];
  const stack = [];
  let cur = null;
  for (let i = first; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = parseLine(lines[i]);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length === 2 && stack[0] === 'VCALENDAR') cur = Object.create(null);
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      const at = stack.lastIndexOf(comp);
      if (at < 0) continue;
      if (comp === 'VEVENT' && at === 1 && cur) {
        events.push(cur);
        cur = null;
      }
      stack.length = at;
      continue;
    }
    if (cur && stack.length === 2) {
      if (!cur[p.name]) cur[p.name] = [];
      cur[p.name].push(p);
    }
  }
  return { events: events };
}

function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN:])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function propText(props, name) {
  const list = props[name];
  return list && list.length ? unescapeText(list[0].value) : '';
}

// Plain one-line text, at most max characters, an ellipsis when cut.
function cleanText(s, max) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return chars.slice(0, max - 1).join('').trimEnd() + '\u2026';
}

// An event's notes (DESCRIPTION) as plain text with line breaks. Google
// sends HTML when the notes were formatted on the web: tags become line
// breaks or nothing, entities become characters. Links and email addresses
// are taken out (a line left with nothing in it goes too), blank runs become
// one blank line, at most max characters with an ellipsis when cut.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', bull: '\u2022' };
function cleanNotes(s, max) {
  let t = String(s || '');
  if (/<[a-z\/][^>]*>/i.test(t)) {
    t = t.replace(/\r?\n/g, ' ')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n\u2022 ')
      .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '');
  }
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>"]+/gi, '')
    .replace(/[^\s<>"()]+@[^\s<>"()]+\.[a-z]{2,}/gi, '');
  const lines = t.replace(/\r\n?/g, '\n').split('\n').map((l) =>
    l.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim());
  const kept = lines.filter((l) => l === '' || /[\p{L}\p{N}]/u.test(l));
  t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return chars.slice(0, max - 1).join('').trimEnd() + '\u2026';
}

// The owner of a Google calendar, from its secret link
// (.../calendar/ical/<address>/private-.../basic.ics), lower case; '' otherwise.
function ownerOf(url) {
  const m = /\/calendar\/ical\/([^/]+)\//.exec(String(url || ''));
  if (!m) return '';
  let a = '';
  try { a = decodeURIComponent(m[1]); } catch (e) { return ''; }
  return /^[^@\s]+@[^@\s]+$/.test(a) ? a.toLowerCase() : '';
}

function mailOf(v) {
  return String(v || '').replace(/^mailto:/i, '').trim().toLowerCase();
}

// The other people on an event: { count, names }.
function guestsOf(props, owner) {
  const list = props.ATTENDEE || [];
  if (!list.length) return { count: 0, names: [] };
  const org = props.ORGANIZER && props.ORGANIZER[0] ? mailOf(props.ORGANIZER[0].value) : '';
  const me = owner || org;
  const seen = new Set();
  const names = [];
  let count = 0;
  list.forEach((p) => {
    const kind = String(p.params.CUTYPE || '').toUpperCase();
    if (kind === 'RESOURCE' || kind === 'ROOM') return;
    if (String(p.params.PARTSTAT || '').toUpperCase() === 'DECLINED') return;
    const mail = mailOf(p.value);
    if (me && mail === me) return;
    const key = mail || String(p.params.CN || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    count++;
    let name = cleanText(String(p.params.CN || ''), MAX_GUEST_NAME);
    if (!name || name.indexOf('@') >= 0) name = cleanText((mail || name).split('@')[0], MAX_GUEST_NAME);
    if (name && names.length < MAX_GUESTS) names.push(name);
  });
  return { count: count, names: names };
}

function noteKey(text) {
  return parseInt(crypto.createHash('sha1').update(text).digest('hex').slice(0, 10), 16).toString(36);
}

// A TZID names an IANA zone. Some programs put a prefix in front of it
// ("/mozilla.org/20070129_1/America/Chicago"), so the end is tried too.
// An unknown zone is read as the hub's zone.
function resolveZone(tzid, hubTz) {
  if (!tzid) return hubTz;
  const t = tzid.trim();
  if (validZone(t)) return t;
  const m = /([A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(t);
  if (m && validZone(m[1])) return m[1];
  return hubTz;
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;

// One date or date-time value. Returns
//   { kind: 'date', day }  or  { kind: 'utc', ms }  or  { kind: 'local', day, sec, tz }
function parseTimeValue(text, isDate, tz) {
  const m = DT_RE.exec(String(text).trim().toUpperCase());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const day = dayNum(y, mo, d);
  if (!m[4] || isDate) return { kind: 'date', day: day };
  const h = +m[4];
  const mi = +m[5];
  const s = Math.min(+m[6], 59);
  if (h > 23 || mi > 59) return null;
  const sec = h * 3600 + mi * 60 + s;
  if (m[7]) return { kind: 'utc', ms: day * DAY_MS + sec * 1000 };
  return { kind: 'local', day: day, sec: sec, tz: tz };
}

// All values of one property line (EXDATE and RDATE may hold several).
function parseTimeProp(p, hubTz) {
  const isDate = String(p.params.VALUE || '').toUpperCase() === 'DATE';
  const tz = resolveZone(p.params.TZID, hubTz);
  const out = [];
  p.value.split(',').forEach((part) => {
    const v = part.split('/')[0]; // a PERIOD value: only its start is used
    const t = parseTimeValue(v, isDate, tz);
    if (t) out.push(t);
  });
  return out;
}

function timeMs(t, hubTz) {
  if (t.kind === 'utc') return t.ms;
  if (t.kind === 'local') return toUtc(t.day, t.sec, t.tz);
  return toUtc(t.day, 0, hubTz);
}

function parseDuration(text) {
  const s = String(text || '').trim().toUpperCase();
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
  if (!m || m[1] === '-' || s === 'P' || /T$/.test(s)) return null;
  return {
    days: (+m[2] || 0) * 7 + (+m[3] || 0),
    ms: ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000
  };
}

/* ---------- repeat rules ---------- */

// Returns the rule, or null when it uses something this reader does not do
// (HOURLY and smaller, BYHOUR, BYMINUTE, BYSECOND, BYWEEKNO, BYYEARDAY,
// RSCALE, SKIP), or is not valid.
function parseRrule(text) {
  const r = { freq: null, interval: 1, count: null, until: null, byDay: null, byMonthDay: null, byMonth: null, bySetPos: null, wkst: 1 };
  const ints = (v, lo, hi, zeroOk) => {
    const list = v.split(',').map((x) => x.trim());
    if (!list.every((x) => /^[+-]?\d{1,4}$/.test(x))) return null;
    const nums = list.map(Number);
    return nums.every((n) => n >= lo && n <= hi && (zeroOk || n !== 0)) ? nums : null;
  };
  const parts = String(text).trim().split(';').filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim().toUpperCase();
    if (k === 'FREQ') {
      if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(v) < 0) return null;
      r.freq = v;
    } else if (k === 'INTERVAL') {
      if (!/^\d{1,4}$/.test(v) || +v < 1) return null;
      r.interval = +v;
    } else if (k === 'COUNT') {
      if (!/^\d{1,7}$/.test(v) || +v < 1) return null;
      r.count = +v;
    } else if (k === 'UNTIL') {
      r.until = v;
    } else if (k === 'BYDAY') {
      const list = [];
      for (const x of v.split(',')) {
        const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x.trim());
        if (!m) return null;
        const n = m[1] ? +m[1] : 0;
        if (m[1] && (n === 0 || n < -53 || n > 53)) return null;
        list.push({ n: n, wd: WEEKDAYS[m[2]] });
      }
      r.byDay = list;
    } else if (k === 'BYMONTHDAY') {
      r.byMonthDay = ints(v, -31, 31, false);
      if (!r.byMonthDay) return null;
    } else if (k === 'BYMONTH') {
      r.byMonth = ints(v, 1, 12, false);
      if (!r.byMonth) return null;
    } else if (k === 'BYSETPOS') {
      r.bySetPos = ints(v, -366, 366, false);
      if (!r.bySetPos) return null;
    } else if (k === 'WKST') {
      if (!(v in WEEKDAYS)) return null;
      r.wkst = WEEKDAYS[v];
    } else {
      return null;
    }
  }
  if (!r.freq) return null;
  const ordinals = r.byDay && r.byDay.some((b) => b.n !== 0);
  if (ordinals && (r.freq === 'DAILY' || r.freq === 'WEEKLY')) return null;
  if (r.byMonthDay && r.freq === 'WEEKLY') return null;
  return r;
}

// The candidate days of one month for a MONTHLY rule (or YEARLY with BYMONTH).
function monthDays(y, m, rule, startDom) {
  const dim = daysInMonth(y, m);
  const first = dayNum(y, m, 1);
  let md = null;
  if (rule.byMonthDay) {
    md = new Set(rule.byMonthDay.map((v) => (v > 0 ? v : dim + v + 1)).filter((v) => v >= 1 && v <= dim));
  }
  let bd = null;
  if (rule.byDay) {
    bd = new Set();
    rule.byDay.forEach((b) => {
      const list = [];
      for (let d = 1; d <= dim; d++) if (weekday(first + d - 1) === b.wd) list.push(d);
      if (!b.n) list.forEach((x) => bd.add(x));
      else {
        const pick = b.n > 0 ? list[b.n - 1] : list[list.length + b.n];
        if (pick) bd.add(pick);
      }
    });
  }
  let doms;
  if (md && bd) doms = Array.from(md).filter((x) => bd.has(x));
  else if (md) doms = Array.from(md);
  else if (bd) doms = Array.from(bd);
  else doms = startDom <= dim ? [startDom] : [];
  return doms.sort((a, b) => a - b).map((x) => first + x - 1);
}

function yearDays(y, rule, startM, startDom) {
  if (!rule.byDay && !rule.byMonthDay) {
    const months = rule.byMonth || [startM];
    return months.filter((m) => startDom <= daysInMonth(y, m)).map((m) => dayNum(y, m, startDom));
  }
  if (rule.byMonth || !rule.byDay) {
    const months = rule.byMonth || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let out = [];
    months.forEach((m) => { out = out.concat(monthDays(y, m, rule, startDom)); });
    return out;
  }
  // BYDAY without BYMONTH: "20MO" counts Mondays through the whole year.
  const first = dayNum(y, 1, 1);
  const last = dayNum(y + 1, 1, 1) - 1;
  const set = new Set();
  rule.byDay.forEach((b) => {
    const list = [];
    for (let d = first; d <= last; d++) if (weekday(d) === b.wd) list.push(d);
    if (!b.n) list.forEach((x) => set.add(x));
    else {
      const pick = b.n > 0 ? list[b.n - 1] : list[list.length + b.n];
      if (pick !== undefined) set.add(pick);
    }
  });
  let days = Array.from(set);
  if (rule.byMonthDay) {
    days = days.filter((d) => {
      const p = dayParts(d);
      const dim = daysInMonth(p.y, p.m);
      return rule.byMonthDay.some((v) => (v > 0 ? v : dim + v + 1) === p.d);
    });
  }
  return days;
}

function applySetPos(days, setPos) {
  if (!setPos) return days;
  const out = new Set();
  setPos.forEach((p) => {
    const d = p > 0 ? days[p - 1] : days[days.length + p];
    if (d !== undefined) out.add(d);
  });
  return Array.from(out).sort((a, b) => a - b);
}

// Walks the rule period by period and calls emit(day) for every day after
// the first one, in order. Returns 'done', 'capped' or 'budget'.
function walkRule(rule, startDay, untilWall, sec, lastDay, skipBefore, budget, emit) {
  const I = rule.interval;
  const sp = dayParts(startDay);
  const startDow = weekday(startDay);
  const week0 = startDay - ((startDow - rule.wkst + 7) % 7);
  const month0 = sp.y * 12 + (sp.m - 1);
  let k = 0;
  // Without COUNT nothing before the window matters, so jump close to it.
  if (!rule.count && skipBefore > startDay) {
    const tp = dayParts(skipBefore);
    if (rule.freq === 'DAILY') k = Math.floor((skipBefore - startDay) / I);
    else if (rule.freq === 'WEEKLY') k = Math.floor((skipBefore - week0) / (7 * I));
    else if (rule.freq === 'MONTHLY') k = Math.floor((tp.y * 12 + tp.m - 1 - month0) / I);
    else k = Math.floor((tp.y - sp.y) / I);
    k = Math.max(0, k - 1);
  }
  let made = 1; // the first day always counts as the first one
  let produced = 0;
  for (;; k++) {
    if (--budget.left < 0) return 'budget';
    let periodStart;
    let days;
    if (rule.freq === 'DAILY') {
      periodStart = startDay + k * I;
      const p = dayParts(periodStart);
      const ok = (!rule.byMonth || rule.byMonth.indexOf(p.m) >= 0) &&
        (!rule.byDay || rule.byDay.some((b) => b.wd === weekday(periodStart))) &&
        (!rule.byMonthDay || rule.byMonthDay.some((v) => (v > 0 ? v : daysInMonth(p.y, p.m) + v + 1) === p.d));
      days = ok ? [periodStart] : [];
    } else if (rule.freq === 'WEEKLY') {
      periodStart = week0 + k * 7 * I;
      const wds = rule.byDay ? rule.byDay.map((b) => b.wd) : [startDow];
      days = [];
      for (let i = 0; i < 7; i++) {
        const d = periodStart + i;
        if (wds.indexOf(weekday(d)) < 0) continue;
        if (rule.byMonth && rule.byMonth.indexOf(dayParts(d).m) < 0) continue;
        days.push(d);
      }
    } else if (rule.freq === 'MONTHLY') {
      const mi = month0 + k * I;
      const y = Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      if (y > 2200) return 'done';
      periodStart = dayNum(y, m, 1);
      days = rule.byMonth && rule.byMonth.indexOf(m) < 0 ? [] : monthDays(y, m, rule, sp.d);
    } else {
      const y = sp.y + k * I;
      if (y > 2200) return 'done';
      periodStart = dayNum(y, 1, 1);
      days = yearDays(y, rule, sp.m, sp.d).sort((a, b) => a - b);
    }
    if (periodStart > lastDay) return 'done';
    days = applySetPos(days, rule.bySetPos);
    budget.left -= days.length;
    for (const day of days) {
      if (day <= startDay) continue;
      if (untilWall !== null && day * DAY_MS + sec * 1000 > untilWall) return 'done';
      if (rule.count && made >= rule.count) return 'done';
      made++;
      if (++produced > MAX_INSTANCES) return 'capped';
      if (day > lastDay) return 'done';
      emit(day);
    }
  }
}

/* ---------- events ---------- */

function makeId(cal, uid, key) {
  const hex = crypto.createHash('sha1').update(cal + '\n' + uid + '\n' + key).digest('hex').slice(0, 12);
  return parseInt(hex, 16).toString(36);
}

// Reads the start and length of one event. Returns null without a usable start.
function readTiming(props, hubTz) {
  const sp = props.DTSTART && props.DTSTART[0];
  if (!sp) return null;
  const st = parseTimeProp(sp, hubTz)[0];
  if (!st) return null;
  const endProp = props.DTEND && props.DTEND[0];
  const end = endProp ? parseTimeProp(endProp, hubTz)[0] : null;
  const dur = props.DURATION ? parseDuration(props.DURATION[0].value) : null;
  if (st.kind === 'date') {
    let days = 1;
    if (end && end.kind === 'date') days = end.day - st.day;
    else if (!end && dur) days = dur.days + (dur.ms > 0 ? 1 : 0);
    return { allDay: true, day: st.day, sec: 0, tz: hubTz, days: Math.max(1, days) };
  }
  const t = st.kind === 'utc'
    ? { allDay: false, day: Math.floor(st.ms / DAY_MS), sec: (st.ms % DAY_MS) / 1000, tz: 'UTC' }
    : { allDay: false, day: st.day, sec: st.sec, tz: st.tz };
  t.ms = toUtc(t.day, t.sec, t.tz);
  t.exact = 0;
  t.nominal = null;
  if (end && end.kind !== 'date') t.exact = Math.max(0, timeMs(end, hubTz) - t.ms);
  else if (!end && dur) {
    if (dur.days) t.nominal = dur;
    else t.exact = dur.ms;
  }
  return t;
}

// Keys that match an instance: 'T' + its UTC ms, or 'D' + its day.
function timeKeys(list, hubTz, allDay, tz) {
  const keys = new Set();
  list.forEach((p) => parseTimeProp(p, hubTz).forEach((t) => {
    if (t.kind === 'date') keys.add('D' + t.day);
    else if (allDay) keys.add('D' + wallDay(timeMs(t, hubTz), tz));
    else keys.add('T' + timeMs(t, hubTz));
  }));
  return keys;
}

// Turns a parsed feed into the events inside the window.
// opts: { cal, tz, window, details: 'show' | 'busy' }
// Returns { events, skipped }. skipped counts events left out because they
// use a repeat rule this reader does not do, or because the work limit or the
// 1000-instance limit was reached.
function expandEvents(parsed, opts) {
  const cal = opts.cal;
  const tz = opts.tz || DEFAULT_TZ;
  const w = opts.window;
  const busy = opts.details === 'busy';
  const budget = { left: opts.maxWork || MAX_WORK };
  const out = [];
  const seen = new Set();
  let skipped = 0;
  const midnights = new Map();
  const midnight = (d) => {
    let v = midnights.get(d);
    if (v === undefined) { v = toUtc(d, 0, tz); midnights.set(d, v); }
    return v;
  };

  const words = (props) => {
    if (busy) return { title: 'Busy', location: '', notes: '', guests: null };
    const g = guestsOf(props, opts.owner || '');
    return {
      title: cleanText(propText(props, 'SUMMARY'), MAX_TITLE) || '(No title)',
      location: cleanText(propText(props, 'LOCATION'), MAX_LOCATION),
      notes: cleanNotes(propText(props, 'DESCRIPTION'), MAX_NOTES),
      guests: g.count ? g : null
    };
  };

  function push(uid, key, txt, allDay, a, b, rec) {
    let ev;
    if (allDay) {
      if (!(a < w.toDay && b > w.fromDay)) return;
      ev = { id: makeId(cal, uid, key), cal: cal, title: txt.title, start: dayText(a), end: dayText(b), allDay: true, location: txt.location };
      if (txt.notes) ev.notes = txt.notes;
      if (txt.guests) { ev.guestCount = txt.guests.count; ev.guests = txt.guests.names.slice(); }
      ev._sort = midnight(a);
    } else {
      if (!(a < w.to && (b > w.from || a >= w.from))) return;
      ev = { id: makeId(cal, uid, key), cal: cal, title: txt.title, start: isoText(a), end: isoText(b), allDay: false, location: txt.location };
      if (txt.notes) ev.notes = txt.notes;
      if (txt.guests) { ev.guestCount = txt.guests.count; ev.guests = txt.guests.names.slice(); }
      ev._sort = a;
    }
    if (seen.has(ev.id)) return;
    if (rec) ev._rec = true; // repeating; only the to-do converter reads it, shareNotes drops it
    seen.add(ev.id);
    out.push(ev);
  }

  function pushOne(uid, key, txt, t, rec) {
    if (t.allDay) push(uid, key, txt, true, t.day, t.day + t.days, rec);
    else push(uid, key, txt, false, t.ms, endOf(t, t.day, t.ms), rec);
  }

  function endOf(t, day, ms) {
    if (t.nominal) return toUtc(day + t.nominal.days, t.sec, t.tz) + t.nominal.ms;
    return ms + t.exact;
  }

  const masters = [];
  const moved = new Map(); // uid -> Set of instance keys replaced or cancelled
  parsed.events.forEach((props, n) => {
    if (--budget.left < 0) return;
    let uid = propText(props, 'UID').trim();
    if (!uid) uid = 'no-uid-' + propText(props, 'SUMMARY') + '-' + (props.DTSTART ? props.DTSTART[0].value : n);
    const status = propText(props, 'STATUS').trim().toUpperCase();
    if (props['RECURRENCE-ID']) {
      const rp = props['RECURRENCE-ID'][0];
      const rt = parseTimeProp(rp, tz)[0];
      if (!rt) { skipped++; return; }
      const key = rt.kind === 'date' ? 'D' + rt.day : 'T' + timeMs(rt, tz);
      if (!moved.has(uid)) moved.set(uid, new Set());
      moved.get(uid).add(key);
      if (status === 'CANCELLED') return;
      const t = readTiming(props, tz);
      if (!t) { skipped++; return; }
      pushOne(uid, key, words(props), t, true);
      return;
    }
    if (status === 'CANCELLED') return;
    masters.push({ props: props, uid: uid });
  });

  for (const m of masters) {
    if (budget.left < 0) { skipped++; continue; }
    const props = m.props;
    const t = readTiming(props, tz);
    if (!t) { skipped++; continue; }
    const txt = words(props);
    const rrules = props.RRULE || [];
    const rdates = props.RDATE || [];
    if (!rrules.length && !rdates.length) {
      const key = t.allDay ? 'D' + t.day : 'T' + t.ms;
      const mv = moved.get(m.uid);
      if (!(mv && mv.has(key))) pushOne(m.uid, key, txt, t);
      continue;
    }
    if (props.EXRULE) { skipped++; continue; }
    const rules = rrules.map((p) => parseRrule(p.value));
    if (rules.some((r) => !r)) { skipped++; continue; }

    const ex = timeKeys(props.EXDATE || [], tz, t.allDay, t.tz);
    const mv = moved.get(m.uid) || new Set();
    const done = new Set();
    const lenDays = t.allDay ? t.days : Math.ceil((t.nominal ? t.nominal.days * DAY_MS + t.nominal.ms : t.exact) / DAY_MS);
    const skipBefore = w.fromDay - lenDays - 2;
    const lastDay = w.toDay + 2;

    const instance = (day, ms) => {
      const key = t.allDay ? 'D' + day : 'T' + ms;
      if (done.has(key)) return;
      done.add(key);
      if (ex.has(key) || mv.has(key)) return;
      if (!t.allDay && (ex.has('D' + day) || mv.has('D' + day))) return;
      if (t.allDay) push(m.uid, key, txt, true, day, day + t.days, true);
      else push(m.uid, key, txt, false, ms, endOf(t, day, ms), true);
    };
    const onDay = (day) => {
      if (day < skipBefore) return; // long before the window, nothing to show
      instance(day, t.allDay ? null : toUtc(day, t.sec, t.tz));
    };

    onDay(t.day);
    let bad = false;
    for (const r of rules) {
      let untilWall = null;
      if (r.until) {
        const ut = parseTimeValue(r.until, false, t.tz);
        if (!ut) { bad = true; break; }
        if (ut.kind === 'date') untilWall = (ut.day + 1) * DAY_MS - 1;
        else if (ut.kind === 'local') untilWall = ut.day * DAY_MS + ut.sec * 1000;
        else untilWall = wallNumber(ut.ms, t.tz);
      }
      const res = walkRule(r, t.day, untilWall, t.sec, lastDay, skipBefore, budget, onDay);
      if (res !== 'done') { skipped++; break; }
    }
    if (bad) { skipped++; continue; }
    rdates.forEach((p) => parseTimeProp(p, tz).forEach((rt) => {
      if (t.allDay) {
        instance(rt.kind === 'date' ? rt.day : wallDay(timeMs(rt, tz), tz), null);
      } else if (rt.kind === 'date') {
        instance(rt.day, toUtc(rt.day, t.sec, t.tz));
      } else {
        const ms = timeMs(rt, tz);
        instance(wallDay(ms, t.tz), ms);
      }
    }));
  }

  sortEvents(out);
  out.forEach((ev) => { delete ev._sort; });
  return { events: out, skipped: skipped };
}

function sortEvents(list) {
  list.sort((a, b) => (a._sort - b._sort) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

// The instant an event starts, for sorting and window checks.
function eventStartMs(ev, tz) {
  if (ev.allDay) return toUtc(parseDayText(ev.start), 0, tz);
  return Date.parse(ev.start);
}

// The calendar day (YYYY-MM-DD, hub time zone) an event starts on, or null.
function eventDay(ev, tz) {
  if (ev.allDay) return parseDayText(ev.start) === null ? null : ev.start;
  const ms = Date.parse(ev.start);
  return isFinite(ms) ? dayText(wallDay(ms, tz)) : null;
}

function dayOfMs(ms, tz) {
  return wallDay(ms, tz);
}

function inWindow(ev, w) {
  if (ev.allDay) {
    const a = parseDayText(ev.start);
    const b = parseDayText(ev.end);
    return a !== null && b !== null && a < w.toDay && b > w.fromDay;
  }
  const a = Date.parse(ev.start);
  const b = Date.parse(ev.end);
  return a < w.to && (b > w.from || a >= w.from);
}

/* ---------- stored data ---------- */

function unconfiguredData() {
  return { configured: false, calendars: [], events: [] };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const strOrNull = (v) => (typeof v === 'string' ? v : null);
const calNum = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_CALENDARS ? v : null);

// Rebuilds stored calendar data from known fields only, so a damaged or
// hand-edited state.json cannot break the server or add anything new.
function cleanData(d) {
  if (!isObj(d) || d.configured !== true) return unconfiguredData();
  const calendars = (Array.isArray(d.calendars) ? d.calendars : []).filter((c) => isObj(c) && calNum(c.cal)).slice(0, MAX_CALENDARS).map((c) => ({
    cal: c.cal, name: cleanText(str(c.name), MAX_NAME), color: /^#[0-9a-f]{6}$/.test(str(c.color)) ? c.color : '', ok: c.ok === true, error: str(c.error).slice(0, 200),
    count: Number.isInteger(c.count) ? c.count : 0, skipped: Number.isInteger(c.skipped) ? c.skipped : 0,
    updatedAt: strOrNull(c.updatedAt)
  }));
  const events = (Array.isArray(d.events) ? d.events : []).filter((e) => isObj(e) && calNum(e.cal) &&
    typeof e.id === 'string' && typeof e.start === 'string' && typeof e.end === 'string' && typeof e.allDay === 'boolean')
    .slice(0, MAX_EVENTS).map((e) => ({
      id: e.id.slice(0, 20), cal: e.cal, title: cleanText(str(e.title), MAX_TITLE), start: e.start.slice(0, 20),
      end: e.end.slice(0, 20), allDay: e.allDay, location: cleanText(str(e.location), MAX_LOCATION),
      notes: isObj(d.notes) && typeof e.note === 'string' && typeof d.notes[e.note] === 'string' ? d.notes[e.note] : '',
      guestCount: e.guestCount, guests: e.guests
    }));
  const out = shareNotes(events);
  return {
    configured: true, tz: str(d.tz), from: str(d.from), to: str(d.to), updatedAt: strOrNull(d.updatedAt),
    truncated: d.truncated === true, calendars: calendars, events: out.events, notes: out.notes
  };
}

function cleanResource(r) {
  if (!isObj(r)) return { rev: 0, data: unconfiguredData() };
  const rev = Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  return { rev: rev, data: cleanData(r.data) };
}

// Events with their notes text (e.notes) -> the shape the screen gets:
// each event carries note (a key) and notes holds each text once. Texts are
// cleaned again, and past MAX_NOTES_TOTAL characters later events go without.
function shareNotes(list) {
  const notes = {};
  let total = 0;
  const events = list.map((e) => {
    const ev = { id: e.id, cal: e.cal, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location };
    const g = cleanGuests(e);
    if (g) { ev.guestCount = g.count; ev.guests = g.names; }
    const text = typeof e.notes === 'string' && e.notes ? cleanNotes(e.notes, MAX_NOTES) : '';
    if (text) {
      const key = noteKey(text);
      if (!notes.hasOwnProperty(key) && total + text.length <= MAX_NOTES_TOTAL) {
        notes[key] = text;
        total += text.length;
      }
      if (notes.hasOwnProperty(key)) ev.note = key;
    }
    return ev;
  });
  return { events: events, notes: notes };
}

// An event's guests checked again (stored data may be hand-edited): null or { count, names }.
function cleanGuests(e) {
  if (!Number.isInteger(e.guestCount) || e.guestCount < 1) return null;
  const names = (Array.isArray(e.guests) ? e.guests : []).filter((n) => typeof n === 'string')
    .map((n) => cleanText(n, MAX_GUEST_NAME)).filter((n) => n && n.indexOf('@') < 0).slice(0, MAX_GUESTS);
  return { count: Math.min(e.guestCount, 999), names: names };
}

// Stored events (note keys) -> events with their notes text again.
function withNotesText(events, notes) {
  return (events || []).map((e) => {
    const ev = Object.assign({}, e);
    if (isObj(notes) && typeof e.note === 'string' && typeof notes[e.note] === 'string') ev.notes = notes[e.note];
    delete ev.note;
    return ev;
  });
}

// The same data apart from the "read at" times.
function sameData(a, b) {
  const strip = (d) => {
    if (!isObj(d)) return d;
    const c = Object.assign({}, d);
    delete c.updatedAt;
    if (Array.isArray(c.calendars)) {
      c.calendars = c.calendars.map((x) => {
        const y = Object.assign({}, x);
        delete y.updatedAt;
        return y;
      });
    }
    return c;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/* ---------- settings ---------- */

function isInsideAddress(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.localhost$/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (h.indexOf(':') >= 0) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h);
  return false;
}

// Checks a link. Returns a URL object, or a short reason (never the link).
function checkLink(text, allowHttp) {
  let t = String(text || '').trim();
  if (/^webcal:\/\//i.test(t)) t = 'https://' + t.slice(9);
  let u;
  try {
    u = new URL(t);
  } catch (e) {
    return 'the link is not a web address';
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return 'the link must start with https://';
  if (!u.hostname) return 'the link is not a web address';
  if (!allowHttp && isInsideAddress(u.hostname)) return 'the link points inside the home network';
  return u;
}

function cleanName(s) {
  return cleanText(s, MAX_NAME);
}

// Calendar colors: a name from this list or #rrggbb (CALENDAR_n_COLOR). The
// named ones are tuned to be readable on the TV's dark glass. '' = the TV's
// own default for that calendar number.
const COLOR_NAMES = {
  red: '#ff6b6b', orange: '#ffb36b', yellow: '#ffd166', green: '#7fdc8a', teal: '#5fd6cf',
  blue: '#6db8ff', purple: '#c7a6ff', pink: '#f592c4', gray: '#b8c4d6', grey: '#b8c4d6'
};

// Returns '#rrggbb', '' (not set) or null (not understood).
function normalizeColor(v) {
  const t = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!t) return '';
  if (Object.prototype.hasOwnProperty.call(COLOR_NAMES, t)) return COLOR_NAMES[t];
  const m = /^#?([0-9a-f]{6})$/.exec(t);
  return m ? '#' + m[1] : null;
}

// Checks the calendar list. Each entry is { cal?, name, url, details, color? }.
// Problems are logged by name and that calendar is left out.
function checkCalendars(list, log, allowHttp) {
  const out = [];
  const links = new Map();
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    if (!isObj(c)) return;
    const cal = calNum(c.cal) || i + 1;
    if (cal > MAX_CALENDARS) {
      log('calendar ' + (cleanName(c.name) || 'Calendar ' + cal) + ': only ' + MAX_CALENDARS + ' calendars are allowed, skipped');
      return;
    }
    const name = cleanName(c.name) || 'Calendar ' + cal;
    const urlText = typeof c.url === 'string' ? c.url.trim() : '';
    if (!urlText) {
      if (cleanName(c.name)) log('calendar ' + name + ': has a name but no link, skipped');
      return;
    }
    const details = String(c.details === undefined || c.details === null ? '' : c.details).trim().toLowerCase() || 'show';
    if (details !== 'show' && details !== 'busy') {
      log('calendar ' + name + ': DETAILS must be show or busy, skipped');
      return;
    }
    let color = normalizeColor(c.color);
    if (color === null) {
      log('calendar ' + name + ': COLOR must be one of ' + Object.keys(COLOR_NAMES).filter((k) => k !== 'grey').join(', ') + ' or a code like #d50000; using the default color');
      color = '';
    }
    const u = checkLink(urlText, allowHttp);
    if (typeof u === 'string') {
      log('calendar ' + name + ': ' + u + ', skipped');
      return;
    }
    if (out.some((o) => o.cal === cal)) {
      log('calendar ' + name + ': number ' + cal + ' is used twice, skipped');
      return;
    }
    if (links.has(u.href)) {
      log('calendar ' + name + ': the same link as ' + links.get(u.href) + ', skipped');
      return;
    }
    links.set(u.href, name);
    out.push({ cal: cal, name: name, url: u.href, details: details, color: color });
  });
  return out.sort((a, b) => a.cal - b.cal);
}

// CALENDAR_1_NAME, CALENDAR_1_URL, CALENDAR_1_DETAILS, CALENDAR_1_COLOR ... up to 9.
function calendarsFromEnv(env) {
  const out = [];
  for (let n = 1; n <= MAX_CALENDARS; n++) {
    const url = env['CALENDAR_' + n + '_URL'];
    const name = env['CALENDAR_' + n + '_NAME'];
    if (!url && !name) continue;
    out.push({ cal: n, name: name || '', url: url || '', details: env['CALENDAR_' + n + '_DETAILS'], color: env['CALENDAR_' + n + '_COLOR'] });
  }
  return out;
}

function refreshMinutes(v, log) {
  if (v === undefined || v === null || v === '') return DEFAULT_REFRESH_MINUTES;
  const n = Number(v);
  if (!isFinite(n)) {
    log('CALENDAR_REFRESH_MINUTES is not a number; using ' + DEFAULT_REFRESH_MINUTES);
    return DEFAULT_REFRESH_MINUTES;
  }
  return Math.min(120, Math.max(1, n));
}

function timezone(v, log) {
  if (v === undefined || v === null || v === '') return DEFAULT_TZ;
  if (validZone(String(v))) return String(v);
  log('HUB_TIMEZONE "' + cleanText(String(v), 40) + '" is not a known time zone; using ' + DEFAULT_TZ);
  return DEFAULT_TZ;
}

/* ---------- fetching ---------- */

function netError(e) {
  const code = String((e && e.code) || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'could not be reached (the address was not found)';
  if (code === 'ECONNREFUSED') return 'could not be reached (connection refused)';
  if (code === 'ETIMEDOUT') return 'timed out';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'could not be read (the connection broke)';
  if (/CERT|TLS|SSL/.test(code)) return 'could not be read (secure connection failed)';
  return 'could not be reached' + (/^[A-Z0-9_]{2,40}$/.test(code) ? ' (' + code + ')' : '');
}

// Fetches one feed. Resolves { body } or { error }, never rejects. The error
// never holds the link. opts: { allowHttp, timeoutMs, track(stopFn) }
function fetchFeed(link, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let untrack = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (untrack) untrack();
      if (req) { try { req.destroy(); } catch (e) { /* gone */ } }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ error: 'timed out' }), o.timeoutMs || FETCH_TIMEOUT);
    if (o.track) untrack = o.track(() => finish({ error: 'stopped' }));

    function go(u, hops) {
      const lib = u.protocol === 'http:' ? http : https;
      try {
        req = lib.request(u, {
          method: 'GET',
          agent: false,
          headers: { 'User-Agent': 'HomeHub', Accept: 'text/calendar', 'Accept-Encoding': 'identity' }
        }, (res) => {
          const st = res.statusCode;
          if (st >= 300 && st < 400 && res.headers.location) {
            res.resume();
            if (hops >= MAX_REDIRECTS) return finish({ error: 'could not be read (too many redirects)' });
            let next;
            try { next = new URL(res.headers.location, u); } catch (e) { return finish({ error: 'could not be read (a bad redirect)' }); }
            const c = checkLink(next.href, o.allowHttp);
            if (typeof c === 'string') return finish({ error: 'could not be read (it was sent to a link that is not allowed)' });
            return go(c, hops + 1);
          }
          if (st !== 200) {
            res.resume();
            return finish({ error: 'could not be read (HTTP ' + st + ')' });
          }
          if (Number(res.headers['content-length']) > FEED_LIMIT) {
            res.resume();
            return finish({ error: 'is larger than 5 MB' });
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > FEED_LIMIT) return finish({ error: 'is larger than 5 MB' });
            chunks.push(c);
          });
          res.on('end', () => finish({ body: Buffer.concat(chunks) }));
          res.on('aborted', () => finish({ error: 'could not be read (the connection broke)' }));
          res.on('error', () => finish({ error: 'could not be read (the connection broke)' }));
        });
      } catch (e) {
        return finish({ error: 'could not be reached' });
      }
      req.on('error', (e) => finish({ error: netError(e) }));
      req.end();
    }

    const first = checkLink(link, o.allowHttp);
    if (typeof first === 'string') return finish({ error: first });
    go(first, 0);
  });
}

/* ---------- the reader ---------- */

// o: { calendars (checked), tz, refreshMs, allowHttp, timeoutMs, now(), log(s),
//      current() -> the stored data, publish(data, changed) }
function createReader(o) {
  const tz = o.tz || DEFAULT_TZ;
  const now = () => o.now().getTime();
  const log = o.log;
  const cals = o.calendars.map((c) => ({
    cfg: c, ok: false, error: 'not read yet', events: [], skipped: 0, lastGood: null, loggedError: ''
  }));
  const stoppers = new Set();
  let running = null;
  let timer = null;
  let closed = false;
  let lastRefresh = null;

  // Starts from what state.json had, so a restart keeps showing events.
  const stored = o.current();
  if (stored && stored.configured === true) {
    cals.forEach((c) => {
      const old = (stored.calendars || []).find((x) => x.cal === c.cfg.cal && x.name === c.cfg.name);
      if (!old) return;
      c.ok = old.ok;
      c.error = old.ok ? '' : old.error || 'not read yet';
      c.skipped = old.skipped;
      c.lastGood = old.updatedAt ? Date.parse(old.updatedAt) || null : null;
      c.events = withNotesText(stored.events, stored.notes).filter((e) => e.cal === c.cfg.cal);
    });
  }

  function assemble(t) {
    const w = windowFor(t, tz);
    let all = [];
    cals.forEach((c) => {
      if (!c.ok && (c.lastGood === null || t - c.lastGood > KEEP_FAILED_MS)) c.events = [];
      c.events = c.events.filter((e) => inWindow(e, w));
      all = all.concat(typeof o.hide === 'function' ? c.events.filter((e) => !o.hide(e)) : c.events);
    });
    all.forEach((e) => { e._sort = eventStartMs(e, tz); });
    sortEvents(all);
    const truncated = all.length > MAX_EVENTS;
    if (truncated) all = all.slice(0, MAX_EVENTS);
    const shared = shareNotes(all);
    all = shared.events;
    return {
      configured: true,
      tz: tz,
      from: isoText(w.from),
      to: isoText(w.to),
      updatedAt: isoText(t),
      truncated: truncated,
      calendars: cals.map((c) => ({
        cal: c.cfg.cal,
        name: c.cfg.name,
        color: c.cfg.color || '',
        ok: c.ok,
        error: c.ok ? '' : c.error,
        count: all.filter((e) => e.cal === c.cfg.cal).length,
        skipped: c.skipped,
        updatedAt: c.lastGood === null ? null : isoText(c.lastGood)
      })),
      events: all,
      notes: shared.notes
    };
  }

  async function readAll() {
    let fresh = []; // events read just now (not kept from an earlier round)
    for (const c of cals) {
      if (closed) return null;
      const r = await fetchFeed(c.cfg.url, {
        allowHttp: o.allowHttp,
        timeoutMs: o.timeoutMs,
        track: (fn) => { stoppers.add(fn); return () => stoppers.delete(fn); }
      });
      if (closed) return null;
      const t = now();
      let error = r.error || '';
      if (!error) {
        try {
          const parsed = parseIcs(r.body);
          if (!parsed) error = 'did not look like a calendar';
          else {
            const res = expandEvents(parsed, { cal: c.cfg.cal, tz: tz, window: windowFor(t, tz), details: c.cfg.details, owner: ownerOf(c.cfg.url) });
            c.ok = true;
            c.error = '';
            c.events = res.events;
            fresh = fresh.concat(res.events);
            c.skipped = res.skipped;
            c.lastGood = t;
            if (c.loggedError) log('calendar ' + c.cfg.name + ': can be read again');
            c.loggedError = '';
          }
        } catch (e) {
          error = 'could not be understood';
        }
      }
      if (error) {
        c.ok = false;
        c.error = error;
        if (c.loggedError !== error) log('calendar ' + c.cfg.name + ': ' + error);
        c.loggedError = error;
      }
    }
    const t = now();
    if (typeof o.convert === 'function' && fresh.length) {
      try { o.convert(fresh, t); } catch (e) { log('calendar: the to-do converter failed'); }
    }
    const data = assemble(t);
    lastRefresh = t;
    const changed = !sameData(data, o.current());
    o.publish(data, changed);
    return { changed: changed, data: data };
  }

  // Reads every calendar now. A second call while one runs joins it.
  function refresh() {
    if (!cals.length || closed) return Promise.resolve({ changed: false, data: o.current() });
    if (running) return running;
    running = readAll().catch((e) => {
      log('calendar: the refresh failed (' + (e && e.name) + ')');
      return null;
    }).then((r) => {
      running = null;
      return r;
    });
    return running;
  }

  function schedule(ms) {
    if (closed) return;
    timer = setTimeout(() => {
      timer = null;
      refresh().then(() => schedule(o.refreshMs));
    }, ms);
    if (timer.unref) timer.unref();
  }

  return {
    configured: cals.length > 0,
    start: () => { if (cals.length) schedule(0); },
    refresh: refresh,
    lastRefresh: () => (lastRefresh === null ? null : isoText(lastRefresh)),
    running: () => !!running,
    debug: () => ({ configured: cals.length > 0, calendars: cals.length, timer: !!timer, refreshing: !!running }),
    close: () => {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      Array.from(stoppers).forEach((fn) => fn());
    }
  };
}

module.exports = {
  DEFAULT_TZ: DEFAULT_TZ,
  MAX_EVENTS: MAX_EVENTS,
  MAX_INSTANCES: MAX_INSTANCES,
  parseIcs: parseIcs,
  eventDay: eventDay,
  dayOfMs: dayOfMs,
  dayText: dayText,
  parseDayText: parseDayText,
  expandEvents: expandEvents,
  parseRrule: parseRrule,
  zonedToUtc: zonedToUtc,
  windowFor: windowFor,
  cleanText: cleanText,
  cleanNotes: cleanNotes,
  ownerOf: ownerOf,
  shareNotes: shareNotes,
  cleanData: cleanData,
  normalizeColor: normalizeColor,
  cleanResource: cleanResource,
  unconfiguredData: unconfiguredData,
  sameData: sameData,
  checkCalendars: checkCalendars,
  calendarsFromEnv: calendarsFromEnv,
  refreshMinutes: refreshMinutes,
  timezone: timezone,
  fetchFeed: fetchFeed,
  createReader: createReader
};
