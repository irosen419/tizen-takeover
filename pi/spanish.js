/*
 * Spanish study progress (the Flashcards widget, app/widgets/flashcards.js):
 * one SQLite table in <dataDir>/spanish.db through Node's built-in
 * node:sqlite (no npm package).
 *
 *   cards(id TEXT PRIMARY KEY, box, due, misses, first, last)
 *     id      'tener.pret.1' (verb, tense pres|pret|imp|fut, person 0-4)
 *     box     0 new or missed, 1..5 known; due again INTERVALS[box] days after
 *             the last answer (1, 3, 7, 14, 30). The same rule as apply() in
 *             app/flash-math.js; pi/spanish-test.js checks they agree.
 *     due     'YYYY-MM-DD', the Pi's local day
 *     first   the day the card was first answered (how many new today)
 *     last    the day it was last answered
 *
 * Routes (pi/server.js, touch door: home and Tailscale addresses, so the TV,
 * the wall tablet and the phone all reach them):
 *   GET  /spanish/progress   { ok, today, cards: { id: [box, due, misses] }, intro, reviewed }
 *   POST /spanish/ops        { ops: [{ id, r: 'got' | 'again' }] } -> the same, for the
 *                            changed cards only (cards), plus intro and reviewed
 *
 * Logs counts only. Tests: node pi/spanish-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let sqlite;
function loadSqlite() {
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }
  }
  return sqlite;
}
function available() { return !!loadSqlite(); }

const INTERVALS = [0, 1, 3, 7, 14, 30];
const ID_RE = /^[a-záéíóúüñ]{2,20}\.(pres|pret|imp|fut)\.[0-4]$/;
const MAX_OPS = 50;
const MAX_CARDS = 5000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function addDays(day, n) {
  const p = day.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}

// A card's next [box, due, misses] after an answer on `today`.
function apply(rec, result, today) {
  const misses = rec ? rec[2] : 0;
  if (result === 'again') return [0, today, misses + 1];
  const box = Math.min((rec ? rec[0] : 0) + 1, INTERVALS.length - 1);
  return [box, addDays(today, INTERVALS[box]), misses];
}

function createSpanish(options) {
  const opt = options || {};
  if (!available()) throw new Error('this Node has no node:sqlite (Node 22.13 or newer)');
  const file = opt.file || path.join(opt.dataDir, 'spanish.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const today = typeof opt.today === 'function' ? opt.today : () => new Date().toISOString().slice(0, 10);

  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 2000');
  db.exec(`CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    box INTEGER NOT NULL CHECK (box BETWEEN 0 AND 5),
    due TEXT NOT NULL,
    misses INTEGER NOT NULL DEFAULT 0,
    first TEXT NOT NULL,
    last TEXT NOT NULL
  ) STRICT`);

  const getOne = db.prepare('SELECT box, due, misses FROM cards WHERE id = ?');
  const getAll = db.prepare('SELECT id, box, due, misses FROM cards ORDER BY id');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM cards');
  const introQ = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE first = ?');
  const reviewedQ = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE last = ?');
  const upsert = db.prepare(`INSERT INTO cards (id, box, due, misses, first, last) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET box = excluded.box, due = excluded.due, misses = excluded.misses, last = excluded.last`);

  function day() {
    const d = today();
    if (!DAY_RE.test(d)) throw new Error('bad local day');
    return d;
  }

  function totals(d) {
    return { intro: introQ.get(d).n, reviewed: reviewedQ.get(d).n };
  }

  function progress() {
    const d = day();
    const cards = {};
    getAll.all().forEach((r) => { cards[r.id] = [r.box, r.due, r.misses]; });
    return Object.assign({ ok: true, today: d, cards: cards }, totals(d));
  }

  function ops(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.ops)) throw bad('send { "ops": [{ "id": "tener.pret.1", "r": "got" }] }');
    if (!body.ops.length) throw bad('no ops');
    if (body.ops.length > MAX_OPS) throw bad('at most ' + MAX_OPS + ' ops at once');
    body.ops.forEach((o, i) => {
      if (!o || typeof o.id !== 'string' || !ID_RE.test(o.id)) throw bad('op ' + (i + 1) + ': "id" is not a card');
      if (o.r !== 'got' && o.r !== 'again') throw bad('op ' + (i + 1) + ': "r" is "got" or "again"');
    });
    const d = day();
    const changed = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      let count = countAll.get().n;
      body.ops.forEach((o) => {
        const row = getOne.get(o.id);
        if (!row && count >= MAX_CARDS) throw bad('too many cards');
        if (!row) count++;
        const next = apply(row ? [row.box, row.due, row.misses] : null, o.r, d);
        upsert.run(o.id, next[0], next[1], next[2], d, d);
        changed[o.id] = next;
      });
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* already gone */ }
      throw e;
    }
    return Object.assign({ ok: true, today: d, cards: changed }, totals(d));
  }

  return {
    progress: progress,
    ops: ops,
    count: () => countAll.get().n,
    close: () => { try { db.close(); } catch (e) { /* already closed */ } }
  };
}

module.exports = { available, createSpanish, apply, addDays, INTERVALS, ID_RE, MAX_OPS };
