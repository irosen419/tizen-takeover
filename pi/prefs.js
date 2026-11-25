/*
 * Widget preferences shared by every screen (the TV, the wall tablet, a
 * phone): a choice made inside a widget is the same everywhere. Device
 * settings (Look, Language, Guest mode) stay on each screen; Guest mode has
 * its own "All screens" choice in the PIN pop-up (the "guestall" resource).
 *
 * Live resources in data/state.json, pushed like any other:
 *   prefs     { values: { key: value }, at: { key: ISO time } }
 *   guestall  { on: bool, at: ISO time } or { on: null, at: null } (never used)
 *
 * The keys are a fixed list (KEYS); anything else is refused, so a screen
 * cannot fill the file. A value of null removes the key.
 *
 *   clock.face        'digital' | 'analog' | 'sun'   (Clock tile and page)
 *   clock.hours       '12' | '24'                    (Clock, and the show times)
 *   budget.capPref    { v: 1, cardDate, keep, at }    (Budget lab's saved cap)
 *
 * Never log a value: budget.capPref holds a dollar amount.
 * Node 22, no npm packages.
 */
'use strict';

const MAX_TEXT = 40;

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }

function oneOf(list) {
  return (v) => {
    if (list.indexOf(v) < 0) throw bad('must be one of ' + list.join(', '));
    return v;
  };
}

function capPref(v) {
  if (!isObj(v) || v.v !== 1) throw bad('must be { v: 1, cardDate, keep, at }');
  if (typeof v.keep !== 'number' || !isFinite(v.keep) || Math.abs(v.keep) > 1e7) throw bad('"keep" must be a number of dollars');
  if (!isDate(v.cardDate)) throw bad('"cardDate" must be a date like 2026-12-01');
  const out = { v: 1, cardDate: v.cardDate, keep: Math.round(v.keep * 100) / 100, at: null };
  if (typeof v.at === 'string' && v.at.length <= MAX_TEXT && !isNaN(Date.parse(v.at))) out.at = v.at;
  return out;
}

const KEYS = {
  'clock.face': oneOf(['digital', 'analog', 'sun']),
  'clock.hours': oneOf(['12', '24']),
  'budget.capPref': capPref
};

function emptyData() { return { values: {}, at: {} }; }

// A clean copy of what was stored: unknown keys and bad values dropped.
function cleanResource(r) {
  const data = emptyData();
  const src = isObj(r) && isObj(r.data) ? r.data : {};
  const values = isObj(src.values) ? src.values : {};
  const at = isObj(src.at) ? src.at : {};
  Object.keys(KEYS).forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(values, k)) return;
    try {
      data.values[k] = KEYS[k](values[k]);
      if (typeof at[k] === 'string' && at[k].length <= MAX_TEXT) data.at[k] = at[k];
    } catch (e) { /* dropped */ }
  });
  return { rev: isObj(r) && typeof r.rev === 'number' ? r.rev : 0, data: data };
}

// { key, value } from a screen (or the mailbox) applied to data (a copy).
// Returns { data, changed, key }. Throws a 400 error for an unknown key or a
// bad value; nothing changes then.
function apply(data, body, nowIso) {
  if (!isObj(body) || typeof body.key !== 'string' || !Object.prototype.hasOwnProperty.call(body, 'value')) {
    throw bad('send { "key": "clock.hours", "value": "24" } (null removes it)');
  }
  const key = body.key;
  if (!Object.prototype.hasOwnProperty.call(KEYS, key)) throw bad('unknown preference "' + key.slice(0, 40) + '"');
  const cur = cleanResource({ data: data }).data;
  let value = null;
  if (body.value !== null) {
    try { value = KEYS[key](body.value); } catch (e) { throw bad('"' + key + '" ' + e.message); }
  }
  const before = Object.prototype.hasOwnProperty.call(cur.values, key) ? JSON.stringify(cur.values[key]) : 'null';
  if (before === JSON.stringify(value)) return { data: cur, changed: false, key: key };
  if (value === null) {
    delete cur.values[key];
    delete cur.at[key];
  } else {
    cur.values[key] = value;
    cur.at[key] = nowIso;
  }
  return { data: cur, changed: true, key: key };
}

/* ---------- Guest mode on every screen ---------- */

function guestEmpty() { return { on: null, at: null }; }

function guestClean(r) {
  const src = isObj(r) && isObj(r.data) ? r.data : {};
  const data = typeof src.on === 'boolean' && typeof src.at === 'string' && src.at.length <= MAX_TEXT
    ? { on: src.on, at: src.at } : guestEmpty();
  return { rev: isObj(r) && typeof r.rev === 'number' ? r.rev : 0, data: data };
}

// The words for ./hub and the mailbox: keys and times, never a value.
function showText(data) {
  const d = cleanResource({ data: data }).data;
  const keys = Object.keys(d.values);
  if (!keys.length) return 'No shared widget preferences yet.';
  return keys.map((k) => k + ' (set ' + (d.at[k] || 'earlier') + ')').join('; ');
}

module.exports = {
  KEYS: Object.keys(KEYS),
  emptyData: emptyData,
  cleanResource: cleanResource,
  apply: apply,
  guestEmpty: guestEmpty,
  guestClean: guestClean,
  showText: showText
};
