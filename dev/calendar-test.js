/*
 * Date logic of the Calendar widget, in Node: node dev/calendar-test.js
 *
 * Loads app/widgets/calendar.js in a vm with a stub window (the file touches
 * no DOM while loading) and checks the pure helpers it exposes on
 * window.HUB_CALENDAR_TEST: which events fall on which day in the data's
 * time zone, all-day ends, midnight crossings, both 2026 DST days in
 * America/Chicago, overlap packing and the tile's agenda. Only what ships
 * with Node is used. Prints one line per check, then "N passed, M failed".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILE = path.join(__dirname, '..', 'app', 'widgets', 'calendar.js');
const sandbox = { window: { HUB_WIDGETS: [] }, Intl: Intl, Date: Date, Math: Math, JSON: JSON, console: console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
const T = sandbox.window.HUB_CALENDAR_TEST;
const widget = sandbox.window.HUB_WIDGETS[0];

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + (e && e.message));
  }
}

const TZ = 'America/Chicago';
const z = T.makeZone(TZ);
const day = (s) => T.dayFromText(s);
const ms = (s) => Date.parse(s);

function data(events) {
  return { configured: true, tz: TZ, events: events };
}
function idsOn(idx, d) {
  const de = T.dayEvents(idx, day(d));
  return de.allDay.map((e) => e.id).concat(de.timed.map((t) => t.ev.id));
}
// vm arrays come from another realm; compare as plain JSON.
function same(a, b, text) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), text); }

check('the widget registers as calendar and exposes its helpers', () => {
  assert.strictEqual(widget.id, 'calendar');
  assert.ok(T && typeof T.dayEvents === 'function');
  assert.strictEqual(T.WEEK_START, 0);
});

check('zone: Chicago works through Intl, and a made-up zone falls back to the TV zone', () => {
  assert.strictEqual(z.ok, true);
  const bad = T.makeZone('Not/AZone');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.wall(ms('2026-11-15T12:00:00Z')), ms('2026-11-15T12:00:00Z') - new Date(ms('2026-11-15T12:00:00Z')).getTimezoneOffset() * 60000);
});

check('zone: an engine without formatToParts reads the formatted text instead', () => {
  const proto = Intl.DateTimeFormat.prototype;
  const saved = Object.getOwnPropertyDescriptor(proto, 'formatToParts');
  delete proto.formatToParts;
  try {
    const old = T.makeZone(TZ);
    assert.strictEqual(old.ok, true);
    assert.strictEqual(old.offset(ms('2026-11-15T12:00:00Z')), -6 * 3600000);
    assert.strictEqual(old.offset(ms('2026-07-04T00:00:00Z')), -5 * 3600000);
    assert.strictEqual(old.dayOf(ms('2026-11-16T05:30:00Z')), day('2026-11-15'));
  } finally {
    Object.defineProperty(proto, 'formatToParts', saved);
  }
});

check('zone: offsets either side of both 2026 changes', () => {
  assert.strictEqual(z.offset(ms('2026-03-08T07:59:00Z')), -6 * 3600000);
  assert.strictEqual(z.offset(ms('2026-03-08T08:00:00Z')), -5 * 3600000);
  assert.strictEqual(z.offset(ms('2026-11-01T06:59:00Z')), -5 * 3600000);
  assert.strictEqual(z.offset(ms('2026-11-01T07:00:00Z')), -6 * 3600000);
});

check('zone: day starts are local midnights, 23 and 25 hours long on the change days', () => {
  assert.strictEqual(new Date(z.dayStart(day('2026-11-15'))).toISOString(), '2026-11-15T06:00:00.000Z');
  assert.strictEqual(new Date(z.dayStart(day('2026-07-04'))).toISOString(), '2026-07-04T05:00:00.000Z');
  assert.strictEqual(z.dayStart(day('2026-03-09')) - z.dayStart(day('2026-03-08')), 23 * 3600000);
  assert.strictEqual(z.dayStart(day('2026-11-02')) - z.dayStart(day('2026-11-01')), 25 * 3600000);
  // The repeated 1:30 on 1 Nov is the first one; the skipped 2:30 on 8 Mar moves forward.
  assert.strictEqual(new Date(z.utc(Date.UTC(2026, 10, 1, 1, 30))).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.strictEqual(new Date(z.utc(Date.UTC(2026, 2, 8, 2, 30))).toISOString(), '2026-03-08T08:30:00.000Z');
});

check('day: an evening event in UTC tomorrow is still today in Chicago', () => {
  const idx = T.buildIndex(data([{ id: 'a', cal: 1, title: 'Dinner', start: '2026-11-16T01:30:00Z', end: '2026-11-16T03:00:00Z', allDay: false, location: '' }]), z);
  same(idsOn(idx, '2026-11-15'), ['a']);
  same(idsOn(idx, '2026-11-16'), []);
  const t = T.dayEvents(idx, day('2026-11-15')).timed[0];
  assert.strictEqual(t.startMin, 19 * 60 + 30);
  assert.strictEqual(t.endMin, 21 * 60);
  assert.strictEqual(T.whenText(z, idx.events[0]), '7:30 – 9:00 PM');
});

check('day: a multi-day all-day event is on each day it covers, and not on its end date', () => {
  const idx = T.buildIndex(data([{ id: 'v', cal: 2, title: 'Visit', start: '2026-11-14', end: '2026-11-17', allDay: true, location: '' }]), z);
  same(idsOn(idx, '2026-11-13'), []);
  same(idsOn(idx, '2026-11-14'), ['v']);
  same(idsOn(idx, '2026-11-16'), ['v']);
  same(idsOn(idx, '2026-11-17'), []);
  assert.strictEqual(T.whenText(z, idx.events[0]), 'All day, Nov 14 – 16');
});

check('day: a one-day all-day event with a missing or bad end still shows for its day', () => {
  const idx = T.buildIndex(data([{ id: 'h', cal: 1, title: 'Holiday', start: '2026-11-26', end: '2026-11-26', allDay: true, location: '' }]), z);
  same(idsOn(idx, '2026-11-26'), ['h']);
  same(idsOn(idx, '2026-11-27'), []);
  assert.strictEqual(T.whenText(z, idx.events[0]), 'All day');
});

check('day: a timed event across midnight shows on both days, clipped', () => {
  const idx = T.buildIndex(data([{ id: 'f', cal: 1, title: 'Flight', start: '2026-11-22T04:00:00Z', end: '2026-11-22T07:30:00Z', allDay: false, location: '' }]), z);
  // 10:00 PM Sat 21 to 1:30 AM Sun 22, Chicago.
  same(idsOn(idx, '2026-11-21'), ['f']);
  same(idsOn(idx, '2026-11-22'), ['f']);
  const a = T.dayEvents(idx, day('2026-11-21')).timed[0];
  const b = T.dayEvents(idx, day('2026-11-22')).timed[0];
  assert.strictEqual(a.startMin, 22 * 60);
  assert.strictEqual(a.endMin, 1440);
  assert.strictEqual(a.after, true);
  assert.strictEqual(b.startMin, 0);
  assert.strictEqual(b.endMin, 90);
  assert.strictEqual(b.before, true);
  assert.strictEqual(T.whenText(z, idx.events[0]), 'Sat 10:00 PM – Sun 1:30 AM');
});

check('day: an event ending exactly at midnight is not on the next day', () => {
  const idx = T.buildIndex(data([{ id: 'm', cal: 1, title: 'Late', start: '2026-11-16T04:00:00Z', end: '2026-11-16T06:00:00Z', allDay: false, location: '' }]), z);
  same(idsOn(idx, '2026-11-15'), ['m']);
  same(idsOn(idx, '2026-11-16'), []);
  assert.strictEqual(T.dayEvents(idx, day('2026-11-15')).timed[0].endMin, 1440);
});

check('DST 1 Nov 2026: both 1:30s are on 1 Nov, 11:30 PM CST is still 1 Nov, midnight CST is 2 Nov', () => {
  const idx = T.buildIndex(data([
    { id: 'cdt', cal: 1, title: 'First 1:30', start: '2026-11-01T06:30:00Z', end: '2026-11-01T06:45:00Z', allDay: false, location: '' },
    { id: 'cst', cal: 1, title: 'Second 1:30', start: '2026-11-01T07:30:00Z', end: '2026-11-01T07:45:00Z', allDay: false, location: '' },
    { id: 'late', cal: 1, title: 'Late', start: '2026-11-02T05:30:00Z', end: '2026-11-02T05:45:00Z', allDay: false, location: '' },
    { id: 'mid', cal: 1, title: 'Midnight', start: '2026-11-02T06:00:00Z', end: '2026-11-02T06:30:00Z', allDay: false, location: '' },
    { id: 'early', cal: 1, title: 'Before', start: '2026-11-01T04:59:00Z', end: '2026-11-01T05:30:00Z', allDay: false, location: '' }
  ]), z);
  same(idsOn(idx, '2026-10-31'), ['early']);
  same(idsOn(idx, '2026-11-01'), ['early', 'cdt', 'cst', 'late']);
  same(idsOn(idx, '2026-11-02'), ['mid']);
  const de = T.dayEvents(idx, day('2026-11-01'));
  assert.strictEqual(de.timed[1].startMin, 90);
  assert.strictEqual(de.timed[2].startMin, 90);
  assert.strictEqual(de.timed[3].startMin, 23 * 60 + 30);
  assert.strictEqual(T.timeText(z, ms('2026-11-01T07:30:00Z')), '1:30 AM');
});

check('DST 8 Mar 2026: 1:59 CST and 3:00 CDT are an hour apart on screen, 11:59 PM CDT is still 8 Mar', () => {
  const idx = T.buildIndex(data([
    { id: 'a', cal: 1, title: 'Before', start: '2026-03-08T07:59:00Z', end: '2026-03-08T08:00:00Z', allDay: false, location: '' },
    { id: 'b', cal: 1, title: 'After', start: '2026-03-08T08:00:00Z', end: '2026-03-08T09:00:00Z', allDay: false, location: '' },
    { id: 'c', cal: 1, title: 'Late', start: '2026-03-09T04:59:00Z', end: '2026-03-09T05:00:00Z', allDay: false, location: '' },
    { id: 'd', cal: 1, title: 'Monday', start: '2026-03-09T05:00:00Z', end: '2026-03-09T05:30:00Z', allDay: false, location: '' }
  ]), z);
  same(idsOn(idx, '2026-03-08'), ['a', 'b', 'c']);
  same(idsOn(idx, '2026-03-09'), ['d']);
  const de = T.dayEvents(idx, day('2026-03-08'));
  assert.strictEqual(de.timed[0].startMin, 119);
  assert.strictEqual(de.timed[1].startMin, 180);
  assert.strictEqual(de.timed[2].startMin, 23 * 60 + 59);
  assert.strictEqual(T.whenText(z, idx.events[1]), '3:00 – 4:00 AM');
});

check('all-day events on DST days are one whole local day', () => {
  const idx = T.buildIndex(data([{ id: 'x', cal: 1, title: 'x', start: '2026-11-01', end: '2026-11-02', allDay: true, location: '' }]), z);
  const ev = idx.events[0];
  assert.strictEqual(new Date(ev.s).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.strictEqual(new Date(ev.e).toISOString(), '2026-11-02T06:00:00.000Z');
});

check('pack: overlapping events go side by side, a later one reuses the first column', () => {
  const items = [
    { startMin: 540, endMin: 600 }, { startMin: 550, endMin: 660 }, { startMin: 600, endMin: 630 },
    { startMin: 700, endMin: 720 }
  ];
  T.pack(items, 0);
  same(items.map((i) => i.col), [0, 1, 0, 0]);
  same(items.map((i) => i.cols), [2, 2, 2, 1]);
});

check('pack: a short event drawn taller than it lasts still pushes the next one aside', () => {
  const items = [{ startMin: 540, endMin: 545 }, { startMin: 550, endMin: 600 }];
  T.pack(items, 30);
  same(items.map((i) => i.col), [0, 1]);
  T.pack(items, 0);
  same(items.map((i) => i.col), [0, 0]);
});

check('agenda: ended events are dropped, the current one is "now", all-day kept', () => {
  const idx = T.buildIndex(data([
    { id: 'gone', cal: 1, title: 'Breakfast', start: '2026-11-15T14:00:00Z', end: '2026-11-15T15:00:00Z', allDay: false, location: '' },
    { id: 'on', cal: 1, title: 'Call', start: '2026-11-15T16:30:00Z', end: '2026-11-15T17:00:00Z', allDay: false, location: '' },
    { id: 'later', cal: 2, title: 'Dinner', start: '2026-11-16T00:00:00Z', end: '2026-11-16T01:00:00Z', allDay: false, location: '' },
    { id: 'ad', cal: 3, title: 'Visit', start: '2026-11-14', end: '2026-11-17', allDay: true, location: '' }
  ]), z);
  const a = T.agenda(idx, ms('2026-11-15T16:40:00Z'));
  assert.strictEqual(a.today, day('2026-11-15'));
  same(a.allDay.map((e) => e.id), ['ad']);
  same(a.upcoming.map((u) => u.ev.id + (u.now ? '*' : '')), ['on*', 'later']);
  assert.strictEqual(a.next, null);
});

check('agenda: nothing left today names the next event, tomorrow or later', () => {
  const idx = T.buildIndex(data([
    { id: 'gone', cal: 1, title: 'Breakfast', start: '2026-11-15T14:00:00Z', end: '2026-11-15T15:00:00Z', allDay: false, location: '' },
    { id: 'tmr', cal: 1, title: 'Dentist', start: '2026-11-16T15:00:00Z', end: '2026-11-16T16:00:00Z', allDay: false, location: '' }
  ]), z);
  const a = T.agenda(idx, ms('2026-11-15T23:00:00Z'));
  assert.strictEqual(a.upcoming.length, 0);
  assert.strictEqual(a.had, true);
  assert.strictEqual(a.next.id, 'tmr');
  assert.strictEqual(T.relDay(a.next.startDay, a.today) + ' ' + T.timeText(z, a.next.s), 'Tomorrow 9:00 AM');
  assert.strictEqual(T.relDay(day('2026-11-18'), a.today), 'Wednesday');
  assert.strictEqual(T.relDay(day('2026-11-24'), a.today), 'Tue, Nov 24');
});

check('agenda: at 11:59 PM UTC-wise tomorrow, Chicago still says today', () => {
  const idx = T.buildIndex(data([]), z);
  // 05:59 UTC on the 16th is 11:59 PM on the 15th in Chicago.
  assert.strictEqual(T.agenda(idx, ms('2026-11-16T05:59:00Z')).today, day('2026-11-15'));
  assert.strictEqual(T.agenda(idx, ms('2026-11-16T06:00:00Z')).today, day('2026-11-16'));
});

check('normalize: bad rows are skipped, duplicate ids made unique, nothing throws', () => {
  const idx = T.buildIndex(data([
    null, 'x', { id: 'a', cal: 1, title: 'ok', start: '2026-11-15T15:00:00Z', end: '2026-11-15T16:00:00Z', allDay: false },
    { id: 'a', cal: 1, title: 'dup', start: '2026-11-15T17:00:00Z', end: '2026-11-15T16:00:00Z', allDay: false },
    { id: 'b', cal: 1, title: 'bad date', start: '2026-02-30', end: '2026-03-01', allDay: true },
    { id: 'c', cal: 1, title: 'bad time', start: 'soon', end: 'later', allDay: false }
  ]), z);
  same(idx.events.map((e) => e.id), ['a', 'a~3']);
  assert.strictEqual(idx.events[1].e, idx.events[1].s);
  T.buildIndex({ configured: true }, z);
  T.buildIndex(null, z);
});

check('week starts on Sunday; months move without spilling past their end', () => {
  assert.strictEqual(T.weekStartOf(day('2026-11-18')), day('2026-11-15'));
  assert.strictEqual(T.weekStartOf(day('2026-11-15')), day('2026-11-15'));
  assert.strictEqual(T.addMonths(day('2027-01-31'), 1), day('2027-02-28'));
  assert.strictEqual(T.addMonths(day('2026-12-15'), 1), day('2027-01-15'));
});

check('parseIso: the Pi\'s UTC form, with and without seconds', () => {
  assert.strictEqual(T.parseIso('2026-11-16T15:00:00Z'), ms('2026-11-16T15:00:00Z'));
  assert.strictEqual(T.parseIso('2026-11-16T15:00Z'), ms('2026-11-16T15:00:00Z'));
  assert.ok(isNaN(T.parseIso('nope')));
});

check('notes: an event takes its text from data.notes by key; missing or bad keys give none', () => {
  const d = { configured: true, tz: TZ, notes: { k1: 'Line one\r\nLine two  ' },
    events: [{ id: 'a', cal: 1, title: 'A', start: '2026-11-21T16:00:00Z', end: '2026-11-21T16:15:00Z', note: 'k1' },
      { id: 'b', cal: 1, title: 'B', start: '2026-11-21T17:00:00Z', end: '2026-11-21T17:15:00Z', note: 'nope' },
      { id: 'c', cal: 1, title: 'C', start: '2026-11-21T18:00:00Z', end: '2026-11-21T18:15:00Z' }] };
  const n = T.normalize(d, z);
  same(n.map((e) => e.notes), ['Line one\nLine two', '', '']);
  assert.strictEqual(T.notesOf(n[0]), 'Line one\nLine two');
  assert.strictEqual(T.notesOf(n[1]), '');
  const old = T.normalize({ configured: true, tz: TZ, events: d.events }, z);
  assert.ok(old.every((e) => e.notes === ''), 'an older Pi without notes still works');
});

check('notes: Guest mode hides them', () => {
  const n = T.normalize({ configured: true, tz: TZ, notes: { k: 'Secret' }, events: [{ id: 'a', cal: 1, title: 'A', start: '2026-11-21T16:00:00Z', end: '2026-11-21T16:15:00Z', note: 'k' }] }, z);
  sandbox.window.HUB_GUEST = { on: () => true };
  try { assert.strictEqual(T.notesOf(n[0]), ''); } finally { delete sandbox.window.HUB_GUEST; }
  assert.strictEqual(T.notesOf(n[0]), 'Secret');
});

check('notes: paragraphs become blocks; a short first line with more under it is a heading', () => {
  const b = T.noteBlocks('Check each plant first. Water slowly.\n\nGolden pothos\nWater when half dry.\nIt handles drying out.\n\n\nAsk about:\nthe tile\n\nOne line only');
  same(b.map((x) => x.head), ['', 'Golden pothos', '', '']);
  same(b[1].lines, ['Water when half dry.', 'It handles drying out.']);
  same(b[2].lines, ['Ask about:', 'the tile'], 'a line ending in a colon is not a heading');
  same(b[3].lines, ['One line only']);
});

check('guests: "1 guest" / "3 guests", nothing without, nothing in Guest mode; guests alone make an event readable', () => {
  const n = T.normalize({ configured: true, tz: TZ, events: [
    { id: 'a', cal: 1, title: 'A', start: '2026-11-21T16:00:00Z', end: '2026-11-21T16:15:00Z', guestCount: 1, guests: ['Ana'] },
    { id: 'b', cal: 1, title: 'B', start: '2026-11-21T17:00:00Z', end: '2026-11-21T17:15:00Z', guestCount: 3, guests: ['Ana', 'Sam', 'Jo'] },
    { id: 'c', cal: 1, title: 'C', start: '2026-11-21T18:00:00Z', end: '2026-11-21T18:15:00Z' }] }, z);
  same(n.map((e) => T.guestText(e)), ['1 guest', '3 guests', '']);
  same(n[1].guests, ['Ana', 'Sam', 'Jo']);
  assert.ok(T.readable(n[0]) && !T.readable(n[2]));
  sandbox.window.HUB_GUEST = { on: () => true };
  try { assert.strictEqual(T.guestText(n[1]), ''); assert.ok(!T.readable(n[0])); } finally { delete sandbox.window.HUB_GUEST; }
});

check('to-do prefix is hidden and the level kept', () => {
  const n = T.normalize({ events: ['TODO!: Shot', 'TODO: Call', 'TODO~: Visit 5', 'TODO:', 'Todoist', 'Todo: mom'].map((t, i) => (
    { id: 't' + i, cal: 1, title: t, start: '2026-11-21', end: '2026-11-21', allDay: true })) }, z);
  same(n.map((e) => e.title).sort(), ['Call', 'TODO:', 'Todoist', 'Todo: mom', 'Visit', 'Shot'].sort());
  same(n.filter((e) => e.todo).map((e) => e.todo).sort(), ['must', 'optional', 'passive']);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
