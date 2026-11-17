/*
 * The personal budget snapshot: a small JSON object the budget app on the Pi
 * sends to the hub server (POST /api/budget with the local token), which
 * keeps it as the resource "budget" and pushes it to the TV's budget tiles.
 * The contract is docs/budget-snapshot.md.
 *
 * Only totals ever arrive here: daily room, card day, goals and alerts. No
 * balances, no transactions, no amounts on alerts. The budget app talks to
 * the server on the Pi itself, so none of it goes through the cloud.
 *
 * This file only checks, merges and describes snapshots, the same way
 * awws.js does for the A World Worth Saving snapshot (and with the same text
 * rules, from awws.js). server.js stores them; hubctl.js (./hub budget ...)
 * and mailbox.js (budget.* commands) print the texts made here.
 *
 * Nothing here logs or prints labels or amounts. Every clean copy is built
 * field by field, so unknown fields (an alert's "amount", say) are dropped.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const awws = require('./awws');

const F = awws.fields;

const MAX_BYTES = 48 * 1024; // 49,152 bytes of JSON
const MAX_FUTURE_MS = 10 * 60 * 1000;
const MAX_AMOUNT = 1000000;
const MAX_DAYS = 366;
const SECTIONS = ['room', 'cardDay', 'goals', 'alerts'];
const GOAL_STATES = ['clean', 'on-pace', 'over', 'under'];
// Sections that are lists; sent as a plain list or as { asOf, items }.
const LISTS = { goals: 8, alerts: 5 };

const isObj = F.isObj;
const has = F.has;
const field = F.field;
const bad = F.bad;
const wrong = F.wrong;

function sizeText(bytes) {
  if (bytes < 1024) return F.commas(bytes) + ' bytes';
  return (Math.round(bytes / 102.4) / 10) + ' KB';
}

function plural(n, word, many) {
  return n + ' ' + (n === 1 ? word : (many || word + 's'));
}

// A dollar figure, rounded to cents. opts: { signed (may be below 0),
// above0 (must be more than 0) }.
function amountOf(o, k, where, required, opts) {
  const name = '"' + ((opts && opts.label) || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  const signed = !!(opts && opts.signed);
  const lo = signed ? -MAX_AMOUNT : 0;
  if (typeof v !== 'number' || !isFinite(v) || v < lo || v > MAX_AMOUNT || (opts && opts.above0 && v <= 0)) {
    throw wrong(name + ' must be a number ' + (opts && opts.above0 ? 'more than 0 and up to 1,000,000' :
      signed ? 'from -1,000,000 to 1,000,000' : 'from 0 to 1,000,000'), where);
  }
  // Halves round away from 0, so -12.345 is -12.35 like 12.345 is 12.35.
  return (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100) / 100;
}

function requiredBool(o, k, where) {
  if (field(o, k) === undefined) throw wrong('"' + k + '" is missing (true or false)', where);
  return F.boolOf(o, k, where);
}

/* ---------- the sections ---------- */

const CHECK = {
  room: (s) => {
    const out = {};
    out.cap = amountOf(s, 'cap', '', true, { above0: true });
    out.roomPerDay = amountOf(s, 'roomPerDay', '', true, { signed: true });
    F.put(out, 'roomIfRefund', amountOf(s, 'roomIfRefund', '', false, { signed: true }));
    out.daysLeft = F.wholeOf(s, 'daysLeft', '', true, { max: MAX_DAYS });
    out.throughDate = F.dateOf(s, 'throughDate', '', true);
    return out;
  },

  cardDay: (s) => {
    const out = {};
    out.date = F.dateOf(s, 'date', '', true);
    out.daysAway = F.wholeOf(s, 'daysAway', '', true, { max: MAX_DAYS });
    out.covered = requiredBool(s, 'covered', '');
    const short = amountOf(s, 'shortBy', '', false);
    if (short !== undefined && out.covered) throw wrong('"shortBy" is only for a card day that is not covered ("covered": false)');
    F.put(out, 'shortBy', short);
    const transfers = F.listOf(s, 'transfers', 6, '');
    if (transfers !== undefined) {
      out.transfers = F.eachEntry(transfers, 'transfer', (e, where) => ({
        label: F.textOf(e, 'label', 24, where, true),
        amount: amountOf(e, 'amount', where, true)
      }));
    }
    const pay = F.listOf(s, 'paychecks', 4, '');
    if (pay !== undefined) {
      out.paychecks = pay.map((v, n) => F.dateOf({ d: v }, 'd', 'paycheck ' + (n + 1), true, 'paychecks'));
    }
    return out;
  },

  goals: (s) => {
    const items = F.listOf(s, 'items', LISTS.goals, '', true);
    return {
      items: F.eachEntry(items, 'goal', (e, where) => {
        const g = { label: F.textOf(e, 'label', 30, where, true), state: F.choiceOf(e, 'state', GOAL_STATES, where) };
        F.put(g, 'text', F.textOf(e, 'text', 20, where));
        const pct = field(e, 'pct');
        if (pct !== undefined) {
          if (typeof pct !== 'number' || !isFinite(pct) || pct < 0 || pct > 100) throw wrong('"pct" must be a number from 0 to 100', where);
          g.pct = Math.round(pct * 10) / 10;
        }
        return g;
      })
    };
  },

  // A charge posted at a merchant the owner cut. Only an id and a label:
  // an amount, if one is sent, is dropped like any unknown field.
  alerts: (s) => {
    const items = F.listOf(s, 'items', LISTS.alerts, '', true);
    return {
      items: F.eachWithId(items, 'alert', (e, where, id) => ({ id: id, label: F.textOf(e, 'label', 30, where, true) }))
    };
  }
};

// Checks one section. Returns its clean copy, with asOf first, or throws a
// section problem. A list section may be sent as the list itself.
function checkSection(name, raw, sentAt) {
  if (LISTS[name] && Array.isArray(raw)) raw = { items: raw };
  if (!isObj(raw)) {
    throw wrong('the section must be ' + (LISTS[name] ? 'a list, or an object with "items"' : 'an object') + ', or null to clear it');
  }
  const asOf = F.timeOf(raw, 'asOf', '');
  const body = CHECK[name](raw);
  return Object.assign({ asOf: asOf === undefined ? sentAt : asOf }, body);
}

/* ---------- the whole snapshot ---------- */

// Checks a snapshot as it arrives. Throws a 400 error when the snapshot as a
// whole is wrong. Otherwise returns { sentAt, bytes, sections, rejected }.
function normalizeSnapshot(raw, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!isObj(raw)) throw bad('the snapshot must be a JSON object, like {"v": 1, "sentAt": "2026-11-16T15:10:00Z", "room": {...}}');
  let bytes;
  try { bytes = F.bytesOf(raw); } catch (e) { throw bad('the snapshot could not be read as JSON'); }
  if (bytes > MAX_BYTES) {
    throw bad('the snapshot is ' + sizeText(bytes) + ' (' + F.commas(bytes) + ' bytes); at most 48 KB (49,152 bytes). Nothing was stored');
  }
  if (field(raw, 'v') !== 1) throw bad('"v" must be 1');
  const sentAt = field(raw, 'sentAt');
  if (sentAt === undefined) throw bad('"sentAt" is missing (the time the snapshot was built, like 2026-11-16T15:10:00Z)');
  if (!awws.isTime(sentAt)) throw bad('"sentAt" must be ' + F.A_TIME);
  if (Date.parse(sentAt) > now + MAX_FUTURE_MS) throw bad('"sentAt" is more than 10 minutes in the future; check the sender\'s clock');
  const present = SECTIONS.filter((k) => has(raw, k));
  if (!present.length) throw bad('the snapshot has no sections (send at least one of ' + F.words(SECTIONS) + ')');
  const sections = {};
  const rejected = [];
  present.forEach((k) => {
    if (raw[k] === null) {
      sections[k] = null;
      return;
    }
    try {
      sections[k] = checkSection(k, raw[k], sentAt);
    } catch (e) {
      if (!e.sectionProblem) throw e;
      rejected.push({ section: k, error: e.message });
    }
  });
  return { sentAt: sentAt, bytes: bytes, sections: sections, rejected: rejected };
}

function emptyData() {
  return { v: 1, sentAt: null, receivedAt: null };
}

function sectionsIn(data) {
  return isObj(data) ? SECTIONS.filter((k) => has(data, k) && isObj(data[k])) : [];
}

function sectionsOnly(data) {
  const out = {};
  sectionsIn(data).forEach((k) => { out[k] = data[k]; });
  return out;
}

// Puts a checked snapshot over what is stored, like awws.merge: sections
// sent replace their copy, null removes one, the rest are kept.
function merge(current, normalized, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const cur = isObj(current) ? current : emptyData();
  const sent = normalized.sections;
  const accepted = SECTIONS.filter((k) => has(sent, k) && sent[k] !== null);
  const cleared = SECTIONS.filter((k) => has(sent, k) && sent[k] === null);
  const rejected = normalized.rejected.slice();
  if (!accepted.length && !cleared.length) {
    throw bad('nothing was stored, because every section was rejected: ' +
      rejected.map((r) => r.section + ': ' + r.error).join('; '));
  }
  const data = { v: 1, sentAt: normalized.sentAt, receivedAt: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z') };
  SECTIONS.forEach((k) => {
    if (has(sent, k)) {
      if (sent[k] !== null) data[k] = sent[k];
    } else if (has(cur, k) && isObj(cur[k])) {
      data[k] = cur[k];
    }
  });
  const bytes = F.bytesOf(data);
  if (bytes > MAX_BYTES) {
    throw bad('with this snapshot the Pi would hold ' + sizeText(bytes) + ' (' + F.commas(bytes) + ' bytes); at most 48 KB (49,152 bytes). Nothing was stored');
  }
  const changed = JSON.stringify(sectionsOnly(cur)) !== JSON.stringify(sectionsOnly(data));
  return { data: data, changed: changed, bytes: bytes, accepted: accepted, cleared: cleared, rejected: rejected };
}

// The budget resource from a state file. Anything damaged or missing means
// "nothing yet"; a stored section that no longer passes its check is dropped.
function cleanResource(r) {
  const rev = isObj(r) && typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const d = isObj(r) && isObj(r.data) ? r.data : null;
  if (!d || field(d, 'v') !== 1 || !awws.isTime(field(d, 'sentAt'))) return { rev: rev, data: emptyData() };
  const data = { v: 1, sentAt: d.sentAt, receivedAt: awws.isTime(field(d, 'receivedAt')) ? d.receivedAt : null };
  SECTIONS.forEach((k) => {
    if (!has(d, k) || d[k] === null) return;
    try { data[k] = checkSection(k, d[k], d.sentAt); } catch (e) { /* a broken section is dropped */ }
  });
  if (F.bytesOf(data) > MAX_BYTES) return { rev: rev, data: emptyData() };
  return { rev: rev, data: data };
}

/* ---------- describing what is stored (no labels, no amounts) ---------- */

function sectionCounts(name, s) {
  if (name === 'room') {
    return { daysLeft: s.daysLeft, throughDate: s.throughDate, state: s.roomPerDay < 0 ? 'negative' : s.roomPerDay < s.cap ? 'under' : 'at', refund: s.roomIfRefund !== undefined };
  }
  if (name === 'cardDay') {
    return { date: s.date, daysAway: s.daysAway, covered: s.covered, transfers: (s.transfers || []).length, paychecks: (s.paychecks || []).length };
  }
  if (name === 'goals') {
    const c = { goals: s.items.length };
    GOAL_STATES.forEach((st) => { c[st] = s.items.filter((g) => g.state === st).length; });
    return c;
  }
  return { alerts: s.items.length };
}

// A compact picture of what is stored, for the mailbox's budget.show.
function summaryData(data) {
  const d = isObj(data) ? data : emptyData();
  const sections = {};
  sectionsIn(d).forEach((k) => {
    sections[k] = Object.assign({ asOf: d[k].asOf }, sectionCounts(k, d[k]));
  });
  return { sentAt: d.sentAt || null, receivedAt: d.receivedAt || null, bytes: d.sentAt ? F.bytesOf(d) : 0, sections: sections };
}

function sectionLine(name, s) {
  const c = sectionCounts(name, s);
  if (name === 'room') {
    const st = c.state === 'negative' ? 'over the budget' : c.state === 'under' ? 'under the daily cap' : 'at the daily cap';
    return plural(c.daysLeft, 'day') + ' left through ' + c.throughDate + ', ' + st + (c.refund ? ', a refund pending' : '');
  }
  if (name === 'cardDay') {
    return c.date + ' (in ' + plural(c.daysAway, 'day') + '), ' + (c.covered ? 'covered' : 'not covered') + ', ' +
      plural(c.transfers, 'transfer') + ', ' + plural(c.paychecks, 'paycheck');
  }
  if (name === 'goals') {
    const parts = GOAL_STATES.filter((st) => c[st]).map((st) => c[st] + ' ' + st.replace('-', ' '));
    return plural(c.goals, 'goal') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }
  return c.alerts ? plural(c.alerts, 'new charge') + ' at a merchant you cut' : 'no new charges';
}

function plainWhen(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const NOTHING_YET = 'No budget snapshot yet. The TV tiles say "Waiting for the budget app".';

// The lines for ./hub budget show. opts.when(ms) formats a time.
function summaryLines(data, opts) {
  const when = opts && typeof opts.when === 'function' ? opts.when : plainWhen;
  const d = isObj(data) ? data : emptyData();
  if (!d.sentAt) return [NOTHING_YET];
  const out = ['Budget snapshot sent ' + when(Date.parse(d.sentAt)) +
    (d.receivedAt ? ', received ' + when(Date.parse(d.receivedAt)) : '') +
    '. ' + sizeText(F.bytesOf(d)) + ' of 48 KB.'];
  const names = sectionsIn(d);
  if (!names.length) {
    out.push('No sections are stored, so the tiles have nothing to show.');
    return out;
  }
  const width = Math.max.apply(null, names.map((k) => k.length));
  names.forEach((k) => {
    out.push('  ' + k + ' '.repeat(width - k.length) + '  ' + sectionLine(k, d[k]) + ', as of ' + when(Date.parse(d[k].asOf)));
  });
  return out;
}

// The answer to ./hub budget set (and the mailbox's budget.set).
function setText(r) {
  const out = [];
  const accepted = r.accepted || [];
  const cleared = r.cleared || [];
  const rejected = r.rejected || [];
  if (accepted.length || cleared.length) {
    const did = [];
    if (accepted.length) did.push('stored ' + F.words(accepted));
    if (cleared.length) did.push('cleared ' + F.words(cleared));
    const first = did.join(', ');
    out.push(first[0].toUpperCase() + first.slice(1) + ' (' + sizeText(r.bytes || 0) + ' of 48 KB). ' +
      (r.changed ? 'Screens that are on change now.' : 'Nothing changed, but the TV now knows the data is fresh.'));
  }
  rejected.forEach((x) => out.push('Rejected ' + x.section + ': ' + x.error + '.'));
  if (rejected.length) out.push('Rejected sections keep their last good copy on the Pi.');
  return out.join('\n');
}

// The answer to ./hub budget clear (and the mailbox's budget.clear).
function clearText(r) {
  if (!r.changed) return 'There is no budget snapshot to clear. Nothing changed.';
  const cleared = r.cleared || [];
  return 'Cleared the budget snapshot' + (cleared.length ? ' (' + F.words(cleared) + ')' : '') +
    '. The TV tiles say "Waiting for the budget app".';
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  SECTIONS: SECTIONS,
  GOAL_STATES: GOAL_STATES,
  normalizeSnapshot: normalizeSnapshot,
  merge: merge,
  emptyData: emptyData,
  cleanResource: cleanResource,
  sectionsIn: sectionsIn,
  summaryData: summaryData,
  summaryLines: summaryLines,
  setText: setText,
  clearText: clearText,
  sizeText: sizeText
};
