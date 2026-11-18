/*
 * Watch link test results. The About panel on the TV has a "Watch link test":
 * each recipe tries one way of opening a show straight in a streaming app,
 * and the owner says what happened ("Opened the title", "Only opened the
 * app", "Nothing"). The TV sends each answer here (POST /linktests on the
 * screen side), the Pi keeps the last 100 as the resource "linktests", and a
 * Claude thread reads them with ./hub linktests or the mailbox's
 * linktests.show, to learn which deep links work on this TV.
 *
 *   result { id, app, name, outcome, detail?, op?, uri?, data?, at, build? }
 *   outcome: title | app | nothing | error (error: the TV could not even try)
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const MAX_RESULTS = 100;
const OUTCOMES = ['title', 'app', 'nothing', 'error'];
const OUTCOME_TEXT = { title: 'opened the title', app: 'only opened the app', nothing: 'nothing happened', error: 'could not be tried' };
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function text(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(CONTROL_RE, ' ').trim();
  return Array.from(t).slice(0, max).join('');
}

function emptyData() {
  return { results: [] };
}

// One result as the TV sends it. Throws a 400 error that names the problem.
function normalizeResult(raw, nowMs) {
  if (!isObj(raw)) throw bad('"result" must be an object');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw bad('"id" must be 1 to 40 of A-Z, a-z, 0-9, "_" or "-"');
  if (OUTCOMES.indexOf(raw.outcome) < 0) throw bad('"outcome" must be ' + OUTCOMES.join(', '));
  const out = { id: raw.id, app: text(raw.app, 40), name: text(raw.name, 80), outcome: raw.outcome };
  ['detail', 'op', 'uri', 'data'].forEach((k) => {
    const t = text(raw[k], k === 'detail' ? 140 : 300);
    if (t) out[k] = t;
  });
  const at = typeof raw.at === 'string' && TIME_RE.test(raw.at) && Date.parse(raw.at) <= nowMs + 600000 ? raw.at : null;
  out.at = at || new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const build = text(raw.build, 20);
  if (/^v?\d+\.\d+\.\d+$/.test(build)) out.build = build;
  return out;
}

// The stored list with one more answer at the top (newest first).
function addResult(data, result) {
  const list = isObj(data) && Array.isArray(data.results) ? data.results.slice() : [];
  list.unshift(result);
  return { results: list.slice(0, MAX_RESULTS) };
}

function cleanResource(r) {
  const rev = isObj(r) && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const list = [];
  const raw = isObj(r) && isObj(r.data) && Array.isArray(r.data.results) ? r.data.results : [];
  raw.forEach((x) => {
    try { if (list.length < MAX_RESULTS) list.push(normalizeResult(x, Date.now())); } catch (e) { /* skip it */ }
  });
  return { rev: rev, data: { results: list } };
}

// The lines for ./hub linktests: the newest answer for each recipe first.
function lines(data) {
  const list = isObj(data) && Array.isArray(data.results) ? data.results : [];
  if (!list.length) return ['No watch link tests yet. On the TV: Left on a left-most tile opens About, then OK on "Watch link test".'];
  const seen = {};
  const out = [list.length + ' answer' + (list.length === 1 ? '' : 's') + ' from the TV; the newest for each recipe:'];
  list.forEach((r) => {
    if (seen[r.id]) return;
    seen[r.id] = true;
    out.push('  ' + r.at.slice(0, 16).replace('T', ' ') + ' UTC  ' + (r.app ? r.app + ': ' : '') + (r.name || r.id) + ' [' + r.id + '] ' +
      OUTCOME_TEXT[r.outcome] + (r.detail ? ' (' + r.detail + ')' : ''));
  });
  return out;
}

module.exports = {
  MAX_RESULTS: MAX_RESULTS,
  OUTCOMES: OUTCOMES,
  emptyData: emptyData,
  normalizeResult: normalizeResult,
  addResult: addResult,
  cleanResource: cleanResource,
  lines: lines
};
