/*
 * The grocery list: one small resource, "grocery", kept by server.js in
 * state.json and read by the touch app (app/touch.html) on a phone or tablet.
 * It shares nothing with the to-do list but the idea of a checkable item
 * (checkItem below), so each can change on its own.
 *
 *   item  { id, name, done, doneAt, addedAt, upc }
 *         upc: '' or a product's canonical code (13 or 8 digits, products.js);
 *         older saved items without one get ''
 *   data  { items: [item, ...] }   newest first, at most MAX_ITEMS
 *
 * Ops (POST /api/grocery/ops from the control API, POST /grocery/ops from the
 * touch app) are a list of at most MAX_OPS of:
 *   { op: 'add',    name: 'Milk' }              adds; the same name already
 *                                               on the list is not doubled
 *                                               (a ticked one comes back)
 *   { op: 'add',    name, upc }                 a scanned product (server.js
 *                                               fills name from the catalog
 *                                               when it is left out): the same
 *                                               upc is not doubled (a ticked
 *                                               one comes back); the same name
 *                                               with no upc gets this one
 *   { op: 'check',  id, done: true|false }      tick or untick
 *   { op: 'remove', id }
 *   { op: 'clear' }                             drops every ticked item
 *
 * A ticked item stays 48 hours (to undo a slip), then goes.
 * Nothing here logs a name: callers log counts only.
 * Node 14 or newer, no npm packages.
 */
'use strict';

const crypto = require('crypto');

const MAX_ITEMS = 200;
const MAX_OPS = 50;
const MAX_NAME = 60;
const DONE_KEEP_MS = 48 * 60 * 60 * 1000;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
const UPC_RE = /^(\d{8}|\d{13})$/;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function emptyData() {
  return { items: [] };
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw bad('"name" must be text');
  const name = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw bad('"name" must not be empty');
  if (name.length > MAX_NAME) throw bad('"name" is at most ' + MAX_NAME + ' characters');
  return name;
}

function newId() {
  return 'g' + crypto.randomBytes(5).toString('hex');
}

// The shared item-check: ticks or unticks one item, returns the new item.
function checkItem(item, done, now) {
  return Object.assign({}, item, { done: !!done, doneAt: done ? now : null });
}

function cleanItem(r, now) {
  if (!isObj(r)) throw bad('an item must be an object');
  const done = r.done === true;
  return {
    id: typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : newId(),
    name: cleanName(r.name),
    done: done,
    doneAt: done ? (typeof r.doneAt === 'number' ? r.doneAt : now) : null,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : now,
    upc: typeof r.upc === 'string' && UPC_RE.test(r.upc) ? r.upc : ''
  };
}

function cleanUpc(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || !UPC_RE.test(raw)) throw bad('"upc" must be a product code of 8 or 13 digits');
  return raw;
}

function purgeOld(items, now) {
  return items.filter((i) => !i.done || i.doneAt === null || now - i.doneAt < DONE_KEEP_MS);
}

// Applies ops to the list, returns a new list. Throws a 400 error (and the
// caller keeps the old list) when an op is wrong.
function applyOps(items, ops, now) {
  if (!Array.isArray(ops) || !ops.length) throw bad('send { "ops": [ ... ] }');
  if (ops.length > MAX_OPS) throw bad('at most ' + MAX_OPS + ' ops at a time');
  let list = purgeOld(items, now).slice();
  ops.forEach((o) => {
    if (!isObj(o) || typeof o.op !== 'string') throw bad('each op needs an "op"');
    if (o.op === 'add') {
      const name = cleanName(o.name);
      const upc = cleanUpc(o.upc);
      let same = upc ? list.findIndex((i) => i.upc === upc) : -1;
      if (same < 0) {
        // The same name: one with no upc (or the same) is this item; a
        // different product under the same name gets its own row.
        same = list.findIndex((i) => i.name.toLowerCase() === name.toLowerCase() && (!upc || !i.upc || i.upc === upc));
      }
      if (same >= 0) {
        if (list[same].done) list[same] = checkItem(list[same], false, now);
        if (upc && !list[same].upc) list[same] = Object.assign({}, list[same], { upc: upc });
        return;
      }
      if (list.length >= MAX_ITEMS) throw bad('the grocery list is full (' + MAX_ITEMS + ' items)');
      list.unshift(cleanItem({ name: name, upc: upc }, now));
    } else if (o.op === 'check' || o.op === 'remove') {
      const at = list.findIndex((i) => i.id === o.id);
      if (at < 0) throw bad('no grocery item has that id');
      if (o.op === 'remove') list.splice(at, 1);
      else {
        if (typeof o.done !== 'boolean') throw bad('"done" must be true or false');
        list[at] = checkItem(list[at], o.done, now);
      }
    } else if (o.op === 'clear') {
      list = list.filter((i) => !i.done);
    } else {
      throw bad('unknown op (use add, check, remove or clear)');
    }
  });
  return list;
}

// A saved resource of any age, rebuilt from known fields.
function cleanResource(r) {
  const now = Date.now();
  const raw = isObj(r) && isObj(r.data) && Array.isArray(r.data.items) ? r.data.items : [];
  const items = [];
  const seen = {};
  raw.forEach((x) => {
    try {
      const it = cleanItem(x, now);
      if (!seen[it.id] && items.length < MAX_ITEMS) { seen[it.id] = 1; items.push(it); }
    } catch (e) { /* skip one bad item, keep the rest */ }
  });
  return { rev: isObj(r) && typeof r.rev === 'number' ? r.rev : 0, data: { items: items } };
}

// Case-insensitive match by id, or by exact name.
function match(items, what) {
  const w = String(what).toLowerCase();
  return items.find((i) => i.id === what) || items.find((i) => i.name.toLowerCase() === w) || null;
}

function listLines(items) {
  if (!items.length) return ['The grocery list is empty.'];
  return items.map((i) => '[' + (i.done ? 'x' : ' ') + '] ' + i.name + '   id ' + i.id);
}

module.exports = {
  MAX_ITEMS: MAX_ITEMS,
  MAX_NAME: MAX_NAME,
  emptyData: emptyData,
  cleanResource: cleanResource,
  cleanItem: cleanItem,
  checkItem: checkItem,
  applyOps: applyOps,
  match: match,
  listLines: listLines
};
