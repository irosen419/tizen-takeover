/*
 * Planned buys from Budget lab: the TV adds, edits and removes them, and
 * this file passes each change on to the budget app on the same Pi, which
 * is their only home (it matches them to charges and keeps matched ones out
 * of the daily goal). The hub keeps no list of its own: the budget app
 * answers with its whole list, which goes into the budget resource's
 * `planned` section at once, and its next snapshot carries the same list.
 *
 *   POST /budget/planned (a screen)
 *     { "op": "add",     "label": "Boots", "amount": 120, "date": "2026-12-04", "match": "Zappos" }
 *     { "op": "edit",    "id": "3f9a12c0", "label": "Boots", "amount": 118, "date": null, "match": null }
 *     { "op": "remove",  "id": "3f9a12c0" }
 *     { "op": "unmatch", "id": "3f9a12c0" }   "not this charge"
 *   date and match are optional; null (or left out) means none.
 *
 * The budget app (BUDGET_APP_URL, default http://127.0.0.1:8000; the
 * hub's own token as a Bearer, BUDGET_APP_TOKEN or else HUB_TOKEN; budget
 * repository PR 158):
 *     add      POST   /api/planned               { label, amount, date, match }   (201)
 *     edit     PUT    /api/planned/<id>          { label, amount, date, match }
 *     remove   DELETE /api/planned/<id>
 *     unmatch  POST   /api/planned/<id>/unmatch
 *   each answering { asOf, cardDay, items: [ ...the whole list... ] } in the
 *   snapshot's `planned` shape (docs/budget-snapshot.md); 400 { error } for a
 *   bad value, 404 for an unknown id. It also sends a fresh snapshot after
 *   each change.
 *
 * Never logs a label or an amount. No npm packages.
 */
'use strict';

const http = require('http');

const OPS = ['add', 'edit', 'remove', 'unmatch'];
const MAX_LABEL = 24;
const MAX_MATCH = 40;
const MAX_AMOUNT = 1000000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TIMEOUT_MS = 8000;

function bad(message, status) {
  const e = new Error(message);
  e.status = status || 400;
  return e;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// Plain one-line text, or a 400 when too long or holding an address or link.
function text(v, name, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad('"' + name + '" must be text');
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) throw bad('"' + name + '" can be at most ' + max + ' characters');
  if (/@|:\/\/|www\./i.test(t)) throw bad('"' + name + '" cannot hold an email address or a link');
  return t;
}

// A clean change from what a screen sent, or a 400.
function checkOp(body) {
  if (!body || typeof body !== 'object' || OPS.indexOf(body.op) < 0) throw bad('"op" must be add, edit, remove or unmatch');
  const out = { op: body.op };
  if (body.op !== 'add') {
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw bad('"id" must be the planned buy\'s id');
    out.id = body.id;
  }
  if (body.op === 'remove' || body.op === 'unmatch') return out;
  out.label = text(body.label, 'label', MAX_LABEL);
  if (!out.label) throw bad('"label" is needed: what the buy is');
  const a = body.amount;
  if (typeof a !== 'number' || !isFinite(a) || a <= 0 || a > MAX_AMOUNT) throw bad('"amount" must be more than 0 and up to 1,000,000');
  out.amount = Math.round(a * 100) / 100;
  if (body.date === undefined || body.date === null || body.date === '') out.date = null;
  else if (!isDate(body.date)) throw bad('"date" must be a date like 2026-12-04, or null for none');
  else out.date = body.date;
  out.match = body.match === undefined || body.match === null ? null : text(body.match, 'match', MAX_MATCH) || null;
  return out;
}

// The request to the budget app for a change: { method, path, body }.
function requestFor(op) {
  const fields = { label: op.label, amount: op.amount, date: op.date, match: op.match };
  if (op.op === 'add') {
    // The budget app takes date and match as optional: left out when there are none.
    if (fields.date === null) delete fields.date;
    if (fields.match === null) delete fields.match;
    return { method: 'POST', path: '/api/planned', body: fields };
  }
  const p = '/api/planned/' + encodeURIComponent(op.id);
  if (op.op === 'edit') return { method: 'PUT', path: p, body: fields };
  if (op.op === 'unmatch') return { method: 'POST', path: p + '/unmatch', body: null };
  return { method: 'DELETE', path: p, body: null };
}

// The budget app's answer as a `planned` section ({ cardDay, items }; the
// hub stamps its own asOf), or a 502.
function listFrom(reply) {
  const j = reply && typeof reply === 'object' ? (reply.planned && typeof reply.planned === 'object' ? reply.planned : reply) : null;
  if (!j || !Array.isArray(j.items)) throw bad('the budget app did not send the list back', 502);
  const out = { items: j.items };
  if (typeof j.cardDay === 'string') out.cardDay = j.cardDay;
  return out;
}

// Sends one change. opt: { url, token, timeoutMs, request (tests) }.
// Resolves to the budget app's JSON answer; rejects with .status 400 for a
// refusal the budget app explains, 502 when it is down or answers oddly.
function send(op, opt) {
  const o = opt || {};
  const r = requestFor(op);
  let base;
  try { base = new URL(o.url || 'http://127.0.0.1:8000'); } catch (e) { return Promise.reject(bad('BUDGET_APP_URL is not an address', 500)); }
  const data = r.body ? JSON.stringify(r.body) : '';
  const headers = { Accept: 'application/json' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const req = (o.request || http.request)({
      hostname: base.hostname, port: base.port || 80, method: r.method,
      path: base.pathname.replace(/\/$/, '') + r.path, headers: headers, timeout: o.timeoutMs || TIMEOUT_MS
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 256 * 1024) text += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        if (res.statusCode >= 200 && res.statusCode < 300 && j && j.ok !== false) return resolve(j);
        // A 400 or 404 is the owner's mistake: its reason goes back to the
        // screen. Anything else (a wrong token, a crash) is the setup's: a
        // 502 whose log line carries only the HTTP status, never the text.
        const refused = res.statusCode === 400 || res.statusCode === 404;
        const why = refused && j && typeof j.error === 'string' ? j.error.slice(0, 200) : 'HTTP ' + res.statusCode;
        const e = bad('the budget app said: ' + why, refused ? 400 : 502);
        e.logText = 'the budget app answered HTTP ' + res.statusCode;
        reject(e);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => {
      const err = bad('the budget app is not answering (' + (e && e.code || 'no answer') + ')', 502);
      err.logText = err.message;
      reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}

// The words for the log: the change, never its label or amount.
function logText(op) {
  return { add: 'screen added a planned buy', edit: 'screen changed a planned buy', remove: 'screen removed a planned buy',
    unmatch: 'screen said a planned buy\'s charge was not it' }[op.op];
}

module.exports = { OPS: OPS, MAX_LABEL: MAX_LABEL, MAX_MATCH: MAX_MATCH, MAX_AMOUNT: MAX_AMOUNT, checkOp: checkOp, requestFor: requestFor, listFrom: listFrom, send: send, logText: logText, isDate: isDate };
