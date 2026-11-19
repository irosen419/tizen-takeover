/*
 * Translates the owner's own text (to-do titles and notes, calendar event
 * titles, A World Worth Saving task lines) into Latin American Spanish for the
 * TV's Spanish mode.
 *
 *   const t = createTranslator({ dataDir, key, log });
 *   t.translate(['Buy milk', ...]).then(r => r.map)   // { 'Buy milk': 'Comprar leche' }
 *
 * Every translation is kept in data/translations-es.json, so a string is
 * translated once, ever. New strings go to Google Gemini in ONE batched call
 * (gemini-2.5-flash-lite). The texts are private: they are never written to
 * the log, only counts. After a Gemini error the server leaves Gemini alone
 * for 10 minutes and answers from the cache only.
 *
 * The key is HUB_TRANSLATE_KEY, or GEMINI_VIDEO_GEN_KEY (the owner's own key).
 * Never GEMINI_API_KEY: that one belongs to a business. With no key the
 * answer holds cache hits only, with "disabled": true.
 *
 * Pure Node (https, fs). No npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL = 'gemini-2.5-flash-lite';
const HOST = 'generativelanguage.googleapis.com';
const MAX_TEXTS = 60;
const MAX_TEXT = 500;
const MAX_CACHE = 5000;
// Gemini 2.5 Flash-Lite list price in US dollars per million tokens (Nov 2026; check
// ai.google.dev/pricing if it looks off). Used only for the estimate in the usage report.
const PRICE_IN = 0.10;
const PRICE_OUT = 0.40;
const USAGE_FILE = 'translate-usage.json';
const USAGE_DAYS = 62;
const MAX_NEW_PER_DAY = 2000; // new lines sent to Gemini per day; the /translate route has no token, so this caps the cost
const BACKOFF_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 20000;
const FILE = 'translations-es.json';

const PROMPT = 'Translate each item of the JSON array to natural Latin American Spanish, as a short line for a ' +
  'home screen. Keep the names of people, places, products, brands, books, shows and song titles unchanged. ' +
  'Keep emoji, numbers, times and punctuation as they are. Return only a JSON array of strings, in the same ' +
  'order and with the same length as the input.';

function problem(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Checks a request body; returns the distinct texts to translate.
function checkRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('send { "to": "es", "texts": ["..."] }');
  if (body.to !== 'es') throw problem('only "to": "es" is supported');
  if (!Array.isArray(body.texts)) throw problem('"texts" must be a list of strings');
  if (body.texts.length > MAX_TEXTS) throw problem('at most ' + MAX_TEXTS + ' texts at a time');
  const seen = {};
  const out = [];
  body.texts.forEach((s) => {
    if (typeof s !== 'string') throw problem('every text must be a string');
    if (s.length > MAX_TEXT) throw problem('each text must be at most ' + MAX_TEXT + ' characters');
    if (!s.trim() || Object.prototype.hasOwnProperty.call(seen, s)) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

// The model's answer: a JSON array of non-empty strings, one per input.
function parseAnswer(text, count) {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new Error('the answer was not JSON'); }
  if (!Array.isArray(v) || v.length !== count) throw new Error('the answer was not a list of the right length');
  v.forEach((s) => {
    if (typeof s !== 'string' || !s.trim()) throw new Error('the answer had an empty or non-text item');
  });
  return v.map((s) => s.trim());
}

// One request to Gemini. Resolves to the answer's text. Errors say the HTTP
// status only (the reply body could echo the private texts).
function geminiCall(key, items) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(items) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, method: 'POST', path: '/v1beta/models/' + MODEL + ':generateContent',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-goog-api-key': key },
      timeout: CALL_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Gemini HTTP ' + res.statusCode));
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const parts = j.candidates[0].content.parts;
          const u = j.usageMetadata || {};
          resolve({ text: parts.map((p) => p.text || '').join(''), inTok: u.promptTokenCount || 0, outTok: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) });
        } catch (e) {
          reject(new Error('Gemini answer not readable'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Gemini timed out')));
    req.on('error', (e) => reject(new Error(e && e.message === 'Gemini timed out' ? e.message : 'Gemini not reachable')));
    req.end(payload);
  });
}

// opt: dataDir, key, log(line), call(items) -> Promise<text> (tests), now()
function createTranslator(opt) {
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  const key = String(opt.key || '').trim();
  const call = typeof opt.call === 'function' ? opt.call : (items) => geminiCall(key, items);
  const enabled = !!key || typeof opt.call === 'function';
  const file = path.join(opt.dataDir, FILE);
  const cache = new Map(); // english -> spanish, oldest first
  const inflight = new Map(); // english -> Promise<string|null>
  let pausedUntil = 0;
  let lastErrorAt = 0;
  let day = '';
  let newToday = 0;
  const maxNew = opt.maxNewPerDay || MAX_NEW_PER_DAY;

  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.es && typeof j.es === 'object') {
      Object.keys(j.es).forEach((k) => { if (typeof j.es[k] === 'string' && j.es[k]) cache.set(k, j.es[k]); });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log('translate: the saved translations could not be read, starting empty');
  }

  // Usage per local day (the Pi's clock): new lines, Gemini calls, tokens in and out.
  const usageFile = path.join(opt.dataDir, USAGE_FILE);
  let usage = {};
  try {
    const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    if (u && u.days && typeof u.days === 'object') usage = u.days;
  } catch (e) { /* none yet */ }

  function dayKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function count(lines, inTok, outTok) {
    const k = dayKey(now());
    const d = usage[k] || (usage[k] = { lines: 0, calls: 0, inTok: 0, outTok: 0 });
    d.lines += lines; d.calls += 1; d.inTok += inTok; d.outTok += outTok;
    const keys = Object.keys(usage).sort();
    while (keys.length > USAGE_DAYS) delete usage[keys.shift()];
    try {
      fs.mkdirSync(opt.dataDir, { recursive: true });
      const tmp = usageFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, days: usage }) + '\n');
      fs.renameSync(tmp, usageFile);
    } catch (e) { /* the count is a nicety; translating goes on */ }
  }

  function sum(prefix) {
    const t = { lines: 0, calls: 0, inTok: 0, outTok: 0 };
    Object.keys(usage).forEach((k) => {
      if (k.indexOf(prefix) !== 0) return;
      ['lines', 'calls', 'inTok', 'outTok'].forEach((f) => { t[f] += usage[k][f] || 0; });
    });
    t.cost = (t.inTok * PRICE_IN + t.outTok * PRICE_OUT) / 1e6;
    return t;
  }

  function save() {
    try {
      fs.mkdirSync(opt.dataDir, { recursive: true });
      const es = {};
      cache.forEach((v, k) => { es[k] = v; });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, es: es }) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      log('translate: could not save the translations (' + (e && e.code ? e.code : 'error') + ')');
    }
  }

  function remember(items, spanish) {
    items.forEach((k, i) => {
      cache.delete(k);
      cache.set(k, spanish[i]);
    });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    save();
  }

  // One Gemini call for all of `items`; every item's inflight promise settles with its text or null.
  function fetchBatch(items, asked, cached) {
    const started = now();
    const work = Promise.resolve().then(() => call(items)).then((answer) => {
      const a = typeof answer === 'string' ? { text: answer, inTok: 0, outTok: 0 } : (answer || {});
      const spanish = parseAnswer(a.text, items.length);
      remember(items, spanish);
      count(items.length, a.inTok || 0, a.outTok || 0);
      log('translate: ' + asked + ' asked, ' + cached + ' cached, ' + items.length + ' new (Gemini ' + (now() - started) + ' ms, ' +
        (a.inTok || 0) + ' + ' + (a.outTok || 0) + ' tokens)');
      return spanish;
    }).catch((e) => {
      pausedUntil = now() + BACKOFF_MS;
      lastErrorAt = now();
      log('translate: Gemini failed (' + (e && e.message ? e.message : 'error') + '), ' + asked + ' asked, ' + cached + ' cached, ' +
        items.length + ' not translated, pausing 10 min');
      return null;
    });
    items.forEach((k, i) => {
      const p = work.then((sp) => (sp ? sp[i] : null));
      inflight.set(k, p);
      p.then(() => { if (inflight.get(k) === p) inflight.delete(k); });
    });
  }

  // texts: the checked list. Resolves { map, disabled }.
  function translate(texts) {
    const map = {};
    const misses = [];
    texts.forEach((s) => {
      if (cache.has(s)) map[s] = cache.get(s);
      else misses.push(s);
    });
    if (!misses.length) {
      if (texts.length) log('translate: ' + texts.length + ' asked, ' + texts.length + ' cached, 0 new');
      return Promise.resolve({ map: map, disabled: !enabled });
    }
    if (!enabled) {
      log('translate: ' + texts.length + ' asked, ' + (texts.length - misses.length) + ' cached, translating is off (no key)');
      return Promise.resolve({ map: map, disabled: true });
    }
    const fresh = misses.filter((s) => !inflight.has(s));
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; newToday = 0; }
    if (fresh.length) {
      if (newToday + fresh.length > maxNew) {
        log('translate: ' + texts.length + ' asked, ' + (texts.length - misses.length) + ' cached, ' + fresh.length + ' not translated (daily limit)');
        fresh.length = 0;
      } else if (now() < pausedUntil) {
        log('translate: ' + texts.length + ' asked, ' + (texts.length - misses.length) + ' cached, ' + fresh.length + ' not translated (paused)');
        fresh.length = 0;
      } else {
        newToday += fresh.length;
        fetchBatch(fresh, texts.length, texts.length - misses.length);
      }
    }
    return Promise.all(misses.map((s) => (inflight.has(s) ? inflight.get(s) : Promise.resolve(cache.get(s) || null)))).then((list) => {
      misses.forEach((s, i) => { if (typeof list[i] === 'string') map[s] = list[i]; });
      return { map: map, disabled: false };
    });
  }

  function info() {
    const today = dayKey(now());
    return {
      enabled: enabled, cached: cache.size, paused: now() < pausedUntil,
      lastError: lastErrorAt ? new Date(lastErrorAt).toISOString() : '',
      cap: maxNew, today: sum(today), month: sum(today.slice(0, 8)), all: sum(''),
      price: { inPerMillion: PRICE_IN, outPerMillion: PRICE_OUT }
    };
  }

  return { translate: translate, info: info, size: () => cache.size };
}

module.exports = { MAX_NEW_PER_DAY, USAGE_FILE, PRICE_IN, PRICE_OUT, createTranslator, checkRequest, parseAnswer, MAX_TEXTS, MAX_TEXT, MAX_CACHE, BACKOFF_MS, MODEL, FILE };
