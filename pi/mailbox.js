/*
 * The Claude mailbox. Claude runs in the cloud and cannot reach the Pi, so it
 * leaves commands in a Cloudflare R2 bucket and the Pi picks them up. The Pi
 * only ever makes outbound HTTPS calls to R2's S3 API; nothing listens.
 *
 *   inbox/<id>.json    written by Claude: { id, created, cmd, args }
 *   outbox/<id>.json   written by the Pi: { id, cmd, ok, message, data, started, finished, state }
 *   status.json        written by the Pi every minute and after each command
 *   health/latest.json and health/YYYY-MM-DD.json
 *                      the weekly Pi health report (pi/health/pi-health.py),
 *                      copied here by the Pi whenever data/health/latest.json changes
 *
 * Only the commands in COMMANDS below can run: the same things ./hub does,
 * through the server's own control API (so every change goes through the same
 * checks). There is no shell, no git and no docker here, ever.
 *
 * A command runs at most once. Before it runs, its outbox file is written
 * with state "running"; a command whose outbox file already exists is never
 * run again. If the result cannot be written, it is kept in memory and
 * written later; the command is not run again.
 *
 * Settings (pi/.env): HUB_MAILBOX_ENDPOINT, HUB_MAILBOX_BUCKET,
 * HUB_MAILBOX_ACCESS_KEY_ID, HUB_MAILBOX_SECRET_ACCESS_KEY,
 * HUB_MAILBOX_POLL_SECONDS. The keys are never logged or written anywhere.
 *
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const hubctl = require('./hubctl');
const awws = require('./awws');
const budget = require('./budget');
const budgetgoal = require('./budgetgoal');
const shows = require('./shows');
const linktests = require('./linktests');
const tvremote = require('./tvremote');
const tvlaunch = require('./tvlaunch');
const news = require('./news');
const echo = require('./echo');
const grocery = require('./grocery');
const lightSettings = require('./lights/settings');

const DEFAULT_BUCKET = 'home-hub-mailbox';
const DEFAULT_POLL_SECONDS = 10;
const MIN_POLL_SECONDS = 3;
const MAX_POLL_SECONDS = 3600;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const INBOX_KEY_RE = /^inbox\/([^/]*)\.json$/;
const OUTBOX_KEY_RE = /^outbox\/([^/]*)\.json$/;
const MAX_FILE = 64 * 1024;
const MAX_PER_POLL = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const OUTBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 20;
const MAX_DATA_BYTES = 48 * 1024;
const MAX_MESSAGE = 8000;
const MAX_TEXT = 140;
const MAX_TITLE = 80;
const MAX_NOTES = 300;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 8;
const MAX_AMBIENCE_CONFIG = 8 * 1024;
const HEALTH_MAX = 512 * 1024;
const HEALTH_CHECK_MS = 60 * 1000;
const HEALTH_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const HEALTH_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/* ---------- AWS Signature Version 4 ---------- */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

// RFC 3986 encoding, as S3 wants it. Slashes stay when keepSlash is set.
function uriEncode(text, keepSlash) {
  const out = encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

function signingKey(secret, date, region, service) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// o: { method, path (not yet encoded), query {name: value}, headers {name: value}
//      (every header given is signed), payloadHash, accessKeyId, secretAccessKey,
//      region, service, amzDate (20130524T000000Z) }
function signRequest(o) {
  const date = o.amzDate.slice(0, 8);
  const scope = date + '/' + o.region + '/' + o.service + '/aws4_request';
  const canonicalUri = uriEncode(o.path, true);
  const q = o.query || {};
  const canonicalQuery = Object.keys(q).map((k) => [uriEncode(k), uriEncode(String(q[k]))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map((p) => p[0] + '=' + p[1]).join('&');
  const h = {};
  Object.keys(o.headers).forEach((k) => { h[k.toLowerCase()] = String(o.headers[k]).trim().replace(/\s+/g, ' '); });
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((k) => k + ':' + h[k] + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [o.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(o.secretAccessKey, date, o.region, o.service))
    .update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + o.accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signature: signature
  };
}

function amzDateOf(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/* ---------- a tiny S3 client ---------- */

function xmlDecode(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch (x) { return ''; }
  });
}

function xmlTag(text, name) {
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(text);
  return m ? xmlDecode(m[1]) : null;
}

function parseListXml(xml) {
  const items = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = xmlTag(m[1], 'Key');
    if (key === null) continue;
    const lm = Date.parse(xmlTag(m[1], 'LastModified') || '');
    items.push({ key: key, lastModified: isFinite(lm) ? lm : 0, size: Number(xmlTag(m[1], 'Size')) || 0 });
  }
  return {
    items: items,
    truncated: xmlTag(xml, 'IsTruncated') === 'true',
    next: xmlTag(xml, 'NextContinuationToken')
  };
}

function isLocalHost(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

// The endpoint Cloudflare shows may end with the bucket name; that is fine.
// Returns { url, bucket } or throws an Error with a plain message.
function parseEndpoint(raw, bucketSetting) {
  let text = String(raw || '').trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch (e) { throw new Error('HUB_MAILBOX_ENDPOINT is not a web address'); }
  if (url.username || url.password) throw new Error('HUB_MAILBOX_ENDPOINT must not contain a user name or password');
  if (url.search || url.hash) throw new Error('HUB_MAILBOX_ENDPOINT must not contain ? or #');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) throw new Error('HUB_MAILBOX_ENDPOINT must start with https://');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HUB_MAILBOX_ENDPOINT must start with https://');
  const pathPart = url.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  let bucket = String(bucketSetting || '').trim();
  if (pathPart) {
    if (pathPart.indexOf('/') >= 0) throw new Error('HUB_MAILBOX_ENDPOINT has an unexpected path after the address');
    if (bucket && bucket !== pathPart) throw new Error('HUB_MAILBOX_ENDPOINT ends with a bucket name that is not HUB_MAILBOX_BUCKET');
    bucket = pathPart;
  }
  if (!bucket) bucket = DEFAULT_BUCKET;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('HUB_MAILBOX_BUCKET is not a valid bucket name');
  return { url: url, bucket: bucket };
}

function s3Error(status, body) {
  const code = xmlTag(String(body || ''), 'Code');
  const e = new Error('R2 answered HTTP ' + status + (code ? ' ' + code.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : ''));
  e.status = status;
  return e;
}

// cfg: { url (URL), bucket, accessKeyId, secretAccessKey, region, timeoutMs, now }
function createS3(cfg) {
  const lib = cfg.url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 2 });
  const hostHeader = cfg.url.host; // includes a non-default port
  const now = cfg.now || (() => new Date());

  function send(method, key, query, body, extraHeaders, maxBytes) {
    return new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(body) : Buffer.alloc(0);
      const payloadHash = sha256Hex(payload);
      const p = '/' + cfg.bucket + (key ? '/' + key : '');
      const signed = { host: hostHeader, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDateOf(now()) };
      const sig = signRequest({
        method: method, path: p, query: query || {}, headers: signed, payloadHash: payloadHash,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region || 'auto', service: 's3',
        amzDate: signed['x-amz-date']
      });
      const qs = Object.keys(query || {}).map((k) => uriEncode(k) + '=' + uriEncode(String(query[k]))).join('&');
      const headers = Object.assign({}, extraHeaders || {}, {
        Host: hostHeader,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': signed['x-amz-date'],
        Authorization: sig.authorization,
        'Content-Length': payload.length
      });
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = lib.request({
        protocol: cfg.url.protocol, hostname: cfg.url.hostname, port: cfg.url.port || undefined,
        method: method, path: uriEncode(p, true) + (qs ? '?' + qs : ''), headers: headers, agent: agent,
        timeout: cfg.timeoutMs || REQUEST_TIMEOUT_MS
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > (maxBytes || MAX_LIST_BYTES)) {
            const e = new Error('the answer from R2 was too large');
            e.tooBig = true;
            req.destroy();
            finish(reject, e);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => finish(reject, e));
      req.end(payload);
    });
  }

  return {
    // Every key under prefix: [{ key, lastModified (ms), size }].
    list: async (prefix) => {
      const out = [];
      let token = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const q = { 'list-type': '2', prefix: prefix, 'max-keys': '1000' };
        if (token) q['continuation-token'] = token;
        const r = await send('GET', '', q);
        if (r.status !== 200) throw s3Error(r.status, r.body);
        const parsed = parseListXml(r.body.toString('utf8'));
        parsed.items.forEach((i) => out.push(i));
        if (!parsed.truncated || !parsed.next) break;
        token = parsed.next;
      }
      return out;
    },
    // The object's bytes, or null when it is not there.
    get: async (key, maxBytes) => {
      const r = await send('GET', key, null, null, null, maxBytes);
      if (r.status === 404) return null;
      if (r.status !== 200) throw s3Error(r.status, r.body);
      return r.body;
    },
    put: async (key, text, contentType) => {
      const r = await send('PUT', key, null, text, { 'Content-Type': contentType || 'application/json' });
      if (r.status < 200 || r.status > 299) throw s3Error(r.status, r.body);
    },
    del: async (key) => {
      const r = await send('DELETE', key, null, null);
      if (r.status !== 404 && (r.status < 200 || r.status > 299)) throw s3Error(r.status, r.body);
    },
    close: () => agent.destroy()
  };
}

/* ---------- settings ---------- */

// Returns { configured: false, problem } or { configured: true, url, bucket,
// accessKeyId, secretAccessKey, pollSeconds }. Problems never contain values.
function configFromEnv(env) {
  const e = env || {};
  const endpoint = (e.HUB_MAILBOX_ENDPOINT || '').trim();
  const keyId = (e.HUB_MAILBOX_ACCESS_KEY_ID || '').trim();
  const secret = (e.HUB_MAILBOX_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint && !keyId && !secret) return { configured: false, problem: '' };
  const missing = [];
  if (!endpoint) missing.push('HUB_MAILBOX_ENDPOINT');
  if (!keyId) missing.push('HUB_MAILBOX_ACCESS_KEY_ID');
  if (!secret) missing.push('HUB_MAILBOX_SECRET_ACCESS_KEY');
  if (missing.length) return { configured: false, problem: missing.join(' and ') + ' missing in pi/.env' };
  if (/\s/.test(keyId) || /\s/.test(secret)) return { configured: false, problem: 'a HUB_MAILBOX_ key contains a space' };
  let ep;
  try { ep = parseEndpoint(endpoint, e.HUB_MAILBOX_BUCKET); } catch (err) { return { configured: false, problem: err.message }; }
  let poll = DEFAULT_POLL_SECONDS;
  const pollText = String(e.HUB_MAILBOX_POLL_SECONDS || '').trim();
  if (pollText) {
    const n = Number(pollText);
    if (isFinite(n) && n > 0) poll = Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(n)));
  }
  return { configured: true, url: ep.url, bucket: ep.bucket, accessKeyId: keyId, secretAccessKey: secret, pollSeconds: poll };
}

/* ---------- argument checks ---------- */

function argError(msg) {
  const e = new Error(msg);
  e.reject = true;
  return e;
}

function text(name, max, value) {
  if (typeof value !== 'string') throw argError('"' + name + '" must be text');
  const t = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!t) throw argError('"' + name + '" is empty');
  if (Array.from(t).length > max) throw argError('"' + name + '" is longer than ' + max + ' characters');
  return t;
}

const V = {
  text: (max) => (name, v) => text(name, max, v),
  bool: () => (name, v) => {
    if (typeof v !== 'boolean') throw argError('"' + name + '" must be true or false');
    return v;
  },
  number: (min, max) => (name, v) => {
    if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) throw argError('"' + name + '" must be a number from ' + min + ' to ' + max);
    return v;
  },
  // A whole number from min to max.
  int: (min, max) => (name, v) => {
    if (!Number.isInteger(v) || v < min || v > max) throw argError('"' + name + '" must be a whole number from ' + min + ' to ' + max);
    return v;
  },
  oneOf: (list) => (name, v) => {
    if (typeof v !== 'string' || list.indexOf(v.trim()) < 0) throw argError('"' + name + '" must be one of: ' + list.join(', '));
    return v.trim();
  },
  // Like text, but empty is allowed (it means "no notes").
  notes: (max) => (name, v) => {
    if (typeof v !== 'string') throw argError('"' + name + '" must be text');
    const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (Array.from(t).length > max) throw argError('"' + name + '" is longer than ' + max + ' characters');
    return t;
  },
  // An http or https address, no spaces.
  url: (max) => (name, v) => {
    if (typeof v !== 'string' || !/^https?:\/\/\S+$/i.test(v.trim())) throw argError('"' + name + '" must be an http or https address');
    if (v.trim().length > max) throw argError('"' + name + '" is longer than ' + max + ' characters');
    return v.trim();
  },
  date: () => (name, v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw argError('"' + name + '" must look like 2026-12-31');
    return v.trim();
  },
  list: (max) => (name, v) => {
    if (!Array.isArray(v)) throw argError('"' + name + '" must be a list');
    if (v.length > max) throw argError('"' + name + '" has more than ' + max + ' entries');
    return v;
  },
  // A JSON object, copied without "__proto__", "constructor" or "prototype"
  // keys at any depth, so nothing in it can reach an object's prototype.
  object: () => (name, v) => {
    if (!isObj(v)) throw argError('"' + name + '" must be an object');
    return plainCopy(name, v, 0);
  }
};

function plainCopy(name, v, depth) {
  if (depth > MAX_DEPTH) throw argError('"' + name + '" is nested more than ' + MAX_DEPTH + ' levels deep');
  if (Array.isArray(v)) return v.map((x) => plainCopy(name, x, depth + 1));
  if (!isObj(v)) return v;
  const out = {};
  Object.keys(v).forEach((k) => {
    if (!BAD_KEYS.has(k)) out[k] = plainCopy(name, v[k], depth + 1);
  });
  return out;
}

/* ---------- the commands ---------- */

// Each command: args { name: [check, required, nullable] }, check(args) for
// extra rules, run(args, ctx) -> { message, data, restart }. An arg marked
// nullable may be sent as null and reaches run as null; otherwise null counts
// as left out.
function lines(list) {
  return list.join('\n');
}

function sendCommand(type, data) {
  return async (args, ctx) => {
    const r = await ctx.call('POST', '/api/command', { type: type, data: data(args) });
    return { message: hubctl.commandText(r), data: { delivered: r.delivered } };
  };
}

function calendarSummary(list) {
  return (list || []).map((c) => {
    const o = { name: c.name, ok: !!c.ok, count: c.count || 0 };
    if (c.error) o.error = c.error;
    if (c.updatedAt) o.updatedAt = c.updatedAt;
    return o;
  });
}

function oneOfIdOrTitle(a) {
  const has = (k) => a[k] !== undefined;
  if (has('id') === has('title')) throw argError('give "id" or "title" (exactly one)');
}

function oneOfIdOrName(a) {
  const has = (k) => a[k] !== undefined;
  if (has('id') === has('name')) throw argError('give "id" or "name" (exactly one)');
}

// grocery.done and grocery.remove: a miss answers ok: false, never a throw.
function groceryChange(sub) {
  return async (a, ctx) => {
    try {
      return await hubctl.groceryChange(ctx.call, sub, a.id !== undefined ? a.id : a.name);
    } catch (e) {
      if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
      throw e;
    }
  };
}

// The pantry: a miss (no such item, two of that name) answers ok: false.
function pantryRun(fn) {
  return async (a, ctx) => {
    try {
      return await fn(a, ctx);
    } catch (e) {
      if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
      throw e;
    }
  };
}

const PANTRY_PLACES = ['fridge', 'freezer', 'pantry', 'bathroom', 'other'];
const PANTRY_ARGS = {
  qty: [V.int(0, 9999), false],
  restockAt: [V.int(0, 999), false],
  location: [V.oneOf(PANTRY_PLACES), false],
  autoAdd: [V.bool(), false]
};

function todoChange(sub) {
  return async (args, ctx) => {
    const r = await ctx.call('GET', '/api/todo');
    let item;
    try {
      item = hubctl.matchItem(r.items || [], args.id !== undefined ? args.id : args.title);
    } catch (e) {
      if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
      throw e;
    }
    const op = sub === 'done' ? { op: 'set', id: item.id, fields: { done: true } } : { op: 'remove', id: item.id };
    await ctx.call('POST', '/api/todo/ops', { ops: [op] });
    return { message: hubctl.todoChangeText(sub, item), data: { id: item.id, title: item.title } };
  };
}

// Counts only: the saved settings hold Home Assistant entity ids, which stay
// on the Pi.
function ambienceCounts(c) {
  const n = (k) => (c && Array.isArray(c[k]) ? c[k].length : 0);
  return { lights: n('lights'), scenes: n('scenes'), moods: n('moods') };
}

// The run function of an echo.* command: POST /api/echo with the same words.
function echoRun(action) {
  return async (a, ctx) => {
    const body = { action: action };
    ['target', 'app', 'query', 'level'].forEach((k) => { if (a[k] !== undefined) body[k] = a[k]; });
    const r = await ctx.call('POST', '/api/echo', body);
    const out = { message: hubctl.echoText(r), data: { echo: r.echo || null } };
    if (!r.ok) out.ok = false;
    return out;
  };
}

// A music lights change; the reply is the line ./hub lights prints.
function lightsChange(bodyOf) {
  return async (a, ctx) => {
    const r = await ctx.call('POST', '/api/lights', bodyOf(a));
    return { message: hubctl.lightsChangeText(r), data: { settings: r.settings } };
  };
}

const COMMANDS = {
  show: {
    args: { widget: [V.oneOf(hubctl.WIDGETS), true], full: [V.bool(), false] },
    run: sendCommand('show', (a) => ({ widget: a.widget, mode: a.full ? 'full' : 'panel' }))
  },
  home: { args: {}, run: sendCommand('home', () => ({})) },
  reload: { args: {}, run: sendCommand('reload', () => ({})) },
  say: {
    args: { text: [V.text(MAX_TEXT), true], seconds: [V.number(1, 60), false] },
    run: sendCommand('say', (a) => (a.seconds !== undefined ? { text: a.text, seconds: a.seconds } : { text: a.text }))
  },
  play: {
    args: { url: [V.url(2048), true], title: [V.text(MAX_TEXT), false] },
    run: sendCommand('play', (a) => (a.title !== undefined ? { url: a.url, title: a.title } : { url: a.url }))
  },
  stop: { args: {}, run: sendCommand('stop', () => ({})) },
  news: {
    args: {},
    run: async (args, ctx) => {
      let ep;
      try {
        ep = await news.latestPlayable();
      } catch (e) {
        return { message: 'Could not read the NPR News Now feed: ' + (e && e.message) + '.', ok: false };
      }
      const r = await ctx.call('POST', '/api/command', { type: 'play', data: hubctl.newsPlay(ep) });
      return { message: hubctl.newsText(ep, r), data: { delivered: r.delivered, title: ep.title, published: ep.published } };
    }
  },
  'todo.add': {
    args: {
      title: [V.text(MAX_TITLE), true], section: [V.oneOf(Object.keys(hubctl.SECTION_NAMES)), false],
      level: [V.oneOf(Object.keys(hubctl.LEVEL_NAMES)), false], due: [V.date(), false],
      lead: [V.int(0, hubctl.MAX_LEAD), false], notes: [V.notes(MAX_NOTES), false]
    },
    run: async (a, ctx) => {
      const body = { title: a.title };
      if (a.section !== undefined) body.section = a.section;
      if (a.level !== undefined) body.level = a.level;
      if (a.due !== undefined) body.due = a.due;
      if (a.lead !== undefined) body.lead = a.lead;
      if (a.notes) body.notes = a.notes;
      const r = await ctx.call('POST', '/api/todo', body);
      return { message: hubctl.todoAddText(r), data: { item: r.item } };
    }
  },
  'todo.list': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/todo');
      const items = (r.items || []).map((i) => {
        const o = { id: i.id, title: i.title, level: hubctl.levelOf(i), section: i.section, done: i.done };
        if (i.due) o.due = i.due;
        if (hubctl.leadOf(i) !== null) o.lead = hubctl.leadOf(i);
        if (i.notes) o.notes = i.notes;
        return o;
      });
      return { message: lines(hubctl.todoListLines(r.items || [])), data: { items: items } };
    }
  },
  'todo.done': { args: { id: [V.text(40), false], title: [V.text(MAX_TITLE), false] }, check: oneOfIdOrTitle, run: todoChange('done') },
  'todo.remove': { args: { id: [V.text(40), false], title: [V.text(MAX_TITLE), false] }, check: oneOfIdOrTitle, run: todoChange('remove') },
  // "notes": "" or null removes the notes.
  'todo.notes': {
    args: { id: [V.text(40), false], title: [V.text(MAX_TITLE), false], notes: [V.notes(MAX_NOTES), true, true] },
    check: oneOfIdOrTitle,
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/todo');
      let item;
      try {
        item = hubctl.matchItem(r.items || [], a.id !== undefined ? a.id : a.title);
      } catch (e) {
        if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
        throw e;
      }
      const after = await hubctl.setNotes(ctx.call, item, a.notes);
      const data = { id: after.id, title: after.title };
      if (after.notes) data.notes = after.notes;
      return { message: hubctl.todoNotesText(after), data: data };
    }
  },
  'todo.level': {
    args: { id: [V.text(40), false], title: [V.text(MAX_TITLE), false], level: [V.oneOf(Object.keys(hubctl.LEVEL_NAMES)), true] },
    check: oneOfIdOrTitle,
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/todo');
      let item;
      try {
        item = hubctl.matchItem(r.items || [], a.id !== undefined ? a.id : a.title);
      } catch (e) {
        if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
        throw e;
      }
      const after = await hubctl.setLevel(ctx.call, item, a.level);
      return { message: hubctl.todoLevelText(after), data: { id: after.id, title: after.title, level: hubctl.levelOf(after) } };
    }
  },
  // "lead": null goes back to the TV's default (2 days).
  'todo.lead': {
    args: { id: [V.text(40), false], title: [V.text(MAX_TITLE), false], lead: [V.int(0, hubctl.MAX_LEAD), true, true] },
    check: oneOfIdOrTitle,
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/todo');
      let item;
      try {
        item = hubctl.matchItem(r.items || [], a.id !== undefined ? a.id : a.title);
      } catch (e) {
        if (e instanceof hubctl.Stop) return { ok: false, message: e.message };
        throw e;
      }
      const after = await hubctl.setLead(ctx.call, item, a.lead);
      return { message: hubctl.todoLeadText(after), data: { id: after.id, title: after.title, lead: hubctl.leadOf(after) } };
    }
  },
  'grocery.add': {
    args: {
      items: [(name, v) => {
        V.list(hubctl.MAX_GROCERY_ADD)(name, v);
        if (!v.length) throw argError('"items" is empty');
        return v.map((n, i) => text('items[' + i + ']', grocery.MAX_NAME, n));
      }, true]
    },
    run: (a, ctx) => hubctl.groceryAdd(ctx.call, a.items)
  },
  'grocery.list': {
    args: {},
    run: async (a, ctx) => {
      const items = (await ctx.call('GET', '/api/grocery')).items || [];
      return { message: lines(hubctl.groceryListLines(items)), data: { items: items.map((i) => ({ id: i.id, name: i.name, done: i.done })) } };
    }
  },
  'grocery.done': { args: { id: [V.text(40), false], name: [V.text(grocery.MAX_NAME), false] }, check: oneOfIdOrName, run: groceryChange('done') },
  'grocery.remove': { args: { id: [V.text(40), false], name: [V.text(grocery.MAX_NAME), false] }, check: oneOfIdOrName, run: groceryChange('remove') },
  'grocery.clear': { args: {}, run: (a, ctx) => hubctl.groceryClear(ctx.call) },
  // Counts and one search text ("Brand Name Size") per item to get.
  'grocery.export': { args: {}, run: (a, ctx) => hubctl.groceryExport(ctx.call) },
  // Keep an item in the pantry (a second add of the same one adds to its count).
  'pantry.add': {
    args: Object.assign({ name: [V.text(80), false], upc: [V.text(14), false], brand: [V.text(40), false] }, PANTRY_ARGS),
    check: (a) => { if (a.name === undefined && a.upc === undefined) throw argError('give "name" or "upc"'); },
    run: pantryRun((a, ctx) => hubctl.pantryAdd(ctx.call, a))
  },
  'pantry.set': {
    args: Object.assign({ id: [V.int(1, 1e9), false], name: [V.text(80), false] }, PANTRY_ARGS),
    check: (a) => {
      oneOfIdOrName(a);
      if (['qty', 'restockAt', 'location', 'autoAdd'].every((k) => a[k] === undefined)) throw argError('give at least one of "qty", "restockAt", "location", "autoAdd"');
    },
    run: pantryRun((a, ctx) => hubctl.pantrySet(ctx.call, a.id !== undefined ? String(a.id) : a.name, a))
  },
  'pantry.list': { args: {}, run: pantryRun((a, ctx) => hubctl.pantryList(ctx.call)) },
  'pantry.low': { args: {}, run: pantryRun((a, ctx) => hubctl.pantryLow(ctx.call)) },
  'calendar.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/calendar');
      const d = r.data || {};
      return {
        message: lines(hubctl.calendarStatusLines(d)),
        data: { configured: !!d.configured, calendars: calendarSummary(d.calendars) }
      };
    }
  },
  'calendar.refresh': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/calendar/refresh', {});
      return {
        message: lines(hubctl.calendarRefreshLines(r)),
        data: { done: !!r.done, changed: !!r.changed, calendars: calendarSummary(r.calendars) }
      };
    }
  },
  'layout.show': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/layout');
      return { message: lines(hubctl.layoutLines(r.layout)), data: { layout: r.layout } };
    }
  },
  'layout.set': {
    // Only the shape is checked here; the server's own layout check decides.
    args: { layout: [V.list(24), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/layout', { layout: a.layout });
      return { message: hubctl.layoutSetText(r), data: { changed: r.changed, layout: r.layout } };
    }
  },
  'layout.reset': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/layout', { layout: null });
      return { message: hubctl.layoutResetText(r), data: { changed: r.changed } };
    }
  },
  'awws.show': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/awws');
      // Only counts and times: the whole snapshot would not fit in a reply.
      return { message: lines(hubctl.awwsShowLines(r)), data: awws.summaryData(r.data) };
    }
  },
  'awws.set': {
    // Only the shape is checked here; the server's own snapshot check decides.
    args: { snapshot: [V.object(), true, true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/awws', { snapshot: a.snapshot });
      const text = a.snapshot === null ? awws.clearText(r) : awws.setText(r);
      return {
        message: text,
        data: { changed: r.changed, bytes: r.bytes, accepted: r.accepted, cleared: r.cleared, rejected: r.rejected }
      };
    }
  },
  'awws.resync': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/awws/resync', {});
      return { message: awws.resyncText(r), data: { requestedAt: r.requestedAt, already: r.already } };
    }
  },
  'awws.clear': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/awws', { snapshot: null });
      return { message: awws.clearText(r), data: { changed: r.changed, cleared: r.cleared } };
    }
  },
  'budget.show': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/budget');
      // Counts, dates and states only: never labels or amounts.
      return { message: lines(hubctl.budgetShowLines(r)), data: budget.summaryData(r.data) };
    }
  },
  'budget.set': {
    // Only the shape is checked here; the server's own snapshot check decides.
    args: { snapshot: [V.object(), true, true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/budget', { snapshot: a.snapshot });
      const text = a.snapshot === null ? budget.clearText(r) : budget.setText(r);
      return {
        message: text,
        data: { changed: r.changed, bytes: r.bytes, accepted: r.accepted, cleared: r.cleared, rejected: r.rejected }
      };
    }
  },
  'budget.clear': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/budget', { snapshot: null });
      return { message: budget.clearText(r), data: { changed: r.changed, cleared: r.cleared } };
    }
  },
  'budget.goal': {
    // The daily spending goal from today on (the Pi's date). Never the amount in the reply.
    args: { goal: [V.int(budgetgoal.MIN_GOAL, budgetgoal.MAX_GOAL), false] },
    run: async (a, ctx) => {
      if (a.goal === undefined) {
        const g = await ctx.call('GET', '/api/budget/goal');
        return { message: budgetgoal.showText(g.goals), data: { changes: g.goals.length, since: g.goals.length ? g.goals[g.goals.length - 1].from : null } };
      }
      const r = await ctx.call('POST', '/api/budget/goal', { goal: a.goal });
      return { message: budgetgoal.setText(r), data: { changed: r.changed, from: r.from } };
    }
  },
  'prefs.show': {
    // The widget preferences every screen shares (prefs.js): keys and times, never values.
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/prefs');
      return { message: r.message, data: { keys: r.keys, at: r.at, guestAll: r.guestAll } };
    }
  },
  'shows.list': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/shows');
      return { message: lines(hubctl.showsListLines(r)), data: shows.summaryData(r) };
    }
  },
  // Only the shape is checked here; the server's own list check decides.
  'shows.add': {
    args: {
      name: [V.text(80), true], service: [V.text(24), false], tvmazeId: [V.number(1, 999999999), false], serviceOverride: [V.text(24), false],
      alsoOn: [V.list(4), false], via: [V.text(24), false], link: [V.text(80), false]
    },
    run: async (a, ctx) => {
      const entry = { name: a.name };
      ['service', 'tvmazeId', 'serviceOverride', 'alsoOn', 'via', 'link'].forEach((k) => { if (a[k] !== undefined) entry[k] = a[k]; });
      const r = await ctx.call('POST', '/api/shows', { add: entry });
      return { message: shows.addText(r), data: { entry: r.entry, replaced: !!r.replaced, list: r.list } };
    }
  },
  'shows.remove': {
    args: { name: [V.text(80), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows', { remove: a.name });
      return { message: shows.removeText(r.removed), data: { removed: r.removed, list: r.list } };
    }
  },
  'shows.set': {
    args: { shows: [V.list(40), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows', { set: a.shows });
      return { message: shows.setText(r.list || []), data: { list: r.list } };
    }
  },
  // episode is "S3E4"; left out on shows.watched = the earliest episode out and not yet marked.
  'shows.watched': {
    args: { name: [V.text(80), true], episode: [V.text(12), false] },
    run: async (a, ctx) => {
      const body = { show: a.name };
      if (a.episode !== undefined) body.episode = a.episode;
      const r = await ctx.call('POST', '/api/shows/watched', body);
      return { message: shows.watchedText(r), data: { season: r.season, number: r.number, changed: !!r.changed } };
    }
  },
  'shows.unwatch': {
    args: { name: [V.text(80), true], episode: [V.text(12), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows/unwatch', { show: a.name, episode: a.episode });
      return { message: shows.unwatchText(r), data: { season: r.season, number: r.number, changed: !!r.changed } };
    }
  },
  // "I'm only up to S3E4" (binge) and "seen it all" (every episode out so far).
  'shows.upto': {
    args: { name: [V.text(80), true], episode: [V.text(12), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows/upto', { show: a.name, episode: a.episode });
      return { message: shows.upToText(r), data: { season: r.season, number: r.number, changed: !!r.changed } };
    }
  },
  'shows.caughtup': {
    args: { name: [V.text(80), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows/caughtup', { show: a.name });
      return { message: shows.caughtUpText(r), data: { season: r.season, number: r.number, changed: !!r.changed } };
    }
  },
  'shows.refresh': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/shows/refresh', {});
      return { message: shows.refreshText(r), data: Object.assign({ done: !!r.done, changed: !!r.changed, problems: r.problems || [] }, shows.summaryData(r)) };
    }
  },
  'linktests.show': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/linktests');
      return { message: lines(linktests.lines(r.data)), data: { results: ((r.data && r.data.results) || []).slice(0, 40) } };
    }
  },
  // The TV's remote from the Pi (tvremote.js). The status leaves out the TV's address.
  // What Home Assistant knows about the TV (its state and the app names it can open), and the last launch.
  'tv.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/tv');
      return { message: lines(tvlaunch.lines(r.tv || {})), data: { tv: r.tv || null } };
    }
  },
  // Opens something on the TV (turns it on first). Sends the TV a command: only with the owner's go-ahead.
  'tv.launch': {
    args: { kind: [V.oneOf(tvlaunch.KINDS), true], name: [V.text(40), true], match: [(n, v) => { if (!Array.isArray(v) || v.length > 8 || v.some((x) => typeof x !== 'string' || x.length > 40)) throw argError('"' + n + '" must be up to 8 app names'); return v; }, false], key: [V.text(40), false], url: [V.text(300), false] },
    run: async (a, ctx) => {
      await ctx.call('POST', '/api/tv/launch', a);
      return { message: 'Queued ' + a.kind + ' ' + a.name + ' on the TV. Read the result with tv.status in about a minute.', data: { queued: true } };
    }
  },
  'tvremote.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/tvremote');
      return { message: lines(tvremote.lines(r)), data: { paired: !!r.paired, running: !!r.running, last: r.last || null } };
    }
  },
  'tvremote.run': {
    args: {
      id: [V.text(40), true], appId: [V.text(60), true], appName: [V.text(40), false],
      open: [V.bool(), false], waitOpen: [V.number(0, 30), false], enter: [V.bool(), false], waitAfter: [V.number(0, 30), false],
      link: [V.oneOf(['deeplink', 'dial', 'none']), false], payload: [V.text(300), false], dialApp: [V.oneOf(tvremote.DIAL_APPS), false]
    },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/tvremote/run', a);
      return {
        message: 'Started ' + a.id + ' on the TV' + (r.paired ? '' : '; the TV will ask to allow "Home Hub Pi" (choose Allow)') + '. Read the steps with tvremote.status in about 30 seconds.',
        data: { started: true, paired: !!r.paired }
      };
    }
  },
  status: {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/status');
      return {
        message: lines(hubctl.statusLines(r)),
        data: { server: r.server, uptimeSeconds: r.uptime, rev: r.rev, screensListening: (r.screens || []).length, calendar: r.calendar }
      };
    }
  },
  'spotify.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/spotify');
      return { message: lines(hubctl.spotifyStatusLines(r.spotify)), data: { spotify: r.spotify || null } };
    }
  },
  // The two halves of ./hub spotify login. The link holds the app's public
  // client ID and a one-time state, never the secret. The pasted address
  // holds a code that works once, for a few minutes, and only with the secret
  // that stays on the Pi.
  'spotify.login': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/spotify/login', {});
      return { message: lines(hubctl.spotifyLoginLines(r)), data: { url: r.url, redirectUri: r.redirectUri, minutes: r.minutes } };
    }
  },
  'spotify.code': {
    args: { address: [V.text(4000), true] },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/spotify/code', { input: a.address });
      return { message: hubctl.spotifyCodeText(r), data: { user: r.user || '' } };
    }
  },
  'spotify.logout': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/spotify/logout', {});
      return { message: hubctl.spotifyLogoutText(r), data: { changed: !!r.changed } };
    }
  },
  // The room's lights (ambience.js). Names of lights and scenes are fine
  // here; the Home Assistant token and the addresses never reach the Pi's
  // answers at all.
  'ambience.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/ambience');
      const s = r.ambience || null;
      return { message: hubctl.ambienceLine(s), data: { ambience: s } };
    }
  },
  'ambience.scene': {
    args: { id: [V.text(32), true] },
    run: async (a, ctx) => {
      const st = (await ctx.call('GET', '/api/ambience')).ambience || {};
      const r = await ctx.call('POST', '/api/ambience/scene', { id: a.id });
      const name = ((st.scenes || []).filter((x) => x.id === a.id)[0] || {}).name;
      return {
        message: hubctl.ambienceSceneText(r, name),
        data: { result: r.result, answered: r.answered, total: r.total, missing: r.missing || [] }
      };
    }
  },
  'ambience.light': {
    args: { id: [V.text(32), true], on: [V.bool(), false], pct: [V.number(1, 100), false] },
    check: (a) => {
      if (a.pct !== undefined && !Number.isInteger(a.pct)) throw argError('"pct" must be a whole number from 1 to 100');
      if (a.pct !== undefined && a.on === false) throw argError('"pct" goes with a light that is on (leave "on" out, or make it true)');
    },
    run: async (a, ctx) => {
      const st = (await ctx.call('GET', '/api/ambience')).ambience || {};
      const body = { id: a.id };
      if (a.on !== undefined) body.on = a.on;
      if (a.pct !== undefined) body.pct = a.pct;
      const r = await ctx.call('POST', '/api/ambience/light', body);
      const name = ((st.lights || []).filter((x) => x.id === a.id)[0] || {}).name;
      return { message: hubctl.ambienceLightText(r, name), data: { result: r.result, on: r.on, pct: r.pct } };
    }
  },
  'ambience.mood': {
    args: { id: [V.text(32), true] },
    run: async (a, ctx) => {
      const st = (await ctx.call('GET', '/api/ambience')).ambience || {};
      const r = await ctx.call('POST', '/api/ambience/mood', { id: a.id });
      const name = ((st.moods || []).filter((x) => x.id === a.id)[0] || {}).name;
      return { message: hubctl.ambienceMoodText(r, name), data: { result: r.result } };
    }
  },
  'ambience.set': {
    // The shape is checked by the server (ambience.js validateConfig).
    args: { config: [V.object(), true] },
    check: (a) => {
      if (Buffer.byteLength(JSON.stringify(a.config)) > MAX_AMBIENCE_CONFIG) throw argError('"config" is larger than 8 KB');
    },
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/ambience/config', { config: a.config });
      return { message: hubctl.ambienceSetText(r, false), data: ambienceCounts(r.config) };
    }
  },
  'ambience.reset': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('POST', '/api/ambience/config', { config: null });
      return { message: hubctl.ambienceSetText(r, true), data: ambienceCounts(r.config) };
    }
  },
  // Music lights (lights/store.js): the lamp and bars follow the Pi's music.
  'lights.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/lights');
      return { message: lines(hubctl.lightsStatusLines(r)), data: { settings: r.settings, engine: r.engine } };
    }
  },
  'lights.on': { args: {}, run: lightsChange(() => ({ on: true })) },
  'lights.off': { args: {}, run: lightsChange(() => ({ on: false })) },
  'lights.set': {
    args: {
      palette: [V.oneOf(lightSettings.paletteIds()), false], vibrancy: [V.oneOf(lightSettings.LEVELS), false],
      beat: [V.oneOf(lightSettings.LEVELS), false], preset: [V.oneOf(Object.keys(lightSettings.PRESETS)), false],
      quiet: [(name, v) => {
        if (v === 'never') return 0;
        return V.int(0, lightSettings.MAX_QUIET_MIN)(name, v);
      }, false],
      on: [V.bool(), false]
    },
    check: (a) => { if (!Object.keys(a).length) throw argError('say what to set: palette, vibrancy, beat, preset, quiet or on'); },
    run: lightsChange((a) => {
      const body = {};
      ['palette', 'vibrancy', 'beat', 'preset', 'on'].forEach((k) => { if (a[k] !== undefined) body[k] = a[k]; });
      if (a.quiet !== undefined) body.quietMin = a.quiet;
      return body;
    })
  },
  'lights.palettes': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/lights');
      return { message: lines(hubctl.lightsPaletteLines(r)), data: { palettes: r.palettes.map((p) => ({ id: p.id, name: p.name })) } };
    }
  },
  // Recent log lines. Always scrubbed on the Pi (addresses and names
  // replaced), so no raw log text reaches the bucket.
  // Spanish translations (translate.js): counts, tokens and estimated cost only, never the texts.
  'translate.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/translate/usage');
      const money = (n) => '$' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
      const line = (name, d) => name + ': ' + d.lines + ' new lines, ' + d.calls + ' Gemini calls, ' +
        (d.inTok + d.outTok) + ' tokens, about ' + money(d.cost);
      const msg = [
        'Translating: ' + (r.enabled ? (r.paused ? 'paused after an error' : 'on') : 'off (no key)') + '; ' + r.cached + ' lines saved; limit ' + r.cap + ' new lines a day.',
        line('Today', r.today), line('This month', r.month), line('All time', r.all)
      ];
      if (r.lastError) msg.push('Last Gemini error: ' + r.lastError);
      return { message: lines(msg), data: { enabled: r.enabled, paused: r.paused, cached: r.cached, cap: r.cap, today: r.today, month: r.month, all: r.all, lastError: r.lastError } };
    }
  },
  // The photo album (photos.js): counts, the last sync time and whether it
  // went well; never a file name or an id.
  'photos.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/photos');
      return {
        message: hubctl.photosStatusText(r),
        data: { count: r.count || 0, newCount: r.newCount || 0, lastRun: r.lastRun || null, ok: typeof r.syncOk === 'boolean' ? r.syncOk : null }
      };
    }
  },
  'log.tail': {
    args: { lines: [V.number(1, 200), false], errors: [V.bool(), false] },
    check: (a) => {
      if (a.lines !== undefined && !Number.isInteger(a.lines)) throw argError('"lines" must be a whole number from 1 to 200');
    },
    run: async (a, ctx) => {
      const r = await ctx.call('GET', hubctl.logQuery(a.lines, a.errors === true, true));
      return {
        message: hubctl.logSummaryText(r, a.errors === true),
        data: { lines: r.lines || [], errors24h: r.errors24h || 0 }
      };
    }
  },
  // What plays anywhere (allsounds.js): state, source, speaker, title and
  // artist only; never a token or an address.
  'allsounds.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/allsounds');
      const s = r.allsounds || null;
      return {
        message: lines(hubctl.allsoundsStatusLines(s)),
        data: { allsounds: s ? { state: s.state, source: s.source, device: s.device, title: s.title, artist: s.artist } : null }
      };
    }
  },
  // Echo controls (echo.js): start an app on an Echo, or steer it. The
  // answer is the server's own words, the same as ./hub. A Home Assistant
  // failure is ok: false with that message.
  'echo.status': {
    args: {},
    run: async (a, ctx) => {
      const r = await ctx.call('GET', '/api/echo');
      return { message: lines(hubctl.echoStatusLines(r.echo)), data: { echo: r.echo || null } };
    }
  },
  'echo.start': {
    args: { app: [V.oneOf(echo.APP_KEYS), true], target: [V.text(20), false], query: [V.text(echo.MAX_QUERY), false] },
    check: (a) => {
      const why = echo.checkStart(a.app, a.query);
      if (why) throw argError(why);
    },
    run: echoRun('start')
  },
  'echo.pause': { args: { target: [V.text(20), false] }, run: echoRun('pause') },
  'echo.resume': { args: { target: [V.text(20), false] }, run: echoRun('resume') },
  'echo.next': { args: { target: [V.text(20), false] }, run: echoRun('next') },
  'echo.stop': { args: { target: [V.text(20), false] }, run: echoRun('stop') },
  'echo.volume': {
    args: { target: [V.text(20), false], level: [(name, v) => {
      if (v === 'up' || v === 'down') return v;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw argError('"' + name + '" must be a whole number from 0 to 100, or "up" or "down"');
      return v;
    }, true] },
    run: echoRun('volume')
  },
  ping: {
    args: {},
    run: async (a, ctx) => ({ message: 'Pong. Home Hub live server ' + ctx.version + ' is running.', data: { version: ctx.version } })
  },
  restart: {
    args: {},
    run: async (a, ctx) => {
      if (!ctx.canRestart) return { ok: false, message: 'This server cannot restart itself (it was not started with node server.js).' };
      return { message: 'Restarting now. The server comes back by itself in a few seconds (Docker restarts it).', data: {}, restart: true };
    }
  }
};

/* ---------- checking one inbox file ---------- */

// Returns { id, created, cmd, args } or throws an Error with e.reject set and
// a plain reason. name is the id from the file name.
function checkEnvelope(name, bytes, nowMs) {
  if (bytes.length > MAX_FILE) throw argError('the file is larger than 64 KB');
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch (e) { throw argError('the file is not valid JSON'); }
  if (!isObj(env)) throw argError('the file must hold a JSON object');
  const extra = Object.keys(env).filter((k) => ['id', 'created', 'cmd', 'args'].indexOf(k) < 0);
  if (extra.length) throw argError('unknown field "' + extra[0].slice(0, 30) + '" (only id, created, cmd and args are allowed)');
  if (typeof env.id !== 'string' || env.id !== name) throw argError('"id" must be the same as the file name (' + name + ')');
  if (typeof env.created !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(env.created) || !isFinite(Date.parse(env.created))) {
    throw argError('"created" must be an ISO time like 2026-11-16T09:30:00Z');
  }
  const created = Date.parse(env.created);
  if (created < nowMs - MAX_AGE_MS) throw argError('the command is older than 24 hours, so it was not run');
  if (created > nowMs + MAX_FUTURE_MS) throw argError('"created" is more than 5 minutes in the future, so it was not run');
  if (typeof env.cmd !== 'string' || !Object.prototype.hasOwnProperty.call(COMMANDS, env.cmd)) {
    const shown = typeof env.cmd === 'string' ? env.cmd.slice(0, 40) : String(env.cmd).slice(0, 20);
    throw argError('unknown command "' + shown + '" (use one of: ' + Object.keys(COMMANDS).join(', ') + ')');
  }
  const spec = COMMANDS[env.cmd];
  const raw = env.args === undefined || env.args === null ? {} : env.args;
  if (!isObj(raw)) throw argError('"args" must be an object');
  const args = {};
  Object.keys(raw).forEach((k) => {
    if (BAD_KEYS.has(k) || !Object.prototype.hasOwnProperty.call(spec.args, k)) {
      const allowed = Object.keys(spec.args);
      throw argError('"' + env.cmd + '" does not take "' + k.slice(0, 30) + '"' + (allowed.length ? ' (it takes ' + allowed.join(', ') + ')' : ' (it takes no args)'));
    }
  });
  Object.keys(spec.args).forEach((k) => {
    const pair = spec.args[k];
    const given = Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : undefined;
    if (given === null && pair[2]) {
      args[k] = null;
      return;
    }
    if (given === undefined || given === null) {
      if (pair[1]) throw argError('"' + env.cmd + '" needs "' + k + '"');
      return;
    }
    args[k] = pair[0](k, given);
  });
  if (spec.check) spec.check(args);
  return { id: name, created: created, cmd: env.cmd, args: args };
}

/* ---------- the mailbox loop ---------- */

// o: { config (from configFromEnv), api (method, route, body) -> Promise<{status, body}>,
//      version, log, onRestart, now () -> Date, manual (no timer, for tests) }
function createMailbox(o) {
  const cfg = o.config;
  const log = o.log || (() => {});
  const now = o.now || (() => new Date());
  const pollMs = cfg.pollSeconds * 1000;
  const s3 = o.s3 || createS3({
    url: cfg.url, bucket: cfg.bucket, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    region: 'auto', now: now
  });
  const pending = new Map(); // id -> { result, restart }: results not written yet
  const info = {
    configured: true, bucket: cfg.bucket, host: cfg.url.host, pollSeconds: cfg.pollSeconds,
    connected: false, lastOkAt: null, lastError: null,
    lastCommandId: null, lastCommand: null, lastCommandAt: null, lastCommandOk: null
  };
  let timer = null;
  let closed = false;
  let running = null;
  let failures = 0;
  let lastHeartbeat = 0;
  let lastPrune = 0;
  let restarting = false;
  let lastHealthCheck = 0;
  let healthSent = null;  // mtime and size of the last health report copied to the bucket
  let healthInfo = null;  // its one-line summary, for status.json

  function describe(e) {
    if (!e) return 'unknown problem';
    if (e.status) return e.message;
    if (e.tooBig) return e.message;
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'cannot find ' + cfg.url.hostname + ' (no internet, or DNS)';
    if (e.code) return 'network problem (' + String(e.code).replace(/[^A-Z0-9_]/g, '').slice(0, 30) + ')';
    if (e.message === 'timed out') return 'R2 did not answer in time';
    return 'network problem';
  }

  async function call(method, route, body) {
    const r = await o.api(method, route, body);
    const echoNo = r.status === 200 && route === '/api/echo' && r.body && r.body.ok === false && typeof r.body.message === 'string';
    if (!echoNo && (!r.body || !r.body.ok)) {
      const e = new Error('The server said no: ' + ((r.body && r.body.error) || 'error ' + r.status) + '.');
      e.serverSaidNo = true;
      throw e;
    }
    return r.body;
  }

  function trimData(data) {
    if (data === undefined) return undefined;
    try {
      if (Buffer.byteLength(JSON.stringify(data)) <= MAX_DATA_BYTES) return data;
    } catch (e) { /* fall through */ }
    return { note: 'the data was too large to include' };
  }

  function resultText(r) {
    return JSON.stringify(r, null, 1) + '\n';
  }

  async function heartbeat() {
    let st = {};
    let cal = {};
    let lg = {};
    try { st = (await o.api('GET', '/api/status')).body || {}; } catch (e) { /* keep going */ }
    try { cal = ((await o.api('GET', '/api/calendar')).body || {}).data || {}; } catch (e) { /* keep going */ }
    // Counts and a time only, never log text.
    try { lg = (await o.api('GET', '/api/log?errors=1&lines=1')).body || {}; } catch (e) { /* keep going */ }
    const lastError = Array.isArray(lg.lines) && lg.lines.length ? lg.lines[lg.lines.length - 1] : null;
    const body = {
      updated: now().toISOString(),
      version: o.version,
      uptimeSeconds: st.uptime,
      screensListening: (st.screens || []).length,
      mailbox: {
        pollSeconds: cfg.pollSeconds,
        lastCommandId: info.lastCommandId,
        lastCommandAt: info.lastCommandAt,
        lastError: info.lastError
      },
      calendar: {
        configured: !!cal.configured,
        calendars: (cal.calendars || []).length,
        problems: (cal.calendars || []).filter((c) => !c.ok).length,
        lastRefresh: st.calendar ? st.calendar.lastRefresh || null : null
      },
      log: {
        errors24h: typeof lg.errors24h === 'number' ? lg.errors24h : 0,
        lastErrorAt: lastError && typeof lastError.t === 'string' ? lastError.t : null
      }
    };
    if (healthInfo) body.health = healthInfo;
    await s3.put('status.json', JSON.stringify(body, null, 1) + '\n');
    lastHeartbeat = Date.now();
  }

  // The weekly health report: pi/health/pi-health.py writes data/health/latest.json
  // on the Pi itself; this copies it to the bucket when it changes, so a cloud
  // thread can read it. The script scrubs it before writing; nothing is added here.
  async function sendHealth() {
    lastHealthCheck = Date.now();
    if (!o.healthDir) return;
    const file = path.join(o.healthDir, 'latest.json');
    let st;
    try { st = fs.statSync(file); } catch (e) { return; } // no report yet
    const tag = st.mtimeMs + ':' + st.size;
    if (tag === healthSent) return;
    const kb = Math.max(1, Math.round(st.size / 1024));
    if (st.size > HEALTH_MAX) {
      healthSent = tag;
      log('Claude mailbox: health report too large to send (' + kb + ' KB)');
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    let rep = null;
    try { rep = JSON.parse(text); } catch (e) { rep = null; }
    if (!isObj(rep) || rep.kind !== 'pi-health') {
      healthSent = tag;
      log('Claude mailbox: health report is not valid, so it was not sent');
      return;
    }
    const day = String(rep.generated || '').slice(0, 10);
    await s3.put('health/latest.json', text, 'application/json');
    if (HEALTH_DAY_RE.test(day)) await s3.put('health/' + day + '.json', text, 'application/json');
    healthSent = tag;
    const sum = isObj(rep.summary) ? rep.summary : {};
    healthInfo = {
      generated: typeof rep.generated === 'string' ? rep.generated.slice(0, 40) : null,
      overall: ['ok', 'warn', 'bad'].indexOf(sum.overall) >= 0 ? sum.overall : null,
      bad: Number.isInteger(sum.bad) ? sum.bad : null,
      warn: Number.isInteger(sum.warn) ? sum.warn : null
    };
    log('Claude mailbox: health report sent (' + (healthInfo.overall || 'no summary') + ', ' + kb + ' KB)');
  }

  // Writes a result that could not be written before. True when done.
  async function flushPending() {
    for (const [id, p] of Array.from(pending)) {
      await s3.put('outbox/' + id + '.json', resultText(p.result));
      pending.delete(id);
      try { await s3.del('inbox/' + id + '.json'); } catch (e) { /* the next poll tidies it */ }
      if (p.restart) await doRestart();
    }
  }

  async function doRestart() {
    if (restarting) return;
    restarting = true;
    try { await heartbeat(); } catch (e) { /* not needed to restart */ }
    log('Claude mailbox: restart asked for; stopping so Docker starts the server again');
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { o.onRestart(); } catch (e) { /* nothing more to do */ }
  }

  function noteCommand(id, cmd, ok) {
    info.lastCommandId = id;
    info.lastCommand = cmd;
    info.lastCommandAt = now().toISOString();
    info.lastCommandOk = ok;
  }

  // A file whose name cannot be an id: answered under a made-up name, then removed.
  async function rejectBadName(item) {
    const tag = 'invalid-' + sha256Hex(item.key).slice(0, 16);
    const r = {
      id: null, key: item.key.slice(0, 200), cmd: null, ok: false, state: 'done',
      message: 'Rejected: the file name must be inbox/<id>.json, where id is 6 to 64 letters, digits, "_" or "-". Not run.',
      started: now().toISOString(), finished: now().toISOString()
    };
    await s3.put('outbox/' + tag + '.json', resultText(r));
    await s3.del(item.key);
    log('Claude mailbox: rejected a file with a bad name (answered as ' + tag + ')');
  }

  // An inbox file that already has an outbox file. If that one still says
  // "running", the server stopped while it ran: say so, and never run it again.
  async function tidyAnswered(id) {
    const key = 'outbox/' + id + '.json';
    const bytes = await s3.get(key, MAX_FILE * 2);
    let prev = null;
    try { prev = bytes ? JSON.parse(bytes.toString('utf8')) : null; } catch (e) { prev = null; }
    if (prev && prev.state === 'running') {
      const r = Object.assign({}, prev, {
        ok: false, state: 'done', finished: now().toISOString(),
        message: 'The hub stopped while this command ran, so it may or may not have happened. It was not run again. Check, and send a new command if needed.'
      });
      await s3.put(key, resultText(r));
      log('Claude mailbox: ' + id + ' was interrupted by a restart; marked as not finished');
    }
    await s3.del('inbox/' + id + '.json');
  }

  async function runOne(item, bytes) {
    const started = now().toISOString();
    let env;
    try {
      if (bytes === null) return; // gone meanwhile
      env = checkEnvelope(item.id, bytes, now().getTime());
    } catch (e) {
      let cmd = null;
      try { const j = JSON.parse(bytes.toString('utf8')); if (typeof j.cmd === 'string') cmd = j.cmd.slice(0, 40); } catch (x) { /* none */ }
      const r = { id: item.id, cmd: cmd, ok: false, state: 'done', message: 'Rejected: ' + (e.reject ? e.message : 'the file could not be read') + '. Not run.', started: started, finished: now().toISOString() };
      await s3.put('outbox/' + item.id + '.json', resultText(r));
      noteCommand(item.id, cmd || '(rejected)', false);
      log('Claude mailbox: rejected ' + item.id + ' (' + (e.reject ? e.message : 'unreadable') + ')');
      await s3.del(item.key);
      return;
    }
    // Claim it first: an outbox file means "never run this again".
    await s3.put('outbox/' + env.id + '.json', resultText({ id: env.id, cmd: env.cmd, ok: null, state: 'running', message: 'Running.', started: started }));
    let out;
    try {
      out = await COMMANDS[env.cmd].run(env.args, { call: call, version: o.version, canRestart: typeof o.onRestart === 'function' });
    } catch (e) {
      out = { ok: false, message: e.serverSaidNo ? e.message : 'Something went wrong: ' + (e && e.message) };
    }
    const ok = out.ok !== false;
    const result = {
      id: env.id, cmd: env.cmd, ok: ok, state: 'done',
      message: String(out.message || '').slice(0, MAX_MESSAGE),
      started: started, finished: now().toISOString()
    };
    const data = trimData(out.data);
    if (data !== undefined) result.data = data;
    noteCommand(env.id, env.cmd, ok);
    log('Claude mailbox: ' + env.cmd + ' (' + env.id + ') -> ' + (ok ? 'ok' : 'failed'));
    try {
      await s3.put('outbox/' + env.id + '.json', resultText(result));
    } catch (e) {
      pending.set(env.id, { result: result, restart: !!out.restart });
      throw e;
    }
    try { await s3.del(item.key); } catch (e) { /* the next poll tidies it */ }
    try { await heartbeat(); } catch (e) { /* the next minute's one will do */ }
    if (out.restart) await doRestart();
  }

  async function prune() {
    const cutOut = Date.now() - OUTBOX_KEEP_MS;
    const cutIn = Date.now() - MAX_AGE_MS;
    for (const i of await s3.list('outbox/')) {
      if (i.lastModified && i.lastModified < cutOut) await s3.del(i.key);
    }
    for (const i of await s3.list('inbox/')) {
      if (i.key !== 'inbox/' && i.lastModified && i.lastModified < cutIn) await s3.del(i.key);
    }
    const cutHealth = Date.now() - HEALTH_KEEP_MS;
    for (const i of await s3.list('health/')) {
      if (i.key !== 'health/latest.json' && i.lastModified && i.lastModified < cutHealth) await s3.del(i.key);
    }
    lastPrune = Date.now();
  }

  async function cycle() {
    await flushPending();
    if (closed) return;
    if (Date.now() - lastHealthCheck >= HEALTH_CHECK_MS) await sendHealth();
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) await heartbeat();
    const inbox = (await s3.list('inbox/')).filter((i) => i.key !== 'inbox/');
    const valid = [];
    for (const i of inbox) {
      const m = INBOX_KEY_RE.exec(i.key);
      if (!m || !ID_RE.test(m[1])) { await rejectBadName(i); continue; }
      if (pending.has(m[1])) continue;
      valid.push({ key: i.key, id: m[1], lastModified: i.lastModified, size: i.size });
    }
    if (valid.length) {
      const answered = new Set();
      (await s3.list('outbox/')).forEach((i) => {
        const m = OUTBOX_KEY_RE.exec(i.key);
        if (m) answered.add(m[1]);
      });
      const todo = [];
      for (const v of valid) {
        if (answered.has(v.id)) await tidyAnswered(v.id);
        else todo.push(v);
      }
      todo.sort((a, b) => a.lastModified - b.lastModified);
      const batch = [];
      for (const v of todo.slice(0, MAX_PER_POLL)) {
        const bytes = v.size > MAX_FILE ? Buffer.alloc(MAX_FILE + 1) : await getCapped(v.key);
        let created = v.lastModified;
        try { const c = Date.parse(JSON.parse(bytes.toString('utf8')).created); if (isFinite(c)) created = c; } catch (e) { /* stays */ }
        batch.push({ v: v, bytes: bytes, created: created });
      }
      batch.sort((a, b) => a.created - b.created);
      for (const b of batch) {
        if (closed) return;
        await runOne(b.v, b.bytes);
      }
    }
    if (!closed && Date.now() - lastPrune >= PRUNE_EVERY_MS) await prune();
  }

  async function getCapped(key) {
    try {
      return await s3.get(key, MAX_FILE);
    } catch (e) {
      if (e.tooBig) return Buffer.alloc(MAX_FILE + 1);
      throw e;
    }
  }

  function noteOk() {
    if (!info.connected) {
      if (failures > 0) log('Claude mailbox: connected again after ' + failures + ' failed tries');
      else log('Claude mailbox: connected to bucket ' + cfg.bucket);
    }
    failures = 0;
    info.connected = true;
    info.lastOkAt = now().toISOString();
  }

  function noteFail(e) {
    const why = describe(e);
    if (failures === 0) log('Claude mailbox: cannot reach R2 (' + why + '); trying again quietly, up to once a minute');
    failures++;
    info.connected = false;
    info.lastError = why;
  }

  // One poll. Never rejects.
  function pollOnce() {
    if (running) return running;
    running = cycle().then(noteOk, noteFail).then(() => { running = null; });
    return running;
  }

  function schedule() {
    if (closed || o.manual) return;
    const wait = failures ? Math.min(MAX_BACKOFF_MS, pollMs * Math.pow(2, Math.min(failures, 6))) : pollMs;
    timer = setTimeout(() => { timer = null; pollOnce().then(schedule); }, wait);
    if (timer.unref) timer.unref();
  }

  return {
    start: () => {
      log('Claude mailbox: on, bucket ' + cfg.bucket + ' at ' + cfg.url.host + ', checking every ' + cfg.pollSeconds + ' seconds');
      if (o.manual) return;
      timer = setTimeout(() => { timer = null; pollOnce().then(schedule); }, 1000);
      if (timer.unref) timer.unref();
    },
    pollOnce: pollOnce,
    info: () => Object.assign({}, info, { pendingResults: pending.size }),
    close: () => {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      s3.close && s3.close();
    }
  };
}

module.exports = {
  signRequest: signRequest,
  signingKey: signingKey,
  uriEncode: uriEncode,
  parseListXml: parseListXml,
  parseEndpoint: parseEndpoint,
  configFromEnv: configFromEnv,
  createS3: createS3,
  createMailbox: createMailbox,
  checkEnvelope: checkEnvelope,
  COMMANDS: COMMANDS,
  ID_RE: ID_RE
};
