/*
 * The daily spending goal's history (Budget lab's "Under your $60 goal"):
 * owned by the hub server, set from the TV (POST /budget/goal), ./hub budget
 * goal or the mailbox's budget.goal. The budget app never sends it.
 *
 *   data/budget-goal.json   { "v": 1, "history": [{ "from": "2026-11-24", "goal": 60 }] }
 *
 * Oldest first, one entry per date. A change applies from that day on and
 * never rewrites a past day: setting a goal on a date already in the list
 * replaces that date's entry, a later date adds one. Goals are whole dollars,
 * 1 to 1,000. At most MAX_ENTRIES (the oldest go first). The TV judges each
 * past day against the goal in force that day (the last entry with from <=
 * that date); days before the first entry have no goal.
 *
 * The history reaches the TV as pace.goals, merged into the budget
 * resource's pace section (attach below), so it rides the same push as the
 * snapshot. Atomic writes (a temp file, then rename). No npm packages.
 * Never put the goal amount in a log line.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'budget-goal.json';
const MIN_GOAL = 1;
const MAX_GOAL = 1000;
const MAX_ENTRIES = 200;

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function checkGoal(goal) {
  if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < MIN_GOAL || goal > MAX_GOAL) {
    throw bad('"goal" must be a whole number of dollars from ' + MIN_GOAL + ' to ' + MAX_GOAL.toLocaleString('en-US'));
  }
  return goal;
}

// A clean history from whatever was read: bad entries dropped, oldest first,
// each date once (the last one read wins), at most MAX_ENTRIES.
function cleanHistory(list) {
  if (!Array.isArray(list)) return [];
  const byDate = {};
  list.forEach((e) => {
    if (!e || !isDate(e.from) || typeof e.goal !== 'number' || !Number.isInteger(e.goal) || e.goal < MIN_GOAL || e.goal > MAX_GOAL) return;
    byDate[e.from] = e.goal;
  });
  return Object.keys(byDate).sort().slice(-MAX_ENTRIES).map((d) => ({ from: d, goal: byDate[d] }));
}

// The history with goal set from date on: the same date replaced, a new date
// added. A date before the last entry is refused (it would rewrite the days
// after it). Returns { history, changed }.
function setGoal(history, goal, date) {
  checkGoal(goal);
  if (!isDate(date)) throw bad('"date" must be a date like 2026-11-24');
  const cur = cleanHistory(history);
  const last = cur.length ? cur[cur.length - 1] : null;
  if (last && date < last.from) throw bad('a goal applies from today on; ' + date + ' is before the last change (' + last.from + ')');
  if (last && last.goal === goal) return { history: cur, changed: false };
  const next = cur.filter((e) => e.from !== date);
  next.push({ from: date, goal: goal });
  return { history: cleanHistory(next), changed: true };
}

// The goal in force on a date, or null (before the first entry).
function goalOn(history, date) {
  let g = null;
  cleanHistory(history).forEach((e) => { if (e.from <= date) g = e.goal; });
  return g;
}

// The budget resource's data with pace.goals set to the history (a copy;
// the input is left alone). Only when there is a pace section: the goal
// is shown against pace.days. An empty history removes pace.goals.
function attach(data, history) {
  if (!data || typeof data !== 'object' || !data.pace || typeof data.pace !== 'object') return data;
  const h = cleanHistory(history);
  const pace = Object.assign({}, data.pace);
  if (h.length) pace.goals = h; else delete pace.goals;
  return Object.assign({}, data, { pace: pace });
}

function load(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return cleanHistory(raw && raw.history);
  } catch (e) {
    return [];
  }
}

function save(dir, history) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, history: cleanHistory(history) }, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// The words for ./hub and the mailbox: dates only, never the amount.
function setText(r) {
  if (!r || !r.from) return 'No daily goal set.';
  return r.changed ? 'Daily goal set; it applies from ' + r.from + '. Past days keep the goal they had.' : 'The daily goal was already that; nothing changed.';
}

function showText(history) {
  const h = cleanHistory(history);
  if (!h.length) return 'No daily goal yet. Budget lab on the TV asks for one.';
  return 'Daily goal set since ' + h[h.length - 1].from + ' (' + h.length + (h.length === 1 ? ' change' : ' changes') + ' since ' + h[0].from + ').';
}

module.exports = {
  FILE: FILE,
  MIN_GOAL: MIN_GOAL,
  MAX_GOAL: MAX_GOAL,
  MAX_ENTRIES: MAX_ENTRIES,
  cleanHistory: cleanHistory,
  setGoal: setGoal,
  goalOn: goalOn,
  attach: attach,
  load: load,
  save: save,
  setText: setText,
  showText: showText,
  isDate: isDate
};
