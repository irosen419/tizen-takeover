/* Tests for todoconvert.js: calendar events -> hub to-dos. Run: node todoconvert-test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cal = require('./calendar');
const conv = require('./todoconvert');

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-11-20T15:00:00Z'); // 9 AM Friday, Chicago
let passed = 0;
let failed = 0;
const dirs = [];

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('ok   ' + name); },
    (e) => { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack).split('\n').slice(0, 4).join('\n     ')); });
}

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-todoconv-')); dirs.push(d); return d; };

function vevent(uid, summary, dtstart, more) {
  return 'BEGIN:VEVENT\nUID:' + uid + '\nSUMMARY:' + summary + '\n' + dtstart + '\n' + (more || '') + 'END:VEVENT\n';
}
const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\n' + [
  vevent('a1', 'TODO: Buy milk', 'DTSTART;VALUE=DATE:20261121', 'DESCRIPTION:Oat\\, not dairy\n'),
  vevent('a2', 'TODO: Weekly thing', 'DTSTART;VALUE=DATE:20261120', 'RRULE:FREQ=WEEKLY\n'),
  vevent('a3', 'TODO: Far away', 'DTSTART;VALUE=DATE:20261125'),
  vevent('a4', 'TODO!: Take weekly shot', 'DTSTART;TZID=America/Chicago:20261120T200000', 'RRULE:FREQ=WEEKLY\n'),
  vevent('a5', 'TODO~: School meeting 3', 'DTSTART;VALUE=DATE:20261123'),
  vevent('a6', 'TODO~: Room 101', 'DTSTART;VALUE=DATE:20261123'),
  vevent('a7', 'TODO: With guest', 'DTSTART;VALUE=DATE:20261120', 'ORGANIZER;CN=Ian:mailto:ian@example.com\nATTENDEE;CN=Bob:mailto:bob@example.com\n'),
  vevent('a8', 'todo: lowercase', 'DTSTART;VALUE=DATE:20261120'),
  vevent('a9', 'Dinner', 'DTSTART;VALUE=DATE:20261120')
].join('') + 'END:VCALENDAR\n';

function events() {
  const w = cal.windowFor(NOW, TZ);
  return cal.expandEvents(cal.parseIcs(ICS), { cal: 1, tz: TZ, window: w, details: 'show' }).events;
}

function make(dir, items, logs) {
  const store = items || [];
  return conv.create({
    dataDir: dir, tz: TZ, log: (s) => logs && logs.push(s),
    items: () => store,
    add: (list) => { list.forEach((r) => store.unshift(r)); return true; }
  });
}

async function main() {
  await check('title parsing: prefixes, lead, plain titles', () => {
    assert.deepStrictEqual(conv.parseTitle('TODO: Buy milk'), { kind: 'optional', text: 'Buy milk', lead: null });
    assert.strictEqual(conv.parseTitle('TODO!: Shot').kind, 'must');
    assert.deepStrictEqual(conv.parseTitle('TODO~: School meeting 3'), { kind: 'passive', text: 'School meeting', lead: 3 });
    assert.strictEqual(conv.parseTitle('TODO~: Dentist 0').lead, 0);
    ['TODO~: Room 101', 'TODO~: Pay rent 2nd', 'TODO~: Pickup 3pm', 'TODO~: Plan-3', 'TODO~: Over 31'].forEach((t) => {
      const p = conv.parseTitle(t);
      assert.strictEqual(p.lead, null, t);
    });
    assert.strictEqual(conv.parseTitle('TODO~: 3').text, '3');
    assert.strictEqual(conv.parseTitle('TODO!: Take 5').lead, null);
    assert.strictEqual(conv.parseTitle('TODO!: Take 5').text, 'Take 5');
    assert.strictEqual(conv.parseTitle('todo: x'), null);
    assert.strictEqual(conv.parseTitle('Dinner'), null);
    assert.strictEqual(conv.parseTitle('TODO:'), null);
  });

  await check('converts the right events with the right levels, leads and notes', () => {
    const logs = [];
    const items = [];
    const c = make(tmp(), items, logs);
    const n = c.convert(events(), NOW);
    assert.deepStrictEqual([n.must, n.optional, n.passive, n.failed], [1, 1, 1, 0]);
    const by = (t) => items.find((i) => i.title === t);
    const milk = by('Buy milk');
    assert.strictEqual(milk.level, 'optional');
    assert.strictEqual(milk.due, '2026-11-21');
    assert.ok(/^Oat, not dairy \[cal:ics-[a-z0-9]+@2026-11-21\]$/.test(milk.notes), milk.notes);
    const shot = by('TODO!: Take weekly shot');
    assert.strictEqual(shot.level, 'must');
    assert.strictEqual(shot.due, '2026-11-20');
    const school = by('TODO~: School meeting');
    assert.strictEqual(school.level, 'passive');
    assert.strictEqual(school.lead, 3);
    assert.strictEqual(items.length, 3); // not the repeating TODO:, far, guest, lowercase, Room 101, Dinner
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0], 'Calendar to-dos: must 1 added, optional 1 added, passive 1 added, 0 already converted, 0 failed');
    assert.ok(!/milk|shot|school/i.test(logs[0]));
  });

  await check('a second run adds nothing, even after a to-do is removed; survives a restart', () => {
    const dir = tmp();
    const items = [];
    make(dir, items).convert(events(), NOW);
    items.length = 0; // ticked and purged, or removed
    const logs = [];
    const again = make(dir, items, logs); // new object = restart
    const n = again.convert(events(), NOW + 3600000);
    assert.strictEqual(items.length, 0);
    assert.strictEqual(n.seen, 3);
    assert.strictEqual(logs.length, 0); // nothing new: no log line
  });

  await check('does not duplicate a to-do already there (same title and due, or same mark)', () => {
    const items = [{ title: 'Buy milk', due: '2026-11-21', notes: '', level: 'optional' }];
    const n = make(tmp(), items).convert(events(), NOW);
    assert.strictEqual(n.optional, 0);
    assert.strictEqual(n.seen, 1);
  });

  await check('TODO~: waits for its lead; TODO!: waits for tomorrow', () => {
    const items = [];
    const c = make(tmp(), items);
    const early = NOW - 2 * 86400000; // Wed Nov 18: school meeting is 5 days off, Friday shot 2 days off
    c.convert(events(), early);
    assert.strictEqual(items.length, 0);
    c.convert(events(), NOW - 86400000); // Thu: shot tomorrow? the shot is Fri Nov 20 = tomorrow; meeting is 4 away
    assert.deepStrictEqual(items.map((i) => i.level), ['must']);
  });

  await check('hides only converted TODO: events; others stay visible', () => {
    const c = make(tmp());
    const list = events();
    assert.ok(!list.some((e) => c.hides(e)));
    c.convert(list, NOW);
    const hidden = list.filter((e) => c.hides(e)).map((e) => e.title);
    assert.deepStrictEqual(hidden, ['TODO: Buy milk']);
  });

  await check('a failed add is not remembered, and is counted', () => {
    const logs = [];
    const c = conv.create({ dataDir: tmp(), tz: TZ, log: (s) => logs.push(s), items: () => [], add: () => false });
    const n = c.convert(events(), NOW);
    assert.strictEqual(n.failed, 3);
    assert.strictEqual(c.size(), 0);
    assert.ok(/3 failed/.test(logs[0]));
  });

  await check('ledger forgets keys a week after their date and never stores titles', () => {
    const dir = tmp();
    const c = make(dir);
    c.convert(events(), NOW);
    const text = fs.readFileSync(path.join(dir, 'todo-converter.json'), 'utf8');
    assert.ok(!/milk|shot|school/i.test(text));
    assert.ok(c.size() === 3);
    c.convert([], NOW + 14 * 86400000);
    assert.strictEqual(c.size(), 0);
  });

  await check('reader: converts on a refresh and hides the converted TODO: event', async () => {
    const feed = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/calendar'); r.end(ICS); });
    await new Promise((res) => feed.listen(0, '127.0.0.1', res));
    const dir = tmp();
    const items = [];
    const c = make(dir, items);
    let data = null;
    const reader = cal.createReader({
      calendars: [{ cal: 1, name: 'Ian', url: 'http://127.0.0.1:' + feed.address().port + '/a.ics', details: 'show' }],
      tz: TZ, refreshMs: 1e9, allowHttp: true, now: () => new Date(NOW), log: () => {},
      current: () => data || cal.unconfiguredData(),
      publish: (d) => { data = d; },
      convert: (e, t) => c.convert(e, t), hide: (e) => c.hides(e)
    });
    await reader.refresh();
    reader.close();
    feed.close();
    assert.strictEqual(items.length, 3);
    const titles = data.events.map((e) => e.title);
    assert.ok(!titles.includes('TODO: Buy milk'));
    assert.ok(titles.includes('TODO!: Take weekly shot') && titles.includes('TODO: Weekly thing') && titles.includes('Dinner'));
    assert.ok(data.events.every((e) => !('_rec' in e)));
  });

  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* fine */ } });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
