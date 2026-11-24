/*
 * The personal budget snapshot: a small JSON object the budget app on the Pi
 * sends to the hub server (POST /api/budget with the local token), which
 * keeps it as the resource "budget" and pushes it to the TV's budget tiles.
 * The contract is docs/budget-snapshot.md.
 *
 * Only totals ever arrive here: daily room, card day, goals and alerts, and
 * for Budget lab the room to card day (lab), the top 5 merchants with their
 * month-to-date totals (merchants, which the owner asked for), one spending
 * total per day (pace) and the runway as headroom (runway). No balances, no
 * transactions, no amounts on alerts, with one exception the owner approved on
 * 2026-11-19: cardDay.receipt, the Card day sum with the checking balance, what
 * each card owes and bill names (the TV hides it in guest mode), and a second
 * one approved the same day: the investments section, with the portfolio
 * total, its accounts and top holdings in dollars (also hidden in guest mode),
 * and a third on 2026-11-24: the trends section, everyday spending this month
 * by category and by merchant against the usual, and an average per weekday
 * (blurred in guest mode too).
 * The budget app talks to the server on the Pi itself, so none of it goes
 * through the cloud.
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
const SECTIONS = ['room', 'cardDay', 'goals', 'alerts', 'lab', 'merchants', 'pace', 'runway', 'investments', 'trends'];
const GOAL_STATES = ['clean', 'on-pace', 'over', 'under'];
// Budget lab: where spare money on card day goes, and the runway's steps.
const SPLIT_KEYS = ['savings', 'awws', 'buffer', 'extra'];
const STEP_KINDS = ['pay', 'bill', 'reserve'];
// Card day's payment plan (autopay days): when a payment goes out.
const PLAN_KINDS = ['first', 'autopay'];
const BASES = ['first', 'autopay'];
const MAX_PLAN = 6;
// Card day's receipt (cardDay.receipt): the lines of the budget site's own sum.
const RECEIPT_KEYS = ['checking', 'paychecks', 'billsBefore', 'cardsToday', 'cardCharges', 'billsAfter', 'buys'];
const MAX_RECEIPT_ITEMS = 12;
const MAX_MERCHANTS = 5;
const MAX_PACE_DAYS = 31;
const MAX_STEPS = 40;
const MAX_SPLIT = 4;
const MAX_COUNT = 999;
const MAX_OUTLOOK_MONTHS = 3;
const MAX_PAYDAYS = 3;
// Investments: portfolio totals can run higher than a monthly budget figure.
const MAX_INVEST = 10000000;
const MAX_INVEST_ACCOUNTS = 6;
const MAX_INVEST_TOP = 8;
const MAX_INVEST_HISTORY = 92;
// trends (the Spending widget's Where it goes page): rows per list, weekdays.
const MAX_TREND_ROWS = 8;
const WEEKDAYS = 7;
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
  const hi = (opts && opts.max) || MAX_AMOUNT;
  const lo = signed ? -hi : 0;
  const hiText = F.commas(hi);
  if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi || (opts && opts.above0 && v <= 0)) {
    throw wrong(name + ' must be a number ' + (opts && opts.above0 ? 'more than 0 and up to ' + hiText :
      signed ? 'from -' + hiText + ' to ' + hiText : 'from 0 to ' + hiText), where);
  }
  // Halves round away from 0, so -12.345 is -12.35 like 12.345 is 12.35.
  return (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100) / 100;
}

function requiredBool(o, k, where) {
  if (field(o, k) === undefined) throw wrong('"' + k + '" is missing (true or false)', where);
  return F.boolOf(o, k, where);
}

// Whole cents, so sums are compared without floating point drift.
function cents(v) {
  return (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100);
}

// One thing behind a receipt line: a bill, a card, a paycheck, a planned buy.
function receiptItem(e, where) {
  const it = {
    label: F.textOf(e, 'label', 30, where, true),
    amount: amountOf(e, 'amount', where, true, { signed: true })
  };
  F.put(it, 'date', F.dateOf(e, 'date', where));
  if (F.boolOf(e, 'new', where)) it.new = true;
  F.put(it, 'note', F.textOf(e, 'note', 30, where));
  // A card: what it owes split in posted and pending, the recurring charges
  // still to come before card day, the autopay day, and what the plan pays.
  F.put(it, 'bal', amountOf(e, 'bal', where, false, { signed: true }));
  F.put(it, 'pending', amountOf(e, 'pending', where, false, { signed: true }));
  F.put(it, 'coming', amountOf(e, 'coming', where, false));
  F.put(it, 'pay', amountOf(e, 'pay', where, false));
  F.put(it, 'auto', amountOf(e, 'auto', where, false));
  F.put(it, 'autopay', F.dateOf(e, 'autopay', where));
  return it;
}

// cardDay.receipt: top to bottom, oldest money first. Every line adds up to
// "bottom" and every line's items add up to the line, to the cent, or the
// receipt is refused (the sender is tested against the same rule).
function receiptOf(r) {
  const out = {};
  out.asOf = F.timeOf(r, 'asOf', 'receipt', true);
  out.bottom = amountOf(r, 'bottom', 'receipt', true, { signed: true });
  F.put(out, 'perDay', amountOf(r, 'perDay', 'receipt', false));
  const next = F.objectOf(r, 'next', 'receipt');
  if (next !== undefined) {
    out.next = { date: F.dateOf(next, 'date', 'receipt next', true) };
    F.put(out.next, 'amount', amountOf(next, 'amount', 'receipt next', false));
  }
  const lines = F.listOf(r, 'lines', RECEIPT_KEYS.length + 1, 'receipt', true);
  if (!lines.length) throw wrong('"lines" must have at least 1 entry', 'receipt');
  const seen = Object.create(null);
  let sum = 0;
  out.lines = F.eachEntry(lines, 'receipt line', (e, where) => {
    const ln = { key: F.choiceOf(e, 'key', RECEIPT_KEYS, where) };
    where += ', ' + ln.key;
    if (seen[ln.key]) throw wrong('"' + ln.key + '" is used twice', where);
    seen[ln.key] = true;
    F.put(ln, 'label', F.textOf(e, 'label', 60, where));
    ln.amount = amountOf(e, 'amount', where, true, { signed: true });
    sum += cents(ln.amount);
    const items = F.listOf(e, 'items', MAX_RECEIPT_ITEMS, where);
    if (items !== undefined) {
      if (ln.key === 'checking') throw wrong('"items" is not for the checking line', where);
      ln.items = F.eachEntry(items, 'item', receiptItem);
      const total = ln.items.reduce((a, it) => a + cents(it.amount), 0);
      if (ln.items.length && total !== cents(ln.amount) * (ln.key === 'paychecks' ? 1 : -1)) {
        throw wrong('its items do not add up to "amount" (paychecks add, every other line takes away)', where);
      }
    }
    return ln;
  });
  if (out.lines[0].key !== 'checking') throw wrong('the first line must be "checking"', 'receipt');
  if (sum !== cents(out.bottom)) throw wrong('the lines do not add up to "bottom"', 'receipt');
  return out;
}

/* ---------- the sections ---------- */

// cardDay.outlook: where the month starts (behind or ahead of the plan), the
// 3 month average of daily spending and up to 3 months of totals.
function checkOutlook(o) {
  if (!isObj(o)) throw wrong('"outlook" must be an object');
  const out = {};
  const st = F.objectOf(o, 'start', '', true);
  out.start = {
    date: F.dateOf(st, 'date', 'start', true),
    behind: amountOf(st, 'behind', 'start', true),
    ahead: amountOf(st, 'ahead', 'start', true)
  };
  out.dailyAverage = amountOf(o, 'dailyAverage', '', true);
  out.averageMonths = F.wholeOf(o, 'averageMonths', '', true, { min: 1, max: 12 });
  const months = F.listOf(o, 'months', MAX_OUTLOOK_MONTHS, '', true);
  if (!months.length) throw wrong('"months" is empty');
  out.months = F.eachEntry(months, 'month', (e, where) => {
    const m = { month: F.monthOf(e, 'month', where, true) };
    m.days = F.wholeOf(e, 'days', where, true, { min: 28, max: 31 });
    const pd = F.listOf(e, 'paydays', MAX_PAYDAYS, where, true);
    m.paydays = pd.map((v, n) => F.dateOf({ d: v }, 'd', where + ', payday ' + (n + 1), true, 'paydays'));
    ['paycheck', 'bills', 'cardRecurring', 'planned'].forEach((k) => { m[k] = amountOf(e, k, where, true); });
    return m;
  });
  return out;
}

const CHECK = {
  room: (s) => {
    const out = {};
    out.cap = amountOf(s, 'cap', '', true, { above0: true });
    out.roomPerDay = amountOf(s, 'roomPerDay', '', true, { signed: true });
    F.put(out, 'roomIfRefund', amountOf(s, 'roomIfRefund', '', false, { signed: true }));
    // Which card day plan the room is worked from; left out means "first".
    if (field(s, 'basis') !== undefined) out.basis = F.choiceOf(s, 'basis', BASES, '');
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
    // Autopay days: a short card day can still be covered when the cards
    // wait for their own autopay dates. Only said when it is not covered.
    const by = field(s, 'byAutopay');
    if (by !== undefined) {
      if (out.covered) throw wrong('"byAutopay" is only for a card day that is not covered ("covered": false)');
      out.byAutopay = F.boolOf(s, 'byAutopay', '');
    }
    const autoShort = amountOf(s, 'autopayShortBy', '', false);
    if (autoShort !== undefined) {
      if (out.byAutopay !== false) throw wrong('"autopayShortBy" is only for a card day that is not covered by autopay ("byAutopay": false)');
      out.autopayShortBy = autoShort;
    }
    // The payments to make, in date order. These amounts are payments the
    // owner asked to see, never what a card owes.
    const plan = F.listOf(s, 'plan', MAX_PLAN, '');
    if (plan !== undefined) {
      out.plan = F.eachEntry(plan, 'payment', (e, where) => ({
        label: F.textOf(e, 'label', 24, where, true),
        date: F.dateOf(e, 'date', where, true),
        amount: amountOf(e, 'amount', where, true),
        kind: F.choiceOf(e, 'kind', PLAN_KINDS, where)
      }));
    }
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
    // The Card day receipt: checking balance, what the cards owe and bill
    // names, which the owner approved for the TV (guest mode hides it there).
    const receipt = F.objectOf(s, 'receipt', '');
    if (receipt !== undefined) out.receipt = receiptOf(receipt);
    // The next 3 months outlook. A bad outlook is dropped on its own: the
    // rest of card day is still good.
    if (field(s, 'outlook') !== undefined) {
      try { out.outlook = checkOutlook(s.outlook); } catch (e) { /* dropped */ }
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
  },

  // Budget lab's inputs: the room to card day as it stood this morning, and
  // what the TV needs to work its equations. The TV does the arithmetic.
  lab: (s) => {
    const out = {};
    out.room = amountOf(s, 'room', '', true, { signed: true });
    out.spentToday = amountOf(s, 'spentToday', '', true);
    out.daysLeft = F.wholeOf(s, 'daysLeft', '', true, { max: MAX_DAYS });
    out.cardDate = F.dateOf(s, 'cardDate', '', true);
    out.monthDay = F.wholeOf(s, 'monthDay', '', true, { min: 1, max: 31 });
    // The room when the cards wait for their autopay days, same morning
    // basis as "room", and the day that plan is worked to.
    F.put(out, 'autopayRoom', amountOf(s, 'autopayRoom', '', false, { signed: true }));
    F.put(out, 'autopayDate', F.dateOf(s, 'autopayDate', '', false));
    const split = F.listOf(s, 'split', MAX_SPLIT, '');
    if (split !== undefined) {
      const seen = Object.create(null);
      out.split = F.eachEntry(split, 'split entry', (e, where) => {
        const key = F.choiceOf(e, 'key', SPLIT_KEYS, where);
        if (seen[key]) throw wrong('the key "' + key + '" is used twice', where);
        seen[key] = true;
        return { key: key, amount: amountOf(e, 'amount', where, true) };
      });
    }
    return out;
  },

  // The top 5 merchants this month. Names and month-to-date totals are
  // allowed here because the owner asked for them; ./hub budget show still
  // prints only how many there are. "combined" is the five counted once
  // (one order can count for two merchants), so it is sent, never summed.
  merchants: (s) => {
    const out = {};
    out.month = F.monthOf(s, 'month', '', true);
    const items = F.listOf(s, 'items', MAX_MERCHANTS, '', true);
    out.items = F.eachEntry(items, 'merchant', (e, where) => ({
      label: F.textOf(e, 'label', 30, where, true),
      mtd: amountOf(e, 'mtd', where, true),
      count: F.wholeOf(e, 'count', where, true, { max: MAX_COUNT })
    }));
    out.combined = amountOf(s, 'combined', '', true);
    return out;
  },

  // One spending total per day against the cap logged that morning. Never
  // the charges themselves. Oldest first, each date once.
  pace: (s) => {
    const days = F.listOf(s, 'days', MAX_PACE_DAYS, '', true);
    let last = '';
    return {
      days: F.eachEntry(days, 'day', (e, where) => {
        const d = { date: F.dateOf(e, 'date', where, true), spent: amountOf(e, 'spent', where, true) };
        if (d.date <= last) throw wrong('"date" must come after the day before it (oldest first, each date once)', where);
        last = d.date;
        F.put(d, 'cap', amountOf(e, 'cap', where, false, { above0: true }));
        return d;
      })
    };
  },

  // The portfolio: the owner approved dollar figures on the TV on 2026-11-19
  // (guest mode hides them there). Totals, accounts and top holdings, plus one
  // total per date so the TV can draw a trend. No quantities, no account
  // numbers, no transactions: a field not named here is dropped.
  investments: (s) => {
    const big = { max: MAX_INVEST };
    const sbig = { max: MAX_INVEST, signed: true };
    const out = {};
    out.total = amountOf(s, 'total', '', true, big);
    F.put(out, 'cost', amountOf(s, 'cost', '', false, big));
    F.put(out, 'gain', amountOf(s, 'gain', '', false, sbig));
    const accounts = F.listOf(s, 'accounts', MAX_INVEST_ACCOUNTS, '', true);
    if (!accounts.length) throw wrong('"accounts" must have at least 1 entry');
    out.accounts = F.eachEntry(accounts, 'account', (e, where) => {
      const a = { label: F.textOf(e, 'label', 30, where, true), value: amountOf(e, 'value', where, true, big) };
      F.put(a, 'gain', amountOf(e, 'gain', where, false, sbig));
      return a;
    });
    const top = F.listOf(s, 'top', MAX_INVEST_TOP, '');
    if (top !== undefined) {
      out.top = F.eachEntry(top, 'holding', (e, where) => {
        // A ticker may be empty (cash, a fund with no symbol): then it is left out.
        const h = {};
        F.put(h, 'ticker', F.textOf(e, 'ticker', 10, where));
        h.name = F.textOf(e, 'name', 40, where, true);
        h.value = amountOf(e, 'value', where, true, big);
        F.put(h, 'gain', amountOf(e, 'gain', where, false, sbig));
        return h;
      });
    }
    const hist = F.listOf(s, 'history', MAX_INVEST_HISTORY, '');
    if (hist !== undefined) {
      let last = '';
      out.history = F.eachEntry(hist, 'day', (e, where) => {
        const d = { date: F.dateOf(e, 'date', where, true), total: amountOf(e, 'total', where, true, big) };
        if (d.date <= last) throw wrong('"date" must come after the day before it (oldest first, each date once)', where);
        last = d.date;
        return d;
      });
    }
    return out;
  },

  // Everyday spending for the Spending widget's Where it goes page: this
  // month so far and "your usual" (the 3-month average up to the same day of
  // the month) by category and by merchant, and the average day per weekday,
  // Monday to Sunday. The owner approved category totals on the TV on
  // 2026-11-24. Every list is optional, so later additions (one total per
  // day) can join it. "usual" null or left out: no usual for that row.
  trends: (s) => {
    const out = {};
    out.month = F.monthOf(s, 'month', '', true);
    [['categories', 'category'], ['merchants', 'merchant']].forEach((p) => {
      const list = F.listOf(s, p[0], MAX_TREND_ROWS, '');
      if (list === undefined) return;
      out[p[0]] = F.eachEntry(list, p[1], (e, where) => {
        const r = { label: F.textOf(e, 'label', 30, where, true), mtd: amountOf(e, 'mtd', where, true) };
        F.put(r, 'usual', amountOf(e, 'usual', where, false));
        return r;
      });
    });
    const wd = F.listOf(s, 'weekdays', WEEKDAYS, '');
    if (wd !== undefined) {
      if (wd.length !== WEEKDAYS) throw wrong('"weekdays" must have exactly 7 entries, Monday to Sunday (null for a day with no data)');
      out.weekdays = wd.map((v, n) => (v === null ? null : amountOf({ v: v }, 'v', 'weekday ' + (n + 1), true, { label: 'weekdays' })));
    }
    return out;
  },

  // Headroom from this morning to card day: never checking or a card
  // balance by itself. Steps carry no names; a "label" sent is dropped.
  runway: (s) => {
    const out = {};
    out.start = amountOf(s, 'start', '', true, { signed: true });
    out.end = F.dateOf(s, 'end', '', true);
    const steps = F.listOf(s, 'steps', MAX_STEPS, '', true);
    let last = '';
    out.steps = F.eachEntry(steps, 'step', (e, where) => {
      const date = F.dateOf(e, 'date', where, true);
      if (date < last) throw wrong('"date" must not come before the step before it (steps in date order)', where);
      if (date > out.end) throw wrong('"date" must not come after "end" (card day)', where);
      last = date;
      const kind = F.choiceOf(e, 'kind', STEP_KINDS, where);
      const delta = amountOf(e, 'delta', where, true, { signed: true });
      if (kind === 'pay' && delta < 0) throw wrong('"delta" must be 0 or more for a pay step', where);
      if (kind !== 'pay' && delta > 0) throw wrong('"delta" must be 0 or less for a ' + kind + ' step', where);
      return { date: date, delta: delta, kind: kind };
    });
    return out;
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
    return { date: s.date, daysAway: s.daysAway, covered: s.covered, byAutopay: s.byAutopay === true, payments: (s.plan || []).length, transfers: (s.transfers || []).length, paychecks: (s.paychecks || []).length, outlook: s.outlook ? s.outlook.months.length : 0 };
  }
  if (name === 'goals') {
    const c = { goals: s.items.length };
    GOAL_STATES.forEach((st) => { c[st] = s.items.filter((g) => g.state === st).length; });
    return c;
  }
  if (name === 'alerts') return { alerts: s.items.length };
  if (name === 'lab') {
    return { cardDate: s.cardDate, daysLeft: s.daysLeft, monthDay: s.monthDay, state: s.room < 0 ? 'short' : s.room > 0 ? 'spare' : 'none', split: (s.split || []).length };
  }
  if (name === 'merchants') return { month: s.month, merchants: s.items.length };
  if (name === 'pace') {
    const n = s.days.length;
    return { days: n, capped: s.days.filter((d) => d.cap !== undefined).length, from: n ? s.days[0].date : null, to: n ? s.days[n - 1].date : null };
  }
  if (name === 'trends') {
    return { month: s.month, categories: (s.categories || []).length, merchants: (s.merchants || []).length,
      weekdays: (s.weekdays || []).filter((v) => v !== null).length };
  }
  if (name === 'investments') {
    const n = s.history ? s.history.length : 0;
    return { accounts: s.accounts.length, holdings: (s.top || []).length, days: n, from: n ? s.history[0].date : null, to: n ? s.history[n - 1].date : null };
  }
  const c = { end: s.end, steps: s.steps.length };
  STEP_KINDS.forEach((k) => { c[k] = s.steps.filter((x) => x.kind === k).length; });
  return c;
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
    return c.date + ' (in ' + plural(c.daysAway, 'day') + '), ' + (c.covered ? 'covered' : c.byAutopay ? 'covered by autopay' : 'not covered') + ', ' +
      (c.payments ? plural(c.payments, 'payment') + ', ' : '') + plural(c.transfers, 'transfer') + ', ' + plural(c.paychecks, 'paycheck');
  }
  if (name === 'goals') {
    const parts = GOAL_STATES.filter((st) => c[st]).map((st) => c[st] + ' ' + st.replace('-', ' '));
    return plural(c.goals, 'goal') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }
  if (name === 'alerts') return c.alerts ? plural(c.alerts, 'new charge') + ' at a merchant you cut' : 'no new charges';
  if (name === 'lab') {
    const st = c.state === 'short' ? 'room short' : c.state === 'spare' ? 'room to spare' : 'no room';
    return c.cardDate + ' (' + plural(c.daysLeft, 'day') + ' left), day ' + c.monthDay + ' of the month, ' + st +
      (c.split ? ', split in ' + c.split : '');
  }
  if (name === 'merchants') return plural(c.merchants, 'merchant') + ' in ' + c.month;
  if (name === 'pace') {
    return c.days ? plural(c.days, 'day') + ' (' + c.capped + ' with a cap), ' + c.from + ' to ' + c.to : 'no days yet';
  }
  if (name === 'trends') {
    return plural(c.categories, 'category', 'categories') + ', ' + plural(c.merchants, 'merchant') + ', ' +
      (c.weekdays ? c.weekdays + ' of 7 weekdays' : 'no weekdays') + ' in ' + c.month;
  }
  if (name === 'investments') {
    return plural(c.accounts, 'account') + ', ' + plural(c.holdings, 'holding') + ', ' +
      (c.days ? plural(c.days, 'day') + ' of history, ' + c.from + ' to ' + c.to : 'no history yet');
  }
  return plural(c.steps, 'step') + ' to ' + c.end + ' (' + plural(c.pay, 'payday') + ', ' + plural(c.bill, 'bill') + ', ' +
    plural(c.reserve, 'reserve') + ')';
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
  SPLIT_KEYS: SPLIT_KEYS,
  STEP_KINDS: STEP_KINDS,
  PLAN_KINDS: PLAN_KINDS,
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
