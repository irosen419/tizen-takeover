/*
 * The A World Worth Saving snapshot: one small JSON object a Claude routine
 * (or a person with a file) sends to the Pi, which keeps it as the resource
 * "awws" and pushes it to the TV tiles. The contract is docs/awws-snapshot.md.
 *
 * This file only checks, merges and describes snapshots. server.js stores
 * them, hubctl.js (./hub awws ...) and mailbox.js (awws.* commands) print the
 * texts made here, so all three say exactly the same thing.
 *
 * Nothing here logs or prints the snapshot's text (titles, school names).
 * Reading is by own fields only and every clean copy is built field by field,
 * so keys like "__proto__" in a snapshot are simply dropped.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const MAX_BYTES = 48 * 1024; // 49,152 bytes of JSON
const MAX_FUTURE_MS = 10 * 60 * 1000;
const MAX_WHOLE = 1000000;
const MAX_MONEY = 1000000000;
const SECTIONS = ['todos', 'handoffs', 'outreach', 'khaya', 'pipeline', 'money', 'reach'];
const OWNERS = ['ian', 'claude', 'both'];
const TODO_SECTIONS = ['now', 'next', 'later'];
const SCHOOL_STATES = ['waiting-ian', 'waiting-them', 'booked', 'visited'];
const REACH_FIGURES = ['visits', 'buyClicks', 'subscribers', 'scans'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LINK_RE = /https?:\/\/|www\./i;

/* ---------- small helpers ---------- */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

// The value of an own field, or undefined. null counts as left out.
function field(o, k) {
  if (!has(o, k)) return undefined;
  const v = o[k];
  return v === null ? undefined : v;
}

// A 400 error, the same convention as server.js.
function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// A problem inside one section. It rejects that section only.
function wrong(msg, where) {
  const e = new Error(msg + (where ? ' (' + where + ')' : ''));
  e.sectionProblem = true;
  return e;
}

function bytesOf(v) {
  return Buffer.byteLength(JSON.stringify(v));
}

function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sizeText(bytes) {
  if (bytes < 1024) return commas(bytes) + ' bytes';
  return (Math.round(bytes / 102.4) / 10) + ' KB';
}

function words(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function plural(n, word, many) {
  return n + ' ' + (n === 1 ? word : (many || word + 's'));
}

/* ---------- times, dates and months ---------- */

function realDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function isDate(v) {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  return !!m && realDate(+m[1], +m[2], +m[3]);
}

function isTime(v) {
  const m = typeof v === 'string' ? TIME_RE.exec(v) : null;
  return !!m && realDate(+m[1], +m[2], +m[3]) && +m[4] <= 23 && +m[5] <= 59 && +m[6] <= 59;
}

function isMonth(v) {
  return typeof v === 'string' && MONTH_RE.test(v);
}

/* ---------- field checks ---------- */

// Each check takes the object, the field name, where it sits (for the error)
// and returns the clean value, or undefined for an optional field left out.
// The name in an error may carry a prefix, like "visits.week".

function textOf(o, k, max, where, required, label) {
  const name = '"' + (label || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (typeof v !== 'string') throw wrong(name + ' must be text', where);
  const t = v.replace(CONTROL_RE, ' ').trim();
  if (!t) {
    if (required) throw wrong(name + ' is empty', where);
    return undefined;
  }
  // Never echo the text itself: it may be the very thing that must not leak.
  if (EMAIL_RE.test(t)) throw wrong(name + ' holds an email address, which the snapshot must never carry', where);
  if (LINK_RE.test(t)) throw wrong(name + ' holds a link, which the snapshot must never carry', where);
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
}

function wholeOf(o, k, where, required, opts) {
  const name = '"' + ((opts && opts.label) || k) + '"';
  const min = opts && opts.min !== undefined ? opts.min : 0;
  const max = opts && opts.max !== undefined ? opts.max : MAX_WHOLE;
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw wrong(name + ' must be a whole number from ' + commas(min) + ' to ' + commas(max), where);
  }
  return v;
}

function moneyOf(o, k, where, required, label) {
  const name = '"' + (label || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > MAX_MONEY) {
    throw wrong(name + ' must be a number from 0 to 1,000,000,000', where);
  }
  return Math.round(v * 100) / 100;
}

function boolOf(o, k, where) {
  const v = field(o, k);
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw wrong('"' + k + '" must be true or false', where);
  return v;
}

function choiceOf(o, k, list, where) {
  const v = field(o, k);
  if (v === undefined) throw wrong('"' + k + '" is missing', where);
  if (typeof v !== 'string' || list.indexOf(v) < 0) {
    throw wrong('"' + k + '" must be ' + list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1], where);
  }
  return v;
}

function shapedOf(o, k, test, what, where, required, label) {
  const name = '"' + (label || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (!test(v)) throw wrong(name + ' must be ' + what, where);
  return v;
}

const A_TIME = 'a UTC time like 2026-11-16T15:10:00Z';
const A_DATE = 'a real date like 2026-12-01';
const A_MONTH = 'a month like 2026-11';

function timeOf(o, k, where, required, label) {
  return shapedOf(o, k, isTime, A_TIME, where, required, label);
}

function dateOf(o, k, where, required, label) {
  return shapedOf(o, k, isDate, A_DATE, where, required, label);
}

function monthOf(o, k, where, required, label) {
  return shapedOf(o, k, isMonth, A_MONTH, where, required, label);
}

function listOf(o, k, max, where, required, label) {
  const name = '"' + (label || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (!Array.isArray(v)) throw wrong(name + ' must be a list', where);
  if (v.length > max) throw wrong(name + ' has ' + v.length + ' entries; at most ' + max, where);
  return v;
}

function objectOf(o, k, where, required, label) {
  const name = '"' + (label || k) + '"';
  const v = field(o, k);
  if (v === undefined) {
    if (required) throw wrong(name + ' is missing', where);
    return undefined;
  }
  if (!isObj(v)) throw wrong(name + ' must be an object', where);
  return v;
}

// Sets out[k] only when v is not undefined, so optional fields stay out.
function put(out, k, v) {
  if (v !== undefined) out[k] = v;
}

// Runs fn on each entry of a list that holds objects with an "id". kind is
// the plain word for an entry, like "item". Ids must be unique in the list.
function eachWithId(list, kind, fn) {
  const seen = Object.create(null);
  return list.map((e, n) => {
    let where = kind + ' ' + (n + 1);
    if (!isObj(e)) throw wrong('each ' + kind + ' must be an object', where);
    const id = field(e, 'id');
    if (id === undefined) throw wrong('"id" is missing', where);
    if (typeof id !== 'string' || !ID_RE.test(id)) throw wrong('"id" must be 1 to 40 of A-Z, a-z, 0-9, "_" or "-"', where);
    where += ', ' + id;
    if (seen[id]) throw wrong('the id "' + id + '" is used twice', where);
    seen[id] = true;
    return fn(e, where, id);
  });
}

// The same for lists whose entries have no id, like schools or months.
function eachEntry(list, kind, fn) {
  return list.map((e, n) => {
    const where = kind + ' ' + (n + 1);
    if (!isObj(e)) throw wrong('each ' + kind + ' must be an object', where);
    return fn(e, where);
  });
}

/* ---------- the sections ---------- */

const CHECK = {
  todos: (s) => {
    const out = {};
    const items = listOf(s, 'items', 200, '', true);
    out.items = eachWithId(items, 'item', (e, where, id) => {
      const it = { id: id };
      it.title = textOf(e, 'title', 80, where, true);
      it.owner = choiceOf(e, 'owner', OWNERS, where);
      it.section = choiceOf(e, 'section', TODO_SECTIONS, where);
      put(it, 'stream', textOf(e, 'stream', 24, where));
      put(it, 'due', textOf(e, 'due', 40, where));
      put(it, 'dueISO', shapedOf(e, 'dueISO', (v) => isDate(v) || isTime(v), 'a date like 2026-12-01 or a UTC time like 2026-12-01T18:15:00Z', where));
      put(it, 'waitingOn', textOf(e, 'waitingOn', 40, where));
      if (boolOf(e, 'done', where)) it.done = true; // left out means false
      put(it, 'doneAt', timeOf(e, 'doneAt', where));
      return it;
    });
    const totals = objectOf(s, 'totals', '');
    if (totals !== undefined) {
      out.totals = {};
      OWNERS.forEach((who) => {
        const one = objectOf(totals, who, '', true, 'totals.' + who);
        out.totals[who] = {};
        TODO_SECTIONS.forEach((sec) => {
          out.totals[who][sec] = wholeOf(one, sec, '', true, { label: 'totals.' + who + '.' + sec });
        });
      });
    }
    return out;
  },

  handoffs: (s) => {
    const out = { open: wholeOf(s, 'open', '', true), blocked: wholeOf(s, 'blocked', '', true) };
    const items = listOf(s, 'items', 20, '');
    if (items !== undefined) {
      out.items = eachWithId(items, 'item', (e, where, id) => ({
        id: id,
        title: textOf(e, 'title', 80, where, true),
        state: choiceOf(e, 'state', ['open', 'blocked'], where)
      }));
    }
    return out;
  },

  outreach: (s) => {
    const out = {};
    put(out, 'emailed', wholeOf(s, 'emailed', ''));
    ['replied', 'booked', 'visited', 'waitingOnIan'].forEach((k) => { out[k] = wholeOf(s, k, '', true); });
    const schools = listOf(s, 'schools', 30, '');
    if (schools !== undefined) {
      out.schools = eachEntry(schools, 'school', (e, where) => {
        const o = { school: textOf(e, 'school', 40, where, true), state: choiceOf(e, 'state', SCHOOL_STATES, where) };
        put(o, 'since', dateOf(e, 'since', where));
        return o;
      });
    }
    const log = listOf(s, 'log', 30, '');
    if (log !== undefined) {
      out.log = eachEntry(log, 'log entry', (e, where) => ({
        date: dateOf(e, 'date', where, true),
        school: textOf(e, 'school', 40, where, true),
        what: textOf(e, 'what', 80, where, true)
      }));
    }
    return out;
  },

  khaya: (s) => {
    const out = {};
    out.done = wholeOf(s, 'done', '', true);
    out.total = wholeOf(s, 'total', '', true, { min: 1 });
    if (out.done > out.total) throw wrong('"done" (' + out.done + ') is more than "total" (' + out.total + ')');
    put(out, 'label', textOf(s, 'label', 40, ''));
    return out;
  },

  pipeline: (s) => {
    const rawStages = listOf(s, 'stages', 7, '', true);
    if (rawStages.length < 2) throw wrong('"stages" needs 2 to 7 stage names');
    const stages = rawStages.map((v, n) => textOf({ s: v }, 's', 16, 'stage ' + (n + 1), true, 'stages'));
    const items = listOf(s, 'items', 12, '', true);
    return {
      stages: stages,
      items: eachWithId(items, 'item', (e, where, id) => {
        const it = { id: id };
        it.title = textOf(e, 'title', 40, where, true);
        put(it, 'format', textOf(e, 'format', 24, where));
        it.stage = wholeOf(e, 'stage', where, true, { max: stages.length });
        put(it, 'next', textOf(e, 'next', 80, where));
        put(it, 'waitingOn', textOf(e, 'waitingOn', 40, where));
        if (boolOf(e, 'blocked', where)) it.blocked = true; // left out means false
        return it;
      })
    };
  },

  money: (s) => {
    const out = {};
    out.currency = shapedOf(s, 'currency', (v) => typeof v === 'string' && CURRENCY_RE.test(v), 'three capital letters, like USD', '', true);
    out.spent = moneyOf(s, 'spent', '', true);
    out.earned = moneyOf(s, 'earned', '', true);
    const months = listOf(s, 'months', 12, '');
    if (months !== undefined) {
      out.months = eachEntry(months, 'month', (e, where) => ({
        month: monthOf(e, 'month', where, true),
        spent: moneyOf(e, 'spent', where, true),
        earned: moneyOf(e, 'earned', where, true)
      }));
    }
    const claude = objectOf(s, 'claude', '');
    if (claude !== undefined) {
      out.claude = { month: monthOf(claude, 'month', '', true, 'claude.month'), cost: moneyOf(claude, 'cost', '', true, 'claude.cost') };
    }
    const next = objectOf(s, 'nextTransfer', '');
    if (next !== undefined) {
      out.nextTransfer = { date: dateOf(next, 'date', '', true, 'nextTransfer.date') };
      put(out.nextTransfer, 'amount', moneyOf(next, 'amount', '', false, 'nextTransfer.amount'));
    }
    return out;
  },

  reach: (s) => {
    const counts = (k, required) => {
      const o = objectOf(s, k, '', required);
      if (o === undefined) return undefined;
      const c = {
        week: wholeOf(o, 'week', '', true, { label: k + '.week' }),
        prev: wholeOf(o, 'prev', '', true, { label: k + '.prev' })
      };
      const days = listOf(o, 'days', 28, '', false, k + '.days');
      if (days !== undefined) c.days = days.map((v, n) => wholeOf({ d: v }, 'd', 'day ' + (n + 1), true, { label: k + '.days' }));
      return c;
    };
    const out = {};
    put(out, 'visits', counts('visits', false));
    put(out, 'buyClicks', counts('buyClicks', false));
    put(out, 'subscribers', wholeOf(s, 'subscribers', ''));
    put(out, 'subscribersAsOf', shapedOf(s, 'subscribersAsOf', (v) => isDate(v) || isTime(v),
      'a date like 2026-11-16 or a UTC time like 2026-11-16T15:10:00Z', ''));
    const scans = listOf(s, 'scans', 10, '');
    if (scans !== undefined) {
      out.scans = eachEntry(scans, 'scan', (e, where) => ({
        school: textOf(e, 'school', 40, where, true),
        count: wholeOf(e, 'count', where, true)
      }));
    }
    // Traffic figures come later than the hand-counted subscribers, so any
    // one of them will do, but a reach section with none says nothing.
    if (!REACH_FIGURES.some((k) => has(out, k))) {
      throw wrong('the section must hold at least one of ' + REACH_FIGURES.map((k) => '"' + k + '"').join(', ').replace(/, ([^,]*)$/, ' or $1'));
    }
    return out;
  }
};

// Checks one section. Returns its clean copy, with asOf first, or throws a
// section problem.
function checkSection(name, raw, sentAt) {
  if (!isObj(raw)) throw wrong('the section must be an object, or null to clear it');
  const asOf = timeOf(raw, 'asOf', '');
  const body = CHECK[name](raw);
  return Object.assign({ asOf: asOf === undefined ? sentAt : asOf }, body);
}

/* ---------- the whole snapshot ---------- */

// Checks a snapshot as it arrives. Throws a 400 error when the snapshot as a
// whole is wrong. Otherwise returns { sentAt, bytes, sections, rejected }:
// sections maps each accepted section to its clean copy, and each section
// sent as null to null; rejected is [{ section, error }].
function normalizeSnapshot(raw, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!isObj(raw)) throw bad('the snapshot must be a JSON object, like {"v": 1, "sentAt": "2026-11-16T15:10:00Z", "todos": {...}}');
  let bytes;
  try { bytes = bytesOf(raw); } catch (e) { throw bad('the snapshot could not be read as JSON'); }
  if (bytes > MAX_BYTES) {
    throw bad('the snapshot is ' + sizeText(bytes) + ' (' + commas(bytes) + ' bytes); at most 48 KB (49,152 bytes). Nothing was stored');
  }
  if (field(raw, 'v') !== 1) throw bad('"v" must be 1');
  const sentAt = field(raw, 'sentAt');
  if (sentAt === undefined) throw bad('"sentAt" is missing (the time the snapshot was built, like 2026-11-16T15:10:00Z)');
  if (!isTime(sentAt)) throw bad('"sentAt" must be ' + A_TIME);
  if (Date.parse(sentAt) > now + MAX_FUTURE_MS) throw bad('"sentAt" is more than 10 minutes in the future; check the sender\'s clock');
  const present = SECTIONS.filter((k) => has(raw, k));
  if (!present.length) throw bad('the snapshot has no sections (send at least one of ' + words(SECTIONS) + ')');
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

// The section names stored in data, in the usual order.
function sectionsIn(data) {
  return isObj(data) ? SECTIONS.filter((k) => has(data, k) && isObj(data[k])) : [];
}

function sectionsOnly(data) {
  const out = {};
  sectionsIn(data).forEach((k) => { out[k] = data[k]; });
  return out;
}

// Puts a checked snapshot over what is stored. Sections sent replace their
// stored copy, sections sent as null are removed, the rest are kept.
// Returns { data, changed, bytes, accepted, cleared, rejected }; changed says
// whether any section's contents changed (sentAt and receivedAt always move).
// Throws a 400 error when nothing could be stored, or when the result would
// be over 48 KB.
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
  const bytes = bytesOf(data);
  if (bytes > MAX_BYTES) {
    throw bad('with this snapshot the Pi would hold ' + sizeText(bytes) + ' (' + commas(bytes) + ' bytes); at most 48 KB (49,152 bytes). Nothing was stored');
  }
  const changed = JSON.stringify(sectionsOnly(cur)) !== JSON.stringify(sectionsOnly(data));
  return { data: data, changed: changed, bytes: bytes, accepted: accepted, cleared: cleared, rejected: rejected };
}

// The awws resource from a state file. Anything damaged or missing means
// "no snapshot yet"; a stored section that no longer passes its check is
// dropped, the rest are kept.
function cleanResource(r) {
  const rev = isObj(r) && typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const d = isObj(r) && isObj(r.data) ? r.data : null;
  if (!d || field(d, 'v') !== 1 || !isTime(field(d, 'sentAt'))) return { rev: rev, data: emptyData() };
  const data = { v: 1, sentAt: d.sentAt, receivedAt: isTime(field(d, 'receivedAt')) ? d.receivedAt : null };
  SECTIONS.forEach((k) => {
    if (!has(d, k) || d[k] === null) return;
    try { data[k] = checkSection(k, d[k], d.sentAt); } catch (e) { /* a broken section is dropped */ }
  });
  if (bytesOf(data) > MAX_BYTES) return { rev: rev, data: emptyData() };
  return { rev: rev, data: data };
}

/* ---------- describing what is stored ---------- */

function countOpen(items, owner) {
  return items.filter((i) => !i.done && (!owner || i.owner === owner)).length;
}

// Small per-section figures, for ./hub awws show and the mailbox's awws.show.
// Never titles or names.
function sectionCounts(name, s) {
  if (name === 'todos') {
    return { items: s.items.length, open: countOpen(s.items), openForIan: countOpen(s.items, 'ian'), done: s.items.filter((i) => i.done).length };
  }
  if (name === 'handoffs') return { open: s.open, blocked: s.blocked, items: (s.items || []).length };
  if (name === 'outreach') {
    return { replied: s.replied, booked: s.booked, visited: s.visited, waitingOnIan: s.waitingOnIan, schools: (s.schools || []).length };
  }
  if (name === 'khaya') return { done: s.done, total: s.total };
  if (name === 'pipeline') return { stages: s.stages.length, items: s.items.length, blocked: s.items.filter((i) => i.blocked).length };
  if (name === 'money') return { months: (s.months || []).length };
  // reach: only the figures it holds (traffic and subscribers come apart).
  const c = {};
  if (s.visits) { c.visitsWeek = s.visits.week; c.visitsPrev = s.visits.prev; }
  if (s.buyClicks) { c.buyClicksWeek = s.buyClicks.week; c.buyClicksPrev = s.buyClicks.prev; }
  if (s.subscribers !== undefined) c.subscribers = s.subscribers;
  if (s.subscribersAsOf !== undefined) c.subscribersAsOf = s.subscribersAsOf;
  c.scans = (s.scans || []).length;
  return c;
}

// A compact picture of what is stored: no titles, no names, no amounts.
function summaryData(data) {
  const d = isObj(data) ? data : emptyData();
  const sections = {};
  sectionsIn(d).forEach((k) => {
    sections[k] = Object.assign({ asOf: d[k].asOf }, sectionCounts(k, d[k]));
  });
  return {
    sentAt: d.sentAt || null,
    receivedAt: d.receivedAt || null,
    bytes: d.sentAt ? bytesOf(d) : 0,
    sections: sections
  };
}

function sectionLine(name, s) {
  const c = sectionCounts(name, s);
  if (name === 'todos') return plural(c.items, 'item') + ', ' + c.open + ' open (' + c.openForIan + ' for Ian), ' + c.done + ' done';
  if (name === 'handoffs') return c.open + ' open, ' + c.blocked + ' blocked';
  if (name === 'outreach') return c.replied + ' replied, ' + c.booked + ' booked, ' + c.visited + ' visited, ' + c.waitingOnIan + ' waiting on Ian';
  if (name === 'khaya') return c.done + ' of ' + c.total + ' done';
  if (name === 'pipeline') return plural(c.items, 'item') + ' in ' + c.stages + ' stages' + (c.blocked ? ', ' + c.blocked + ' blocked' : '');
  if (name === 'money') return 'figures in ' + s.currency + (c.months ? ', ' + plural(c.months, 'month') : '') + ' (the TV shows them only when showMoney is on)';
  const parts = [];
  if (c.visitsWeek !== undefined) parts.push(c.visitsWeek + ' visits this week, ' + c.visitsPrev + ' the week before');
  if (c.buyClicksWeek !== undefined) parts.push(plural(c.buyClicksWeek, 'buy click') + ' this week, ' + c.buyClicksPrev + ' the week before');
  if (c.subscribers !== undefined) {
    parts.push(plural(c.subscribers, 'subscriber') + (c.subscribersAsOf ? ' at last check ' + c.subscribersAsOf.slice(0, 10) : ''));
  }
  if (c.scans) parts.push(plural(c.scans, 'school') + ' with flier scans');
  return parts.join('; ');
}

function plainWhen(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const NOTHING_YET = 'No A World Worth Saving snapshot yet. The TV tiles say "Not synced yet".';

// The lines for ./hub awws show. opts.when(ms) formats a time; hubctl passes
// the same one ./hub calendar status uses, in the hub's time zone.
function summaryLines(data, opts) {
  const when = opts && typeof opts.when === 'function' ? opts.when : plainWhen;
  const d = isObj(data) ? data : emptyData();
  if (!d.sentAt) return [NOTHING_YET];
  const out = ['Snapshot sent ' + when(Date.parse(d.sentAt)) +
    (d.receivedAt ? ', received ' + when(Date.parse(d.receivedAt)) : '') +
    '. ' + sizeText(bytesOf(d)) + ' of 48 KB.'];
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

// The answer to ./hub awws set (and the mailbox's awws.set).
function setText(r) {
  const out = [];
  const accepted = r.accepted || [];
  const cleared = r.cleared || [];
  const rejected = r.rejected || [];
  if (accepted.length || cleared.length) {
    const did = [];
    if (accepted.length) did.push('stored ' + words(accepted));
    if (cleared.length) did.push('cleared ' + words(cleared));
    const first = did.join(', ');
    out.push(first[0].toUpperCase() + first.slice(1) + ' (' + sizeText(r.bytes || 0) + ' of 48 KB). ' +
      (r.changed ? 'Screens that are on change now.' : 'Nothing changed, but the TV now knows the data is fresh.'));
  }
  rejected.forEach((x) => out.push('Rejected ' + x.section + ': ' + x.error + '.'));
  if (rejected.length) out.push('Rejected sections keep their last good copy on the Pi.');
  return out.join('\n');
}

// The answer to ./hub awws clear (and the mailbox's awws.clear).
function clearText(r) {
  if (!r.changed) return 'There is no A World Worth Saving snapshot to clear. Nothing changed.';
  const cleared = r.cleared || [];
  return 'Cleared the A World Worth Saving snapshot' + (cleared.length ? ' (' + words(cleared) + ')' : '') +
    '. The TV tiles say "Not synced yet".';
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  SECTIONS: SECTIONS,
  normalizeSnapshot: normalizeSnapshot,
  merge: merge,
  emptyData: emptyData,
  cleanResource: cleanResource,
  sectionsIn: sectionsIn,
  summaryData: summaryData,
  summaryLines: summaryLines,
  setText: setText,
  clearText: clearText,
  sizeText: sizeText,
  isTime: isTime,
  isDate: isDate,
  // The field checks, shared with budget.js so both resources keep the same
  // text rules (no emails, no links, cut with "…").
  fields: {
    isObj: isObj, has: has, field: field, bad: bad, wrong: wrong, bytesOf: bytesOf, commas: commas, words: words,
    textOf: textOf, wholeOf: wholeOf, boolOf: boolOf, choiceOf: choiceOf, shapedOf: shapedOf, dateOf: dateOf,
    timeOf: timeOf, listOf: listOf, objectOf: objectOf, put: put, eachWithId: eachWithId, eachEntry: eachEntry,
    A_TIME: A_TIME, A_DATE: A_DATE
  }
};
