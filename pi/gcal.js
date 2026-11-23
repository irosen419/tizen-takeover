/*
 * Deletes one Google Calendar event, for the to-do converter: a ticked to-do
 * whose event should go (todoconvert.js decides which).
 *
 * The calendars themselves are still read through their private iCal links;
 * this is the only write. It signs in as a Google service account whose key
 * file sits at data/google-calendar-key.json on the Pi, and only
 * calendars shared with that account ("Make changes to events") can be
 * changed. No key file: nothing is deleted, and nothing is logged.
 *
 * Never logs the key, tokens, calendar addresses or event ids.
 * Node 14 or newer, no npm packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const KEY_FILE = 'google-calendar-key.json';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 15000;

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// The Google event id for one occurrence: the feed's UID without
// "@google.com", plus "_<original start>" for an occurrence of a repeating
// event (all day: _YYYYMMDD; timed: _YYYYMMDDTHHMMSSZ). Null when the UID is
// not a Google one (an imported event's id in Google is not its UID).
function eventId(uid, inst, repeating) {
  const m = /^([a-z0-9_]+)@google\.com$/i.exec(String(uid || '').trim());
  if (!m) return null;
  const base = m[1];
  if (!repeating) return base;
  const k = String(inst || '');
  if (/^D-?\d+$/.test(k)) {
    const d = new Date(Number(k.slice(1)) * 86400000).toISOString().slice(0, 10);
    return base + '_' + d.replace(/-/g, '');
  }
  if (/^T-?\d+$/.test(k)) {
    const t = new Date(Number(k.slice(1))).toISOString().replace(/\.\d+Z$/, 'Z');
    return base + '_' + t.replace(/[-:]/g, '');
  }
  return null;
}

// One https call: resolves { status, body } and never rejects.
function call(method, url, headers, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ status: 0, body: '' }); return; }
    const req = https.request({ method: method, hostname: u.hostname, path: u.pathname + u.search, headers: headers, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 65536) data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: '' }));
    if (body) req.write(body);
    req.end();
  });
}

// o: { dataDir, file?, request?(method, url, headers, body), now?() }
function create(o) {
  const file = o.file || path.join(o.dataDir, KEY_FILE);
  const request = o.request || call;
  const now = o.now || (() => Date.now());
  let token = null;
  let tokenUntil = 0;

  function key() {
    try {
      const k = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (k && typeof k.client_email === 'string' && typeof k.private_key === 'string') return k;
    } catch (e) { /* none */ }
    return null;
  }

  async function getToken(k) {
    if (token && now() < tokenUntil) return token;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: k.client_email, scope: SCOPE, aud: k.token_uri || TOKEN_URL, iat: iat, exp: iat + 3600 }));
    let sig;
    try { sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(head + '.' + claim), k.private_key)); } catch (e) { return null; }
    const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig;
    const r = await request('POST', TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, form);
    if (r.status !== 200) return null;
    try {
      const j = JSON.parse(r.body);
      if (!j.access_token) return null;
      token = j.access_token;
      tokenUntil = now() + Math.max(60, (Number(j.expires_in) || 3600) - 120) * 1000;
      return token;
    } catch (e) { return null; }
  }

  // Resolves 'deleted', 'gone' (already deleted or not found), 'denied'
  // (calendar not shared with the account, or a bad key) or 'retry'.
  async function remove(calId, evId) {
    const k = key();
    if (!k) return 'retry';
    const t = await getToken(k);
    if (!t) return 'retry';
    const url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) +
      '/events/' + encodeURIComponent(evId) + '?sendUpdates=none';
    const r = await request('DELETE', url, { Authorization: 'Bearer ' + t }, null);
    if (r.status === 200 || r.status === 204) return 'deleted';
    if (r.status === 404 || r.status === 410) return 'gone';
    if (r.status === 401) { token = null; return 'retry'; }
    if (r.status === 403) {
      // Rate limits are 403 too; only "forbidden" means no access.
      return /rateLimit|userRateLimit|quotaExceeded/i.test(r.body) ? 'retry' : 'denied';
    }
    return 'retry';
  }

  return { ready: () => key() !== null, remove: remove };
}

module.exports = { create: create, eventId: eventId, KEY_FILE: KEY_FILE };
