/*
 * Calendar events -> hub to-dos, run inside the Pi's own calendar refresh.
 * (It replaces the scheduled Claude task that did this at 6:41 AM and PM.)
 *
 * Rules, from the title's exact uppercase prefix:
 *   TODO:   optional. Today or tomorrow. Not repeating, no guests. The event
 *           is then hidden from the calendar view (not deleted in Google).
 *   TODO!:  must. Today or tomorrow. Repeating and guests are fine. Kept.
 *   TODO~:  passive. Today up to its lead (a trailing 0-30 number, "TODO~:
 *           School meeting 3"; none = 2 days). Repeating is fine. Kept.
 * The stored title keeps the prefix for ! and ~ and drops it for TODO:. The
 * level and lead go in their own fields; notes are the event description
 * plus a "[cal:...]" mark the hub never shows.
 *
 * A local ledger (data/todo-converter.json) remembers what was converted, so
 * a ticked or removed to-do does not come back. It holds event ids and dates,
 * never titles or notes. Log line: counts only, never titles or notes.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const calendar = require('./calendar');

const FILE = 'todo-converter.json';
const MAX_TITLE = 80;
const MAX_NOTES = 300;
const DEFAULT_LEAD = 2;
const MAX_LEAD = 30;
const KEEP_DAYS = 7;

// Reads a title: { kind, text, lead } or null when it has no prefix or nothing after it.
function parseTitle(title) {
  const m = /^TODO([!~]?):\s*(.*)$/.exec(String(title || '').trim());
  if (!m) return null;
  const kind = m[1] === '!' ? 'must' : m[1] === '~' ? 'passive' : 'optional';
  let text = m[2].replace(/\s+/g, ' ').trim();
  let lead = null;
  if (kind === 'passive') {
    const l = /^(.*\S) (\d{1,2})$/.exec(text);
    if (l && Number(l[2]) <= MAX_LEAD) { text = l[1]; lead = Number(l[2]); }
  }
  if (!text) return null;
  return { kind: kind, text: text, lead: lead };
}

function cut(s, n) {
  const a = Array.from(s);
  return a.length > n ? a.slice(0, n).join('').trim() : s;
}

function create(o) {
  const log = o.log || (() => {});
  const tz = o.tz || calendar.DEFAULT_TZ;
  const file = path.join(o.dataDir, FILE);
  let keys = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.v === 1 && j.keys && typeof j.keys === 'object') keys = j.keys;
  } catch (e) { /* none yet */ }

  function save() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, keys: keys }));
      fs.renameSync(tmp, file);
    } catch (e) {
      log('to-do converter: could not save its ledger');
    }
  }

  // A one-off event keeps its key when it is moved to another day; a repeating
// one needs the day (each occurrence is its own to-do).
const keyOf = (ev, date) => 'cal:ics-' + ev.id + (ev._rec ? '@' + date : '');
  const knownKey = (ev, date) => has(keyOf(ev, date)) || has('cal:ics-' + ev.id + '@' + date) || has('cal:ics-' + ev.id);
  const has = (k) => Object.prototype.hasOwnProperty.call(keys, k);
  let lastFailed = 0;

  // True for a converted TODO: event, so the calendar view skips it.
  function hides(ev) {
    if (!ev || !/^TODO:/.test(ev.title || '')) return false;
    const d = calendar.eventDay(ev, tz);
    return d !== null && knownKey(ev, d);
  }

  // events: freshly read events (with e.notes text and e._rec). Adds what is
  // due through o.add(list), which returns true when the to-dos were stored.
  function convert(events, nowMs) {
    const today = calendar.dayOfMs(nowMs, tz);
    const items = o.items();
    const have = new Set();
    items.forEach((it) => {
      have.add((it.due || '') + '\n' + it.title);
      const m = /\[(cal:[^\]]+)\]/.exec(it.notes || '');
      if (m) have.add(m[1]);
    });
    const count = { must: 0, optional: 0, passive: 0, seen: 0, failed: 0 };
    const adds = [];
    events.forEach((ev) => {
      const p = parseTitle(ev.title);
      if (!p) return;
      if (p.kind === 'optional' && (ev._rec || ev.guestCount)) return;
      const date = calendar.eventDay(ev, tz);
      if (date === null) return;
      const away = calendar.parseDayText(date) - today;
      const lead = p.kind === 'passive' ? (p.lead === null ? DEFAULT_LEAD : p.lead) : 1;
      if (away < 0 || away > lead) return;
      const key = keyOf(ev, date);
      const title = cut(p.kind === 'optional' ? p.text : (p.kind === 'must' ? 'TODO!: ' : 'TODO~: ') + p.text, MAX_TITLE);
      const same = date + '\n' + title;
      if (knownKey(ev, date) || have.has(key) || have.has(same)) { count.seen++; return; }
      have.add(key); have.add(same); // the same event in two calendars, or twice in one feed
      const tail = ' [' + key + ']';
      const raw = { title: title, due: date, level: p.kind, notes: '' };
      if (p.kind === 'passive' && p.lead !== null) raw.lead = p.lead;
      const desc = String(ev.notes || '').replace(/\s+/g, ' ').trim();
      raw.notes = (cut(desc, MAX_NOTES - tail.length) + tail).trim();
      adds.push({ raw: raw, key: key, kind: p.kind, date: date });
    });
    if (adds.length) {
      let ok = false;
      try { ok = o.add(adds.map((a) => a.raw)) === true; } catch (e) { ok = false; }
      if (ok) {
        adds.forEach((a) => { keys[a.key] = a.date; count[a.kind]++; });
      } else count.failed = adds.length;
    }
    // Forget old keys (their events are long gone).
    const old = calendar.dayText(today - KEEP_DAYS);
    let pruned = false;
    Object.keys(keys).forEach((k) => {
      if (String(keys[k]) < old) { delete keys[k]; pruned = true; }
    });
    if (adds.length || pruned) save();
    // A full list fails every refresh: say so once, not every 5 minutes.
    if (adds.length && !(count.failed && count.failed === lastFailed)) {
      log('Calendar to-dos: must ' + count.must + ' added, optional ' + count.optional + ' added, passive ' +
        count.passive + ' added, ' + count.seen + ' already converted, ' + count.failed + ' failed');
    }
    lastFailed = count.failed;
    return count;
  }

  return { convert: convert, hides: hides, size: () => Object.keys(keys).length };
}

module.exports = { create: create, parseTitle: parseTitle };
